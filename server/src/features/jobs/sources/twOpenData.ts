// server/src/features/jobs/sources/twOpenData.ts — Taiwan government open-data
// job vacancies (台灣就業通). GUARDED STUB (TASK_PLAN.md WP-42; CN_TW_LAUNCH_PLAN.md
// WP-TW-JOBS "TW open data", §5.1, T-5).
//
// Status of the licence spike: NOT CONFIRMED. Before any import we must
// confirm that the Ministry of Labor's job-vacancy dataset is published on
// data.gov.tw under the Open Government Data License, and check its fields
// and update cadence. That check needs a person (and Taiwan counsel for the
// licence reading); this work package could not perform it. Until then:
//   - no adapter is registered and nothing is fetched, whatever the env says;
//   - `twOpenDataStatus()` reports why, for the admin System panel.
//
// When the spike confirms the licence, implement `fetch` as a JobSourceAdapter
// (provider 'tw_open_data', markets ['intl'], JSON/CSV download only), show the
// attribution line TW_OPEN_DATA_ATTRIBUTION on every job from it, set
// TW_OPEN_DATA_LICENCE_CONFIRMED to true below in the same change, and register
// it next to ats_public. Env: TW_OPEN_DATA_JOBS_ENABLED, TW_OPEN_DATA_JOBS_URL.

import type { EnvSource } from '../../../platform/brand/index.js';
import { envSet, parseBoolEnv } from '../../../platform/brand/index.js';

/** Flip only in the change that implements the import, after the licence check. */
export const TW_OPEN_DATA_LICENCE_CONFIRMED: boolean = false;

/** Required attribution on every job from the dataset (data, not UI copy). */
export const TW_OPEN_DATA_ATTRIBUTION = '資料來源：台灣就業通（勞動部勞動力發展署）';

export type TwOpenDataStatus =
  | { enabled: true }
  | { enabled: false; reason: 'licence_unverified' | 'disabled' | 'url_missing' };

export function twOpenDataStatus(env: EnvSource = process.env): TwOpenDataStatus {
  if (!TW_OPEN_DATA_LICENCE_CONFIRMED) return { enabled: false, reason: 'licence_unverified' };
  if (!parseBoolEnv(env.TW_OPEN_DATA_JOBS_ENABLED)) return { enabled: false, reason: 'disabled' };
  if (!envSet(env, 'TW_OPEN_DATA_JOBS_URL')) return { enabled: false, reason: 'url_missing' };
  return { enabled: true };
}

/** Always false until the licence spike is confirmed (see header). */
export function twOpenDataEnabled(env: EnvSource = process.env): boolean {
  return twOpenDataStatus(env).enabled;
}
