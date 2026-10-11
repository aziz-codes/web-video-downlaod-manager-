// Lifecycle of the offscreen document that runs browser-engine downloads.

import type { OffscreenMessage } from '../messages';
import type { Browser } from 'wxt/browser';

const PATH = '/offscreen.html';
let creating: Promise<void> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

export async function offscreenExists(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as Browser.runtime.ContextType],
    documentUrls: [browser.runtime.getURL(PATH)],
  });
  return contexts.length > 0;
}

export async function ensureOffscreen() {
  clearTimeout(closeTimer);
  if (await offscreenExists()) return;
  creating ??= browser.offscreen
    .createDocument({
      url: PATH,
      reasons: ['BLOBS' as Browser.offscreen.Reason],
      justification: 'Downloads video segments and assembles them into a file on disk.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

export async function toOffscreen<T = unknown>(msg: OffscreenMessage): Promise<T> {
  await ensureOffscreen();
  return browser.runtime.sendMessage(msg) as Promise<T>;
}

/** Closes the document once no browser-engine jobs remain, to free memory. */
export function scheduleOffscreenClose(hasActiveJobs: boolean) {
  clearTimeout(closeTimer);
  if (hasActiveJobs) return;
  closeTimer = setTimeout(async () => {
    if (await offscreenExists()) await browser.offscreen.closeDocument().catch(() => {});
  }, 60_000);
}
