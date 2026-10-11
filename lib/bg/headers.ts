// Replays the page's Referer / Origin on the extension's own media requests,
// which many CDNs require (hotlink protection).

const RULE_BASE = 1000;
let nextRule: Promise<number> | undefined;
let counter = RULE_BASE;
const rules = new Map<string, number>();

/** Rule IDs continue after any session rules left over from a previous worker. */
async function allocateRuleId(): Promise<number> {
  nextRule ??= browser.declarativeNetRequest
    .getSessionRules()
    .then((existing) => Math.max(RULE_BASE, ...existing.map((r) => r.id + 1)));
  counter = Math.max(counter, await nextRule);
  return counter++;
}

export async function setRefererRule(key: string, hosts: string[], referer: string | undefined) {
  if (!referer || !/^https?:/.test(referer) || !hosts.length) return;
  const id = rules.get(key) ?? (await allocateRuleId());
  rules.set(key, id);
  const origin = new URL(referer).origin;
  await browser.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: referer },
            { header: 'origin', operation: 'set', value: origin },
          ],
        },
        condition: {
          requestDomains: [...new Set(hosts)],
          tabIds: [browser.tabs.TAB_ID_NONE],
          resourceTypes: ['xmlhttprequest', 'media', 'other'],
        },
      },
    ],
  });
}

export async function clearRefererRule(key: string) {
  const id = rules.get(key);
  if (id === undefined) return;
  rules.delete(key);
  await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
}

export async function clearAllRules() {
  const existing = await browser.declarativeNetRequest.getSessionRules();
  await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: existing.map((r) => r.id) });
}

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};
