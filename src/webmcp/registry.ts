import type { ModelContextTool } from "./types";
import { isWebmcpAvailable } from "./types";
import { toolErr, toolOk, toolOkFull, toolResult } from "./toolResult";
import { useSetStore } from "../commands/pipeline";
import type { Command } from "../types/commands";
import type {
  ArrangementEntry,
  AutomationCurve,
  AutomationLane,
  AutomationParam,
  DeckId,
  FxType,
  SetDoc,
  TrackCraft,
  TrackMood,
  TrackRole,
  TransitionType,
} from "../types/setdoc";
import { buildTimeline, setDurationBars } from "../set/timeline";
import {
  applyRecipeBars,
  deriveEnergyLevel,
  getMixPoints,
  scoreArrangement,
  snapToPhrase,
  verifySet,
} from "../set/builder";
import {
  alignDropJoin,
  crateHealth,
  isDropRecipe,
  planSetArc,
  powerBlockTrims,
  tempoRelation,
} from "../set/craft";
import { previewJoin } from "../set/previewJoin";
import { setPerformer } from "../audio/setPerformer";
import { assertToolMapped } from "./toolUiMap";
import { findLyricMatches } from "../lyrics/lrclib";
import { audioEngine } from "../audio/engine";
import { phaseAlignBars } from "../audio/phaseAlign";
import { getPlaybookPayload } from "../agent/djPlaybook";

