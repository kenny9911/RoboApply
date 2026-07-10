// Settings endpoints. Mounted at /api/v1/roboapply/settings.
// Plus billing portal link helper.

import { roboApi } from './client';
import type {
  RoboBillingPortalLink,
  RoboBillingTier,
  RoboReviewMode,
  RoboSettings,
} from './types';

export function getSettings(): Promise<RoboSettings> {
  return roboApi.get<RoboSettings>('/api/v1/roboapply/settings');
}

export interface UpdateSettingsInput {
  reviewMode?: RoboReviewMode;
  dailyCap?: number;
  coverLetterToneOverride?: string | null;
  enabled?: boolean;
}

export function updateSettings(input: UpdateSettingsInput) {
  return roboApi.patch<RoboSettings>(
    '/api/v1/roboapply/settings',
    input,
  );
}

// ---------------------------------------------------------------------------
// Billing — proxies to existing seeker billing surface
// ---------------------------------------------------------------------------

export function getBillingTiers() {
  return roboApi.get<{ tiers: RoboBillingTier[] }>(
    '/api/v1/roboapply/settings/billing/tiers',
  );
}

export function getBillingPortal() {
  return roboApi.post<RoboBillingPortalLink>(
    '/api/v1/roboapply/settings/billing/portal',
  );
}

// Account deletion lives in lib/api/account.ts (accountApi.deleteAccount →
// /api/v1/roboapply/account/delete), which the account page uses. The server
// also keeps /settings/account/delete wired to the same flow for old clients.
