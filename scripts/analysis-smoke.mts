/**
 * Synthetic PCM checks for the analysis rebuild (no browser).
 * Usage: npx tsx scripts/analysis-smoke.mts
 */
import { analyzePcm, heatWindowFromEnergy, salienceDropBars } from "../src/analysis/analyzePcm.ts";
import { classifyCamelotMove } from "../src/set/builder.ts";
import { tempoRelation } from "../src/set/craft.ts";

function sine(sr: number, sec: number, hz: number, amp = 0.25) {
  const n = Math.floor(sr * sec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sr) * amp;
  return out;
}

function mix(...bufs: Float32Array[]) {
  const n = Math.max(...bufs.map((b) => b.length));
  const out = new Float32Array(n);
  for (const b of bufs) {
    for (let i = 0; i < b.length; i++) out[i]! += b[i]!;
  }
  return out;
}

function kickTrain(sr: number, sec: number, bpm: number) {
  const n = Math.floor(sr * sec);
  const out = new Float32Array(n);
  const interval = (60 / bpm) * sr;
  const kickLen = Math.floor(sr * 0.04);
  for (let t = 0; t < n; t += interval) {
    const start = Math.floor(t);
    for (let i = 0; i < kickLen && start + i < n; i++) {
      const env = Math.exp(-i / (sr * 0.012));
      out[start + i]! += Math.sin((2 * Math.PI * 55 * i) / sr) * env * 0.9;
    }
  }
  return out;
}

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

const sr = 22050;
const am = mix(
  kickTrain(sr, 32, 128),
  sine(sr, 32, 220, 0.18),
  sine(sr, 32, 261.63, 0.12),
  sine(sr, 32, 329.63, 0.1),
);
const result = analyzePcm(am, sr);

console.log({
  bpm: result.bpm,
  key: result.key,
  energyLevel: result.energyLevel,
  timbre: result.timbre,
  brightness: result.brightness,
  dropBars: result.dropBars,
  heat: [result.heatInBars, result.heatOutBars],
  detector: result.detector,
  vocalLead: result.vocalLead,
  sections: result.sections.map((s) => `${s.label} ${s.startBars.toFixed(0)}–${s.endBars.toFixed(0)}`),
  beats: result.beats.length,
  downbeats: result.downbeats.length,
});

assert(result.mood === undefined, "detector must not guess mood");
assert(result.genreHint === undefined, "detector must not guess genre");
assert(result.suggestedRole === undefined, "detector must not assign set roles");
assert(result.key.profile === "edma", "key must use edma profiles");
assert(result.detector === "salience-v1", "detector generation");
assert(result.dropBars != null, "measured drop");
assert(result.heatInBars != null && result.heatOutBars != null, "heat window");
assert(result.brightness != null, "brightness");
assert(
  result.timbre === "bright" || result.timbre === "dark" || result.timbre === "warm",
  "measured timbre must be present",
);
assert(result.bpm >= 120 && result.bpm <= 136, `BPM expected ~128, got ${result.bpm}`);
assert(
  result.key.camelot === "8A" || result.key.name === "Am" || result.key.camelot.endsWith("A"),
  `Key expected Am/8A-ish, got ${result.key.camelot} ${result.key.name}`,
);
assert(result.key.confidence > 0.2 && result.key.confidence < 0.96, "confidence should be real, not hardcoded 0.35");
assert(result.beats.length > 40, "beat grid should be onset-aligned, not empty");
assert(result.downbeats.length > 8, "downbeats missing");
assert(result.energyLevel != null && result.energyLevel >= 1 && result.energyLevel <= 10, "energy 1–10");
// Roles are curated (tag_track) — the salience detector stopped guessing them,
// same principle as mood/genre: measure, don't infer taste.
assert(result.suggestedRole === undefined, "detector must not guess role");
// The synthetic signal is one loud 17-bar blob — an honest EDM segmenter
// finds no boundaries in it. Structure contracts are the eval corpus's job.
assert(result.sections.length >= 1, "segmenter must emit at least one section");
assert(result.dropBars != null, "measured salience drop must be present");
assert(classifyCamelotMove("8A", "8B") === "relative", "relative major/minor");
assert(classifyCamelotMove("8A", "9A") === "adjacent", "adjacent");
assert(classifyCamelotMove("8A", "10A") === "energy_boost", "energy boost");
assert(classifyCamelotMove("8A", "3A") === "jaws", "jaws");
assert(tempoRelation(87, 174) === "double", "half/double helper");
assert(tempoRelation(174, 87) === "half", "half helper");

const quietThenLoud = [
  ...Array.from({ length: 48 }, () => 0.18),
  ...Array.from({ length: 32 }, () => 0.95),
  ...Array.from({ length: 16 }, () => 0.4),
];
const novelty = quietThenLoud.map((_, i) => (i === 48 ? 1 : 0.08));
const drop = salienceDropBars(quietThenLoud, quietThenLoud, novelty);
assert(drop >= 40 && drop <= 56, `salience drop must not be bar 0, got ${drop}`);
const heat = heatWindowFromEnergy(quietThenLoud, quietThenLoud.length);
assert(heat.inBars >= 32, `heat window on the loud part, got ${heat.inBars}`);

console.log("analysis-smoke: ok");
