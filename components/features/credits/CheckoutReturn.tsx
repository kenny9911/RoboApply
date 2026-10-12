'use client';

// CheckoutReturn — /settings/billing/return, where the payment page sends the
// buyer back (TASK_PLAN.md §4.1.b route shell; WP-21b). The plan changes
// only when the server has the payment (webhook), so this page re-reads the
// credit summary a few times and says plainly when it is still waiting. It
// never shows a purchase as done before the server does.
//
// What "done" means depends on what was bought (`?plan=`, set by the plan
// sheet in `next`):
//   - Pro (subscription or pass), or no plan named: the summary says Pro.
//   - A practice pack: the practice balance rose above `?practiceBefore=`
//     (the balance the plan sheet saw before checkout). Without that baseline
//     there is nothing to compare, so the page says neutrally that the
//     interviews are added when the payment clears — no polling, no warning.
//   - GoApply, back from WeChat Pay in a mobile browser (H5): the return URL
//     carries `?order=<our order number>` and no outcome, because WeChat
//     sends the buyer back whether or not they paid. The page then asks the
//     server about that order and keeps asking while it is pending
//     (billing-cn `WechatPayReturn`). The heading follows the order: "checking"
//     only while it is pending, then paid / not completed / a neutral title
//     when the body points to support, a refund, or a failed status check.
//
// Reconcile (ST-3; MARKET_STRATEGY §5.1 "Lost-event recovery"). A one-time
// card payment has a single notification from the payment provider; if it is
// lost, nothing else would ever add the pass or the pack. So, back from the
// card payment page with its Checkout Session id (`?session_id=cs_…`), this
// page asks the server to settle that session: once when it opens, and again
// on every third re-read while it is still waiting. The server runs the same
// claimed fulfilment as the notification, so whichever arrives second changes
// nothing. Rules:
//   - only on success, with a session id, on the international brand (the
//     card rail is its rail; a mainland page never calls it);
//   - the answer is never shown as "done": after any answer the credit
//     summary is read again, and only the summary (or the practice balance
//     for a pack) turns the page to done;
//   - `pending` keeps the page waiting and asking;
//   - an answer that asking again cannot change (403 not this buyer's
//     session, 404, 422, 503 cards not set up) ends the calls and leaves the
//     ordinary waiting / "taking longer" copy.

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { useBrand } from '../../../lib/brand/BrandProvider';
import { accountApi, checkoutSessionId } from '../../../lib/api/account';
import { RoboApiError } from '../../../lib/api/client';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import { useCredits, useInvalidateCredits } from '../../../hooks/shared/useCredits';
import { WechatPayReturn, isOrderNumber, type WechatPayReturnState } from '../billing-cn';
import styles from './credits.module.css';

export const RETURN_POLL_MS = 3000;
export const RETURN_POLL_ATTEMPTS = 10;
/** The session is handed to the server again on every Nth re-read of the summary. */
export const RETURN_RECONCILE_EVERY = 3;

/** Reconcile refusals that asking again cannot change (the contract's error codes). */
const RECONCILE_FINAL_STATUS = new Set([403, 404, 422]);
const RECONCILE_FINAL_CODES = new Set(['forbidden', 'not_found', 'invalid_request', 'stripe_not_configured', 'feature_disabled', 'not_implemented']);

/** True when a failed reconcile call should not be repeated. A timeout, a 429 or a provider error may pass, so those are asked again. */
export function reconcileRefusalIsFinal(err: unknown): boolean {
  if (!(err instanceof RoboApiError)) return false;
  if (typeof err.status === 'number' && RECONCILE_FINAL_STATUS.has(err.status)) return true;
  const code = apiErrorCode(err);
  return !!code && RECONCILE_FINAL_CODES.has(code);
}

export interface CheckoutReturnProps {
  outcome: 'success' | 'cancel' | null;
  /** The plan bought (`?plan=`), when the plan sheet passed it. */
  planKey?: string | null;
  /** Practice balance before checkout (`?practiceBefore=`), for a pack. */
  practiceBefore?: number | null;
  /**
   * The WeChat Pay order to check (`?order=`, set by the H5 return URL).
   * Omitted, it is read from the address; `null` means there is none.
   */
  orderId?: string | null;
  /**
   * The card payment page's Checkout Session (`?session_id=`), already
   * checked by the route. With it the page asks the server to settle the
   * purchase instead of only waiting for it.
   */
  sessionId?: string | null;
  pollMs?: number;
}

export function isPackKey(planKey: string | null | undefined): boolean {
  return !!planKey && planKey.startsWith('practice_pack_');
}

/** Which heading a WeChat Pay order's state gets on the return page. */
export function orderTitleKind(state: WechatPayReturnState): 'checking' | 'paid' | 'notPaid' | 'neutral' {
  if (state === 'paid') return 'paid';
  if (state === 'closed' || state === 'failed') return 'notPaid';
  if (state === 'checking' || state === 'pending') return 'checking';
  // needs_support, refunded, a failed status check: the body explains; the heading claims nothing.
  // (`unavailable` is never shown: the page falls back to the ordinary return page.)
  return 'neutral';
}

