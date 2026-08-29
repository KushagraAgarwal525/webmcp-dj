import type { TrackAnalysis } from "../types/setdoc";

/** Snap a bar position to the nearest beat (or bar if no beats). */
export function quantizeBars(
  positionBars: number,
  analysis: TrackAnalysis | undefined,
  mode: "beat" | "bar" = "beat",
): number {
  if (!analysis || !Number.isFinite(positionBars)) return Math.max(0, positionBars);
  if (mode === "bar") return Math.max(0, Math.round(positionBars));

  const bpm = analysis.bpm || 120;
  const barSec = (60 / bpm) * 4;
  const targetSec = positionBars * barSec;

  const beats = analysis.beats;
  if (!beats.length) {
    // Fall back to 1/4-bar grid
    const beatBars = 0.25;
    return Math.max(0, Math.round(positionBars / beatBars) * beatBars);
  }

  let best = beats[0]!;
  let bestDist = Math.abs(best - targetSec);
  for (const t of beats) {
    const d = Math.abs(t - targetSec);
    if (d < bestDist) {
      best = t;
      bestDist = d;
    }
  }
  return Math.max(0, best / barSec);
}
