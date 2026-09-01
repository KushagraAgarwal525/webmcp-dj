/**
 * Re-prepare the already-uploaded 4-track crate after join-fallback fix.
 */
import { chromium } from "playwright";

const CDP = "http://127.0.0.1:9335";

function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw) return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return { raw: String(raw) };
  }
}

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0]!;
const page =
  context.pages().find((p) => /5175/.test(p.url())) ?? context.pages()[0]!;
await page.goto("http://localhost:5175/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__bananalabs), null, { timeout: 60000 });
await page.bringToFront();
await page.mouse.click(200, 200);

async function mcp(name: string, input: Record<string, unknown> = {}, timeoutMs = 180000) {
  console.log(`→ ${name}`, Object.keys(input).length ? JSON.stringify(input) : "");
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
  console.log(`← ${name}`, JSON.stringify(p).slice(0, 1800));
  return p;
}

await mcp("set_pause", {});
const health = await mcp("get_crate_health", {});
console.log("CRATE", health.trackCount);

const prepared = await mcp("prepare_set", {
  intent:
    "Club journey, four records. Mixability path: blends by default, slams only as punctuation. Closer lands on its drop, never from silence.",
  track_count: 4,
  hear: true,
  apply: true,
});
console.log("PREPARE inferred", JSON.stringify(prepared.inferred));
console.log("PREPARE entries", JSON.stringify(prepared.entries));
console.log(
  "PREPARE joins",
  JSON.stringify(
    (prepared.joins as Array<Record<string, unknown>> | undefined)?.map((j) => ({
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
  if (j.verdict === "fail" && j.index && j.alternatives?.[0]) {
    await mcp("apply_transition_recipe", {
      index: j.index,
      recipe: j.alternatives[0].recipe,
      bars: j.alternatives[0].bars,
    });
  }
}

const hasEcho = joins.some((j) => j.recipe === "echo_out" || j.recipe === "half_bridge");
const hasSpin = joins.some((j) => j.recipe === "backspin");
if (hasEcho || hasSpin) {
  await mcp("fx_set", { type: "delay", wet: 0.2, time_beats: 0.75, feedback: 0.4 });
}
await mcp("deck_set_options", { deck: "A", keylock: true, quantize: true });
await mcp("deck_set_options", { deck: "B", keylock: true, quantize: true });

for (const j of joins) {
  if (j.index) await mcp("preview_join", { index: j.index, hear: true });
}

const verify = await mcp("verify_set", { source: "arrangement" });
console.log("VERIFY", JSON.stringify(verify));
if (verify.ready !== true) throw new Error("not ready");

const tl = await mcp("get_set_timeline", {});
console.log("SPANS", JSON.stringify(tl.spans));

await page.mouse.click(240, 220);
await mcp("set_seek", { bars: 0 });
await mcp("set_play", { start_bars: 0 });
console.log("PLAYING from 0");
