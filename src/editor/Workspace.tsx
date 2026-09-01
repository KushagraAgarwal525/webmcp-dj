import "./Workspace.css";
import { useEffect, useMemo, type CSSProperties } from "react";
import { useSetStore } from "../commands/pipeline";
import type { DeckId, Track } from "../types/setdoc";
import { audioEngine } from "../audio/engine";
import { ProposalBanner } from "./ProposalBanner";
import { BoothExtras } from "./BoothExtras";
import { MixerStrip } from "./MixerStrip";
import { JogWheel } from "./controls/JogWheel";
import { HardwareButton } from "./controls/HardwareButton";
import { VerticalFader } from "./controls/VerticalFader";
import { formatCamelot } from "../set/builder";
import { fetchLyricsForTrack } from "../lyrics/lrclib";
import { executeLocalTool } from "../webmcp/registry";
import { SetRuler } from "./SetRuler";

async function fetchDeckLyrics(trackId: string) {
  const track = useSetStore.getState().doc.tracks[trackId];
  if (!track?.analysis) {
    useSetStore.getState().setActivity("Analyze track before lyrics");
    return;
  }
  useSetStore.getState().setActivity("Fetching lyrics…");
  try {
    const result = await fetchLyricsForTrack(track);
    useSetStore.getState().dispatch({
      type: "library.setLyrics",
      trackId,
      lyrics:
        result.words.length > 0
          ? { words: result.words, explicit: result.explicit }
          : null,
    });
    useSetStore
      .getState()
      .setActivity(
        result.instrumental
          ? "Instrumental — no lyrics"
          : result.words.length
            ? `Lyrics: ${result.words.length} words (${result.source})`
            : "No lyrics found",
      );
  } catch (e) {
    useSetStore
      .getState()
      .setActivity(e instanceof Error ? e.message : "Lyrics fetch failed");
  }
}

function lyricWindow(track: Track, playheadBars: number): string {
  const words = track.analysis?.lyrics?.words;
  if (!words?.length) return "—";
  const bpm = track.analysis?.bpm ?? 120;
  const barSec = (60 / bpm) * 4;
  const t = playheadBars * barSec;
  let i = 0;
  for (; i < words.length; i++) {
    if (words[i]!.t > t) break;
  }
  const start = Math.max(0, i - 2);
  const slice = words.slice(start, start + 8);
  return slice
    .map((w, idx) => (start + idx === i - 1 ? `«${w.w}»` : w.w))
    .join(" ");
}

function useDeckPlayhead(deck: "A" | "B") {
  return useSetStore((s) => {
    const d = s.doc.decks[deck];
    return s.transport.setPlaying || d.playing
      ? (s.transport.deckPlayheads[deck] ?? d.positionBars)
      : d.positionBars;
  });
}

function currentPlayhead(deck: "A" | "B"): number {
  const s = useSetStore.getState();
  const d = s.doc.decks[deck];
  return s.transport.setPlaying || d.playing
    ? (s.transport.deckPlayheads[deck] ?? d.positionBars)
    : d.positionBars;
}

