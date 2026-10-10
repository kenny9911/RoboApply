// @vitest-environment node
//
// FND-7: lib/i18n.ts merges the staged English (i18n/staging) over en.json
// before deriving the other locales, so a key a feature WP stages renders —
// in English — in every locale until INT translates it, instead of next-intl
// printing the raw dotted path (ARCHITECTURE.md §10.1.2).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { STAGING_EN, STAGING_NAMESPACES } from '../../i18n/staging/index';
import { loadMessages } from '../../lib/i18n';
import { LOCALES } from '../../lib/localeConfig';

type Tree = Record<string, unknown>;
const at = (obj: unknown, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Tree | undefined)?.[k], obj);
const bundle = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), 'i18n/messages', `${locale}.json`), 'utf8')) as Tree;

function leafPaths(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return prefix ? [prefix] : [];
  return Object.entries(obj as Tree).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

describe('staged English at runtime', () => {
  it('an English key a locale has not translated renders in English there (never the dotted path)', () => {
    // FND-4 staged the taxonomy category labels and WP-91 merged them into
    // en.json. A locale shows its own translation once it has one (WP-92);
    // until then, and for any key staged later, it shows the English.
    const key = 'taxonomy.categories.software_engineering';
    expect(at(bundle('en'), key)).toBe('Software engineering');
    for (const locale of LOCALES) {
      const own = at(bundle(locale), key);
      expect(at(loadMessages(locale), key), locale).toBe(typeof own === 'string' ? own : 'Software engineering');
    }
    const ownZh = at(bundle('zh'), key);
    expect(at(loadMessages('zh', 'goapply'), key)).toBe(typeof ownZh === 'string' ? ownZh : 'Software engineering');
  });

  it('every string still in staging renders in every locale that has no translation of it', () => {
    // Empty right after a merge (`npm run i18n:merge -- --check`); feature work stages new keys here again.
    const en = bundle('en');
    for (const path of leafPaths(STAGING_EN)) {
      const staged = at(STAGING_EN, path);
      expect(at(loadMessages('en'), path), path).toBe(staged);
      for (const locale of LOCALES) {
        if (locale === 'en' || typeof at(bundle(locale), path) === 'string') continue;
        expect(at(loadMessages(locale), path), `${locale}:${path}`).toBe(staged);
      }
      // Staging wins over en.json for the same key.
      if (typeof at(en, path) === 'string') expect(at(loadMessages('en'), path)).toBe(staged);
    }
  });

  it('translated keys still win over English in their locale', () => {
    const zhSave = at(loadMessages('zh'), 'common.save');
    expect(typeof zhSave).toBe('string');
    expect(zhSave).not.toBe(at(loadMessages('en'), 'common.save'));
  });

  it('existing namespaces survive an (empty) staging namespace of the same name', () => {
    expect(STAGING_NAMESPACES).toContain('jobs');
    expect(Object.keys((at(loadMessages('en'), 'jobs') as Tree) ?? {}).length).toBeGreaterThan(5);
  });

  it('extension package namespaces are not part of the web bundle', () => {
    expect(STAGING_NAMESPACES).not.toContain('extension');
    expect(STAGING_NAMESPACES).not.toContain('extension-cn');
    expect(STAGING_NAMESPACES).toContain('extensionWeb');
  });
});
