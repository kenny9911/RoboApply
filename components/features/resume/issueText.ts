// components/features/resume/issueText.ts — localized text for a resume-check
// issue (WP-22). The server stores a stable `type` plus ICU `params` and an
// English `why`/`how`; the web renders `resumeCheck.issue.<type>.*` and falls
// back to the stored English only for a type this build does not know.

import type { GradeIssue } from '../../../lib/api/contracts/resume';

/** Placeholder defaults so a missing param never throws inside ICU formatting. */
const PARAM_DEFAULTS: Record<string, string | number> = {
  opener: '',
  withNumbers: '—',
  total: '—',
  terms: '',
  count: '—',
  min: 5,
  word: '',
  suggestion: '',
  label: '',
  symbol: '',
  units: '—',
  max: '—',
  template: '',
};

export function issueParams(issue: Pick<GradeIssue, 'params'>): Record<string, string | number> {
  return { ...PARAM_DEFAULTS, ...(issue.params ?? {}) };
}

interface Translator {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
}

export interface IssueText {
  title: string;
  why: string;
  how: string;
}

/** `t` must be bound to the `resumeCheck` namespace. */
export function issueText(t: Translator, issue: GradeIssue): IssueText {
  const base = `issue.${issue.type}`;
  const values = issueParams(issue);
  if (!t.has(`${base}.title`)) {
    return { title: issue.why, why: issue.why, how: issue.how };
  }
  return { title: t(`${base}.title`, values), why: t(`${base}.why`, values), how: t(`${base}.how`, values) };
}

/** Short name of an issue type (the "fixed since last time" list), or null for an unknown type. */
export function issueTypeName(t: Translator, type: string): string | null {
  const key = `typeName.${type}`;
  return t.has(key) ? t(key) : null;
}
