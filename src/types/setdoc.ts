export type TrackId = string;
export type DeckId = "A" | "B" | "C" | "D";

export type SectionLabel =
  | "intro"
  | "build"
  | "drop"
  | "breakdown"
  | "outro"
  | "verse"
  | "chorus"
  | "unknown";

export type TransitionType =
  | "cut"
  | "blend"
  | "eq_swap"
  | "filter_sweep"
  | "echo_out"
  | "loop_out"
  | "build_cut"
  | "drop_swap"
  | "double_drop"
  | "loop_roll"
  | "backspin"
  | "hook_layer"
  | "air_cut"
  | "tempo_ride"
  | "tease_slam";

export const TRANSITION_TYPES: TransitionType[] = [
  "cut",
  "blend",
  "eq_swap",
  "filter_sweep",
  "echo_out",
  "loop_out",
  "build_cut",
  "drop_swap",
  "double_drop",
  "loop_roll",
  "backspin",
  "hook_layer",
  "air_cut",
  "tempo_ride",
  "tease_slam",
];

export type TrackRole = "opener" | "builder" | "bridge" | "peak" | "reset" | "closer";
export type TrackMood = "dark" | "bright" | "driving" | "warm";

export type TrackCraft = {
  role?: TrackRole;
  energyLevel?: number;
  mood?: TrackMood;
  genreHint?: string;
  /** Who wrote genreHint — never DSP. */
  genreSource?: "musicbrainz" | "human" | "agent";
};

export type ComposeStyle = "chop" | "blend";

export type AutomationCurve = "linear" | "exponential" | "ease_in" | "ease_out";

export type AutomationParam =
  | "tempo"
  | "xfader"
  | "filter_a"
  | "filter_b"
  | "eq_low_a"
  | "eq_mid_a"
  | "eq_high_a"
  | "eq_low_b"
  | "eq_mid_b"
  | "eq_high_b"
  | "fader_a"
  | "fader_b"
  | "gain_a"
  | "gain_b"
  | "fx_wet"
  | "fx_arm";

export type FxType = "off" | "delay" | "reverb" | "echo";

export type AnalysisSection = {
  label: SectionLabel;
  startBars: number;
  endBars: number;
  startSec: number;
  endSec: number;
};

export type WaveformPeaks = {
  samplesPerPeak: number;
  peaks: number[];
  low?: number[];
  mid?: number[];
  high?: number[];
};

export type TrackAnalysis = {
  bpm: number;
  durationSec: number;
  durationBars: number;
  key: {
    camelot: string;
    confidence: number;
    name?: string;
    window?: "intro" | "drop";
    /** Template set used — edma = Faraldo EDM profiles, not Krumhansl. */
    profile?: "edma" | "krumhansl";
  };
  beats: number[];
  downbeats: number[];
  sections: AnalysisSection[];
  energy: number[];
  energyMean: number;
  energyLevel?: number;
  /** High-band / total ratio 0..1 — display this, never the word "dark". */
  brightness?: number;
  /**
   * Measured spectral timbre. Do not show this as mood. Emotional mood is
   * craft-only (human / MusicBrainz / agent).
   */
  timbre?: "bright" | "dark" | "warm";
  /** @deprecated legacy rows only — the detector stopped emitting genre guesses. */
  genreHint?: string;
  /** @deprecated legacy rows only — the detector stopped emitting mood guesses. */
  mood?: TrackMood;
  vocalLead?: boolean;
  /** @deprecated DSP no longer assigns set roles — slots are assigned at compose time. */
  suggestedRole?: TrackRole;
  vocalRegions?: { startSec: number; endSec: number; startBars: number; endBars: number }[];
  /**
   * Per-bucket chroma (96 windows × 12 pitch classes, normalized per bucket) —
   * the audio truth behind harmony auditions. Absent on pre-chroma analyses.
   */
  chromaCurve?: number[][];
  /** Phrase-snapped peak drop (Foote novelty ∩ salience). */
  dropBars?: number;
  /** Hottest 16-bar window (energy-curve argmax, phrase-snapped). */
  heatInBars?: number;
  heatOutBars?: number;
  /** Detector generation — stale rows without this get re-analyzed. */
  detector?: "salience-v1";
  lyrics?: { words: { t: number; w: string }[]; explicit: boolean };
  waveform: WaveformPeaks;
  analyzedAt: number;
};

export type Track = {
  id: TrackId;
  fileRef: string;
  title: string;
  artist: string;
  durationSec?: number;
  tags: string[];
  crateIds: string[];
  craft?: TrackCraft;
  analysis?: TrackAnalysis;
  analysisStatus: "pending" | "running" | "ready" | "error";
  analysisError?: string;
};

