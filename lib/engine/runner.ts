// Executes a Plan: concurrent segment downloads, delivered in order to the
// muxer (or straight to the file for progressive downloads).

import type { Progress } from '../types';
import { decryptAes128 } from './aes';
import { Mp4Muxer, type ByteSink, type MuxSource } from './muxer';
import { AbortedError, fetchBytes } from './net';
import { fileChunks, type Plan, type SegTask } from './plan';
import { TsTransmuxer } from './ts';

export interface FileSink extends ByteSink {
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface RunOptions {
  title?: string;
  concurrency: number;
  signal: AbortSignal;
  gate: PauseGate;
  /** Opens the output file once the extension is known. */
  openSink: (ext: string) => Promise<FileSink>;
  onProgress: (p: Progress) => void;
}

export interface RunResult {
  ext: string;
  bytes: number;
}

/** Lets a running download be paused between segment fetches. */
export class PauseGate {
  private waiters: Array<() => void> = [];
  paused = false;
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    this.waiters.splice(0).forEach((w) => w());
  }
  wait(signal: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      signal.addEventListener('abort', () => reject(new AbortedError()), { once: true });
    });
  }
}

class ProgressTracker {
  private bytes = 0;
  private doneWeight = 0;
  private samples: Array<[number, number]> = [];
  private lastEmit = 0;
  stage = 'Downloading';

  constructor(
    private totalWeight: number,
    private estimatedBytes: number | undefined,
    private emit: (p: Progress) => void,
  ) {}

  addBytes = (n: number) => {
    this.bytes += n;
    this.tick();
  };

  addWeight(w: number) {
    this.doneWeight += w;
    this.tick();
  }

  tick(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.samples.push([now, this.bytes]);
    while (this.samples.length > 2 && now - this.samples[0][0] > 4000) this.samples.shift();
    const [t0, b0] = this.samples[0];
    const speed = now > t0 ? ((this.bytes - b0) * 1000) / (now - t0) : undefined;
    const fraction = this.totalWeight ? Math.min(1, this.doneWeight / this.totalWeight) : undefined;
    let totalBytes = this.estimatedBytes;
    if (fraction && fraction > 0.03) totalBytes = this.bytes / fraction;
    const eta = speed && totalBytes ? Math.max(0, (totalBytes - this.bytes) / speed) : undefined;
    this.emit({ fraction, bytes: this.bytes, totalBytes, speed, eta, stage: this.stage });
  }

  get downloaded() {
    return this.bytes;
  }
}

export async function runPlan(plan: Plan, opts: RunOptions): Promise<RunResult> {
  return plan.type === 'file' ? runFile(plan, opts) : runMux(plan, opts);
}

/**
 * Runs fetches with bounded concurrency and a bounded look-ahead window,
 * yielding results strictly in order.
 */
async function orderedFetch<T>(
  count: number,
  fetchOne: (index: number, signal: AbortSignal) => Promise<T>,
  consume: (index: number, value: T) => Promise<void>,
  opts: Pick<RunOptions, 'concurrency' | 'signal' | 'gate'>,
) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  opts.signal.addEventListener('abort', onAbort, { once: true });
  const window = Math.max(opts.concurrency * 3, 8);
  const results = new Array<Promise<T> | undefined>(count);
  let started = 0;
  let inflight = 0;
  let next = 0;

  const pump = () => {
    while (!opts.gate.paused && started < count && inflight < opts.concurrency && started < next + window) {
      const i = started++;
      inflight++;
      const p = fetchOne(i, ctrl.signal);
      p.catch(() => {}).finally(() => {
        inflight--;
        pump();
      });
      results[i] = p;
    }
  };

  try {
    for (next = 0; next < count; next++) {
      while (!results[next]) {
        await opts.gate.wait(ctrl.signal);
        pump();
        if (!results[next]) await new Promise((r) => setTimeout(r, 50));
        if (ctrl.signal.aborted) throw new AbortedError();
      }
      const value = await results[next]!;
      results[next] = undefined;
      pump();
      await consume(next, value);
    }
  } finally {
    ctrl.abort();
    opts.signal.removeEventListener('abort', onAbort);
  }
}

