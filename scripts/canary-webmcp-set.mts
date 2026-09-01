/**
 * Drive BananaLabs on the feat/prepare-set preview via Chrome Canary + WebMCP.
 */
import { spawn } from "node:child_process";
import { chromium, type Page } from "playwright";

const CANARY = `${process.env.LOCALAPPDATA}\\Google\\Chrome SxS\\Application\\chrome.exe`;
const PORT = 9334;
const PROFILE = `${process.env.TEMP}\\bananalabs-canary-webmcp-prepare`;
const APP = process.env.DJ_URL ?? "http://localhost:5173/";
const FILES = [
  "C:\\Users\\kusha\\Downloads\\At Night (Anyma x Layton Giordani Remix) - Shakedown.mp3",
  "C:\\Users\\kusha\\Downloads\\M83 'Midnight City' Official video.mp3",
];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForCdp(url: string, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`CDP not ready at ${url}`);
}

async function mcp(
  page: Page,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs = 30_000,
): Promise<{ via: string; raw: string }> {
  const payload = JSON.stringify({ name, args });
  return page.evaluate(
    async (json) => {
      const { name, args } = JSON.parse(json) as {
        name: string;
        args: Record<string, unknown>;
      };
      const mc = document.modelContext;
      if (mc && typeof mc.getTools === "function" && typeof mc.executeTool === "function") {
        try {
          const tools = await mc.getTools();
          const tool = tools.find((t) => t.name === name);
          if (tool) {
            const raw = await mc.executeTool(tool, args);
            return { via: "webmcp", raw: typeof raw === "string" ? raw : JSON.stringify(raw) };
          }
        } catch (e) {
          const raw = await window.__bananalabs!.callTool(name, args);
          return {
            via: "local-after-webmcp-error",
            raw: `${raw}\n/* webmcp: ${e instanceof Error ? e.message : String(e)} */`,
          };
        }
      }
      const raw = await window.__bananalabs!.callTool(name, args);
      return { via: "local", raw };
    },
    payload,
    { timeout: timeoutMs },
  );
}

function parseToolJson(raw: string) {
  const cut = raw.indexOf("\n/* webmcp:");
  return JSON.parse(cut >= 0 ? raw.slice(0, cut) : raw);
}

function tracksFrom(raw: string) {
  const parsed = parseToolJson(raw) as
    | Array<{ id: string; title?: string; status?: string; bpm?: number | null }>
    | {
        tracks?: Array<{
          id: string;
          title?: string;
          status?: string;
          bpm?: number | null;
        }>;
      };
  return Array.isArray(parsed) ? parsed : (parsed.tracks ?? []);
}

const phase = process.argv[2] ?? "boot";

async function cdpUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

if (phase === "boot" || ((phase === "leave" || phase === "upload" || phase === "club") && !(await cdpUp()))) {
  const child = spawn(
    CANARY,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--enable-features=WebMCPTesting,DevToolsWebMCPSupport",
      "--enable-experimental-web-platform-features",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=Translate",
      "--no-first-run",
      "--no-default-browser-check",
      APP,
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  console.log(`spawned canary pid=${child.pid} cdp=127.0.0.1:${PORT}`);
}

const cdp = `http://127.0.0.1:${PORT}`;
await waitForCdp(`${cdp}/json/version`);
const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0] ?? (await browser.newContext());
let page =
  context.pages().find(
    (p) =>
      p.url().includes("localhost:5173") ||
      p.url().includes("127.0.0.1:5173") ||
      p.url().includes("bananalabs"),
  ) ?? context.pages()[0];
if (!page) page = await context.newPage();
const onBooth =
  page.url().includes("localhost:5173") ||
  page.url().includes("127.0.0.1:5173") ||
  page.url().includes("bananalabs");
if (phase === "leave" || phase === "club") {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
} else if (!onBooth) {
  await page.goto(APP, { waitUntil: "domcontentloaded" });
}

await page.waitForFunction(() => Boolean(window.__bananalabs), null, { timeout: 45000 });
await page.mouse.click(20, 20);

const webmcp = await page.evaluate(() => ({
  modelContext: typeof document.modelContext?.registerTool === "function",
  getTools: typeof document.modelContext?.getTools === "function",
  executeTool: typeof document.modelContext?.executeTool === "function",
}));
console.log("webmcp", JSON.stringify(webmcp));

