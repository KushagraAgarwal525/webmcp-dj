/** Facts for tools / booth. Not a script. The DJ (human or agent) picks the join. */

export const TRANSITION_RECIPES = [
  "tease_slam",
  "drop_swap",
  "double_drop",
  "power_cut",
  "air_cut",
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
  "tempo_ride",
  "power_block",
] as const;

export type TransitionRecipe = (typeof TRANSITION_RECIPES)[number];

export const PLAYBOOK_TOPICS = ["all", "recipes", "verify", "exemplar"] as const;

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
    tease_slam: {
      type: "tease_slam",
      bars: "8–16",
      compiles:
        "The chop default — take the outgoing record INTO the incoming one. TEASE: the incoming build bleeds in under the outgoing (LP-filtered, bass killed, fader low, xfader drifting off the rail). BUILD: incoming opens, outgoing HP-rises, FX send swells, the performer stutters a 1→0.5 loop roll on the outgoing's last 2 bars, and a tempo lane rides outBPM→inBPM across the whole window when Δ>3 (authored by prepare_set/apply_transition_recipe — verify demands the lane). Over the FINAL 4 bars the outgoing stays keylocked and SoundTouch rides onto a musical interval (energy-boost lands on the incoming tonic; same-key snaps vinyl cents to semitones) so it doesn't sit 50¢ sharp against the incoming. THE 1: bass swap + xfader snap + echo throw tail ringing over the incoming drop. Parks incoming at drop−bars so the drop lands exactly on the commit; outgoing rides its drop phrase, then leaves.",
    },
    drop_swap: {
      type: "drop_swap",
      bars: "8–16",
      compiles:
        "Incoming isolated through the build; hats sneak; mids stay down while the outgoing line finishes. Bass + xfader on the incoming 1 (8 bars in when overlap is 16). Then peel outgoing over the rest. Parks incoming at drop−8, outgoing after the line plus the peel.",
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
    air_cut: {
      type: "air_cut",
      bars: "1–4",
      compiles:
        "Boom–pause–SLAM: LP suck-out on the outgoing's last bars, hard kill on the 8, one bar of dead air, incoming cold from its drop. No shared clock, no FX — the silence is the effect. Parks incoming on its drop, outgoing on its safe leave.",
    },
    build_cut: {
      type: "build_cut",
      bars: "8–16",
      compiles: "Same shape as a pictured drop plus send FX on the build.",
    },
    bass_swap: { type: "blend", bars: "8–16", compiles: "Outgoing low dies mid-overlap; incoming low opens after." },
    eq_swap: { type: "eq_swap", bars: "8–24", compiles: "Bass swap plus mid handoff." },
    filter_sweep: { type: "filter_sweep", bars: "8–24", compiles: "Outgoing filter close, incoming bass dead until the 1. No FX." },
    echo_out: { type: "echo_out", bars: "4–8", compiles: "Echo-THROW, not a fade: dry holds full while the send swells through the phrase, the last hook fills the delay, fader CUTS on the 1 and the buffer rings through the air. Incoming is not on the clock (overlap 0, 1-bar air). Parks incoming on its drop/heat at native BPM — never bar 0. No tempo ramp." },
    loop_out: { type: "loop_out", bars: "4", compiles: "Hold a loop, then cut." },
    loop_roll: { type: "loop_roll", bars: "4", compiles: "2→1→0.5 then cut." },
    backspin: {
      type: "backspin",
      bars: "1",
      compiles:
        "Outgoing stays loud, highpass + delay throw, playhead rewinds then xfader-slams to the incoming 1. No shared clock — each deck native BPM.",
    },
    hook_layer: { type: "hook_layer", bars: "8–16", compiles: "Outgoing mid stays; low/high die. EQ stand-in for an acapella." },
    half_bridge: { type: "echo_out", bars: "4–8", compiles: "Same leave as echo_out when BPM is ~2:1. No shared clock. Incoming native." },
    tempo_ride: {
      type: "tempo_ride",
      bars: "16",
      compiles:
        "For ridable BPM gaps (6–10%): both decks ramp from the outgoing BPM to the incoming BPM across a 16-bar isolator overlap — keylock stays on; the outgoing rides a musical pitch interval over the final 4 bars (energy-boost meets the incoming key; same-key snaps the vinyl cents), the incoming stays true. Commit (bass swap) on the incoming drop 8 bars in, then the outgoing peels while the ride finishes. Needs a tempo lane; verify demands it. Past 10% the ride is a stretch — slam or throw instead.",
    },
    power_block: { type: "cut", bars: "1", compiles: "1-bar cuts; pair with short trims." },
  },
} as const;

