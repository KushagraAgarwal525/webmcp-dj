/**
 * From-scratch 4-track chop set on the current booth.
 * Empty/chop intent — prepare_set owns order, heat clips, slam variety.
 */
import { chromium, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";

const CDP = "http://127.0.0.1:9335";
const APP = "http://localhost:5175/";
const DOWNLOADS = "C:\\Users\\kusha\\Downloads";

type Card = {
  track_id: string;
  title: string;
  artist?: string;
  bpm: number | null;
  camelot?: string | null;
  duration_bars: number | null;
  drop_bars?: number | null;
};

function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw) return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return { raw: String(raw) };
  }
}

function resolveFiles(): string[] {
  const files = fs.readdirSync(DOWNLOADS);
  const pick = (pred: (f: string) => boolean, label: string) => {
    const f = files.find((x) => pred(x) && x.toLowerCase().endsWith(".mp3"));
    if (!f) throw new Error(`missing ${label}`);
    return path.join(DOWNLOADS, f);
  };
  return [
    pick((f) => /midnight city/i.test(f), "Midnight City"),
    pick((f) => /avicii/i.test(f) && /nights/i.test(f), "Avicii The Nights"),
    pick((f) => /at night/i.test(f) && /shakedown|anyma/i.test(f), "At Night"),
    pick((f) => /in the moment/i.test(f), "In the Moment"),
  ];
}

function canon(title: string, artist = "") {
  const s = `${artist} ${title}`.toLowerCase();
  if (/midnight city/.test(s)) return "midnight";
  if (/the nights/.test(s) || (/nights/.test(s) && /avicii/.test(s))) return "nights";
  if (/shakedown|anyma|at night/.test(s)) return "shakedown";
  if (/in the moment/.test(s)) return "moment";
  return s.trim();
}

