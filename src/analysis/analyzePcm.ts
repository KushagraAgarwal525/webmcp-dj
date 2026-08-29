import type {
  SectionLabel,
  TrackAnalysis,
  TrackMood,
  TrackRole,
  WaveformPeaks,
} from "../types/setdoc";
import { downsampleMono, fft, hann, hzToPitchClass, mean } from "./dsp";

const KRUM_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KRUM_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

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
    const maj = correlate(chroma, KRUM_MAJOR, root);
    const min = correlate(chroma, KRUM_MINOR, root);
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
  };
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

function snapBars(bars: number, phrase = 8) {
  if (bars <= 0) return 0;
  return Math.round(bars / phrase) * phrase;
}

function segmentSections(
  energy: number[],
  vocal: number[],
  durationSec: number,
  bpm: number,
): TrackAnalysis["sections"] {
  const barSec = (60 / bpm) * 4;
  const durationBars = durationSec / barSec;
  if (energy.length < 4) {
    return [
      {
        label: "intro",
        startBars: 0,
        endBars: Math.max(8, durationBars),
        startSec: 0,
        endSec: durationSec,
      },
    ];
  }

  const meanE = mean(energy);
  const novelty: number[] = [0];
  for (let i = 1; i < energy.length; i++) {
    novelty.push(Math.abs(energy[i]! - energy[i - 1]!) + Math.abs((vocal[i] ?? 0) - (vocal[i - 1] ?? 0)) * 0.5);
  }
  const novMean = mean(novelty);
  const raw = [0];
  for (let i = 2; i < novelty.length - 2; i++) {
    if (novelty[i]! > novMean * 1.55 && i - raw[raw.length - 1]! > 3) raw.push(i);
  }
  raw.push(energy.length - 1);

  // Convert to bars and snap to 8
  const cuts = raw.map((i) => snapBars((i / (energy.length - 1)) * durationBars));
  const uniq = [...new Set(cuts)].sort((a, b) => a - b);
  if (uniq[0] !== 0) uniq.unshift(0);
  const last = snapBars(durationBars) || durationBars;
  if (uniq[uniq.length - 1]! < last - 4) uniq.push(last);

  const merged: number[] = [0];
  for (const c of uniq.slice(1)) {
    if (c - merged[merged.length - 1]! >= 8) merged.push(c);
  }
  if (merged[merged.length - 1]! < last) {
    if (last - merged[merged.length - 1]! >= 8) merged.push(last);
    else merged[merged.length - 1] = last;
  }

  const sections: TrackAnalysis["sections"] = [];
  for (let i = 0; i < merged.length - 1; i++) {
    const startBars = merged[i]!;
    const endBars = merged[i + 1]!;
    const a = Math.floor((startBars / durationBars) * (energy.length - 1));
    const b = Math.floor((endBars / durationBars) * (energy.length - 1));
    const local = mean(energy.slice(a, Math.max(a + 1, b + 1)));
    const voc = mean(vocal.slice(a, Math.max(a + 1, b + 1)));
    const rel = (startBars + endBars) / 2 / Math.max(durationBars, 0.001);
    const prevE = sections.length ? mean(energy.slice(Math.max(0, a - 4), a + 1)) : local;
    sections.push({
      label: labelSection(rel, local, meanE, voc, local - prevE, i === 0, i === merged.length - 2),
      startBars,
      endBars,
      startSec: startBars * barSec,
      endSec: endBars * barSec,
    });
  }
  return sections;
}

