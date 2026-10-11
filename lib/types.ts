// Types shared by the background worker, offscreen engine, popup, options page
// and content script.

export type BrowserSource =
  | { type: 'hls'; url: string; videoUri?: string; audioUri?: string }
  | { type: 'dash'; url: string; videoId?: string; audioId?: string }
  | { type: 'file'; url: string; size?: number };

export interface HelperSource {
  url: string;
  format: string;
  ext: string;
  audioOnly?: boolean;
}

export interface DownloadOption {
  id: string;
  kind: 'video' | 'audio';
  /** "1080p60", "Audio" */
  label: string;
  /** "MP4 · H.264 · 245 MB" */
  detail: string;
  /** "4K", "FHD", "HD", "SD" */
  badge?: string;
  height?: number;
  sizeBytes?: number;
  ext: string;
  engine: 'browser' | 'helper';
  source?: BrowserSource;
  helper?: HelperSource;
  /** Stream group label when a page has several streams. */
  group?: string;
}

export interface MediaInfo {
  title: string;
  duration?: number;
  thumbnail?: string;
  site: string;
}

export type OptionsResult =
  | { ok: true; media: MediaInfo; options: DownloadOption[]; note?: string }
  | { ok: false; reason: 'none' | 'drm' | 'live' | 'needs-helper' | 'error'; message: string; media?: MediaInfo };

export type JobStatus =
  | 'queued'
  | 'preparing'
  | 'downloading'
  | 'paused'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface Job {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  pageUrl: string;
  site: string;
  thumbnail?: string;
  option: DownloadOption;
  status: JobStatus;
  stage?: string;
  fraction?: number;
  bytes: number;
  totalBytes?: number;
  speed?: number;
  eta?: number;
  error?: string;
  /** File name as saved. */
  fileName?: string;
  /** Absolute path (helper downloads). */
  filePath?: string;
  /** Where a browser-engine file was written. */
  savedTo?: 'folder' | 'staging';
  /** Request headers to replay (Referer / Origin of the page). */
  referer?: string;
  /** Output name chosen by the helper, reused when resuming. */
  helperStem?: string;
}

export interface Progress {
  fraction?: number;
  bytes: number;
  totalBytes?: number;
  speed?: number;
  eta?: number;
  stage?: string;
}

export interface Settings {
  showOverlay: boolean;
  overlayCorner: 'top-right' | 'top-left';
  preferCompatible: boolean;
  segmentConcurrency: number;
  maxConcurrentJobs: number;
  helperCookies: 'never' | 'non-youtube' | 'always';
  helperOutputDir: string;
  notify: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  showOverlay: true,
  overlayCorner: 'top-right',
  preferCompatible: true,
  segmentConcurrency: 6,
  maxConcurrentJobs: 3,
  helperCookies: 'non-youtube',
  helperOutputDir: '',
  notify: true,
};

export interface HelperStatus {
  connected: boolean;
  version?: string;
  ytdlp?: string;
  ffmpeg?: boolean;
  jsRuntime?: string;
  outputDir?: string;
  error?: string;
}

export interface DetectedMedia {
  url: string;
  kind: 'hls' | 'dash' | 'file';
  frameId: number;
  referer?: string;
  size?: number;
  contentType?: string;
  time: number;
}

export const ACTIVE_STATUSES: JobStatus[] = ['queued', 'preparing', 'downloading', 'paused', 'finalizing'];
