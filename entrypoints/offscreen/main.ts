// Runs browser-engine downloads. Lives in an offscreen document so long
// downloads survive service worker suspension and can write to disk.

import { DrmError } from '@/lib/engine/muxer';
import { isAbort } from '@/lib/engine/net';
import { buildPlan, PlanError, type Plan } from '@/lib/engine/plan';
import { PauseGate, runPlan, type FileSink } from '@/lib/engine/runner';
import { stagingDir, uniqueName, usableDownloadDir } from '@/lib/files';
import type { EngineEvent, EngineJob, OffscreenMessage } from '@/lib/messages';

interface Running {
  ctrl: AbortController;
  gate: PauseGate;
}

const running = new Map<string, Running>();
const reservedNames = new Set<string>();

const emit = (e: EngineEvent) => browser.runtime.sendMessage(e).catch(() => {});

browser.runtime.onMessage.addListener((msg: OffscreenMessage, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  switch (msg.type) {
    case 'run':
      if (!running.has(msg.job.id)) void run(msg.job);
      sendResponse({ ok: true });
      break;
    case 'pause':
      running.get(msg.id)?.gate.pause();
      sendResponse({ ok: true });
      break;
    case 'resume':
      running.get(msg.id)?.gate.resume();
      sendResponse({ ok: true });
      break;
    case 'cancel':
      running.get(msg.id)?.ctrl.abort();
      sendResponse({ ok: true });
      break;
    case 'list-active':
      sendResponse([...running.keys()]);
      break;
    default:
      sendResponse({ ok: false });
  }
  return false;
});

function planHosts(plan: Plan): string[] {
  const urls =
    plan.type === 'file'
      ? [plan.url]
      : plan.tracks.flatMap((t) => [t.init?.url, ...t.segments.map((s) => s.url), ...t.segments.map((s) => s.key?.uri)]);
  const hosts = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      hosts.add(new URL(u).hostname);
    } catch {
      // ignore
    }
  }
  return [...hosts];
}

async function openSink(stem: string, ext: string): Promise<FileSink & { name: string; savedTo: 'folder' | 'staging' }> {
  const folder = await usableDownloadDir();
  const dir = folder ?? (await stagingDir());
  const name = await uniqueName(dir, stem, ext, reservedNames);
  reservedNames.add(name);
  const handle = await dir.getFileHandle(name, { create: true });
  const writer = await handle.createWritable();
  const release = () => reservedNames.delete(name);
  return {
    name,
    savedTo: folder ? 'folder' : 'staging',
    write: (data) => writer.write(data as BufferSource),
    writeAt: (position, data) => writer.write({ type: 'write', position, data: data as BufferSource }),
    close: async () => {
      await writer.close();
      release();
    },
    abort: async () => {
      release();
      await writer.abort().catch(() => {});
      await dir.removeEntry(name).catch(() => {});
    },
  };
}

async function run(job: EngineJob) {
  const ctrl = new AbortController();
  const gate = new PauseGate();
  running.set(job.id, { ctrl, gate });
  let sinkInfo: { name: string; savedTo: 'folder' | 'staging' } | undefined;
  try {
    emit({ type: 'engine-progress', id: job.id, progress: { bytes: 0, stage: 'Reading stream' } });
    const plan = await buildPlan(job.source, ctrl.signal);
    await emit({ type: 'engine-hosts', id: job.id, hosts: planHosts(plan) });
    const result = await runPlan(plan, {
      title: job.title,
      concurrency: job.concurrency,
      signal: ctrl.signal,
      gate,
      openSink: async (ext) => {
        const sink = await openSink(job.fileStem, ext);
        sinkInfo = sink;
        return sink;
      },
      onProgress: (progress) => emit({ type: 'engine-progress', id: job.id, progress }),
    });
    emit({
      type: 'engine-done',
      id: job.id,
      fileName: sinkInfo?.name ?? `${job.fileStem}.${result.ext}`,
      savedTo: sinkInfo?.savedTo ?? 'staging',
      bytes: result.bytes,
    });
  } catch (e) {
    if (isAbort(e) || ctrl.signal.aborted) {
      emit({ type: 'engine-canceled', id: job.id });
    } else {
      console.error('download failed', job, e);
      const reason = e instanceof PlanError ? e.reason : e instanceof DrmError ? 'drm' : undefined;
      emit({ type: 'engine-error', id: job.id, error: e instanceof Error ? e.message : String(e), reason });
    }
  } finally {
    running.delete(job.id);
  }
}
