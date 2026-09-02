/**
 * Prepare-set loop on synthetic crate cards (no browser / PCM).
 * Usage: npx tsx scripts/prepare-smoke.mts
 */
import { createEmptySetDoc, type Track, type TrackAnalysis } from "../src/types/setdoc.ts";
import { chooseJoinFromRecords, inferNight, prepareSet } from "../src/set/prepareSet.ts";
import { buildTimeline, clockBpmAt, compileTransitionAutomation } from "../src/set/timeline.ts";
import { alignDropJoin, alignEchoJoin, alignTeaseJoin, findHoleBars, findPeakDropBars, isSlamRecipe, planSetArc } from "../src/set/craft.ts";
import { isolatorOverlapCap, padOverlapCap, safeLeaveBars, vocalCovers } from "../src/set/builder.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Root-9 (Am) chroma with fifth support — auditions blend_ok against itself. */
const AM_CHROMA = [
  0.1, 0.1, 0.25, 0.1, 0.5, 0.1, 0.1, 0.3, 0.1, 1.0, 0.1, 0.2,
];
/** Root-3 (D#) — tritone against root-9; auditions clash. */
const TRITONE_CHROMA = [
  0.1, 0.1, 0.25, 1.0, 0.1, 0.2, 0.1, 0.1, 0.3, 0.1, 0.1, 0.5,
];

function analysis(partial: Partial<TrackAnalysis> & Pick<TrackAnalysis, "bpm" | "key">): TrackAnalysis {
  const durationBars = partial.durationBars ?? 64;
  const sections = partial.sections ?? [
    { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
    { label: "build", startBars: 16, endBars: 32, startSec: 8, endSec: 16 },
    { label: "drop", startBars: 32, endBars: 48, startSec: 16, endSec: 24 },
    { label: "breakdown", startBars: 48, endBars: 56, startSec: 24, endSec: 28 },
    { label: "outro", startBars: 56, endBars: 64, startSec: 28, endSec: 32 },
  ];
  const dropStart = sections.find((s) => s.label === "drop")?.startBars ?? 32;
  const row: TrackAnalysis = {
    durationSec: durationBars * 0.5,
    durationBars,
    beats: [],
    downbeats: [],
    chromaCurve: Array.from({ length: 12 }, () => [...AM_CHROMA]),
    sections,
    energy: [0.3, 0.45, 0.8, 0.55],
    energyMean: 0.55,
    energyLevel: 6,
    brightness: 0.4,
    detector: "salience-v1",
    waveform: {
      samplesPerPeak: 1024,
      peaks: [0.2, 0.35, 0.7, 0.4],
      low: [0.1, 0.2, 0.5, 0.2],
      mid: [0.15, 0.25, 0.4, 0.2],
      high: [0.1, 0.15, 0.3, 0.15],
    },
    analyzedAt: Date.now(),
    ...partial,
    key: { profile: "edma", ...partial.key },
  };
  const drop = row.sections.find((s) => s.label === "drop")?.startBars ?? dropStart;
  if (row.dropBars == null) row.dropBars = drop;
  if (row.heatInBars == null) row.heatInBars = drop;
  if (row.heatOutBars == null) row.heatOutBars = Math.min(row.durationBars, drop + 32);
  return row;
}

function track(
  id: string,
  title: string,
  a: TrackAnalysis,
  extra: Partial<Track> = {},
): Track {
  return {
    id,
    fileRef: id,
    title,
    artist: "Smoke",
    tags: [],
    crateIds: ["all"],
    analysisStatus: "ready",
    analysis: a,
    ...extra,
  };
}

const opener = track(
  "t1",
  "Opener",
  analysis({
    bpm: 126,
    key: { camelot: "8A", confidence: 0.9, name: "Am" },
    energyLevel: 4,
    energyMean: 0.4,
    suggestedRole: "opener",
    vocalLead: false,
  }),
);
const weapon = track(
  "t2",
  "Weapon",
  analysis({
    bpm: 128,
    key: { camelot: "9A", confidence: 0.85, name: "Em" },
    energyLevel: 9,
    energyMean: 0.82,
    suggestedRole: "peak",
    vocalLead: false,
  }),
);
const vocal = track(
  "t3",
  "Vocal Hook",
  analysis({
    bpm: 127,
    key: { camelot: "8A", confidence: 0.8, name: "Am" },
    energyLevel: 6,
    energyMean: 0.6,
    suggestedRole: "builder",
    vocalLead: true,
    vocalRegions: [{ startSec: 16, endSec: 24, startBars: 32, endBars: 48 }],
  }),
);

const far = track(
  "t4",
  "Half Time",
  analysis({
    bpm: 174,
    key: { camelot: "3A", confidence: 0.7, name: "Bbm" },
    energyLevel: 8,
    energyMean: 0.75,
    suggestedRole: "peak",
    vocalLead: false,
  }),
);

const replace = chooseJoinFromRecords(opener, weapon);
assert(
  replace.recipe === "tease_slam",
  `chop default must tease into the slam, got ${replace.recipe}`,
);
assert(replace.bars === 16, `full tease on a deep drop, got ${replace.bars}`);
const replaceBlend = chooseJoinFromRecords(opener, weapon, "blend");
assert(replaceBlend.recipe === "drop_swap" || replaceBlend.recipe === "double_drop", `expected drop join, got ${replaceBlend.recipe}`);
assert(replaceBlend.recipe !== "double_drop", "adjacent 8A→9A must not stack 16");
assert(replaceBlend.bars === 16, `adjacent isolator replace should be 16, got ${replaceBlend.bars}`);
assert(padOverlapCap("adjacent", true) === 8, "adjacent pad cap");
assert(padOverlapCap("adjacent", false) === 1, "untrusted pad cap");
assert(padOverlapCap("same", true) === 16, "same-key pad cap");
assert(isolatorOverlapCap("energy_boost") === 16, "energy boost isolator");
assert(isolatorOverlapCap("clash") === 1, "clash isolator");

const stackish = chooseJoinFromRecords(weapon, opener);
assert(stackish.recipe !== "echo_out", "echo_out must not be the default");

const half = chooseJoinFromRecords(opener, far);
assert(half.recipe === "air_cut" || half.recipe === "power_cut", half.recipe);
const halfBlend = chooseJoinFromRecords(opener, far, "blend");
assert(halfBlend.recipe === "half_bridge" || halfBlend.recipe === "echo_out" || halfBlend.recipe === "air_cut", halfBlend.recipe);

const twoVox = chooseJoinFromRecords(vocal, vocal);
assert(twoVox.recipe === "tease_slam", twoVox.recipe);

const midnight = track(
  "m83",
  "Midnight City",
  analysis({
    bpm: 107.7,
    key: { camelot: "10A", confidence: 0.9, name: "Bm" },
    energyLevel: 6,
    energyMean: 0.55,
    suggestedRole: "opener",
    vocalLead: true,
    durationBars: 80,
    vocalRegions: [{ startSec: 20, endSec: 80, startBars: 16, endBars: 64 }],
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "drop", startBars: 16, endBars: 56, startSec: 8, endSec: 28 },
      { label: "breakdown", startBars: 64, endBars: 72, startSec: 32, endSec: 36 },
      { label: "outro", startBars: 72, endBars: 80, startSec: 36, endSec: 40 },
    ],
  }),
);
const atNight = track(
  "anyma",
  "At Night",
  analysis({
    bpm: 129.2,
    key: { camelot: "8A", confidence: 0.85, name: "Am" },
    energyLevel: 8,
    energyMean: 0.8,
    suggestedRole: "peak",
    vocalLead: true,
    durationBars: 88,
    vocalRegions: [{ startSec: 10, endSec: 90, startBars: 8, endBars: 72 }],
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "build", startBars: 16, endBars: 32, startSec: 8, endSec: 16 },
      { label: "drop", startBars: 32, endBars: 72, startSec: 16, endSec: 36 },
      { label: "outro", startBars: 80, endBars: 88, startSec: 40, endSec: 44 },
    ],
  }),
);

