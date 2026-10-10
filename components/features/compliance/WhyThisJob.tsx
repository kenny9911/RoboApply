'use client';

// WhyThisJob — renders a MatchExplanation from explainMatch() (PIPL Art. 24;
// server/src/features/compliance/explainMatch.ts). The feed and job detail
// (WP-33, WP-34) render it wherever a score is shown. Every line is a
// `legal.explain.*` key; evidence quotes are shown under their reason with
// where they came from.

import { useTranslations } from 'next-intl';

import type { ExplainLine, MatchExplanation } from '../../../lib/api/contracts/compliance';
import styles from './compliance.module.css';

function stripNs(key: string): string {
  return key.startsWith('legal.') ? key.slice('legal.'.length) : key;
}

export function WhyThisJob({ explanation }: { explanation: MatchExplanation }) {
  const t = useTranslations('legal');
  const text = (l: ExplainLine) => t(stripNs(l.key), l.params ?? {});
  // The label, the colon and the quotation marks are one message per source,
  // so each language uses its own punctuation (full-width in zh / zh-TW / ja).
  const evidence = (l: ExplainLine) =>
    l.params?.evidence ? (
      <span className={styles.quote}>
        {t(l.params.source === 'posting' ? 'explain.quoteFromPosting' : 'explain.quoteFromResume', { evidence: String(l.params.evidence) })}
      </span>
    ) : null;
  return (
    <section className={styles.why} aria-label={t('explain.title')} data-mode={explanation.mode}>
      <p className={styles.whyHead}>{text(explanation.headline)}</p>
      {explanation.reasons.length > 0 ? (
        <ul className={styles.whyList}>
          {explanation.reasons.map((r) => (
            <li key={r.key}>
              {text(r)}
              {evidence(r)}
            </li>
          ))}
        </ul>
      ) : null}
      {explanation.gaps.length > 0 ? (
        <ul className={styles.whyList}>
          {explanation.gaps.map((g) => (
            <li key={g.key}>{text(g)}</li>
          ))}
        </ul>
      ) : null}
      {explanation.notices.map((n) => (
        <p key={n.key} className={styles.notice}>
          {text(n)}
        </p>
      ))}
    </section>
  );
}

export default WhyThisJob;
