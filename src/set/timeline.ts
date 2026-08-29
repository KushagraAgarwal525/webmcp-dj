import type {
  ArrangementEntry,
  AutomationCurve,
  AutomationLane,
  AutomationParam,
  SetDoc,
  Track,
  TransitionType,
} from "../types/setdoc";

export type TimelineSpan = {
  entryIndex: number;
  entry: ArrangementEntry;
  /** Set-timeline start (bars) */
  setStart: number;
  /** Set-timeline end (bars) */
  setEnd: number;
  /** Bars of overlap with previous entry (0 for first) */
  overlapBars: number;
  deck: "A" | "B";
};

/** Flatten arrangement into a set timeline with transition overlaps. */
export function buildTimeline(doc: SetDoc): TimelineSpan[] {
  const spans: TimelineSpan[] = [];
  let cursor = 0;
  doc.arrangement.forEach((entry, i) => {
    const playBars = Math.max(1, entry.outBars - entry.inBars);
    const overlap = i === 0 ? 0 : Math.max(0, entry.transition.bars);
    const setStart = Math.max(0, cursor - overlap);
    const setEnd = setStart + playBars;
    spans.push({
      entryIndex: i,
      entry,
      setStart,
      setEnd,
      overlapBars: overlap,
      deck: i % 2 === 0 ? "A" : "B",
    });
    cursor = setEnd;
  });
  return spans;
}

export function setDurationBars(doc: SetDoc): number {
  const spans = buildTimeline(doc);
  if (!spans.length) return 0;
  return spans[spans.length - 1]!.setEnd;
}

export function masterBpm(doc: SetDoc): number {
  if (doc.setTempoBpm != null && doc.setTempoBpm > 0) return doc.setTempoBpm;
  const first = doc.arrangement[0];
  if (first) {
    const bpm = doc.tracks[first.trackId]?.analysis?.bpm;
    if (bpm) return bpm;
  }
  return doc.decks[doc.tempoMaster].bpm ?? 120;
}

export function evalCurve(t: number, curve: AutomationCurve): number {
  const x = Math.min(1, Math.max(0, t));
  switch (curve) {
    case "exponential":
      return (Math.pow(Math.E, x) - 1) / (Math.E - 1);
    case "ease_in":
      return x * x;
    case "ease_out":
      return 1 - (1 - x) * (1 - x);
    case "linear":
    default:
      return x;
  }
}

export function sampleAutomation(
  lanes: AutomationLane[],
  param: AutomationParam,
  setBars: number,
): number | null {
  const active = lanes.filter(
    (l) => l.param === param && setBars >= l.startBars && setBars <= l.endBars,
  );
  if (!active.length) return null;
  const lane = active[active.length - 1]!;
  const span = Math.max(1e-6, lane.endBars - lane.startBars);
  const t = evalCurve((setBars - lane.startBars) / span, lane.curve);
  return lane.startValue + (lane.endValue - lane.startValue) * t;
}

function lane(
  startBars: number,
  endBars: number,
  param: AutomationParam,
  startValue: number,
  endValue: number,
  curve: AutomationCurve = "linear",
): AutomationLane {
  return {
    id: crypto.randomUUID(),
    startBars,
    endBars: Math.max(endBars, startBars + 0.01),
    param,
    startValue,
    endValue,
    curve,
  };
}