function useLooseDeckPlayheads() {
  const setPlaying = useSetStore((s) => s.transport.setPlaying);
  const playingA = useSetStore((s) => s.doc.decks.A.playing);
  const playingB = useSetStore((s) => s.doc.decks.B.playing);

  useEffect(() => {
    if (setPlaying || (!playingA && !playingB)) return;
    let raf = 0;
    const tick = () => {
      const heads: Partial<Record<DeckId, number>> = {};
      if (useSetStore.getState().doc.decks.A.playing) {
        heads.A = audioEngine.getPositionBars("A");
      }
      if (useSetStore.getState().doc.decks.B.playing) {
        heads.B = audioEngine.getPositionBars("B");
      }
      useSetStore.getState().setTransport({
        deckPlayheads: heads as Record<DeckId, number>,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setPlaying, playingA, playingB]);
}

function WaveformView({
  peaks,
  playheadFrac,
  loopStartFrac,
  loopEndFrac,
  hotcueFracs,
  onSeekFrac,
}: {
  peaks?: number[];
  playheadFrac?: number;
  loopStartFrac?: number | null;
  loopEndFrac?: number | null;
  hotcueFracs?: (number | null)[];
  onSeekFrac?: (frac: number) => void;
}) {
  const w = 400;
  const h = 56;
  // Static layer (peaks/loop/cues) — rebuild only when those inputs change, not every playhead tick.
  const staticSvg = useMemo(() => {
    if (!peaks?.length) return null;
    const step = w / peaks.length;
    const mid = h / 2;
    const bars = peaks.map((p, i) => {
      const bh = Math.max(1, p * (h - 4));
      return `<rect x="${i * step}" y="${mid - bh / 2}" width="${Math.max(1, step * 0.85)}" height="${bh}" fill="#ffd60a" opacity="0.9"/>`;
    });
    let loop = "";
    if (
      loopStartFrac != null &&
      loopEndFrac != null &&
      loopEndFrac > loopStartFrac
    ) {
      loop = `<rect x="${loopStartFrac * w}" y="0" width="${(loopEndFrac - loopStartFrac) * w}" height="${h}" fill="#4fc3f7" opacity="0.2"/>`;
    }
    const cues = (hotcueFracs ?? [])
      .map((f, i) =>
        f != null && f >= 0 && f <= 1
          ? `<line x1="${f * w}" y1="0" x2="${f * w}" y2="${h}" stroke="#fff" stroke-width="1.5" opacity="0.7"/><text x="${f * w + 2}" y="10" fill="#fff" font-size="8" font-family="monospace">${i + 1}</text>`
          : "",
      )
      .join("");
    return `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${loop}${bars.join("")}${cues}</svg>`;
  }, [peaks, loopStartFrac, loopEndFrac, hotcueFracs]);

  if (!staticSvg) {
    return <div className="cdj-wave empty" aria-hidden />;
  }

  const phPct =
    playheadFrac != null && playheadFrac >= 0 && playheadFrac <= 1
      ? playheadFrac * 100
      : null;

  return (
    <div
      className="cdj-wave"
      role={onSeekFrac ? "slider" : undefined}
      tabIndex={onSeekFrac ? 0 : undefined}
      onClick={
        onSeekFrac
          ? (e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onSeekFrac(
                Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
              );
            }
          : undefined
      }
    >
      <div
        className="cdj-wave-static"
        dangerouslySetInnerHTML={{ __html: staticSvg }}
      />
      {phPct != null && (
        <div
          className="cdj-wave-playhead"
          style={{ left: `${phPct}%` } as CSSProperties}
        />
      )}
    </div>
  );
}

function DeckBars({ deck }: { deck: "A" | "B" }) {
  const bars = useDeckPlayhead(deck);
  return <span className="cdj-bars">{bars.toFixed(1)}b</span>;
}

function DeckWaveform({
  deck,
  peaks,
  durationBars,
  loopStartFrac,
  loopEndFrac,
  hotcueFracs,
  canSeek,
}: {
  deck: "A" | "B";
  peaks?: number[];
  durationBars: number;
  loopStartFrac: number | null;
  loopEndFrac: number | null;
  hotcueFracs: (number | null)[];
  canSeek: boolean;
}) {
  const playheadBars = useDeckPlayhead(deck);
  const playheadFrac = durationBars > 0 ? playheadBars / durationBars : 0;
  return (
    <WaveformView
      peaks={peaks}
      playheadFrac={playheadFrac}
      loopStartFrac={loopStartFrac}
      loopEndFrac={loopEndFrac}
      hotcueFracs={hotcueFracs}
      onSeekFrac={
        canSeek
          ? (frac) => {
              const bars = frac * durationBars;
              useSetStore.getState().dispatch({
                type: "deck.seek",
                deck,
                positionBars: bars,
              });
              useSetStore.getState().setTransport({
                deckPlayheads: {
                  ...useSetStore.getState().transport.deckPlayheads,
                  [deck]: bars,
                },
              });
            }
          : undefined
      }
    />
  );
}

function DeckLyricsLine({ deck, track }: { deck: "A" | "B"; track: Track }) {
  const playheadBars = useDeckPlayhead(deck);
  const slot = Math.floor(playheadBars * 4);
  const text = useMemo(
    () => lyricWindow(track, slot / 4),
    [track, slot],
  );
  return (
    <div className="cdj-lyrics">
      <HardwareButton onClick={() => void fetchDeckLyrics(track.id)}>
        Lrc
      </HardwareButton>
      <span className="mono">{text}</span>
    </div>
  );
}

function DeckJog({
  deck,
  bpm,
  playing,
  empty,
  title,
}: {
  deck: "A" | "B";
  bpm: number | null;
  playing: boolean;
  empty: boolean;
  title?: string;
}) {
  const playheadBars = useDeckPlayhead(deck);
  return (
    <JogWheel
      deck={deck}
      bpm={bpm}
      playing={playing}
      playheadBars={playheadBars}
      empty={empty}
      title={title}
    />
  );
}

function CdjDeck({ deck }: { deck: "A" | "B" }) {
  const state = useSetStore((s) => s.doc.decks[deck]);
  const trackId = state.trackId;
  const track = useSetStore((s) =>
    trackId ? s.doc.tracks[trackId] : undefined,
  );
  const dispatch = useSetStore((s) => s.dispatch);
  const setPlaying = useSetStore((s) => s.transport.setPlaying);
  const tempoMaster = useSetStore((s) => s.doc.tempoMaster);

  const peaks = track?.analysis?.waveform.peaks;
  const durationBars = track?.analysis?.durationBars ?? 1;
  const loopStartFrac =
    state.loopInBars != null && durationBars > 0
      ? state.loopInBars / durationBars
      : null;
  const loopEndFrac =
    state.loopInBars != null && state.loopBars != null && durationBars > 0
      ? (state.loopInBars + state.loopBars) / durationBars
      : null;
  const hotcueFracs = state.hotcues.map((hc) =>
    hc != null && durationBars > 0 ? hc / durationBars : null,
  );
  const nativeBpm = track?.analysis?.bpm ?? state.bpm ?? 120;
  const deckBpm = state.bpm ?? nativeBpm;

  return (
    <section className={`cdj-deck deck-${deck.toLowerCase()}`}>
      <header className="cdj-info">
        <div className="cdj-title-block">
          <span className="cdj-deck-tag">{deck}</span>
          <strong>{track?.title ?? "No track loaded"}</strong>
          <span className="cdj-meta">
            {track
              ? `${track.artist || "Unknown"}${track.analysis ? ` · ${formatCamelot(track.analysis.key)}` : ""}`
              : "Load from Assets"}
          </span>
        </div>
        <div className="cdj-readout mono">
          <span className="cdj-bpm-big">
            {state.bpm != null ? state.bpm.toFixed(1) : "—.—"}
          </span>
          <DeckBars deck={deck} />
          <span className="cdj-leds">
            <i className={state.keylock ? "on" : ""}>KL</i>
            <i className={state.quantize ? "on" : ""}>Q</i>
            <i className={tempoMaster === deck ? "on" : ""}>MST</i>
          </span>
        </div>
      </header>

      <DeckWaveform
        deck={deck}
        peaks={peaks}
        durationBars={durationBars}
        loopStartFrac={loopStartFrac}
        loopEndFrac={loopEndFrac}
        hotcueFracs={hotcueFracs}
        canSeek={Boolean(track) && !setPlaying}
      />

      {track && <DeckLyricsLine deck={deck} track={track} />}

      <div className="cdj-platter-row">
        <DeckJog
          deck={deck}
          bpm={state.bpm}
          playing={state.playing}
          empty={!track}
          title={track?.analysis ? formatCamelot(track.analysis.key) : undefined}
        />
        <VerticalFader
          label="Tempo"
          value={deckBpm}
          min={nativeBpm * 0.84}
          max={nativeBpm * 1.16}
          step={0.1}
          length={160}
          disabled={!track}
          onChange={(bpm) => dispatch({ type: "deck.setTempo", deck, bpm })}
        />
      </div>

      <div className="cdj-transport">
        <HardwareButton
          led={state.playing}
          disabled={!track || setPlaying}
          onClick={async () => {
            await audioEngine.unlock();
            dispatch({
              type: state.playing ? "deck.pause" : "deck.play",
              deck,
            });
          }}
        >
          {state.playing ? "Pause" : "Play"}
        </HardwareButton>
        <HardwareButton
          disabled={!track || setPlaying}
          onClick={() => dispatch({ type: "deck.seek", deck, positionBars: 0 })}
        >
          Cue
        </HardwareButton>
        <HardwareButton
          led={state.keylock}
          disabled={!track}
          onClick={() =>
            dispatch({
              type: "deck.setOptions",
              deck,
              keylock: !state.keylock,
            })
          }
        >
          Key
        </HardwareButton>
        <HardwareButton
          led={state.quantize}
          disabled={!track}
          onClick={() =>
            dispatch({
              type: "deck.setOptions",
              deck,
              quantize: !state.quantize,
            })
          }
        >
          Q
        </HardwareButton>
        <HardwareButton
          led={tempoMaster === deck}
          disabled={!track}
          onClick={() => dispatch({ type: "deck.setMaster", deck })}
        >
          Mst
        </HardwareButton>
        <HardwareButton
          disabled={!track || tempoMaster === deck}
          onClick={() => void executeLocalTool("sync_deck", { deck })}
        >
          Sync
        </HardwareButton>
        <HardwareButton
          disabled={!track}
          onClick={() => void executeLocalTool("prep_hotcues", { deck })}
          title="Pads from mix points: in / drop / break / out"
        >
          Cues
        </HardwareButton>
      </div>

      <div className="cdj-pads">
        {[1, 2, 4, 8].map((bars) => (
          <HardwareButton
            key={bars}
            pad
            led={state.loopBars === bars}
            disabled={!track}
            onClick={() =>
              dispatch({
                type: "deck.setLoop",
                deck,
                bars: state.loopBars === bars ? null : bars,
                inBars: currentPlayhead(deck),
              })
            }
          >
            {bars}
          </HardwareButton>
        ))}
        {state.hotcues.slice(0, 4).map((hc, i) => (
          <HardwareButton
            key={`c${i}`}
            pad
            hasCue={hc != null}
            disabled={!track}
            onClick={() => {
              if (hc != null) {
                dispatch({ type: "deck.seek", deck, positionBars: hc });
                dispatch({ type: "deck.play", deck });
              } else {
                dispatch({
                  type: "deck.setHotcue",
                  deck,
                  pad: i + 1,
                  bars: currentPlayhead(deck),
                });
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              dispatch({ type: "deck.setHotcue", deck, pad: i + 1, bars: null });
            }}
          >
            C{i + 1}
          </HardwareButton>
        ))}
      </div>
    </section>
  );
}

export function Workspace() {
  useLooseDeckPlayheads();
  const proposal = useSetStore((s) => s.doc.proposal);

  return (
    <div className="workspace-inner booth">
      <div className="booth-main">
        {proposal && <ProposalBanner />}
        <div className="booth-stage">
          <CdjDeck deck="A" />
          <MixerStrip />
          <CdjDeck deck="B" />
        </div>
      </div>

      <BoothExtras />
      <SetRuler />
    </div>
  );
}
