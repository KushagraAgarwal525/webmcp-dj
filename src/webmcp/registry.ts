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
import { TRANSITION_TYPES } from "../types/setdoc";
import { defaultTransitionBars, resolveTransition } from "../set/timeline";
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
  alignEchoJoin,
  alignTeaseJoin,
  crateHealth,
  findDropBars,
  findPeakDropBars,
  inferStyle,
  isDropRecipe,
  joinCompileReport,
  planSetArc,
  powerBlockTrims,
  tempoRelation,
} from "../set/craft";
import { crateCard, crateCards, prepareSet } from "../set/prepareSet";
import { previewJoin } from "../set/previewJoin";
import { reviewBounce } from "../set/reviewSet";
import { setPerformer } from "../audio/setPerformer";
import { assertToolMapped } from "./toolUiMap";
import { findLyricMatches } from "../lyrics/lrclib";
import { audioEngine } from "../audio/engine";
import { phaseAlignBars } from "../audio/phaseAlign";
import { getPlaybookPayload, TRANSITION_RECIPES } from "../agent/djPlaybook";
import { captureToolCall } from "../analytics/tools";

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

/** Stereo render → mono for the review ear. */
function monoMix(buffer: AudioBuffer): Float32Array {
  const l = buffer.getChannelData(0);
  const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l;
  const out = new Float32Array(l.length);
  for (let i = 0; i < l.length; i++) out[i] = ((l[i] ?? 0) + (r[i] ?? 0)) * 0.5;
  return out;
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
      role: doc.tracks[e.trackId]?.craft?.role ?? null,
      mood: doc.tracks[e.trackId]?.craft?.mood ?? null,
      genre: doc.tracks[e.trackId]?.craft?.genreHint ?? null,
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
  if (!a) return { ...base, analysis: null, card: null };
  const card = crateCard(track);
  if (detail === "compact") {
    return {
      ...base,
      card,
      analysis: {
        bpm: a.bpm,
        key: a.key,
        durationBars: Number(a.durationBars.toFixed(2)),
        durationSec: Number(a.durationSec.toFixed(2)),
        energyMean: Number(a.energyMean.toFixed(3)),
        energyLevel: deriveEnergyLevel(track),
        dropBars: a.dropBars ?? null,
        heatInBars: a.heatInBars ?? null,
        brightness: a.brightness ?? null,
        mood: track.craft?.mood ?? null,
        genre: track.craft?.genreHint ?? null,
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
    card,
    analysis: {
      bpm: a.bpm,
      key: a.key,
      durationBars: Number(a.durationBars.toFixed(2)),
      durationSec: Number(a.durationSec.toFixed(2)),
      energyMean: Number(a.energyMean.toFixed(3)),
      energyLevel: deriveEnergyLevel(track),
      dropBars: a.dropBars ?? null,
      heatInBars: a.heatInBars ?? null,
      brightness: a.brightness ?? null,
      mood: track.craft?.mood ?? null,
      genre: track.craft?.genreHint ?? null,
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

/** Anything a model may legally write into a `transition` field: bare types
 *  AND recipe aliases (power_cut, bass_swap, half_bridge, power_block). */
const TRANSITION_OR_RECIPE: string[] = [
  ...TRANSITION_TYPES,
  ...TRANSITION_RECIPES,
];

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
    const tRaw = row.transition ?? row.recipe;
    const resolved = tRaw != null ? resolveTransition(tRaw) : null;
    if (tRaw != null && !resolved) {
      throw new Error(
        `entries[${i}]: transition "${String(tRaw)}" is not a type or a recipe. Types: ${TRANSITION_TYPES.join(", ")}. Recipes: ${TRANSITION_RECIPES.join(", ")} (recipes compile via apply_transition_recipe).`,
      );
    }
    const type = resolved?.type ?? "blend";
    const bars = Number(
      row.bars ?? row.transition_bars ?? defaultTransitionBars(type),
    );
    return {
      id: crypto.randomUUID(),
      trackId,
      inBars,
      outBars,
      transition: { type, bars: Number.isFinite(bars) && bars > 0 ? bars : 8 },
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
      return toolOkFull(payload);
    },
  });

  defineTool({
    name: "search_library",
    title: "Search library",
    description:
      "List/filter library tracks by title/artist, BPM range, or Camelot key (e.g. 8A). Paginated: limit (default 25, max 100) + offset; response includes total and has_more — keep paging until has_more is false instead of guessing the rest.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        bpm_min: { type: "number" },
        bpm_max: { type: "number" },
        key: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: async (input) => searchLibrary(input),
    localExecute: async (input) => toolOk(searchLibrary(input)),
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
      "The rulebook: chop formula first (INTRO→UP+→DROP→[DOWN]→DROP+→OUTRO), then what each recipe compiles, verify error codes, Camelot/BPM refs. Read it once before your first set.",
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
      "Phrase candidates: peak drop, 8/16 before that drop, vocal_end, safe_leave, breakdown, mix-in/out, grid. Prefer phraseBars. Leave on safe_leave, not mid-line.",
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
      "Craft gate — run before proposing/applying and after any rewrite. ready:true means no broken automation. Errors (must fix): double-bass on a blend, echo without FX, mid-vocal leave, key-unknown pad, overlap past the Camelot cap, |ΔBPM|>3 without a tempo lane, unknown transition type. echo_out / cut / backspin do not share a clock and do not need a tempo ramp. Warnings are observations — keep them if you meant it.",
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
      "Compile a join you chose on incoming entry (index≥1). tease_slam (the chop default) parks incoming at drop−bars so its build teases in filtered under the outgoing, rides the tempo lane across the window, then roll + throw and the slam on the 1. drop_swap parks incoming at drop−8 (the build), leaves after the vocal line, then peels. power_cut / backspin / air_cut park incoming on its drop. air_cut = suck-out, one bar of dead air, slam — no shared clock. echo_out = echo-throw leave (dry holds, delay fills, cut on the 1; incoming from its drop/heat, never bar 0, no tempo ramp). Never pad-blend two vocal leads; only half/double-time records still air-slam. The result echoes the parked trims and the compiled commit (commit_bars, commit_on_drop) — trust that echo over your own bar math.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number" },
        recipe: {
          type: "string",
          enum: [...TRANSITION_RECIPES],
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
      "START HERE before composing a set. Cards carry MEASURED facts only: bpm, bpm_lane, key+confidence (a ? means untrusted), energy, brightness, drop/heat/hole/safe_leave, vocals, cue_before_drop_8/16. mood and genre are MusicBrainz or tag_track — never DSP. Roles are craft-only. Next step: prepare_set (chop formula by default).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () =>
      toolOkFull({ ...crateHealth(getDoc()), cards: crateCards(getDoc()) }),
    localExecute: async () =>
      toolOkFull({ ...crateHealth(getDoc()), cards: crateCards(getDoc()) }),
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
    name: "prepare_set",
    title: "Prepare set",
    description:
      "Default action for 'make me a set'. Chop formula: INTRO→UP+→DROP→[DOWN]→DROP+→OUTRO. 16–32 bar heat/drop clips, sudden entries, never intros. Default join: tease_slam — the incoming build teases in filtered under the outgoing, the tempo lane rides the BPM gap, roll + throw, slam on the 1 (loop_roll / backspin / power_cut for variety and no-drop cases; no two identical slams in a row). Blend + echo only when intent is chill/deep/warm-up/smooth. The engine owns bar math — you never compute in_bars/out_bars. Options: intent; track_count; order; join_overrides; apply (default true); hear (default true). Rewrite any join with apply_transition_recipe, then verify_set.",
    inputSchema: {
      type: "object",
      properties: {
        intent: { type: "string" },
        track_count: { type: "number" },
        order: {
          type: "array",
          items: { type: "string" },
          description: "Explicit track_ids in play order; omit for auto arc",
        },
        join_overrides: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "number" },
              recipe: { type: "string", enum: [...TRANSITION_RECIPES] },
              bars: { type: "number" },
            },
            required: ["index"],
          },
        },
        hear: { type: "boolean" },
        apply: { type: "boolean" },
      },
      additionalProperties: false,
    },
    execute: async (input) => toolOkFull(await prepareSetExec(input)),
    localExecute: async (input) => {
      try {
        return toolOkFull(await prepareSetExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "prepare failed");
      }
    },
  });

  defineTool({
    name: "preview_join",
    title: "Preview join",
    description:
      "Listen-score a join (index ≥ 1) — the ear you lack. Auditions the ACTUAL overlap windows from the stored chroma (harmony.blend_ok / bass_only / clash): measured audio beats the Camelot label. echo_out is scored as a leave (incoming is not in the window). Isolator recipes are not failed for raw-file bass or a guessed key. Fails mid-vocal leave, measured-clash pad blends, and pad blends that break the cap. Returns drops/cues plus the compiled commit (commit_bars, commit_on_drop): on a drop recipe the commit must land on the incoming drop's 1, otherwise your cue math drifted.",
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
      "You are the curator of mood, genre, and role. The detector measures audio (bpm, energy, brightness, drop) but cannot know a euphoric anthem from a minor key. MusicBrainz may fill genre on import; override here (genreSource=agent). Also: role opener|builder|bridge|peak|reset|closer, energyLevel 1–10.",
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
    name: "set_cue",
    title: "Channel cue",
    description:
      "Arm channel Cue (PFL). Any armed Cue solos those channels to master (web has no separate phones out).",
    inputSchema: {
      type: "object",
      properties: {
        deck: { type: "string", enum: ["A", "B", "C", "D"] },
        enabled: { type: "boolean" },
      },
      required: ["deck", "enabled"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) throw new Error("invalid deck");
      const enabled = Boolean(input.enabled);
      dispatch({ type: "mixer.setCue", deck, enabled });
      return { deck, enabled };
    },
    localExecute: async (input) => {
      const deck = deckId(input.deck);
      if (!deck) return toolErr("invalid deck");
      const enabled = Boolean(input.enabled);
      dispatch({ type: "mixer.setCue", deck, enabled });
      return toolOk({ deck, enabled });
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
      "Insert a track into the working arrangement at index. Prefer cue parking over raw bars: cue = auto | drop | mix_in | <bars>. 'auto' parks from the join compiler (incoming N bars before its drop for swap recipes, on the drop for cuts, drop/heat for echo) and 'drop'/'mix_in' pick that cue explicitly. Raw in_bars/out_bars still work but are NOT phrase-snapped — verify_set will flag off-grid bars. transition accepts types (cut, drop_swap, …) or recipe names (power_cut, bass_swap, half_bridge, power_block). Result echoes the parked entry and, for index ≥ 1, where the compiled xfader commit lands (commit_on_drop).",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number" },
        track_id: { type: "string" },
        cue: {
          type: ["string", "number"],
          description: "auto | drop | mix_in | bars — parking handled by the compiler",
        },
        in_bars: { type: "number" },
        out_bars: { type: "number" },
        transition: { type: "string", enum: TRANSITION_OR_RECIPE },
        bars: { type: "number" },
      },
      required: ["index", "track_id"],
      additionalProperties: false,
    },
    execute: async (input) => insertTrackExec(input),
    localExecute: async (input) => {
      try {
        return toolOk(insertTrackExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "insert failed");
      }
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
    description:
      "Set in_bars/out_bars for an arrangement entry. Bars within ±1 of the 8-bar phrase grid are auto-snapped to it (a 71 becomes 72) — off-phrase commits are the #1 'beats don't match' complaint. Values further off-grid pass through untouched and verify_set will flag them.",
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
    execute: async (input) => setTrimExec(input),
    localExecute: async (input) => {
      try {
        return toolOk(setTrimExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "trim failed");
      }
    },
  });

  defineTool({
    name: "set_set_transition",
    title: "Set transition",
    description:
      "Set the join INTO the entry at index (index ≥ 1). Accepts transition types (cut, blend, drop_swap, echo_out, …) or recipe names (power_cut, bass_swap, half_bridge, power_block — resolved to their types). Prefer apply_transition_recipe for recipes: it also parks the cue bars. Result echoes the compiled commit (commit_bars on the set clock, commit_on_drop) — if commit_on_drop is false on a drop recipe, your cue math drifted from the recipe shape.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number" },
        type: { type: "string", enum: TRANSITION_OR_RECIPE },
        bars: { type: "number" },
      },
      required: ["index", "type"],
      additionalProperties: false,
    },
    execute: async (input) => setTransitionExec(input),
    localExecute: async (input) => {
      try {
        return toolOk(setTransitionExec(input));
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "transition failed");
      }
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
              transition: { type: "string", enum: TRANSITION_OR_RECIPE },
              recipe: { type: "string", enum: [...TRANSITION_RECIPES] },
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
    name: "download_set",
    title: "Download set WAV",
    description:
      "Offline-bounce the arrangement (transitions + automation) to a WAV file and download it. Same as TopBar Download. Does not use the live Rec bus.",
    inputSchema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Optional base filename without extension" },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
      const doc = getDoc();
      if (!doc.arrangement.length) throw new Error("empty arrangement");
      const { downloadSetWav } = await import("../audio/renderSet");
      const name =
        typeof input.filename === "string" && input.filename.trim()
          ? input.filename.trim()
          : doc.title;
      useSetStore.getState().setActivity("Bouncing set to WAV…");
      const result = await downloadSetWav(doc, name, (p, label) => {
        useSetStore.getState().setActivity(`${label} ${Math.round(p * 100)}%`);
      });
      useSetStore
        .getState()
        .setActivity(`Downloaded WAV · ${result.durationSec.toFixed(0)}s`);
      return {
        ok: true,
        durationSec: result.durationSec,
        bytes: result.bytes,
        sampleRate: result.sampleRate,
        format: "wav",
      };
    },
    localExecute: async (input) => {
      const doc = getDoc();
      if (!doc.arrangement.length) return toolErr("empty arrangement");
      try {
        const { downloadSetWav } = await import("../audio/renderSet");
        const name =
          typeof input.filename === "string" && input.filename.trim()
            ? input.filename.trim()
            : doc.title;
        useSetStore.getState().setActivity("Bouncing set to WAV…");
        const result = await downloadSetWav(doc, name, (p, label) => {
          useSetStore.getState().setActivity(`${label} ${Math.round(p * 100)}%`);
        });
        useSetStore
          .getState()
          .setActivity(`Downloaded WAV · ${result.durationSec.toFixed(0)}s`);
        return toolOk({
          ok: true,
          durationSec: result.durationSec,
          bytes: result.bytes,
          sampleRate: result.sampleRate,
          format: "wav",
        });
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "download failed");
      }
    },
  });

  defineTool({
    name: "review_set",
    title: "Review set (bounce + measure)",
    description:
      "Bounce the arrangement offline and MEASURE each join from the rendered audio: dead air at the commit, level jump across the 1, bass stacking during the tease, whether the tease rises, whether the slam lifts. Trust these numbers over imagination — what fails here fails in the room. Loop rolls and tempo rides render like live. Run after prepare_set / apply_transition_recipe, fix rough/broken joins, re-run. Pass index to focus one join.",
    inputSchema: {
      type: "object",
      properties: {
        index: { type: "number", description: "Optional join index (≥1) to focus" },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
      const doc = getDoc();
      if (doc.arrangement.length < 2) throw new Error("need a set (2+ entries) to review");
      const { renderSetToBuffer } = await import("../audio/renderSet");
      useSetStore.getState().setActivity("Bouncing for review…");
      const { buffer, barsToSec } = await renderSetToBuffer(doc, (p, label) => {
        useSetStore.getState().setActivity(`Review: ${label} ${Math.round(p * 100)}%`);
      });
      const mono = monoMix(buffer);
      const review = reviewBounce(doc, mono, buffer.sampleRate, barsToSec);
      const idx = input.index != null ? Number(input.index) : null;
      useSetStore
        .getState()
        .setActivity(`Review: ${review.clean} clean · ${review.rough} rough · ${review.broken} broken`);
      if (idx != null) {
        const join = review.joins.find((j) => j.index === idx);
        if (!join) throw new Error(`no join at index ${idx}`);
        return { ...review, joins: [join], focus: idx };
      }
      return review;
    },
    localExecute: async (input) => {
      const doc = getDoc();
      if (doc.arrangement.length < 2) return toolErr("need a set (2+ entries) to review");
      try {
        const { renderSetToBuffer } = await import("../audio/renderSet");
        useSetStore.getState().setActivity("Bouncing for review…");
        const { buffer, barsToSec } = await renderSetToBuffer(doc, (p, label) => {
          useSetStore.getState().setActivity(`Review: ${label} ${Math.round(p * 100)}%`);
        });
        const mono = monoMix(buffer);
        const review = reviewBounce(doc, mono, buffer.sampleRate, barsToSec);
        const idx = input.index != null ? Number(input.index) : null;
        useSetStore
          .getState()
          .setActivity(`Review: ${review.clean} clean · ${review.rough} rough · ${review.broken} broken`);
        if (idx != null) {
          const join = review.joins.find((j) => j.index === idx);
          if (!join) return toolErr(`no join at index ${idx}`);
          return toolOk({ ...review, joins: [join], focus: idx });
        }
        return toolOk(review);
      } catch (e) {
        return toolErr(e instanceof Error ? e.message : "review failed");
      }
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

  if (index > 0 && recipe === "tease_slam") {
    // Tease parking: incoming at drop−bars so the drop lands on the commit.
    const live = getDoc();
    const prev = live.arrangement[index - 1]!;
    const cur = live.arrangement[index]!;
    const ta = live.tracks[prev.trackId];
    const tb = live.tracks[cur.trackId];
    if (ta && tb) {
      const aligned = alignTeaseJoin(ta, tb, applied.bars);
      // Host the full tease plus a solo lead-in (same rule as prepare_set) —
      // a vocal wall may have collapsed the safe leave.
      const durOut = Math.max(8, ta.analysis?.durationBars ?? 32);
      const need = prev.inBars + applied.bars + 8;
      const outBars =
        aligned.outBars < need ? Math.min(durOut, Math.ceil(need / 8) * 8) : aligned.outBars;
      dispatch({
        type: "set.setTrim",
        index: index - 1,
        inBars: prev.inBars,
        outBars,
      });
      dispatch({
        type: "set.setTrim",
        index,
        inBars: aligned.inBars,
        outBars: cur.outBars,
      });
    }
  } else if (index > 0 && (isDropRecipe(recipe) || recipe === "backspin")) {
    const live = getDoc();
    const prev = live.arrangement[index - 1]!;
    const cur = live.arrangement[index]!;
    const ta = live.tracks[prev.trackId];
    const tb = live.tracks[cur.trackId];
    if (ta && tb) {
      const mode =
        recipe === "power_cut" || recipe === "backspin" || recipe === "air_cut" || recipe === "loop_roll"
          ? "cut"
          : "swap";
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
  } else if (index > 0 && (recipe === "echo_out" || recipe === "half_bridge")) {
    const live = getDoc();
    const prev = live.arrangement[index - 1]!;
    const cur = live.arrangement[index]!;
    const ta = live.tracks[prev.trackId];
    const tb = live.tracks[cur.trackId];
    if (ta && tb) {
      const aligned = alignEchoJoin(ta, tb, applied.bars);
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
    dispatch({ type: "set.setTempo", bpm: null });
    const tempoIds = getDoc()
      .automation.filter((l) => l.param === "tempo")
      .map((l) => l.id);
    for (const id of tempoIds) {
      dispatch({ type: "set.removeAutomation", id });
    }
  }

  // Slam recipes share no clock — clear any tempo lanes touching this join
  // (targeted: other joins' ramps further down the set survive).
  if (index > 0 && (recipe === "air_cut" || recipe === "backspin")) {
    const live = getDoc();
    const spans = buildTimeline(live);
    const span = spans[index];
    const prevSpan = spans[index - 1];
    if (span && prevSpan) {
      const joinStart = span.setStart;
      const joinEnd = prevSpan.setEnd + 2;
      const stale = live.automation.filter(
        (l) =>
          l.param === "tempo" && l.endBars > joinStart && l.startBars < joinEnd,
      );
      for (const lane of stale) {
        dispatch({ type: "set.removeAutomation", id: lane.id });
      }
    }
    dispatch({ type: "set.setTempo", bpm: null });
  }

  // Tempo ramp only when the join actually shares a clock.
  const sequential =
    recipe === "echo_out" ||
    recipe === "half_bridge" ||
    recipe === "power_cut" ||
    recipe === "backspin" ||
    recipe === "air_cut" ||
    applied.type === "echo_out" ||
    applied.type === "air_cut" ||
    applied.type === "cut" ||
    applied.type === "backspin";
  if (index > 0 && !sequential) {
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

  // A ride bends pitch without keylock — force it on both decks.
  if (index > 0 && (recipe === "tempo_ride" || applied.type === "tempo_ride")) {
    dispatch({ type: "deck.setOptions", deck: "A", keylock: true });
    dispatch({ type: "deck.setOptions", deck: "B", keylock: true });
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

function transitionInputError(raw: unknown): string {
  return `"${String(raw)}" is not a transition type or recipe. Types: ${TRANSITION_TYPES.join(", ")}. Recipes: ${TRANSITION_RECIPES.join(", ")}.`;
}

/** Bars within ±1 of the phrase grid snap to it — off-phrase commits are the
 *  classic "beats don't match" bug even when beat-quantize fixes the beat. */
function snapPhraseSoft(bars: number): { bars: number; snappedFrom: number | null } {
  if (!Number.isFinite(bars) || bars <= 0) return { bars, snappedFrom: null };
  const snapped = snapToPhrase(bars);
  if (snapped > 0 && snapped !== bars && Math.abs(snapped - bars) <= 1) {
    return { bars: snapped, snappedFrom: bars };
  }
  return { bars, snappedFrom: null };
}

function setTrimExec(input: Record<string, unknown>) {
  const index = Number(input.index);
  const inRaw = Number(input.in_bars);
  const outRaw = Number(input.out_bars);
  if (!Number.isFinite(inRaw) || !Number.isFinite(outRaw) || outRaw <= inRaw) {
    throw new Error("in_bars/out_bars invalid");
  }
  const inS = snapPhraseSoft(inRaw);
  const outS = snapPhraseSoft(outRaw);
  dispatch({
    type: "set.setTrim",
    index,
    inBars: inS.bars,
    outBars: Math.max(inS.bars + 1, outS.bars),
  });
  const entry = getDoc().arrangement[index] ?? null;
  const snapped: string[] = [];
  if (inS.snappedFrom != null) snapped.push(`in_bars ${inS.snappedFrom} → ${inS.bars}`);
  if (outS.snappedFrom != null) snapped.push(`out_bars ${outS.snappedFrom} → ${outS.bars}`);
  return {
    entry,
    snapped: snapped.length ? snapped : undefined,
  };
}

function setTransitionExec(input: Record<string, unknown>) {
  const index = Number(input.index);
  const resolved = resolveTransition(input.type);
  if (!resolved) throw new Error(transitionInputError(input.type));
  if (!getDoc().arrangement[index]) throw new Error("invalid index");
  dispatch({
    type: "set.setTransition",
    index,
    transition: resolved.type,
    bars: input.bars != null ? Number(input.bars) : undefined,
  });
  const live = getDoc();
  const entry = live.arrangement[index]!;
  return {
    index,
    requested: resolved.name,
    resolved_via: resolved.via,
    transition: entry.transition,
    compile: joinCompileReport(live, index),
    note:
      resolved.via === "recipe"
        ? "Recipe accepted as a type alias — apply_transition_recipe also parks cue bars; prefer it for recipes."
        : undefined,
  };
}

function insertTrackExec(input: Record<string, unknown>) {
  const index = Number(input.index);
  const trackId = String(input.track_id);
  const doc = getDoc();
  const track = doc.tracks[trackId];
  if (!track) throw new Error("track not found");
  const resolved =
    input.transition != null ? resolveTransition(input.transition) : null;
  if (input.transition != null && !resolved) {
    throw new Error(`transition ${transitionInputError(input.transition)}`);
  }
  const type: TransitionType = resolved?.type ?? "blend";
  const bars =
    input.bars != null ? Number(input.bars) : defaultTransitionBars(type);

  // Cue parking: let the compiler choose bars unless the caller insisted.
  const rawBarsGiven = input.in_bars != null || input.out_bars != null;
  let inBars: number;
  let outBars: number;
  const dur = Math.max(8, track.analysis?.durationBars ?? 32);
  const cueRaw = input.cue;
  const cue: "auto" | "drop" | "mix_in" | null =
    cueRaw === "auto" || cueRaw === "drop" || cueRaw === "mix_in" ? cueRaw : null;
  const cueBars = cueRaw != null && !cue ? Number(cueRaw) : null;

  if (rawBarsGiven || (cue == null && cueBars == null)) {
    const rawIn = input.in_bars != null ? Number(input.in_bars) : 0;
    const rawOut = input.out_bars != null ? Number(input.out_bars) : dur;
    inBars = snapPhraseSoft(rawIn).bars;
    outBars = snapPhraseSoft(rawOut).bars;
  } else {
    const prevEntry = doc.arrangement[Math.max(0, index - 1)];
    const prevTrack = prevEntry && index > 0 ? doc.tracks[prevEntry.trackId] : undefined;
    const drop = findPeakDropBars(track) ?? findDropBars(track);
    const points = getMixPoints(track);
    const mixIn =
      points.find((p) => p.role === "mix_in" && p.phraseBars > 0)?.phraseBars ?? 0;
    if (cueBars != null) {
      inBars = snapToPhrase(Math.max(0, cueBars));
    } else if (cue === "mix_in" || index === 0) {
      inBars = cue === "drop" ? (drop != null ? drop : mixIn) : mixIn;
    } else if (cue === "drop") {
      inBars =
        drop != null
          ? type === "cut" || type === "backspin"
            ? drop
            : snapToPhrase(Math.max(0, drop - bars))
          : mixIn;
    } else {
      // auto: park against the previous entry like the recipe compiler would
      if (type === "echo_out") {
        inBars = prevTrack
          ? alignEchoJoin(prevTrack, track, bars).inBars
          : drop != null
            ? drop
            : 0;
      } else if (prevTrack && type === "tease_slam") {
        inBars = alignTeaseJoin(prevTrack, track, bars).inBars;
      } else if (prevTrack && (isDropRecipe(resolved?.name ?? type) || type === "backspin")) {
        const mode = type === "cut" || type === "backspin" ? "cut" : "swap";
        inBars = alignDropJoin(prevTrack, track, bars, mode).inBars;
      } else if (drop != null) {
        inBars = snapToPhrase(Math.max(0, drop - bars));
      } else {
        inBars = mixIn;
      }
    }
    inBars = Math.max(0, Math.min(inBars, Math.max(0, dur - 8)));
    outBars = dur;
  }

  if (!Number.isFinite(inBars) || !Number.isFinite(outBars) || outBars <= inBars) {
    throw new Error("in_bars/out_bars invalid");
  }

  dispatch({
    type: "set.insert",
    index,
    trackId,
    inBars,
    outBars,
    transition: type,
    bars,
  });

  const live = getDoc();
  const entry = live.arrangement[index];
  return {
    index,
    entry,
    parked: !rawBarsGiven,
    compile: index >= 1 ? joinCompileReport(live, index) : null,
    next:
      index >= 1
        ? `preview_join index ${index} to score the join, or apply_transition_recipe index ${index} to recompile it.`
        : "insert the next track to create a join.",
  };
}

async function prepareSetExec(input: Record<string, unknown>) {
  const order =
    Array.isArray(input.order) ?
      input.order.map((id) => String(id)).filter(Boolean)
    : undefined;
  const joinOverrides = Array.isArray(input.join_overrides)
    ? input.join_overrides.map((row) => {
        const o = row as Record<string, unknown>;
        return {
          index: Number(o.index),
          recipe: o.recipe != null ? String(o.recipe) : undefined,
          bars: o.bars != null ? Number(o.bars) : undefined,
        };
      })
    : undefined;
  const prepared = await prepareSet(getDoc(), {
    intent: input.intent != null ? String(input.intent) : undefined,
    trackCount: input.track_count != null ? Number(input.track_count) : undefined,
    order,
    joinOverrides,
    hear: input.hear !== false,
  });
  const apply = input.apply !== false;
  if (prepared.arrangement.length < 2) {
    return { ...prepared.result, applied: false, proposed: false };
  }
  if (apply) {
    dispatch({ type: "set.setTempo", bpm: null });
    dispatch({ type: "set.replaceArrangement", entries: prepared.arrangement });
    dispatch({ type: "set.replaceAutomation", lanes: prepared.automation });
    if (prepared.result.joins.some((j) => j.recipe === "tempo_ride")) {
      dispatch({ type: "deck.setOptions", deck: "A", keylock: true });
      dispatch({ type: "deck.setOptions", deck: "B", keylock: true });
    }
    useSetStore.getState().setRail("set");
    return { ...prepared.result, applied: true, proposed: false };
  }
  await proposeFromInput({
    entries: prepared.arrangement.map((e) => ({
      track_id: e.trackId,
      in_bars: e.inBars,
      out_bars: e.outBars,
      transition: e.transition.type,
      bars: e.transition.bars,
    })),
    automation: prepared.automation.map((l) => ({
      param: l.param,
      start_bars: l.startBars,
      end_bars: l.endBars,
      start_value: l.startValue,
      end_value: l.endValue,
      curve: l.curve,
    })),
    reason: prepared.result.inferred.reason,
  });
  return { ...prepared.result, applied: false, proposed: true };
}

async function planArcExec(input: Record<string, unknown>) {
  const arcs = ["journey", "peak_time", "warm_up", "cool_down", "chill", "power_block"] as const;
  const arcRaw = String(input.arc ?? "journey");
  const arc = arcs.find((a) => a === arcRaw) ?? "journey";
  const plan = planSetArc(
    getDoc(),
    arc,
    input.track_count != null ? Number(input.track_count) : undefined,
    inferStyle(undefined, arc),
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
  if (input.genre_hint != null) {
    craft.genreHint = String(input.genre_hint);
    craft.genreSource = "agent";
  }
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
  const dropPts = points.filter((p) => p.role === "drop");
  const drop =
    (dropPts.length
      ? dropPts.reduce((best, p) => (p.energy > best.energy ? p : best)).phraseBars
      : pick("phrase")) ?? Math.min(16, Math.max(0, dur * 0.35));
  const cues = [
    pick("mix_in") ?? 0,
    snapToPhrase(Math.max(0, drop - 16)),
    drop,
    pick("safe_leave") ?? pick("vocal_end") ?? pick("mix_out") ?? Math.max(0, dur - 8),
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

function searchTrackRow(t: SetDoc["tracks"][string]) {
  // Compact row: drop nulls and the sections list (get_track / get_mix_points own that).
  const row: Record<string, unknown> = {
    id: t.id,
    title: t.title,
    artist: t.artist,
    bpm: t.analysis?.bpm ?? null,
    key: t.analysis?.key.camelot ?? null,
    keyTrusted:
      t.analysis?.key.confidence != null &&
      t.analysis.key.confidence >= 0.55,
    energyLevel: deriveEnergyLevel(t),
    role: t.craft?.role ?? null,
    genre: t.craft?.genreHint ?? null,
    vocalLead: Boolean(t.analysis?.vocalLead),
    durationBars:
      t.analysis?.durationBars != null
        ? Number(t.analysis.durationBars.toFixed(1))
        : null,
    status: t.analysisStatus,
  };
  for (const k of Object.keys(row)) {
    if (row[k] === null || row[k] === undefined) delete row[k];
  }
  return row;
}

function searchLibrary(input: Record<string, unknown>) {
  const query = String(input.query ?? "")
    .trim()
    .toLowerCase();
  const bpmMin = input.bpm_min != null ? Number(input.bpm_min) : null;
  const bpmMax = input.bpm_max != null ? Number(input.bpm_max) : null;
  const key = input.key != null ? String(input.key).toUpperCase() : null;
  const limit = Math.min(100, Math.max(1, Math.floor(Number(input.limit ?? 25) || 25)));
  const offset = Math.max(0, Math.floor(Number(input.offset ?? 0) || 0));

  const all = Object.values(getDoc().tracks).filter((t) => {
    if (query) {
      const hay = `${t.title} ${t.artist}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    const bpm = t.analysis?.bpm;
    if (bpmMin != null && (bpm == null || bpm < bpmMin)) return false;
    if (bpmMax != null && (bpm == null || bpm > bpmMax)) return false;
    if (key && t.analysis?.key.camelot !== key) return false;
    return true;
  });
  all.sort((a, b) => a.title.localeCompare(b.title));
  const tracks = all.slice(offset, offset + limit).map(searchTrackRow);
  return {
    tracks,
    total: all.length,
    offset,
    limit,
    has_more: offset + tracks.length < all.length,
  };
}

/**
 * Per-tool output budgets (chars). null = uncapped. Everything else defaults
 * to toolResult's 6000 — the days of every WebMCP result sliced at 1500
 * mid-JSON are over.
 */
const OUTPUT_BUDGETS: Record<string, number | null> = {
  get_dj_playbook: null,
  get_crate_health: null,
  prepare_set: null,
  plan_set_arc: null,
  preview_join: null,
  apply_transition_recipe: null,
  get_mix_points: 8000,
  get_track: 8000,
  get_set_timeline: 10000,
  get_session: 10000,
  verify_set: 8000,
  review_set: 8000,
  get_set_quality: 8000,
  suggest_compatible: 8000,
  search_library: 10000,
};

/**
 * Hardware-jockey tools stay out of the agent's face by default — 60+ flat
 * tools invite a model to push faders instead of composing. Enable with
 * ?booth=1 (or localStorage bananalabs:booth=1) when you want manual jamming
 * exposed too. They remain callable from the Agent panel either way.
 */
const BOOTH_TOOLS = new Set([
  "load_deck",
  "unload_deck",
  "deck_play",
  "deck_pause",
  "deck_seek",
  "deck_set_tempo",
  "deck_set_loop",
  "deck_set_options",
  "set_tempo_master",
  "sync_deck",
  "hotcue",
  "prep_hotcues",
  "set_gain",
  "set_eq",
  "set_filter",
  "set_fader",
  "set_crossfader",
  "set_xfader_curve",
  "deck_set_fx_send",
  "sampler_set_pad",
  "sampler_trigger",
  "sampler_set_master",
  "record_start",
  "record_stop",
  "record_clear",
]);

function boothToolsEnabled(): boolean {
  try {
    if (typeof location !== "undefined" && new URLSearchParams(location.search).has("booth")) {
      return true;
    }
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem("bananalabs:booth") === "1";
    }
  } catch {
    /* non-browser context */
  }
  return false;
}

export async function registerToolsWithBrowser(): Promise<boolean> {
  buildCoreTools();
  const available = isWebmcpAvailable();
  useSetStore.getState().setWebmcpAvailable(available);
  if (!available) return false;

  for (const [, controller] of registrationControllers) controller.abort();
  registrationControllers.clear();

  const booth = boothToolsEnabled();
  const registered: string[] = [];
  for (const tool of localTools.values()) {
    if (BOOTH_TOOLS.has(tool.name) && !booth) continue;
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
          const args = input ?? {};
          const t0 = performance.now();
          try {
            const result = await tool.execute(args, { signal });
            captureToolCall(tool.name, "webmcp", args, result, performance.now() - t0, false);
            return typeof result === "string"
              ? result
              : toolResult(result, OUTPUT_BUDGETS[tool.name]);
          } catch (e) {
            captureToolCall(tool.name, "webmcp", args, e, performance.now() - t0, true);
            throw e;
          }
        },
      },
      { signal: controller.signal },
    );
    registered.push(tool.name);
  }
  console.log(
    `[webmcp] registered ${registered.length} tools${booth ? " (booth tier on)" : " — booth tools hidden; add ?booth=1 to expose them"}`,
  );
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
  const t0 = performance.now();
  try {
    const result = await tool.localExecute(
      input,
      signal ?? new AbortController().signal,
    );
    captureToolCall(name, "local", input, result, performance.now() - t0, false);
    return result;
  } catch (e) {
    captureToolCall(name, "local", input, e, performance.now() - t0, true);
    throw e;
  }
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
