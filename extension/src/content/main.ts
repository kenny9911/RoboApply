// extension/src/content/main.ts — content script entry.
//
// Registered by the manifest for the supported form hosts, and injected by
// the popup (activeTab) when the user clicks the toolbar button elsewhere.
// On a supported form it shows the collapsed panel button and does nothing
// else: no API call, no reading, no listeners on the page's forms. Everything
// after that starts with a user click. It never watches submits.
// The state lives in controller.ts (testable without chrome.*).

import { brandConfig, buildEnv } from '../env';
import type { ContentMessage } from '../shared/messages';
import { runtimeApi } from './bridge';
import { createContentController } from './controller';
import { mountPanel } from './panel/mount';

declare global {
  interface Window {
    __raExtContentLoaded?: boolean;
  }
}

function webOrigin(): string {
  const env = buildEnv();
  return env.dev ? env.apiOrigin : brandConfig().apiOrigin;
}

function main(): void {
  if (window.__raExtContentLoaded) return;
  window.__raExtContentLoaded = true;

  const env = buildEnv();
  const brand = brandConfig();
  const controller = createContentController({
    doc: document,
    href: () => location.href,
    set: brand.adapterSet,
    dev: env.dev,
    mount: (adapter, url, open) =>
      mountPanel(document, {
        adapter,
        doc: document,
        url,
        api: runtimeApi(),
        webOrigin: webOrigin(),
        market: brand.market,
        brand: brand.id,
        dev: env.dev,
        open,
      }),
  });
  controller.init();

  chrome.runtime.onMessage.addListener((message: ContentMessage, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const res = controller.handle(message);
    if (res !== undefined) sendResponse(res);
    return false;
  });
}

main();