const farVox = chooseJoinFromRecords(midnight, atNight);
assert(
  farVox.recipe === "tease_slam",
  `a ridable gap (+20%) must tease-ride onto the drop, got ${farVox.recipe}`,
);
// Echo joins land the incoming on its drop/heat window — bar-0 intro entries
// are dead (that was the "fade in" complaint).
assert(
  alignEchoJoin(midnight, atNight, 8).inBars > 0,
  "echo incoming must land at its drop/heat, not bar 0",
);

const farDoc = createEmptySetDoc("FarVox");
farDoc.tracks = { m83: midnight, anyma: atNight };
farDoc.crates.all!.trackIds = ["m83", "anyma"];
const farPrep = await prepareSet(farDoc, { hear: false, trackCount: 2 });
assert(farPrep.arrangement.length === 2, "two-track set");
assert(
  farPrep.arrangement[0]!.inBars > 0,
  `first clip must not be forced to bar 0, got ${farPrep.arrangement[0]!.inBars}`,
);
// The only join of a 2-track set is the closer join — the closer is teased
// in and lands on its drop (tease_slam), never from bar-0 silence.
assert(
  farPrep.arrangement[1]!.transition.type === "tease_slam",
  `closer must land, got ${farPrep.arrangement[1]!.transition.type}`,
);
assert(farPrep.arrangement[1]!.inBars > 0, "closer parked on its build, not bar 0");
assert(
  farPrep.automation.some(
    (l) =>
      l.param === "tempo" &&
      Math.abs(l.startValue - 107.7) < 0.01 &&
      Math.abs(l.endValue - 129.2) < 0.01,
  ),
  "a ridable gap must author the tempo lane across the tease",
);
const farTl = buildTimeline({ ...farDoc, arrangement: farPrep.arrangement });
assert(farTl[1]!.overlapBars === 16, "the tease IS the handoff — 16 shared bars");
assert(
  farPrep.result.joins[0]?.commit?.commit_on_drop === true,
  "the tease commit must land on the incoming drop",
);
assert(farPrep.result.verify.ready, JSON.stringify(farPrep.result.verify.issues));

const hooked = track(
  "hook",
  "Hooked Drop",
  analysis({
    bpm: 129,
    key: { camelot: "8A", confidence: 0.8, name: "Am" },
    energyLevel: 8,
    energyMean: 0.8,
    suggestedRole: "peak",
    vocalLead: true,
    durationBars: 80,
    vocalRegions: [{ startSec: 14, endSec: 20, startBars: 28, endBars: 40 }],
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "build", startBars: 16, endBars: 32, startSec: 8, endSec: 16 },
      { label: "drop", startBars: 32, endBars: 64, startSec: 16, endSec: 32 },
      { label: "outro", startBars: 64, endBars: 80, startSec: 32, endSec: 40 },
    ],
  }),
);
assert(vocalCovers(hooked, 32), "drop sits inside the hook");
assert(safeLeaveBars(hooked, 32) === 48, `finish the line then the next 1, got ${safeLeaveBars(hooked, 32)}`);
assert(!vocalCovers(hooked, safeLeaveBars(hooked, 32)), "safe leave is not mid-line");
assert(alignDropJoin(hooked, weapon, 8, "swap").outBars === 48, "align parks after the line");

const longLine = track(
  "wall",
  "Wall of Vocal",
  analysis({
    bpm: 129,
    key: { camelot: "8A", confidence: 0.8, name: "Am" },
    energyLevel: 8,
    energyMean: 0.8,
    vocalLead: true,
    durationBars: 80,
    vocalRegions: [{ startSec: 4, endSec: 36, startBars: 8, endBars: 72 }],
  }),
);
assert(safeLeaveBars(longLine, 32) === 8, "line longer than max slip → leave before it");

const atNightAdj = track(
  "anyma2",
  "At Night",
  analysis({
    bpm: 129.2,
    key: { camelot: "8A", confidence: 0.85, name: "Am" },
    energyLevel: 8,
    energyMean: 0.8,
    suggestedRole: "peak",
    vocalLead: true,
    durationBars: 88,
    vocalRegions: [{ startSec: 28, endSec: 36, startBars: 56, endBars: 72 }],
    energy: [0.3, 0.35, 0.4, 0.45, 0.5, 0.4, 0.35, 0.4, 0.9, 0.85, 0.5, 0.3],
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "build", startBars: 16, endBars: 24, startSec: 8, endSec: 12 },
      { label: "drop", startBars: 24, endBars: 40, startSec: 12, endSec: 20 },
      { label: "breakdown", startBars: 40, endBars: 64, startSec: 20, endSec: 32 },
      { label: "drop", startBars: 64, endBars: 80, startSec: 32, endSec: 40 },
      { label: "outro", startBars: 80, endBars: 88, startSec: 40, endSec: 44 },
    ],
  }),
);
const newGen = track(
  "ng",
  "New Generation",
  analysis({
    bpm: 129.2,
    key: { camelot: "9A", confidence: 0.8, name: "Em" },
    energyLevel: 9,
    energyMean: 0.85,
    suggestedRole: "peak",
    vocalLead: true,
    durationBars: 80,
    vocalRegions: [{ startSec: 16, endSec: 24, startBars: 32, endBars: 48 }],
    energy: [0.3, 0.35, 0.4, 0.9, 0.85, 0.5, 0.4, 0.3],
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "build", startBars: 16, endBars: 24, startSec: 8, endSec: 12 },
      { label: "drop", startBars: 24, endBars: 32, startSec: 12, endSec: 16 },
      { label: "drop", startBars: 40, endBars: 64, startSec: 20, endSec: 32 },
      { label: "outro", startBars: 72, endBars: 80, startSec: 36, endSec: 40 },
    ],
  }),
);
const technoPair = chooseJoinFromRecords(atNightAdj, newGen, "blend");
assert(technoPair.recipe === "drop_swap", technoPair.recipe);
assert(technoPair.bars === 16, `same-BPM isolator should be 16, got ${technoPair.bars}`);
const parked = alignDropJoin(atNightAdj, newGen, 16, "swap");
const inDrop = findPeakDropBars(newGen)!;
const outDrop = findPeakDropBars(atNightAdj)!;
const leave = safeLeaveBars(atNightAdj, outDrop);
assert(Math.abs(parked.inBars - (inDrop - 8)) < 1, `cue the build (drop−8), got in ${parked.inBars} drop ${inDrop}`);
assert(parked.outBars === Math.min(atNightAdj.analysis!.durationBars, leave + 8), `leave + peel, got ${parked.outBars} leave ${leave}`);
assert(!vocalCovers(atNightAdj, parked.outBars), "xfader commit is after the line");

