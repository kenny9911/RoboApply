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
//     "来源：{sourceName}" (+ GoHire's licence line when the server sent it);
//     a job the user added has no source name and reads "Added by you";
//   - pay verbatim or "薪资未披露";
//   - 可落户 / 央国企 / 事业编 / 外企 and 届别 only with the posting's quote,
//     shown on hover/focus and to screen readers;
//   - on the user's own import, fraud warnings with the sentence they rest on
//     (AI-raised ones carry AiGeneratedBadge).
// No applicant counts, view counts or funding data.

import { useFormatter, useTranslations } from 'next-intl';

import { AiGeneratedBadge } from '../AiGeneratedBadge';
import type { MarketJobMetaSlotProps } from '../types';
import { SalaryCn } from './SalaryCn';
import { isOwnImport, parseDate, readCnMeta, ruleKey } from './meta';
import styles from './cnJobs.module.css';

export function JobMetaCn({ jobId, meta, variant }: MarketJobMetaSlotProps) {
  const t = useTranslations('jobsCn');
  const format = useFormatter();
  const m = readCnMeta(meta);
  if (!m) return null;

  const fmt = (d: Date) => format.dateTime(d, { year: 'numeric', month: 'short', day: 'numeric' });
  const updated = parseDate(m.updatedAt);
  const checked = parseDate(m.lastCheckedAt);
  const expires = parseDate(m.expiresAt);
  const expired = expires ? expires.getTime() < Date.now() : false;
  const { sourceLine } = m;

  const source =
    sourceLine.kind === 'direct' ? (
      <span className={styles.direct} title={t('source.directHint')}>
        {t('source.direct')}
      </span>
    ) : null;
  const sourceText = sourceLine.sourceName
    ? t('source.from', { sourceName: sourceLine.sourceName })
    : isOwnImport(meta)
      ? t('source.addedByYou')
      : t('source.unknown');
  const updatedText = updated ? t('dates.updated', { date: fmt(updated) }) : t('dates.updatedUnknown');
  const checkedText = checked ? t('dates.lastChecked', { date: fmt(checked) }) : null;
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
            {sourceLine.originalSourceName ? <span className={styles.muted}>{t('source.reposted', { name: sourceLine.originalSourceName })}</span> : null}
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
