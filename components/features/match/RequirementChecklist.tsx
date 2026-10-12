'use client';

// RequirementChecklist — "What the post asks for" (PRODUCT F-MATCH-01; SM-8;
// MATCH 4.8). Scorer v4 checks the resume against each requirement line of
// the posting; this lists them, must-haves first, each with:
//
//   Met | Partly | Not shown in your resume      ← a statement about the resume, never about the person
//   From the job post   “5+ years building backend services”     ← the posting's own words
//   From your resume    “Led the rewrite of the billing API …”   ← the resume's own words, when there are any
//
// A line the scorer marked "not applicable" (a benefits line) is not a
// requirement of the candidate and is not listed. With no requirements (a
// quick estimate, or a fit written before scorer v4) nothing is rendered, so
// the card looks as it always did.
//
// The statuses are a model's reading, so the block carries the AI label on
// GoApply (AiGeneratedBadge shows only there) and its own check-it line on
// both brands. The quotes are verbatim: the server drops a quote that is not
// in the text.

import { useTranslations } from 'next-intl';

import { AiGeneratedBadge } from '../market';
import type { RequirementCheck } from '../../../lib/api/contracts/match';
import { plainQuote } from './labels';
import styles from './match.module.css';

type ListedStatus = Exclude<RequirementCheck['status'], 'not_applicable'>;
type Listed = RequirementCheck & { status: ListedStatus };

const STATUS_CLASS: Record<ListedStatus, string | undefined> = {
  met: styles.statusMet,
  partly: styles.statusPartly,
  not_shown: styles.statusNotMet,
};

/** Must-haves in the posting's order, then the preferred ones; "not applicable" lines are left out. */
export function listedRequirements(requirements: readonly RequirementCheck[] | null | undefined): { must: Listed[]; preferred: Listed[] } {
  const listed = (requirements ?? []).filter((r): r is Listed => !!r && typeof r.text === 'string' && !!r.text.trim() && (r.status === 'met' || r.status === 'partly' || r.status === 'not_shown'));
  return { must: listed.filter((r) => r.importance === 'must'), preferred: listed.filter((r) => r.importance !== 'must') };
}

export interface RequirementChecklistProps {
  /** `MatchFitView.requirements`: empty for a quick estimate and for a fit written before scorer v4. */
  requirements: readonly RequirementCheck[] | null | undefined;
}

export function RequirementChecklist({ requirements }: RequirementChecklistProps) {
  const t = useTranslations('fit.requirements');
  const { must, preferred } = listedRequirements(requirements);
  if (!must.length && !preferred.length) return null;
  return (
    <section className={styles.section} aria-labelledby="fit-requirements-heading" data-testid="fit-requirements">
      <div className={styles.summaryHead}>
        <h3 id="fit-requirements-heading" className={styles.heading}>
          {t('title')}
        </h3>
        <AiGeneratedBadge kind="text" />
      </div>
      <p className={styles.intro}>{t('intro')}</p>
      <Group id="must" title={t('must')} items={must} />
      <Group id="preferred" title={t('preferred')} items={preferred} />
      <p className={styles.muted} data-testid="fit-requirements-note">
        {t('note')}
      </p>
    </section>
  );
}

function Group({ id, title, items }: { id: 'must' | 'preferred'; title: string; items: Listed[] }) {
  const t = useTranslations('fit');
  if (!items.length) return null;
  const count = (status: ListedStatus) => items.filter((r) => r.status === status).length;
  return (
    <div className={styles.reqGroup} data-group={id}>
      <div className={styles.reqGroupHead}>
        <h4 className={styles.subheading}>{title}</h4>
        <span className={styles.muted}>{t('requirements.count', { met: count('met'), partly: count('partly'), notShown: count('not_shown'), total: items.length })}</span>
      </div>
      <ul className={styles.reqList}>
        {items.map((r, i) => {
          const quote = r.status === 'not_shown' ? '' : plainQuote(r.evidence ?? '');
          return (
            <li key={`${i}:${r.id}`} className={styles.req} data-requirement={r.id} data-status={r.status}>
              <p className={styles.reqText}>{t('compared.evidence.quote', { text: r.text.trim() })}</p>
              <span className={[styles.status, STATUS_CLASS[r.status]].filter(Boolean).join(' ')}>{t(`requirements.status.${r.status}`)}</span>
              {quote ? (
                <p className={styles.reqEvidence}>
                  <span className={styles.source}>{t('compared.source.resume')}</span>
                  <span>{t('compared.evidence.quote', { text: quote })}</span>
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
