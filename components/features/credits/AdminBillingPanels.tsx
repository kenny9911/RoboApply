'use client';

// AdminBillingPanels — the billing panels of /admin/credits added by the
// market wave (MKT-4C over MKT-4B's admin API; MARKET_STRATEGY §4.4 "How a
// refund is executed", §5.1 "Refunds and disputes" and "Endpoint health",
// §5.3 G13, §7 item 17):
//
//   Refunds        keyed by a user id:
//                  (a) what the published refund rules say about the latest
//                      charge, as read-only facts;
//                  (b) "Refund through Stripe": the latest charge or a typed
//                      invoice / checkout session id, an optional partial
//                      amount, a required reason, and a confirm step that
//                      repeats the amount and the user. Access does not
//                      change here: Stripe's event does that. One attempt
//                      key names one movement of money (user, charge,
//                      amount): rewording the reason after an unclear
//                      failure is the same refund, never a second one;
//                  (c) the user's refunds, withdrawals and disputes, disputes
//                      flagged. A refund made here is written by Stripe's
//                      event a moment later, so the list is read again by
//                      itself after a refund and has its own Refresh;
//                  (d) "Mainland orders": Alipay and WeChat Pay refunds are
//                      made in the merchant console; here staff RECORD one
//                      (box ticked, reason given) and the server takes the
//                      access back once. A second record is "already
//                      recorded", not an error, and says what the first
//                      record did. A record that failed half way is finished
//                      by trying again (the server never records twice): in
//                      the open form, and afterwards with "Check the record"
//                      on the order's row for as long as the full refund is
//                      on record with no access taken back.
//   Practice cost  per brand, the average platform cost of the latest
//                  sessions in US dollars with the sample size, or "not
//                  enough sessions"; under it the owner's rule as plain text.
//   Stripe         key mode, whether the key is usable here, the number of
//                  webhook secrets, rail ready or not, and the webhook
//                  endpoint: none at all, could not be read, sends every
//                  event, or the events it does not send. Never a key, a
//                  secret or a price id.
//
// The Stripe pieces render on the international brand only: Stripe never
// serves the mainland brand. Every number comes from the API; a value the API
// did not state renders "—" or "could not be checked".

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { apiErrorCode } from '../../../lib/api/contracts/wire';
import type { RefundQuoteResponse } from '../../../lib/api/admin';
import {
  CN_RECHECK_REASON,
  PRACTICE_COST_BRANDS,
  cnReversalOpen,
  parseAmountMinor,
  refundTargetId,
  refundTargetOf,
  stripeEndpointState,
  stripeUncheckedReason,
  type AdminRefundResult,
  type AdminRefundRow,
  type AdminRefundTarget,
  type CnOrderRow,
  type CnRefundResult,
} from '../../../lib/api/adminBilling';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { getBrand } from '../../../lib/brand/registry.generated';
import {
  useAdminRefundQuote,
  useAdminRefunds,
  useCnOrders,
  useIssueRefund,
  usePracticeCost,
  useRecordCnRefund,
  useRefundAttempts,
  useRereadUserBilling,
  useStripeHealth,
} from '../../../hooks/credits/useAdminCredits';
import { chargedMoney, parseDate } from './labels';
import styles from './credits.module.css';

/** The anchor of the Stripe panel: the admin System panel links here. */
export const ADMIN_STRIPE_PANEL_ID = 'admin-stripe';

const REASON_MAX = 300;

type Tone = 'warn' | 'ok' | 'neutral';
const TONE: Record<Tone, { background: string; color: string; borderColor: string }> = {
  warn: { background: 'var(--warn-subtle)', color: 'var(--warn)', borderColor: 'var(--warn)' },
  ok: { background: 'var(--ok-subtle)', color: 'var(--ok)', borderColor: 'var(--ok)' },
  neutral: { background: 'var(--surface-2)', color: 'var(--text-2)', borderColor: 'var(--rule)' },
};

/** A labelled marker. Colour is never the only signal: the words say what it is. */
function Marker({ tone, children, testId }: { tone: Tone; children: ReactNode; testId?: string }) {
  return (
    <span
      data-testid={testId}
      style={{ ...TONE[tone], display: 'inline-block', padding: '2px var(--sp-2)', borderRadius: 'var(--r-pill)', borderWidth: 1, borderStyle: 'solid', fontSize: 'var(--fs-label)', fontWeight: 600, whiteSpace: 'nowrap' }}
    >
      {children}
    </span>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{children}</span>
    </li>
  );
}

