import { readAudioBlob } from "../storage/opfs";

/** Shared decoded buffers — engine, bounce, and sampler reuse the same PCM. */
const cache = new Map<string, AudioBuffer>();
const inflight = new Map<string, Promise<AudioBuffer | null>>();

export function peekAudioBuffer(fileRef: string): AudioBuffer | null {
  return cache.get(fileRef) ?? null;
}

export function invalidateAudioBuffer(fileRef: string) {
  cache.delete(fileRef);
  inflight.delete(fileRef);
}

export function clearAudioBufferCache() {
  cache.clear();
  inflight.clear();
}

export async function getAudioBuffer(
  ctx: BaseAudioContext,
  fileRef: string,
): Promise<AudioBuffer | null> {
  const hit = cache.get(fileRef);
  if (hit) return hit;

  const pending = inflight.get(fileRef);
  if (pending) return pending;

  const work = (async () => {
    try {
      const blob = await readAudioBlob(fileRef);
      if (!blob) return null;
      const buf = await ctx.decodeAudioData((await blob.arrayBuffer()).slice(0));
      cache.set(fileRef, buf);
      return buf;
    } catch {
      return null;
    } finally {
      inflight.delete(fileRef);
    }
  })();

  inflight.set(fileRef, work);
  return work;
}
