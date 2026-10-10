'use client';

// JobMetaCn — GoApply job-card lines (CN-E-05 display, F-FEED-07 cn tags,
// F-SAL-01 cn, CN plan "card honesty"). Reached only through
// components/features/market/MarketJobMeta.tsx when brand.market === 'cn';
// reads `meta.cn` (server CnCardMeta).
//
// Every card and detail view shows the source, the updated date (the
// posting's own date) and the closing date ("not listed" when unknown, never
// blank or invented), plus "Last checked {date}" when we know when we last saw
// it live (our crawl time is never presented as an update by the source):
//   - 企业直招 only when the server's three-field rule held; otherwise
//     "来源：{original publisher}" (the employer for a posting read from an
//     employer's careers board, the bank for a recruiter-bank row, plus the
//     bank's licence line when the server sent it), a link to the original
//     posting, and "最后核验 {date}"; a job the user added has no source name
//     and reads "Added by you";
//   - pay verbatim or "薪资未披露" (never 面议);
//   - 可落户 / 央国企 / 事业编 / 外企 and 届别 only with the posting's quote,
//     shown on hover/focus and to screen readers;
//   - on the user's own import, fraud warnings with the sentence they rest on
//     (AI-raised ones carry AiGeneratedBadge).
// No applicant counts, view counts or funding data.

import { useFormatter, useTranslations } from 'next-intl';

import { AiGeneratedBadge } from '../AiGeneratedBadge';
import type { MarketJobMetaSlotProps } from '../types';
import { SalaryCn } from './SalaryCn';
import { cnSourceName, isOwnImport, parseDate, readCnListing, readCnMeta, ruleKey } from './meta';
import styles from './cnJobs.module.css';

