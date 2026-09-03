import type { Command } from "../types/commands";
import type { AutomationParam, DeckId, SetDoc } from "../types/setdoc";

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

/** Clone only the mixer/fx/fxSend slice the live graph mutates in place. */
export function cloneLiveMixerDoc(doc: SetDoc): SetDoc {
  const ch = doc.mixer.channels;
  return {
    ...doc,
    mixer: {
      ...doc.mixer,
      channels: {
        A: { ...ch.A },
        B: { ...ch.B },
        C: { ...ch.C },
        D: { ...ch.D },
      },
    },
    fx: { ...doc.fx },
    decks: {
      A: { ...doc.decks.A },
      B: { ...doc.decks.B },
      C: { ...doc.decks.C },
      D: { ...doc.decks.D },
    },
  };
}

export function applyAutomationInPlace(
  mixer: SetDoc["mixer"],
  fx: SetDoc["fx"],
  decks: SetDoc["decks"],
  patch: Partial<Record<AutomationParam, number>>,
): { mixer: boolean; fx: boolean } {
  let mixerDirty = false;
  let fxDirty = false;

  const setCh = (
    deck: DeckId,
    key: "filter" | "eqLow" | "eqMid" | "eqHigh" | "fader" | "gainDb",
    value: number,
  ) => {
    mixer.channels[deck][key] = value;
    mixerDirty = true;
  };

  if (patch.xfader != null) {
    mixer.crossfader = clamp(patch.xfader, -1, 1);
    mixerDirty = true;
  }
  if (patch.filter_a != null) setCh("A", "filter", clamp(patch.filter_a, -1, 1));
  if (patch.filter_b != null) setCh("B", "filter", clamp(patch.filter_b, -1, 1));
  if (patch.eq_low_a != null) setCh("A", "eqLow", patch.eq_low_a);
  if (patch.eq_mid_a != null) setCh("A", "eqMid", patch.eq_mid_a);
  if (patch.eq_high_a != null) setCh("A", "eqHigh", patch.eq_high_a);
  if (patch.eq_low_b != null) setCh("B", "eqLow", patch.eq_low_b);
  if (patch.eq_mid_b != null) setCh("B", "eqMid", patch.eq_mid_b);
  if (patch.eq_high_b != null) setCh("B", "eqHigh", patch.eq_high_b);
  if (patch.fader_a != null) setCh("A", "fader", clamp(patch.fader_a, 0, 1));
  if (patch.fader_b != null) setCh("B", "fader", clamp(patch.fader_b, 0, 1));
  if (patch.gain_a != null) setCh("A", "gainDb", patch.gain_a);
  if (patch.gain_b != null) setCh("B", "gainDb", patch.gain_b);

  if (patch.fx_wet != null || patch.fx_arm != null) {
    fxDirty = true;
    const arm = patch.fx_arm ?? (patch.fx_wet != null && patch.fx_wet > 0.05 ? 1 : 0);
    const wet = patch.fx_wet != null ? clamp(patch.fx_wet, 0, 1) : fx.wet;
    fx.wet = wet;
    fx.type =
      arm > 0.5 || wet > 0.03 ? "delay" : fx.type === "delay" ? "off" : fx.type;
    if (arm > 0.5) {
      fx.timeBeats = Math.max(fx.timeBeats, 0.75);
      fx.feedback = Math.max(fx.feedback, 0.4);
    }
    const xf = mixer.crossfader;
    if (arm > 0.5) {
      const aFader = mixer.channels.A.fader;
      const bFader = mixer.channels.B.fader;
      decks.A.fxSend = xf <= 0 && aFader > 0.02 ? 0.55 : 0;
      decks.B.fxSend = xf >= 0 && bFader > 0.02 ? 0.55 : 0;
    } else {
      decks.A.fxSend = 0;
      decks.B.fxSend = 0;
    }
  }

  return { mixer: mixerDirty, fx: fxDirty };
}

/** 20 Hz SetDoc flush — same values already in the live overlay. */
export function applyAutomationToDoc(
  doc: SetDoc,
  patch: Partial<Record<AutomationParam, number>>,
): SetDoc {
  const next = cloneLiveMixerDoc(doc);
  const dirty = applyAutomationInPlace(next.mixer, next.fx, next.decks, patch);
  if (!dirty.mixer && !dirty.fx) return doc;
  return next;
}

/** Fold a human/agent mixer command into the live overlay without copying stale automation. */
export function adoptMixerCommand(overlay: SetDoc, doc: SetDoc, command: Command) {
  switch (command.type) {
    case "mixer.setGain":
      overlay.mixer.channels[command.deck].gainDb = doc.mixer.channels[command.deck].gainDb;
      break;
    case "mixer.setEQ": {
      const ch = overlay.mixer.channels[command.deck];
      const src = doc.mixer.channels[command.deck];
      if (command.band === "low") ch.eqLow = src.eqLow;
      else if (command.band === "mid") ch.eqMid = src.eqMid;
      else ch.eqHigh = src.eqHigh;
      break;
    }
    case "mixer.setFilter":
      overlay.mixer.channels[command.deck].filter = doc.mixer.channels[command.deck].filter;
      break;
    case "mixer.setFader":
      overlay.mixer.channels[command.deck].fader = doc.mixer.channels[command.deck].fader;
      break;
    case "mixer.setCrossfader":
      overlay.mixer.crossfader = doc.mixer.crossfader;
      break;
    case "mixer.setXfaderCurve":
      overlay.mixer.xfaderCurve = doc.mixer.xfaderCurve;
      break;
    case "mixer.setCue":
      overlay.mixer.channels[command.deck].cue = doc.mixer.channels[command.deck].cue;
      break;
    case "mixer.setMaster":
      overlay.mixer.masterDb = doc.mixer.masterDb;
      break;
    case "fx.set":
      Object.assign(overlay.fx, doc.fx);
      break;
    case "deck.setFxSend":
      overlay.decks[command.deck].fxSend = doc.decks[command.deck].fxSend;
      break;
    default:
      break;
  }
}

export function isMixerVisualCommand(type: Command["type"]): boolean {
  return (
    type === "mixer.setGain" ||
    type === "mixer.setEQ" ||
    type === "mixer.setFilter" ||
    type === "mixer.setFader" ||
    type === "mixer.setCrossfader" ||
    type === "mixer.setXfaderCurve" ||
    type === "mixer.setCue" ||
    type === "mixer.setMaster" ||
    type === "fx.set" ||
    type === "deck.setFxSend"
  );
}
