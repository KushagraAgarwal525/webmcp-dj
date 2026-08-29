import "./BoothExtras.css";
import { useSetStore } from "../commands/pipeline";
import { setPerformer } from "../audio/setPerformer";
import { HardwareButton } from "./controls/HardwareButton";

/** Slim chassis dock — FX lives on the mixer; arrangement/automation in Set. */
export function BoothExtras() {
  const dispatch = useSetStore((s) => s.dispatch);
  const sampler = useSetStore((s) => s.doc.sampler);
  const record = useSetStore((s) => s.doc.record);
  const tracks = useSetStore((s) => s.doc.tracks);
  const setTempo = useSetStore((s) => s.doc.setTempoBpm);
  const automationCount = useSetStore((s) => s.doc.automation.length);

  return (
    <section className="booth-dock">
      <div className="dock-group dock-pads">
        <span className="dock-label">Pads</span>
        {sampler.pads.map((pad, i) => (
          <HardwareButton
            key={pad.id}
            pad
            hasCue={Boolean(pad.trackId)}
            title={
              pad.trackId
                ? `${tracks[pad.trackId]?.title ?? pad.trackId}`
                : "Right-click = sample Deck A"
            }
            onClick={() => dispatch({ type: "sampler.trigger", pad: i + 1 })}
            onContextMenu={(e) => {
              e.preventDefault();
              const deckTrack =
                useSetStore.getState().doc.decks.A.trackId ??
                useSetStore.getState().doc.decks.B.trackId;
              if (!deckTrack) return;
              const pos =
                useSetStore.getState().transport.deckPlayheads.A ??
                useSetStore.getState().doc.decks.A.positionBars;
              dispatch({
                type: "sampler.setPad",
                pad: i + 1,
                trackId: deckTrack,
                inBars: pos,
                outBars: pos + 1,
              });
            }}
          >
            {i + 1}
          </HardwareButton>
        ))}
      </div>

      <div className="dock-group">
        <HardwareButton
          led={record.recording}
          className={record.recording ? "is-rec" : ""}
          onClick={() =>
            dispatch({
              type: record.recording ? "record.stop" : "record.start",
            })
          }
        >
          {record.recording ? "Stop" : "Rec"}
        </HardwareButton>
        {record.lastBlobUrl && (
          <a className="booth-link" href={record.lastBlobUrl} download>
            Take
          </a>
        )}
      </div>

      <div className="dock-group">
        <span className="dock-label">Set BPM</span>
        <input
          type="number"
          className="mono dock-bpm"
          min={60}
          max={200}
          step={0.1}
          value={setTempo ?? ""}
          placeholder="auto"
          onChange={(e) =>
            dispatch({
              type: "set.setTempo",
              bpm: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        />
        <HardwareButton onClick={() => void setPerformer.seek(0)}>
          Cue
        </HardwareButton>
        <span className="dock-meta mono">
          {automationCount} auto · edit in Set
        </span>
      </div>
    </section>
  );
}
