// lib/resumeAnalyzer.ts
//
// Heuristic resume analyzer. Same shape Teal's Analyzer tab uses — a count
// of "issues" (the orange "Analyzer 11" badge) split by severity, plus
// rule-level detail. Pure / synchronous so we can re-score on every keystroke
// without a network round-trip.
//
// When the real backend lands, swap this for an LLM-backed scorer — the
// `AnalyzerReport` shape stays the same so the panel doesn't change.

import type { StructuredResume } from './resumeStructure';

export type AnalyzerSeverity = 'critical' | 'recommended' | 'optional';

/**
 * Every message this module can emit, as an i18n key under
 * `resume.analyzer.issue` in i18n/messages/*.json. The analyzer never builds a
 * user-facing sentence itself: it is imported by a client component that runs
 * in nine locales, and a hardcoded English string here shipped English issue
 * text into an otherwise fully translated editor. Rendering happens in
 * components/v3/resume-editor/AnalyzerPanel.tsx.
 *
 * Keep this list in sync with the bundles — __tests__/utils/resumeAnalyzer.i18n.test.ts
 * resolves every key here against all nine bundles, because next-intl renders a
 * missing key as its own dotted path instead of throwing.
 */
export const ANALYZER_MESSAGE_KEYS = [
  'contact_name',
  'contact_email',
  'contact_phone',
  'contact_location',
  'contact_links',
  'title_missing',
  'summary_missing',
  'summary_short',
  'summary_long',
  'experience_missing',
  'experience_head',
  'experience_dates',
  'experience_bullets_missing',
  'experience_bullets_quantify',
  'experience_bullets_weak_start',
  'experience_bullets_long',
  'skills_few',
  'skills_many',
  'education_missing',
] as const;

export type AnalyzerMessageKey = (typeof ANALYZER_MESSAGE_KEYS)[number];

/** ICU values for an issue's message. */
export interface AnalyzerMessageValues {
  /** Company (or role title) of the entry an issue points at. Empty when the
   *  entry has neither yet — the panel labels it by position instead. */
  where?: string;
  /** 1-based position of that entry, backing the `where` fallback label. */
  entry?: number;
  /** Plural-driving count: bullets, skills. */
  count?: number;
  /** Word count, for the summary-length rules. */
  words?: number;
}

export interface AnalyzerIssue {
  id: string;
  severity: AnalyzerSeverity;
  category: 'contact' | 'summary' | 'experience' | 'skills' | 'formatting';
  messageKey: AnalyzerMessageKey;
  messageValues?: AnalyzerMessageValues;
  /** Optional anchor for click-to-fix navigation in the editor. */
  anchor?: string;
}

export interface AnalyzerReport {
  /** 0..100. 100 = perfect. */
  score: number;
  issues: AnalyzerIssue[];
  counts: {
    critical: number;
    recommended: number;
    optional: number;
    total: number;
  };
}

const ACTION_VERBS = new Set([
  'led',
  'built',
  'shipped',
  'designed',
  'launched',
  'owned',
  'drove',
  'reduced',
  'increased',
  'improved',
  'managed',
  'mentored',
  'migrated',
  'optimized',
  'architected',
  'developed',
  'implemented',
  'created',
  'delivered',
  'scaled',
  'spearheaded',
  'cut',
  'grew',
  'launched',
  'introduced',
  'rolled',
  'standardized',
  'rewrote',
  'refactored',
  'partnered',
  'collaborated',
]);

const QUANTIFIER_RE = /\b\d+(\.\d+)?\s*(%|x|k|m|b|million|billion|users|customers|years|hours|days|requests|seconds|ms|sec)?\b/i;

