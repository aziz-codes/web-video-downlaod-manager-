// MPEG-DASH manifest parser. Covers SegmentTemplate ($Number$ / $Time$,
// with or without SegmentTimeline), SegmentList and SegmentBase.

import { childNamed, childrenNamed, parseXml, type XmlNode } from './xml';
import { resolveUrl } from './hls';

export interface SegRef {
  url: string;
  /** Inclusive byte range. */
  range?: [number, number];
  start: number;
  duration: number;
}

export type DashAddressing =
  | { type: 'list'; init?: SegRef; segments: SegRef[] }
  | { type: 'base'; url: string; indexRange?: [number, number]; initRange?: [number, number] };

export interface DashRepresentation {
  id: string;
  contentType: 'video' | 'audio' | 'text' | 'other';
  mimeType: string;
  codecs: string;
  bandwidth: number;
  width?: number;
  height?: number;
  frameRate?: number;
  lang?: string;
  label?: string;
  isProtected: boolean;
  addressing: DashAddressing;
}

export interface DashManifest {
  dynamic: boolean;
  duration: number;
  representations: DashRepresentation[];
}

export function parseIsoDuration(s: string | undefined): number {
  if (!s) return 0;
  const m = /^-?P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)W)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(
    s.trim(),
  );
  if (!m) return 0;
  const [, y, mo, w, d, h, mi, sec] = m.map((v) => (v ? parseFloat(v) : 0));
  return y * 31536000 + mo * 2592000 + w * 604800 + d * 86400 + h * 3600 + mi * 60 + sec;
}

function parseRange(s: string | undefined): [number, number] | undefined {
  if (!s) return undefined;
  const [a, b] = s.split('-').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : undefined;
}

function parseFrameRate(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const [num, den] = s.split('/').map(Number);
  const v = den ? num / den : num;
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export function fillTemplate(
  template: string,
  vars: { RepresentationID: string; Number?: number; Time?: number; Bandwidth: number },
): string {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)([dxX]))?\$/g, (_, name: string, width, fmt) => {
    if (name === '') return '$';
    const value = vars[name as keyof typeof vars];
    if (value === undefined) return '';
    let str = typeof value === 'number' && fmt && fmt !== 'd' ? value.toString(16) : String(value);
    if (fmt === 'X') str = str.toUpperCase();
    return width ? str.padStart(Number(width), '0') : str;
  });
}

function resolveBase(node: XmlNode, parentBase: string): string {
  const b = childNamed(node, 'BaseURL');
  const text = b?.text.trim();
  return text ? resolveUrl(text, parentBase) : parentBase;
}

/** Merge SegmentTemplate / SegmentList / SegmentBase attributes across hierarchy levels. */
function mergedSegmentInfo(name: string, levels: XmlNode[]): XmlNode | undefined {
  let merged: XmlNode | undefined;
  for (const level of levels) {
    const node = childNamed(level, name);
    if (!node) continue;
    merged = merged
      ? {
          name,
          attrs: { ...merged.attrs, ...node.attrs },
          children: node.children.length ? mergeChildren(merged.children, node.children) : merged.children,
          text: '',
        }
      : node;
  }
  return merged;
}

function mergeChildren(a: XmlNode[], b: XmlNode[]): XmlNode[] {
  const names = new Set(b.map((c) => c.name));
  return [...a.filter((c) => !names.has(c.name)), ...b];
}

function contentTypeOf(as: XmlNode, rep: XmlNode, mime: string, codecs: string): DashRepresentation['contentType'] {
  const ct = rep.attrs.contentType ?? as.attrs.contentType;
  if (ct === 'video' || ct === 'audio' || ct === 'text') return ct;
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || mime.includes('ttml') || mime.includes('vtt')) return 'text';
  if (/avc|hvc|hev|av01|vp0?9/i.test(codecs)) return 'video';
  if (/mp4a|opus|ac-3|ec-3/i.test(codecs)) return 'audio';
  return 'other';
}

function templateSegments(
  tpl: XmlNode,
  repId: string,
  bandwidth: number,
  base: string,
  periodDuration: number,
): { init?: SegRef; segments: SegRef[] } {
  const a = tpl.attrs;
  const timescale = Number(a.timescale) || 1;
  const pto = Number(a.presentationTimeOffset) || 0;
  const startNumber = a.startNumber !== undefined ? Number(a.startNumber) : 1;
  const vars = { RepresentationID: repId, Bandwidth: bandwidth };
  const init = a.initialization
    ? { url: resolveUrl(fillTemplate(a.initialization, vars), base), start: 0, duration: 0 }
    : undefined;
  const media = a.media;
  const segments: SegRef[] = [];
  if (!media) return { init, segments };

  const timeline = childNamed(tpl, 'SegmentTimeline');
  if (timeline) {
    const entries = childrenNamed(timeline, 'S');
    const periodEnd = pto + periodDuration * timescale;
    let t = 0;
    let number = startNumber;
    entries.forEach((s, idx) => {
      if (s.attrs.t !== undefined) t = Number(s.attrs.t);
      const d = Number(s.attrs.d);
      let r = Number(s.attrs.r ?? 0);
      if (r < 0) {
        const nextT = entries[idx + 1]?.attrs.t !== undefined ? Number(entries[idx + 1].attrs.t) : periodEnd;
        r = Math.max(0, Math.ceil((nextT - t) / d) - 1);
      }
      for (let k = 0; k <= r; k++) {
        segments.push({
          url: resolveUrl(fillTemplate(media, { ...vars, Number: number, Time: t }), base),
          start: (t - pto) / timescale,
          duration: d / timescale,
        });
        t += d;
        number++;
      }
    });
    return { init, segments };
  }

  const segDuration = Number(a.duration);
  if (!segDuration || !periodDuration) return { init, segments };
  const count = a.endNumber
    ? Number(a.endNumber) - startNumber + 1
    : Math.ceil((periodDuration * timescale) / segDuration - 1e-6);
  for (let k = 0; k < count; k++) {
    segments.push({
      url: resolveUrl(
        fillTemplate(media, { ...vars, Number: startNumber + k, Time: pto + k * segDuration }),
        base,
      ),
      start: (k * segDuration) / timescale,
      duration: Math.min(segDuration / timescale, periodDuration - (k * segDuration) / timescale),
    });
  }
  return { init, segments };
}

