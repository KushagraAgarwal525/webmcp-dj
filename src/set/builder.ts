import {
  TRANSITION_TYPES,
  type ArrangementEntry,
  type SetDoc,
  type Track,
  type TrackId,
  type TransitionType,
} from "../types/setdoc";
import {
  allAutomation,
  buildTimeline,
  defaultTransitionBars,
  isTransitionType,
  recipeToTransition,
} from "./timeline";

const CAMELOT_WHEEL = [
  "1A", "2A", "3A", "4A", "5A", "6A", "7A", "8A", "9A", "10A", "11A", "12A",
  "1B", "2B", "3B", "4B", "5B", "6B", "7B", "8B", "9B", "10B", "11B", "12B",
];

export type CamelotMove =
  | "same"
  | "adjacent"
  | "relative"
  | "energy_boost"
  | "diagonal"
  | "jaws"
  | "pay_attention"
  | "clash";

export function parseCamelot(
  code: string,
): { n: number; letter: "A" | "B" } | null {
  const m = /^(\d{1,2})([ABab])$/.exec(code.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1 || n > 12) return null;
  return { n, letter: m[2]!.toUpperCase() as "A" | "B" };
}

export function camelotNumberDelta(a: string, b: string): number {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return 6;
  return Math.min(Math.abs(pa.n - pb.n), 12 - Math.abs(pa.n - pb.n));
}

/** Below this, Camelot is a guess — no long tonal pad. */
export const KEY_CONFIDENCE_OK = 0.55;

export function keyIsTrusted(track: Track): boolean {
  const c = track.analysis?.key.confidence;
  return typeof c === "number" && c >= KEY_CONFIDENCE_OK;
}

export function formatCamelot(
  key: { camelot: string; confidence: number } | undefined | null,
): string {
  if (!key?.camelot) return "";
  return key.confidence >= KEY_CONFIDENCE_OK ? key.camelot : `${key.camelot}?`;
}

/** Max shared-clock overlap for a tonal pad (blend / eq_swap / double_drop). */
export function padOverlapCap(move: CamelotMove, trusted: boolean): number {
  if (!trusted) return 1;
  if (move === "same" || move === "relative") return 16;
  if (move === "adjacent" || move === "energy_boost" || move === "diagonal") return 8;
  return 1;
}

/**
 * Is the outgoing's overlap window parked on a tonal hole — a breakdown/drum
 * section or a low-energy stretch that covers the whole window? A hole-parked
 * blend never co-ripples two harmonies, so a label clash is mostly moot.
 */
export function holeParkedAt(track: Track, outBars: number, bars: number): boolean {
  const a = track.analysis;
  if (!a) return false;
  const winStart = Math.max(0, outBars - bars);
  const winEnd = outBars;
  const section = a.sections.find(
    (s) =>
      (s.label === "breakdown" || s.label === "outro") &&
      s.startBars <= winStart + 1 &&
      s.endBars >= winEnd - 1,
  );
  if (section) return true;
  if (a.energy.length >= 2) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < a.energy.length; i++) {
      const bar = (i / Math.max(1, a.energy.length - 1)) * a.durationBars;
      if (bar >= winStart && bar <= winEnd) {
        sum += a.energy[i]!;
        n++;
      }
    }
    if (n >= 2 && sum / n <= 0.45) return true;
  }
  return false;
}

/**
 * Pad cap for a specific parked join. A blend whose overlap sits fully on the
 * outgoing's hole may run 8 bars even on a label clash — the clash
 * window (two harmonies at once) structurally cannot happen.
 */
export function padCapForJoin(
  outgoing: Track,
  outBars: number,
  move: CamelotMove,
  trusted: boolean,
  bars: number,
): number {
  const cap = padOverlapCap(move, trusted);
  if (cap >= 8) return cap;
  if ((move === "clash" || move === "jaws") && holeParkedAt(outgoing, outBars, bars)) {
    return 8;
  }
  return cap;
}

/** Interval-class dissonance: unison/fifths cheap, tritone/minor-2nd expensive. */
const DISSONANCE_BY_INTERVAL = [0, 1, 0.55, 0.2, 0.2, 0.15, 0.9, 0.1, 0.25, 0.25, 0.6, 1];

function windowChroma(track: Track, startBars: number, endBars: number): Float32Array | null {
  const a = track.analysis;
  const curve = a?.chromaCurve;
  if (!a || !curve?.length || a.durationBars <= 0) return null;
  const out = new Float32Array(12);
  let weight = 0;
  for (let i = 0; i < curve.length; i++) {
    const bucketStart = (i / curve.length) * a.durationBars;
    const bucketEnd = ((i + 1) / curve.length) * a.durationBars;
    if (bucketEnd <= startBars || bucketStart >= endBars) continue;
    const overlap = Math.min(bucketEnd, endBars) - Math.max(bucketStart, startBars);
    if (overlap <= 0) continue;
    const row = curve[i];
    if (!row) continue;
    // Quiet windows are drums/pads, not harmony — they don't clash.
    const e = a.energy[Math.min(a.energy.length - 1, i)] ?? 0.4;
    const w = overlap * Math.max(0.05, e);
    for (let c = 0; c < 12; c++) out[c]! += (row[c] ?? 0) * w;
    weight += w;
  }
  if (weight <= 0) return null;
  for (let c = 0; c < 12; c++) out[c]! /= weight;
  return out;
}

