import type { TransitionRecipe } from "../agent/djPlaybook";
import { analysisNeedsRefresh } from "../analysis/stale";
import type {
  ArrangementEntry,
  AutomationLane,
  SetDoc,
  Track,
  TrackMood,
  TrackRole,
  TransitionType,
} from "../types/setdoc";
import {
  applyRecipeBars,
  classifyCamelotMove,
  deriveEnergyLevel,
  snapToPhrase,
  verifySet,
  type VerifyResult,
} from "./builder";
import {
  alignDropJoin,
  crateHealth,
  findDropBars,
  findHoleBars,
  isDropRecipe,
  planSetArc,
  tempoRelation,
  trackGenre,
  trackMood,
  trackRole,
  trackVocalLead,
  type SetArcId,
} from "./craft";
import { previewJoin, type JoinListen } from "./previewJoin";
import { buildTimeline } from "./timeline";

export type CrateCard = {
  track_id: string;
  title: string;
  artist: string;
  bpm: number | null;
  camelot: string | null;
  key_name: string | null;
  energy_level: number | null;
  role: TrackRole | null;
  mood: TrackMood | null;
  genre: string | null;
  vocal_lead: boolean;
  drop_bars: number | null;
  hole_bars: number | null;
  cue_before_drop_8: number | null;
  cue_before_drop_16: number | null;
  duration_bars: number | null;
  stale: boolean;
};

export type JoinPick = {
  recipe: TransitionRecipe;
  bars: number;
  reason: string;
};

export type PreparedJoin = JoinPick & {
  index: number;
  outgoing: string;
  incoming: string;
  retries: number;
  verdict: JoinListen["verdict"] | "skipped";
  notes: string[];
};

export type PrepareSetResult = {
  intent: string | null;
  inferred: { arc: SetArcId; reason: string; track_count: number };
  cards: CrateCard[];
  entries: Array<{
    track_id: string;
    title: string;
    in_bars: number;
    out_bars: number;
    transition: TransitionType;
    bars: number;
    recipe: string;
  }>;
  joins: PreparedJoin[];
  verify: VerifyResult;
  applied: boolean;
  proposed: boolean;
};

export function crateCard(track: Track): CrateCard {
  const a = track.analysis;
  const drop = findDropBars(track);
  const hole = findHoleBars(track);
  const dur = a?.durationBars ?? null;
  const cue = (n: number) =>
    drop == null || dur == null
      ? null
      : Math.max(0, Math.min(snapToPhrase(drop - n), Math.max(0, dur - n)));
  return {
    track_id: track.id,
    title: track.title,
    artist: track.artist,
    bpm: a?.bpm ?? null,
    camelot: a?.key.camelot ?? null,
    key_name: a?.key.name ?? null,
    energy_level: deriveEnergyLevel(track),
    role: trackRole(track),
    mood: trackMood(track),
    genre: trackGenre(track),
    vocal_lead: trackVocalLead(track),
    drop_bars: drop,
    hole_bars: hole,
    cue_before_drop_8: cue(8),
    cue_before_drop_16: cue(16),
    duration_bars: dur != null ? Number(dur.toFixed(2)) : null,
    stale: analysisNeedsRefresh(a),
  };
}

export function crateCards(doc: SetDoc): CrateCard[] {
  return Object.values(doc.tracks)
    .filter((t) => t.analysis)
    .map(crateCard)
    .sort((a, b) => a.title.localeCompare(b.title));
}

function minutesFromIntent(intent: string): number | null {
  const m = /(\d+)\s*(m|min|mins|minute|minutes)\b/i.exec(intent);
  return m ? Number(m[1]) : null;
}

