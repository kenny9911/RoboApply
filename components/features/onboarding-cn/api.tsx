'use client';

// components/features/onboarding-cn/api.tsx — the requests the GoApply steps make, behind one
// injectable context (tests and the onboarding page may pass their own).
//
// Every call goes through an area wrapper in lib/api (no raw paths here):
//   save a step         putOnboardingStep           (lib/api/onboarding, WP-30's route; GoApply bodies
//                                                     validated by server/src/features/onboarding-cn)
//   stored answers      getOnboardingState
//   consent prose       getSignupConsents           (lib/api/compliance, WP-13; nothing pre-checked)
//   current answers     getConsents                 (resume gate: is AI processing on?)
//   record a consent    recordConsent               (resume gate: turning AI processing on later)
//   role typeahead      getTaxonomy                 (lib/api/search, WP-20; zh labels)
//   open-jobs panel     getMarketSnapshot           (lib/api/onboarding; WP-30 dispatches GoApply to
//                                                     onboarding-cn's index counts)
//   campus programmes   listCampusEvents / subscribeCampus (lib/api/campus, WP-58)
// When INT mounts /onboarding/cn (handoff), `marketSnapshot` switches to the
// cn route (every role and city in one count, plus the campus count and the
// median) through `cnSnapshotView`. Until then a search with several roles or
// cities shows the count for one of them, named in the copy (`scope`).

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import { getOnboardingState, getMarketSnapshot, putOnboardingStep } from '../../../lib/api/onboarding';
import { getConsents, getSignupConsents, recordConsent } from '../../../lib/api/compliance';
import { getTaxonomy } from '../../../lib/api/search';
import { listCampusEvents, subscribeCampus } from '../../../lib/api/campus';
import type { MarketSnapshotResponse, OnboardingStateResponse, StepResponse } from '../../../lib/api/contracts/onboarding';
import type { CnMarketSnapshotResponse } from '../../../lib/api/contracts/onboarding-cn';
import type { ConsentCatalogItem, RecordConsentResponse } from '../../../lib/api/contracts/compliance';
import type { CampusEventView } from '../../../lib/api/contracts/cn/campus';
import { CN_ANY_CITY } from './logic';

/**
 * What a job count covers. `complete` = the whole search (one role, at most one
 * city). Otherwise the count is for `role` (and `city`) only, and the copy
 * names them: WP-30's route takes one taxonomy id and one city, so a search
 * with several roles or cities is never shown as a single total (D3).
 */
export interface CnSnapshotScope {
  complete: boolean;
  role: string;
  city: string | null;
}

/**
 * Pay for the panel, monthly CNY only.
 *   - `iqr`: onboarding-cn's own figures (median, 25th–75th percentile).
 *   - `range`: WP-30's `low`/`high`, whose meaning that contract does not
 *     state; shown as a plain range, never as "the middle half".
 */
export type CnPayView =
  | { kind: 'iqr'; median: number; low: number; high: number; listedCount: number; sampleSize: number; asOf: string }
  | { kind: 'range'; low: number; high: number; listedCount: number; sampleSize: number; asOf: string };

/** What the open-jobs panel and the confirm page show. Every number has a source and date (D3). */
export interface CnSnapshotView {
  jobs: { value: number; asOf: string; scope: CnSnapshotScope };
  /** Null when no campus count is available. `more` = at least this many. `asOf` only when the server states one. */
  campusOpen: { value: number; more: boolean; asOf: string | null } | null;
  /** Null below 20 postings that list monthly CNY pay. */
  pay: CnPayView | null;
}

export interface CnSnapshotQuery {
  roles: Array<{ taxonomyId?: string; label: string }>;
  cities: string[];
  classYear?: number | null;
}

/** Campus programmes open now. `more` = the list has further pages, so the count is "at least". */
export interface CnProgramList {
  items: CampusEventView[];
  more: boolean;
}

export interface CnOnboardingApi {
  getState(): Promise<OnboardingStateResponse>;
  saveStep(step: string, body: Record<string, unknown>): Promise<StepResponse>;
  getConsents(locale: string): Promise<ConsentCatalogItem[]>;
  /** The signed-in user's consents with their current answers (the ledger, not the onboarding answers). */
  getMyConsents(locale: string): Promise<ConsentCatalogItem[]>;
  recordConsent(input: { type: string; granted: boolean; proseVersion: string; locale: string }): Promise<RecordConsentResponse>;
  suggestRoles(q: string, locale: string): Promise<Array<{ taxonomyId: string; label: string; context: string | null }>>;
  marketSnapshot(q: CnSnapshotQuery): Promise<CnSnapshotView | null>;
  /** Every chosen city (不限 or none = all cities). */
  campusPrograms(q: { classYear?: number | null; cities?: readonly string[] }): Promise<CnProgramList | null>;
  subscribeProgram(eventId: string): Promise<void>;
}

