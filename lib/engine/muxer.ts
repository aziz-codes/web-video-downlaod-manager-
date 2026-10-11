// Streams fragmented MP4 input (DASH / HLS-fMP4 / transmuxed TS) from one or
// more sources into a single regular (non-fragmented) MP4 file:
//   ftyp | free | mdat (sample data, interleaved as pushed) | moov
// Sample tables are accumulated while streaming and written at the end, so
// memory use stays small no matter how long the video is.

import {
  Bytes,
  box,
  boxBytes,
  childBoxes,
  concat,
  findChild,
  findPath,
  fourcc,
  fullBox,
  i32,
  payloadOf,
  readBoxHeader,
  u16,
  u32,
  u32Table,
  u64,
  type Box,
} from './mp4';

export interface ByteSink {
  write(data: Uint8Array): Promise<void>;
  writeAt(position: number, data: Uint8Array): Promise<void>;
}

export class DrmError extends Error {
  constructor() {
    super('This stream is DRM protected and cannot be downloaded.');
    this.name = 'DrmError';
  }
}

interface Track {
  outId: number;
  timescale: number;
  handler: string;
  tkhd: Uint8Array;
  hdlr: Uint8Array;
  mediaHeader?: Uint8Array;
  dinf?: Uint8Array;
  stsd: Uint8Array;
  language: number;
  sourceMediaTime?: number;
  trex: { duration: number; size: number; flags: number };

  sizes: number[];
  stts: number[];
  ctts: number[];
  negativeCts: boolean;
  sync: number[];
  nonSyncSeen: boolean;
  chunkOffsets: number[];
  stsc: number[];
  sampleCount: number;
  firstDts?: number;
  nextDts: number;
  mediaDuration: number;
  firstCto: number;
}

const MOVIE_TIMESCALE = 1000;
const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

interface SampleRun {
  durations: number[];
  sizes: number[];
  flags: number[];
  ctos: number[];
}

export class Mp4Muxer {
  private tracks: Track[] = [];
  private position = 0;
  private started = false;
  private ftypSize = 0;

  constructor(
    private sink: ByteSink,
    private kind: 'mp4' | 'm4a' = 'mp4',
  ) {}

  createSource(): MuxSource {
    return new MuxSource(this);
  }

  get bytesWritten() {
    return this.position;
  }

  get hasSamples() {
    return this.tracks.some((t) => t.sampleCount > 0);
  }

  /** @internal */
  addTrack(t: Omit<Track, 'outId' | 'sizes' | 'stts' | 'ctts' | 'negativeCts' | 'sync' | 'nonSyncSeen' | 'chunkOffsets' | 'stsc' | 'sampleCount' | 'nextDts' | 'mediaDuration' | 'firstCto'>): Track {
    const track: Track = {
      ...t,
      outId: this.tracks.length + 1,
      sizes: [],
      stts: [],
      ctts: [],
      negativeCts: false,
      sync: [],
      nonSyncSeen: false,
      chunkOffsets: [],
      stsc: [],
      sampleCount: 0,
      nextDts: 0,
      mediaDuration: 0,
      firstCto: 0,
    };
    this.tracks.push(track);
    return track;
  }

  private async start() {
    this.started = true;
    const ftyp =
      this.kind === 'm4a'
        ? box('ftyp', new Bytes().str('M4A ').u32(0).str('M4A isomiso2mp41').done())
        : box('ftyp', new Bytes().str('isom').u32(0x200).str('isomiso2avc1mp41').done());
    this.ftypSize = ftyp.length;
    // "free" is a spare header slot used to upgrade mdat to a 64-bit size if needed.
    const header = concat([ftyp, box('free'), new Bytes().u32(0).str('mdat').done()]);
    await this.sink.write(header);
    this.position = header.length;
  }

