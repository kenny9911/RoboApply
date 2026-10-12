'use client';

// WechatPayCheckout — GoApply checkout for one pass or practice pack with
// WeChat Pay v3 (TASK_PLAN.md WP-62; F-BILL-02/03/11 cn; CN-L-08).
//
//   - Prices and the pass length come from GET /billing/plans (D3: never
//     from copy); the payee is the collecting entity the server returns.
//   - Passes are one-time: the summary says it does not renew and nothing is
//     charged automatically. No deposit, no other fees.
//   - The agreement box starts unticked; paying is disabled until it is ticked
//     AND the agreement version is known (it is the acceptance record sent
//     with the order — never 'unversioned'). When the server answers
//     409 terms_outdated (a newer agreement was published), the box is
//     unticked and the agreement reloaded before the buyer can pay.
//   - Trade type by context: JSAPI inside WeChat (falls back to the QR code
//     when the account has no WeChat sign-in or the in-app cashier fails),
//     H5 in a mobile browser, Native QR on desktop. The order is polled; the
//     server is the source of truth.
//   - Renders nothing while availability is unknown or WeChat Pay is not
//     available (no UI entry, R-04). Available means what the plans response
//     says: `checkout.rails` lists `wechatpay`. There is no payments switch
//     to wait for; the server stops listing the rail under the kill switch.
//   - Inside WeChat, on GoApply, the pay tap is also where WeChat asks for
//     the one-time permission to send the "payment received" notice
//     (`<SubscribeOnTap template="payment_success">`). The payment goes on
//     whatever the buyer answers; outside WeChat the button is unchanged.

import { useEffect, useId, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation, useQuery } from '@tanstack/react-query';

import { Btn } from '../../v3/primitives/Btn';
import { createWechatPayOrder } from '../../../lib/api/billingCn';
import { getLegalDoc } from '../../../lib/api/compliance';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import type { CnOrderStatus, CreateWechatOrderResponse, WechatPayTradeType } from '../../../lib/api/contracts/billing-cn';
import { formatMoney } from '../../../lib/pricing';
import { SubscribeOnTap } from '../notify-cn';
import {
  currentUserAgent,
  detectTradeType,
  invokeWechatJsapi,
  qrDataUrl,
  sellableCnPlan,
  useWechatPayAvailable,
  useWechatPayOrder,
} from './useWechatPay';
import styles from './billingCn.module.css';

export const BILLING_PATH = '/settings/billing';
export const HELP_PATH = '/help';
const PLAN_NAME_KEYS = ['pro_week_pass', 'pro_monthly', 'pro_quarterly', 'practice_pack_5', 'practice_pack_15', 'student_monthly', 'student_quarterly'] as const;

export interface WechatPayCheckoutProps {
  planKey: string;
  /** Called once when the order is paid. */
  onPaid?: (order: CnOrderStatus) => void;
  /** Shows a Cancel button when given. */
  onCancel?: () => void;
  /** Browser navigation for H5 (tests inject it). */
  navigate?: (url: string) => void;
  /** User agent override (tests). */
  userAgent?: string;
}

type ErrorKind = 'notOpen' | 'notSellable' | 'studentRequired' | 'termsOutdated' | 'tooMany' | 'generic' | 'jsapiCancelled';

/**
 * What a refused order means for the buyer. WeChat Pay is on whenever its
 * merchant is set up, so "not open" is never the normal state: it is what the
 * server answers when the rail is not set up on this deployment
 * (`rail_not_configured`, `rail_not_registered`, `feature_disabled`) or when
 * the operator switched payments off (`payments_disabled`, the kill switch).
 */
function errorKind(err: unknown): ErrorKind {
  const code = apiErrorCode(err);
  if (code === 'rail_not_configured' || code === 'rail_not_registered' || code === 'feature_disabled' || code === 'payments_disabled') return 'notOpen';
  if (code === 'student_verification_required') return 'studentRequired';
  if (code === 'plan_not_sellable') return 'notSellable';
  if (code === 'terms_outdated') return 'termsOutdated';
  if (code === 'rate_limited') return 'tooMany';
  return 'generic';
}

export function planNameKey(planKey: string): string {
  return (PLAN_NAME_KEYS as readonly string[]).includes(planKey) ? `plans.${planKey}` : 'plans.unknown';
}

function defaultNavigate(url: string): void {
  window.location.assign(url);
}

