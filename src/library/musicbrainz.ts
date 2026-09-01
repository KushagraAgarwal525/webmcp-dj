/**
 * Genre/tags from MusicBrainz — editorial/folksonomy, not BPM buckets.
 * https://musicbrainz.org/doc/MusicBrainz_API
 */

const BASE = "https://musicbrainz.org/ws/2";
const UA = "BananaLabsDJ/0.1 (https://bananalabs-sable.vercel.app)";

export type RecordingMeta = {
  mbid: string;
  genres: string[];
  tags: string[];
  source: "musicbrainz";
};

let lastAt = 0;

async function mbFetch(path: string): Promise<Response> {
  const wait = 1100 - (Date.now() - lastAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAt = Date.now();
  return fetch(`${BASE}${path}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
}

export function cleanTitleForLookup(title: string): string {
  return title
    .replace(/\s*[([].*official.*(audio|video|lyric).*[)\]]/gi, "")
    .replace(/\s*official\s+(audio|video|lyric).*$/gi, "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function luceneEscape(s: string): string {
  return s.replace(/[+\-&&||!(){}[\]^"~*?:\\/]/g, "\\$&");
}

type MbTag = { name?: string; count?: number };

function tagNames(tags: MbTag[] | undefined): string[] {
  if (!tags?.length) return [];
  return [...tags]
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map((t) => (t.name ?? "").trim())
    .filter(Boolean);
}

export async function lookupRecordingMeta(
  artist: string,
  title: string,
): Promise<RecordingMeta | null> {
  const t = cleanTitleForLookup(title);
  const a = artist.replace(/\s*unknown artist\s*/i, "").trim();
  if (!t || t.length < 2) return null;

  const q = a
    ? `recording:"${luceneEscape(t)}" AND artist:"${luceneEscape(a)}"`
    : `recording:"${luceneEscape(t)}"`;
  try {
    const search = await mbFetch(
      `/recording?query=${encodeURIComponent(q)}&fmt=json&limit=1`,
    );
    if (!search.ok) return null;
    const body = (await search.json()) as {
      recordings?: Array<{ id?: string; score?: number }>;
    };
    const hit = body.recordings?.[0];
    if (!hit?.id || (hit.score ?? 0) < 50) return null;

    const lookup = await mbFetch(`/recording/${hit.id}?inc=genres+tags&fmt=json`);
    if (!lookup.ok) return null;
    const rec = (await lookup.json()) as {
      id?: string;
      genres?: MbTag[];
      tags?: MbTag[];
    };
    const genres = tagNames(rec.genres);
    const tags = tagNames(rec.tags);
    if (!genres.length && !tags.length) {
      return { mbid: rec.id ?? hit.id, genres: [], tags: [], source: "musicbrainz" };
    }
    return { mbid: rec.id ?? hit.id, genres, tags, source: "musicbrainz" };
  } catch {
    return null;
  }
}