type LocalTool = ModelContextTool & {
  localExecute: (
    input: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<string>;
};

const localTools = new Map<string, LocalTool>();
const registrationControllers = new Map<string, AbortController>();

function dispatch(command: Command, source: "agent" | "ui" = "agent") {
  return useSetStore.getState().dispatch(command, source);
}

function getDoc(): SetDoc {
  return useSetStore.getState().doc;
}

function deckId(value: unknown): DeckId | null {
  return value === "A" || value === "B" || value === "C" || value === "D"
    ? value
    : null;
}

function defineTool(tool: LocalTool) {
  assertToolMapped(tool.name);
  localTools.set(tool.name, tool);
}

function compactSession(doc: SetDoc) {
  const transport = useSetStore.getState().transport;
  return {
    id: doc.id,
    title: doc.title,
    version: doc.version,
    trackCount: Object.keys(doc.tracks).length,
    tempoMaster: doc.tempoMaster,
    setTempoBpm: doc.setTempoBpm,
    setDurationBars: setDurationBars(doc),
    transport: {
      setPlaying: transport.setPlaying,
      setPositionBars: Number(transport.setPositionBars.toFixed(2)),
      entryIndex: transport.entryIndex,
    },
    arrangement: doc.arrangement.map((e, index) => ({
      index,
      trackId: e.trackId,
      inBars: e.inBars,
      outBars: e.outBars,
      transition: e.transition,
      title: doc.tracks[e.trackId]?.title,
      bpm: doc.tracks[e.trackId]?.analysis?.bpm,
      key: doc.tracks[e.trackId]?.analysis?.key.camelot,
      energyLevel: doc.tracks[e.trackId]
        ? deriveEnergyLevel(doc.tracks[e.trackId]!)
        : null,
      role:
        doc.tracks[e.trackId]?.craft?.role ??
        doc.tracks[e.trackId]?.analysis?.suggestedRole ??
        null,
      genre:
        doc.tracks[e.trackId]?.craft?.genreHint ??
        doc.tracks[e.trackId]?.analysis?.genreHint ??
        null,
    })),
    automation: (doc.automation ?? []).map((l) => ({
      id: l.id,
      param: l.param,
      startBars: l.startBars,
      endBars: l.endBars,
      startValue: l.startValue,
      endValue: l.endValue,
      curve: l.curve,
    })),
    proposalPending: Boolean(doc.proposal),
    proposalTrackCount: doc.proposal?.entries.length ?? 0,
    decks: Object.fromEntries(
      (["A", "B", "C", "D"] as DeckId[]).map((deck) => {
        const d = doc.decks[deck];
        const ch = doc.mixer.channels[deck];
        return [
          deck,
          {
            trackId: d.trackId,
            playing: d.playing,
            bpm: d.bpm,
            positionBars: Number(
              (transport.deckPlayheads[deck] ?? d.positionBars).toFixed(2),
            ),
            loopBars: d.loopBars,
            keylock: d.keylock,
            slip: d.slip,
            quantize: d.quantize,
            hotcues: d.hotcues,
            gainDb: ch.gainDb,
            eq: { low: ch.eqLow, mid: ch.eqMid, high: ch.eqHigh },
            filter: ch.filter,
            fader: ch.fader,
            cue: ch.cue,
          },
        ];
      }),
    ),
    mixer: {
      crossfader: doc.mixer.crossfader,
      xfaderCurve: doc.mixer.xfaderCurve,
      cueMix: doc.mixer.cueMix,
      masterDb: doc.mixer.masterDb,
    },
  };
}

function trackPayload(trackId: string, detail: "full" | "compact" = "full") {
  const track = getDoc().tracks[trackId];
  if (!track) return null;
  const a = track.analysis;
  const base = {
    id: track.id,
    title: track.title,
    artist: track.artist,
    tags: track.tags,
    craft: track.craft ?? null,
    analysisStatus: track.analysisStatus,
    analysisError: track.analysisError,
  };
  if (!a) return { ...base, analysis: null };
  if (detail === "compact") {
    return {
      ...base,
      analysis: {
        bpm: a.bpm,
        key: a.key,
        durationBars: Number(a.durationBars.toFixed(2)),
        durationSec: Number(a.durationSec.toFixed(2)),
        energyMean: Number(a.energyMean.toFixed(3)),
        energyLevel: deriveEnergyLevel(track),
        role: track.craft?.role ?? a.suggestedRole ?? null,
        mood: track.craft?.mood ?? a.mood ?? null,
        genreHint: track.craft?.genreHint ?? a.genreHint ?? null,
        vocalLead: Boolean(a.vocalLead),
        sectionCount: a.sections.length,
        vocalRegionCount: a.vocalRegions?.length ?? 0,
        hasLyrics: Boolean(a.lyrics),
      },
    };
  }
  // Full but budget-aware: downsample beats/energy
  const beatStep = Math.max(1, Math.floor(a.beats.length / 64));
  const downStep = Math.max(1, Math.floor(a.downbeats.length / 32));
  return {
    ...base,
    analysis: {
      bpm: a.bpm,
      key: a.key,
      durationBars: Number(a.durationBars.toFixed(2)),
      durationSec: Number(a.durationSec.toFixed(2)),
      energyMean: Number(a.energyMean.toFixed(3)),
      energyLevel: deriveEnergyLevel(track),
      role: track.craft?.role ?? a.suggestedRole ?? null,
      mood: track.craft?.mood ?? a.mood ?? null,
      genreHint: track.craft?.genreHint ?? a.genreHint ?? null,
      vocalLead: Boolean(a.vocalLead),
      energy: a.energy.map((v) => Number(v.toFixed(3))),
      sections: a.sections.map((s) => ({
        label: s.label,
        startBars: Number(s.startBars.toFixed(2)),
        endBars: Number(s.endBars.toFixed(2)),
      })),
      vocalRegions: (a.vocalRegions ?? []).map((v) => ({
        startBars: Number(v.startBars.toFixed(2)),
        endBars: Number(v.endBars.toFixed(2)),
      })),
      beatsSample: a.beats.filter((_, i) => i % beatStep === 0).map((t) => Number(t.toFixed(3))),
      downbeatsSample: a.downbeats
        .filter((_, i) => i % downStep === 0)
        .map((t) => Number(t.toFixed(3))),
      waveformPeaks: a.waveform?.peaks
        ?.filter((_, i) => i % 8 === 0)
        .map((v) => Number(v.toFixed(3))) ?? [],
      lyrics: a.lyrics
        ? {
            explicit: a.lyrics.explicit,
            wordCount: a.lyrics.words.length,
            preview: a.lyrics.words.slice(0, 40).map((w) => w.w).join(" "),
          }
        : null,
    },
  };
}

const TRANSITIONS: TransitionType[] = [
  "cut",
  "blend",
  "eq_swap",
  "filter_sweep",
  "echo_out",
  "loop_out",
  "build_cut",
  "drop_swap",
  "double_drop",
  "loop_roll",
  "backspin",
  "hook_layer",
];

const RECIPE_ENUM = [
  "drop_swap",
  "double_drop",
  "power_cut",
  "build_cut",
  "bass_swap",
  "eq_swap",
  "filter_sweep",
  "echo_out",
  "loop_out",
  "loop_roll",
  "backspin",
  "hook_layer",
  "half_bridge",
  "power_block",
] as const;

const AUTOMATION_PARAMS: AutomationParam[] = [
  "tempo",
  "xfader",
  "filter_a",
  "filter_b",
  "eq_low_a",
  "eq_mid_a",
  "eq_high_a",
  "eq_low_b",
  "eq_mid_b",
  "eq_high_b",
  "fader_a",
  "fader_b",
  "gain_a",
  "gain_b",
  "fx_wet",
  "fx_arm",
];

const AUTOMATION_CURVES: AutomationCurve[] = [
  "linear",
  "exponential",
  "ease_in",
  "ease_out",
];

function parseEntries(raw: unknown): ArrangementEntry[] {
  if (!Array.isArray(raw)) throw new Error("entries must be an array");
  const doc = getDoc();
  return raw.map((item, i) => {
    const row = item as Record<string, unknown>;
    const trackId = String(row.track_id ?? row.trackId ?? "");
    const track = doc.tracks[trackId];
    if (!track) throw new Error(`entries[${i}]: track not found`);
    const durationBars = track.analysis?.durationBars ?? 32;
    const inBars = Number(row.in_bars ?? row.inBars ?? 0);
    const outBars = Number(row.out_bars ?? row.outBars ?? durationBars);
    if (!Number.isFinite(inBars) || !Number.isFinite(outBars) || outBars <= inBars) {
      throw new Error(`entries[${i}]: in_bars/out_bars invalid`);
    }
    const tRaw = String(row.transition ?? "blend");
    const transition = (TRANSITIONS.includes(tRaw as TransitionType)
      ? tRaw
      : "blend") as TransitionType;
    const bars = Number(row.bars ?? row.transition_bars ?? 8);
    return {
      id: crypto.randomUUID(),
      trackId,
      inBars,
      outBars,
      transition: { type: transition, bars: Number.isFinite(bars) ? bars : 8 },
    };
  });
}

export function buildCoreTools() {
  localTools.clear();

  defineTool({
    name: "get_session",
    title: "Get session",
    description:
      "Compact live snapshot: decks, mixer, arrangement, proposal pending. Use before editing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => compactSession(getDoc()),
    localExecute: async () => toolOk({ session: compactSession(getDoc()) }),
  });

  defineTool({
    name: "get_track",
    title: "Get track",
    description:
      "Full track analysis: BPM, Camelot key, sections, energy curve, vocal regions, beat/downbeat samples, waveform peaks, lyrics preview. No mix-point suggestions — choose bars yourself.",
    inputSchema: {
      type: "object",
      properties: {
        track_id: { type: "string" },
        detail: { type: "string", enum: ["full", "compact"] },
      },
      required: ["track_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => {
      const detail = input.detail === "compact" ? "compact" : "full";
      const payload = trackPayload(String(input.track_id), detail);
      if (!payload) throw new Error("track not found");
      return payload;
    },
    localExecute: async (input) => {
      const detail = input.detail === "compact" ? "compact" : "full";
      const payload = trackPayload(String(input.track_id), detail);
      if (!payload) return toolErr("track not found");
      return toolOk(payload);
    },
  });

  defineTool({
    name: "search_library",
    title: "Search library",
    description: "Search tracks by title/artist with optional BPM and Camelot filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        bpm_min: { type: "number" },
        bpm_max: { type: "number" },
        key: { type: "string" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => searchTracks(input),
    localExecute: async (input) => toolOk({ tracks: searchTracks(input) }),
  });

  defineTool({
    name: "suggest_compatible",
    title: "Suggest compatible",
    description:
      "Ranks other tracks by BPM/key/energy distance to a seed. Metrics only — you choose the set.",
    inputSchema: {
      type: "object",
      properties: {
        track_id: { type: "string" },
        bpm_min: { type: "number" },
        bpm_max: { type: "number" },
      },
      required: ["track_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const { suggestCompatible } = await import("../set/builder");
      return suggestCompatible(
        getDoc(),
        String(input.track_id),
        input.bpm_min != null ? Number(input.bpm_min) : undefined,
        input.bpm_max != null ? Number(input.bpm_max) : undefined,
      );
    },
    localExecute: async (input) => {
      const { suggestCompatible } = await import("../set/builder");
      return toolOk({
        tracks: suggestCompatible(
          getDoc(),
          String(input.track_id),
          input.bpm_min != null ? Number(input.bpm_min) : undefined,
          input.bpm_max != null ? Number(input.bpm_max) : undefined,
        ),
      });
    },
  });

  defineTool({
    name: "get_set_quality",
    title: "Get set quality",
    description:
      "Returns numeric BPM/key/energy metrics plus craft notes from verify_set. Prefer verify_set as the gate before propose.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["arrangement", "proposal"] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => qualityPayload(input),
    localExecute: async (input) => {
      try {
        return toolOk(await qualityPayload(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "quality failed");
      }
    },
  });

  defineTool({
    name: "get_dj_playbook",
    title: "Get DJ playbook",
    description:
      "Facts: what recipes compile, verify error codes, Camelot/BPM refs. Does not pick a join. Optional topic=all|recipes|verify.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["all", "recipes", "verify"],
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => toolOkFull(getPlaybookPayload(input.topic)),
    localExecute: async (input) => toolOkFull(getPlaybookPayload(input.topic)),
  });

  defineTool({
    name: "get_mix_points",
    title: "Get mix points",
    description:
      "Phrase candidates: drop, 8/16 bars before drop, breakdown, mix-in/out, grid. Prefer phraseBars. You choose.",
    inputSchema: {
      type: "object",
      properties: { track_id: { type: "string" } },
      required: ["track_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const track = getDoc().tracks[String(input.track_id)];
      if (!track) throw new Error("track not found");
      return {
        trackId: track.id,
        title: track.title,
        points: getMixPoints(track),
      };
    },
    localExecute: async (input) => {
      const track = getDoc().tracks[String(input.track_id)];
      if (!track) return toolErr("track not found");
      return toolOk({
        trackId: track.id,
        title: track.title,
        points: getMixPoints(track),
      });
    },
  });

  defineTool({
    name: "verify_set",
    title: "Verify set",
    description:
      "Craft gate before set_propose. Returns ready + issues (double-bass, wash transitions, missing tempo ramp, echo without FX). Fix errors until ready:true.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["arrangement", "proposal"] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => verifyPayload(input),
    localExecute: async (input) => {
      try {
        return toolOk(verifyPayload(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "verify failed");
      }
    },
  });

  defineTool({
    name: "apply_transition_recipe",
    title: "Apply transition recipe",
    description:
      "Compile a join you chose on incoming entry (index≥1). Drop recipes also park incoming at drop−N and outgoing leave on its drop.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number" },
        recipe: {
          type: "string",
          enum: [...RECIPE_ENUM],
        },
        bars: { type: "number" },
      },
      required: ["index", "recipe"],
      additionalProperties: false,
    },
    execute: async (input) => applyRecipeExec(input),
    localExecute: async (input) => {
      try {
        return toolOk(applyRecipeExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "recipe failed");
      }
    },
  });

  defineTool({
    name: "get_crate_health",
    title: "Crate health",
    description:
      "Library coverage: Camelot orphans, BPM lanes, role/genre counts. Call before plan_set_arc.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => toolOkFull(crateHealth(getDoc())),
    localExecute: async () => toolOkFull(crateHealth(getDoc())),
  });

  defineTool({
    name: "plan_set_arc",
    title: "Plan set arc",
    description:
      "Peak-first track order + mix windows + drop cues. Does not pick the join (1-bar cut placeholder). Optional apply=true stages set_propose.",
    inputSchema: {
      type: "object",
      properties: {
        arc: {
          type: "string",
          enum: ["journey", "peak_time", "warm_up", "cool_down", "chill", "power_block"],
        },
        track_count: { type: "number" },
        apply: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: async (input) => toolOkFull(await planArcExec(input)),
    localExecute: async (input) => {
      try {
        return toolOkFull(await planArcExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "plan failed");
      }
    },
  });

  defineTool({
    name: "preview_join",
    title: "Preview join",
    description:
      "Listen-score a join (index ≥ 1): phrase, Camelot, BPM, bass/mid, drop positions. Verdict is an ear, not a recipe pick.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number" },
        hear: { type: "boolean" },
      },
      required: ["index"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) =>
      toolOkFull(await previewJoin(getDoc(), Number(input.index), input.hear !== false)),
    localExecute: async (input) => {
      try {
        return toolOkFull(
          await previewJoin(getDoc(), Number(input.index), input.hear !== false),
        );
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "preview failed");
      }
    },
  });

  defineTool({
    name: "tag_track",
    title: "Tag track craft",
    description:
      "Set human/agent craft overrides: role opener|builder|bridge|peak|reset|closer, energyLevel 1–10, mood, genreHint.",
    inputSchema: {
      type: "object",
      properties: {
        track_id: { type: "string" },
        role: {
          type: "string",
          enum: ["opener", "builder", "bridge", "peak", "reset", "closer"],
        },
        energy_level: { type: "number" },
        mood: { type: "string", enum: ["dark", "bright", "driving", "warm"] },
        genre_hint: { type: "string" },
      },
      required: ["track_id"],
      additionalProperties: false,
    },
    execute: async (input) => tagTrackExec(input),
    localExecute: async (input) => {
      try {
        return toolOk(tagTrackExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "tag failed");
      }
    },
  });

  defineTool({
    name: "prep_hotcues",
    title: "Prep hotcues",
    description:
      "Set deck pads 1–4: mix-in, 16 bars before drop, drop, mix-out.",
    inputSchema: {
      type: "object",
      properties: { deck: { type: "string", enum: ["A", "B", "C", "D"] } },
      required: ["deck"],
      additionalProperties: false,
    },
    execute: async (input) => prepHotcuesExec(input),
    localExecute: async (input) => {
      try {
        return toolOk(prepHotcuesExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "cues failed");
      }
    },
  });

  defineTool({
    name: "apply_power_block",
    title: "Apply power block",
    description:
      "Trim each arrangement entry to the first drop/hook (~32 bars) and set every join to a 1-bar cut.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => powerBlockExec(),
    localExecute: async () => {
      try {
        return toolOk(powerBlockExec());
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "power block failed");
      }
    },
  });

  defineTool({
    name: "analyze_track",
    title: "Analyze track",
    description: "Re-run analysis for a track already in the library (BPM, sections, energy, waveform).",
    inputSchema: {
      type: "object",
      properties: { track_id: { type: "string" } },
      required: ["track_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: async (input, { signal }) => {
      const { reanalyzeTrack } = await import("../library/importTracks");
      await reanalyzeTrack(String(input.track_id), signal);
      return trackPayload(String(input.track_id), "compact");
    },
    localExecute: async (input, signal) => {
      try {
        const { reanalyzeTrack } = await import("../library/importTracks");
        await reanalyzeTrack(String(input.track_id), signal);
        return toolOk(trackPayload(String(input.track_id), "compact")!);
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "analyze failed");
      }
    },
  });

  defineTool({
    name: "fetch_lyrics",
    title: "Fetch lyrics",
    description:
      "Fetch synced lyrics (LRCLIB) and store on the track. Then use find_lyric to map words → bars.",
    inputSchema: {
      type: "object",
      properties: { track_id: { type: "string" } },
      required: ["track_id"],
      additionalProperties: false,
    },
    execute: async (input) => fetchLyricsTool(String(input.track_id)),
    localExecute: async (input) => {
      try {
        return toolOk(await fetchLyricsTool(String(input.track_id)));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "lyrics fetch failed");
      }
    },
  });

  defineTool({
    name: "get_lyrics",
    title: "Get lyrics",
    description: "Return stored lyric words {t seconds, w}. Empty if not fetched yet.",
    inputSchema: {
      type: "object",
      properties: {
        track_id: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["track_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => getLyricsTool(input),
    localExecute: async (input) => toolOk(getLyricsTool(input)),
  });

  defineTool({
    name: "find_lyric",
    title: "Find lyric",
    description:
      "Search stored lyrics for query. Returns start_bars/end_bars for seek/loop/trim. fetch_lyrics first if none.",
    inputSchema: {
      type: "object",
      properties: {
        track_id: { type: "string" },
        query: { type: "string" },
        limit: { type: "number" },
      },
      required: ["track_id", "query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => findLyricTool(input),
    localExecute: async (input) => {
      try {
        return toolOk(findLyricTool(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "find failed");
      }
    },
  });

  // Decks
  defineTool({
    name: "load_deck",
    title: "Load deck",
    description: "Load a library track onto deck A–D.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        track_id: { type: "string" },
      },
      required: ["deck", "track_id"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      const trackId = String(input.track_id);
      if (!deck) throw new Error("invalid deck");
      if (!getDoc().tracks[trackId]) throw new Error("track not found");
      dispatch({ type: "deck.load", deck, trackId });
      return { deck, trackId };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      const trackId = String(input.track_id);
      if (!deck) return toolErr("invalid deck");
      if (!getDoc().tracks[trackId]) return toolErr("track not found");
      dispatch({ type: "deck.load", deck, trackId });
      return toolOk({ deck, trackId });
    },
  });

  defineTool({
    name: "unload_deck",
    title: "Unload deck",
    description: "Clear the track from a deck.",
    inputSchema: {
      type: "object",
      properties: { deck: { type: "string", enum: ["A", "B", "C", "D"] } },
      required: ["deck"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) throw new Error("invalid deck");
      dispatch({ type: "deck.unload", deck });
      return { deck };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) return toolErr("invalid deck");
      dispatch({ type: "deck.unload", deck });
      return toolOk({ deck });
    },
  });

  for (const action of ["play", "pause"] as const) {
    defineTool({
      name: `deck_${action}`,
      title: `Deck ${action}`,
      description: `${action === "play" ? "Start" : "Stop"} playback on a deck.`,
      inputSchema: {
        type: "object",
        properties: { deck: { type: "string", enum: ["A", "B", "C", "D"] } },
        required: ["deck"],
        additionalProperties: false,
      },
      execute: async (input) => {
        const deck = deckId(input.deck);
        if (!deck) throw new Error("invalid deck");
        dispatch({ type: action === "play" ? "deck.play" : "deck.pause", deck });
        return { deck, action };
      },
      localExecute: async (input) => {
        const deck = deckId(input.deck);
        if (!deck) return toolErr("invalid deck");
        dispatch({ type: action === "play" ? "deck.play" : "deck.pause", deck });
        return toolOk({ deck, action });
      },
    });
  }

  defineTool({
    name: "deck_seek",
    title: "Seek deck",
    description: "Seek a deck to a position in bars (from analysis beatgrid).",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        position_bars: { type: "number" },
      },
      required: ["deck", "position_bars"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      const positionBars = Number(input.position_bars);
      if (!deck) throw new Error("invalid deck");
      if (!Number.isFinite(positionBars)) throw new Error("position_bars required");
      dispatch({ type: "deck.seek", deck, positionBars });
      return { deck, positionBars };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      const positionBars = Number(input.position_bars);
      if (!deck) return toolErr("invalid deck");
      if (!Number.isFinite(positionBars)) return toolErr("position_bars required");
      dispatch({ type: "deck.seek", deck, positionBars });
      return toolOk({ deck, positionBars });
    },
  });

  defineTool({
    name: "deck_set_tempo",
    title: "Set tempo",
    description: "Set deck tempo in BPM. Engine maps to playback rate vs track analysis BPM.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        bpm: { type: "number" },
      },
      required: ["deck", "bpm"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      const bpm = Number(input.bpm);
      if (!deck) throw new Error("invalid deck");
      if (!Number.isFinite(bpm) || bpm <= 0) throw new Error("bpm invalid");
      dispatch({ type: "deck.setTempo", deck, bpm });
      return { deck, bpm };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      const bpm = Number(input.bpm);
      if (!deck) return toolErr("invalid deck");
      if (!Number.isFinite(bpm) || bpm <= 0) return toolErr("bpm invalid");
      dispatch({ type: "deck.setTempo", deck, bpm });
      return toolOk({ deck, bpm });
    },
  });

  defineTool({
    name: "deck_set_loop",
    title: "Set loop",
    description:
      "Engage a loop on a deck. bars = length (0 clears). Optional in_bars = loop start (defaults to current playhead). Audio actually reloops.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        bars: { type: "number" },
        in_bars: { type: "number" },
      },
      required: ["deck", "bars"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      const bars = Number(input.bars);
      if (!deck) throw new Error("invalid deck");
      dispatch({
        type: "deck.setLoop",
        deck,
        bars: bars <= 0 ? null : bars,
        inBars: input.in_bars != null ? Number(input.in_bars) : undefined,
      });
      const d = getDoc().decks[deck];
      return { deck, loopBars: d.loopBars, loopInBars: d.loopInBars };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      const bars = Number(input.bars);
      if (!deck) return toolErr("invalid deck");
      dispatch({
        type: "deck.setLoop",
        deck,
        bars: bars <= 0 ? null : bars,
        inBars: input.in_bars != null ? Number(input.in_bars) : undefined,
      });
      const d = getDoc().decks[deck];
      return toolOk({ deck, loopBars: d.loopBars, loopInBars: d.loopInBars });
    },
  });

  defineTool({
    name: "deck_set_options",
    title: "Deck options",
    description: "Set keylock, slip, and/or quantize on a deck.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        keylock: { type: "boolean" },
        slip: { type: "boolean" },
        quantize: { type: "boolean" },
      },
      required: ["deck"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) throw new Error("invalid deck");
      dispatch({
        type: "deck.setOptions",
        deck,
        keylock: typeof input.keylock === "boolean" ? input.keylock : undefined,
        slip: typeof input.slip === "boolean" ? input.slip : undefined,
        quantize: typeof input.quantize === "boolean" ? input.quantize : undefined,
      });
      return { deck, options: getDoc().decks[deck] };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) return toolErr("invalid deck");
      dispatch({
        type: "deck.setOptions",
        deck,
        keylock: typeof input.keylock === "boolean" ? input.keylock : undefined,
        slip: typeof input.slip === "boolean" ? input.slip : undefined,
        quantize: typeof input.quantize === "boolean" ? input.quantize : undefined,
      });
      return toolOk({ deck });
    },
  });

  defineTool({
    name: "set_tempo_master",
    title: "Set tempo master",
    description: "Choose which deck is the tempo/sync master.",
    inputSchema: {
      type: "object",
      properties: { deck: { type: "string", enum: ["A", "B", "C", "D"] } },
      required: ["deck"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) throw new Error("invalid deck");
      dispatch({ type: "deck.setMaster", deck });
      return { deck };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) return toolErr("invalid deck");
      dispatch({ type: "deck.setMaster", deck });
      return toolOk({ deck });
    },
  });

  defineTool({
    name: "sync_deck",
    title: "Sync deck",
    description:
      "Match this deck's BPM to the tempo master and phase-lock to the master's beat grid (¼-bar).",
    inputSchema: {
      type: "object",
      properties: { deck: { type: "string", enum: ["A", "B", "C", "D"] } },
      required: ["deck"],
      additionalProperties: false,
    },
    execute: async (input) => syncDeckExec(input),
    localExecute: async (input) => {
      try {
        return toolOk(syncDeckExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "sync failed");
      }
    },
  });

  defineTool({
    name: "hotcue",
    title: "Hot cue",
    description: "Set, trigger, or clear a hot cue pad (1–8). Positions are in bars.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        pad: { type: "number" },
        action: { type: "string", enum: ["set", "trigger", "clear"] },
        bars: { type: "number" },
      },
      required: ["deck", "pad", "action"],
      additionalProperties: false,
    },
    execute: async (input) => hotcueExec(input),
    localExecute: async (input) => {
      try {
        return toolOk(await hotcueExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "hotcue failed");
      }
    },
  });

  // Mixer
  defineTool({
    name: "set_gain",
    title: "Set gain",
    description: "Channel gain in dB.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        db: { type: "number" },
      },
      required: ["deck", "db"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      const db = Number(input.db);
      if (!deck) throw new Error("invalid deck");
      dispatch({ type: "mixer.setGain", deck, db });
      return { deck, db };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      const db = Number(input.db);
      if (!deck) return toolErr("invalid deck");
      dispatch({ type: "mixer.setGain", deck, db });
      return toolOk({ deck, db });
    },
  });

  defineTool({
    name: "set_eq",
    title: "Set EQ",
    description: "3-band EQ on a channel. band=low|mid|high, db typically -24..+6 (kill ≈ -24).",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        band: { type: "string", enum: ["low", "mid", "high"] },
        db: { type: "number" },
      },
      required: ["deck", "band", "db"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      const band = input.band;
      const db = Number(input.db);
      if (!deck) throw new Error("invalid deck");
      if (band !== "low" && band !== "mid" && band !== "high") throw new Error("invalid band");
      dispatch({ type: "mixer.setEQ", deck, band, db });
      return { deck, band, db };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      const band = input.band;
      const db = Number(input.db);
      if (!deck) return toolErr("invalid deck");
      if (band !== "low" && band !== "mid" && band !== "high") return toolErr("invalid band");
      dispatch({ type: "mixer.setEQ", deck, band, db });
      return toolOk({ deck, band, db });
    },
  });

  defineTool({
    name: "set_filter",
    title: "Set filter",
    description: "Channel filter sweep. -1 = full LP, 0 = bypass, +1 = full HP.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        value: { type: "number" },
      },
      required: ["deck", "value"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      const value = Number(input.value);
      if (!deck) throw new Error("invalid deck");
      dispatch({ type: "mixer.setFilter", deck, value });
      return { deck, value };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      const value = Number(input.value);
      if (!deck) return toolErr("invalid deck");
      dispatch({ type: "mixer.setFilter", deck, value });
      return toolOk({ deck, value });
    },
  });

  defineTool({
    name: "set_fader",
    title: "Set fader",
    description: "Channel volume fader 0..1.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        value: { type: "number" },
      },
      required: ["deck", "value"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      const value = Number(input.value);
      if (!deck) throw new Error("invalid deck");
      dispatch({ type: "mixer.setFader", deck, value });
      return { deck, value };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      const value = Number(input.value);
      if (!deck) return toolErr("invalid deck");
      dispatch({ type: "mixer.setFader", deck, value });
      return toolOk({ deck, value });
    },
  });

  defineTool({
    name: "set_crossfader",
    title: "Set crossfader",
    description: "Crossfader -1 (A) .. +1 (B).",
    inputSchema: {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const value = Number(input.value);
      dispatch({ type: "mixer.setCrossfader", value });
      return { value };
    },
    localExecute: async (input) => {
      const value = Number(input.value);
      dispatch({ type: "mixer.setCrossfader", value });
      return toolOk({ value });
    },
  });

  defineTool({
    name: "set_xfader_curve",
    title: "Crossfader curve",
    description: "Set crossfader curve to smooth or scratch.",
    inputSchema: {
      type: "object",
      properties: { curve: { type: "string", enum: ["smooth", "scratch"] } },
      required: ["curve"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const curve = input.curve === "scratch" ? "scratch" : "smooth";
      dispatch({ type: "mixer.setXfaderCurve", curve });
      return { curve };
    },
    localExecute: async (input) => {
      const curve = input.curve === "scratch" ? "scratch" : "smooth";
      dispatch({ type: "mixer.setXfaderCurve", curve });
      return toolOk({ curve });
    },
  });

  // Set tools — agent authors the arrangement
  defineTool({
    name: "set_insert_track",
    title: "Insert track",
    description:
      "Insert a track into the working arrangement at index. You choose in_bars and out_bars from get_track sections/grid.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number" },
        track_id: { type: "string" },
        in_bars: { type: "number" },
        out_bars: { type: "number" },
        transition: { type: "string", enum: TRANSITIONS },
        bars: { type: "number" },
      },
      required: ["index", "track_id", "in_bars", "out_bars"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const trackId = String(input.track_id);
      if (!getDoc().tracks[trackId]) throw new Error("track not found");
      dispatch({
        type: "set.insert",
        index: Number(input.index),
        trackId,
        inBars: Number(input.in_bars),
        outBars: Number(input.out_bars),
        transition: input.transition as TransitionType | undefined,
        bars: input.bars != null ? Number(input.bars) : undefined,
      });
      return { arrangementLength: getDoc().arrangement.length };
    },
    localExecute: async (input) => {
      const trackId = String(input.track_id);
      if (!getDoc().tracks[trackId]) return toolErr("track not found");
      dispatch({
        type: "set.insert",
        index: Number(input.index),
        trackId,
        inBars: Number(input.in_bars),
        outBars: Number(input.out_bars),
        transition: input.transition as TransitionType | undefined,
        bars: input.bars != null ? Number(input.bars) : undefined,
      });
      return toolOk({ arrangementLength: getDoc().arrangement.length });
    },
  });

  defineTool({
    name: "set_remove_track",
    title: "Remove track",
    description: "Remove arrangement entry at index.",
    inputSchema: {
      type: "object",
      properties: { index: { type: "number" } },
      required: ["index"],
      additionalProperties: false,
    },
    execute: async (input) => {
      dispatch({ type: "set.remove", index: Number(input.index) });
      return { arrangementLength: getDoc().arrangement.length };
    },
    localExecute: async (input) => {
      dispatch({ type: "set.remove", index: Number(input.index) });
      return toolOk({ arrangementLength: getDoc().arrangement.length });
    },
  });

  defineTool({
    name: "set_move_track",
    title: "Move track",
    description: "Reorder arrangement entry from_index → to_index.",
    inputSchema: {
      type: "object",
      properties: {
        from_index: { type: "number" },
        to_index: { type: "number" },
      },
      required: ["from_index", "to_index"],
      additionalProperties: false,
    },
    execute: async (input) => {
      dispatch({
        type: "set.move",
        fromIndex: Number(input.from_index),
        toIndex: Number(input.to_index),
      });
      return { ok: true };
    },
    localExecute: async (input) => {
      dispatch({
        type: "set.move",
        fromIndex: Number(input.from_index),
        toIndex: Number(input.to_index),
      });
      return toolOk({});
    },
  });

  defineTool({
    name: "set_set_trim",
    title: "Set trim",
    description: "Set in_bars/out_bars for an arrangement entry. You pick bars from analysis.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number" },
        in_bars: { type: "number" },
        out_bars: { type: "number" },
      },
      required: ["index", "in_bars", "out_bars"],
      additionalProperties: false,
    },
    execute: async (input) => {
      dispatch({
        type: "set.setTrim",
        index: Number(input.index),
        inBars: Number(input.in_bars),
        outBars: Number(input.out_bars),
      });
      return getDoc().arrangement[Number(input.index)] ?? null;
    },
    localExecute: async (input) => {
      dispatch({
        type: "set.setTrim",
        index: Number(input.index),
        inBars: Number(input.in_bars),
        outBars: Number(input.out_bars),
      });
      return toolOk({ entry: getDoc().arrangement[Number(input.index)] });
    },
  });

  defineTool({
    name: "set_set_transition",
    title: "Set transition",
    description: "Set transition type and length in bars into the entry at index.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number" },
        type: { type: "string", enum: TRANSITIONS },
        bars: { type: "number" },
      },
      required: ["index", "type"],
      additionalProperties: false,
    },
    execute: async (input) => {
      dispatch({
        type: "set.setTransition",
        index: Number(input.index),
        transition: input.type as TransitionType,
        bars: input.bars != null ? Number(input.bars) : undefined,
      });
      return getDoc().arrangement[Number(input.index)] ?? null;
    },
    localExecute: async (input) => {
      dispatch({
        type: "set.setTransition",
        index: Number(input.index),
        transition: input.type as TransitionType,
        bars: input.bars != null ? Number(input.bars) : undefined,
      });
      return toolOk({ entry: getDoc().arrangement[Number(input.index)] });
    },
  });

  defineTool({
    name: "set_clear",
    title: "Clear set",
    description: "Clear the working arrangement (not the library).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      dispatch({ type: "set.clear" });
      return { cleared: true };
    },
    localExecute: async () => {
      dispatch({ type: "set.clear" });
      return toolOk({ cleared: true });
    },
  });

  defineTool({
    name: "set_propose",
    title: "Propose set",
    description:
      "Stage an arrangement for human Accept/Reject. You author tracks and joins. Do not invent tracks. verify_set ready:true means no broken automation.",
    inputSchema: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              track_id: { type: "string" },
              in_bars: { type: "number" },
              out_bars: { type: "number" },
              transition: { type: "string", enum: TRANSITIONS },
              bars: { type: "number" },
            },
            required: ["track_id", "in_bars", "out_bars"],
          },
        },
        automation: {
          type: "array",
          items: {
            type: "object",
            properties: {
              param: { type: "string", enum: AUTOMATION_PARAMS },
              start_bars: { type: "number" },
              end_bars: { type: "number" },
              start_value: { type: "number" },
              end_value: { type: "number" },
              curve: { type: "string", enum: AUTOMATION_CURVES },
            },
            required: ["param", "start_bars", "end_bars", "start_value", "end_value"],
          },
        },
        reason: { type: "string" },
      },
      required: ["entries"],
      additionalProperties: false,
    },
    execute: async (input) => proposeFromInput(input),
    localExecute: async (input) => {
      try {
        return toolOk(await proposeFromInput(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "propose failed");
      }
    },
  });

  defineTool({
    name: "set_apply_proposal",
    title: "Apply proposal",
    description: "Apply the pending proposal to the arrangement.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (!getDoc().proposal) throw new Error("no pending proposal");
      dispatch({ type: "set.applyProposal" });
      return { applied: true };
    },
    localExecute: async () => {
      if (!getDoc().proposal) return toolErr("no pending proposal");
      dispatch({ type: "set.applyProposal" });
      return toolOk({ applied: true });
    },
  });

  defineTool({
    name: "set_reject_proposal",
    title: "Reject proposal",
    description: "Discard the pending proposal.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      if (!getDoc().proposal) throw new Error("no pending proposal");
      dispatch({ type: "set.rejectProposal" });
      return { rejected: true };
    },
    localExecute: async () => {
      if (!getDoc().proposal) return toolErr("no pending proposal");
      dispatch({ type: "set.rejectProposal" });
      return toolOk({ rejected: true });
    },
  });

  defineTool({
    name: "get_set_timeline",
    title: "Get set timeline",
    description:
      "Flattened set timeline with deck assignment, overlaps from transitions, duration, and automation lanes. Use before adding tempo/mixer automations (bars are absolute from set start).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => timelinePayload(),
    localExecute: async () => toolOk(timelinePayload()),
  });

  defineTool({
    name: "set_set_tempo",
    title: "Set master tempo",
    description:
      "Set master set tempo in BPM (null clears → first track BPM). Tempo automation overrides while active.",
    inputSchema: {
      type: "object",
      properties: { bpm: { type: ["number", "null"] } },
      required: ["bpm"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const bpm = input.bpm == null ? null : Number(input.bpm);
      dispatch({ type: "set.setTempo", bpm });
      return { setTempoBpm: getDoc().setTempoBpm };
    },
    localExecute: async (input) => {
      const bpm = input.bpm == null ? null : Number(input.bpm);
      dispatch({ type: "set.setTempo", bpm });
      return toolOk({ setTempoBpm: getDoc().setTempoBpm });
    },
  });

  defineTool({
    name: "set_add_automation",
    title: "Add automation",
    description:
      "Add a set-timeline automation lane (absolute bars). param=tempo for BPM ramps (e.g. 124→128 over 16 bars). Also xfader, filter_a/b, eq_*_a/b, fader_a/b, gain_a/b. curve: linear|exponential|ease_in|ease_out. Play performs these with transitions.",
    inputSchema: {
      type: "object",
      properties: {
        param: { type: "string", enum: AUTOMATION_PARAMS },
        start_bars: { type: "number" },
        end_bars: { type: "number" },
        start_value: { type: "number" },
        end_value: { type: "number" },
        curve: { type: "string", enum: AUTOMATION_CURVES },
      },
      required: ["param", "start_bars", "end_bars", "start_value", "end_value"],
      additionalProperties: false,
    },
    execute: async (input) => addAutomationFromInput(input),
    localExecute: async (input) => {
      try {
        return toolOk(addAutomationFromInput(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "automation failed");
      }
    },
  });

  defineTool({
    name: "set_remove_automation",
    title: "Remove automation",
    description: "Remove an automation lane by id (from get_session / get_set_timeline).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    execute: async (input) => {
      dispatch({ type: "set.removeAutomation", id: String(input.id) });
      return { automationCount: getDoc().automation.length };
    },
    localExecute: async (input) => {
      dispatch({ type: "set.removeAutomation", id: String(input.id) });
      return toolOk({ automationCount: getDoc().automation.length });
    },
  });

  defineTool({
    name: "set_clear_automation",
    title: "Clear automation",
    description: "Clear all explicit automation lanes (compiled transition automations remain).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      dispatch({ type: "set.clearAutomation" });
      return { cleared: true };
    },
    localExecute: async () => {
      dispatch({ type: "set.clearAutomation" });
      return toolOk({ cleared: true });
    },
  });

  defineTool({
    name: "set_play",
    title: "Play set",
    description:
      "Perform the arrangement: loads A/B alternating, applies transition types and automation (tempo/EQ/filter/xfader). Optional start_bars seeks first.",
    inputSchema: {
      type: "object",
      properties: { start_bars: { type: "number" } },
      additionalProperties: false,
    },
    execute: async (input) => {
      if (input.start_bars != null) await setPerformer.seek(Number(input.start_bars));
      await setPerformer.play(
        input.start_bars != null ? Number(input.start_bars) : undefined,
      );
      return {
        playing: true,
        positionBars: useSetStore.getState().transport.setPositionBars,
      };
    },
    localExecute: async (input) => {
      if (input.start_bars != null) await setPerformer.seek(Number(input.start_bars));
      await setPerformer.play(
        input.start_bars != null ? Number(input.start_bars) : undefined,
      );
      return toolOk({
        playing: true,
        positionBars: useSetStore.getState().transport.setPositionBars,
      });
    },
  });

  defineTool({
    name: "set_pause",
    title: "Pause set",
    description: "Pause set performance.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      setPerformer.pause();
      return { playing: false };
    },
    localExecute: async () => {
      setPerformer.pause();
      return toolOk({ playing: false });
    },
  });

  defineTool({
    name: "set_seek",
    title: "Seek set",
    description: "Seek set playhead to absolute bars (also works while paused).",
    inputSchema: {
      type: "object",
      properties: { bars: { type: "number" } },
      required: ["bars"],
      additionalProperties: false,
    },
    execute: async (input) => {
      await setPerformer.seek(Number(input.bars));
      return { positionBars: useSetStore.getState().transport.setPositionBars };
    },
    localExecute: async (input) => {
      await setPerformer.seek(Number(input.bars));
      return toolOk({
        positionBars: useSetStore.getState().transport.setPositionBars,
      });
    },
  });

  defineTool({
    name: "fx_set",
    title: "Set FX",
    description: "Master FX unit: type off|delay|reverb|echo, wet 0–1, time_beats, feedback.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["off", "delay", "reverb", "echo"] },
        wet: { type: "number" },
        time_beats: { type: "number" },
        feedback: { type: "number" },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
      dispatch({
        type: "fx.set",
        fxType: input.type != null ? (String(input.type) as FxType) : undefined,
        wet: input.wet != null ? Number(input.wet) : undefined,
        timeBeats: input.time_beats != null ? Number(input.time_beats) : undefined,
        feedback: input.feedback != null ? Number(input.feedback) : undefined,
      });
      return getDoc().fx;
    },
    localExecute: async (input) => {
      dispatch({
        type: "fx.set",
        fxType: input.type != null ? (String(input.type) as FxType) : undefined,
        wet: input.wet != null ? Number(input.wet) : undefined,
        timeBeats: input.time_beats != null ? Number(input.time_beats) : undefined,
        feedback: input.feedback != null ? Number(input.feedback) : undefined,
      });
      return toolOk({ fx: getDoc().fx });
    },
  });

  defineTool({
    name: "deck_set_fx_send",
    title: "Deck FX send",
    description: "Set deck send to FX bus 0–1.",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        value: { type: "number" },
      },
      required: ["deck", "value"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) throw new Error("invalid deck");
      dispatch({ type: "deck.setFxSend", deck, value: Number(input.value) });
      return { deck, fxSend: getDoc().decks[deck].fxSend };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) return toolErr("invalid deck");
      dispatch({ type: "deck.setFxSend", deck, value: Number(input.value) });
      return toolOk({ deck, fxSend: getDoc().decks[deck].fxSend });
    },
  });

  defineTool({
    name: "sampler_set_pad",
    title: "Set sampler pad",
    description: "Assign a track slice to sampler pad 1–8 (track_id, in_bars, out_bars).",
    inputSchema: {
      type: "object",
      properties: {
        pad: { type: "number" },
        track_id: { type: ["string", "null"] },
        in_bars: { type: "number" },
        out_bars: { type: "number" },
        gain: { type: "number" },
        label: { type: "string" },
      },
      required: ["pad"],
      additionalProperties: false,
    },
    execute: async (input) => {
      dispatch({
        type: "sampler.setPad",
        pad: Number(input.pad),
        trackId:
          input.track_id === null
            ? null
            : input.track_id != null
              ? String(input.track_id)
              : undefined,
        inBars: input.in_bars != null ? Number(input.in_bars) : undefined,
        outBars: input.out_bars != null ? Number(input.out_bars) : undefined,
        gain: input.gain != null ? Number(input.gain) : undefined,
        label: input.label != null ? String(input.label) : undefined,
      });
      return getDoc().sampler.pads[Number(input.pad) - 1];
    },
    localExecute: async (input) => {
      dispatch({
        type: "sampler.setPad",
        pad: Number(input.pad),
        trackId:
          input.track_id === null
            ? null
            : input.track_id != null
              ? String(input.track_id)
              : undefined,
        inBars: input.in_bars != null ? Number(input.in_bars) : undefined,
        outBars: input.out_bars != null ? Number(input.out_bars) : undefined,
        gain: input.gain != null ? Number(input.gain) : undefined,
        label: input.label != null ? String(input.label) : undefined,
      });
      return toolOk({ pad: getDoc().sampler.pads[Number(input.pad) - 1] });
    },
  });

  defineTool({
    name: "sampler_trigger",
    title: "Trigger sampler",
    description: "Fire sampler pad 1–8 (one-shot).",
    inputSchema: {
      type: "object",
      properties: { pad: { type: "number" } },
      required: ["pad"],
      additionalProperties: false,
    },
    execute: async (input) => {
      dispatch({ type: "sampler.trigger", pad: Number(input.pad) });
      return { pad: Number(input.pad) };
    },
    localExecute: async (input) => {
      dispatch({ type: "sampler.trigger", pad: Number(input.pad) });
      return toolOk({ pad: Number(input.pad) });
    },
  });

  defineTool({
    name: "sampler_set_master",
    title: "Sampler master",
    description: "Set sampler master gain 0–2.",
    inputSchema: {
      type: "object",
      properties: { gain: { type: "number" } },
      required: ["gain"],
      additionalProperties: false,
    },
    execute: async (input) => {
      dispatch({ type: "sampler.setMaster", gain: Number(input.gain) });
      return { gain: getDoc().sampler.masterGain };
    },
    localExecute: async (input) => {
      dispatch({ type: "sampler.setMaster", gain: Number(input.gain) });
      return toolOk({ gain: getDoc().sampler.masterGain });
    },
  });

  defineTool({
    name: "record_start",
    title: "Start record",
    description: "Start recording the master bus (downloads WebM on stop).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      dispatch({ type: "record.start" });
      return { recording: true };
    },
    localExecute: async () => {
      dispatch({ type: "record.start" });
      return toolOk({ recording: true });
    },
  });

  defineTool({
    name: "record_stop",
    title: "Stop record",
    description: "Stop master recording and download the take.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      dispatch({ type: "record.stop" });
      return { recording: false };
    },
    localExecute: async () => {
      dispatch({ type: "record.stop" });
      return toolOk({ recording: false });
    },
  });

  defineTool({
    name: "record_clear",
    title: "Clear record",
    description: "Clear last recorded take URL from session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      dispatch({ type: "record.clear" });
      return { cleared: true };
    },
    localExecute: async () => {
      dispatch({ type: "record.clear" });
      return toolOk({ cleared: true });
    },
  });

  defineTool({
    name: "history",
    title: "History",
    description: "Undo or redo the last SetDoc mutation.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["undo", "redo"] } },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (input) => {
      if (input.action === "undo") useSetStore.getState().undo();
      else if (input.action === "redo") useSetStore.getState().redo();
      else throw new Error("action must be undo or redo");
      return { action: input.action };
    },
    localExecute: async (input) => {
      if (input.action === "undo") useSetStore.getState().undo();
      else if (input.action === "redo") useSetStore.getState().redo();
      else return toolErr("action must be undo or redo");
      return toolOk({ action: input.action });
    },
  });
}

