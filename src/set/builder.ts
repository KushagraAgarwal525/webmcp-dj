import type {
  ArrangementEntry,
  SetDoc,
  Track,
  TrackId,
  TransitionType,
} from "../types/setdoc";
import {
  allAutomation,
  buildTimeline,
  defaultTransitionBars,
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

/** Mixed In Key-style 1–10: human craft override → analysis → heuristic. */
export function deriveEnergyLevel(track: Track): number | null {
  if (track.craft?.energyLevel != null) return track.craft.energyLevel;
  const a = track.analysis;
  if (!a) return null;
  if (a.energyLevel != null) return a.energyLevel;
  const total = Math.max(1e-6, a.durationBars);
  const dropShare =
    a.sections
      .filter((s) => s.label === "drop" || s.label === "chorus")
      .reduce((s, x) => s + Math.max(0, x.endBars - x.startBars), 0) / total;
  const bpmNorm = Math.min(1, Math.max(0, (a.bpm - 110) / 50));
  const raw = a.energyMean * 0.55 + dropShare * 0.25 + bpmNorm * 0.2;
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
  const roleA = a.craft?.role ?? a.analysis.suggestedRole;
  const roleB = b.craft?.role ?? b.analysis.suggestedRole;
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
        role: t.craft?.role ?? t.analysis!.suggestedRole ?? null,
        genre: t.craft?.genreHint ?? t.analysis!.genreHint ?? null,
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
  role: "mix_out" | "mix_in" | "phrase" | "drop" | "breakdown";
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
    if (points.some((x) => Math.abs(x.bars - p.bars) < 0.5)) return;
    const energy = p.energy ?? energyAtBars(track, p.bars);
    points.push({
      ...p,
      phraseBars,
      energy,
      energyHint: p.energyHint ?? energyHintAt(energy),
    });
  };

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

  const dropAt = points.find((p) => p.role === "drop")?.bars;
  if (dropAt != null) {
    for (const n of [8, 16] as const) {
      const cue = dropAt - n;
      if (cue >= 4) {
        push({
          label: `${n} bars before drop (drop-swap cue)`,
          bars: Number(cue.toFixed(2)),
          section: "build",
          role: "phrase",
          energyHint: "mid",
        });
      }
    }
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
    const joinStart = span?.setStart ?? 0;
    const joinEnd = Math.min(
      (span?.setStart ?? 0) + bars,
      prevSpan?.setEnd ?? joinStart + bars,
    );

    const maxBars: Record<TransitionType, number> = {
      cut: 2,
      blend: 16,
      eq_swap: 24,
      filter_sweep: 24,
      build_cut: 24,
      drop_swap: 24,
      echo_out: 12,
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
        type === "double_drop" ||
        type === "hook_layer" ||
        type === "loop_roll") &&
      !hasBassKill(probe, joinStart, joinEnd)
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
      !hasFxArm(probe, joinStart, joinEnd)
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
      if (bpmDelta > 3 && !hasTempoRamp(probe, joinStart, joinEnd)) {
        issues.push({
          code: "bpm_no_ramp",
          index: i,
          message: `ΔBPM ${bpmDelta.toFixed(1)} at join ${i} without tempo automation across the overlap.`,
          severity: "error",
        });
      }
      const from = ta.analysis.key.camelot;
      const to = tb.analysis.key.camelot;
      const move = classifyCamelotMove(from, to);
      const longMelodic =
        bars >= 8 &&
        (type === "blend" ||
          type === "eq_swap" ||
          type === "filter_sweep" ||
          type === "build_cut");
      if (move === "clash" && longMelodic) {
        issues.push({
          code: "key_clash",
          index: i,
          message: `Clash ${from}→${to} on a ${bars}-bar ${type} (long pad overlap).`,
          severity: "warn",
        });
      } else if (
        (move === "jaws" || move === "pay_attention") &&
        longMelodic
      ) {
        issues.push({
          code: "key_drama",
          index: i,
          message: `${move} ${from}→${to} on a long pad blend.`,
          severity: "warn",
        });
      }
    }

    if (ta && tb) {
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
      const hitBars = cur.inBars + Math.max(0, bars);
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
          message: `Incoming hit at bar ${hitBars.toFixed(1)} (in_bars + ${bars}) is a low-energy section for a ${type}.`,
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
