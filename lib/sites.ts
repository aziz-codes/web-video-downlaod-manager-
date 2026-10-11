// Sites whose players can't be downloaded from network traffic alone (signed /
// ciphered URLs, SABR streaming, byte-range DASH...). These go to the helper.
const HELPER_SITES = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'music.youtube.com',
  'facebook.com',
  'fb.watch',
  'instagram.com',
  'tiktok.com',
  'threads.net',
  'bilibili.com',
  'soundcloud.com',
];

// Ads, trackers and site chrome that look like media requests.
const IGNORED_HOSTS = [
  'googlevideo.com',
  'doubleclick.net',
  'googlesyndication.com',
  'imasdk.googleapis.com',
  '2mdn.net',
  'adnxs.com',
  'moatads.com',
  'springserve.com',
  'innovid.com',
  'jwpltx.com',
  'fwmrm.net',
  'serving-sys.com',
  'teads.tv',
  'spotxchange.com',
];

const matches = (host: string, list: string[]) => list.some((d) => host === d || host.endsWith('.' + d));

function host(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export const isHelperSite = (url: string) => matches(host(url), HELPER_SITES);
export const isIgnoredMediaHost = (url: string) => matches(host(url), IGNORED_HOSTS);
export const isYouTube = (url: string) => /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host(url));
