'use client';

// job_list — the jobs an answer is about (MKT-4H; MARKET_STRATEGY §2.3 step 8).
//
// A card that `show_jobs` made (`cited`) lists exactly the jobs the answer
// cites, in the order it mentions them, under "Jobs mentioned in this answer"
// and the answer's optional one-line note. It is never a complete search
// result, so nothing on it counts results or says "all". A card without
// `cited` is a whole list a tool returned (an answer that cited nothing, a
// visitor's search, a card stored earlier): it keeps the plain title.
//
// Ids come only from tool results (server guard). Fit is the tier word, never
// a chance of being hired, with the same fields the feed card reads: "Quick
// estimate" for an estimate, and the one plain reason when that estimate
// rests on little. Pay is what the post lists, with its unit ("a year", "an
// hour"); pay the post states in words only (a similar job's `payText`) is
// printed as those words, by the market's own rule (`marketPayWords`, the rule
// the job page's Similar jobs list uses: GoApply never prints 面议); only a
// post that states no pay reads "Pay not listed" (D3). A unit the post did
// not state is never shown (model.payOf keeps only the post's own text then).
//
// Each row shows what it is: the work model next to the place (a remote job
// whose post names a city is still "Remote"), and "Added by you" for the
// user's own jobs. A job whose pay was not read (the user's own added jobs)
// shows no pay line at all: "Pay not listed" is only said of a post that was
// read. A 台灣就業通 open-data row prints the credit line its licence asks for,
// the server's own sentence linked to the licence text (as the feed card and
// the job page do).

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';

import { useBrand } from '../../../../lib/brand';
import { FitTierLabel, HonestyLine } from '../../../v3/primitives';
import { payText } from '../../feed';
import { jobDetailHref } from '../../job';
import { marketPayWords } from '../../market';
import { lowConfidenceReason } from '../../match/FitScore';
import { CardFrame } from './CardFrame';
import { parseJobList } from './model';
import type { CardProps } from './types';
import styles from '../copilot.module.css';
import own from './jobList.module.css';

export function JobListCard({ card, ctx }: CardProps) {
  const t = useTranslations('assistant.cards.jobList');
  const tCited = useTranslations('assistant.jobList');
  const tFit = useTranslations('fit');
  const locale = useLocale();
  const brand = useBrand();
  const data = parseJobList(card.data);
  if (!data || data.items.length === 0) return null;
  return (
    <CardFrame card={card} title={data.cited ? tCited('title') : t('title')}>
      {data.note ? (
        <p className={styles.cardText} data-testid="job-list-note">
          {data.note}
        </p>
      ) : null}
      <ul className={styles.cardList} data-cited={data.cited ? 'true' : undefined}>
        {data.items.map((job) => {
          const pay = payText(job.pay, {
            locale,
            market: brand.market,
            range: (min, max) => t('range', { min, max }),
            from: (amount) => t('from', { amount }),
            upTo: (amount) => t('upTo', { amount }),
          });
          // No figures: the post's own words about pay, as this market prints them (null when it states none).
          const payWords = pay ? null : marketPayWords(brand.market, { pay: job.pay, payText: job.payText });
          const hasFit = !!job.tier || job.score !== null;
          // The feed card's own rule: one reason, only for a quick estimate whose confidence is low.
          const low = hasFit ? lowConfidenceReason({ kind: job.estimate ? 'pre' : 'ai', confidence: job.confidence ?? undefined, confidenceReason: job.confidenceReason }) : null;
          return (
            <li key={job.jobId} className={styles.jobRow} data-job={job.jobId}>
              <Link href={jobDetailHref(job.jobId)} className={styles.jobLink} onClick={ctx.onNavigate}>
                {job.title}
              </Link>
              <div className={styles.jobMeta}>
                {job.company ? <span>{job.company}</span> : null}
                {job.location ? <span>{job.location}</span> : null}
                {job.workModel ? <span data-work-model={job.workModel}>{t(`workModel.${job.workModel}`)}</span> : null}
                {job.addedByUser ? <span data-added="true">{t('addedByYou')}</span> : null}
                {pay || payWords || job.payKnown ? (
                  <span data-pay={pay ? 'figures' : payWords ? 'words' : 'none'}>
                    {pay ? (pay.period ? t(`payPeriod.${pay.period}`, { amount: pay.amount }) : pay.amount) : payWords ? t('payAsStated', { text: payWords }) : t('payNotListed')}
                  </span>
                ) : null}
                {hasFit ? <FitTierLabel tier={job.tier} score={job.score} estimate={job.estimate} /> : null}
              </div>
              {low ? (
                <p className={styles.muted} data-testid="job-row-estimate-reason">
                  {low === 'no_resume' ? tFit('quickEstimateWhy.no_resume') : tFit(`confidence.reason.${low}`)}
                </p>
              ) : null}
              {job.attribution ? (
                // The sentence is the server's data, in Traditional Chinese for every locale.
                <p className={own.credit} lang="zh-Hant" data-tw-attribution="">
                  {job.attribution.url ? (
                    <a className={own.creditLink} href={job.attribution.url} target="_blank" rel="noopener noreferrer">
                      {job.attribution.text}
                    </a>
                  ) : (
                    <span>{job.attribution.text}</span>
                  )}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
      {data.items.some((j) => j.tier || j.score !== null) ? <HonestyLine kind="fit" /> : null}
      <Link href="/jobs" className={styles.link} onClick={ctx.onNavigate}>
        {t('seeAll')}
      </Link>
    </CardFrame>
  );
}
