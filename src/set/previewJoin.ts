import type { SetDoc, Track } from "../types/setdoc";
import { classifyCamelotMove, phraseOffGrid, snapToPhrase } from "./builder";
import { findDropBars, tempoRelation } from "./craft";
import { buildTimeline } from "./timeline";
import { readAudioBlob } from "../storage/opfs";
import { decodeAudioFile } from "../analysis/runAnalysis";

export type JoinListen = {
  index: number;
  outgoing: string;
  incoming: string;
  bars: number;
  phrase: { inOnGrid: boolean; outOnGrid: boolean; snappedIn: number; snappedOut: number };
  camelot: { from: string; to: string; move: string };
  tempo: { from: number; to: number; relation: string; pitchPct: number };
  analysis: {
    bassClash: number;
    midClash: number;
    vocalOverlap: boolean;
    incomingEnergy: "low" | "mid" | "high";
  };
  heard: {
    bassClash: number;
    midClash: number;
    highClash: number;
    source: "pcm" | "waveform";
  } | null;
  verdict: "clean" | "risky" | "fail";
  notes: string[];
  drops: {
    outgoing: number | null;
    incoming: number | null;
    cueBeforeIn8: number | null;
    cueBeforeIn16: number | null;
    inBarsOnDrop: boolean;
    inBarsIsCue: boolean;
  };
};

function bandAt(track: Track, bars: number, band: "low" | "mid" | "high" | "peaks"): number {
  const w = track.analysis?.waveform;
  const arr = band === "peaks" ? w?.peaks : w?.[band];
  if (!arr?.length || !track.analysis) return 0;
  const t = Math.min(0.999, Math.max(0, bars / Math.max(track.analysis.durationBars, 1)));
  const i = Math.min(arr.length - 1, Math.floor(t * arr.length));
  return arr[i] ?? 0;
}

function meanBand(track: Track, start: number, end: number, band: "low" | "mid" | "high"): number {
  const steps = 6;
  let s = 0;
  for (let i = 0; i < steps; i++) {
    const b = start + ((end - start) * i) / steps;
    s += bandAt(track, b, band);
  }
  return s / steps;
}

function sectionEnergy(track: Track, bars: number): "low" | "mid" | "high" {
  const hit = track.analysis?.sections.find((s) => bars >= s.startBars && bars < s.endBars);
  if (!hit) return "mid";
  if (hit.label === "drop" || hit.label === "chorus") return "high";
  if (hit.label === "intro" || hit.label === "outro" || hit.label === "breakdown") return "low";
  return "mid";
}

function vocalsHit(track: Track, start: number, end: number): boolean {
  return (track.analysis?.vocalRegions ?? []).some((r) => r.endBars > start && r.startBars < end);
}

function rms(buf: Float32Array, a: number, b: number) {
  let s = 0;
  const n = Math.max(1, b - a);
  for (let i = a; i < b; i++) {
    const v = buf[i] ?? 0;
    s += v * v;
  }
  return Math.sqrt(s / n);
}

async function hearWindow(track: Track, startBars: number, endBars: number) {
  const blob = await readAudioBlob(track.fileRef);
  if (!blob || !track.analysis) return null;
  const decoded = await decodeAudioFile(blob);
  const bpm = track.analysis.bpm;
  const barSec = (60 / bpm) * 4;
  const a = Math.floor(Math.max(0, startBars) * barSec * decoded.sampleRate);
  const b = Math.min(decoded.samples.length, Math.floor(endBars * barSec * decoded.sampleRate));
  if (b - a < 256) return null;
  const slice = decoded.samples.subarray(a, b);
  // One-pole split
  let lp = 0;
  let bp = 0;
  const sr = decoded.sampleRate;
  const lpA = Math.exp((-2 * Math.PI * 200) / sr);
  const hpA = Math.exp((-2 * Math.PI * 2000) / sr);
  const low = new Float32Array(slice.length);
  const mid = new Float32Array(slice.length);
  const high = new Float32Array(slice.length);
  for (let i = 0; i < slice.length; i++) {
    const x = slice[i]!;
    lp = lpA * lp + (1 - lpA) * x;
    const hp = x - lp;
    bp = hpA * bp + (1 - hpA) * hp;
    low[i] = lp;
    mid[i] = bp;
    high[i] = hp - bp;
  }
  return {
    low: rms(low, 0, low.length),
    mid: rms(mid, 0, mid.length),
    high: rms(high, 0, high.length),
  };
}

