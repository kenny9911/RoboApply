/**
 * subscriptionGate — the single source of truth for "is this user allowed
 * to consume LLM-based features right now?"
 *
 * Pure function (no DB access) so it's cheap to call once per request and
 * once again at WS upgrade. Inputs are the User fields already loaded by
 * `requireAuth` / `resolveUserFromTokens`; the result rides on
 * `req.user.subscriptionGate` and is also surfaced on `/api/auth/me`.
 *
 * Grace period
 * ────────────
 * A paid subscription that lapses (currentPeriodEnd in the past) or gets
 * flipped to `past_due` by Stripe does NOT lock immediately. The user keeps
 * AI access for `graceDays` (default 5, admin-configurable globally + per
 * user) — usage keeps counting during the window. The lock only fires once
 * `now >= currentPeriodEnd + graceDays`. The effective `graceDays` is
 * resolved by the caller (per-user override ?? global default — see
 * lib/subscriptionGraceConfig.ts) and passed in; absent → DEFAULT_GRACE_DAYS.
 *
 * Decision rules (top-down — first match wins):
 *
 *   1. Admin / internal staff → never locked.
 *   2. !isActive → locked, reason='admin_disabled' (the hard admin-disable;
 *      end users hit 401 from `requireAuth` first).
 *   3. Free tier → 14-day trial. STATUS-AGNOSTIC: any free user (trialing OR
 *      active) past their trial anchor + grace locks, reason='trial_ended'. The
 *      anchor is currentPeriodEnd (= trialEnd at signup), falling back to
 *      trialEnd then createdAt + FREE_TRIAL_DAYS. Kill switch reverts to the old
 *      always-unlocked-free behavior platform-wide: FREE_TRIAL_GATING=disabled.
 *   4. Paid tier + Stripe "not paying" status (past_due / canceled / unpaid /
 *      incomplete_expired) → grace-checked: in-grace while within the window,
 *      otherwise locked.
 *   5. Paid tier + active/trialing but currentPeriodEnd elapsed (webhook-
 *      missed window) → grace-checked, reason='expired'.
 *   6. Otherwise → not locked. The frontend reads daysUntilExpiration for the
 *      T-5 renewal banner and daysUntilGraceEnd for the in-grace banner.
 */

import { DEFAULT_GRACE_DAYS, clampGraceDays } from './subscriptionGraceConfig.js';
import { FREE_TRIAL_DAYS } from './tierPeriod.js';

export type SubscriptionLockReason =
  | 'expired'
  | 'trial_ended' // free 14-day trial lapsed (distinct from a paid 'expired')
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'incomplete_expired'
  | 'admin_disabled';

/**
 * Coarse lifecycle bucket for admin display. Distinct from the raw
 * `subscriptionStatus` string because it folds in computed signals
 * (grace window, T-5 expiry, admin disable). Single source of truth for the
 * admin pills + the dedicated Subscriptions view.
 */
export type SubscriptionState =
  | 'free'
  | 'active'
  | 'trialing'
  | 'expiring_soon' // active/trialing, ≤ WARN_DAYS to currentPeriodEnd
  | 'in_grace' // lapsed/past_due but within the grace window (NOT locked)
  | 'expired' // locked: past the grace window
  | 'canceled'
  | 'admin_disabled';

export interface SubscriptionGateResult {
  locked: boolean;
  /** Underlying reason — populated even during grace so banners can show context. */
  reason: SubscriptionLockReason | null;
  /** Date the lock took/will take effect — currentPeriodEnd for expired, now() for past_due, null otherwise. */
  expiredAt: string | null;
  /**
   * Days until the subscription expires (currentPeriodEnd). Positive = still
   * active, frontend may render a T-5 warning. Negative = already past. Null
   * when there's no period anchor (free / custom / never-paid).
   */
  daysUntilExpiration: number | null;
  /** True when the period/status has lapsed but we're still inside the grace window (locked=false). */
  inGracePeriod: boolean;
  /** ISO date when the grace window ends and the lock takes effect. Null when no anchor. */
  graceEndsAt: string | null;
  /** Days left in the grace window (≥0 while in grace). Null when no anchor. */
  daysUntilGraceEnd: number | null;
  /** Effective grace days used for this evaluation. */
  graceDays: number;
}

