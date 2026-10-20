// The /resume hub's derived state: the check state of a resume, the main
// resume, saved jobs without a tailored version, and the order of "Up next".

import { describe, expect, it } from 'vitest';

import type { GradeView, LatestGradeResponse } from '../../../../lib/api/contracts/resume';
import type { ResumeSummary } from '../../../../lib/api/resumes';
import { checkStateOf, mainResumeOf, nextSteps, sortBases, untailoredJobs, type CheckState } from './hubModel';

const row = (over: Partial<ResumeSummary>): ResumeSummary => ({
  id: 'r',
  name: 'Resume',
  kind: 'base',
  targetJobId: null,
  targetJobTitle: null,
  targetJobCompany: null,
  matchScoreCached: null,
  isPrimary: false,
  sourceKind: 'upload',
  lastEditedAt: '2026-10-01T00:00:00.000Z',
  createdAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const grade = (over: Partial<GradeView> = {}): GradeView => ({
  id: 'g1',
  resumeVariantId: 'b1',
  status: 'done',
  label: 'good',
  score: 78,
  counts: { urgent: 0, critical: 0, optional: 2 },
  issues: [],
  profile: 'intl',
  method: 'rules',
  aiSkipped: null,
  rulesChecked: 24,
  targetTitle: null,
  contentHash: 'h',
  createdAt: '2026-10-02T00:00:00.000Z',
  completedAt: '2026-10-02T00:00:30.000Z',
  ...over,
});

const latest = (g: GradeView | null, stale = false): LatestGradeResponse => ({ grade: g, previous: null, stale, aiAvailable: true });
const loaded = (data: LatestGradeResponse) => ({ data, isLoading: false, isError: false });

describe('checkStateOf', () => {
  it('says nothing while loading or after a failed read', () => {
    expect(checkStateOf({ isLoading: true, isError: false })).toEqual({ kind: 'loading' });
    expect(checkStateOf({ isLoading: false, isError: true })).toEqual({ kind: 'unknown' });
  });

  it('reads no check, a running one, a failed one and a finished one', () => {
    expect(checkStateOf(loaded(latest(null)))).toEqual({ kind: 'none' });
    expect(checkStateOf(loaded(latest(grade({ status: 'cancelled' }))))).toEqual({ kind: 'none' });
    expect(checkStateOf(loaded(latest(grade({ status: 'running' }))))).toEqual({ kind: 'running' });
    expect(checkStateOf(loaded(latest(grade({ status: 'failed' }))))).toEqual({ kind: 'failed' });
    expect(checkStateOf(loaded(latest(grade(), true)))).toEqual({
      kind: 'done',
      label: 'good',
      score: 78,
      counts: { urgent: 0, critical: 0, optional: 2 },
      stale: true,
      checkedAt: '2026-10-02T00:00:30.000Z',
    });
  });
});

describe('sortBases / mainResumeOf', () => {
  it('keeps base resumes only, the primary first, then the newest edit', () => {
    const list = [
      row({ id: 'old', lastEditedAt: '2026-09-01T00:00:00.000Z' }),
      row({ id: 'new', lastEditedAt: '2026-10-09T00:00:00.000Z', kind: 'from_template' }),
      row({ id: 'main', isPrimary: true, lastEditedAt: '2026-08-01T00:00:00.000Z' }),
      row({ id: 't', kind: 'tailored_for_jd' }),
    ];
    const bases = sortBases(list);
    expect(bases.map((r) => r.id)).toEqual(['main', 'new', 'old']);
    expect(mainResumeOf(bases)?.id).toBe('main');
  });

  it('falls back to the newest base when none is primary, and to null with none', () => {
    expect(mainResumeOf(sortBases([row({ id: 'a' }), row({ id: 'b', lastEditedAt: '2026-10-05T00:00:00.000Z' })]))?.id).toBe('b');
    expect(mainResumeOf([])).toBeNull();
  });
});

describe('untailoredJobs', () => {
  it('drops saved jobs that already have a tailored version', () => {
    const targets = [
      { jobId: 'j1', title: 'Engineer', company: 'Acme' },
      { jobId: 'j2', title: 'Analyst', company: null },
    ];
    const resumes = [row({ id: 't1', kind: 'tailored_for_jd', targetJobId: 'j1' }), row({ id: 'b', targetJobId: 'j2' })];
    // A base resume's targetJobId does not count as a tailored version.
    expect(untailoredJobs(targets, resumes).map((j) => j.jobId)).toEqual(['j2']);
  });
});

describe('nextSteps', () => {
  const main = row({ id: 'b1', name: 'Main', isPrimary: true });
  const done = (over: Partial<Extract<CheckState, { kind: 'done' }>> = {}): CheckState => ({
    kind: 'done',
    label: 'good',
    score: 78,
    counts: { urgent: 0, critical: 0, optional: 0 },
    stale: false,
    checkedAt: null,
    ...over,
  });

  it('puts details to verify first, then the main resume check', () => {
    const resumes = [
      main,
      row({ id: 't1', name: 'For Acme', kind: 'tailored_for_jd', unverifiedClaims: 3, tailorSessionId: 's1', lastEditedAt: '2026-10-03T00:00:00.000Z' }),
      row({ id: 't2', name: 'For Globex', kind: 'tailored_for_jd', unverifiedClaims: 0 }),
    ];
    const steps = nextSteps({ resumes, main: { resume: main, check: done({ counts: { urgent: 2, critical: 1, optional: 0 } }) } });
    expect(steps).toEqual([
      { kind: 'verify', resumeId: 't1', name: 'For Acme', count: 3, sessionId: 's1' },
      { kind: 'fix_urgent', resumeId: 'b1', name: 'Main', count: 2 },
    ]);
  });

  it('asks for a new check before fixing issues found before the last edit', () => {
    const steps = nextSteps({ resumes: [main], main: { resume: main, check: done({ stale: true, counts: { urgent: 4, critical: 0, optional: 0 } }) } });
    expect(steps).toEqual([{ kind: 'check_stale', resumeId: 'b1', name: 'Main' }]);
  });

  it('names a check that never ran, failed or is running, and important issues when nothing is urgent', () => {
    const at = (check: CheckState) => nextSteps({ resumes: [main], main: { resume: main, check } })[0]?.kind;
    expect(at({ kind: 'none' })).toBe('check_none');
    expect(at({ kind: 'failed' })).toBe('check_failed');
    expect(at({ kind: 'running' })).toBe('check_running');
    expect(at(done({ counts: { urgent: 0, critical: 2, optional: 5 } }))).toBe('fix_critical');
    // Only nice-to-have issues: nothing pending.
    expect(at(done({ counts: { urgent: 0, critical: 0, optional: 5 } }))).toBeUndefined();
    // No answer yet (or a failed read): no step rather than a guess.
    expect(at({ kind: 'loading' })).toBeUndefined();
    expect(at({ kind: 'unknown' })).toBeUndefined();
  });

  it('has nothing to say without a base resume', () => {
    expect(nextSteps({ resumes: [], main: null })).toEqual([]);
  });

  it('shows at most two versions to verify and caps the list', () => {
    const many = [1, 2, 3].map((n) => row({ id: `t${n}`, name: `V${n}`, kind: 'tailored_for_jd', unverifiedClaims: n, lastEditedAt: `2026-10-0${n}T00:00:00.000Z` }));
    const steps = nextSteps({ resumes: [main, ...many], main: { resume: main, check: { kind: 'none' } } });
    expect(steps.map((s) => s.kind)).toEqual(['verify', 'verify', 'check_none']);
    expect(steps.slice(0, 2).map((s) => (s.kind === 'verify' ? s.resumeId : ''))).toEqual(['t3', 't2']);
  });
});