const FACTS = `BananaLabs compiles the join you pick. Default grammar is CHOP — 16–32 bar heat clips, sudden entries at build/drop, never radio intros.

SET = INTRO → UP+ → DROP → [DOWN] → DROP+ → OUTRO
Per-track parts: intro unused at peak, up 8–16 (build), drop 16–32 (the hook), down 8–16 RESET, outro unused. Default join: tease_slam — never a cold switch; loop_roll / backspin / power_cut for variety and no-drop cases. No two identical slams in a row. RESET on 4+ clips.

Chop is the default. Blend + echo only when intent is chill / deep / warm-up / smooth (or you override a join). Radio edits in this crate have no 32-bar drum intros — bar-0 + echo IS the fade. prepare_set parks every clip on drop/heat, never bar 0.

You choose: tease the next record in and slam it (tease_slam — the default), replace the drop (drop_swap), stack both drops (double_drop), blend (bass_swap / eq_swap / filter_sweep), throw and leave (echo_out), rewind slam (backspin), roll and cut (loop_roll), or hand-roll automation. The engine owns bar math.

A transition is a handoff, not a switch: the crowd should HEAR the next record arriving (filtered tease of its build), feel the pitch ride (tempo lane across the window), brace (loop roll + HP rise + FX swell), then get the drop on the 1. Cold cut / air_cut / backspin share no clock and are the exception — half/double-time records, or deliberate shock.

Far BPM: tease_slam rides ANY same-direction gap — the tempo lane ramps both decks across the tease window, and over the FINAL 4 bars the outgoing rides a musical pitch interval (not a keylock-off vinyl detune) so the scream stacks with the roll into the 1 (the incoming stays locked, the drop lands true). Only 2:1 clocks (half/double) still air-slam. Slam joins (cut / backspin / air_cut) share no clock.

Same-BPM label clashes in blend grammar can hole-park; in chop the tease is LP-filtered and bassless, so a label clash is mostly masked — on a measured clash, shorten the tease to 8. A closer lands on its drop, never from silence.

Chop grammar (the app refuses illegal leaves — still pick the 1):
- Commit only on an 8/16-bar 1.
- Default in_bars = measured drop / heat window, never 0.
- Play length 16–32 bars. Do not run the full file.
- tease_slam parks incoming at drop−bars (the build teases in; the drop lands on the commit).
- power_cut / backspin / air_cut park incoming on the drop.
- Drop-swap (blend only): cue incoming at drop−8. Do not park incoming on its drop.
- Never share a set clock on a 2:1 tempo relation.

get_mix_points includes measured drop (salience), 8/16 before that drop, vocal_end, safe_leave, breakdown, mix-in/out.
apply_transition_recipe compiles that gesture.
preview_join is an ear. Isolator recipes are not failed for raw-file bass; slam joins are not failed for far BPM; tease_slam carries its own tempo ramp.
plan_set_arc is track order + heat windows + drop cues. Joins stay unset (1-bar cut placeholder).
prepare_set writes a first playable arrangement: chop formula, heat clips, tease_slam joins. Empty intent infers the night as chop. Intent "smooth blend" / chill / warm-up switches grammar. You can still rewrite any join. The EXEMPLAR chapter (topic "exemplar") shows an approved set — match its shape.
verify_set ready:true means no broken automation. Then review_set measures the SOUND (bounce: dead air, level jumps, bass stack, tease rise, drop punch). Both clean = play. Warns are observations.

Camelot, BPM lanes, and compile strings are in refs. Do not invent numbers.

Labels: the detector measures bpm, energy, brightness, chroma, dropBars, heat window. It does not guess taste. mood and genre on cards are MusicBrainz or tag_track — never DSP. A minor key does not mean dark. A BPM bucket does not mean a genre. Do not display timbre as mood. Roles are craft-only (slots at compose time). Trust measured fields; curate the semantic ones.`;