function useFormats() {
  const format = useFormatter();
  const locale = useLocale();
  const brand = useBrand();
  return {
    brand,
    money: (minor: number | null | undefined, currency: string | null | undefined) => (currency ? chargedMoney(locale, minor, currency, brand.currency) : '—'),
    day: (iso: string | null | undefined) => {
      const d = parseDate(iso);
      return d ? format.dateTime(d, { dateStyle: 'medium' }) : '—';
    },
    moment: (iso: string | null | undefined) => {
      const d = parseDate(iso);
      return d ? format.dateTime(d, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
    },
    usd: (value: number) => format.number(value, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }),
  };
}

// ── Refunds ───────────────────────────────────────────────────────────────

export function RefundsPanel() {
  const t = useTranslations('credits.admin.refunds');
  const [input, setInput] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const rereadUser = useRereadUserBilling();
  return (
    <section className={styles.card} aria-labelledby="admin-refunds" data-testid="admin-refunds-panel">
      <h2 className={styles.h2} id="admin-refunds">
        {t('title')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      <form
        className={styles.actions}
        onSubmit={(e) => {
          e.preventDefault();
          const next = input.trim() || null;
          // "Show" on the user already on screen reads the facts again. The forms below are not started over: a
          // refund that is being retried keeps its attempt key.
          if (next && next === userId) rereadUser(next);
          setUserId(next);
        }}
      >
        <label className={styles.label} htmlFor="refunds-user">
          {t('userId')}
        </label>
        <input id="refunds-user" className={styles.input} style={{ maxWidth: 280 }} value={input} maxLength={64} onChange={(e) => setInput(e.target.value)} />
        <Btn type="submit">{t('show')}</Btn>
      </form>
      {/* Keyed by the user: another id starts every form and answer below from nothing. */}
      {userId ? <UserRefunds key={userId} userId={userId} /> : <p className={styles.muted}>{t('pick')}</p>}
    </section>
  );
}

function UserRefunds({ userId }: { userId: string }) {
  const brand = useBrand();
  const quote = useAdminRefundQuote(userId);
  return (
    <div className={styles.stack} data-testid="admin-refunds-user" data-user={userId}>
      <RefundFacts quote={quote.data} loading={quote.isPending} error={quote.isError ? quote.error : null} />
      {/* Stripe never serves the mainland brand: its admin gets no card refund form. */}
      {brand.market === 'intl' ? <StripeRefundForm userId={userId} quote={quote.data ?? null} /> : null}
      <RefundList userId={userId} />
      <CnOrders userId={userId} />
    </div>
  );
}

function RefundFacts({ quote, loading, error }: { quote: RefundQuoteResponse | undefined; loading: boolean; error: unknown }) {
  const t = useTranslations('credits.admin.refunds.facts');
  // The sentences of the admin console's own refund check, already in every locale.
  const tr = useTranslations('admin.console.refund');
  const f = useFormats();
  const d = quote?.decision ?? null;
  return (
    <div className={styles.stack} data-testid="refund-facts">
      <h3 className={styles.h3}>{t('title')}</h3>
      {error ? <p className={styles.error} role="alert">{apiErrorCode(error) === 'not_found' ? t('notFound') : t('loadError')}</p> : null}
      {!error && loading ? <p className={styles.muted} aria-busy="true">{tr('loading')}</p> : null}
      {quote && !quote.charge ? <p className={styles.muted}>{tr('noCharge')}</p> : null}
      {quote?.charge ? (
        <>
          <p className={styles.body}>
            {tr('charge', {
              amount: f.money(quote.charge.amountMinor, quote.charge.currency),
              at: f.moment(quote.charge.chargedAt),
              plan: quote.charge.planKey,
              kind: tr(`chargeKind.${quote.charge.chargeKind === 'renewal' ? 'renewal' : 'first_purchase'}`),
            })}
          </p>
          <ul className={styles.list}>
            <Fact label={t('paidThrough')}>{t(`source.${quote.charge.source === 'cn' ? 'cn' : 'stripe'}`)}</Fact>
            {quote.facts ? (
              <>
                <Fact label={t('country')}>{quote.facts.billingCountry ?? '—'}</Fact>
                <Fact label={t('waiver')}>{quote.facts.withdrawalWaiver ? t('yes') : t('no')}</Fact>
                <Fact label={t('paidOnlyUsed')}>{quote.facts.paidOnlyCreditsUsed}</Fact>
                {quote.facts.packCreditsUsed !== null && quote.facts.packCreditsUsed !== undefined ? <Fact label={t('packUsed')}>{quote.facts.packCreditsUsed}</Fact> : null}
              </>
            ) : null}
            {d?.prorata ? <Fact label={t('prorata')}>{t('prorataValue', { used: d.prorata.usedDays, period: d.prorata.periodDays })}</Fact> : null}
          </ul>
          {d ? (
            <div className={styles.actions} data-testid="refund-decision">
              <Marker tone={d.eligible ? 'ok' : 'warn'}>{tr(d.eligible ? 'eligible' : 'notEligible')}</Marker>
              {/* Rule and blocker codes are data: shown as they are, as in the admin console's refund check. */}
              <Marker tone="neutral">{tr('rule', { rule: d.rule })}</Marker>
              {d.blocker ? <Marker tone="neutral">{tr('blocker', { blocker: d.blocker })}</Marker> : null}
              {d.deadline ? <Marker tone="neutral">{tr('deadline', { at: f.moment(d.deadline) })}</Marker> : null}
            </div>
          ) : null}
          {d?.eligible ? <p className={styles.body}>{tr('amount', { amount: f.money(d.amountMinor, d.currency) })}</p> : null}
        </>
      ) : null}
    </div>
  );
}

type RefundErrorKey = 'not_found' | 'refund_not_available' | 'rail_not_configured' | 'payment_provider_error' | 'generic';
const REFUND_ERRORS: readonly RefundErrorKey[] = ['not_found', 'refund_not_available', 'rail_not_configured', 'payment_provider_error'];

/** The message key of a refused refund: the server's own code where the console has words for it. */
export function refundErrorKey(err: unknown): RefundErrorKey {
  const code = apiErrorCode(err);
  return REFUND_ERRORS.includes(code as RefundErrorKey) ? (code as RefundErrorKey) : 'generic';
}

function StripeRefundForm({ userId, quote }: { userId: string; quote: RefundQuoteResponse | null }) {
  const t = useTranslations('credits.admin.refunds.stripe');
  const f = useFormats();
  const refund = useIssueRefund();
  // One attempt key per movement of money (this user, this charge, this amount), kept until that movement is
  // completed: across a retry, a reworded reason and a detour through another amount. The server then answers a
  // repeated movement with the refund its first try made, if it made one. See `useRefundAttempts`.
  const attempts = useRefundAttempts();

  // The latest charge can be the target only when it is a card charge whose id is an invoice or session id.
  const latest = quote?.charge?.source === 'stripe' ? quote.charge : null;
  const latestTarget = latest ? refundTargetOf(latest.id) : null;
  const [choice, setChoice] = useState<'latest' | 'other' | null>(null);
  const which: 'latest' | 'other' = choice ?? (latestTarget ? 'latest' : 'other');
  const useLatest = which === 'latest' && !!latestTarget;
  const [targetId, setTargetId] = useState('');
  const [amountText, setAmountText] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [done, setDone] = useState<AdminRefundResult | null>(null);
  // The form is replaced by the confirm step: focus follows it, so the keyboard is not left on a control that is gone.
  const confirmTitle = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (step === 'confirm') confirmTitle.current?.focus();
  }, [step]);

  const target: AdminRefundTarget | null = useLatest ? latestTarget : refundTargetOf(targetId);
  const partial = amountText.trim() ? parseAmountMinor(amountText) : null;
  const amountOk = !amountText.trim() || (partial !== null && (!useLatest || !latest || partial <= latest.amountMinor));
  const reasonOk = reason.trim().length > 0 && reason.trim().length <= REASON_MAX;
  const valid = !!target && amountOk && reasonOk;
  const targetText = useLatest && latest ? t('targetLatest', { amount: f.money(latest.amountMinor, latest.currency), date: f.day(latest.chargedAt) }) : target ? refundTargetId(target) : '—';
  const amountValue = partial === null ? t('everything') : useLatest && latest ? f.money(partial, latest.currency) : t('amountAsTyped', { amount: amountText.trim() });

  const onReview = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDone(null);
    refund.reset();
    setStep('confirm');
  };

  const onConfirm = () => {
    if (!target) return;
    // The reason is not part of what the key names: it says why, not what money moves.
    const movement = { userId, target, amountMinor: partial };
    refund.mutate(
      { userId, target, ...(partial !== null ? { amountMinor: partial } : {}), reason: reason.trim(), attemptKey: attempts.keyFor(movement) },
      {
        onSuccess: (res) => {
          setDone(res);
          setStep('form');
          setAmountText('');
          setReason('');
          setTargetId('');
          // The next refund is a new decision, even with the same amount on the same charge.
          attempts.complete(movement);
        },
      },
    );
  };

  return (
    <div className={styles.stack} data-testid="stripe-refund">
      <h3 className={styles.h3}>{t('title')}</h3>
      <p className={styles.muted}>{t('sub')}</p>
      {done ? (
        <div className={`${styles.notice} ${styles.ok}`} role="status" data-testid="stripe-refund-done">
          <p className={styles.body}>{done.amountMinor !== null && done.currency ? t('done', { amount: f.money(done.amountMinor, done.currency) }) : t('doneNoAmount')}</p>
          {done.full !== null ? <p className={styles.body}>{t(done.full ? 'doneFull' : 'donePartial')}</p> : null}
        </div>
      ) : null}

      {step === 'confirm' ? (
        <div className={styles.notice} role="group" aria-labelledby="stripe-refund-confirm" data-testid="stripe-refund-confirm">
          <h4 className={styles.h3} id="stripe-refund-confirm" tabIndex={-1} ref={confirmTitle}>
            {t('confirmTitle')}
          </h4>
          <ul className={styles.list}>
            <Fact label={t('confirmUser')}>{userId}</Fact>
            <Fact label={t('confirmTarget')}>{targetText}</Fact>
            <Fact label={t('confirmAmount')}>{amountValue}</Fact>
            <Fact label={t('confirmReason')}>{reason.trim()}</Fact>
          </ul>
          {refund.isError ? (
            <p className={styles.error} role="alert">
              {t(`errors.${refundErrorKey(refund.error)}`)}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Btn variant="primary" disabled={refund.isPending} aria-busy={refund.isPending || undefined} onClick={onConfirm}>
              {refund.isPending ? t('pending') : t('confirm')}
            </Btn>
            <Btn
              disabled={refund.isPending}
              onClick={() => {
                refund.reset();
                setStep('form');
              }}
            >
              {t('back')}
            </Btn>
          </div>
        </div>
      ) : (
        <form className={styles.form} onSubmit={onReview} noValidate>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>{t('target')}</legend>
            {latestTarget && latest ? (
              <label className={styles.check}>
                <input type="radio" name="refund-target" checked={which === 'latest'} onChange={() => setChoice('latest')} />
                <span>{t('targetLatest', { amount: f.money(latest.amountMinor, latest.currency), date: f.day(latest.chargedAt) })}</span>
              </label>
            ) : null}
            <label className={styles.check}>
              <input type="radio" name="refund-target" checked={which === 'other'} onChange={() => setChoice('other')} />
              <span>{t('targetOther')}</span>
            </label>
          </fieldset>
          {which === 'other' ? (
            <div className={styles.form} style={{ gap: 'var(--sp-1)' }}>
              <label className={styles.label} htmlFor="refund-target-id">
                {t('targetId')}
              </label>
              <input id="refund-target-id" className={styles.input} value={targetId} aria-describedby="refund-target-help" autoComplete="off" spellCheck={false} onChange={(e) => setTargetId(e.target.value)} />
              <p className={styles.muted} id="refund-target-help">
                {t('targetIdHelp')}
              </p>
            </div>
          ) : null}
          <div className={styles.form} style={{ gap: 'var(--sp-1)' }}>
            <label className={styles.label} htmlFor="refund-amount">
              {t('amount')}
            </label>
            <input id="refund-amount" className={styles.input} style={{ maxWidth: 200 }} inputMode="decimal" value={amountText} aria-describedby="refund-amount-help" aria-invalid={(invalid && !amountOk) || undefined} onChange={(e) => setAmountText(e.target.value)} />
            <p className={styles.muted} id="refund-amount-help">
              {t('amountHelp')}
            </p>
          </div>
          <div className={styles.form} style={{ gap: 'var(--sp-1)' }}>
            <label className={styles.label} htmlFor="refund-reason">
              {t('reason')}
            </label>
            <input id="refund-reason" className={styles.input} value={reason} maxLength={REASON_MAX} aria-required="true" onChange={(e) => setReason(e.target.value)} />
          </div>
          {invalid && !valid ? (
            <p className={styles.error} role="alert">
              {t('invalid')}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Btn type="submit" variant="primary">
              {t('review')}
            </Btn>
          </div>
        </form>
      )}
    </div>
  );
}

function refundReference(row: AdminRefundRow): string {
  return row.invoiceId ?? row.checkoutSessionId ?? row.alipayOrderId ?? '—';
}

function RefundList({ userId }: { userId: string }) {
  const t = useTranslations('credits.admin.refunds.list');
  const f = useFormats();
  const q = useAdminRefunds(userId);
  const rows = (q.data?.pages ?? []).flatMap((page) => page.items);
  const disputes = rows.filter((r) => r.kind === 'dispute').length;
  const refreshing = q.isRefetching;
  return (
    <div className={styles.stack} data-testid="refund-list">
      <div className={styles.cardHead} style={{ alignItems: 'center' }}>
        <h3 className={styles.h3}>{t('title')}</h3>
        {/* A refund made a moment ago is written by the payment provider's notice: staff can ask again at any time. */}
        {q.data || q.isError ? (
          <div className={styles.actions}>
            <Btn disabled={q.isFetching} aria-busy={refreshing || undefined} aria-label={t('refreshLabel')} onClick={() => void q.refetch()}>
              {refreshing ? t('refreshing') : t('refresh')}
            </Btn>
          </div>
        ) : null}
      </div>
      {q.isPending ? <p className={styles.muted} aria-busy="true">{t('loading')}</p> : null}
      {q.isError && !q.data ? <p className={styles.error} role="alert">{t('loadError')}</p> : null}
      {/* The rows on screen are from the last read that worked: a later read that failed says so, so they are not taken for current. */}
      {q.isRefetchError && q.data ? <p className={styles.error} role="alert" data-testid="refund-list-stale">{t('refreshError')}</p> : null}
      {q.data && rows.length === 0 ? <p className={styles.muted}>{t('empty')}</p> : null}
      {disputes > 0 ? (
        <div className={styles.banner} role="status" data-testid="dispute-flag">
          <p className={styles.body}>{t('disputeFlag', { count: disputes })}</p>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('date')}</th>
                <th scope="col">{t('kind')}</th>
                <th scope="col">{t('amount')}</th>
                <th scope="col">{t('access')}</th>
                <th scope="col">{t('reason')}</th>
                <th scope="col">{t('by')}</th>
                <th scope="col">{t('ref')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-kind={r.kind}>
                  <td>{f.moment(r.createdAt)}</td>
                  <td>{r.kind === 'dispute' ? <Marker tone="warn">{t('kinds.dispute')}</Marker> : t(`kinds.${r.kind}`)}</td>
                  <td>{r.amountMinor !== null && r.currency ? t('amountValue', { amount: f.money(r.amountMinor, r.currency), share: t(r.full ? 'full' : 'partial') }) : '—'}</td>
                  <td>{t(r.entitlementReversed ? 'reversed' : 'kept')}</td>
                  <td>{r.reason ?? '—'}</td>
                  <td>{r.actor ?? '—'}</td>
                  <td>{refundReference(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {q.isFetchNextPageError ? <p className={styles.error} role="alert" data-testid="refund-list-more-error">{t('moreError')}</p> : null}
      {q.hasNextPage ? (
        <div className={styles.actions}>
          <Btn disabled={q.isFetching} onClick={() => void q.fetchNextPage()}>
            {t('more')}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}

type CnErrorKey = 'not_found' | 'order_not_completed' | 'invalid_request' | 'generic';
const CN_ERRORS: readonly CnErrorKey[] = ['not_found', 'order_not_completed', 'invalid_request'];

export function cnRefundErrorKey(err: unknown): CnErrorKey {
  const code = apiErrorCode(err);
  return CN_ERRORS.includes(code as CnErrorKey) ? (code as CnErrorKey) : 'generic';
}

interface CnOutcome {
  result: CnRefundResult;
  /** Less than the whole order was recorded as returned. */
  partial: boolean;
}

function CnOrders({ userId }: { userId: string }) {
  const t = useTranslations('credits.admin.refunds.cn');
  const f = useFormats();
  const q = useCnOrders(userId);
  const record = useRecordCnRefund();
  // The refunds the list above has loaded (the same cache, no second request): they say which full refund is on
  // record with no access taken back.
  const refunds = useAdminRefunds(userId);
  const reversalOpen = cnReversalOpen((refunds.data?.pages ?? []).flatMap((page) => page.items));
  /** The order whose record is being checked again from its row (no form open). */
  const [checking, setChecking] = useState<string | null>(null);
  /** That check failed for this order. */
  const [checkFailed, setCheckFailed] = useState<{ orderId: string; error: unknown } | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [returned, setReturned] = useState(false);
  const [reason, setReason] = useState('');
  const [amountText, setAmountText] = useState('');
  const [outcomes, setOutcomes] = useState<Record<string, CnOutcome>>({});
  const [last, setLast] = useState<string | null>(null);

  const orders = q.data?.items ?? [];
  const open = orders.find((o) => o.id === openId) ?? null;
  const orderName = (o: CnOrderRow) => o.outTradeNo ?? o.id;
  const yuan = (minor: number | null) => f.money(minor, minor === null ? null : 'CNY');

  const typed = amountText.trim() ? parseAmountMinor(amountText) : null;
  const amountOk = !amountText.trim() || (typed !== null && (open?.amountMinor === null || open?.amountMinor === undefined || typed <= open.amountMinor));
  const reasonOk = reason.trim().length > 0 && reason.trim().length <= REASON_MAX;
  // The whole order typed out is a full refund, not a partial one.
  const partialMinor = typed !== null && open?.amountMinor !== typed ? typed : null;
  const canRecord = returned && reasonOk && amountOk && !record.isPending;

  const start = (order: CnOrderRow) => {
    record.reset();
    setCheckFailed(null);
    setReturned(false);
    setReason('');
    setAmountText('');
    setOpenId(order.id);
  };

  /**
   * "Check the record": the same call the form sends, for an order whose full
   * refund is already on record. The server never records twice: it finishes
   * taking the access back if that had stopped half way, and answers "already
   * recorded" with what the record did. The reason is the one on record.
   */
  const onCheck = (order: CnOrderRow) => {
    setCheckFailed(null);
    setChecking(order.id);
    record.mutate(
      { userId, orderId: order.id, reason: reversalOpen.get(order.id)?.reason ?? CN_RECHECK_REASON, confirmMoneyReturned: true },
      {
        onSuccess: (result) => {
          setOutcomes((all) => ({ ...all, [order.id]: { result, partial: false } }));
          setLast(order.id);
          // A form left open for the same order (its record had failed half way) has nothing left to send.
          setOpenId((id) => (id === order.id ? null : id));
        },
        onError: (error) => setCheckFailed({ orderId: order.id, error }),
        onSettled: () => setChecking(null),
      },
    );
  };

  const onRecord = (e: FormEvent) => {
    e.preventDefault();
    if (!open || !canRecord) return;
    record.mutate(
      { userId, orderId: open.id, reason: reason.trim(), confirmMoneyReturned: true, ...(partialMinor !== null ? { refundedAmountMinor: partialMinor } : {}) },
      {
        onSuccess: (result) => {
          setOutcomes((all) => ({ ...all, [open.id]: { result, partial: partialMinor !== null } }));
          setLast(open.id);
          setOpenId(null);
        },
      },
    );
  };

  const lastOrder = last ? orders.find((o) => o.id === last) : null;
  const lastOutcome = last ? outcomes[last] : null;

  return (
    <div className={styles.stack} data-testid="cn-orders">
      <h3 className={styles.h3}>{t('title')}</h3>
      <p className={styles.muted}>{t('sub')}</p>
      {q.isPending ? <p className={styles.muted} aria-busy="true">{t('loading')}</p> : null}
      {q.isError && !q.data ? <p className={styles.error} role="alert">{t('loadError')}</p> : null}
      {q.data && orders.length === 0 ? <p className={styles.muted}>{t('empty')}</p> : null}
      {lastOutcome ? (
        <div className={`${styles.notice} ${lastOutcome.result.status === 'recorded' ? styles.ok : ''}`} role="status" data-testid="cn-refund-result">
          <p className={styles.body}>{t(lastOutcome.result.status === 'recorded' ? 'recorded' : 'already', { order: lastOrder ? orderName(lastOrder) : (lastOutcome.result.orderId ?? last ?? '') })}</p>
          {/* What the record did to the access. An "already recorded" answer carries what the first record did. */}
          {lastOutcome.result.entitlement ? <p className={styles.body}>{t(`entitlement.${lastOutcome.result.entitlement}`)}</p> : null}
        </div>
      ) : null}
      {orders.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('order')}</th>
                <th scope="col">{t('plan')}</th>
                <th scope="col">{t('channel')}</th>
                <th scope="col">{t('amount')}</th>
                <th scope="col">{t('date')}</th>
                <th scope="col">{t('refund')}</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const outcome = outcomes[o.id] ?? null;
                // The server's marker once the list is read again; until then, what this page just recorded.
                const marker = o.refunded ?? (outcome ? (outcome.partial && outcome.result.status === 'recorded' ? 'partial' : 'full') : null);
                // A full refund on record with no access taken back: the record may have stopped half way. The
                // order's own flag when the server sends one, else the refunds list. Never for a partial record,
                // which changes no access by design.
                const canCheck = marker === 'full' && (o.reversalPending || reversalOpen.has(o.id));
                return (
                  <tr key={o.id} data-order={o.id}>
                    <th scope="row">{orderName(o)}</th>
                    <td>{o.planKey ?? '—'}</td>
                    <td>{t(`channels.${o.channel}`)}</td>
                    <td>{yuan(o.amountMinor)}</td>
                    <td>{f.moment(o.completedAt)}</td>
                    <td>
                      {marker ? (
                        <div className={styles.stack} style={{ gap: 'var(--sp-1)' }}>
                          <Marker tone="neutral" testId="cn-refunded">
                            {t(`refunded.${marker}`)}
                          </Marker>
                          {outcome?.result.entitlement ? <span className={styles.muted}>{t(`entitlement.${outcome.result.entitlement}`)}</span> : null}
                          {canCheck ? (
                            <div className={styles.stack} style={{ gap: 'var(--sp-1)' }} data-testid="cn-refund-check">
                              <span className={styles.muted}>{t('checkHint')}</span>
                              <div className={styles.actions}>
                                <Btn disabled={record.isPending} aria-busy={checking === o.id || undefined} aria-label={t('checkLabel', { order: orderName(o) })} onClick={() => onCheck(o)}>
                                  {checking === o.id ? t('checking') : t('check')}
                                </Btn>
                              </div>
                              {checkFailed?.orderId === o.id ? (
                                <span className={styles.error} role="alert">
                                  {t(`errors.${cnRefundErrorKey(checkFailed.error)}`)}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <Btn disabled={record.isPending || openId === o.id} aria-label={t('recordLabel', { order: orderName(o) })} onClick={() => start(o)}>
                          {t('record')}
                        </Btn>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {open ? (
        <form className={styles.notice} onSubmit={onRecord} noValidate data-testid="cn-refund-form" aria-labelledby="cn-refund-title">
          <h4 className={styles.h3} id="cn-refund-title">
            {t('formTitle', { order: orderName(open) })}
          </h4>
          <label className={styles.check}>
            <input type="checkbox" checked={returned} onChange={(e) => setReturned(e.target.checked)} />
            <span>{t('moneyReturned')}</span>
          </label>
          <div className={styles.form} style={{ gap: 'var(--sp-1)' }}>
            <label className={styles.label} htmlFor="cn-refund-reason">
              {t('reason')}
            </label>
            <input id="cn-refund-reason" className={styles.input} value={reason} maxLength={REASON_MAX} aria-required="true" onChange={(e) => setReason(e.target.value)} />
          </div>
          <div className={styles.form} style={{ gap: 'var(--sp-1)' }}>
            <label className={styles.label} htmlFor="cn-refund-amount">
              {t('partialAmount')}
            </label>
            <input id="cn-refund-amount" className={styles.input} style={{ maxWidth: 200 }} inputMode="decimal" value={amountText} aria-invalid={!amountOk || undefined} onChange={(e) => setAmountText(e.target.value)} />
          </div>
          {!amountOk ? <p className={styles.error}>{t('invalidAmount')}</p> : null}
          {record.isError && record.variables?.orderId === open.id && checkFailed === null ? (
            <p className={styles.error} role="alert">
              {t(`errors.${cnRefundErrorKey(record.error)}`)}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Btn type="submit" variant="primary" disabled={!canRecord} aria-busy={(record.isPending && checking === null) || undefined}>
              {record.isPending && checking === null ? t('saving') : t('save')}
            </Btn>
            <Btn
              disabled={record.isPending}
              onClick={() => {
                record.reset();
                setOpenId(null);
              }}
            >
              {t('cancel')}
            </Btn>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// ── Practice cost ─────────────────────────────────────────────────────────

export function PracticeCostPanel() {
  const t = useTranslations('credits.admin.practiceCost');
  const f = useFormats();
  const q = usePracticeCost();
  return (
    <section className={styles.card} aria-labelledby="admin-practice-cost" data-testid="practice-cost">
      <h2 className={styles.h2} id="admin-practice-cost">
        {t('title')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      {q.isPending ? <p className={styles.muted} aria-busy="true">{t('loading')}</p> : null}
      {q.isError && !q.data ? <p className={styles.error} role="alert">{t('loadError')}</p> : null}
      {q.data ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('brand')}</th>
                <th scope="col">{t('average')}</th>
                <th scope="col">{t('sample')}</th>
                <th scope="col">{t('range')}</th>
              </tr>
            </thead>
            <tbody>
              {PRACTICE_COST_BRANDS.map((id) => {
                const c = q.data.brands[id];
                return (
                  <tr key={id} data-brand={id}>
                    <th scope="row">{getBrand(id).name}</th>
                    {/* An average only when the server gives one over enough sessions; never a figure from a thin sample. */}
                    <td>{!c ? '—' : c.enough && c.averageUsd !== null ? f.usd(c.averageUsd) : t('notEnough', { n: c.sampleSize, min: c.minSessions })}</td>
                    <td>{c ? t('sampleValue', { n: c.sampleSize, max: c.maxSessions }) : '—'}</td>
                    <td>{c && c.oldest && c.newest ? t('rangeValue', { from: f.day(c.oldest), to: f.day(c.newest) }) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      <h3 className={styles.h3}>{t('ruleTitle')}</h3>
      <ul className={styles.list} data-testid="practice-cost-rules">
        {PRACTICE_COST_BRANDS.map((id) => (
          <li key={id} className={styles.row}>
            <span className={styles.rowLabel}>{getBrand(id).name}</span>
            <span className={styles.rowMeta}>{t(`rules.${id}`)}</span>
          </li>
        ))}
      </ul>
      <p className={styles.muted}>{t('ruleNote')}</p>
    </section>
  );
}

// ── Stripe ────────────────────────────────────────────────────────────────

function EventList({ events }: { events: readonly string[] }) {
  return (
    <ul className={styles.list}>
      {events.map((event) => (
        <li key={event} className={styles.row}>
          <span className={styles.rowLabel}>{event}</span>
        </li>
      ))}
    </ul>
  );
}

export function StripePanel() {
  const t = useTranslations('credits.admin.stripe');
  const q = useStripeHealth();
  const h = q.data;
  const endpoint = h ? stripeEndpointState(h) : null;
  const unchecked = h ? stripeUncheckedReason(h) : null;
  return (
    <section className={styles.card} aria-labelledby="admin-stripe-title" id={ADMIN_STRIPE_PANEL_ID} data-testid="stripe-health">
      <h2 className={styles.h2} id="admin-stripe-title">
        {t('title')}
      </h2>
      <p className={styles.muted}>{t('sub')}</p>
      {q.isPending ? <p className={styles.muted} aria-busy="true">{t('loading')}</p> : null}
      {q.isError && !h ? <p className={styles.error} role="alert">{t('loadError')}</p> : null}
      {h ? (
        <>
          <ul className={styles.list}>
            <Fact label={t('key')}>{t(`keyModes.${h.keyMode ?? 'unknown'}`)}</Fact>
            <Fact label={t('usable')}>{h.usable ? t('yes') : t('no')}</Fact>
            <Fact label={t('secrets')}>{h.webhookSecrets ?? '—'}</Fact>
            <Fact label={t('rail')}>
              <Marker tone={h.railReady ? 'ok' : 'warn'} testId="stripe-rail">
                {t(h.railReady ? 'railReady' : 'railNotReady')}
              </Marker>
            </Fact>
            <Fact label={t('endpoint')}>{h.endpoint.url ?? '—'}</Fact>
            <Fact label={t('pinned')}>{h.pinnedPlans.length ? h.pinnedPlans.join(', ') : t('pinnedNone')}</Fact>
          </ul>
          {!h.usable ? (
            <div className={styles.banner} role="status" data-testid="stripe-refused">
              <p className={styles.body}>{t(`refused.${h.refusedReason ?? 'unknown'}`)}</p>
            </div>
          ) : null}
          <h3 className={styles.h3}>{t('events')}</h3>
          {endpoint === 'no_endpoint' ? (
            // No endpoint at all: nothing can be "added to the endpoint". The events listed are what a new one needs.
            <div className={styles.stack} data-testid="stripe-endpoint-none">
              <div className={styles.banner} role="status">
                <p className={styles.body}>{t('endpointNone')}</p>
              </div>
              {h.endpoint.missingEvents.length > 0 ? (
                <>
                  <p className={styles.body}>{t('eventsNeeded', { count: h.endpoint.missingEvents.length })}</p>
                  <EventList events={h.endpoint.missingEvents} />
                </>
              ) : null}
            </div>
          ) : endpoint === 'unchecked' ? (
            <p className={styles.body} data-testid="stripe-events-unchecked">
              {t('notChecked')}
              {unchecked ? <> {t(`notCheckedReason.${unchecked}`)}</> : null}
            </p>
          ) : endpoint === 'complete' ? (
            <p className={styles.body} data-testid="stripe-events-none">
              {t('eventsNone')}
            </p>
          ) : (
            <div className={styles.stack} data-testid="stripe-events-missing">
              <p className={styles.body}>{t('eventsMissing', { count: h.endpoint.missingEvents.length })}</p>
              <EventList events={h.endpoint.missingEvents} />
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