export function inferNight(
  doc: SetDoc,
  intent?: string,
  trackCount?: number,
): { arc: SetArcId; reason: string; track_count: number } {
  const pool = Object.values(doc.tracks).filter((t) => t.analysis);
  const health = crateHealth(doc);
  const levels = pool
    .map((t) => deriveEnergyLevel(t))
    .filter((n): n is number => n != null);
  const peak = levels.length ? Math.max(...levels) : 6;
  const floor = levels.length ? Math.min(...levels) : 4;
  const spread = peak - floor;
  const mean = levels.length ? levels.reduce((s, n) => s + n, 0) / levels.length : 5;
  const lanes = Object.keys(health.bpmLanes);
  const minutes = intent ? minutesFromIntent(intent) : null;
  const fromMinutes =
    minutes != null ? Math.max(2, Math.min(pool.length, Math.round(minutes / 4))) : undefined;
  const n = Math.max(
    2,
    Math.min(trackCount ?? fromMinutes ?? Math.min(6, pool.length), pool.length),
  );

  const text = (intent ?? "").trim().toLowerCase();
  const named = ((): SetArcId | null => {
    if (!text) return null;
    if (/\bpower[_\s-]?block\b/.test(text)) return "power_block";
    if (/\b(chill|ambient|downtempo|late)\b/.test(text)) return "chill";
    if (/\b(cool[_\s-]?down|wind[_\s-]?down|close)\b/.test(text)) return "cool_down";
    if (/\b(warm[_\s-]?up|opener|open)\b/.test(text)) return "warm_up";
    if (/\b(peak|prime|weapon|peak[_\s-]?time)\b/.test(text)) return "peak_time";
    if (/\b(journey|night|set)\b/.test(text)) return "journey";
    return null;
  })();

  if (named) {
    return {
      arc: named,
      reason: `Intent “${intent!.trim()}” → ${named}.`,
      track_count: n,
    };
  }

  let arc: SetArcId = "journey";
  let reason = `Crate infers journey (E${floor}–${peak}, ${lanes.join("/") || "mixed"}).`;
  if (spread <= 1 && mean >= 7) {
    arc = "peak_time";
    reason = `Crate is already hot (mean E${mean.toFixed(1)}) — peak-time order.`;
  } else if (spread <= 1 && mean <= 4.5) {
    arc = "chill";
    reason = `Crate sits low (mean E${mean.toFixed(1)}) — chill order.`;
  } else if ((health.roles.opener ?? 0) === 0 && peak >= 8 && spread >= 3) {
    arc = "warm_up";
    reason = "No tagged opener and a real peak — warm-up climb.";
  } else if (lanes.length === 1 && (lanes[0] === "dnb" || lanes[0] === "hard")) {
    arc = "peak_time";
    reason = `Single ${lanes[0]} lane — peak-time block.`;
  }

  return { arc, reason, track_count: n };
}

