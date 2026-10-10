// server/src/features/agent/__tests__/testkit.ts — shared fakes for the
// Ready to apply tests (WP-52). Not a test file itself and not imported by
// production code: an in-memory database (fakePrisma) and every seam as a
// recording fake. No network, no database, no model.

import { getBrand, type BrandId } from '../../../platform/brand/registry.js';
import { createFakePrisma } from '../../../test/fakePrisma.js';
import type { FeedItem } from '../../feed/index.js';
import type { TailorSessionView } from '../../resume/index.js';
import type { AgentDeps, CreditUsageLine, PreparePayload } from '../deps.js';
import { createAgentService } from '../service.js';
import type { AgentDb } from '../store.js';

export const NOW = new Date('2026-10-12T08:00:00Z'); // Monday

export function makeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  return createFakePrisma({
    timestampFields: ['createdAt', 'updatedAt'],
    defaults: {
      rAAgentSettings: { setupStep: 'profile', calibration: [], setupCompletedAt: null },
      rAAgentQueueItem: {
        trackerEntryId: null,
        resumeVariantId: null,
        coverLetterId: null,
        tailorSessionId: null,
        missingFields: null,
        lastError: null,
        openedAt: null,
        completedAt: null,
        userMarkedSubmitted: false,
        state: 'picked',
      },
      rAAgentKitEvent: { fromState: null, detail: null },
      rAAnswerBankItem: { lastUsedAt: null },
    },
    seed: {
      user: [{ id: 'u1', brand: 'roboapply' }],
      seekerProfile: [{ id: 'sp1', userId: 'u1', timezone: 'America/New_York' }],
      rAResumeVariant: [{ id: 'rv_base', userId: 'u1', kind: 'base', isPrimary: true, lastEditedAt: new Date('2026-10-01T00:00:00Z') }],
      rAJob: [job('j1'), job('j2', { descriptionPlain: 'Please include a cover letter.' }), job('j3'), job('j4'), job('j5'), job('j6')],
      ...seed,
    },
  });
}

export function job(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Role ${id}`,
    companyName: `Company ${id}`,
    location: 'Remote',
    applyUrl: `https://jobs.example.test/${id}`,
    market: 'intl',
    visibility: 'public',
    ownerUserId: null,
    closedAt: null,
    archivedAt: null,
    descriptionPlain: 'We build things.',
    qualifications: null,
    ...extra,
  };
}

export function feedItem(jobId: string, tier: 'great' | 'good' | 'possible' | 'unlikely' | null, tracker: string | null = null): FeedItem {
  return {
    jobId,
    title: `Role ${jobId}`,
    company: { id: null, name: `Company ${jobId}`, logoUrl: null },
    location: null,
    workModel: null,
    employmentType: null,
    seniority: null,
    pay: null,
    postedAt: null,
    lastSeenAt: null,
    source: { name: 'test', kind: 'provider' },
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: false,
    badges: [],
    fit: tier ? { tier, score: tier === 'great' ? 85 : tier === 'good' ? 70 : tier === 'possible' ? 50 : 30, kind: 'ai', topGap: null, topOverlap: null } : null,
    tracker: tracker ? { status: tracker } : null,
  };
}

export function session(id: string, extra: Partial<TailorSessionView> = {}): TailorSessionView {
  return {
    id,
    status: 'review',
    baseVariantId: 'rv_base',
    jobId: 'j1',
    scoreBefore: null,
    scoreAfter: null,
    changes: [],
    claims: [],
    resultVariantId: `rv_${id}`,
    mode: 'fast',
    sections: [],
    experienceDepth: null,
    target: { title: null, company: null },
    pendingClaims: 0,
    fit: { before: null, after: null },
    aiWritten: true,
    failure: null,
    createdAt: NOW.toISOString(),
    ...extra,
  } as TailorSessionView;
}

export function usageLine(remaining: number, window: 'day' | 'week' = 'day'): CreditUsageLine {
  return { remaining, window, resetsAt: new Date('2026-10-13T04:00:00Z'), cap: remaining };
}

