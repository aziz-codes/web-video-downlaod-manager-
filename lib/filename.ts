const SITE_SUFFIX = /\s*[-|–—]\s*(YouTube|Vimeo|Dailymotion|Twitch|Facebook|Instagram|X|Twitter|TikTok|Reddit)\s*$/i;

export function cleanTitle(title: string | undefined): string {
  let t = (title ?? '').replace(/^\(\d+\+?\)\s*/, '').replace(SITE_SUFFIX, '').trim();
  return t || 'Video';
}

export function safeFileStem(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f<>:"/\\|?*\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  return (cleaned || 'video').slice(0, 180);
}

export const fileStemFor = (title: string, label: string) => safeFileStem(`${cleanTitle(title)} [${label}]`);