if (phase === "boot" || phase === "upload" || phase === "leave") {
  const existing = tracksFrom((await mcp(page, "search_library", {})).raw);
  if (existing.length < 2) {
    await page.getByRole("button", { name: "Assets" }).click();
    await page.locator('input[accept*=".mp3"]').setInputFiles(FILES);
    console.log("uploaded", FILES.length, "files — waiting for analysis");
  } else {
    console.log("crate already has", existing.length, "tracks — skipping upload");
  }

  const deadline = Date.now() + 180_000;
  let last = "";
  while (Date.now() < deadline) {
    const session = await mcp(page, "search_library", {});
    last = session.raw;
    const tracks = tracksFrom(session.raw);
    const ready = tracks.filter((t) => t.status === "ready" || (t.bpm != null && t.bpm > 0));
    console.log(
      `tracks=${tracks.length} ready=${ready.length} via=${session.via} ${tracks.map((t) => `${t.title}:${t.status ?? "?"}`).join(" | ")}`,
    );
    if (tracks.length >= 2 && ready.length >= 2) break;
    await sleep(3000);
  }
  console.log("search_library", last.slice(0, 800));
}

if (phase === "dump") {
  const health = await mcp(page, "get_crate_health", {});
  console.log("HEALTH", health.raw.slice(0, 4000));
  const listed = tracksFrom((await mcp(page, "search_library", {})).raw);
  console.log("TRACKS", listed.map((t) => `${t.title}:${t.status}:${t.bpm}`).join(" | "));
  for (const t of listed) {
    const card = await mcp(page, "get_track", { track_id: t.id, detail: "compact" });
    console.log("TRACK", t.title, card.raw.slice(0, 1800));
    const points = await mcp(page, "get_mix_points", { track_id: t.id });
    console.log("MIXPOINTS", t.title, points.raw.slice(0, 2200));
  }
}

if (phase === "probe") {
  const probe = await page.evaluate(async () => {
    const mc = document.modelContext!;
    const tools = await mc.getTools();
    const names = tools.map((t) => t.name);
    const crate = tools.find((t) => t.name === "get_crate_health");
    const attempts: Array<{ how: string; ok: boolean; preview: string }> = [];
    const tryHow = async (how: string, fn: () => Promise<unknown>) => {
      try {
        const raw = await fn();
        attempts.push({
          how,
          ok: true,
          preview: (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, 160),
        });
      } catch (e) {
        attempts.push({
          how,
          ok: false,
          preview: e instanceof Error ? e.message : String(e),
        });
      }
    };
    if (crate) {
      await tryHow("executeTool(tool, {})", () => mc.executeTool(crate, {}));
      await tryHow("executeTool(tool)", () => mc.executeTool(crate));
      await tryHow("executeTool(tool, undefined)", () => mc.executeTool(crate, undefined));
    }
    const byName = mc as unknown as {
      executeTool: (a: unknown, b?: unknown) => Promise<unknown>;
    };
    await tryHow("executeTool(name, {})", () => byName.executeTool("get_crate_health", {}));
    return { toolCount: tools.length, names: names.slice(0, 12), attempts };
  });
  console.log("PROBE", JSON.stringify(probe, null, 2));
}

function peakDropFromPoints(raw: string): { phraseBars: number; energy: number; label: string } | null {
  const parsed = parseToolJson(raw) as {
    points?: Array<{ role?: string; phraseBars?: number; energy?: number; label?: string }>;
    ok?: boolean;
  };
  const points = parsed.points ?? [];
  const drops = points.filter((p) => p.role === "drop" && typeof p.phraseBars === "number");
  if (!drops.length) return null;
  const late = drops.filter((p) => (p.phraseBars ?? 0) >= 32);
  const pool = late.length ? late : drops;
  const best = pool.reduce((a, b) => ((b.energy ?? 0) > (a.energy ?? 0) ? b : a));
  return {
    phraseBars: best.phraseBars ?? 0,
    energy: best.energy ?? 0,
    label: best.label ?? "drop",
  };
}

