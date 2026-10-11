// Download queue: owns every Job, routes it to the browser engine (offscreen
// document) or the yt-dlp helper, and persists state for the popup.

import { fileStemFor } from '../filename';
import type { EngineEvent, JobAction } from '../messages';
import { getSettings } from '../settings';
import { ACTIVE_STATUSES, type DownloadOption, type Job, type MediaInfo } from '../types';
import { clearRefererRule, hostOf, setRefererRule } from './headers';
import { helper, type HelperEvent } from './helper';
import { offscreenExists, scheduleOffscreenClose, toOffscreen } from './offscreen';
import { helperCookies, helperOptions } from './resolve';

const MAX_HISTORY = 150;
const RUNNING: Job['status'][] = ['preparing', 'downloading', 'finalizing'];

const jobs = new Map<string, Job>();
let ready: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function initJobs() {
  ready ??= load();
  helper.onEvent(onHelperEvent);
  helper.onDisconnect((error) => {
    for (const j of jobs.values()) {
      if (j.option.engine === 'helper' && RUNNING.includes(j.status))
        patch(j.id, { status: 'failed', error: `The helper app stopped: ${error}. Click retry to resume.`, speed: undefined, eta: undefined });
    }
    pump();
  });
  return ready;
}

async function load() {
  const { jobs: stored } = await browser.storage.local.get('jobs');
  for (const j of (stored as Job[] | undefined) ?? []) jobs.set(j.id, j);

  // Reconcile with what is actually still running after a worker restart.
  let activeInEngine: string[] = [];
  if (await offscreenExists()) {
    activeInEngine = await toOffscreen<string[]>({ target: 'offscreen', type: 'list-active' }).catch(() => []);
  }
  for (const j of jobs.values()) {
    if (!ACTIVE_STATUSES.includes(j.status) || j.status === 'queued') continue;
    if (j.option.engine === 'browser' && activeInEngine.includes(j.id)) continue;
    if (j.option.engine === 'helper' && j.status === 'paused') continue;
    j.status = 'failed';
    j.error = 'The download was interrupted. Click retry to start again.';
    j.speed = j.eta = undefined;
  }
  save();
  pump();
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const list = [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
    const keep = list.filter((j, i) => ACTIVE_STATUSES.includes(j.status) || i < MAX_HISTORY);
    if (keep.length < list.length) list.filter((j) => !keep.includes(j)).forEach((j) => jobs.delete(j.id));
    void browser.storage.local.set({ jobs: keep });
    updateBadge();
  }, 200);
}

function patch(id: string, changes: Partial<Job>) {
  const job = jobs.get(id);
  if (!job) return undefined;
  Object.assign(job, changes, { updatedAt: Date.now() });
  save();
  return job;
}

function updateBadge() {
  const active = [...jobs.values()].filter((j) => RUNNING.includes(j.status) || j.status === 'queued').length;
  void browser.action.setBadgeText({ text: active ? String(active) : '' });
  void browser.action.setBadgeBackgroundColor({ color: '#6d5ef8' });
  void browser.action.setBadgeTextColor?.({ color: '#ffffff' });
}

