// Fetch helpers with retries, byte ranges and byte-level progress.

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
  ) {
    super(httpMessage(status));
    this.name = 'HttpError';
  }
}

function httpMessage(status: number): string {
  if (status === 401 || status === 403)
    return `The server refused the request (${status}). The link may have expired, reload the page and try again.`;
  if (status === 404 || status === 410) return `The media was not found on the server (${status}).`;
  if (status === 429) return 'The server is rate limiting downloads (429). Try again in a moment.';
  return `The server returned an error (${status}).`;
}

export class AbortedError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'AbortError';
  }
}

export const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AbortedError());
      },
      { once: true },
    );
  });

export interface FetchBytesOptions {
  signal?: AbortSignal;
  /** Inclusive byte range. */
  range?: [number, number];
  onBytes?: (n: number) => void;
  retries?: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

export async function fetchBytes(url: string, opts: FetchBytesOptions = {}): Promise<Uint8Array> {
  const retries = opts.retries ?? 5;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new AbortedError();
    let received = 0;
    try {
      const headers: Record<string, string> = {};
      if (opts.range) headers.Range = `bytes=${opts.range[0]}-${opts.range[1]}`;
      const res = await fetch(url, { signal: opts.signal, headers, credentials: 'include' });
      if (!res.ok) throw new HttpError(res.status, url);
      const chunks: Uint8Array[] = [];
      const reader = res.body!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        opts.onBytes?.(value.length);
      }
      let data = joinChunks(chunks, received);
      if (opts.range && res.status === 200) data = data.subarray(opts.range[0], opts.range[1] + 1);
      return data;
    } catch (e) {
      if (received) opts.onBytes?.(-received);
      if (isAbort(e) || opts.signal?.aborted) throw new AbortedError();
      if (e instanceof HttpError && !RETRYABLE.has(e.status) && attempt >= 1) throw e;
      lastError = e;
      if (attempt < retries) await sleep(Math.min(8000, 400 * 2 ** attempt), opts.signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function fetchText(url: string, signal?: AbortSignal): Promise<{ text: string; url: string; contentType: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal, credentials: 'include' });
      if (!res.ok) throw new HttpError(res.status, url);
      return { text: await res.text(), url: res.url || url, contentType: res.headers.get('content-type') ?? '' };
    } catch (e) {
      if (isAbort(e) || signal?.aborted) throw new AbortedError();
      lastError = e;
      if (e instanceof HttpError && !RETRYABLE.has(e.status)) break;
      await sleep(500 * (attempt + 1), signal);
    }
  }
  throw lastError;
}

export interface ResourceInfo {
  size?: number;
  rangeable: boolean;
  contentType: string;
  url: string;
}

/** Probes a resource with a 1-byte range request. */
export async function probeResource(url: string, signal?: AbortSignal): Promise<ResourceInfo> {
  const ctrl = new AbortController();
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctrl.signal, credentials: 'include' });
  ctrl.abort(); // We only need headers.
  if (!res.ok) throw new HttpError(res.status, url);
  const contentType = res.headers.get('content-type') ?? '';
  const cr = res.headers.get('content-range');
  if (res.status === 206 && cr) {
    const total = Number(cr.split('/')[1]);
    return { size: Number.isFinite(total) ? total : undefined, rangeable: true, contentType, url: res.url || url };
  }
  const len = Number(res.headers.get('content-length'));
  return { size: len || undefined, rangeable: false, contentType, url: res.url || url };
}