function labelSection(
  rel: number,
  local: number,
  meanE: number,
  vocal: number,
  rise: number,
  isFirst: boolean,
  isLast: boolean,
): SectionLabel {
  if (isFirst && (rel < 0.18 || local < meanE * 0.85)) return "intro";
  if (isLast && (rel > 0.82 || local < meanE * 0.9)) return "outro";
  if (local < meanE * 0.72) return "breakdown";
  if (rise > 0.08 && local > meanE * 0.95) return "build";
  if (local > meanE * 1.12) return vocal > 0.45 ? "chorus" : "drop";
  if (vocal > 0.5) return "verse";
  return local > meanE ? "drop" : "verse";
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

function inferGenre(bpm: number, brightness: number, energyMean: number, vocalLead: boolean): string {
  if (bpm >= 160 && bpm <= 180) return "drum and bass";
  if (bpm >= 138 && bpm <= 144 && energyMean > 0.55) return "dubstep";
  if (bpm >= 145 && bpm <= 160) return "hard techno";
  if (bpm >= 132 && bpm <= 150 && brightness < 0.55) return "techno";
  if (bpm >= 128 && bpm <= 140 && brightness > 0.55) return "trance";
  if (bpm >= 122 && bpm <= 132 && brightness > 0.4) return "tech house";
  if (bpm >= 118 && bpm <= 126 && energyMean < 0.55) return "deep house";
  if (bpm >= 118 && bpm <= 132) return "house";
  if (bpm >= 85 && bpm <= 115) return vocalLead ? "hip-hop" : "downtempo";
  if (bpm >= 70 && bpm < 85) return "downtempo";
  return "unknown";
}

function inferMood(camelot: string, energyLevel: number, brightness: number): TrackMood {
  const minor = camelot.endsWith("A");
  if (energyLevel >= 8) return "driving";
  if (!minor && brightness > 0.45) return "bright";
  if (minor && energyLevel <= 5) return "dark";
  return brightness > 0.4 ? "warm" : "dark";
}

function inferRole(energyLevel: number, vocalLead: boolean, dropShare: number): TrackRole {
  if (energyLevel >= 8) return "peak";
  if (energyLevel <= 3) return dropShare < 0.15 ? "opener" : "reset";
  if (energyLevel <= 4) return "opener";
  if (energyLevel <= 6) return vocalLead ? "bridge" : "builder";
  return energyLevel >= 7 && dropShare > 0.2 ? "peak" : "builder";
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
  const chromaSum = new Float32Array(12);
  let brightAcc = 0;
  const keyUntil = Math.min(frames.length, Math.floor(fps * 75));

  for (let b = 0; b < buckets; b++) {
    const a = Math.floor((b / buckets) * frames.length);
    const z = Math.floor(((b + 1) / buckets) * frames.length);
    let e = 0;
    let v = 0;
    let n = 0;
    for (let i = a; i < z; i++) {
      const f = frames[i];
      if (!f) continue;
      const tot = f.low + f.mid + f.high + 1e-9;
      e += tot;
      // Vocal: mid-strong, low not dominating (kills drop=vocal false positive)
      const midRatio = f.mid / tot;
      const lowRatio = f.low / tot;
      v += midRatio > 0.38 && lowRatio < 0.42 ? midRatio : 0;
      n++;
    }
    energy.push(n ? e / n : 0);
    vocal.push(n ? v / n : 0);
  }

  for (let i = 0; i < keyUntil; i++) {
    const f = frames[i]!;
    for (let c = 0; c < 12; c++) chromaSum[c]! += f.chroma[c]!;
    const tot = f.low + f.mid + f.high + 1e-9;
    brightAcc += f.high / tot;
  }

  const maxE = Math.max(...energy, 1e-6);
  const energyNorm = energy.map((e) => e / maxE);
  const brightness = frames.length ? brightAcc / Math.max(1, keyUntil) : 0.3;
  const key = estimateKey(chromaSum);
  const durationBars = (durationSec * bpm) / 60 / 4;
  const sections = segmentSections(energyNorm, vocal, durationSec, bpm);
  const waveform = buildWaveform(mono, targetRate);
  const vocalRegions = vocalRegionsFrom(vocal, durationSec, bpm);
  const vocalLead =
    vocalRegions.reduce((s, r) => s + (r.endBars - r.startBars), 0) / Math.max(1, durationBars) > 0.18;
  const energyMean = mean(energyNorm);
  const dropShare =
    sections
      .filter((s) => s.label === "drop" || s.label === "chorus")
      .reduce((s, x) => s + Math.max(0, x.endBars - x.startBars), 0) / Math.max(1, durationBars);
  const bpmNorm = Math.min(1, Math.max(0, (bpm - 110) / 50));
  const energyLevel = Math.round(
    1 + Math.min(1, Math.max(0, energyMean * 0.4 + dropShare * 0.25 + bpmNorm * 0.2 + brightness * 0.15)) * 9,
  );
  const genreHint = inferGenre(bpm, brightness, energyMean, vocalLead);
  const mood = inferMood(key.camelot, energyLevel, brightness);
  const suggestedRole = inferRole(energyLevel, vocalLead, dropShare);

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
    genreHint,
    mood,
    vocalLead,
    suggestedRole,
    vocalRegions,
    waveform,
    analyzedAt: Date.now(),
  };
}
