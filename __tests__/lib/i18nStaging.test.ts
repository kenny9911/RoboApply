// @vitest-environment node
//
// FND-7: lib/i18n.ts merges the staged English (i18n/staging) over en.json
// before deriving the other locales, so a key a feature WP stages renders —
// in English — in every locale until INT translates it, instead of next-intl
// printing the raw dotted path (ARCHITECTURE.md §10.1.2).

import { describe, expect, it } from 'vitest';

import { STAGING_EN, STAGING_NAMESPACES } from '../../i18n/staging/index';
import { loadMessages } from '../../lib/i18n';
import { LOCALES } from '../../lib/localeConfig';

type Tree = Record<string, unknown>;
const at = (obj: unknown, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Tree | undefined)?.[k], obj);

describe('staged English at runtime', () => {
  it('a staged key renders in English under zh (and every other locale)', () => {
    // FND-4 staged the taxonomy category labels; no locale bundle has them yet.
    const key = 'taxonomy.categories.software_engineering';
    expect(at(STAGING_EN, key)).toBe('Software engineering');
    for (const locale of LOCALES) {
      expect(at(loadMessages(locale), key), locale).toBe('Software engineering');
    }
    expect(at(loadMessages('zh', 'goapply'), key)).toBe('Software engineering');
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
