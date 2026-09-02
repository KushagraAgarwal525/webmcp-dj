import type { SetDoc } from "../types/setdoc";
import { buildTimeline, joinIsClockIndependent, setDurationBars } from "./timeline";

/**
 * review_set core — the agent's ear. Measures the RENDERED bounce at each
 * join instead of trusting narration: dead air at the commit, level jumps,
 * bass stacking during the tease, whether the tease actually rises, whether
 * the slam lifts. Pure PCM math (no audio imports) so it runs in the page,
 * the eval harness, and the Node smoke suite alike.
 */

export type JoinReview = {
  index: number;
  join: string;
  type: string;
  commit_bars: number;
  level_jump_db: number | null;
  /** Mid-band rise across the tease window (late/early) — null on no-overlap joins. */
  tease_rise: number | null;
  /** Low-band ratio at tease mid vs the pre-tease solo — ~1 means one bass at a time. */
  bass_stack: number | null;
  /** Full-band lift across the 1 (post/pre) — a slam must punch, not sag. */
  drop_punch: number | null;
  dead_air: boolean;
  verdict: "clean" | "rough" | "broken";
  notes: string[];
};

export type SetReview = {
  duration_sec: number;
  joins: JoinReview[];
  clean: number;
  rough: number;
  broken: number;
  mean_abs_jump_db: number;
  ready: boolean;
  note: string;
};

function rms(samples: Float32Array, a: number, b: number): number {
  const lo = Math.max(0, Math.floor(a));
  const hi = Math.min(samples.length, Math.floor(b));
  if (hi - lo < 64) return 0;
  let s = 0;
  for (let i = lo; i < hi; i++) {
    const v = samples[i]!;
    s += v * v;
  }
  return Math.sqrt(s / (hi - lo));
}

/** One-pole band split (same constants as previewJoin's ear): LP 200Hz, HP 2kHz. */
function bandRms(
  samples: Float32Array,
  sampleRate: number,
  aSec: number,
  bSec: number,
  band: "full" | "low" | "mid" | "high",
): number {
  if (band === "full") return rms(samples, aSec * sampleRate, bSec * sampleRate);
  const a = Math.max(0, Math.floor(aSec * sampleRate));
  const b = Math.min(samples.length, Math.floor(bSec * sampleRate));
  if (b - a < 256) return 0;
  const lpA = Math.exp((-2 * Math.PI * 200) / sampleRate);
  const hpA = Math.exp((-2 * Math.PI * 2000) / sampleRate);
  let lp = 0;
  let bp = 0;
  let s = 0;
  let n = 0;
  // Skip the filter settle (~30ms) so the window edge transient doesn't skew.
  const settle = Math.floor(sampleRate * 0.03);
  for (let i = a; i < b; i++) {
    const x = samples[i]!;
    lp = lpA * lp + (1 - lpA) * x;
    const hp = x - lp;
    bp = hpA * bp + (1 - hpA) * hp;
    if (i < a + settle) continue;
    const v = band === "low" ? lp : band === "mid" ? bp : hp - bp;
    s += v * v;
    n++;
  }
  return n > 0 ? Math.sqrt(s / n) : 0;
}

function db(ratio: number): number {
  return 20 * Math.log10(Math.max(1e-6, ratio));
}

const SLAM_TYPES = new Set(["cut", "air_cut", "backspin", "loop_roll", "tease_slam"]);

