import { useState } from "react";
import "./SetPanel.css";
import { useSetStore } from "../commands/pipeline";
import { PanelHeader } from "./PanelHeader";
import { executeLocalTool } from "../webmcp/registry";
import { PLAYBOOK_TOPICS, TRANSITION_RECIPES } from "../agent/djPlaybook";
import type { PlaybookTopic, TransitionRecipe } from "../agent/djPlaybook";
import { deriveEnergyLevel } from "../set/builder";

const ARCS = ["journey", "peak_time", "warm_up", "cool_down", "chill", "power_block"] as const;

export function SetPanel() {
  const doc = useSetStore((s) => s.doc);
  const dispatch = useSetStore((s) => s.dispatch);
  const setActivity = useSetStore((s) => s.setActivity);
  const [verifyText, setVerifyText] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<TransitionRecipe>("drop_swap");
  const [arc, setArc] = useState<(typeof ARCS)[number]>("journey");
  const [bookTopic, setBookTopic] = useState<PlaybookTopic>("all");
  const [intent, setIntent] = useState("");
  const [preparing, setPreparing] = useState(false);

  async function showJson(tool: string, args: Record<string, unknown>, label: string) {
    const raw = await executeLocalTool(tool, args);
    try {
      const parsed = JSON.parse(raw) as {
        playbook?: string;
        error?: string;
        notes?: string[];
        verdict?: string;
        reason?: string;
        drops?: { incoming?: number | null; outgoing?: number | null };
      };
      if (parsed.playbook) setVerifyText(parsed.playbook.slice(0, 4000));
      else if (parsed.verdict) {
        const drop =
          parsed.drops?.incoming != null || parsed.drops?.outgoing != null
            ? ` drops ${parsed.drops.outgoing ?? "—"}→${parsed.drops.incoming ?? "—"}`
            : "";
        setVerifyText(
          `${parsed.verdict}${drop}\n${(parsed.notes ?? []).join("\n")}`,
        );
      } else if (parsed.reason) setVerifyText(parsed.reason);
      else setVerifyText(raw.slice(0, 1200));
    } catch {
      setVerifyText(raw);
    }
    setActivity(label);
  }

  async function runPrepare() {
    setPreparing(true);
    setActivity("Preparing set…");
    try {
      const raw = await executeLocalTool("prepare_set", {
        intent: intent.trim() || undefined,
        apply: true,
        hear: true,
      });
      try {
        const parsed = JSON.parse(raw) as {
          error?: string;
          inferred?: { arc?: string; reason?: string };
          joins?: Array<{
            index: number;
            recipe: string;
            verdict?: string;
            reason?: string;
          }>;
          verify?: { ready?: boolean; issues?: Array<{ message: string }> };
          applied?: boolean;
        };
        if (parsed.error) {
          setVerifyText(parsed.error);
          return;
        }
        const joinLines = (parsed.joins ?? []).map(
          (j) => `#${j.index} ${j.recipe} ${j.verdict ?? ""} — ${j.reason ?? ""}`.trim(),
        );
        const issues = (parsed.verify?.issues ?? []).map((i) => i.message);
        setVerifyText(
          [
            parsed.inferred?.reason,
            joinLines.join("\n"),
            parsed.verify?.ready ? "verify ready" : issues.join("\n"),
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      } catch {
        setVerifyText(raw.slice(0, 2000));
      }
      setActivity("Set prepared");
    } finally {
      setPreparing(false);
    }
  }

  async function applyRecipe(index: number) {
    const raw = await executeLocalTool("apply_transition_recipe", {
      index,
      recipe,
    });
    setActivity(`recipe ${recipe} → entry ${index}`);
    setVerifyText(raw);
  }

  return (
    <aside className="flyout set-panel">
      <PanelHeader title="Set">
        <select
          className="panel-action"
          value={bookTopic}
          onChange={(e) => setBookTopic(e.target.value as PlaybookTopic)}
          title="Playbook chapter"
        >
          {PLAYBOOK_TOPICS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="panel-action"
          onClick={() => void showJson("get_dj_playbook", { topic: bookTopic }, "playbook")}
        >
          Playbook
        </button>
        <button
          type="button"
          className="panel-action"
          disabled={doc.arrangement.length < 2}
          onClick={() => void showJson("verify_set", { source: "arrangement" }, "verify")}
        >
          Verify
        </button>
        <button
          type="button"
          className="panel-action"
          disabled={!doc.arrangement.length && !doc.proposal}
          onClick={() => dispatch({ type: "set.clear" })}
        >
          Clear
        </button>
      </PanelHeader>

      <div className="set-recipe-row">
        <label className="set-intent">
          Intent
          <input
            type="text"
            value={intent}
            placeholder="optional — empty infers from crate"
            onChange={(e) => setIntent(e.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={preparing || Object.keys(doc.tracks).length < 2}
          onClick={() => void runPrepare()}
        >
          {preparing ? "Preparing…" : "Prepare"}
        </button>
      </div>

      <div className="set-recipe-row">
        <label>
          Arc
          <select
            value={arc}
            onChange={(e) => setArc(e.target.value as (typeof ARCS)[number])}
          >
            {ARCS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={Object.keys(doc.tracks).length < 2}
          onClick={() =>
            void showJson("plan_set_arc", { arc, apply: true }, `plan ${arc}`)
          }
        >
          Plan
        </button>
        <button
          type="button"
          disabled={doc.arrangement.length < 2}
          onClick={() => void showJson("apply_power_block", {}, "power block")}
        >
          Block
        </button>
      </div>

      {doc.arrangement.length >= 2 && (
        <div className="set-recipe-row">
          <label>
            Recipe
            <select
              value={recipe}
              onChange={(e) => setRecipe(e.target.value as TransitionRecipe)}
            >
              {TRANSITION_RECIPES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={doc.arrangement.length < 2}
            onClick={() => void applyRecipe(1)}
            title="Apply recipe to incoming entry (index 1)"
          >
            Apply → #2
          </button>
        </div>
      )}

      {verifyText && (
        <pre className="set-verify mono">{verifyText.slice(0, 1200)}</pre>
      )}

      {doc.proposal && (
        <div className="proposal-card">
          <div className="proposal-title">Proposed set</div>
          <p className="proposal-reason">
            {doc.proposal.reason ??
              `${doc.proposal.entries.length} tracks staged for approval.`}
          </p>
          <div className="proposal-actions">
            <button
              type="button"
              className="accept"
              onClick={() => dispatch({ type: "set.applyProposal" })}
            >
              Accept
            </button>
            <button type="button" onClick={() => dispatch({ type: "set.rejectProposal" })}>
              Reject
            </button>
          </div>
        </div>
      )}

      <ol className="set-list">
        {doc.arrangement.length === 0 && !doc.proposal && (
          <li className="set-empty">
            Prepare writes a playable first set from the crate. Play it, or rewrite a join.
          </li>
        )}
        {doc.automation.length > 0 && (
          <li className="set-empty">
            {doc.automation.length} automation lane
            {doc.automation.length === 1 ? "" : "s"} on set timeline
          </li>
        )}
        {doc.arrangement.map((entry, index) => {
          const track = doc.tracks[entry.trackId];
          const energy = track ? deriveEnergyLevel(track) : null;
          const role = track?.craft?.role ?? track?.analysis?.suggestedRole;
          return (
            <li key={entry.id} className="set-item">
              <span className="set-index mono">{index + 1}</span>
              <div>
                <div className="set-title">{track?.title ?? entry.trackId}</div>
                <div className="set-sub mono">
                  {entry.inBars.toFixed(0)}–{entry.outBars.toFixed(0)} bars ·{" "}
                  {entry.transition.type} {entry.transition.bars}b
                  {energy != null ? ` · E${energy}` : ""}
                  {role ? ` · ${role}` : ""}
                </div>
              </div>
              {index >= 1 && (
                <>
                  <button
                    type="button"
                    className="set-recipe"
                    title="Listen-score this join"
                    onClick={() =>
                      void showJson("preview_join", { index, hear: true }, `listen ${index}`)
                    }
                  >
                    Ear
                  </button>
                  <button
                    type="button"
                    className="set-recipe"
                    title={`Apply ${recipe}`}
                    onClick={() => void applyRecipe(index)}
                  >
                    Rx
                  </button>
                </>
              )}
              <button
                type="button"
                className="set-remove"
                onClick={() => dispatch({ type: "set.remove", index })}
              >
                ×
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
