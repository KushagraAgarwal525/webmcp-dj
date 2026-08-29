/**
 * Prepare-set loop on synthetic crate cards (no browser / PCM).
 * Usage: npx tsx scripts/prepare-smoke.mts
 */
import { createEmptySetDoc, type Track, type TrackAnalysis } from "../src/types/setdoc.ts";
import { chooseJoinFromRecords, inferNight, prepareSet } from "../src/set/prepareSet.ts";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

function analysis(partial: Partial<TrackAnalysis> & Pick<TrackAnalysis, "bpm" | "key">): TrackAnalysis {
  const durationBars = partial.durationBars ?? 64;
  return {
    durationSec: durationBars * 0.5,
    durationBars,
    beats: [],
    downbeats: [],
    sections: partial.sections ?? [
      { label: "intro", startBars: 0, endBars: 16, startSec: 0, endSec: 8 },
      { label: "build", startBars: 16, endBars: 32, startSec: 8, endSec: 16 },
      { label: "drop", startBars: 32, endBars: 48, startSec: 16, endSec: 24 },
      { label: "breakdown", startBars: 48, endBars: 56, startSec: 24, endSec: 28 },
      { label: "outro", startBars: 56, endBars: 64, startSec: 28, endSec: 32 },
    ],
    energy: [0.3, 0.45, 0.8, 0.55],
    energyMean: partial.energyMean ?? 0.55,
    energyLevel: partial.energyLevel ?? 6,
    waveform: {
      samplesPerPeak: 1024,
      peaks: [0.2, 0.35, 0.7, 0.4],
      low: [0.1, 0.2, 0.5, 0.2],
      mid: [0.15, 0.25, 0.4, 0.2],
      high: [0.1, 0.15, 0.3, 0.15],
    },
    analyzedAt: Date.now(),
    ...partial,
  };
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
assert(replace.recipe === "drop_swap" || replace.recipe === "double_drop", `expected drop join, got ${replace.recipe}`);

const stackish = chooseJoinFromRecords(weapon, opener);
assert(stackish.recipe !== "echo_out", "echo_out must not be the default");

const half = chooseJoinFromRecords(opener, far);
assert(half.recipe === "half_bridge" || half.recipe === "power_cut" || half.recipe === "echo_out", half.recipe);

const twoVox = chooseJoinFromRecords(vocal, vocal);
assert(twoVox.recipe === "drop_swap" || twoVox.recipe === "eq_swap", twoVox.recipe);

const doc = createEmptySetDoc("Smoke");
doc.tracks = { t1: opener, t2: weapon, t3: vocal };
doc.crates.all!.trackIds = ["t1", "t2", "t3"];

const night = inferNight(doc);
assert(night.arc === "journey" || night.arc === "warm_up" || night.arc === "peak_time", night.arc);

const prepared = await prepareSet(doc, { hear: false, trackCount: 3 });
assert(prepared.arrangement.length >= 2, "need a set");
assert(prepared.result.verify.ready, JSON.stringify(prepared.result.verify.issues));
assert(
  prepared.result.joins.every((j) => j.recipe !== "echo_out" || /hole|far|half/i.test(j.reason)),
  "echo_out without a hole/tempo reason",
);

console.log("prepare-smoke ok");
console.log("inferred", prepared.result.inferred);
console.log(
  "joins",
  prepared.result.joins.map((j) => `${j.recipe} ${j.verdict} — ${j.reason}`),
);
