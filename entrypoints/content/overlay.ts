// The on-video download button and quality menu (plain DOM: this runs in every
// frame of every page, so it stays tiny).

import { formatDuration } from '@/lib/format';
import type { VideoContext } from '@/lib/messages';
import type { DownloadOption, OptionsResult, Settings } from '@/lib/types';

const ICONS = {
  download:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10.5 5 5 5-5"/><path d="M5 19.5h14"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>',
  lock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>',
  plug:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 0 1-11 0zM12 16.5V21"/></svg>',
  spinner:
    '<svg class="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 3a9 9 0 1 1-9 9" /></svg>',
  folder:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/></svg>',
};

type Attrs = Record<string, string | ((e: Event) => void) | boolean | undefined>;
type Child = Node | string | undefined | false;

function h(tag: string, attrs: Attrs = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v as string;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c !== undefined && c !== false) el.append(c);
  return el;
}

export interface OverlayDeps {
  getOptions: (ctx: VideoContext) => Promise<OptionsResult>;
  startDownload: (option: DownloadOption, result: Extract<OptionsResult, { ok: true }>) => Promise<void>;
  openPopup: () => void;
  openSetup: () => void;
  contextFor: (video: HTMLVideoElement) => VideoContext;
}

export class Overlay {
  private btn: HTMLButtonElement;
  private panel: HTMLDivElement;
  private toast: HTMLDivElement;
  private target?: HTMLVideoElement;
  private panelOpen = false;
  private hideTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private toastTimer?: ReturnType<typeof setTimeout>;
  private raf = 0;
  private request = 0;

  constructor(
    private root: HTMLElement,
    private deps: OverlayDeps,
    private settings: Settings,
  ) {
    this.btn = h(
      'button',
      { class: 'btn', type: 'button', 'aria-label': 'Download video', onclick: () => this.togglePanel() },
      h('span', { html: ICONS.download }),
      h('span', { class: 'text' }, 'Download'),
    ) as HTMLButtonElement;
    this.btn.addEventListener('pointerenter', () => this.cancelHide());
    this.panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Download options' }) as HTMLDivElement;
    this.panel.addEventListener('pointerenter', () => this.cancelHide());
    this.toast = h('div', { class: 'toast', role: 'status' }) as HTMLDivElement;
    root.append(this.btn, this.panel, this.toast);
  }

  updateSettings(s: Settings) {
    this.settings = s;
    if (!s.showOverlay) this.hide(true);
  }

  get current() {
    return this.target;
  }

  get isOpen() {
    return this.panelOpen;
  }

  /** Called when the pointer is over a video. */
  showFor(video: HTMLVideoElement) {
    if (!this.settings.showOverlay) return;
    this.cancelHide();
    if (this.target !== video) {
      if (this.panelOpen) return; // Keep the open menu attached to its video.
      this.target = video;
    }
    this.btn.classList.add('show');
    this.btn.classList.remove('idle');
    clearTimeout(this.idleTimer);
    if (!video.paused) this.idleTimer = setTimeout(() => this.btn.classList.add('idle'), 2500);
    this.startTracking();
  }

  /** Called when the pointer left every video. */
  scheduleHide() {
    if (this.panelOpen || this.hideTimer) return;
    this.hideTimer = setTimeout(() => this.hide(), 1200);
  }

  private cancelHide() {
    clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }

