/** Maps every WebMCP tool to a human booth surface. Keep in sync with registry. */
export type ToolUiSurface =
  | "deck"
  | "mixer"
  | "set"
  | "library"
  | "transport"
  | "fx"
  | "sampler"
  | "record"
  | "debug-only";

export const TOOL_UI_MAP: Record<string, ToolUiSurface> = {
  get_session: "debug-only",
  get_track: "library",
  search_library: "library",
  suggest_compatible: "debug-only",
  get_set_quality: "set",
  get_dj_playbook: "set",
  get_mix_points: "library",
  verify_set: "set",
  apply_transition_recipe: "set",
  get_crate_health: "library",
  plan_set_arc: "set",
  prepare_set: "set",
  preview_join: "set",
  tag_track: "library",
  prep_hotcues: "deck",
  apply_power_block: "set",
  analyze_track: "library",
  fetch_lyrics: "library",
  get_lyrics: "library",
  find_lyric: "library",
  load_deck: "library",
  unload_deck: "deck",
  deck_play: "deck",
  deck_pause: "deck",
  deck_seek: "deck",
  deck_set_tempo: "deck",
  deck_set_loop: "deck",
  deck_set_options: "deck",
  set_tempo_master: "deck",
  sync_deck: "deck",
  hotcue: "deck",
  set_gain: "mixer",
  set_eq: "mixer",
  set_filter: "mixer",
  set_fader: "mixer",
  set_cue: "mixer",
  set_crossfader: "mixer",
  set_xfader_curve: "mixer",
  set_insert_track: "set",
  set_remove_track: "set",
  set_move_track: "set",
  set_set_trim: "set",
  set_set_transition: "set",
  set_clear: "set",
  set_propose: "debug-only",
  set_apply_proposal: "set",
  set_reject_proposal: "set",
  get_set_timeline: "set",
  set_set_tempo: "set",
  set_add_automation: "set",
  set_remove_automation: "set",
  set_clear_automation: "set",
  set_play: "transport",
  set_pause: "transport",
  set_seek: "transport",
  history: "transport",
  fx_set: "fx",
  deck_set_fx_send: "fx",
  sampler_set_pad: "sampler",
  sampler_trigger: "sampler",
  sampler_set_master: "sampler",
  record_start: "record",
  record_stop: "record",
  record_clear: "record",
  download_set: "transport",
};

export function assertToolMapped(name: string) {
  if (!(name in TOOL_UI_MAP)) {
    console.warn(`[toolUiMap] unmapped tool: ${name}`);
  }
}
