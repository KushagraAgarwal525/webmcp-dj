# BananaLabs DJ

Web-based DJ workstation with a WebMCP tool surface. Human and agent edit the same `SetDoc` through one command pipeline.

## Dev

```bash
npm install
npm run dev
```

Enable WebMCP in Chrome Canary: `chrome://flags/#enable-webmcp-testing` (or launch with `--enable-features=WebMCPTesting,DevToolsWebMCPSupport`). Agent tools are curated by default (compose/verify surface); add `?booth=1` to also expose deck/mixer/sampler hardware tools.

First draft: Set → **Prepare** (or `prepare_set`). Optional one-line intent; empty infers the night from crate cards. Play is the demo. Rewrite any join after.

Manual craft still works: `get_dj_playbook` → `get_crate_health` → `plan_set_arc` → `apply_transition_recipe` → `preview_join` → `verify_set`. Recipes compile to bass swaps, double-drops, loop-rolls, backspins — not linear washes.

## Current slice

- Dark shell (top bar, icon rail, status bar)
- Upload → OPFS + IndexedDB persistence
- Worker analysis: STFT chroma + Krumhansl–Schmuckler key, flux beatgrid, phrase-snapped sections, mid/low vocal regions, energy 1–10 + role/genre/mood
- Library: crate health, role/energy/mood tags, re-analyze stale detector rows, cues from mix points
- Set: **Prepare** first draft from crate cards, peak-first arc planner, listen-score joins, power-block trims, recipe compiler
- Two-deck playback + set performer (transitions, automations, loop-roll, backspin)
- Command pipeline + undo/redo + agent toasts
- WebMCP / local tools share the same `dispatch` path as the booth UI

## Try the loop

1. Open http://localhost:5173
2. Assets → upload several audio files
3. Wait for BPM / key / sections
4. Set → **Prepare** (intent optional)
5. Play. Rewrite a join if you want.

