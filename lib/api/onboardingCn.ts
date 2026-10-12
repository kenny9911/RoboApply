// lib/api/onboardingCn.ts — GoApply onboarding data (届别 defaults, school and place lists, the open-jobs panel).
//
// Thin typed wrappers over the area contract (server/src/features/onboarding-cn,
// WP-31; wired by INT-08). The router is mounted at
// /api/v1/roboapply/onboarding/cn and answers 404 feature_disabled on
// RoboApply. The step answers themselves are saved through
// lib/api/onboarding.ts (PUT /onboarding/steps/:step).
//
// Endpoints:
//   GET    /api/v1/roboapply/onboarding/cn/schools
//   GET    /api/v1/roboapply/onboarding/cn/provinces
//   GET    /api/v1/roboapply/onboarding/cn/market-snapshot
//   GET    /api/v1/roboapply/onboarding/cn/defaults

import { call, type CallOptions, type In, withQuery } from './contracts/wire';
import type * as OC from './contracts/onboarding-cn';

const BASE = '/api/v1/roboapply/onboarding/cn';

/**
 * The market-snapshot query as the caller writes it. The route takes
 * comma-separated lists (`roles=产品经理,管培生`); `cnSnapshotQuery` builds them.
 */
export type CnMarketSnapshotParams = In<typeof OC.CnMarketSnapshotQuerySchema>;

/** `onboardingCn.schools` — GET /api/v1/roboapply/onboarding/cn/schools */
export function searchCnSchools(query: In<typeof OC.CnSchoolSearchQuerySchema>, opts?: CallOptions): Promise<OC.CnSchoolSearchResponse> {
  return call<OC.CnSchoolSearchResponse>('GET', withQuery(`${BASE}/schools`, query), opts);
}

/** `onboardingCn.provinces` — GET /api/v1/roboapply/onboarding/cn/provinces */
export function getCnProvinces(opts?: CallOptions): Promise<OC.CnProvincesResponse> {
  return call<OC.CnProvincesResponse>('GET', `${BASE}/provinces`, opts);
}

/** `onboardingCn.marketSnapshot` — GET /api/v1/roboapply/onboarding/cn/market-snapshot */
export function getCnMarketSnapshot(query?: CnMarketSnapshotParams, opts?: CallOptions): Promise<OC.CnMarketSnapshotResponse> {
  return call<OC.CnMarketSnapshotResponse>('GET', withQuery(`${BASE}/market-snapshot`, query), opts);
}

/** `onboardingCn.defaults` — GET /api/v1/roboapply/onboarding/cn/defaults */
export function getCnOnboardingDefaults(opts?: CallOptions): Promise<OC.CnOnboardingDefaultsResponse> {
  return call<OC.CnOnboardingDefaultsResponse>('GET', `${BASE}/defaults`, opts);
}

/**
 * Every chosen role and city as one snapshot query. Roles with a taxonomy id
 * go by id, the others by their label; 不限 (`any`) and an empty list mean
 * every city, so no city is sent. The route splits its lists on commas, so a
 * label or city that contains one cannot be sent: `exact` is then false and
 * the caller must not present the count as covering the whole search.
 */
export function cnSnapshotQuery(input: { roles: ReadonlyArray<{ taxonomyId?: string; label: string }>; cities: readonly string[]; classYear?: number | null }): {
  query: CnMarketSnapshotParams;
  exact: boolean;
} {
  const clean = (v: string) => v.trim();
  const sendable = (v: string) => v !== '' && !v.includes(',');
  const ids = input.roles.map((r) => r.taxonomyId).filter((x): x is string => !!x).map(clean);
  const labels = input.roles.filter((r) => !r.taxonomyId).map((r) => clean(r.label));
  const cityList = input.cities.map(clean).filter((c) => c !== '' && c !== 'any');
  const taxonomyIds = [...new Set(ids.filter(sendable))];
  const roles = [...new Set(labels.filter(sendable))];
  const cities = [...new Set(cityList.filter(sendable))];
  return {
    query: {
      ...(taxonomyIds.length ? { taxonomyIds: taxonomyIds.join(',') } : {}),
      ...(roles.length ? { roles: roles.join(',') } : {}),
      ...(cities.length ? { cities: cities.join(',') } : {}),
      ...(input.classYear ? { class: input.classYear } : {}),
    },
    exact: [...ids, ...labels, ...cityList].every(sendable) && taxonomyIds.length + roles.length > 0,
  };
}

/** Every wrapper of this area, for callers that prefer one import. */
export const onboardingCnApi = {
  searchCnSchools,
  getCnProvinces,
  getCnMarketSnapshot,
  getCnOnboardingDefaults,
};
