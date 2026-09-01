/** Encode a stereo/mono AudioBuffer as a 16-bit PCM WAV blob. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels >= 2 ? 2 : 1;
  const sampleRate = buffer.sampleRate;
  const numFrames = buffer.length;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const headerSize = 44;
  const ab = new ArrayBuffer(headerSize + dataSize);
  const view = new DataView(ab);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  const left = buffer.getChannelData(0);
  const right = numChannels > 1 ? buffer.getChannelData(1) : left;
  let o = headerSize;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, left[i]!));
    const r = Math.max(-1, Math.min(1, right[i]!));
    view.setInt16(o, (l < 0 ? l * 0x8000 : l * 0x7fff) | 0, true);
    o += 2;
    if (numChannels > 1) {
      view.setInt16(o, (r < 0 ? r * 0x8000 : r * 0x7fff) | 0, true);
      o += 2;
    }
  }

  return new Blob([ab], { type: "audio/wav" });
}