  /** @internal */
  async writeRun(track: Track, data: Uint8Array, run: SampleRun, decodeTime: number | undefined) {
    if (!run.sizes.length) return;
    if (!this.started) await this.start();

    if (track.firstDts === undefined) {
      track.firstDts = decodeTime ?? 0;
      track.nextDts = track.firstDts;
      track.firstCto = run.ctos[0] ?? 0;
    } else if (decodeTime !== undefined) {
      // Fill small gaps so tracks stay in sync; large jumps are discontinuities.
      const gap = decodeTime - track.nextDts;
      if (gap > 0 && gap < track.timescale && track.stts.length) {
        extendLastSample(track, gap);
        track.nextDts += gap;
        track.mediaDuration += gap;
      }
    }

    const offset = this.position;
    await this.sink.write(data);
    this.position += data.length;

    track.chunkOffsets.push(offset);
    const chunkIndex = track.chunkOffsets.length;
    const lastSpc = track.stsc.length ? track.stsc[track.stsc.length - 2] : -1;
    if (lastSpc !== run.sizes.length) track.stsc.push(chunkIndex, run.sizes.length, 1);

    for (let i = 0; i < run.sizes.length; i++) {
      track.sampleCount++;
      track.sizes.push(run.sizes[i]);
      pushRle(track.stts, run.durations[i]);
      const cto = run.ctos[i];
      if (cto !== 0 || track.ctts.length) {
        if (!track.ctts.length && track.sampleCount > 1) track.ctts.push(track.sampleCount - 1, 0);
        pushRle(track.ctts, cto);
        if (cto < 0) track.negativeCts = true;
      }
      if (run.flags[i] & 0x10000) track.nonSyncSeen = true;
      else track.sync.push(track.sampleCount);
      track.nextDts += run.durations[i];
      track.mediaDuration += run.durations[i];
    }
  }

  /** Writes the moov box and fixes up the mdat size. Returns the final file size. */
  async finalize(meta: { title?: string } = {}): Promise<number> {
    const tracks = this.tracks.filter((t) => t.sampleCount > 0);
    if (!tracks.length || !this.started) throw new Error('No media samples were received');

    const mediaTime = (t: Track) =>
      t.sourceMediaTime ?? (t.handler === 'vide' && t.firstCto > 0 ? t.firstCto : 0);
    const presStart = (t: Track) => ((t.firstDts ?? 0) + mediaTime(t)) / t.timescale;
    const origin = Math.min(...tracks.map(presStart));

    let movieDuration = 0;
    const traks = tracks.map((t, idx) => {
      t.outId = idx + 1;
      const delay = Math.round((presStart(t) - origin) * MOVIE_TIMESCALE);
      // Video media_time compensates B-frame reordering, so the whole media
      // duration is still presented; audio media_time skips encoder priming.
      const presented = t.handler === 'vide' ? t.mediaDuration : t.mediaDuration - mediaTime(t);
      const editDuration = Math.max(0, Math.round((presented / t.timescale) * MOVIE_TIMESCALE));
      movieDuration = Math.max(movieDuration, delay + editDuration);
      return this.buildTrak(t, delay, editDuration, mediaTime(t));
    });

    const mvhd = buildMvhd(movieDuration, tracks.length + 1);
    const udta = meta.title ? buildUdta(meta.title) : new Uint8Array(0);
    const moov = box('moov', mvhd, ...traks, udta);

    const dataEnd = this.position;
    await this.sink.write(moov);
    this.position += moov.length;

    const mdatStart = this.ftypSize + 8;
    const mdatSize = dataEnd - mdatStart;
    if (mdatSize <= 0xffffffff) {
      await this.sink.writeAt(mdatStart, new Bytes().u32(mdatSize).done());
    } else {
      await this.sink.writeAt(
        this.ftypSize,
        new Bytes().u32(1).str('mdat').u64(dataEnd - this.ftypSize).done(),
      );
    }
    return this.position;
  }

