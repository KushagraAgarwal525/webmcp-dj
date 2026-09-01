/** Copy [startSec, startSec+durationSec) from src, reversed. */
export function reversedSlice(
  ctx: BaseAudioContext,
  src: AudioBuffer,
  startSec: number,
  durationSec: number,
): AudioBuffer {
  const rate = src.sampleRate;
  const start = Math.max(0, Math.min(src.length - 1, Math.floor(startSec * rate)));
  const want = Math.max(1, Math.floor(durationSec * rate));
  const len = Math.max(1, Math.min(want, src.length - start));
  const out = ctx.createBuffer(src.numberOfChannels, len, rate);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const a = src.getChannelData(c);
    const b = out.getChannelData(c);
    for (let i = 0; i < len; i++) {
      b[i] = a[start + len - 1 - i]!;
    }
  }
  return out;
}
