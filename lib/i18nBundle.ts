// lib/i18nBundle.ts — the client's message bundle, outside the page HTML.
//
// The root layout used to hand the whole message bundle (≈500 KB of JSON) to
// the client <Providers> as a prop, so React serialized it into the HTML of
// EVERY full page load, and no cache could keep it. Now the bundle is a
// script of its own, /i18n/<brand>.<locale>.<hash>.js (app/i18n/[file]/route.ts),
// which the browser keeps for a year: the hash changes when the copy does.
//
// The script stores the bundle at `self.__RA_MESSAGES__[<brand>:<locale>]`.
// The root layout loads it with next/script `beforeInteractive`, and Next's
// bootstrap waits for those scripts before it hydrates, so the bundle is
// there on the first client render. A bundle that is not there yet (a locale
// switched in place with router.refresh) is loaded here and the render waits
// for it.
//
// On the server, lib/server/messagesBundle.ts registers each bundle on the
// same global when the root layout renders; the server render of the client
// tree (same process) reads it from there, so the bundle never travels
// through the React payload.

import { use } from 'react';

export type MessageBundle = Record<string, unknown>;

declare global {
  // eslint-disable-next-line no-var
  var __RA_MESSAGES__: Record<string, MessageBundle> | undefined;
}

/** The registry key of a brand × locale bundle. */
export function messagesKey(brandId: string, locale: string): string {
  return `${brandId}:${locale}`;
}

/** The bundle under `key`, when this runtime already has it. */
export function readMessagesBundle(key: string): MessageBundle | undefined {
  return globalThis.__RA_MESSAGES__?.[key];
}

/** Server: put a bundle where the server render of the client tree finds it. */
export function registerMessagesBundle(key: string, messages: MessageBundle): void {
  (globalThis.__RA_MESSAGES__ ??= {})[key] = messages;
}

const loading = new Map<string, Promise<MessageBundle>>();

/** Browser: load the bundle script once and resolve with what it stored. */
export function loadMessagesBundle(key: string, url: string): Promise<MessageBundle> {
  let pending = loading.get(key);
  if (!pending) {
    pending = new Promise<MessageBundle>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = url;
      el.async = true;
      el.onload = () => {
        const bundle = readMessagesBundle(key);
        if (bundle) resolve(bundle);
        else reject(new Error(`The message bundle ${url} did not define ${key}.`));
      };
      el.onerror = () => reject(new Error(`The message bundle ${url} could not be loaded.`));
      document.head.appendChild(el);
    });
    // A failed load may be retried by the next render.
    pending.catch(() => loading.delete(key));
    loading.set(key, pending);
  }
  return pending;
}

/**
 * The messages for `key`: synchronously when the bundle is here (the first
 * client render, every server render), else the render suspends until the
 * script has loaded. Null without a key (callers that pass messages in).
 */
export function useMessagesBundle(key: string | null, url: string | null): MessageBundle | null {
  if (!key) return null;
  const ready = readMessagesBundle(key);
  if (ready) return ready;
  if (typeof window === 'undefined') {
    throw new Error(`The message bundle ${key} was not registered by the root layout.`);
  }
  if (!url) return null;
  return use(loadMessagesBundle(key, url));
}
