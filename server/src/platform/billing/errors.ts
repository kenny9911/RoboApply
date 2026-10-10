// server/src/platform/billing/errors.ts
//
// Billing errors carry their own wire code (`plan_not_sellable`,
// `auto_renew_ack_required`, …) and HTTP status. Routes write them as the
// standard envelope `{ success: false, code, error, details? }` with
// `billingErrorBody()`; legacy `/billing` routes keep their `{ success, code,
// error }` shape, which is the same thing.

export const BILLING_ERROR_STATUS = {
  /** The plan key is unknown on this brand, unpriced, or not sold (legacy plans). */
  plan_not_sellable: 409,
  /** Auto-renewing plans need the unticked "renews automatically" acknowledgement. */
  auto_renew_ack_required: 422,
  /** The requested rail is not one of the brand's rails (GoApply never Stripe; RoboApply never Alipay for new purchases). */
  rail_not_allowed: 409,
  /** The rail is allowed but its credentials / switches are missing on this deployment. */
  rail_not_configured: 503,
  /** No implementation registered for the rail (e.g. WeChat Pay before WP-62). */
  rail_not_registered: 503,
  /** The user already has a live auto-renewing plan; use the switch flow. */
  already_subscribed: 409,
  /** A pass (no renewal) is running; a subscription can start once it ends (`details.availableFrom`). */
  pass_active: 409,
  /** Nothing to cancel or switch. */
  no_subscription: 409,
  /** Switching is only offered from an auto-renewing Stripe subscription to another auto-renewing plan. */
  switch_not_available: 409,
  /** The quoted proration date is too old (re-quote). */
  quote_expired: 409,
  /** The one-time cancel link is unknown, used or older than 30 minutes. */
  cancel_token_invalid: 410,
  /** The payment provider failed or returned something unexpected. */
  payment_provider_error: 502,
  /** No seeker profile to attach the purchase to. */
  no_profile: 409,
  /** The CN rail amount is not a whole yuan (the GoHire worker bills whole yuan). */
  price_not_whole_yuan: 503,
  /** Student plans need a live school-email verification (WP-79; F-ACCT-02). */
  student_verification_required: 403,
} as const;

export type BillingErrorCode = keyof typeof BILLING_ERROR_STATUS;

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: BillingErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.status = BILLING_ERROR_STATUS[code];
    this.details = details;
  }
}

export function isBillingError(err: unknown): err is BillingError {
  return err instanceof BillingError;
}

/** The error envelope for a BillingError. */
export function billingErrorBody(err: BillingError): { success: false; code: string; error: string; details?: Record<string, unknown> } {
  return err.details ? { success: false, code: err.code, error: err.message, details: err.details } : { success: false, code: err.code, error: err.message };
}