export type HarmonyVerdict = "blend_ok" | "bass_only" | "clash" | "unknown";

export type HarmonyAudition = {
  verdict: HarmonyVerdict;
  /** 0..~1 — energy-weighted pitch-class co-occurrence dissonance. */
  score: number;
  bassRoots: { outgoing: number | null; incoming: number | null };
  /** True when the two window roots sit in unison/4th/5th relation. */
  locked: boolean;
};

const UNKNOWN_AUDITION: HarmonyAudition = {
  verdict: "unknown",
  score: -1,
  bassRoots: { outgoing: null, incoming: null },
  locked: false,
};

/**
 * Judge whether two records can actually share a window — from the stored
 * chroma curves, not the Camelot label (which is often a 0.3-confidence
 * guess). Peak-weighted (squared) pitch-class co-occurrence so tonal centers
 * dominate and color-tone noise doesn't dilute a real root conflict; the
 * window roots get the final word on borderline scores. blend_ok unlocks
 * blends the labels condemn; clash vetoes blends the labels bless.
 * Thresholds are first-pass calibrations — the eval harness is the referee.
 */
export function auditionHarmony(
  outgoing: Track,
  outStart: number,
  outEnd: number,
  incoming: Track,
  inStart: number,
  inEnd: number,
): HarmonyAudition {
  const a = windowChroma(outgoing, outStart, outEnd);
  const b = windowChroma(incoming, inStart, inEnd);
  if (!a || !b) return UNKNOWN_AUDITION;
  let score = 0;
  let wa = 0;
  let wb = 0;
  for (let i = 0; i < 12; i++) {
    const av = a[i]! * a[i]!; // square: tonal centers dominate, noise dilutes
    if (av <= 0) continue;
    wa += av;
    for (let j = 0; j < 12; j++) {
      const bv = b[j]! * b[j]!;
      if (bv <= 0) continue;
      const d = Math.min(Math.abs(i - j), 12 - Math.abs(i - j));
      score += av * bv * DISSONANCE_BY_INTERVAL[d]!;
    }
  }
  wb = b.reduce((s, v) => s + v * v, 0);
  score /= Math.max(1e-9, wa * wb);
  const rootA = a.indexOf(Math.max(...a));
  const rootB = b.indexOf(Math.max(...b));
  const dRoot = Math.min(Math.abs(rootA - rootB), 12 - Math.abs(rootA - rootB));
  const locked = dRoot === 0 || dRoot === 5 || dRoot === 7;
  const rootClash = dRoot === 1 || dRoot === 6 || dRoot === 11;
  let verdict: HarmonyVerdict =
    score < 0.18 ? "blend_ok" : score < 0.4 ? "bass_only" : "clash";
  if (verdict === "bass_only") {
    verdict = rootClash ? "clash" : locked ? "blend_ok" : "bass_only";
  }
  return {
    verdict,
    score: Number(score.toFixed(3)),
    bassRoots: { outgoing: rootA, incoming: rootB },
    locked,
  };
}

/**
 * Isolator drop-swap is drums/build then the 1, not a pad. Key tags do not
 * force a cut — clashes only matter when two melodies are fully open.
 */
export function isolatorOverlapCap(move: CamelotMove): number {
  if (move === "clash" || move === "jaws") return 1;
  if (move === "pay_attention") return 8;
  return 16;
}

/** @deprecated Use padOverlapCap — kept for older call sites. */
export function harmonicOverlapCap(move: CamelotMove, trusted: boolean): number {
  return padOverlapCap(move, trusted);
}

export function isIsolatorType(type: TransitionType): boolean {
  return (
    type === "drop_swap" ||
    type === "filter_sweep" ||
    type === "build_cut" ||
    type === "tempo_ride"
  );
}

export function isPadType(type: TransitionType): boolean {
  return (
    type === "blend" ||
    type === "eq_swap" ||
    type === "hook_layer" ||
    type === "double_drop"
  );
}

export function vocalCovers(track: Track, bars: number): boolean {
  const regions = track.analysis?.vocalRegions;
  if (!regions?.length) return false;
  return regions.some((r) => bars > r.startBars + 0.15 && bars < r.endBars - 0.15);
}

export function vocalRegionAt(
  track: Track,
  bars: number,
): { startBars: number; endBars: number } | null {
  return (
    (track.analysis?.vocalRegions ?? []).find(
      (r) => bars >= r.startBars && bars <= r.endBars,
    ) ?? null
  );
}

/**
 * Phrase 1 for an xfader commit. If the target sits inside a vocal line,
 * walk forward to the line end then the next 8-bar 1 (max ~16 bar slip).
 * If the line is longer than that, leave on the 1 before it starts.
 */
export function safeLeaveBars(track: Track, targetBars: number, maxSlip = 16): number {
  const dur = Math.max(8, track.analysis?.durationBars ?? 32);
  let leave = snapToPhrase(Math.max(8, targetBars));
  if (leave > dur) leave = snapToPhrase(dur);
  if (!vocalCovers(track, leave)) return Math.min(leave, dur);

  const region = vocalRegionAt(track, leave) ?? vocalRegionAt(track, Math.max(0, leave - 0.25));
  if (!region) return Math.min(leave, dur);

  let after = snapToPhrase(region.endBars);
  if (after < region.endBars + 0.25) after += 8;
  while (vocalCovers(track, after - 0.15) && after <= leave + maxSlip) after += 8;
  if (
    after <= leave + maxSlip &&
    after <= dur &&
    !vocalCovers(track, after - 0.15)
  ) {
    return Math.min(after, dur);
  }

  let before = snapToPhrase(region.startBars);
  if (before >= region.startBars - 0.15) before = Math.max(8, before - 8);
  while (vocalCovers(track, before - 0.15) && before > 8) before -= 8;
  return Math.max(8, Math.min(before, dur));
}

