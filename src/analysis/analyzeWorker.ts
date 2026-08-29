/// <reference lib="webworker" />
import { analyzePcm } from "./analyzePcm";
import type { TrackAnalysis } from "../types/setdoc";

export type WorkerAnalyzeRequest = {
  id: string;
  samples: Float32Array;
  sampleRate: number;
};

export type WorkerAnalyzeResponse =
  | { id: string; ok: true; analysis: TrackAnalysis }
  | { id: string; ok: false; error: string };

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (ev: MessageEvent<WorkerAnalyzeRequest>) => {
  const { id, samples, sampleRate } = ev.data;
  try {
    const analysis = analyzePcm(samples, sampleRate);
    const response: WorkerAnalyzeResponse = { id, ok: true, analysis };
    self.postMessage(response);
  } catch (err) {
    const response: WorkerAnalyzeResponse = {
      id,
      ok: false,
      error: err instanceof Error ? err.message : "analysis failed",
    };
    self.postMessage(response);
  }
};

export {};