const swapDoc = createEmptySetDoc("Swap");
swapDoc.tracks = { anyma2: atNightAdj, ng: newGen };
swapDoc.arrangement = [
  {
    id: "e0",
    trackId: "anyma2",
    inBars: 0,
    outBars: parked.outBars,
    transition: { type: "cut", bars: 1 },
  },
  {
    id: "e1",
    trackId: "ng",
    inBars: parked.inBars,
    outBars: Math.min(newGen.analysis!.durationBars, parked.inBars + 32),
    transition: { type: "drop_swap", bars: 16 },
  },
];
const xf = compileTransitionAutomation(swapDoc).filter((l) => l.param === "xfader");
assert(xf.length >= 2, "drop_swap xfader lanes");
assert(xf[0]!.startValue === xf[0]!.endValue, "xfader holds outgoing through the build");
assert(Math.abs(xf[0]!.endBars - xf[0]!.startBars - 8) < 0.2, `hit should be 8 bars in, got ${xf[0]!.endBars - xf[0]!.startBars}`);

// ─── tease_slam: the handoff shape — tease, ride, roll, slam on the 1 ───
const teaseAligned = alignTeaseJoin(atNightAdj, newGen, 16);
assert(
  Math.abs(teaseAligned.inBars - (findPeakDropBars(newGen)! - 16)) < 1,
  `tease parks the incoming at drop−16 (the build), got in ${teaseAligned.inBars}`,
);
const teaseDoc = createEmptySetDoc("Tease");
teaseDoc.tracks = { anyma2: atNightAdj, ng: newGen };
teaseDoc.arrangement = [
  {
    id: "x0",
    trackId: "anyma2",
    inBars: 24,
    outBars: teaseAligned.outBars,
    transition: { type: "cut", bars: 1 },
  },
  {
    id: "x1",
    trackId: "ng",
    inBars: teaseAligned.inBars,
    outBars: Math.min(newGen.analysis!.durationBars, teaseAligned.inBars + 32),
    transition: { type: "tease_slam", bars: 16 },
  },
];
const teaseTl = buildTimeline(teaseDoc);
assert(teaseTl[1]!.overlapBars === 16, "tease shares the clock for 16 bars");
const teaseLanes = compileTransitionAutomation(teaseDoc);
const tStart = teaseTl[1]!.setStart;
const tEnd = teaseTl[0]!.setEnd;
// Incoming tease: fader swells from silence, LP opens, bass held until the 1.
assert(
  teaseLanes.some((l) => l.param === "fader_b" && l.startValue === 0 && l.startBars === tStart),
  "incoming tease starts silent",
);
assert(
  teaseLanes.some((l) => l.param === "filter_b" && l.startValue < -0.4 && l.endValue > l.startValue),
  "incoming LP opens through the tease",
);
assert(
  teaseLanes.some((l) => l.param === "eq_low_b" && l.startValue === -24 && l.endValue === -24),
  "incoming bass held until the 1",
);
assert(
  teaseLanes.some(
    (l) => l.param === "eq_low_b" && l.startValue === -24 && l.endValue === 0 && l.endBars - l.startBars <= 0.5,
  ),
  "bass swap snaps on the 1",
);
// Outgoing: HP tension rise into the slam.
assert(
  teaseLanes.some((l) => l.param === "filter_a" && l.endValue > 0.3 && l.endValue > l.startValue),
  "outgoing HP rise into the slam",
);
// Xfader: drifts off the outgoing rail during the tease, then snaps on the 1.
assert(
  teaseLanes.some((l) => l.param === "xfader" && l.startValue === -1 && l.endValue > -1),
  "xfader drifts off the outgoing rail during the tease",
);
const teaseSnap = teaseLanes.find(
  (l) => l.param === "xfader" && l.endValue === 1 && l.startValue < 0,
);
assert(
  teaseSnap != null && teaseSnap.endBars - teaseSnap.startBars <= 0.5,
  "the xfader snap lands on the 1",
);
// The throw: wet fills hard before the cut, then rings out past the leave.
assert(
  teaseLanes.some((l) => l.param === "fx_wet" && (l.endValue >= 0.8 || l.startValue >= 0.8)),
  "echo throw fills before the slam",
);
assert(
  teaseLanes.some((l) => l.param === "fx_wet" && l.endValue === 0 && l.startBars >= tEnd),
  "throw rings out past the leave",
);
// The commit anchors on the incoming drop's 1 — the drift lanes must not
// masquerade as the commit (that was the old joinCompileReport bug).
const teaseReport = joinCompileReport(teaseDoc, 1);
assert(
  teaseReport?.commit_on_drop === true,
  `tease commit must land on the incoming drop (commit ${teaseReport?.commit_bars}, drop ${teaseReport?.incoming_drop_bars})`,
);
assert(
  verifySet(teaseDoc, teaseDoc.arrangement).ready,
  `tease_slam must verify ready — ${JSON.stringify(verifySet(teaseDoc, teaseDoc.arrangement).issues)}`,
);
// (Past ~20% the ride is chipmunk territory — the farSlam fixture below
// covers that the air slam survives there.)

const untrustedNight = track("u1", "Untrusted A", {
  ...atNightAdj.analysis!,
  key: { camelot: "8A", confidence: 0.3, name: "Am" },
});
const untrustedGen = track("u2", "Untrusted B", {
  ...newGen.analysis!,
  key: { camelot: "10A", confidence: 0.3, name: "Bm" },
});
const guessJoin = chooseJoinFromRecords(untrustedNight, untrustedGen, "blend");
assert(guessJoin.recipe === "drop_swap", `untrusted same-BPM isolator must still drop-swap, got ${guessJoin.recipe}`);
// Untrusted keys cap the isolator at 8 bars (Grok policy: trust buys length).
assert(guessJoin.bars === 8, String(guessJoin.bars));

const doc = createEmptySetDoc("Smoke");
doc.tracks = { t1: opener, t2: weapon, t3: vocal };
doc.crates.all!.trackIds = ["t1", "t2", "t3"];

const night = inferNight(doc);
assert(night.arc === "journey" || night.arc === "warm_up" || night.arc === "peak_time", night.arc);
assert(night.style === "chop", `default night is chop, got ${night.style}`);

