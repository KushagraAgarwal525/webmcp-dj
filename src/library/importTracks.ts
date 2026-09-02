import { useSetStore } from "../commands/pipeline";
import { persistAnalysis } from "../storage/db";
import { makeFileRef, writeAudioBlob, readAudioBlob } from "../storage/opfs";
import { analyzeInWorker, decodeAudioFile } from "../analysis/runAnalysis";
import { lookupRecordingMeta } from "./musicbrainz";
import { captureLibraryImport } from "../analytics/tools";

function parseFilename(name: string): { title: string; artist: string } {
  const base = name.replace(/\.[^.]+$/, "");
  const parts = base.split(" - ");
  if (parts.length >= 2) {
    return { artist: parts[0]!.trim(), title: parts.slice(1).join(" - ").trim() };
  }
  return { title: base, artist: "" };
}

async function enrichGenreFromMusicBrainz(trackId: string, artist: string, title: string) {
  const track = useSetStore.getState().doc.tracks[trackId];
  const source = track?.craft?.genreSource;
  if (source === "human" || source === "agent") return;
  const meta = await lookupRecordingMeta(artist, title);
  if (!meta) return;
  const hint = meta.genres[0] ?? meta.tags[0];
  if (!hint) return;
  useSetStore.getState().dispatch({
    type: "library.setCraft",
    trackId,
    craft: { genreHint: hint, genreSource: "musicbrainz" },
  });
}

const queue: File[] = [];
let pumping = false;

async function processOne(file: File) {
  const dispatch = useSetStore.getState().dispatch;
  const trackId = crypto.randomUUID();
  const fileRef = makeFileRef(file.name);
  const { title, artist } = parseFilename(file.name);

  await writeAudioBlob(fileRef, file);
  dispatch({
    type: "library.addTrack",
    track: { id: trackId, fileRef, title, artist },
  });
  dispatch({ type: "library.setAnalysisStatus", trackId, status: "running" });

  try {
    const decoded = await decodeAudioFile(file);
    const analysis = await analyzeInWorker(decoded.samples, decoded.sampleRate);
    analysis.durationSec = decoded.durationSec;
    analysis.durationBars = (decoded.durationSec * analysis.bpm) / 60 / 4;
    await persistAnalysis(trackId, analysis);
    dispatch({ type: "library.setAnalysis", trackId, analysis });
    void enrichGenreFromMusicBrainz(trackId, artist, title);
  } catch (err) {
    dispatch({
      type: "library.setAnalysisStatus",
      trackId,
      status: "error",
      error: err instanceof Error ? err.message : "analysis failed",
    });
  }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const file = queue.shift()!;
    await processOne(file);
  }
  pumping = false;
}

export async function importAudioFiles(files: File[]) {
  if (!files.length) return;
  const importedTitles = files.map((file) => {
    const { title, artist } = parseFilename(file.name);
    return artist ? `${artist} - ${title}` : title;
  });
  queue.push(...files);
  await pump();
  captureLibraryImport(files.length, importedTitles);
}

export async function reanalyzeTrack(trackId: string, signal?: AbortSignal) {
  const track = useSetStore.getState().doc.tracks[trackId];
  if (!track) throw new Error("track not found");
  if (signal?.aborted) throw new Error("aborted");
  const dispatch = useSetStore.getState().dispatch;
  dispatch({ type: "library.setAnalysisStatus", trackId, status: "running" });
  const blob = await readAudioBlob(track.fileRef);
  if (!blob) {
    dispatch({
      type: "library.setAnalysisStatus",
      trackId,
      status: "error",
      error: "audio missing",
    });
    throw new Error("audio missing");
  }
  const decoded = await decodeAudioFile(blob);
  if (signal?.aborted) throw new Error("aborted");
  const analysis = await analyzeInWorker(decoded.samples, decoded.sampleRate);
  analysis.durationSec = decoded.durationSec;
  analysis.durationBars = (decoded.durationSec * analysis.bpm) / 60 / 4;
  await persistAnalysis(trackId, analysis);
  dispatch({ type: "library.setAnalysis", trackId, analysis });
  void enrichGenreFromMusicBrainz(trackId, track.artist, track.title);
}
