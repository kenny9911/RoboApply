'use client';

// JobMetaTw — Taiwan lines on job cards and the job page (TASK_PLAN.md WP-42;
// TW-03, TW-09). Reached only through MarketJobMeta on RoboApply; renders
// nothing for jobs outside Taiwan or when the server sent no `ats_public` and
// no `tw_sources` meta.
//
//   card    one compact line: pay as posted when the posting says 面議 /
//           依公司規定 (the employer's own words, kept, minus the Art. 5
//           floor clause the server strips from `pay.text`), and the permit
//           tags.
//   detail  the same, plus the posting's full pay wording (labelled as the
//           posting's own words, next to the note that explains the Art. 5
//           rule), each permit tag's quote, and the source link.
//
//   both    for a row of a government open-data source (台灣就業通), the
//           licence attribution: the server's sentence, linked to the licence
//           text. The licence (政府資料開放授權條款 第1版) allows reuse only
//           with it, so it shows on the card and on the job page, also when
//           the row has no pay or permit line. The sentence is data in
//           Traditional Chinese, not UI copy, and no 台灣就業通 logo is used.
//
// D3: pay is only the posting's own text; nothing here shows an amount the
// posting did not state, and no card shows the NT$40,000 floor as pay. A permit tag never renders without its quote on the
// detail view, and the server drops a tag whose quote left the posting.

import { useTranslations } from 'next-intl';

import type { MarketJobMetaSlotProps } from '../types';
import { readTwMeta, readTwSourcesMeta, type TwAttribution } from './meta';
import { NegotiablePayNote } from './NegotiablePayNote';
import styles from './tw.module.css';

/**
 * The open-data licence attribution: the sentence itself is the link to the
 * licence text (plain text when the server sent no safe link). `lang` marks
 * it as Traditional Chinese in every locale.
 */
function Attribution({ attribution, jobId }: { attribution: TwAttribution; jobId: string }) {
  return (
    <p className={styles.source} lang="zh-Hant" data-tw-attribution="" data-job-id={jobId}>
      {attribution.url ? (
        <a className={styles.link} href={attribution.url} target="_blank" rel="noopener noreferrer">
          {attribution.text}
        </a>
      ) : (
        <span>{attribution.text}</span>
      )}
    </p>
  );
}

export function JobMetaTw({ jobId, meta, variant }: MarketJobMetaSlotProps) {
  const t = useTranslations('jobsTw.meta');
  const tw = readTwMeta(meta);
  const attribution = readTwSourcesMeta(meta)?.attribution ?? null;
  const showPay = !!tw && tw.pay.negotiable && !!tw.pay.text;
  const permitTags = tw?.permitTags ?? [];
  // Disclosed pay and the source line are already on every card (WP-32/34);
  // this slot adds only what Taiwan postings need.
  const hasLines = !!tw && (showPay || permitTags.length > 0);
  if (!hasLines && !attribution) return null;
  // An open-data row with no pay or permit line still carries its attribution.
  if (!tw || !hasLines) return <Attribution attribution={attribution!} jobId={jobId} />;
  const { pay, source } = tw;

  if (variant === 'card') {
    return (
      <>
        <ul className={styles.cardLine} aria-label={t('regionLabel')} data-job-id={jobId}>
          {showPay ? (
            <li className={styles.pill}>
              {t('payAsPosted', { text: pay.text! })}
            </li>
          ) : null}
          {permitTags.map((p) => (
            <li key={p.tag} className={`${styles.pill} ${styles.pillPermit}`}>
              {t(`permit.${p.tag}`)}
            </li>
          ))}
        </ul>
        {attribution ? <Attribution attribution={attribution} jobId={jobId} /> : null}
      </>
    );
  }

  const headingId = `tw-meta-${jobId}`;
  return (
    <section className={styles.detail} aria-labelledby={headingId} data-job-id={jobId}>
      <h3 id={headingId} className={styles.detailTitle}>
        {t('regionLabel')}
      </h3>
      {showPay ? (
        <div>
          <p className={styles.pay}>
            {t('payAsPosted', { text: pay.text! })}
          </p>
          {pay.posted && pay.posted !== pay.text ? <p className={styles.postedWords}>{t('postedWords', { text: pay.posted })}</p> : null}
          <NegotiablePayNote />
        </div>
      ) : null}
      {permitTags.length ? (
        <ul className={styles.permits}>
          {permitTags.map((p) => (
            <li key={p.tag} className={styles.permit}>
              <span className={`${styles.pill} ${styles.pillPermit}`}>{t(`permit.${p.tag}`)}</span>
              <span className={styles.quoteLabel}>{t('quoteLabel')}</span>
              <blockquote className={styles.quote} cite={source.url ?? undefined}>
                {p.quote}
              </blockquote>
            </li>
          ))}
        </ul>
      ) : null}
      {source.name || source.url ? (
        <p className={styles.source}>
          {source.name ? <span>{t('source', { name: source.name })}</span> : null}
          {source.url ? (
            <a className={styles.link} href={source.url} target="_blank" rel="noopener noreferrer">
              {t('viewPosting')}
            </a>
          ) : null}
        </p>
      ) : null}
      {attribution ? <Attribution attribution={attribution} jobId={jobId} /> : null}
    </section>
  );
}

export default JobMetaTw;