const prepared = await prepareSet(doc, { hear: false, trackCount: 3 });
assert(prepared.arrangement.length >= 2, "need a set");
assert(prepared.result.verify.ready, JSON.stringify(prepared.result.verify.issues));
assert(
  prepared.result.joins.every((j) => j.recipe !== "echo_out" || /hole|far|half/i.test(j.reason)),
  "echo_out without a hole/tempo reason",
);
assert(
  prepared.result.joins.every((j) => j.commit != null && j.commit.compiled_lanes > 0),
  "every join must echo a compile report with lanes",
);

// ─── resolveTransition: recipe names resolve, garbage is null (never a blend) ───
import {
  isTransitionType,
  resolveTransition,
} from "../src/set/timeline.ts";
assert(resolveTransition("power_cut")?.type === "cut", "power_cut → cut");
assert(resolveTransition("power_cut")?.via === "recipe", "power_cut via recipe");
assert(resolveTransition("bass_swap")?.type === "blend", "bass_swap → blend");
assert(resolveTransition("half_bridge")?.type === "echo_out", "half_bridge → echo_out");
assert(resolveTransition("power_block")?.type === "cut", "power_block → cut");
assert(resolveTransition("drop_swap")?.type === "drop_swap", "type passes through");
assert(resolveTransition("cut")?.via === "type", "bare type via type");
assert(resolveTransition("power_cut ")?.type === "cut", "trims whitespace");
assert(resolveTransition("garbage") === null, "garbage resolves to null");
assert(resolveTransition(42) === null, "non-string resolves to null");
assert(isTransitionType("cut") && !isTransitionType("power_cut"), "isTransitionType");

// ─── verifySet: unknown transition type is an error, not a silent blend ───
import { verifySet } from "../src/set/builder.ts";
const garbageDoc = createEmptySetDoc("Garbage");
garbageDoc.tracks = { t1: opener, t2: weapon };
garbageDoc.arrangement = [
  { id: "g0", trackId: "t1", inBars: 0, outBars: 32, transition: { type: "cut", bars: 1 } },
  {
    id: "g1",
    trackId: "t2",
    inBars: 8,
    outBars: 40,
    // Simulate a stored recipe name — the old silent-fallback path.
    transition: { type: "power_cut" as never, bars: 1 },
  },
];
const garbageGate = verifySet(garbageDoc, garbageDoc.arrangement);
assert(
  garbageGate.issues.some((i) => i.code === "unknown_transition" && i.severity === "error"),
  "unknown transition must be a verify error",
);
assert(!garbageGate.ready, "garbage transition blocks ready");
assert(
  compileTransitionAutomation(garbageDoc).length === 0,
  "unknown type compiles zero lanes (why the gate must catch it)",
);

// ─── joinCompileReport: parked drop_swap commits on the incoming drop's 1 ───
import { joinCompileReport } from "../src/set/craft.ts";
const swapReport = joinCompileReport(swapDoc, 1);
assert(swapReport != null, "swap report exists");
assert(swapReport!.compiled_lanes > 0, "swap join compiled lanes");
assert(
  swapReport!.commit_bars != null && swapReport!.commit_on_drop === true,
  `drop_swap commit must anchor on the incoming drop (commit ${swapReport!.commit_bars}, drop ${swapReport!.incoming_drop_bars})`,
);
// The drifted shape: same tracks, in_bars nudged 8 bars late → drop lands off the commit.
const driftedDoc = createEmptySetDoc("Drift");
driftedDoc.tracks = swapDoc.tracks;
driftedDoc.arrangement = swapDoc.arrangement.map((e) => ({ ...e }));
driftedDoc.arrangement[1] = {
  ...driftedDoc.arrangement[1]!,
  inBars: Math.min(40, driftedDoc.arrangement[1]!.inBars + 8),
};
const driftedReport = joinCompileReport(driftedDoc, 1);
assert(
  driftedReport != null && driftedReport.commit_on_drop === false,
  "a nudged cue must be reported as off-the-drop (narration/doc drift)",
);

// ─── prepareSet: order + join_overrides + alternatives ───
const ordered = await prepareSet(doc, {
  hear: false,
  order: ["t3", "t1", "t2"],
});
assert(
  ordered.arrangement.map((e) => e.trackId).join(",") === "t3,t1,t2",
  `explicit order must be respected, got ${ordered.arrangement.map((e) => e.trackId).join(",")}`,
);
assert(ordered.result.verify.ready, JSON.stringify(ordered.result.verify.issues));
assert(
  ordered.result.joins.every((j) => Array.isArray(j.alternatives)),
  "joins must list alternatives",
);

const overridden = await prepareSet(doc, {
  hear: false,
  trackCount: 3,
  joinOverrides: [{ index: 1, recipe: "bass_swap", bars: 8 }],
});
const oj1 = overridden.result.joins.find((j) => j.index === 1);
assert(oj1 != null, "join 1 exists");
assert(oj1!.override === true, "join 1 marked as overridden");
assert(
  oj1!.recipe === "bass_swap" || (oj1!.notes.length && oj1!.override),
  `override applied or explained, got ${oj1!.recipe}`,
);
assert(
  overridden.arrangement[1]!.transition.type === "blend" || oj1!.recipe !== "bass_swap",
  "bass_swap override compiles to a blend join",
);

const badOverride = await prepareSet(doc, {
  hear: false,
  trackCount: 3,
  joinOverrides: [{ index: 1, recipe: "not_a_recipe" }],
});
const bj1 = badOverride.result.joins.find((j) => j.index === 1);
assert(
  bj1 != null && bj1.notes.some((n) => /not_a_recipe/.test(n)),
  "unknown override recipe must be explained in notes, not silently applied",
);

// ─── toolResult: semantic truncation, never a mid-JSON preview ───
const { toolResult } = await import("../src/webmcp/toolResult.ts");
const bigLibrary = {
  tracks: Array.from({ length: 200 }, (_, i) => ({
    id: `t${i}`,
    title: `Track Number ${i} With A Longish Title`,
    bpm: 120 + (i % 20),
    key: "8A",
  })),
  total: 200,
};
const bigJson = toolResult(bigLibrary, 3000);
const parsedBig = JSON.parse(bigJson) as {
  truncated?: boolean;
  dropped?: Record<string, { returned: number; total: number }>;
  tracks?: unknown[];
};
assert(parsedBig.truncated === true, "oversized payload must be marked truncated");
assert(parsedBig.dropped?.tracks != null, "must report which list was dropped");
assert(
  parsedBig.tracks != null && parsedBig.tracks.length < 200 && parsedBig.tracks.length >= 2,
  "must keep whole items, not slice mid-JSON",
);
assert(!bigJson.includes('"title":"Track Number 199"'), "should not keep all 200 rows");
const fitsJson = toolResult({ ok: true, small: "payload" }, 3000);
assert(JSON.parse(fitsJson).small === "payload", "fitting payloads pass through untouched");
const uncapped = toolResult(bigLibrary, null);
assert(uncapped.length === JSON.stringify(bigLibrary).length, "null budget = uncapped");

