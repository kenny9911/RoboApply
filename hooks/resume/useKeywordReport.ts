'use client';

// hooks/resume/useKeywordReport.ts — the keyword check for one resume and one
// posting (WP-22; F-RES-08). Deterministic and free on the server, so it is a
// cached query. Job detail (WP-34) and tailoring (WP-36a) render it through
// components/features/resume `KeywordReport`.
//
// The posting is a job id, a pasted posting (tailoring from the editor), or a
// tailor session (its own job or pasted posting, read on the server).

import { useQuery } from '@tanstack/react-query';

import { getKeywordReport } from '../../lib/api/resumes';
import type { KeywordReportResponse } from '../../lib/api/contracts/resume';

export interface PastedPosting {
  title: string;
  company: string;
  text: string;
}

export type KeywordTarget =
  | { jobId: string }
  | { jd: PastedPosting }
  | {
      tailorSessionId: string;
      /** Changes when the checked text changes (claims decided), so the report is read again. */
      version?: string;
    };

/** The server only reads a pasted posting of 50+ characters with a title. */
export const MIN_POSTING_CHARS = 50;

function keyOf(target: KeywordTarget): string {
  if ('jobId' in target) return `job:${target.jobId}`;
  if ('tailorSessionId' in target) return `session:${target.tailorSessionId}:${target.version ?? ''}`;
  const { title, company, text } = target.jd;
  return `jd:${title}|${company}|${text.length}|${text.slice(0, 80)}|${text.slice(-40)}`;
}

function usable(target: KeywordTarget | null): target is KeywordTarget {
  if (!target) return false;
  if ('jd' in target) return target.jd.title.trim().length > 0 && target.jd.text.trim().length >= MIN_POSTING_CHARS;
  return true;
}

export const keywordReportKeys = {
  forJob: (resumeId: string, jobId: string) => ['resume-check', 'keywords', resumeId, `job:${jobId}`] as const,
  forTarget: (resumeId: string, target: KeywordTarget) => ['resume-check', 'keywords', resumeId, keyOf(target)] as const,
};

export function useKeywordReport(resumeId: string | null | undefined, posting: string | KeywordTarget | null | undefined) {
  const target: KeywordTarget | null = typeof posting === 'string' ? (posting ? { jobId: posting } : null) : (posting ?? null);
  const enabled = Boolean(resumeId) && usable(target);
  return useQuery<KeywordReportResponse>({
    queryKey: enabled ? keywordReportKeys.forTarget(resumeId as string, target as KeywordTarget) : ['resume-check', 'keywords', 'none'],
    queryFn: ({ signal }) => {
      const t = target as KeywordTarget;
      const body =
        'jobId' in t
          ? { jobId: t.jobId }
          : 'tailorSessionId' in t
            ? { tailorSessionId: t.tailorSessionId }
            : { jd: { title: t.jd.title.trim(), company: t.jd.company.trim(), text: t.jd.text.trim() } };
      return getKeywordReport(resumeId as string, body, { signal });
    },
    enabled,
    staleTime: 5 * 60_000,
  });
}
