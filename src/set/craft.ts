import type {
  ArrangementEntry,
  ComposeStyle,
  SetDoc,
  Track,
  TrackMood,
  TrackRole,
  TransitionType,
} from "../types/setdoc";
import { analysisNeedsRefresh } from "../analysis/stale";
import {
  auditionHarmony,
  classifyCamelotMove,
  deriveEnergyLevel,
  getMixPoints,
  holeParkedAt,
  isolatorOverlapCap,
  keyIsTrusted,
  padOverlapCap,
  safeLeaveBars,
  scorePair,
  snapToPhrase,
  vocalCovers,
} from "./builder";
import type { TransitionRecipe } from "../agent/djPlaybook";
import {
  buildTimeline,
  compileTransitionAutomation,
  defaultTransitionBars,
  recipeToTransition,
} from "./timeline";

export type SetArcId = "journey" | "peak_time" | "warm_up" | "cool_down" | "chill" | "power_block";

export function trackRole(track: Track): TrackRole | null {
  return track.craft?.role ?? null;
}

/** Chop = club edits. Blend only when the night is explicitly chill/deep/smooth. */
export function inferStyle(intent?: string, arc?: SetArcId): ComposeStyle {
  const text = (intent ?? "").trim().toLowerCase();
  if (/\b(chop|edit|slam|power[_\s-]?block)\b/.test(text)) return "chop";
  if (/\b(chill|deep|warm[_\s-]?up|smooth|blend)\b/.test(text)) return "blend";
  if (arc === "chill" || arc === "warm_up" || arc === "cool_down") return "blend";
  return "chop";
}

export function isChopJoin(recipe: string): boolean {
  return (
    recipe === "tease_slam" ||
    recipe === "power_cut" ||
    recipe === "air_cut" ||
    recipe === "backspin" ||
    recipe === "loop_roll" ||
    recipe === "power_block"
  );
}

export type ClipSlot = "up" | "drop" | "down";

export function clipSlot(index: number, n: number, style: ComposeStyle): ClipSlot {
  if (style !== "chop") return "drop";
  if (n >= 4 && index === Math.floor(n / 2)) return "down";
  if (index === 0 && n >= 3) return "up";
  return "drop";
}

export function trackMood(track: Track): TrackMood | null {
  // Curated only — the detector's mood guesses (minor-key ⇏ dark) misguided
  // the agent; tag_track is where mood comes from now.
  return track.craft?.mood ?? null;
}

