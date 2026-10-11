// Browser end-to-end test: loads the built extension into Chrome, plays test
// streams from a local server, uses the on-video overlay to download, and
// validates the saved files with ffmpeg.
//
//   pnpm build && node tests/e2e.mjs [--headful] [--youtube]

import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MEDIA = join(ROOT, 'tests/.media');
const EXT = join(ROOT, 'dist/chrome-mv3');
const SHOTS = join(ROOT, 'tests/.media/shots');
const FFMPEG = process.env.FFMPEG ?? join(homedir(), '.local/share/video-downloader-helper/bin/ffmpeg');
const headful = process.argv.includes('--headful');
const withYoutube = process.argv.includes('--youtube');
const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✘'} ${name}${extra ? ` — ${extra}` : ''}`);
};

const PAGES = {
  '/page-file.html': `<!doctype html><title>Progressive Test Clip</title>
    <body style="margin:0;background:#111"><video id="v" src="/source.mp4" muted autoplay loop playsinline style="width:960px;height:540px;margin:40px"></video>`,
  '/page-hls.html': `<!doctype html><title>HLS Test Clip - Example</title>
    <body style="margin:0;background:#111"><video id="v" muted playsinline style="width:960px;height:540px;margin:40px" poster=""></video>
    <script>
      // Emulates an MSE player: the manifest is fetched by script, the element shows a blob.
      fetch('/protected/hls-alt/master.m3u8').then(r => r.text()).then(() => {
        const v = document.getElementById('v');
        v.src = '/source.mp4'; // gives the element a 12s duration like the stream
      });
    </script>`,
};

// ---- Server ------------------------------------------------------------

const refererLog = [];
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (PAGES[url.pathname]) {
    res.writeHead(200, { 'content-type': 'text/html' }).end(PAGES[url.pathname]);
    return;
  }
  let path = url.pathname;
  if (path.startsWith('/protected/')) {
    // Hotlink protection: only serve when the page's Referer is replayed.
    refererLog.push(req.headers.referer ?? '');
    if (!req.headers.referer?.includes('/page-hls.html')) {
      res.writeHead(403).end('no referer');
      return;
    }
    path = path.slice('/protected'.length);
  }
  try {
    const data = await readFile(join(MEDIA, decodeURIComponent(path)));
    const type = path.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : path.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream';
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
      res.end(data.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'content-type': type, 'content-length': data.length, 'accept-ranges': 'bytes' }).end(data);
    }
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---- Browser -------------------------------------------------------------

const profile = await mkdtemp(join(tmpdir(), 'vdl-e2e-'));
// Native messaging hosts are looked up inside the profile's user data dir.
const hostManifest = join(homedir(), '.config/google-chrome/NativeMessagingHosts/com.videodl.helper.json');
if (existsSync(hostManifest)) {
  await mkdir(join(profile, 'NativeMessagingHosts'), { recursive: true });
  await cp(hostManifest, join(profile, 'NativeMessagingHosts/com.videodl.helper.json'));
}
await mkdir(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: !headful,
  pipe: true,
  enableExtensions: [EXT],
  userDataDir: profile,
  args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1200,900', '--no-first-run'],
  defaultViewport: { width: 1100, height: 760 },
});

const extId = readFileSync(join(ROOT, '.keys/extension-id.txt'), 'utf8').trim();
const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${extId}`), { timeout: 15000 });
const sw = await swTarget.worker();
check('extension loaded with stable ID', !!sw, extId);

// The install handler opens the settings page; screenshot it.
await new Promise((r) => setTimeout(r, 1500));
const optionsPage = (await browser.pages()).find((p) => p.url().includes('options.html'));
if (optionsPage) {
  await optionsPage.setViewport({ width: 900, height: 1400 });
  await new Promise((r) => setTimeout(r, 1500));
  await optionsPage.screenshot({ path: join(SHOTS, 'options.png') });
}

const getJobs = () => sw.evaluate(() => chrome.storage.local.get('jobs').then((r) => r.jobs ?? []));

async function waitForJob(predicate, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const jobs = await getJobs();
    const job = jobs.find(predicate);
    if (job && ['completed', 'failed', 'canceled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('timed out waiting for job');
}

async function overlayDownload(page, pick) {
  const box = await page.$eval('#v', (v) => {
    const r = v.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(box.x - 20, box.y);
  await page.mouse.move(box.x, box.y, { steps: 5 });
  await page.waitForFunction(() => document.querySelector('vdl-overlay')?.shadowRoot?.querySelector('.btn.show'), { timeout: 10000 });
  await page.screenshot({ path: join(SHOTS, `${pick.shot}-button.png`) });
  const btn = await page.evaluateHandle(() => document.querySelector('vdl-overlay').shadowRoot.querySelector('.btn'));
  await btn.click();
  await page.waitForFunction(
    () => document.querySelector('vdl-overlay').shadowRoot.querySelectorAll('.row, .status').length > 0,
    { timeout: 60000 },
  );
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: join(SHOTS, `${pick.shot}-menu.png`) });
  const rows = await page.evaluate(() =>
    [...document.querySelector('vdl-overlay').shadowRoot.querySelectorAll('.row')].map((r) => r.innerText.replace(/\s+/g, ' ').trim()),
  );
  const status = await page.evaluate(() => document.querySelector('vdl-overlay').shadowRoot.querySelector('.status')?.innerText);
  if (!rows.length) throw new Error(`no options: ${status}`);
  const index = rows.findIndex(pick.match);
  const row = await page.evaluateHandle(
    (i) => document.querySelector('vdl-overlay').shadowRoot.querySelectorAll('.row')[i],
    index < 0 ? 0 : index,
  );
  await row.click();
  await page.waitForFunction(() => document.querySelector('vdl-overlay').shadowRoot.querySelector('.toast.show'), { timeout: 10000 });
  await page.screenshot({ path: join(SHOTS, `${pick.shot}-toast.png`) });
  return { rows, chosen: rows[index < 0 ? 0 : index] };
}

async function readStaged(name) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/player.html`);
  const b64 = await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('staging');
    const file = await (await dir.getFileHandle(n)).getFile();
    const buf = new Uint8Array(await file.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, name);
  await page.close();
  return Buffer.from(b64, 'base64');
}