function syncDeckExec(input: Record<string, unknown>) {
  const deck = deckId(input.deck);
  if (!deck) throw new Error("invalid deck");
  const doc = getDoc();
  const master = doc.tempoMaster;
  if (deck === master) throw new Error("deck is already the tempo master");
  const masterState = doc.decks[master];
  const slaveState = doc.decks[deck];
  if (!slaveState.trackId) throw new Error("deck has no track");
  const bpm =
    masterState.bpm ??
    doc.setTempoBpm ??
    (masterState.trackId ? doc.tracks[masterState.trackId]?.analysis?.bpm : null);
  if (bpm == null) throw new Error("master has no BPM");

  dispatch({ type: "deck.setTempo", deck, bpm });

  const transport = useSetStore.getState().transport;
  const masterBars = masterState.playing
    ? audioEngine.getPositionBars(master)
    : (transport.deckPlayheads[master] ?? masterState.positionBars);
  const slaveBars = slaveState.playing
    ? audioEngine.getPositionBars(deck)
    : (transport.deckPlayheads[deck] ?? slaveState.positionBars);
  const aligned = phaseAlignBars(slaveBars, masterBars, 0.25);
  dispatch({ type: "deck.seek", deck, positionBars: aligned, exact: true });

  return {
    deck,
    bpm,
    master,
    fromBars: Number(slaveBars.toFixed(3)),
    toBars: Number(aligned.toFixed(3)),
    phaseDeltaBars: Number((aligned - slaveBars).toFixed(3)),
  };
}

