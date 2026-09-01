import { useEffect, useRef, type CSSProperties } from "react";
import type { DeckId } from "../../types/setdoc";
import { audioEngine } from "../../audio/engine";
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

/** VU from the engine AnalyserNode — updates the fill in the DOM, no React churn. */
export function LiveLevelMeter({
  deck,
  height = 100,
}: {
  deck: DeckId;
  height?: number;
}) {
  const fillRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = fillRef.current;
      if (el) {
        const pct = Math.min(100, audioEngine.getDeckLevel(deck) * 100);
        el.style.height = `${pct}%`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [deck]);

  return (
    <div
      className="hw-meter"
      style={{ "--meter-h": `${height}px` } as CSSProperties}
      aria-hidden
    >
      <div className="hw-meter-fill" ref={fillRef} style={{ height: "0%" }} />
    </div>
  );
}
