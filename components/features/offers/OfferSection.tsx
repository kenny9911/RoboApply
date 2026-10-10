'use client';

// OfferSection — the offer block in an application's detail drawer: the
// user's own offer numbers (base, bonus, equity; GoApply 月薪·N薪, 年终,
// 五险一金, 公积金, 户口, 签字费, 期权) (TASK_PLAN.md WP-64).
//
// WP-38's tracker drawer renders it for every entry; it shows itself only
// when the `offers` flag is on. Writes go through lib/api/offers.ts (the
// server writes them with `tracker.updateOffer()`, which records the change in
// the application's history). The totals are computed only from what the
// user entered; posted pay for the role is loaded on demand with N shown; the
// negotiation draft is AI-written, labelled, and sent by the user themselves.

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives';
import { PhoneBindingNotice } from '../auth-cn';
import { useFlag } from '../../../lib/flags';
import { useBrand } from '../../../lib/brand';
import { useDeleteOffer, useNegotiationDraft, useOffer, useOffers, useOffersAiAvailable, useSaveOffer } from '../../../hooks/offers/useOffers';
import type * as OF from '../../../lib/api/contracts/offers';
import { AiText } from './AiText';
import { OfferForm } from './OfferForm';
import { PostedPay } from './PostedPay';
import { aiErrorKey, defaultCurrency, formFrom, useMoney } from './shared';
import styles from './offers.module.css';

export interface OfferSectionProps {
  /** RATrackerEntry id of the application. */
  trackerEntryId: string;
  /** Called after the offer was saved, so the drawer can refresh. */
  onChange?: () => void;
}

export function OfferSection({ trackerEntryId, onChange }: OfferSectionProps) {
  const on = useFlag('offers');
  if (!on) return null;
  return <OfferSectionBody trackerEntryId={trackerEntryId} onChange={onChange} />;
}

function OfferSectionBody({ trackerEntryId, onChange }: OfferSectionProps) {
  const t = useTranslations('offers.section');
  const brand = useBrand();
  const locale = useLocale();
  const market = brand.market === 'cn' ? 'cn' : 'intl';
  const { offer, isLoading, isError } = useOffer(trackerEntryId);
  const save = useSaveOffer();
  const remove = useDeleteOffer();
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'save_error' | 'remove_error' | null>(null);

  return (
    <section className={styles.section} aria-labelledby={`offer-${trackerEntryId}`}>
      <div className={styles.head}>
        <h3 id={`offer-${trackerEntryId}`} className={styles.title}>
          {t('title')}
        </h3>
        {notice ? (
          <span role="status" className={notice === 'saved' ? styles.muted : styles.error}>
            {t(notice)}
          </span>
        ) : null}
      </div>

      {isLoading ? <p className={styles.muted}>{t('loading')}</p> : null}
      {isError ? <p className={styles.muted}>{t('load_error')}</p> : null}

      {editing ? (
        <OfferForm
          initial={formFrom(offer?.offer, { market, currency: defaultCurrency(market, locale) })}
          market={market}
          saving={save.isPending}
          onCancel={() => setEditing(false)}
          onSave={(body) =>
            save.mutate(
              { trackerEntryId, body },
              {
                onSuccess: () => {
                  setEditing(false);
                  setNotice('saved');
                  onChange?.();
                },
                onError: () => setNotice('save_error'),
              },
            )
          }
        />
      ) : offer === null ? (
        <>
          <p className={styles.text}>{t('empty')}</p>
          <div className={styles.actions}>
            <Btn variant="default" onClick={() => setEditing(true)}>
              {t('add')}
            </Btn>
          </div>
        </>
      ) : offer ? (
        <>
          <OfferSummary view={offer} market={market} />
          <div className={styles.actions}>
            <Btn variant="default" onClick={() => setEditing(true)}>
              {t('edit')}
            </Btn>
            {confirmRemove ? (
              <>
                <span className={styles.muted}>{t('remove_confirm')}</span>
                <Btn
                  variant="default"
                  disabled={remove.isPending}
                  onClick={() =>
                    remove.mutate(trackerEntryId, {
                      onSuccess: () => {
                        setConfirmRemove(false);
                        onChange?.();
                      },
                      onError: () => setNotice('remove_error'),
                    })
                  }
                >
                  {t('remove_yes')}
                </Btn>
                <Btn variant="ghost" onClick={() => setConfirmRemove(false)}>
                  {t('remove_keep')}
                </Btn>
              </>
            ) : (
              <Btn variant="ghost" onClick={() => setConfirmRemove(true)}>
                {t('remove')}
              </Btn>
            )}
          </div>
          <PostedPay trackerEntryId={trackerEntryId} currency={offer.offer.currency} period={offer.offer.period} baseAnnual={offer.totals.baseAnnual} />
          <NegotiationDraftPanel trackerEntryId={trackerEntryId} />
        </>
      ) : null}
    </section>
  );
}

