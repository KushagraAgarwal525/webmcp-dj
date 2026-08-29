import type {
  ArrangementEntry,
  SetDoc,
  Track,
  TrackMood,
  TrackRole,
  TransitionType,
} from "../types/setdoc";
import { analysisNeedsRefresh } from "../analysis/stale";
import { classifyCamelotMove, deriveEnergyLevel, getMixPoints, scorePair, snapToPhrase } from "./builder";
import { defaultTransitionBars, recipeToTransition } from "./timeline";

export type SetArcId = "journey" | "peak_time" | "warm_up" | "cool_down" | "chill" | "power_block";

export function trackRole(track: Track): TrackRole | null {
  return track.craft?.role ?? track.analysis?.suggestedRole ?? null;
}

export function trackMood(track: Track): TrackMood | null {
  return track.craft?.mood ?? track.analysis?.mood ?? null;
}

export function trackGenre(track: Track): string | null {
  return track.craft?.genreHint ?? track.analysis?.genreHint ?? null;
}

export function trackVocalLead(track: Track): boolean {
  return Boolean(track.analysis?.vocalLead);
}

export function bpmLane(bpm: number): string {
  if (bpm >= 160) return "dnb";
  if (bpm >= 145) return "hard";
  if (bpm >= 132) return "techno";
  if (bpm >= 126) return "peak-4/4";
  if (bpm >= 118) return "house";
  if (bpm >= 100) return "groove";
  return "slow";
}

export function tempoRelation(a: number, b: number): "same" | "near" | "half" | "double" | "far" {
  if (!a || !b) return "far";
  const ratio = b / a;
  if (Math.abs(ratio - 1) <= 0.03) return "same";
  if (Math.abs(ratio - 2) <= 0.06) return "double";
  if (Math.abs(ratio - 0.5) <= 0.06) return "half";
  const pct = Math.abs(b - a) / a;
  if (pct <= 0.06) return "near";
  return "far";
}

export function crateHealth(doc: SetDoc) {
  const tracks = Object.values(doc.tracks).filter((t) => t.analysis);
  const keys: Record<string, number> = {};
  const lanes: Record<string, number> = {};
  const roles: Record<string, number> = {};
  const genres: Record<string, number> = {};
  for (const t of tracks) {
    const k = t.analysis!.key.camelot;
    keys[k] = (keys[k] ?? 0) + 1;
    const lane = bpmLane(t.analysis!.bpm);
    lanes[lane] = (lanes[lane] ?? 0) + 1;
    const role = trackRole(t) ?? "unassigned";
    roles[role] = (roles[role] ?? 0) + 1;
    const g = trackGenre(t) ?? "unknown";
    genres[g] = (genres[g] ?? 0) + 1;
  }

  const notes: string[] = [];
  const orphans: string[] = [];
  for (const [key, n] of Object.entries(keys)) {
    const neighbors = tracks.filter((t) => {
      const move = classifyCamelotMove(key, t.analysis!.key.camelot);
      return move === "same" || move === "adjacent" || move === "relative" || move === "energy_boost";
    });
    if (n > 0 && neighbors.length <= n) {
      orphans.push(key);
    }
  }
  if (orphans.length) {
    notes.push(`Thin harmonic coverage: ${orphans.join(", ")} has no adjacent crate mates.`);
  }
  if ((roles.peak ?? 0) === 0 && tracks.length >= 2) {
    notes.push("No peak-tagged tracks — mark a weapon or re-analyze.");
  }
  if ((roles.opener ?? 0) === 0 && tracks.length >= 3) {
    notes.push("No opener — first track will have to come from a mid-energy builder.");
  }
  if (tracks.length && Object.keys(lanes).length === 1) {
    notes.push(`All tracks sit in the ${Object.keys(lanes)[0]} BPM lane — fine for one room, no genre bridge.`);
  }
  const stale = tracks.filter((t) => analysisNeedsRefresh(t.analysis)).length;
  if (stale) {
    notes.push(`${stale} track${stale === 1 ? "" : "s"} still on the old detector — Re-analyze so key/grid/roles are real.`);
  }

  return {
    trackCount: tracks.length,
    keys,
    bpmLanes: lanes,
    roles,
    genres,
    orphans,
    notes,
  };
}

export function findDropBars(track: Track): number | null {
  if (!track.analysis) return null;
  const drop = getMixPoints(track).find((p) => p.role === "drop");
  if (drop) return drop.phraseBars;
  const sec = track.analysis.sections.find((s) => s.label === "drop" || s.label === "chorus");
  return sec ? snapToPhrase(sec.startBars) : null;
}

