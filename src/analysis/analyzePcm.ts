import type { SectionLabel, TrackAnalysis, WaveformPeaks } from "../types/setdoc";
import { downsampleMono, fft, hann, hzToPitchClass, mean } from "./dsp";

/** Faraldo et al. EDM key profiles (Essentia `edma`). Minor-key EDM is the norm — Krumhansl is not. */
const EDMA_MAJOR = [1.0, 0.29, 0.5, 0.4, 0.6, 0.56, 0.32, 0.8, 0.31, 0.45, 0.42, 0.39];
const EDMA_MINOR = [1.0, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32];

const MAJOR_CAMELOT = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"];
const MINOR_CAMELOT = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"];
const KEY_NAMES_MAJ = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const KEY_NAMES_MIN = ["Cm", "C#m", "Dm", "D#m", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "A#m", "Bm"];

function correlate(chroma: Float32Array, profile: number[], root: number) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += chroma[i]! * profile[(i - root + 12) % 12]!;
  return s;
}

function estimateKey(chroma: Float32Array): TrackAnalysis["key"] {
  let best = -Infinity;
  let second = -Infinity;
  let bestRoot = 0;
  let bestMinor = true;
  for (let root = 0; root < 12; root++) {
    const maj = correlate(chroma, EDMA_MAJOR, root);
    const min = correlate(chroma, EDMA_MINOR, root);
    const pair: [number, boolean][] = [
      [maj, false],
      [min, true],
    ];
    for (const [score, minor] of pair) {
      if (score > best) {
        second = best;
        best = score;
        bestRoot = root;
        bestMinor = minor;
      } else if (score > second) {
        second = score;
      }
    }
  }
  const chromaMax = Math.max(...chroma, 1e-9);
  const chromaSum = chroma.reduce((a, b) => a + b, 0);
  const peaked = chromaMax / Math.max(chromaSum / 12, 1e-9);
  const sep = best > 0 ? (best - Math.max(second, 0)) / best : 0;
  const confidence = Number(Math.min(0.95, Math.max(0.15, 0.25 + sep * 0.5 + Math.min(0.2, peaked * 0.04))).toFixed(2));
  return {
    camelot: (bestMinor ? MINOR_CAMELOT : MAJOR_CAMELOT)[bestRoot]!,
    confidence,
    name: (bestMinor ? KEY_NAMES_MIN : KEY_NAMES_MAJ)[bestRoot],
    profile: "edma",
  };
}

function sumChroma(frames: FrameBands[], from: number, to: number): Float32Array {
  const sum = new Float32Array(12);
  const a = Math.max(0, from);
  const b = Math.min(frames.length, Math.max(a + 1, to));
  for (let i = a; i < b; i++) {
    const ch = frames[i]?.chroma;
    if (!ch) continue;
    for (let c = 0; c < 12; c++) sum[c]! += ch[c]!;
  }
  return sum;
}

function resampleToBars(curve: number[], nBars: number): number[] {
  const n = Math.max(1, nBars);
  if (curve.length < 2) return Array.from({ length: n }, () => curve[0] ?? 0);
  const out: number[] = [];
  for (let b = 0; b < n; b++) {
    const a = (b / n) * (curve.length - 1);
    const i = Math.floor(a);
    const f = a - i;
    const lo = curve[i] ?? 0;
    const hi = curve[Math.min(curve.length - 1, i + 1)] ?? lo;
    out.push(lo * (1 - f) + hi * f);
  }
  return out;
}

function cosine(a: number[], b: number[]) {
  let d = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return d / (Math.sqrt(na * nb) + 1e-9);
}

