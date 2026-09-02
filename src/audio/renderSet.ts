import { saveAs } from "file-saver";
import type {
  AutomationParam,
  ChannelState,
  SetDoc,
} from "../types/setdoc";
import { getAudioBuffer } from "./bufferCache";
import {
  allAutomation,
  BACKSPIN_REWIND_BARS,
  backspinSpinWindow,
  buildTimeline,
  clockBpmAt,
  entryBpm,
  joinIsClockIndependent,
  sampleAutomation,
  setDurationBars,
  type TimelineSpan,
} from "../set/timeline";
import { encodeWav } from "./encodeWav";
import { captureDownloadWav } from "../analytics/tools";
import { reversedSlice } from "./reverseSlice";

const STEP_BARS = 1 / 16;
const SAMPLE_RATE = 44100;
const MAX_SECONDS = 30 * 60;

export type RenderSetResult = {
  blob: Blob;
  durationSec: number;
  sampleRate: number;
  bytes: number;
};

type MixerSnap = {
  crossfader: number;
  masterDb: number;
  xfaderCurve: SetDoc["mixer"]["xfaderCurve"];
  channels: Record<"A" | "B", ChannelState>;
  fxWet: number;
  fxType: SetDoc["fx"]["type"];
  fxSendA: number;
  fxSendB: number;
  bpm: number;
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function barSec(bpm: number) {
  return 240 / Math.max(1, bpm);
}

function clockBpm(doc: SetDoc, setBars: number): number {
  // Shared with the live performer (timeline.clockBpmAt) — the bounce clock
  // must integrate the exact same set-time the room hears.
  return clockBpmAt(doc, setBars);
}

function deckTargetBpm(doc: SetDoc, setBars: number, span: TimelineSpan): number {
  const live = buildTimeline(doc).filter(
    (s) => setBars >= s.setStart && setBars < s.setEnd,
  );
  const overlapping = live.length > 1;
  const tempoAuto = sampleAutomation(allAutomation(doc), "tempo", setBars);
  if (overlapping) {
    const incoming = live.reduce((a, b) => (a.setStart >= b.setStart ? a : b));
    if (joinIsClockIndependent(incoming.entry.transition.type)) {
      return entryBpm(doc, span.entry);
    }
    if (tempoAuto != null && tempoAuto > 0) return tempoAuto;
    if (doc.setTempoBpm != null && doc.setTempoBpm > 0) return doc.setTempoBpm;
    const outgoing = live.reduce((a, b) => (a.setStart <= b.setStart ? a : b));
    return entryBpm(doc, outgoing.entry);
  }
  return entryBpm(doc, span.entry);
}

function baselineMixer(doc: SetDoc): MixerSnap {
  const ch = (deck: "A" | "B"): ChannelState => ({
    ...doc.mixer.channels[deck],
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    filter: 0,
    fader: 0.75,
    gainDb: 0,
  });
  return {
    crossfader: -1,
    masterDb: doc.mixer.masterDb < -40 ? 0 : doc.mixer.masterDb,
    xfaderCurve: doc.mixer.xfaderCurve,
    channels: { A: ch("A"), B: ch("B") },
    fxWet: 0,
    fxType: "off",
    fxSendA: 0,
    fxSendB: 0,
    bpm: 120,
  };
}

/** Carry-forward mixer sampling — matches live applyAutomation (hold last values). */
function sampleMixer(
  doc: SetDoc,
  setBars: number,
  prev: MixerSnap,
  lanes: ReturnType<typeof allAutomation>,
): MixerSnap {
  const patch: Partial<Record<AutomationParam, number>> = {};
  const params: AutomationParam[] = [
    "tempo",
    "xfader",
    "filter_a",
    "filter_b",
    "eq_low_a",
    "eq_mid_a",
    "eq_high_a",
    "eq_low_b",
    "eq_mid_b",
    "eq_high_b",
    "fader_a",
    "fader_b",
    "gain_a",
    "gain_b",
    "fx_wet",
    "fx_arm",
  ];
  for (const p of params) {
    const v = sampleAutomation(lanes, p, setBars);
    if (v != null) patch[p] = v;
  }

  // Start from previous snap (not baseline) so xfader/EQ persist after lanes end.
  const next: MixerSnap = {
    ...prev,
    channels: {
      A: { ...prev.channels.A },
      B: { ...prev.channels.B },
    },
    bpm: clockBpm(doc, setBars),
  };

  if (patch.xfader != null) next.crossfader = clamp(patch.xfader, -1, 1);
  if (patch.filter_a != null) next.channels.A.filter = clamp(patch.filter_a, -1, 1);
  if (patch.filter_b != null) next.channels.B.filter = clamp(patch.filter_b, -1, 1);
  if (patch.eq_low_a != null) next.channels.A.eqLow = patch.eq_low_a;
  if (patch.eq_mid_a != null) next.channels.A.eqMid = patch.eq_mid_a;
  if (patch.eq_high_a != null) next.channels.A.eqHigh = patch.eq_high_a;
  if (patch.eq_low_b != null) next.channels.B.eqLow = patch.eq_low_b;
  if (patch.eq_mid_b != null) next.channels.B.eqMid = patch.eq_mid_b;
  if (patch.eq_high_b != null) next.channels.B.eqHigh = patch.eq_high_b;
  if (patch.fader_a != null) next.channels.A.fader = clamp(patch.fader_a, 0, 1);
  if (patch.fader_b != null) next.channels.B.fader = clamp(patch.fader_b, 0, 1);
  if (patch.gain_a != null) next.channels.A.gainDb = patch.gain_a;
  if (patch.gain_b != null) next.channels.B.gainDb = patch.gain_b;

  if (patch.fx_wet != null || patch.fx_arm != null) {
    const arm = patch.fx_arm ?? (patch.fx_wet != null && patch.fx_wet > 0.05 ? 1 : 0);
    const wet = patch.fx_wet != null ? clamp(patch.fx_wet, 0, 1) : next.fxWet;
    next.fxWet = wet;
    next.fxType = arm > 0.5 || wet > 0.03 ? "delay" : "off";
    if (arm > 0.5) {
      const xf = next.crossfader;
      next.fxSendA = xf <= 0 && next.channels.A.fader > 0.02 ? 0.55 : 0;
      next.fxSendB = xf >= 0 && next.channels.B.fader > 0.02 ? 0.55 : 0;
    } else {
      next.fxSendA = 0;
      next.fxSendB = 0;
    }
  }

  return next;
}

function xfGain(
  deck: "A" | "B",
  xf: number,
  curve: SetDoc["mixer"]["xfaderCurve"],
): number {
  if (curve === "smooth") {
    if (deck === "A") return Math.cos(((xf + 1) / 2) * (Math.PI / 2));
    return Math.sin(((xf + 1) / 2) * (Math.PI / 2));
  }
  if (deck === "A") return xf <= 0 ? 1 : Math.max(0, 1 - xf * 8);
  return xf >= 0 ? 1 : Math.max(0, 1 + xf * 8);
}

function channelGain(deck: "A" | "B", snap: MixerSnap): number {
  const ch = snap.channels[deck];
  return (
    ch.fader *
    xfGain(deck, snap.crossfader, snap.xfaderCurve) *
    Math.pow(10, ch.gainDb / 20)
  );
}

function applyFilter(filter: BiquadFilterNode, value: number, t: number) {
  if (Math.abs(value) < 0.05) {
    filter.type = "allpass";
    filter.frequency.setValueAtTime(1000, t);
  } else if (value < 0) {
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(400 + (1 + value) * 8000, t);
    filter.Q.setValueAtTime(0.7, t);
  } else {
    filter.type = "highpass";
    filter.frequency.setValueAtTime(40 + value * 4000, t);
    filter.Q.setValueAtTime(0.7, t);
  }
}

async function loadTrackBuffers(
  doc: SetDoc,
  decodeCtx: BaseAudioContext,
): Promise<Map<string, AudioBuffer>> {
  const ids = [...new Set(doc.arrangement.map((e) => e.trackId))];
  const map = new Map<string, AudioBuffer>();
  for (const id of ids) {
    const track = doc.tracks[id];
    if (!track) throw new Error(`Missing track ${id}`);
    const buf = await getAudioBuffer(decodeCtx, track.fileRef);
    if (!buf) {
      throw new Error(`Audio missing for “${track.title}” — re-upload or Share/.blset`);
    }
    map.set(id, buf);
  }
  return map;
}

type DeckChain = {
  input: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  send: GainNode;
};

function makeDeckChain(ctx: OfflineAudioContext, master: GainNode, fxIn: GainNode): DeckChain {
  const input = ctx.createGain();
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
  const gain = ctx.createGain();
  const send = ctx.createGain();
  send.gain.value = 0;

  input.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(filter);
  filter.connect(gain);
  gain.connect(master);
  filter.connect(send);
  send.connect(fxIn);

  return { input, eqLow, eqMid, eqHigh, filter, gain, send };
}

export type SetClockMap = {
  durationSec: number;
  barsToSec: (bars: number) => number;
};

/**
 * Set-clock → wall-second map with mixer carry-forward — the same integration
 * the bounce uses, exported so review_set can point at the render in bars.
 */
export function setClockMap(doc: SetDoc): SetClockMap {
  const durBars = setDurationBars(doc);
  const lanes = allAutomation(doc);
  let snap = baselineMixer(doc);
  let sec = 0;
  const steps: { bars: number; sec: number }[] = [];
  for (let bars = 0; bars <= durBars + 1e-6; bars += STEP_BARS) {
    snap = sampleMixer(doc, bars, snap, lanes);
    steps.push({ bars, sec });
    sec += STEP_BARS * barSec(snap.bpm);
  }
  const durationSec = Math.min(MAX_SECONDS, steps[steps.length - 1]?.sec ?? 0);
  const barsToSec = (bars: number): number => {
    if (bars <= 0) return 0;
    if (bars >= steps[steps.length - 1]!.bars) return durationSec;
    const idx = Math.min(
      steps.length - 2,
      Math.max(0, Math.floor(bars / STEP_BARS)),
    );
    const a = steps[idx]!;
    const b = steps[idx + 1] ?? a;
    const t = (bars - a.bars) / Math.max(1e-6, b.bars - a.bars);
    return a.sec + (b.sec - a.sec) * t;
  };
  return { durationSec, barsToSec };
}

/**
 * Offline render of the arrangement to an AudioBuffer. Tempo uses
 * playbackRate (no SoundTouch keylock in OfflineAudioContext) — the bounce
 * pitch-bends where live keylocks; loop rolls render like the live watch.
 */
export async function renderSetToBuffer(
  doc: SetDoc,
  onProgress?: (p: number, label: string) => void,
): Promise<{ buffer: AudioBuffer; durationSec: number; barsToSec: (bars: number) => number }> {
  if (!doc.arrangement.length) {
    throw new Error("Empty arrangement — add tracks to the set first");
  }

  const spans = buildTimeline(doc);
  const durBars = setDurationBars(doc);
  if (durBars <= 0) throw new Error("Set has no duration");

  onProgress?.(0.02, "Loading audio…");

  const decodeCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  let buffers: Map<string, AudioBuffer>;
  try {
    buffers = await loadTrackBuffers(doc, decodeCtx);
  } finally {
    void decodeCtx.close();
  }

  // Integrate set clock → wall seconds (carry mixer state like live patchLive)
  const steps: { bars: number; sec: number; snap: MixerSnap }[] = [];
  const lanes = allAutomation(doc);
  let snap = baselineMixer(doc);
  let sec = 0;
  for (let bars = 0; bars <= durBars + 1e-6; bars += STEP_BARS) {
    snap = sampleMixer(doc, bars, snap, lanes);
    steps.push({ bars, sec, snap });
    sec += STEP_BARS * barSec(snap.bpm);
  }
  const base = steps[0]?.snap ?? baselineMixer(doc);
  const durationSec = Math.min(MAX_SECONDS, steps[steps.length - 1]!.sec);
  if (durationSec < 0.25) throw new Error("Set too short to bounce");

  const length = Math.ceil(durationSec * SAMPLE_RATE);
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE);
  const master = ctx.createGain();
  master.gain.value = Math.pow(10, base.masterDb / 20);
  master.connect(ctx.destination);

  const fxIn = ctx.createGain();
  const delay = ctx.createDelay(2);
  const delayFb = ctx.createGain();
  delayFb.gain.value = 0.4;
  const delayFilter = ctx.createBiquadFilter();
  delayFilter.type = "lowpass";
  delayFilter.frequency.value = 3500;
  const fxWet = ctx.createGain();
  fxWet.gain.value = 0;
  fxIn.connect(delay);
  delay.connect(delayFilter);
  delayFilter.connect(delayFb);
  delayFb.connect(delay);
  delayFilter.connect(fxWet);
  fxWet.connect(master);

  const decks: Record<"A" | "B", DeckChain> = {
    A: makeDeckChain(ctx, master, fxIn),
    B: makeDeckChain(ctx, master, fxIn),
  };

  const barsToSec = (bars: number): number => {
    if (bars <= 0) return 0;
    if (bars >= steps[steps.length - 1]!.bars) return durationSec;
    const idx = Math.min(
      steps.length - 2,
      Math.max(0, Math.floor(bars / STEP_BARS)),
    );
    const a = steps[idx]!;
    const b = steps[idx + 1] ?? a;
    const t = (bars - a.bars) / Math.max(1e-6, b.bars - a.bars);
    return a.sec + (b.sec - a.sec) * t;
  };

  onProgress?.(0.15, "Scheduling mix…");

  // Automate mixer params along the set clock
  for (const step of steps) {
    if (step.sec > durationSec) break;
    const t = step.sec;
    const { snap } = step;
    master.gain.setValueAtTime(Math.pow(10, snap.masterDb / 20), t);
    fxWet.gain.setValueAtTime(snap.fxType === "off" ? 0 : snap.fxWet, t);
    delay.delayTime.setValueAtTime(
      Math.min(1.9, 0.75 * (60 / Math.max(1, snap.bpm))),
      t,
    );

    for (const deck of ["A", "B"] as const) {
      const chain = decks[deck];
      const ch = snap.channels[deck];
      chain.gain.gain.setValueAtTime(channelGain(deck, snap), t);
      chain.eqLow.gain.setValueAtTime(ch.eqLow, t);
      chain.eqMid.gain.setValueAtTime(ch.eqMid, t);
      chain.eqHigh.gain.setValueAtTime(ch.eqHigh, t);
      applyFilter(chain.filter, ch.filter, t);
      const send =
        snap.fxType === "off"
          ? 0
          : (deck === "A" ? snap.fxSendA : snap.fxSendB) *
            xfGain(deck, snap.crossfader, snap.xfaderCurve) *
            ch.fader;
      chain.send.gain.setValueAtTime(send, t);
    }
  }

  const scheduleForward = (
    span: TimelineSpan,
    buffer: AudioBuffer,
    nativeBpm: number,
    fromBars: number,
    toBars: number,
    offsetBars: number,
  ) => {
    const startSec = barsToSec(fromBars);
    const endSec = Math.min(durationSec, barsToSec(toBars));
    if (endSec - startSec < 0.02) return;
    const offsetSec = Math.max(
      0,
      Math.min(buffer.duration - 0.01, offsetBars * barSec(nativeBpm)),
    );
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(decks[span.deck].input);
    let armed = false;
    for (const step of steps) {
      if (step.bars < fromBars - 1e-6) continue;
      if (step.bars >= toBars) break;
      const rate = deckTargetBpm(doc, step.bars, span) / Math.max(1e-6, nativeBpm);
      const t = Math.max(startSec, step.sec);
      if (!armed) {
        src.playbackRate.setValueAtTime(clamp(rate, 0.05, 4), t);
        armed = true;
      } else {
        src.playbackRate.linearRampToValueAtTime(clamp(rate, 0.05, 4), t);
      }
    }
    try {
      src.start(startSec, offsetSec);
      src.stop(endSec);
    } catch {
      /* schedule edge */
    }
  };

  // Schedule each arrangement span onto its deck
  for (const span of spans) {
    const track = doc.tracks[span.entry.trackId];
    const buffer = buffers.get(span.entry.trackId);
    if (!track?.analysis || !buffer) continue;

    const nativeBpm = track.analysis.bpm || entryBpm(doc, span.entry);
    const next = spans[span.entryIndex + 1];
    const spinNext =
      next?.entry.transition.type === "backspin" && next.overlapBars > 0 ? next : null;

    // Loop-roll parity with the live performer's applyLoopOut: when the NEXT
    // entry rolls the outgoing (loop_out / loop_roll across the window, or
    // tease_slam's 1→0.5 stutter in the final 2 bars), the tail loops instead
    // of playing straight through. The forward run stops where the roll starts.
    const rollNext =
      next &&
      next.overlapBars > 0 &&
      (next.entry.transition.type === "loop_out" ||
        next.entry.transition.type === "loop_roll" ||
        next.entry.transition.type === "tease_slam")
        ? next
        : null;
    const rollPhases: { from: number; to: number; len: number }[] = [];
    if (rollNext) {
      const winStart = rollNext.setStart;
      const winEnd = Math.min(rollNext.setStart + rollNext.overlapBars, span.setEnd);
      const kind = rollNext.entry.transition.type;
      if (kind === "tease_slam") {
        rollPhases.push({ from: winEnd - 2, to: winEnd - 1, len: 1 });
        rollPhases.push({ from: winEnd - 1, to: winEnd, len: 0.5 });
      } else if (kind === "loop_roll") {
        const n = winEnd - winStart;
        rollPhases.push({ from: winStart, to: winStart + n * 0.34, len: 2 });
        rollPhases.push({ from: winStart + n * 0.34, to: winStart + n * 0.67, len: 1 });
        rollPhases.push({ from: winStart + n * 0.67, to: winEnd, len: 0.5 });
      } else {
        rollPhases.push({
          from: winStart,
          to: winEnd,
          len: Math.max(0.5, Math.min(2, rollNext.overlapBars)),
        });
      }
    }

    let fromBars = span.setStart;
    let toBars = span.setEnd;
    let offsetBars = span.entry.inBars;

    if (span.entry.transition.type === "backspin" && span.entryIndex > 0) {
      const prev = spans[span.entryIndex - 1]!;
      fromBars = prev.setEnd;
      offsetBars = span.entry.inBars;
    }

    if (spinNext) {
      const { start, end } = backspinSpinWindow(spinNext, span);
      toBars = start;
      const originBars = span.entry.inBars + (start - span.setStart);
      const sliceStartBars = Math.max(span.entry.inBars, originBars - BACKSPIN_REWIND_BARS);
      const nativeBar = barSec(nativeBpm);
      const slice = reversedSlice(
        ctx,
        buffer,
        sliceStartBars * nativeBar,
        Math.max(0.12, (originBars - sliceStartBars) * nativeBar),
      );
      const spinStartSec = barsToSec(start);
      const spinEndSec = Math.min(durationSec, barsToSec(end));
      const wall = spinEndSec - spinStartSec;
      if (wall > 0.02 && slice.length > 1) {
        const rev = ctx.createBufferSource();
        rev.buffer = slice;
        rev.connect(decks[span.deck].input);
        const meanRate = slice.duration / wall;
        rev.playbackRate.setValueAtTime(Math.max(0.7, meanRate * 0.55), spinStartSec);
        rev.playbackRate.linearRampToValueAtTime(
          Math.max(1, meanRate * 1.45),
          spinEndSec,
        );
        try {
          rev.start(spinStartSec);
          rev.stop(spinEndSec);
        } catch {
          /* schedule edge */
        }
      }
    }

    if (rollPhases.length) {
      toBars = Math.min(toBars, Math.max(rollPhases[0]!.from, span.setStart));
    }

    scheduleForward(span, buffer, nativeBpm, fromBars, toBars, offsetBars);

    if (rollNext && rollPhases.length) {
      const nativeBar = barSec(nativeBpm);
      for (const phase of rollPhases) {
        const pStart = Math.max(phase.from, span.setStart);
        const pEnd = Math.min(phase.to, span.setEnd);
        if (pEnd - pStart < 0.02) continue;
        const loopInBars = Math.max(span.entry.inBars, span.entry.outBars - phase.len);
        const startSec = barsToSec(pStart);
        const endSec = Math.min(durationSec, barsToSec(pEnd));
        if (endSec - startSec < 0.02) continue;
        const playheadBars = span.entry.inBars + (pStart - span.setStart);
        const offsetSec = Math.max(
          0,
          Math.min(buffer.duration - 0.01, playheadBars * nativeBar),
        );
        const loopStartSec = Math.max(0, Math.min(buffer.duration - 0.02, loopInBars * nativeBar));
        const loopEndSec = Math.max(
          loopStartSec + 0.03,
          Math.min(buffer.duration, span.entry.outBars * nativeBar),
        );
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.loopStart = loopStartSec;
        src.loopEnd = loopEndSec;
        src.connect(decks[span.deck].input);
        let armed = false;
        for (const step of steps) {
          if (step.bars < pStart - 1e-6) continue;
          if (step.bars >= pEnd) break;
          const rate = deckTargetBpm(doc, step.bars, span) / Math.max(1e-6, nativeBpm);
          const t = Math.max(startSec, step.sec);
          if (!armed) {
            src.playbackRate.setValueAtTime(clamp(rate, 0.05, 4), t);
            armed = true;
          } else {
            src.playbackRate.linearRampToValueAtTime(clamp(rate, 0.05, 4), t);
          }
        }
        try {
          // loop=true: plays the lead-in once, then wraps inside
          // [loopStart, loopEnd) — the live loop watch's exact shape.
          src.start(startSec, Math.min(offsetSec, loopEndSec - 0.01));
          src.stop(endSec);
        } catch {
          /* schedule edge */
        }
      }
    }
  }

  onProgress?.(0.35, "Rendering…");
  const rendered = await ctx.startRendering();
  onProgress?.(1, "Done");

  return {
    buffer: rendered,
    durationSec: rendered.duration,
    barsToSec,
  };
}

/**
 * Offline bounce of the arrangement (transitions + automation) to a WAV blob.
 * Tempo uses playbackRate (no SoundTouch keylock in OfflineAudioContext).
 */
export async function renderSetToWav(
  doc: SetDoc,
  onProgress?: (p: number, label: string) => void,
): Promise<RenderSetResult> {
  const { buffer, durationSec } = await renderSetToBuffer(doc, onProgress);
  onProgress?.(0.9, "Encoding WAV…");
  const blob = encodeWav(buffer);
  return {
    blob,
    durationSec,
    sampleRate: buffer.sampleRate,
    bytes: blob.size,
  };
}

export async function downloadSetWav(
  doc: SetDoc,
  filename?: string,
  onProgress?: (p: number, label: string) => void,
): Promise<RenderSetResult> {
  const result = await renderSetToWav(doc, onProgress);
  const safe =
    (filename ?? (doc.title || "bananalabs-set"))
      .replace(/[^\w\-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 64) || "bananalabs-set";
  saveAs(result.blob, `${safe}.wav`);
  captureDownloadWav(result.bytes, result.durationSec);
  return result;
}