function ffprobe(file) {
  const decode = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  const info = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr;
  return { errors: decode.stderr.trim(), info, duration: /Duration: ([\d:.]+)/.exec(info)?.[1], streams: [...info.matchAll(/Stream #\S+: (\w+): (\w+)/g)].map((m) => `${m[1]}:${m[2]}`) };
}

try {
  // 1. Progressive <video src>.
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/page-file.html`);
    await page.waitForFunction(() => document.getElementById('v').readyState >= 2);
    const { rows, chosen } = await overlayDownload(page, { shot: 'file', match: () => true });
    check('progressive: overlay lists quality', rows.length >= 1, rows.join(' | '));
    const job = await waitForJob((j) => j.title.includes('Progressive Test Clip'));
    check('progressive: job completed', job.status === 'completed', `${job.status} ${job.error ?? ''} → ${job.fileName} (${job.savedTo})`);
    if (job.status === 'completed') {
      const bytes = await readStaged(job.fileName);
      const original = readFileSync(join(MEDIA, 'source.mp4'));
      check('progressive: file is byte-identical', Buffer.compare(bytes, original) === 0, `${bytes.length} bytes`);
    }
    await page.close();
  }

  // 2. HLS master with alternate audio behind hotlink protection.
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/page-hls.html`);
    await page.waitForFunction(() => document.getElementById('v').readyState >= 1);
    const { rows, chosen } = await overlayDownload(page, { shot: 'hls', match: (r) => r.startsWith('720p') });
    check('hls: overlay lists 720p from master playlist', rows.some((r) => r.startsWith('720p')), rows.join(' | '));
    const job = await waitForJob((j) => j.title.includes('HLS Test Clip'));
    check('hls: job completed', job.status === 'completed', `${job.status} ${job.error ?? ''} → ${job.fileName}`);
    check('hls: Referer replayed on protected segments', refererLog.length > 3 && refererLog.every((r) => r.includes('/page-hls.html')), `${refererLog.length} requests`);
    if (job.status === 'completed') {
      const out = join(SHOTS, job.fileName);
      await writeFile(out, await readStaged(job.fileName));
      const p = ffprobe(out);
      check('hls: output decodes cleanly', p.errors === '', p.errors.slice(0, 200));
      check('hls: has video + audio', p.streams.includes('Video:h264') && p.streams.includes('Audio:aac'), p.streams.join(', '));
      check('hls: duration ~12s', p.duration?.startsWith('00:00:12'), p.duration);
    }
    await page.close();
  }

  // 3. Popup rendering.
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 400, height: 640 });
    await page.goto(`chrome-extension://${extId}/popup.html`);
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: join(SHOTS, 'popup.png') });
    const cards = await page.$$eval('article', (a) => a.length);
    check('popup: shows download cards', cards >= 2, `${cards} cards`);
    await page.close();
  }

  // 4. YouTube through the helper (network required).
  if (withYoutube) {
    // Keep test downloads out of the real Downloads folder.
    const out = await mkdtemp(join(tmpdir(), 'vdl-yt-'));
    await sw.evaluate((dir) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, helperOutputDir: dir } })), out);
    const page = await browser.newPage();
    await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('video', { timeout: 30000 });
    await page.evaluate(() => document.querySelector('video').setAttribute('id', 'v'));
    await new Promise((r) => setTimeout(r, 2500));
    const { rows } = await overlayDownload(page, { shot: 'youtube', match: (r) => r.startsWith('144p') });
    check('youtube: helper lists qualities', rows.length >= 2, rows.join(' | '));
    const job = await waitForJob((j) => j.option.engine === 'helper', 120000);
    check('youtube: helper job completed', job.status === 'completed', `${job.status} ${job.error ?? ''} → ${job.filePath}`);
    if (job.filePath) {
      const p = ffprobe(job.filePath);
      check('youtube: file decodes with audio + video', p.errors === '' && p.streams.length === 2, p.streams.join(', '));
    }
    await page.close();
  }
} catch (e) {
  check('e2e run', false, e.stack);
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
