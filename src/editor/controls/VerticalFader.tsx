import {
  useCallback,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./controls.css";

type Props = {
  label?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  horizontal?: boolean;
  length?: number;
  onChange: (value: number) => void;
};

/** Vertical (or horizontal) hardware fader. */
export function VerticalFader({
  label,
  value,
  min,
  max,
  step = 0.01,
  disabled,
  horizontal,
  length = 140,
  onChange,
}: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = max - min || 1;
  const t = Math.min(1, Math.max(0, (value - min) / span));
  // Vertical: 1 at top visually for channel faders (0 bottom)
  const pct = horizontal ? t * 100 : (1 - t) * 100;

  const valueFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const el = trackRef.current;
      if (!el) return value;
      const rect = el.getBoundingClientRect();
      let n: number;
      if (horizontal) {
        n = (clientX - rect.left) / rect.width;
      } else {
        n = 1 - (clientY - rect.top) / rect.height;
      }
      n = Math.min(1, Math.max(0, n));
      let next = min + n * span;
      next = Math.round(next / step) * step;
      return Math.min(max, Math.max(min, next));
    },
    [horizontal, max, min, span, step, value],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (disabled) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      onChange(valueFromEvent(e.clientX, e.clientY));
    },
    [disabled, onChange, valueFromEvent],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (disabled || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
      onChange(valueFromEvent(e.clientX, e.clientY));
    },
    [disabled, onChange, valueFromEvent],
  );

  return (
    <div
      className={`hw-fader${horizontal ? " is-horizontal" : ""}${disabled ? " is-disabled" : ""}`}
      style={
        {
          "--fader-h": `${length}px`,
          "--fader-pct": `${horizontal ? t * 100 : pct}%`,
          "--fader-fill": `${t * 100}%`,
        } as CSSProperties
      }
    >
      {label && <span className="hw-fader-label">{label}</span>}
      <div
        ref={trackRef}
        className="hw-fader-track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
      >
        {!horizontal && (
          <div className="hw-fader-fill" style={{ height: `${t * 100}%` }} />
        )}
        {horizontal && <div className="hw-fader-fill" />}
        <div
          className="hw-fader-thumb"
          style={
            horizontal
              ? undefined
              : { top: `${pct}%` }
          }
        />
      </div>
    </div>
  );
}
