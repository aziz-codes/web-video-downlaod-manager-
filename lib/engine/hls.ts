// HLS playlist parser (RFC 8216 plus common extensions).

export interface ByteRange {
  offset: number;
  length: number;
}

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  averageBandwidth?: number;
  width?: number;
  height?: number;
  codecs?: string;
  frameRate?: number;
  audioGroup?: string;
}

export interface HlsRendition {
  type: string;
  groupId: string;
  name: string;
  language?: string;
  isDefault: boolean;
  uri?: string;
  channels?: string;
}

export interface HlsMaster {
  kind: 'master';
  variants: HlsVariant[];
  renditions: HlsRendition[];
  /** True when an EXT-X-SESSION-KEY points to a DRM system. */
  drm: boolean;
}

export interface HlsKey {
  method: string;
  uri?: string;
  iv?: Uint8Array;
  keyFormat?: string;
}

export interface HlsSegment {
  uri: string;
  duration: number;
  start: number;
  byteRange?: ByteRange;
  key?: HlsKey;
  map?: { uri: string; byteRange?: ByteRange };
  mediaSequence: number;
  discontinuity: boolean;
}

export type Encryption = 'none' | 'aes-128' | 'drm' | 'unsupported';

export interface HlsMedia {
  kind: 'media';
  segments: HlsSegment[];
  targetDuration: number;
  endList: boolean;
  totalDuration: number;
  encryption: Encryption;
}

export type HlsPlaylist = HlsMaster | HlsMedia;

const DRM_KEY_FORMATS = ['com.apple.streamingkeydelivery', 'urn:uuid:', 'com.microsoft.playready', 'com.widevine'];

export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    let v = m[2];
    if (v.startsWith('"')) v = v.slice(1, -1);
    out[m[1].toUpperCase()] = v;
  }
  return out;
}

export function resolveUrl(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

function parseByteRange(s: string, lastEnd: number | undefined): ByteRange {
  const [len, off] = s.split('@');
  return { length: Number(len), offset: off !== undefined ? Number(off) : (lastEnd ?? 0) };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, '').padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function sequenceIv(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  let n = seq;
  for (let i = 15; i >= 8 && n > 0; i--) {
    iv[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return iv;
}

function isDrmKey(key: HlsKey): boolean {
  const fmt = key.keyFormat?.toLowerCase() ?? 'identity';
  return fmt !== 'identity' && DRM_KEY_FORMATS.some((d) => fmt.startsWith(d));
}

export function isHlsText(text: string): boolean {
  return text.trimStart().startsWith('#EXTM3U');
}

export function parseHls(text: string, baseUrl: string): HlsPlaylist {
  if (!isHlsText(text)) throw new Error('Not an HLS playlist');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: HlsVariant[] = [];
    const renditions: HlsRendition[] = [];
    let drm = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttributes(line.slice(18));
        let uri = lines[i + 1];
        while (uri && uri.startsWith('#')) uri = lines[++i + 1];
        if (!uri) continue;
        i++;
        const [w, h] = (a.RESOLUTION ?? '').split('x').map(Number);
        variants.push({
          uri: resolveUrl(uri, baseUrl),
          bandwidth: Number(a.BANDWIDTH) || 0,
          averageBandwidth: Number(a['AVERAGE-BANDWIDTH']) || undefined,
          width: w || undefined,
          height: h || undefined,
          codecs: a.CODECS,
          frameRate: Number(a['FRAME-RATE']) || undefined,
          audioGroup: a.AUDIO,
        });
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttributes(line.slice(13));
        renditions.push({
          type: a.TYPE,
          groupId: a['GROUP-ID'],
          name: a.NAME ?? a.LANGUAGE ?? 'Audio',
          language: a.LANGUAGE,
          isDefault: a.DEFAULT === 'YES',
          uri: a.URI ? resolveUrl(a.URI, baseUrl) : undefined,
          channels: a.CHANNELS,
        });
      } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
        const a = parseAttributes(line.slice(19));
        if (isDrmKey({ method: a.METHOD, keyFormat: a.KEYFORMAT })) drm = true;
      }
    }
    return { kind: 'master', variants, renditions, drm };
  }

  const segments: HlsSegment[] = [];
  let targetDuration = 0;
  let mediaSequence = 0;
  let endList = false;
  let duration = 0;
  let byteRange: string | undefined;
  let lastRangeEnd: number | undefined;
  let lastRangeUri: string | undefined;
  let key: HlsKey | undefined;
  let map: HlsSegment['map'];
  let discontinuity = false;
  let start = 0;
  let encryption: Encryption = 'none';

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8));
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice(22));
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice(22));
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byteRange = line.slice(17);
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice(11));
      const method = (a.METHOD ?? 'NONE').toUpperCase();
      if (method === 'NONE') {
        key = undefined;
        continue;
      }
      key = {
        method,
        uri: a.URI ? resolveUrl(a.URI, baseUrl) : undefined,
        iv: a.IV ? hexToBytes(a.IV) : undefined,
        keyFormat: a.KEYFORMAT,
      };
      if (isDrmKey(key)) encryption = 'drm';
      else if (method === 'AES-128') encryption = encryption === 'none' ? 'aes-128' : encryption;
      else if (encryption !== 'drm') encryption = 'unsupported';
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      map = {
        uri: resolveUrl(a.URI, baseUrl),
        byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : undefined,
      };
    } else if (!line.startsWith('#')) {
      const uri = resolveUrl(line, baseUrl);
      let range: ByteRange | undefined;
      if (byteRange) {
        range = parseByteRange(byteRange, lastRangeUri === uri ? lastRangeEnd : 0);
        lastRangeEnd = range.offset + range.length;
        lastRangeUri = uri;
      }
      segments.push({
        uri,
        duration,
        start,
        byteRange: range,
        key,
        map,
        mediaSequence: mediaSequence + segments.length,
        discontinuity,
      });
      start += duration;
      duration = 0;
      byteRange = undefined;
      discontinuity = false;
    }
  }

  return { kind: 'media', segments, targetDuration, endList, totalDuration: start, encryption };
}

/** Human readable codec family from an RFC 6381 codecs string. */
export function describeCodecs(codecs: string | undefined): { video?: string; audio?: string } {
  if (!codecs) return {};
  const out: { video?: string; audio?: string } = {};
  for (const c of codecs.split(',').map((s) => s.trim().toLowerCase())) {
    if (c.startsWith('avc')) out.video = 'H.264';
    else if (c.startsWith('hvc') || c.startsWith('hev')) out.video = 'H.265';
    else if (c.startsWith('av01')) out.video = 'AV1';
    else if (c.startsWith('vp09') || c === 'vp9') out.video = 'VP9';
    else if (c.startsWith('mp4a')) out.audio = 'AAC';
    else if (c.startsWith('ac-3')) out.audio = 'AC-3';
    else if (c.startsWith('ec-3')) out.audio = 'E-AC-3';
    else if (c === 'opus') out.audio = 'Opus';
  }
  return out;
}
