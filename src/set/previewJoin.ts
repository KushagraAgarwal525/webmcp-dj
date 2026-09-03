import type { SetDoc, Track } from "../types/setdoc";
import { auditionHarmony, classifyCamelotMove, holeParkedAt, isolatorOverlapCap, isIsolatorType, isPadType, keyIsTrusted, padCapForJoin, phraseOffGrid, snapToPhrase, vocalCovers, type HarmonyAudition } from "./builder";
import { findDropBars, findPeakDropBars, joinCompileReport, tempoRelation } from "./craft";
import { buildTimeline } from "./timeline";
import { ridePitchSemitones } from "./pitchRide";
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
  /** Measured harmony over the actual windows (null on slam/leave joins). */
  harmony: HarmonyAudition | null;
  /** What the compiler actually does to this join — commit bar + drop anchor. */
  compile: ReturnType<typeof joinCompileReport>;
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
  const type = cur.transition.type;
  // Leave joins: incoming is never in the speakers over the window.
  const sequential = type === "echo_out" || type === "air_cut";
  // Slam joins: incoming enters at the commit with its bass pre-killed —
  // far BPM and Camelot caps do not apply, by design.
  const slam = type === "cut" || type === "backspin";
  const sharedClock = !sequential && !slam;
  const isolator = isIsolatorType(type);
  const outStart = Math.max(0, prev.outBars - bars);
  const inEnd = sequential ? cur.inBars : cur.inBars + bars;
  const notes: string[] = [];

  const bassClash = sequential
    ? 0
    : meanBand(ta, outStart, prev.outBars, "low") * meanBand(tb, cur.inBars, inEnd, "low");
  const midClash = sequential
    ? 0
    : meanBand(ta, outStart, prev.outBars, "mid") * meanBand(tb, cur.inBars, inEnd, "mid");
  const vocalOverlap =
    !sequential &&
    vocalsHit(ta, outStart, prev.outBars) &&
    vocalsHit(tb, cur.inBars, inEnd);
  if (sequential) {
    notes.push(
      type === "air_cut"
        ? "Air cut: suck-out, one bar of dead air, incoming cold on its drop — no shared clock."
        : "Leave to silence — incoming is not in the speakers during the echo.",
    );
  } else if (slam) {
    notes.push("Slam join — incoming bass is killed until the commit; far BPM and Camelot caps do not apply.");
  }
  if (vocalOverlap && isolator) {
    notes.push("Outgoing vocal over the incoming build — isolator keeps incoming mids down until the 1.");
  } else if (vocalOverlap && sharedClock) {
    notes.push("Both sides have vocal regions in the overlap.");
  }
  if (sharedClock && bassClash > 0.18) {
    notes.push("Waveform lows are hot on both decks — expect double-bass.");
  }
  if (phraseOffGrid(cur.inBars) || phraseOffGrid(prev.outBars)) {
    notes.push("Phrase off the 8-bar grid — snap before you trust the 1.");
  }

  const move = classifyCamelotMove(ta.analysis.key.camelot, tb.analysis.key.camelot);
  const rel = tempoRelation(ta.analysis.bpm, tb.analysis.bpm);
  const pitchPct = ((tb.analysis.bpm - ta.analysis.bpm) / ta.analysis.bpm) * 100;
  const pitchRide = ridePitchSemitones({
    fromCamelot: ta.analysis.key.camelot,
    toCamelot: tb.analysis.key.camelot,
    tempoRatio: tb.analysis.bpm / Math.max(1e-6, ta.analysis.bpm),
  });
  const trusted = keyIsTrusted(ta) && keyIsTrusted(tb);
  // Hole-aware: a blend parked on the outgoing's tonal hole can run 8 bars
  // even on a label clash — the harmonies never co-occur.
  const holeOk = holeParkedAt(ta, prev.outBars, bars);
  // Audio truth over labels: audition the actual windows.
  const sharesWindow = !sequential && !slam;
  const harmony = sharesWindow
    ? auditionHarmony(
        ta,
        Math.max(0, prev.outBars - bars),
        prev.outBars,
        tb,
        cur.inBars,
        cur.inBars + bars,
      )
    : null;
  const audioOk =
    harmony?.verdict === "blend_ok" || harmony?.verdict === "bass_only";
  const audioClash = harmony?.verdict === "clash";
  const padCap = audioOk
    ? Math.max(8, padCapForJoin(ta, prev.outBars, move, trusted, bars))
    : audioClash
      ? 1
      : padCapForJoin(ta, prev.outBars, move, trusted, bars);
  const isoCap = audioClash ? 1 : isolatorOverlapCap(move);
  const cap = isolator ? isoCap : padCap;
  // Slam-class joins (cut / backspin / echo_out / tease_slam) chop the
  // outgoing ON the 1 — a vocal cut on the incoming drop is the festival
  // move, not a broken leave.
  const midVocalLeave =
    type !== "echo_out" &&
    type !== "backspin" &&
    type !== "tease_slam" &&
    vocalCovers(ta, prev.outBars);
  if (harmony && harmony.verdict !== "unknown") {
    notes.push(
      `Audio audition: ${harmony.verdict} (dissonance ${harmony.score}, roots ${harmony.locked ? "locked" : "unlocked"}) — measured from the chroma in the actual windows, not the key label.`,
    );
  }
  if (holeOk && !isolator) {
    notes.push("Hole-parked blend — the outgoing's harmony sits out of the window; the label clash is mostly moot.");
  }
  if (sharedClock && (move === "clash" || move === "jaws") && bars >= 8 && !holeOk && !audioOk) {
    notes.push(`Camelot clash ${ta.analysis.key.camelot}→${tb.analysis.key.camelot} on a long overlap.`);
  }
  if (sharedClock && rel === "far" && type !== "tempo_ride" && type !== "tease_slam") {
    notes.push("BPM gap is too wide to blend.");
  }
  if (type === "tempo_ride") {
    notes.push(
      `Ride: both decks ramp ${ta.analysis.bpm.toFixed(1)}→${tb.analysis.bpm.toFixed(1)} across the overlap — outgoing pitch ` +
        (pitchRide === 0
          ? "stays locked (a vinyl unlock would sit between keys)"
          : `rides ${pitchRide > 0 ? "+" : ""}${pitchRide} st over the last 4 bars (${move === "energy_boost" ? "lands on incoming tonic" : "quantized vinyl"})`) +
        `; incoming stays true; isolator commit on the incoming drop, then peel.`,
    );
  }
  if (type === "tease_slam") {
    notes.push(
      `Tease slam: the incoming build bleeds in filtered under the outgoing across ${bars} bars` +
        (Math.abs(pitchPct) > 3
          ? `, the tempo lane rides ${ta.analysis.bpm.toFixed(0)}→${tb.analysis.bpm.toFixed(0)} across the window`
          : "") +
        (pitchRide !== 0
          ? `, outgoing pitch rides ${pitchRide > 0 ? "+" : ""}${pitchRide} st into the 1`
          : "") +
        `, roll + throw, slam on the incoming 1.`,
    );
    if (audioClash) {
      notes.push(
        "Measured clash — the tease is LP-filtered and bassless so it is mostly masked; drop to 8 bars if it still fights.",
      );
    }
  }
  if (rel === "far" && sequential) notes.push("Far BPM: each record keeps its own clock.");
  if (rel === "far" && slam) notes.push("Far BPM: slam join — each record keeps its own clock.");
  if (midVocalLeave) notes.push("Outgoing leave sits inside a vocal region — wait for the line.");
  if (sharedClock && !trusted && isPadType(type) && bars >= 8 && !holeOk && !audioOk) {
    notes.push("Key untrusted — do not pad-blend.");
  }
  if (sharedClock && bars > cap) {
    notes.push(`Overlap ${bars} > ${cap} bars for ${move}.`);
  }
  if (isolator && !sequential) {
    notes.push("Isolator: incoming build under the line, bass swap on the 1, then peel.");
  }

  const outDrop = findPeakDropBars(ta) ?? findDropBars(ta);
  const inDrop = findPeakDropBars(tb) ?? findDropBars(tb);
  const cue8 = inDrop != null ? snapToPhrase(Math.max(0, inDrop - 8)) : null;
  const cue16 = inDrop != null ? snapToPhrase(Math.max(0, inDrop - 16)) : null;
  if (inDrop != null && Math.abs(cur.inBars - inDrop) < 2 && bars >= 8 && !sequential) {
    notes.push(
      isolator
        ? `in_bars sits on the incoming drop (${inDrop}) — cue the build (drop−8), not the 1.`
        : `in_bars sits on the incoming drop (${inDrop}). A replace/stack usually cues ${bars} bars earlier.`,
    );
  }
  if (
    isolator &&
    cue8 != null &&
    Math.abs(cur.inBars - cue8) < 2 &&
    bars >= 8
  ) {
    notes.push(`Incoming is on the build (drop−8 at ${cue8}).`);
  }
  if (outDrop != null && Math.abs(prev.outBars - outDrop) > 4 && bars >= 8 && !isolator) {
    notes.push(`outgoing leave is ${prev.outBars.toFixed(0)}; drop is ${outDrop}.`);
  }

  let heard: JoinListen["heard"] = sequential
    ? {
        bassClash: 0,
        midClash: 0,
        highClash: 0,
        source: "waveform",
      }
    : {
        bassClash,
        midClash,
        highClash: meanBand(ta, outStart, prev.outBars, "high") * meanBand(tb, cur.inBars, inEnd, "high"),
        source: "waveform",
      };

  if (hear && !sequential) {
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
        if (sharedClock && !isolator && heard.bassClash > 0.08) {
          notes.push("Heard: stacked low end in the PCM window.");
        }
        if (sharedClock && !isolator && heard.midClash > 0.1 && vocalOverlap) {
          notes.push("Heard: mids fighting (likely vocals/leads).");
        }
      }
    } catch {
      notes.push("PCM listen failed — scored from waveform bands.");
    }
  }

  const incomingEnergy = sectionEnergy(tb, cur.inBars + Math.max(0, bars));

  // The compile report doubles as a gate: a tease whose drop lands off the
  // commit is geometrically broken (the outgoing clip cannot host the tease
  // window — shrink bars or re-park the leave).
  const compile = joinCompileReport(doc, index);
  const teaseOffDrop = type === "tease_slam" && compile?.commit_on_drop === false;
  if (teaseOffDrop) {
    notes.push(
      `Tease geometry broken: the incoming drop lands at set bar ${compile?.incoming_drop_bars ?? "?"} but the commit fires at ${compile?.commit_bars ?? "?"} — the outgoing clip cannot host ${bars} tease bars. Shrink the tease or re-park the leave.`,
    );
  }

  // tease_slam is exempt from the raw-window caps: the tease runs LP-filtered
  // with bass and mids held down, so raw file-on-file clash numbers overstate
  // what the compiled lanes actually let through.
  const fail =
    !sequential &&
    (teaseOffDrop ||
      midVocalLeave ||
      (sharedClock && isPadType(type) && !trusted && bars >= 8 && !holeOk && !audioOk) ||
      (sharedClock && bars > cap && type !== "tease_slam") ||
      (sharedClock &&
        (move === "clash" || move === "jaws") &&
        isPadType(type) &&
        bars >= 12 &&
        !holeOk &&
        !audioOk) ||
      (sharedClock && audioClash && isPadType(type) && bars >= 8) ||
      (sharedClock &&
        !isolator &&
        type !== "tease_slam" &&
        heard?.source === "pcm" &&
        heard.bassClash > 0.14 &&
        bars >= 8));
  const risky =
    !sequential &&
    !fail &&
    (phraseOffGrid(cur.inBars) ||
      phraseOffGrid(prev.outBars) ||
      (sharedClock && vocalOverlap && !isolator) ||
      (sharedClock && !isolator && bassClash > 0.16) ||
      (sharedClock && rel === "far" && type !== "tempo_ride" && type !== "tease_slam") ||
      (sharedClock && move === "clash"));

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
    harmony,
    compile,
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
