// End-to-end engine tests: serves ffmpeg-generated HLS/DASH over HTTP, runs the
// real planner/runner/muxer, then validates the result by decoding it with ffmpeg.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { open, readFile, stat, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildPlan } from '../lib/engine/plan';
import { PauseGate, runPlan, type FileSink } from '../lib/engine/runner';
import type { BrowserSource } from '../lib/types';

const MEDIA = join(__dirname, '.media');
const OUT = join(__dirname, '.media', 'out');
const HELPER_FFMPEG = join(homedir(), '.local/share/video-downloader-helper/bin/ffmpeg');
const FFMPEG = process.env.FFMPEG ?? (existsSync(HELPER_FFMPEG) ? HELPER_FFMPEG : 'ffmpeg');
let server: Server;
let base = '';

beforeAll(async () => {
  if (!existsSync(MEDIA)) execFileSync(join(__dirname, 'make-media.sh'), { stdio: 'inherit' });
  await mkdir(OUT, { recursive: true });
  server = createServer(async (req, res) => {
    const path = join(MEDIA, decodeURIComponent(new URL(req.url!, 'http://x').pathname));
    try {
      const data = await readFile(path);
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1 });
        res.end(data.subarray(start, end + 1));
      } else {
        res.writeHead(200, { 'Content-Length': data.length });
        res.end(data);
      }
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => server?.close());

async function nodeSink(path: string): Promise<FileSink> {
  const fh = await open(path, 'w');
  let pos = 0;
  return {
    async write(d) {
      await fh.write(d, 0, d.length, pos);
      pos += d.length;
    },
    async writeAt(p, d) {
      await fh.write(d, 0, d.length, p);
    },
    close: () => fh.close(),
    abort: () => fh.close(),
  };
}

function probe(file: string) {
  const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const info = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
  const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(info);
  return {
    errors: decode.stderr.trim(),
    duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : 0,
    video: /Video: (\w+)/.exec(info)?.[1],
    audio: /Audio: (\w+)/.exec(info)?.[1],
    start: Number(/start: ([\d.-]+)/.exec(info)?.[1] ?? NaN),
    frames: Number(
      [...spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-map', '0:v?', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.matchAll(/frame= *(\d+)/g)].at(-1)?.[1] ?? 0,
    ),
    info,
  };
}

async function download(name: string, source: BrowserSource) {
  const plan = await buildPlan(source);
  const progress: number[] = [];
  let file = '';
  const result = await runPlan(plan, {
    title: name,
    concurrency: 4,
    signal: new AbortController().signal,
    gate: new PauseGate(),
    openSink: (ext) => nodeSink((file = join(OUT, `${name}.${ext}`))),
    onProgress: (p) => p.fraction !== undefined && progress.push(p.fraction),
  });
  return { file, result, progress };
}

const cases: Array<[string, () => BrowserSource]> = [
  ['hls-ts', () => ({ type: 'hls', url: `${base}/hls-ts/index.m3u8` })],
  ['hls-fmp4', () => ({ type: 'hls', url: `${base}/hls-fmp4/index.m3u8` })],
  ['hls-aes', () => ({ type: 'hls', url: `${base}/hls-aes/index.m3u8` })],
  ['hls-alt', () => ({ type: 'hls', url: `${base}/hls-alt/master.m3u8` })],
  ['hls-single', () => ({ type: 'hls', url: `${base}/hls-single/index.m3u8` })],
  ['dash-tl', () => ({ type: 'dash', url: `${base}/dash-tl/manifest.mpd`, videoId: '0', audioId: '1' })],
  ['dash-num', () => ({ type: 'dash', url: `${base}/dash-num/manifest.mpd`, videoId: '0', audioId: '1' })],
  ['dash-single', () => ({ type: 'dash', url: `${base}/dash-single/manifest.mpd`, videoId: '0', audioId: '1' })],
];

describe('engine end-to-end', () => {
  for (const [name, source] of cases) {
    it(`downloads ${name} into a valid MP4 with audio and video`, async () => {
      const { file, result } = await download(name, source());
      expect(result.ext).toBe('mp4');
      const p = probe(file);
      expect(p.errors, p.info).toBe('');
      expect(p.video).toBe('h264');
      expect(p.audio).toBe('aac');
      expect(p.duration).toBeGreaterThan(11.5);
      expect(p.duration).toBeLessThan(12.6);
      expect(Math.abs(p.start)).toBeLessThan(0.1);
      expect(p.frames).toBe(360);
    });
  }

  it('downloads an audio-only DASH representation as M4A', async () => {
    const { file, result } = await download('dash-audio', { type: 'dash', url: `${base}/dash-tl/manifest.mpd`, audioId: '1' });
    expect(result.ext).toBe('m4a');
    const p = probe(file);
    expect(p.errors).toBe('');
    expect(p.video).toBeUndefined();
    expect(p.audio).toBe('aac');
  });

  it('downloads a progressive file with ranged chunks', async () => {
    const { file, result, progress } = await download('file', { type: 'file', url: `${base}/source.mp4` });
    expect(result.ext).toBe('mp4');
    expect((await stat(file)).size).toBe((await stat(join(MEDIA, 'source.mp4'))).size);
    expect(progress.at(-1)).toBe(1);
  });

  it('pauses between segments and resumes to a complete file', async () => {
    const plan = await buildPlan({ type: 'hls', url: `${base}/hls-ts/index.m3u8` });
    const gate = new PauseGate();
    const file = join(OUT, 'paused.mp4');
    let writes = 0;
    const sink = await nodeSink(file);
    const run = runPlan(plan, {
      concurrency: 2,
      signal: new AbortController().signal,
      gate,
      openSink: async () => ({
        ...sink,
        write: async (d) => {
          writes++;
          if (writes === 1) gate.pause();
          await sink.write(d);
        },
      }),
      onProgress: () => {},
    });
    await new Promise((r) => setTimeout(r, 400));
    const pausedAt = writes;
    await new Promise((r) => setTimeout(r, 400));
    expect(writes).toBe(pausedAt); // nothing is written while paused
    gate.resume();
    await run;
    const p = probe(file);
    expect(p.errors).toBe('');
    expect(p.frames).toBe(360);
  });

  it('can be canceled', async () => {
    const plan = await buildPlan({ type: 'hls', url: `${base}/hls-ts/index.m3u8` });
    const ctrl = new AbortController();
    let aborted = false;
    const run = runPlan(plan, {
      concurrency: 1,
      signal: ctrl.signal,
      gate: new PauseGate(),
      openSink: async () => ({
        write: async () => ctrl.abort(),
        writeAt: async () => {},
        close: async () => {},
        abort: async () => {
          aborted = true;
        },
      }),
      onProgress: () => {},
    });
    await expect(run).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});