/** Foote (2000) checkerboard novelty on a feature sequence (Müller FMP C4.4). */
export function footeNovelty(seq: number[][], kernelHalf = 4): number[] {
  const n = seq.length;
  if (n < 4) return seq.map(() => 0);
  const L = Math.max(2, kernelHalf);
  const M = 2 * L + 1;
  const kernel: number[][] = [];
  let ksum = 0;
  for (let i = 0; i < M; i++) {
    const row: number[] = [];
    const si = Math.sign(i - L);
    for (let j = 0; j < M; j++) {
      const sj = Math.sign(j - L);
      const g = Math.exp(-0.5 * (((i - L) / L) ** 2 + ((j - L) / L) ** 2));
      const v = si * sj * g;
      row.push(v);
      ksum += Math.abs(v);
    }
    kernel.push(row);
  }
  if (ksum > 0) {
    for (const row of kernel) for (let j = 0; j < row.length; j++) row[j]! /= ksum;
  }
  const S: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    S[i]![i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = cosine(seq[i]!, seq[j]!);
      S[i]![j] = c;
      S[j]![i] = c;
    }
  }
  const nov = new Array(n).fill(0);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let ki = 0; ki < M; ki++) {
      for (let kj = 0; kj < M; kj++) {
        const i = t + ki - L;
        const j = t + kj - L;
        const sv = i >= 0 && i < n && j >= 0 && j < n ? S[i]![j]! : 0;
        s += kernel[ki]![kj]! * sv;
      }
    }
    nov[t] = Math.max(0, s);
  }
  return nov;
}

export function heatWindowFromEnergy(
  energy: number[],
  durationBars: number,
  win = 16,
  phrase = 8,
): { inBars: number; outBars: number } {
  const nBars = Math.max(1, Math.round(durationBars));
  if (!energy.length || nBars < 4) return { inBars: 0, outBars: Math.max(8, nBars) };
  const barE = energy.length === nBars ? energy : resampleToBars(energy, nBars);
  const w = Math.min(Math.max(8, win), Math.max(8, nBars));
  let best = 0;
  let bestS = -Infinity;
  const step = Math.min(phrase, 8);
  for (let s = 0; s + Math.min(w, nBars) <= nBars; s += step) {
    let sum = 0;
    const end = Math.min(nBars, s + w);
    for (let i = s; i < end; i++) sum += barE[i] ?? 0;
    const score = sum / Math.max(1, end - s);
    if (score > bestS) {
      bestS = score;
      best = s;
    }
  }
  return { inBars: best, outBars: Math.min(nBars, best + w) };
}

/**
 * Zehren/Yadati drop: Foote peaks on an 8-bar grid that pass salience
 * (following 8 bars loud + bass-in vs the 8 before). Fallback = heat window.
 */
export function salienceDropBars(
  barEnergy: number[],
  barLow: number[],
  novelty: number[],
  phrase = 8,
): number {
  const n = barEnergy.length;
  const heat = heatWindowFromEnergy(barEnergy, n, 16, phrase).inBars;
  if (n < 12 || novelty.length !== n) return heat;
  const maxN = Math.max(...novelty, 1e-9);
  const maxE = Math.max(...barEnergy, 1e-9);
  const maxL = Math.max(...barLow, 1e-9);
  const raw: number[] = [];
  for (let i = 2; i < n - 2; i++) {
    if (novelty[i]! < 0.28 * maxN) continue;
    let peak = true;
    for (let k = i - 2; k <= i + 2; k++) {
      if (k !== i && (novelty[k] ?? 0) > novelty[i]!) peak = false;
    }
    if (peak) raw.push(i);
  }
  const snapped = [
    ...new Set(raw.map((p) => Math.round(p / phrase) * phrase)),
  ].filter((p) => p >= phrase && p < n - 4);
  const ok = snapped.filter((p) => {
    const after = mean(barEnergy.slice(p, Math.min(n, p + 8)));
    const before = mean(barEnergy.slice(Math.max(0, p - 8), p));
    const afterL = mean(barLow.slice(p, Math.min(n, p + 8)));
    return after >= 0.38 * maxE && after >= before * 0.92 && afterL >= 0.28 * maxL;
  });
  const pool = ok.length ? ok : snapped.length ? snapped : [heat];
  return pool.reduce((best, p) => {
    const a = mean(barEnergy.slice(p, Math.min(n, p + 16)));
    const b = mean(barEnergy.slice(best, Math.min(n, best + 16)));
    return a > b ? p : best;
  });
}