export interface SubscriptionGateInput {
  subscriptionTier: string | null | undefined;
  subscriptionStatus: string | null | undefined;
  currentPeriodEnd: Date | string | null | undefined;
  isActive: boolean | null | undefined;
  role: string | null | undefined;
  /** Effective grace days (per-user override ?? global default), resolved by the caller. */
  graceDays?: number | null;
  /**
   * Free-tier trial anchor fallbacks. The free gate anchors on
   * `currentPeriodEnd ?? trialEnd ?? (createdAt + FREE_TRIAL_DAYS)`. For a normal
   * free user currentPeriodEnd === trialEnd (set together by computeTierPeriod),
   * so passing currentPeriodEnd alone is sufficient; trialEnd / createdAt only
   * matter for legacy rows whose currentPeriodEnd was never populated. Optional
   * so existing paid-tier callers need not thread them.
   */
  trialEnd?: Date | string | null;
  createdAt?: Date | string | null;
}

/** Days-to-expiry threshold at/below which the T-5 renewal banner shows. */
export const WARN_DAYS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

const LOCKED_STATUSES = new Set([
  'past_due',
  'canceled',
  'unpaid',
  'incomplete_expired',
]);

const ACTIVE_STATUSES = new Set(['active', 'trialing']);

const EXEMPT_ROLES = new Set(['admin', 'internal']);

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function daysBetween(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / DAY_MS);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function effectiveGraceDays(input: number | null | undefined): number {
  if (input == null || !Number.isFinite(input)) return DEFAULT_GRACE_DAYS;
  return clampGraceDays(input);
}

/**
 * Shared grace-window evaluation for an elapsed anchor (paid period end OR free
 * trial end). Within the window → not locked (inGracePeriod). Past it → locked.
 * With no anchor we cannot grant grace, so lock immediately.
 */
function graceCheckedResult(
  anchor: Date | null,
  reason: SubscriptionLockReason,
  now: Date,
  graceDays: number,
): SubscriptionGateResult {
  const graceEndsAt = anchor ? new Date(anchor.getTime() + graceDays * DAY_MS) : null;
  const daysUntilExpiration = anchor ? daysBetween(now, anchor) : null;

  if (graceEndsAt && now.getTime() < graceEndsAt.getTime()) {
    return {
      locked: false,
      reason,
      expiredAt: (anchor ?? now).toISOString(),
      daysUntilExpiration,
      inGracePeriod: true,
      graceEndsAt: graceEndsAt.toISOString(),
      daysUntilGraceEnd: daysBetween(now, graceEndsAt),
      graceDays,
    };
  }

  return {
    locked: true,
    reason,
    expiredAt: (anchor ?? now).toISOString(),
    daysUntilExpiration,
    inGracePeriod: false,
    graceEndsAt: graceEndsAt ? graceEndsAt.toISOString() : null,
    daysUntilGraceEnd: graceEndsAt ? daysBetween(now, graceEndsAt) : null,
    graceDays,
  };
}

export function evaluateSubscriptionGate(
  user: SubscriptionGateInput,
  now: Date = new Date(),
): SubscriptionGateResult {
  const graceDays = effectiveGraceDays(user.graceDays);

  const unlocked = (daysUntilExpiration: number | null): SubscriptionGateResult => ({
    locked: false,
    reason: null,
    expiredAt: null,
    daysUntilExpiration,
    inGracePeriod: false,
    graceEndsAt: null,
    daysUntilGraceEnd: null,
    graceDays,
  });

  const role = (user.role ?? '').toLowerCase();
  if (EXEMPT_ROLES.has(role)) {
    return unlocked(null);
  }

  // `isActive` defaults to true server-side; treat undefined as true.
  if (user.isActive === false) {
    return {
      locked: true,
      reason: 'admin_disabled',
      expiredAt: null,
      daysUntilExpiration: null,
      inGracePeriod: false,
      graceEndsAt: null,
      daysUntilGraceEnd: null,
      graceDays,
    };
  }

  const tier = (user.subscriptionTier ?? 'free').toLowerCase();
  const status = (user.subscriptionStatus ?? 'active').toLowerCase();
  const periodEnd = toDate(user.currentPeriodEnd);

  if (tier === 'free') {
    // Free is a 14-day trial. It gates once the trial anchor passes the grace
    // window — STATUS-AGNOSTIC: any free user (trialing OR active) past their
    // anchor locks, reason='trial_ended'. Kill switch reverts to the old
    // always-unlocked-free behavior platform-wide: FREE_TRIAL_GATING=disabled.
    if (process.env.FREE_TRIAL_GATING === 'disabled') {
      return unlocked(periodEnd ? daysBetween(now, periodEnd) : null);
    }
    // Anchor = currentPeriodEnd (set = trialEnd at signup) ?? trialEnd ??
    // createdAt + FREE_TRIAL_DAYS. currentPeriodEnd is primary so every gate
    // caller (which all pass it) stays consistent; the other two are fallbacks
    // for legacy free rows whose currentPeriodEnd was never populated.
    const createdAt = toDate(user.createdAt);
    const anchor =
      periodEnd ??
      toDate(user.trialEnd) ??
      (createdAt ? addDays(createdAt, FREE_TRIAL_DAYS) : null);
    if (!anchor) {
      // No anchor we can compute → leave open (cannot date a trial we can't see).
      return unlocked(null);
    }
    if (now.getTime() < anchor.getTime()) {
      // Trial still running → open; surface daysUntilExpiration for the T-5 banner.
      return unlocked(daysBetween(now, anchor));
    }
    // Trial lapsed → grace-checked lock.
    return graceCheckedResult(anchor, 'trial_ended', now, graceDays);
  }

  const isLockedStatus = LOCKED_STATUSES.has(status);
  const isExpiredActive =
    ACTIVE_STATUSES.has(status) && !!periodEnd && periodEnd.getTime() < now.getTime();

  if (isLockedStatus || isExpiredActive) {
    const reason: SubscriptionLockReason = isLockedStatus
      ? (status as SubscriptionLockReason)
      : 'expired';
    return graceCheckedResult(periodEnd, reason, now, graceDays);
  }

  // Healthy paid (active/trialing with period in the future, or no anchor).
  return {
    locked: false,
    reason: null,
    expiredAt: null,
    daysUntilExpiration: periodEnd ? daysBetween(now, periodEnd) : null,
    inGracePeriod: false,
    graceEndsAt: null,
    daysUntilGraceEnd: null,
    graceDays,
  };
}

