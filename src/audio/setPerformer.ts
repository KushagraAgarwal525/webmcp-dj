import { audioEngine } from "./engine";
import { useSetStore } from "../commands/pipeline";
import type { AutomationParam, ChannelState, DeckId, SetDoc } from "../types/setdoc";
import {
  allAutomation,
  backspinPlayheadBars,
  backspinSpinWindow,
  buildTimeline,
  clockBpmAt,
  entryBpm,
  joinIsClockIndependent,
  livePlayheadBars,
  sampleAutomation,
  sampleAutomationHeld,
  setDurationBars,
  spanPlayheadBars,
  type TimelineSpan,
} from "../set/timeline";
import { getAudioBuffer, peekAudioBuffer } from "./bufferCache";

type ActiveSlot = {
  entryIndex: number;
  trackId: string;
};

class SetPerformer {
  private raf = 0;
  private lastCtxTime = 0;
  private positionBars = 0;
  private active: Partial<Record<"A" | "B", ActiveSlot>> = {};
  private starting = false;
  /** One sync at a time; ticks set dirty instead of cancelling in-flight work. */
  private syncInFlight = false;
  private syncNeeded = false;
  private lastDriftSeekMs: Partial<Record<"A" | "B", number>> = {};
  private lastUiTransportMs = 0;
  private lastAutoKey = "";
  private suppressDriftUntil = 0;
  private hiddenTimer: ReturnType<typeof setInterval> | undefined;
  private visibilityWatch = false;
  /** Decks WE unlocked for a ride scream → the track they rode (safe restore). */
  private rideKeylockOff = new Map<DeckId, string>();

  isPlaying() {
    return useSetStore.getState().transport.setPlaying;
  }

  getPositionBars() {
    return useSetStore.getState().transport.setPositionBars;
  }

  async toggle() {
    if (this.isPlaying()) {
      this.pause();
      return;
    }
    // One click: stop loose deck preview, then perform the set (or resume loose play).
    await this.stopLooseDecks();
    await this.play();
  }

  private async stopLooseDecks() {
    const doc = useSetStore.getState().doc;
    const dispatch = useSetStore.getState().dispatch;
    for (const deck of ["A", "B"] as const) {
      if (doc.decks[deck].playing) {
        dispatch({ type: "deck.pause", deck }, "ui");
      }
    }
    // Let engine apply pause before we start set playback.
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  }

