/**
 * Drive BananaLabs DJ tools on localhost.
 * Usage: npm run agent:smoke
 */
import { chromium } from "playwright";

const BASE = process.env.DJ_URL ?? "http://localhost:5173";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__bananalabs), null, {
    timeout: 15000,
  });

  const tools = await page.evaluate(() => window.__bananalabs!.listTools());
  console.log("tool count:", tools.length);
  console.log(
    "tools:",
    tools.map((t) => t.name).join(", "),
  );

  const session = await page.evaluate(() =>
    window.__bananalabs!.callTool("get_session", {}),
  );
  console.log("get_session:", session);

  const search = await page.evaluate(() =>
    window.__bananalabs!.callTool("search_library", {}),
  );
  console.log("search_library:", search);

  const parsed = JSON.parse(search) as {
    tracks?: { id: string; title: string }[];
  };
  const first = parsed.tracks?.[0];
  if (first) {
    const detail = await page.evaluate(
      ({ id }) => window.__bananalabs!.callTool("get_track", { track_id: id }),
      { id: first.id },
    );
    console.log("get_track:", detail.slice(0, 400) + "…");

    const track = JSON.parse(detail) as {
      analysis?: { durationBars?: number };
    };
    const out = track.analysis?.durationBars ?? 32;

    await page.evaluate(
      ({ id, outBars }) =>
        window.__bananalabs!.callTool("set_propose", {
          entries: [
            { track_id: id, in_bars: 0, out_bars: outBars, transition: "cut", bars: 0 },
          ],
          reason: "smoke test proposal",
        }),
      { id: first.id, outBars: out },
    );
    console.log("set_propose staged");
  } else {
    console.log("No tracks — upload in UI then re-run.");
  }

  console.log(
    "modelContext:",
    await page.evaluate(
      () => typeof document.modelContext?.registerTool === "function",
    ),
  );
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
