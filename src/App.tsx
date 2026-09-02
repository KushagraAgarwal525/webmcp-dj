import { useEffect, useRef, useState } from "react";
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
import { setPerformer } from "./audio/setPerformer";
import { setDurationBars } from "./set/timeline";
import { registerContext } from "./analytics/posthog";
import "./Toasts.css";

type RailId = "library" | "set" | "agent";

/** Animate open only; close snaps. Same-side swaps (Assets↔Set) stay open. */
function usePushDrawer<T extends RailId>(active: T | null) {
  const [open, setOpen] = useState(Boolean(active));
  const wasOpen = useRef(Boolean(active));

  useEffect(() => {
    if (active) {
      if (wasOpen.current) {
        setOpen(true);
        return;
      }
      setOpen(false);
      const raf = requestAnimationFrame(() => {
        wasOpen.current = true;
        setOpen(true);
      });
      return () => cancelAnimationFrame(raf);
    }
    wasOpen.current = false;
    setOpen(false);
  }, [active]);

  return { shown: active, open };
}

declare global {
  interface Window {
    __bananalabs?: {
      listTools: typeof listLocalTools;
      callTool: typeof executeLocalTool;
      getSession: () => unknown;
      dispatch: (command: unknown, source?: "agent" | "ui" | "system") => unknown;
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
  const leftActive = rail === "library" || rail === "set" ? rail : null;
  const rightActive = rail === "agent" ? rail : null;
  const left = usePushDrawer(leftActive);
  const right = usePushDrawer(rightActive);

  useEffect(() => {
    void (async () => {
      const saved = await loadActiveSetDoc();
      if (saved) hydrate(saved);
      const webmcp = await registerToolsWithBrowser();
      registerContext({ webmcp_on: webmcp });
      await audioEngine.ensure();
      window.__bananalabs = {
        listTools: listLocalTools,
        callTool: executeLocalTool,
        getSession: () => useSetStore.getState().doc,
        dispatch: (command, source = "agent") =>
          useSetStore.getState().dispatch(command as never, source),
      };
    })();

    const unlock = () => {
      void audioEngine.unlock();
      window.removeEventListener("pointerdown", unlock);
    };
    window.addEventListener("pointerdown", unlock);

    const onKey = (e: KeyboardEvent) => {
      const el = e.target;
      const typing =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);

      if (e.key === "Escape") {
        useSetStore.getState().setRail(null);
        return;
      }
      if (typing) return;

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        void setPerformer.toggle();
        return;
      }
      if (e.key >= "1" && e.key <= "8" && e.key.length === 1) {
        useSetStore.getState().dispatch({
          type: "sampler.trigger",
          pad: Number(e.key),
        });
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const doc = useSetStore.getState().doc;
        const dur = setDurationBars(doc);
        const delta = e.shiftKey ? 4 : 1;
        const next =
          setPerformer.getPositionBars() +
          (e.key === "ArrowRight" ? delta : -delta);
        void setPerformer.seek(Math.max(0, Math.min(dur, next)));
      }
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
          <div
            className={`workspace-drawer workspace-drawer-left${left.open ? " is-open" : ""}`}
          >
            {left.shown === "library" && <LibraryPanel />}
            {left.shown === "set" && <SetPanel />}
          </div>
          <div className="workspace-main">
            <Workspace />
          </div>
          <div
            className={`workspace-drawer workspace-drawer-right${right.open ? " is-open" : ""}`}
          >
            {right.shown === "agent" && <AgentPanel />}
          </div>
          <Toasts />
        </div>
      </div>
      <StatusBar />
    </div>
  );
}
