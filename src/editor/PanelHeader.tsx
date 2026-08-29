import { useSetStore } from "../commands/pipeline";

type Props = {
  title: string;
  children?: React.ReactNode;
};

export function PanelHeader({ title, children }: Props) {
  const setRail = useSetStore((s) => s.setRail);

  return (
    <header className="panel-header">
      <h2>{title}</h2>
      <div className="panel-header-actions">{children}</div>
      <button
        type="button"
        className="panel-close"
        aria-label={`Close ${title}`}
        title="Close"
        onClick={() => setRail(null)}
      >
        ×
      </button>
    </header>
  );
}
