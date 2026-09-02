import { useSetStore } from "../commands/pipeline";
import { setDurationBars } from "../set/timeline";
import { capture } from "./posthog";

const MAX_TITLES = 32;

const COMPOSE_TOOLS = new Set([
  "prepare_set",
  "plan_set_arc",
  "apply_transition_recipe",
  "verify_set",
  "review_set",
  "preview_join",
  "set_clear",
]);

type ToolSource = "webmcp" | "local";

function asRecord(result: unknown): Record<string, unknown> | null {
  if (typeof result === "string") {
    try {
      const parsed: unknown = JSON.parse(result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
    return null;
  }
  if (result && typeof result === "object" && !Array.isArray(result) && !(result instanceof Error)) {
    return result as Record<string, unknown>;
  }
  return null;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function str(v: unknown, max = 80): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.slice(0, max);
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function issueCounts(issues: unknown): { error_count: number; warning_count: number } {
  if (!Array.isArray(issues)) return { error_count: 0, warning_count: 0 };
  let error_count = 0;
  let warning_count = 0;
  for (const row of issues) {
    if (!row || typeof row !== "object") continue;
    const sev = (row as { severity?: unknown }).severity;
    if (sev === "error") error_count += 1;
    else if (sev === "warn") warning_count += 1;
  }
  return { error_count, warning_count };
}

function titlesFromEntries(entries: unknown): string[] | undefined {
  if (!Array.isArray(entries) || !entries.length) return undefined;
  const out: string[] = [];
  for (const row of entries) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { title?: unknown; artist?: unknown };
    const title = str(rec.title, 120);
    if (!title) continue;
    const artist = str(rec.artist, 80);
    out.push(artist ? `${artist} - ${title}`.slice(0, 160) : title);
  }
  return out.length ? out.slice(0, MAX_TITLES) : undefined;
}

function joinHistogram(joins: unknown): string | undefined {
  if (!Array.isArray(joins) || !joins.length) return undefined;
  const counts: Record<string, number> = {};
  for (const row of joins) {
    if (!row || typeof row !== "object") continue;
    const recipe = str((row as { recipe?: unknown }).recipe, 40);
    if (!recipe) continue;
    counts[recipe] = (counts[recipe] ?? 0) + 1;
  }
  const keys = Object.keys(counts).sort();
  if (!keys.length) return undefined;
  return keys.map((k) => `${k}:${counts[k]}`).join(",");
}

function trackLabel(title: string, artist?: string): string {
  const t = title.trim().slice(0, 120);
  const a = artist?.trim().slice(0, 80);
  if (a) return `${a} - ${t}`.slice(0, 160);
  return t;
}

function crateTitles(): string[] {
  return Object.values(useSetStore.getState().doc.tracks)
    .map((t) => trackLabel(t.title, t.artist))
    .filter(Boolean)
    .slice(0, MAX_TITLES);
}

function setTitles(): string[] {
  const doc = useSetStore.getState().doc;
  return doc.arrangement
    .map((e) => {
      const t = doc.tracks[e.trackId];
      return t ? trackLabel(t.title, t.artist) : e.trackId;
    })
    .slice(0, MAX_TITLES);
}

function boothProps(): Record<string, string | number | boolean | string[]> {
  const doc = useSetStore.getState().doc;
  const set_titles = setTitles();
  return {
    set_id: doc.id,
    track_count: Object.keys(doc.tracks).length,
    arrangement_length: doc.arrangement.length,
    duration_bars: Math.round(setDurationBars(doc) * 100) / 100,
    ...(set_titles.length ? { set_titles } : {}),
  };
}

function toolProps(
  name: string,
  input: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): Record<string, string | number | boolean | string[] | undefined> {
  if (name === "prepare_set") {
    const inferred =
      payload?.inferred && typeof payload.inferred === "object"
        ? (payload.inferred as Record<string, unknown>)
        : null;
    const verify =
      payload?.verify && typeof payload.verify === "object"
        ? (payload.verify as Record<string, unknown>)
        : null;
    const counts = issueCounts(verify?.issues);
    return {
      intent: str(input.intent) ?? str(payload?.intent),
      arc: str(inferred?.arc, 32),
      style: str(inferred?.style, 16),
      inferred_track_count: num(inferred?.track_count),
      join_count: Array.isArray(payload?.joins) ? payload.joins.length : undefined,
      join_types: joinHistogram(payload?.joins),
      applied: bool(payload?.applied),
      proposed: bool(payload?.proposed),
      ready: bool(verify?.ready),
      error_count: counts.error_count,
      warning_count: counts.warning_count,
      hear: input.hear === undefined ? true : bool(input.hear),
      apply: input.apply === undefined ? true : bool(input.apply),
      set_titles: titlesFromEntries(payload?.entries),
    };
  }

  if (name === "plan_set_arc") {
    return {
      arc: str(input.arc, 32) ?? str(payload?.arc, 32),
      requested_track_count: num(input.track_count),
      entry_count: Array.isArray(payload?.entries) ? payload.entries.length : undefined,
      proposed: bool(payload?.proposed),
      apply: bool(input.apply) ?? false,
      set_titles: titlesFromEntries(payload?.entries),
    };
  }

  if (name === "apply_transition_recipe") {
    return {
      index: num(input.index) ?? num(payload?.index),
      recipe: str(input.recipe, 40) ?? str(payload?.recipe, 40),
    };
  }

  if (name === "verify_set") {
    const counts = issueCounts(payload?.issues);
    return {
      verify_source: str(input.source, 16) ?? str(payload?.source, 16) ?? "arrangement",
      ready: bool(payload?.ready),
      error_count: counts.error_count,
      warning_count: counts.warning_count,
    };
  }

  if (name === "review_set") {
    return {
      clean: num(payload?.clean),
      rough: num(payload?.rough),
      broken: num(payload?.broken),
      ready: bool(payload?.ready),
      mean_abs_jump_db: num(payload?.mean_abs_jump_db),
      join_count: Array.isArray(payload?.joins) ? payload.joins.length : undefined,
      duration_sec: num(payload?.duration_sec),
      focus: num(input.index) ?? num(payload?.focus),
    };
  }

  if (name === "preview_join") {
    return { index: num(input.index) };
  }

  return {};
}

/** Named compose events only — skips get_session / mixer chatter. */
export function captureToolCall(
  name: string,
  source: ToolSource,
  input: Record<string, unknown>,
  result: unknown,
  elapsedMs: number,
  threw: boolean,
): void {
  if (!COMPOSE_TOOLS.has(name)) return;
  const payload = threw ? null : asRecord(result);
  const ok = threw ? false : payload?.ok !== false;
  capture(name, {
    ...boothProps(),
    ...toolProps(name, input, payload),
    source,
    ok,
    ms: Math.round(elapsedMs),
  });
}

export function captureLibraryImport(added: number, importedTitles: string[]): void {
  if (added <= 0) return;
  const crate_titles = crateTitles();
  capture("library_import", {
    ...boothProps(),
    added,
    imported_titles: importedTitles.slice(0, MAX_TITLES),
    ...(crate_titles.length ? { crate_titles } : {}),
  });
}

export function captureSetPlay(): void {
  capture("set_play", boothProps());
}

export function captureDownloadWav(bytes: number, durationSec: number): void {
  capture("download_wav", {
    ...boothProps(),
    bytes,
    duration_sec: Math.round(durationSec * 10) / 10,
  });
}

export function captureDownloadBlset(missingAudio: number): void {
  capture("download_blset", {
    ...boothProps(),
    missing_audio: missingAudio,
  });
}