export function WechatPayCheckout({ planKey, onPaid, onCancel, navigate = defaultNavigate, userAgent }: WechatPayCheckoutProps) {
  const t = useTranslations('billingCn');
  const locale = useLocale();
  const termsId = useId();
  const { available, loading, plans } = useWechatPayAvailable();
  const plan = useMemo(() => sellableCnPlan(plans, planKey), [plans, planKey]);
  const ua = userAgent ?? currentUserAgent();
  const inWechat = detectTradeType(ua) === 'jsapi';

  const [agreed, setAgreed] = useState(false);
  const [order, setOrder] = useState<CreateWechatOrderResponse | null>(null);
  const [notice, setNotice] = useState<ErrorKind | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  /** The in-app cashier failed and the QR code replaced it. */
  const [jsapiFellBack, setJsapiFellBack] = useState(false);

  const termsQ = useQuery({
    queryKey: ['billingCn', 'terms', locale],
    queryFn: ({ signal }) => getLegalDoc('terms', { locale }, { signal }),
    enabled: available,
    staleTime: 30 * 60 * 1000,
    retry: 1,
  });

  const termsVersion = termsQ.data?.version?.trim() ? termsQ.data.version.trim().slice(0, 40) : null;

  const create = useMutation({
    mutationFn: ({ tradeType, terms }: { tradeType: WechatPayTradeType; terms: string }) => createWechatPayOrder({ planKey, tradeType, termsVersion: terms }),
  });

  const status = useWechatPayOrder(order?.orderId ?? null, { expiresAt: order?.expiresAt ?? null });
  const state = status.data?.status ?? (order ? 'pending' : null);
  /** The status call failed (after its retries); polling stopped until the user checks again. */
  const checkFailed = Boolean(order) && status.isError;
  const checkAgain = () => void status.refetch();

  useEffect(() => {
    let live = true;
    setQr(null);
    if (order?.tradeType === 'native') {
      void qrDataUrl(order.codeUrl).then(
        (url) => live && setQr(url),
        () => live && setNotice('generic'),
      );
    }
    return () => {
      live = false;
    };
  }, [order]);

  const paidOrder = status.data?.status === 'paid' ? status.data : null;
  useEffect(() => {
    if (paidOrder) onPaid?.(paidOrder);
    // Fire once per paid order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paidOrder?.orderId]);

  // Nothing (not even payment wording) until we know the rail is live.
  if (loading || !available || !plan) return null;

  const price = formatMoney(locale, plan.amountMinor ?? 0, 'CNY');

  async function start(tradeType: WechatPayTradeType): Promise<void> {
    setNotice(null);
    // The agreement version is the acceptance record: never order without it.
    if (!termsVersion) return;
    let res: CreateWechatOrderResponse;
    try {
      res = await create.mutateAsync({ tradeType, terms: termsVersion });
    } catch (err) {
      if (tradeType === 'jsapi' && apiErrorCode(err) === 'wechat_openid_missing') {
        await start('native');
        return;
      }
      const kind = errorKind(err);
      if (kind === 'termsOutdated') {
        // The agreement changed since the page loaded: reload it and ask the
        // buyer to read and tick it again (the server only takes the current one).
        setAgreed(false);
        void termsQ.refetch();
      }
      setNotice(kind);
      return;
    }
    if (res.tradeType === 'h5') {
      setOrder(res);
      navigate(res.h5Url);
      return;
    }
    if (res.tradeType === 'jsapi') {
      setOrder(res);
      const outcome = await invokeWechatJsapi(res.jsapi);
      if (outcome === 'cancel') {
        setOrder(null);
        setNotice('jsapiCancelled');
      } else if (outcome === 'fail') {
        // No bridge, a timeout or a cashier error: show the QR code instead
        // (long-press to identify it inside WeChat) rather than retrying JSAPI.
        setOrder(null);
        setJsapiFellBack(true);
        await start('native');
      }
      return;
    }
    setOrder(res);
  }

  const reset = () => {
    setOrder(null);
    setNotice(null);
    setJsapiFellBack(false);
    create.reset();
  };

  const pay = () => {
    setJsapiFellBack(false);
    void start(detectTradeType(ua));
  };

  // ── Result states ─────────────────────────────────────────────────────
  if (order && state && state !== 'pending') {
    const accessUntil = status.data?.accessUntil ? new Date(status.data.accessUntil) : null;
    const message =
      state === 'paid'
        ? plan.kind === 'pack'
          ? t('status.paidPack')
          : accessUntil
            ? t('status.paidPass', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(accessUntil) })
            : t('status.paidPassNoDate')
        : state === 'needs_support'
          ? t.rich('status.needsSupport', {
              help: (chunks) => (
                <a href={HELP_PATH} className={styles.link}>
                  {chunks}
                </a>
              ),
            })
          : t(`status.${state}`);
    // Money was taken in both of these: never offer a new code.
    const settled = state === 'paid' || state === 'needs_support';
    return (
      <div className={styles.stack} data-testid="wechatpay-result" data-state={state}>
        <p className={state === 'paid' ? styles.success : styles.notice} role="status">
          {message}
        </p>
        <div className={styles.actions}>
          {settled ? (
            <Btn as="a" href={BILLING_PATH} variant="primary">
              {t('status.viewBilling')}
            </Btn>
          ) : (
            <Btn variant="primary" onClick={reset}>
              {t('status.newCode')}
            </Btn>
          )}
          {onCancel ? <Btn onClick={onCancel}>{t('status.done')}</Btn> : null}
        </div>
      </div>
    );
  }

  // ── Waiting for payment ───────────────────────────────────────────────
  if (order && order.tradeType === 'native') {
    const expires = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(order.expiresAt));
    return (
      <div className={styles.stack} data-testid="wechatpay-qr">
        <p className={styles.h3}>{t('qr.title')}</p>
        <div className={styles.qrFrame}>
          {qr ? (
            <img src={qr} alt={t('qr.alt', { price })} width={208} height={208} className={styles.qr} />
          ) : (
            <p className={styles.muted} aria-busy="true">
              {t('qr.loading')}
            </p>
          )}
        </div>
        {jsapiFellBack ? (
          <p className={styles.notice} role="status">
            {t('jsapi.failed')}
          </p>
        ) : null}
        {inWechat ? <p className={styles.body}>{t('qr.inWechat')}</p> : null}
        <ul className={styles.facts}>
          <li>{t('qr.amount', { price: formatMoney(locale, order.amountMinor, 'CNY') })}</li>
          <li>{t('qr.payee', { entity: order.collectingEntity })}</li>
          <li>{t('qr.expires', { time: expires })}</li>
        </ul>
        {checkFailed ? (
          <p className={styles.notice} role="alert">
            {t('qr.checkFailed')}
          </p>
        ) : (
          <p className={styles.muted} role="status" aria-live="polite">
            {t('qr.waiting')}
          </p>
        )}
        {checkFailed || onCancel ? (
          <div className={styles.actions}>
            {checkFailed ? (
              <Btn variant="primary" disabled={status.isFetching} onClick={checkAgain}>
                {t('qr.checkAgain')}
              </Btn>
            ) : null}
            {onCancel ? <Btn onClick={onCancel}>{t('pay.cancel')}</Btn> : null}
          </div>
        ) : null}
      </div>
    );
  }

  if (order && order.tradeType === 'h5') {
    return (
      <p className={styles.muted} role="status">
        {t('h5.redirecting')}
      </p>
    );
  }

  // ── Summary and pay ───────────────────────────────────────────────────
  const termsFailed = termsQ.isError && !termsVersion;
  const jsapiWaiting = order?.tradeType === 'jsapi' && state === 'pending';
  const noticeText =
    jsapiWaiting && checkFailed
      ? t('qr.checkFailed')
      : notice === 'jsapiCancelled'
        ? t('jsapi.cancelled')
        : notice
          ? t(`errors.${notice}`)
          : termsFailed
            ? t('errors.generic')
            : null;
  const busy = create.isPending || (jsapiWaiting && !checkFailed);
  let primary: { label: string; onClick: () => void; disabled: boolean; pays: boolean };
  if (jsapiWaiting && checkFailed) {
    primary = { label: t('qr.checkAgain'), onClick: checkAgain, disabled: status.isFetching, pays: false };
  } else if (termsFailed) {
    primary = { label: t('errors.retry'), onClick: () => void termsQ.refetch(), disabled: termsQ.isFetching, pays: false };
  } else {
    primary = {
      label: jsapiWaiting ? t('qr.waiting') : busy ? t('pay.creating') : notice === 'generic' ? t('errors.retry') : t('pay.button', { price }),
      onClick: pay,
      // Ticked AND the agreement version known (it is recorded with the order).
      disabled: !agreed || !termsVersion || busy,
      pays: true,
    };
  }
  const primaryButton = (
    <Btn variant="primary" disabled={primary.disabled} aria-busy={busy || undefined} onClick={primary.onClick}>
      {primary.label}
    </Btn>
  );

  return (
    <div className={styles.stack} data-testid="wechatpay-checkout">
      <div className={styles.summary}>
        <div className={styles.summaryHead}>
          <span className={styles.planName}>{t(planNameKey(plan.key))}</span>
          <span className={styles.price}>{price}</span>
        </div>
        <p className={styles.body}>
          {plan.kind === 'pack'
            ? plan.practice?.validMonths
              ? t('summary.pack', { credits: plan.practice.credits, months: plan.practice.validMonths })
              : t('summary.packNoExpiry', { credits: plan.practice?.credits ?? 0 })
            : t('summary.pass', { days: plan.passDays ?? 0 })}
        </p>
        <p className={styles.muted}>{t('summary.oneTime')}</p>
      </div>

      <label className={styles.check} htmlFor={termsId}>
        <input id={termsId} type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>
          {t.rich('terms.label', {
            terms: (chunks) => (
              <a href="/legal/terms" target="_blank" rel="noreferrer" className={styles.link}>
                {chunks}
              </a>
            ),
            fees: (chunks) => (
              <a href="/pricing" target="_blank" rel="noreferrer" className={styles.link}>
                {chunks}
              </a>
            ),
          })}
        </span>
      </label>

      {noticeText ? (
        <p className={styles.notice} role="alert">
          {noticeText}
        </p>
      ) : null}

      <div className={styles.actions}>
        {/* Only the button that pays asks for the notice permission; "check
            again" and "try again" must not prompt WeChat a second time. */}
        {primary.pays ? <SubscribeOnTap template="payment_success">{primaryButton}</SubscribeOnTap> : primaryButton}
        {onCancel ? <Btn onClick={onCancel}>{t('pay.cancel')}</Btn> : null}
      </div>
    </div>
  );
}