function pushSection(
  out: TrackAnalysis["sections"],
  label: SectionLabel,
  startBars: number,
  endBars: number,
  barSec: number,
) {
  if (endBars - startBars < 4) return;
  out.push({
    label,
    startBars,
    endBars,
    startSec: startBars * barSec,
    endSec: endBars * barSec,
  });
}

/** Rekordbox-high / EDM-98 labels from energy shape around the measured drop. */
function segmentEdm(
  barEnergy: number[],
  dropBars: number,
  durationBars: number,
  bpm: number,
): TrackAnalysis["sections"] {
  const n = Math.max(1, Math.round(durationBars));
  const barSec = (60 / bpm) * 4;
  const drop = Math.max(0, Math.min(n - 8, Math.round(dropBars / 8) * 8));
  const meanE = mean(barEnergy);
  const sections: TrackAnalysis["sections"] = [];

  let buildStart = drop;
  if (drop >= 16) {
    const rise = mean(barEnergy.slice(drop - 8, drop)) - mean(barEnergy.slice(Math.max(0, drop - 16), drop - 8));
    buildStart = rise > 0.04 ? drop - 16 : drop - 8;
    pushSection(sections, "intro", 0, buildStart, barSec);
    pushSection(sections, "build", buildStart, drop, barSec);
  } else if (drop >= 8) {
    pushSection(sections, "intro", 0, drop, barSec);
  }

  let dropEnd = Math.min(n, drop + 32);
  let hole: number | null = null;
  for (let b = drop + 8; b <= n - 8; b += 8) {
    const local = mean(barEnergy.slice(b, b + 8));
    if (local < meanE * 0.72 && local < 0.55) {
      hole = b;
      dropEnd = b;
      break;
    }
  }
  pushSection(sections, "drop", drop, dropEnd, barSec);
  if (hole != null) {
    let holeEnd = Math.min(n, hole + 16);
    const rest = mean(barEnergy.slice(Math.min(n - 1, hole + 8), Math.min(n, hole + 16)));
    if (rest > 0.7 && hole + 16 < n - 4) {
      holeEnd = hole + 8;
      pushSection(sections, "breakdown", hole, holeEnd, barSec);
      pushSection(sections, "drop", holeEnd, Math.min(n, holeEnd + 24), barSec);
      const tail = Math.min(n, holeEnd + 24);
      if (tail < n - 4) pushSection(sections, "outro", tail, n, barSec);
    } else {
      pushSection(sections, "breakdown", hole, holeEnd, barSec);
      if (holeEnd < n - 4) pushSection(sections, "outro", holeEnd, n, barSec);
    }
  } else if (dropEnd < n - 4) {
    const tailE = mean(barEnergy.slice(Math.max(0, n - 8), n));
    pushSection(sections, tailE < meanE * 0.9 ? "outro" : "drop", dropEnd, n, barSec);
  }

  if (!sections.length) {
    pushSection(sections, drop < 8 ? "drop" : "intro", 0, n, barSec);
  }
  return sections;
}

