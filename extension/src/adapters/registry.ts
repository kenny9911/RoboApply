// extension/src/adapters/registry.ts — which adapters a brand build ships, and
// the forms we know about but do not fill yet (stubs WP-70 / WP-71 replace by
// adding real adapters to adapters/intl or adapters/cn).

import { CN_ADAPTERS } from './cn/index';
import { INTL_ADAPTERS } from './intl/index';
import type { AtsAdapter, AtsType } from './types';

export type AdapterSet = 'intl' | 'cn';

export interface PlannedSite {
  id: AtsType;
  siteName: string;
  domains: string[];
}

/** Known form hosts without an adapter yet: the popup offers "Request this site" for them. */
export const PLANNED_SITES: Record<AdapterSet, readonly PlannedSite[]> = {
  intl: [
    { id: 'workday', siteName: 'Workday', domains: ['myworkdayjobs.com', 'myworkdaysite.com'] },
    { id: 'smartrecruiters', siteName: 'SmartRecruiters', domains: ['jobs.smartrecruiters.com'] },
    { id: 'icims', siteName: 'iCIMS', domains: ['icims.com'] },
    { id: 'workable', siteName: 'Workable', domains: ['apply.workable.com'] },
    { id: 'taleo', siteName: 'Taleo', domains: ['taleo.net'] },
    { id: 'successfactors', siteName: 'SuccessFactors', domains: ['successfactors.com', 'successfactors.eu'] },
  ],
  cn: [
    { id: 'moka', siteName: 'Moka', domains: ['mokahr.com'] },
    { id: 'beisen', siteName: 'Beisen', domains: ['zhiye.com', 'beisen.com'] },
    { id: 'feishu', siteName: 'Feishu', domains: ['feishu.cn'] },
    { id: 'dayee', siteName: 'Dayee', domains: ['dayee.com'] },
  ],
};

export function adaptersFor(set: AdapterSet): readonly AtsAdapter[] {
  return set === 'cn' ? CN_ADAPTERS : INTL_ADAPTERS;
}

/** Planned sites that have since gained a real adapter drop out automatically. */
export function plannedSitesFor(set: AdapterSet): PlannedSite[] {
  const shipped = new Set(adaptersFor(set).map((a) => a.id));
  return PLANNED_SITES[set].filter((p) => !shipped.has(p.id));
}

export function plannedSiteForUrl(url: URL, set: AdapterSet): PlannedSite | null {
  const host = url.hostname.toLowerCase();
  return plannedSitesFor(set).find((p) => p.domains.some((d) => host === d || host.endsWith(`.${d}`))) ?? null;
}

/** Host match patterns of every shipped adapter (manifest host permissions + content scripts). */
export function adapterHostPatterns(set: AdapterSet): string[] {
  return [...new Set(adaptersFor(set).flatMap((a) => a.hostPatterns))];
}