/** Club-style transition compile — bass swaps, build→cut, real echo — not linear washes. */
export function compileTransitionAutomation(doc: SetDoc): AutomationLane[] {
  const spans = buildTimeline(doc);
  const lanes: AutomationLane[] = [];

  for (const span of spans) {
    if (span.entryIndex === 0 || span.overlapBars <= 0) continue;
    const prev = spans[span.entryIndex - 1]!;
    const start = span.setStart;
    const end = Math.min(span.setStart + span.overlapBars, prev.setEnd);
    if (end <= start) continue;
    const type = span.entry.transition.type;
    const outIsA = prev.deck === "A";
    const outLow = outIsA ? "eq_low_a" : "eq_low_b";
    const inLow = outIsA ? "eq_low_b" : "eq_low_a";
    const outFilt = outIsA ? "filter_a" : "filter_b";
    const inFilt = outIsA ? "filter_b" : "filter_a";
    const outFader = outIsA ? "fader_a" : "fader_b";
    const xfOut = outIsA ? -1 : 1;
    const xfIn = outIsA ? 1 : -1;
    const mid = start + (end - start) * 0.5;
    const late = Math.max(start, end - Math.min(1, (end - start) * 0.2));
    const cutAt = Math.max(start, end - 0.25);

    if (type === "cut") {
      lanes.push(lane(cutAt, end, "xfader", xfOut, xfIn, "linear"));
      lanes.push(lane(start, cutAt, outLow, 0, -24, "ease_in"));
      lanes.push(lane(start, end, inLow, -24, 0, "ease_out"));
    } else if (type === "blend") {
      // Bass swap under a short mid blend — never double-bass wash
      lanes.push(lane(start, mid, outLow, 0, -24, "ease_in"));
      lanes.push(lane(mid, end, inLow, -24, 0, "ease_out"));
      lanes.push(lane(mid, end, "xfader", xfOut, xfIn, "ease_in"));
      lanes.push(lane(start, mid, "xfader", xfOut, xfOut * 0.35, "linear"));
    } else if (type === "eq_swap") {
      lanes.push(lane(start, mid, outLow, 0, -24, "ease_in"));
      lanes.push(lane(mid, end, inLow, -24, 0, "ease_out"));
      lanes.push(
        lane(start, end, outIsA ? "eq_mid_a" : "eq_mid_b", 0, -8, "linear"),
      );
      lanes.push(
        lane(start, end, outIsA ? "eq_mid_b" : "eq_mid_a", -6, 0, "ease_out"),
      );
      lanes.push(lane(late, end, "xfader", xfOut, xfIn, "ease_in"));
    } else if (type === "filter_sweep" || type === "build_cut") {
      // Tension: close outgoing filter, kill bass; power cut on the 1
      lanes.push(lane(start, late, outFilt, 0, 0.95, "exponential"));
      lanes.push(lane(start, mid, outLow, 0, -24, "ease_in"));
      lanes.push(lane(start, late, inLow, -24, -24, "linear"));
      lanes.push(lane(late, end, inLow, -24, 0, "ease_out"));
      lanes.push(lane(start, late, inFilt, -0.35, 0, "ease_out"));
      lanes.push(lane(start, late, "xfader", xfOut, xfOut, "linear"));
      lanes.push(lane(late, end, "xfader", xfOut, xfIn, "linear"));
      lanes.push(lane(late, end, outFilt, 0.95, 0.95, "linear"));
      if (type === "build_cut") {
        lanes.push(lane(start, late, "fx_arm", 0, 1, "ease_in"));
        lanes.push(lane(start, late, "fx_wet", 0.05, 0.45, "ease_in"));
        lanes.push(lane(late, end, "fx_wet", 0.45, 0, "ease_out"));
        lanes.push(lane(late, end, "fx_arm", 1, 0, "linear"));
      }
    } else if (type === "drop_swap") {
      // Isolator drop-swap: incoming isolated, mids/highs sneak, bass + xfader commit on the 1.
      const inMid = outIsA ? "eq_mid_b" : "eq_mid_a";
      const inHigh = outIsA ? "eq_high_b" : "eq_high_a";
      lanes.push(lane(start, late, inLow, -24, -24, "linear"));
      lanes.push(lane(start, mid, inMid, -24, -8, "ease_out"));
      lanes.push(lane(mid, late, inMid, -8, 0, "linear"));
      lanes.push(lane(start, late, inHigh, -18, 0, "ease_out"));
      lanes.push(lane(start, late, outLow, 0, 0, "linear"));
      lanes.push(lane(late, end, outLow, 0, -24, "linear"));
      lanes.push(lane(late, end, inLow, -24, 0, "linear"));
      lanes.push(lane(start, late, "xfader", xfOut, xfOut * 0.2, "linear"));
      lanes.push(lane(late, end, "xfader", xfOut * 0.2, xfIn, "linear"));
      lanes.push(lane(late, end, outFader, 0.75, 0.35, "ease_in"));
    } else if (type === "echo_out") {
      lanes.push(lane(start, end, "fx_arm", 1, 1, "linear"));
      lanes.push(lane(start, mid, "fx_wet", 0.15, 0.55, "ease_in"));
      lanes.push(lane(mid, end, "fx_wet", 0.55, 0.2, "linear"));
      lanes.push(lane(start, end, outLow, 0, -24, "ease_in"));
      lanes.push(lane(start, end, outFader, 0.75, 0, "exponential"));
      lanes.push(lane(start, mid, outFilt, 0, -0.7, "linear"));
      lanes.push(lane(start, late, "xfader", xfOut, xfOut, "linear"));
      lanes.push(lane(late, end, "xfader", xfOut, xfIn, "ease_in"));
      lanes.push(lane(late, end, inLow, -24, 0, "ease_out"));
      lanes.push(lane(end, end + 0.01, "fx_arm", 1, 0, "linear"));
      lanes.push(lane(end, end + 0.01, "fx_wet", 0.2, 0, "linear"));
    } else if (type === "loop_out" || type === "loop_roll") {
      lanes.push(lane(start, mid, outLow, 0, -24, "ease_in"));
      lanes.push(lane(start, late, outFilt, 0, type === "loop_roll" ? 0.85 : 0.4, "ease_in"));
      lanes.push(lane(cutAt, end, "xfader", xfOut, xfIn, "linear"));
      lanes.push(lane(mid, end, inLow, -24, 0, "ease_out"));
    } else if (type === "double_drop") {
      const hit = start + (end - start) * 0.45;
      lanes.push(lane(start, hit, inLow, -24, -24, "linear"));
      lanes.push(lane(hit, hit + 0.25, inLow, -24, 0, "linear"));
      lanes.push(lane(start, hit, "xfader", xfOut, xfOut * 0.2, "linear"));
      lanes.push(lane(hit, late, "xfader", xfOut * 0.2, 0, "linear"));
      lanes.push(lane(late, end, "xfader", 0, xfIn, "ease_in"));
      lanes.push(lane(late, end, outLow, 0, -24, "ease_in"));
      lanes.push(lane(start, late, outFader, 0.75, 0.75, "linear"));
      lanes.push(lane(late, end, outFader, 0.75, 0, "ease_in"));
    } else if (type === "backspin") {
      lanes.push(lane(start, late, outFilt, 0, 0.9, "exponential"));
      lanes.push(lane(late, end, outFader, 0.75, 0, "linear"));
      lanes.push(lane(cutAt, end, "xfader", xfOut, xfIn, "linear"));
      lanes.push(lane(start, late, inLow, -24, -24, "linear"));
      lanes.push(lane(late, end, inLow, -24, 0, "ease_out"));
    } else if (type === "hook_layer") {
      const outMid = outIsA ? "eq_mid_a" : "eq_mid_b";
      const inMid = outIsA ? "eq_mid_b" : "eq_mid_a";
      const outHigh = outIsA ? "eq_high_a" : "eq_high_b";
      lanes.push(lane(start, mid, outLow, 0, -24, "ease_in"));
      lanes.push(lane(start, mid, outHigh, 0, -10, "linear"));
      lanes.push(lane(start, end, outMid, 0, 0, "linear"));
      lanes.push(lane(start, mid, inMid, -10, -4, "linear"));
      lanes.push(lane(mid, end, inMid, -4, 0, "ease_out"));
      lanes.push(lane(start, mid, inLow, -24, -24, "linear"));
      lanes.push(lane(mid, end, inLow, -24, 0, "ease_out"));
      lanes.push(lane(late, end, "xfader", xfOut, xfIn, "ease_in"));
    }
  }

  return lanes;
}