function verifyPayload(input: Record<string, unknown>) {
  const doc = getDoc();
  const source = input.source === "proposal" ? "proposal" : "arrangement";
  const entries =
    source === "proposal" ? doc.proposal?.entries ?? [] : doc.arrangement;
  if (!entries.length) throw new Error(`no ${source} entries`);
  return { source, ...verifySet(doc, entries) };
}

function applyRecipeExec(input: Record<string, unknown>) {
  const index = Number(input.index);
  const recipe = String(input.recipe);
  const applied = applyRecipeBars(
    recipe,
    input.bars != null ? Number(input.bars) : undefined,
  );
  if (!applied) throw new Error(`unknown recipe: ${recipe}`);
  const doc = getDoc();
  if (!doc.arrangement[index]) throw new Error("invalid index");
  dispatch({
    type: "set.setTransition",
    index,
    transition: applied.type,
    bars: applied.bars,
  });

  if (index > 0 && (isDropRecipe(recipe) || recipe === "backspin")) {
    const live = getDoc();
    const prev = live.arrangement[index - 1]!;
    const cur = live.arrangement[index]!;
    const ta = live.tracks[prev.trackId];
    const tb = live.tracks[cur.trackId];
    if (ta && tb) {
      const mode = recipe === "power_cut" || recipe === "backspin" ? "cut" : "swap";
      const aligned = alignDropJoin(ta, tb, applied.bars, mode);
      dispatch({
        type: "set.setTrim",
        index: index - 1,
        inBars: prev.inBars,
        outBars: aligned.outBars,
      });
      dispatch({
        type: "set.setTrim",
        index,
        inBars: aligned.inBars,
        outBars: cur.outBars,
      });
    }
  }

  // Auto tempo ramp across the join when BPMs disagree
  if (index > 0) {
    const prev = doc.arrangement[index - 1]!;
    const cur = doc.arrangement[index]!;
    const bpmA = doc.tracks[prev.trackId]?.analysis?.bpm;
    const bpmB = doc.tracks[cur.trackId]?.analysis?.bpm;
    if (bpmA && bpmB && Math.abs(bpmB - bpmA) > 3) {
      const spans = buildTimeline({
        ...getDoc(),
        arrangement: getDoc().arrangement,
      });
      const span = spans[index];
      if (span) {
        const start = span.setStart;
        const end = Math.min(span.setStart + applied.bars, spans[index - 1]!.setEnd);
        const rel = tempoRelation(bpmA, bpmB);
        const snap = recipe === "half_bridge" && (rel === "half" || rel === "double");
        dispatch({
          type: "set.addAutomation",
          lane: {
            id: crypto.randomUUID(),
            param: "tempo",
            startBars: start,
            endBars: Math.max(end, start + (snap ? 0.25 : 0.5)),
            startValue: bpmA,
            endValue: bpmB,
            curve: snap ? "linear" : "ease_in",
          },
        });
      }
    }
  }

  const live = getDoc();
  const entry = live.arrangement[index]!;
  const prev = index > 0 ? live.arrangement[index - 1] : undefined;
  return {
    index,
    recipe,
    transition: entry.transition,
    in_bars: entry.inBars,
    out_bars: entry.outBars,
    outgoing_out_bars: prev?.outBars,
  };
}

