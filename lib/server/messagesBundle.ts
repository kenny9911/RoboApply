// lib/server/messagesBundle.ts
//
// The browser's message bundle as a script of its own (lib/i18nBundle.ts
// explains why it is not in the page). One per brand × locale, built once
// per server process from loadMessages():
//
//   const bundle = messagesBundle(locale, brand.id);
//   bundle.url  → /i18n/<brand>.<locale>.<hash>.js, the hash of its content
//   bundle.js   → the body app/i18n/[file]/route.ts serves
//
// Building it also registers the messages for the server render of the client
// tree (registerMessagesBundle), which runs in the same process right after
// the root layout.
//
// Server-only: it hashes with node:crypto and loads every locale bundle.

import { createHash } from 'node:crypto';

import type { BrandId } from '../brand/registry.generated';
import { loadMessages } from '../i18n';
import type { RoboLocale } from '../localeConfig';
import { messagesKey, registerMessagesBundle } from '../i18nBundle';

export interface MessagesBundle {
  /** Registry key, `<brand>:<locale>`. */
  key: string;
  /** First 16 hex digits of the SHA-256 of the script. */
  hash: string;
  /** Same-origin URL of the script. */
  url: string;
  /** The script: stores the bundle at self.__RA_MESSAGES__[key]. */
  js: string;
}

const BUNDLES = new Map<string, MessagesBundle>();

export function messagesBundle(locale: RoboLocale, brandId: BrandId): MessagesBundle {
  const key = messagesKey(brandId, locale);
  let bundle = BUNDLES.get(key);
  if (!bundle) {
    const messages = loadMessages(locale, brandId);
    const json = JSON.stringify(messages);
    // JSON.parse of one string literal is faster for the browser than the same
    // data as an object literal. Single quotes: the copy is full of `"` (every
    // key and value) and has few `'`, so far less escaping.
    const literal = json.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const js = `(self.__RA_MESSAGES__=self.__RA_MESSAGES__||{})[${JSON.stringify(key)}]=JSON.parse('${literal}');\n`;
    // The hash covers the whole script, so a change to this wrapper is a new URL too.
    const hash = createHash('sha256').update(js).digest('hex').slice(0, 16);
    bundle = { key, hash, url: `/i18n/${brandId}.${locale}.${hash}.js`, js };
    BUNDLES.set(key, bundle);
    registerMessagesBundle(key, messages);
  }
  return bundle;
}
