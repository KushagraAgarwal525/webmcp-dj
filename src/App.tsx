import { useEffect } from "react";
import { TopBar } from "./editor/TopBar";
import { IconRail } from "./editor/IconRail";
import { StatusBar } from "./editor/StatusBar";
import { Workspace } from "./editor/Workspace";
import { LibraryPanel } from "./editor/LibraryPanel";
import { SetPanel } from "./editor/SetPanel";
import { AgentPanel } from "./editor/AgentPanel";
import { useSetStore } from "./commands/pipeline";
import { loadActiveSetDoc } from "./storage/db";
import { registerToolsWithBrowser, executeLocalTool, listLocalTools } from "./webmcp/registry";
import { audioEngine } from "./audio/engine";
import "./Toasts.css";

declare global {
  interface Window {
    __bananalabs?: {
      listTools: typeof listLocalTools;
      callTool: typeof executeLocalTool;
      getSession: () => unknown;
    };
  }
}

function Toasts() {
  const toasts = useSetStore((s) => s.toasts);
  const dismiss = useSetStore((s) => s.dismissToast);
  const undo = useSetStore((s) => s.undo);

  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.message}</span>
          <button
            type="button"
            onClick={() => {
              undo();
              dismiss(t.id);
            }}
          >
            Undo
          </button>
          <button type="button" className="toast-x" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const rail = useSetStore((s) => s.rail);
  const hydrate = useSetStore((s) => s.hydrate);

  useEffect(() => {
    void (async () => {
      const saved = await loadActiveSetDoc();
      if (saved) hydrate(saved);
      await registerToolsWithBrowser();
      await audioEngine.ensure();
      window.__bananalabs = {
        listTools: listLocalTools,
        callTool: executeLocalTool,
        getSession: () => useSetStore.getState().doc,
      };
    })();

    const unlock = () => {
      void audioEngine.unlock();
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useSetStore.getState().setRail(null);
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", onKey);
    };
  }, [hydrate]);

  return (
    <div className="app-shell">
      <TopBar />
      <div className="app-body">
        <IconRail />
        <div className="workspace">
          {rail === "library" && <LibraryPanel />}
          {rail === "set" && <SetPanel />}
          <Workspace />
          {rail === "agent" && <AgentPanel />}
          <Toasts />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