async function planArcExec(input: Record<string, unknown>) {
  const arcs = ["journey", "peak_time", "warm_up", "cool_down", "chill", "power_block"] as const;
  const arcRaw = String(input.arc ?? "journey");
  const arc = arcs.find((a) => a === arcRaw) ?? "journey";
  const plan = planSetArc(
    getDoc(),
    arc,
    input.track_count != null ? Number(input.track_count) : undefined,
  );
  if (input.apply === true && plan.entries.length >= 2) {
    await proposeFromInput({
      entries: plan.entries.map((e) => ({
        track_id: e.track_id,
        in_bars: e.in_bars,
        out_bars: e.out_bars,
        transition: e.transition,
        bars: e.bars,
      })),
      reason: plan.reason,
    });
  }
  return { ...plan, proposed: input.apply === true && plan.entries.length >= 2 };
}

function tagTrackExec(input: Record<string, unknown>) {
  const trackId = String(input.track_id);
  if (!getDoc().tracks[trackId]) throw new Error("track not found");
  const craft: TrackCraft = {};
  if (input.role != null) craft.role = String(input.role) as TrackRole;
  if (input.energy_level != null) {
    craft.energyLevel = Math.max(1, Math.min(10, Math.round(Number(input.energy_level))));
  }
  if (input.mood != null) craft.mood = String(input.mood) as TrackMood;
  if (input.genre_hint != null) craft.genreHint = String(input.genre_hint);
  dispatch({ type: "library.setCraft", trackId, craft });
  const t = getDoc().tracks[trackId]!;
  return { trackId, craft: t.craft };
}