// ─── echo_out compiles as a THROW, not a fade ───
const echoDoc = createEmptySetDoc("EchoThrow");
echoDoc.tracks = { m83: midnight, anyma: atNight };
echoDoc.arrangement = [
  { id: "q0", trackId: "m83", inBars: 0, outBars: 64, transition: { type: "cut", bars: 1 } },
  { id: "q1", trackId: "anyma", inBars: 0, outBars: 32, transition: { type: "echo_out", bars: 8 } },
];
const echoLanes = compileTransitionAutomation(echoDoc);
const echoFader = echoLanes.filter((l) => l.param === "fader_a" || l.param === "fader_b");
const echoHold = echoFader.find((l) => l.startValue === l.endValue && l.endValue === 0.75);
const echoCut = echoFader.find((l) => l.startValue === 0.75 && l.endValue === 0);
assert(echoHold != null, "echo must HOLD the dry fader (no fade)");
assert(echoCut != null, "echo must CUT the fader on the 1");
assert(
  echoCut != null && echoCut.endBars - echoCut.startBars <= 0.5,
  `the cut must be a cut (<0.5 bar), not a fade — got ${echoCut?.endBars ?? 0}-${echoCut?.startBars ?? 0}`,
);
const echoWet = echoLanes.filter((l) => l.param === "fx_wet");
assert(
  echoWet.some((l) => l.endValue >= 0.8 || l.startValue >= 0.8),
  "the delay must fill hard before the cut (a throw, not a wash)",
);
assert(echoWet.some((l) => l.endValue === 0 && l.endBars > 64), "wet must ring out past the leave");

// ─── air_cut: boom–pause–SLAM on a far pair ───
const noHolePeak = track(
  "slam",
  "Slam Weapon",
  analysis({
    bpm: 174,
    key: { camelot: "3A", confidence: 0.85, name: "Bbm" },
    energyLevel: 9,
    energyMean: 0.85,
    suggestedRole: "peak",
    durationBars: 40,
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "build", startBars: 16, endBars: 32, startSec: 8, endSec: 16 },
      { label: "drop", startBars: 32, endBars: 40, startSec: 16, endSec: 20 },
    ],
    energy: [0.3, 0.35, 0.4, 0.9, 0.88],
  }),
);
assert(findHoleBars(noHolePeak) === null, "slam weapon has no hole (drop runs to the end)");
const noHoleOpener = track(
  "nh1",
  "No-Hole Opener",
  analysis({
    bpm: 126,
    key: { camelot: "8A", confidence: 0.9, name: "Am" },
    energyLevel: 4,
    energyMean: 0.4,
    suggestedRole: "opener",
    durationBars: 40,
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "build", startBars: 16, endBars: 32, startSec: 8, endSec: 16 },
      { label: "drop", startBars: 32, endBars: 40, startSec: 16, endSec: 20 },
    ],
    energy: [0.3, 0.35, 0.4, 0.7],
  }),
);
assert(findHoleBars(noHoleOpener) === null, "no-hole opener fixture");
const farSlam = chooseJoinFromRecords(noHoleOpener, noHolePeak);
assert(
  farSlam.recipe === "air_cut",
  `far BPM, incoming drop, no outgoing hole must air-slam, got ${farSlam.recipe}`,
);
assert(farSlam.bars === 2, String(farSlam.bars));

const airDoc = createEmptySetDoc("AirCut");
airDoc.tracks = { t1: opener, slam: noHolePeak };
airDoc.arrangement = [
  { id: "a0", trackId: "t1", inBars: 0, outBars: 48, transition: { type: "cut", bars: 1 } },
  { id: "a1", trackId: "slam", inBars: 32, outBars: 40, transition: { type: "air_cut", bars: 2 } },
];
const airTl = buildTimeline(airDoc);
assert(airTl[1]!.overlapBars === 0, "air_cut never overlaps on the set clock");
assert(
  airTl[1]!.setStart === airTl[0]!.setEnd,
  "air_cut switches instantly on the 1 — no dead air",
);
const airLanes = compileTransitionAutomation(airDoc);
// Tension setup: the outgoing RISES (HP opens, highs lift, send swells) into
// the snap — the fake-out build. Then everything snaps on the 1.
const setupFilt = airLanes.find(
  (l) => l.param === "filter_a" && l.endValue > 0.3 && l.endValue > l.startValue,
);
assert(setupFilt != null, "air_cut needs a tension setup (HP rise) before the snap");
const airSwell = airLanes.find(
  (l) => l.param === "fx_wet" && l.endValue >= 0.3 && l.endValue > l.startValue,
);
assert(airSwell != null, "air_cut swells the send into the snap");
const airKill = airLanes.find(
  (l) => l.param === "eq_low_a" && l.endValue <= -24 && l.endBars - l.startBars < 1,
);
assert(airKill != null, "the kill snaps in under a bar on the 1");
const airSnapFilt = airLanes.find(
  (l) => l.param === "filter_a" && l.endValue <= -0.7 && l.endBars - l.startBars < 1,
);
assert(airSnapFilt != null, "the filter snaps shut with the kill");
const airGate = verifySet(airDoc, airDoc.arrangement);
assert(airGate.ready, `air_cut on a far pair must verify ready — ${JSON.stringify(airGate.issues)}`);

// The quiet-deck bug: kill lanes HOLD — the spent channel must be restored to
// defaults after the flip, or the next entry on that deck plays dead.
const flipDone = airTl[0]!.setEnd + 0.25;
const restoredFader = airLanes.find(
  (l) =>
    l.param === "fader_a" &&
    l.startValue === 0.75 &&
    l.endValue === 0.75 &&
    l.startBars >= flipDone,
);
assert(restoredFader != null, "air_cut must restore the spent deck's fader (quiet-deck bug)");
const restoredLow = airLanes.find(
  (l) => l.param === "eq_low_a" && l.endValue === 0 && l.startBars >= flipDone,
);
assert(restoredLow != null, "air_cut must restore the spent deck's bass (dead-bass bug)");

// Same class of bug on plain cuts — the chronic thin/quiet reuse.
const cutDoc = createEmptySetDoc("CutRestore");
cutDoc.tracks = { t1: opener, t2: weapon };
cutDoc.arrangement = [
  { id: "c0", trackId: "t1", inBars: 0, outBars: 48, transition: { type: "cut", bars: 1 } },
  { id: "c1", trackId: "t2", inBars: 32, outBars: 64, transition: { type: "cut", bars: 1 } },
];
const cutLanes = compileTransitionAutomation(cutDoc);
const cutRestoredLow = cutLanes.find(
  (l) => l.param === "eq_low_a" && l.endValue === 0 && l.startBars > 48,
);
assert(cutRestoredLow != null, "cut must restore the spent deck's bass after the join");

