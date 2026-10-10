'use client';

// TailorResult — the tailored version (WP-36a; F-RES-10, F-RES-15):
//   - fit score before → after, as numbers and meters (real AI fit scores with
//     their source line, or "—"; never an estimate; "This is not your chance
//     of getting hired."). The after score appears only once every detail is
//     checked and the copy is finalized, so it never rests on unchecked claims;
//   - change cards and a side-by-side compare;
//   - Verify details: every line that says something the resume did not say
//     before must be kept, removed or rewritten by the user;
//   - "Use this resume" (finalize) stays disabled until nothing is pending.
// AI blocks carry AiGeneratedBadge (GoApply) and the "Written with AI" line.

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn, FitMeter, HonestyLine, Markdown, SourceNote, Tabs, tabPanelProps } from '../../v3/primitives';
import { AiGeneratedBadge } from '../market';
import { useResume } from '../../../hooks/useResumes';
import { useFinalizeTailor, useTailorClaim } from '../../../hooks/tailor';
import type { TailorChange, TailorSessionView } from '../../../lib/api/contracts/resume';
import { ClaimCard } from './ClaimCard';
import { TailorError } from './TailorError';
import styles from './Tailor.module.css';

export interface TailorResultProps {
  session: TailorSessionView;
  /** Called after "Use this resume" succeeds. */
  onFinalized?: (session: TailorSessionView) => void;
  /** Open the tailored resume (shown once finalized). */
  onOpenResume?: (resultVariantId: string) => void;
  onClose?: () => void;
}

type Tab = 'changes' | 'compare';

export function TailorResult({ session, onFinalized, onOpenResume, onClose }: TailorResultProps) {
  const t = useTranslations('tailor.result');
  const tv = useTranslations('tailor.verify');
  const [tab, setTab] = useState<Tab>('changes');
  const claim = useTailorClaim(session.id);
  const finalize = useFinalizeTailor(session.id);
  const finalized = session.status === 'finalized';
  const pending = session.pendingClaims;
  const tabBase = `tailor-${session.id}`;
  const title = session.target.title ? t('titleFor', { title: [session.target.title, session.target.company].filter(Boolean).join(' · ') }) : t('title');

  return (
    <div className={styles.flow} data-session-status={session.status}>
      <div className={styles.spread}>
        <h3 className={styles.heading}>{title}</h3>
        <AiGeneratedBadge kind="document" />
      </div>
      <HonestyLine kind="ai_written" />

      <section className={styles.card} aria-label={t('scoreHeading')}>
        {session.fit.before ? (
          <div className={styles.scores}>
            <div className={styles.score}>
              <p className={styles.label}>{t('scoreBefore')}</p>
              <p className={styles.scoreValue} data-testid="tailor-score-before">
                {t('scoreValue', { score: session.fit.before.value })}
              </p>
              <FitMeter score={session.fit.before.value} compact />
              <SourceNote sourced={session.fit.before} />
            </div>
            <div className={styles.score}>
              <p className={styles.label}>{t('scoreAfter')}</p>
              {session.fit.after ? (
                <>
                  <p className={styles.scoreValue} data-testid="tailor-score-after">
                    {t('scoreValue', { score: session.fit.after.value })}
                  </p>
                  <FitMeter score={session.fit.after.value} compact />
                  <SourceNote sourced={session.fit.after} />
                </>
              ) : (
                <>
                  <p className={styles.scoreValue} aria-hidden="true">
                    —
                  </p>
                  {/* The tailored text is scored only once every detail is checked (no score rests on unchecked claims). */}
                  <p className={styles.sub} data-testid="tailor-score-after-pending">
                    {finalized ? t('scoreNone') : t('scoreAfterPending')}
                  </p>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.score}>
            <p className={styles.label}>{t('scoreHeading')}</p>
            <p className={styles.sub} data-testid="tailor-score-none">
              — {t('scoreNone')}
            </p>
            <HonestyLine kind="fit" />
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby={`tailor-verify-${session.id}`}>
        <h4 id={`tailor-verify-${session.id}`} className={styles.heading}>
          {tv('title')}
        </h4>
        <p className={styles.sub}>{tv('sub')}</p>
        {session.claims.length === 0 || pending === 0 ? (
          <p className={styles.success} role="status">
            {tv('allDone')}
          </p>
        ) : null}
        {session.claims.length > 0 ? (
          <ul className={styles.claims}>
            {session.claims.map((c) => (
              <ClaimCard
                key={c.id}
                claim={c}
                busy={claim.pending || finalized}
                onDecide={(d) => claim.decide(c.id, d).catch(() => undefined)}
              />
            ))}
          </ul>
        ) : null}
        <TailorError error={claim.error} />
      </section>

      <section className={styles.section}>
        <Tabs<Tab>
          ariaLabel={t('tabs.label')}
          idBase={tabBase}
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'changes', label: t('tabs.changes', { count: session.changes.length }) },
            { id: 'compare', label: t('tabs.compare') },
          ]}
        />
        <div {...tabPanelProps(tabBase, 'changes')} hidden={tab !== 'changes'}>
          <ChangeList changes={session.changes} />
        </div>
        <div {...tabPanelProps(tabBase, 'compare')} hidden={tab !== 'compare'}>
          {tab === 'compare' ? <Compare baseId={session.baseVariantId} resultId={session.resultVariantId} /> : null}
        </div>
      </section>

      <div className={styles.footer}>
        {finalized ? (
          <>
            <p className={styles.success} role="status">
              {t('done')}
            </p>
            <div className={styles.actions}>
              {session.resultVariantId && onOpenResume ? (
                <Btn variant="primary" onClick={() => onOpenResume(session.resultVariantId!)}>
                  {t('open')}
                </Btn>
              ) : null}
              {onClose ? <Btn onClick={onClose}>{t('close')}</Btn> : null}
            </div>
          </>
        ) : (
          <>
            <p className={styles.sub} role="status" aria-live="polite">
              {pending > 0 ? t('pendingBlock', { count: pending }) : tv('allDone')}
            </p>
            <Btn
              variant="primary"
              disabled={pending > 0 || finalize.isPending || session.status !== 'review'}
              onClick={async () => {
                try {
                  const view = await finalize.mutateAsync();
                  onFinalized?.(view);
                } catch {
                  // shown below
                }
              }}
            >
              {finalize.isPending ? t('finalizing') : t('finalize')}
            </Btn>
          </>
        )}
      </div>
      <TailorError error={finalize.error} />
    </div>
  );
}