function prepHotcuesExec(input: Record<string, unknown>) {
  const deck = deckId(input.deck);
  if (!deck) throw new Error("invalid deck");
  const trackId = getDoc().decks[deck].trackId;
  if (!trackId) throw new Error("deck has no track");
  const track = getDoc().tracks[trackId];
  if (!track) throw new Error("track not found");
  const points = getMixPoints(track);
  const dur = track.analysis?.durationBars ?? 32;
  const pick = (role: string) =>
    points.find((p) => p.role === role && p.phraseBars < dur - 0.5)?.phraseBars;
  const clampBars = (b: number) => Math.max(0, Math.min(b, Math.max(0, dur - 0.125)));
  const drop = pick("drop") ?? pick("phrase") ?? Math.min(16, Math.max(0, dur * 0.35));
  const cues = [
    pick("mix_in") ?? 0,
    snapToPhrase(Math.max(0, drop - 16)),
    drop,
    pick("mix_out") ?? Math.max(0, dur - 8),
  ].map(clampBars);
  cues.forEach((bars, i) => {
    dispatch({ type: "deck.setHotcue", deck, pad: i + 1, bars });
  });
  return { deck, trackId, hotcues: cues };
}

function powerBlockExec() {
  const doc = getDoc();
  if (doc.arrangement.length < 2) throw new Error("need 2+ arrangement entries");
  const trims = powerBlockTrims(doc, doc.arrangement);
  for (const t of trims) {
    dispatch({
      type: "set.setTrim",
      index: t.index,
      inBars: t.inBars,
      outBars: t.outBars,
    });
    if (t.index >= 1) {
      dispatch({
        type: "set.setTransition",
        index: t.index,
        transition: "cut",
        bars: 1,
      });
    }
  }
  return { applied: true, entries: trims.length };
}

