import type { DeckId, SetDoc } from "../../types/setdoc";

function knobAngle(value: number, min: number, max: number): number {
  const span = max - min || 1;
  const t = Math.min(1, Math.max(0, (value - min) / span));
  return -135 + t * 270;
}

function faderNorm(value: number, min: number, max: number): number {
  const span = max - min || 1;
  return Math.min(1, Math.max(0, (value - min) / span));
}

function readPath(doc: SetDoc, path: string): number {
  if (path === "xfader") return doc.mixer.crossfader;
  if (path === "masterDb") return doc.mixer.masterDb;
  if (path === "fx.wet") return doc.fx.wet;
  const [deck, field] = path.split(".");
  if (deck !== "A" && deck !== "B" && deck !== "C" && deck !== "D") return 0;
  if (field === "fxSend") return doc.decks[deck].fxSend;
  const ch = doc.mixer.channels[deck as DeckId];
  if (field === "gainDb") return ch.gainDb;
  if (field === "eqHigh") return ch.eqHigh;
  if (field === "eqMid") return ch.eqMid;
  if (field === "eqLow") return ch.eqLow;
  if (field === "filter") return ch.filter;
  if (field === "fader") return ch.fader;
  return 0;
}

function paintKnob(el: HTMLElement, value: number, min: number, max: number) {
  el.style.setProperty("--knob-angle", `${knobAngle(value, min, max)}deg`);
}

function paintFader(el: HTMLElement, value: number, min: number, max: number) {
  const t = faderNorm(value, min, max);
  const horizontal = el.classList.contains("is-horizontal");
  const pct = horizontal ? t * 100 : (1 - t) * 100;
  el.style.setProperty("--fader-pct", `${horizontal ? t * 100 : pct}%`);
  el.style.setProperty("--fader-fill", `${t * 100}%`);
  const fill = el.querySelector(".hw-fader-fill");
  const thumb = el.querySelector(".hw-fader-thumb");
  if (!horizontal && fill instanceof HTMLElement) fill.style.height = `${t * 100}%`;
  if (!horizontal && thumb instanceof HTMLElement) thumb.style.top = `${pct}%`;
}

/** Paint mixer needles from the live overlay — same idea as LiveLevelMeter (DOM, no React). */
export function paintMixerDom(root: HTMLElement, doc: SetDoc) {
  const nodes = root.querySelectorAll<HTMLElement>("[data-live]");
  for (const el of nodes) {
    const kind = el.dataset.live;
    if (kind === "xf-led-a") {
      el.classList.toggle("on", doc.mixer.crossfader <= 0.05);
      continue;
    }
    if (kind === "xf-led-b") {
      el.classList.toggle("on", doc.mixer.crossfader >= -0.05);
      continue;
    }
    const path = el.dataset.livePath;
    if (!path) continue;
    const min = Number(el.dataset.liveMin);
    const max = Number(el.dataset.liveMax);
    const value = readPath(doc, path);
    if (kind === "knob") paintKnob(el, value, min, max);
    else if (kind === "fader") paintFader(el, value, min, max);
  }
}
