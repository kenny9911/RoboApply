// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// The Simplified/Traditional variant guard of `npm run check` (its glossary lists mainland terms banned in zh-TW text).
import { checkBundle, loadGlossary } from '../../../../../scripts/check-zh-variants.mjs';
import { MAX_QUERY_SYNONYMS, providerQueryLabels, queryLabelsFor, type ProviderQueryLabel } from './queryLabels.js';
import { ALONE_ONLY_PHRASES, normalizeTitle } from './match.js';
import { TAXONOMY_NODES, getTaxonomyNode, taxonomyLabel } from './taxonomy.js';
import * as taxonomy from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../../..');
const CJK = /[㐀-鿿]/;
const ROLES = TAXONOMY_NODES.filter((n) => n.level === 3);
const texts = (labels: ProviderQueryLabel[]) => labels.map((l) => l.text);

describe('providerQueryLabels (SM-11)', () => {
  it('is part of the public surface of the taxonomy', () => {
    expect(taxonomy.providerQueryLabels).toBe(providerQueryLabels);
  });

  it('intl: the English label and up to two English synonyms, common names first', () => {
    expect(providerQueryLabels('backend_engineer', { market: 'intl' })).toEqual([
      { text: 'Backend engineer', language: 'en' },
      { text: 'backend developer', language: 'en' },
      { text: 'server engineer', language: 'en' },
    ]);
    expect(texts(providerQueryLabels('product_manager', { market: 'intl', country: 'US' }))).toEqual(['Product manager', 'product owner', 'product lead']);
    expect(texts(providerQueryLabels('registered_nurse', { market: 'intl' }))).toEqual(['Registered nurse', 'nurse', 'staff nurse']);
  });

  it('intl: only English text, for every role', () => {
    for (const role of ROLES) {
      const labels = providerQueryLabels(role.id, { market: 'intl', country: 'US' });
      expect(labels.length, role.id).toBeGreaterThanOrEqual(1);
      expect(labels.length, role.id).toBeLessThanOrEqual(MAX_QUERY_SYNONYMS + 1);
      for (const l of labels) {
        expect(l.language, role.id).toBe('en');
        expect(CJK.test(l.text), `${role.id}: ${l.text}`).toBe(false);
      }
      expect(new Set(texts(labels).map(normalizeTitle)).size, role.id).toBe(labels.length);
    }
  });

  it('caps the synonyms at two and leaves out what makes a poor query', () => {
    expect(MAX_QUERY_SYNONYMS).toBe(2);
    // "swe" and "sde" are three letters; the catch-all "developer" goes last and does not make the cut.
    expect(texts(providerQueryLabels('software_engineer', { market: 'intl' }))).toEqual(['Software engineer', 'programmer', 'software developer']);
    // "consultant" alone is the catch-all head noun: it is the last choice.
    expect(texts(providerQueryLabels('management_consultant', { market: 'intl' }))).not.toContain('consultant');
    for (const role of ROLES) {
      for (const text of texts(providerQueryLabels(role.id, { market: 'intl' })).slice(1)) {
        const key = normalizeTitle(text);
        expect(Object.hasOwn(ALONE_ONLY_PHRASES, key), `${role.id}: ${text}`).toBe(false);
        expect(key.includes(' ') || key.length > 3, `${role.id}: ${text}`).toBe(true);
      }
    }
  });

  it('a label that joins two names is not searched for: the synonyms stand in', () => {
    expect(texts(providerQueryLabels('chef', { market: 'intl' }))).toEqual(['chef', 'cook', 'line cook']);
    expect(texts(providerQueryLabels('nlp_engineer', { market: 'intl' }))).toEqual(['nlp engineer', 'llm engineer', 'prompt engineer']);
    expect(texts(providerQueryLabels('engineering_director', { market: 'intl' }))).not.toContain('Director of engineering / CTO');
    expect(texts(providerQueryLabels('academic_advisor', { market: 'cn' }))).toEqual(['留学顾问', '升学顾问', '招生顾问']);
  });

  it('cn: the Simplified label and up to two Chinese aliases, no English text', () => {
    expect(providerQueryLabels('backend_engineer', { market: 'cn' })).toEqual([
      { text: '后端开发工程师', language: 'zh-CN' },
      { text: '后端', language: 'zh-CN' },
      { text: '服务端', language: 'zh-CN' },
    ]);
    expect(texts(providerQueryLabels('frontend_engineer', { market: 'cn' }))).toEqual(['前端开发工程师', '前端', '前端开发']);
    expect(texts(providerQueryLabels('account_executive', { market: 'cn' }))).toEqual(['销售代表', '销售', '业务员']);
    // 新媒体 alone names the role only as a whole title (新媒体销售 is a sales job): not a query.
    expect(texts(providerQueryLabels('social_media_manager', { market: 'cn' }))).toEqual(['新媒体运营', '社群运营', '社区运营']);
    expect(texts(providerQueryLabels('product_operations', { market: 'cn' }))).toEqual(['产品运营', '活动运营', '平台运营']);
    expect(texts(providerQueryLabels('administrative_assistant', { market: 'cn' }))).not.toContain('行政');
    // The country does not matter for the mainland market.
    expect(providerQueryLabels('backend_engineer', { market: 'cn', country: 'TW' })).toEqual(providerQueryLabels('backend_engineer', { market: 'cn' }));
    const english = new Set(ROLES.flatMap((r) => [r.en, ...r.synonyms.en]).map(normalizeTitle));
    for (const role of ROLES) {
      const labels = providerQueryLabels(role.id, { market: 'cn' });
      expect(labels.length, role.id).toBeGreaterThanOrEqual(1);
      expect(labels.length, role.id).toBeLessThanOrEqual(MAX_QUERY_SYNONYMS + 1);
      for (const l of labels) {
        expect(l.language, role.id).toBe('zh-CN');
        // Chinese text, or the role's own Chinese-market label when that is a Latin name ("HRBP").
        expect(CJK.test(l.text) || l.text === role.zh, `${role.id}: ${l.text}`).toBe(true);
        if (CJK.test(l.text)) expect(english.has(normalizeTitle(l.text)), `${role.id}: ${l.text}`).toBe(false);
      }
    }
  });

  it('Taiwan: English only until the role has a Traditional label, and never the Simplified one', () => {
    const glossary = loadGlossary(repoRoot);
    for (const role of ROLES) {
      const tw = providerQueryLabels(role.id, { market: 'intl', country: 'TW' });
      const english = providerQueryLabels(role.id, { market: 'intl' });
      const zhHant = taxonomyLabel(role.id, 'zh-TW');
      const hasTraditional = !!zhHant && CJK.test(zhHant);
      // Before the Taiwan labels exist `taxonomyLabel(id, 'zh-TW')` is the English label: nothing is added.
      expect(tw.filter((l) => l.language === 'en'), role.id).toEqual(english);
      expect(tw.filter((l) => l.language === 'zh-TW').length, role.id).toBe(hasTraditional ? 1 : 0);
      for (const l of tw) {
        expect(l.language === 'zh-CN', role.id).toBe(false);
        if (l.language !== 'zh-TW') continue;
        // No mainland wording in a Taiwan query (the variant guard of `npm run check`).
        expect(checkBundle(glossary, 'queryLabels.zh-TW.json', 'zh-TW', { text: l.text }), `${role.id}: ${l.text}`).toEqual([]);
      }
    }
    // Lower case and padding in the country code do not matter; another country gets no Chinese text.
    expect(providerQueryLabels('backend_engineer', { market: 'intl', country: ' tw ' })).toEqual(providerQueryLabels('backend_engineer', { market: 'intl', country: 'TW' }));
    expect(providerQueryLabels('backend_engineer', { market: 'intl', country: 'HK' }).every((l) => l.language === 'en')).toBe(true);
  });

  it('Taiwan: one zh-TW item once a Traditional label exists', () => {
    const node = getTaxonomyNode('backend_engineer')!;
    const glossary = loadGlossary(repoRoot);
    const withLabel = queryLabelsFor(node, { market: 'intl', country: 'TW', zhHantLabel: '後端工程師' });
    expect(withLabel).toEqual([
      { text: 'Backend engineer', language: 'en' },
      { text: 'backend developer', language: 'en' },
      { text: 'server engineer', language: 'en' },
      { text: '後端工程師', language: 'zh-TW' },
    ]);
    expect(checkBundle(glossary, 'queryLabels.zh-TW.json', 'zh-TW', { text: withLabel.at(-1)!.text })).toEqual([]);
    // The fallback of `taxonomyLabel` (the English label), an empty label and no label add nothing.
    for (const zhHantLabel of ['Backend engineer', 'backend engineer', '', '  ', null, undefined]) {
      expect(queryLabelsFor(node, { market: 'intl', country: 'TW', zhHantLabel }).some((l) => l.language === 'zh-TW'), String(zhHantLabel)).toBe(false);
    }
    // Outside Taiwan a Traditional label is not used, and the mainland market never takes it.
    expect(queryLabelsFor(node, { market: 'intl', country: 'US', zhHantLabel: '後端工程師' }).some((l) => l.language === 'zh-TW')).toBe(false);
    expect(queryLabelsFor(node, { market: 'cn', country: 'TW', zhHantLabel: '後端工程師' }).every((l) => l.language === 'zh-CN')).toBe(true);
    // The helper of the variant guard does flag mainland wording, so the check above means something.
    expect(checkBundle(glossary, 'queryLabels.zh-TW.json', 'zh-TW', { text: '软件工程师' }).length).toBeGreaterThan(0);
  });

  it('an unknown id, a category and a role group give no texts', () => {
    expect(providerQueryLabels('not_a_role', { market: 'intl' })).toEqual([]);
    expect(providerQueryLabels('', { market: 'cn' })).toEqual([]);
    expect(providerQueryLabels('software_engineering', { market: 'intl' })).toEqual([]);
    expect(providerQueryLabels('swe_backend', { market: 'cn' })).toEqual([]);
  });
});
