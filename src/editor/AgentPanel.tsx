import { useMemo, useState } from "react";
import "./AgentPanel.css";
import { executeLocalTool, listLocalTools } from "../webmcp/registry";
import { useSetStore } from "../commands/pipeline";
import { PanelHeader } from "./PanelHeader";

type Msg = { role: "user" | "system"; text: string };

export function AgentPanel() {
  const webmcp = useSetStore((s) => s.webmcpAvailable);
  const [input, setInput] = useState("get_session");
  const [args, setArgs] = useState("{}");
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "system",
      text: "You choose the join. Mix points include drop and N-before-drop. Recipes compile gestures; they do not pick taste. Same tools as WebMCP.",
    },
  ]);
  const tools = useMemo(() => listLocalTools(), []);

  async function runTool() {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = args.trim() ? (JSON.parse(args) as Record<string, unknown>) : {};
    } catch {
      setMessages((m) => [...m, { role: "system", text: "Invalid JSON args" }]);
      return;
    }
    setMessages((m) => [...m, { role: "user", text: `${input} ${args}` }]);
    const result = await executeLocalTool(input.trim(), parsed);
    setMessages((m) => [...m, { role: "system", text: result }]);
  }

  return (
    <aside className="flyout flyout-right agent-panel">
      <PanelHeader title="Agent">
        <span className={`agent-badge${webmcp ? " on" : ""}`}>
          {webmcp ? "WebMCP" : "local"}
        </span>
      </PanelHeader>

      <div className="agent-tools">
        {tools.map((t) => (
          <button
            key={t.name}
            type="button"
            className="tool-chip"
            title={t.description}
            onClick={() => setInput(t.name)}
          >
            {t.name}
          </button>
        ))}
      </div>

      <div className="agent-log">
        {messages.map((m, i) => (
          <pre key={`${i}-${m.role}`} className={`agent-msg ${m.role}`}>
            {m.text}
          </pre>
        ))}
      </div>

      <div className="agent-compose ph-mask">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="tool name"
          className="mono"
        />
        <textarea
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          placeholder="{}"
          className="mono"
          rows={3}
        />
        <button type="button" onClick={() => void runTool()}>
          Execute
        </button>
      </div>
    </aside>
  );
}
