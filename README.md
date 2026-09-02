# BananaLabs DJ

**A web DJ workstation where an AI agent composes and performs real DJ sets — through the same controls a human would use.**

**[Live app](https://bananalabs-sable.vercel.app/)** · Built for the **[WebMCP Challenge](https://webmcp.devpost.com/)** · MIT licensed

Upload a few tracks and BananaLabs measures them (BPM, key, drop points, energy, harmony), composes a set — club-style `tease_slam` transitions that tease the next record in, ride the pitch, and slam the drop on the 1 — then *performs* it live in the browser on two decks, a mixer, and an FX bus. Every tool the agent uses is a WebMCP tool; every tool mutates the same document the human UI edits.

---

## What it does

- **Analyzes your crate** in a worker: STFT chroma + EDM-profile key detection, flux beatgrid with downbeats, salience-based drop detection, heat windows, vocal regions, energy levels.
- **Composes a set** from one line of intent ("peak-time festival chop") or none at all: track order is solved as a mixability path (Held–Karp DP over real join costs), clips park on drops/heat (never radio intros), and each join picks a transition recipe.
- **Performs it live**: two tempo-matched decks, 3-band EQ + filter, crossfader, delay/reverb throw bus, loop rolls, backspins, and tempo rides with a dosed pitch scream (the outgoing deck unlocks keylock for the final 4 bars of a ride).
- **Reviews its own work**: `review_set` bounces the set offline and *measures* each join from the rendered audio — dead air, level jumps, bass stacking, tease rise, drop punch — so the agent fixes what it can't hear.
- **Bounces to WAV** with full transition automation, loop rolls, and backspin rewinds rendered in.

## How it uses WebMCP

BananaLabs registers **66 tools** on the page's `document.modelContext` (WebMCP). An agent — browser-native or an external model driving CDP — calls them to compose, audition, verify, and perform. The same tools are also exposed through a local bridge (`window.__bananalabs.callTool`) used by the in-app Agent panel, and both paths funnel into one command pipeline, so the human at the booth and the agent never fork the document.

Two tiers keep the agent focused:

- **Compose surface (default)** — `prepare_set`, `plan_set_arc`, `preview_join`, `apply_transition_recipe`, `verify_set`, `review_set`, `search_library`, `tag_track`, `get_dj_playbook`, transport. Big levers, honest echoes (every mutation returns a compile report: where the commit lands, whether it's on the drop).
- **Booth hardware (`?booth=1`)** — `deck_set_loop`, `hotcue`, `set_eq`, `set_filter`, `set_fader`, `sampler_trigger`, `fx_set`… everything the human UI can do, for when you want the agent to *play*, not just compose.

To let a browser agent discover the tools, use Codex in-built browser or run Chrome Canary with WebMCP enabled:

```
chrome://flags/#enable-webmcp-testing
# or launch with:
--enable-features=WebMCPTesting,DevToolsWebMCPSupport
```

## Architecture

One document, one pipeline, two performers (human + agent):

```
Assets → OPFS blobs + IndexedDB (Dexie)
       → analysis worker (chroma/key/beatgrid/drop/heat/vocal/energy)
       → SetDoc (tracks, crates, arrangement, automation lanes)
       → command pipeline (dispatch → applyCommand → store, undo/redo)
       → WebMCP tools ────────────────▲ human UI (same dispatch)
       → set compiler (recipes → automation lanes, verify gates)
       → SetPerformer (set clock, rate matching, loop watch, backspin, ride keylock)
       → AudioEngine (Web Audio, SoundTouch keylock worklet, EQ/filter, FX bus, sampler)
       → renderSet (OfflineAudioContext bounce → WAV) → reviewSet (measure the bounce)
```

| Path | Role |
| --- | --- |
| `src/types/setdoc.ts` | The `SetDoc` — tracks, crates, arrangement, automation, decks, mixer, FX |
| `src/commands/` | Command pipeline shared by UI, local bridge, and WebMCP tools |
| `src/analysis/` | Analysis worker — chroma, key (EDM profiles), beatgrid, salience drop pick, vocal regions |
| `src/set/` | Composer: `prepareSet`, arc planner (path DP), `timeline` recipe compiler, `builder` (verify), `previewJoin` (pre-ear), `reviewSet` (bounce ear) |
| `src/audio/` | `engine` (decks/mixer/FX/sampler), `setPerformer` (plays the set), `renderSet` (offline WAV) |
| `src/webmcp/` | Tool registry, per-tool output budgets, UI surface mapping |
| `scripts/` | `prepare-smoke` (compose suite), `analysis-smoke` (detector), `eval-compose` (Canary CDP harness: upload → compose → bounce → scorecard) |

## Layout

- **Top bar** — BananaLabs mark, set transport, master BPM, record, Download (WAV bounce).
- **Icon rail** — **Assets** (library: upload, crate health, mix points, re-analyze), **Set** (arrangement editor), **Agent** (chat driving the same tools).
- **Workspace** — deck A / deck B with jog wheels, tempo, hotcues and loops; a mixer strip (3-band EQ, filter, channel faders, crossfader); FX and sampler pads; then the **set ruler** — the timeline of clips, joins, and automation lanes.
- **Status bar** — activity feed (what the agent/engine is doing) and WebMCP state.
- **Keys** — `Space` play/pause the set · `←`/`→` seek (Shift = 4 bars) · `1–8` sampler pads · `Esc` close drawers.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
```

Open in Chrome Canary with WebMCP enabled (above) to let an agent drive. Without WebMCP the workstation is fully usable by hand — the Agent panel's local bridge also works without it.

Useful variations:

```bash
npm run dev                 # workstation
# http://localhost:5173/?booth=1   ← also expose hardware tools to agents
npm run prepare:smoke       # compose pipeline suite (no browser)
npm run analysis:smoke      # detector suite
npm run build               # typecheck + production build
EVAL_FILES="a.mp3,b.mp3" npx tsx scripts/eval-compose.mts   # full CDP eval + scorecard
```

## License

[MIT](LICENSE) — © 2026 Kushagra Agarwal.