/** The role and city WP-30's single-role snapshot is asked for, and whether that is the whole search. */
export function snapshotScope(q: CnSnapshotQuery): (CnSnapshotScope & { taxonomyId: string }) | null {
  const role = q.roles.find((r) => r.taxonomyId);
  if (!role?.taxonomyId) return null;
  const cities = q.cities.filter((c) => c !== CN_ANY_CITY);
  return { taxonomyId: role.taxonomyId, role: role.label, city: cities[0] ?? null, complete: q.roles.length === 1 && cities.length <= 1 };
}

/** WP-30's pay block → the panel's, only for monthly CNY (anything else is not shown). */
export function payFromOnboarding(pay: MarketSnapshotResponse['pay']): CnPayView | null {
  if (!pay || pay.currency !== 'CNY' || pay.period !== 'month') return null;
  return { kind: 'range', low: pay.low, high: pay.high, listedCount: pay.listedCount, sampleSize: pay.sampleSize, asOf: pay.asOf };
}

/**
 * The cn route's answer (GET /onboarding/cn/market-snapshot, every role and
 * city at once) → the panel's view. For `defaultCnOnboardingApi` once INT
 * mounts that route and adds its lib/api wrapper.
 */
export function cnSnapshotView(res: CnMarketSnapshotResponse, role: string): CnSnapshotView {
  return {
    jobs: { value: res.jobCount.value, asOf: res.jobCount.asOf, scope: { complete: true, role, city: null } },
    campusOpen: { value: res.campusOpenCount.value, more: false, asOf: res.campusOpenCount.asOf },
    pay: res.pay
      ? { kind: 'iqr', median: res.pay.medianMonthly, low: res.pay.p25Monthly, high: res.pay.p75Monthly, listedCount: res.pay.listedCount, sampleSize: res.pay.sampleSize, asOf: res.pay.asOf }
      : null,
  };
}

async function campusPrograms(q: { classYear?: number | null; cities?: readonly string[] }): Promise<CnProgramList | null> {
  const cities = (q.cities ?? []).filter((c) => c !== CN_ANY_CITY);
  const base = { openNow: 'true' as const, ...(q.classYear ? { class: q.classYear } : {}) };
  try {
    // One request per chosen city (the route takes one); merged without duplicates.
    const pages = await Promise.all(cities.length ? cities.map((city) => listCampusEvents({ ...base, city })) : [listCampusEvents(base)]);
    const seen = new Set<string>();
    const items: CampusEventView[] = [];
    for (const page of pages) {
      for (const e of page.items) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        items.push(e);
      }
    }
    return { items, more: pages.some((p) => !!p.cursor) };
  } catch {
    return null;
  }
}

export const defaultCnOnboardingApi: CnOnboardingApi = {
  getState: () => getOnboardingState(),
  saveStep: (step, body) => putOnboardingStep(step, body),
  async getConsents(locale) {
    return (await getSignupConsents({ locale })).items;
  },
  async getMyConsents(locale) {
    return (await getConsents({ locale })).items;
  },
  recordConsent: (input) => recordConsent(input),
  async suggestRoles(q, locale) {
    const res = await getTaxonomy({ q, locale });
    return res.suggestions.filter((s) => s.level >= 2).map((s) => ({ taxonomyId: s.id, label: s.label, context: s.context }));
  },
  async marketSnapshot(q) {
    const scope = snapshotScope(q);
    const [jobs, campus] = await Promise.all([
      scope
        ? getMarketSnapshot({ taxonomyId: scope.taxonomyId, country: 'CN', ...(scope.city ? { city: scope.city } : {}) }).catch(() => null)
        : Promise.resolve(null),
      campusPrograms({ classYear: q.classYear, cities: q.cities }),
    ]);
    if (!jobs || !scope) return null;
    return {
      jobs: { value: jobs.jobCount.value, asOf: jobs.jobCount.asOf, scope: { complete: scope.complete, role: scope.role, city: scope.city } },
      // listCampusEvents states no as-of time, so none is shown (never the browser clock).
      campusOpen: campus ? { value: campus.items.length, more: campus.more, asOf: null } : null,
      pay: payFromOnboarding(jobs.pay),
    };
  },
  campusPrograms: (q) => campusPrograms(q),
  async subscribeProgram(eventId) {
    await subscribeCampus({ kind: 'event', eventId, channel: 'in_app' });
  },
};

const Ctx = createContext<CnOnboardingApi>(defaultCnOnboardingApi);

/** Override some or all requests (tests, previews). */
export function CnOnboardingApiProvider({ api, children }: { api: Partial<CnOnboardingApi>; children: ReactNode }) {
  const value = useMemo(() => ({ ...defaultCnOnboardingApi, ...api }), [api]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCnOnboardingApi(): CnOnboardingApi {
  return useContext(Ctx);
}
