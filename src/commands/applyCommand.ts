import type { Command } from "../types/commands";
import type {
  ArrangementEntry,
  AutomationLane,
  DeckId,
  SetDoc,
  Track,
  TransitionType,
} from "../types/setdoc";
import { createEmptySetDoc } from "../types/setdoc";
import { quantizeBars } from "../audio/quantize";

function cloneLane(lane: AutomationLane): AutomationLane {
  return { ...lane };
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function cloneEntry(entry: ArrangementEntry): ArrangementEntry {
  return { ...entry, transition: { ...entry.transition } };
}

function snapIfQuantized(doc: SetDoc, deck: DeckId, bars: number): number {
  const d = doc.decks[deck];
  if (!d.quantize) return Math.max(0, bars);
  const track = d.trackId ? doc.tracks[d.trackId] : undefined;
  return quantizeBars(bars, track?.analysis, "beat");
}

export function applyCommand(doc: SetDoc, command: Command): SetDoc {
  const next: SetDoc = {
    ...doc,
    version: doc.version + 1,
    updatedAt: Date.now(),
  };

  switch (command.type) {
    case "set.setTitle":
      next.title = command.title.trim() || "Untitled Set";
      return next;

    case "library.addTrack": {
      const track: Track = {
        id: command.track.id,
        fileRef: command.track.fileRef,
        title: command.track.title,
        artist: command.track.artist,
        durationSec: command.track.durationSec,
        tags: [],
        crateIds: ["all"],
        analysisStatus: "pending",
      };
      next.tracks = { ...doc.tracks, [track.id]: track };
      const all = doc.crates.all ?? { id: "all", name: "All Tracks", trackIds: [] };
      next.crates = {
        ...doc.crates,
        all: { ...all, trackIds: [...all.trackIds, track.id] },
      };
      return next;
    }

    case "library.removeTrack": {
      const { [command.trackId]: _, ...rest } = doc.tracks;
      next.tracks = rest;
      next.crates = Object.fromEntries(
        Object.entries(doc.crates).map(([id, crate]) => [
          id,
          { ...crate, trackIds: crate.trackIds.filter((t) => t !== command.trackId) },
        ]),
      );
      next.arrangement = doc.arrangement.filter((e) => e.trackId !== command.trackId);
      next.decks = { ...doc.decks };
      for (const deck of Object.keys(next.decks) as DeckId[]) {
        if (next.decks[deck].trackId === command.trackId) {
          next.decks[deck] = {
            ...next.decks[deck],
            trackId: null,
            playing: false,
            bpm: null,
          };
        }
      }
      return next;
    }

    case "library.setAnalysisStatus": {
      const track = doc.tracks[command.trackId];
      if (!track) return doc;
      next.tracks = {
        ...doc.tracks,
        [command.trackId]: {
          ...track,
          analysisStatus: command.status,
          analysisError: command.error,
        },
      };
      return next;
    }

    case "library.setAnalysis": {
      const track = doc.tracks[command.trackId];
      if (!track) return doc;
      next.tracks = {
        ...doc.tracks,
        [command.trackId]: {
          ...track,
          analysis: command.analysis,
          analysisStatus: "ready",
          analysisError: undefined,
          durationSec: command.analysis.durationSec,
        },
      };
      return next;
    }

    case "library.setLyrics": {
      const track = doc.tracks[command.trackId];
      if (!track?.analysis) return doc;
      next.tracks = {
        ...doc.tracks,
        [command.trackId]: {
          ...track,
          analysis: {
            ...track.analysis,
            lyrics: command.lyrics ?? undefined,
          },
        },
      };
      return next;
    }

    case "library.tag": {
      const track = doc.tracks[command.trackId];
      if (!track) return doc;
      next.tracks = {
        ...doc.tracks,
        [command.trackId]: { ...track, tags: [...command.tags] },
      };
      return next;
    }

    case "library.setCraft": {
      const track = doc.tracks[command.trackId];
      if (!track) return doc;
      const craft = { ...track.craft, ...command.craft };
      for (const key of Object.keys(command.craft) as (keyof typeof craft)[]) {
        if (command.craft[key] == null) delete craft[key];
      }
      next.tracks = {
        ...doc.tracks,
        [command.trackId]: { ...track, craft },
      };
      return next;
    }

    case "library.setSections": {
      const track = doc.tracks[command.trackId];
      if (!track?.analysis) return doc;
      next.tracks = {
        ...doc.tracks,
        [command.trackId]: {
          ...track,
          analysis: { ...track.analysis, sections: command.sections },
        },
      };
      return next;
    }

    case "deck.load": {
      const track = doc.tracks[command.trackId];
      if (!track) return doc;
      next.decks = {
        ...doc.decks,
        [command.deck]: {
          ...doc.decks[command.deck],
          trackId: command.trackId,
          playing: false,
          positionBars: 0,
          bpm: track.analysis?.bpm ?? null,
          loopBars: null,
          loopInBars: null,
        },
      };
      return next;
    }

    case "deck.unload":
      next.decks = {
        ...doc.decks,
        [command.deck]: {
          ...doc.decks[command.deck],
          trackId: null,
          playing: false,
          bpm: null,
          positionBars: 0,
          loopBars: null,
          loopInBars: null,
        },
      };
      return next;

    case "deck.play":
      next.decks = {
        ...doc.decks,
        [command.deck]: { ...doc.decks[command.deck], playing: true },
      };
      return next;

    case "deck.pause":
      next.decks = {
        ...doc.decks,
        [command.deck]: { ...doc.decks[command.deck], playing: false },
      };
      return next;

    case "deck.seek":
      next.decks = {
        ...doc.decks,
        [command.deck]: {
          ...doc.decks[command.deck],
          positionBars: command.exact
            ? Math.max(0, command.positionBars)
            : snapIfQuantized(doc, command.deck, command.positionBars),
        },
      };
      return next;

    case "deck.setTempo":
      next.decks = {
        ...doc.decks,
        [command.deck]: { ...doc.decks[command.deck], bpm: command.bpm },
      };
      return next;

    case "deck.setLoop": {
      const deck = doc.decks[command.deck];
      const clear = command.bars === null || command.bars <= 0;
      let inBars =
        command.inBars !== undefined
          ? command.inBars
          : deck.loopInBars ?? deck.positionBars;
      if (clear) {
        next.decks = {
          ...doc.decks,
          [command.deck]: { ...deck, loopBars: null, loopInBars: null },
        };
        return next;
      }
      if (inBars != null) {
        inBars = snapIfQuantized(doc, command.deck, inBars);
      }
      next.decks = {
        ...doc.decks,
        [command.deck]: {
          ...deck,
          loopBars: command.bars,
          loopInBars: inBars ?? deck.positionBars,
        },
      };
      return next;
    }

    case "deck.setOptions":
      next.decks = {
        ...doc.decks,
        [command.deck]: {
          ...doc.decks[command.deck],
          ...(command.keylock !== undefined ? { keylock: command.keylock } : {}),
          ...(command.slip !== undefined ? { slip: command.slip } : {}),
          ...(command.quantize !== undefined ? { quantize: command.quantize } : {}),
        },
      };
      return next;

    case "deck.setHotcue": {
      const hotcues = [...doc.decks[command.deck].hotcues];
      const idx = clamp(command.pad, 1, 8) - 1;
      hotcues[idx] =
        command.bars == null
          ? null
          : snapIfQuantized(doc, command.deck, command.bars);
      next.decks = {
        ...doc.decks,
        [command.deck]: { ...doc.decks[command.deck], hotcues },
      };
      return next;
    }

    case "deck.setMaster":
      next.tempoMaster = command.deck;
      return next;

    case "mixer.setGain":
      next.mixer = {
        ...doc.mixer,
        channels: {
          ...doc.mixer.channels,
          [command.deck]: { ...doc.mixer.channels[command.deck], gainDb: command.db },
        },
      };
      return next;

    case "mixer.setEQ": {
      const key =
        command.band === "low" ? "eqLow" : command.band === "mid" ? "eqMid" : "eqHigh";
      next.mixer = {
        ...doc.mixer,
        channels: {
          ...doc.mixer.channels,
          [command.deck]: { ...doc.mixer.channels[command.deck], [key]: command.db },
        },
      };
      return next;
    }

    case "mixer.setFilter":
      next.mixer = {
        ...doc.mixer,
        channels: {
          ...doc.mixer.channels,
          [command.deck]: {
            ...doc.mixer.channels[command.deck],
            filter: clamp(command.value, -1, 1),
          },
        },
      };
      return next;

    case "mixer.setFader":
      next.mixer = {
        ...doc.mixer,
        channels: {
          ...doc.mixer.channels,
          [command.deck]: {
            ...doc.mixer.channels[command.deck],
            fader: clamp(command.value, 0, 1),
          },
        },
      };
      return next;

    case "mixer.setCrossfader":
      next.mixer = { ...doc.mixer, crossfader: clamp(command.value, -1, 1) };
      return next;

    case "mixer.setXfaderCurve":
      next.mixer = { ...doc.mixer, xfaderCurve: command.curve };
      return next;

    case "mixer.setCue":
      next.mixer = {
        ...doc.mixer,
        channels: {
          ...doc.mixer.channels,
          [command.deck]: { ...doc.mixer.channels[command.deck], cue: command.enabled },
        },
      };
      return next;

    case "mixer.setCueMix":
      next.mixer = { ...doc.mixer, cueMix: clamp(command.value, 0, 1) };
      return next;

    case "mixer.setMaster":
      next.mixer = { ...doc.mixer, masterDb: command.db };
      return next;

    case "set.clear":
      next.arrangement = [];
      next.automation = [];
      next.proposal = null;
      return next;

    case "set.replaceArrangement":
      next.arrangement = command.entries.map(cloneEntry);
      return next;

    case "set.insert": {
      const track = doc.tracks[command.trackId];
      if (!track) return doc;
      const durationBars = track.analysis?.durationBars ?? 32;
      const entries = [...doc.arrangement];
      const index = clamp(command.index, 0, entries.length);
      entries.splice(index, 0, {
        id: crypto.randomUUID(),
        trackId: command.trackId,
        inBars: command.inBars ?? 0,
        outBars: command.outBars ?? durationBars,
        transition: {
          type: (command.transition as TransitionType) ?? "blend",
          bars: command.bars ?? 8,
        },
      });
      next.arrangement = entries;
      return next;
    }

    case "set.remove": {
      const entries = [...doc.arrangement];
      if (command.index < 0 || command.index >= entries.length) return doc;
      entries.splice(command.index, 1);
      next.arrangement = entries;
      return next;
    }

    case "set.move": {
      const entries = [...doc.arrangement];
      if (
        command.fromIndex < 0 ||
        command.fromIndex >= entries.length ||
        command.toIndex < 0 ||
        command.toIndex >= entries.length
      ) {
        return doc;
      }
      const [item] = entries.splice(command.fromIndex, 1);
      if (!item) return doc;
      entries.splice(command.toIndex, 0, item);
      next.arrangement = entries;
      return next;
    }

    case "set.setTrim": {
      const entries = [...doc.arrangement];
      const entry = entries[command.index];
      if (!entry) return doc;
      entries[command.index] = {
        ...entry,
        inBars: Math.max(0, command.inBars),
        outBars: Math.max(command.inBars + 1, command.outBars),
      };
      next.arrangement = entries;
      return next;
    }

    case "set.setTransition": {
      const entries = [...doc.arrangement];
      const entry = entries[command.index];
      if (!entry) return doc;
      entries[command.index] = {
        ...entry,
        transition: {
          type: command.transition,
          bars: command.bars ?? entry.transition.bars,
        },
      };
      next.arrangement = entries;
      return next;
    }

    case "set.edit": {
      // legacy shim
      if (command.action === "add" && command.trackId) {
        return applyCommand(doc, {
          type: "set.insert",
          index: command.index ?? doc.arrangement.length,
          trackId: command.trackId,
          bars: command.bars,
          transition: command.transition,
        });
      }
      if (command.action === "remove" && command.index !== undefined) {
        return applyCommand(doc, { type: "set.remove", index: command.index });
      }
      if (
        command.action === "reorder" &&
        command.index !== undefined &&
        command.toIndex !== undefined
      ) {
        return applyCommand(doc, {
          type: "set.move",
          fromIndex: command.index,
          toIndex: command.toIndex,
        });
      }
      if (
        command.action === "set_transition" &&
        command.index !== undefined &&
        command.transition
      ) {
        return applyCommand(doc, {
          type: "set.setTransition",
          index: command.index,
          transition: command.transition,
          bars: command.bars,
        });
      }
      return doc;
    }

    case "set.setProposal":
      next.proposal = command.proposal;
      return next;

    case "set.applyProposal":
      if (!doc.proposal) return doc;
      next.arrangement = doc.proposal.entries.map(cloneEntry);
      if (doc.proposal.automation) {
        next.automation = doc.proposal.automation.map(cloneLane);
      }
      next.proposal = null;
      return next;

    case "set.rejectProposal":
      next.proposal = null;
      return next;

    case "set.setTempo":
      next.setTempoBpm =
        command.bpm == null || !Number.isFinite(command.bpm) || command.bpm <= 0
          ? null
          : command.bpm;
      return next;

    case "set.addAutomation":
      next.automation = [...(doc.automation ?? []), cloneLane(command.lane)];
      return next;

    case "set.removeAutomation":
      next.automation = (doc.automation ?? []).filter((l) => l.id !== command.id);
      return next;

    case "set.replaceAutomation":
      next.automation = command.lanes.map(cloneLane);
      return next;

    case "set.clearAutomation":
      next.automation = [];
      return next;

    case "deck.setFxSend":
      next.decks = {
        ...doc.decks,
        [command.deck]: {
          ...doc.decks[command.deck],
          fxSend: clamp(command.value, 0, 1),
        },
      };
      return next;

    case "fx.set": {
      next.fx = {
        ...doc.fx,
        ...(command.fxType !== undefined ? { type: command.fxType } : {}),
        ...(command.wet !== undefined ? { wet: clamp(command.wet, 0, 1) } : {}),
        ...(command.timeBeats !== undefined
          ? { timeBeats: Math.max(0.0625, command.timeBeats) }
          : {}),
        ...(command.feedback !== undefined
          ? { feedback: clamp(command.feedback, 0, 0.95) }
          : {}),
      };
      return next;
    }

    case "sampler.setPad": {
      const idx = clamp(command.pad, 1, 8) - 1;
      const pads = [...doc.sampler.pads];
      const prev = pads[idx]!;
      pads[idx] = {
        ...prev,
        ...(command.trackId !== undefined ? { trackId: command.trackId } : {}),
        ...(command.inBars !== undefined ? { inBars: command.inBars } : {}),
        ...(command.outBars !== undefined ? { outBars: command.outBars } : {}),
        ...(command.label !== undefined ? { label: command.label } : {}),
        ...(command.gain !== undefined ? { gain: clamp(command.gain, 0, 2) } : {}),
      };
      next.sampler = { ...doc.sampler, pads };
      return next;
    }

    case "sampler.trigger":
      // Engine listens; doc unchanged except version bump for activity
      return next;

    case "sampler.setMaster":
      next.sampler = {
        ...doc.sampler,
        masterGain: clamp(command.gain, 0, 2),
      };
      return next;

    case "record.start":
      next.record = {
        ...doc.record,
        recording: true,
        startedAt: Date.now(),
      };
      return next;

    case "record.stop":
      next.record = {
        ...doc.record,
        recording: false,
      };
      return next;

    case "record.clear":
      next.record = {
        recording: false,
        startedAt: null,
        lastBlobUrl: null,
      };
      return next;

    default:
      return doc;
  }
}

/** Migrate older persisted docs missing newer fields. */
export function normalizeDoc(doc: SetDoc): SetDoc {
  const base = createEmptySetDoc(doc.title);
  const decks = { ...base.decks };
  for (const id of ["A", "B", "C", "D"] as DeckId[]) {
    const d = doc.decks?.[id] ?? base.decks[id];
    decks[id] = {
      ...base.decks[id],
      ...d,
      loopInBars: d.loopInBars ?? null,
      loopBars: d.loopBars ?? null,
      fxSend: d.fxSend ?? 0,
      hotcues: d.hotcues?.length === 8 ? d.hotcues : base.decks[id].hotcues,
    };
  }
  return {
    ...base,
    ...doc,
    decks,
    automation: Array.isArray(doc.automation) ? doc.automation : [],
    setTempoBpm: doc.setTempoBpm ?? null,
    arrangement: doc.arrangement ?? [],
    fx: { ...base.fx, ...(doc.fx ?? {}) },
    sampler: {
      masterGain: doc.sampler?.masterGain ?? base.sampler.masterGain,
      pads:
        doc.sampler?.pads?.length === 8
          ? doc.sampler.pads
          : base.sampler.pads,
    },
    record: { ...base.record, ...(doc.record ?? {}), recording: false },
  };
}

export function createInitialDoc(): SetDoc {
  return createEmptySetDoc("Untitled Set");
}
