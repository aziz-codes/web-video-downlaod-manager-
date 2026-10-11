// Builds the quality list for a video: from detected network streams, or from
// the yt-dlp helper for sites that need it.

import { cleanTitle } from '../filename';
import { hostname } from '../format';
import type { VideoContext } from '../messages';
import { probeMedia, type ProbeResult } from '../probe';
import { getSettings } from '../settings';
import { isHelperSite, isYouTube } from '../sites';
import type { DetectedMedia, DownloadOption, MediaInfo, OptionsResult } from '../types';
import { detectedFor } from './detector';
import { clearRefererRule, hostOf, setRefererRule } from './headers';
import { helper } from './helper';

const probeCache = new Map<string, { at: number; result: ProbeResult }>();
const helperCache = new Map<string, { at: number; result: OptionsResult }>();
const CACHE_MS = 60_000;

export async function helperCookies(pageUrl: string) {
  const { helperCookies: mode } = await getSettings();
  if (mode === 'never' || (mode === 'non-youtube' && isYouTube(pageUrl))) return undefined;
  try {
    const cookies = await browser.cookies.getAll({ url: pageUrl });
    return cookies.map((c) => ({
      domain: c.domain,
      hostOnly: c.hostOnly,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate,
      name: c.name,
      value: c.value,
    }));
  } catch {
    return undefined;
  }
}

export async function helperOptions(pageUrl: string, fallbackMedia: MediaInfo): Promise<OptionsResult> {
  const cached = helperCache.get(pageUrl);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;
  const { preferCompatible } = await getSettings();
  let result: OptionsResult;
  try {
    const res = await helper.request<any>(
      { type: 'probe', url: pageUrl, preferCompatible, cookies: await helperCookies(pageUrl) },
      90_000,
    );
    if (!res.ok) {
      result = { ok: false, reason: 'error', message: res.error, media: fallbackMedia };
    } else if (res.media?.isLive) {
      result = { ok: false, reason: 'live', message: 'Live streams can’t be downloaded yet.', media: fallbackMedia };
    } else if (!res.options?.length) {
      result = { ok: false, reason: 'none', message: 'No downloadable formats were found.', media: fallbackMedia };
    } else {
      result = {
        ok: true,
        media: { ...fallbackMedia, ...res.media, site: fallbackMedia.site, title: res.media.title || fallbackMedia.title },
        options: res.options,
      };
    }
  } catch (e) {
    result = { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e), media: fallbackMedia };
  }
  if (result.ok) helperCache.set(pageUrl, { at: Date.now(), result });
  return result;
}

async function probeCached(m: DetectedMedia, referer: string, videoHeight?: number): Promise<ProbeResult> {
  const key = `${m.url}|${videoHeight ?? ''}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const { preferCompatible } = await getSettings();
  const ruleKey = `probe:${m.url}`;
  await setRefererRule(ruleKey, [hostOf(m.url)], referer);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    const result = await probeMedia(m, { preferCompatible, videoHeight, signal: ctrl.signal });
    clearTimeout(timer);
    probeCache.set(key, { at: Date.now(), result });
    return result;
  } finally {
    await clearRefererRule(ruleKey);
  }
}

const durationMatches = (a: number | undefined, b: number | undefined) =>
  !!a && !!b && Math.abs(a - b) <= Math.max(2, b * 0.02);

export async function resolveOptions(ctx: VideoContext, tabId: number | undefined, frameId: number | undefined): Promise<OptionsResult> {
  const tab = tabId !== undefined ? await browser.tabs.get(tabId).catch(() => undefined) : undefined;
  const title = cleanTitle(ctx.isTop || !tab?.title ? ctx.title || tab?.title : tab.title);
  const media: MediaInfo = {
    title,
    duration: Number.isFinite(ctx.duration) ? ctx.duration : undefined,
    thumbnail: ctx.thumbnail,
    site: hostname(tab?.url ?? ctx.pageUrl),
  };
  const helperOk = () => helper.available();

  if (isHelperSite(ctx.pageUrl)) {
    if (await helperOk()) return helperOptions(ctx.pageUrl, media);
    return {
      ok: false,
      reason: 'needs-helper',
      message: `${isYouTube(ctx.pageUrl) ? 'YouTube' : media.site} downloads need the free helper app (yt-dlp). It takes one command to install.`,
      media,
    };
  }

  const detected = tabId !== undefined ? await detectedFor(tabId) : [];
  let candidates = detected.filter((m) => frameId === undefined || m.frameId === frameId);
  if (!candidates.length) candidates = detected;
  if (ctx.src && /^https?:/.test(ctx.src) && !candidates.some((c) => c.url === ctx.src)) {
    candidates.unshift({ url: ctx.src, kind: 'file', frameId: frameId ?? 0, time: Date.now() });
  }
  // Manifests first, most recent first; cap the number of probes.
  candidates = [...candidates].sort((a, b) => Number(a.kind === 'file') - Number(b.kind === 'file') || b.time - a.time).slice(0, 8);

  if (!candidates.length) {
    if (await helperOk()) {
      const viaHelper = await helperOptions(ctx.pageUrl, media);
      if (viaHelper.ok) return viaHelper;
    }
    return {
      ok: false,
      reason: 'none',
      message: ctx.src?.startsWith('blob:')
        ? 'Play the video for a few seconds so its stream can be detected. If it was already playing before the extension was installed, reload the page.'
        : 'No downloadable video was found on this page yet. Try playing it first.',
      media,
    };
  }

  const referer = ctx.pageUrl;
  const probed = await Promise.all(candidates.map(async (c) => ({ c, r: await probeCached(c, referer, ctx.height) })));
  const usable = probed.filter((p) => p.r.options.length);

  let chosen = usable;
  if (media.duration) {
    const matching = usable.filter((p) => durationMatches(p.r.duration, media.duration) || p.r.duration === undefined);
    const exact = matching.filter((p) => p.r.duration !== undefined);
    chosen = exact.length ? exact : matching.length ? matching : usable;
  } else {
    // Without a reference duration, drop short streams (usually ads) next to a long one.
    const longest = Math.max(0, ...usable.map((p) => p.r.duration ?? 0));
    if (longest > 60) chosen = usable.filter((p) => (p.r.duration ?? longest) >= longest * 0.3);
  }

  // The same stream is often requested under several URLs; dedupe by quality signature.
  const seen = new Set<string>();
  const groups = chosen.filter((p) => {
    const sig = `${Math.round(p.r.duration ?? 0)}|${p.r.options.map((o) => o.label).join(',')}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    return true;
  });

  const options: DownloadOption[] = [];
  groups.forEach((g, i) => {
    for (const o of g.r.options) options.push(groups.length > 1 ? { ...o, group: `Stream ${i + 1}` } : o);
  });

  if (options.length) {
    const duration = media.duration ?? groups[0]?.r.duration;
    return { ok: true, media: { ...media, duration }, options };
  }

  if (await helperOk()) {
    const viaHelper = await helperOptions(ctx.pageUrl, media);
    if (viaHelper.ok) return viaHelper;
  }
  if (probed.some((p) => p.r.drm))
    return { ok: false, reason: 'drm', message: 'This video is DRM protected. Protected streams can’t be downloaded.', media };
  if (probed.some((p) => p.r.live))
    return { ok: false, reason: 'live', message: 'This is a live stream. Live recording isn’t supported yet.', media };
  const err = probed.find((p) => p.r.error)?.r.error;
  return { ok: false, reason: 'error', message: err ?? 'Couldn’t read the video stream.', media };
}
