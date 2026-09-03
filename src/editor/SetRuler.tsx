import { memo, useRef, type PointerEvent } from "react";
import { useSetStore } from "../commands/pipeline";
import { setPerformer } from "../audio/setPerformer";
import { buildTimeline, masterBpm, setDurationBars, type TimelineSpan } from "../set/timeline";
import type { SetDoc } from "../types/setdoc";

function formatRemain(bars: number, bpm: number): string {
  const sec = Math.max(0, bars) * (240 / Math.max(1, bpm));
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `−${m}:${s.toString().padStart(2, "0")}`;
}

function seekFromClientX(
  clientX: number,
  track: HTMLElement,
  duration: number,
) {
  const rect = track.getBoundingClientRect();
  const frac = (clientX - rect.left) / Math.max(1, rect.width);
  void setPerformer.seek(Math.max(0, Math.min(1, frac)) * duration);
}

function SetRulerReadout({ duration, bpm }: { duration: number; bpm: number }) {
  const setPos = useSetStore((s) => s.transport.setPositionBars);
  const setPlaying = useSetStore((s) => s.transport.setPlaying);
  const remain = duration > 0 ? formatRemain(duration - setPos, bpm) : "";
  if (!setPlaying && setPos <= 0) return null;
  return (
    <>
      {` · @${setPos.toFixed(1)}`}
      {remain ? ` · ${remain}` : ""}
    </>
  );
}

function SetRulerCaret({ duration }: { duration: number }) {
  const setPos = useSetStore((s) => s.transport.setPositionBars);
  const playheadPct = duration > 0 ? (setPos / duration) * 100 : 0;
  return <div className="set-playhead" style={{ left: `${playheadPct}%` }} />;
}

const SetRulerBlocks = memo(function SetRulerBlocks({
  spans,
  duration,
  tracks,
  entryIndex,
}: {
  spans: TimelineSpan[];
  duration: number;
  tracks: SetDoc["tracks"];
  entryIndex: number;
}) {
  return (
    <>
      {spans.map((span) => {
        const t = tracks[span.entry.trackId];
        const widthPct =
          duration > 0 ? ((span.setEnd - span.setStart) / duration) * 100 : 0;
        const leftPct = duration > 0 ? (span.setStart / duration) * 100 : 0;
        return (
          <div
            key={span.entry.id}
            className={`set-block ph-no-mask${span.entryIndex === entryIndex ? " is-active" : ""}`}
            style={{
              width: `${Math.max(4, widthPct)}%`,
              left: `${leftPct}%`,
            }}
            title={`${t?.title ?? "Track"} · ${span.entry.transition.type}`}
          >
            {span.entryIndex + 1}. {t?.title ?? "Track"}
          </div>
        );
      })}
      {spans
        .filter((s) => s.overlapBars > 0 && duration > 0)
        .map((span) => {
          const leftPct = (span.setStart / duration) * 100;
          const widthPct = (span.overlapBars / duration) * 100;
          return (
            <div
              key={`ov-${span.entry.id}`}
              className="set-overlap"
              style={{ left: `${leftPct}%`, width: `${Math.max(1.2, widthPct)}%` }}
              title={`${span.entry.transition.type} ${span.entry.transition.bars}b`}
            >
              {span.entry.transition.type}
            </div>
          );
        })}
    </>
  );
});

/** Arrangement ruler — blocks stay mounted; only the caret ticks with the playhead. */
export function SetRuler() {
  const arrangement = useSetStore((s) => s.doc.arrangement);
  const tracks = useSetStore((s) => s.doc.tracks);
  const automation = useSetStore((s) => s.doc.automation);
  const setTempoBpm = useSetStore((s) => s.doc.setTempoBpm);
  const trackCount = useSetStore((s) => s.doc.crates.all?.trackIds.length ?? 0);
  const entryIndex = useSetStore((s) => s.transport.entryIndex);
  const dragging = useRef(false);

  const slim = { arrangement, automation, setTempoBpm, tracks } as SetDoc;
  const spans = buildTimeline(slim);
  const duration = setDurationBars(slim);
  const bpm = masterBpm(slim);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekFromClientX(e.clientX, e.currentTarget, duration);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    seekFromClientX(e.clientX, e.currentTarget, duration);
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* */
    }
  };

  return (
    <section className="set-ruler">
      <header>
        <h3>Set</h3>
        <span className="mono">
          {arrangement.length}tr
          {duration > 0 ? ` · ${duration.toFixed(0)}b` : ""}
          <SetRulerReadout duration={duration} bpm={bpm} />
        </span>
      </header>
      {arrangement.length === 0 ? (
        <div className="set-ruler-empty">
          {trackCount === 0
            ? "Assets → upload tracks"
            : "No arrangement — open Set or use agent tools"}
        </div>
      ) : (
        <div
          className="set-ruler-track"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <SetRulerBlocks
            spans={spans}
            duration={duration}
            tracks={tracks}
            entryIndex={entryIndex}
          />
          <SetRulerCaret duration={duration} />
        </div>
      )}
    </section>
  );
}