export function JobMetaCn({ jobId, meta, variant }: MarketJobMetaSlotProps) {
  const t = useTranslations('jobsCn');
  const format = useFormatter();
  const m = readCnMeta(meta);
  if (!m) return null;

  const fmt = (d: Date) => format.dateTime(d, { year: 'numeric', month: 'short', day: 'numeric' });
  const listing = readCnListing(meta);
  const updated = parseDate(m.updatedAt);
  // The contract's last-verified time when the item carries it, else the card meta's.
  const checked = parseDate(listing.lastVerifiedAt) ?? parseDate(m.lastCheckedAt);
  const expires = parseDate(m.expiresAt);
  const expired = expires ? expires.getTime() < Date.now() : false;
  const { sourceLine } = m;

  const source =
    sourceLine.kind === 'direct' ? (
      <span className={styles.direct} title={t('source.directHint')}>
        {t('source.direct')}
      </span>
    ) : null;
  const own = isOwnImport(meta);
  // A job the user added keeps the name its own meta carries (usually none: "Added by you").
  const sourceName = own ? sourceLine.sourceName : cnSourceName(m, listing);
  const sourceText = sourceName ? t('source.from', { sourceName }) : own ? t('source.addedByYou') : t('source.unknown');
  // The first publisher, when the line above names someone else (a reposted bank row).
  const reposted = sourceLine.originalSourceName && sourceLine.originalSourceName !== sourceName ? sourceLine.originalSourceName : null;
  const original = !own && listing.url ? (
    <a className={styles.link} href={listing.url} target="_blank" rel="noopener noreferrer nofollow" data-testid="cn-original-link">
      {t('source.original')}
      <span className={styles.srOnly}> {t('external.newTab')}</span>
    </a>
  ) : null;
  const updatedText = updated ? t('dates.updated', { date: fmt(updated) }) : t('dates.updatedUnknown');
  const checkedText = checked ? t('dates.lastVerified', { date: fmt(checked) }) : null;
  const expiresText = expires ? t(expired ? 'dates.expired' : 'dates.expires', { date: fmt(expires) }) : t('dates.expiresUnknown');

  const tags = [
    ...m.classYears.map((c) => ({ key: `cy-${c.year}`, label: t('tags.classYear', { year: c.year }), quote: c.evidenceQuote })),
    ...m.tags.map((tg) => ({ key: tg.tag, label: t(`tags.${tg.tag}`), quote: tg.evidenceQuote })),
  ];
  const idBase = `cn-meta-${jobId}-${variant}`;

  const warnings = m.warnings.length ? (
    <div className={styles.warning} role="note" aria-labelledby={`${idBase}-warn`}>
      <p className={styles.warningTitle} id={`${idBase}-warn`}>
        {t('warning.title')}
      </p>
      <ul className={styles.warningList}>
        {m.warnings.map((w, i) => (
          <li key={`${w.rule}-${i}`}>
            <span className={styles.warningRule}>{t(`rules.${ruleKey(w.rule)}`)}</span>
            {w.ai ? <AiGeneratedBadge /> : null}
            <span className={styles.quote}>{t('warning.evidence', { evidence: w.evidence })}</span>
          </li>
        ))}
      </ul>
      <p className={styles.muted}>{t('warning.body')}</p>
    </div>
  ) : null;

  // Card: compact chips, the quote on hover/focus and for screen readers.
  // Detail: the quote is printed under each tag (touch screens have no hover).
  const tagList = tags.length ? (
    <ul className={variant === 'card' ? styles.tags : styles.tagQuotes} aria-label={t('tags.label')}>
      {tags.map((tg, i) =>
        variant === 'card' ? (
          <li key={tg.key}>
            <span className={styles.tag} tabIndex={0} title={t('tags.quote', { quote: tg.quote })} aria-describedby={`${idBase}-q${i}`}>
              {tg.label}
            </span>
            <span className={styles.srOnly} id={`${idBase}-q${i}`}>
              {t('tags.quote', { quote: tg.quote })}
            </span>
          </li>
        ) : (
          <li key={tg.key} className={styles.tagQuote}>
            <span className={styles.tag}>{tg.label}</span>
            <span className={styles.quote}>{t('tags.quote', { quote: tg.quote })}</span>
          </li>
        ),
      )}
    </ul>
  ) : null;

  if (variant === 'card') {
    return (
      <div className={styles.card} data-testid="job-meta-cn" data-variant="card">
        <p className={styles.line}>
          {source}
          <span data-testid="cn-source">{sourceText}</span>
          {original ? (
            <>
              <span aria-hidden="true">·</span>
              {original}
            </>
          ) : null}
          <span aria-hidden="true">·</span>
          <span>{updatedText}</span>
          <span aria-hidden="true">·</span>
          <span>{expiresText}</span>
          {checkedText ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{checkedText}</span>
            </>
          ) : null}
        </p>
        <p className={styles.line}>
          <SalaryCn text={m.salary.text} disclosed={m.salary.disclosed} />
        </p>
        {tagList}
        {warnings}
      </div>
    );
  }

  return (
    <section className={styles.detail} data-testid="job-meta-cn" data-variant="detail" aria-labelledby={`${idBase}-h`}>
      <h3 className={styles.h3} id={`${idBase}-h`}>
        {t('meta.label')}
      </h3>
      {warnings}
      <dl className={styles.dl}>
        <div>
          <dt>{t('salary.label')}</dt>
          <dd>
            <SalaryCn text={m.salary.text} disclosed={m.salary.disclosed} />
          </dd>
        </div>
        <div>
          <dt className={styles.srOnly}>{sourceText}</dt>
          <dd className={styles.sourceBlock}>
            {source}
            <span data-testid="cn-source">{sourceText}</span>
            {original}
            {reposted ? <span className={styles.muted}>{t('source.reposted', { name: reposted })}</span> : null}
            {sourceLine.licence ? <span className={styles.muted}>{t('source.licence', sourceLine.licence)}</span> : null}
          </dd>
        </div>
        <div>
          <dt className={styles.srOnly}>{updatedText}</dt>
          <dd>
            {updatedText} <span aria-hidden="true">·</span> {expiresText}
            {checkedText ? (
              <>
                {' '}
                <span aria-hidden="true">·</span> {checkedText}
              </>
            ) : null}
          </dd>
        </div>
      </dl>
      {tagList}
    </section>
  );
}

export default JobMetaCn;
