/**
 * Eval harness — the referee for composed sets.
 *
 * Drives the real app on Chrome Canary (same pattern as canary-webmcp-set):
 * upload EVAL_FILES -> re-analyze (chromaCurve) -> prepare_set (auto order)
 * -> verify -> offline bounce (download_set WAV) -> objective scorecard.
 *
 * Scorecard (model-independent — measures the RENDER, not the narration):
 *   chop_ratio    slams/joins (want high; chop is the default grammar)
 *   intro_exposure fraction of clips starting before bar 8 (want ~0)
 *   play_bars     mean clip length (want 16–32)
 *   variety       distinct recipes / joins
 *   phrase_snap   fraction of trims on the 8-bar grid
 *   monotone      energy arc flatness (want low)
 *   verify_ready  boolean
 *   bounce        WAV loudness-jump stats at join boundaries vs elsewhere
 *
 * Usage:
 *   $env:EVAL_FILES = "a.mp3,b.mp3,c.mp3"   # comma-separated paths
 *   npx tsx scripts/eval-compose.mts
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

const CANARY = `${process.env.LOCALAPPDATA}\\Google\\Chrome SxS\\Application\\chrome.exe`;
const PORT = 9335;
const PROFILE = `${process.env.TEMP}\\bananalabs-eval`;
const APP = process.env.DJ_URL ?? "http://localhost:5173/";
const FILES = (process.env.EVAL_FILES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const OUT = process.env.EVAL_OUT ?? "eval-scorecard.json";

const SLAM_RECIPES = new Set([
  "power_cut",
  "air_cut",
  "backspin",
  "echo_out",
  "half_bridge",
  "power_block",
  "loop_roll",
]);

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
  timeoutMs = 90_000,
) {
  const payload = JSON.stringify({ name, args });
  return page.evaluate(
    async (json) => {
      const { name, args } = JSON.parse(json) as {
        name: string;
        args: Record<string, unknown>;
      };
      return await window.__bananalabs!.callTool(name, args);
    },
    payload,
    { timeout: timeoutMs },
  );
}

function parseToolJson(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Minimal 16-bit PCM WAV reader -> mono Float32. */
function readWavMono(path: string): { samples: Float32Array; sampleRate: number } {
  const buf = readFileSync(path);
  let pos = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let dataOff = -1;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      fmt = {
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === "data") {
      dataOff = pos + 8;
      dataLen = size;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || dataOff < 0 || fmt.bits !== 16) {
    throw new Error(`unsupported WAV (bits=${fmt?.bits})`);
  }
  const count = Math.floor(dataLen / 2 / fmt.channels);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let acc = 0;
    for (let ch = 0; ch < fmt.channels; ch++) {
      acc += buf.readInt16LE(dataOff + (i * fmt.channels + ch) * 2) / 32768;
    }
    out[i] = acc / fmt.channels;
  }
  return { samples: out, sampleRate: fmt.sampleRate };
}

function rmsWindows(samples: Float32Array, sampleRate: number, windowSec = 2) {
  const win = Math.floor(windowSec * sampleRate);
  const out: number[] = [];
  for (let off = 0; off + win <= samples.length; off += win) {
    let s = 0;
    for (let i = off; i < off + win; i++) s += samples[i]! * samples[i]!;
    out.push(Math.sqrt(s / win));
  }
  return out;
}