/** Facts about these two files — not a genre script. */
export function chooseJoinFromRecords(outgoing: Track, incoming: Track): JoinPick {
  const outA = outgoing.analysis;
  const inA = incoming.analysis;
  if (!outA || !inA) {
    return { recipe: "power_cut", bars: 1, reason: "Missing analysis — cut." };
  }

  const outDrop = findDropBars(outgoing);
  const inDrop = findDropBars(incoming);
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
  if (rel === "far") {
    if (hole != null) {
      return {
        recipe: "echo_out",
        bars: 8,
        reason: `BPM too far to share a phrase; outgoing has a hole at ${hole}.`,
      };
    }
    return {
      recipe: "power_cut",
      bars: 1,
      reason: `BPM too far to blend (${outA.bpm.toFixed(0)}→${inA.bpm.toFixed(0)}).`,
    };
  }

  if (move === "clash" || move === "jaws") {
    if (inHasDrop) {
      return {
        recipe: "power_cut",
        bars: 1,
        reason: `${outA.key.camelot}→${inA.key.camelot} ${move} — cut on the incoming 1.`,
      };
    }
    return {
      recipe: hole != null ? "echo_out" : "power_cut",
      bars: hole != null ? 8 : 1,
      reason: `${move} ${outA.key.camelot}→${inA.key.camelot} — do not pad-blend.`,
    };
  }

  if (twoVocals && inHasDrop && outHasDrop) {
    return {
      recipe: "drop_swap",
      bars: canCue8 ? 8 : 1,
      reason: "Both files carry vocals and drops — isolator replace, short overlap.",
    };
  }
  if (twoVocals) {
    return {
      recipe: "eq_swap",
      bars: 8,
      reason: "Two vocal leads — mid handoff, not a long pad.",
    };
  }

  if (trackVocalLead(incoming) && !trackVocalLead(outgoing) && hole != null) {
    return {
      recipe: "hook_layer",
      bars: 12,
      reason: `Incoming vocal over outgoing hole at ${hole}.`,
    };
  }

  if (inHasDrop && outHasDrop && Math.abs(lift) <= 1 && canCue16 && safeKey) {
    return {
      recipe: "double_drop",
      bars: 16,
      reason: `Both drops (${outDrop} / ${inDrop}), energy ${eOut}→${eIn} — stack the 1.`,
    };
  }

  if (inHasDrop && (outHasDrop || hole != null) && lift >= 0) {
    const n = canCue16 ? 16 : 8;
    return {
      recipe: "drop_swap",
      bars: n,
      reason: hole != null && !outHasDrop
        ? `Incoming drop ${inDrop}; leave through outgoing hole ${hole}.`
        : `Replace: incoming drop ${inDrop}, outgoing drop ${outDrop}.`,
    };
  }

  if (inHasDrop && inBuild && canCue8) {
    return {
      recipe: "filter_sweep",
      bars: canCue16 ? 16 : 8,
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

  if (!inHasDrop && !twoVocals && safeKey) {
    return {
      recipe: "bass_swap",
      bars: 8,
      reason: `${outA.key.camelot}→${inA.key.camelot} ${move}, no incoming drop — one-bass blend.`,
    };
  }

  return {
    recipe: inHasDrop ? "drop_swap" : "bass_swap",
    bars: inHasDrop && canCue8 ? 8 : 8,
    reason: "Default from these two files: drop replace if a drop exists, else one-bass blend.",
  };
}

function fallbacks(first: JoinPick, outgoing: Track, incoming: Track): JoinPick[] {
  const list: JoinPick[] = [first];
  const add = (recipe: TransitionRecipe, bars: number, reason: string) => {
    if (!list.some((x) => x.recipe === recipe && x.bars === bars)) {
      list.push({ recipe, bars, reason });
    }
  };
  add("power_cut", 1, "retry: cut on the 1");
  if (findHoleBars(outgoing) != null) {
    add("echo_out", 8, "retry: leave through the hole");
  }
  if (trackVocalLead(outgoing) && trackVocalLead(incoming)) {
    add("eq_swap", 8, "retry: mid handoff");
  }
  if (findDropBars(incoming) != null) {
    add("drop_swap", 8, "retry: shorter replace");
  }
  add("bass_swap", 8, "retry: one-bass blend");
  return list.slice(0, 4);
}

function applyPick(
  outgoing: Track,
  incoming: Track,
  outEntry: ArrangementEntry,
  inEntry: ArrangementEntry,
  pick: JoinPick,
) {
  const applied = applyRecipeBars(pick.recipe, pick.bars);
  if (!applied) return;
  const durIn = Math.max(8, incoming.analysis?.durationBars ?? 32);
  const durOut = Math.max(8, outgoing.analysis?.durationBars ?? 32);
  if (isDropRecipe(pick.recipe) || pick.recipe === "backspin") {
    const mode = pick.recipe === "power_cut" || pick.recipe === "backspin" ? "cut" : "swap";
    const aligned = alignDropJoin(outgoing, incoming, applied.bars, mode);
    outEntry.outBars = Math.max(outEntry.inBars + 8, Math.min(durOut, aligned.outBars));
    inEntry.inBars = Math.max(0, Math.min(aligned.inBars, Math.max(0, durIn - 8)));
  }
  inEntry.outBars = Math.min(durIn, Math.max(inEntry.inBars + 16, inEntry.outBars));
  if (inEntry.outBars <= inEntry.inBars) inEntry.outBars = Math.min(durIn, inEntry.inBars + 16);
  if (outEntry.outBars <= outEntry.inBars) outEntry.outBars = Math.min(durOut, outEntry.inBars + 16);
  inEntry.transition = { type: applied.type, bars: applied.bars };
}

function injectContrast(sequence: Track[], leftover: Track[]): Track[] {
  const out = [...sequence];
  const used = new Set(out.map((t) => t.id));
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1]!;
    const b = out[i]!;
    if (!a.analysis || !b.analysis) continue;
    const sameKey = a.analysis.key.camelot === b.analysis.key.camelot;
    const flat =
      Math.abs((deriveEnergyLevel(a) ?? 5) - (deriveEnergyLevel(b) ?? 5)) === 0;
    const sameGenre = (trackGenre(a) ?? "") === (trackGenre(b) ?? "") && trackGenre(a);
    if (!(sameKey && flat && sameGenre)) continue;
    const swap = leftover.find((t) => {
      if (used.has(t.id) || !t.analysis) return false;
      const move = classifyCamelotMove(a.analysis!.key.camelot, t.analysis.key.camelot);
      const eDelta = Math.abs((deriveEnergyLevel(a) ?? 5) - (deriveEnergyLevel(t) ?? 5));
      return move !== "same" || eDelta >= 2;
    });
    if (swap) {
      used.delete(b.id);
      used.add(swap.id);
      out[i] = swap;
    }
  }
  return out;
}

