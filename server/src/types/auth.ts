// Auth-related type definitions

import type { SubscriptionGateResult } from '../lib/subscriptionGate.js';

// User type for authenticated requests (public, no password hash)
export interface AuthUser {
  id: string;
  email: string;
  name?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  company?: string | null;
  avatar?: string | null;
  role?: string;
  provider?: string | null;
  providerId?: string | null;
  teamId?: string | null;
  // Hard admin-disable flag. False = `requireAuth` returns 401 with
  // code='ACCOUNT_DISABLED'. Distinct from subscription expiration (see
  // `subscriptionGate`). Defaults to true server-side; absence here is
  // treated as `true` by `evaluateSubscriptionGate`.
  isActive?: boolean;
  createdAt: Date;
  updatedAt: Date;
  // Subscription
  stripeCustomerId?: string | null;
  subscriptionTier?: string;
  subscriptionStatus?: string;
  subscriptionId?: string | null;
  currentPeriodEnd?: Date | null;
  /** Billing cadence of the active plan. Drives renewal period math. */
  billingInterval?: string | null;
  /**
   * True when the user is on a paid tier backed by a LIVE auto-renewing Stripe
   * subscription (Stripe charges every cycle automatically). Computed in
   * `toAuthenticatedUser`. When true the UI must NOT offer a manual one-time
   * Renew (it would double-bill) — it shows an "Auto-renews on {date}" state.
   */
  autoRenew?: boolean;
  /** Per-user grace-period override (days). Null/absent = global default. */
  subscriptionGraceDays?: number | null;
  trialEnd?: Date | null;
  interviewsUsed?: number;
  resumeMatchesUsed?: number;
  topUpBalance?: number;
  planMaxInterviews?: number | null;
  planMaxMatches?: number | null;
  effectiveMaxInterviews?: number | null;
  effectiveMaxMatches?: number | null;
  /** Computed subscription gate result; populated by `toAuthenticatedUser`. */
  subscriptionGate?: SubscriptionGateResult;
}

// API Key scope type
export type ApiKeyScope = 'read' | 'write';

// Extend Express User type to include our properties
declare global {
  namespace Express {
    interface User {
      id: string;
      email: string;
      name?: string | null;
      phone?: string | null;
      jobTitle?: string | null;
      company?: string | null;
      avatar?: string | null;
      role?: string;
      provider?: string | null;
      providerId?: string | null;
      teamId?: string | null;
      isActive?: boolean;
      createdAt: Date;
      updatedAt: Date;
      // Subscription
      stripeCustomerId?: string | null;
      subscriptionTier?: string;
      subscriptionStatus?: string;
      subscriptionId?: string | null;
      currentPeriodEnd?: Date | null;
      billingInterval?: string | null;
      autoRenew?: boolean;
      subscriptionGraceDays?: number | null;
      trialEnd?: Date | null;
      interviewsUsed?: number;
      resumeMatchesUsed?: number;
      topUpBalance?: number;
      planMaxInterviews?: number | null;
      planMaxMatches?: number | null;
      effectiveMaxInterviews?: number | null;
      effectiveMaxMatches?: number | null;
      subscriptionGate?: SubscriptionGateResult;
    }
    interface Request {
      requestId?: string;
      sessionToken?: string;
      apiKeyId?: string;
      apiKeyScopes?: ApiKeyScope[];
      payloadCapture?: {
        requestPayload: Record<string, unknown>;
        responsePayload: Record<string, unknown>;
      };
      /** Set to true to skip the default middleware audit log (e.g. when creating per-unit entries manually) */
      skipAudit?: boolean;
      /**
       * Per-request override of the classifier's (module, apiName) result.
       * Used when a route's URL doesn't reflect what the route actually does
       * (e.g. GET /resumes/:id may trigger a lazy LLM parse — set
       * { module: 'resume_parse', apiName: 'resume_lazy_parse' } so the row
       * lands in the right analytics bucket).
       */
      auditOverride?: {
        module?: string;
        apiName?: string;
      };
    }
  }
}

export {};
