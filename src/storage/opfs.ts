const AUDIO_DIR = "audio";

async function getAudioDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(AUDIO_DIR, { create: true });
}

export async function writeAudioBlob(
  fileRef: string,
  blob: Blob,
): Promise<void> {
  const dir = await getAudioDir();
  const handle = await dir.getFileHandle(fileRef, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

export async function readAudioBlob(fileRef: string): Promise<Blob | null> {
  try {
    const dir = await getAudioDir();
    const handle = await dir.getFileHandle(fileRef);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function deleteAudioBlob(fileRef: string): Promise<void> {
  try {
    const dir = await getAudioDir();
    await dir.removeEntry(fileRef);
  } catch {
    // ignore missing
  }
}

export function makeFileRef(originalName: string): string {
  const safe = originalName.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 64);
  return `${crypto.randomUUID()}-${safe}`;
}