  private buildTrak(t: Track, delay: number, editDuration: number, mediaTime: number): Uint8Array {
    const trackDuration = delay + editDuration;

    // tkhd: rebuilt with the new track ID and duration, keeping the source tail
    // (layer, volume, matrix, width, height).
    const src = t.tkhd;
    const srcVersion = src[8];
    const srcFlags = u32(src, 8) & 0xffffff;
    const tail = src.subarray(8 + (srcVersion === 1 ? 36 : 24), 8 + (srcVersion === 1 ? 96 : 84));
    const tkhdV = trackDuration > 0xffffffff ? 1 : 0;
    const tkhdBody = new Bytes();
    if (tkhdV) tkhdBody.u64(0).u64(0).u32(t.outId).u32(0).u64(trackDuration);
    else tkhdBody.u32(0).u32(0).u32(t.outId).u32(0).u32(trackDuration);
    const tkhd = fullBox('tkhd', tkhdV, srcFlags | 0x3, tkhdBody.bytes(tail).done());

    const entries: Array<[number, number]> = [];
    if (delay > 0) entries.push([delay, -1]);
    entries.push([editDuration, mediaTime]);
    const elstV = entries.some(([d, m]) => d > 0xffffffff || m > 0x7fffffff) ? 1 : 0;
    const elstBody = new Bytes().u32(entries.length);
    for (const [d, m] of entries) {
      if (elstV) {
        elstBody.u64(d);
        if (m < 0) elstBody.u32(0xffffffff).u32(0xffffffff);
        else elstBody.u64(m);
      } else elstBody.u32(d).u32(m < 0 ? 0xffffffff : m);
      elstBody.u16(1).u16(0);
    }
    const edts = box('edts', fullBox('elst', elstV, 0, elstBody.done()));

    const mdhdV = t.mediaDuration > 0xffffffff ? 1 : 0;
    const mdhdBody = new Bytes();
    if (mdhdV) mdhdBody.u64(0).u64(0).u32(t.timescale).u64(t.mediaDuration);
    else mdhdBody.u32(0).u32(0).u32(t.timescale).u32(t.mediaDuration);
    const mdhd = fullBox('mdhd', mdhdV, 0, mdhdBody.u16(t.language).u16(0).done());

    const dinf = t.dinf ?? box('dinf', fullBox('dref', 0, 0, new Bytes().u32(1).done(), fullBox('url ', 0, 1)));

    const useCo64 = t.chunkOffsets.some((o) => o > 0xffffffff);
    let chunkBox: Uint8Array;
    if (useCo64) {
      const b = new Bytes().u32(t.chunkOffsets.length);
      for (const o of t.chunkOffsets) b.u64(o);
      chunkBox = fullBox('co64', 0, 0, b.done());
    } else {
      chunkBox = fullBox('stco', 0, 0, u32Table(t.chunkOffsets, [t.chunkOffsets.length]));
    }

    const stblChildren = [
      t.stsd,
      fullBox('stts', 0, 0, u32Table(t.stts, [t.stts.length / 2])),
    ];
    if (t.ctts.length) {
      const ctts = t.ctts.map((v, i) => (i % 2 === 1 ? v >>> 0 : v));
      stblChildren.push(fullBox('ctts', t.negativeCts ? 1 : 0, 0, u32Table(ctts, [ctts.length / 2])));
    }
    if (t.nonSyncSeen) stblChildren.push(fullBox('stss', 0, 0, u32Table(t.sync, [t.sync.length])));
    stblChildren.push(
      fullBox('stsc', 0, 0, u32Table(t.stsc, [t.stsc.length / 3])),
      fullBox('stsz', 0, 0, u32Table(t.sizes, [0, t.sizes.length])),
      chunkBox,
    );

    const minf = box('minf', ...(t.mediaHeader ? [t.mediaHeader] : []), dinf, box('stbl', ...stblChildren));
    return box('trak', tkhd, edts, box('mdia', mdhd, t.hdlr, minf));
  }
}

function pushRle(table: number[], value: number) {
  const n = table.length;
  if (n && table[n - 1] === value) table[n - 2]++;
  else table.push(1, value);
}

function extendLastSample(track: Track, extra: number) {
  const n = track.stts.length;
  const delta = track.stts[n - 1];
  if (track.stts[n - 2] > 1) {
    track.stts[n - 2]--;
    track.stts.push(1, delta + extra);
  } else {
    track.stts[n - 1] = delta + extra;
  }
}

function buildMvhd(duration: number, nextTrackId: number): Uint8Array {
  const v = duration > 0xffffffff ? 1 : 0;
  const b = new Bytes();
  if (v) b.u64(0).u64(0).u32(MOVIE_TIMESCALE).u64(duration);
  else b.u32(0).u32(0).u32(MOVIE_TIMESCALE).u32(duration);
  b.u32(0x00010000).u16(0x0100).zeros(10);
  for (const m of IDENTITY_MATRIX) b.u32(m);
  b.zeros(24).u32(nextTrackId);
  return fullBox('mvhd', v, 0, b.done());
}

function buildUdta(title: string): Uint8Array {
  const text = new TextEncoder().encode(title);
  const data = box('data', new Bytes().u32(1).u32(0).done(), text);
  const hdlr = fullBox('hdlr', 0, 0, new Bytes().u32(0).str('mdir').str('appl').zeros(9).done());
  const ilst = box('ilst', box('©nam', data));
  return box('udta', fullBox('meta', 0, 0, hdlr, ilst));
}

/** One input byte stream of fragmented MP4 (init segment followed by moof/mdat pairs). */
export class MuxSource {
  private buf: Uint8Array = new Uint8Array(0);
  /** Stream position of buf[0]. */
  private bufPos = 0;
  private tracks = new Map<number, Track>();
  private hasInit = false;
  private pendingMoof?: { bytes: Uint8Array; pos: number };

