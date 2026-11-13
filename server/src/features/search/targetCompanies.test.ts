// @vitest-environment node
//
// "Companies you want to work at" (targetCompanies.ts): names compare as the
// feed compares companies, so a list entry, a posting's company and the job
// page's control all agree on what "this company" is.

import { describe, expect, it } from 'vitest';
import { normalizeCompanyName } from '../jobs/normalize/index.js';
import { isTargetCompany, targetCompanyKey, targetCompanyKeys, withTargetCompany } from './targetCompanies.js';

describe('targetCompanyKeys / isTargetCompany', () => {
  it('compares by the normalized company name: case, legal forms and bracketed notes do not count', () => {
    const keys = targetCompanyKeys(['Stripe', ' figma, Inc. ', '腾讯科技（深圳）有限公司', '', '   ']);
    expect(keys).toEqual(new Set(['stripe', 'figma', '腾讯科技']));
    expect(targetCompanyKey('Stripe, Inc.')).toBe(normalizeCompanyName('Stripe, Inc.'));
    expect(isTargetCompany({ companyName: 'STRIPE INC' }, keys)).toBe(true);
    expect(isTargetCompany({ companyName: 'Figma' }, keys)).toBe(true);
    expect(isTargetCompany({ companyName: '腾讯科技(深圳)有限公司' }, keys)).toBe(true);
    expect(isTargetCompany({ companyName: 'Stripe Partners Ltd' }, keys)).toBe(false);
  });

  it('reads the stored key first (RAJob.companyNameNormalized), else the name', () => {
    const keys = targetCompanyKeys(['Acme']);
    expect(isTargetCompany({ companyName: 'Something else', companyNameNormalized: 'acme' }, keys)).toBe(true);
    expect(isTargetCompany({ companyName: 'Acme Corp', companyNameNormalized: null }, keys)).toBe(true);
    expect(isTargetCompany({ companyName: 'Acme Corp', companyNameNormalized: '  ' }, keys)).toBe(true);
  });

  it('an empty or missing list matches nothing', () => {
    expect(isTargetCompany({ companyName: 'Acme' }, new Set())).toBe(false);
    expect(isTargetCompany({ companyName: 'Acme' }, null)).toBe(false);
    expect(isTargetCompany({ companyName: '' }, targetCompanyKeys(['Acme']))).toBe(false);
    expect(targetCompanyKeys(undefined).size).toBe(0);
  });
});

describe('withTargetCompany', () => {
  it('adds a company at the end, in the spelling given, and keeps the other entries as they are', () => {
    expect(withTargetCompany(['Figma'], '  Stripe ', true)).toEqual({ list: ['Figma', 'Stripe'], changed: true });
    expect(withTargetCompany(undefined, 'Stripe', true)).toEqual({ list: ['Stripe'], changed: true });
  });

  it('adding a company the list already names, in any spelling, changes nothing', () => {
    expect(withTargetCompany(['Stripe', 'Figma'], 'stripe, inc.', true)).toEqual({ list: ['Stripe', 'Figma'], changed: false });
  });

  it('taking a company off removes every entry that names it, and nothing else', () => {
    expect(withTargetCompany(['Stripe', 'Figma', 'STRIPE INC'], 'Stripe', false)).toEqual({ list: ['Figma'], changed: true });
    expect(withTargetCompany(['Figma'], 'Stripe', false)).toEqual({ list: ['Figma'], changed: false });
    expect(withTargetCompany(['Stripe'], 'Stripe', false)).toEqual({ list: [], changed: true });
  });

  it('a blank name changes nothing; a name with nothing left after normalization compares as typed', () => {
    expect(withTargetCompany(['Figma'], '   ', true)).toEqual({ list: ['Figma'], changed: false });
    expect(withTargetCompany(['!!'], '!!', true)).toEqual({ list: ['!!'], changed: false });
    expect(withTargetCompany(['!!', 'Figma'], '!!', false)).toEqual({ list: ['Figma'], changed: true });
  });
});