function loudestDropSection(
  sections: TrackAnalysis["sections"],
  energy: number[],
  durationBars: number,
  dropBars?: number,
): TrackAnalysis["sections"][number] | null {
  if (dropBars != null) {
    const hit =
      sections.find((s) => s.label === "drop" && s.startBars <= dropBars && s.endBars > dropBars) ??
      sections.find((s) => s.label === "drop");
    if (hit) return hit;
  }
  const labeled = sections.filter((s) => s.label === "drop" || s.label === "chorus");
  const pool = labeled.length
    ? labeled
    : sections.filter((s) => s.label !== "intro" && s.label !== "outro");
  if (!pool.length || !energy.length) return null;
  const score = (s: TrackAnalysis["sections"][number]) => {
    const a = Math.floor((s.startBars / Math.max(durationBars, 1e-6)) * (energy.length - 1));
    const b = Math.floor((s.endBars / Math.max(durationBars, 1e-6)) * (energy.length - 1));
    return mean(energy.slice(Math.max(0, a), Math.max(a + 1, b + 1)));
  };
  return pool.reduce((best, s) => (score(s) > score(best) ? s : best));
}

type FrameBands = { flux: number; low: number; mid: number; high: number; chroma: Float32Array };

function analyzeFrames(samples: Float32Array, sampleRate: number): FrameBands[] {
  const fftSize = 2048;
  const hop = 512;
  const window = hann(fftSize);
  const binHz = sampleRate / fftSize;
  const frames: FrameBands[] = [];
  let prevMag: Float32Array | null = null;

  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);

  for (let off = 0; off + fftSize < samples.length; off += hop) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < fftSize; i++) re[i] = (samples[off + i] ?? 0) * window[i]!;
    fft(re, im);

    const mag = new Float32Array(fftSize / 2);
    const chroma = new Float32Array(12);
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let k = 1; k < mag.length; k++) {
      const m = Math.hypot(re[k]!, im[k]!);
      mag[k] = m;
      const hz = k * binHz;
      if (hz < 80 || hz > 5000) {
        if (hz >= 20 && hz < 200) low += m;
        else if (hz >= 2000 && hz < 8000) high += m;
        continue;
      }
      if (hz < 200) low += m;
      else if (hz < 3000) mid += m;
      else high += m;
      // Harmonic weighting: downweight very high partials
      const w = hz < 250 ? 1.4 : hz < 1000 ? 1 : 0.55;
      chroma[hzToPitchClass(hz)]! += m * w;
    }

    let flux = 0;
    if (prevMag) {
      for (let k = 1; k < mag.length; k++) flux += Math.max(0, mag[k]! - prevMag[k]!);
    }
    prevMag = mag;
    frames.push({ flux, low, mid, high, chroma });
  }
  return frames;
}

function estimateBpm(flux: number[], fps: number) {
  const minBpm = 70;
  const maxBpm = 180;
  const minLag = Math.max(2, Math.floor((60 / maxBpm) * fps));
  const maxLag = Math.floor((60 / minBpm) * fps);
  const norm = flux.slice();
  const m = mean(norm);
  for (let i = 0; i < norm.length; i++) norm[i] = Math.max(0, norm[i]! - m);

  let bestLag = minLag;
  let bestScore = -Infinity;
  const scores: { lag: number; score: number }[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = 0; i + lag < norm.length; i++) score += norm[i]! * norm[i + lag]!;
    scores.push({ lag, score });
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  let bpm = (60 * fps) / bestLag;

  // Prefer the octave that matches onset density (DnB 174 vs 87, hip-hop 85 vs 170).
  const peaks = peakPick(norm, mean(norm) * 1.6);
  const onsetsPerSec = peaks.length / Math.max(1, norm.length / fps);
  const candidates = [bpm, bpm * 2, bpm / 2].filter((b) => b >= 70 && b <= 185);
  let chosen = bpm;
  let chosenErr = Infinity;
  for (const c of candidates) {
    const expected = c / 60;
    const err = Math.abs(onsetsPerSec - expected);
    const errHalf = Math.abs(onsetsPerSec - expected / 2);
    const errDbl = Math.abs(onsetsPerSec - expected * 2);
    const e = Math.min(err, errHalf, errDbl);
    // Soft preference for club lanes
    const lane = c >= 118 && c <= 150 ? -0.15 : c >= 160 ? 0 : 0;
    if (e + lane < chosenErr) {
      chosenErr = e + lane;
      chosen = c;
    }
  }
  return chosen;
}