async function pump() {
  await ready;
  const settings = await getSettings();
  let running = [...jobs.values()].filter((j) => RUNNING.includes(j.status)).length;
  const queued = [...jobs.values()].filter((j) => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
  for (const job of queued) {
    if (running >= settings.maxConcurrentJobs) break;
    running++;
    void start(job);
  }
  const browserActive = [...jobs.values()].some((j) => j.option.engine === 'browser' && ACTIVE_STATUSES.includes(j.status));
  scheduleOffscreenClose(browserActive);
}

async function start(job: Job) {
  patch(job.id, { status: 'preparing', stage: 'Preparing', error: undefined, speed: undefined, eta: undefined });
  const settings = await getSettings();
  const stem = fileStemFor(job.title, job.option.label);
  try {
    if (job.option.engine === 'browser') {
      const source = job.option.source!;
      await setRefererRule(`job:${job.id}`, [hostOf(source.url)], job.referer);
      await toOffscreen({
        target: 'offscreen',
        type: 'run',
        job: { id: job.id, source, title: job.title, fileStem: stem, concurrency: settings.segmentConcurrency },
      });
    } else {
      const h = job.option.helper!;
      helper.post({
        type: 'download',
        jobId: job.id,
        url: h.url,
        format: h.format,
        ext: h.ext,
        audioOnly: !!h.audioOnly,
        fileName: stem,
        stem: job.helperStem,
        outputDir: settings.helperOutputDir || undefined,
        cookies: await helperCookies(job.pageUrl),
      });
    }
  } catch (e) {
    fail(job.id, e instanceof Error ? e.message : String(e));
  }
}

function fail(id: string, error: string) {
  patch(id, { status: 'failed', error, speed: undefined, eta: undefined });
  void clearRefererRule(`job:${id}`);
  void pump();
}

async function notifyDone(job: Job) {
  if (!(await getSettings()).notify) return;
  browser.notifications.create(`done:${job.id}`, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title: 'Download complete',
    message: job.fileName ?? job.title,
    contextMessage: job.savedTo === 'staging' ? 'Choose a download folder to save it to disk' : job.site,
  });
}

function complete(id: string, changes: Partial<Job>) {
  const job = patch(id, { ...changes, status: 'completed', fraction: 1, speed: undefined, eta: undefined, stage: undefined, error: undefined });
  void clearRefererRule(`job:${id}`);
  if (job) void notifyDone(job);
  void pump();
}

export function onEngineEvent(e: EngineEvent) {
  const job = jobs.get(e.id);
  if (!job) return;
  switch (e.type) {
    case 'engine-progress': {
      if (job.status === 'canceled' || job.status === 'failed') return;
      const finalizing = e.progress.stage === 'Finalizing' || e.progress.stage === 'Saving';
      patch(e.id, {
        ...e.progress,
        status: job.status === 'paused' ? 'paused' : finalizing ? 'finalizing' : 'downloading',
      });
      break;
    }
    case 'engine-hosts':
      void setRefererRule(`job:${e.id}`, e.hosts, job.referer);
      break;
    case 'engine-done':
      complete(e.id, { fileName: e.fileName, savedTo: e.savedTo, bytes: e.bytes, totalBytes: e.bytes });
      break;
    case 'engine-error':
      fail(e.id, e.error);
      break;
    case 'engine-canceled':
      void clearRefererRule(`job:${e.id}`);
      void pump();
      break;
  }
}

function onHelperEvent(e: HelperEvent) {
  const job = jobs.get(e.jobId);
  if (!job) return;
  switch (e.type) {
    case 'progress': {
      if (job.status === 'canceled' || job.status === 'paused') return;
      const finalizing = /merg|convert|final/i.test(e.stage ?? '');
      patch(e.jobId, {
        status: finalizing ? 'finalizing' : e.stage === 'Preparing' ? 'preparing' : 'downloading',
        stage: e.stage,
        bytes: e.bytes,
        totalBytes: e.totalBytes ?? job.totalBytes,
        fraction: e.fraction ?? undefined,
        speed: e.speed ?? undefined,
        eta: e.eta ?? undefined,
        helperStem: e.stem ?? job.helperStem,
      });
      break;
    }
    case 'done':
      complete(e.jobId, {
        filePath: e.filePath,
        fileName: e.filePath?.split(/[\\/]/).pop(),
        bytes: e.bytes,
        totalBytes: e.bytes,
      });
      break;
    case 'error':
      fail(e.jobId, e.error);
      break;
    case 'canceled':
      if (job.status !== 'paused') patch(e.jobId, { status: 'canceled', speed: undefined, eta: undefined });
      void pump();
      break;
  }
}

export async function createJob(option: DownloadOption, media: MediaInfo, pageUrl: string): Promise<Job> {
  await ready;
  const now = Date.now();
  const job: Job = {
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
    title: media.title,
    pageUrl,
    site: media.site,
    thumbnail: media.thumbnail,
    option,
    status: 'queued',
    bytes: 0,
    totalBytes: option.sizeBytes,
    referer: pageUrl,
  };
  jobs.set(job.id, job);
  save();
  void pump();
  return job;
}

