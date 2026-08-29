import {
  useCallback,
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
};

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
}: Props) {
  const start = useRef<{ y: number; v: number } | null>(null);
  const span = max - min || 1;
  const t = Math.min(1, Math.max(0, (value - min) / span));
  const angle = -135 + t * 270;

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (disabled) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { y: e.clientY, v: value };
    },
    [disabled, value],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!start.current || disabled) return;
      const dy = start.current.y - e.clientY;
      const delta = (dy / 100) * span;
      let next = start.current.v + delta;
      next = Math.round(next / step) * step;
      next = Math.min(max, Math.max(min, next));
      onChange(next);
    },
    [disabled, max, min, onChange, span, step],
  );

  const onPointerUp = useCallback(() => {
    start.current = null;
  }, []);

  return (
    <div
      className={`hw-knob${disabled ? " is-disabled" : ""}`}
      style={
        {
          "--knob-size": `${size}px`,
          "--knob-angle": `${angle}deg`,
        } as CSSProperties
      }
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      title={`${label}: ${value.toFixed(2)}`}
    >
      <div className="hw-knob-dial">
        <div className="hw-knob-pointer" />
      </div>
      <span className="hw-knob-label">{label}</span>
    </div>
  );
}
