// Turns a chosen source (HLS variant, DASH representations, plain file) into a
// list of byte fetches the runner can execute.

import type { BrowserSource } from '../types';
import { parseDash, type DashRepresentation, type SegRef } from './dash';
import { parseHls, sequenceIv, type HlsMedia } from './hls';
import { parseSidx, readBoxes } from './mp4';
import { fetchBytes, fetchText, probeResource } from './net';

export interface SegTask {
  url: string;
  range?: [number, number];
  start: number;
  duration: number;
  key?: { uri: string; iv: Uint8Array };
  discontinuity?: boolean;
  /** Progress weight; defaults to duration. */
  weight?: number;
}

export interface PlanTrack {
  kind: 'fmp4' | 'ts';
  init?: SegTask;
  segments: SegTask[];
}

export type Plan =
  | { type: 'mux'; container: 'mp4' | 'm4a'; tracks: PlanTrack[]; duration: number; estimatedBytes?: number }
  | { type: 'file'; url: string; size?: number; rangeable: boolean; ext: string };

export class PlanError extends Error {
  constructor(
    message: string,
    public reason: 'drm' | 'live' | 'unsupported',
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

const CHUNK = 4 * 1024 * 1024;

export async function buildPlan(source: BrowserSource, signal?: AbortSignal): Promise<Plan> {
  if (source.type === 'file') {
    const info = await probeResource(source.url, signal);
    return {
      type: 'file',
      url: info.url,
      size: info.size,
      rangeable: info.rangeable && !!info.size,
      ext: extFromFile(info.url, info.contentType),
    };
  }
  if (source.type === 'hls') return hlsPlan(source, signal);
  return dashPlan(source, signal);
}

export function extFromFile(url: string, contentType: string): string {
  const fromType: Record<string, string> = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'video/x-flv': 'flv',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
  };
  const ct = contentType.split(';')[0].trim().toLowerCase();
  if (fromType[ct]) return fromType[ct];
  const m = /\.(mp4|m4v|webm|mov|mkv|flv|m4a|mp3|ogg|ogv)(?:$|[?#])/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase().replace('m4v', 'mp4').replace('ogv', 'ogg') : 'mp4';
}

// ---- HLS ------------------------------------------------------------------

async function loadMedia(url: string, signal?: AbortSignal): Promise<HlsMedia> {
  const { text, url: finalUrl } = await fetchText(url, signal);
  const pl = parseHls(text, finalUrl);
  if (pl.kind !== 'media') throw new PlanError('Expected an HLS media playlist', 'unsupported');
  if (pl.encryption === 'drm') throw new PlanError('This stream is DRM protected and cannot be downloaded.', 'drm');
  if (pl.encryption === 'unsupported')
    throw new PlanError('This stream uses SAMPLE-AES encryption, which the browser engine cannot decrypt.', 'unsupported');
  if (!pl.endList)
    throw new PlanError('This is a live stream. Live recording needs the helper app.', 'live');
  return pl;
}

function hlsTrack(pl: HlsMedia): PlanTrack {
  const first = pl.segments[0];
  const isFmp4 = !!first?.map || /\.(m4s|mp4|m4v|m4a|cmfv|cmfa)(?:$|\?)/i.test(first?.uri ?? '');
  const toTask = (s: HlsMedia['segments'][number]): SegTask => ({
    url: s.uri,
    range: s.byteRange ? [s.byteRange.offset, s.byteRange.offset + s.byteRange.length - 1] : undefined,
    start: s.start,
    duration: s.duration,
    key: s.key?.method === 'AES-128' && s.key.uri ? { uri: s.key.uri, iv: s.key.iv ?? sequenceIv(s.mediaSequence) } : undefined,
    discontinuity: s.discontinuity,
  });
  const map = first?.map;
  return {
    kind: isFmp4 ? 'fmp4' : 'ts',
    init: map
      ? {
          url: map.uri,
          range: map.byteRange ? [map.byteRange.offset, map.byteRange.offset + map.byteRange.length - 1] : undefined,
          start: -1,
          duration: 0,
        }
      : undefined,
    segments: pl.segments.map(toTask),
  };
}

async function hlsPlan(source: Extract<BrowserSource, { type: 'hls' }>, signal?: AbortSignal): Promise<Plan> {
  let videoUri = source.videoUri;
  let audioUri = source.audioUri;
  let bandwidth = 0;

  if (!videoUri && !audioUri) {
    // Resolve the playlist and pick the best variant if a master was given.
    const { text, url } = await fetchText(source.url, signal);
    const pl = parseHls(text, url);
    if (pl.kind === 'media') videoUri = url;
    else {
      const best = [...pl.variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
      if (!best) throw new PlanError('The playlist has no playable variants', 'unsupported');
      videoUri = best.uri;
      bandwidth = best.bandwidth;
      const audio = pl.renditions.find((r) => r.type === 'AUDIO' && r.groupId === best.audioGroup && r.isDefault && r.uri);
      audioUri = audio?.uri;
    }
  }

  const tracks: PlanTrack[] = [];
  let duration = 0;
  if (videoUri) {
    const pl = await loadMedia(videoUri, signal);
    tracks.push(hlsTrack(pl));
    duration = pl.totalDuration;
  }
  if (audioUri && audioUri !== videoUri) {
    const pl = await loadMedia(audioUri, signal);
    tracks.push(hlsTrack(pl));
    duration = Math.max(duration, pl.totalDuration);
  }
  return {
    type: 'mux',
    container: videoUri ? 'mp4' : 'm4a',
    tracks,
    duration,
    estimatedBytes: bandwidth ? (bandwidth / 8) * duration : undefined,
  };
}

// ---- DASH -----------------------------------------------------------------

async function dashTrack(rep: DashRepresentation, totalDuration: number, signal?: AbortSignal): Promise<PlanTrack> {
  if (rep.isProtected) throw new PlanError('This stream is DRM protected and cannot be downloaded.', 'drm');
  if (!/mp4/i.test(rep.mimeType) && /webm/i.test(rep.mimeType))
    throw new PlanError('WebM streams need the helper app to download.', 'unsupported');

  const toTask = (s: SegRef): SegTask => ({ url: s.url, range: s.range, start: s.start, duration: s.duration });
  const a = rep.addressing;
  if (a.type === 'list') {
    return { kind: 'fmp4', init: a.init && { ...toTask(a.init), start: -1 }, segments: a.segments.map(toTask) };
  }

  // SegmentBase: read the index (sidx) to find fragment byte ranges.
  const headEnd = Math.max(a.indexRange?.[1] ?? 0, a.initRange?.[1] ?? 0, a.indexRange ? 0 : 64 * 1024 - 1);
  const head = await fetchBytes(a.url, { range: [0, headEnd], signal });
  const boxes = readBoxes(head);
  const sidx = boxes.find((b) => b.type === 'sidx');
  const moov = boxes.find((b) => b.type === 'moov');
  if (sidx && moov) {
    const refs = parseSidx(head, sidx, sidx.start);
    return {
      kind: 'fmp4',
      init: { url: a.url, range: [0, moov.start + moov.size - 1], start: -1, duration: 0 },
      segments: refs.map((r) => ({ url: a.url, range: r.range, start: r.start, duration: r.duration })),
    };
  }

  // No index: stream the whole file in byte chunks.
  const info = await probeResource(a.url, signal);
  if (!info.size || !info.rangeable) {
    return { kind: 'fmp4', segments: [{ url: a.url, start: 0, duration: totalDuration || 1 }] };
  }
  const segments: SegTask[] = [];
  for (let off = 0; off < info.size; off += CHUNK) {
    const end = Math.min(info.size, off + CHUNK) - 1;
    segments.push({
      url: a.url,
      range: [off, end],
      start: (off / info.size) * (totalDuration || 1),
      duration: ((end - off + 1) / info.size) * (totalDuration || 1),
    });
  }
  return { kind: 'fmp4', segments };
}

async function dashPlan(source: Extract<BrowserSource, { type: 'dash' }>, signal?: AbortSignal): Promise<Plan> {
  const { text, url } = await fetchText(source.url, signal);
  const mpd = parseDash(text, url);
  if (mpd.dynamic) throw new PlanError('This is a live stream. Live recording needs the helper app.', 'live');

  const byId = (id?: string) => (id ? mpd.representations.find((r) => r.id === id) : undefined);
  const video = byId(source.videoId);
  const audio = byId(source.audioId);
  if (!video && !audio) throw new PlanError('The selected quality is no longer in the manifest', 'unsupported');

  const tracks: PlanTrack[] = [];
  if (video) tracks.push(await dashTrack(video, mpd.duration, signal));
  if (audio) tracks.push(await dashTrack(audio, mpd.duration, signal));
  const bandwidth = (video?.bandwidth ?? 0) + (audio?.bandwidth ?? 0);
  return {
    type: 'mux',
    container: video ? 'mp4' : 'm4a',
    tracks,
    duration: mpd.duration,
    estimatedBytes: bandwidth ? (bandwidth / 8) * mpd.duration : undefined,
  };
}

export function fileChunks(size: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let off = 0; off < size; off += CHUNK) out.push([off, Math.min(size, off + CHUNK) - 1]);
  return out;
}