export function trackGenre(track: Track): string | null {
  // Curated only — BPM-bucket genre guesses ("107.7 → hip-hop") were comedy.
  return track.craft?.genreHint ?? null;
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
  if (tracks.length >= 2) {
    const levels = tracks.map((t) => deriveEnergyLevel(t) ?? 5);
    if (Math.max(...levels) - Math.min(...levels) < 1) {
      notes.push("Crate energy is flat — a RESET clip mid-set will have nowhere to sit.");
    }
  }
  if (tracks.length && Object.keys(lanes).length === 1) {
    notes.push(`All tracks sit in the ${Object.keys(lanes)[0]} BPM lane — fine for one room, no genre bridge.`);
  }
  const stale = tracks.filter((t) => analysisNeedsRefresh(t.analysis)).length;
  if (stale) {
    notes.push(
      `${stale} track${stale === 1 ? "" : "s"} still on the old detector — Re-analyze so drop/key/energy are salience-v1.`,
    );
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
  const a = track.analysis;
  if (!a) return null;
  // Measured salience drop first — labels (sections/mix points) only advise.
  // This is what makes drop finding survive section mislabels.
  if (a.dropBars != null && a.dropBars >= 8) return snapToPhrase(a.dropBars);
  const drop = getMixPoints(track).find((p) => p.role === "drop");
  if (drop) return drop.phraseBars;
  const sec = a.sections.find((s) => s.label === "drop" || s.label === "chorus");
  return sec ? snapToPhrase(sec.startBars) : null;
}

/** Loudest pictured drop — the 1 the room waits for, not the first build-end. */
export function findPeakDropBars(track: Track): number | null {
  const a = track.analysis;
  if (a?.dropBars != null && a.dropBars >= 8) return snapToPhrase(a.dropBars);
  const drops = getMixPoints(track).filter((p) => p.role === "drop");
  if (!drops.length) return findDropBars(track);
  return drops.reduce((best, p) => (p.energy > best.energy ? p : best)).phraseBars;
}

/** Low after the hook — not a breakdown glued to the first build. */
export function findHoleBars(track: Track): number | null {
  const a = track.analysis;
  if (!a) return null;
  const peak = findPeakDropBars(track) ?? findDropBars(track) ?? 0;

  const breakdown = a.sections.find(
    (s) => s.label === "breakdown" && s.startBars >= peak + 4,
  );
  if (breakdown) return snapToPhrase(breakdown.startBars);

  const outro = a.sections.find((s) => s.label === "outro" && s.startBars >= peak);
  if (outro) return snapToPhrase(outro.startBars);

  if (a.energy.length && a.durationBars > peak + 8) {
    const start = peak + 4;
    const end = Math.min(a.durationBars - 4, peak + 24);
    let bestBar = start;
    let bestE = Infinity;
    for (let i = 0; i < a.energy.length; i++) {
      const bar = (i / Math.max(1, a.energy.length - 1)) * a.durationBars;
      if (bar < start || bar > end) continue;
      const e = a.energy[i]!;
      if (e < bestE) {
        bestE = e;
        bestBar = bar;
      }
    }
    if (bestE < 0.55) return snapToPhrase(bestBar);
  }

  if (peak > 0 && peak + 8 < a.durationBars) return snapToPhrase(peak + 8);
  return null;
}

/**
 * 16–32 bar play window on the heat/drop — never a radio intro.
 * up = 16 bars of build into the drop; down = hole/reset; drop = the hook.
 */
export function chopWindow(track: Track, slot: ClipSlot = "drop"): { inBars: number; outBars: number } {
  const a = track.analysis;
  if (!a) return { inBars: 0, outBars: 32 };
  const dur = Math.max(8, a.durationBars);
  const drop = findPeakDropBars(track) ?? findDropBars(track);
  const heatIn = a.heatInBars != null ? snapToPhrase(a.heatInBars) : null;
  const heatOut = a.heatOutBars != null ? snapToPhrase(a.heatOutBars) : null;
  const hole = findHoleBars(track);

  let inBars: number;
  let want = 16;
  if (slot === "down") {
    inBars = hole ?? (drop != null ? snapToPhrase(Math.min(dur - 16, drop + 16)) : heatIn ?? 0);
    want = 16;
  } else if (slot === "up" && drop != null && drop >= 16) {
    inBars = snapToPhrase(Math.max(0, drop - 16));
    want = 16;
  } else if (heatIn != null && heatOut != null && heatOut - heatIn >= 8) {
    inBars = heatIn;
    want = Math.min(32, Math.max(16, heatOut - heatIn));
  } else if (drop != null) {
    inBars = drop;
    want = Math.min(32, Math.max(16, dur - drop));
  } else {
    inBars = Math.min(Math.max(8, snapToPhrase(dur * 0.25)), Math.max(0, dur - 16));
    want = 16;
  }
  inBars = Math.max(0, Math.min(inBars, Math.max(0, dur - 8)));
  if (slot !== "down" && drop != null && drop >= 16 && inBars < 8) inBars = drop;
  // A clip of 8 bars is a stab, not a statement — drops ride at least 16.
  const outBars = Math.min(dur, Math.max(inBars + 16, inBars + want));
  return { inBars, outBars };
}

/** Leave through a hole; incoming from its drop/heat — never bar 0. */
export function alignEchoJoin(
  outgoing: Track,
  _incoming: Track,
  echoBars: number,
): { inBars: number; outBars: number } {
  const durOut = Math.max(8, outgoing.analysis?.durationBars ?? 32);
  const n = Math.max(2, echoBars);
  const hole = findHoleBars(outgoing);
  const peak = findPeakDropBars(outgoing);
  const holeStart = hole ?? (peak != null ? peak + 8 : snapToPhrase(durOut * 0.65));
  const outBars = Math.min(durOut, Math.max(n + 8, holeStart + n));
  const inDrop = findPeakDropBars(_incoming) ?? findDropBars(_incoming);
  const heat = _incoming.analysis?.heatInBars;
  const inBars =
    inDrop != null ? inDrop : heat != null ? snapToPhrase(heat) : chopWindow(_incoming, "drop").inBars;
  return { inBars, outBars };
}

export function isDropRecipe(recipe: string): boolean {
  return (
    recipe === "drop_swap" ||
    recipe === "build_cut" ||
    recipe === "double_drop" ||
    recipe === "power_cut" ||
    recipe === "air_cut" ||
    recipe === "tease_slam" ||
    recipe === "tempo_ride" ||
    recipe === "filter_sweep" ||
    recipe === "loop_roll"
  );
}

/** Park incoming 8 bars before its drop (the build). Leave after the line, then peel. */
export function alignDropJoin(
  outgoing: Track,
  incoming: Track,
  nBars: number,
  mode: "swap" | "cut",
): { inBars: number; outBars: number } {
  const durIn = Math.max(8, incoming.analysis?.durationBars ?? 32);
  const durOut = Math.max(8, outgoing.analysis?.durationBars ?? 32);
  const inDrop = findPeakDropBars(incoming) ?? findDropBars(incoming);
  const outDrop = findPeakDropBars(outgoing) ?? findDropBars(outgoing);
  const n = Math.max(1, nBars);
  const buildCue = 8;

  let inBars = 0;
  if (inDrop != null) {
    inBars =
      mode === "cut"
        ? Math.max(0, Math.min(inDrop, durIn - 1))
        : Math.max(0, Math.min(snapToPhrase(inDrop - buildCue), Math.max(0, durIn - buildCue)));
  }

  // Slam mode rides the drop phrase, THEN leaves (the crowd hears the payoff
  // and the next record hijacks the phrase boundary). Blend mode leaves at
  // the drop — the overlap IS the payoff there.
  const leaveTarget = outDrop != null ? outDrop + (mode === "cut" ? 16 : 0) : null;
  const leave =
    leaveTarget != null ? safeLeaveBars(outgoing, leaveTarget) : Math.min(durOut, Math.max(n + 8, durOut * 0.7));
  const peel = mode === "swap" ? Math.max(0, n - buildCue) : 0;
  // The peel extends past the safe leave — re-run it through safeLeaveBars so
  // the extension cannot walk the leave back INTO a vocal line (it should
  // finish the line, then peel: line_end + peel, or back before the line).
  let outBars =
    outDrop != null
      ? Math.max(n, Math.min(safeLeaveBars(outgoing, leave + peel), durOut))
      : Math.max(n, Math.min(leave + peel, durOut));
  if (outDrop == null && outBars <= 8) {
    outBars = Math.min(durOut, Math.max(16, n + 8));
  }
  return { inBars, outBars };
}

/**
 * Tease slam parking: the incoming enters `bars` before its drop, so its
 * BUILD is what bleeds under the outgoing and the drop lands exactly on the
 * commit (setStart + bars = prev.setEnd). The outgoing rides its own drop
 * phrase and leaves at a safe boundary — same parking as a slam cut.
 */
export function alignTeaseJoin(
  outgoing: Track,
  incoming: Track,
  bars: number,
): { inBars: number; outBars: number } {
  const durIn = Math.max(8, incoming.analysis?.durationBars ?? 32);
  const n = Math.max(4, bars);
  const inDrop = findPeakDropBars(incoming) ?? findDropBars(incoming);
  const inBars =
    inDrop != null
      ? Math.max(0, Math.min(snapToPhrase(inDrop - n), Math.max(0, durIn - n - 4)))
      : chopWindow(incoming, "drop").inBars;
  const cut = alignDropJoin(outgoing, incoming, n, "cut");
  return { inBars, outBars: cut.outBars };
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

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

function arcEnergyTargets(levels: number[], arc: SetArcId, style: ComposeStyle = "chop"): number[] {
  const n = levels.length;
  const floor = Math.min(...levels);
  const peak = Math.max(...levels);
  if (style === "chop" && n >= 4) {
    const mid = Math.floor(n / 2);
    const t: number[] = [];
    for (let k = 0; k < n; k++) {
      if (k === 0) t.push(floor + (peak - floor) * 0.45);
      else if (k === mid) t.push(floor + (peak - floor) * 0.25);
      else if (k === n - 1) t.push(peak);
      else t.push(peak - (peak - floor) * 0.08);
    }
    return t;
  }
  const t: number[] = [];
  for (let k = 0; k < n; k++) {
    const f = n <= 1 ? 0 : k / (n - 1);
    if (arc === "cool_down") t.push(peak - (peak - floor) * f);
    else if (arc === "peak_time") t.push(peak - (peak - floor) * 0.1 * (1 - f));
    else if (arc === "chill") t.push(floor + (peak - floor) * 0.25 * f);
    else t.push(floor + 1 + (peak - floor - 1) * Math.min(1, f * 1.15));
  }
  return t;
}

function stratifiedPool(pool: Track[], max: number): Track[] {
  if (pool.length <= max) return pool;
  const sorted = [...pool].sort(
    (a, b) => (deriveEnergyLevel(a) ?? 5) - (deriveEnergyLevel(b) ?? 5),
  );
  const step = sorted.length / max;
  const out: Track[] = [];
  for (let i = 0; i < max; i++) {
    out.push(sorted[Math.min(sorted.length - 1, Math.floor(i * step))]!);
  }
  return out;
}

/**
 * Order the set as a path problem. Chop grammar: slams are the default
 * (cheap); blends cost. Blend grammar inverts that. Energy arc is a soft
 * constraint; RESET sits mid-set when n≥4 chop.
 */
function optimizeOrder(
  pool: Track[],
  arc: SetArcId,
  n: number,
  style: ComposeStyle = "chop",
): { sequence: Track[]; blends: number; slams: number } | null {
  const m = pool.length;
  if (m < 2 || m > 14 || n < 2 || n > m) return null;
  const pickCache = new Map<string, JoinPick>();
  const pickOf = (a: Track, b: Track): JoinPick => {
    const k = `${a.id}>${b.id}`;
    let p = pickCache.get(k);
    if (!p) {
      p = chooseJoinFromRecords(a, b, style);
      pickCache.set(k, p);
    }
    return p;
  };
  const levels = pool.map((t) => deriveEnergyLevel(t) ?? 5);
  const targets = arcEnergyTargets(levels, arc, style);
  const floor = Math.min(...levels);
  const peakE = Math.max(...levels);
  const SLAM_COST = style === "chop" ? 4 : 34;
  const BLEND_COST = style === "chop" ? 36 : 0;
  const edge = (a: number, b: number, pos: number): number => {
    const pick = pickOf(pool[a]!, pool[b]!);
    const slam = isSlamRecipe(pick.recipe) || isChopJoin(pick.recipe);
    let c = slam ? SLAM_COST : BLEND_COST;
    if (style !== "chop" && c > 0 && (pos === 1 || pos === n - 1)) c *= 0.35;
    c += Math.abs(levels[b]! - (targets[pos] ?? levels[b]!)) * 2.4;
    if (style === "chop" && n >= 4 && pos === Math.floor(n / 2)) {
      c += Math.max(0, levels[b]! - (floor + (peakE - floor) * 0.3)) * 3;
    }
    c += Math.max(0, 100 - scorePair(pool[a]!, pool[b]!).score) * 0.1;
    return c;
  };

  const size = 1 << m;
  const dp = new Float64Array(size * m).fill(Infinity);
  const parent = new Int16Array(size * m).fill(-1);
  for (let i = 0; i < m; i++) dp[(1 << i) * m + i] = 0;
  for (let mask = 1; mask < size; mask++) {
    const bits = popcount(mask);
    if (bits >= n) continue;
    for (let last = 0; last < m; last++) {
      if (!(mask & (1 << last))) continue;
      const cur = dp[mask * m + last];
      if (!Number.isFinite(cur)) continue;
      for (let next = 0; next < m; next++) {
        if (mask & (1 << next)) continue;
        const cost = cur + edge(last, next, bits);
        const idx = (mask | (1 << next)) * m + next;
        if (cost < dp[idx]!) {
          dp[idx] = cost;
          parent[idx] = last;
        }
      }
    }
  }

  let best = Infinity;
  let bestMask = -1;
  let bestLast = -1;
  for (let mask = 1; mask < size; mask++) {
    if (popcount(mask) !== n) continue;
    for (let last = 0; last < m; last++) {
      if (!(mask & (1 << last))) continue;
      const v = dp[mask * m + last]!;
      if (v < best) {
        best = v;
        bestMask = mask;
        bestLast = last;
      }
    }
  }
  if (bestMask < 0) return null;

  const idx: number[] = [];
  let mask = bestMask;
  let last = bestLast;
  while (last >= 0) {
    idx.push(last);
    const p = parent[mask * m + last]!;
    mask &= ~(1 << last);
    last = p;
  }
  idx.reverse();
  const sequence = idx.map((i) => pool[i]!);
  let blends = 0;
  let slams = 0;
  for (let k = 1; k < sequence.length; k++) {
    if (isSlamRecipe(pickOf(sequence[k - 1]!, sequence[k]!).recipe)) slams++;
    else blends++;
  }
  return { sequence, blends, slams };
}

export function planSetArc(
  doc: SetDoc,
  arc: SetArcId,
  trackCount?: number,
  style: ComposeStyle = "chop",
): {
  arc: SetArcId;
  reason: string;
  via: "path-dp" | "energy-ladder";
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
    return { arc, reason: "Need at least 2 analyzed tracks.", via: "energy-ladder", entries: [] };
  }

  const ranked = [...pool].sort((a, b) => (deriveEnergyLevel(b) ?? 0) - (deriveEnergyLevel(a) ?? 0));
  const peak = ranked[0]!;
  const peakE = deriveEnergyLevel(peak) ?? 7;

  const pick = (pred: (t: Track) => boolean, exclude: Set<string>) =>
    ranked.find((t) => !exclude.has(t.id) && pred(t));

  let used = new Set<string>();
  let sequence: Track[] = [];
  let via: "path-dp" | "energy-ladder" = "energy-ladder";

  // Path-DP first: order by what the joins actually compile to, with slams
  // reserved for earned boundary positions.
  if (arc !== "power_block") {
    const working = stratifiedPool(pool, 14);
    const opt = optimizeOrder(working, arc, Math.min(n, working.length), style);
    if (opt && opt.sequence.length >= 2) {
      sequence = opt.sequence;
      used = new Set(sequence.map((t) => t.id));
      via = "path-dp";
    }
  }

  if (sequence.length < 2) {
    // Greedy energy ladder — fallback when the DP couldn't run.
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
  }

  while (sequence.length < n) {
    const extra = ranked.find((t) => !used.has(t.id));
    if (!extra) break;
    sequence.push(extra);
    used.add(extra.id);
  }

  const entries = sequence.map((t, i) => {
    const role = trackRole(t);
    const slot = clipSlot(i, sequence.length, style);
    const win = style === "chop" ? chopWindow(t, slot) : pickMixWindow(t, role);
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

  let blends = 0;
  let slams = 0;
  for (let k = 1; k < sequence.length; k++) {
    if (isSlamRecipe(chooseJoinFromRecords(sequence[k - 1]!, sequence[k]!, style).recipe)) slams++;
    else blends++;
  }

  return {
    arc,
    via,
    reason:
      style === "chop"
        ? `Chop formula INTRO→UP+→DROP→[DOWN]→DROP+→OUTRO (${slams} slam${slams === 1 ? "" : "s"}, ${blends} blend${blends === 1 ? "" : "s"}). 16–32 bar heat clips, never intros.`
        : via === "path-dp"
          ? `Order optimized as a mixability path (${blends} blendable join${blends === 1 ? "" : "s"}, ${slams} slam${slams === 1 ? "" : "s"} placed at earned boundaries). Joins unset (1-bar cut placeholder) — pick replace / stack / cut / blend from drop cues.`
          : `Order for ${arc} from peak "${peak.title}" (E${peakE}). Joins unset (1-bar cut placeholder) — pick replace / stack / cut / blend from drop cues.`,
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
    const win = chopWindow(track, "drop");
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

/**
 * Park a blend so the overlap sits on the outgoing's tonal hole (breakdown /
 * drum run) under the incoming's build — the way pros blend "clashing"
 * records: the two harmonies never co-occur, so the label clash mostly
 * cannot happen. Returns null when the outgoing has no usable hole.
 */
export function alignBlendJoin(
  outgoing: Track,
  incoming: Track,
  bars: number,
): { inBars: number; outBars: number; holeStart: number } | null {
  const outA = outgoing.analysis;
  const inA = incoming.analysis;
  if (!outA || !inA) return null;
  const durOut = Math.max(8, outA.durationBars);
  const durIn = Math.max(8, inA.durationBars);
  const hole = findHoleBars(outgoing);
  if (hole == null) return null;

  // Don't let the overlap run past the hole section's real length.
  const holeSec = outA.sections.find(
    (s) => s.label === "breakdown" && Math.abs(s.startBars - hole) <= 2,
  );
  const holeEnd = holeSec ? holeSec.endBars : hole + 16;
  const n = Math.max(4, Math.min(bars, Math.max(4, Math.floor(holeEnd - hole))));

  let outBars = hole + n;
  if (vocalCovers(outgoing, outBars)) outBars = safeLeaveBars(outgoing, outBars);
  outBars = Math.min(durOut, Math.max(n + 8, Math.round(outBars)));
  if (!holeParkedAt(outgoing, outBars, n)) return null;

  // Incoming enters at its mix-in (end of intro / breakdown end) and builds
  // through the hole; one bass open at a time is the compile's job.
  const mixIn =
    getMixPoints(incoming).find((p) => p.role === "mix_in" && p.phraseBars > 0)
      ?.phraseBars ?? 0;
  const inBars = Math.max(
    0,
    Math.min(snapToPhrase(mixIn), Math.max(0, durIn - n - 8)),
  );
  return { inBars, outBars, holeStart: hole };
}

export type JoinPick = {
  recipe: TransitionRecipe;
  bars: number;
  reason: string;
  /** "hole" = park the overlap on the outgoing's tonal hole (blend recipes). */
  park?: "hole";
};

export function isSlamRecipe(recipe: string): boolean {
  return (
    recipe === "tease_slam" ||
    recipe === "power_cut" ||
    recipe === "air_cut" ||
    recipe === "backspin" ||
    recipe === "echo_out" ||
    recipe === "half_bridge" ||
    recipe === "power_block"
  );
}

/** Facts about these two files — not a genre script. */
export function chooseJoinFromRecords(
  outgoing: Track,
  incoming: Track,
  style: ComposeStyle = "chop",
): JoinPick {
  if (style === "blend") return chooseJoinBlend(outgoing, incoming);
  return chooseJoinChop(outgoing, incoming);
}

function chooseJoinChop(outgoing: Track, incoming: Track): JoinPick {
  const outA = outgoing.analysis;
  const inA = incoming.analysis;
  if (!outA || !inA) {
    return { recipe: "power_cut", bars: 1, reason: "Missing analysis — cut." };
  }
  const inDrop = findPeakDropBars(incoming) ?? findDropBars(incoming);
  const rel = tempoRelation(outA.bpm, inA.bpm);

  // 2:1 clocks cannot share a tease — the air slam survives for these.
  if (rel === "half" || rel === "double") {
    if (inDrop != null && inDrop >= 8) {
      return {
        recipe: "air_cut",
        bars: 2,
        reason: `${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)} ${rel} — 2:1 clocks can't tease; air-slam onto the drop at ${inDrop}.`,
      };
    }
    return {
      recipe: "power_cut",
      bars: 1,
      reason: `${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)} ${rel} — cut.`,
    };
  }

  // Past ~20% the ride is chipmunk territory even under keylock — air-slam.
  const pct = Math.abs(inA.bpm - outA.bpm) / Math.max(1, outA.bpm);
  if (rel === "far" && pct > 0.2) {
    if (inDrop != null && inDrop >= 8) {
      return {
        recipe: "air_cut",
        bars: 2,
        reason: `${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)} (+${(pct * 100).toFixed(0)}%) is past the ridable 20% — air-slam onto the drop at ${inDrop}. No shared clock.`,
      };
    }
    return {
      recipe: "power_cut",
      bars: 1,
      reason: `${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)} (+${(pct * 100).toFixed(0)}%) — cut.`,
    };
  }

  // Default: TAKE the outgoing record into the incoming one. The build of
  // the next track bleeds in filtered under the current one, the tempo lane
  // rides the gap, the roll + throw fire, and the slam lands on the drop.
  if (inDrop != null && inDrop >= 20) {
    return {
      recipe: "tease_slam",
      bars: 16,
      reason:
        `16-bar tease: incoming build (drop at ${inDrop}) bleeds in filtered under the outgoing` +
        (pct > 0.03
          ? `, tempo rides ${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)} across the window,`
          : "") +
        `, roll + throw, slam on the 1.`,
    };
  }
  if (inDrop != null && inDrop >= 12) {
    return {
      recipe: "tease_slam",
      bars: 8,
      reason: `Short tease (drop at ${inDrop}) — 8-bar filtered bleed, slam on the 1.`,
    };
  }
  return {
    recipe: "loop_roll",
    bars: 4,
    reason:
      inDrop != null
        ? `Drop at ${inDrop} too close to the top for a tease — roll then cut.`
        : "No pictured incoming drop — roll then cut on the heat window.",
  };
}

/** Blend grammar — Zehren-style hole parks, isolator replaces, tempo rides. */
function chooseJoinBlend(outgoing: Track, incoming: Track): JoinPick {
  const outA = outgoing.analysis;
  const inA = incoming.analysis;
  if (!outA || !inA) {
    return { recipe: "power_cut", bars: 1, reason: "Missing analysis — cut." };
  }

  const outDrop = findPeakDropBars(outgoing) ?? findDropBars(outgoing);
  const inDrop = findPeakDropBars(incoming) ?? findDropBars(incoming);
  const hole = findHoleBars(outgoing);
  const rel = tempoRelation(outA.bpm, inA.bpm);
  const move = classifyCamelotMove(outA.key.camelot, inA.key.camelot);
  const twoVocals = trackVocalLead(outgoing) && trackVocalLead(incoming);
  const eOut = deriveEnergyLevel(outgoing) ?? 5;
  const eIn = deriveEnergyLevel(incoming) ?? 5;
  const lift = eIn - eOut;
  const inHasDrop = inDrop != null && inDrop >= 8;
  const outHasDrop = outDrop != null;
  const canCue16 = inDrop != null && inDrop >= 16;
  const canCue8 = inDrop != null && inDrop >= 8;
  const trusted = keyIsTrusted(outgoing) && keyIsTrusted(incoming);
  const padCap = padOverlapCap(move, trusted);
  const isoCap = isolatorOverlapCap(move);
  const safeKey =
    move === "same" || move === "adjacent" || move === "relative" || move === "energy_boost";
  const inBuild = inA.sections.some(
    (s) => s.label === "build" && (inDrop == null || s.endBars <= inDrop + 1),
  );

  if (rel === "half" || rel === "double") {
    return {
      recipe: "half_bridge",
      bars: 8,
      reason: `${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)} is ${rel} — echo-shaped exit + tempo snap.`,
    };
  }

  // 6–10% gaps are ridable: ramp both decks under keylock across a 16-bar
  // isolator overlap instead of throwing the set away to a slam.
  const ridePct = Math.abs(inA.bpm - outA.bpm) / Math.max(1, outA.bpm);
  const rideable =
    rel === "far" &&
    ridePct > 0.06 &&
    ridePct <= 0.1 &&
    move !== "clash" &&
    move !== "jaws" &&
    move !== "pay_attention" &&
    inHasDrop &&
    canCue16 &&
    isoCap >= 16;
  if (rideable) {
    return {
      recipe: "tempo_ride",
      bars: 16,
      reason: `${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)} (+${(ridePct * 100).toFixed(1)}%) is ridable — ramp both decks under keylock across a 16-bar isolator, commit on the incoming drop at ${inDrop}.`,
    };
  }

  if (rel === "far") {
    // Far BPM is where show moves live — make a virtue of the gap.
    if (hole != null) {
      return {
        recipe: "echo_out",
        bars: 8,
        reason: `BPM too far to share a 1 (${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)}) — echo-throw through the hole at ${hole}, then the next record from bar 0 at its own tempo.`,
      };
    }
    if (inHasDrop) {
      return {
        recipe: "air_cut",
        bars: 2,
        reason: `BPM too far to share a 1 (${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)}) — suck-out, one bar of dead air, slam the incoming drop at ${inDrop}. No shared clock.`,
      };
    }
    return {
      recipe: "echo_out",
      bars: 8,
      reason: `BPM too far to share a 1 (${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)}) — echo-throw leave, incoming from bar 0 at its own tempo.`,
    };
  }

  if (move === "clash" || move === "jaws") {
    // Same-clock label clash: try a hole-parked blend first — the overlap
    // sits on the outgoing's breakdown under the incoming's build, so the
    // two harmonies never co-occur. The stored chroma gets the final word.
    if (hole != null) {
      const parked = alignBlendJoin(outgoing, incoming, 8);
      if (parked) {
        const audition = auditionHarmony(
          outgoing,
          parked.outBars - 8,
          parked.outBars,
          incoming,
          parked.inBars,
          parked.inBars + 8,
        );
        if (audition.verdict === "blend_ok" || audition.verdict === "bass_only") {
          return {
            recipe: "bass_swap",
            bars: 8,
            reason: `${outA.key.camelot}→${inA.key.camelot} ${move} by label, but the audio auditions ${audition.verdict} (dissonance ${audition.score}) — hole-parked on ${parked.holeStart} under the incoming build: one harmony at a time, bass swap mid-window.`,
            park: "hole",
          };
        }
        // Measured clash — fall through to the slam, now earned by evidence.
      }
    }
    if (inHasDrop) {
      return {
        recipe: "air_cut",
        bars: 2,
        reason: `${outA.key.camelot}→${inA.key.camelot} ${move} — no shared clock: suck-out, dead air, slam the incoming drop at ${inDrop}.`,
      };
    }
    return {
      recipe: hole != null ? "echo_out" : "power_cut",
      bars: hole != null ? 8 : 1,
      reason: `${move} ${outA.key.camelot}→${inA.key.camelot} — do not pad-blend.`,
    };
  }

  if (twoVocals && inHasDrop && outHasDrop) {
    const bars = canCue8 && isoCap >= 8 ? Math.min(isoCap, trusted ? 16 : 8) : 1;
    if (bars >= 8) {
      return {
        recipe: "drop_swap",
        bars,
        reason: `Both files carry vocals — isolator drop-swap ${bars} (build under the line, peel after the 1).`,
      };
    }
    return {
      recipe: "power_cut",
      bars: 1,
      reason: `${move} cannot share a clock — cut on the incoming 1.`,
    };
  }
  if (twoVocals) {
    if (padCap >= 8) {
      return {
        recipe: "eq_swap",
        bars: 8,
        reason: "Two vocal leads — mid handoff, not a long pad.",
      };
    }
    return {
      recipe: "power_cut",
      bars: 1,
      reason: "Two vocal leads without a drop to swap — cut.",
    };
  }

  if (trackVocalLead(incoming) && !trackVocalLead(outgoing) && hole != null) {
    if (padCap >= 8) {
      return {
        recipe: "hook_layer",
        bars: Math.min(12, padCap),
        reason: `Incoming vocal over outgoing hole at ${hole}.`,
      };
    }
  }

  if (inHasDrop && outHasDrop && Math.abs(lift) <= 1 && canCue16 && padCap >= 16) {
    return {
      recipe: "double_drop",
      bars: 16,
      reason: `Both drops (${outDrop} / ${inDrop}), energy ${eOut}→${eIn} — stack the 1.`,
    };
  }

  if (inHasDrop && (outHasDrop || hole != null) && lift >= 0) {
    const n = canCue8 && isoCap >= 8 ? Math.min(isoCap, trusted ? 16 : 8) : 1;
    if (n >= 8) {
      return {
        recipe: "drop_swap",
        bars: n,
        reason: hole != null && !outHasDrop
          ? `Incoming drop ${inDrop}; leave through outgoing hole ${hole}.`
          : `Drop-swap: incoming build into ${inDrop}, leave after the line (${n} bar ${move}).`,
      };
    }
    return {
      recipe: "power_cut",
      bars: 1,
      reason: `${move} cannot share a clock — cut on the incoming 1.`,
    };
  }

  if (inHasDrop && inBuild && canCue8 && isoCap >= 8) {
    return {
      recipe: "filter_sweep",
      bars: Math.min(isoCap, trusted ? 16 : 8),
      reason: "Incoming has a build into its drop — tension then the 1.",
    };
  }

  if (inHasDrop && !outHasDrop) {
    return {
      recipe: "power_cut",
      bars: 1,
      reason: `Incoming drop at ${inDrop}; outgoing has no pictured drop to swap.`,
    };
  }

  if (!inHasDrop && !twoVocals && safeKey && padCap >= 8) {
    return {
      recipe: "bass_swap",
      bars: 8,
      reason: `${outA.key.camelot}→${inA.key.camelot} ${move}, no incoming drop — one-bass blend.`,
    };
  }

  return {
    recipe: inHasDrop && isoCap >= 8 && canCue8 ? "drop_swap" : "power_cut",
    bars: inHasDrop && isoCap >= 8 && canCue8 ? Math.min(isoCap, trusted ? 16 : 8) : 1,
    reason: inHasDrop
      ? "Default from these two files: drop replace if harmony allows, else cut."
      : "No incoming drop — cut.",
  };
}

export function joinFallbacks(
  first: JoinPick,
  outgoing: Track,
  incoming: Track,
  style: ComposeStyle = "chop",
): JoinPick[] {
  const list: JoinPick[] = [first];
  const add = (recipe: TransitionRecipe, bars: number, reason: string, park?: "hole") => {
    if (!list.some((x) => x.recipe === recipe && x.bars === bars)) {
      list.push({ recipe, bars, reason, park });
    }
  };
  const blendFirst =
    style === "blend" ||
    first.recipe === "drop_swap" ||
    first.recipe === "bass_swap" ||
    first.recipe === "eq_swap" ||
    first.recipe === "tempo_ride" ||
    first.recipe === "echo_out" ||
    first.recipe === "half_bridge" ||
    first.recipe === "filter_sweep" ||
    first.recipe === "double_drop" ||
    first.recipe === "hook_layer";
  if (!blendFirst) {
    add("tease_slam", 16, "retry: full tease into the slam");
    add("tease_slam", 8, "retry: shorter tease");
    add("loop_roll", 4, "retry: roll then cut");
    add("power_cut", 1, "retry: cut on the 1");
    return list.slice(0, 4);
  }
  const outA = outgoing.analysis;
  const inA = incoming.analysis;
  const rel =
    outA && inA ? tempoRelation(outA.bpm, inA.bpm) : "far";
  if (rel === "far" || first.recipe === "echo_out" || first.recipe === "half_bridge" || first.recipe === "air_cut") {
    if (findDropBars(incoming) != null) {
      const rideMove =
        outA && inA
          ? classifyCamelotMove(outA.key.camelot, inA.key.camelot)
          : "clash";
      const ridePct =
        outA && inA
          ? Math.abs(inA.bpm - outA.bpm) / Math.max(1, outA.bpm)
          : 1;
      const rideIsoCap = isolatorOverlapCap(rideMove);
      if (
        ridePct > 0.06 &&
        ridePct <= 0.1 &&
        rideIsoCap >= 16 &&
        rideMove !== "pay_attention"
      ) {
        add("tempo_ride", 16, "retry: ride the gap under keylock");
      }
      add("air_cut", 2, "retry: dead-air slam onto the drop");
      add("backspin", 1, "retry: rewind slam onto the drop");
    }
    add("echo_out", 8, "retry: echo-throw leave, own clocks");
    add("echo_out", 4, "retry: shorter throw");
    return list.slice(0, 4);
  }
  const move =
    outA && inA
      ? classifyCamelotMove(outA.key.camelot, inA.key.camelot)
      : "clash";
  const isoCap = isolatorOverlapCap(move);
  const trusted =
    Boolean(outA && inA) && keyIsTrusted(outgoing) && keyIsTrusted(incoming);
  const padCap = padOverlapCap(move, trusted);
  if (isoCap >= 8 && findDropBars(incoming) != null) {
    add("drop_swap", 8, "retry: shorter replace");
    add("drop_swap", 16, "retry: drop-swap with peel");
  }
  add("power_cut", 1, "retry: cut on the 1");
  add("backspin", 1, "retry: rewind slam");
  if (findHoleBars(outgoing) != null) {
    add("bass_swap", 8, "retry: hole-parked blend — outgoing harmony sits out", "hole");
    add("echo_out", 8, "retry: echo-throw through the hole");
  }
  if (padCap >= 8 && trackVocalLead(outgoing) && trackVocalLead(incoming)) {
    add("eq_swap", 8, "retry: mid handoff");
  }
  if (padCap >= 8) add("bass_swap", 8, "retry: one-bass blend");
  return list.slice(0, 6);
}

export type JoinCompileReport = {
  index: number;
  transition: { type: TransitionType; bars: number };
  /** Set-timeline bars where the overlap (or echo leave window) starts. */
  overlap_start_bars: number;
  overlap_end_bars: number;
  /** Set bars where the audible swap begins (first xfader commit lane). */
  commit_bars: number | null;
  /** Set bars where the swap completes (last xfader lane end). */
  commit_complete_bars: number | null;
  /** Where the incoming track's peak drop lands on the set clock. */
  incoming_drop_bars: number | null;
  /** True when the swap completes on the incoming drop's 1 (±1.25 bars). */
  commit_on_drop: boolean | null;
  compiled_lanes: number;
};

/**
 * What the compiler actually did to a join — echo this back on every mutation
 * so narration and doc can never silently disagree. For drop recipes the
 * audible swap (bass swap + xfader commit lane) begins on the incoming drop's
 * 1; commit_on_drop:false means the cue math and the recipe shape have
 * drifted (e.g. in_bars parked so the drop lands nowhere near the commit).
 */
export function joinCompileReport(doc: SetDoc, index: number): JoinCompileReport | null {
  const spans = buildTimeline(doc);
  const span = spans[index];
  const prev = spans[index - 1];
  if (!span || !prev || index < 1) return null;
  const start = span.setStart;
  const end = Math.min(span.setStart + span.overlapBars, prev.setEnd);
  const windowEnd = Math.max(end, prev.setEnd);
  const lanes = compileTransitionAutomation(doc).filter(
    (l) => l.endBars >= start - 1e-6 && l.startBars <= windowEnd + 1e-6,
  );
  const isEcho = span.entry.transition.type === "echo_out";
  // Hold lanes (xfOut→xfOut) park the fader; the swap lane is the audible
  // commit. Tease/drift lanes move the xfader OFF the outgoing rail long
  // before the slam — the commit is the lane that lands on the INCOMING side.
  // The endcap keeps the NEXT join's drift lanes (which start at this join's
  // boundary) out of this join's commit.
  const xfIn = prev.deck === "A" ? 1 : -1;
  const xfLanes = lanes.filter(
    (l) =>
      l.param === "xfader" &&
      l.startBars >= start - 1e-6 &&
      l.endBars <= windowEnd + 0.5 &&
      Math.abs(l.startValue - l.endValue) > 0.5 &&
      l.endValue !== 0 &&
      Math.sign(l.endValue) === Math.sign(xfIn),
  );
  const commitBars = xfLanes.length
    ? Math.min(...xfLanes.map((l) => l.startBars))
    : null;
  const commitComplete = xfLanes.length
    ? Math.max(...xfLanes.map((l) => l.endBars))
    : null;
  const track = doc.tracks[span.entry.trackId];
  const inDrop = track ? (findPeakDropBars(track) ?? findDropBars(track)) : null;
  const incomingDropSetBars =
    inDrop != null ? start + (inDrop - span.entry.inBars) : null;
  const commitOnDrop =
    !isEcho && commitBars != null && incomingDropSetBars != null
      ? Math.abs(commitBars - incomingDropSetBars) <= 1.25
      : null;
  return {
    index,
    transition: span.entry.transition,
    overlap_start_bars: Number(start.toFixed(2)),
    overlap_end_bars: Number(end.toFixed(2)),
    commit_bars:
      !isEcho && commitBars != null ? Number(commitBars.toFixed(2)) : null,
    commit_complete_bars:
      !isEcho && commitComplete != null ? Number(commitComplete.toFixed(2)) : null,
    incoming_drop_bars:
      incomingDropSetBars != null ? Number(incomingDropSetBars.toFixed(2)) : null,
    commit_on_drop: commitOnDrop,
    compiled_lanes: lanes.length,
  };
}
