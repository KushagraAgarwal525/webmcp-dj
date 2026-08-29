import "./ProposalBanner.css";
import { useSetStore } from "../commands/pipeline";

export function ProposalBanner() {
  const proposal = useSetStore((s) => s.doc.proposal);
  const tracks = useSetStore((s) => s.doc.tracks);
  const dispatch = useSetStore((s) => s.dispatch);
  const setRail = useSetStore((s) => s.setRail);

  if (!proposal) return null;

  const changes = proposal.entries.map((e, i) => {
    const t = tracks[e.trackId];
    return {
      i: i + 1,
      title: t?.title ?? e.trackId,
      bpm: t?.analysis?.bpm,
      key: t?.analysis?.key.camelot,
      bars: Math.round(e.outBars - e.inBars),
      inBars: e.inBars,
      outBars: e.outBars,
      transition: e.transition,
    };
  });

  return (
    <section className="proposal-banner" role="region" aria-label="Pending set proposal">
      <div className="proposal-banner-top">
        <div>
          <div className="proposal-banner-kicker">Pending proposal</div>
          <div className="proposal-banner-title">
            {changes.length} track{changes.length === 1 ? "" : "s"} waiting for approval
          </div>
        </div>
        <div className="proposal-banner-actions">
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
          <button type="button" className="ghost" onClick={() => setRail("set")}>
            Review
          </button>
        </div>
      </div>
      {proposal.reason && <p className="proposal-banner-reason">{proposal.reason}</p>}
      <ol className="proposal-banner-list">
        {changes.map((c) => (
          <li key={`${c.i}-${c.title}`}>
            <span className="mono idx">{c.i}</span>
            <span className="name">{c.title}</span>
            <span className="mono detail">
              {c.bpm != null ? `${c.bpm.toFixed(0)}` : "—"} BPM
              {c.key ? ` · ${c.key}` : ""} · {c.inBars.toFixed(0)}–{c.outBars.toFixed(0)}b
              {c.i > 1 ? ` · ${c.transition.type} ${c.transition.bars}b` : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
