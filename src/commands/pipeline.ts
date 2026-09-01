import { create } from "zustand";
import type { Command, CommandSource, DispatchedCommand } from "../types/commands";
import type { DeckId, SetDoc } from "../types/setdoc";
import {
  applyCommand,
  createInitialDoc,
  freezeRuntimeFlags,
  normalizeDoc,
} from "./applyCommand";
import { persistSetDoc } from "../storage/db";

const MAX_HISTORY = 100;

type Toast = {
  id: string;
  message: string;
  commandId: string;
};

export type TransportState = {
  setPlaying: boolean;
  setPositionBars: number;
  entryIndex: number;
  deckPlayheads: Record<DeckId, number>;
};

const emptyTransport = (): TransportState => ({
  setPlaying: false,
  setPositionBars: 0,
  entryIndex: 0,
  deckPlayheads: { A: 0, B: 0, C: 0, D: 0 },
});

type SetStore = {
  doc: SetDoc;
  past: SetDoc[];
  future: SetDoc[];
  lastCommand: DispatchedCommand | null;
  toasts: Toast[];
  activity: string;
  webmcpAvailable: boolean;
  rail: "library" | "set" | "agent" | null;
  transport: TransportState;
  dispatch: (command: Command, source?: CommandSource) => DispatchedCommand;
  /** Live mixer/deck patches during set performance — no undo history. */
  patchLive: (mutator: (doc: SetDoc) => SetDoc) => void;
  setTransport: (partial: Partial<TransportState>) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  dismissToast: (id: string) => void;
  setRail: (rail: SetStore["rail"]) => void;
  setActivity: (activity: string) => void;
  setWebmcpAvailable: (available: boolean) => void;
  hydrate: (doc: SetDoc) => void;
};

function describeCommand(command: Command): string {
  switch (command.type) {
    case "library.addTrack":
      return `Imported “${command.track.title}”`;
    case "library.setAnalysis":
      return `Analyzed track (${command.analysis.bpm.toFixed(1)} BPM)`;
    case "deck.load":
      return `Loaded Deck ${command.deck}`;
    case "deck.setLoop":
      return `Deck ${command.deck} loop → ${command.bars ?? 0} bars`;
    case "deck.setTempo":
      return `Deck ${command.deck} tempo → ${command.bpm.toFixed(1)}`;
    case "set.setProposal":
      return command.proposal ? "Proposed a new set" : "Cleared proposal";
    case "set.applyProposal":
      return "Applied set proposal";
    case "set.rejectProposal":
      return "Rejected set proposal";
    case "set.addAutomation":
      return `Automation ${command.lane.param}`;
    case "set.setTempo":
      return command.bpm != null ? `Set tempo → ${command.bpm}` : "Set tempo cleared";
    case "set.edit":
      return `Edited set (${command.action})`;
    default:
      return command.type;
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(doc: SetDoc) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    void persistSetDoc(freezeRuntimeFlags(doc));
  }, 400);
}

function transportUnchanged(a: TransportState, b: TransportState): boolean {
  if (a.setPlaying !== b.setPlaying || a.entryIndex !== b.entryIndex) return false;
  if (Math.abs(a.setPositionBars - b.setPositionBars) > 1e-6) return false;
  for (const id of ["A", "B", "C", "D"] as DeckId[]) {
    if (Math.abs((a.deckPlayheads[id] ?? 0) - (b.deckPlayheads[id] ?? 0)) > 1e-4) {
      return false;
    }
  }
  return true;
}

export const useSetStore = create<SetStore>((set, get) => ({
  doc: createInitialDoc(),
  past: [],
  future: [],
  lastCommand: null,
  toasts: [],
  activity: "Ready",
  webmcpAvailable: false,
  rail: null,
  transport: emptyTransport(),

  dispatch: (command, source = "ui") => {
    const state = get();
    const previous = state.doc;
    const next = applyCommand(previous, command);
    const dispatched: DispatchedCommand = {
      id: crypto.randomUUID(),
      at: Date.now(),
      source,
      command,
    };

    const changed = next.version !== previous.version || next !== previous;
    if (!changed) return dispatched;

    const ephemeral = source === "system";

    const toast: Toast | null =
      source === "agent"
        ? {
            id: crypto.randomUUID(),
            message: `Agent: ${describeCommand(command)}`,
            commandId: dispatched.id,
          }
        : null;

    const arrangementChanged =
      next.arrangement !== previous.arrangement &&
      (next.arrangement.length !== previous.arrangement.length ||
        next.arrangement.some((e, i) => {
          const p = previous.arrangement[i];
          return (
            !p ||
            e.trackId !== p.trackId ||
            e.inBars !== p.inBars ||
            e.outBars !== p.outBars ||
            e.id !== p.id
          );
        }));

    set((s) => {
      let transport = s.transport;
      if (arrangementChanged) {
        transport = {
          ...transport,
          setPositionBars: 0,
          entryIndex: 0,
          setPlaying: false,
        };
      }
      return {
        doc: next,
        past: ephemeral ? s.past : [...state.past.slice(-(MAX_HISTORY - 1)), previous],
        future: ephemeral ? s.future : [],
        lastCommand: dispatched,
        activity: ephemeral ? s.activity : describeCommand(command),
        toasts: toast ? [...s.toasts.slice(-4), toast] : s.toasts,
        transport,
      };
    });
    if (arrangementChanged && state.transport.setPlaying) {
      queueMicrotask(() => {
        void import("../audio/setPerformer").then(({ setPerformer }) => {
          setPerformer.pause();
        });
      });
    }
    if (!ephemeral) schedulePersist(next);
    return dispatched;
  },

  patchLive: (mutator) => {
    const previous = get().doc;
    const next = mutator(previous);
    if (next === previous) return;
    // Bump version so audio engine subscribers fire, but skip undo stack.
    const stamped: SetDoc = {
      ...next,
      version: previous.version + 1,
      updatedAt: Date.now(),
    };
    set({ doc: stamped });
  },

  setTransport: (partial) =>
    set((s) => {
      const next: TransportState = {
        ...s.transport,
        ...partial,
        deckPlayheads: partial.deckPlayheads
          ? { ...s.transport.deckPlayheads, ...partial.deckPlayheads }
          : s.transport.deckPlayheads,
      };
      if (transportUnchanged(s.transport, next)) return s;
      return { transport: next };
    }),

  undo: () => {
    const { past, doc, future } = get();
    const previous = past[past.length - 1];
    if (!previous) return;
    set({
      doc: previous,
      past: past.slice(0, -1),
      future: [doc, ...future].slice(0, MAX_HISTORY),
      activity: "Undo",
    });
    schedulePersist(previous);
  },

  redo: () => {
    const { past, doc, future } = get();
    const next = future[0];
    if (!next) return;
    set({
      doc: next,
      past: [...past, doc].slice(-MAX_HISTORY),
      future: future.slice(1),
      activity: "Redo",
    });
    schedulePersist(next);
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  setRail: (rail) => set({ rail }),
  setActivity: (activity) => set({ activity }),
  setWebmcpAvailable: (webmcpAvailable) => set({ webmcpAvailable }),
  hydrate: (doc) =>
    set({
      doc: normalizeDoc(doc),
      past: [],
      future: [],
      transport: emptyTransport(),
      activity: "Restored set",
    }),
}));