  constructor(private muxer: Mp4Muxer) {}

  get initialized() {
    return this.hasInit;
  }

  async push(data: Uint8Array) {
    if (this.buf.length) {
      this.buf = concat([this.buf, data]);
    } else {
      this.buf = data;
    }
    let offset = 0;
    for (;;) {
      const header = readBoxHeader(this.buf, offset);
      if (!header || offset + header.size > this.buf.length) break;
      const bytes = this.buf.subarray(offset, offset + header.size);
      await this.handleBox(header.type, bytes, this.bufPos + offset);
      offset += header.size;
    }
    // Copy the remainder so the consumed segment can be garbage collected.
    this.buf = this.buf.slice(offset);
    this.bufPos += offset;
  }

  private async handleBox(type: string, bytes: Uint8Array, pos: number) {
    if (type === 'moov') {
      if (!this.hasInit) this.parseInit(bytes);
    } else if (type === 'moof') {
      this.pendingMoof = { bytes, pos };
    } else if (type === 'mdat') {
      if (!this.pendingMoof) return;
      const moof = this.pendingMoof;
      this.pendingMoof = undefined;
      await this.processFragment(moof.bytes, moof.pos, bytes, pos);
    }
  }

  private parseInit(moov: Uint8Array) {
    const root = readBoxHeader(moov, 0)!;
    const children = childBoxes(moov, root);

    const trex = new Map<number, Track['trex']>();
    const mvex = children.find((b) => b.type === 'mvex');
    if (mvex) {
      for (const t of childBoxes(moov, mvex).filter((b) => b.type === 'trex')) {
        const p = payloadOf(t);
        trex.set(u32(moov, p + 4), {
          duration: u32(moov, p + 12),
          size: u32(moov, p + 16),
          flags: u32(moov, p + 20),
        });
      }
    }

    for (const trak of children.filter((b) => b.type === 'trak')) {
      const tkhd = findChild(moov, trak, 'tkhd');
      const mdia = findChild(moov, trak, 'mdia');
      const mdhd = mdia && findChild(moov, mdia, 'mdhd');
      const hdlr = mdia && findChild(moov, mdia, 'hdlr');
      const minf = mdia && findChild(moov, mdia, 'minf');
      const stsd = minf && findPath(moov, minf, ['stbl', 'stsd']);
      if (!tkhd || !mdhd || !hdlr || !minf || !stsd) continue;

      const tp = payloadOf(tkhd);
      const srcId = moov[tp] === 1 ? u32(moov, tp + 20) : u32(moov, tp + 12);
      const mp = payloadOf(mdhd);
      const mdhdV1 = moov[mp] === 1;
      const timescale = u32(moov, mp + (mdhdV1 ? 20 : 12));
      const language = u16(moov, mp + (mdhdV1 ? 32 : 20));
      const handler = fourcc(moov, payloadOf(hdlr) + 8);

      const sampleEntry = readBoxHeader(moov, payloadOf(stsd) + 8);
      if (sampleEntry && ['encv', 'enca', 'enct', 'drmi', 'drms'].includes(sampleEntry.type)) throw new DrmError();

      const minfChildren = childBoxes(moov, minf);
      const mediaHeader = minfChildren.find((b) => ['vmhd', 'smhd', 'sthd', 'nmhd', 'hmhd'].includes(b.type));
      const dinf = minfChildren.find((b) => b.type === 'dinf');

      let sourceMediaTime: number | undefined;
      const elst = findPath(moov, trak, ['edts', 'elst']);
      if (elst) sourceMediaTime = firstMediaTime(moov, elst);

      const track = this.muxer.addTrack({
        timescale,
        handler,
        tkhd: boxBytes(moov, tkhd).slice(),
        hdlr: boxBytes(moov, hdlr).slice(),
        mediaHeader: mediaHeader && boxBytes(moov, mediaHeader).slice(),
        dinf: dinf && boxBytes(moov, dinf).slice(),
        stsd: boxBytes(moov, stsd).slice(),
        language,
        sourceMediaTime,
        trex: trex.get(srcId) ?? { duration: 0, size: 0, flags: 0 },
      });
      this.tracks.set(srcId, track);
    }
    this.hasInit = true;
  }

