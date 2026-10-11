// Client for the native yt-dlp helper (native messaging).

import type { HelperStatus } from '../types';
import type { Browser } from 'wxt/browser';

const HOST = 'com.videodl.helper';
const IDLE_DISCONNECT_MS = 90_000;

type Listener = (msg: HelperEvent) => void;

export type HelperEvent =
  | { type: 'progress'; jobId: string; stem?: string; bytes: number; totalBytes?: number; fraction?: number; speed?: number; eta?: number; stage?: string }
  | { type: 'done'; jobId: string; filePath: string; bytes: number }
  | { type: 'error'; jobId: string; error: string }
  | { type: 'canceled'; jobId: string; stem?: string };

class HelperClient {
  private port?: Browser.runtime.Port;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private activeJobs = new Set<string>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private lastStatus?: { at: number; status: HelperStatus };
  private disconnectHandlers = new Set<(error: string) => void>();

  onEvent(l: Listener) {
    this.listeners.add(l);
  }

  onDisconnect(h: (error: string) => void) {
    this.disconnectHandlers.add(h);
  }

  private connect(): Browser.runtime.Port {
    if (this.port) return this.port;
    const port = browser.runtime.connectNative(HOST);
    this.port = port;
    port.onMessage.addListener((msg: any) => {
      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        p.resolve(msg);
      } else if (msg.jobId) {
        if (msg.type !== 'progress') this.activeJobs.delete(msg.jobId);
        this.listeners.forEach((l) => l(msg));
      }
      this.scheduleIdle();
    });
    port.onDisconnect.addListener(() => {
      const error = browser.runtime.lastError?.message ?? 'The helper app closed unexpectedly';
      this.port = undefined;
      this.pending.forEach((p) => p.reject(new Error(error)));
      this.pending.clear();
      this.lastStatus = undefined;
      const hadJobs = this.activeJobs.size > 0;
      this.activeJobs.clear();
      if (hadJobs) this.disconnectHandlers.forEach((h) => h(error));
    });
    return port;
  }

  private scheduleIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.activeJobs.size && !this.pending.size && this.port) {
        this.port.disconnect();
        this.port = undefined;
      }
    }, IDLE_DISCONNECT_MS);
  }

  request<T = any>(msg: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The helper app did not respond'));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.connect().postMessage({ ...msg, id });
        this.scheduleIdle();
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  post(msg: Record<string, unknown>) {
    if (msg.type === 'download' && typeof msg.jobId === 'string') this.activeJobs.add(msg.jobId);
    this.connect().postMessage(msg);
    this.scheduleIdle();
  }

  async status(refresh = false): Promise<HelperStatus> {
    if (!refresh && this.lastStatus && Date.now() - this.lastStatus.at < 60_000) return this.lastStatus.status;
    let status: HelperStatus;
    try {
      const pong = await this.request<any>({ type: 'ping' }, 8000);
      status = {
        connected: true,
        version: pong.version,
        ytdlp: pong.ytdlp,
        ffmpeg: pong.ffmpeg,
        jsRuntime: pong.jsRuntime,
        outputDir: pong.outputDir,
      };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      status = {
        connected: false,
        error: /not found/i.test(message) ? 'not-installed' : message,
      };
    }
    this.lastStatus = { at: Date.now(), status };
    return status;
  }

  async available(): Promise<boolean> {
    return (await this.status()).connected;
  }
}

export const helper = new HelperClient();
