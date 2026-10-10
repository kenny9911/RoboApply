// extension/src/adapters/intl/index.ts — RoboApply's form adapters.
//
// WP-55b ships Greenhouse, Lever and Ashby. WP-70 owns this folder and adds
// Workday, SmartRecruiters, iCIMS, Workable, Taleo, SuccessFactors and the
// label-heuristic generic adapter by appending to INTL_ADAPTERS (the manifest's
// host permissions follow this list; see src/manifest.ts).

import type { AtsAdapter } from '../types';
import { ashbyAdapter } from './ashby';
import { greenhouseAdapter } from './greenhouse';
import { leverAdapter } from './lever';

export const INTL_ADAPTERS: readonly AtsAdapter[] = [greenhouseAdapter, leverAdapter, ashbyAdapter];