  private async processFragment(moof: Uint8Array, moofPos: number, mdat: Uint8Array, mdatPos: number) {
    const mdatHeader = readBoxHeader(mdat, 0)!;
    const payloadPos = mdatPos + mdatHeader.headerSize;
    const payloadLen = mdat.length - mdatHeader.headerSize;
    const root = readBoxHeader(moof, 0)!;

    let prevTrafEnd: number | undefined;
    let trafIndex = 0;
    for (const traf of childBoxes(moof, root).filter((b) => b.type === 'traf')) {
      const kids = childBoxes(moof, traf);
      const tfhd = kids.find((b) => b.type === 'tfhd');
      if (!tfhd) continue;
      const hp = payloadOf(tfhd);
      const tfFlags = u32(moof, hp) & 0xffffff;
      const trackId = u32(moof, hp + 4);
      let o = hp + 8;
      let baseDataOffset: number | undefined;
      if (tfFlags & 0x1) {
        baseDataOffset = u64(moof, o);
        o += 8;
      }
      if (tfFlags & 0x2) o += 4;
      const track = this.tracks.get(trackId);
      const defDuration = tfFlags & 0x8 ? u32(moof, (o += 4) - 4) : track?.trex.duration ?? 0;
      const defSize = tfFlags & 0x10 ? u32(moof, (o += 4) - 4) : track?.trex.size ?? 0;
      const defFlags = tfFlags & 0x20 ? u32(moof, (o += 4) - 4) : track?.trex.flags ?? 0;

      const tfdt = kids.find((b) => b.type === 'tfdt');
      let decodeTime: number | undefined;
      if (tfdt) {
        const p = payloadOf(tfdt);
        decodeTime = moof[p] === 1 ? u64(moof, p + 4) : u32(moof, p + 4);
      }

      const base =
        baseDataOffset !== undefined
          ? baseDataOffset
          : tfFlags & 0x20000 || trafIndex === 0
            ? moofPos
            : (prevTrafEnd ?? moofPos);
      let dataPos = base;

      for (const trun of kids.filter((b) => b.type === 'trun')) {
        const rp = payloadOf(trun);
        const trFlags = u32(moof, rp) & 0xffffff;
        const count = u32(moof, rp + 4);
        let q = rp + 8;
        if (trFlags & 0x1) {
          dataPos = base + i32(moof, q);
          q += 4;
        }
        let firstFlags: number | undefined;
        if (trFlags & 0x4) {
          firstFlags = u32(moof, q);
          q += 4;
        }
        const run: SampleRun = { durations: [], sizes: [], flags: [], ctos: [] };
        let total = 0;
        for (let i = 0; i < count; i++) {
          const d = trFlags & 0x100 ? u32(moof, (q += 4) - 4) : defDuration;
          const s = trFlags & 0x200 ? u32(moof, (q += 4) - 4) : defSize;
          const f = trFlags & 0x400 ? u32(moof, (q += 4) - 4) : i === 0 && firstFlags !== undefined ? firstFlags : defFlags;
          const c = trFlags & 0x800 ? i32(moof, (q += 4) - 4) : 0;
          run.durations.push(d);
          run.sizes.push(s);
          run.flags.push(f);
          run.ctos.push(c);
          total += s;
        }

        let rel = dataPos - payloadPos;
        if ((rel < 0 || rel + total > payloadLen) && baseDataOffset !== undefined) {
          // base_data_offset is relative to the original segment file, not our
          // concatenated stream; fall back to the moof as the base.
          rel = moofPos + (dataPos - base) - payloadPos;
        }
        if (rel < 0 || rel + total > payloadLen) throw new Error('Unsupported MP4 fragment layout');

        if (track) {
          await this.muxer.writeRun(track, mdat.subarray(mdatHeader.headerSize + rel, mdatHeader.headerSize + rel + total), run, decodeTime);
        }
        if (decodeTime !== undefined) decodeTime += run.durations.reduce((a, b) => a + b, 0);
        dataPos += total;
      }
      prevTrafEnd = dataPos;
      trafIndex++;
    }
  }
}

function firstMediaTime(buf: Uint8Array, elst: Box): number | undefined {
  const p = payloadOf(elst);
  const v = buf[p];
  const count = u32(buf, p + 4);
  let o = p + 8;
  for (let i = 0; i < count; i++) {
    const mediaTime = v === 1 ? u64(buf, o + 8) : i32(buf, o + 4);
    const isEmpty = v === 1 ? u32(buf, o + 8) === 0xffffffff && u32(buf, o + 12) === 0xffffffff : mediaTime === -1;
    if (!isEmpty) return mediaTime;
    o += v === 1 ? 20 : 12;
  }
  return undefined;
}

