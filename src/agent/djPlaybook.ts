/** Facts for tools / booth. Not a script. The DJ (human or agent) picks the join. */

export const TRANSITION_RECIPES = [
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

export type TransitionRecipe = (typeof TRANSITION_RECIPES)[number];

export const PLAYBOOK_TOPICS = ["all", "recipes", "verify"] as const;

export type PlaybookTopic = (typeof PLAYBOOK_TOPICS)[number];

export const DJ_PLAYBOOK_REFS = {
  camelot: {
    letter: { A: "minor / darker / moodier", B: "major / brighter / lift" },
    wheelToPitch: {
      "1A": "Abm",
      "1B": "B",
      "2A": "Ebm",
      "2B": "Gb",
      "3A": "Bbm",
      "3B": "Db",
      "4A": "Fm",
      "4B": "Ab",
      "5A": "Cm",
      "5B": "Eb",
      "6A": "Gm",
      "6B": "Bb",
      "7A": "Dm",
      "7B": "F",
      "8A": "Am",
      "8B": "C",
      "9A": "Em",
      "9B": "G",
      "10A": "Bm",
      "10B": "D",
      "11A": "F#m",
      "11B": "A",
      "12A": "C#m",
      "12B": "E",
    },
    fromAny: {
      same: "8A→8A",
      adjacent: "8A→7A/9A",
      relative: "8A→8B",
      energy_boost: "8A→10A",
      diagonal: "8A→7B/9B",
      jaws: "8A→3A",
      pay_attention: "8A→5A",
      clash: "else",
    },
  },
  bpmByGenre: {
    "hip-hop": "85–115",
    amapiano: "110–120",
    "deep house": "118–125",
    house: "120–130",
    "tech house": "122–130",
    "progressive house": "124–132",
    disco: "110–124",
    trance: "132–140",
    techno: "130–150",
    "uk garage": "128–138",
    dubstep: "140 felt ~70",
    "hard techno": "145–160",
    "drum and bass": "168–180",
  },
  halfDouble: [
    "87 hip-hop ↔ 174 drum and bass",
    "70 trap feel ↔ 140 dubstep",
    "64 downtempo ↔ 128 house",
  ],
  recipes: {
    drop_swap: {
      type: "drop_swap",
      bars: "8–16",
      compiles:
        "Incoming isolated; mids/highs sneak; outgoing low dies on the 1; xfader commits. No send FX. Parks incoming at drop−N, outgoing leave on its drop.",
    },
    double_drop: {
      type: "double_drop",
      bars: "16",
      compiles: "Both full at a shared 1 (~45% through the overlap), then pull outgoing.",
    },
    power_cut: {
      type: "cut",
      bars: "1",
      compiles: "Xfader cut on the 1. Parks incoming on its drop.",
    },
    build_cut: {
      type: "build_cut",
      bars: "8–16",
      compiles: "Same shape as a pictured drop plus send FX on the build.",
    },
    bass_swap: { type: "blend", bars: "8–16", compiles: "Outgoing low dies mid-overlap; incoming low opens after." },
    eq_swap: { type: "eq_swap", bars: "8–24", compiles: "Bass swap plus mid handoff." },
    filter_sweep: { type: "filter_sweep", bars: "8–24", compiles: "Outgoing filter close, incoming bass dead until the 1. No FX." },
    echo_out: { type: "echo_out", bars: "4–8", compiles: "Send/FX tail, outgoing fader out. A hole you meant." },
    loop_out: { type: "loop_out", bars: "4", compiles: "Hold a loop, then cut." },
    loop_roll: { type: "loop_roll", bars: "4", compiles: "2→1→0.5 then cut." },
    backspin: { type: "backspin", bars: "1", compiles: "Rewind outgoing, snap to incoming 1." },
    hook_layer: { type: "hook_layer", bars: "8–16", compiles: "Outgoing mid stays; low/high die. EQ stand-in for an acapella." },
    half_bridge: { type: "echo_out", bars: "4–8", compiles: "Echo-shaped exit plus tempo snap when BPM ratio is ~2:1." },
    power_block: { type: "cut", bars: "1", compiles: "1-bar cuts; pair with short trims." },
  },
} as const;

const FACTS = `BananaLabs compiles the join you pick. It does not pick the join.

You choose: replace the drop (drop_swap / power_cut), stack both drops (double_drop), blend (bass_swap / eq_swap / filter_sweep), FX hole (echo_out), or hand-roll automation.

get_mix_points includes drop, 8/16 bars before drop, breakdown, mix-in/out.
apply_transition_recipe compiles that gesture. Drop recipes also park incoming in_bars at drop−N and outgoing out_bars on the outgoing drop.
preview_join is an ear (bass / mid / vocal / key / tempo / drop positions). It does not pick a recipe.
plan_set_arc is track order + windows + drop cues. Joins stay unset (1-bar cut placeholder).
verify_set ready:true means no broken automation. Warns are observations.

Camelot, BPM lanes, and compile strings are in refs. Do not invent numbers.`;

const RECIPES = `What each recipe compiles (not when to use it):

drop_swap     isolator swap on the 1 — incoming bass dead through the shared phrase
double_drop   both drops on the same 1
power_cut     cut on the incoming 1
build_cut     pictured drop + send FX
bass_swap     one-bass blend
eq_swap       bass + mid handoff
filter_sweep  filter tension, snap on the 1, no FX
echo_out      send tail / hole
loop_out      hold then cut
loop_roll     2→1→0.5 then cut
backspin      rewind then snap
hook_layer    outgoing mid over a new bed
half_bridge   echo-shaped exit + tempo to half/double
power_block   1-bar cuts

Cue math you apply yourself (or let apply_transition_recipe park it):
incoming drop D, overlap N → in_bars = D − N
outgoing drop E → out_bars = E
power_cut / backspin → in_bars = D`;

const VERIFY = `verify_set errors (broken mix — fix the automation):
- double_bass on a blend-class join with no bass kill
- echo_out / build_cut with no FX arm
- |ΔBPM|>3 and no tempo lane
- transition_too_long past the engine cap
- too_short (need 2+ tracks)

warns are observations (phrase, vocals, energy shape, key on a long pad blend). Keep them if you meant it.`;

const CHAPTERS: Record<Exclude<PlaybookTopic, "all">, string> = {
  recipes: RECIPES,
  verify: VERIFY,
};

export const DJ_PLAYBOOK = `${FACTS}

═══════════════════════════════════════
${RECIPES}

═══════════════════════════════════════
${VERIFY}
`;

export function getPlaybookPayload(topicRaw?: unknown) {
  const raw = String(topicRaw ?? "all").toLowerCase();
  const topic = (PLAYBOOK_TOPICS as readonly string[]).includes(raw)
    ? (raw as PlaybookTopic)
    : "all";

  const playbook =
    topic === "all" ? DJ_PLAYBOOK : `${FACTS}\n\n${CHAPTERS[topic]}`;

  return {
    topic,
    playbook,
    recipes: [...TRANSITION_RECIPES],
    refs: DJ_PLAYBOOK_REFS,
  };
}