export function allAutomation(doc: SetDoc): AutomationLane[] {
  return [...compileTransitionAutomation(doc), ...doc.automation];
}

export function trackAtSetPosition(
  doc: SetDoc,
  setBars: number,
): { span: TimelineSpan; trackBars: number } | null {
  const spans = buildTimeline(doc);
  let hit: TimelineSpan | null = null;
  for (const s of spans) {
    if (setBars >= s.setStart && setBars < s.setEnd) hit = s;
  }
  if (!hit && spans.length && setBars >= spans[spans.length - 1]!.setEnd) {
    hit = spans[spans.length - 1]!;
  }
  if (!hit) return null;
  const trackBars = hit.entry.inBars + (setBars - hit.setStart);
  return { span: hit, trackBars };
}

export function entryBpm(doc: SetDoc, entry: ArrangementEntry): number {
  return doc.tracks[entry.trackId]?.analysis?.bpm ?? masterBpm(doc);
}

export function getTrack(doc: SetDoc, id: string): Track | undefined {
  return doc.tracks[id];
}

/** Default bars for a transition recipe. */
export function defaultTransitionBars(type: TransitionType): number {
  switch (type) {
    case "cut":
      return 1;
    case "echo_out":
      return 8;
    case "loop_out":
    case "loop_roll":
      return 4;
    case "backspin":
      return 1;
    case "double_drop":
      return 16;
    case "hook_layer":
      return 12;
    case "blend":
      return 8;
    case "eq_swap":
      return 16;
    case "filter_sweep":
    case "build_cut":
    case "drop_swap":
      return 16;
    default:
      return 8;
  }
}

/** Map recipe name → TransitionType. */
export function recipeToTransition(
  recipe: string,
): TransitionType | null {
  switch (recipe) {
    case "bass_swap":
      return "blend";
    case "build_cut":
      return "build_cut";
    case "drop_swap":
      return "drop_swap";
    case "echo_out":
      return "echo_out";
    case "power_cut":
      return "cut";
    case "eq_swap":
      return "eq_swap";
    case "filter_sweep":
      return "filter_sweep";
    case "loop_out":
      return "loop_out";
    case "loop_roll":
      return "loop_roll";
    case "double_drop":
      return "double_drop";
    case "backspin":
      return "backspin";
    case "hook_layer":
      return "hook_layer";
    case "half_bridge":
      return "echo_out";
    case "power_block":
      return "cut";
    case "blend":
      return "blend";
    case "cut":
      return "cut";
    default:
      return null;
  }
}