// ─── slam joins are not failed for far BPM / jaws / caps (the backspin bug) ───
const { previewJoin } = await import("../src/set/previewJoin.ts");
const adriatique = track(
  "adri",
  "In the Moment",
  analysis({
    bpm: 129.2,
    key: { camelot: "3A", confidence: 0.31, name: "Bbm" },
    energyLevel: 8,
    energyMean: 0.78,
    suggestedRole: "peak",
    durationBars: 128,
    sections: [
      { label: "intro", startBars: 0, endBars: 32, startSec: 0, endSec: 16 },
      { label: "build", startBars: 104, endBars: 120, startSec: 52, endSec: 60 },
      { label: "drop", startBars: 120, endBars: 128, startSec: 60, endSec: 64 },
    ],
    energy: [0.3, 0.35, 0.4, 0.9, 0.5, 0.4],
  }),
);
const spinDoc = createEmptySetDoc("Spin");
spinDoc.tracks = { m83: midnight, adri: adriatique };
spinDoc.arrangement = [
  { id: "s0", trackId: "m83", inBars: 0, outBars: 96, transition: { type: "cut", bars: 1 } },
  { id: "s1", trackId: "adri", inBars: 120, outBars: 128, transition: { type: "backspin", bars: 2 } },
];
const spinEar = await previewJoin(spinDoc, 1, false);
assert(
  spinEar.verdict !== "fail",
  `backspin on a jaws/far pair must not fail the ear (got ${spinEar.verdict}: ${spinEar.notes.join(" / ")})`,
);
assert(
  spinEar.notes.some((n) => /slam/i.test(n)),
  "the ear should say this is a slam join",
);

// jaws with a drop: the audio gets the final word — compatible chroma through
// the hole unlocks a blend the label condemns; clashing chroma earns the slam.
const jawsPick = chooseJoinFromRecords(midnight, adriatique);
assert(
  jawsPick.recipe === "tease_slam" ||
    jawsPick.recipe === "air_cut" ||
    jawsPick.recipe === "echo_out",
  `jaws in chop: tease (filtered, masked) or slam, got ${jawsPick.recipe}`,
);

// ─── audition: audio truth over labels ───
const { auditionHarmony } = await import("../src/set/builder.ts");
const amTrack = track("am1", "Am Root", analysis({ bpm: 126, key: { camelot: "8A", confidence: 0.9, name: "Am" } }));
const tritoneTrack = track("tt1", "Tritone Root", analysis({
  bpm: 126,
  key: { camelot: "8A", confidence: 0.9, name: "Am" },
  chromaCurve: Array.from({ length: 12 }, () => [...TRITONE_CHROMA]),
}));
const noCurveTrack = track("nc1", "Old Analysis", {
  ...amTrack,
  analysis: { ...amTrack.analysis!, chromaCurve: undefined },
});

const okAud = auditionHarmony(amTrack, 40, 48, amTrack, 16, 24);
assert(okAud.verdict === "blend_ok", `same-root windows must audition blend_ok, got ${okAud.verdict} (${okAud.score})`);
const clashAud = auditionHarmony(amTrack, 40, 48, tritoneTrack, 16, 24);
assert(clashAud.verdict === "clash", `tritone windows must audition clash, got ${clashAud.verdict} (${clashAud.score})`);
const unknownAud = auditionHarmony(amTrack, 40, 48, noCurveTrack, 16, 24);
assert(unknownAud.verdict === "unknown", "missing chroma curve must audition unknown");

// Clashing chroma through the hole: the slam is now earned by evidence.
const clashJaws = chooseJoinFromRecords(midnight, {
  ...adriatique,
  analysis: { ...adriatique.analysis!, chromaCurve: Array.from({ length: 12 }, () => [...TRITONE_CHROMA]) },
});
assert(
  clashJaws.recipe === "tease_slam" ||
    clashJaws.recipe === "air_cut" ||
    clashJaws.recipe === "echo_out" ||
    clashJaws.recipe === "power_cut",
  `measured clash in chop: filtered tease or slam, got ${clashJaws.recipe}`,
);

// ─── hole-parked blend end-to-end: verify + preview bless what labels condemn ───
const holeBlendDoc = createEmptySetDoc("HoleBlend");
holeBlendDoc.tracks = { m83: midnight, adri: adriatique };
holeBlendDoc.arrangement = [
  { id: "hb0", trackId: "m83", inBars: 0, outBars: 72, transition: { type: "cut", bars: 1 } },
  { id: "hb1", trackId: "adri", inBars: 32, outBars: 80, transition: { type: "blend", bars: 8 } },
];
const holeBlendGate = verifySet(holeBlendDoc, holeBlendDoc.arrangement);
assert(
  !holeBlendGate.issues.some((i) => i.code === "key_clash" || i.code === "key_unknown_pad"),
  `a hole-parked, audition-ok blend must not be label-blocked — ${JSON.stringify(holeBlendGate.issues)}`,
);
assert(
  holeBlendGate.issues.some((i) => i.code === "hole_parked_blend" || i.code === "harmony_audition"),
  "the gate should note the hole park / audition",
);
const holeBlendEar = await previewJoin(holeBlendDoc, 1, false);
assert(
  holeBlendEar.verdict !== "fail",
  `hole-parked blend must not fail the ear (${holeBlendEar.verdict}: ${holeBlendEar.notes.join(" / ")})`,
);
assert(holeBlendEar.harmony?.verdict === "blend_ok", "the ear must carry the audition");

// Measured clash vetoes a label-blessed pad blend.
const vetoDoc = createEmptySetDoc("Veto");
vetoDoc.tracks = { am: amTrack, tt: tritoneTrack };
vetoDoc.arrangement = [
  { id: "v0", trackId: "am", inBars: 0, outBars: 48, transition: { type: "cut", bars: 1 } },
  { id: "v1", trackId: "tt", inBars: 32, outBars: 64, transition: { type: "blend", bars: 8 } },
];
const vetoGate = verifySet(vetoDoc, vetoDoc.arrangement);
assert(
  vetoGate.issues.some((i) => i.code === "harmony_audition" && i.severity === "error"),
  "a measured clash on a pad blend must be an error",
);
assert(!vetoGate.ready, "measured clash must block the blend");

