import type { TrackAnalysis } from "../types/setdoc";
import type { WorkerAnalyzeResponse } from "./analyzeWorker";

let worker: Worker | null = null;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./analyzeWorker.ts", import.meta.url), {
      type: "module",
    });
  }
  return worker;
}

export async function decodeAudioFile(file: Blob): Promise<{
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
}> {
  const ctx = new AudioContext();
  try {
    const buffer = await file.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(buffer.slice(0));
    const ch0 = audioBuf.getChannelData(0);
    let mono: Float32Array;
    if (audioBuf.numberOfChannels > 1) {
      const ch1 = audioBuf.getChannelData(1);
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i]! + ch1[i]!) * 0.5;
    } else {
      mono = ch0.slice(0);
    }
    // Downsample for worker transfer size if huge
    const maxSamples = 22050 * 60 * 8; // 8 min @ 22k
    if (mono.length > maxSamples) {
      const step = Math.ceil(mono.length / maxSamples);
      const slim = new Float32Array(Math.floor(mono.length / step));
      for (let i = 0; i < slim.length; i++) slim[i] = mono[i * step]!;
      return {
        samples: slim,
        sampleRate: audioBuf.sampleRate / step,
        durationSec: audioBuf.duration,
      };
    }
    return {
      samples: mono,
      sampleRate: audioBuf.sampleRate,
      durationSec: audioBuf.duration,
    };
  } finally {
    await ctx.close();
  }
}

export function analyzeInWorker(
  samples: Float32Array,
  sampleRate: number,
): Promise<TrackAnalysis> {
  const id = crypto.randomUUID();
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent<WorkerAnalyzeResponse>) => {
      if (ev.data.id !== id) return;
      w.removeEventListener("message", onMessage);
      if (ev.data.ok) resolve(ev.data.analysis);
      else reject(new Error(ev.data.error));
    };
    w.addEventListener("message", onMessage);
    const req = { id, samples, sampleRate };
    w.postMessage(req, [samples.buffer]);
  });
}