export interface SubscriptionDescription {
  state: SubscriptionState;
  gate: SubscriptionGateResult;
  graceEndsAt: string | null;
  daysUntilExpiration: number | null;
  daysUntilGraceEnd: number | null;
}

/**
 * Compute the coarse `SubscriptionState` (for admin pills + the Subscriptions
 * view) alongside the full gate result. Single source of truth so the admin
 * UI and the gate never disagree.
 */
export function describeSubscription(
  user: SubscriptionGateInput,
  now: Date = new Date(),
): SubscriptionDescription {
  const gate = evaluateSubscriptionGate(user, now);
  const role = (user.role ?? '').toLowerCase();
  const tier = (user.subscriptionTier ?? 'free').toLowerCase();
  const status = (user.subscriptionStatus ?? 'active').toLowerCase();

  let state: SubscriptionState;
  if (user.isActive === false) {
    state = 'admin_disabled';
  } else if (EXEMPT_ROLES.has(role)) {
    state = tier === 'free' ? 'free' : 'active';
  } else if (tier === 'free') {
    // A free user within/after their (gating) trial shows lifecycle states like
    // a paid sub — status-agnostic, mirroring evaluateSubscriptionGate's anchor.
    // A free user without ANY anchor (or with gating disabled) is plain 'free'.
    const createdAt = toDate(user.createdAt);
    const anchor =
      toDate(user.currentPeriodEnd) ??
      toDate(user.trialEnd) ??
      (createdAt ? addDays(createdAt, FREE_TRIAL_DAYS) : null);
    const gatingOn = process.env.FREE_TRIAL_GATING !== 'disabled';
    if (!gatingOn || !anchor) {
      state = 'free';
    } else if (gate.locked) {
      state = 'expired';
    } else if (gate.inGracePeriod) {
      state = 'in_grace';
    } else if (
      gate.daysUntilExpiration != null &&
      gate.daysUntilExpiration >= 0 &&
      gate.daysUntilExpiration <= WARN_DAYS
    ) {
      state = 'expiring_soon';
    } else {
      state = 'trialing';
    }
  } else if (gate.locked) {
    state = gate.reason === 'canceled' ? 'canceled' : 'expired';
  } else if (gate.inGracePeriod) {
    state = 'in_grace';
  } else if (status === 'canceled') {
    state = 'canceled';
  } else if (status === 'trialing') {
    state = 'trialing';
  } else if (
    gate.daysUntilExpiration != null &&
    gate.daysUntilExpiration >= 0 &&
    gate.daysUntilExpiration <= WARN_DAYS
  ) {
    state = 'expiring_soon';
  } else {
    state = 'active';
  }

  return {
    state,
    gate,
    graceEndsAt: gate.graceEndsAt,
    daysUntilExpiration: gate.daysUntilExpiration,
    daysUntilGraceEnd: gate.daysUntilGraceEnd,
  };
}

/**
 * Convenience helper for the auditor / admin tools — returns the
 * `subscriptionStatus` value we want to set on a paid user whose period
 * has lapsed without a renewal webhook. `'past_due'` matches our locked-
 * status set so the (grace-aware) gate fires once the grace window closes.
 */
export function deriveStaleStatus(): 'past_due' {
  return 'past_due';
}
