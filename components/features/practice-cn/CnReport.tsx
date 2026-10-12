'use client';

// CnReport — the GoApply AI面试 practice report blocks: communication / logic /
// behaviour areas, STAR completeness and filler-word counts (TASK_PLAN.md
// WP-66; F-INT-06). WP-43's report page renders it on GoApply only
// (brand.market === 'cn'), after the shared report.
//
// It loads the session's report (the same read the page makes) and shows the
// block the server stored, or builds it here from the transcript with the
// client mirror of the rubric (fromSession.ts). While the AI review is still
// being written it re-reads now and then, so the areas switch from the quick
// text checks to the review when it lands. A failed read renders nothing: the
// shared report above still works. AI output in it carries AiGeneratedBadge
// (CnReportView).

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { interviewEngineApi } from '../../../lib/api/interviewEngine';
import { CnReportView } from './CnReportView';
import { cnReportFromEngine, reviewPending } from './fromSession';
import type { CnPracticeReport } from './rubric';
import styles from './practiceCn.module.css';

export interface CnReportProps {
  /** The practice session the report belongs to. */
  sessionId: string;
}

/** Re-read cadence while the review is pending, and the cap (about 3 minutes). */
export const CN_REPORT_POLL_MS = 15_000;
export const CN_REPORT_MAX_POLLS = 12;

type State = { kind: 'loading' } | { kind: 'ready'; report: CnPracticeReport } | { kind: 'failed' };

export function CnReport({ sessionId }: CnReportProps) {
  const t = useTranslations('practiceCn.report');
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;

    const load = async () => {
      try {
        const res = await interviewEngineApi.report(sessionId);
        if (cancelled) return;
        setState({ kind: 'ready', report: cnReportFromEngine(res) });
        if (reviewPending(res) && polls < CN_REPORT_MAX_POLLS) {
          polls += 1;
          timer = setTimeout(() => void load(), CN_REPORT_POLL_MS);
        }
      } catch {
        // Keep what is on screen; with nothing yet, render nothing.
        if (!cancelled) setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'failed' }));
      }
    };

    setState({ kind: 'loading' });
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  if (state.kind === 'failed') return null;
  if (state.kind === 'loading') {
    return (
      <p className={styles.text} role="status" data-testid="cn-report-loading">
        {t('loading')}
      </p>
    );
  }
  return <CnReportView report={state.report} />;
}

export default CnReport;