async function waitCdp(url: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${url}/json/version`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`CDP not ready at ${url}`);
}

await waitCdp(CDP);
const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0]!;
let page: Page =
  context.pages().find((p) => /5175/.test(p.url())) ?? context.pages()[0]!;
if (!page) page = await context.newPage();

async function ensurePage() {
  page =
    context.pages().find((p) => /5175/.test(p.url())) ?? context.pages()[0] ?? page;
  if (!/5175/.test(page.url())) {
    await page.goto(APP, { waitUntil: "domcontentloaded" });
  }
  await page.waitForFunction(() => Boolean(window.__bananalabs), null, { timeout: 60000 });
}

await ensurePage();
await page.bringToFront();
await page.mouse.click(200, 200);

async function mcp(name: string, input: Record<string, unknown> = {}, timeoutMs = 120000) {
  console.log(`→ ${name}`, Object.keys(input).length ? JSON.stringify(input) : "");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ensurePage();
      const raw = await page.evaluate(
        async ({ n, i }) => {
          const local = window.__bananalabs;
          if (!local) throw new Error(`missing ${n}`);
          return local.callTool(n, i);
        },
        { n: name, i: input },
        { timeout: timeoutMs },
      );
      const p = parse(raw);
      console.log(`← ${name}`, JSON.stringify(p).slice(0, 1400));
      return p;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`! ${name} ${msg}`);
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw new Error(name);
}

function cardsOf(h: Record<string, unknown>): Card[] {
  return (Array.isArray(h.cards) ? h.cards : []) as Card[];
}

async function wipeCrate() {
  await ensurePage();
  const removed = await page.evaluate(() => {
    const bl = window.__bananalabs;
    if (!bl?.dispatch) throw new Error("dispatch hook missing");
    const doc = bl.getSession() as { tracks: Record<string, unknown> };
    const ids = Object.keys(doc.tracks ?? {});
    for (const trackId of ids) {
      bl.dispatch({ type: "library.removeTrack", trackId });
    }
    return ids.length;
  });
  console.log("WIPED library tracks", removed);
}

async function openLibrary() {
  await ensurePage();
  const input = page.locator('input[accept*=".mp3"]');
  if (await input.count()) return;
  const assets = page.locator("button.rail-btn", { hasText: "Assets" });
  if (await assets.count()) await assets.click();
  else await page.getByRole("button", { name: "Assets" }).click();
  await page.waitForSelector('input[accept*=".mp3"]', { state: "attached", timeout: 15000 });
}

async function uploadFiles(files: string[]) {
  await openLibrary();
  const chooserWait = page.waitForEvent("filechooser", { timeout: 12000 });
  const libUpload = page.locator("aside.flyout.library-panel button.panel-action", {
    hasText: /^Upload$/,
  });
  if (await libUpload.count()) await libUpload.click();
  else await page.getByRole("button", { name: "Upload" }).last().click();
  try {
    const chooser = await chooserWait;
    await chooser.setFiles(files);
    console.log("UPLOAD via filechooser");
  } catch {
    console.log("filechooser missed — CDP");
    const client = await page.context().newCDPSession(page);
    const tree = await client.send("DOM.getDocument");
    const { nodeId } = await client.send("DOM.querySelector", {
      nodeId: tree.root.nodeId,
      selector: 'input[accept*=".mp3"]',
    });
    if (!nodeId) throw new Error("library file input missing — open Assets");
    await client.send("DOM.setFileInputFiles", { nodeId, files });
  }
}

await mcp("set_pause", {});
await wipeCrate();
await mcp("set_clear", {});
await mcp("set_clear_automation", {});

const files = resolveFiles();
console.log("FILES", files);
await uploadFiles(files);

const deadline = Date.now() + 240_000;
let cards: Card[] = [];
while (Date.now() < deadline) {
  const health = await mcp("get_crate_health", {});
  cards = cardsOf(health);
  const ready = cards.filter((c) => (c.bpm ?? 0) > 0 && (c.duration_bars ?? 0) > 8);
  const unique = new Set(ready.map((c) => canon(c.title, c.artist)));
  console.log(
    `crate=${cards.length} ready=${ready.length} unique=${unique.size}`,
    cards.map((c) => `${c.title}:${c.bpm ?? "?"}`).join(" | "),
  );
  if (ready.length >= 4 && unique.size >= 4) break;
  if (Date.now() - (deadline - 240_000) > 20000 && cards.length === 0) {
    console.log("retry upload");
    await uploadFiles(files);
  }
  await new Promise((r) => setTimeout(r, 4000));
}

const extras = await page.evaluate(() => {
  const bl = window.__bananalabs;
  if (!bl?.dispatch) throw new Error("dispatch hook missing");
  const session = bl.getSession() as {
    tracks: Record<string, { id: string; title: string; artist: string }>;
  };
  const keep: Record<string, string> = {};
  const drop: string[] = [];
  for (const t of Object.values(session.tracks ?? {})) {
    const s = `${t.artist} ${t.title}`.toLowerCase();
    let k = s.trim();
    if (/midnight city/.test(s)) k = "midnight";
    else if (/the nights/.test(s) || (/nights/.test(s) && /avicii/.test(s))) k = "nights";
    else if (/shakedown|anyma|at night/.test(s)) k = "shakedown";
    else if (/in the moment/.test(s)) k = "moment";
    if (!keep[k]) keep[k] = t.id;
    else drop.push(t.id);
  }
  for (const trackId of drop) bl.dispatch({ type: "library.removeTrack", trackId });
  return { kept: keep, dropped: drop.length };
});
console.log("DEDUPE", JSON.stringify(extras));

const after = await mcp("get_crate_health", {});
cards = cardsOf(after);
if (cards.length !== 4) {
  throw new Error(`expected 4 unique tracks, got ${cards.length}: ${cards.map((c) => c.title).join(", ")}`);
}

await mcp("get_dj_playbook", { topic: "all" });
for (const c of cards) {
  await mcp("get_mix_points", { track_id: c.track_id });
}

const prepared = await mcp("prepare_set", {
  intent: "chop club set, four records. Heat clips, sudden entries, no radio intros.",
  track_count: 4,
  hear: true,
  apply: true,
});

console.log("PREPARE inferred", JSON.stringify(prepared.inferred));
console.log("PREPARE entries", JSON.stringify(prepared.entries));
console.log(
  "PREPARE joins",
  JSON.stringify(
    (Array.isArray(prepared.joins) ? prepared.joins : []).map((j: Record<string, unknown>) => ({
      index: j.index,
      outgoing: j.outgoing,
      incoming: j.incoming,
      recipe: j.recipe,
      bars: j.bars,
      verdict: j.verdict,
      retries: j.retries,
      tries: j.tries,
      reason: j.reason,
    })),
  ),
);

type Join = {
  index?: number;
  recipe?: string;
  verdict?: string;
  alternatives?: Array<{ recipe: string; bars: number }>;
};
const joins = (Array.isArray(prepared.joins) ? prepared.joins : []) as Join[];
for (const j of joins) {
  const idx = Number(j.index);
  if (!idx) continue;
  if (j.verdict === "fail" && j.alternatives?.[0]) {
    const alt = j.alternatives[0]!;
    console.log(`join ${idx} failed ${j.recipe} → ${alt.recipe}`);
    await mcp("apply_transition_recipe", {
      index: idx,
      recipe: alt.recipe,
      bars: alt.bars,
    });
  }
}

const hasEcho = joins.some((j) => j.recipe === "echo_out" || j.recipe === "half_bridge" || j.recipe === "backspin");
if (hasEcho) {
  await mcp("fx_set", { type: "delay", wet: 0.2, time_beats: 0.75, feedback: 0.4 });
}
await mcp("deck_set_options", { deck: "A", keylock: true, quantize: true });
await mcp("deck_set_options", { deck: "B", keylock: true, quantize: true });

for (const j of joins) {
  if (j.index) await mcp("preview_join", { index: j.index, hear: true });
}

const verify = await mcp("verify_set", { source: "arrangement" });
console.log("VERIFY", JSON.stringify(verify));
if (verify.ready !== true) {
  throw new Error(`not ready: ${JSON.stringify(verify.issues)}`);
}

const tl = await mcp("get_set_timeline", {});
console.log("SPANS", JSON.stringify(tl.spans));

await page.mouse.click(240, 220);
await mcp("set_seek", { bars: 0 });
await mcp("set_play", { start_bars: 0 });
console.log("PLAYING from 0");
