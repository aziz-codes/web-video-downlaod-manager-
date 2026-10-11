import type { BrowserSource, DownloadOption, HelperStatus, MediaInfo, OptionsResult, Progress } from './types';

export interface VideoContext {
  pageUrl: string;
  title: string;
  isTop: boolean;
  thumbnail?: string;
  src?: string;
  duration?: number;
  height?: number;
}

/** Messages handled by the background worker. */
export type BgMessage =
  | { type: 'get-options'; ctx: VideoContext; tabId?: number }
  | { type: 'start-download'; option: DownloadOption; media: MediaInfo; pageUrl: string; tabId?: number }
  | { type: 'job-action'; id: string; action: JobAction }
  | { type: 'clear-finished' }
  | { type: 'helper-status'; refresh?: boolean }
  | { type: 'helper-update' }
  | { type: 'open-popup' }
  | { type: 'open-options'; section?: string }
  | { type: 'staged-moved'; moves: Array<{ from: string; to: string }> }
  | EngineEvent;

export type JobAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'remove' | 'open' | 'reveal' | 'retry-helper';

/** Messages from the offscreen engine to the background worker. */
export type EngineEvent =
  | { type: 'engine-progress'; id: string; progress: Progress }
  | { type: 'engine-hosts'; id: string; hosts: string[] }
  | { type: 'engine-done'; id: string; fileName: string; savedTo: 'folder' | 'staging'; bytes: number }
  | { type: 'engine-error'; id: string; error: string; reason?: string }
  | { type: 'engine-canceled'; id: string };

export interface EngineJob {
  id: string;
  source: BrowserSource;
  title: string;
  fileStem: string;
  concurrency: number;
}

/** Messages to the offscreen document. */
export type OffscreenMessage =
  | { target: 'offscreen'; type: 'run'; job: EngineJob }
  | { target: 'offscreen'; type: 'pause' | 'resume' | 'cancel'; id: string }
  | { target: 'offscreen'; type: 'list-active' }
  | { target: 'offscreen'; type: 'flush-staged' };

export type BgResponse<T extends BgMessage['type']> = T extends 'get-options'
  ? OptionsResult
  : T extends 'helper-status'
    ? HelperStatus
    : { ok: boolean; error?: string; jobId?: string };

export function sendBg<M extends BgMessage>(msg: M): Promise<BgResponse<M['type']>> {
  return browser.runtime.sendMessage(msg) as Promise<BgResponse<M['type']>>;
}