if (phase === "club") {
  const listed = tracksFrom((await mcp(page, "search_library", {})).raw);
  let atNight = listed.find((t) => /shake|at night|anyma/i.test(`${t.title}`));
  let newGen = listed.find((t) => /new generation|giordani|layton/i.test(`${t.title}`));
  if (!newGen) {
    const file = "C:\\Users\\kusha\\Downloads\\New Generation.mp3";
    await page.getByRole("button", { name: "Assets" }).click();
    await page.locator('input[accept*=".mp3"]').setInputFiles([file]);
    console.log("uploaded New Generation.mp3");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const tracks = tracksFrom((await mcp(page, "search_library", {})).raw);
      newGen = tracks.find((t) => /new generation|giordani|layton/i.test(`${t.title}`));
      atNight = tracks.find((t) => /shake|at night|anyma/i.test(`${t.title}`));
      const ready = tracks.filter((t) => t.status === "ready" || (t.bpm != null && t.bpm > 0));
      console.log(
        `tracks=${tracks.length} ready=${ready.length} ${tracks.map((t) => `${t.title}:${t.status ?? "?"}`).join(" | ")}`,
      );
      if (newGen && (newGen.status === "ready" || (newGen.bpm != null && newGen.bpm > 0))) break;
      await sleep(3000);
    }
  }
  if (!atNight || !newGen) {
    throw new Error(
      `need At Night + New Generation, have: ${tracksFrom((await mcp(page, "search_library", {})).raw).map((t) => t.title).join(", ")}`,
    );
  }

  await mcp(page, "fx_set", { type: "off", wet: 0 });
  await mcp(page, "set_set_tempo", { bpm: null });
  await mcp(page, "set_clear_automation", {});
  await mcp(page, "set_clear", {});

  const peekOut = parseToolJson(
    (await mcp(page, "get_track", { track_id: atNight.id, detail: "compact" })).raw,
  ) as {
    analysis?: { key?: { window?: string } };
    card?: { stale?: boolean };
  };
  const peekIn = parseToolJson(
    (await mcp(page, "get_track", { track_id: newGen.id, detail: "compact" })).raw,
  ) as {
    analysis?: { key?: { window?: string } };
    card?: { stale?: boolean };
  };
  if (peekOut.analysis?.key?.window && peekIn.analysis?.key?.window) {
    console.log("skip reanalyze — drop-window key already present");
  } else {
    console.log("reanalyze At Night + New Generation (drop-window key)");
    await mcp(page, "analyze_track", { track_id: atNight.id }, 180_000);
    await mcp(page, "analyze_track", { track_id: newGen.id }, 180_000);
  }

  const outInfo = parseToolJson(
    (await mcp(page, "get_track", { track_id: atNight.id, detail: "compact" })).raw,
  ) as {
    analysis?: { durationBars?: number; bpm?: number; key?: { camelot?: string; confidence?: number; window?: string } };
    card?: {
      duration_bars?: number;
      drop_bars?: number | null;
      safe_leave_bars?: number | null;
      cue_before_drop_8?: number | null;
      key_trusted?: boolean;
      camelot?: string | null;
      key_confidence?: number | null;
    };
  };
  const inInfo = parseToolJson(
    (await mcp(page, "get_track", { track_id: newGen.id, detail: "compact" })).raw,
  ) as {
    analysis?: { durationBars?: number; bpm?: number; key?: { camelot?: string; confidence?: number; window?: string } };
    card?: {
      duration_bars?: number;
      drop_bars?: number | null;
      cue_before_drop_8?: number | null;
      key_trusted?: boolean;
      camelot?: string | null;
      key_confidence?: number | null;
    };
  };

  const recipe = "drop_swap";
  const overlap = 16;
  const inDur = inInfo.analysis?.durationBars ?? inInfo.card?.duration_bars ?? 80;
  const outDur = outInfo.analysis?.durationBars ?? outInfo.card?.duration_bars ?? 80;

  console.log(
    JSON.stringify({
      outgoing: {
        title: atNight.title,
        bpm: atNight.bpm,
        camelot: outInfo.card?.camelot,
        conf: outInfo.card?.key_confidence,
        trusted: outInfo.card?.key_trusted,
        drop: outInfo.card?.drop_bars,
        safe_leave: outInfo.card?.safe_leave_bars,
      },
      incoming: {
        title: newGen.title,
        bpm: newGen.bpm,
        camelot: inInfo.card?.camelot,
        conf: inInfo.card?.key_confidence,
        trusted: inInfo.card?.key_trusted,
        drop: inInfo.card?.drop_bars,
        cue8: inInfo.card?.cue_before_drop_8,
      },
      recipe,
      overlap,
    }),
  );

  await mcp(page, "set_propose", {
    entries: [
      {
        track_id: atNight.id,
        in_bars: 0,
        out_bars: Math.min(outDur, outInfo.card?.safe_leave_bars ?? outInfo.card?.drop_bars ?? 72),
        transition: "cut",
        bars: 1,
      },
      {
        track_id: newGen.id,
        in_bars: inInfo.card?.cue_before_drop_8 ?? 32,
        out_bars: Math.min(inDur, (inInfo.card?.drop_bars ?? 40) + 32),
        transition: "drop_swap",
        bars: overlap,
      },
    ],
    reason: "At Night into New Generation — 16-bar isolator drop-swap (build under the line, peel after the 1).",
  });
  await mcp(page, "set_apply_proposal", {});
  await mcp(page, "apply_transition_recipe", { index: 1, recipe, bars: overlap });

  const parkedLive = await page.evaluate(`
    (() => {
      const doc = window.__bananalabs.getSession();
      const a = doc.arrangement[0];
      const b = doc.arrangement[1];
      return {
        out: a ? { in: a.inBars, out: a.outBars, type: a.transition && a.transition.type, bars: a.transition && a.transition.bars } : null,
        inc: b ? { in: b.inBars, out: b.outBars, type: b.transition && b.transition.type, bars: b.transition && b.transition.bars } : null,
      };
    })()
  `);
  console.log("PARKED", JSON.stringify(parkedLive));

  const timeline = await mcp(page, "get_set_timeline", {});
  console.log("TIMELINE", timeline.raw.slice(0, 2200));
  const verify = await mcp(page, "verify_set", { source: "arrangement" });
  console.log("VERIFY", verify.raw);
  const ear = await mcp(page, "preview_join", { index: 1, hear: true }, 90_000);
  console.log("EAR", ear.raw.slice(0, 1600));

  const start = (await page.evaluate(`
    (() => {
      const doc = window.__bananalabs.getSession();
      const a = doc.arrangement[0];
      const b = doc.arrangement[1];
      if (!a || !b) return 0;
      const playA = a.outBars - a.inBars;
      const n = (b.transition && b.transition.bars) || 1;
      const join = Math.max(0, playA - n);
      return Math.max(0, join - 8);
    })()
  `)) as number;
  await page.mouse.click(24, 24);
  await mcp(page, "set_play", { start_bars: start });
  const live = await page.evaluate(() => {
    const api = window.__bananalabs as {
      getSession: () => {
        decks: Record<string, { playing: boolean; bpm: number | null }>;
      };
    };
    const d = api.getSession().decks;
    return { A: { play: d.A.playing, bpm: d.A.bpm }, B: { play: d.B.playing, bpm: d.B.bpm } };
  });
  console.log("PLAY_FROM", start, "DECKS", JSON.stringify(live));
  process.exit(0);
}

