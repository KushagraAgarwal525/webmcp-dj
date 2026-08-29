import "./StatusBar.css";
import { useSetStore } from "../commands/pipeline";
import { masterBpm, setDurationBars } from "../set/timeline";

export function StatusBar() {
  const activity = useSetStore((s) => s.activity);
  const webmcp = useSetStore((s) => s.webmcpAvailable);
  const tracks = useSetStore((s) => s.doc.crates.all?.trackIds.length ?? 0);
  const arrangement = useSetStore((s) => s.doc.arrangement.length);
  const master = useSetStore((s) => s.doc.tempoMaster);
  const doc = useSetStore((s) => s.doc);
  const setPlaying = useSetStore((s) => s.transport.setPlaying);
  const setPos = useSetStore((s) => s.transport.setPositionBars);
  const entryIndex = useSetStore((s) => s.transport.entryIndex);
  const playingA = useSetStore((s) => s.doc.decks.A.playing);
  const playingB = useSetStore((s) => s.doc.decks.B.playing);
  const bpm = masterBpm(doc);
  const dur = setDurationBars(doc);

  let mode = "Idle";
  if (setPlaying) {
    mode = `SET ▶ ${setPos.toFixed(1)}/${dur.toFixed(0)}b · #${entryIndex + 1}`;
  } else if (playingA || playingB) {
    const which = [playingA && "A", playingB && "B"].filter(Boolean).join("+");
    mode = `DECK ${which} preview`;
  } else {
    mode = `Master ${master}`;
  }

  return (
    <footer className="statusbar">
      <span>
        {tracks} tracks · {arrangement} in set
      </span>
      <span className="mono">
        {mode}
        {` · ${bpm.toFixed(1)} BPM`}
      </span>
      <span className={`webmcp-badge${webmcp ? " is-on" : ""}`}>
        WebMCP {webmcp ? "on" : "off"}
      </span>
      <span className="statusbar-activity">{activity}</span>
    </footer>
  );
}
