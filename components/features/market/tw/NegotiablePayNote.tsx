'use client';

// NegotiablePayNote — "Why is pay not listed?" for Taiwan postings that say
// 面議 / 依公司規定 (TW-03; CN_TW_LAUNCH_PLAN.md §4.2 WP-TW-JOBS; MKT-5F JT-6).
//
// States the legal rule (Employment Services Act Art. 5: pay may be left
// unlisted only at or above a statutory monthly amount) and links to where
// the rule can be read. It never says or implies that THIS job pays that
// amount: the copy says outright that the rule is not the job's pay and that
// unlisted pay is never estimated.
//
// The amount, the provision, the link and the day they were read come from
// the server (GET /tw/pay-rule: AppConfig `tw.payRule.v1`, or the law as read
// on 2026-10-11 when no admin has stored one), so an edit of the config
// follows a change of the law without a deploy. No amount lives in this file
// or in any message bundle. Until the rule has arrived, and whenever it cannot
// be read, the note explains the rule WITHOUT an amount: a number we cannot
// vouch for right now is worse than none (D3).
//
// `context="filter"` adds the line that ties it to the "Only jobs that list
// pay" toggle (FiltersDrawer).

import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';

import { useBrand } from '../../../../lib/brand';
import { TW_PAY_RULE_STALE_MS, formatRuleDate, formatTwd, getTwPayRule, httpsHref, twKeys, type TwPayRuleView } from '../../../../lib/api/tw';
import styles from './tw.module.css';

/**
 * Employment Services Act, Article 5 (national law database, Ministry of
 * Justice): the link the note carries while the rule has not arrived. A link
 * to the law, never an amount.
 */
export const TW_PAY_LAW_URL = 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5';

export interface NegotiablePayNoteProps {
  context?: 'job' | 'filter';
}

/**
 * The pay-disclosure rule for the note, or null while it loads, when the
 * request fails, when the server has no readable rule, and on GoApply (which
 * has no such note and never asks). One request per 4 minutes however many
 * notes are on screen.
 */
export function useTwPayRule(): TwPayRuleView | null {
  const brand = useBrand();
  const query = useQuery({
    queryKey: twKeys.payRule,
    queryFn: ({ signal }) => getTwPayRule({ signal }),
    enabled: brand.market === 'intl',
    staleTime: TW_PAY_RULE_STALE_MS,
    retry: false,
  });
  return query.data ?? null;
}

export function NegotiablePayNote({ context = 'job' }: NegotiablePayNoteProps) {
  const t = useTranslations('jobsTw.negotiable');
  const locale = useLocale();
  const rule = useTwPayRule();
  // Both must be readable to print either: an amount without its date is not shown.
  const amount = formatTwd(rule?.thresholdTwd);
  const asOf = formatRuleDate(rule?.asOf, locale);
  const stated = rule && amount && asOf ? { amount, asOf, iso: rule.asOf } : null;
  const href = httpsHref(rule?.sourceUrl) ?? TW_PAY_LAW_URL;
  const provision = typeof rule?.lawLabel === 'string' && rule.lawLabel.trim() ? rule.lawLabel.trim() : null;
  return (
    <details className={styles.note}>
      <summary className={styles.summary}>{t('summary')}</summary>
      <div className={styles.noteBody}>
        {stated ? (
          <p data-tw-pay-rule="stated" data-as-of={stated.iso}>
            {t('body', { amount: stated.amount, asOf: stated.asOf })}
          </p>
        ) : (
          <p data-tw-pay-rule="unstated">{t('bodyNoAmount')}</p>
        )}
        <p>{t('notAFigure')}</p>
        {context === 'filter' ? <p>{t('filterHint')}</p> : null}
        <p>
          <a className={styles.link} href={href} target="_blank" rel="noopener noreferrer">
            {/* The words name the national law database only when the link is that page. */}
            {href === TW_PAY_LAW_URL ? t('lawLink') : t('sourceLink')}
          </a>
          {provision ? (
            <>
              {' '}
              <span lang="zh-Hant" data-tw-pay-provision="">
                {provision}
              </span>
            </>
          ) : null}
        </p>
      </div>
    </details>
  );
}

export default NegotiablePayNote;