async function runFile(plan: Extract<Plan, { type: 'file' }>, opts: RunOptions): Promise<RunResult> {
  const sink = await opts.openSink(plan.ext);
  try {
    const progress = new ProgressTracker(plan.size ?? 0, plan.size, opts.onProgress);
    if (plan.rangeable && plan.size) {
      const chunks = fileChunks(plan.size);
      await orderedFetch(
        chunks.length,
        (i, signal) => fetchBytes(plan.url, { range: chunks[i], signal, onBytes: progress.addBytes }),
        async (i, data) => {
          await sink.write(data);
          progress.addWeight(chunks[i][1] - chunks[i][0] + 1);
        },
        opts,
      );
    } else {
      // No range support: one streaming request (cannot pause mid-way).
      const res = await fetch(plan.url, { signal: opts.signal, credentials: 'include' });
      if (!res.ok) throw new Error(`The server returned an error (${res.status}).`);
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await sink.write(value);
        progress.addBytes(value.length);
        progress.addWeight(value.length);
      }
    }
    progress.stage = 'Saving';
    progress.tick(true);
    await sink.close();
    return { ext: plan.ext, bytes: progress.downloaded };
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  }
}

interface Task {
  track: number;
  seg: SegTask;
  isInit: boolean;
}

async function runMux(plan: Extract<Plan, { type: 'mux' }>, opts: RunOptions): Promise<RunResult> {
  const tasks: Task[] = [];
  plan.tracks.forEach((t, track) => {
    if (t.init) tasks.push({ track, seg: t.init, isInit: true });
    for (const seg of t.segments) tasks.push({ track, seg, isInit: false });
  });
  // Interleave tracks by time so audio and video chunks sit close together in the file.
  tasks.sort((a, b) => (a.isInit === b.isInit ? a.seg.start - b.seg.start || a.track - b.track : a.isInit ? -1 : 1));

  const totalWeight = tasks.reduce((s, t) => s + (t.isInit ? 0 : (t.seg.weight ?? t.seg.duration ?? 1)), 0);
  const progress = new ProgressTracker(totalWeight, plan.estimatedBytes, opts.onProgress);

  let sink: FileSink | undefined;
  let ext = plan.container;
  let rawTs = false;
  const lazySink: ByteSink = {
    write: async (data) => {
      sink ??= await opts.openSink(ext);
      await sink.write(data);
    },
    writeAt: async (pos, data) => sink!.writeAt(pos, data),
  };

  const muxer = new Mp4Muxer(lazySink, plan.container);
  const sources: MuxSource[] = plan.tracks.map(() => muxer.createSource());
  const transmuxers = plan.tracks.map((t) => (t.kind === 'ts' ? new TsTransmuxer() : undefined));
  const initCache = new Map<string, Promise<Uint8Array>>();

  const fetchTask = async (i: number, signal: AbortSignal) => {
    const { seg, isInit } = tasks[i];
    const key = `${seg.url}|${seg.range?.join('-')}`;
    if (isInit && initCache.has(key)) return initCache.get(key)!;
    const p = fetchBytes(seg.url, { range: seg.range, signal, onBytes: progress.addBytes }).then((data) =>
      seg.key ? decryptAes128(data, seg.key.uri, seg.key.iv, signal) : data,
    );
    if (isInit) initCache.set(key, p);
    return p;
  };

  const consume = async (i: number, data: Uint8Array) => {
    const { track, seg, isInit } = tasks[i];
    if (rawTs) {
      await lazySink.write(data);
    } else if (transmuxers[track]) {
      const out = transmuxers[track]!.transmux(data);
      if (!out.length && !sources[track].initialized && plan.tracks.length === 1) {
        // Codec mux.js cannot handle (e.g. HEVC): keep the original MPEG-TS.
        rawTs = true;
        ext = 'ts' as typeof ext;
        await lazySink.write(data);
      } else if (out.length) {
        await sources[track].push(out);
      }
    } else {
      await sources[track].push(data);
    }
    if (!isInit) progress.addWeight(seg.weight ?? seg.duration ?? 1);
  };

  try {
    await orderedFetch(tasks.length, fetchTask, consume, opts);
    progress.stage = 'Finalizing';
    progress.tick(true);
    if (!rawTs) {
      if (!muxer.hasSamples) throw new Error('No playable audio or video was found in the stream.');
      await muxer.finalize({ title: opts.title });
    }
    if (!sink) throw new Error('Nothing was downloaded.');
    await sink.close();
    return { ext, bytes: progress.downloaded };
  } catch (e) {
    await sink?.abort().catch(() => {});
    throw e;
  }
}
