import "./LibraryPanel.css";
import { useRef, useState } from "react";
import { useSetStore } from "../commands/pipeline";
import { importAudioFiles } from "../library/importTracks";
import type { Track, TrackMood, TrackRole } from "../types/setdoc";
import { analysisNeedsRefresh } from "../analysis/stale";
import { deriveEnergyLevel } from "../set/builder";
import { executeLocalTool } from "../webmcp/registry";
import { PanelHeader } from "./PanelHeader";

const ROLES: TrackRole[] = ["opener", "builder", "bridge", "peak", "reset", "closer"];
const MOODS: TrackMood[] = ["dark", "bright", "driving", "warm"];
const ENERGIES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

function EnergySpark({ values }: { values: number[] }) {
  if (!values.length) return <span className="spark empty">—</span>;
  const w = 72;
  const h = 16;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values
    .map((v, i) => `${i * step},${h - Math.max(1, v) * (h - 2) - 1}`)
    .join(" ");
  return (
    <svg className="spark" width={w} height={h} aria-hidden>
      <polyline fill="none" stroke="var(--banana)" strokeWidth="1.5" points={points} />
    </svg>
  );
}

function TrackRow({ track }: { track: Track }) {
  const dispatch = useSetStore((s) => s.dispatch);
  const setActivity = useSetStore((s) => s.setActivity);
  const a = track.analysis;
  const role = track.craft?.role ?? a?.suggestedRole ?? "";
  const energy = deriveEnergyLevel(track);
  const genre = track.craft?.genreHint ?? a?.genreHint;
  const mood = track.craft?.mood ?? a?.mood;

  return (
    <li className="track-row">
      <div className="track-main">
        <div className="track-title">{track.title}</div>
        <div className="track-artist">{track.artist || "Unknown artist"}</div>
      </div>
      <div className="track-meta mono">
        {track.analysisStatus === "running" && <span className="pill">analyzing…</span>}
        {track.analysisStatus === "error" && (
          <span className="pill pill-err">{track.analysisError ?? "error"}</span>
        )}
        {track.analysisStatus === "pending" && <span className="pill">queued</span>}
        {a && (
          <>
            <span>{a.bpm.toFixed(1)} BPM</span>
            <span title={`confidence ${a.key.confidence}`}>
              {a.key.camelot}
              {a.key.name ? ` ${a.key.name}` : ""}
            </span>
            {energy != null && <span className="pill">E{energy}</span>}
            {genre && genre !== "unknown" && <span>{genre}</span>}
            {mood && <span>{mood}</span>}
            {a.vocalLead && <span className="pill">vocal</span>}
            {analysisNeedsRefresh(a) && <span className="pill pill-err">stale</span>}
            <span>{Math.round(a.durationBars)} bars</span>
            <EnergySpark values={a.energy} />
          </>
        )}
      </div>
      {a && (
        <div className="track-craft">
          <label>
            Role
            <select
              value={role}
              onChange={(e) => {
                const v = e.target.value;
                dispatch({
                  type: "library.setCraft",
                  trackId: track.id,
                  craft: { role: v ? (v as TrackRole) : undefined },
                });
              }}
            >
              <option value="">auto</option>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label>
            E
            <select
              value={track.craft?.energyLevel ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                dispatch({
                  type: "library.setCraft",
                  trackId: track.id,
                  craft: { energyLevel: v ? Number(v) : undefined },
                });
              }}
            >
              <option value="">auto</option>
              {ENERGIES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <label>
            Mood
            <select
              value={track.craft?.mood ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                dispatch({
                  type: "library.setCraft",
                  trackId: track.id,
                  craft: { mood: v ? (v as TrackMood) : undefined },
                });
              }}
            >
              <option value="">auto</option>
              {MOODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {a && (
        <div className="track-sections">
          {a.sections.slice(0, 6).map((s) => (
            <span key={`${s.label}-${s.startBars}`} className="section-chip">
              {s.label} {s.startBars.toFixed(0)}–{s.endBars.toFixed(0)}
            </span>
          ))}
        </div>
      )}
      <div className="track-actions">
        <button
          type="button"
          onClick={() => dispatch({ type: "deck.load", deck: "A", trackId: track.id })}
        >
          → A
        </button>
        <button
          type="button"
          onClick={() => dispatch({ type: "deck.load", deck: "B", trackId: track.id })}
        >
          → B
        </button>
        <button
          type="button"
          onClick={async () => {
            dispatch({ type: "deck.load", deck: "A", trackId: track.id });
            await executeLocalTool("prep_hotcues", { deck: "A" });
            setActivity("Cues on A");
          }}
        >
          Cues A
        </button>
        <button
          type="button"
          title="Re-run key / grid / sections / role"
          onClick={async () => {
            setActivity(`Re-analyzing ${track.title}…`);
            await executeLocalTool("analyze_track", { track_id: track.id });
            setActivity("Re-analyzed");
          }}
        >
          Re-analyze
        </button>
      </div>
    </li>
  );
}

export function LibraryPanel() {
  const tracksMap = useSetStore((s) => s.doc.tracks);
  const tracks = Object.values(tracksMap);
  const setActivity = useSetStore((s) => s.setActivity);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<string | null>(null);
  const staleCount = tracks.filter((t) => analysisNeedsRefresh(t.analysis)).length;

  async function handleFiles(files: FileList | File[]) {
    const list = [...files].filter((f) => f.type.startsWith("audio/") || /\.(mp3|wav|flac|m4a|ogg|aiff?)$/i.test(f.name));
    if (!list.length) return;
    setBusy(true);
    setActivity(`Importing ${list.length} track${list.length === 1 ? "" : "s"}…`);
    try {
      await importAudioFiles(list);
    } finally {
      setBusy(false);
      setActivity("Ready");
    }
  }

  async function showHealth() {
    const raw = await executeLocalTool("get_crate_health", {});
    try {
      const parsed = JSON.parse(raw) as {
        notes?: string[];
        orphans?: string[];
        trackCount?: number;
        bpmLanes?: Record<string, number>;
        roles?: Record<string, number>;
      };
      const lines = [
        `${parsed.trackCount ?? 0} analyzed`,
        parsed.orphans?.length ? `orphans ${parsed.orphans.join(", ")}` : "harmonic coverage ok",
        parsed.notes?.join("\n") ?? "",
      ];
      setHealth(lines.filter(Boolean).join("\n"));
      setActivity("crate health");
    } catch {
      setHealth(raw);
    }
  }

  return (
    <aside className="flyout library-panel">
      <PanelHeader title="Library">
        <button
          type="button"
          className="panel-action"
          onClick={() => void showHealth()}
        >
          Health
        </button>
        {staleCount > 0 && (
          <button
            type="button"
            className="panel-action"
            disabled={busy}
            title={`${staleCount} track${staleCount === 1 ? "" : "s"} on the old detector`}
            onClick={async () => {
              setBusy(true);
              setActivity(`Re-analyzing ${staleCount} stale track${staleCount === 1 ? "" : "s"}…`);
              try {
                for (const t of tracks.filter((x) => analysisNeedsRefresh(x.analysis))) {
                  await executeLocalTool("analyze_track", { track_id: t.id });
                }
                setActivity("Crate re-analyzed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Re-analyze {staleCount}
          </button>
        )}
        <button
          type="button"
          className="panel-action"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          Upload
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg,.aif,.aiff"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void handleFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </PanelHeader>

      {health && <pre className="lib-health mono">{health}</pre>}

      <div
        className={`dropzone${dragging ? " is-drag" : ""}`}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles(e.dataTransfer.files);
        }}
      >
        Drop songs — real key, beatgrid, roles, energy on upload
      </div>

      <ul className="track-list">
        {tracks.length === 0 && (
          <li className="track-empty">No tracks yet. Upload a crate to begin.</li>
        )}
        {tracks
          .slice()
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((track) => (
            <TrackRow key={track.id} track={track} />
          ))}
      </ul>
    </aside>
  );
}
