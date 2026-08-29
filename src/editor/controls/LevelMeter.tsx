import type { CSSProperties } from "react";
import "./controls.css";

type Props = {
  /** 0–1 level */
  level: number;
  height?: number;
};

export function LevelMeter({ level, height = 100 }: Props) {
  const pct = Math.min(100, Math.max(0, level * 100));
  return (
    <div
      className="hw-meter"
      style={{ "--meter-h": `${height}px` } as CSSProperties}
      aria-hidden
    >
      <div className="hw-meter-fill" style={{ height: `${pct}%` }} />
    </div>
  );
}
