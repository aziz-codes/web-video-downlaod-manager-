// Turns a detected manifest / media URL into the list of qualities offered to the user.

import { parseDash, type DashRepresentation } from './engine/dash';
import { describeCodecs, parseHls, type HlsMaster } from './engine/hls';
import { fetchText, probeResource } from './engine/net';
import { extFromFile } from './engine/plan';
import { formatBytes, qualityBadge } from './format';
import type { DetectedMedia, DownloadOption } from './types';

export interface ProbeResult {
  options: DownloadOption[];
  duration?: number;
  drm?: boolean;
  live?: boolean;
  error?: string;
}

interface ProbeContext {
  preferCompatible: boolean;
  /** Height of the playing <video>, used when the stream has no quality ladder. */
  videoHeight?: number;
  signal?: AbortSignal;
}

const COMPAT_RANK: Record<string, number> = { 'H.264': 4, AV1: 3, VP9: 2, 'H.265': 1 };
const EFFICIENT_RANK: Record<string, number> = { AV1: 4, 'H.265': 3, VP9: 2, 'H.264': 1 };

function videoLabel(height: number, fps?: number) {
  return `${height}p${fps && fps >= 50 ? Math.round(fps) : ''}`;
}

function detail(parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(' · ');
}

export async function probeMedia(media: DetectedMedia, ctx: ProbeContext): Promise<ProbeResult> {
  try {
    if (media.kind === 'file') return await probeFile(media, ctx);
    const { text, url } = await fetchText(media.url, ctx.signal);
    if (media.kind === 'hls' || text.trimStart().startsWith('#EXTM3U')) return await probeHls(text, url, ctx);
    return probeDash(text, url, ctx);
  } catch (e) {
    return { options: [], error: e instanceof Error ? e.message : String(e) };
  }
}

async function probeFile(media: DetectedMedia, ctx: ProbeContext): Promise<ProbeResult> {
  const info = await probeResource(media.url, ctx.signal);
  const ext = extFromFile(info.url, info.contentType || media.contentType || '');
  const isAudio = /^audio\//.test(info.contentType) || ['mp3', 'm4a', 'ogg'].includes(ext);
  const height = isAudio ? undefined : ctx.videoHeight;
  return {
    options: [
      {
        id: `file:${media.url}`,
        kind: isAudio ? 'audio' : 'video',
        label: isAudio ? 'Audio' : height ? videoLabel(height) : 'Original',
        detail: detail([ext.toUpperCase(), formatBytes(info.size ?? media.size)]),
        badge: qualityBadge(height),
        height,
        sizeBytes: info.size ?? media.size,
        ext,
        engine: 'browser',
        source: { type: 'file', url: media.url, size: info.size },
      },
    ],
  };
}

async function probeHls(text: string, url: string, ctx: ProbeContext): Promise<ProbeResult> {
  const pl = parseHls(text, url);
  if (pl.kind === 'media') {
    if (pl.encryption === 'drm') return { options: [], drm: true };
    if (!pl.endList) return { options: [], live: true };
    const h = ctx.videoHeight;
    return {
      duration: pl.totalDuration,
      options: [
        {
          id: `hls:${url}`,
          kind: 'video',
          label: h ? videoLabel(h) : 'Original',
          detail: detail(['MP4', pl.encryption === 'aes-128' && 'Encrypted (AES)']),
          badge: qualityBadge(h),
          height: h,
          ext: 'mp4',
          engine: 'browser',
          source: { type: 'hls', url, videoUri: url },
        },
      ],
    };
  }
  return masterOptions(pl, url, ctx);
}

