import { useRef, useState } from "react";
import "./TopBar.css";
import { useSetStore } from "../commands/pipeline";
import { setPerformer } from "../audio/setPerformer";
import { exportBlset, importBlset } from "../storage/blset";
import { audioEngine } from "../audio/engine";
import { BananaLogo } from "./BananaLogo";
import { downloadSetWav } from "../audio/renderSet";

export function TopBar() {
  const title = useSetStore((s) => s.doc.title);
  const canUndo = useSetStore((s) => s.past.length > 0);
  const canRedo = useSetStore((s) => s.future.length > 0);
  const undo = useSetStore((s) => s.undo);
  const redo = useSetStore((s) => s.redo);
  const dispatch = useSetStore((s) => s.dispatch);
  const hydrate = useSetStore((s) => s.hydrate);
  const setPlaying = useSetStore((s) => s.transport.setPlaying);
  const playingA = useSetStore((s) => s.doc.decks.A.playing);
  const playingB = useSetStore((s) => s.doc.decks.B.playing);
  const hasArrangement = useSetStore((s) => s.doc.arrangement.length > 0);
  const trackCount = useSetStore((s) => Object.keys(s.doc.tracks).length);
  const loosePlaying = !setPlaying && (playingA || playingB);
  const playLabel = setPlaying
    ? "Pause"
    : loosePlaying && hasArrangement
      ? "Play set"
      : loosePlaying
        ? "Pause"
        : "Play";

  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"share" | "upload" | "download" | null>(null);

  async function onDownloadWav() {
    if (busy) return;
    if (!hasArrangement) {
      useSetStore.getState().setActivity("Add tracks to the set before Download");
      return;
    }
    setBusy("download");
    try {
      if (setPlaying) setPerformer.pause();
      const doc = useSetStore.getState().doc;
      useSetStore.getState().setActivity("Bouncing set to WAV…");
      const result = await downloadSetWav(doc, doc.title, (p, label) => {
        useSetStore
          .getState()
          .setActivity(`${label} ${Math.round(p * 100)}%`);
      });
      const mb = (result.bytes / (1024 * 1024)).toFixed(1);
      useSetStore
        .getState()
        .setActivity(`Downloaded WAV · ${result.durationSec.toFixed(0)}s · ${mb} MB`);
    } catch (e) {
      console.error(e);
      useSetStore
        .getState()
        .setActivity(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(null);
    }
  }

  async function onShare() {
    if (busy) return;
    setBusy("share");
    try {
      if (setPlaying) setPerformer.pause();
      const doc = useSetStore.getState().doc;
      await exportBlset(doc);
      useSetStore.getState().setActivity("Downloaded .blset");
    } catch (e) {
      console.error(e);
      useSetStore
        .getState()
        .setActivity(e instanceof Error ? e.message : "Share failed");
    } finally {
      setBusy(null);
    }
  }

  async function onUploadFile(file: File | null) {
    if (!file || busy) return;
    setBusy("upload");
    try {
      if (setPlaying) setPerformer.pause();
      await audioEngine.unlock();
      const { doc, audioCount, missingAudio } = await importBlset(file);
      hydrate(doc);
      useSetStore.getState().setActivity(
        missingAudio.length
          ? `Loaded set (${audioCount} audio, ${missingAudio.length} missing)`
          : `Loaded set (${audioCount} audio files)`,
      );
    } catch (e) {
      console.error(e);
      useSetStore
        .getState()
        .setActivity(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-brand" title="BananaLabs">
        <BananaLogo size={22} />
        <span className="topbar-product">BananaLabs</span>
      </div>

      <input
        className="topbar-title ph-mask"
        value={title}
        aria-label="Set name"
        onChange={(e) =>
          dispatch({ type: "set.setTitle", title: e.target.value }, "ui")
        }
      />

      <div className="topbar-actions">
        <button type="button" className="topbar-btn" disabled={!canUndo} onClick={undo}>
          Undo
        </button>
        <button type="button" className="topbar-btn" disabled={!canRedo} onClick={redo}>
          Redo
        </button>
        <button
          type="button"
          className="topbar-btn topbar-play"
          data-on={setPlaying || loosePlaying ? "true" : "false"}
          title={hasArrangement ? "Play set (arrangement + transitions)" : "Play loaded deck"}
          onClick={() => void setPerformer.toggle()}
        >
          {playLabel}
        </button>
        <button
          type="button"
          className="topbar-btn"
          disabled={busy !== null || !hasArrangement}
          title="Bounce arrangement (transitions + automation) to a WAV file"
          onClick={() => void onDownloadWav()}
        >
          {busy === "download" ? "…" : "Download"}
        </button>
        <button
          type="button"
          className="topbar-btn"
          disabled={busy !== null || trackCount === 0}
          title="Download .blset (set + audio) for reload debugging"
          onClick={() => void onShare()}
        >
          {busy === "share" ? "…" : "Share"}
        </button>
        <button
          type="button"
          className="topbar-share"
          disabled={busy !== null}
          title="Upload a .blset to restore set + audio"
          onClick={() => fileRef.current?.click()}
        >
          {busy === "upload" ? "…" : "Upload"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".blset,application/zip"
          hidden
          onChange={(e) => void onUploadFile(e.target.files?.[0] ?? null)}
        />
      </div>
    </header>
  );
}