// ─── order optimizer: the user's four-track crate ───
// Midnight City 107.7/10A · The Nights 129.2/2A · At Night 129.2/8A ·
// In the Moment 129.2/3A — the order that maximized slams under the energy
// ladder. The path DP should put 2A→3A adjacent and the far-BPM track at a
// boundary where its slam is earned.
const nightsTrack = track(
  "nights",
  "The Nights",
  analysis({
    bpm: 129.2,
    key: { camelot: "2A", confidence: 0.31, name: "Ebm" },
    energyLevel: 7,
    energyMean: 0.65,
    suggestedRole: "builder",
    vocalLead: true,
    durationBars: 104,
    vocalRegions: [{ startSec: 10, endSec: 60, startBars: 20, endBars: 76 }],
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "verse", startBars: 16, endBars: 48, startSec: 8, endSec: 24 },
      { label: "build", startBars: 48, endBars: 64, startSec: 24, endSec: 32 },
      { label: "drop", startBars: 64, endBars: 96, startSec: 32, endSec: 48 },
      { label: "outro", startBars: 96, endBars: 104, startSec: 48, endSec: 52 },
    ],
    energy: [0.3, 0.4, 0.6, 0.9, 0.7, 0.4],
  }),
);
const atNightTrack = track(
  "atnight",
  "At Night",
  analysis({
    bpm: 129.2,
    key: { camelot: "8A", confidence: 0.31, name: "Am" },
    energyLevel: 9,
    energyMean: 0.82,
    suggestedRole: "peak",
    durationBars: 104,
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "build", startBars: 16, endBars: 32, startSec: 8, endSec: 16 },
      { label: "drop", startBars: 32, endBars: 72, startSec: 16, endSec: 36 },
      { label: "breakdown", startBars: 72, endBars: 88, startSec: 36, endSec: 44 },
      { label: "drop", startBars: 88, endBars: 104, startSec: 44, endSec: 52 },
    ],
    energy: [0.3, 0.35, 0.4, 0.9, 0.5, 0.4, 0.95, 0.4],
  }),
);
const momentTrack = track(
  "moment",
  "In the Moment",
  analysis({
    bpm: 129.2,
    key: { camelot: "3A", confidence: 0.31, name: "Bbm" },
    energyLevel: 8,
    energyMean: 0.75,
    suggestedRole: "peak",
    durationBars: 136,
    sections: [
      { label: "intro", startBars: 0, endBars: 32, startSec: 0, endSec: 16 },
      { label: "build", startBars: 32, endBars: 120, startSec: 16, endSec: 60 },
      { label: "drop", startBars: 120, endBars: 136, startSec: 60, endSec: 68 },
    ],
    energy: [0.3, 0.4, 0.5, 0.6, 0.7, 0.95, 0.5],
  }),
);
const crateDoc = createEmptySetDoc("Crate");
crateDoc.tracks = {
  m83: midnight,
  nights: nightsTrack,
  atnight: atNightTrack,
  moment: momentTrack,
};
const cratePlan = planSetArc(crateDoc, "journey", 4);
assert(cratePlan.via === "path-dp", `optimizer must run on a 4-track crate, got ${cratePlan.via}`);
const crateOrder = cratePlan.entries.map((e) => e.track_id);
assert(crateOrder.length === 4, `all four tracks picked, got ${crateOrder.join(",")}`);
assert(
  crateOrder[0] === "m83" || crateOrder[3] === "m83",
  `the far-BPM anthem belongs at a boundary, got ${crateOrder.join(",")}`,
);
let crateSlams = 0;
for (let k = 1; k < crateOrder.length; k++) {
  const a = crateDoc.tracks[crateOrder[k - 1]!]!;
  const b = crateDoc.tracks[crateOrder[k]!]!;
  if (isSlamRecipe(chooseJoinFromRecords(a, b).recipe)) crateSlams++;
}
assert(
  crateSlams >= 2,
  `chop order should slam, got ${crateSlams} (${crateOrder.join(",")})`,
);

// Full compose: slams, no intro exposure, short clips.
const cratePrep = await prepareSet(crateDoc, { hear: false, trackCount: 4 });
assert(cratePrep.result.verify.ready, JSON.stringify(cratePrep.result.verify.issues));
const slamJoins = cratePrep.result.joins.filter((j) => isSlamRecipe(j.recipe)).length;
console.log(
  "crate set:",
  cratePrep.result.entries.map((e) => e.title).join(" → "),
  "|",
  cratePrep.result.joins.map((j) => `${j.recipe}/${j.bars} ${j.verdict}`).join(", "),
);
assert(
  slamJoins >= 2,
  `chop set must slam — joins: ${cratePrep.result.joins.map((j) => j.recipe).join(",")}`,
);
assert(
  cratePrep.result.entries.every((e) => e.in_bars >= 8),
  `no radio intros: ${cratePrep.result.entries.map((e) => `${e.title}@${e.in_bars}`).join(", ")}`,
);
assert(
  cratePrep.result.entries.every((e) => e.out_bars - e.in_bars <= 40),
  `clips must be short, got ${cratePrep.result.entries.map((e) => e.out_bars - e.in_bars).join(",")}`,
);

// ─── closer lands on its drop, not from silence ───
const closerPrep = await prepareSet(crateDoc, {
  hear: false,
  order: ["m83", "atnight"],
});
const closerJoin = closerPrep.result.joins.find((j) => j.index === 1);
assert(
  closerJoin != null && closerJoin.recipe !== "echo_out" && closerJoin.recipe !== "half_bridge",
  `a closer with a drop must land (air_cut/backspin/cut), not enter from silence — got ${closerJoin?.recipe}`,
);

// ─── tempo_ride: 6–10% BPM gaps are ridable blends, not slams ───
const rideOut = track(
  "ro",
  "Ride Opener",
  analysis({
    bpm: 118,
    key: { camelot: "8A", confidence: 0.9, name: "Am" },
    energyLevel: 5,
    energyMean: 0.5,
    suggestedRole: "builder",
  }),
);
const rideIn = track(
  "ri",
  "Ride Peak",
  analysis({
    bpm: 128,
    key: { camelot: "9A", confidence: 0.85, name: "Em" },
    energyLevel: 9,
    energyMean: 0.82,
    suggestedRole: "peak",
    durationBars: 80,
    sections: [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "build", startBars: 24, endBars: 40, startSec: 12, endSec: 20 },
      { label: "drop", startBars: 40, endBars: 72, startSec: 20, endSec: 36 },
      { label: "outro", startBars: 72, endBars: 80, startSec: 36, endSec: 40 },
    ],
    energy: [0.3, 0.35, 0.4, 0.9, 0.85, 0.5],
  }),
);
const ridePick = chooseJoinFromRecords(rideOut, rideIn, "blend");
assert(
  ridePick.recipe === "tempo_ride",
  `a +8.5% gap on adjacent keys must ride in blend grammar, got ${ridePick.recipe}`,
);
assert(ridePick.bars === 16, String(ridePick.bars));
assert(
  chooseJoinFromRecords(rideOut, rideIn).recipe !== "tempo_ride",
  "chop default must not tempo-ride",
);

const overGap = chooseJoinFromRecords(midnight, atNight);
assert(overGap.recipe !== "tempo_ride", "+20% must not ride (slam/throw instead)");

const rideDoc = createEmptySetDoc("Ride");
rideDoc.tracks = { ro: rideOut, ri: rideIn };
const ridePrep = await prepareSet(rideDoc, { hear: false, trackCount: 2, intent: "smooth blend" });
const rideJoin = ridePrep.result.joins.find((j) => j.index === 1);
assert(rideJoin != null, "ride join exists");
assert(
  rideJoin!.recipe === "tempo_ride",
  `prepare must keep the ride, got ${rideJoin!.recipe}`,
);
assert(
  ridePrep.automation.some(
    (l) =>
      l.param === "tempo" &&
      Math.abs(l.startValue - 118) < 0.01 &&
      Math.abs(l.endValue - 128) < 0.01,
  ),
  "the ride must generate the tempo lane 118→128",
);
assert(
  rideJoin!.verdict !== "fail",
  `the ear must not fail a legal ride (${rideJoin!.verdict}: ${rideJoin!.notes.join(" / ")})`,
);
assert(
  rideJoin!.notes.some((n) => /[Rr]ide/.test(n)),
  "the ear should explain the ride",
);
assert(
  rideJoin!.commit?.commit_on_drop === true,
  "the ride commit must anchor on the incoming drop",
);
assert(ridePrep.result.verify.ready, JSON.stringify(ridePrep.result.verify.issues));