/** Breakdown or outro after the drop — the hole a leave can aim at. */
export function findHoleBars(track: Track): number | null {
  const a = track.analysis;
  if (!a) return null;
  const drop = findDropBars(track);
  const breakdown = a.sections.find(
    (s) => s.label === "breakdown" && (drop == null || s.startBars + 0.5 >= drop),
  );
  if (breakdown) return snapToPhrase(breakdown.startBars);
  const fromPoints = getMixPoints(track).find((p) => p.role === "breakdown");
  if (fromPoints && (drop == null || fromPoints.phraseBars + 0.5 >= drop)) {
    return fromPoints.phraseBars;
  }
  const outro = a.sections.find((s) => s.label === "outro");
  return outro ? snapToPhrase(outro.startBars) : null;
}

export function isDropRecipe(recipe: string): boolean {
  return (
    recipe === "drop_swap" ||
    recipe === "build_cut" ||
    recipe === "double_drop" ||
    recipe === "power_cut" ||
    recipe === "filter_sweep"
  );
}

/** Park incoming N bars before its drop; leave outgoing on its drop (the hole). */
export function alignDropJoin(
  outgoing: Track,
  incoming: Track,
  nBars: number,
  mode: "swap" | "cut",
): { inBars: number; outBars: number } {
  const durIn = Math.max(8, incoming.analysis?.durationBars ?? 32);
  const durOut = Math.max(8, outgoing.analysis?.durationBars ?? 32);
  const inDrop = findDropBars(incoming);
  const outDrop = findDropBars(outgoing);
  const n = Math.max(1, nBars);

  let inBars = 0;
  if (inDrop != null) {
    inBars =
      mode === "cut"
        ? Math.max(0, Math.min(inDrop, durIn - 1))
        : Math.max(0, Math.min(snapToPhrase(inDrop - n), Math.max(0, durIn - n)));
  }

  let outBars =
    outDrop != null
      ? Math.max(n, Math.min(outDrop, durOut))
      : Math.min(durOut, Math.max(n + 8, durOut * 0.7));
  if (outBars <= 8) outBars = Math.min(durOut, Math.max(16, n + 8));
  return { inBars, outBars };
}

function pickMixWindow(track: Track, role: TrackRole | null): { inBars: number; outBars: number } {
  const a = track.analysis!;
  const dur = Math.max(8, a.durationBars);
  const points = getMixPoints(track).filter(
    (p) => p.bars >= 0 && p.phraseBars < dur - 0.5,
  );
  const drop = points.find((p) => p.role === "drop");
  const mixIn = points.find((p) => p.role === "mix_in" && p.phraseBars > 0);
  const mixOut = [...points].reverse().find((p) => p.role === "mix_out" && p.phraseBars > 8);
  let start =
    role === "peak" || role === "builder"
      ? (drop?.phraseBars ?? mixIn?.phraseBars ?? 0)
      : (mixIn?.phraseBars ?? 0);
  start = Math.max(0, Math.min(start, Math.max(0, dur - 8)));
  const endHint = mixOut?.phraseBars ?? dur;
  const want = Math.min(64, Math.max(16, endHint - start));
  const outBars = Math.min(dur, Math.max(start + 8, start + want));
  if (outBars <= start) return { inBars: 0, outBars: dur };
  return { inBars: start, outBars };
}

