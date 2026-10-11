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
//   both    for a row read out of Google's job index (MKT-5F, JT-8; the
//           server's `tw_sources.via = 'google_jobs'`), where it came from:
//           "{publisher} · found through Google job search", linked to the
//           original posting; with no publisher it names only the search. It
//           replaces the "Source: …" line of the job page for such a row, so
//           the aggregator is never named as the source. We do not read 104,
//           1111 or any other board and have no agreement with them: the
//           wording says "found through" and nothing more, and no board's
//           logo is shown. The publisher's name is the server's data and is
//           never a LinkedIn name (the server drops it; a name that still
//           carries the mark is not rendered here either).
//
// D3: pay is only the posting's own text; nothing here shows an amount the
// posting did not state, and no card shows the statutory amount of the pay
// rule as pay. A permit tag never renders without its quote on the
// detail view, and the server drops a tag whose quote left the posting.

import { useTranslations } from 'next-intl';

import type { MarketCardMeta, MarketJobMetaSlotProps } from '../types';
import { readTwMeta, readTwSourcesMeta, safeHref, type TwAttribution } from './meta';
import { NegotiablePayNote } from './NegotiablePayNote';
import styles from './tw.module.css';

/** A row found through Google's job index: who published it (null: not known) and the original posting. */
export interface TwProvenance {
  via: 'google_jobs';
  publisher: string | null;
  url: string | null;
}

/** Longest publisher name we print (a board's name is a few words). */
const MAX_PUBLISHER_CHARS = 80;
/** The mark that never appears on a source line (ruling H9), in the spellings the server also refuses. */
const LINKEDIN_RE = /linked\s*-?\s*in|lnkd\.in|領英|领英/i;

/**
 * Reads the provenance half of `meta.tw_sources` (the server's
 * `TwSourcesCardMeta`, jobs/sources/twHooks.ts). Null when the row was not
 * found through Google's job index or the value is not one: nothing is
 * rendered then. Defensive: a card always renders.
 */
export function readTwProvenance(meta: MarketCardMeta | null | undefined): TwProvenance | null {
  const raw = meta?.tw_sources as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object' || raw.via !== 'google_jobs') return null;
  const name = typeof raw.publisher === 'string' ? raw.publisher.trim() : '';
  const publisher = name && name.length <= MAX_PUBLISHER_CHARS && !LINKEDIN_RE.test(name) ? name : null;
  const url = safeHref(raw.url);
  return { via: 'google_jobs', publisher, url: url && !LINKEDIN_RE.test(url) ? url : null };
}

/**
 * The open-data licence attribution: the sentence itself is the link to the
 * licence text (plain text when the server sent no safe link). `lang` marks
 * it as Traditional Chinese in every locale.
 */
export function TwAttributionLine({ attribution, jobId }: { attribution: TwAttribution; jobId: string }) {
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

/**
 * "104人力銀行 · found through Google job search": the line is the link to the
 * original posting (plain text when the row has no safe link). Words only: no
 * logo, and nothing that reads as a partnership.
 */
function Provenance({ provenance, jobId }: { provenance: TwProvenance; jobId: string }) {
  const t = useTranslations('jobsTw.meta');
  const line = provenance.publisher ? t('foundThroughGoogle', { publisher: provenance.publisher }) : t('foundThroughGoogleOnly');
  return (
    <p className={styles.source} data-tw-provenance={provenance.via} data-job-id={jobId}>
      {provenance.url ? (
        <a className={styles.link} href={provenance.url} target="_blank" rel="noopener noreferrer">
          {line}
        </a>
      ) : (
        <span>{line}</span>
      )}
    </p>
  );
}

export function JobMetaTw({ jobId, meta, variant }: MarketJobMetaSlotProps) {
  const t = useTranslations('jobsTw.meta');
  const tw = readTwMeta(meta);
  const attribution = readTwSourcesMeta(meta)?.attribution ?? null;
  const provenance = readTwProvenance(meta);
  const showPay = !!tw && tw.pay.negotiable && !!tw.pay.text;
  const permitTags = tw?.permitTags ?? [];
  // Disclosed pay and the source line are already on every card (WP-32/34);
  // this slot adds only what Taiwan postings need.
  const hasLines = !!tw && (showPay || permitTags.length > 0);
  if (!hasLines && !attribution && !provenance) return null;
  // A row with no pay or permit line still says where it came from, and an open-data row still carries its attribution.
  if (!tw || !hasLines) {
    return (
      <>
        {provenance ? <Provenance provenance={provenance} jobId={jobId} /> : null}
        {attribution ? <TwAttributionLine attribution={attribution} jobId={jobId} /> : null}
      </>
    );
  }
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
        {provenance ? <Provenance provenance={provenance} jobId={jobId} /> : null}
        {attribution ? <TwAttributionLine attribution={attribution} jobId={jobId} /> : null}
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
      {provenance ? (
        // Found through a search: the publisher and the search, never the aggregator's name.
        <Provenance provenance={provenance} jobId={jobId} />
      ) : source.name || source.url ? (
        <p className={styles.source}>
          {source.name ? <span>{t('source', { name: source.name })}</span> : null}
          {source.url ? (
            <a className={styles.link} href={source.url} target="_blank" rel="noopener noreferrer">
              {t('viewPosting')}
            </a>
          ) : null}
        </p>
      ) : null}
      {attribution ? <TwAttributionLine attribution={attribution} jobId={jobId} /> : null}
    </section>
  );
}

export default JobMetaTw;
