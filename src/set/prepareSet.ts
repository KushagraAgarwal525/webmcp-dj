import { analysisNeedsRefresh } from "../analysis/stale";
import type {
  ArrangementEntry,
  AutomationLane,
  ComposeStyle,
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
  keyIsTrusted,
  safeLeaveBars,
  snapToPhrase,
  verifySet,
  type VerifyResult,
} from "./builder";
import {
  alignBlendJoin,
  alignDropJoin,
  alignEchoJoin,
  alignTeaseJoin,
  bpmLane,
  chooseJoinFromRecords,
  chopWindow,
  clipSlot,
  crateHealth,
  findDropBars,
  findHoleBars,
  findPeakDropBars,
  inferStyle,
  isChopJoin,
  isDropRecipe,
  joinCompileReport,
  joinFallbacks,
  planSetArc,
  tempoRelation,
  trackGenre,
  trackMood,
  trackRole,
  trackVocalLead,
  type JoinCompileReport,
  type JoinPick,
  type SetArcId,
} from "./craft";
import { previewJoin, type JoinListen } from "./previewJoin";
import { buildTimeline } from "./timeline";

// Kept for older callers (smoke scripts import the composer from here).
export { chooseJoinFromRecords } from "./craft";

export type CrateCard = {
  track_id: string;
  title: string;
  artist: string;
  bpm: number | null;
  camelot: string | null;
  key_name: string | null;
  key_confidence: number | null;
  key_trusted: boolean;
  energy_level: number | null;
  /** High-band ratio 0..1 — display this, never the word "dark". */
  brightness: number | null;
  bpm_lane: string | null;
  /** Curated (tag_track) — null until the agent/human sets it. */
  role: TrackRole | null;
  mood: TrackMood | null;
  genre: string | null;
  vocal_lead: boolean;
  drop_bars: number | null;
  hole_bars: number | null;
  safe_leave_bars: number | null;
  cue_before_drop_8: number | null;
  cue_before_drop_16: number | null;
  duration_bars: number | null;
  heat_in_bars: number | null;
  heat_out_bars: number | null;
  stale: boolean;
};


export type JoinOverride = {
  index: number;
  recipe?: string;
  bars?: number;
};

export type PreparedJoin = JoinPick & {
  index: number;
  outgoing: string;
  incoming: string;
  retries: number;
  verdict: JoinListen["verdict"] | "skipped";
  notes: string[];
  /** Full candidate trail — why each pick passed or failed (transparency for re-edits). */
  tries: Array<{ recipe: string; bars: number; pass: boolean; why: string }>;
  /** Other recipe/bars pairs that also pass verify + preview for this pair. */
  alternatives: Array<{ recipe: string; bars: number }>;
  /** What the compiler did: commit bar on the set clock and drop anchor. */
  commit: JoinCompileReport | null;
  override: boolean;
};

