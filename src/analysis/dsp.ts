/** Small DSP primitives for the analysis worker — no native/WASM deps. */

export function mean(xs: ArrayLike<number>) {
  if (!xs.length) return 0;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s / xs.length;
}

export function downsampleMono(channel: Float32Array, fromRate: number, toRate: number) {
  if (fromRate === toRate) return channel;
  const ratio = fromRate / toRate;
  const length = Math.floor(channel.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = channel[Math.floor(i * ratio)] ?? 0;
  return out;
}

export function hann(n: number) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

/** In-place radix-2 FFT. */
export function fft(re: Float32Array, im: Float32Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < half; j++) {
        const jr = i + j;
        const kr = jr + half;
        const vr = re[kr]! * wRe - im[kr]! * wIm;
        const vi = re[kr]! * wIm + im[kr]! * wRe;
        re[kr] = re[jr]! - vr;
        im[kr] = im[jr]! - vi;
        re[jr] += vr;
        im[jr] += vi;
        const nWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nWRe;
      }
    }
  }
}

export function hzToPitchClass(hz: number): number {
  const midi = 69 + 12 * Math.log2(Math.max(hz, 1) / 440);
  return ((Math.round(midi) % 12) + 12) % 12;
}
