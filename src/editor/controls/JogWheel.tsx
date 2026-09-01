import type { CSSProperties } from "react";
import "./controls.css";

type Props = {
  deck: "A" | "B";
  bpm: number | null;
  playing: boolean;
  playheadBars: number;
  empty?: boolean;
  title?: string;
};

/** Flat CDJ-style jog wheel — spins with playback. */
export function JogWheel({
  deck,
  bpm,
  playing,
  playheadBars,
  empty,
  title,
}: Props) {
  const angle = (playheadBars / 2) * 360;
  const barSec = bpm && bpm > 0 ? (60 / bpm) * 4 : 2;
  const revSec = barSec * 2;
  // While spinning, leave --jog-angle alone so the CSS animation isn't restarted.
  const ringStyle = {
    "--jog-duration": `${Math.max(0.4, revSec)}s`,
    ...(playing ? {} : { "--jog-angle": `${angle}deg` }),
  } as CSSProperties;

  return (
    <div
      className={`jog${playing ? " is-playing" : ""}${empty ? " is-empty" : ""}`}
      aria-label={`Deck ${deck} jog`}
    >
      <div className="jog-outer">
        <div
          className={`jog-ring${playing ? " is-spinning" : ""}`}
          style={ringStyle}
        />
        <div className="jog-face">
          <span className="jog-deck">{deck}</span>
          <span className="jog-bpm mono">
            {bpm != null ? bpm.toFixed(1) : "—"}
          </span>
          <span className="jog-sub">{empty ? "LOAD" : title || "READY"}</span>
        </div>
      </div>
    </div>
  );
}
