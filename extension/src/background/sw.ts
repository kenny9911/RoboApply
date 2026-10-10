// extension/src/background/sw.ts — MV3 service worker entry.
//
// Holds the device token (chrome.storage.local), answers the web app's ping /
// pair messages, proxies the content script's API calls, and sets the
// uninstall survey URL. It never reads pages and never watches submits.

import { brandConfig, buildEnv } from '../env';
import { createRouter, webOriginFor } from './router';
import { chromeLocalStore, restrictToTrustedContexts, type AccessLevelArea } from './storage';

declare const __TARGET__: string | undefined;

// Before anything is read or written: content scripts may not read the token's area.
void restrictToTrustedContexts(chrome.storage.local as unknown as AccessLevelArea);

const env = buildEnv();
const brand = brandConfig();
const browserName = typeof __TARGET__ !== 'undefined' && __TARGET__ === 'edge' ? 'Edge' : 'Chrome';

const router = createRouter({
  brand,
  dev: env.dev,
  apiOrigin: env.apiOrigin,
  version: env.version,
  browserName,
  store: chromeLocalStore(),
  fetch: (input, init) => fetch(input, init),
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  router.handleExternal(message, sender).then(sendResponse, () => sendResponse({ ok: false, code: 'internal_error' }));
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  router.handleInternal(message).then(sendResponse, () => sendResponse({ ok: false, code: 'internal_error', status: 0 }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  const origin = webOriginFor({ brand, dev: env.dev, apiOrigin: env.apiOrigin });
  void chrome.runtime.setUninstallURL(`${origin}/extension/uninstalled`);
});
