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

export interface AnalyzerIssue {
  id: string;
  severity: AnalyzerSeverity;
  category: 'contact' | 'summary' | 'experience' | 'skills' | 'formatting';
  message: string;
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
  message: string,
  anchor?: string,
): AnalyzerIssue {
  return { id, severity, category, message, anchor };
}

export function analyzeResume(resume: StructuredResume): AnalyzerReport {
  const issues: AnalyzerIssue[] = [];

  // ── Contact ──────────────────────────────────────────────────────────
  if (!resume.contact.fullName.trim()) {
    issues.push(
      makeIssue(
        'contact.name',
        'critical',
        'contact',
        'Add your full name so recruiters know who this resume belongs to.',
        'section-contact',
      ),
    );
  }
  if (!resume.contact.email.trim()) {
    issues.push(
      makeIssue(
        'contact.email',
        'critical',
        'contact',
        'Add an email address — recruiters need a way to reach you.',
        'section-contact',
      ),
    );
  }
  if (!resume.contact.phone.trim()) {
    issues.push(
      makeIssue(
        'contact.phone',
        'recommended',
        'contact',
        'Adding a phone number doubles your callback rate for senior roles.',
        'section-contact',
      ),
    );
  }
  if (!resume.contact.location.trim()) {
    issues.push(
      makeIssue(
        'contact.location',
        'recommended',
        'contact',
        'Add your city — many ATS filters reject resumes without a location.',
        'section-contact',
      ),
    );
  }
  if (resume.contact.links.length === 0) {
    issues.push(
      makeIssue(
        'contact.links',
        'optional',
        'contact',
        'Add a LinkedIn URL or portfolio link to give recruiters somewhere to dig deeper.',
        'section-contact',
      ),
    );
  }

  // ── Target title ─────────────────────────────────────────────────────
  if (!resume.targetTitle.trim()) {
    issues.push(
      makeIssue(
        'title.missing',
        'recommended',
        'contact',
        'Add a target job title so the rest of your resume tells one consistent story.',
        'section-target',
      ),
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────
  const summary = resume.summary.trim();
  if (!summary) {
    issues.push(
      makeIssue(
        'summary.missing',
        'critical',
        'summary',
        'Write a 2-3 sentence summary. This is the first thing a recruiter reads.',
        'section-summary',
      ),
    );
  } else {
    const words = summary.split(/\s+/).filter(Boolean).length;
    if (words < 25) {
      issues.push(
        makeIssue(
          'summary.short',
          'recommended',
          'summary',
          `Your summary is ${words} words. Aim for 40-60 — long enough to land your pitch, short enough to skim.`,
          'section-summary',
        ),
      );
    } else if (words > 90) {
      issues.push(
        makeIssue(
          'summary.long',
          'optional',
          'summary',
          `Your summary is ${words} words. Tighten it to 60 or less — recruiters spend ~7 seconds on the top of a resume.`,
          'section-summary',
        ),
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
        'Add at least one work experience entry. This is the spine of your resume.',
        'section-experience',
      ),
    );
  } else {
    resume.experiences.forEach((exp, idx) => {
      const where = exp.company || exp.title || `Experience #${idx + 1}`;
      if (!exp.company.trim() || !exp.title.trim()) {
        issues.push(
          makeIssue(
            `exp.${exp.id}.head`,
            'critical',
            'experience',
            `${where}: fill in both the company and the role title.`,
            `exp-${exp.id}`,
          ),
        );
      }
      if (!exp.startDate.trim()) {
        issues.push(
          makeIssue(
            `exp.${exp.id}.dates`,
            'recommended',
            'experience',
            `${where}: add start and end dates — gaps without dates raise flags.`,
            `exp-${exp.id}`,
          ),
        );
      }
      if (exp.bullets.length === 0 || exp.bullets.every((b) => !b.trim())) {
        issues.push(
          makeIssue(
            `exp.${exp.id}.bullets.missing`,
            'critical',
            'experience',
            `${where}: add at least 2-3 bullet points showing what you actually did.`,
            `exp-${exp.id}`,
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
              `${where}: none of your bullets contain a number. Quantified outcomes (38% latency cut, 8M weekly users) hit harder.`,
              `exp-${exp.id}`,
            ),
          );
        }
        if (weakStartCount > 0 && exp.bullets.length > 0) {
          issues.push(
            makeIssue(
              `exp.${exp.id}.bullets.weak_start`,
              'recommended',
              'experience',
              `${where}: ${weakStartCount} bullet${weakStartCount === 1 ? '' : 's'} start${weakStartCount === 1 ? 's' : ''} with a passive or weak verb. Try "Led", "Shipped", "Reduced".`,
              `exp-${exp.id}`,
            ),
          );
        }
        if (overlongCount > 0) {
          issues.push(
            makeIssue(
              `exp.${exp.id}.bullets.long`,
              'optional',
              'experience',
              `${where}: ${overlongCount} bullet${overlongCount === 1 ? '' : 's'} run${overlongCount === 1 ? 's' : ''} past 32 words. Aim for 1-2 lines per bullet.`,
              `exp-${exp.id}`,
            ),
          );
        }
      }
    });
  }

  // ── Skills ───────────────────────────────────────────────────────────
  if (resume.skills.length < 5) {
    issues.push(
      makeIssue(
        'skills.few',
        'recommended',
        'skills',
        `You list ${resume.skills.length} skill${resume.skills.length === 1 ? '' : 's'}. Most ATS systems weight 8-15 keywords — add more from the JD you're targeting.`,
        'section-skills',
      ),
    );
  }
  if (resume.skills.length > 25) {
    issues.push(
      makeIssue(
        'skills.many',
        'optional',
        'skills',
        `${resume.skills.length} skills is a lot — recruiters skim. Trim to the 12-15 strongest for the role.`,
        'section-skills',
      ),
    );
  }

  // ── Formatting / overall length ──────────────────────────────────────
  if (resume.experiences.length > 0 && resume.education.length === 0) {
    issues.push(
      makeIssue(
        'edu.missing',
        'optional',
        'formatting',
        'No education entries. If you graduated, list it — it costs nothing and many filters require it.',
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