async function qualityPayload(input: Record<string, unknown>) {
  const doc = getDoc();
  const source = input.source === "proposal" ? "proposal" : "arrangement";
  const entries =
    source === "proposal" ? doc.proposal?.entries ?? [] : doc.arrangement;
  if (!entries.length) throw new Error(`no ${source} entries`);
  return { source, ...scoreArrangement(doc, entries) };
}

function timelinePayload() {
  const doc = getDoc();
  const spans = buildTimeline(doc);
  return {
    durationBars: setDurationBars(doc),
    setTempoBpm: doc.setTempoBpm,
    spans: spans.map((s) => ({
      index: s.entryIndex,
      deck: s.deck,
      trackId: s.entry.trackId,
      title: doc.tracks[s.entry.trackId]?.title,
      setStart: Number(s.setStart.toFixed(2)),
      setEnd: Number(s.setEnd.toFixed(2)),
      overlapBars: s.overlapBars,
      inBars: s.entry.inBars,
      outBars: s.entry.outBars,
      transition: s.entry.transition,
    })),
    automation: doc.automation,
    transport: useSetStore.getState().transport,
  };
}

function addAutomationFromInput(input: Record<string, unknown>) {
  const param = String(input.param) as AutomationParam;
  if (!AUTOMATION_PARAMS.includes(param)) throw new Error("invalid param");
  const startBars = Number(input.start_bars);
  const endBars = Number(input.end_bars);
  if (!Number.isFinite(startBars) || !Number.isFinite(endBars) || endBars <= startBars) {
    throw new Error("start_bars/end_bars invalid");
  }
  const curveRaw = String(input.curve ?? "linear") as AutomationCurve;
  const curve = AUTOMATION_CURVES.includes(curveRaw) ? curveRaw : "linear";
  const lane: AutomationLane = {
    id: crypto.randomUUID(),
    param,
    startBars,
    endBars,
    startValue: Number(input.start_value),
    endValue: Number(input.end_value),
    curve,
  };
  if (!Number.isFinite(lane.startValue) || !Number.isFinite(lane.endValue)) {
    throw new Error("start_value/end_value invalid");
  }
  dispatch({ type: "set.addAutomation", lane });
  return { lane, automationCount: getDoc().automation.length };
}

