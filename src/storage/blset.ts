import JSZip from "jszip";
import { saveAs } from "file-saver";
import type { SetDoc } from "../types/setdoc";
import { normalizeDoc } from "../commands/applyCommand";
import { readAudioBlob, writeAudioBlob } from "./opfs";
import { persistSetDoc } from "./db";

const MANIFEST_VERSION = 1;

export type BlsetManifest = {
  format: "bananalabs.blset";
  version: number;
  exportedAt: number;
  title: string;
};

/** Pack SetDoc + OPFS audio into a downloadable .blset (ZIP). */
export async function exportBlset(doc: SetDoc): Promise<void> {
  const zip = new JSZip();
  const manifest: BlsetManifest = {
    format: "bananalabs.blset",
    version: MANIFEST_VERSION,
    exportedAt: Date.now(),
    title: doc.title,
  };
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("setdoc.json", JSON.stringify(doc, null, 2));

  const audio = zip.folder("audio");
  if (!audio) throw new Error("failed to create audio folder");

  const refs = new Set<string>();
  for (const track of Object.values(doc.tracks)) {
    if (track.fileRef) refs.add(track.fileRef);
  }

  let missing = 0;
  for (const ref of refs) {
    const blob = await readAudioBlob(ref);
    if (!blob) {
      missing += 1;
      continue;
    }
    audio.file(ref, blob);
  }

  const out = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const safe = (doc.title || "set").replace(/[^\w\-]+/g, "_").slice(0, 48);
  saveAs(out, `${safe}.blset`);

  if (missing > 0) {
    console.warn(`[blset] ${missing} audio file(s) missing from OPFS`);
  }
}

export type ImportBlsetResult = {
  doc: SetDoc;
  audioCount: number;
  missingAudio: string[];
};

/** Unpack a .blset into OPFS + return a hydrated SetDoc. */
export async function importBlset(file: File): Promise<ImportBlsetResult> {
  const zip = await JSZip.loadAsync(file);
  const setdocFile = zip.file("setdoc.json");
  if (!setdocFile) throw new Error("invalid .blset: missing setdoc.json");

  const raw = JSON.parse(await setdocFile.async("string")) as SetDoc;
  let doc = normalizeDoc(raw);
  // Fresh identity so we don't collide with the previous session id
  doc = {
    ...doc,
    id: crypto.randomUUID(),
    updatedAt: Date.now(),
    record: { recording: false, startedAt: null, lastBlobUrl: null },
  };

  const missingAudio: string[] = [];
  let audioCount = 0;

  const audioEntries = Object.entries(zip.files).filter(
    ([path, entry]) => path.startsWith("audio/") && !entry.dir,
  );
  for (const [path, entry] of audioEntries) {
    const ref = path.slice("audio/".length);
    if (!ref) continue;
    const blob = await entry.async("blob");
    await writeAudioBlob(ref, blob);
    audioCount += 1;
  }

  for (const track of Object.values(doc.tracks)) {
    if (!track.fileRef) continue;
    const exists = await readAudioBlob(track.fileRef);
    if (!exists) missingAudio.push(track.fileRef);
  }

  // Pause all decks on import
  for (const deck of ["A", "B", "C", "D"] as const) {
    doc = {
      ...doc,
      decks: {
        ...doc.decks,
        [deck]: { ...doc.decks[deck], playing: false },
      },
    };
  }

  await persistSetDoc(doc);
  return { doc, audioCount, missingAudio };
}