/** GoApply, back from WeChat Pay H5: the heading and the order check, kept in step. */
function CnOrderReturn({ orderId, onPaid, onUnavailable }: { orderId: string; onPaid: () => void; onUnavailable: () => void }) {
  const t = useTranslations('credits.return');
  const tCn = useTranslations('billingCn.return');
  const [state, setState] = useState<WechatPayReturnState>('checking');
  const kind = orderTitleKind(state);
  const title = kind === 'paid' ? t('successTitle') : kind === 'notPaid' ? t('cancelTitle') : kind === 'checking' ? t('unknownTitle') : tCn('statusTitle');
  return (
    <div className={styles.page} data-testid="checkout-return" data-outcome="order">
      <h1 className={styles.title}>{title}</h1>
      <WechatPayReturn orderId={orderId} onPaid={onPaid} onStatus={(next) => (next === 'unavailable' ? onUnavailable() : setState(next))} />
    </div>
  );
}

export function CheckoutReturn({ outcome, planKey = null, practiceBefore = null, orderId, sessionId = null, pollMs = RETURN_POLL_MS }: CheckoutReturnProps) {
  const t = useTranslations('credits.return');
  const brand = useBrand();
  const params = useSearchParams();
  const { data } = useCredits();
  const invalidate = useInvalidateCredits();
  const [attempts, setAttempts] = useState(0);
  // The last reconcile answer said "not settled yet": the page keeps waiting.
  const [reconcilePending, setReconcilePending] = useState(false);

  const order = orderId === undefined ? (params?.get('order') ?? null) : orderId;
  // The server said WeChat Pay is not set up on this deployment: there is no order to show.
  const [cnOrderUnavailable, setCnOrderUnavailable] = useState(false);
  // Only GoApply has orders to look up. The lookup does NOT wait for WeChat Pay to be on sale: an order that was
  // in flight when the kill switch closed new purchases still completes, and its buyer lands here.
  const cnOrder = brand.market === 'cn' && isOrderNumber(order) && !cnOrderUnavailable ? order : null;

  // The card rail is the international brand's; a mainland page never reconciles.
  const session = outcome === 'success' && brand.market === 'intl' ? checkoutSessionId(sessionId) : null;
  // 'open': may be asked (again) · 'asking': a call is in flight · 'closed': no further call.
  const reconcileState = useRef<'open' | 'asking' | 'closed'>('open');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reconcile = useCallback(() => {
    if (!session || reconcileState.current !== 'open') return;
    reconcileState.current = 'asking';
    accountApi
      .reconcileCheckout(session)
      .then(
        (res) => {
          // Settled (now, or earlier by the notification): nothing more to ask.
          reconcileState.current = res.status === 'pending' ? 'open' : 'closed';
          if (mounted.current) setReconcilePending(res.status === 'pending');
        },
        (err: unknown) => {
          reconcileState.current = reconcileRefusalIsFinal(err) ? 'closed' : 'open';
          if (mounted.current) setReconcilePending(false);
        },
      )
      // Whatever the answer, the summary is what the page believes: read it again.
      .finally(() => {
        if (mounted.current) void invalidate();
      });
  }, [session, invalidate]);

  // Once when the page opens (also when the summary already reads Pro: a second pass may still be missing).
  const askedOnOpen = useRef(false);
  useEffect(() => {
    if (!session || askedOnOpen.current) return;
    askedOnOpen.current = true;
    reconcile();
  }, [session, reconcile]);

  const pack = isPackKey(planKey);
  const balance = data?.practice?.balance ?? null;
  const canTell = !pack || practiceBefore !== null;
  const active = pack
    ? practiceBefore !== null && balance !== null && balance > practiceBefore
    : data?.summary.planProfile === 'pro';
  // A pack with no balance to compare against is only waited for while the server says the payment is not settled yet.
  const waiting = outcome === 'success' && (canTell || reconcilePending) && !active && attempts < RETURN_POLL_ATTEMPTS;

  useEffect(() => {
    if (!waiting) return;
    const id = window.setTimeout(() => {
      const next = attempts + 1;
      setAttempts(next);
      void invalidate();
      if (next % RETURN_RECONCILE_EVERY === 0) reconcile();
    }, pollMs);
    return () => window.clearTimeout(id);
  }, [waiting, attempts, invalidate, pollMs, reconcile]);

  let title: string;
  let body: string;
  if (outcome === 'cancel') {
    title = t('cancelTitle');
    body = t('cancelSub');
  } else if (outcome === 'success') {
    title = t('successTitle');
    if (pack) {
      if (active && balance !== null) body = t('packActive', { n: balance });
      else if (waiting) body = t('packPending');
      else body = t('packPaid');
    } else {
      body = active ? t('successActive') : waiting ? t('successPending') : t('slow');
    }
  } else {
    title = t('unknownTitle');
    body = t('unknownSub');
  }

  if (cnOrder) {
    // The plan and the practice balance changed on the server once it is paid.
    return <CnOrderReturn orderId={cnOrder} onPaid={() => void invalidate()} onUnavailable={() => setCnOrderUnavailable(true)} />;
  }

  return (
    <div className={styles.page} data-testid="checkout-return" data-outcome={outcome ?? 'unknown'}>
      <h1 className={styles.title}>{title}</h1>
      <div className={`${styles.notice} ${outcome === 'success' && active ? styles.ok : ''}`} role="status" aria-busy={waiting || undefined}>
        <p className={styles.body}>{body}</p>
      </div>
      <div className={styles.actions}>
        <Link href="/settings#billing" className={styles.link}>
          {t('back')}
        </Link>
      </div>
    </div>
  );
}

export default CheckoutReturn;