// A ride without its tempo lane is a broken mix — verify must say so.
const rideBare = createEmptySetDoc("RideBare");
rideBare.tracks = { ro: rideOut, ri: rideIn };
rideBare.arrangement = [
  { id: "rb0", trackId: "ro", inBars: 0, outBars: 40, transition: { type: "cut", bars: 1 } },
  { id: "rb1", trackId: "ri", inBars: 32, outBars: 80, transition: { type: "tempo_ride", bars: 16 } },
];
const bareGate = verifySet(rideBare, rideBare.arrangement);
assert(
  bareGate.issues.some((i) => i.code === "bpm_no_ramp" && i.severity === "error"),
  "tempo_ride without a tempo lane must fail verify",
);
assert(!bareGate.ready, "bare ride must not be ready");

// ─── clockBpmAt: un-laned overlaps follow the OUTGOING deck (drift fix) ───
{
  const clockDoc = createEmptySetDoc("Clock");
  clockDoc.tracks = { t1: opener, t2: weapon }; // 126 vs 128
  clockDoc.arrangement = [
    { id: "ck0", trackId: "t1", inBars: 0, outBars: 32, transition: { type: "cut", bars: 1 } },
    { id: "ck1", trackId: "t2", inBars: 8, outBars: 40, transition: { type: "tease_slam", bars: 16 } },
  ];
  // spans: [0,32] deck A, [16,48] deck B — overlap [16,32].
  assert(clockBpmAt(clockDoc, 10) === 126, "solo stretch follows the playing deck");
  assert(
    clockBpmAt(clockDoc, 24) === 126,
    `un-laned overlap must follow the OUTGOING deck (both decks rate-match to it), got ${clockBpmAt(clockDoc, 24)}`,
  );
  assert(clockBpmAt(clockDoc, 40) === 128, "after the commit the clock is the incoming's");
  const laned = {
    ...clockDoc,
    automation: [
      {
        id: "tl1",
        param: "tempo" as const,
        startBars: 16,
        endBars: 32,
        startValue: 126,
        endValue: 128,
        curve: "linear" as const,
      },
    ],
  };
  const mid = clockBpmAt(laned, 24);
  assert(Math.abs(mid - 127) < 0.2, `the tempo lane drives the clock mid-ride, got ${mid}`);
}

// ─── reviewBounce: the agent's ear measures the render, not the narration ───
const { reviewBounce } = await import("../src/set/reviewSet.ts");
{
  const sr = 44100;
  const secPerBar = 2; // linear map: 120bpm 4/4
  const durBars = 48;
  const len = Math.floor(durBars * secPerBar * sr);
  const mkSamples = (shape: (bar: number) => { full: number; mid: number }) => {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const bar = i / (sr * secPerBar);
      const { full, mid } = shape(bar);
      const t = i / sr;
      out[i] = full * Math.sin(2 * Math.PI * 110 * t) + mid * Math.sin(2 * Math.PI * 880 * t);
    }
    return out;
  };
  const revDoc = createEmptySetDoc("Review");
  revDoc.tracks = { t1: opener, t2: weapon };
  revDoc.arrangement = [
    { id: "r0", trackId: "t1", inBars: 0, outBars: 32, transition: { type: "cut", bars: 1 } },
    { id: "r1", trackId: "t2", inBars: 8, outBars: 40, transition: { type: "tease_slam", bars: 16 } },
  ];
  const linearMap = (b: number) => b * secPerBar;

  // Good join: steady lows, mids rise through the tease, slight lift on the 1.
  const good = mkSamples((bar) => ({
    full: bar >= 32 ? 0.17 : 0.15,
    mid: bar < 16 ? 0.05 : bar < 32 ? 0.05 + 0.1 * ((bar - 16) / 16) : 0.15,
  }));
  const goodReview = reviewBounce(revDoc, good, sr, linearMap);
  assert(goodReview.joins.length === 1, "one join reviewed");
  const gj = goodReview.joins[0]!;
  assert(gj.verdict === "clean", `good join must measure clean, got ${gj.verdict}: ${gj.notes.join(" / ")}`);
  assert(gj.dead_air === false, "no dead air on a full render");
  assert(gj.tease_rise != null && gj.tease_rise > 1.05, `tease must rise, got ${gj.tease_rise}`);
  assert(gj.drop_punch != null && gj.drop_punch >= 0.98, `the 1 must lift, got ${gj.drop_punch}`);
  assert(gj.bass_stack != null && gj.bass_stack < 1.5, `one bass at a time, got ${gj.bass_stack}`);
  assert(goodReview.ready, "clean review is ready");

  // Dead air at the commit → broken.
  const gapped = mkSamples((bar) => ({
    full: bar >= 31.5 && bar < 33 ? 0 : 0.15,
    mid: bar >= 31.5 && bar < 33 ? 0 : 0.05,
  }));
  const gapReview = reviewBounce(revDoc, gapped, sr, linearMap);
  assert(gapReview.joins[0]!.dead_air === true, "silence at the 1 must flag dead air");
  assert(gapReview.joins[0]!.verdict === "broken", "dead air breaks the join");
  assert(!gapReview.ready, "broken join blocks ready");

  // Hot slam: post-commit runs 4× the build → rough level jump.
  const hot = mkSamples((bar) => ({ full: bar >= 32 ? 0.6 : 0.15, mid: 0.05 }));
  const hotReview = reviewBounce(revDoc, hot, sr, linearMap);
  assert(hotReview.joins[0]!.verdict === "rough", `hot slam must be rough, got ${hotReview.joins[0]!.verdict}`);
  assert(
    Math.abs(hotReview.joins[0]!.level_jump_db ?? 0) > 6,
    `jump must be measured, got ${hotReview.joins[0]!.level_jump_db}`,
  );
}

console.log("prepare-smoke ok");
console.log("inferred", prepared.result.inferred);
console.log(
  "joins",
  prepared.result.joins.map(
    (j) =>
      `${j.recipe} ${j.bars} ${j.verdict} retries=${j.retries} — ${j.reason}` +
      (j.notes.length ? ` | notes: ${j.notes.join(" / ")}` : "") +
      (j.alternatives.length
        ? ` | alt: ${j.alternatives.map((a) => `${a.recipe} ${a.bars}`).join(", ")}`
        : "") +
      (j.tries.some((t) => !t.pass)
        ? ` | failed picks: ${j.tries.filter((t) => !t.pass).map((t) => `${t.recipe} ${t.bars} (${t.why})`).join(" | ")}`
        : "") +
      (j.commit ? ` | commit@${j.commit.commit_bars} drop@${j.commit.incoming_drop_bars} onDrop=${j.commit.commit_on_drop}` : ""),
  ),
);