async function masterOptions(pl: HlsMaster, url: string, ctx: ProbeContext): Promise<ProbeResult> {
  if (pl.drm) return { options: [], drm: true };

  const audioFor = (group?: string) => {
    const audios = pl.renditions.filter((r) => r.type === 'AUDIO' && r.groupId === group && r.uri);
    return audios.find((r) => r.isDefault) ?? audios[0];
  };
  const videoVariants = pl.variants.filter((v) => v.height || !/^\s*mp4a[^,]*$/i.test(v.codecs ?? ''));

  // Duration (and live/DRM state) from the highest quality media playlist.
  let duration: number | undefined;
  const top = [...videoVariants].sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? pl.variants[0];
  if (top) {
    try {
      const media = parseHls((await fetchText(top.uri, ctx.signal)).text, top.uri);
      if (media.kind === 'media') {
        if (media.encryption === 'drm') return { options: [], drm: true };
        if (!media.endList) return { options: [], live: true };
        duration = media.totalDuration;
      }
    } catch {
      // Sizes are only estimates; carry on without them.
    }
  }

  const rank = ctx.preferCompatible ? COMPAT_RANK : EFFICIENT_RANK;
  const byHeight = new Map<number, (typeof videoVariants)[number]>();
  for (const v of videoVariants) {
    const h = v.height ?? 0;
    const cur = byHeight.get(h);
    const codecRank = (x: typeof v) => rank[describeCodecs(x.codecs).video ?? 'H.264'] ?? 0;
    if (
      !cur ||
      codecRank(v) > codecRank(cur) ||
      (codecRank(v) === codecRank(cur) && v.bandwidth > cur.bandwidth)
    )
      byHeight.set(h, v);
  }

  const options: DownloadOption[] = [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0] || b[1].bandwidth - a[1].bandwidth)
    .map(([h, v], i) => {
      const codecs = describeCodecs(v.codecs);
      const audio = audioFor(v.audioGroup);
      const size = duration ? ((v.averageBandwidth ?? v.bandwidth) / 8) * duration : undefined;
      const label = h ? videoLabel(h, v.frameRate) : `Quality ${i + 1}`;
      return {
        id: `hls:${v.uri}`,
        kind: 'video' as const,
        label,
        detail: detail(['MP4', codecs.video, formatBytes(size, true)]),
        badge: qualityBadge(h),
        height: h || undefined,
        sizeBytes: size,
        ext: 'mp4',
        engine: 'browser' as const,
        source: { type: 'hls' as const, url, videoUri: v.uri, audioUri: audio?.uri },
      };
    });

  // Separate audio renditions, one per language.
  const seen = new Set<string>();
  for (const r of pl.renditions) {
    if (r.type !== 'AUDIO' || !r.uri) continue;
    const key = r.language ?? r.name;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      id: `hls-audio:${r.uri}`,
      kind: 'audio',
      label: 'Audio',
      detail: detail(['M4A', r.name !== 'Audio' && r.name, r.language && r.language !== r.name && r.language]),
      ext: 'm4a',
      engine: 'browser',
      source: { type: 'hls', url, audioUri: r.uri },
    });
  }
  // Audio-only variants (common for radio / podcasts).
  for (const v of pl.variants.filter((x) => !videoVariants.includes(x))) {
    options.push({
      id: `hls-audio:${v.uri}`,
      kind: 'audio',
      label: 'Audio',
      detail: detail(['M4A', `${Math.round(v.bandwidth / 1000)} kbps`]),
      ext: 'm4a',
      engine: 'browser',
      source: { type: 'hls', url, videoUri: undefined, audioUri: v.uri },
    });
  }

  return { options, duration };
}

function probeDash(text: string, url: string, ctx: ProbeContext): ProbeResult {
  const mpd = parseDash(text, url);
  if (mpd.dynamic) return { options: [], live: true };
  const playable = (r: DashRepresentation) => !r.isProtected && !/webm/i.test(r.mimeType);
  const videos = mpd.representations.filter((r) => r.contentType === 'video');
  const audios = mpd.representations.filter((r) => r.contentType === 'audio');
  if ([...videos, ...audios].length && ![...videos, ...audios].some(playable)) {
    const allProtected = [...videos, ...audios].every((r) => r.isProtected);
    return allProtected ? { options: [], drm: true } : { options: [], error: 'WebM streams need the helper app.' };
  }

  const okAudios = audios.filter(playable).sort((a, b) => b.bandwidth - a.bandwidth);
  const mainAudio = okAudios[0];
  const rank = ctx.preferCompatible ? COMPAT_RANK : EFFICIENT_RANK;
  const byHeight = new Map<number, DashRepresentation>();
  for (const v of videos.filter(playable)) {
    const h = v.height ?? 0;
    const cur = byHeight.get(h);
    const r = (x: DashRepresentation) => rank[describeCodecs(x.codecs).video ?? ''] ?? 0;
    if (!cur || r(v) > r(cur) || (r(v) === r(cur) && v.bandwidth > cur.bandwidth)) byHeight.set(h, v);
  }

  const duration = mpd.duration || undefined;
  const options: DownloadOption[] = [...byHeight.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([h, v], i) => {
      const size = duration ? ((v.bandwidth + (mainAudio?.bandwidth ?? 0)) / 8) * duration : undefined;
      return {
        id: `dash:${url}#${v.id}`,
        kind: 'video' as const,
        label: h ? videoLabel(h, v.frameRate) : `Quality ${i + 1}`,
        detail: detail(['MP4', describeCodecs(v.codecs).video, formatBytes(size, true)]),
        badge: qualityBadge(h),
        height: h || undefined,
        sizeBytes: size,
        ext: 'mp4',
        engine: 'browser' as const,
        source: { type: 'dash' as const, url, videoId: v.id, audioId: mainAudio?.id },
      };
    });

  const seenLang = new Set<string>();
  for (const a of okAudios) {
    const key = a.lang ?? a.label ?? '';
    if (seenLang.has(key)) continue;
    seenLang.add(key);
    const size = duration ? (a.bandwidth / 8) * duration : undefined;
    options.push({
      id: `dash-audio:${url}#${a.id}`,
      kind: 'audio',
      label: 'Audio',
      detail: detail(['M4A', a.label ?? (a.lang !== 'und' ? a.lang : undefined), `${Math.round(a.bandwidth / 1000)} kbps`, formatBytes(size, true)]),
      sizeBytes: size,
      ext: 'm4a',
      engine: 'browser',
      source: { type: 'dash', url, audioId: a.id },
    });
  }
  return { options, duration };
}
