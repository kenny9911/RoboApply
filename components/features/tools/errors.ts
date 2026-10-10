// components/features/tools/errors.ts — plain-language text for a failed tool call (WP-57).

import { RoboApiError } from '../../../lib/api/client';
import { apiErrorCode, apiErrorDetails, apiErrorReason } from '../../../lib/api/contracts/wire';
import { CLIENT_LIMITS } from './catalog';

const REASONS = new Set([
  'file_missing',
  'file_unreadable',
  'file_too_large',
  'file_wrong_type',
  'consent_required',
  'posting_title_missing',
  'posting_too_short',
  'posting_too_long',
  'result_expired',
  'run_in_progress',
  'too_many_attempts',
]);

type T = (key: string, values?: Record<string, string | number>) => string;

/**
 * `t` bound to the `tools` namespace. `configLimit` = GET /config's
 * allowance; the 429's own `details.limit` (the effective allowance) wins.
 * With neither, the message names no number.
 */
export function toolErrorText(t: T, err: unknown, configLimit?: number | null): string {
  const reason = apiErrorReason(err);
  const values = { mb: Math.round(CLIENT_LIMITS.maxFileBytes / (1024 * 1024)), min: CLIENT_LIMITS.postingMinChars };
  if (reason && REASONS.has(reason)) return t(`errors.${reason}`, values);
  if (apiErrorCode(err) === 'rate_limited') {
    const fromServer = apiErrorDetails<{ limit?: unknown }>(err)?.limit;
    const limit = typeof fromServer === 'number' ? fromServer : (configLimit ?? null);
    return limit === null ? t('errors.rate_limited_unknown') : t('errors.rate_limited', { ...values, limit });
  }
  if (err instanceof RoboApiError && err.code === 'network_error') return t('errors.network');
  return t('errors.generic');
}
