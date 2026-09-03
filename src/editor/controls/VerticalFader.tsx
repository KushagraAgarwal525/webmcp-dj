import {
  useCallback,
  useLayoutEffect,
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
  live?: boolean;
  livePath?: string;
  getValue?: () => number;
};

function paintFaderEl(
  el: HTMLElement,
  value: number,
  min: number,
  max: number,
  horizontal: boolean,
) {
  const span = max - min || 1;
  const t = Math.min(1, Math.max(0, (value - min) / span));
  const pct = horizontal ? t * 100 : (1 - t) * 100;
  el.style.setProperty("--fader-pct", `${horizontal ? t * 100 : pct}%`);
  el.style.setProperty("--fader-fill", `${t * 100}%`);
  const fill = el.querySelector(".hw-fader-fill");
  const thumb = el.querySelector(".hw-fader-thumb");
  if (!horizontal && fill instanceof HTMLElement) fill.style.height = `${t * 100}%`;
  if (!horizontal && thumb instanceof HTMLElement) thumb.style.top = `${pct}%`;
}

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
  live,
  livePath,
  getValue,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const span = max - min || 1;
  const t = Math.min(1, Math.max(0, (value - min) / span));
  const pct = horizontal ? t * 100 : (1 - t) * 100;

  useLayoutEffect(() => {
    if (!live || !rootRef.current) return;
    paintFaderEl(rootRef.current, getValue?.() ?? value, min, max, Boolean(horizontal));
  }, [live, getValue, value, min, max, horizontal]);

  const valueFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      const el = trackRef.current;
      if (!el) return getValue?.() ?? value;
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
    [getValue, horizontal, max, min, span, step, value],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (disabled) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const next = valueFromEvent(e.clientX, e.clientY);
      if (live && rootRef.current) {
        paintFaderEl(rootRef.current, next, min, max, Boolean(horizontal));
      }
      onChange(next);
    },
    [disabled, horizontal, live, max, min, onChange, valueFromEvent],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (disabled || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const next = valueFromEvent(e.clientX, e.clientY);
      if (live && rootRef.current) {
        paintFaderEl(rootRef.current, next, min, max, Boolean(horizontal));
      }
      onChange(next);
    },
    [disabled, horizontal, live, max, min, onChange, valueFromEvent],
  );

  return (
    <div
      ref={rootRef}
      className={`hw-fader${horizontal ? " is-horizontal" : ""}${disabled ? " is-disabled" : ""}`}
      data-live={live ? "fader" : undefined}
      data-live-path={live ? livePath : undefined}
      data-live-min={live ? String(min) : undefined}
      data-live-max={live ? String(max) : undefined}
      style={
        {
          "--fader-h": `${length}px`,
          ...(live
            ? {}
            : {
                "--fader-pct": `${horizontal ? t * 100 : pct}%`,
                "--fader-fill": `${t * 100}%`,
              }),
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
          <div
            className="hw-fader-fill"
            style={live ? undefined : { height: `${t * 100}%` }}
          />
        )}
        {horizontal && <div className="hw-fader-fill" />}
        <div
          className="hw-fader-thumb"
          style={
            live || horizontal ? undefined : { top: `${pct}%` }
          }
        />
      </div>
    </div>
  );
}