if (phase === "replay") {
  await page.mouse.click(24, 24);
  await mcp(page, "set_play", { start_bars: 48 });
  const live = await page.evaluate(() => {
    const api = window.__bananalabs as {
      getSession: () => {
        decks: Record<string, { playing: boolean; bpm: number | null; trackId: string | null }>;
      };
    };
    const d = api.getSession().decks;
    return {
      A: { play: d.A.playing, bpm: d.A.bpm, id: Boolean(d.A.trackId) },
      B: { play: d.B.playing, bpm: d.B.bpm, id: Boolean(d.B.trackId) },
    };
  });
  console.log("DECKS", JSON.stringify(live));
  process.exit(0);
}

if (phase === "rescue" || phase === "refine" || phase === "leave") {
  const listed = tracksFrom((await mcp(page, "search_library", {})).raw);
  const midnight = listed.find((t) => /midnight/i.test(t.title ?? ""));
  const atNight = listed.find((t) => /shake|at night|anyma/i.test(`${t.title}`));
  if (!midnight || !atNight) throw new Error("tracks missing");

  await mcp(page, "fx_set", { type: "echo", wet: 0.45, time_beats: 0.75, feedback: 0.4 });
  await mcp(page, "set_set_tempo", { bpm: null });
  await mcp(page, "set_clear", {});
  const prepared = await mcp(page, "prepare_set", {
    track_count: 2,
    hear: true,
    apply: true,
  });
  console.log("PREPARE", prepared.raw.slice(0, 2000));

  await mcp(page, "apply_transition_recipe", {
    index: 1,
    recipe: "echo_out",
    bars: 8,
  });
  await mcp(page, "set_set_trim", { index: 0, in_bars: 0, out_bars: 72 });
  await mcp(page, "set_set_trim", { index: 1, in_bars: 0, out_bars: 80 });

  const timeline = await mcp(page, "get_set_timeline", {});
  console.log("TIMELINE", timeline.raw.slice(0, 2000));
  const verify = await mcp(page, "verify_set", { source: "arrangement" });
  console.log("VERIFY", verify.raw);
  const ear = await mcp(page, "preview_join", { index: 1, hear: true });
  console.log("EAR", ear.raw.slice(0, 1400));
  await mcp(page, "set_play", { start_bars: 48 });
  const session = await mcp(page, "get_session", {});
  console.log("SESSION", session.raw.slice(0, 1400));
}

