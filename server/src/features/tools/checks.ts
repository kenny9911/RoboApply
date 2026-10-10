// server/src/features/tools/checks.ts
//
// The two deterministic checks behind the free tools, run through WP-22's
// public surface (`ResumeCheckService` from features/resume/index.ts) over a
// one-resume, in-process store: nothing is written to RAResumeGrade, no
// credit is touched and no model runs (`aiAvailable` is always false, so the
// AI pass never starts — the tool is an automated checklist).

import crypto from 'node:crypto';
import { ResumeCheckService, type ResumeCheckStore } from '../resume/index.js';
import type { GradeCounts, GradeIssue, GradeLabel, GradeProfile, KeywordReportResponse } from '../resume/contract.js';

type GradeRow = Awaited<ReturnType<ResumeCheckStore['createGrade']>>;
type VariantRow = NonNullable<Awaited<ReturnType<ResumeCheckStore['findVariant']>>>;

const TOOL_USER = 'tool:anonymous';
const TOOL_VARIANT = 'tool:variant';

function unsupported(what: string): never {
  throw new Error(`tools: ${what} is not available on the anonymous check`);
}

/** A ResumeCheckStore that holds exactly one resume and the grade rows of this call. */
function oneResumeStore(markdown: string, now: () => Date): ResumeCheckStore {
  const variant: VariantRow = {
    id: TOOL_VARIANT,
    userId: TOOL_USER,
    resumeMarkdown: markdown,
    resumeContentHash: 'sha256:' + crypto.createHash('sha256').update(markdown).digest('hex').slice(0, 32),
    layout: null,
  };
  const grades: GradeRow[] = [];
  return {
    async findVariant(userId, variantId) {
      return userId === TOOL_USER && variantId === TOOL_VARIANT ? variant : null;
    },
    async createGrade(input) {
      const row: GradeRow = {
        id: `tool_grade_${grades.length + 1}`,
        userId: input.userId,
        variantId: input.variantId,
        contentHash: input.contentHash,
        targetTitle: input.targetTitle,
        status: 'running',
        grade: null,
        score: null,
        counts: null,
        issues: null,
        model: null,
        creditLedgerId: input.creditLedgerId,
        createdAt: now(),
        completedAt: null,
      };
      grades.push(row);
      return { ...row };
    },
    async updateGrade(gradeId, data) {
      const row = grades.find((g) => g.id === gradeId) ?? unsupported('updateGrade');
      Object.assign(row, data);
      return { ...row };
    },
    async completeRunningGrade(gradeId, data) {
      const row = grades.find((g) => g.id === gradeId && g.status === 'running');
      if (!row) return null;
      Object.assign(row, data);
      return { ...row };
    },
    async cancelRunningGrade() {
      return null;
    },
    async findGrade(_userId, gradeId) {
      const row = grades.find((g) => g.id === gradeId);
      return row ? { ...row } : null;
    },
    async listGrades() {
      return grades.slice().reverse();
    },
    async findJob() {
      return null;
    },
    async findKeywordExtraction() {
      return null;
    },
    async findFitRow() {
      return null;
    },
    async saveMarkdown() {
      return unsupported('saveMarkdown');
    },
    async withGrantClaim() {
      return unsupported('withGrantClaim');
    },
  };
}

function serviceFor(markdown: string, profile: GradeProfile, now: () => Date): ResumeCheckService {
  const noCredits = () => unsupported('credits');
  return new ResumeCheckService({
    store: oneResumeStore(markdown, now),
    credits: { reserve: noCredits, commit: noCredits, release: noCredits, withCredit: noCredits, grant: noCredits },
    aiAvailable: async () => false,
    profile: () => profile,
    market: () => (profile === 'cn' ? 'cn' : 'intl'),
    runAiPass: async () => unsupported('runAiPass'),
    rewrite: async () => unsupported('rewrite'),
    logAiLabel: async () => undefined,
    now,
  });
}

export interface ChecklistResult {
  label: GradeLabel;
  counts: GradeCounts;
  issues: GradeIssue[];
  rulesChecked: number | null;
  profile: GradeProfile;
}

const SEVERITY_ORDER: Record<string, number> = { urgent: 0, critical: 1, optional: 2 };

/** Most severe first; stable inside a severity (the rules' own order). */
export function bySeverity<T extends { severity: string }>(issues: readonly T[]): T[] {
  return issues
    .map((issue, i) => ({ issue, i }))
    .sort((a, b) => (SEVERITY_ORDER[a.issue.severity] ?? 9) - (SEVERITY_ORDER[b.issue.severity] ?? 9) || a.i - b.i)
    .map((x) => x.issue);
}

/** The rules-only resume check over `markdown`. */
export async function runChecklist(markdown: string, profile: GradeProfile, now: () => Date = () => new Date()): Promise<ChecklistResult> {
  const service = serviceFor(markdown, profile, now);
  const { grade } = await service.grade(TOOL_USER, TOOL_VARIANT);
  if (!grade || grade.status !== 'done' || !grade.label || !grade.counts) throw new Error('tools: the checklist did not finish');
  return {
    label: grade.label,
    counts: grade.counts,
    issues: bySeverity(grade.issues),
    rulesChecked: grade.rulesChecked,
    profile: grade.profile,
  };
}

/** The deterministic requirement rows for (resume, pasted posting). */
export async function runRequirementRows(
  markdown: string,
  posting: { title: string; text: string },
  profile: GradeProfile,
  now: () => Date = () => new Date(),
): Promise<KeywordReportResponse> {
  const service = serviceFor(markdown, profile, now);
  return service.keywordReport(TOOL_USER, TOOL_VARIANT, { jd: { title: posting.title, company: '', text: posting.text } });
}
