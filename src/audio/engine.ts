import { SoundTouchNode } from "@soundtouchjs/audio-worklet";
import processorUrl from "@soundtouchjs/audio-worklet/processor?url";
import type { DeckId, SetDoc } from "../types/setdoc";
import { useSetStore } from "../commands/pipeline";
import { getAudioBuffer } from "./bufferCache";
import { BACKSPIN_REWIND_BARS } from "../set/timeline";
import { reversedSlice } from "./reverseSlice";

type FilterMode = "allpass" | "lowpass" | "highpass";

type DeckNodes = {
  gain: GainNode;
  send: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  filter: BiquadFilterNode;
  filterMode: FilterMode;
  buffer: AudioBuffer | null;
  loadedTrackId: string | null;
  source: AudioBufferSourceNode | null;
  /** Keylock pitch-compensator (null when keylock off) */
  stretch: SoundTouchNode | null;
  startedAt: number;
  offsetSec: number;
  playing: boolean;
  rate: number;
  nativeBpm: number;
  useStretch: boolean;
  analyser: AnalyserNode;
  levelBuf: Uint8Array<ArrayBuffer>;
  /** Vinyl rewind: a reversed slice is playing; skip forward seeks / rate writes. */
  reversing: boolean;
};

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private fxInput: GainNode | null = null;
  private fxWet: GainNode | null = null;
  private delay: DelayNode | null = null;
  private delayFeedback: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private fxDelayConnected = false;
  private fxReverbConnected = false;
  private samplerGain: GainNode | null = null;
  private destStream: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recordChunks: Blob[] = [];
  private decks: Record<DeckId, DeckNodes> | null = null;
  private unsub: (() => void) | null = null;
  private loopRaf = 0;
  private loopWatchOn = false;
  private syncRunning = false;
  private syncQueued = false;
  private workletReady = false;
  private lastDeckSnap: Record<
    DeckId,
    { trackId: string | null; playing: boolean; positionBars: number }
  > | null = null;
  private wasRecording = false;
  /** Last values pushed to each channel's AudioParams — dezipper + skip identical frames. */
  private appliedCh: Partial<Record<DeckId, Record<string, number>>> = {};

  dispose() {
    this.disarmLoopWatch();
    this.unsub?.();
    this.unsub = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  setPerformerSync(_on: boolean) {
    // Retained for setPerformer API; tempo sync is driven by deck BPM + keylock worklet.
  }

  async ensure() {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext();
    const master = ctx.createGain();
    const destStream = ctx.createMediaStreamDestination();
    master.connect(ctx.destination);
    master.connect(destStream);

    const fxInput = ctx.createGain();
    const fxWet = ctx.createGain();
    fxWet.gain.value = 0;
    fxWet.connect(master);

    const delay = ctx.createDelay(2);
    const delayFeedback = ctx.createGain();
    const delayFilter = ctx.createBiquadFilter();
    delayFilter.type = "lowpass";
    delayFilter.frequency.value = 3500;
    delayFeedback.gain.value = 0.35;
    delay.connect(delayFilter);
    delayFilter.connect(delayFeedback);
    delayFeedback.connect(delay);
    delayFilter.connect(fxWet);

    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulse(ctx, 1.8);
    convolver.connect(fxWet);

    const samplerGain = ctx.createGain();
    samplerGain.connect(master);

    this.ctx = ctx;
    this.master = master;
    this.destStream = destStream;
    this.fxInput = fxInput;
    this.fxWet = fxWet;
    this.delay = delay;
    this.delayFeedback = delayFeedback;
    this.convolver = convolver;
    this.samplerGain = samplerGain;
    this.decks = {
      A: this.makeDeck(ctx),
      B: this.makeDeck(ctx),
      C: this.makeDeck(ctx),
      D: this.makeDeck(ctx),
    };
    this.appliedCh = {};
    this.appliedFx = {};

    try {
      await SoundTouchNode.register(ctx, processorUrl);
      this.workletReady = true;
    } catch (e) {
      console.warn("[audio] SoundTouch worklet unavailable; keylock falls back to rate", e);
      this.workletReady = false;
    }

    this.unsub = useSetStore.subscribe((state, prev) => {
      if (state.doc !== prev.doc) {
        if (needsTransportSync(prev.doc, state.doc)) this.requestSync();
        else this.applyMixerGraph(state.doc);
      }
      if (
        state.lastCommand &&
        state.lastCommand !== prev.lastCommand &&
        state.lastCommand.command.type === "sampler.trigger"
      ) {
        void this.triggerPad(state.lastCommand.command.pad);
      }
    });

    return ctx;
  }

  getCurrentTime() {
    return this.ctx?.currentTime ?? 0;
  }

  /** Drift correction: restart the playing buffer without a command. */
  seekPlayingTo(deck: DeckId, positionBars: number) {
    if (this.decks?.[deck]?.reversing) return;
    const d = useSetStore.getState().doc.decks[deck];
    this.seekPlaying(deck, positionBars, d);
  }

  isReversing(deck: DeckId): boolean {
    return Boolean(this.decks?.[deck]?.reversing);
  }

  /**
   * Play a reversed PCM slice once (no SoundTouch). Restarting the keylock
   * worklet every frame is silent; this is actual rewind audio.
   */
  startReverse(
    deck: DeckId,
    fromBars: number,
    windowSec: number,
    minBars = 0,
    rewindBars = BACKSPIN_REWIND_BARS,
  ) {
    const nodes = this.decks?.[deck];
    if (!nodes || !this.ctx || !nodes.buffer) return;
    if (nodes.reversing) return;

    const barSec = (60 / Math.max(1, nodes.nativeBpm)) * 4;
    const originBars = Math.max(minBars, fromBars);
    const startBars = Math.max(minBars, originBars - rewindBars);
    const sliceSec = Math.max(0.12, (originBars - startBars) * barSec);
    const slice = reversedSlice(this.ctx, nodes.buffer, startBars * barSec, sliceSec);
    const dur = Math.max(0.08, windowSec);
    const meanRate = slice.duration / dur;

    nodes.reversing = true;
    this.haltSource(deck);

    const src = this.ctx.createBufferSource();
    src.buffer = slice;
    src.connect(nodes.eqLow);
    const t = this.ctx.currentTime;
    const fromRate = Math.max(0.7, meanRate * 0.55);
    const toRate = Math.max(fromRate, meanRate * 1.45);
    src.playbackRate.setValueAtTime(fromRate, t);
    src.playbackRate.linearRampToValueAtTime(toRate, t + dur);
    src.start(0);

    nodes.source = src;
    nodes.stretch = null;
    nodes.useStretch = false;
    nodes.reversing = true;
    nodes.playing = true;
    nodes.rate = fromRate;
    nodes.startedAt = t;
    nodes.offsetSec = startBars * barSec;
    if (this.lastDeckSnap) {
      this.lastDeckSnap[deck] = {
        trackId: useSetStore.getState().doc.decks[deck].trackId,
        playing: true,
        positionBars: originBars,
      };
    }
    src.onended = () => {
      if (nodes.source === src) {
        nodes.playing = false;
        nodes.source = null;
      }
    };
  }

  stopReverse(deck: DeckId) {
    if (!this.decks?.[deck]?.reversing) return;
    this.stopDeck(deck);
  }

  private requestSync() {
    if (this.syncRunning) {
      this.syncQueued = true;
      return;
    }
    this.syncRunning = true;
    void this.runSyncLoop();
  }

  private async runSyncLoop() {
    try {
      do {
        this.syncQueued = false;
        await this.sync();
      } while (this.syncQueued);
    } finally {
      this.syncRunning = false;
      if (this.syncQueued) this.requestSync();
    }
  }

  private makeImpulse(ctx: AudioContext, seconds: number): AudioBuffer {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
      }
    }
    return buf;
  }

  private makeDeck(ctx: AudioContext): DeckNodes {
    const gain = ctx.createGain();
    const send = ctx.createGain();
    send.gain.value = 0;
    const eqLow = ctx.createBiquadFilter();
    eqLow.type = "lowshelf";
    eqLow.frequency.value = 320;
    const eqMid = ctx.createBiquadFilter();
    eqMid.type = "peaking";
    eqMid.frequency.value = 1000;
    eqMid.Q.value = 0.7;
    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = "highshelf";
    eqHigh.frequency.value = 3200;
    const filter = ctx.createBiquadFilter();
    filter.type = "allpass";
    filter.frequency.value = 1000;

    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(filter);
    filter.connect(gain);
    filter.connect(send);
    gain.connect(this.master!);
    send.connect(this.fxInput!);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.45;
    gain.connect(analyser);

    return {
      gain,
      send,
      eqLow,
      eqMid,
      eqHigh,
      filter,
      filterMode: "allpass",
      buffer: null,
      loadedTrackId: null,
      source: null,
      stretch: null,
      startedAt: 0,
      offsetSec: 0,
      playing: false,
      rate: 1,
      nativeBpm: 120,
      useStretch: false,
      analyser,
      levelBuf: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      reversing: false,
    };
  }

  private applyMixerGraph(doc: SetDoc) {
    if (!this.ctx || !this.decks || !this.master || !this.samplerGain) return;
    this.master.gain.value = Math.pow(10, doc.mixer.masterDb / 20);
    this.samplerGain.gain.value = doc.sampler.masterGain;
    this.applyFx(doc);
    for (const deck of ["A", "B", "C", "D"] as DeckId[]) {
      this.applyChannel(deck, doc);
    }
  }

  private armLoopWatch() {
    if (this.loopWatchOn) return;
    this.loopWatchOn = true;
    const tick = () => {
      if (!this.loopWatchOn) return;
      this.checkLoops();
      this.loopRaf = requestAnimationFrame(tick);
    };
    this.loopRaf = requestAnimationFrame(tick);
  }

  private disarmLoopWatch() {
    this.loopWatchOn = false;
    cancelAnimationFrame(this.loopRaf);
    this.loopRaf = 0;
  }

  private syncLoopWatch(doc: SetDoc) {
    const need = (["A", "B", "C", "D"] as DeckId[]).some((id) => {
      const d = doc.decks[id];
      return d.playing && d.loopBars != null && d.loopInBars != null;
    });
    if (need) this.armLoopWatch();
    else this.disarmLoopWatch();
  }

  private checkLoops() {
    if (!this.decks) return;
    const doc = useSetStore.getState().doc;
    for (const deck of ["A", "B", "C", "D"] as DeckId[]) {
      const d = doc.decks[deck];
      const nodes = this.decks[deck];
      if (
        !d.playing ||
        d.loopBars == null ||
        d.loopInBars == null ||
        !nodes.playing ||
        nodes.reversing
      ) {
        continue;
      }
      const pos = this.getPositionBars(deck);
      const end = d.loopInBars + d.loopBars;
      if (pos >= end - 0.02) {
        this.seekPlaying(deck, d.loopInBars, d);
      }
    }
  }

  getPositionBars(deck: DeckId): number {
    if (!this.ctx || !this.decks) return 0;
    const nodes = this.decks[deck];
    const barSec = (60 / Math.max(1, nodes.nativeBpm)) * 4;
    let sec = nodes.offsetSec;
    if (nodes.playing) {
      sec += (this.ctx.currentTime - nodes.startedAt) * nodes.rate;
    }
    if (nodes.buffer) {
      sec = Math.min(Math.max(0, sec), Math.max(0, nodes.buffer.duration - 0.01));
    }
    return sec / barSec;
  }

  isBufferReady(deck: DeckId): boolean {
    return Boolean(this.decks?.[deck]?.buffer);
  }

  /** Peak-ish 0..1 from the channel tap (after fader / xfader / cue). */
  getDeckLevel(deck: DeckId): number {
    const nodes = this.decks?.[deck];
    if (!nodes) return 0;
    nodes.analyser.getByteTimeDomainData(nodes.levelBuf);
    let sum = 0;
    const buf = nodes.levelBuf;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i]! - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 2.8);
  }

  /**
   * Dezippered param write: skips identical/sub-epsilon frames (automation
   * ticks at ~60Hz) and ramps the rest with setTargetAtTime instead of
   * slamming .value (zipper clicks).
   */
  private smoothSet(deck: DeckId, key: string, param: AudioParam, value: number) {
    const cache = (this.appliedCh[deck] ??= {});
    const prev = cache[key];
    if (prev === value) return;
    if (prev != null && Math.abs(prev - value) < 1e-4) {
      cache[key] = value;
      return;
    }
    cache[key] = value;
    const t = this.ctx ? this.ctx.currentTime : 0;
    param.setTargetAtTime(value, t, 0.012);
  }

  private applyChannel(deck: DeckId, doc: SetDoc) {
    if (!this.decks || !this.master) return;
    const nodes = this.decks[deck];
    const ch = doc.mixer.channels[deck];
    const xf = doc.mixer.crossfader;
    let xfGain = 1;
    if (doc.mixer.xfaderCurve === "smooth") {
      if (deck === "A") xfGain = Math.cos(((xf + 1) / 2) * (Math.PI / 2));
      if (deck === "B") xfGain = Math.sin(((xf + 1) / 2) * (Math.PI / 2));
    } else {
      if (deck === "A") xfGain = xf <= 0 ? 1 : Math.max(0, 1 - xf * 8);
      if (deck === "B") xfGain = xf >= 0 ? 1 : Math.max(0, 1 + xf * 8);
    }
    if (deck === "C" || deck === "D") xfGain = 0.7;

    // Cue-to-master: any armed Cue solos those channels (PFL, ignore xfader).
    const anyCue =
      doc.mixer.channels.A.cue ||
      doc.mixer.channels.B.cue ||
      doc.mixer.channels.C.cue ||
      doc.mixer.channels.D.cue;
    if (anyCue) xfGain = ch.cue ? 1 : 0;

    this.smoothSet(deck, "gain", nodes.gain.gain, ch.fader * xfGain * Math.pow(10, ch.gainDb / 20));
    // Send follows the same mute as the dry path — a silenced deck must not hit the delay.
    this.smoothSet(
      deck,
      "send",
      nodes.send.gain,
      doc.fx.type === "off" ? 0 : (doc.decks[deck].fxSend ?? 0) * xfGain * ch.fader,
    );
    this.smoothSet(deck, "eqLow", nodes.eqLow.gain, ch.eqLow);
    this.smoothSet(deck, "eqMid", nodes.eqMid.gain, ch.eqMid);
    this.smoothSet(deck, "eqHigh", nodes.eqHigh.gain, ch.eqHigh);

    // Only change BiquadFilterNode.type when mode changes (type swaps rebuild the filter).
    if (Math.abs(ch.filter) < 0.05) {
      if (nodes.filterMode !== "allpass") {
        nodes.filter.type = "allpass";
        nodes.filterMode = "allpass";
      }
      this.smoothSet(deck, "filterHz", nodes.filter.frequency, 1000);
    } else if (ch.filter < 0) {
      if (nodes.filterMode !== "lowpass") {
        nodes.filter.type = "lowpass";
        nodes.filterMode = "lowpass";
      }
      this.smoothSet(deck, "filterHz", nodes.filter.frequency, 400 + (1 + ch.filter) * 8000);
      this.smoothSet(deck, "filterQ", nodes.filter.Q, 0.7);
    } else {
      if (nodes.filterMode !== "highpass") {
        nodes.filter.type = "highpass";
        nodes.filterMode = "highpass";
      }
      this.smoothSet(deck, "filterHz", nodes.filter.frequency, 40 + ch.filter * 4000);
      this.smoothSet(deck, "filterQ", nodes.filter.Q, 0.7);
    }
  }

  /** Last FX-bus param values — same dezipper rationale as applyChannel. */
  private appliedFx: Record<string, number> = {};

  private smoothFx(key: string, param: AudioParam, value: number) {
    const prev = this.appliedFx[key];
    if (prev === value) return;
    if (prev != null && Math.abs(prev - value) < 1e-4) {
      this.appliedFx[key] = value;
      return;
    }
    this.appliedFx[key] = value;
    const t = this.ctx ? this.ctx.currentTime : 0;
    param.setTargetAtTime(value, t, 0.012);
  }

  private applyFx(doc: SetDoc) {
    if (
      !this.fxWet ||
      !this.delay ||
      !this.delayFeedback ||
      !this.convolver ||
      !this.fxInput
    ) {
      return;
    }
    const xf = doc.mixer.crossfader;
    const bpm =
      (xf <= 0 ? doc.decks.A.bpm : doc.decks.B.bpm) ??
      doc.setTempoBpm ??
      120;
    const beatSec = 60 / Math.max(1, bpm);
    this.smoothFx("delayTime", this.delay.delayTime, Math.min(1.9, doc.fx.timeBeats * beatSec));

    const type = doc.fx.type;
    if (type === "off") {
      this.smoothFx("wet", this.fxWet.gain, 0);
      this.setFxRoute(false, false);
      return;
    }

    this.smoothFx("wet", this.fxWet.gain, doc.fx.wet);
    if (type === "reverb") {
      this.smoothFx("feedback", this.delayFeedback.gain, 0);
      this.setFxRoute(false, true);
    } else {
      this.smoothFx(
        "feedback",
        this.delayFeedback.gain,
        type === "echo" ? Math.max(doc.fx.feedback, 0.45) : doc.fx.feedback,
      );
      this.setFxRoute(true, false);
    }
  }

  private setFxRoute(delayOn: boolean, reverbOn: boolean) {
    if (!this.fxInput || !this.delay || !this.convolver) return;
    if (delayOn && !this.fxDelayConnected) {
      this.fxInput.connect(this.delay);
      this.fxDelayConnected = true;
    } else if (!delayOn && this.fxDelayConnected) {
      try {
        this.fxInput.disconnect(this.delay);
      } catch {
        /* */
      }
      this.fxDelayConnected = false;
    }
    if (reverbOn && !this.fxReverbConnected) {
      this.fxInput.connect(this.convolver);
      this.fxReverbConnected = true;
    } else if (!reverbOn && this.fxReverbConnected) {
      try {
        this.fxInput.disconnect(this.convolver);
      } catch {
        /* */
      }
      this.fxReverbConnected = false;
    }
  }

  private async sync() {
    if (!this.ctx || !this.decks || !this.master || !this.samplerGain) return;
    if (this.ctx.state === "suspended") await this.ctx.resume();

    const doc = useSetStore.getState().doc;
    const prevSnap = this.lastDeckSnap;

    this.master.gain.value = Math.pow(10, doc.mixer.masterDb / 20);
    this.samplerGain.gain.value = doc.sampler.masterGain;
    this.applyFx(doc);
    this.syncRecord(doc);

    for (const deck of ["A", "B", "C", "D"] as DeckId[]) {
      const liveDoc = useSetStore.getState().doc;
      const d = liveDoc.decks[deck];
      const nodes = this.decks[deck];
      this.applyChannel(deck, liveDoc);

      if (nodes.reversing) {
        const d2r = useSetStore.getState().doc.decks[deck];
        if (!d2r.playing) this.stopDeck(deck);
        continue;
      }

      const track = d.trackId ? liveDoc.tracks[d.trackId] : null;
      const nativeBpm = track?.analysis?.bpm ?? d.bpm ?? 120;
      nodes.nativeBpm = nativeBpm;

      if (d.trackId !== nodes.loadedTrackId) {
        this.stopDeck(deck);
        nodes.buffer = null;
        nodes.loadedTrackId = d.trackId;
        if (d.trackId && track && this.ctx) {
          const buf = await getAudioBuffer(this.ctx, track.fileRef);
          const still = useSetStore.getState().doc.decks[deck];
          if (buf && still.trackId === d.trackId) {
            nodes.buffer = buf;
          }
        }
      }

      const d2 = useSetStore.getState().doc.decks[deck];
      const track2 = d2.trackId ? useSetStore.getState().doc.tracks[d2.trackId] : null;
      const nativeBpm2 = track2?.analysis?.bpm ?? d2.bpm ?? nodes.nativeBpm;
      nodes.nativeBpm = nativeBpm2;
      const targetBpm2 = d2.bpm ?? nativeBpm2;
      const tempoRatio2 = targetBpm2 / Math.max(1e-6, nativeBpm2);
      // Pitch-lock only when keylock (worklet). Performer sync sets BPM; rate follows.
      const wantStretch2 = d2.keylock && this.workletReady;

      if (nodes.source && nodes.playing) {
        nodes.rate = tempoRatio2;
        nodes.source.playbackRate.value = tempoRatio2;
        if (nodes.stretch) {
          nodes.stretch.playbackRate.value = tempoRatio2;
          nodes.stretch.pitch.value = 1;
        }
      }

      const prev = prevSnap?.[deck];
      if (d2.playing && !nodes.playing) {
        this.startDeck(deck, d2.positionBars, nativeBpm2, tempoRatio2, wantStretch2);
      } else if (!d2.playing && nodes.playing) {
        this.stopDeck(deck, true);
      } else if (
        d2.playing &&
        nodes.playing &&
        prev &&
        Math.abs(d2.positionBars - prev.positionBars) > 0.02 &&
        prev.playing
      ) {
        this.seekPlaying(deck, d2.positionBars, d2);
      } else if (d2.playing && nodes.playing && wantStretch2 !== nodes.useStretch) {
        const pos = this.getPositionBars(deck);
        this.stopDeck(deck);
        this.startDeck(deck, pos, nativeBpm2, tempoRatio2, wantStretch2);
      }
    }

    const finalDoc = useSetStore.getState().doc;
    this.lastDeckSnap = {
      A: snapDeck(finalDoc, "A"),
      B: snapDeck(finalDoc, "B"),
      C: snapDeck(finalDoc, "C"),
      D: snapDeck(finalDoc, "D"),
    };
    this.syncLoopWatch(finalDoc);
  }

  private syncRecord(doc: SetDoc) {
    if (doc.record.recording && !this.wasRecording) {
      this.startRecorder();
    } else if (!doc.record.recording && this.wasRecording) {
      this.stopRecorder();
    }
    this.wasRecording = doc.record.recording;
  }

  private seekPlaying(deck: DeckId, positionBars: number, d: SetDoc["decks"][DeckId]) {
    const nodes = this.decks?.[deck];
    if (!nodes || !this.ctx) return;
    const nativeBpm = nodes.nativeBpm;
    const targetBpm = d.bpm ?? nativeBpm;
    const tempoRatio = targetBpm / Math.max(1e-6, nativeBpm);
    const wantStretch = d.keylock && this.workletReady;
    this.stopDeck(deck);
    this.startDeck(deck, positionBars, nativeBpm, tempoRatio, wantStretch);
    if (this.lastDeckSnap) {
      this.lastDeckSnap[deck] = {
        trackId: d.trackId,
        playing: true,
        positionBars,
      };
    }
  }

  private startDeck(
    deck: DeckId,
    positionBars: number,
    bpm: number,
    tempoRatio: number,
    stretch: boolean,
  ) {
    if (!this.ctx || !this.decks) return;
    const nodes = this.decks[deck];
    if (!nodes.buffer) return;
    const barSec = (60 / bpm) * 4;
    const offset = Math.max(
      0,
      Math.min(nodes.buffer.duration - 0.05, positionBars * barSec),
    );
    const rate = Math.max(0.05, tempoRatio);

    const src = this.ctx.createBufferSource();
    src.buffer = nodes.buffer;
    src.playbackRate.value = rate;

    if (stretch && this.workletReady) {
      const st = new SoundTouchNode({ context: this.ctx });
      st.playbackRate.value = rate;
      st.pitch.value = 1;
      src.connect(st);
      st.connect(nodes.eqLow);
      nodes.stretch = st;
      nodes.useStretch = true;
    } else {
      src.connect(nodes.eqLow);
      nodes.stretch = null;
      nodes.useStretch = false;
    }

    src.start(0, offset);
    nodes.source = src;
    nodes.rate = rate;
    nodes.startedAt = this.ctx.currentTime;
    nodes.offsetSec = offset;
    nodes.playing = true;
    nodes.nativeBpm = bpm;
    src.onended = () => {
      if (nodes.source === src) {
        nodes.playing = false;
        nodes.source = null;
        if (nodes.stretch) {
          try {
            nodes.stretch.disconnect();
          } catch {
            /* */
          }
          nodes.stretch = null;
        }
        if (!useSetStore.getState().transport.setPlaying) {
          useSetStore.getState().dispatch({ type: "deck.pause", deck }, "system");
        }
      }
    };
  }

  private haltSource(deck: DeckId, rememberOffset = false) {
    if (!this.ctx || !this.decks) return;
    const nodes = this.decks[deck];
    if (rememberOffset && nodes.playing) {
      nodes.offsetSec += (this.ctx.currentTime - nodes.startedAt) * nodes.rate;
    }
    if (nodes.source) {
      try {
        nodes.source.stop();
      } catch {
        /* */
      }
      try {
        nodes.source.disconnect();
      } catch {
        /* */
      }
      nodes.source = null;
    }
    if (nodes.stretch) {
      try {
        nodes.stretch.disconnect();
      } catch {
        /* */
      }
      nodes.stretch = null;
    }
    nodes.playing = false;
    nodes.useStretch = false;
  }

  private stopDeck(deck: DeckId, rememberOffset = false) {
    this.haltSource(deck, rememberOffset);
    if (this.decks) this.decks[deck].reversing = false;
  }

  async triggerPad(pad: number) {
    await this.ensure();
    if (!this.ctx || !this.samplerGain) return;
    const doc = useSetStore.getState().doc;
    const slot = doc.sampler.pads[clamp(pad, 1, 8) - 1];
    if (!slot?.trackId) return;
    const track = doc.tracks[slot.trackId];
    if (!track) return;
    const buf = await getAudioBuffer(this.ctx, track.fileRef);
    if (!buf) return;
    const bpm = track.analysis?.bpm ?? 120;
    const barSec = (60 / bpm) * 4;
    const start = Math.max(0, slot.inBars * barSec);
    const end = Math.min(buf.duration, Math.max(start + 0.05, slot.outBars * barSec));
    const src = this.ctx.createBufferSource();
    const g = this.ctx.createGain();
    g.gain.value = slot.gain;
    src.buffer = buf;
    src.connect(g);
    g.connect(this.samplerGain);
    src.start(0, start, end - start);
  }

  private startRecorder() {
    if (!this.destStream || this.recorder) return;
    this.recordChunks = [];
    const rec = new MediaRecorder(this.destStream.stream);
    rec.ondataavailable = (e) => {
      if (e.data.size) this.recordChunks.push(e.data);
    };
    this.recorder = rec;
    rec.start(1000);
  }

  private stopRecorder() {
    const rec = this.recorder;
    if (!rec) return;
    this.recorder = null;
    rec.onstop = () => {
      const blob = new Blob(this.recordChunks, { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      useSetStore.getState().patchLive((doc) => ({
        ...doc,
        record: { ...doc.record, lastBlobUrl: url, recording: false },
      }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${useSetStore.getState().doc.title || "set"}-take.webm`;
      a.click();
    };
    try {
      rec.stop();
    } catch {
      /* */
    }
  }

  async unlock() {
    const ctx = await this.ensure();
    if (ctx.state === "suspended") await ctx.resume();
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function needsTransportSync(prev: SetDoc, next: SetDoc): boolean {
  if (
    prev.tracks !== next.tracks ||
    prev.arrangement !== next.arrangement ||
    prev.sampler !== next.sampler ||
    prev.record !== next.record
  ) {
    return true;
  }
  for (const id of ["A", "B", "C", "D"] as DeckId[]) {
    const a = prev.decks[id];
    const b = next.decks[id];
    if (
      a.trackId !== b.trackId ||
      a.playing !== b.playing ||
      a.positionBars !== b.positionBars ||
      a.bpm !== b.bpm ||
      a.keylock !== b.keylock ||
      a.loopBars !== b.loopBars ||
      a.loopInBars !== b.loopInBars
    ) {
      return true;
    }
  }
  return false;
}

function snapDeck(doc: SetDoc, deck: DeckId) {
  const d = doc.decks[deck];
  return {
    trackId: d.trackId,
    playing: d.playing,
    positionBars: d.positionBars,
  };
}

export const audioEngine = new AudioEngine();
