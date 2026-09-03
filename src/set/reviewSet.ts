import type { AutomationLane, SetDoc } from "../types/setdoc";
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
  /** RMS of the drop's first 150ms vs its following bars — <0.7 means the
   *  slam ramps THROUGH the first hit instead of landing on it. */
  first_hit: number | null;
  dead_air: boolean;
  verdict: "clean" | "rough" | "broken";
  notes: string[];
};

export type SetReview = {
  duration_sec: number;
  /** Per-entry solo level (full-band RMS dB between overlaps) — the input
   *  for gain staging. null when an entry has no clean solo stretch. */
  entries: { index: number; title: string; level_db: number | null }[];
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

  // Per-entry solo level: the span's own stretch between the previous
  // commit and the next overlap. This is what gain staging levels.
  const atBar = (bars: number) => barsToSec(Math.max(0, Math.min(durBars, bars)));
  const entries = spans.map((span, i) => {
    const nextOverlap = spans[i + 1]?.overlapBars ?? 0;
    const soloStart = i === 0 ? span.setStart : spans[i - 1]!.setEnd;
    const soloEnd = span.setEnd - nextOverlap;
    const track = doc.tracks[span.entry.trackId];
    if (soloEnd - soloStart < 2) {
      return { index: i, title: track?.title ?? "?", level_db: null };
    }
    const level = bandRms(
      samples,
      sampleRate,
      atBar(soloStart + 0.5),
      atBar(soloEnd - 0.5),
      "full",
    );
    return {
      index: i,
      title: track?.title ?? "?",
      level_db: level > 1e-4 ? Number(db(level).toFixed(1)) : null,
    };
  });

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
    // Level continuity ACROSS the 1: the bar before vs the bar after. Wider
    // windows read tease-build content as "quiet" by design and overestimate
    // the discontinuity — the ear judges the seam, not the sections.
    const pre = bandRms(samples, sampleRate, at(commit - 1), at(commit), "full");
    const post = bandRms(samples, sampleRate, at(commit), at(commit + 1), "full");
    const jumpDb = pre > 1e-4 && post > 1e-4 ? db(post / pre) : null;

    // Dead air: 0.25-bar windows straddling the 1. echo_out throws are meant
    // to ring through — a true floor means the tail died.
    let minWin = Infinity;
    for (let b = commit - 0.5; b < commit + 1; b += 0.25) {
      minWin = Math.min(minWin, bandRms(samples, sampleRate, at(b), at(b + 0.25), "full"));
    }
    const deadAir = minWin < Math.max(0.012, setRef * 0.06) && setRef > 0.05;

    // Slam punch: the 4-bar body after the 1 vs the 4-bar approach — a slam
    // must lift the room, not sag into it.
    const preBody = bandRms(samples, sampleRate, at(commit - 4), at(commit), "full");
    const postBody = bandRms(samples, sampleRate, at(commit), at(commit + 4), "full");
    const punch = SLAM_TYPES.has(type) && preBody > 1e-4 ? postBody / preBody : null;

    // Transient masking: on a slam, the drop's FIRST hit is the whole point.
    // Lane masking reads < ~0.5; a drop that opens with a riser legitimately
    // reads 0.6–0.8 — that's content shape, not a lane failure.
    const firstHit = bandRms(samples, sampleRate, at(commit), at(commit) + 0.15, "full");
    const steady = bandRms(samples, sampleRate, at(commit + 1), at(commit + 5), "full");
    const firstHitRatio =
      SLAM_TYPES.has(type) && steady > 0.02 ? firstHit / steady : null;
    const masked = firstHitRatio != null && firstHitRatio < 0.6;

    // Tease metrics on shared-clock overlaps.
    let teaseRise: number | null = null;
    let bassStack: number | null = null;
    if (n >= 8 && !joinIsClockIndependent(type)) {
      const early = bandRms(samples, sampleRate, at(start), at(start + n / 4), "mid");
      // The final bar is the wind-up (roll + dip) by design — the build's
      // shape is judged on the bars BEFORE it.
      const late = bandRms(samples, sampleRate, at(commit - n / 4 - 1), at(commit - 1), "mid");
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
    if (jumpDb != null && Math.abs(jumpDb) > 5) {
      notes.push(
        jumpDb > 0
          ? `level jumps +${jumpDb.toFixed(1)}dB across the 1 — the incoming slams hot (review_set fix:true gain-stages it)`
          : `level drops ${jumpDb.toFixed(1)}dB across the 1 — the slam sags (review_set fix:true gain-stages it)`,
      );
    }
    if (masked) {
      notes.push(
        `the drop's first hit lands half-open (${firstHitRatio!.toFixed(2)}× the bars after) — the slam ramps through the 1`,
      );
    }
    if (punch != null && punch < 0.98) {
      notes.push("the 1 doesn't lift — post-commit energy sags below the build");
    }
    if (teaseRise != null && teaseRise < 0.8) {
      // Observation only — never a verdict. The early tease is the outgoing's
      // drop at full power; a breather before the next build is the arc
      // working. Below 0.8 the tease is barely audible — worth an ear check.
      notes.push(`tease is subtle (${teaseRise.toFixed(2)}× mids) — listen for the bleed`);
    }
    if (bassStack != null && bassStack > 1.5) {
      notes.push(
        `double bass during the tease (${bassStack.toFixed(2)}×) — the incoming lows open before the 1`,
      );
    }
    if (!notes.length) notes.push("measures clean — tease rises, one bass, the 1 lands");

    const verdict = deadAir
      ? "broken"
      : (jumpDb != null && Math.abs(jumpDb) > 5) ||
          masked ||
          (punch != null && punch < 0.98) ||
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
      first_hit: firstHitRatio != null ? Number(firstHitRatio.toFixed(2)) : null,
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
    entries,
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
          ? `No dead air; join ${worst?.index} is rough — read its notes. Hot/sagging slams: re-run with fix:true to gain-stage.`
          : "Every join measures clean. Play it loud.",
  };
}

/**
 * Turn the review's per-entry solo levels into gain lanes: every entry gets
 * pulled toward the set's mean level (a slam should LIFT +1–2dB from content,
 * not from a hotter master). Lanes are id "gainstage-N" so a later fix run
 * replaces them wholesale. Chop clips all play heat, so per-entry loudness
 * differences are mastering differences — leveling them is the pro move.
 */
export function gainStageLanes(doc: SetDoc, review: SetReview): AutomationLane[] {
  const spans = buildTimeline(doc);
  const measured = review.entries.filter(
    (e): e is typeof e & { level_db: number } =>
      e.level_db != null && Number.isFinite(e.level_db),
  );
  if (measured.length < 2) return [];
  const target =
    measured.reduce((s, e) => s + e.level_db, 0) / measured.length;
  const lanes: AutomationLane[] = [];
  for (const span of spans) {
    const entry = review.entries[span.entryIndex];
    if (!entry) continue;
    const delta =
      entry.level_db == null
        ? 0
        : Math.max(-6, Math.min(4, target - entry.level_db));
    lanes.push({
      id: `gainstage-${span.entryIndex}`,
      startBars: span.setStart,
      endBars: span.setEnd,
      param: span.deck === "A" ? "gain_a" : "gain_b",
      startValue: Math.abs(delta) < 0.75 ? 0 : Number(delta.toFixed(1)),
      endValue: Math.abs(delta) < 0.75 ? 0 : Number(delta.toFixed(1)),
      curve: "linear",
    });
  }
  return lanes;
}