export function reviewBounce(
  doc: SetDoc,
  samples: Float32Array,
  sampleRate: number,
  barsToSec: (bars: number) => number,
): SetReview {
  const spans = buildTimeline(doc);
  const durBars = setDurationBars(doc);
  const durSec = barsToSec(durBars);

  // Set-wide reference floor for the dead-air check.
  const setRef = bandRms(samples, sampleRate, 0, durSec, "full");

  const joins: JoinReview[] = [];
  for (let i = 1; i < spans.length; i++) {
    const span = spans[i]!;
    const prev = spans[i - 1]!;
    const type = span.entry.transition.type;
    const ta = doc.tracks[prev.entry.trackId];
    const tb = doc.tracks[span.entry.trackId];
    const commit = prev.setEnd;
    const start = span.setStart;
    const n = Math.max(0, Math.min(span.setStart + span.overlapBars, prev.setEnd) - start);
    const notes: string[] = [];

    const at = (bars: number) => barsToSec(Math.max(0, Math.min(durBars, bars)));
    const pre = bandRms(samples, sampleRate, at(commit - 4), at(commit), "full");
    const post = bandRms(samples, sampleRate, at(commit), at(commit + 4), "full");
    const jumpDb = pre > 1e-4 && post > 1e-4 ? db(post / pre) : null;

    // Dead air: 0.25-bar windows straddling the 1. echo_out throws are meant
    // to ring through — a true floor means the tail died.
    let minWin = Infinity;
    for (let b = commit - 0.5; b < commit + 1; b += 0.25) {
      minWin = Math.min(minWin, bandRms(samples, sampleRate, at(b), at(b + 0.25), "full"));
    }
    const deadAir = minWin < Math.max(0.012, setRef * 0.06) && setRef > 0.05;

    // Slam punch: the 1 must lift, not sag.
    const punch = SLAM_TYPES.has(type) && pre > 1e-4 ? post / pre : null;

    // Tease metrics on shared-clock overlaps.
    let teaseRise: number | null = null;
    let bassStack: number | null = null;
    if (n >= 8 && !joinIsClockIndependent(type)) {
      const early = bandRms(samples, sampleRate, at(start), at(start + n / 4), "mid");
      const late = bandRms(samples, sampleRate, at(commit - n / 4), at(commit), "mid");
      teaseRise = early > 1e-4 ? late / early : null;
      // Bass reference: the outgoing solo just before the tease, if that
      // window isn't still inside the previous join's tail.
      const prevCommit = i >= 2 ? spans[i - 2]!.setEnd : -Infinity;
      const refClean = start - 4 > prevCommit + 1;
      const bassRef = bandRms(
        samples,
        sampleRate,
        at(refClean ? start - 4 : commit - 4),
        at(refClean ? start : commit),
        "low",
      );
      const bassMid = bandRms(
        samples,
        sampleRate,
        at(start + n / 2 - 2),
        at(start + n / 2 + 2),
        "low",
      );
      bassStack = bassRef > 1e-4 ? bassMid / bassRef : null;
    }

    if (deadAir) {
      notes.push(
        type === "echo_out"
          ? "dead air at the leave — the echo throw should be ringing; the tail died"
          : "dead air at the commit — the room drops out",
      );
    }
    if (jumpDb != null && Math.abs(jumpDb) > 6) {
      notes.push(
        jumpDb > 0
          ? `level jumps +${jumpDb.toFixed(1)}dB across the 1 — the incoming slams hot`
          : `level drops ${jumpDb.toFixed(1)}dB across the 1 — the slam sags`,
      );
    }
    if (punch != null && punch < 0.98) {
      notes.push("the 1 doesn't lift — post-commit energy sags below the build");
    }
    if (teaseRise != null && teaseRise < 1.0) {
      notes.push(
        `tease falls (${teaseRise.toFixed(2)}×) — the build loses mids instead of rising into the 1`,
      );
    }
    if (bassStack != null && bassStack > 1.5) {
      notes.push(
        `double bass during the tease (${bassStack.toFixed(2)}×) — the incoming lows open before the 1`,
      );
    }
    if (!notes.length) notes.push("measures clean — tease rises, one bass, the 1 lands");

    const verdict = deadAir
      ? "broken"
      : (jumpDb != null && Math.abs(jumpDb) > 6) ||
          (punch != null && punch < 0.98) ||
          (teaseRise != null && teaseRise < 1.0) ||
          (bassStack != null && bassStack > 1.5)
        ? "rough"
        : "clean";

    joins.push({
      index: i,
      join: `${ta?.title ?? "?"} → ${tb?.title ?? "?"}`,
      type,
      commit_bars: Number(commit.toFixed(2)),
      level_jump_db: jumpDb != null ? Number(jumpDb.toFixed(1)) : null,
      tease_rise: teaseRise != null ? Number(teaseRise.toFixed(2)) : null,
      bass_stack: bassStack != null ? Number(bassStack.toFixed(2)) : null,
      drop_punch: punch != null ? Number(punch.toFixed(2)) : null,
      dead_air: deadAir,
      verdict,
      notes,
    });
  }

  const clean = joins.filter((j) => j.verdict === "clean").length;
  const rough = joins.filter((j) => j.verdict === "rough").length;
  const broken = joins.filter((j) => j.verdict === "broken").length;
  const jumps = joins
    .map((j) => Math.abs(j.level_jump_db ?? 0))
    .filter((n) => n > 0);
  const meanJump = jumps.length
    ? jumps.reduce((s, x) => s + x, 0) / jumps.length
    : 0;
  const worst = joins.find((j) => j.verdict === "broken") ?? joins.find((j) => j.verdict === "rough");

  return {
    duration_sec: Number(durSec.toFixed(1)),
    joins,
    clean,
    rough,
    broken,
    mean_abs_jump_db: Number(meanJump.toFixed(1)),
    ready: broken === 0,
    note:
      broken > 0
        ? `Join ${worst?.index} is broken — fix it and re-run. These numbers are the room, not opinion.`
        : rough > 0
          ? `No dead air; join ${worst?.index} is rough — read its notes before touching faders.`
          : "Every join measures clean. Play it loud.",
  };
}
