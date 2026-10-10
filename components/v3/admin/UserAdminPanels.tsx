'use client';

// components/v3/admin/UserAdminPanels.tsx — the per-user admin panels on
// /admin/users/[userId] (WP-74; PRODUCT F-BILL-01 overrides UI):
//   UserOverridesPanel  per-user credit caps, entitlements and beta flags
//                       (server: /admin/overrides → credits area rules, audited);
//   RefundQuotePanel    what the refund policy says about the person's latest
//                       charge (WP-21a; a quote only, refunds are issued in the
//                       payment provider).
// Plan-wide caps live on /admin/credits, linked from here.

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Btn } from '../primitives/Btn';
import { Tag } from '../primitives/Tag';
import { useCreateOverride, useDeleteOverride, useRefundQuote, useUserOverrides } from '../../../hooks/useAdmin';
import { apiErrorReason } from '../../../lib/api/contracts/wire';
import { ErrorPanel } from './SystemConsole';
import { fmtLongDate, fmtNativeAmount } from './format';
import styles from './console.module.css';

type OverrideValue = number | boolean | 'off' | 'deeplinks_only' | 'on';

/** Parse the value box: "true"/"false", a whole number, or a hiring-contacts mode. Null = invalid. */
export function parseOverrideValue(raw: string): OverrideValue | null {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === 'on') return v === 'on' ? 'on' : true;
  if (v === 'false') return false;
  if (v === 'off' || v === 'deeplinks_only') return v;
  if (/^\d{1,5}$/.test(v)) return Number(v);
  return null;
}

export function UserOverridesPanel({ userId }: { userId: string }) {
  const t = useTranslations('admin.console.overrides');
  const locale = useLocale();
  const q = useUserOverrides(userId);
  const create = useCreateOverride(userId);
  const remove = useDeleteOverride(userId);
  const [kind, setKind] = useState<'bucket' | 'entitlement' | 'flag'>('bucket');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [expires, setExpires] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const parsed = parseOverrideValue(value);
    if (!name.trim() || parsed === null || !reason.trim()) {
      setFormError(t('invalid'));
      return;
    }
    create.mutate(
      {
        key: `${kind}:${name.trim()}`,
        value: parsed,
        reason: reason.trim(),
        ...(expires ? { expiresAt: new Date(`${expires}T23:59:59`).toISOString() } : {}),
      },
      {
        onSuccess: () => {
          setName('');
          setValue('');
          setExpires('');
          setReason('');
        },
        onError: (err) => setFormError(apiErrorReason(err) ?? (err instanceof Error ? err.message : t('failed'))),
      },
    );
  };

  return (
    <section className={styles.panel} aria-labelledby="overrides-title">
      <div className={styles.panelHead}>
        <div>
          <h2 id="overrides-title">{t('title')}</h2>
          <p>{t('sub')}</p>
        </div>
        <Link className={styles.link} href="/admin/credits">{t('creditsLink')}</Link>
      </div>
      {q.isError ? (
        <ErrorPanel retry={() => void q.refetch()} />
      ) : !q.data ? (
        <p className={styles.muted} aria-busy="true">{t('loading')}</p>
      ) : q.data.items.length === 0 ? (
        <p className={styles.muted}>{t('empty')}</p>
      ) : (
        <ul className={styles.list}>
          {q.data.items.map((o) => (
            <li key={o.id} className={styles.card}>
              <div className={styles.cardHead}>
                <div>
                  <h3><span className={styles.code}>{o.key}</span> = {String(o.value)}</h3>
                  <p>{t('meta', { created: fmtLongDate(o.createdAt, locale), expires: o.expiresAt ? fmtLongDate(o.expiresAt, locale) : t('noEnd') })}</p>
                </div>
                <Btn variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(o.id)} aria-label={t('removeLabel', { key: o.key })}>{t('remove')}</Btn>
              </div>
              <p className={styles.quote}>{o.reason}</p>
            </li>
          ))}
        </ul>
      )}
      {remove.isError && <p className={styles.error} role="alert">{t('failed')}</p>}
      <form onSubmit={submit} className={styles.filters} aria-labelledby="overrides-add">
        <h3 id="overrides-add" className={`${styles.muted} ${styles.full}`}>{t('add')}</h3>
        <label className={styles.field}>
          {t('kind')}
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="bucket">{t('kinds.bucket')}</option>
            <option value="entitlement">{t('kinds.entitlement')}</option>
            <option value="flag">{t('kinds.flag')}</option>
          </select>
        </label>
        <label className={styles.field}>
          {t('name')}
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} maxLength={70} />
        </label>
        <label className={styles.field}>
          {t('value')}
          <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('valuePlaceholder')} maxLength={20} />
        </label>
        <label className={styles.field}>
          {t('expires')}
          <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </label>
        <label className={`${styles.field} ${styles.full}`}>
          {t('reason')}
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} aria-required="true" />
        </label>
        <div className={styles.actions}>
          <Btn type="submit" variant="primary" disabled={create.isPending}>{t('save')}</Btn>
          {formError && <p className={styles.error} role="alert">{formError}</p>}
          {create.isSuccess && !formError && <p className={styles.success} role="status">{t('saved')}</p>}
        </div>
      </form>
      <p className={styles.muted}>{t('help')}</p>
    </section>
  );
}

export function RefundQuotePanel({ userId }: { userId: string }) {
  const t = useTranslations('admin.console.refund');
  const locale = useLocale();
  const [asked, setAsked] = useState(false);
  const q = useRefundQuote(userId, asked);
  const d = q.data;
  return (
    <section className={styles.panel} aria-labelledby="refund-title">
      <div className={styles.panelHead}>
        <div>
          <h2 id="refund-title">{t('title')}</h2>
          <p>{t('sub')}</p>
        </div>
        {!asked && <Btn onClick={() => setAsked(true)}>{t('check')}</Btn>}
      </div>
      {asked && q.isError && <ErrorPanel retry={() => void q.refetch()} />}
      {asked && !d && !q.isError && <p className={styles.muted} aria-busy="true">{t('loading')}</p>}
      {d && !d.charge && <p className={styles.muted}>{t('noCharge')}</p>}
      {d?.charge && (
        <>
          <p className={styles.muted}>
            {t('charge', { amount: fmtNativeAmount(d.charge.amountMinor, d.charge.currency, locale), at: fmtLongDate(d.charge.chargedAt, locale), plan: d.charge.planKey, kind: t(`chargeKind.${d.charge.chargeKind}`) })}
          </p>
          {d.decision && (
            <div className={styles.tags}>
              <Tag tone={d.decision.eligible ? 'default' : 'warn'}>{t(d.decision.eligible ? 'eligible' : 'notEligible')}</Tag>
              <Tag>{t('rule', { rule: d.decision.rule })}</Tag>
              {d.decision.blocker && <Tag>{t('blocker', { blocker: d.decision.blocker })}</Tag>}
              {d.decision.deadline && <Tag>{t('deadline', { at: fmtLongDate(d.decision.deadline, locale) })}</Tag>}
            </div>
          )}
          {d.decision?.eligible && <p className={styles.muted}>{t('amount', { amount: fmtNativeAmount(d.decision.amountMinor, d.decision.currency, locale) })}</p>}
          <p className={styles.muted}>{t('issueElsewhere')}</p>
        </>
      )}
    </section>
  );
}