export async function jobAction(id: string, action: JobAction): Promise<{ ok: boolean; error?: string }> {
  await ready;
  const job = jobs.get(id);
  if (!job) return { ok: false, error: 'Download not found' };
  const browserEngine = job.option.engine === 'browser';

  switch (action) {
    case 'pause':
      if (!RUNNING.includes(job.status)) break;
      if (browserEngine) await toOffscreen({ target: 'offscreen', type: 'pause', id });
      else helper.post({ type: 'cancel', jobId: id, keepPartial: true });
      patch(id, { status: 'paused', speed: undefined, eta: undefined });
      void pump();
      break;

    case 'resume':
      if (job.status !== 'paused') break;
      if (browserEngine) {
        const active = await toOffscreen<string[]>({ target: 'offscreen', type: 'list-active' }).catch((): string[] => []);
        if (active.includes(id)) {
          await toOffscreen({ target: 'offscreen', type: 'resume', id });
          patch(id, { status: 'downloading' });
          break;
        }
      }
      patch(id, { status: 'queued' });
      void pump();
      break;

    case 'cancel':
      if (!ACTIVE_STATUSES.includes(job.status)) break;
      if (browserEngine) await toOffscreen({ target: 'offscreen', type: 'cancel', id }).catch(() => {});
      else helper.post({ type: 'cancel', jobId: id, keepPartial: false });
      patch(id, { status: 'canceled', speed: undefined, eta: undefined, stage: undefined });
      void clearRefererRule(`job:${id}`);
      void pump();
      break;

    case 'retry':
      if (ACTIVE_STATUSES.includes(job.status)) break;
      patch(id, { status: 'queued', error: undefined, bytes: 0, fraction: undefined, createdAt: Date.now() });
      void pump();
      break;

    case 'remove':
      if (ACTIVE_STATUSES.includes(job.status)) await jobAction(id, 'cancel');
      jobs.delete(id);
      save();
      break;

    case 'open':
    case 'reveal':
      if (browserEngine) {
        await browser.tabs.create({ url: browser.runtime.getURL(`/player.html?id=${encodeURIComponent(id)}`) });
      } else {
        const res = await helper.request<any>({ type: 'open', path: job.filePath, reveal: action === 'reveal' }, 10_000);
        if (!res.ok) return { ok: false, error: res.error };
      }
      break;

    case 'retry-helper': {
      const res = await helperOptions(job.pageUrl, { title: job.title, site: job.site, thumbnail: job.thumbnail });
      if (!res.ok) return { ok: false, error: res.message };
      const videos = res.options.filter((o) => o.kind === job.option.kind);
      const target = job.option.height
        ? videos.reduce((best, o) =>
            Math.abs((o.height ?? 0) - job.option.height!) < Math.abs((best.height ?? 0) - job.option.height!) ? o : best,
          )
        : videos[0];
      if (!target) return { ok: false, error: 'The helper found no matching quality' };
      jobs.delete(id);
      await createJob(target, res.media, job.pageUrl);
      break;
    }
  }
  return { ok: true };
}

export async function clearFinished() {
  await ready;
  for (const [id, j] of jobs) if (!ACTIVE_STATUSES.includes(j.status)) jobs.delete(id);
  save();
}

export async function markStagedMoved(moves: Array<{ from: string; to: string }>) {
  await ready;
  for (const m of moves) {
    for (const j of jobs.values()) {
      if (j.savedTo === 'staging' && j.fileName === m.from) patch(j.id, { savedTo: 'folder', fileName: m.to });
    }
  }
}

export function handleNotificationClick(notificationId: string) {
  const id = notificationId.replace(/^done:/, '');
  const job = jobs.get(id);
  if (!job) return;
  if (job.savedTo === 'staging') void browser.runtime.openOptionsPage();
  else void jobAction(id, 'open');
  browser.notifications.clear(notificationId);
}
