import { camelotSemitoneDelta, classifyCamelotMove } from "./builder";

/** Last bars of an overlap: pitch eases onto the musical landing. */
export const RIDE_PITCH_BARS = 4;

/** Below this, a vinyl unlock is a quarter-tone, not a scream. Stay locked. */
const VINYL_DEAD_SEMITONES = 0.45;
/** Cap the same-key scream so a 20% BPM gap is a minor third, not chipmunk. */
const VINYL_MAX_SEMITONES = 3;

/**
 * 0 before the window, ease-in through it, 1 at/after the end (hold through
 * the peel — snapping back to 0 while the outgoing is still up is a click).
 */
export function ridePitchAmount(
  setBars: number,
  windowEnd: number,
  windowBars = RIDE_PITCH_BARS,
): number {
  const span = Math.max(0.25, windowBars);
  const t = (setBars - (windowEnd - span)) / span;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t;
}

/**
 * Where the outgoing deck should land, in semitones, while the incoming
 * stays keylocked.
 *
 * Across keys this is NOT “turn keylock off.” Vinyl follows the BPM ratio,
 * which is almost never a musical interval — 3–6% is 50–100¢ of detune
 * against the incoming tonic. Instead:
 *
 * - energy_boost (±2 Camelot = a whole tone, same mode): transpose onto
 *   the incoming tonic so the records meet.
 * - same key: snap the vinyl cents onto ±1..±3 semitones, or stay at 0
 *   when the gap is in the cracks.
 * - relative / adjacent / clash: 0. Relative already shares pitch classes;
 *   a fifth is mixable without a 7-semitone jump; a clash should not add
 *   more beating.
 */
export function ridePitchSemitones(args: {
  fromCamelot?: string | null;
  toCamelot?: string | null;
  /** Outgoing native → tempo-lane end (or incoming BPM if un-laned). */
  tempoRatio: number;
}): number {
  const vinyl = 12 * Math.log2(Math.max(0.05, args.tempoRatio));
  const from = args.fromCamelot?.trim() ?? "";
  const to = args.toCamelot?.trim() ?? "";
  const move = from && to ? classifyCamelotMove(from, to) : "same";
  const keyDelta = from && to ? camelotSemitoneDelta(from, to) : 0;

  if (move === "energy_boost" && keyDelta) return keyDelta;
  if (move !== "same") return 0;

  if (Math.abs(vinyl) < VINYL_DEAD_SEMITONES) return 0;
  const snapped = Math.round(vinyl);
  const signed = snapped === 0 ? (vinyl > 0 ? 1 : -1) : snapped;
  return Math.max(-VINYL_MAX_SEMITONES, Math.min(VINYL_MAX_SEMITONES, signed));
}
