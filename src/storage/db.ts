import Dexie, { type EntityTable } from "dexie";
import type { SetDoc, TrackAnalysis } from "../types/setdoc";

type SetRow = {
  id: string;
  doc: SetDoc;
  updatedAt: number;
};

type AnalysisRow = {
  trackId: string;
  analysis: TrackAnalysis;
  updatedAt: number;
};

type MetaRow = {
  key: string;
  value: string;
};

class BananaDJDatabase extends Dexie {
  sets!: EntityTable<SetRow, "id">;
  analyses!: EntityTable<AnalysisRow, "trackId">;
  meta!: EntityTable<MetaRow, "key">;

  constructor() {
    super("bananalabs-dj");
    this.version(1).stores({
      sets: "id, updatedAt",
      analyses: "trackId, updatedAt",
      meta: "key",
    });
  }
}

export const db = new BananaDJDatabase();

const ACTIVE_SET_KEY = "activeSetId";

export async function persistSetDoc(doc: SetDoc): Promise<void> {
  await db.sets.put({ id: doc.id, doc, updatedAt: doc.updatedAt });
  await db.meta.put({ key: ACTIVE_SET_KEY, value: doc.id });
}

export async function loadActiveSetDoc(): Promise<SetDoc | null> {
  const meta = await db.meta.get(ACTIVE_SET_KEY);
  if (!meta?.value) return null;
  const row = await db.sets.get(meta.value);
  return row?.doc ?? null;
}

export async function persistAnalysis(
  trackId: string,
  analysis: TrackAnalysis,
): Promise<void> {
  await db.analyses.put({ trackId, analysis, updatedAt: Date.now() });
}

export async function loadAnalysis(
  trackId: string,
): Promise<TrackAnalysis | null> {
  const row = await db.analyses.get(trackId);
  return row?.analysis ?? null;
}