function bulletStarts(line: string): string {
  const first = line.trim().split(/\s+/)[0] ?? '';
  return first
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

function makeIssue(
  id: string,
  severity: AnalyzerSeverity,
  category: AnalyzerIssue['category'],
  messageKey: AnalyzerMessageKey,
  anchor?: string,
  messageValues?: AnalyzerMessageValues,
): AnalyzerIssue {
  return { id, severity, category, messageKey, messageValues, anchor };
}

export function analyzeResume(resume: StructuredResume): AnalyzerReport {
  const issues: AnalyzerIssue[] = [];

  // ── Contact ──────────────────────────────────────────────────────────
  if (!resume.contact.fullName.trim()) {
    issues.push(
      makeIssue('contact.name', 'critical', 'contact', 'contact_name', 'section-contact'),
    );
  }
  if (!resume.contact.email.trim()) {
    issues.push(
      makeIssue('contact.email', 'critical', 'contact', 'contact_email', 'section-contact'),
    );
  }
  if (!resume.contact.phone.trim()) {
    issues.push(
      makeIssue('contact.phone', 'recommended', 'contact', 'contact_phone', 'section-contact'),
    );
  }
  if (!resume.contact.location.trim()) {
    issues.push(
      makeIssue(
        'contact.location',
        'recommended',
        'contact',
        'contact_location',
        'section-contact',
      ),
    );
  }
  if (resume.contact.links.length === 0) {
    issues.push(
      makeIssue('contact.links', 'optional', 'contact', 'contact_links', 'section-contact'),
    );
  }

  // ── Target title ─────────────────────────────────────────────────────
  if (!resume.targetTitle.trim()) {
    issues.push(
      makeIssue('title.missing', 'recommended', 'contact', 'title_missing', 'section-target'),
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────
  const summary = resume.summary.trim();
  if (!summary) {
    issues.push(
      makeIssue('summary.missing', 'critical', 'summary', 'summary_missing', 'section-summary'),
    );
  } else {
    const words = summary.split(/\s+/).filter(Boolean).length;
    if (words < 25) {
      issues.push(
        makeIssue(
          'summary.short',
          'recommended',
          'summary',
          'summary_short',
          'section-summary',
          { words },
        ),
      );
    } else if (words > 90) {
      issues.push(
        makeIssue('summary.long', 'optional', 'summary', 'summary_long', 'section-summary', {
          words,
        }),
      );
    }
  }

  // ── Experience ───────────────────────────────────────────────────────
  if (resume.experiences.length === 0) {
    issues.push(
      makeIssue(
        'exp.missing',
        'critical',
        'experience',
        'experience_missing',
        'section-experience',
      ),
    );
  } else {
    resume.experiences.forEach((exp, idx) => {
      // An entry with neither a company nor a title has no name to show yet;
      // the panel falls back to labelling it by position, in the user's locale.
      const where = exp.company || exp.title || '';
      const entry = idx + 1;
      if (!exp.company.trim() || !exp.title.trim()) {
        issues.push(
          makeIssue(
            `exp.${exp.id}.head`,
            'critical',
            'experience',
            'experience_head',
            `exp-${exp.id}`,
            { where, entry },
          ),
        );
      }
      if (!exp.startDate.trim()) {
        issues.push(
          makeIssue(
            `exp.${exp.id}.dates`,
            'recommended',
            'experience',
            'experience_dates',
            `exp-${exp.id}`,
            { where, entry },
          ),
        );
      }
      if (exp.bullets.length === 0 || exp.bullets.every((b) => !b.trim())) {
        issues.push(
          makeIssue(
            `exp.${exp.id}.bullets.missing`,
            'critical',
            'experience',
            'experience_bullets_missing',
            `exp-${exp.id}`,
            { where, entry },
          ),
        );
      } else {
        let hasQuantifier = false;
        const startWords = new Set<string>();
        let weakStartCount = 0;
        let overlongCount = 0;
        for (const b of exp.bullets) {
          if (!b.trim()) continue;
          if (QUANTIFIER_RE.test(b)) hasQuantifier = true;
          const start = bulletStarts(b);
          startWords.add(start);
          if (!ACTION_VERBS.has(start)) weakStartCount++;
          if (b.split(/\s+/).length > 32) overlongCount++;
        }
        if (!hasQuantifier) {
          issues.push(
            makeIssue(
              `exp.${exp.id}.bullets.quantify`,
              'recommended',
              'experience',
              'experience_bullets_quantify',
              `exp-${exp.id}`,
              { where, entry },
            ),
          );
        }
        if (weakStartCount > 0 && exp.bullets.length > 0) {
          issues.push(
            makeIssue(
              `exp.${exp.id}.bullets.weak_start`,
              'recommended',
              'experience',
              'experience_bullets_weak_start',
              `exp-${exp.id}`,
              { where, entry, count: weakStartCount },
            ),
          );
        }
        if (overlongCount > 0) {
          issues.push(
            makeIssue(
              `exp.${exp.id}.bullets.long`,
              'optional',
              'experience',
              'experience_bullets_long',
              `exp-${exp.id}`,
              { where, entry, count: overlongCount },
            ),
          );
        }
      }
    });
  }

  // ── Skills ───────────────────────────────────────────────────────────
  if (resume.skills.length < 5) {
    issues.push(
      makeIssue('skills.few', 'recommended', 'skills', 'skills_few', 'section-skills', {
        count: resume.skills.length,
      }),
    );
  }
  if (resume.skills.length > 25) {
    issues.push(
      makeIssue('skills.many', 'optional', 'skills', 'skills_many', 'section-skills', {
        count: resume.skills.length,
      }),
    );
  }

  // ── Formatting / overall length ──────────────────────────────────────
  if (resume.experiences.length > 0 && resume.education.length === 0) {
    issues.push(
      makeIssue(
        'edu.missing',
        'optional',
        'formatting',
        'education_missing',
        'section-education',
      ),
    );
  }

  // Build counts + score.
  const counts = {
    critical: issues.filter((i) => i.severity === 'critical').length,
    recommended: issues.filter((i) => i.severity === 'recommended').length,
    optional: issues.filter((i) => i.severity === 'optional').length,
    total: issues.length,
  };
  const penalty =
    counts.critical * 12 + counts.recommended * 5 + counts.optional * 2;
  const score = Math.max(0, Math.min(100, 100 - penalty));

  return { score, issues, counts };
}