  async play(fromBars?: number) {
    if (this.starting) return;
    this.starting = true;
    try {
      await audioEngine.unlock();
      const doc = useSetStore.getState().doc;

      if (!doc.arrangement.length) {
        audioEngine.setPerformerSync(false);
        await this.playLooseDecks();
        return;
      }

      audioEngine.setPerformerSync(true);
      const dur = setDurationBars(doc);
      let start =
        fromBars != null
          ? Math.max(0, fromBars)
          : useSetStore.getState().transport.setPositionBars;

      // Stale playhead after a finished set / agent rewrite → start from top.
      if (fromBars == null && (start >= dur - 0.05 || !Number.isFinite(start) || start < 0)) {
        start = 0;
      }

      this.positionBars = start;
      this.active = {};

      const dispatch = useSetStore.getState().dispatch;
      for (const deck of ["A", "B"] as const) {
        if (useSetStore.getState().doc.decks[deck].playing) {
          dispatch({ type: "deck.pause", deck }, "system");
        }
      }

      useSetStore.getState().patchLive((d) => resetMixerForSet(d));

      useSetStore.getState().setTransport({
        setPlaying: true,
        setPositionBars: this.positionBars,
        entryIndex: 0,
      });
      useSetStore.getState().setActivity("Playing set");

      // Tempo + mixer first, then load/seek/play so decks never start at native BPM.
      this.lastAutoKey = "";
      this.applyAutomation(useSetStore.getState().doc, this.positionBars);
      await this.runSyncDecks(true);
      this.applyAutomation(useSetStore.getState().doc, this.positionBars);

      this.attachVisibility();
      this.lastCtxTime = audioEngine.getCurrentTime();
      this.lastUiTransportMs = 0;
      this.suppressDriftUntil = 0;
      this.clearHiddenTimer();
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.tick());
    } finally {
      this.starting = false;
    }
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.clearHiddenTimer();
    this.syncNeeded = false;
    audioEngine.setPerformerSync(false);
    useSetStore.getState().setTransport({ setPlaying: false });
    for (const deck of ["A", "B"] as const) {
      if (useSetStore.getState().doc.decks[deck].playing) {
        useSetStore.getState().dispatch({ type: "deck.pause", deck }, "system");
      }
    }
    // Restore ride keylocks while the decks are stopped — click-free.
    for (const deck of this.rideKeylockOff.keys()) {
      if (!useSetStore.getState().doc.decks[deck].keylock) {
        useSetStore.getState().dispatch(
          { type: "deck.setOptions", deck, keylock: true },
          "system",
        );
      }
    }
    this.rideKeylockOff.clear();
    this.active = {};
    useSetStore.getState().setActivity("Paused");
  }

  /**
   * Vinyl pitch drama on tempo rides — dosed. Only the FINAL 4 bars of the
   * lane unlock the OUTGOING deck's keylock: the scream stacks with the HP
   * rise and the loop roll where the build peaks. A full-window unlock lets
   * the pitch creep for 12+ bars — the bass rises off its sweet spot and the
   * record goes thin (that read as "dull"). The incoming deck keeps keylock
   * so the drop lands pitch-true with no stretch-toggle click on the 1.
   * Restore once the deck is idle OR has moved to another record (the engine
   * restarts the source on load anyway, so the toggle rides along) — before
   * the track check, a deck that rolled straight into the next span kept
   * keylock off for the whole record.
   */
  private applyRideKeylock(doc: SetDoc, setBars: number) {
    const activeLane = allAutomation(doc).find(
      (l) => l.param === "tempo" && setBars >= l.startBars && setBars <= l.endBars,
    );
    const screaming = activeLane != null && setBars >= activeLane.endBars - 4;
    if (screaming) {
      const live = buildTimeline(doc).filter(
        (s) => setBars >= s.setStart && setBars < s.setEnd,
      );
      if (live.length > 1) {
        const outgoing = live.reduce((a, b) => (a.setStart <= b.setStart ? a : b));
        const deck = outgoing.deck;
        if (doc.decks[deck].keylock) {
          useSetStore.getState().dispatch(
            { type: "deck.setOptions", deck, keylock: false },
            "system",
          );
        }
        this.rideKeylockOff.set(deck, outgoing.entry.trackId);
      }
      return;
    }
    for (const [deck, rodeTrack] of this.rideKeylockOff) {
      const d = doc.decks[deck];
      if (!d.keylock && (!d.playing || d.trackId !== rodeTrack)) {
        useSetStore.getState().dispatch(
          { type: "deck.setOptions", deck, keylock: true },
          "system",
        );
        this.rideKeylockOff.delete(deck);
      }
    }
  }

  async seek(setBars: number) {
    const doc = useSetStore.getState().doc;
    const dur = setDurationBars(doc);
    this.positionBars = Math.max(0, Math.min(setBars, Math.max(0, dur)));
    this.active = {};
    this.lastAutoKey = "";
    this.lastDriftSeekMs = {};
    useSetStore.getState().setTransport({ setPositionBars: this.positionBars });
    this.applyAutomation(useSetStore.getState().doc, this.positionBars);
    this.lastCtxTime = audioEngine.getCurrentTime();
    this.suppressDriftUntil = performance.now() + 250;
    // Wait for any in-flight tick sync, then force a complete sync that isn't cancelled.
    await this.waitForSyncIdle();
    await this.runSyncDecks(this.isPlaying());
    this.applyAutomation(useSetStore.getState().doc, this.positionBars);
    this.lastCtxTime = audioEngine.getCurrentTime();
    // Keep UI playheads in sync immediately after ruler seek.
    this.updatePlayheads(useSetStore.getState().doc);
  }

  private attachVisibility() {
    if (this.visibilityWatch || typeof document === "undefined") return;
    this.visibilityWatch = true;
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private onVisibility = () => {
    if (document.visibilityState === "hidden") this.onPageHidden();
    else void this.onPageVisible();
  };

  private clearHiddenTimer() {
    if (!this.hiddenTimer) return;
    clearInterval(this.hiddenTimer);
    this.hiddenTimer = undefined;
  }

  private onPageHidden() {
    if (!this.isPlaying() || this.hiddenTimer) return;
    this.hiddenTimer = setInterval(() => this.hiddenTick(), 250);
  }

  private async onPageVisible() {
    this.clearHiddenTimer();
    await audioEngine.unlock();
    if (!this.isPlaying()) return;
    this.suppressDriftUntil = performance.now() + 500;
    if (!this.raf) {
      this.raf = requestAnimationFrame(() => this.tick());
    }
  }

  /** Advance set clock from AudioContext time — survives rAF pauses while audio runs. */
  private advanceClock() {
    const ctxNow = audioEngine.getCurrentTime();
    if (this.lastCtxTime <= 0) {
      this.lastCtxTime = ctxNow;
      return;
    }
    let dt = ctxNow - this.lastCtxTime;
    // Context was recreated / currentTime reset — don't yank the playhead.
    if (!Number.isFinite(dt) || dt < 0 || (this.lastCtxTime > 1 && ctxNow < 0.5)) {
      this.lastCtxTime = ctxNow;
      return;
    }
    this.lastCtxTime = ctxNow;
    const doc = useSetStore.getState().doc;
    this.positionBars += dt * (this.clockBpm(doc, this.positionBars) / 240);
  }

  private hiddenTick() {
    if (!this.isPlaying()) return;
    this.advanceClock();
    const doc = useSetStore.getState().doc;
    const dur = setDurationBars(doc);
    if (dur > 0 && this.positionBars >= dur) {
      this.positionBars = 0;
      useSetStore.getState().setTransport({ setPositionBars: 0 });
      this.pause();
      useSetStore.getState().setActivity("Set finished");
      return;
    }
    this.applyAutomation(doc, this.positionBars);
    this.applyBackspin(doc, this.positionBars);
    this.applyRideKeylock(doc, this.positionBars);
  }

  private async playLooseDecks() {
    const doc = useSetStore.getState().doc;
    const dispatch = useSetStore.getState().dispatch;
    if (doc.decks.A.trackId) {
      dispatch({ type: "deck.play", deck: "A" }, "ui");
    } else if (doc.decks.B.trackId) {
      dispatch({ type: "deck.play", deck: "B" }, "ui");
    }
  }

  private tick() {
    if (!useSetStore.getState().transport.setPlaying) return;

    this.advanceClock();

    const doc = useSetStore.getState().doc;
    const dur = setDurationBars(doc);

    if (dur > 0 && this.positionBars >= dur) {
      this.positionBars = 0;
      useSetStore.getState().setTransport({ setPositionBars: 0 });
      this.pause();
      useSetStore.getState().setActivity("Set finished");
      return;
    }

    this.applyAutomation(doc, this.positionBars);
    this.applyLoopOut(doc, this.positionBars);
    this.applyRideKeylock(doc, this.positionBars);
    if (typeof document === "undefined" || document.visibilityState === "visible") {
      void this.queueSyncDecks(doc, this.positionBars, true);
    }
    this.applyBackspin(doc, this.positionBars);
    this.prefetchUpcoming(doc, this.positionBars);

    const spans = buildTimeline(doc);
    let entryIndex = 0;
    for (const s of spans) {
      if (this.positionBars >= s.setStart) entryIndex = s.entryIndex;
    }

    // UI transport at ~20 Hz — audio clock stays full-rate above.
    const nowUi = performance.now();
    if (nowUi - this.lastUiTransportMs >= 50) {
      this.lastUiTransportMs = nowUi;
      this.updatePlayheads(doc, spans, {
        setPositionBars: this.positionBars,
        entryIndex,
      });
    }

    this.raf = requestAnimationFrame(() => this.tick());
  }

  private updatePlayheads(
    doc: SetDoc,
    spans = buildTimeline(doc),
    extra?: { setPositionBars?: number; entryIndex?: number },
  ) {
    const heads: Partial<Record<DeckId, number>> = {};
    const setBars = this.positionBars;

    for (const deck of ["A", "B"] as DeckId[]) {
      // Authoritative during set performance: map set clock → track bars
      const span = [...spans].reverse().find(
        (s) => s.deck === deck && setBars >= s.setStart && setBars < s.setEnd,
      );
      if (span) {
        const trackBars = livePlayheadBars(spans, span, setBars);
        const dur = doc.tracks[span.entry.trackId]?.analysis?.durationBars;
        heads[deck] =
          dur != null ? Math.min(trackBars, Math.max(0, dur - 0.01)) : trackBars;
      } else if (doc.decks[deck].trackId) {
        heads[deck] = audioEngine.getPositionBars(deck);
      }
    }
    useSetStore.getState().setTransport({
      deckPlayheads: heads as Record<DeckId, number>,
      ...extra,
    });
  }

  private applyAutomation(doc: SetDoc, setBars: number) {
    const lanes = allAutomation(doc);
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
      // Held values so seek/jump into later spans keeps xfader/EQ from prior transitions.
      const v = sampleAutomationHeld(lanes, p, setBars);
      if (v != null) patch[p] = v;
    }

    if (!Object.keys(patch).length) return;

    // Skip identical automation frames (same DSP targets → no doc churn / engine sync).
    const key = Object.keys(patch)
      .sort()
      .map((k) => `${k}:${Math.round((patch[k as AutomationParam] as number) * 1000)}`)
      .join("|");
    if (key === this.lastAutoKey) return;
    this.lastAutoKey = key;

    useSetStore.getState().patchLive((d) => {
      let next = d;
      const mixer = { ...next.mixer, channels: { ...next.mixer.channels } };
      let dirty = false;

      const setCh = (deck: DeckId, key: keyof ChannelState, value: number) => {
        mixer.channels[deck] = { ...mixer.channels[deck], [key]: value };
        dirty = true;
      };

      if (patch.xfader != null) {
        mixer.crossfader = clamp(patch.xfader, -1, 1);
        dirty = true;
      }
      if (patch.filter_a != null) setCh("A", "filter", clamp(patch.filter_a, -1, 1));
      if (patch.filter_b != null) setCh("B", "filter", clamp(patch.filter_b, -1, 1));
      if (patch.eq_low_a != null) setCh("A", "eqLow", patch.eq_low_a);
      if (patch.eq_mid_a != null) setCh("A", "eqMid", patch.eq_mid_a);
      if (patch.eq_high_a != null) setCh("A", "eqHigh", patch.eq_high_a);
      if (patch.eq_low_b != null) setCh("B", "eqLow", patch.eq_low_b);
      if (patch.eq_mid_b != null) setCh("B", "eqMid", patch.eq_mid_b);
      if (patch.eq_high_b != null) setCh("B", "eqHigh", patch.eq_high_b);
      if (patch.fader_a != null) setCh("A", "fader", clamp(patch.fader_a, 0, 1));
      if (patch.fader_b != null) setCh("B", "fader", clamp(patch.fader_b, 0, 1));
      if (patch.gain_a != null) setCh("A", "gainDb", patch.gain_a);
      if (patch.gain_b != null) setCh("B", "gainDb", patch.gain_b);

      if (dirty) next = { ...next, mixer };

      if (patch.fx_wet != null || patch.fx_arm != null) {
        const arm = patch.fx_arm ?? (patch.fx_wet != null && patch.fx_wet > 0.05 ? 1 : 0);
        const wet =
          patch.fx_wet != null ? clamp(patch.fx_wet, 0, 1) : next.fx.wet;
        next = {
          ...next,
          fx: {
            ...next.fx,
            wet,
            type:
              arm > 0.5 || wet > 0.03
                ? "delay"
                : next.fx.type === "delay"
                  ? "off"
                  : next.fx.type,
            timeBeats: arm > 0.5 ? Math.max(next.fx.timeBeats, 0.75) : next.fx.timeBeats,
            feedback: arm > 0.5 ? Math.max(next.fx.feedback, 0.4) : next.fx.feedback,
          },
        };
        const decks = { ...next.decks };
        const xf = mixer.crossfader;
        // Only the leave deck feeds the send — never both, never the incoming record.
        if (arm > 0.5) {
          const aFader = mixer.channels.A.fader;
          const bFader = mixer.channels.B.fader;
          decks.A = {
            ...decks.A,
            fxSend: xf <= 0 && aFader > 0.02 ? 0.55 : 0,
          };
          decks.B = {
            ...decks.B,
            fxSend: xf >= 0 && bFader > 0.02 ? 0.55 : 0,
          };
        } else {
          decks.A = { ...decks.A, fxSend: 0 };
          decks.B = { ...decks.B, fxSend: 0 };
        }
        next = { ...next, decks };
      }

      return next;
    });
  }

  private clockBpm(doc: SetDoc, setBars: number): number {
    // Shared with the offline bounce — during un-laned overlaps the clock
    // follows the outgoing deck (the one still driving), never the parked
    // incoming span's native bpm.
    return clockBpmAt(doc, setBars);
  }

  private deckTargetBpm(doc: SetDoc, setBars: number, span: TimelineSpan): number {
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

  /** Tick path: never cancel an in-flight sync — just mark dirty. */
  private queueSyncDecks(_doc: SetDoc, _setBars: number, shouldPlay: boolean) {
    if (this.syncInFlight) {
      this.syncNeeded = true;
      return;
    }
    void this.runSyncDecks(shouldPlay);
  }

  private async waitForSyncIdle() {
    const start = performance.now();
    while (this.syncInFlight && performance.now() - start < 8000) {
      await new Promise((r) => setTimeout(r, 16));
    }
  }

  /** Complete at most two syncs; leftover dirty is picked up on the next tick. */
  private async runSyncDecks(shouldPlay: boolean) {
    if (this.syncInFlight) {
      this.syncNeeded = true;
      await this.waitForSyncIdle();
      if (this.syncInFlight) return;
    }
    this.syncInFlight = true;
    try {
      this.syncNeeded = false;
      await this.syncDecks(useSetStore.getState().doc, this.positionBars, shouldPlay);
      // One catch-up if ticks marked dirty during the first (usually a load).
      if (this.syncNeeded) {
        this.syncNeeded = false;
        await this.syncDecks(useSetStore.getState().doc, this.positionBars, shouldPlay);
      }
    } finally {
      this.syncInFlight = false;
    }
  }

  private prefetchUpcoming(doc: SetDoc, setBars: number) {
    const spans = buildTimeline(doc);
    const upcoming = spans.find((s) => s.setStart > setBars && s.setStart <= setBars + 16);
    if (!upcoming) return;
    const track = doc.tracks[upcoming.entry.trackId];
    if (!track || peekAudioBuffer(track.fileRef)) return;
    // Prefetch into shared cache without blocking the audio clock.
    void audioEngine.ensure().then((c) => getAudioBuffer(c, track.fileRef));
  }

  private async syncDecks(doc: SetDoc, setBars: number, shouldPlay: boolean) {
    const spans = buildTimeline(doc);
    const wanted = new Map<"A" | "B", TimelineSpan>();
    for (const span of spans) {
      if (setBars >= span.setStart && setBars < span.setEnd) {
        wanted.set(span.deck, span);
      }
    }
    if (!wanted.size && spans.length) {
      const last = spans[spans.length - 1]!;
      if (setBars >= last.setEnd) wanted.set(last.deck, last);
    }

    const store = useSetStore.getState();

    for (const deck of ["A", "B"] as const) {
      const span = wanted.get(deck);
      if (!span) {
        if (store.doc.decks[deck].playing) {
          store.dispatch({ type: "deck.pause", deck }, "system");
        }
        delete this.active[deck];
        continue;
      }

      const trackBars = spanPlayheadBars(spans, span, setBars);
      const prev = this.active[deck];
      const needLoad =
        !prev ||
        prev.trackId !== span.entry.trackId ||
        prev.entryIndex !== span.entryIndex ||
        store.doc.decks[deck].trackId !== span.entry.trackId;
      const bpm = this.deckTargetBpm(store.doc, setBars, span);

      const seekExact = (bars: number) => {
        store.dispatch(
          { type: "deck.seek", deck, positionBars: bars, exact: true },
          "system",
        );
      };
      const matchTempo = () => {
        const live = useSetStore.getState().doc.decks[deck];
        // Round: a tempo lane yields a fresh float every tick — dispatching
        // each one is a store/engine sync storm across the whole ramp.
        if (live.trackId && (live.bpm == null || Math.abs(live.bpm - bpm) > 0.05)) {
          useSetStore.getState().dispatch({ type: "deck.setTempo", deck, bpm }, "system");
        }
      };

      if (needLoad) {
        store.dispatch(
          { type: "deck.load", deck, trackId: span.entry.trackId },
          "system",
        );
        // deck.load resets BPM to native — lock to set tempo before any audio starts.
        matchTempo();
        await waitForBuffer(deck, 4000);
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        if (!audioEngine.isBufferReady(deck)) {
          await waitForBuffer(deck, 4000);
        }
        matchTempo();
        seekExact(trackBars);
        this.active[deck] = {
          entryIndex: span.entryIndex,
          trackId: span.entry.trackId,
        };
        if (shouldPlay) {
          useSetStore.getState().dispatch({ type: "deck.play", deck }, "system");
          if (!audioEngine.isBufferReady(deck)) {
            await waitForBuffer(deck, 4000);
            matchTempo();
            seekExact(trackBars);
            useSetStore.getState().dispatch({ type: "deck.play", deck }, "system");
          }
        }
      } else if (shouldPlay) {
        matchTempo();
        const engineBars = audioEngine.getPositionBars(deck);
        const livePlaying = useSetStore.getState().doc.decks[deck].playing;
        if (!livePlaying) {
          seekExact(trackBars);
          useSetStore.getState().dispatch({ type: "deck.play", deck }, "system");
        } else {
          const drift = Math.abs(engineBars - trackBars);
          const looping = useSetStore.getState().doc.decks[deck].loopBars != null;
          const spinning = isBackspinDeck(doc, setBars, deck);
          const now = performance.now();
          // Re-seeking a live deck mid-overlap is audible stutter. While both
          // decks are up, only hard-correct big drift, rarely; solo decks can
          // correct small drift more freely.
          const overlapLive = wanted.size > 1;
          const driftFloor = overlapLive ? 1.0 : 0.35;
          const cooldownMs = overlapLive ? 600 : 300;
          if (
            !looping &&
            !spinning &&
            drift > driftFloor &&
            now >= this.suppressDriftUntil &&
            now - (this.lastDriftSeekMs[deck] ?? 0) >= cooldownMs
          ) {
            this.lastDriftSeekMs[deck] = now;
            audioEngine.seekPlayingTo(deck, trackBars);
            useSetStore.getState().patchLive((d) => ({
              ...d,
              decks: {
                ...d.decks,
                [deck]: { ...d.decks[deck], positionBars: trackBars },
              },
            }));
          }
        }
      } else {
        matchTempo();
        seekExact(trackBars);
      }
    }
  }

  private applyLoopOut(doc: SetDoc, setBars: number) {
    const spans = buildTimeline(doc);
    for (const span of spans) {
      const kind = span.entry.transition.type;
      if (
        (kind !== "loop_out" && kind !== "loop_roll" && kind !== "tease_slam") ||
        span.overlapBars <= 0
      )
        continue;
      const prev = spans[span.entryIndex - 1];
      if (!prev) continue;
      const start = span.setStart;
      const end = Math.min(span.setStart + span.overlapBars, prev.setEnd);
      if (setBars < start || setBars >= end) continue;
      const deck = prev.deck;
      const d = doc.decks[deck];
      if (kind === "tease_slam") {
        // The pad move into the slam: stutter the outgoing 1 → 0.5 over the
        // final 2 bars of the build. Earlier in the tease the deck runs free
        // (clear a stale roll if the user seeks back into the window).
        if (setBars < end - 2) {
          if (d.loopBars != null) {
            useSetStore.getState().dispatch(
              { type: "deck.setLoop", deck, bars: 0 },
              "system",
            );
          }
          continue;
        }
        const rollLen = setBars < end - 1 ? 1 : 0.5;
        const rollIn = Math.max(prev.entry.inBars, prev.entry.outBars - rollLen);
        if (d.loopBars === rollLen && d.loopInBars === rollIn) continue;
        useSetStore.getState().dispatch(
          { type: "deck.setLoop", deck, bars: rollLen, inBars: rollIn },
          "system",
        );
        continue;
      }
      const t = (setBars - start) / Math.max(0.01, end - start);
      let loopLen = Math.max(0.5, Math.min(2, span.overlapBars));
      if (kind === "loop_roll") {
        loopLen = t < 0.34 ? 2 : t < 0.67 ? 1 : 0.5;
      }
      const trackLoopIn = Math.max(prev.entry.inBars, prev.entry.outBars - loopLen);
      if (d.loopBars === loopLen && d.loopInBars === trackLoopIn) continue;
      useSetStore.getState().dispatch(
        { type: "deck.setLoop", deck, bars: loopLen, inBars: trackLoopIn },
        "system",
      );
    }
  }

  private applyBackspin(doc: SetDoc, setBars: number) {
    const spans = buildTimeline(doc);
    const spinning = new Set<DeckId>();
    for (const span of spans) {
      if (span.entry.transition.type !== "backspin" || span.overlapBars <= 0) continue;
      const prev = spans[span.entryIndex - 1];
      if (!prev) continue;
      const { start, end } = backspinSpinWindow(span, prev);
      if (setBars < start || setBars >= end) continue;
      const deck = prev.deck;
      spinning.add(deck);
      if (audioEngine.isReversing(deck)) continue;
      const origin = backspinPlayheadBars(
        { inBars: prev.entry.inBars, setStart: prev.setStart },
        start,
        end,
        start,
      );
      const windowSec = ((end - start) * 240) / Math.max(1, this.clockBpm(doc, start));
      audioEngine.startReverse(deck, origin, windowSec, prev.entry.inBars);
    }
    for (const deck of ["A", "B"] as const) {
      if (!spinning.has(deck)) audioEngine.stopReverse(deck);
    }
  }
}

