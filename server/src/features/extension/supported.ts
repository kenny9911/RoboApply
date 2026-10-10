// server/src/features/extension/supported.ts — the ATS types the extension
// can fill today, per market (WP-55b: Greenhouse, Lever, Ashby; WP-70:
// Workday, SmartRecruiters, iCIMS, Workable, Taleo, SuccessFactors; WP-71:
// Moka, Beisen, Feishu, Dayee on GoApply, whose list is those four plus the
// whole RoboApply list: D5, the portal list is a superset). Job detail answers
// `autofill.supported` / `extensionSupported` from WP-34's registry, so a
// job page offers "Fill this form" only where an adapter exists.
//
// WP-34's registry takes one brand-agnostic type set (both markets' lists)
// plus `extensionOffersFill` (Wave 5 gate): the brand's own market list, the
// application URL on a host the adapter has a permission for
// (`EXTENSION_ATS_HOST_PATTERNS`), and no page-by-page form until one run
// covers a whole application (R4, WP-93). The web button also checks the
// brand's list (`bridge.ts#extensionFillsAts`).

import { registerExtensionAtsTypes } from '../jobs/detail/index.js';
import { EXTENSION_ATS_TYPES_BY_MARKET, extensionOffersFill } from './contract.js';

/** RoboApply's list (kept for existing importers). */
export const EXTENSION_ATS_TYPES = EXTENSION_ATS_TYPES_BY_MARKET.intl;

/** The ATS types the extension can fill for one market. */
export function extensionAtsTypesFor(market: 'intl' | 'cn'): readonly string[] {
  return EXTENSION_ATS_TYPES_BY_MARKET[market];
}

let registered = false;

/** Idempotent; called when the extension router is built. */
export function registerSupportedAtsTypes(): void {
  if (registered) return;
  registered = true;
  registerExtensionAtsTypes([...new Set<string>([...EXTENSION_ATS_TYPES_BY_MARKET.intl, ...EXTENSION_ATS_TYPES_BY_MARKET.cn])], extensionOffersFill);
}