function peakPick(env: number[], thresh: number) {
  const idx: number[] = [];
  for (let i = 2; i < env.length - 2; i++) {
    if (env[i]! > thresh && env[i]! >= env[i - 1]! && env[i]! >= env[i + 1]!) idx.push(i);
  }
  return idx;
}

function alignGrid(flux: number[], fps: number, bpm: number) {
  const beatSec = 60 / bpm;
  const beatFrames = beatSec * fps;
  const durationSec = flux.length / fps;
  let bestPhase = 0;
  let best = -Infinity;
  const steps = 24;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * beatFrames;
    let score = 0;
    for (let t = phase; t < flux.length; t += beatFrames) {
      const i = Math.floor(t);
      score += flux[i] ?? 0;
    }
    if (score > best) {
      best = score;
      bestPhase = phase / fps;
    }
  }
  const beats: number[] = [];
  for (let t = bestPhase; t < durationSec; t += beatSec) beats.push(t);
  if (beats[0]! > beatSec * 0.25) beats.unshift(Math.max(0, beats[0]! - beatSec));

  // Downbeat = phase among 4 that hits the most flux
  let bestDb = 0;
  let bestDbScore = -Infinity;
  for (let off = 0; off < 4; off++) {
    let score = 0;
    for (let i = off; i < beats.length; i += 4) {
      const f = Math.floor(beats[i]! * fps);
      score += flux[f] ?? 0;
    }
    if (score > bestDbScore) {
      bestDbScore = score;
      bestDb = off;
    }
  }
  const downbeats = beats.filter((_, i) => i % 4 === bestDb);
  return { beats, downbeats, phaseSec: bestPhase };
}

function buildWaveform(samples: Float32Array, sampleRate: number): WaveformPeaks {
  const targetPeaks = 512;
  const samplesPerPeak = Math.max(1, Math.floor(samples.length / targetPeaks));
  const peaks: number[] = [];
  const low: number[] = [];
  const mid: number[] = [];
  const high: number[] = [];
  let lp = 0;
  let bp = 0;
  const lpA = Math.exp((-2 * Math.PI * 200) / sampleRate);
  const hpA = Math.exp((-2 * Math.PI * 2000) / sampleRate);

  for (let p = 0; p < targetPeaks; p++) {
    const start = p * samplesPerPeak;
    const end = Math.min(samples.length, start + samplesPerPeak);
    let peak = 0;
    let lowP = 0;
    let midP = 0;
    let highP = 0;
    for (let i = start; i < end; i++) {
      const x = samples[i]!;
      const ax = Math.abs(x);
      if (ax > peak) peak = ax;
      lp = lpA * lp + (1 - lpA) * x;
      const hp = x - lp;
      bp = hpA * bp + (1 - hpA) * hp;
      const hi = hp - bp;
      lowP = Math.max(lowP, Math.abs(lp));
      midP = Math.max(midP, Math.abs(bp));
      highP = Math.max(highP, Math.abs(hi));
    }
    peaks.push(peak);
    low.push(lowP);
    mid.push(midP);
    high.push(highP);
  }
  const max = Math.max(...peaks, 1e-6);
  return {
    samplesPerPeak,
    peaks: peaks.map((v) => v / max),
    low: low.map((v) => v / max),
    mid: mid.map((v) => v / max),
    high: high.map((v) => v / max),
  };
}

