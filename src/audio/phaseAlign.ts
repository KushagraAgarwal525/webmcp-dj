/** Align slave bar position to master's beat phase (¼-bar = 1 beat in 4/4). */
export function phaseAlignBars(
  slaveBars: number,
  masterBars: number,
  gridBars = 0.25,
): number {
  const g = Math.max(1e-6, gridBars);
  const masterPhase = ((masterBars % g) + g) % g;
  const slavePhase = ((slaveBars % g) + g) % g;
  let delta = masterPhase - slavePhase;
  if (delta > g / 2) delta -= g;
  if (delta < -g / 2) delta += g;
  return Math.max(0, slaveBars + delta);
}
