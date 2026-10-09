// server/src/features/jobs/normalize/company.ts
//
// The RACompany upsert payload for a job's company (ARCH §4.4 "Company").
// D3: a company field is filled only from a provider / bank statement that
// names its source, and each filled field gets a provenance entry in `facts`
// ({ source, url?, fetchedAt }). Size and industry are never guessed.

import type { Market } from '../../../platform/brand/index.js';
import { cleanOrNull, hostOf, safeUrl, truncate } from './text.js';
import type { CompanyFactsInput, CompanyUpsert } from './types.js';
import { toDate } from './identity.js';

export const SIZE_BANDS = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001+'] as const;
export type SizeBand = (typeof SIZE_BANDS)[number];

/** The band an employee count falls in. */
export function sizeBandFromCount(count: number | null | undefined): SizeBand | null {
  if (count == null || !Number.isFinite(count) || count < 1) return null;
  if (count <= 10) return '1-10';
  if (count <= 50) return '11-50';
  if (count <= 200) return '51-200';
  if (count <= 500) return '201-500';
  if (count <= 1000) return '501-1000';
  if (count <= 5000) return '1001-5000';
  return '5001+';
}

/** A provider size text ("51-200 employees", "10,001+", "1001-5000", "500人以上") → band, only when it fits one band exactly. */
export function sizeBandFromText(text: string | null | undefined): SizeBand | null {
  if (!text) return null;
  const s = text.normalize('NFKC').replace(/[,，\s]/g, '');
  const range = s.match(/^(\d+)[-–~至](\d+)/);
  if (range) {
    const lo = sizeBandFromCount(Number(range[1]));
    const hi = sizeBandFromCount(Number(range[2]));
    return lo && lo === hi ? lo : null;
  }
  const plus = s.match(/^(\d+)(?:\+|人以上|以上)/);
  if (plus && Number(plus[1]) > 5000) return '5001+';
  return null;
}

export interface CompanyInput {
  market: Market;
  displayName: string;
  nameNormalized: string;
  logoUrl: string | null;
  isAgency: boolean | null;
  bankCompanyRef: string | null;
  facts: CompanyFactsInput | null | undefined;
  /** Provenance for the logo when no facts block is given (e.g. 'provider:activejobs'). */
  logoSource: string;
  now: Date;
}

export function buildCompanyUpsert(input: CompanyInput): CompanyUpsert {
  const f = input.facts;
  const source = cleanOrNull(f?.source);
  const fetchedAt = (toDate(f?.fetchedAt ?? null) ?? input.now).toISOString();
  const url = safeUrl(f?.url ?? null);
  const provenance = source ? { source, ...(url ? { url } : {}), fetchedAt } : null;

  const out: CompanyUpsert = {
    market: input.market,
    displayName: input.displayName,
    nameNormalized: input.nameNormalized,
    logoUrl: safeUrl(input.logoUrl),
    isAgency: input.isAgency,
    bankCompanyRef: cleanOrNull(input.bankCompanyRef),
    website: null,
    domain: null,
    industries: [],
    sizeBand: null,
    employeeCount: null,
    hqLocation: null,
    foundedYear: null,
    description: null,
    facts: {},
  };
  if (out.logoUrl) out.facts.logoUrl = provenance ? { ...provenance } : { source: input.logoSource, fetchedAt };
  if (!f || !provenance) return out;

  const set = <K extends keyof CompanyUpsert>(key: K, value: CompanyUpsert[K] | null) => {
    if (value == null || (Array.isArray(value) && value.length === 0)) return;
    out[key] = value as CompanyUpsert[K];
    out.facts[key as string] = { ...provenance };
  };

  const website = safeUrl(f.website ?? null);
  set('website', website);
  set('domain', cleanOrNull(f.domain)?.toLowerCase().replace(/^www\./, '') ?? hostOf(website));
  set('industries', (f.industries ?? []).map((i) => cleanOrNull(i)).filter((i): i is string => !!i).slice(0, 5));
  const count = typeof f.employeeCount === 'number' && Number.isFinite(f.employeeCount) && f.employeeCount > 0 ? Math.round(f.employeeCount) : null;
  set('employeeCount', count);
  set('sizeBand', sizeBandFromCount(count) ?? sizeBandFromText(f.size));
  set('hqLocation', cleanOrNull(f.hqLocation));
  const year = typeof f.foundedYear === 'number' && f.foundedYear >= 1600 && f.foundedYear <= input.now.getUTCFullYear() ? f.foundedYear : null;
  set('foundedYear', year);
  const description = cleanOrNull(f.description);
  set('description', description ? truncate(description, 2000) : null);
  return out;
}
