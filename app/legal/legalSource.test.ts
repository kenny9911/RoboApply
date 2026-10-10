// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

  it('GoApply documents are served by the same rule as RoboApply: in production a draft is a 200 with the draft notice (D5; G112)', () => {
    for (const slug of ['terms', 'privacy', 'coaching']) {
      const r = loadLegalDocForPage(GA, slug, { NODE_ENV: 'production' });
      expect(r.kind, slug).toBe('doc');
      if (r.kind !== 'doc') continue;
      expect(r.doc, slug).toMatchObject({ doc: slug, draft: true, version: null, lang: 'zh' });
      expect(r.doc.body.length, slug).toBeGreaterThan(50);
    }
    // With a documents version the version is shown; the draft notice goes only when the file itself is approved.
    const versioned = loadLegalDocForPage(GA, 'privacy', { NODE_ENV: 'production', CN_LEGAL_DOCS_VERSION: 'v1' });
    expect(versioned.kind === 'doc' && versioned.doc).toMatchObject({ version: 'v1', draft: true });
    const dev = loadLegalDocForPage(GA, 'privacy', { NODE_ENV: 'development' });
    expect(dev.kind === 'doc' && dev.doc.draft).toBe(true);
  });

  it('the draft notice is gone once the brand version is set and the file is approved (both brands, one rule)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'legal-page-'));
    try {
      for (const [market, file] of [['cn', 'privacy'], ['intl', 'privacy']] as const) {
        mkdirSync(path.join(dir, market), { recursive: true });
        writeFileSync(path.join(dir, market, `${file}.md`), '---\ntitle: T\nstatus: published\nupdated: 2026-11-01\n---\n# T\n\nBody {{version}}\n');
      }
      const env = { NODE_ENV: 'production', LEGAL_CONTENT_DIR: dir };
      for (const [brand, name] of [[GA, 'CN_LEGAL_DOCS_VERSION'], [RA, 'LEGAL_DOCS_VERSION']] as const) {
        const published = loadLegalDocForPage(brand, 'privacy', { ...env, [name]: '2026-11.v1' });
        expect(published.kind === 'doc' && published.doc, brand.id).toMatchObject({ draft: false, version: '2026-11.v1' });
        // Without the brand's own version the same approved file is still a draft.
        const unversioned = loadLegalDocForPage(brand, 'privacy', env);
        expect(unversioned.kind === 'doc' && unversioned.doc.draft, brand.id).toBe(true);
      }
      // RoboApply's version never publishes a GoApply document.
      const crossed = loadLegalDocForPage(GA, 'privacy', { ...env, LEGAL_DOCS_VERSION: '2026-11.v1' });
      expect(crossed.kind === 'doc' && crossed.doc).toMatchObject({ draft: true, version: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
      [GA, ['terms', 'privacy', 'pi-collection-list', 'third-party-sharing', 'ai-content-labels', 'complaints', 'coaching']],
    ] as const) {
      for (const d of docs) {
        expect(loadLegalDocForPage(brand, d, {}).kind, `${brand.id}/${d}`).toBe('doc');
        expect(loadLegalDocForPage(brand, d, { NODE_ENV: 'production' }).kind, `${brand.id}/${d} (production)`).toBe('doc');
      }
    }
  });

  it('identity values never fall back across brands; the cross-border notice is a live block, not a typed sentence', () => {
    expect(brandEnvValue(GA, 'LEGAL_ENTITY_NAME', { LEGAL_ENTITY_NAME: 'Intl Ltd' })).toBeNull();
    expect(brandEnvValue(GA, 'LEGAL_ENTITY_NAME', { CN_LEGAL_ENTITY_NAME: ' 某公司 ' })).toBe('某公司');
    // Whether personal information leaves the mainland follows the stack in use, which only the
    // server can tell: the page renders {{offshore_notice}} from the disclosures. No country or
    // region is typed into the page loader any more.
    expect(LEGAL_BLOCKS).toContain('offshore_notice');
    expect('offshore_notice' in inlineValues(GA, {})).toBe(false);
    for (const env of [{}, { DEPLOY_REGION: 'cn-mainland' }]) {
      const privacy = loadLegalDocForPage(GA, 'privacy', env);
      expect(privacy.kind === 'doc' && privacy.doc.body).toContain('{{offshore_notice}}');
      expect(privacy.kind === 'doc' && privacy.doc.body).not.toMatch(/处理地区为美国|内测阶段/);
    }
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

  it('the index lists every footer document of the brand, in development and in production, on both brands', () => {
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
    // Production GoApply lists the same documents, each marked as a draft until it is published (the /legal index is a 200).
    for (const env of [{ NODE_ENV: 'production' }, { NODE_ENV: 'production', CN_LEGAL_DOCS_VERSION: 'v1' }]) {
      const ga = listLegalDocsForPage(GA, 'zh', env);
      expect(ga.map((d) => d.doc)).toEqual(['terms', 'privacy', 'pi-collection-list', 'third-party-sharing', 'ai-content-labels', 'complaints']);
      expect(ga.every((d) => d.draft)).toBe(true); // the files are still drafts
    }
  });
});
