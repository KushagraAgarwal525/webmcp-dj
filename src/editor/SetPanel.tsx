import { useState } from "react";
import "./SetPanel.css";
import { useSetStore } from "../commands/pipeline";
import { PanelHeader } from "./PanelHeader";
import { executeLocalTool } from "../webmcp/registry";
import { PLAYBOOK_TOPICS, TRANSITION_RECIPES } from "../agent/djPlaybook";
import type { PlaybookTopic, TransitionRecipe } from "../agent/djPlaybook";
import { deriveEnergyLevel } from "../set/builder";
import { TRANSITION_TYPES, type TransitionType } from "../types/setdoc";

const ARCS = ["journey", "peak_time", "warm_up", "cool_down", "chill", "power_block"] as const;

function BarStepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
}) {
  const clamped = Math.min(max, Math.max(min, value));
  return (
    <div className="set-stepper">
      <button
        type="button"
        className="set-step"
        aria-label="Decrease"
        disabled={clamped <= min}
        onClick={() => onChange(Math.max(min, clamped - 1))}
      >
        −
      </button>
      <input
        type="number"
        className="mono"
        min={min}
        max={max}
        step={1}
        value={clamped}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
      />
      <button
        type="button"
        className="set-step"
        aria-label="Increase"
        disabled={clamped >= max}
        onClick={() => onChange(Math.min(max, clamped + 1))}
      >
        +
      </button>
    </div>
  );
}

export function SetPanel() {
  const arrangement = useSetStore((s) => s.doc.arrangement);
  const tracks = useSetStore((s) => s.doc.tracks);
  const proposal = useSetStore((s) => s.doc.proposal);
  const automationCount = useSetStore((s) => s.doc.automation.length);
  const trackCount = useSetStore((s) => Object.keys(s.doc.tracks).length);
  const dispatch = useSetStore((s) => s.dispatch);
  const setActivity = useSetStore((s) => s.setActivity);
  const [verifyText, setVerifyText] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<TransitionRecipe>("power_cut");
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
        <button
          type="button"
          className="panel-action"
          disabled={arrangement.length < 2}
          onClick={() => void showJson("verify_set", { source: "arrangement" }, "verify")}
        >
          Verify
        </button>
        <button
          type="button"
          className="panel-action"
          disabled={!arrangement.length && !proposal}
          onClick={() => dispatch({ type: "set.clear" })}
        >
          Clear
        </button>
      </PanelHeader>

      <div className="set-toolbar">
        <select
          className="set-topic"
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
          onClick={() => void showJson("get_dj_playbook", { topic: bookTopic }, "playbook")}
        >
          Playbook
        </button>
      </div>

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
          className="primary"
          disabled={preparing || trackCount < 2}
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
          disabled={trackCount < 2}
          onClick={() =>
            void showJson("plan_set_arc", { arc, apply: true }, `plan ${arc}`)
          }
        >
          Plan
        </button>
        <button
          type="button"
          disabled={arrangement.length < 2}
          onClick={() => void showJson("apply_power_block", {}, "power block")}
        >
          Block
        </button>
      </div>

      {arrangement.length >= 2 && (
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
            disabled={arrangement.length < 2}
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

      {proposal && (
        <div className="proposal-card">
          <div className="proposal-title">Proposed set</div>
          <p className="proposal-reason">
            {proposal.reason ??
              `${proposal.entries.length} tracks staged for approval.`}
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

      {automationCount > 0 && (
        <p className="set-automation">
          {automationCount} automation lane
          {automationCount === 1 ? "" : "s"} on set timeline
        </p>
      )}

      <ol className="set-list">
        {arrangement.length === 0 && !proposal && (
          <li className="set-empty">
            Prepare writes a playable first set from the crate. Play it, or rewrite a join.
          </li>
        )}
        {arrangement.map((entry, index) => {
          const track = tracks[entry.trackId];
          const energy = track ? deriveEnergyLevel(track) : null;
          const role = track?.craft?.role;
          const maxOut = track?.analysis?.durationBars ?? entry.outBars;
          return (
            <li key={entry.id} className="set-item">
              <span className="set-index mono">{index + 1}</span>
              <div className="set-item-main">
                <div className="set-item-head">
                  <div className="set-item-copy">
                    <div className="set-title ph-no-mask" title={track?.title ?? entry.trackId}>
                      {track?.title ?? entry.trackId}
                    </div>
                    <div className="set-sub mono">
                      {energy != null ? `E${energy}` : ""}
                      {role ? ` · ${role}` : ""}
                    </div>
                  </div>
                  <div className="set-item-actions">
                    {index >= 1 && (
                      <>
                        <button
                          type="button"
                          className="set-recipe"
                          title="Listen-score this join"
                          onClick={() =>
                            void showJson(
                              "preview_join",
                              { index, hear: true },
                              `listen ${index}`,
                            )
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
                  </div>
                </div>
                <div className="set-edit">
                  <label>
                    in
                    <BarStepper
                      value={Math.round(entry.inBars)}
                      min={0}
                      max={Math.max(0, Math.round(maxOut) - 1)}
                      onChange={(inBars) =>
                        dispatch({
                          type: "set.setTrim",
                          index,
                          inBars,
                          outBars: Math.max(entry.outBars, inBars + 1),
                        })
                      }
                    />
                  </label>
                  <label>
                    out
                    <BarStepper
                      value={Math.round(entry.outBars)}
                      min={Math.round(entry.inBars) + 1}
                      max={Math.round(maxOut)}
                      onChange={(outBars) =>
                        dispatch({
                          type: "set.setTrim",
                          index,
                          inBars: entry.inBars,
                          outBars,
                        })
                      }
                    />
                  </label>
                  {index >= 1 && (
                    <div className="set-edit-join">
                      <label>
                        join
                        <select
                          value={entry.transition.type}
                          onChange={(e) =>
                            dispatch({
                              type: "set.setTransition",
                              index,
                              transition: e.target.value as TransitionType,
                              bars: entry.transition.bars,
                            })
                          }
                        >
                          {TRANSITION_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        bars
                        <BarStepper
                          value={entry.transition.bars}
                          min={0}
                          max={32}
                          onChange={(bars) =>
                            dispatch({
                              type: "set.setTransition",
                              index,
                              transition: entry.transition.type,
                              bars,
                            })
                          }
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
