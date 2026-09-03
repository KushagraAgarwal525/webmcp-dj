import {
  useCallback,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./controls.css";

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  size?: number;
  onChange: (value: number) => void;
  /** Needle driven by mixerVisuals rAF, not React. */
  live?: boolean;
  livePath?: string;
  getValue?: () => number;
};

function angleOf(value: number, min: number, max: number): number {
  const span = max - min || 1;
  const t = Math.min(1, Math.max(0, (value - min) / span));
  return -135 + t * 270;
}

/** Hardware-style rotary; drag vertically to change value. */
export function RotaryKnob({
  label,
  value,
  min,
  max,
  step = 0.01,
  disabled,
  size = 40,
  onChange,
  live,
  livePath,
  getValue,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ y: number; v: number } | null>(null);
  const span = max - min || 1;
  const angle = angleOf(value, min, max);

  useLayoutEffect(() => {
    if (!live || !rootRef.current) return;
    rootRef.current.style.setProperty("--knob-angle", `${angleOf(getValue?.() ?? value, min, max)}deg`);
  }, [live, getValue, value, min, max]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (disabled) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { y: e.clientY, v: getValue?.() ?? value };
    },
    [disabled, getValue, value],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!start.current || disabled) return;
      const dy = start.current.y - e.clientY;
      const delta = (dy / 100) * span;
      let next = start.current.v + delta;
      next = Math.round(next / step) * step;
      next = Math.min(max, Math.max(min, next));
      if (live && rootRef.current) {
        rootRef.current.style.setProperty("--knob-angle", `${angleOf(next, min, max)}deg`);
      }
      onChange(next);
    },
    [disabled, live, max, min, onChange, span, step],
  );

  const onPointerUp = useCallback(() => {
    start.current = null;
  }, []);

  return (
    <div
      ref={rootRef}
      className={`hw-knob${disabled ? " is-disabled" : ""}`}
      data-live={live ? "knob" : undefined}
      data-live-path={live ? livePath : undefined}
      data-live-min={live ? String(min) : undefined}
      data-live-max={live ? String(max) : undefined}
      style={
        {
          "--knob-size": `${size}px`,
          ...(live ? {} : { "--knob-angle": `${angle}deg` }),
        } as CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      title={`${label}: ${(getValue?.() ?? value).toFixed(2)}`}
    >
      <div className="hw-knob-dial">
        <div className="hw-knob-pointer" />
      </div>
      <span className="hw-knob-label">{label}</span>
    </div>
  );
}
