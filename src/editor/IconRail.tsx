import "./IconRail.css";
import { useSetStore } from "../commands/pipeline";

const ITEMS = [
  { id: "library" as const, label: "Assets", icon: "▣" },
  { id: "set" as const, label: "Set", icon: "☰" },
  { id: "agent" as const, label: "Agent", icon: "✦" },
];

export function IconRail() {
  const rail = useSetStore((s) => s.rail);
  const setRail = useSetStore((s) => s.setRail);

  return (
    <nav className="icon-rail" aria-label="Panels">
      {ITEMS.map((item) => {
        const active = rail === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={`rail-btn${active ? " is-active" : ""}`}
            aria-pressed={active}
            onClick={() => setRail(active ? null : item.id)}
          >
            <span className="rail-icon" aria-hidden>
              {item.icon}
            </span>
            <span className="rail-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