export type Crate = {
  id: string;
  name: string;
  trackIds: TrackId[];
};

export type ArrangementEntry = {
  id: string;
  trackId: TrackId;
  inBars: number;
  outBars: number;
  transition: {
    type: TransitionType;
    bars: number;
  };
};

export type AutomationLane = {
  id: string;
  startBars: number;
  endBars: number;
  param: AutomationParam;
  startValue: number;
  endValue: number;
  curve: AutomationCurve;
};

export type SetProposal = {
  id: string;
  createdAt: number;
  reason?: string;
  entries: ArrangementEntry[];
  automation?: AutomationLane[];
};

export type DeckState = {
  trackId: TrackId | null;
  playing: boolean;
  bpm: number | null;
  positionBars: number;
  /** Loop start in track bars; null = no loop */
  loopInBars: number | null;
  /** Loop length in bars; null = no loop */
  loopBars: number | null;
  keylock: boolean;
  slip: boolean;
  quantize: boolean;
  hotcues: (number | null)[];
  /** Channel send to FX bus 0..1 */
  fxSend: number;
};

export type ChannelState = {
  gainDb: number;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  filter: number;
  fader: number;
  cue: boolean;
};

export type MixerState = {
  channels: Record<DeckId, ChannelState>;
  crossfader: number;
  xfaderCurve: "smooth" | "scratch";
  cueMix: number;
  masterDb: number;
};

export type FxState = {
  type: FxType;
  wet: number;
  /** Delay/echo time in beats (quarter notes) */
  timeBeats: number;
  feedback: number;
};

export type SamplerPad = {
  id: string;
  label: string;
  /** Optional slice from a library track */
  trackId: TrackId | null;
  inBars: number;
  outBars: number;
  gain: number;
};

export type SamplerState = {
  pads: SamplerPad[];
  masterGain: number;
};

export type RecordState = {
  recording: boolean;
  startedAt: number | null;
  lastBlobUrl: string | null;
};

export type SetDoc = {
  id: string;
  version: number;
  title: string;
  updatedAt: number;
  tracks: Record<TrackId, Track>;
  crates: Record<string, Crate>;
  arrangement: ArrangementEntry[];
  automation: AutomationLane[];
  proposal: SetProposal | null;
  decks: Record<DeckId, DeckState>;
  mixer: MixerState;
  fx: FxState;
  sampler: SamplerState;
  record: RecordState;
  tempoMaster: DeckId;
  setTempoBpm: number | null;
};

export function emptyChannel(): ChannelState {
  return {
    gainDb: 0,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    filter: 0,
    fader: 0.75,
    cue: false,
  };
}

export function emptyDeck(): DeckState {
  return {
    trackId: null,
    playing: false,
    bpm: null,
    positionBars: 0,
    loopInBars: null,
    loopBars: null,
    keylock: true,
    slip: false,
    quantize: true,
    hotcues: Array.from({ length: 8 }, () => null),
    fxSend: 0,
  };
}

export function emptyFx(): FxState {
  return { type: "off", wet: 0.35, timeBeats: 0.75, feedback: 0.35 };
}

export function emptySampler(): SamplerState {
  return {
    masterGain: 0.85,
    pads: Array.from({ length: 8 }, (_, i) => ({
      id: `pad-${i + 1}`,
      label: String(i + 1),
      trackId: null,
      inBars: 0,
      outBars: 1,
      gain: 1,
    })),
  };
}

export function emptyRecord(): RecordState {
  return { recording: false, startedAt: null, lastBlobUrl: null };
}

export function createEmptySetDoc(title = "Untitled Set"): SetDoc {
  const id = crypto.randomUUID();
  return {
    id,
    version: 1,
    title,
    updatedAt: Date.now(),
    tracks: {},
    crates: {
      all: { id: "all", name: "All Tracks", trackIds: [] },
    },
    arrangement: [],
    automation: [],
    proposal: null,
    decks: {
      A: emptyDeck(),
      B: emptyDeck(),
      C: emptyDeck(),
      D: emptyDeck(),
    },
    mixer: {
      channels: {
        A: emptyChannel(),
        B: emptyChannel(),
        C: emptyChannel(),
        D: emptyChannel(),
      },
      crossfader: 0,
      xfaderCurve: "smooth",
      cueMix: 0.5,
      masterDb: 0,
    },
    fx: emptyFx(),
    sampler: emptySampler(),
    record: emptyRecord(),
    tempoMaster: "A",
    setTempoBpm: null,
  };
}
