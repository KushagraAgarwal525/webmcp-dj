import { useEffect, useRef } from "react";
import "./MixerStrip.css";
import { useSetStore } from "../commands/pipeline";
import type { DeckId, FxType } from "../types/setdoc";
import { RotaryKnob } from "./controls/RotaryKnob";
import { VerticalFader } from "./controls/VerticalFader";
import { HardwareButton } from "./controls/HardwareButton";
import { LiveLevelMeter } from "./controls/LevelMeter";
import { paintMixerDom } from "./controls/mixerVisuals";
import { audioEngine } from "../audio/engine";

const FX_TYPES: FxType[] = ["off", "delay", "reverb", "echo"];

function ChannelStrip({ deck }: { deck: DeckId }) {
  const cue = useSetStore((s) => s.doc.mixer.channels[deck].cue);
  const hasTrack = useSetStore((s) => Boolean(s.doc.decks[deck].trackId));
  const dispatch = useSetStore((s) => s.dispatch);
  const live = (path: string) => () => {
    const d = audioEngine.getLiveMixerDoc();
    if (path === "fxSend") return d.decks[deck].fxSend;
    const ch = d.mixer.channels[deck];
    if (path === "gainDb") return ch.gainDb;
    if (path === "eqHigh") return ch.eqHigh;
    if (path === "eqMid") return ch.eqMid;
    if (path === "eqLow") return ch.eqLow;
    if (path === "filter") return ch.filter;
    if (path === "fader") return ch.fader;
    return 0;
  };

  return (
    <div className="djm-channel">
      <div className="djm-ch-label">{deck}</div>
      <RotaryKnob
        label="Gain"
        live
        livePath={`${deck}.gainDb`}
        getValue={live("gainDb")}
        value={0}
        min={-24}
        max={12}
        step={0.5}
        size={34}
        disabled={!hasTrack}
        onChange={(db) => dispatch({ type: "mixer.setGain", deck, db })}
      />
      <RotaryKnob
        label="Hi"
        live
        livePath={`${deck}.eqHigh`}
        getValue={live("eqHigh")}
        value={0}
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
        live
        livePath={`${deck}.eqMid`}
        getValue={live("eqMid")}
        value={0}
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
        live
        livePath={`${deck}.eqLow`}
        getValue={live("eqLow")}
        value={0}
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
        live
        livePath={`${deck}.filter`}
        getValue={live("filter")}
        value={0}
        min={-1}
        max={1}
        step={0.01}
        size={34}
        disabled={!hasTrack}
        onChange={(value) => dispatch({ type: "mixer.setFilter", deck, value })}
      />
      <RotaryKnob
        label="FX"
        live
        livePath={`${deck}.fxSend`}
        getValue={live("fxSend")}
        value={0}
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
          live
          livePath={`${deck}.fader`}
          getValue={live("fader")}
          value={0}
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
  const rootRef = useRef<HTMLElement | null>(null);
  const xfaderCurve = useSetStore((s) => s.doc.mixer.xfaderCurve);
  const fxType = useSetStore((s) => s.doc.fx.type);
  const dispatch = useSetStore((s) => s.dispatch);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = rootRef.current;
      if (el) paintMixerDom(el, audioEngine.getLiveMixerDoc());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <aside ref={rootRef} className="djm-strip" aria-label="Mixer">
      <ChannelStrip deck="A" />

      <div className="djm-center">
        <div className="djm-brand">MIX</div>
        <select
          className="djm-fx-select"
          value={fxType}
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
          live
          livePath="fx.wet"
          getValue={() => audioEngine.getLiveMixerDoc().fx.wet}
          value={0}
          min={0}
          max={1}
          step={0.01}
          size={32}
          disabled={fxType === "off"}
          onChange={(wet) => dispatch({ type: "fx.set", wet })}
        />
        <RotaryKnob
          label="Mst"
          live
          livePath="masterDb"
          getValue={() => audioEngine.getLiveMixerDoc().mixer.masterDb}
          value={0}
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
          live
          livePath="xfader"
          getValue={() => audioEngine.getLiveMixerDoc().mixer.crossfader}
          value={0}
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
          <span data-live="xf-led-a">A</span>
          <span data-live="xf-led-b">B</span>
        </div>
      </div>

      <ChannelStrip deck="B" />
    </aside>
  );
}
