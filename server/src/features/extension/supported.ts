// server/src/features/extension/supported.ts — the ATS types the extension
// can fill today, per market (WP-55b ships the Greenhouse, Lever and Ashby
// adapters for RoboApply; the GoApply build targets Moka / Beisen / Feishu /
// Dayee and has no adapter until WP-71). Job detail answers
// `autofill.supported` / `extensionSupported` from WP-34's registry, so a
// job page offers "Fill this form" only where an adapter exists.
//
// WP-34's registry (`registerExtensionAtsTypes`) is one brand-agnostic set,
// so only the RoboApply list is registered there; GoApply's list is empty,
// and the web button checks the brand's own list too
// (`extensionAtsTypesFor` / bridge.ts) until the registry takes a market
// (request to WP-34 in the WP-55a handoff).

import { registerExtensionAtsTypes } from '../jobs/detail/index.js';
import { EXTENSION_ATS_TYPES_BY_MARKET } from './contract.js';

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
  registerExtensionAtsTypes(EXTENSION_ATS_TYPES_BY_MARKET.intl);
}
