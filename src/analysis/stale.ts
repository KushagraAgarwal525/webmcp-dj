import type { Track, TrackAnalysis } from "../types/setdoc";

/** Old IndexedDB rows lack DSP fields added in the salience/edma rebuild. */
export function analysisNeedsRefresh(a?: TrackAnalysis | null): boolean {
  if (!a) return false;
  return (
    a.energyLevel == null ||
    a.key.name == null ||
    a.key.window == null ||
    a.key.profile !== "edma" ||
    a.detector !== "salience-v1" ||
    a.dropBars == null ||
    a.brightness == null ||
    !a.chromaCurve ||
    a.chromaCurve.length < 8
  );
}

export function staleTrackIds(tracks: Track[]): string[] {
  return tracks.filter((t) => analysisNeedsRefresh(t.analysis)).map((t) => t.id);
}