function ChangeList({ changes }: { changes: TailorChange[] }) {
  const t = useTranslations('tailor.result');
  if (changes.length === 0) return <p className={styles.sub}>{t('noChanges')}</p>;
  return (
    <ul className={styles.changes}>
      {changes.map((c, i) => {
        const kind = c.kind ?? (c.before && c.after ? 'rewrite' : c.after ? 'add' : 'remove');
        return (
          <li key={`${c.section}-${i}`} className={styles.change} data-kind={kind}>
            <div className={styles.row}>
              <span className={styles.changeKind}>{t(`change.${kind}`)}</span>
              <span className={styles.sub}>{c.section}</span>
            </div>
            {c.before ? (
              <p className={styles.before}>
                <span className="sr-only">{t('change.before')}: </span>
                {c.before}
              </p>
            ) : null}
            {c.after ? (
              <p className={styles.after}>
                <span className="sr-only">{t('change.after')}: </span>
                {c.after}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Compare({ baseId, resultId }: { baseId: string; resultId: string | null }) {
  const t = useTranslations('tailor.result.compare');
  const base = useResume(baseId);
  const result = useResume(resultId);
  if (base.isLoading || result.isLoading) {
    return (
      <p className={styles.sub} role="status">
        {t('loading')}
      </p>
    );
  }
  if (base.isError || result.isError || !base.data || !result.data) {
    return (
      <p className={styles.error} role="alert">
        {t('error')}
      </p>
    );
  }
  return (
    <div className={styles.compare}>
      <div>
        <p className={styles.label}>{t('before')}</p>
        <div className={styles.paper}>
          <Markdown block>{base.data.resumeMarkdown}</Markdown>
        </div>
      </div>
      <div>
        <p className={styles.label}>{t('after')}</p>
        <div className={styles.paper}>
          <Markdown block>{result.data.resumeMarkdown}</Markdown>
        </div>
      </div>
    </div>
  );
}