export function planSetArc(
  doc: SetDoc,
  arc: SetArcId,
  trackCount?: number,
): {
  arc: SetArcId;
  reason: string;
  entries: Array<{
    track_id: string;
    title: string;
    role: TrackRole | null;
    energyLevel: number | null;
    in_bars: number;
    out_bars: number;
    drop_bars: number | null;
    cue_before_drop_8: number | null;
    cue_before_drop_16: number | null;
    transition: TransitionType;
    bars: number;
    recipe: string | null;
  }>;
} {
  const pool = Object.values(doc.tracks).filter((t) => t.analysis);
  const n = Math.max(2, Math.min(trackCount ?? Math.min(6, pool.length), pool.length));
  if (pool.length < 2) {
    return { arc, reason: "Need at least 2 analyzed tracks.", entries: [] };
  }

  const ranked = [...pool].sort((a, b) => (deriveEnergyLevel(b) ?? 0) - (deriveEnergyLevel(a) ?? 0));
  const peak = ranked[0]!;
  const peakE = deriveEnergyLevel(peak) ?? 7;

  const pick = (pred: (t: Track) => boolean, exclude: Set<string>) =>
    ranked.find((t) => !exclude.has(t.id) && pred(t));

  const used = new Set<string>();
  const sequence: Track[] = [];

  if (arc === "power_block") {
    const key = peak.analysis!.key.camelot;
    for (const t of ranked) {
      if (sequence.length >= n) break;
      const move = classifyCamelotMove(key, t.analysis!.key.camelot);
      if (move === "same" || move === "adjacent" || t.id === peak.id) {
        sequence.push(t);
        used.add(t.id);
      }
    }
  } else if (arc === "peak_time") {
    for (const t of ranked) {
      if (sequence.length >= n) break;
      if ((deriveEnergyLevel(t) ?? 0) >= peakE - 2) {
        sequence.push(t);
        used.add(t.id);
      }
    }
  } else if (arc === "chill") {
    for (const t of [...ranked].reverse()) {
      if (sequence.length >= n) break;
      sequence.push(t);
      used.add(t.id);
    }
  } else if (arc === "cool_down") {
    sequence.push(peak);
    used.add(peak.id);
    while (sequence.length < n) {
      const prev = sequence[sequence.length - 1]!;
      const next =
        pick(
          (t) => (deriveEnergyLevel(t) ?? 9) <= (deriveEnergyLevel(prev) ?? 9) && scorePair(prev, t).score > 20,
          used,
        ) ?? ranked.find((t) => !used.has(t.id));
      if (!next) break;
      sequence.push(next);
      used.add(next.id);
    }
  } else {
    // journey / warm_up — peak first, then opener, then path
    const openerTarget = arc === "warm_up" ? peakE * 0.45 : peakE * 0.65;
    const opener =
      pick(
        (t) => {
          const e = deriveEnergyLevel(t) ?? 5;
          return e <= openerTarget + 1 && e >= openerTarget - 3 && t.id !== peak.id;
        },
        used,
      ) ?? ranked[ranked.length - 1]!;
    sequence.push(opener);
    used.add(opener.id);
    const builders = ranked.filter((t) => !used.has(t.id) && t.id !== peak.id);
    const midSlots = Math.max(0, n - 2);
    for (let i = 0; i < midSlots; i++) {
      const prev = sequence[sequence.length - 1]!;
      const want = openerTarget + ((peakE - openerTarget) * (i + 1)) / (midSlots + 1);
      builders.sort(
        (a, b) =>
          Math.abs((deriveEnergyLevel(a) ?? 5) - want) - Math.abs((deriveEnergyLevel(b) ?? 5) - want) ||
          scorePair(prev, b).score - scorePair(prev, a).score,
      );
      const next = builders.find((t) => !used.has(t.id));
      if (!next) break;
      sequence.push(next);
      used.add(next.id);
    }
    if (!used.has(peak.id) && sequence.length < n) {
      sequence.push(peak);
      used.add(peak.id);
    } else if (!used.has(peak.id)) {
      sequence[sequence.length - 1] = peak;
    }
    if (arc === "journey" && sequence.length < n) {
      const closer = ranked.filter((t) => !used.has(t.id)).pop();
      if (closer) sequence.push(closer);
    }
  }

  while (sequence.length < n) {
    const extra = ranked.find((t) => !used.has(t.id));
    if (!extra) break;
    sequence.push(extra);
    used.add(extra.id);
  }

  const entries = sequence.map((t, i) => {
    const role = trackRole(t);
    const win = pickMixWindow(t, role);
    const drop = findDropBars(t);
    const dur = Math.max(8, t.analysis?.durationBars ?? 32);
    const cue = (n: number) =>
      drop == null ? null : Math.max(0, Math.min(snapToPhrase(drop - n), Math.max(0, dur - n)));
    const placeholder = i === 0 || arc === "power_block";
    return {
      track_id: t.id,
      title: t.title,
      role,
      energyLevel: deriveEnergyLevel(t),
      in_bars: win.inBars,
      out_bars: win.outBars,
      drop_bars: drop,
      cue_before_drop_8: cue(8),
      cue_before_drop_16: cue(16),
      transition: "cut" as TransitionType,
      bars: 1,
      recipe: placeholder ? (arc === "power_block" && i > 0 ? "power_block" : "cut") : null,
    };
  });

  return {
    arc,
    reason: `Order for ${arc} from peak "${peak.title}" (E${peakE}). Joins unset (1-bar cut placeholder) — pick replace / stack / cut / blend from drop cues.`,
    entries,
  };
}

export function plannedToEntries(
  plan: ReturnType<typeof planSetArc>,
): Array<{
  track_id: string;
  in_bars: number;
  out_bars: number;
  transition: TransitionType;
  bars: number;
}> {
  return plan.entries.map((e) => ({
    track_id: e.track_id,
    in_bars: e.in_bars,
    out_bars: e.out_bars,
    transition: e.transition,
    bars: e.bars,
  }));
}

export function powerBlockTrims(doc: SetDoc, entries: ArrangementEntry[]) {
  return entries.map((e, i) => {
    const track = doc.tracks[e.trackId];
    if (!track?.analysis) return { index: i, ...e };
    const win = pickMixWindow(track, "peak");
    return {
      index: i,
      inBars: win.inBars,
      outBars: Math.min(win.inBars + 32, win.outBars),
      transition: "cut" as TransitionType,
      bars: 1,
    };
  });
}

export function recipeNameToType(recipe: string): TransitionType | null {
  return recipeToTransition(recipe);
}

export function defaultBarsForRecipe(recipe: string): number {
  const t = recipeToTransition(recipe);
  return t ? defaultTransitionBars(t) : 8;
}