function parseAutomation(raw: unknown): AutomationLane[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("automation must be an array");
  return raw.map((item, i) => {
    const row = item as Record<string, unknown>;
    const param = String(row.param ?? "") as AutomationParam;
    if (!AUTOMATION_PARAMS.includes(param)) {
      throw new Error(`automation[${i}]: invalid param`);
    }
    const startBars = Number(row.start_bars ?? row.startBars);
    const endBars = Number(row.end_bars ?? row.endBars);
    const curveRaw = String(row.curve ?? "linear") as AutomationCurve;
    const curve = AUTOMATION_CURVES.includes(curveRaw) ? curveRaw : "linear";
    if (!Number.isFinite(startBars) || !Number.isFinite(endBars) || endBars <= startBars) {
      throw new Error(`automation[${i}]: bars invalid`);
    }
    return {
      id: crypto.randomUUID(),
      param,
      startBars,
      endBars,
      startValue: Number(row.start_value ?? row.startValue),
      endValue: Number(row.end_value ?? row.endValue),
      curve,
    };
  });
}

async function proposeFromInput(input: Record<string, unknown>) {
  const entries = parseEntries(input.entries);
  if (!entries.length) throw new Error("entries required");
  const automation = parseAutomation(input.automation);
  const proposal = {
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    reason: input.reason != null ? String(input.reason) : undefined,
    entries,
    automation: automation.length ? automation : undefined,
  };
  dispatch({ type: "set.setProposal", proposal });
  useSetStore.getState().setRail("set");
  return {
    proposalId: proposal.id,
    trackCount: entries.length,
    automationCount: automation.length,
    entries: entries.map((e) => ({
      trackId: e.trackId,
      inBars: e.inBars,
      outBars: e.outBars,
      transition: e.transition,
    })),
  };
}

async function fetchLyricsTool(trackId: string) {
  const track = getDoc().tracks[trackId];
  if (!track) throw new Error("track not found");
  if (!track.analysis) throw new Error("analyze track first");
  const { fetchLyricsForTrack } = await import("../lyrics/lrclib");
  const result = await fetchLyricsForTrack(track);
  dispatch({
    type: "library.setLyrics",
    trackId,
    lyrics:
      result.words.length > 0
        ? { words: result.words, explicit: result.explicit }
        : null,
  });
  return {
    trackId,
    source: result.source,
    instrumental: result.instrumental,
    wordCount: result.words.length,
    preview: result.words.slice(0, 24).map((w) => w.w).join(" "),
  };
}

function getLyricsTool(input: Record<string, unknown>) {
  const trackId = String(input.track_id);
  const track = getDoc().tracks[trackId];
  if (!track) throw new Error("track not found");
  const words = track.analysis?.lyrics?.words ?? [];
  const offset = Math.max(0, Number(input.offset ?? 0));
  const limit = Math.min(400, Math.max(1, Number(input.limit ?? 80)));
  return {
    trackId,
    total: words.length,
    explicit: track.analysis?.lyrics?.explicit ?? false,
    words: words.slice(offset, offset + limit),
  };
}

function findLyricTool(input: Record<string, unknown>) {
  const trackId = String(input.track_id);
  const track = getDoc().tracks[trackId];
  if (!track?.analysis) throw new Error("track not found or unanalyzed");
  if (!track.analysis.lyrics?.words.length) {
    throw new Error("no lyrics — call fetch_lyrics first");
  }
  const matches = findLyricMatches(
    track.analysis,
    String(input.query),
    input.limit != null ? Number(input.limit) : 12,
  );
  return { trackId, query: String(input.query), matches };
}

async function hotcueExec(input: Record<string, unknown>) {
  const deck = deckId(input.deck);
  const pad = Number(input.pad);
  const action = String(input.action);
  if (!deck) throw new Error("invalid deck");
  if (!Number.isFinite(pad) || pad < 1 || pad > 8) throw new Error("pad 1–8");
  if (action === "clear") {
    dispatch({ type: "deck.setHotcue", deck, pad, bars: null });
    return { deck, pad, action };
  }
  if (action === "set") {
    const bars =
      input.bars != null ? Number(input.bars) : getDoc().decks[deck].positionBars;
    dispatch({ type: "deck.setHotcue", deck, pad, bars });
    return { deck, pad, action, bars };
  }
  if (action === "trigger") {
    const bars = getDoc().decks[deck].hotcues[pad - 1];
    if (bars == null) throw new Error("hotcue empty");
    dispatch({ type: "deck.seek", deck, positionBars: bars });
    dispatch({ type: "deck.play", deck });
    return { deck, pad, action, bars };
  }
  throw new Error("action must be set|trigger|clear");
}

function searchTracks(input: Record<string, unknown>) {
  const query = String(input.query ?? "")
    .trim()
    .toLowerCase();
  const bpmMin = input.bpm_min != null ? Number(input.bpm_min) : null;
  const bpmMax = input.bpm_max != null ? Number(input.bpm_max) : null;
  const key = input.key != null ? String(input.key).toUpperCase() : null;

  return Object.values(getDoc().tracks)
    .filter((t) => {
      if (query) {
        const hay = `${t.title} ${t.artist}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      const bpm = t.analysis?.bpm;
      if (bpmMin != null && (bpm == null || bpm < bpmMin)) return false;
      if (bpmMax != null && (bpm == null || bpm > bpmMax)) return false;
      if (key && t.analysis?.key.camelot !== key) return false;
      return true;
    })
    .slice(0, 40)
    .map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.artist,
      bpm: t.analysis?.bpm ?? null,
      key: t.analysis?.key.camelot ?? null,
      energy: t.analysis?.energyMean ?? null,
      energyLevel: deriveEnergyLevel(t),
      role: t.craft?.role ?? t.analysis?.suggestedRole ?? null,
      genre: t.craft?.genreHint ?? t.analysis?.genreHint ?? null,
      vocalLead: Boolean(t.analysis?.vocalLead),
      keyConfidence: t.analysis?.key.confidence ?? null,
      durationBars: t.analysis?.durationBars ?? null,
      sections: t.analysis?.sections.map((s) => s.label) ?? [],
      status: t.analysisStatus,
    }));
}

export async function registerToolsWithBrowser(): Promise<boolean> {
  buildCoreTools();
  const available = isWebmcpAvailable();
  useSetStore.getState().setWebmcpAvailable(available);
  if (!available) return false;

  for (const [, controller] of registrationControllers) controller.abort();
  registrationControllers.clear();

  for (const tool of localTools.values()) {
    const controller = new AbortController();
    registrationControllers.set(tool.name, controller);
    await document.modelContext!.registerTool(
      {
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: async (input, { signal }) => {
          const result = await tool.execute(input ?? {}, { signal });
          return typeof result === "string" ? result : toolResult(result);
        },
      },
      { signal: controller.signal },
    );
  }
  return true;
}

export async function executeLocalTool(
  name: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<string> {
  if (!localTools.size) buildCoreTools();
  const tool = localTools.get(name);
  if (!tool) return toolErr(`unknown tool: ${name}`);
  return tool.localExecute(input, signal ?? new AbortController().signal);
}

export function listLocalTools() {
  if (!localTools.size) buildCoreTools();
  return [...localTools.values()].map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}