export async function previewJoin(
  doc: SetDoc,
  index: number,
  hear = true,
): Promise<JoinListen> {
  const cur = doc.arrangement[index];
  const prev = doc.arrangement[index - 1];
  if (!cur || !prev) throw new Error("join needs incoming index ≥ 1");
  const ta = doc.tracks[prev.trackId];
  const tb = doc.tracks[cur.trackId];
  if (!ta?.analysis || !tb?.analysis) throw new Error("both tracks need analysis");

  const bars = cur.transition.bars;
  const outStart = Math.max(0, prev.outBars - bars);
  const inEnd = cur.inBars + bars;
  const notes: string[] = [];

  const bassClash = meanBand(ta, outStart, prev.outBars, "low") * meanBand(tb, cur.inBars, inEnd, "low");
  const midClash = meanBand(ta, outStart, prev.outBars, "mid") * meanBand(tb, cur.inBars, inEnd, "mid");
  const vocalOverlap = vocalsHit(ta, outStart, prev.outBars) && vocalsHit(tb, cur.inBars, inEnd);
  if (vocalOverlap) notes.push("Both sides have vocal regions in the overlap.");
  if (bassClash > 0.18) notes.push("Waveform lows are hot on both decks — expect double-bass.");
  if (phraseOffGrid(cur.inBars) || phraseOffGrid(prev.outBars)) {
    notes.push("Phrase off the 8-bar grid — snap before you trust the 1.");
  }

  const move = classifyCamelotMove(ta.analysis.key.camelot, tb.analysis.key.camelot);
  const rel = tempoRelation(ta.analysis.bpm, tb.analysis.bpm);
  const pitchPct = ((tb.analysis.bpm - ta.analysis.bpm) / ta.analysis.bpm) * 100;
  if (move === "clash" && bars >= 8) notes.push(`Camelot clash ${ta.analysis.key.camelot}→${tb.analysis.key.camelot} on a long overlap.`);
  if (rel === "far") notes.push("BPM gap is too wide to blend.");

  const outDrop = findDropBars(ta);
  const inDrop = findDropBars(tb);
  const cue8 = inDrop != null ? snapToPhrase(Math.max(0, inDrop - 8)) : null;
  const cue16 = inDrop != null ? snapToPhrase(Math.max(0, inDrop - 16)) : null;
  if (inDrop != null && Math.abs(cur.inBars - inDrop) < 2 && bars >= 8) {
    notes.push(`in_bars sits on the incoming drop (${inDrop}). A replace/stack usually cues ${bars} bars earlier.`);
  }
  if (outDrop != null && Math.abs(prev.outBars - outDrop) > 4 && bars >= 8) {
    notes.push(`outgoing leave is ${prev.outBars.toFixed(0)}; drop is ${outDrop}.`);
  }

  let heard: JoinListen["heard"] = {
    bassClash,
    midClash,
    highClash: meanBand(ta, outStart, prev.outBars, "high") * meanBand(tb, cur.inBars, inEnd, "high"),
    source: "waveform",
  };

  if (hear) {
    try {
      const [ha, hb] = await Promise.all([
        hearWindow(ta, outStart, prev.outBars),
        hearWindow(tb, cur.inBars, inEnd),
      ]);
      if (ha && hb) {
        heard = {
          bassClash: ha.low * hb.low * 8,
          midClash: ha.mid * hb.mid * 8,
          highClash: ha.high * hb.high * 8,
          source: "pcm",
        };
        if (heard.bassClash > 0.08) notes.push("Heard: stacked low end in the PCM window.");
        if (heard.midClash > 0.1 && vocalOverlap) notes.push("Heard: mids fighting (likely vocals/leads).");
      }
    } catch {
      notes.push("PCM listen failed — scored from waveform bands.");
    }
  }

  const incomingEnergy = sectionEnergy(tb, cur.inBars + Math.max(0, bars));

  const fail =
    (heard?.source === "pcm" && heard.bassClash > 0.14 && bars >= 8) ||
    (move === "clash" && bars >= 12 && incomingEnergy !== "low");
  const risky =
    vocalOverlap ||
    bassClash > 0.16 ||
    phraseOffGrid(cur.inBars) ||
    rel === "far" ||
    move === "clash";

  if (!notes.length) notes.push("Overlap looks mixable.");

  return {
    index,
    outgoing: ta.title,
    incoming: tb.title,
    bars,
    phrase: {
      inOnGrid: !phraseOffGrid(cur.inBars),
      outOnGrid: !phraseOffGrid(prev.outBars),
      snappedIn: snapToPhrase(cur.inBars),
      snappedOut: snapToPhrase(prev.outBars),
    },
    camelot: {
      from: ta.analysis.key.camelot,
      to: tb.analysis.key.camelot,
      move,
    },
    tempo: {
      from: ta.analysis.bpm,
      to: tb.analysis.bpm,
      relation: rel,
      pitchPct: Number(pitchPct.toFixed(1)),
    },
    analysis: { bassClash, midClash, vocalOverlap, incomingEnergy },
    heard,
    verdict: fail ? "fail" : risky ? "risky" : "clean",
    notes,
    drops: {
      outgoing: outDrop,
      incoming: inDrop,
      cueBeforeIn8: cue8,
      cueBeforeIn16: cue16,
      inBarsOnDrop: inDrop != null && Math.abs(cur.inBars - inDrop) < 2,
      inBarsIsCue:
        (cue8 != null && Math.abs(cur.inBars - cue8) < 2) ||
        (cue16 != null && Math.abs(cur.inBars - cue16) < 2),
    },
  };
}

export function previewAllJoins(doc: SetDoc) {
  const spans = buildTimeline(doc);
  return spans.slice(1).map((s) => s.entryIndex);
}
