import type {
  ArrangementEntry,
  AutomationLane,
  DeckId,
  FxType,
  SectionLabel,
  SetProposal,
  TrackAnalysis,
  TrackCraft,
  TrackId,
  TransitionType,
} from "./setdoc";

export type CommandSource = "ui" | "agent" | "system";

export type Command =
  | { type: "set.setTitle"; title: string }
  | {
      type: "library.addTrack";
      track: {
        id: TrackId;
        fileRef: string;
        title: string;
        artist: string;
        durationSec?: number;
      };
    }
  | { type: "library.removeTrack"; trackId: TrackId }
  | {
      type: "library.setAnalysisStatus";
      trackId: TrackId;
      status: "pending" | "running" | "ready" | "error";
      error?: string;
    }
  | { type: "library.setAnalysis"; trackId: TrackId; analysis: TrackAnalysis }
  | {
      type: "library.setLyrics";
      trackId: TrackId;
      lyrics: { words: { t: number; w: string }[]; explicit: boolean } | null;
    }
  | { type: "library.tag"; trackId: TrackId; tags: string[] }
  | { type: "library.setCraft"; trackId: TrackId; craft: TrackCraft }
  | {
      type: "library.setSections";
      trackId: TrackId;
      sections: {
        label: SectionLabel;
        startBars: number;
        endBars: number;
        startSec: number;
        endSec: number;
      }[];
    }
  | { type: "deck.load"; deck: DeckId; trackId: TrackId }
  | { type: "deck.unload"; deck: DeckId }
  | { type: "deck.play"; deck: DeckId }
  | { type: "deck.pause"; deck: DeckId }
  | {
      type: "deck.seek";
      deck: DeckId;
      positionBars: number;
      /** Skip quantize snap — set performer / phase lock must hit exact bars. */
      exact?: boolean;
    }
  | { type: "deck.setTempo"; deck: DeckId; bpm: number }
  | {
      type: "deck.setLoop";
      deck: DeckId;
      bars: number | null;
      inBars?: number | null;
    }
  | {
      type: "deck.setOptions";
      deck: DeckId;
      keylock?: boolean;
      slip?: boolean;
      quantize?: boolean;
    }
  | { type: "deck.setHotcue"; deck: DeckId; pad: number; bars: number | null }
  | { type: "deck.setMaster"; deck: DeckId }
  | { type: "deck.setFxSend"; deck: DeckId; value: number }
  | { type: "mixer.setGain"; deck: DeckId; db: number }
  | { type: "mixer.setEQ"; deck: DeckId; band: "low" | "mid" | "high"; db: number }
  | { type: "mixer.setFilter"; deck: DeckId; value: number }
  | { type: "mixer.setFader"; deck: DeckId; value: number }
  | { type: "mixer.setCrossfader"; value: number }
  | { type: "mixer.setXfaderCurve"; curve: "smooth" | "scratch" }
  | { type: "mixer.setCue"; deck: DeckId; enabled: boolean }
  | { type: "mixer.setCueMix"; value: number }
  | { type: "mixer.setMaster"; db: number }
  | {
      type: "fx.set";
      fxType?: FxType;
      wet?: number;
      timeBeats?: number;
      feedback?: number;
    }
  | {
      type: "sampler.setPad";
      pad: number;
      trackId?: TrackId | null;
      inBars?: number;
      outBars?: number;
      label?: string;
      gain?: number;
    }
  | { type: "sampler.trigger"; pad: number }
  | { type: "sampler.setMaster"; gain: number }
  | { type: "record.start" }
  | { type: "record.stop" }
  | { type: "record.clear" }
  | { type: "set.clear" }
  | { type: "set.replaceArrangement"; entries: ArrangementEntry[] }
  | {
      type: "set.insert";
      index: number;
      trackId: TrackId;
      inBars?: number;
      outBars?: number;
      bars?: number;
      transition?: TransitionType;
    }
  | { type: "set.remove"; index: number }
  | { type: "set.move"; fromIndex: number; toIndex: number }
  | { type: "set.setTrim"; index: number; inBars: number; outBars: number }
  | {
      type: "set.setTransition";
      index: number;
      transition: TransitionType;
      bars?: number;
    }
  | {
      type: "set.edit";
      action: "add" | "remove" | "reorder" | "set_transition";
      index?: number;
      toIndex?: number;
      trackId?: TrackId;
      bars?: number;
      transition?: TransitionType;
    }
  | { type: "set.setProposal"; proposal: SetProposal | null }
  | { type: "set.applyProposal" }
  | { type: "set.rejectProposal" }
  | { type: "set.setTempo"; bpm: number | null }
  | { type: "set.addAutomation"; lane: AutomationLane }
  | { type: "set.removeAutomation"; id: string }
  | { type: "set.replaceAutomation"; lanes: AutomationLane[] }
  | { type: "set.clearAutomation" };

export type DispatchedCommand = {
  id: string;
  at: number;
  source: CommandSource;
  command: Command;
};