function isBackspinDeck(doc: SetDoc, setBars: number, deck: DeckId): boolean {
  const spans = buildTimeline(doc);
  for (const span of spans) {
    if (span.entry.transition.type !== "backspin" || span.overlapBars <= 0) continue;
    const prev = spans[span.entryIndex - 1];
    if (!prev || prev.deck !== deck) continue;
    const { start, end } = backspinSpinWindow(span, prev);
    if (setBars >= start && setBars < end) return true;
  }
  return false;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function resetMixerForSet(doc: SetDoc): SetDoc {
  const channels = { ...doc.mixer.channels };
  for (const deck of ["A", "B"] as DeckId[]) {
    channels[deck] = {
      ...channels[deck],
      eqLow: 0,
      eqMid: 0,
      eqHigh: 0,
      filter: 0,
      fader: 0.75,
      gainDb: 0,
    };
  }
  return {
    ...doc,
    mixer: {
      ...doc.mixer,
      channels,
      crossfader: -1,
      masterDb: doc.mixer.masterDb < -40 ? 0 : doc.mixer.masterDb,
    },
  };
}

function waitForBuffer(deck: DeckId, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const start = performance.now();
    const check = () => {
      if (audioEngine.isBufferReady(deck) || performance.now() - start > timeoutMs) {
        resolve();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

export const setPerformer = new SetPerformer();