async function main() {
  if (!FILES.length) {
    console.error("Set EVAL_FILES to a comma-separated list of audio files.");
    process.exit(1);
  }

  spawn(
    CANARY,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE}`,
      "--enable-features=WebMCPTesting,DevToolsWebMCPSupport",
      "--autoplay-policy=no-user-gesture-required",
      "--no-first-run",
      "--no-default-browser-check",
      APP,
    ],
    { detached: true, stdio: "ignore" },
  ).unref();

  await waitForCdp(`http://127.0.0.1:${PORT}/json/version`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  let page =
    context.pages().find(
      (p) => p.url().includes("localhost:5173") || p.url().includes("bananalabs"),
    ) ?? context.pages()[0];
  if (!page) page = await context.newPage();
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__bananalabs), null, { timeout: 45000 });
  await page.mouse.click(20, 20);

  // Upload + wait for analysis (chromaCurve included).
  await page.getByRole("button", { name: "Assets" }).click();
  await page
    .locator('input[accept*=".mp3"], input[accept*="audio"]')
    .setInputFiles(FILES);
  console.log(`uploaded ${FILES.length} files — waiting for analysis`);
  const deadline = Date.now() + 300_000;
  let trackIds: string[] = [];
  for (;;) {
    const listed = parseToolJson(await mcp(page, "search_library", { limit: 100 })) as {
      tracks?: Array<{ id: string; status?: string; bpm?: number }>;
    };
    const tracks = listed.tracks ?? [];
    const ready = tracks.filter((t) => t.status === "ready" || (t.bpm != null && t.bpm > 0));
    if (tracks.length >= FILES.length && ready.length >= FILES.length) {
      trackIds = tracks.map((t) => t.id);
      break;
    }
    if (Date.now() > deadline) throw new Error("analysis timeout");
    await sleep(3000);
  }
  console.log("crate ready:", trackIds.length, "tracks");

  // Re-analyze anything on the old detector (no chromaCurve -> stale).
  for (const id of trackIds) {
    await mcp(page, "analyze_track", { track_id: id }, 240_000);
  }
  console.log("re-analyzed (chromaCurve guaranteed)");

  // Compose: the auto order, full gating.
  const prepared = parseToolJson(
    await mcp(page, "prepare_set", { hear: true, apply: true }, 300_000),
  ) as {
    inferred?: { reason?: string };
    joins?: Array<{ recipe: string; bars: number; verdict: string }>;
    entries?: Array<{ title: string; in_bars: number; out_bars: number; transition: string }>;
    verify?: { ready: boolean };
  };
  console.log("order:", prepared.inferred?.reason ?? "?");

  const joins = prepared.joins ?? [];
  const entries = prepared.entries ?? [];
  const slams = joins.filter((j) => SLAM_RECIPES.has(j.recipe)).length;
  const distinct = new Set(joins.map((j) => j.recipe)).size;
  const onGrid = entries.filter(
    (e) => e.in_bars % 8 === 0 && e.out_bars % 8 === 0,
  ).length;
  const introExposure = entries.filter((e) => e.in_bars < 8).length;
  const playBars = entries.map((e) => e.out_bars - e.in_bars);
  const meanPlay =
    playBars.length > 0 ? playBars.reduce((s, n) => s + n, 0) / playBars.length : 0;

  // Energy arc flatness from the session arrangement.
  const session = parseToolJson(await mcp(page, "get_session")) as {
    arrangement?: Array<{ energyLevel: number | null }>;
  };
  const levels = (session.arrangement ?? [])
    .map((e) => e.energyLevel)
    .filter((n): n is number => n != null);
  const monotone =
    levels.length >= 3 && Math.max(...levels) - Math.min(...levels) <= 1 ? 1 : 0;

  // Offline bounce + loudness-jump scoring.
  const bounce = await mcp(page, "download_set", { filename: "eval-set" }, 600_000);
  console.log("bounce:", bounce.slice(0, 200));
  const download = await page.waitForEvent("download", { timeout: 120_000 });
  const wavPath = `${process.env.TEMP}\\bananalabs-eval-set.wav`;
  await download.saveAs(wavPath);
  const { samples, sampleRate } = readWavMono(wavPath);
  const rms = rmsWindows(samples, sampleRate);
  const jumps: number[] = [];
  for (let i = 1; i < rms.length; i++) {
    jumps.push(Math.abs(Math.log10(Math.max(1e-6, rms[i]! / Math.max(1e-6, rms[i - 1]!)))));
  }
  jumps.sort((a, b) => b - a);
  const worstJump = jumps[0] ?? 0;
  const medianJump = jumps[Math.floor(jumps.length / 2)] ?? 0;

  const scorecard = {
    files: FILES.length,
    order: entries.map((e) => e.title),
    joins: joins.map((j) => `${j.recipe}/${j.bars} ${j.verdict}`),
    chop_ratio: joins.length ? Number((slams / joins.length).toFixed(2)) : null,
    blend_ratio: joins.length ? Number((1 - slams / joins.length).toFixed(2)) : null,
    intro_exposure: entries.length ? Number((introExposure / entries.length).toFixed(2)) : null,
    mean_play_bars: Number(meanPlay.toFixed(1)),
    variety: joins.length ? Number((distinct / joins.length).toFixed(2)) : null,
    phrase_snap: entries.length ? Number((onGrid / entries.length).toFixed(2)) : null,
    monotone,
    verify_ready: prepared.verify?.ready ?? false,
    bounce: {
      seconds: Number((samples.length / sampleRate).toFixed(0)),
      worst_loudness_jump_db: Number((worstJump * 20).toFixed(1)),
      median_loudness_jump_db: Number((medianJump * 20).toFixed(1)),
    },
  };

  writeFileSync(OUT, JSON.stringify(scorecard, null, 2));
  console.log(JSON.stringify(scorecard, null, 2));
  console.log(`scorecard written to ${OUT}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