function tempoLanes(doc: SetDoc, entries: ArrangementEntry[]): AutomationLane[] {
  const probe: SetDoc = { ...doc, arrangement: entries };
  const spans = buildTimeline(probe);
  const lanes: AutomationLane[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1]!;
    const cur = entries[i]!;
    const bpmA = doc.tracks[prev.trackId]?.analysis?.bpm;
    const bpmB = doc.tracks[cur.trackId]?.analysis?.bpm;
    if (!bpmA || !bpmB || Math.abs(bpmB - bpmA) <= 3) continue;
    const span = spans[i];
    const prevSpan = spans[i - 1];
    if (!span || !prevSpan) continue;
    const start = span.setStart;
    const end = Math.min(span.setStart + cur.transition.bars, prevSpan.setEnd);
    const rel = tempoRelation(bpmA, bpmB);
    const snap = rel === "half" || rel === "double";
    lanes.push({
      id: crypto.randomUUID(),
      param: "tempo",
      startBars: start,
      endBars: Math.max(end, start + (snap ? 0.25 : 0.5)),
      startValue: bpmA,
      endValue: bpmB,
      curve: snap ? "linear" : "ease_in",
    });
  }
  return lanes;
}

export async function prepareSet(
  doc: SetDoc,
  opts: { intent?: string; trackCount?: number; hear?: boolean } = {},
): Promise<{
  result: Omit<PrepareSetResult, "applied" | "proposed">;
  arrangement: ArrangementEntry[];
  automation: AutomationLane[];
}> {
  const cards = crateCards(doc);
  const inferred = inferNight(doc, opts.intent, opts.trackCount);
  const plan = planSetArc(doc, inferred.arc, inferred.track_count);
  if (plan.entries.length < 2) {
    return {
      result: {
        intent: opts.intent?.trim() || null,
        inferred,
        cards,
        entries: [],
        joins: [],
        verify: {
          ready: false,
          issues: [{ code: "too_short", message: plan.reason, severity: "error" }],
        },
      },
      arrangement: [],
      automation: [],
    };
  }

  const planned = plan.entries
    .map((e) => doc.tracks[e.track_id])
    .filter((t): t is Track => Boolean(t?.analysis));
  const leftover = Object.values(doc.tracks).filter(
    (t) => t.analysis && !planned.some((p) => p.id === t.id),
  );
  const sequence = injectContrast(planned, leftover);

  const arrangement: ArrangementEntry[] = sequence.map((t) => {
    const plannedRow = plan.entries.find((e) => e.track_id === t.id);
    const dur = Math.max(8, t.analysis?.durationBars ?? 32);
    const drop = findDropBars(t);
    const inBars = plannedRow?.in_bars ?? (drop != null ? Math.min(drop, Math.max(0, dur - 8)) : 0);
    const outBars = plannedRow?.out_bars ?? dur;
    return {
      id: crypto.randomUUID(),
      trackId: t.id,
      inBars,
      outBars: Math.max(inBars + 8, outBars),
      transition: {
        type: "cut" as TransitionType,
        bars: 1,
      },
    };
  });

  const hear = opts.hear !== false;
  const joins: PreparedJoin[] = [];

  for (let i = 1; i < arrangement.length; i++) {
    const outgoing = doc.tracks[arrangement[i - 1]!.trackId]!;
    const incoming = doc.tracks[arrangement[i]!.trackId]!;
    const first = chooseJoinFromRecords(outgoing, incoming);
    const candidates = fallbacks(first, outgoing, incoming);
    let chosen = first;
    let verdict: JoinListen["verdict"] | "skipped" = "skipped";
    let notes: string[] = [];
    let retries = 0;

    for (let c = 0; c < candidates.length; c++) {
      const pick = candidates[c]!;
      applyPick(outgoing, incoming, arrangement[i - 1]!, arrangement[i]!, pick);
      const lanes = tempoLanes(doc, arrangement);
      const working: SetDoc = { ...doc, arrangement, automation: lanes };
      const gate = verifySet(working, arrangement);
      const joinErrors = gate.issues.filter(
        (iss) => iss.severity === "error" && iss.index === i,
      );
      let listen: JoinListen | null = null;
      try {
        listen = await previewJoin(working, i, hear);
      } catch (e) {
        notes = [e instanceof Error ? e.message : "preview failed"];
      }
      const fail = joinErrors.length > 0 || listen?.verdict === "fail";
      if (!fail) {
        chosen = pick;
        verdict = listen?.verdict ?? "skipped";
        notes = listen?.notes ?? notes;
        retries = c;
        break;
      }
      chosen = pick;
      verdict = listen?.verdict ?? "fail";
      notes = [
        ...(listen?.notes ?? notes),
        ...joinErrors.map((iss) => iss.message),
      ];
      retries = c;
    }

    joins.push({
      index: i,
      outgoing: outgoing.title,
      incoming: incoming.title,
      recipe: chosen.recipe,
      bars: chosen.bars,
      reason: chosen.reason,
      retries,
      verdict,
      notes,
    });
  }

  const automation = tempoLanes(doc, arrangement);
  const probe: SetDoc = { ...doc, arrangement, automation };
  const verify = verifySet(probe, arrangement);

  return {
    result: {
      intent: opts.intent?.trim() || null,
      inferred: {
        ...inferred,
        reason: `${inferred.reason} ${plan.reason.replace(/\s*Joins unset[^.]*\./, "").trim()}`,
      },
      cards,
      entries: arrangement.map((e, i) => ({
        track_id: e.trackId,
        title: doc.tracks[e.trackId]?.title ?? e.trackId,
        in_bars: e.inBars,
        out_bars: e.outBars,
        transition: e.transition.type,
        bars: e.transition.bars,
        recipe: i === 0 ? "cut" : (joins.find((j) => j.index === i)?.recipe ?? e.transition.type),
      })),
      joins,
      verify,
    },
    arrangement,
    automation,
  };
}