  hide(force = false) {
    this.cancelHide();
    if (this.panelOpen && !force) return;
    this.closePanel();
    this.btn.classList.remove('show');
    this.target = undefined;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  containsEvent(e: Event) {
    const path = e.composedPath();
    return path.includes(this.btn) || path.includes(this.panel) || path.includes(this.toast);
  }

  // ---- Positioning -------------------------------------------------------

  private startTracking() {
    if (this.raf) return;
    const tick = () => {
      this.position();
      this.raf = this.btn.classList.contains('show') || this.toast.classList.contains('show') ? requestAnimationFrame(tick) : 0;
    };
    this.raf = requestAnimationFrame(tick);
  }

  private position() {
    const v = this.target;
    if (!v) return;
    if (!v.isConnected) {
      this.hide(true);
      return;
    }
    const r = v.getBoundingClientRect();
    if (r.width < 2 || r.bottom < 0 || r.top > innerHeight) {
      if (!this.panelOpen) this.hide();
      return;
    }
    const compact = r.width < 300;
    this.btn.classList.toggle('compact', compact);
    const bw = this.btn.offsetWidth || 110;
    const bh = this.btn.offsetHeight || 34;
    const inset = r.width < 400 ? 8 : 12;
    const top = Math.max(8, Math.min(r.top + inset, innerHeight - bh - 8));
    const left =
      this.settings.overlayCorner === 'top-left'
        ? Math.max(8, r.left + inset)
        : Math.min(innerWidth - bw - 8, Math.max(8, r.right - bw - inset));
    this.btn.style.top = `${top}px`;
    this.btn.style.left = `${left}px`;

    if (this.panelOpen) {
      const pw = Math.min(330, innerWidth - 16);
      const ptop = top + bh + 8;
      const pleft =
        this.settings.overlayCorner === 'top-left'
          ? Math.min(left, innerWidth - pw - 8)
          : Math.max(8, Math.min(left + bw - pw, innerWidth - pw - 8));
      this.panel.style.top = `${ptop}px`;
      this.panel.style.left = `${pleft}px`;
      this.panel.style.transformOrigin = this.settings.overlayCorner === 'top-left' ? 'top left' : 'top right';
      const body = this.panel.querySelector<HTMLElement>('.body');
      if (body) body.style.maxHeight = `${Math.max(140, Math.min(380, innerHeight - ptop - 130))}px`;
    }

    if (this.toast.classList.contains('show')) {
      const tw = this.toast.offsetWidth;
      this.toast.style.left = `${Math.max(8, Math.min(innerWidth - tw - 8, r.left + r.width / 2 - tw / 2))}px`;
      this.toast.style.top = `${Math.min(innerHeight - 60, Math.max(8, r.bottom - 64))}px`;
    }
  }

  // ---- Panel ---------------------------------------------------------------

  togglePanel() {
    if (this.panelOpen) this.closePanel();
    else void this.openPanel();
  }

  closePanel() {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.request++;
    this.panel.classList.remove('show');
    this.btn.classList.remove('open');
  }

  private async openPanel() {
    const video = this.target;
    if (!video) return;
    this.panelOpen = true;
    this.btn.classList.add('open');
    const ctx = this.deps.contextFor(video);
    this.renderLoading(ctx);
    this.panel.classList.add('show');
    this.position();
    const req = ++this.request;
    let result: OptionsResult;
    try {
      result = await this.deps.getOptions(ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result = {
        ok: false,
        reason: 'error',
        message: /context invalidated/i.test(msg) ? 'The extension was updated. Reload this page to keep using it.' : msg,
      };
    }
    if (req !== this.request) return;
    if (result.ok) this.renderOptions(result);
    else this.renderError(result, ctx);
    this.position();
  }

  private header(title: string, sub: string) {
    return h(
      'div',
      { class: 'head' },
      h('div', { class: 'meta' }, h('div', { class: 'title', title }, title), h('div', { class: 'sub' }, sub)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', html: ICONS.close, onclick: () => this.closePanel() }),
    );
  }

  private renderLoading(ctx: VideoContext) {
    const sub = [location.hostname.replace(/^www\./, ''), formatDuration(ctx.duration)].filter(Boolean).join(' · ');
    const skeleton = (w1: number, w2: number) =>
      h('div', { class: 'skeleton' }, h('i', { style: `width:${w1}px` }), h('i', { style: `width:${w2}px;opacity:.6` }));
    this.panel.replaceChildren(
      this.header(ctx.title || 'Video', sub),
      h('div', { class: 'body' }, skeleton(70, 150), skeleton(60, 130), skeleton(64, 110)),
      h('div', { class: 'foot', html: `${ICONS.spinner}<span>Finding available qualities…</span>` }),
    );
  }

  private renderOptions(result: Extract<OptionsResult, { ok: true }>) {
    const { media, options } = result;
    const sub = [media.site, formatDuration(media.duration)].filter(Boolean).join(' · ');
    const body = h('div', { class: 'body' });
    const groups = new Map<string, DownloadOption[]>();
    for (const o of options) {
      const key = `${o.group ? o.group + ' · ' : ''}${o.kind === 'audio' ? 'Audio only' : 'Video'}`;
      groups.set(key, [...(groups.get(key) ?? []), o]);
    }
    for (const [name, list] of groups) {
      body.append(h('div', { class: 'section' }, name));
      for (const o of list) body.append(this.row(o, result));
    }
    const viaHelper = options.some((o) => o.engine === 'helper');
    this.panel.replaceChildren(
      this.header(media.title, sub),
      body,
      h(
        'div',
        { class: 'foot' },
        h('span', { html: viaHelper ? ICONS.plug : ICONS.folder }),
        h('span', {}, viaHelper ? 'Downloaded by the yt-dlp helper' : 'Downloaded right in your browser'),
        h('a', { onclick: () => this.deps.openPopup() }, 'Downloads'),
      ),
    );
  }

  private row(o: DownloadOption, result: Extract<OptionsResult, { ok: true }>) {
    const go = h('span', { class: 'go', html: ICONS.download });
    const row = h(
      'button',
      {
        class: 'row',
        type: 'button',
        title: `${o.label} · ${o.detail}`,
        onclick: async () => {
          if (row.hasAttribute('disabled')) return;
          row.setAttribute('disabled', '');
          go.innerHTML = ICONS.spinner;
          try {
            await this.deps.startDownload(o, result);
            row.classList.add('added');
            go.innerHTML = ICONS.check;
            this.showToast(`${o.label} download started`);
            setTimeout(() => this.closePanel(), 700);
          } catch (e) {
            row.removeAttribute('disabled');
            go.innerHTML = ICONS.download;
            this.showToast(e instanceof Error ? e.message : 'Could not start the download', false);
          }
        },
      },
      h(
        'span',
        { class: 'q' },
        h('span', { class: 'label' }, o.label),
        o.badge ? h('span', { class: `badge b${o.badge}` }, o.badge) : undefined,
      ),
      h('span', { class: 'detail' }, o.detail),
      go,
    );
    return row;
  }

  private renderError(result: Extract<OptionsResult, { ok: false }>, ctx: VideoContext) {
    const icon = result.reason === 'drm' ? ICONS.lock : result.reason === 'needs-helper' ? ICONS.plug : ICONS.alert;
    const action =
      result.reason === 'needs-helper'
        ? h('button', { class: 'primary', type: 'button', onclick: () => this.deps.openSetup() }, 'Set up the helper')
        : result.reason === 'drm'
          ? undefined
          : h('button', { class: 'primary', type: 'button', onclick: () => void this.openPanelAgain() }, 'Try again');
    const media = result.media;
    const sub = [media?.site ?? location.hostname, formatDuration(media?.duration ?? ctx.duration)].filter(Boolean).join(' · ');
    this.panel.replaceChildren(
      this.header(media?.title || ctx.title || 'Video', sub),
      h(
        'div',
        { class: `status ${result.reason === 'drm' ? '' : 'warn'}` },
        h('div', { class: 'ico', html: icon }),
        h('p', {}, result.message),
        action,
      ),
    );
  }

  private async openPanelAgain() {
    this.panelOpen = false;
    await this.openPanel();
  }

  private showToast(text: string, success = true) {
    clearTimeout(this.toastTimer);
    const parts: Node[] = [
      h('span', { class: 'dot', html: success ? ICONS.check : ICONS.alert, style: success ? '' : 'background:#f59e0b' }),
      h('span', {}, text),
    ];
    if (success) parts.push(h('button', { type: 'button', onclick: () => this.deps.openPopup() }, 'View'));
    this.toast.replaceChildren(...parts);
    this.toast.classList.add('show');
    this.startTracking();
    this.position();
    this.toastTimer = setTimeout(() => this.toast.classList.remove('show'), 3500);
  }
}
