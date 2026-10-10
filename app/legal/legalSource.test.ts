// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { LEGAL_BLOCKS } from '../../components/features/compliance/legalCatalog';
import { brandEnvValue, fillInline, inlineValues, listLegalDocsForPage, loadLegalDocForPage, type LegalBrandInfo } from './legalSource';

const RA: LegalBrandInfo = { id: 'roboapply', market: 'intl', name: 'RoboApply', replyTo: 'support@roboapply.io' };
const GA: LegalBrandInfo = { id: 'goapply', market: 'cn', name: 'GoApply', replyTo: 'support@goapply.top' };

describe('/legal/[doc] loader', () => {
  it('RoboApply documents render as drafts with inline values filled and block markers kept', () => {
    const r = loadLegalDocForPage(RA, 'privacy', { NODE_ENV: 'production', LEGAL_ENTITY_NAME: 'Example Ltd' });
    expect(r.kind).toBe('doc');
    if (r.kind !== 'doc') return;
    expect(r.doc).toMatchObject({ doc: 'privacy', title: 'Privacy notice', draft: true, version: null, lang: 'en' });
    expect(r.doc.body).toContain('Example Ltd');
    expect(r.doc.body).toContain('{{retention_schedule}}');
    expect(r.doc.body).toContain('{{ai_models}}');
    // Only block placeholders stay (the page renders them live); every inline one is filled.
    expect(r.doc.body).toContain('{{processing_facts}}');
    expect(r.doc.body).toContain('{{llm_endpoints}}');
    expect(r.doc.body).not.toMatch(new RegExp(`\\{\\{(?!${LEGAL_BLOCKS.join('|')})`));
    expect(r.doc.body).not.toMatch(/^# /m); // the page renders the title
  });

  it('production GoApply is a 404 until CN_LEGAL_DOCS_VERSION is set and the file is approved', () => {
    expect(loadLegalDocForPage(GA, 'privacy', { NODE_ENV: 'production' }).kind).toBe('not_found');
    expect(loadLegalDocForPage(GA, 'privacy', { NODE_ENV: 'production', CN_LEGAL_DOCS_VERSION: 'v1' }).kind).toBe('not_found');
    const dev = loadLegalDocForPage(GA, 'privacy', { NODE_ENV: 'development' });
    expect(dev.kind === 'doc' && dev.doc.draft).toBe(true);
  });

  it('aliases redirect; documents of the other market 404', () => {
    expect(loadLegalDocForPage(GA, 'agreement', {})).toEqual({ kind: 'redirect', to: 'terms' });
    expect(loadLegalDocForPage(GA, 'personal-info-list', {})).toEqual({ kind: 'redirect', to: 'pi-collection-list' });
    expect(loadLegalDocForPage(GA, 'ai-disclosure', {})).toEqual({ kind: 'redirect', to: 'ai-content-labels' });
    expect(loadLegalDocForPage(GA, 'cookies', {}).kind).toBe('not_found');
    expect(loadLegalDocForPage(RA, 'pi-collection-list', {}).kind).toBe('not_found');
    expect(loadLegalDocForPage(RA, '../../package', {}).kind).toBe('not_found');
  });

  it('every footer document exists for both brands', () => {
    for (const [brand, docs] of [
      [RA, ['terms', 'privacy', 'cookies', 'ai-disclosure', 'subscription-terms', 'refunds', 'tw-pdpa-notice']],
      [GA, ['terms', 'privacy', 'pi-collection-list', 'third-party-sharing', 'ai-content-labels', 'complaints']],
    ] as const) {
      for (const d of docs) expect(loadLegalDocForPage(brand, d, {}).kind, `${brand.id}/${d}`).toBe('doc');
    }
  });

  it('brand env never falls back across brands; offshore notice follows DEPLOY_REGION', () => {
    expect(brandEnvValue(GA, 'LEGAL_ENTITY_NAME', { LEGAL_ENTITY_NAME: 'Intl Ltd' })).toBeNull();
    expect(brandEnvValue(GA, 'LEGAL_ENTITY_NAME', { CN_LEGAL_ENTITY_NAME: ' 某公司 ' })).toBe('某公司');
    expect(inlineValues(GA, {}).offshore_notice).toContain('美国');
    expect(inlineValues(GA, { DEPLOY_REGION: 'cn-mainland' }).offshore_notice).toContain('境内');
    expect(inlineValues(RA, {}).entity_name).toBe('Not listed');
    expect(inlineValues(GA, {}).entity_name).toBe('未披露');
    expect(inlineValues(RA, { GOHIRE_PARSE_BRANDS: 'goapply,roboapply' }).gohire_parse_notice).toContain('mainland China');
    expect(fillInline('{{brand}} {{ai_models}} {{unknown}}', { brand: 'X' })).toBe('X {{ai_models}} {{unknown}}');
  });
});

describe('WP-93: inline values and the /legal index list', () => {
  it('the takedown contact is TAKEDOWN_CONTACT, else the support address — per brand, no cross-brand fallback', () => {
    expect(inlineValues(RA, {}).takedown_contact).toBe('support@roboapply.io');
    expect(inlineValues(RA, { SUPPORT_EMAIL: 'help@example.test' }).takedown_contact).toBe('help@example.test');
    expect(inlineValues(RA, { TAKEDOWN_CONTACT: 'takedown@example.test', SUPPORT_EMAIL: 'help@example.test' }).takedown_contact).toBe('takedown@example.test');
    expect(inlineValues(GA, { TAKEDOWN_CONTACT: 'takedown@example.test' }).takedown_contact).toBe('support@goapply.top');
    expect(inlineValues(GA, { CN_TAKEDOWN_CONTACT: 'jubao@example.cn' }).takedown_contact).toBe('jubao@example.cn');
  });

  it('the collecting entity is CN_PAYMENT_COLLECTING_ENTITY, never invented', () => {
    expect(inlineValues(GA, {}).collecting_entity).toBe('未披露');
    expect(inlineValues(GA, { PAYMENT_COLLECTING_ENTITY: 'Intl Co' }).collecting_entity).toBe('未披露');
    expect(inlineValues(GA, { CN_PAYMENT_COLLECTING_ENTITY: '示例（上海）科技有限公司' }).collecting_entity).toBe('示例（上海）科技有限公司');
    const doc = loadLegalDocForPage(GA, 'terms', { NODE_ENV: 'development', CN_PAYMENT_COLLECTING_ENTITY: '示例（上海）科技有限公司' });
    expect(doc.kind === 'doc' && doc.doc.body).toContain('收款主体：示例（上海）科技有限公司');
    expect(doc.kind === 'doc' && doc.doc.body).toContain('不会自动续费');
  });

  it('every document of both brands leaves only block placeholders for the page', () => {
    const blocks = new RegExp(`\\{\\{(?!${LEGAL_BLOCKS.join('|')})`);
    for (const [brand, docs] of [
      [RA, ['terms', 'privacy', 'cookies', 'ai-disclosure', 'subscription-terms', 'refunds', 'tw-pdpa-notice']],
      [GA, ['terms', 'privacy', 'pi-collection-list', 'third-party-sharing', 'ai-content-labels', 'complaints']],
    ] as const) {
      for (const doc of docs) {
        const r = loadLegalDocForPage(brand, doc, { NODE_ENV: 'development' });
        expect(r.kind, `${brand.id}/${doc}`).toBe('doc');
        if (r.kind === 'doc') expect(r.doc.body, `${brand.id}/${doc}`).not.toMatch(blocks);
      }
    }
  });

  it('the index lists what can be served: every footer document in development, nothing on production GoApply', () => {
    const ra = listLegalDocsForPage(RA, 'en', { NODE_ENV: 'production' });
    expect(ra.map((d) => d.doc)).toEqual(['terms', 'privacy', 'cookies', 'ai-disclosure', 'subscription-terms', 'refunds']);
    expect(ra.every((d) => d.draft)).toBe(true);
    expect(listLegalDocsForPage(RA, 'zh-TW', {}).map((d) => d.doc)).toContain('tw-pdpa-notice');
    expect(listLegalDocsForPage(GA, 'zh', { NODE_ENV: 'development' }).map((d) => d.doc)).toEqual([
      'terms',
      'privacy',
      'pi-collection-list',
      'third-party-sharing',
      'ai-content-labels',
      'complaints',
    ]);
    expect(listLegalDocsForPage(GA, 'zh', { NODE_ENV: 'production' })).toEqual([]);
    expect(listLegalDocsForPage(GA, 'zh', { NODE_ENV: 'production', CN_LEGAL_DOCS_VERSION: 'v1' })).toEqual([]); // files are still drafts
  });
});