function listSegments(list: XmlNode, base: string, periodDuration: number): { init?: SegRef; segments: SegRef[] } {
  const timescale = Number(list.attrs.timescale) || 1;
  const segDuration = Number(list.attrs.duration) / timescale || 0;
  const initNode = childNamed(list, 'Initialization');
  const init = initNode
    ? {
        url: resolveUrl(initNode.attrs.sourceURL ?? '', base),
        range: parseRange(initNode.attrs.range),
        start: 0,
        duration: 0,
      }
    : undefined;
  const urls = childrenNamed(list, 'SegmentURL');
  const timelineDurations: number[] = [];
  const timeline = childNamed(list, 'SegmentTimeline');
  for (const s of childrenNamed(timeline, 'S')) {
    for (let k = 0; k <= Number(s.attrs.r ?? 0); k++) timelineDurations.push(Number(s.attrs.d) / timescale);
  }
  let start = 0;
  const fallback = urls.length ? periodDuration / urls.length : 0;
  const segments = urls.map((u, i) => {
    const duration = timelineDurations[i] ?? (segDuration || fallback);
    const seg = {
      url: resolveUrl(u.attrs.media ?? '', base),
      range: parseRange(u.attrs.mediaRange),
      start,
      duration,
    };
    start += duration;
    return seg;
  });
  return { init, segments };
}

export function parseDash(text: string, manifestUrl: string): DashManifest {
  const doc = parseXml(text);
  const mpd = childNamed(doc, 'MPD');
  if (!mpd) throw new Error('Not a DASH manifest');
  const dynamic = mpd.attrs.type === 'dynamic';
  const mpdDuration = parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const mpdBase = resolveBase(mpd, manifestUrl);

  const periods = childrenNamed(mpd, 'Period');
  const periodInfo = periods.map((p, i) => {
    const start = parseIsoDuration(p.attrs.start);
    const nextStart = periods[i + 1] ? parseIsoDuration(periods[i + 1].attrs.start) : undefined;
    let duration = parseIsoDuration(p.attrs.duration);
    if (!duration && nextStart !== undefined && nextStart > start) duration = nextStart - start;
    if (!duration && i === periods.length - 1) duration = Math.max(0, mpdDuration - start);
    return { node: p, duration };
  });
  // Multi-period manifests are usually ads around one main period; keep the longest.
  const period = periodInfo.reduce((best, p) => (p.duration > best.duration ? p : best), periodInfo[0]);
  if (!period) return { dynamic, duration: mpdDuration, representations: [] };

  const periodBase = resolveBase(period.node, mpdBase);
  const representations: DashRepresentation[] = [];

  for (const as of childrenNamed(period.node, 'AdaptationSet')) {
    const asBase = resolveBase(as, periodBase);
    const asProtected = childrenNamed(as, 'ContentProtection').length > 0;
    const label = childNamed(as, 'Label')?.text.trim() || as.attrs.label;
    for (const rep of childrenNamed(as, 'Representation')) {
      const id = rep.attrs.id ?? String(representations.length);
      const mimeType = rep.attrs.mimeType ?? as.attrs.mimeType ?? '';
      const codecs = rep.attrs.codecs ?? as.attrs.codecs ?? '';
      const bandwidth = Number(rep.attrs.bandwidth) || 0;
      const base = resolveBase(rep, asBase);
      const levels = [period.node, as, rep];

      let addressing: DashAddressing;
      const tpl = mergedSegmentInfo('SegmentTemplate', levels);
      const list = mergedSegmentInfo('SegmentList', levels);
      const sb = mergedSegmentInfo('SegmentBase', levels);
      if (tpl) {
        addressing = { type: 'list', ...templateSegments(tpl, id, bandwidth, base, period.duration) };
      } else if (list) {
        addressing = { type: 'list', ...listSegments(list, base, period.duration) };
      } else {
        addressing = {
          type: 'base',
          url: base,
          indexRange: parseRange(sb?.attrs.indexRange),
          initRange: parseRange(childNamed(sb, 'Initialization')?.attrs.range),
        };
      }

      representations.push({
        id,
        contentType: contentTypeOf(as, rep, mimeType, codecs),
        mimeType,
        codecs,
        bandwidth,
        width: Number(rep.attrs.width ?? as.attrs.width) || undefined,
        height: Number(rep.attrs.height ?? as.attrs.height) || undefined,
        frameRate: parseFrameRate(rep.attrs.frameRate ?? as.attrs.frameRate),
        lang: as.attrs.lang ?? rep.attrs.lang,
        label,
        isProtected: asProtected || childrenNamed(rep, 'ContentProtection').length > 0,
        addressing,
      });
    }
  }

  return { dynamic, duration: period.duration || mpdDuration, representations };
}

export function isDashText(text: string): boolean {
  return /<MPD[\s>]/.test(text.slice(0, 4096));
}
