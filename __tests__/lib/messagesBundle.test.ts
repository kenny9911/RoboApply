// The client's message bundle as its own cached script (lib/i18nBundle.ts,
// lib/server/messagesBundle.ts, app/i18n/[file]/route.ts): it must carry
// exactly what loadMessages() returns for every brand × locale, and its URL
// must change whenever the copy does.

import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

import { GET } from '../../app/i18n/[file]/route';
import { BRAND_IDS } from '../../lib/brand/registry.generated';
import { loadMessages } from '../../lib/i18n';
import { messagesKey, readMessagesBundle, useMessagesBundle } from '../../lib/i18nBundle';
import { LOCALES } from '../../lib/localeConfig';
import { messagesBundle } from '../../lib/server/messagesBundle';

/** Run a bundle script the way a browser would and return what it stored. */
function runBundle(js: string): Record<string, unknown> {
  const self: { __RA_MESSAGES__?: Record<string, unknown> } = {};
  vm.runInNewContext(js, { self, JSON });
  return self.__RA_MESSAGES__ ?? {};
}

const request = (file: string) => GET(new Request(`http://localhost/i18n/${file}`), { params: Promise.resolve({ file }) });

describe('messagesBundle()', () => {
  it.each(BRAND_IDS.flatMap((brand) => LOCALES.map((locale) => [brand, locale] as const)))('%s · %s round-trips exactly', (brand, locale) => {
    const bundle = messagesBundle(locale, brand);
    expect(bundle.key).toBe(messagesKey(brand, locale));
    expect(bundle.hash).toMatch(/^[a-f0-9]{16}$/);
    expect(bundle.url).toBe(`/i18n/${brand}.${locale}.${bundle.hash}.js`);
    expect(runBundle(bundle.js)[bundle.key]).toEqual(loadMessages(locale, brand));
  });

  it('survives apostrophes, backslashes and line separators in the copy', () => {
    const bundle = messagesBundle('fr', 'roboapply');
    // French copy is full of apostrophes; the literal is single-quoted.
    expect(JSON.stringify(loadMessages('fr', 'roboapply'))).toContain("'");
    expect(() => runBundle(bundle.js)).not.toThrow();
  });

  it('differs per brand and per locale', () => {
    const urls = new Set(BRAND_IDS.flatMap((brand) => LOCALES.map((locale) => messagesBundle(locale, brand).url)));
    expect(urls.size).toBe(BRAND_IDS.length * LOCALES.length);
  });

  it('registers the messages for the server render of the client tree', () => {
    const bundle = messagesBundle('de', 'roboapply');
    expect(readMessagesBundle(bundle.key)).toEqual(loadMessages('de', 'roboapply'));
  });
});

describe('useMessagesBundle()', () => {
  afterEach(() => {
    document.head.querySelectorAll('script[src^="/i18n/"]').forEach((el) => el.remove());
  });

  it('returns the bundle when this runtime has it, and nothing without a key', () => {
    const bundle = messagesBundle('en', 'roboapply');
    expect(useMessagesBundle(bundle.key, bundle.url)).toEqual(loadMessages('en', 'roboapply'));
    expect(useMessagesBundle(null, null)).toBeNull();
  });
});

describe('GET /i18n/[file]', () => {
  it('serves the current bundle as JavaScript, cached for a year', async () => {
    const bundle = messagesBundle('ja', 'roboapply');
    const res = await request(`roboapply.ja.${bundle.hash}.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(runBundle(await res.text())[bundle.key]).toEqual(loadMessages('ja', 'roboapply'));
  });

  it('answers an earlier deployment’s hash with the current copy, cached briefly', async () => {
    const res = await request('goapply.zh.0000000000000000.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=60');
    expect(runBundle(await res.text())[messagesKey('goapply', 'zh')]).toEqual(loadMessages('zh', 'goapply'));
  });

  it.each(['acme.en.0000000000000000.js', 'roboapply.xx.0000000000000000.js', 'roboapply.en.js', 'roboapply.en.0000000000000000.json'])('404 for %s', async (file) => {
    expect((await request(file)).status).toBe(404);
  });
});
