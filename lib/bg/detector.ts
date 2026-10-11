// Watches network traffic for HLS / DASH manifests and progressive media files,
// remembering them per tab so the overlay can offer them.

import { isIgnoredMediaHost } from '../sites';
import type { DetectedMedia } from '../types';
import type { Browser } from 'wxt/browser';

const MAX_PER_TAB = 40;
const MIN_FILE_BYTES = 256 * 1024;
const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
const DASH_TYPES = ['application/dash+xml'];

const tabs = new Map<number, DetectedMedia[]>();
let restored: Promise<void> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function restore() {
  restored ??= browser.storage.session.get('detected').then(({ detected }) => {
    for (const [tabId, list] of Object.entries((detected as Record<string, DetectedMedia[]>) ?? {})) {
      if (!tabs.has(Number(tabId))) tabs.set(Number(tabId), list);
    }
  });
  return restored;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    browser.storage.session.set({ detected: Object.fromEntries(tabs) }).catch(() => {});
  }, 500);
}

function header(headers: Browser.webRequest.HttpHeader[] | undefined, name: string) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
}

export function classify(
  url: string,
  contentType: string,
  resourceType: string,
): DetectedMedia['kind'] | undefined {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  if (path.endsWith('.m3u8') || HLS_TYPES.includes(ct)) return 'hls';
  if (path.endsWith('.mpd') || DASH_TYPES.includes(ct)) return 'dash';
  // Progressive files are loaded by <video>/<audio> elements directly ("media"),
  // whereas MSE players fetch segments via XHR, which we must not pick up.
  if (resourceType === 'media' && (/^(video|audio)\//.test(ct) || /\.(mp4|m4v|webm|mov|mkv|m4a|mp3|ogg)$/.test(path)))
    return 'file';
  return undefined;
}

function onHeadersReceived(d: Browser.webRequest.OnHeadersReceivedDetails): undefined {
  if (d.tabId < 0 || d.statusCode >= 400 || /^(blob|data):/.test(d.url)) return;
  const kind = classify(d.url, header(d.responseHeaders, 'content-type'), d.type);
  if (!kind || isIgnoredMediaHost(d.url)) return;

  let size: number | undefined;
  if (kind === 'file') {
    const range = header(d.responseHeaders, 'content-range');
    size = Number(range.split('/')[1]) || Number(header(d.responseHeaders, 'content-length')) || undefined;
    if (size !== undefined && size < MIN_FILE_BYTES) return;
  }

  void restore().then(() => {
    const list = tabs.get(d.tabId) ?? [];
    const existing = list.findIndex((m) => m.url === d.url);
    if (existing >= 0) list.splice(existing, 1);
    list.unshift({
      url: d.url,
      kind,
      frameId: d.frameId,
      size,
      contentType: header(d.responseHeaders, 'content-type'),
      time: Date.now(),
    });
    if (list.length > MAX_PER_TAB) list.length = MAX_PER_TAB;
    tabs.set(d.tabId, list);
    persist();
  });
}

export function startDetector() {
  browser.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media', 'other'] },
    ['responseHeaders'],
  );
  browser.webNavigation.onCommitted.addListener((d) => {
    const list = tabs.get(d.tabId);
    if (!list) return;
    if (d.frameId === 0) tabs.delete(d.tabId);
    else tabs.set(d.tabId, list.filter((m) => m.frameId !== d.frameId));
    persist();
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    tabs.delete(tabId);
    persist();
  });
}

export async function detectedFor(tabId: number): Promise<DetectedMedia[]> {
  await restore();
  return tabs.get(tabId) ?? [];
}