function OfferSummary({ view, market }: { view: OF.OfferView; market: 'intl' | 'cn' }) {
  const t = useTranslations('offers.section');
  const tr = useTranslations('offers.rows');
  const money = useMoney();
  const o = view.offer;
  const totals = view.totals;
  const items: Array<[string, string]> = [
    [tr('base'), t('per_period', { amount: money(o.base, o.currency), period: o.period })],
    [t('yearly_total'), money(totals.recurringAnnual, o.currency)],
  ];
  if (totals.firstYear !== totals.recurringAnnual) items.push([t('first_year'), money(totals.firstYear, o.currency)]);
  if (market === 'cn' && o.cn?.salaryMonths) items.push([tr('salaryMonths'), String(o.cn.salaryMonths)]);
  if (o.equity) items.push([tr('equity'), o.equity]);
  if (o.deadline) items.push([tr('deadline'), o.deadline]);
  return (
    <>
      <dl className={styles.facts}>
        {items.map(([label, value]) => (
          <div key={label} className={styles.fact}>
            <dt className={styles.factLabel}>{label}</dt>
            <dd className={styles.factValue}>{value}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.muted}>{t('totals_note')}</p>
    </>
  );
}

function NegotiationDraftPanel({ trackerEntryId }: { trackerEntryId: string }) {
  const t = useTranslations('offers.draft');
  // Hidden unless the server says the AI can run for this user (consent AND ai.text, §2.2).
  const capability = useFlag('ai.text');
  const aiOn = useOffersAiAvailable(capability) && capability;
  const others = useOffers().data?.filter((o) => o.trackerEntryId !== trackerEntryId) ?? [];
  const draft = useNegotiationDraft();
  const [focus, setFocus] = useState<OF.NegotiationFocus>('overall');
  const [mentionOthers, setMentionOthers] = useState(false);
  if (!aiOn) return null;
  const errKey = draft.isError ? aiErrorKey(draft.error) : null;
  const focuses: OF.NegotiationFocus[] = ['overall', 'base', 'signing_bonus', 'start_date', 'equity'];

  return (
    <div className={styles.form}>
      <div className={styles.grid}>
        <label className={styles.field}>
          <span className={styles.label}>{t('focus')}</span>
          <select className={styles.select} value={focus} onChange={(e) => setFocus(e.target.value as OF.NegotiationFocus)}>
            {focuses.map((f) => (
              <option key={f} value={f}>
                {t(`focus_${f}`)}
              </option>
            ))}
          </select>
        </label>
        {others.length ? (
          <label className={styles.check}>
            <input type="checkbox" checked={mentionOthers} onChange={(e) => setMentionOthers(e.target.checked)} />
            {t('mention_others', { count: others.length })}
          </label>
        ) : null}
      </div>
      <div className={styles.actions}>
        <Btn
          variant="default"
          disabled={draft.isPending}
          onClick={() =>
            draft.mutate({
              trackerEntryId,
              body: { focus, ...(mentionOthers && others.length ? { compareWith: others.slice(0, 4).map((o) => o.trackerEntryId) } : {}) },
            })
          }
        >
          {draft.isPending ? t('writing') : draft.data ? t('rewrite') : t('write')}
        </Btn>
      </div>
      {errKey ? (
        <p className={styles.error} role="alert">
          {t(`error.${errKey}`)}
        </p>
      ) : null}
      {draft.isError ? <PhoneBindingNotice error={draft.error} /> : null}
      {draft.data ? <AiText label={t('ai_label')} text={draft.data.text} points={draft.data.talkingPoints} pointsTitle={t('points')} copyable /> : null}
      {draft.data && !draft.data.postedRange ? <p className={styles.muted}>{t('no_market')}</p> : null}
    </div>
  );
}

export default OfferSection;
