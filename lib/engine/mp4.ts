// ISO-BMFF (MP4) box reading and writing helpers.

export interface Box {
  type: string;
  /** Offset of the box header within the buffer. */
  start: number;
  /** Total box size including header. */
  size: number;
  headerSize: number;
}

export const u8 = (b: Uint8Array, o: number) => b[o];
export const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
export const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const i32 = (b: Uint8Array, o: number) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
export const u64 = (b: Uint8Array, o: number) => u32(b, o) * 0x100000000 + u32(b, o + 4);
export const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export function setU32(b: Uint8Array, o: number, v: number) {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

export function setU64(b: Uint8Array, o: number, v: number) {
  setU32(b, o, Math.floor(v / 0x100000000));
  setU32(b, o + 4, v >>> 0);
}

/** Reads the header of the box at `offset`, or undefined when incomplete. */
export function readBoxHeader(buf: Uint8Array, offset: number, end = buf.length): Box | undefined {
  if (end - offset < 8) return undefined;
  let size = u32(buf, offset);
  const type = fourcc(buf, offset + 4);
  let headerSize = 8;
  if (size === 1) {
    if (end - offset < 16) return undefined;
    size = u64(buf, offset + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }
  if (size < headerSize) throw new Error(`Corrupt MP4 box "${type}" (size ${size})`);
  return { type, start: offset, size, headerSize };
}

export function readBoxes(buf: Uint8Array, start = 0, end = buf.length): Box[] {
  const boxes: Box[] = [];
  let o = start;
  while (o < end) {
    const box = readBoxHeader(buf, o, end);
    if (!box || box.start + box.size > end) break;
    boxes.push(box);
    o += box.size;
  }
  return boxes;
}

export const payloadOf = (box: Box) => box.start + box.headerSize;

export function childBoxes(buf: Uint8Array, box: Box): Box[] {
  return readBoxes(buf, payloadOf(box), box.start + box.size);
}

export function findChild(buf: Uint8Array, box: Box, type: string): Box | undefined {
  return childBoxes(buf, box).find((b) => b.type === type);
}

export function findPath(buf: Uint8Array, box: Box, path: string[]): Box | undefined {
  let cur: Box | undefined = box;
  for (const t of path) {
    if (!cur) return undefined;
    cur = findChild(buf, cur, t);
  }
  return cur;
}

export const boxBytes = (buf: Uint8Array, box: Box) => buf.subarray(box.start, box.start + box.size);

// ---- Writing --------------------------------------------------------------

export function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function box(type: string, ...children: Uint8Array[]): Uint8Array {
  const body = concat(children);
  const out = new Uint8Array(8 + body.length);
  setU32(out, 0, out.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

export function fullBox(type: string, version: number, flags: number, ...children: Uint8Array[]): Uint8Array {
  const vf = new Uint8Array(4);
  setU32(vf, 0, ((version & 0xff) << 24) | (flags & 0xffffff));
  return box(type, vf, ...children);
}

/** Big-endian field writer. */
export class Bytes {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    this.parts.push((v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  u32(v: number) {
    this.parts.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }
  u64(v: number) {
    return this.u32(Math.floor(v / 0x100000000)).u32(v >>> 0);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.parts.push(s.charCodeAt(i) & 0xff);
    return this;
  }
  bytes(b: Uint8Array) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
    return this;
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.parts.push(0);
    return this;
  }
  done() {
    return Uint8Array.from(this.parts);
  }
}

/** Big tables (stsz, stco...) are built directly into typed arrays. */
export function u32Table(values: ArrayLike<number>, prefix: number[] = []): Uint8Array {
  const out = new Uint8Array((prefix.length + values.length) * 4);
  let o = 0;
  for (const v of prefix) {
    setU32(out, o, v);
    o += 4;
  }
  for (let i = 0; i < values.length; i++) {
    setU32(out, o, values[i]);
    o += 4;
  }
  return out;
}

// ---- sidx ----------------------------------------------------------------

export interface SidxReference {
  /** Absolute byte range in the file, inclusive. */
  range: [number, number];
  start: number;
  duration: number;
}

/**
 * Parses a sidx box. `sidxFileOffset` is the absolute file offset of the box,
 * so returned ranges are absolute.
 */
export function parseSidx(buf: Uint8Array, sidx: Box, sidxFileOffset: number): SidxReference[] {
  const p = payloadOf(sidx);
  const version = buf[p];
  const timescale = u32(buf, p + 8);
  let o = p + 12;
  let earliest: number;
  let firstOffset: number;
  if (version === 0) {
    earliest = u32(buf, o);
    firstOffset = u32(buf, o + 4);
    o += 8;
  } else {
    earliest = u64(buf, o);
    firstOffset = u64(buf, o + 8);
    o += 16;
  }
  o += 2; // reserved
  const count = u16(buf, o);
  o += 2;
  let offset = sidxFileOffset + sidx.size + firstOffset;
  let time = earliest;
  const refs: SidxReference[] = [];
  for (let i = 0; i < count; i++) {
    const word = u32(buf, o);
    const size = word & 0x7fffffff;
    const duration = u32(buf, o + 4);
    o += 12;
    if (word & 0x80000000) throw new Error('Hierarchical sidx is not supported');
    refs.push({ range: [offset, offset + size - 1], start: time / timescale, duration: duration / timescale });
    offset += size;
    time += duration;
  }
  return refs;
}