function vocalRegionsFrom(
  vocalCurve: number[],
  durationSec: number,
  bpm: number,
): NonNullable<TrackAnalysis["vocalRegions"]> {
  if (vocalCurve.length < 4) return [];
  const barSec = (60 / bpm) * 4;
  const thr = Math.max(0.42, mean(vocalCurve) + 0.08);
  const regions: NonNullable<TrackAnalysis["vocalRegions"]> = [];
  let start: number | null = null;
  for (let i = 0; i < vocalCurve.length; i++) {
    const hot = vocalCurve[i]! > thr;
    if (hot && start === null) start = i;
    if ((!hot || i === vocalCurve.length - 1) && start !== null) {
      const end = i;
      if (end - start >= 2) {
        const startSec = (start / (vocalCurve.length - 1)) * durationSec;
        const endSec = (end / (vocalCurve.length - 1)) * durationSec;
        regions.push({
          startSec,
          endSec,
          startBars: startSec / barSec,
          endBars: endSec / barSec,
        });
      }
      start = null;
    }
  }
  return regions;
}

/**
 * Timbre is the ONLY mood-adjacent thing the DSP can honestly claim: it is a
 * spectral measurement (high-band ratio + energy), never a harmonic-mode
 * guess. "Dark" here means low-passed and low-mid heavy — a timbre, not an
 * emotion. Emotional mood (euphoric, melancholy…) is agent-curated via
 * tag_track; the detector stopped guessing it because minor-key ⇏ dark and
 * BPM-bucket ⇏ genre were actively misguiding the composer.
 */
function inferTimbre(brightness: number, energyLevel: number): "bright" | "dark" | "warm" {
  if (energyLevel >= 8) return "bright";
  if (brightness >= 0.45) return "bright";
  if (brightness < 0.3) return "dark";
  return "warm";
}