if (phase === "author" || phase === "boot") {
  const listed = tracksFrom((await mcp(page, "search_library", {})).raw);
  const midnight = listed.find((t) => /midnight/i.test(t.title ?? ""));
  const atNight = listed.find((t) => /shake|at night|anyma/i.test(`${t.title}`));
  if (!midnight || !atNight) throw new Error(`missing tracks: ${listed.map((t) => t.title).join(", ")}`);

  const midPts = await mcp(page, "get_mix_points", { track_id: midnight.id });
  const nightPts = await mcp(page, "get_mix_points", { track_id: atNight.id });
  console.log("MID_POINTS", midPts.raw.slice(0, 2000));
  console.log("NIGHT_POINTS", nightPts.raw.slice(0, 2000));

  await mcp(page, "tag_track", {
    track_id: atNight.id,
    role: "peak",
    energy_level: 8,
    mood: "dark",
    genre_hint: "melodic techno",
  });
  await mcp(page, "tag_track", {
    track_id: midnight.id,
    role: "opener",
    energy_level: 4,
    mood: "dark",
    genre_hint: "synth-pop",
  });

  // Night: Midnight City (vocal anthem, 107.7 / 10A) into At Night remix
  // (warehouse weapon, 129.2 / 8A). ΔBPM is far — no pad blend, cut on the 1.
  // Play the first Midnight City idea (into/through the drop), leave before
  // the file dumps; park At Night on its drop.
  const clear = await mcp(page, "set_clear", {});
  console.log("CLEAR", clear.via, clear.raw.slice(0, 200));

  const proposed = await mcp(page, "set_propose", {
    entries: [
      {
        track_id: midnight.id,
        in_bars: 0,
        out_bars: 32,
        transition: "cut",
        bars: 1,
      },
      {
        track_id: atNight.id,
        in_bars: 16,
        out_bars: 80,
        transition: "cut",
        bars: 1,
      },
    ],
    reason:
      "Midnight City opens (10A / 108, vocal anthem). Far jump to At Night (8A / 129) — power cut on the incoming drop, no vocal overlap.",
  });
  console.log("PROPOSE", proposed.via, proposed.raw.slice(0, 600));

  const applied = await mcp(page, "set_apply_proposal", {});
  console.log("APPLY", applied.raw.slice(0, 400));

  const recipe = await mcp(page, "apply_transition_recipe", {
    index: 1,
    recipe: "power_cut",
    bars: 1,
  });
  console.log("RECIPE", recipe.via, recipe.raw);

  const ear = await mcp(page, "preview_join", { index: 1, hear: true });
  console.log("EAR", ear.via, ear.raw.slice(0, 1500));

  const verify = await mcp(page, "verify_set", { source: "arrangement" });
  console.log("VERIFY", verify.raw);

  const play = await mcp(page, "set_play", {});
  console.log("PLAY", play.raw);

  const session = await mcp(page, "get_session", {});
  console.log("SESSION", session.raw.slice(0, 1500));
}

if (phase !== "leave") {
  await browser.close();
  console.log("playwright disconnected (canary stays up)");
} else {
  console.log("leave mix playing — canary stays up");
  process.exit(0);
}