const RECIPES = `What each recipe compiles (not when to use it):

tease_slam    THE chop default: filtered tease of the incoming build under the outgoing, tempo ride across the window, roll + HP + FX swell, slam on the 1 with an echo-throw tail
drop_swap     isolator: incoming bass/mids dead through the build, swap on the 1, peel
double_drop   both drops on the same 1
power_cut     cut on the incoming 1
air_cut       suck-out, one bar of dead air, slam the incoming drop — no shared clock
build_cut     pictured drop + send FX
bass_swap     one-bass blend
eq_swap       bass + mid handoff
filter_sweep  filter tension, snap on the 1, no FX
echo_out      echo-throw leave — dry holds, delay fills, cut on the 1, ring through the air
loop_out      hold then cut
loop_roll     incoming teases in filtered, 2→1→0.5 roll, then cut
backspin      rewind (loud, delay throw) then xfader slam — native BPM each side
hook_layer    outgoing mid over a new bed
half_bridge   echo-shaped exit + tempo to half/double
tempo_ride    6–10% BPM gap: ramp both decks, outgoing rides a musical pitch interval for the final 4 bars, commit on the drop, peel
power_block   1-bar cuts

Cue math you apply yourself (or let apply_transition_recipe park it):
incoming drop D → in_bars = D − 8 (the build, even when overlap is 16)
tease_slam → in_bars = D − bars (the tease IS the build; the drop lands on the commit)
outgoing leave = safe_leave + peel (peel = overlap − 8)
power_cut / backspin / air_cut → in_bars = D
tempo_ride parks like drop_swap (in = D − 8) and adds the tempo lane itself`;

const VERIFY = `verify_set errors (broken mix — fix the automation):
- double_bass on a blend-class join with no bass kill
- echo_out / build_cut with no FX arm
- |ΔBPM|>3 and no tempo lane on a shared-clock join (not echo_out / air_cut / cut / backspin — those slams share no clock; tempo_ride AND tease_slam REQUIRE the lane — prepare_set / apply_transition_recipe author it)
- tempo_ride on a ≤3% gap (drop_swap covers that) — warns
- mid_vocal_leave (xfader commit inside a vocal region)
- key_unknown_pad (confidence < 0.55 on an 8+ bar pad blend — not an isolator drop-swap)
- key_overlap_too_long / key_clash on a pad longer than the Camelot cap
- unknown_transition (a recipe name stored as a type — re-apply via apply_transition_recipe)
- transition_too_long past the engine cap
- too_short (need 2+ tracks)

Slam joins (cut / backspin / air_cut) are exempt from key caps and ΔBPM ramps by design; tease_slam is exempt from raw-window clash caps (the tease is filtered/bassless) but never from the ramp. warns are observations (phrase, both-sides vocals, energy shape). Keep them if you meant it.

review_set is the SOUND check: it bounces the set offline and measures every join from the rendered audio — dead air at the commit, |level jump| > 6dB across the 1, a tease whose mids fall, double bass during the tease, a slam that doesn't lift. verify_set checks the doc; review_set checks what the room hears. ready:true + review clean = play it. Rough/broken → fix the join (recipe, bars, trims, gain) and re-run.`;

const EXEMPLAR = `APPROVED EXEMPLAR — a 4-track peak-time chop set the human signed off on by ear. Copy this SHAPE:

Midnight City [64→96] ═tease_slam 16 (tempo rides 107.7→129.2)═▶ In the Moment [96→128] ═tease_slam 16═▶ Shakedown [32→64] ═tease_slam 16═▶ The Nights [24→56]

Why it works:
- Every clip is 32 bars parked on the drop/heat — never bar 0, never a radio intro, never a full file.
- Every join is a 16-bar tease_slam: the incoming BUILD bleeds in filtered under the outgoing's drop, the room hears the next record arriving, and the incoming drop lands exactly on the commit (commit_on_drop: true on all three).
- The far-BPM boundary (107.7→129.2, +20%) rides a tempo lane across the tease window — the pitch ride IS the transition — instead of a cold air cut.
- review_set measured the bounce: joins 2–3 clean; join 1 rough (+8.5dB — the incoming record was simply hotter. Fix next time: gain-stage the incoming channel down ~3dB before the slam).
- 80 bars ≈ 2:38. No dead air, no mixing-for-mixing's-sake, every second is a record playing or a drop being teased.

Anti-pattern (what "sucks" sounds like): four cold switches with zero overlap — the crowd never hears the next record coming, so every change reads as random. If your joins have overlapBars 0–2, you are switching, not mixing.`;

const CHAPTERS: Record<Exclude<PlaybookTopic, "all">, string> = {
  recipes: RECIPES,
  verify: VERIFY,
  exemplar: EXEMPLAR,
};

export const DJ_PLAYBOOK = `${FACTS}

═══════════════════════════════════════
${RECIPES}

═══════════════════════════════════════
${VERIFY}

═══════════════════════════════════════
${EXEMPLAR}
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