/** Club Camelot taxonomy — relative major/minor is a safe mood flip, not a clash. */
export function classifyCamelotMove(a: string, b: string): CamelotMove {
  const pa = parseCamelot(a);
  const pb = parseCamelot(b);
  if (!pa || !pb) return "clash";
  const step = camelotNumberDelta(a, b);
  const flip = pa.letter !== pb.letter;
  if (step === 0 && !flip) return "same";
  if (step === 0 && flip) return "relative";
  if (step === 1 && !flip) return "adjacent";
  if (step === 2 && !flip) return "energy_boost";
  if (step === 1 && flip) return "diagonal";
  if (step === 5) return "jaws";
  if (step === 3) return "pay_attention";
  return "clash";
}

const CAMELOT_DIST: Record<CamelotMove, number> = {
  same: 0,
  relative: 0.4,
  adjacent: 0.8,
  energy_boost: 1.4,
  diagonal: 1.6,
  pay_attention: 2.6,
  jaws: 3.2,
  clash: 5,
};

export function camelotDistance(a: string, b: string): number {
  if (CAMELOT_WHEEL.indexOf(a.toUpperCase()) < 0) return 6;
  if (CAMELOT_WHEEL.indexOf(b.toUpperCase()) < 0) return 6;
  return CAMELOT_DIST[classifyCamelotMove(a, b)];
}

/** Mixed In Key-style 1–10: human craft override → analysis → spectral heuristic (no BPM). */
export function deriveEnergyLevel(track: Track): number | null {
  if (track.craft?.energyLevel != null) return track.craft.energyLevel;
  const a = track.analysis;
  if (!a) return null;
  if (a.energyLevel != null) return a.energyLevel;
  const peak = a.energy.length ? Math.max(...a.energy) : a.energyMean;
  const brightness = a.brightness ?? 0.3;
  let heatMean = a.energyMean;
  if (a.heatInBars != null && a.heatOutBars != null && a.energy.length && a.durationBars > 0) {
    const n = a.energy.length;
    const i0 = Math.floor((a.heatInBars / a.durationBars) * (n - 1));
    const i1 = Math.floor((a.heatOutBars / a.durationBars) * (n - 1));
    const slice = a.energy.slice(Math.max(0, i0), Math.max(i0 + 1, i1 + 1));
    if (slice.length) heatMean = slice.reduce((s, x) => s + x, 0) / slice.length;
  }
  const raw = peak * 0.45 + brightness * 0.25 + heatMean * 0.2 + a.energyMean * 0.1;
  return Math.round(1 + Math.min(1, Math.max(0, raw)) * 9);
}

function tempoRatio(a: number, b: number): "same" | "near" | "half" | "double" | "far" {
  if (!a || !b) return "far";
  const ratio = b / a;
  if (Math.abs(ratio - 1) <= 0.03) return "same";
  if (Math.abs(ratio - 2) <= 0.06) return "double";
  if (Math.abs(ratio - 0.5) <= 0.06) return "half";
  if (Math.abs(b - a) / a <= 0.06) return "near";
  return "far";
}

/** Pairwise compatibility metrics — not set authorship. */
export function scorePair(a: Track, b: Track): { score: number; why: string } {
  if (!a.analysis || !b.analysis) return { score: -Infinity, why: "missing analysis" };
  const bpmDelta = b.analysis.bpm - a.analysis.bpm;
  const rel = tempoRatio(a.analysis.bpm, b.analysis.bpm);
  const bpmCost =
    rel === "half" || rel === "double" ? 4 : rel === "far" ? 28 : Math.abs(bpmDelta) * 5;
  const move = classifyCamelotMove(a.analysis.key.camelot, b.analysis.key.camelot);
  const keyDist = camelotDistance(a.analysis.key.camelot, b.analysis.key.camelot);
  const eA = deriveEnergyLevel(a) ?? 5;
  const eB = deriveEnergyLevel(b) ?? 5;
  const eDelta = eB - eA;
  // +1–2 energy is free (a lift). Same energy is not a prize. Drops cost.
  const energyPen = eDelta >= 1 ? Math.max(0, eDelta - 2) * 4 : eDelta === 0 ? 6 : Math.abs(eDelta) * 8;
  const vocalPen = a.analysis.vocalLead && b.analysis.vocalLead ? 14 : 0;
  const roleA = a.craft?.role;
  const roleB = b.craft?.role;
  const rolePen = roleA && roleB && roleA === "peak" && roleB === "opener" ? 10 : 0;
  const score = 100 - bpmCost - keyDist * 12 - energyPen - vocalPen - rolePen;
  const why = `ΔBPM ${bpmDelta >= 0 ? "+" : ""}${bpmDelta.toFixed(1)} ${rel}, ${a.analysis.key.camelot}→${b.analysis.key.camelot} ${move}, E ${eA}→${eB}${vocalPen ? ", two vocals" : ""}`;
  return { score, why };
}