export function analyzePcm(
  channelData: Float32Array,
  sampleRate: number,
): TrackAnalysis {
  const targetRate = 11025;
  const mono = downsampleMono(channelData, sampleRate, targetRate);
  const durationSec = channelData.length / sampleRate;
  const frames = analyzeFrames(mono, targetRate);
  const fps = targetRate / 512;
  const flux = frames.map((f) => f.flux);
  const bpmRaw = frames.length ? estimateBpm(flux, fps) : 120;
  const bpm = Math.round(bpmRaw * 10) / 10;
  const { beats, downbeats } = alignGrid(flux, fps, bpm);

  const buckets = 96;
  const energy: number[] = [];
  const vocal: number[] = [];
  const lowBand: number[] = [];
  const midBand: number[] = [];
  const highBand: number[] = [];
  const chromaByBucket: Float32Array[] = [];
  const chromaSum = new Float32Array(12);
  let brightAcc = 0;
  const keyUntil = Math.min(frames.length, Math.floor(fps * 75));

  for (let b = 0; b < buckets; b++) {
    const a = Math.floor((b / buckets) * frames.length);
    const z = Math.floor(((b + 1) / buckets) * frames.length);
    let e = 0;
    let v = 0;
    let lowAcc = 0;
    let midAcc = 0;
    let highAcc = 0;
    let n = 0;
    const bucketChroma = new Float32Array(12);
    for (let i = a; i < z; i++) {
      const f = frames[i];
      if (!f) continue;
      const tot = f.low + f.mid + f.high + 1e-9;
      e += tot;
      lowAcc += f.low;
      midAcc += f.mid;
      highAcc += f.high;
      const midRatio = f.mid / tot;
      const lowRatio = f.low / tot;
      v += midRatio > 0.38 && lowRatio < 0.42 ? midRatio : 0;
      for (let c = 0; c < 12; c++) bucketChroma[c]! += f.chroma[c]!;
      n++;
    }
    energy.push(n ? e / n : 0);
    vocal.push(n ? v / n : 0);
    lowBand.push(n ? lowAcc / n : 0);
    midBand.push(n ? midAcc / n : 0);
    highBand.push(n ? highAcc / n : 0);
    chromaByBucket.push(bucketChroma);
  }

  for (let i = 0; i < keyUntil; i++) {
    const f = frames[i]!;
    for (let c = 0; c < 12; c++) chromaSum[c]! += f.chroma[c]!;
    const tot = f.low + f.mid + f.high + 1e-9;
    brightAcc += f.high / tot;
  }

  const maxE = Math.max(...energy, 1e-6);
  const energyNorm = energy.map((e) => e / maxE);
  const maxL = Math.max(...lowBand, 1e-6);
  const maxM = Math.max(...midBand, 1e-6);
  const maxH = Math.max(...highBand, 1e-6);
  const lowNorm = lowBand.map((e) => e / maxL);
  const midNorm = midBand.map((e) => e / maxM);
  const highNorm = highBand.map((e) => e / maxH);
  const chromaCurve = chromaByBucket.map((bucket) => {
    const m = Math.max(...bucket, 1e-9);
    return Array.from(bucket, (v) => Number((v / m).toFixed(3)));
  });
  const brightness = frames.length ? brightAcc / Math.max(1, keyUntil) : 0.3;
  const introKey = estimateKey(chromaSum);
  const durationBars = (durationSec * bpm) / 60 / 4;
  const nBars = Math.max(1, Math.round(durationBars));
  const barEnergy = resampleToBars(energyNorm, nBars);
  const barLow = resampleToBars(lowNorm, nBars);
  const seq = energyNorm.map((e, i) => [e, lowNorm[i] ?? 0, midNorm[i] ?? 0, highNorm[i] ?? 0]);
  const barsPerBucket = durationBars / Math.max(1, buckets);
  const kernelHalf = Math.max(2, Math.round(8 / Math.max(0.25, barsPerBucket) / 2));
  const novelty = footeNovelty(seq, kernelHalf);
  const noveltyBars = resampleToBars(novelty, nBars);
  const dropBars = salienceDropBars(barEnergy, barLow, noveltyBars);
  const heat = heatWindowFromEnergy(barEnergy, nBars);
  const sections = segmentEdm(barEnergy, dropBars, durationBars, bpm);
  const dropSection = loudestDropSection(sections, energyNorm, durationBars, dropBars);
  let key = introKey;
  let keyWindow: "intro" | "drop" = "intro";
  if (dropSection && frames.length) {
    const barSec = (60 / bpm) * 4;
    const startSec = dropSection.startSec;
    const endSec = Math.min(dropSection.endSec, startSec + barSec * 16);
    const from = Math.floor(startSec * fps);
    const to = Math.ceil(endSec * fps);
    if (to - from >= fps * 4) {
      const dropKey = estimateKey(sumChroma(frames, from, to));
      if (dropKey.confidence >= introKey.confidence - 0.05) {
        key = dropKey;
        keyWindow = "drop";
      }
    }
  }
  key = { ...key, window: keyWindow, profile: "edma" };
  const waveform = buildWaveform(mono, targetRate);
  const vocalRegions = vocalRegionsFrom(vocal, durationSec, bpm);
  const vocalLead =
    vocalRegions.reduce((s, r) => s + (r.endBars - r.startBars), 0) / Math.max(1, durationBars) > 0.18;
  const energyMean = mean(energyNorm);
  const heatMean = mean(barEnergy.slice(heat.inBars, Math.max(heat.inBars + 1, heat.outBars)));
  const peakE = Math.max(...barEnergy, 0);
  const energyLevel = Math.round(
    1 +
      Math.min(
        1,
        Math.max(0, peakE * 0.45 + brightness * 0.25 + heatMean * 0.2 + energyMean * 0.1),
      ) *
        9,
  );
  const timbre = inferTimbre(brightness, energyLevel);

  return {
    bpm,
    durationSec,
    durationBars,
    key,
    beats,
    downbeats,
    sections,
    energy: energyNorm,
    energyMean,
    energyLevel,
    brightness: Number(brightness.toFixed(3)),
    timbre,
    vocalLead,
    vocalRegions,
    waveform,
    chromaCurve,
    dropBars,
    heatInBars: heat.inBars,
    heatOutBars: heat.outBars,
    detector: "salience-v1",
    analyzedAt: Date.now(),
  };
}
