import type { ButtonHTMLAttributes, ReactNode } from "react";
import "./controls.css";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  led?: boolean;
  pad?: boolean;
  hasCue?: boolean;
  children: ReactNode;
};

export function HardwareButton({
  led,
  pad,
  hasCue,
  className = "",
  children,
  ...rest
}: Props) {
  const cls = [
    "hw-btn",
    led ? "is-on" : "",
    pad ? "is-pad" : "",
    hasCue ? "has-cue" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}