export function suggestCompatible(
  doc: SetDoc,
  trackId: TrackId,
  bpmMin?: number,
  bpmMax?: number,
) {
  const seed = doc.tracks[trackId];
  if (!seed?.analysis) return [];
  return Object.values(doc.tracks)
    .filter((t) => t.id !== trackId && t.analysis)
    .filter((t) => {
      const bpm = t.analysis!.bpm;
      if (bpmMin != null && bpm < bpmMin) return false;
      if (bpmMax != null && bpm > bpmMax) return false;
      return true;
    })
    .map((t) => {
      const { score, why } = scorePair(seed, t);
      return {
        trackId: t.id,
        title: t.title,
        bpm: t.analysis!.bpm,
        key: t.analysis!.key.camelot,
        energy: t.analysis!.energyMean,
        energyLevel: deriveEnergyLevel(t),
        role: t.craft?.role ?? null,
        genre: t.craft?.genreHint ?? null,
        vocalLead: Boolean(t.analysis!.vocalLead),
        camelotMove: classifyCamelotMove(
          seed.analysis!.key.camelot,
          t.analysis!.key.camelot,
        ),
        score,
        why,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

export type SetQuality = {
  overall: number;
  bpm_deltas: number[];
  key_distances: number[];
  camelot_moves: string[];
  energy_means: number[];
  energy_levels: (number | null)[];
  weak_transitions: number[];
  notes: string[];
};

/** Read-only metrics for whatever arrangement exists — agent interprets. */
export function scoreArrangement(doc: SetDoc, entries: ArrangementEntry[]): SetQuality {
  const bpm_deltas: number[] = [];
  const key_distances: number[] = [];
  const camelot_moves: string[] = [];
  const energy_means = entries.map(
    (e) => doc.tracks[e.trackId]?.analysis?.energyMean ?? 0,
  );
  const energy_levels = entries.map((e) =>
    doc.tracks[e.trackId] ? deriveEnergyLevel(doc.tracks[e.trackId]!) : null,
  );
  const weak: number[] = [];
  const notes: string[] = [];

  for (let i = 1; i < entries.length; i++) {
    const a = doc.tracks[entries[i - 1]!.trackId];
    const b = doc.tracks[entries[i]!.trackId];
    if (!a?.analysis || !b?.analysis) continue;
    const bpmDelta = b.analysis.bpm - a.analysis.bpm;
    const move = classifyCamelotMove(a.analysis.key.camelot, b.analysis.key.camelot);
    const keyDist = camelotDistance(a.analysis.key.camelot, b.analysis.key.camelot);
    bpm_deltas.push(Number(bpmDelta.toFixed(2)));
    key_distances.push(keyDist);
    camelot_moves.push(move);
    if (Math.abs(bpmDelta) > 8 || move === "clash") {
      weak.push(i);
      notes.push(
        `index ${i}: ΔBPM ${bpmDelta.toFixed(1)}, ${a.analysis.key.camelot}→${b.analysis.key.camelot} ${move}`,
      );
    }
  }

  const verify = verifySet(doc, entries);
  for (const issue of verify.issues) {
    notes.push(issue.message);
    if (issue.severity === "error" && issue.index != null && !weak.includes(issue.index)) {
      weak.push(issue.index);
    }
  }

  const pen =
    weak.length * 12 +
    bpm_deltas.reduce((s, d) => s + Math.max(0, Math.abs(d) - 4) * 2, 0) +
    verify.issues.filter((i) => i.severity === "error").length * 8;
  return {
    overall: Math.max(0, Math.min(100, Math.round(100 - pen))),
    bpm_deltas,
    key_distances,
    camelot_moves,
    energy_means,
    energy_levels,
    weak_transitions: weak,
    notes,
  };
}

export type MixPoint = {
  label: string;
  bars: number;
  /** Nearest 8-bar phrase line — prefer this for in_bars / out_bars. */
  phraseBars: number;
  section: string;
  role: "mix_out" | "mix_in" | "phrase" | "drop" | "breakdown" | "vocal_end" | "safe_leave";
  energyHint: "low" | "mid" | "high";
  energy: number;
};

export function snapToPhrase(bars: number, phrase = 8): number {
  if (!Number.isFinite(bars) || bars <= 0) return 0;
  return Math.round(bars / phrase) * phrase;
}

export function phraseOffGrid(bars: number, phrase = 8, slop = 1): boolean {
  if (bars <= 0.25) return false;
  return Math.abs(bars - snapToPhrase(bars, phrase)) > slop;
}

function energyAtBars(track: Track, bars: number): number {
  const a = track.analysis;
  if (!a?.energy.length || !a.durationBars) return a?.energyMean ?? 0;
  const t = Math.min(1, Math.max(0, bars / a.durationBars));
  const idx = Math.min(a.energy.length - 1, Math.floor(t * (a.energy.length - 1)));
  return Number((a.energy[idx] ?? a.energyMean).toFixed(3));
}

function energyHintAt(energy: number): "low" | "mid" | "high" {
  if (energy >= 0.72) return "high";
  if (energy <= 0.4) return "low";
  return "mid";
}

/** Phrase candidates from analysis sections — agent still chooses. */
export function getMixPoints(track: Track): MixPoint[] {
  const a = track.analysis;
  if (!a) return [];
  const points: MixPoint[] = [];
  const push = (p: Omit<MixPoint, "phraseBars" | "energy"> & { energy?: number }) => {
    const phraseBars = snapToPhrase(p.bars);
    const hit = points.find((x) => Math.abs(x.bars - p.bars) < 0.5);
    if (hit) {
      if (p.role === "drop" && hit.role !== "drop") {
        points.splice(points.indexOf(hit), 1);
      } else {
        return;
      }
    }
    const energy = p.energy ?? energyAtBars(track, p.bars);
    points.push({
      ...p,
      phraseBars,
      energy,
      energyHint: p.energyHint ?? energyHintAt(energy),
    });
  };

  if (a.dropBars != null) {
    push({
      label: "measured drop (salience)",
      bars: Number(a.dropBars.toFixed(2)),
      section: "drop",
      role: "drop",
      energyHint: "high",
    });
  }

  for (const s of a.sections) {
    const mid = (s.startBars + s.endBars) / 2;
    if (s.label === "intro") {
      push({
        label: "end of intro",
        bars: Number(s.endBars.toFixed(2)),
        section: s.label,
        role: "mix_in",
        energyHint: "low",
      });
    } else if (s.label === "build") {
      push({
        label: "build start",
        bars: Number(s.startBars.toFixed(2)),
        section: s.label,
        role: "phrase",
        energyHint: "mid",
      });
      push({
        label: "build end / into drop",
        bars: Number(s.endBars.toFixed(2)),
        section: s.label,
        role: "drop",
        energyHint: "high",
      });
    } else if (s.label === "drop") {
      push({
        label: "drop start",
        bars: Number(s.startBars.toFixed(2)),
        section: s.label,
        role: "drop",
        energyHint: "high",
      });
      push({
        label: "drop mid",
        bars: Number(mid.toFixed(2)),
        section: s.label,
        role: "phrase",
        energyHint: "high",
      });
      push({
        label: "end of drop",
        bars: Number(s.endBars.toFixed(2)),
        section: s.label,
        role: "mix_out",
        energyHint: "high",
      });
    } else if (s.label === "breakdown") {
      push({
        label: "breakdown start",
        bars: Number(s.startBars.toFixed(2)),
        section: s.label,
        role: "breakdown",
        energyHint: "low",
      });
      push({
        label: "breakdown end",
        bars: Number(s.endBars.toFixed(2)),
        section: s.label,
        role: "mix_in",
        energyHint: "mid",
      });
    } else if (s.label === "outro") {
      push({
        label: "outro start",
        bars: Number(s.startBars.toFixed(2)),
        section: s.label,
        role: "mix_out",
        energyHint: "low",
      });
    } else if (s.label === "verse" || s.label === "chorus") {
      // Legacy IDB rows only — current detector emits intro/build/drop/breakdown/outro.
      push({
        label: `${s.label} start`,
        bars: Number(s.startBars.toFixed(2)),
        section: s.label,
        role: s.label === "chorus" ? "drop" : "mix_in",
        energyHint: s.label === "chorus" ? "high" : "mid",
      });
    }
  }

  push({
    label: "track start",
    bars: 0,
    section: "start",
    role: "mix_in",
    energyHint: "low",
  });
  push({
    label: "near end",
    bars: Number(Math.max(0, a.durationBars - 8).toFixed(2)),
    section: "end",
    role: "mix_out",
    energyHint: "mid",
  });

  const dropPts = points.filter((p) => p.role === "drop");
  const peakDropPt = dropPts.length
    ? dropPts.reduce((best, p) => (p.energy > best.energy ? p : best))
    : undefined;
  const dropAt = peakDropPt?.phraseBars ?? peakDropPt?.bars;
  if (dropAt != null) {
    for (const n of [8, 16] as const) {
      const cue = dropAt - n;
      if (cue >= 4) {
        push({
          label: `${n} bars before peak drop (drop-swap cue)`,
          bars: Number(cue.toFixed(2)),
          section: "build",
          role: "phrase",
          energyHint: "mid",
        });
      }
    }
    const leave = safeLeaveBars(track, dropAt);
    push({
      label: "safe leave (after the line)",
      bars: Number(leave.toFixed(2)),
      section: "vocal",
      role: "safe_leave",
      energyHint: energyHintAt(energyAtBars(track, leave)),
    });
  }

  for (const r of a.vocalRegions ?? []) {
    const bars = snapToPhrase(r.endBars);
    if (bars < 8 || bars > a.durationBars - 4) continue;
    push({
      label: "vocal end",
      bars: Number(bars.toFixed(2)),
      section: "vocal",
      role: "vocal_end",
      energyHint: energyHintAt(energyAtBars(track, bars)),
    });
  }

  // Phrase grid from aligned downbeats (every 8 bars), not duration÷BPM ticks.
  if (a.downbeats.length >= 8) {
    const barSec = (60 / a.bpm) * 4;
    for (let i = 8; i < a.downbeats.length; i += 8) {
      const bars = a.downbeats[i]! / barSec;
      if (bars < 8 || bars > a.durationBars - 8) continue;
      push({
        label: `phrase ${Math.round(bars)}`,
        bars: Number(bars.toFixed(2)),
        section: "grid",
        role: "phrase",
        energyHint: energyHintAt(energyAtBars(track, bars)),
      });
    }
  }

  return points.sort((x, y) => x.bars - y.bars);
}

export type VerifyIssue = {
  code: string;
  index?: number;
  message: string;
  severity: "error" | "warn";
};

export type VerifyResult = {
  ready: boolean;
  issues: VerifyIssue[];
};

function nearestSectionEnergy(
  track: Track,
  bars: number,
): "low" | "mid" | "high" | null {
  const sections = track.analysis?.sections;
  if (!sections?.length) return null;
  const hit =
    sections.find((s) => bars >= s.startBars && bars < s.endBars) ??
    sections.reduce((best, s) =>
      Math.abs(s.startBars - bars) < Math.abs(best.startBars - bars) ? s : best,
    );
  if (hit.label === "drop" || hit.label === "chorus") return "high";
  if (hit.label === "intro" || hit.label === "outro" || hit.label === "breakdown")
    return "low";
  return "mid";
}

function hasBassKill(doc: SetDoc, joinStart: number, joinEnd: number): boolean {
  const lanes = allAutomation(doc).filter(
    (l) =>
      (l.param === "eq_low_a" || l.param === "eq_low_b") &&
      l.endBars >= joinStart &&
      l.startBars <= joinEnd,
  );
  return lanes.some((l) => Math.min(l.startValue, l.endValue) <= -18);
}

function hasFxArm(doc: SetDoc, joinStart: number, joinEnd: number): boolean {
  return allAutomation(doc).some(
    (l) =>
      (l.param === "fx_arm" || l.param === "fx_wet") &&
      l.endBars >= joinStart &&
      l.startBars <= joinEnd &&
      Math.max(l.startValue, l.endValue) > 0.2,
  );
}

function hasTempoRamp(doc: SetDoc, joinStart: number, joinEnd: number): boolean {
  return allAutomation(doc).some(
    (l) =>
      l.param === "tempo" &&
      l.endBars >= joinStart &&
      l.startBars <= joinEnd &&
      Math.abs(l.endValue - l.startValue) >= 1,
  );
}

function regionOverlaps(
  start: number,
  end: number,
  regions: { startBars: number; endBars: number }[] | undefined,
): boolean {
  if (!regions?.length) return false;
  return regions.some((r) => r.endBars > start && r.startBars < end);
}

/** Craft gate — fails wash-only / double-bass mixes. */
export function verifySet(
  doc: SetDoc,
  entries: ArrangementEntry[] = doc.arrangement,
): VerifyResult {
  const issues: VerifyIssue[] = [];
  if (entries.length < 2) {
    issues.push({
      code: "too_short",
      message: "Need at least 2 arrangement entries for a mix.",
      severity: "error",
    });
    return { ready: false, issues };
  }

  const probe: SetDoc = { ...doc, arrangement: entries };
  const spans = buildTimeline(probe);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const play = e.outBars - e.inBars;
    if (phraseOffGrid(e.inBars) || phraseOffGrid(e.outBars)) {
      issues.push({
        code: "phrase_off_grid",
        index: i,
        message: `Index ${i}: snap in/out to 8-bar phrases (in ${e.inBars.toFixed(1)} → ${snapToPhrase(e.inBars)}).`,
        severity: "warn",
      });
    }
    if (
      play < 16 &&
      (i === 0 || (e.transition.type !== "cut" && e.transition.type !== "backspin"))
    ) {
      issues.push({
        code: "play_too_short",
        index: i,
        message: `Index ${i} plays ${play.toFixed(0)} bars — crowd needs ≥16 unless this is a cut / power block.`,
        severity: "warn",
      });
    }
    if (play > 96) {
      issues.push({
        code: "play_too_long",
        index: i,
        message: `Index ${i} plays ${play.toFixed(0)} bars — trim to the idea (24–64 typical), don't dump the file.`,
        severity: "warn",
      });
    }
  }

  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const cur = entries[i]!;
    const span = spans[i];
    const prevSpan = spans[i - 1];
    const ta = doc.tracks[prev.trackId];
    const tb = doc.tracks[cur.trackId];
    const type = cur.transition.type;
    const bars = cur.transition.bars;

    if (!isTransitionType(type)) {
      issues.push({
        code: "unknown_transition",
        index: i,
        message: `Join ${i}: "${String(type)}" is not a transition type — recipe names (power_cut, bass_swap, half_bridge, power_block) must be applied through apply_transition_recipe. Valid types: ${TRANSITION_TYPES.join(", ")}.`,
        severity: "error",
      });
      continue;
    }

    const joinStart = span?.setStart ?? 0;
    const joinEnd = Math.min(
      (span?.setStart ?? 0) + bars,
      prevSpan?.setEnd ?? joinStart + bars,
    );
    const echoStart =
      type === "echo_out" || type === "air_cut"
        ? Math.max(0, (prevSpan?.setEnd ?? 0) - Math.max(2, bars))
        : joinStart;
    const echoEnd =
      type === "echo_out" || type === "air_cut"
        ? (prevSpan?.setEnd ?? joinEnd)
        : joinEnd;
    const gateStart = type === "echo_out" || type === "air_cut" ? echoStart : joinStart;
    const gateEnd = type === "echo_out" || type === "air_cut" ? echoEnd : joinEnd;

    const maxBars: Record<TransitionType, number> = {
      cut: 2,
      blend: 16,
      eq_swap: 24,
      filter_sweep: 24,
      build_cut: 24,
      drop_swap: 24,
      echo_out: 12,
      air_cut: 4,
      tempo_ride: 16,
      tease_slam: 16,
      loop_out: 8,
      loop_roll: 8,
      double_drop: 24,
      backspin: 2,
      hook_layer: 20,
    };
    const minBars: Partial<Record<TransitionType, number>> = {
      build_cut: 4,
      drop_swap: 8,
      filter_sweep: 4,
      blend: 4,
      eq_swap: 4,
      echo_out: 2,
      air_cut: 1,
      tempo_ride: 16,
      tease_slam: 8,
      double_drop: 8,
      hook_layer: 8,
      loop_roll: 2,
    };

    if (bars > (maxBars[type] ?? 32)) {
      issues.push({
        code: "transition_too_long",
        index: i,
        message: `${type} at index ${i} is ${bars} bars — max ${maxBars[type]} (sounds like a wash).`,
        severity: "error",
      });
    }
    if (minBars[type] != null && bars < minBars[type]!) {
      issues.push({
        code: "transition_too_short",
        index: i,
        message: `${type} at index ${i} is ${bars} bars — need ≥ ${minBars[type]}.`,
        severity: "warn",
      });
    }

    if (
      (type === "blend" ||
        type === "filter_sweep" ||
        type === "build_cut" ||
        type === "drop_swap" ||
        type === "eq_swap" ||
        type === "echo_out" ||
        type === "air_cut" ||
        type === "tempo_ride" ||
        type === "tease_slam" ||
        type === "double_drop" ||
        type === "hook_layer" ||
        type === "loop_roll") &&
      !hasBassKill(probe, gateStart, gateEnd)
    ) {
      issues.push({
        code: "double_bass",
        index: i,
        message: `Join ${i}: no outgoing bass kill (eq_low → −24). Use apply_transition_recipe.`,
        severity: "error",
      });
    }

    if (
      (type === "echo_out" || type === "build_cut") &&
      !hasFxArm(probe, gateStart, gateEnd)
    ) {
      issues.push({
        code: "echo_without_fx",
        index: i,
        message: `${type} at ${i} should arm FX (fx_arm / fx_wet). Re-apply recipe.`,
        severity: "error",
      });
    }

    if (ta?.analysis && tb?.analysis) {
      const bpmDelta = Math.abs(tb.analysis.bpm - ta.analysis.bpm);
      const needsRamp =
        type !== "echo_out" &&
        type !== "air_cut" &&
        type !== "cut" &&
        type !== "backspin";
      if (bpmDelta > 3 && needsRamp && !hasTempoRamp(probe, joinStart, joinEnd)) {
        issues.push({
          code: "bpm_no_ramp",
          index: i,
          message: `ΔBPM ${bpmDelta.toFixed(1)} at join ${i} without tempo automation across the overlap.`,
          severity: "error",
        });
      }
      if (type === "tempo_ride") {
        if (bpmDelta <= 3) {
          issues.push({
            code: "ride_pointless",
            index: i,
            message: `tempo_ride at join ${i} with ΔBPM ${bpmDelta.toFixed(1)} — the clocks already match; drop_swap covers this without a ride.`,
            severity: "warn",
          });
        }
        if (!doc.decks.A.keylock || !doc.decks.B.keylock) {
          issues.push({
            code: "ride_without_keylock",
            index: i,
            message: `tempo_ride at join ${i} — turn keylock ON on both decks or the ride bends pitch.`,
            severity: "warn",
          });
        }
      }
      const from = ta.analysis.key.camelot;
      const to = tb.analysis.key.camelot;
      const move = classifyCamelotMove(from, to);
      const trusted = keyIsTrusted(ta) && keyIsTrusted(tb);
      // Hole-aware pad cap: a blend parked on the outgoing's tonal hole may
      // run 8 bars even on a label clash — the two harmonies never co-occur.
      const holeOk = holeParkedAt(ta, prev.outBars, bars);
      // Audio truth: audition the actual overlap windows. A measured
      // blend_ok unlocks what the label condemns; a measured clash vetoes
      // what the label blesses. Labels only break ties when there's no curve.
      const sharesWindow =
        type !== "echo_out" && type !== "air_cut" && type !== "cut" && type !== "backspin";
      const audition = sharesWindow
        ? auditionHarmony(
            ta,
            Math.max(0, prev.outBars - bars),
            prev.outBars,
            tb,
            cur.inBars,
            cur.inBars + bars,
          )
        : UNKNOWN_AUDITION;
      const audioOk = audition.verdict === "blend_ok" || audition.verdict === "bass_only";
      const audioClash = audition.verdict === "clash";
      const padCap = audioOk
        ? Math.max(8, padCapForJoin(ta, prev.outBars, move, trusted, bars))
        : audioClash
          ? 1
          : padCapForJoin(ta, prev.outBars, move, trusted, bars);
      // Isolator compiles kill the incoming mids, so raw-window dissonance
      // overstates their clash — soften to a short-isolator cap, not a veto.
      const isoCap = audioClash
        ? Math.min(isolatorOverlapCap(move), 8)
        : isolatorOverlapCap(move);
      if (audition.verdict !== "unknown" && isPadType(type)) {
        issues.push({
          code: "harmony_audition",
          index: i,
          message: `Join ${i}: audio audition ${audition.verdict} (score ${audition.score}) — the measured windows ${audioOk ? "coexist" : "clash"} regardless of the ${from}→${to} label.`,
          severity: audioClash ? "error" : "warn",
        });
      }
      if (holeOk && isPadType(type)) {
        issues.push({
          code: "hole_parked_blend",
          index: i,
          message: `Join ${i}: overlap sits on the outgoing's tonal hole — label clash ${from}→${to} is mostly moot while the harmony sits out.`,
          severity: "warn",
        });
      }
      if (isPadType(type) && bars >= 8 && !trusted && !holeOk && !audioOk) {
        issues.push({
          code: "key_unknown_pad",
          index: i,
          message: `Join ${i}: key confidence is a guess — do not pad-blend ${bars} bars.`,
          severity: "error",
        });
      } else if (
        isPadType(type) &&
        bars >= 8 &&
        (move === "clash" || move === "jaws") &&
        !holeOk &&
        !audioOk
      ) {
        issues.push({
          code: "key_clash",
          index: i,
          message: `Clash ${from}→${to} on a ${bars}-bar ${type}.`,
          severity: "error",
        });
      } else if (isPadType(type) && bars > padCap) {
        issues.push({
          code: "key_overlap_too_long",
          index: i,
          message: `Join ${i}: ${bars}-bar ${type} is longer than ${padCap} for ${move}.`,
          severity: "error",
        });
      } else if (isIsolatorType(type) && bars > isoCap) {
        issues.push({
          code: "key_overlap_too_long",
          index: i,
          message: `Join ${i}: ${bars}-bar ${type} is longer than ${isoCap} for ${move}.`,
          severity: "error",
        });
      } else if (isIsolatorType(type) && (move === "clash" || move === "jaws") && bars >= 8) {
        issues.push({
          code: "key_clash",
          index: i,
          message: `Clash ${from}→${to} on an isolator — filter or cut rather than a long replace.`,
          severity: "warn",
        });
      }
    }

    if (
      type !== "echo_out" &&
      type !== "backspin" &&
      type !== "air_cut" &&
      type !== "cut" &&
      type !== "tease_slam" &&
      ta &&
      vocalCovers(ta, prev.outBars)
    ) {
      issues.push({
        code: "mid_vocal_leave",
        index: i,
        message: `Join ${i}: outgoing leave at bar ${prev.outBars} is mid-line — wait for the vocal end.`,
        severity: "error",
      });
    }

    if (ta && tb && type !== "echo_out" && !isIsolatorType(type)) {
      const outWin = [Math.max(0, prev.outBars - bars), prev.outBars] as const;
      const inWin = [cur.inBars, cur.inBars + bars] as const;
      if (
        regionOverlaps(outWin[0], outWin[1], ta.analysis?.vocalRegions) &&
        regionOverlaps(inWin[0], inWin[1], tb.analysis?.vocalRegions)
      ) {
        issues.push({
          code: "vocal_overlap",
          index: i,
          message: `Join ${i}: vocal regions overlap on both tracks — shift bars or use eq_swap / cut.`,
          severity: "warn",
        });
      }
    }

    if (tb) {
      const hitBars =
        isIsolatorType(type) && bars >= 8
          ? cur.inBars + 8
          : cur.inBars + Math.max(0, bars);
      const hitEnergy = nearestSectionEnergy(tb, hitBars);
      if (
        hitEnergy === "low" &&
        (type === "build_cut" ||
          type === "drop_swap" ||
          type === "cut" ||
          type === "filter_sweep" ||
          type === "double_drop")
      ) {
        issues.push({
          code: "incoming_not_drop",
          index: i,
          message: `Incoming hit at bar ${hitBars.toFixed(1)} is a low-energy section for a ${type}.`,
          severity: "warn",
        });
      }
    }

    if (i === 1 && ta?.analysis && tb?.analysis) {
      if (tb.analysis.energyMean + 0.02 < ta.analysis.energyMean) {
        issues.push({
          code: "energy_arc_down",
          index: i,
          message:
            "Second track energy is lower than the first — peak arc usually rises.",
          severity: "warn",
        });
      }
    }
  }

  const types = entries.slice(1).map((e) => e.transition.type);
  if (types.length >= 3 && types.every((t) => t === types[0])) {
    issues.push({
      code: "same_recipe",
      message: `Every join is ${types[0]} — vary recipe with energy intent (lift/hold/reset).`,
      severity: "warn",
    });
  }

  const keys = entries
    .map((e) => doc.tracks[e.trackId]?.analysis?.key.camelot)
    .filter((k): k is string => Boolean(k));
  if (keys.length >= 3 && keys.every((k) => k === keys[0])) {
    issues.push({
      code: "same_key_run",
      message: `All tracks in ${keys[0]} — walk ±1 or flip A/B so the set does not stall.`,
      severity: "warn",
    });
  }

  const levels = entries
    .map((e) => deriveEnergyLevel(doc.tracks[e.trackId]!))
    .filter((n): n is number => n != null);
  if (levels.length >= 3) {
    const peakIdx = levels.indexOf(Math.max(...levels));
    if (peakIdx === 0) {
      issues.push({
        code: "energy_peaked_early",
        message:
          "Highest energyLevel is track 1 — open at 60–70% of peak and spend the weapon later.",
        severity: "warn",
      });
    }
    const spread = Math.max(...levels) - Math.min(...levels);
    if (spread <= 1) {
      issues.push({
        code: "energy_monotone",
        message: `Energy levels ${levels.join("→")} are flat — add a builder, peak, or reset.`,
        severity: "warn",
      });
    }
  }

  const errors = issues.filter((x) => x.severity === "error");
  return { ready: errors.length === 0, issues };
}

export function applyRecipeBars(
  recipe: string,
  bars?: number,
): { type: TransitionType; bars: number } | null {
  const type = recipeToTransition(recipe);
  if (!type) return null;
  return {
    type,
    bars: bars != null && bars > 0 ? bars : defaultTransitionBars(type),
  };
}
