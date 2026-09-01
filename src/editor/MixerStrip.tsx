import "./MixerStrip.css";
import { useSetStore } from "../commands/pipeline";
import type { DeckId, FxType } from "../types/setdoc";
import { RotaryKnob } from "./controls/RotaryKnob";
import { VerticalFader } from "./controls/VerticalFader";
import { HardwareButton } from "./controls/HardwareButton";
import { LiveLevelMeter } from "./controls/LevelMeter";

const FX_TYPES: FxType[] = ["off", "delay", "reverb", "echo"];

function ChannelStrip({ deck }: { deck: DeckId }) {
  const ch = useSetStore((s) => s.doc.mixer.channels[deck]);
  const fxSend = useSetStore((s) => s.doc.decks[deck].fxSend);
  const cue = useSetStore((s) => s.doc.mixer.channels[deck].cue);
  const hasTrack = useSetStore((s) => Boolean(s.doc.decks[deck].trackId));
  const dispatch = useSetStore((s) => s.dispatch);

  return (
    <div className="djm-channel">
      <div className="djm-ch-label">{deck}</div>
      <RotaryKnob
        label="Gain"
        value={ch.gainDb}
        min={-24}
        max={12}
        step={0.5}
        size={34}
        disabled={!hasTrack}
        onChange={(db) => dispatch({ type: "mixer.setGain", deck, db })}
      />
      <RotaryKnob
        label="Hi"
        value={ch.eqHigh}
        min={-24}
        max={6}
        step={0.5}
        size={34}
        disabled={!hasTrack}
        onChange={(db) =>
          dispatch({ type: "mixer.setEQ", deck, band: "high", db })
        }
      />
      <RotaryKnob
        label="Mid"
        value={ch.eqMid}
        min={-24}
        max={6}
        step={0.5}
        size={34}
        disabled={!hasTrack}
        onChange={(db) =>
          dispatch({ type: "mixer.setEQ", deck, band: "mid", db })
        }
      />
      <RotaryKnob
        label="Low"
        value={ch.eqLow}
        min={-24}
        max={6}
        step={0.5}
        size={34}
        disabled={!hasTrack}
        onChange={(db) =>
          dispatch({ type: "mixer.setEQ", deck, band: "low", db })
        }
      />
      <RotaryKnob
        label="Filt"
        value={ch.filter}
        min={-1}
        max={1}
        step={0.01}
        size={34}
        disabled={!hasTrack}
        onChange={(value) => dispatch({ type: "mixer.setFilter", deck, value })}
      />
      <RotaryKnob
        label="FX"
        value={fxSend}
        min={0}
        max={1}
        step={0.01}
        size={34}
        disabled={!hasTrack}
        onChange={(value) =>
          dispatch({ type: "deck.setFxSend", deck, value })
        }
      />
      <div className="djm-fader-row">
        <LiveLevelMeter deck={deck} height={120} />
        <VerticalFader
          value={ch.fader}
          min={0}
          max={1}
          step={0.01}
          length={120}
          disabled={!hasTrack}
          onChange={(value) =>
            dispatch({ type: "mixer.setFader", deck, value })
          }
        />
      </div>
      <HardwareButton
        led={cue}
        disabled={!hasTrack}
        onClick={() =>
          dispatch({ type: "mixer.setCue", deck, enabled: !cue })
        }
        title="Cue to master (solos this channel while any Cue is on)"
      >
        Cue
      </HardwareButton>
    </div>
  );
}

export function MixerStrip() {
  const crossfader = useSetStore((s) => s.doc.mixer.crossfader);
  const xfaderCurve = useSetStore((s) => s.doc.mixer.xfaderCurve);
  const masterDb = useSetStore((s) => s.doc.mixer.masterDb);
  const fx = useSetStore((s) => s.doc.fx);
  const dispatch = useSetStore((s) => s.dispatch);

  return (
    <aside className="djm-strip" aria-label="Mixer">
      <ChannelStrip deck="A" />

      <div className="djm-center">
        <div className="djm-brand">MIX</div>
        <select
          className="djm-fx-select"
          value={fx.type}
          onChange={(e) =>
            dispatch({ type: "fx.set", fxType: e.target.value as FxType })
          }
        >
          {FX_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <RotaryKnob
          label="Wet"
          value={fx.wet}
          min={0}
          max={1}
          step={0.01}
          size={32}
          disabled={fx.type === "off"}
          onChange={(wet) => dispatch({ type: "fx.set", wet })}
        />
        <RotaryKnob
          label="Mst"
          value={masterDb}
          min={-24}
          max={6}
          step={0.5}
          size={32}
          onChange={(db) => dispatch({ type: "mixer.setMaster", db })}
        />
        <HardwareButton
          led={xfaderCurve === "scratch"}
          onClick={() =>
            dispatch({
              type: "mixer.setXfaderCurve",
              curve: xfaderCurve === "smooth" ? "scratch" : "smooth",
            })
          }
        >
          {xfaderCurve === "smooth" ? "Smth" : "Scr"}
        </HardwareButton>
        <VerticalFader
          label="XF"
          value={crossfader}
          min={-1}
          max={1}
          step={0.01}
          horizontal
          length={110}
          onChange={(value) =>
            dispatch({ type: "mixer.setCrossfader", value })
          }
        />
        <div className="djm-xf-leds">
          <span className={crossfader <= 0.05 ? "on" : ""}>A</span>
          <span className={crossfader >= -0.05 ? "on" : ""}>B</span>
        </div>
      </div>

      <ChannelStrip deck="B" />
    </aside>
  );
}