export type PrepareSetResult = {
  intent: string | null;
  inferred: { arc: SetArcId; reason: string; track_count: number; style: ComposeStyle };
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
  const drop = findPeakDropBars(track) ?? findDropBars(track);
  const hole = findHoleBars(track);
  const dur = a?.durationBars ?? null;
  const cue = (n: number) =>
    drop == null || dur == null
      ? null
      : Math.max(0, Math.min(snapToPhrase(drop - n), Math.max(0, dur - n)));
  const trusted = keyIsTrusted(track);
  return {
    track_id: track.id,
    title: track.title,
    artist: track.artist,
    bpm: a?.bpm ?? null,
    camelot: a?.key.camelot ?? null,
    key_name: a?.key.name ?? null,
    key_confidence: a?.key.confidence ?? null,
    key_trusted: trusted,
    energy_level: deriveEnergyLevel(track),
    brightness: a?.brightness ?? null,
    bpm_lane: a ? bpmLane(a.bpm) : null,
    role: trackRole(track),
    mood: trackMood(track),
    genre: trackGenre(track),
    vocal_lead: trackVocalLead(track),
    drop_bars: drop,
    hole_bars: hole,
    safe_leave_bars: drop != null ? safeLeaveBars(track, drop) : null,
    cue_before_drop_8: cue(8),
    cue_before_drop_16: cue(16),
    duration_bars: dur != null ? Number(dur.toFixed(2)) : null,
    heat_in_bars: a?.heatInBars ?? null,
    heat_out_bars: a?.heatOutBars ?? null,
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
): { arc: SetArcId; reason: string; track_count: number; style: ComposeStyle } {
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
      style: inferStyle(intent, named),
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
  } else if (lanes.length === 1 && (lanes[0] === "dnb" || lanes[0] === "hard")) {
    arc = "peak_time";
    reason = `Single ${lanes[0]} lane — peak-time block.`;
  }

  return { arc, reason, track_count: n, style: inferStyle(intent, arc) };
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
  if (pick.park === "hole") {
    // Hole-parked blend: the overlap sits on the outgoing's tonal hole under
    // the incoming's build — two harmonies never co-occur.
    const aligned = alignBlendJoin(outgoing, incoming, applied.bars);
    if (aligned) {
      outEntry.outBars = Math.max(outEntry.inBars + 8, Math.min(durOut, aligned.outBars));
      inEntry.inBars = Math.max(0, Math.min(aligned.inBars, Math.max(0, durIn - 8)));
      inEntry.outBars = Math.min(durIn, Math.max(inEntry.inBars + 16, inEntry.outBars));
      if (outEntry.outBars <= outEntry.inBars) outEntry.outBars = Math.min(durOut, outEntry.inBars + 16);
      inEntry.transition = { type: applied.type, bars: applied.bars };
      return;
    }
    // No hole after all — fall through to the drop parking below.
  }
  if (pick.recipe === "tease_slam") {
    // Tease parking: incoming at drop−bars so the drop lands on the commit.
    const aligned = alignTeaseJoin(outgoing, incoming, applied.bars);
    outEntry.outBars = Math.max(outEntry.inBars + 8, Math.min(durOut, aligned.outBars));
    // The outgoing clip must host the full tease plus a solo lead-in — if a
    // vocal wall collapsed the safe leave, the overlap clamps and the drop
    // lands late. Grow on the phrase grid; the slam chops on the 1 by design.
    const need = outEntry.inBars + applied.bars + 8;
    if (outEntry.outBars < need) {
      outEntry.outBars = Math.min(durOut, Math.ceil(need / 8) * 8);
    }
    inEntry.inBars = Math.max(0, Math.min(aligned.inBars, Math.max(0, durIn - 8)));
  } else if (isDropRecipe(pick.recipe) || pick.recipe === "backspin") {
    const mode =
      pick.recipe === "power_cut" ||
      pick.recipe === "backspin" ||
      pick.recipe === "air_cut" ||
      pick.recipe === "loop_roll"
        ? "cut"
        : "swap";
    const aligned = alignDropJoin(outgoing, incoming, applied.bars, mode);
    outEntry.outBars = Math.max(outEntry.inBars + 8, Math.min(durOut, aligned.outBars));
    inEntry.inBars = Math.max(0, Math.min(aligned.inBars, Math.max(0, durIn - 8)));
  } else if (pick.recipe === "echo_out" || pick.recipe === "half_bridge") {
    const aligned = alignEchoJoin(outgoing, incoming, applied.bars);
    outEntry.outBars = Math.max(outEntry.inBars + 16, Math.min(durOut, aligned.outBars));
    inEntry.inBars = Math.max(0, Math.min(aligned.inBars, Math.max(0, durIn - 16)));
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
    if (
      cur.transition.type === "echo_out" ||
      cur.transition.type === "cut" ||
      cur.transition.type === "backspin"
    ) {
      continue;
    }
    const span = spans[i];
    const prevSpan = spans[i - 1];
    if (!span || !prevSpan || span.overlapBars <= 0) continue;
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
  opts: {
    intent?: string;
    trackCount?: number;
    order?: string[];
    joinOverrides?: JoinOverride[];
    hear?: boolean;
  } = {},
): Promise<{
  result: Omit<PrepareSetResult, "applied" | "proposed">;
  arrangement: ArrangementEntry[];
  automation: AutomationLane[];
}> {
  const cards = crateCards(doc);
  const inferred = inferNight(doc, opts.intent, opts.trackCount);
  const plan = planSetArc(doc, inferred.arc, inferred.track_count, inferred.style);
  if (plan.entries.length < 2 && (opts.order?.length ?? 0) < 2) {
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

  const pool = Object.values(doc.tracks).filter((t) => t.analysis);
  let sequence: Track[];
  let orderNote = "";
  if (opts.order?.length) {
    const byId = new Map(pool.map((t) => [t.id, t] as const));
    const ordered = opts.order
      .map((id) => byId.get(id))
      .filter((t): t is Track => Boolean(t));
    sequence = [...new Map(ordered.map((t) => [t.id, t] as const)).values()];
    const missing = opts.order.filter((id) => !byId.has(id));
    if (missing.length) {
      orderNote = ` Unknown/unanalyzed order ids skipped: ${missing.join(", ")}.`;
    }
  } else {
    const planned = plan.entries
      .map((e) => doc.tracks[e.track_id])
      .filter((t): t is Track => Boolean(t?.analysis));
    if (plan.via === "path-dp") {
      // The path optimizer already paid for contrast in its edge costs —
      // swapping tracks after the fact would fight the optimum.
      sequence = planned;
    } else {
      const leftover = pool.filter((t) => !planned.some((p) => p.id === t.id));
      sequence = injectContrast(planned, leftover);
    }
  }

  if (sequence.length < 2) {
    return {
      result: {
        intent: opts.intent?.trim() || null,
        inferred,
        cards,
        entries: [],
        joins: [],
        verify: {
          ready: false,
          issues: [
            {
              code: "too_short",
              message: "Order needs at least 2 analyzed tracks.",
              severity: "error",
            },
          ],
        },
      },
      arrangement: [],
      automation: [],
    };
  }

  const arrangement: ArrangementEntry[] = sequence.map((t, i) => {
    const plannedRow = plan.entries.find((e) => e.track_id === t.id);
    const dur = Math.max(8, t.analysis?.durationBars ?? 32);
    const drop = findDropBars(t);
    const chop =
      inferred.style === "chop"
        ? chopWindow(t, clipSlot(i, sequence.length, inferred.style))
        : null;
    const inBars =
      chop?.inBars ??
      plannedRow?.in_bars ??
      (drop != null ? Math.min(drop, Math.max(0, dur - 8)) : 0);
    const outBars = chop?.outBars ?? plannedRow?.out_bars ?? dur;
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

  function clampChopClip(track: Track, entry: ArrangementEntry, keep: "in" | "out") {
    if (inferred.style !== "chop") return;
    const dur = Math.max(8, track.analysis?.durationBars ?? 32);
    entry.outBars = Math.min(dur, Math.max(entry.inBars + 8, entry.outBars));
    if (entry.outBars - entry.inBars > 32) {
      // Drop-anchored joins park the ENTRANCE (tease_slam at drop−bars, slams
      // at the drop). Sliding inBars forward to keep the tail would break the
      // anchor — the drop would land off the commit. Trim the tail instead.
      const anchorLocked =
        entry.transition.type === "tease_slam" ||
        entry.transition.type === "cut" ||
        entry.transition.type === "air_cut" ||
        entry.transition.type === "backspin" ||
        entry.transition.type === "loop_roll";
      if (keep === "in" || anchorLocked) {
        entry.outBars = Math.min(dur, entry.inBars + 32);
      } else {
        entry.inBars = Math.max(0, entry.outBars - 32);
      }
    }
    if (entry.outBars - entry.inBars < 8) {
      entry.outBars = Math.min(dur, entry.inBars + 16);
    }
  }

  const hear = opts.hear !== false;
  const joins: PreparedJoin[] = [];
  const overrides = (opts.joinOverrides ?? []).filter(
    (o) => Number.isFinite(o.index) && o.index >= 1 && o.index < arrangement.length,
  );

  const gateCandidate = async (
    outgoing: Track,
    incoming: Track,
    i: number,
    pick: JoinPick,
    hearAudio: boolean,
  ): Promise<{ pass: boolean; errors: string[]; listen: JoinListen | null }> => {
    applyPick(outgoing, incoming, arrangement[i - 1]!, arrangement[i]!, pick);
    clampChopClip(outgoing, arrangement[i - 1]!, "out");
    clampChopClip(incoming, arrangement[i]!, "in");
    const lanes = tempoLanes(doc, arrangement);
    const working: SetDoc = { ...doc, arrangement, automation: lanes };
    const gate = verifySet(working, arrangement);
    const joinErrors = gate.issues
      .filter((iss) => iss.severity === "error" && iss.index === i)
      .map((iss) => iss.message);
    let listen: JoinListen | null = null;
    try {
      listen = await previewJoin(working, i, hearAudio);
    } catch {
      /* preview failure is not a gate failure by itself */
    }
    return {
      pass: joinErrors.length === 0 && listen?.verdict !== "fail",
      errors: joinErrors,
      listen,
    };
  };

  for (let i = 1; i < arrangement.length; i++) {
    const outgoing = doc.tracks[arrangement[i - 1]!.trackId]!;
    const incoming = doc.tracks[arrangement[i]!.trackId]!;
    const first = chooseJoinFromRecords(outgoing, incoming, inferred.style);

    const ov = overrides.find((o) => o.index === i);
    let forced: JoinPick | null = null;
    let overrideNote = "";
    if (ov) {
      const recipeName = (ov.recipe ?? first.recipe) as JoinPick["recipe"];
      const applied = applyRecipeBars(recipeName, ov.bars);
      if (applied) {
        forced = {
          recipe: recipeName,
          bars: applied.bars,
          reason: "operator override",
        };
      } else {
        overrideNote = `Override recipe "${String(ov.recipe)}" is unknown — auto pick kept. Valid recipes: tease_slam, drop_swap, double_drop, power_cut, build_cut, bass_swap, eq_swap, filter_sweep, echo_out, loop_out, loop_roll, backspin, hook_layer, half_bridge, tempo_ride, power_block.`;
      }
    }

    const base = forced ?? first;
    let candidates = joinFallbacks(base, outgoing, incoming, inferred.style);
    if (inferred.style === "chop" && joins.length) {
      const prev = joins[joins.length - 1]!.recipe;
      if (candidates[0]?.recipe === prev) {
        const alt = candidates.findIndex((c) => c.recipe !== prev && isChopJoin(c.recipe));
        if (alt > 0) {
          const pick = candidates.splice(alt, 1)[0]!;
          candidates.unshift(pick);
        }
      }
    }

    // A closer should LAND on its drop, not enter from silence — put landing
    // moves ahead of leaves on the final join.
    const isCloserJoin = i === arrangement.length - 1;
    if (
      isCloserJoin &&
      (candidates[0]?.recipe === "echo_out" || candidates[0]?.recipe === "half_bridge") &&
      findDropBars(incoming) != null
    ) {
      const closerDrop = findDropBars(incoming)!;
      const landing: JoinPick[] = [
        {
          recipe: "tease_slam",
          bars: closerDrop >= 20 ? 16 : 8,
          reason: "closer is teased in, then lands on its drop",
        },
        { recipe: "backspin", bars: 1, reason: "closer lands via rewind slam" },
      ];
      const rest = candidates.filter(
        (c) => c.recipe !== "tease_slam" && c.recipe !== "backspin",
      );
      candidates = [...landing, ...rest].slice(0, 4);
    }
    let chosen = base;
    let verdict: JoinListen["verdict"] | "skipped" = "skipped";
    let notes: string[] = [];
    let retries = 0;
    const tries: Array<{ recipe: string; bars: number; pass: boolean; why: string }> = [];

    for (let c = 0; c < candidates.length; c++) {
      const pick = candidates[c]!;
      const gate = await gateCandidate(outgoing, incoming, i, pick, hear);
      const why = gate.errors.length
        ? gate.errors.join("; ")
        : gate.listen?.verdict === "fail"
          ? (gate.listen.notes ?? []).join("; ")
          : "";
      if (gate.pass) {
        chosen = pick;
        verdict = gate.listen?.verdict ?? "skipped";
        notes = gate.listen?.notes ?? [];
        retries = c;
        tries.push({ recipe: pick.recipe, bars: pick.bars, pass: true, why });
        break;
      }
      chosen = pick;
      verdict = gate.listen?.verdict ?? "fail";
      notes = [...(gate.listen?.notes ?? []), ...gate.errors];
      retries = c;
      tries.push({ recipe: pick.recipe, bars: pick.bars, pass: false, why });
    }

    // Alternatives: other candidates that would also pass (scored cheap,
    // waveform-only) — the model re-edits by index with these, not by bars.
    const alternatives: Array<{ recipe: string; bars: number }> = [];
    for (const pick of candidates) {
      if (pick.recipe === chosen.recipe && pick.bars === chosen.bars) continue;
      const gate = await gateCandidate(outgoing, incoming, i, pick, false);
      if (gate.pass) alternatives.push({ recipe: pick.recipe, bars: pick.bars });
    }
    // Restore the chosen candidate after probing alternatives.
    await gateCandidate(outgoing, incoming, i, chosen, false);

    if (overrideNote) notes = [overrideNote, ...notes];
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
      tries,
      alternatives,
      commit: null,
      override: Boolean(forced),
    });
  }

  const automation = tempoLanes(doc, arrangement);
  const probe: SetDoc = { ...doc, arrangement, automation };
  const verify = verifySet(probe, arrangement);
  for (const j of joins) {
    j.commit = joinCompileReport(probe, j.index);
  }

  return {
    result: {
      intent: opts.intent?.trim() || null,
      inferred: {
        ...inferred,
        reason: `${inferred.reason} ${plan.reason.replace(/\s*Joins unset[^.]*\./, "").trim()}${orderNote}`,
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

