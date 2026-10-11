export function formatBytes(n?: number, approx = false): string {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const value = i <= 1 || n >= 100 ? Math.round(n).toString() : n.toFixed(1);
  return `${approx ? '~' : ''}${value} ${units[i]}`;
}

export const formatSpeed = (bps?: number) => (bps && bps > 0 ? `${formatBytes(bps)}/s` : '');

export function formatDuration(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatEta(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec)) return '';
  if (sec < 1) return 'almost done';
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s left`;
  return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m left`;
}

export function qualityBadge(height?: number): string | undefined {
  if (!height) return undefined;
  if (height >= 2160) return '4K';
  if (height >= 1440) return '2K';
  if (height >= 1080) return 'FHD';
  if (height >= 720) return 'HD';
  return 'SD';
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
