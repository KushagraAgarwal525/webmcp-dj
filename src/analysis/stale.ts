import type { Track, TrackAnalysis } from "../types/setdoc";

/** Old IndexedDB rows lack DSP fields added in the analysis rebuild. */
export function analysisNeedsRefresh(a?: TrackAnalysis | null): boolean {
  if (!a) return false;
  return (
    a.energyLevel == null ||
    a.suggestedRole == null ||
    a.genreHint == null ||
    a.key.name == null
  );
}

export function staleTrackIds(tracks: Track[]): string[] {
  return tracks.filter((t) => analysisNeedsRefresh(t.analysis)).map((t) => t.id);
}
