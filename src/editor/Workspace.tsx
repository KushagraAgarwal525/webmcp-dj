import "./Workspace.css";
import { useEffect } from "react";
import { useSetStore } from "../commands/pipeline";
import type { DeckId, Track } from "../types/setdoc";
import { audioEngine } from "../audio/engine";
import { setPerformer } from "../audio/setPerformer";
import { ProposalBanner } from "./ProposalBanner";
import { BoothExtras } from "./BoothExtras";
import { MixerStrip } from "./MixerStrip";
import { JogWheel } from "./controls/JogWheel";
import { HardwareButton } from "./controls/HardwareButton";
import { VerticalFader } from "./controls/VerticalFader";
import { buildTimeline, setDurationBars } from "../set/timeline";
import { fetchLyricsForTrack } from "../lyrics/lrclib";
import { executeLocalTool } from "../webmcp/registry";

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
  if (!peaks?.length) {
    return <div className="cdj-wave empty" aria-hidden />;
  }
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
  const ph =
    playheadFrac != null && playheadFrac >= 0 && playheadFrac <= 1
      ? `<line x1="${playheadFrac * w}" y1="0" x2="${playheadFrac * w}" y2="${h}" stroke="#fff" stroke-width="2"/>`
      : "";
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
      dangerouslySetInnerHTML={{
        __html: `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${loop}${bars.join("")}${cues}${ph}</svg>`,
      }}
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
  const playheadBars = useSetStore((s) =>
    s.transport.setPlaying || state.playing
      ? (s.transport.deckPlayheads[deck] ?? state.positionBars)
      : state.positionBars,
  );
  const tempoMaster = useSetStore((s) => s.doc.tempoMaster);

  const peaks = track?.analysis?.waveform.peaks;
  const durationBars = track?.analysis?.durationBars ?? 1;
  const playheadFrac = durationBars > 0 ? playheadBars / durationBars : 0;
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
  const spinning = state.playing || (setPlaying && Boolean(trackId));
  const nativeBpm = track?.analysis?.bpm ?? state.bpm ?? 120;
  const deckBpm = state.bpm ?? nativeBpm;

  const seekBars = (bars: number) => {
    if (setPlaying) return;
    dispatch({ type: "deck.seek", deck, positionBars: bars });
    useSetStore.getState().setTransport({
      deckPlayheads: {
        ...useSetStore.getState().transport.deckPlayheads,
        [deck]: bars,
      },
    });
  };

  return (
    <section className={`cdj-deck deck-${deck.toLowerCase()}`}>
      <header className="cdj-info">
        <div className="cdj-title-block">
          <span className="cdj-deck-tag">{deck}</span>
          <strong>{track?.title ?? "No track loaded"}</strong>
          <span className="cdj-meta">
            {track
              ? `${track.artist || "Unknown"}${track.analysis ? ` · ${track.analysis.key.camelot}` : ""}`
              : "Load from Assets"}
          </span>
        </div>
        <div className="cdj-readout mono">
          <span className="cdj-bpm-big">
            {state.bpm != null ? state.bpm.toFixed(1) : "—.—"}
          </span>
          <span className="cdj-bars">{playheadBars.toFixed(1)}b</span>
          <span className="cdj-leds">
            <i className={state.keylock ? "on" : ""}>KL</i>
            <i className={state.quantize ? "on" : ""}>Q</i>
            <i className={tempoMaster === deck ? "on" : ""}>MST</i>
          </span>
        </div>
      </header>

      <WaveformView
        peaks={peaks}
        playheadFrac={playheadFrac}
        loopStartFrac={loopStartFrac}
        loopEndFrac={loopEndFrac}
        hotcueFracs={hotcueFracs}
        onSeekFrac={
          track && !setPlaying
            ? (frac) => seekBars(frac * durationBars)
            : undefined
        }
      />

      {track && (
        <div className="cdj-lyrics">
          <HardwareButton onClick={() => void fetchDeckLyrics(track.id)}>
            Lrc
          </HardwareButton>
          <span className="mono">{lyricWindow(track, playheadBars)}</span>
        </div>
      )}

      <div className="cdj-platter-row">
        <JogWheel
          deck={deck}
          bpm={state.bpm}
          playing={spinning}
          playheadBars={playheadBars}
          empty={!track}
          title={track?.analysis?.key.camelot}
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
                inBars: playheadBars,
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
                  bars: playheadBars,
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
  const arrangement = useSetStore((s) => s.doc.arrangement);
  const tracks = useSetStore((s) => s.doc.tracks);
  const proposal = useSetStore((s) => s.doc.proposal);
  const doc = useSetStore((s) => s.doc);
  const trackCount = useSetStore((s) => s.doc.crates.all?.trackIds.length ?? 0);
  const setPos = useSetStore((s) => s.transport.setPositionBars);
  const setPlaying = useSetStore((s) => s.transport.setPlaying);
  const entryIndex = useSetStore((s) => s.transport.entryIndex);

  const spans = buildTimeline(doc);
  const duration = setDurationBars(doc);
  const playheadPct = duration > 0 ? (setPos / duration) * 100 : 0;

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

      <section className="set-ruler">
        <header>
          <h3>Set</h3>
          <span className="mono">
            {arrangement.length}tr
            {duration > 0 ? ` · ${duration.toFixed(0)}b` : ""}
            {setPlaying || setPos > 0 ? ` · @${setPos.toFixed(1)}` : ""}
          </span>
        </header>
        {arrangement.length === 0 ? (
          <div className="set-ruler-empty">
            {trackCount === 0
              ? "Assets → upload tracks"
              : "No arrangement — open Set or use agent tools"}
          </div>
        ) : (
          <div
            className="set-ruler-track"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const frac = (e.clientX - rect.left) / rect.width;
              void setPerformer.seek(frac * duration);
            }}
          >
            {spans.map((span) => {
              const t = tracks[span.entry.trackId];
              const widthPct =
                duration > 0
                  ? ((span.setEnd - span.setStart) / duration) * 100
                  : 0;
              const leftPct =
                duration > 0 ? (span.setStart / duration) * 100 : 0;
              return (
                <div
                  key={span.entry.id}
                  className={`set-block${span.entryIndex === entryIndex ? " is-active" : ""}`}
                  style={{
                    width: `${Math.max(4, widthPct)}%`,
                    left: `${leftPct}%`,
                  }}
                  title={`${t?.title ?? "Track"} · ${span.entry.transition.type}`}
                >
                  {span.entryIndex + 1}. {t?.title ?? "Track"}
                </div>
              );
            })}
            <div
              className="set-playhead"
              style={{ left: `${playheadPct}%` }}
            />
          </div>
        )}
      </section>
    </div>
  );
}
