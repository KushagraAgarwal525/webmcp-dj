import type { Track, TrackAnalysis } from "../types/setdoc";

const BASE = "https://lrclib.net/api";
const UA = "BananaLabsDJ/0.1 (https://bananalabs-sable.vercel.app)";

export type LyricWord = { t: number; w: string };

type LrcHit = {
  syncedLyrics: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
};

async function lrcFetch(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: { "User-Agent": UA },
  });
}

/** Parse LRC `[mm:ss.xx] line` into word-ish tokens with timestamps. */
export function parseLrcToWords(synced: string): LyricWord[] {
  const words: LyricWord[] = [];
  const lineRe = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\](.*)/g;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(synced)) !== null) {
    const min = Number(m[1]);
    const sec = Number(m[2]);
    const frac = m[3] ? Number(m[3].padEnd(3, "0").slice(0, 3)) / 1000 : 0;
    const t = min * 60 + sec + frac;
    const line = (m[4] ?? "").trim();
    if (!line) continue;
    const parts = line.split(/\s+/).filter(Boolean);
    parts.forEach((w, i) => {
      words.push({ t: t + i * 0.35, w });
    });
  }
  return words;
}

function plainToWords(plain: string): LyricWord[] {
  return plain
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => ({ t: i * 0.4, w }));
}

function fromHit(hit: LrcHit): {
  words: LyricWord[];
  explicit: boolean;
  source: "synced" | "plain" | "none";
  instrumental: boolean;
} {
  if (hit.instrumental) {
    return { words: [], explicit: false, source: "none", instrumental: true };
  }
  if (hit.syncedLyrics) {
    return {
      words: parseLrcToWords(hit.syncedLyrics),
      explicit: false,
      source: "synced",
      instrumental: false,
    };
  }
  if (hit.plainLyrics) {
    return {
      words: plainToWords(hit.plainLyrics),
      explicit: false,
      source: "plain",
      instrumental: false,
    };
  }
  return { words: [], explicit: false, source: "none", instrumental: false };
}

export async function fetchLyricsForTrack(track: Track): Promise<{
  words: LyricWord[];
  explicit: boolean;
  source: "synced" | "plain" | "none";
  instrumental: boolean;
}> {
  const title = track.title.replace(/\s*Official.*$/i, "").trim() || track.title;
  const artist =
    track.artist && track.artist !== "Unknown artist" ? track.artist : "Unknown";
  const duration = Math.round(
    track.analysis?.durationSec ?? track.durationSec ?? 180,
  );

  const q = encodeURIComponent(
    artist !== "Unknown" ? `${title} ${artist}` : title,
  );
  const searchRes = await lrcFetch(`/search?q=${q}`);
  if (searchRes.ok) {
    const results = (await searchRes.json()) as LrcHit[];
    const best =
      results.find((r) => r.syncedLyrics) ??
      results.find((r) => r.plainLyrics) ??
      null;
    if (best) return fromHit(best);
  }

  const params = new URLSearchParams({
    track_name: title,
    artist_name: artist,
    album_name: "",
    duration: String(duration),
  });
  try {
    const getRes = await lrcFetch(`/get?${params}`);
    if (getRes.ok) {
      return fromHit((await getRes.json()) as LrcHit);
    }
  } catch {
    /* */
  }
  return { words: [], explicit: false, source: "none", instrumental: false };
}

export function findLyricMatches(
  analysis: TrackAnalysis,
  query: string,
  limit = 12,
): {
  word: string;
  t: number;
  startBars: number;
  endBars: number;
  index: number;
}[] {
  const words = analysis.lyrics?.words;
  if (!words?.length) return [];
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const bpm = analysis.bpm || 120;
  const barSec = (60 / bpm) * 4;
  const out: {
    word: string;
    t: number;
    startBars: number;
    endBars: number;
    index: number;
  }[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (!w.w.toLowerCase().includes(q)) continue;
    const next = words[i + 1];
    const endT = next ? Math.max(w.t + 0.2, next.t) : w.t + 0.5;
    out.push({
      word: w.w,
      t: w.t,
      startBars: w.t / barSec,
      endBars: endT / barSec,
      index: i,
    });
    if (out.length >= limit) break;
  }
  return out;
}
