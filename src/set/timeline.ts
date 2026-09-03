import {
  TRANSITION_TYPES,
  type ArrangementEntry,
  type AutomationCurve,
  type AutomationLane,
  type AutomationParam,
  type SetDoc,
  type Track,
  type TransitionType,
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

/** Cached timeline / automation — invalidated when arrangement or automation identity changes. */
let timelineCache: { key: string; spans: TimelineSpan[] } | null = null;
let automationCache: { key: string; lanes: AutomationLane[] } | null = null;

function arrangementKey(doc: SetDoc): string {
  // version bumps on every live mixer patch — use structural identity instead
  const arr = doc.arrangement
    .map(
      (e) =>
        `${e.id}:${e.trackId}:${e.inBars}:${e.outBars}:${e.transition.type}:${e.transition.bars}`,
    )
    .join("|");
  const auto = doc.automation
    .map(
      (l) =>
        `${l.id}:${l.param}:${l.startBars}:${l.endBars}:${l.startValue}:${l.endValue}:${l.curve}`,
    )
    .join("|");
  return `${arr}#${auto}#${doc.setTempoBpm ?? ""}`;
}

/** Flatten arrangement into a set timeline with transition overlaps. */
export function transitionOverlapBars(type: TransitionType, bars: number): number {
  // Echo and air cuts are leaves to silence — incoming must not share the clock.
  if (type === "echo_out" || type === "air_cut") return 0;
  return Math.max(0, bars);
}

/** Air after a leave — none. Real DJs switch on the beat; dead air reads as a pause. */
export function transitionGapBars(_type: TransitionType): number {
  return 0;
}

/** Far-BPM safe: each deck keeps native tempo; incoming is not heard until the slam. */
export function joinIsClockIndependent(type: TransitionType): boolean {
  return type === "echo_out" || type === "cut" || type === "backspin";
}

export const BACKSPIN_REWIND_BARS = 8;

/**
 * Vinyl rewind playhead: start at the overlap-start position and accelerate backward.
 */
export function backspinPlayheadBars(
  outgoing: { inBars: number; setStart: number },
  overlapStart: number,
  overlapEnd: number,
  setBars: number,
  rewindDepthBars = BACKSPIN_REWIND_BARS,
): number {
  const origin = outgoing.inBars + (overlapStart - outgoing.setStart);
  const dur = Math.max(1e-6, overlapEnd - overlapStart);
  const t = Math.max(0, Math.min(1, (setBars - overlapStart) / dur));
  return Math.max(outgoing.inBars, origin - t * t * rewindDepthBars);
}

/** Cut/backspin: park incoming on its in-point until the slam, then run from there. */
export function spanPlayheadBars(
  spans: TimelineSpan[],
  span: TimelineSpan,
  setBars: number,
): number {
  const type = span.entry.transition.type;
  if (span.entryIndex === 0 || !joinIsClockIndependent(type) || type === "echo_out") {
    return span.entry.inBars + (setBars - span.setStart);
  }
  const prev = spans[span.entryIndex - 1];
  if (!prev) return span.entry.inBars + (setBars - span.setStart);
  if (setBars < prev.setEnd) return span.entry.inBars;
  return span.entry.inBars + (setBars - prev.setEnd);
}

/** Inclusive rewind window (excludes the xfader slam). */
export function backspinSpinWindow(span: TimelineSpan, prev: TimelineSpan) {
  const start = span.setStart;
  const end = Math.min(span.setStart + span.overlapBars, prev.setEnd);
  const cutAt = Math.max(start, end - 0.25);
  return { start, end, cutAt };
}

/** Set-clock → track bars, including the backspin reverse on the outgoing deck. */
export function livePlayheadBars(
  spans: TimelineSpan[],
  span: TimelineSpan,
  setBars: number,
): number {
  for (const s of spans) {
    if (s.entry.transition.type !== "backspin" || s.overlapBars <= 0) continue;
    const prev = spans[s.entryIndex - 1];
    if (!prev || span.entryIndex !== prev.entryIndex) continue;
    const { start, cutAt } = backspinSpinWindow(s, prev);
    if (setBars >= start && setBars < cutAt) {
      return backspinPlayheadBars(
        { inBars: prev.entry.inBars, setStart: prev.setStart },
        start,
        cutAt,
        setBars,
      );
    }
  }
  return spanPlayheadBars(spans, span, setBars);
}

export function buildTimeline(doc: SetDoc): TimelineSpan[] {
  const key = arrangementKey(doc);
  if (timelineCache?.key === key) return timelineCache.spans;

  const spans: TimelineSpan[] = [];
  let cursor = 0;
  doc.arrangement.forEach((entry, i) => {
    const playBars = Math.max(1, entry.outBars - entry.inBars);
    const overlap =
      i === 0 ? 0 : transitionOverlapBars(entry.transition.type, entry.transition.bars);
    const gap = i === 0 ? 0 : transitionGapBars(entry.transition.type);
    const setStart = Math.max(0, cursor - overlap + gap);
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
  timelineCache = { key, spans };
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
  return doc.decks?.[doc.tempoMaster ?? "A"]?.bpm ?? 120;
}

/**
 * The set clock's bpm at a position — single source of truth for the live
 * performer AND the offline bounce. Tempo lane wins. During an overlap with
 * no lane, the clock follows the OUTGOING span: both decks rate-match to it
 * until the commit, so reading the incoming span's native bpm here would run
 * the clock against the decks and force audible drift-correction seeks.
 */
export function clockBpmAt(doc: SetDoc, setBars: number): number {
  const tempoAuto = sampleAutomation(allAutomation(doc), "tempo", setBars);
  if (tempoAuto != null && tempoAuto > 0) return tempoAuto;
  const spans = buildTimeline(doc);
  const live = spans.filter((s) => setBars >= s.setStart && setBars < s.setEnd);
  if (live.length > 1) {
    const outgoing = live.reduce((a, b) => (a.setStart <= b.setStart ? a : b));
    return entryBpm(doc, outgoing.entry);
  }
  if (live.length) return entryBpm(doc, live[live.length - 1]!.entry);
  const ended = [...spans].reverse().find((s) => s.setEnd <= setBars);
  if (ended) return entryBpm(doc, ended.entry);
  return spans[0] ? entryBpm(doc, spans[0].entry) : 120;
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

/**
 * Like sampleAutomation, but after a lane ends keep its endValue (matches live
 * patchLive hold + offline bounce carry-forward). Critical for seek into later spans.
 */
export function sampleAutomationHeld(
  lanes: AutomationLane[],
  param: AutomationParam,
  setBars: number,
): number | null {
  const live = sampleAutomation(lanes, param, setBars);
  if (live != null) return live;
  let best: AutomationLane | null = null;
  for (const l of lanes) {
    if (l.param !== param) continue;
    if (l.endBars > setBars) continue;
    if (!best || l.endBars >= best.endBars) best = l;
  }
  return best ? best.endValue : null;
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
    if (span.entryIndex === 0) continue;
    const prev = spans[span.entryIndex - 1]!;
    const type = span.entry.transition.type;
    const outIsA = prev.deck === "A";
    const outLow = outIsA ? "eq_low_a" : "eq_low_b";
    const inLow = outIsA ? "eq_low_b" : "eq_low_a";
    const outFilt = outIsA ? "filter_a" : "filter_b";
    const inFilt = outIsA ? "filter_b" : "filter_a";
    const outFader = outIsA ? "fader_a" : "fader_b";
    const xfOut = outIsA ? -1 : 1;
    const xfIn = outIsA ? 1 : -1;

    /**
     * Bring the spent channel back to life for the NEXT entry on this deck.
     * Kill lanes hold forever (sampleAutomationHeld) — without these restores,
     * every later entry on a reused deck plays with a dead fader / killed EQ.
     * That bug is why tracks went quiet mid-set. Constant lanes at channel
     * defaults, starting after the xfader flip completes (inaudible side).
     */
    const restoreOut = (t: number) => {
      lanes.push(lane(t, t + 0.25, outFader, 0.75, 0.75, "linear"));
      lanes.push(lane(t, t + 0.25, outLow, 0, 0, "linear"));
      lanes.push(lane(t, t + 0.25, outIsA ? "eq_mid_a" : "eq_mid_b", 0, 0, "linear"));
      lanes.push(lane(t, t + 0.25, outIsA ? "eq_high_a" : "eq_high_b", 0, 0, "linear"));
      lanes.push(lane(t, t + 0.25, outFilt, 0, 0, "linear"));
    };

    if (type === "echo_out") {
      // Echo-THROW: dry holds full, the send swells through the phrase, the
      // last hook fills the delay, the fader CUTS on the 1 and the buffer
      // rings OVER the incoming's first bars — the tail sits on the new kick,
      // which is the club move. No dead air anywhere.
      const n = Math.max(2, span.entry.transition.bars);
      const end = prev.setEnd;
      const start = Math.max(prev.setStart, end - n);
      if (end <= start) continue;
      const fill = Math.max(start, end - 1.5); // last hook fills the delay
      const cut = Math.max(start, end - 0.1); // dry cut on the 1
      const flipEnd = end + 0.25;
      lanes.push(lane(start, end + 1, "fx_arm", 1, 1, "linear"));
      lanes.push(lane(start, fill, "fx_wet", 0.12, 0.4, "linear"));
      lanes.push(lane(fill, cut, "fx_wet", 0.4, 0.85, "ease_in"));
      lanes.push(lane(cut, end, "fx_wet", 0.85, 0.85, "linear"));
      lanes.push(lane(end, end + 1, "fx_wet", 0.85, 0, "ease_out"));
      lanes.push(lane(end + 1, end + 1.01, "fx_arm", 1, 0, "linear"));
      // Dry path: full until the throw — never a fade.
      lanes.push(lane(start, cut, outFader, 0.75, 0.75, "linear"));
      lanes.push(lane(start, cut, outLow, 0, 0, "linear"));
      lanes.push(lane(start, cut, outFilt, 0, -0.45, "linear"));
      // The throw: dry dies on the 1, EQs kill with it, delay keeps ringing.
      lanes.push(lane(cut, end, outFader, 0.75, 0, "linear"));
      lanes.push(lane(cut, end, outLow, 0, -24, "linear"));
      lanes.push(lane(cut, end, outIsA ? "eq_mid_a" : "eq_mid_b", 0, -14, "linear"));
      lanes.push(lane(cut, end, outIsA ? "eq_high_a" : "eq_high_b", 0, -10, "linear"));
      lanes.push(lane(start, end, "xfader", xfOut, xfOut, "linear"));
      lanes.push(lane(end, flipEnd, "xfader", xfOut, xfIn, "linear"));
      restoreOut(flipEnd + 0.05);
      continue;
    }

    if (type === "air_cut") {
      // The hijack slam: four bars of RISING tension on the outgoing (HP
      // opens, highs lift, send swells — anticipation, never muffling), then
      // everything snaps on the 1, and the incoming's drop lands instantly.
      // The outgoing is parked at its own build end by the composer, so the
      // crowd braced for ITS drop and gets the new one on that same 1.
      const n = Math.max(2, Math.min(8, span.entry.transition.bars));
      const end = prev.setEnd;
      const setupStart = Math.max(prev.setStart, end - n);
      const killAt = Math.max(setupStart, end - 0.1);
      const flipEnd = end + 0.25;
      const outHigh = outIsA ? "eq_high_a" : "eq_high_b";
      const outMid = outIsA ? "eq_mid_a" : "eq_mid_b";
      // Tension setup: brighter, bigger, more reverb — the fake-out build.
      lanes.push(lane(setupStart, killAt, "fx_arm", 1, 1, "linear"));
      lanes.push(lane(setupStart, killAt, outFilt, 0, 0.65, "ease_in"));
      lanes.push(lane(setupStart, killAt, outHigh, 0, 2.5, "linear"));
      lanes.push(lane(setupStart, killAt, "fx_wet", 0.08, 0.4, "ease_in"));
      // The snap: everything dies on the 1, the FX tail cuts with it.
      lanes.push(lane(killAt, end, outFader, 0.75, 0, "linear"));
      lanes.push(lane(killAt, end, outLow, 0, -24, "linear"));
      lanes.push(lane(killAt, end, outMid, 0, -16, "linear"));
      lanes.push(lane(killAt, end, outHigh, 2.5, -12, "linear"));
      lanes.push(lane(killAt, end, outFilt, 0.65, -0.8, "linear"));
      lanes.push(lane(killAt, end, "fx_wet", 0.4, 0, "linear"));
      lanes.push(lane(end, end + 0.01, "fx_arm", 1, 0, "linear"));
      lanes.push(lane(prev.setStart, end, "xfader", xfOut, xfOut, "linear"));
      lanes.push(lane(end, flipEnd, "xfader", xfOut, xfIn, "linear"));
      restoreOut(flipEnd + 0.05);
      continue;
    }

    if (span.overlapBars <= 0) continue;
    const start = span.setStart;
    const end = Math.min(span.setStart + span.overlapBars, prev.setEnd);
    if (end <= start) continue;
    const mid = start + (end - start) * 0.5;
    const late = Math.max(start, end - Math.min(1, (end - start) * 0.2));
    const cutAt = Math.max(start, end - 0.25);

    if (type === "tease_slam") {
      // The chop default — a real handoff, not a switch. TEASE — the incoming
      // build bleeds in under the outgoing (LP-filtered, bass killed, fader
      // low, xfader drifting off the rail). BUILD — the incoming opens to
      // FULL bandwidth and near-full level a bar early while the outgoing
      // HP-rises and the FX send swells (prepare_set/apply_recipe also lay a
      // tempo lane across this window; over the last 4 bars the outgoing
      // rides a musical pitch interval while the incoming stays keylocked;
      // the performer stutters a 1→0.5 loop roll on the outgoing's last 2
      // bars). LAST BAR — the outgoing dips under its roll so the kill is a
      // flick, not a squelch. THE 1 (1/16 bar) — bass swap + xfader flick;
      // the drop's first transient lands at full level, not mid-sweep, and
      // the outgoing dies into an echo throw whose tail rings over the drop.
      const n = end - start;
      const build = Math.max(start, end - Math.min(4, n * 0.5));
      const preOpen = Math.max(build, end - 1); // incoming fully open a bar early
      const flick = Math.max(preOpen, end - 0.0625); // the 1: a 1/16-bar flick
      const inFader = outIsA ? "fader_b" : "fader_a";
      const inMid = outIsA ? "eq_mid_b" : "eq_mid_a";
      const inHigh = outIsA ? "eq_high_b" : "eq_high_a";
      const outMid = outIsA ? "eq_mid_a" : "eq_mid_b";
      const outHigh = outIsA ? "eq_high_a" : "eq_high_b";
      // TEASE: incoming is a rumour — muffled, bassless, under the line.
      lanes.push(lane(start, build, inFader, 0, 0.38, "ease_in"));
      lanes.push(lane(start, build, inFilt, -0.6, -0.3, "ease_in"));
      lanes.push(lane(start, build, inHigh, -8, -3, "linear"));
      lanes.push(lane(start, build, inMid, -10, -6, "linear"));
      lanes.push(lane(start, flick, inLow, -24, -24, "linear"));
      lanes.push(lane(start, build, "xfader", xfOut, xfOut * 0.45, "ease_in"));
      // BUILD: incoming reaches full bandwidth and near-full level a bar
      // early — the drop's first hit must not arrive mid-sweep.
      lanes.push(lane(build, preOpen, inFader, 0.38, 0.75, "linear"));
      lanes.push(lane(build, preOpen, inFilt, -0.3, 0, "ease_out"));
      lanes.push(lane(build, preOpen, inHigh, -3, 0, "linear"));
      lanes.push(lane(build, preOpen, inMid, -6, -2, "linear"));
      lanes.push(lane(build, preOpen, "xfader", xfOut * 0.45, xfIn * 0.35, "linear"));
      // HP rise for tension, not mid massacre: 0.32 ≈ 1.3kHz keeps the
      // outgoing's mids alive through the build (0.45 gutted them).
      lanes.push(lane(build, flick, outFilt, 0, 0.32, "ease_in"));
      lanes.push(lane(build, flick, outHigh, 0, 2, "linear"));
      lanes.push(lane(build, end + 1, "fx_arm", 1, 1, "linear"));
      lanes.push(lane(build, preOpen, "fx_wet", 0.1, 0.5, "ease_in"));
      // LAST BAR: the outgoing dips under the roll; the throw keeps filling.
      lanes.push(lane(preOpen, flick, outFader, 0.75, 0.5, "ease_in"));
      lanes.push(lane(preOpen, flick, "fx_wet", 0.5, 0.7, "linear"));
      // THE 1 (1/16 bar): bass swap + xfader flick — the drop lands NOW.
      lanes.push(lane(flick, end, inLow, -24, 0, "linear"));
      lanes.push(lane(flick, end, "xfader", xfIn * 0.35, xfIn, "linear"));
      lanes.push(lane(flick, end, outFader, 0.5, 0, "linear"));
      lanes.push(lane(flick, end, outLow, 0, -24, "linear"));
      lanes.push(lane(flick, end, outMid, 0, -14, "linear"));
      lanes.push(lane(flick, end, outHigh, 2, -10, "linear"));
      lanes.push(lane(flick, end, outFilt, 0.32, -0.5, "linear"));
      lanes.push(lane(flick, end, "fx_wet", 0.7, 0.85, "linear"));
      // Tail: the delay buffer rings over the incoming drop, then releases.
      lanes.push(lane(end, end + 1, "fx_wet", 0.85, 0, "ease_out"));
      lanes.push(lane(end + 1, end + 1.01, "fx_arm", 1, 0, "linear"));
      // restoreOut(end + 0.3) happens below, with every overlapping type.
    } else if (type === "cut") {
      // Power cut with a two-bar tension setup: HP opens on the outgoing
      // (anticipation rises), bass dies into it, xfader snaps on the 1.
      const setup = Math.max(start, cutAt - 2);
      lanes.push(lane(setup, cutAt, outFilt, 0, 0.55, "ease_in"));
      lanes.push(lane(cutAt, end, "xfader", xfOut, xfIn, "linear"));
      lanes.push(lane(start, cutAt, outLow, 0, -24, "ease_in"));
      lanes.push(lane(start, end, inLow, -24, 0, "ease_out"));
      lanes.push(lane(end, end + 0.01, outFilt, 0.55, 0, "linear"));
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
    } else if (type === "drop_swap" || type === "tempo_ride") {
      // Build under the outgoing line, bass swap on the incoming 1, peel the rest of the overlap.
      // tempo_ride adds a doc-level tempo lane (prepare/apply_recipe) that ramps
      // both decks across this same window — the commit shape is identical.
      const n = end - start;
      const hit = Math.min(
        end - 0.25,
        Math.max(start + 0.5, n >= 12 ? start + 8 : end - Math.min(1.5, n * 0.25)),
      );
      const inMid = outIsA ? "eq_mid_b" : "eq_mid_a";
      const inHigh = outIsA ? "eq_high_b" : "eq_high_a";
      const outMid = outIsA ? "eq_mid_a" : "eq_mid_b";
      const outHigh = outIsA ? "eq_high_a" : "eq_high_b";
      lanes.push(lane(start, hit, inLow, -24, -24, "linear"));
      lanes.push(lane(start, hit, inMid, -24, -12, "linear"));
      lanes.push(lane(start, hit, inHigh, -18, -4, "ease_out"));
      lanes.push(lane(start, hit, outLow, 0, 0, "linear"));
      lanes.push(lane(start, hit, "xfader", xfOut, xfOut, "linear"));
      lanes.push(lane(start, hit, outFader, 0.75, 0.75, "linear"));
      lanes.push(lane(hit, Math.min(end, hit + 0.5), outLow, 0, -24, "linear"));
      lanes.push(lane(hit, Math.min(end, hit + 0.5), inLow, -24, 0, "linear"));
      lanes.push(lane(hit, end, inMid, -12, 0, "ease_out"));
      lanes.push(lane(hit, end, inHigh, -4, 0, "linear"));
      lanes.push(lane(hit, end, outMid, 0, -16, "linear"));
      lanes.push(lane(hit, end, outHigh, 0, -12, "linear"));
      lanes.push(lane(hit, end, "xfader", xfOut, xfIn, "ease_in"));
      lanes.push(lane(hit, end, outFader, 0.75, 0, "ease_in"));
    } else if (type === "loop_out" || type === "loop_roll") {
      // The roll is the pad move — but a roll under a hard xfader rail is
      // still a cold switch. Drift the xfader so the incoming bleeds in
      // (LP-filtered) under the loop, then cut on the 1.
      const inFilt2 = outIsA ? "filter_b" : "filter_a";
      lanes.push(lane(start, mid, outLow, 0, -24, "ease_in"));
      lanes.push(lane(start, late, outFilt, 0, type === "loop_roll" ? 0.85 : 0.4, "ease_in"));
      lanes.push(lane(start, mid, "xfader", xfOut, xfOut * 0.4, "ease_in"));
      lanes.push(lane(mid, cutAt, "xfader", xfOut * 0.4, xfOut * 0.15, "linear"));
      lanes.push(lane(start, mid, inFilt2, -0.5, -0.15, "ease_in"));
      lanes.push(lane(mid, cutAt, inFilt2, -0.15, 0, "ease_out"));
      lanes.push(lane(cutAt, end, "xfader", xfOut * 0.15, xfIn, "linear"));
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
      // Keep the outgoing record loud through the rewind — a fader dip here reads as echo_out.
      lanes.push(lane(start, cutAt, outFilt, 0, 0.7, "exponential"));
      lanes.push(lane(start, cutAt, outFader, 0.75, 0.75, "linear"));
      lanes.push(lane(start, cutAt, "xfader", xfOut, xfOut, "linear"));
      lanes.push(lane(start, cutAt, inLow, -24, -24, "linear"));
      lanes.push(lane(start, cutAt, "fx_arm", 0, 1, "ease_in"));
      lanes.push(lane(start, cutAt, "fx_wet", 0.1, 0.4, "ease_in"));
      lanes.push(lane(cutAt, end, "xfader", xfOut, xfIn, "linear"));
      lanes.push(lane(cutAt, end, outFader, 0.75, 0, "linear"));
      lanes.push(lane(cutAt, end, inLow, -24, 0, "linear"));
      lanes.push(lane(cutAt, end, "fx_wet", 0.4, 0, "ease_out"));
      lanes.push(lane(cutAt, end, "fx_arm", 1, 0, "linear"));
      lanes.push(lane(cutAt, end, outFilt, 0.7, 0.7, "linear"));
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
    } else {
      // Exhaustiveness guard: a new TransitionType must add a compile case here.
      // An unknown type compiles zero lanes → two full-volume decks.
      const _exhaustive: never = type;
      console.warn(`[timeline] no compile case for transition "${String(_exhaustive)}" — join will play unautomated`);
      continue;
    }

    // Every overlapping type kills outgoing EQ/fader lanes that would hold
    // dead forever — restore the spent channel right after the overlap ends
    // so the next entry on this deck comes in alive.
    restoreOut(end + 0.3);
  }

  return lanes;
}

export function allAutomation(doc: SetDoc): AutomationLane[] {
  const key = arrangementKey(doc);
  if (automationCache?.key === key) return automationCache.lanes;
  const lanes = [...compileTransitionAutomation(doc), ...doc.automation];
  automationCache = { key, lanes };
  return lanes;
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
  const trackBars = spanPlayheadBars(spans, hit, setBars);
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
    case "air_cut":
      return 4;
    case "tempo_ride":
      return 16;
    case "tease_slam":
      return 16;
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
    case "air_cut":
      return "air_cut";
    case "tempo_ride":
      return "tempo_ride";
    case "tease_slam":
      return "tease_slam";
    case "blend":
      return "blend";
    case "cut":
      return "cut";
    default:
      return null;
  }
}

export function isTransitionType(value: unknown): value is TransitionType {
  return (
    typeof value === "string" &&
    (TRANSITION_TYPES as readonly string[]).includes(value)
  );
}

export type ResolvedTransition = {
  type: TransitionType;
  /** What the caller actually wrote — a bare type or a recipe alias. */
  via: "type" | "recipe";
  name: string;
};

/**
 * One resolver for every place a join is authored: accepts transition types
 * ("cut", "drop_swap") AND recipe names ("power_cut", "bass_swap",
 * "half_bridge", "power_block"). Returns null for anything else — callers
 * must reject, never silently coerce to a blend.
 */
export function resolveTransition(raw: unknown): ResolvedTransition | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (!name) return null;
  if (isTransitionType(name)) return { type: name, via: "type", name };
  const type = recipeToTransition(name);
  return type ? { type, via: "recipe", name } : null;
}
