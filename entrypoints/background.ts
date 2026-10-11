import { startDetector } from '@/lib/bg/detector';
import { clearAllRules } from '@/lib/bg/headers';
import { helper } from '@/lib/bg/helper';
import { clearFinished, createJob, handleNotificationClick, initJobs, jobAction, markStagedMoved, onEngineEvent } from '@/lib/bg/jobs';
import { resolveOptions } from '@/lib/bg/resolve';
import type { BgMessage } from '@/lib/messages';
import type { Browser } from 'wxt/browser';

export default defineBackground(() => {
  // Listeners must be registered synchronously so a woken worker receives the event.
  startDetector();
  void initJobs();

  browser.runtime.onInstalled.addListener(async ({ reason }) => {
    await clearAllRules();
    if (reason === 'install') await browser.runtime.openOptionsPage();
  });
  browser.runtime.onStartup.addListener(() => void clearAllRules());
  browser.notifications.onClicked.addListener(handleNotificationClick);

  browser.runtime.onMessage.addListener((msg: BgMessage & { target?: string }, sender, sendResponse) => {
    if (msg?.target === 'offscreen') return false;
    handle(msg, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
});

async function handle(msg: BgMessage, sender: Browser.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case 'get-options':
      return resolveOptions(msg.ctx, msg.tabId ?? sender.tab?.id, msg.tabId !== undefined ? undefined : sender.frameId);

    case 'start-download': {
      const job = await createJob(msg.option, msg.media, msg.pageUrl);
      return { ok: true, jobId: job.id };
    }

    case 'job-action':
      return jobAction(msg.id, msg.action);

    case 'clear-finished':
      await clearFinished();
      return { ok: true };

    case 'helper-status':
      return helper.status(msg.refresh);

    case 'helper-update': {
      const res = await helper.request<any>({ type: 'update' }, 180_000);
      await helper.status(true).catch(() => {});
      return res.ok ? { ok: true, version: res.version } : { ok: false, error: res.error };
    }

    case 'open-popup':
      try {
        await browser.action.openPopup();
      } catch {
        await browser.tabs.create({ url: browser.runtime.getURL('/popup.html?tab=1') });
      }
      return { ok: true };

    case 'open-options': {
      const url = browser.runtime.getURL(`/options.html${msg.section ? `#${msg.section}` : ''}`);
      await browser.tabs.create({ url });
      return { ok: true };
    }

    case 'staged-moved':
      await markStagedMoved(msg.moves);
      return { ok: true };

    case 'engine-progress':
    case 'engine-hosts':
    case 'engine-done':
    case 'engine-error':
    case 'engine-canceled':
      onEngineEvent(msg);
      return { ok: true };
  }
  return { ok: false, error: 'Unknown message' };
}