export function makeDeps(db: ReturnType<typeof makeDb>, brand: BrandId = 'roboapply', overrides: Partial<AgentDeps> = {}) {
  const calls = {
    tailor: [] as Array<Parameters<AgentDeps['tailor']>[1]>,
    letters: [] as string[],
    enqueued: [] as PreparePayload[],
    reserved: [] as string[],
    committed: [] as string[],
    released: [] as string[],
    applyClicks: [] as string[],
    undoClicks: [] as string[],
    marks: [] as string[],
    undoMarks: [] as string[],
    notices: [] as unknown[],
  };
  let n = 0;
  const deps: AgentDeps = {
    getDb: async () => db as unknown as AgentDb,
    now: () => NOW,
    brand: () => getBrand(brand),
    aiAvailable: async () => true,
    flag: async () => true,
    assertPhoneBound: async () => undefined,
    visibleJobs: async (jobs) => jobs,
    extensionConnected: async (userId, brandId) =>
      (await db.rAExtensionDevice.findMany({ where: { userId, brand: brandId, revokedAt: null } })).length > 0,
    profileMissing: async () => [{ key: 'phone', label: 'profile.missing.phone' }],
    profileName: async () => ({ firstName: 'Ana', lastName: 'Lima' }),
    feedPreview: async () => [],
    activeSearch: async () => ({ id: 'sp_main', name: 'Main', isDefault: true, isActive: true, version: 3, schemaVersion: 1, filters: {}, alertInstantMax: 0, alertDigest: null, createdAt: '', updatedAt: '' }) as never,
    patchSearch: async (_u, id, version) => ({ id, version: version + 1 }) as never,
    filtersDiffer: async (_base, overridesIn) => Object.keys(overridesIn).length > 0,
    recordApplyClick: async (_u, jobId) => {
      calls.applyClicks.push(jobId);
      return { applyUrl: `https://jobs.example.test/${jobId}`, atsType: null, extensionSupported: false, trackerEntryId: `trk_${jobId}`, alreadyApplied: false };
    },
    undoApplyClick: async (_u, jobId) => {
      calls.undoClicks.push(jobId);
      return { reverted: true };
    },
    markApplied: async (_u, jobId) => {
      calls.marks.push(jobId);
      return { entryId: `trk_${jobId}`, changed: true, eventId: `ev_${jobId}` };
    },
    undoMarkApplied: async (_u, jobId) => {
      calls.undoMarks.push(jobId);
      return { reverted: true };
    },
    tailor: async (_u, input) => {
      calls.tailor.push(input);
      n += 1;
      return session(`ts${n}`, { jobId: input.jobId, resultVariantId: `rv_tailored${n}`, pendingClaims: 1 });
    },
    finalizeTailor: async (_u, id) => session(id, { status: 'finalized' }),
    tailorSession: async (_u, id) => session(id, { pendingClaims: 1 }),
    unverifiedClaims: async () => 0,
    createLetter: async (_u, input) => {
      calls.letters.push(input.jobId);
      return { id: `cl_${input.jobId}` };
    },
    rewriteLetter: async (_u, id) => ({ id }),
    regenerateLetter: async (_u, id) => ({ id }),
    attachLetter: async () => undefined,
    creditUsage: async () => ({ lines: { tailor: usageLine(10), cover_letter: usageLine(10), ready_kits: usageLine(3, 'week') }, upgradable: true }),
    reserveKit: async (_u, key) => {
      calls.reserved.push(key);
      return { id: `res_${key}`, replayed: false };
    },
    commitKit: async (id) => {
      calls.committed.push(id);
    },
    releaseKit: async (id) => {
      calls.released.push(id);
    },
    enqueuePrepare: async (payload) => {
      calls.enqueued.push(payload);
    },
    kickPrepare: () => undefined,
    notify: async (input) => {
      calls.notices.push(input);
      return { status: 'delivered', outcome: { notificationId: 'n1', email: null, channels: {} } };
    },
    ...overrides,
  };
  return { deps, calls, service: createAgentService(deps) };
}

/** Seed one queue item in a given state. */
export async function seedItem(db: ReturnType<typeof makeDb>, row: Record<string, unknown>): Promise<string> {
  const created = await (db as unknown as AgentDb).rAAgentQueueItem.create({
    data: { userId: 'u1', jobId: 'j1', weekKey: '2026-W42', addedVia: 'manual', ...row } as never,
  });
  return created.id;
}
