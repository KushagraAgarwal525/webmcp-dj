import { audioEngine } from "./engine";
import { useSetStore } from "../commands/pipeline";
import type { AutomationParam, ChannelState, DeckId, SetDoc } from "../types/setdoc";
import {
  allAutomation,
  buildTimeline,
  masterBpm,
  sampleAutomation,
  setDurationBars,
  type TimelineSpan,
} from "../set/timeline";

type ActiveSlot = {
  entryIndex: number;
  trackId: string;
};

class SetPerformer {
  private raf = 0;
  private lastMs = 0;
  private positionBars = 0;
  private active: Partial<Record<"A" | "B", ActiveSlot>> = {};
  private starting = false;

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

      useSetStore.getState().patchLive((d) => resetMixerForSet(d));

      useSetStore.getState().setTransport({
        setPlaying: true,
        setPositionBars: this.positionBars,
        entryIndex: 0,
      });
      useSetStore.getState().setActivity("Playing set");

      // Tempo + mixer first, then load/seek/play so decks never start at native BPM.
      this.applyAutomation(useSetStore.getState().doc, this.positionBars);
      await this.syncDecks(useSetStore.getState().doc, this.positionBars, true);
      this.applyAutomation(useSetStore.getState().doc, this.positionBars);

      this.lastMs = performance.now();
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame((t) => this.tick(t));
    } finally {
      this.starting = false;
    }
  }

  pause() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    audioEngine.setPerformerSync(false);
    useSetStore.getState().setTransport({ setPlaying: false });
    for (const deck of ["A", "B"] as const) {
      if (useSetStore.getState().doc.decks[deck].playing) {
        useSetStore.getState().dispatch({ type: "deck.pause", deck }, "system");
      }
    }
    this.active = {};
    useSetStore.getState().setActivity("Paused");
  }

  async seek(setBars: number) {
    const doc = useSetStore.getState().doc;
    const dur = setDurationBars(doc);
    this.positionBars = Math.max(0, Math.min(setBars, Math.max(0, dur)));
    this.active = {};
    useSetStore.getState().setTransport({ setPositionBars: this.positionBars });
    this.applyAutomation(useSetStore.getState().doc, this.positionBars);
    await this.syncDecks(
      useSetStore.getState().doc,
      this.positionBars,
      this.isPlaying(),
    );
    this.applyAutomation(useSetStore.getState().doc, this.positionBars);
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

  private tick(now: number) {
    if (!useSetStore.getState().transport.setPlaying) return;

    const dt = Math.min(0.1, (now - this.lastMs) / 1000);
    this.lastMs = now;

    const doc = useSetStore.getState().doc;
    const dur = setDurationBars(doc);
    let bpm = masterBpm(doc);
    const tempoAuto = sampleAutomation(allAutomation(doc), "tempo", this.positionBars);
    if (tempoAuto != null && tempoAuto > 0) bpm = tempoAuto;

    this.positionBars += dt * (bpm / 240);

    if (dur > 0 && this.positionBars >= dur) {
      this.positionBars = 0;
      useSetStore.getState().setTransport({ setPositionBars: 0 });
      this.pause();
      useSetStore.getState().setActivity("Set finished");
      return;
    }

    this.applyAutomation(doc, this.positionBars);
    this.applyLoopOut(doc, this.positionBars);
    void this.syncDecks(doc, this.positionBars, true);
    this.applyBackspin(doc, this.positionBars);
    this.updatePlayheads(doc);

    const spans = buildTimeline(doc);
    let entryIndex = 0;
    for (const s of spans) {
      if (this.positionBars >= s.setStart) entryIndex = s.entryIndex;
    }

    useSetStore.getState().setTransport({
      setPositionBars: this.positionBars,
      entryIndex,
    });

    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private updatePlayheads(doc: SetDoc) {
    const heads: Partial<Record<DeckId, number>> = {};
    const spans = buildTimeline(doc);
    const setBars = this.positionBars;

    for (const deck of ["A", "B"] as DeckId[]) {
      // Authoritative during set performance: map set clock → track bars
      const span = [...spans].reverse().find(
        (s) => s.deck === deck && setBars >= s.setStart && setBars < s.setEnd,
      );
      if (span) {
        const trackBars = span.entry.inBars + (setBars - span.setStart);
        const dur = doc.tracks[span.entry.trackId]?.analysis?.durationBars;
        heads[deck] =
          dur != null ? Math.min(trackBars, Math.max(0, dur - 0.01)) : trackBars;
      } else if (doc.decks[deck].trackId) {
        heads[deck] = audioEngine.getPositionBars(deck);
      }
    }
    useSetStore.getState().setTransport({ deckPlayheads: heads as Record<DeckId, number> });
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
      const v = sampleAutomation(lanes, p, setBars);
      if (v != null) patch[p] = v;
    }

    if (!Object.keys(patch).length) return;

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
            type: arm > 0.5 ? "delay" : next.fx.type === "delay" ? "off" : next.fx.type,
            timeBeats: arm > 0.5 ? Math.max(next.fx.timeBeats, 0.75) : next.fx.timeBeats,
            feedback: arm > 0.5 ? Math.max(next.fx.feedback, 0.4) : next.fx.feedback,
          },
        };
        // Route send from both decks when armed so echo_out is audible
        if (arm > 0.5) {
          const decks = { ...next.decks };
          for (const deck of ["A", "B"] as DeckId[]) {
            if (decks[deck].trackId && (decks[deck].fxSend ?? 0) < 0.35) {
              decks[deck] = { ...decks[deck], fxSend: 0.55 };
            }
          }
          next = { ...next, decks };
        }
      }

      let tempo = next.setTempoBpm;
      if (patch.tempo != null && patch.tempo > 0) tempo = patch.tempo;

      const bpm = tempo ?? masterBpm(next);
      const decks = { ...next.decks };
      for (const deck of ["A", "B"] as DeckId[]) {
        if (decks[deck].trackId && decks[deck].bpm !== bpm) {
          decks[deck] = { ...decks[deck], bpm };
          next = { ...next, decks };
        }
      }
      if (tempo !== next.setTempoBpm) {
        next = { ...next, setTempoBpm: tempo };
      }
      return next;
    });
  }

  private targetBpm(doc: SetDoc, setBars: number): number {
    const tempoAuto = sampleAutomation(allAutomation(doc), "tempo", setBars);
    if (tempoAuto != null && tempoAuto > 0) return tempoAuto;
    return doc.setTempoBpm ?? masterBpm(doc);
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
    const bpm = this.targetBpm(store.doc, setBars);

    for (const deck of ["A", "B"] as const) {
      const span = wanted.get(deck);
      if (!span) {
        if (this.active[deck]) {
          if (store.doc.decks[deck].playing) {
            store.dispatch({ type: "deck.pause", deck }, "system");
          }
          delete this.active[deck];
        }
        continue;
      }

      const trackBars = span.entry.inBars + (setBars - span.setStart);
      const prev = this.active[deck];
      const needLoad =
        !prev ||
        prev.trackId !== span.entry.trackId ||
        prev.entryIndex !== span.entryIndex ||
        store.doc.decks[deck].trackId !== span.entry.trackId;

      const seekExact = (bars: number) => {
        store.dispatch(
          { type: "deck.seek", deck, positionBars: bars, exact: true },
          "system",
        );
      };
      const matchTempo = () => {
        const live = store.doc.decks[deck];
        if (live.trackId && live.bpm !== bpm) {
          store.dispatch({ type: "deck.setTempo", deck, bpm }, "system");
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
          store.dispatch({ type: "deck.play", deck }, "system");
          if (!audioEngine.isBufferReady(deck)) {
            await waitForBuffer(deck, 4000);
            matchTempo();
            seekExact(trackBars);
            store.dispatch({ type: "deck.play", deck }, "system");
          }
        }
      } else if (shouldPlay) {
        matchTempo();
        const engineBars = audioEngine.getPositionBars(deck);
        if (!store.doc.decks[deck].playing) {
          seekExact(trackBars);
          store.dispatch({ type: "deck.play", deck }, "system");
        } else if (Math.abs(engineBars - trackBars) > 0.05) {
          // Keep decks glued to the set clock (≈1/5 beat). Quantize used to fight this.
          const looping = store.doc.decks[deck].loopBars != null;
          const spinning = isBackspinDeck(doc, setBars, deck);
          if (!looping && !spinning) {
            seekExact(trackBars);
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
      if ((kind !== "loop_out" && kind !== "loop_roll") || span.overlapBars <= 0) continue;
      const prev = spans[span.entryIndex - 1];
      if (!prev) continue;
      const start = span.setStart;
      const end = Math.min(span.setStart + span.overlapBars, prev.setEnd);
      if (setBars < start || setBars >= end) continue;
      const t = (setBars - start) / Math.max(0.01, end - start);
      let loopLen = Math.max(0.5, Math.min(2, span.overlapBars));
      if (kind === "loop_roll") {
        loopLen = t < 0.34 ? 2 : t < 0.67 ? 1 : 0.5;
      }
      const trackLoopIn = Math.max(prev.entry.inBars, prev.entry.outBars - loopLen);
      const deck = prev.deck;
      const d = doc.decks[deck];
      if (d.loopBars === loopLen && d.loopInBars === trackLoopIn) continue;
      useSetStore.getState().dispatch(
        { type: "deck.setLoop", deck, bars: loopLen, inBars: trackLoopIn },
        "system",
      );
    }
  }

  private applyBackspin(doc: SetDoc, setBars: number) {
    const spans = buildTimeline(doc);
    for (const span of spans) {
      if (span.entry.transition.type !== "backspin" || span.overlapBars <= 0) continue;
      const prev = spans[span.entryIndex - 1];
      if (!prev) continue;
      const start = span.setStart;
      const end = Math.min(span.setStart + span.overlapBars, prev.setEnd);
      const spinStart = Math.max(start, end - 0.65);
      if (setBars < spinStart || setBars >= end) continue;
      const fromEnd = end - setBars;
      const trackBars = Math.max(prev.entry.inBars, prev.entry.outBars - fromEnd * 8);
      useSetStore.getState().dispatch(
        { type: "deck.seek", deck: prev.deck, positionBars: trackBars, exact: true },
        "system",
      );
    }
  }
}

function isBackspinDeck(doc: SetDoc, setBars: number, deck: DeckId): boolean {
  const spans = buildTimeline(doc);
  for (const span of spans) {
    if (span.entry.transition.type !== "backspin" || span.overlapBars <= 0) continue;
    const prev = spans[span.entryIndex - 1];
    if (!prev || prev.deck !== deck) continue;
    const start = span.setStart;
    const end = Math.min(span.setStart + span.overlapBars, prev.setEnd);
    if (setBars >= Math.max(start, end - 0.65) && setBars < end) return true;
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
