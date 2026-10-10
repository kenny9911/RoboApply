// server/src/features/onboarding/testkit.ts — in-memory doubles for the onboarding tests (WP-30).
// No vitest imports: this file compiles with the server. Fictional data only.

import type { FilterSetPatch } from '../search/index.js';
import type { PreScoreResult } from '../match/index.js';
import type { OnboardingAnswers } from './contract.js';
import type { CandidateQuery, OnboardingPatch, OnboardingRecord, OnboardingRepo, ResumeVariantRow } from './repo.js';
import type { OnboardingDeps } from './service.js';

export interface MemoryRow extends OnboardingRecord {
  acquisitionSource?: string | null;
  acquisitionNote?: string | null;
  seekerType?: string | null;
  careerGoal?: string | null;
}

export function createMemoryRepo(seed: Record<string, Partial<MemoryRow>> = {}) {
  const rows = new Map<string, MemoryRow>();
  for (const [id, r] of Object.entries(seed)) {
    rows.set(id, { step: 'account', path: null, answers: {}, entry: null, startedAt: null, completedAt: null, ...r });
  }
  const resumes = new Map<string, ResumeVariantRow & { userId: string }>();
  let candidates: string[] = [];
  const candidateQueries: CandidateQuery[] = [];
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const repo: OnboardingRepo = {
    async read(userId) {
      const r = rows.get(userId);
      return r ? { ...r, answers: clone(r.answers) as OnboardingAnswers } : null;
    },
    async mutate(userId, fn) {
      const r = rows.get(userId);
      if (!r) {
        const { OnboardingProfileMissingError } = await import('./repo.js');
        throw new OnboardingProfileMissingError();
      }
      const { patch, result } = fn({ ...r, answers: clone(r.answers) as OnboardingAnswers });
      if (patch) apply(r, patch);
      return result;
    },
    async setProfileFields(userId, data) {
      const r = rows.get(userId)!;
      if (data.seekerType !== undefined) r.seekerType = data.seekerType;
      if (data.careerGoal !== undefined) r.careerGoal = data.careerGoal;
    },
    async getResume(userId, variantId) {
      const r = resumes.get(variantId);
      return r && r.userId === userId ? { id: r.id, parsedData: r.parsedData, resumeMarkdown: r.resumeMarkdown } : null;
    },
    async findCandidates(q) {
      candidateQueries.push(q);
      return candidates.slice(0, q.limit);
    },
  };
  function apply(r: MemoryRow, p: OnboardingPatch) {
    if (p.step !== undefined) r.step = p.step;
    if (p.path !== undefined) r.path = p.path;
    if (p.answers !== undefined) r.answers = clone(p.answers);
    if (p.startedAt !== undefined) r.startedAt = p.startedAt;
    if (p.completedAt !== undefined) r.completedAt = p.completedAt;
    if (p.acquisitionSource !== undefined) r.acquisitionSource = p.acquisitionSource;
    if (p.acquisitionNote !== undefined) r.acquisitionNote = p.acquisitionNote;
  }
  return {
    repo,
    rows,
    candidateQueries,
    addResume(userId: string, row: ResumeVariantRow) {
      resumes.set(row.id, { ...row, userId });
    },
    setCandidates(ids: string[]) {
      candidates = ids;
    },
  };
}

/** A fake default search profile that records every patch (values replace; null clears). */
export function createMemorySearchProfiles() {
  const state = { id: 'sp_default', version: 1, filters: {} as Record<string, unknown>, alertDigest: null as 'daily' | 'weekly' | null, patches: [] as FilterSetPatch[] };
  const api: OnboardingDeps['searchProfiles'] = {
    async getDefault() {
      return { id: state.id, version: state.version };
    },
    async update(_userId, id, input) {
      if (id !== state.id) throw new Error('unknown profile');
      if (input.version !== state.version) throw Object.assign(new Error('version'), { code: 'version_conflict' });
      if (input.filtersPatch) {
        state.patches.push(input.filtersPatch);
        for (const [k, v] of Object.entries(input.filtersPatch)) {
          if (v === null) delete state.filters[k];
          else if (v !== undefined) state.filters[k] = v;
        }
      }
      if (input.alertDigest !== undefined) state.alertDigest = input.alertDigest;
      state.version += 1;
      return { id: state.id, version: state.version };
    },
  };
  return { api, state };
}

export function preScoreFixture(jobId: string, score: number | null, tier: PreScoreResult['tier']): PreScoreResult {
  return { jobId, score, tier, kind: 'pre', dimensions: [], topOverlap: null, topGap: null };
}

export const SAMPLE_BASICS = {
  jobFunctions: [{ taxonomyId: 'backend_engineer', label: 'Backend engineer' }],
  jobTypes: ['full_time'],
  countries: ['US'],
  remoteOk: true,
} as const;
