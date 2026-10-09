// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { brandEnvValue, fillInline, inlineValues, loadLegalDocForPage, type LegalBrandInfo } from './legalSource';

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
    expect(r.doc.body).not.toMatch(/\{\{(?!retention_schedule|ai_models|processors)/);
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
