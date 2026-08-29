/**
 * Synthetic PCM checks for the analysis rebuild (no browser).
 * Usage: npx tsx scripts/analysis-smoke.mts
 */
import { analyzePcm } from "../src/analysis/analyzePcm.ts";
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
  role: result.suggestedRole,
  genre: result.genreHint,
  mood: result.mood,
  vocalLead: result.vocalLead,
  sections: result.sections.map((s) => `${s.label} ${s.startBars.toFixed(0)}–${s.endBars.toFixed(0)}`),
  beats: result.beats.length,
  downbeats: result.downbeats.length,
});

assert(result.bpm >= 120 && result.bpm <= 136, `BPM expected ~128, got ${result.bpm}`);
assert(
  result.key.camelot === "8A" || result.key.name === "Am" || result.key.camelot.endsWith("A"),
  `Key expected Am/8A-ish, got ${result.key.camelot} ${result.key.name}`,
);
assert(result.key.confidence > 0.2 && result.key.confidence < 0.96, "confidence should be real, not hardcoded 0.35");
assert(result.beats.length > 40, "beat grid should be onset-aligned, not empty");
assert(result.downbeats.length > 8, "downbeats missing");
assert(result.energyLevel != null && result.energyLevel >= 1 && result.energyLevel <= 10, "energy 1–10");
assert(result.suggestedRole, "role tag missing");
assert(result.sections.length >= 2, "need phrase-snapped sections");
assert(classifyCamelotMove("8A", "8B") === "relative", "relative major/minor");
assert(classifyCamelotMove("8A", "9A") === "adjacent", "adjacent");
assert(classifyCamelotMove("8A", "10A") === "energy_boost", "energy boost");
assert(classifyCamelotMove("8A", "3A") === "jaws", "jaws");
assert(tempoRelation(87, 174) === "double", "half/double helper");
assert(tempoRelation(174, 87) === "half", "half helper");

console.log("analysis-smoke: ok");
