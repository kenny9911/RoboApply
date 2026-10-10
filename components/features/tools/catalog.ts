// components/features/tools/catalog.ts — the free tools and their pages (WP-57;
// PRODUCT_PLAN.md F-TOOL-01). Only tools that actually work are listed: no
// lander-only "tools", no /tools/cover-letter. /tools/job-alerts is WP-78's.

import type { ToolKind } from '../../../lib/api/contracts/tools';

export interface ToolEntry {
  kind: ToolKind;
  /** `/tools/<slug>` */
  slug: 'resume-check' | 'resume-job-match';
  /** `tools.hub.<key>.*` and `tools.meta.<key>.*` */
  key: 'resumeCheck' | 'resumeJobMatch';
  /** `from=` on signup links (lib/auth/entry.ts knows `resume-check`). */
  from: string;
}

export const TOOLS: readonly ToolEntry[] = [
  { kind: 'resume_check', slug: 'resume-check', key: 'resumeCheck', from: 'resume-check' },
  { kind: 'resume_job_match', slug: 'resume-job-match', key: 'resumeJobMatch', from: 'resume-job-match' },
];

export function toolBySlug(slug: string | null | undefined): ToolEntry | null {
  return TOOLS.find((t) => t.slug === slug) ?? null;
}

export function toolByKind(kind: ToolKind): ToolEntry {
  return TOOLS.find((t) => t.kind === kind)!;
}

/** `/tools/<slug>`. A result id is never put in a URL (it stays in this tab's sessionStorage). */
export function toolHref(entry: Pick<ToolEntry, 'slug'>): string {
  return `/tools/${entry.slug}`;
}

/** Client fallbacks when GET /config has not answered (the server enforces the real values). */
export const CLIENT_LIMITS = {
  perIpPerDay: 3,
  maxFileBytes: 15 * 1024 * 1024,
  acceptedExtensions: ['.pdf', '.doc', '.docx', '.txt'],
  cacheHours: 24,
  postingMinChars: 50,
  postingMaxChars: 60_000,
} as const;

/**
 * GoApply's processing-notice version, for when GET /config has not answered
 * (runtime mirror of TOOLS_CONSENT_VERSION in server/src/features/tools/contract.ts;
 * a test keeps them equal).
 */
export const CLIENT_CONSENT_VERSION = 'tools-processing.2026-10-10.v2';

/**
 * Signup / sign-in link that carries the tool context: `from` (brand panel
 * copy) and `next` (back to the tool page). The result id is NOT in the link
 * (URLs end up in history, shared links and analytics): the click remembers
 * it in this tab's sessionStorage (./pendingResult.ts), and the tool page and
 * ToolResultClaimHost pick it up from there. It only works together with the
 * visitor cookie of the browser that ran the check.
 */
export function signupHref(entry: ToolEntry, mode: 'signup' | 'login' = 'signup'): string {
  const q = new URLSearchParams({ from: entry.from, next: toolHref(entry) });
  return `/${mode}?${q.toString()}`;
}
