import './style.css';
import type { VideoContext } from '@/lib/messages';
import { sendBg } from '@/lib/messages';
import { getSettings, watchSettings } from '@/lib/settings';
import { Overlay, type OverlayDeps } from './overlay';

const MIN_W = 160;
const MIN_H = 90;

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: false,
  runAt: 'document_idle',
  cssInjectionMode: 'ui',

  async main(ctx) {
    let settings = await getSettings();
    let videos: HTMLVideoElement[] = [];
    let overlay: Overlay | undefined;
    let mounting: Promise<Overlay> | undefined;
    let host: HTMLElement | undefined;

    const deps: OverlayDeps = {
      contextFor,
      getOptions: (c) => sendBg({ type: 'get-options', ctx: c }),
      startDownload: async (option, result) => {
        const res = await sendBg({ type: 'start-download', option, media: result.media, pageUrl: location.href });
        if (!res.ok) throw new Error(res.error ?? 'Could not start the download');
      },
      openPopup: () => void sendBg({ type: 'open-popup' }),
      openSetup: () => void sendBg({ type: 'open-options', section: 'helper' }),
    };

    watchSettings((s) => {
      settings = s;
      overlay?.updateSettings(s);
    });

    // Popup asks the top frame which video is the main one.
    if (window === window.top) {
      browser.runtime.onMessage.addListener((msg: { type?: string }, _sender, sendResponse) => {
        if (msg?.type !== 'video-info') return false;
        const main = mainVideo();
        sendResponse(main ? contextFor(main) : { pageUrl: location.href, title: document.title, isTop: true });
        return false;
      });
    }

    function collectVideos(root: Document | ShadowRoot, out: HTMLVideoElement[], depth = 0) {
      out.push(...root.querySelectorAll('video'));
      if (depth > 3) return;
      // Players built from web components (Reddit, some news sites) hide <video> in shadow roots.
      const all = root.querySelectorAll('*');
      if (all.length > 15000) return;
      for (const el of all) if (el.shadowRoot && el.tagName.includes('-')) collectVideos(el.shadowRoot, out, depth + 1);
    }

    function scan() {
      const found: HTMLVideoElement[] = [];
      collectVideos(document, found);
      videos = found;
      if (videos.length && !overlay) void mount();
      // Some pages prune unknown nodes from <html>; put the overlay back.
      if (host && !host.isConnected) (document.fullscreenElement ?? document.documentElement).append(host);
    }

    function visibleArea(v: HTMLVideoElement) {
      const r = v.getBoundingClientRect();
      const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
      const hgt = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
      return w > 0 && hgt > 0 ? w * hgt : 0;
    }

    function mainVideo() {
      scan();
      return [...videos]
        .filter((v) => visibleArea(v) > 0 || v.currentSrc)
        .sort((a, b) => Number(!b.paused) - Number(!a.paused) || visibleArea(b) - visibleArea(a))[0];
    }

    function videoAt(x: number, y: number): HTMLVideoElement | undefined {
      let best: HTMLVideoElement | undefined;
      let bestScore = -1;
      for (const v of videos) {
        const r = v.getBoundingClientRect();
        if (r.width < MIN_W || r.height < MIN_H) continue;
        if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
        const score = (v.paused ? 0 : 1e9) + r.width * r.height;
        if (score > bestScore) {
          best = v;
          bestScore = score;
        }
      }
      return best;
    }

    function pageTitle() {
      const og = document.querySelector<HTMLMetaElement>('meta[property="og:title"]')?.content;
      return document.title?.trim() || og || location.hostname;
    }

    function contextFor(video: HTMLVideoElement): VideoContext {
      const og = document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content;
      return {
        pageUrl: location.href,
        title: pageTitle(),
        isTop: window === window.top,
        thumbnail: og || video.poster || undefined,
        src: video.currentSrc || video.src || undefined,
        duration: Number.isFinite(video.duration) ? video.duration : undefined,
        height: video.videoHeight || undefined,
      };
    }

    async function mount(): Promise<Overlay> {
      mounting ??= createShadowRootUi(ctx, {
        name: 'vdl-overlay',
        position: 'inline',
        anchor: 'html',
        append: 'last',
        isolateEvents: ['keydown', 'keyup', 'keypress', 'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'wheel'],
        onMount(container, _shadow, host) {
          host.setAttribute(
            'style',
            'position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;' +
              'z-index:2147483647!important;display:block!important;overflow:visible!important;pointer-events:none!important;',
          );
          container.className = 'vdl';
          container.style.pointerEvents = 'auto';
          return new Overlay(container, deps, settings);
        },
      }).then((ui) => {
        ui.mount();
        host = ui.shadowHost;
        // Keep the overlay above fullscreen players.
        const reparent = () => {
          const fs = document.fullscreenElement;
          const parent = fs && !(fs instanceof HTMLVideoElement) ? fs : document.documentElement;
          if (ui.shadowHost.parentElement !== parent) parent.append(ui.shadowHost);
        };
        ctx.addEventListener(document, 'fullscreenchange', reparent);
        overlay = ui.mounted!;
        return overlay;
      });
      return mounting;
    }

    let pending = false;
    let lastX = 0;
    let lastY = 0;
    ctx.addEventListener(
      document,
      'pointermove',
      (e: PointerEvent) => {
        lastX = e.clientX;
        lastY = e.clientY;
        if (pending || !videos.length || !settings.showOverlay) return;
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          const v = videoAt(lastX, lastY);
          if (v) overlay?.showFor(v);
          else overlay?.scheduleHide();
        });
      },
      { capture: true, passive: true },
    );

    ctx.addEventListener(
      document,
      'pointerdown',
      (e: PointerEvent) => {
        if (overlay?.isOpen && !overlay.containsEvent(e)) overlay.closePanel();
      },
      { capture: true },
    );
    ctx.addEventListener(
      window,
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Escape' && overlay?.isOpen) overlay.closePanel();
      },
      { capture: true },
    );

    scan();
    ctx.setInterval(() => {
      if (document.visibilityState === 'visible') scan();
    }, 1500);
    ctx.onInvalidated(() => overlay?.hide(true));
  },
});
