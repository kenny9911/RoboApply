// server/src/features/alice/deps.ts — the seams between Alice and the rest of the product.
//
// The orchestrator (service.ts) talks to other areas only through this
// interface, so tests run it with fakes. The defaults load each area lazily
// (as the agent area does) and go through each area's public surface
// (index.ts), except two reads of rows Alice owns the meaning of: the
// user's resume variants (read as onboarding reads them) and the Ready to
// apply list (through the agent service).
//
// D1: no seam here submits anything or calls an employer.

import { getCurrentBrandOrDefault } from '../../platform/brand/index.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { aiAllowed } from '../../platform/consent/index.js';
import { isEnabled } from '../../platform/flags.js';
import { assertRateLimit, type RateLimitName } from '../../platform/ratelimit/index.js';
import { LLM_PII_KINDS, redactPii } from '../../platform/pii/index.js';
import type { FeedItem } from '../feed/contract.js';
import type { FilterSet } from '../search/contract.js';
import type { TrackerEntryView } from '../tracker/contract.js';
import { createAliceAgents, type AliceAgents } from './agents.js';
import { createPrismaAliceStore, type AliceStore } from './store.js';
import type { ReadyToCheck, TrackerFact } from './skills/followUps.js';

export interface ResumeRef {
  id: string;
  name: string;
  updatedAt: Date;
}

export interface ResumeDigest extends ResumeRef {
  /** Contact block dropped, PII redacted, at most RESUME_DIGEST_CHARS. Empty when the resume has no text. */
  text: string;
  /** Roles the resume shows (deterministic seed), for the "I read your resume" line. */
  roles: string[];
  years: number | null;
}

export interface SearchRef {
  id: string;
  name: string;
  isActive: boolean;
  isDefault: boolean;
  version: number;
  filters: FilterSet;
}

export interface TrackerEntryLite {
  id: string;
  status: string;
  company: string | null;
  title: string | null;
  dateApplied: string | null;
  followUpAt: string | null;
  updatedAt: string;
}

export interface AliceDeps {
  store: AliceStore;
  agents: AliceAgents;
  now(): Date;
  brand(): ProductBrand;
  aiAllowed(userId: string): Promise<boolean>;
  /** A capability for this user (`agent` decides whether Ready to apply facts are read). */
  flag(key: 'agent', userId: string): Promise<boolean>;
  /** Throws 429 `rate_limited` past the window. */
  rateLimit(name: AliceRateName, userId: string): Promise<void>;
  // Resumes
  primaryResume(userId: string): Promise<ResumeRef | null>;
  resume(userId: string, id: string): Promise<ResumeRef | null>;
  resumeDigest(userId: string, id: string): Promise<ResumeDigest | null>;
  // Saved searches
  searches(userId: string): Promise<{ items: SearchRef[]; cap: number }>;
  createSearch(userId: string, input: { name: string; filters: FilterSet; activate: boolean }): Promise<SearchRef>;
  replaceSearch(userId: string, id: string, input: { version: number; filters: FilterSet }): Promise<SearchRef>;
  activateSearch(userId: string, id: string): Promise<SearchRef>;
  // The feed
  matches(userId: string, input: { filters: FilterSet; relevance: string; limit: number; locale: string }): Promise<FeedItem[]>;
  // The tracker
  trackerEntries(userId: string): Promise<{ entries: TrackerEntryLite[]; statusCounts: Record<string, number> }>;
  trackerFacts(userId: string): Promise<TrackerFact[]>;
  setFollowUp(userId: string, entryId: string, date: string | null): Promise<TrackerEntryLite>;
  // Ready to apply
  readyToCheck(userId: string): Promise<ReadyToCheck[]>;
}

/** Per-user windows (persisted counters, `RARateCounter`; the windows are in platform/ratelimit RATE_LIMITS). */
export type AliceRateName = Extract<RateLimitName, 'aliceTurn' | 'aliceDraft'>;

export const RESUME_DIGEST_CHARS = 9000;

const db = async () => (await import('../../lib/prisma.js')).default;

function snapshotOf(entry: Pick<TrackerEntryView, 'job' | 'externalSnapshot'>): { company: string | null; title: string | null } {
  const company = entry.job?.companyName ?? entry.externalSnapshot?.companyName ?? null;
  const title = entry.job?.title ?? entry.externalSnapshot?.title ?? null;
  return { company: company || null, title: title || null };
}

function liteEntry(e: TrackerEntryView): TrackerEntryLite {
  return { id: e.id, status: e.status, ...snapshotOf(e), dateApplied: e.dateApplied ?? null, followUpAt: e.followUpAt ?? null, updatedAt: e.updatedAt };
}

export function defaultAliceDeps(): AliceDeps {
  return {
    store: createPrismaAliceStore(),
    agents: createAliceAgents(),
    now: () => new Date(),
    brand: () => getCurrentBrandOrDefault(),
    aiAllowed: (userId) => aiAllowed(userId),
    flag: (key, userId) => isEnabled(key, { userId }),
    async rateLimit(name, userId) {
      await assertRateLimit({ name, id: userId, scope: 'user' });
    },
    async primaryResume(userId) {
      const row = await (await db()).rAResumeVariant.findFirst({
        // `parseStatus` is null for anything that never went through the upload parse: a plain NOT would drop those rows (SQL NULL).
        where: { userId, deletedAt: null, kind: 'base', OR: [{ parseStatus: null }, { parseStatus: { not: 'parsing' } }] },
        orderBy: [{ isPrimary: 'desc' }, { lastEditedAt: 'desc' }],
        select: { id: true, name: true, lastEditedAt: true },
      });
      return row ? { id: row.id, name: row.name, updatedAt: row.lastEditedAt } : null;
    },
    async resume(userId, id) {
      const row = await (await db()).rAResumeVariant.findFirst({ where: { id, userId, deletedAt: null }, select: { id: true, name: true, lastEditedAt: true } });
      return row ? { id: row.id, name: row.name, updatedAt: row.lastEditedAt } : null;
    },
    async resumeDigest(userId, id) {
      const row = await (await db()).rAResumeVariant.findFirst({
        where: { id, userId, deletedAt: null },
        select: { id: true, name: true, lastEditedAt: true, parsedData: true, resumeMarkdown: true },
      });
      if (!row) return null;
      const [{ resumeForLlm }, { seedDraftFromParsedResume }] = await Promise.all([import('../resume/index.js'), import('../../roboapply/v2/lib/raResumeSeed.js')]);
      // Contact block dropped and PII redacted before anything reaches a model.
      const text = redactPii(resumeForLlm(row.resumeMarkdown ?? ''), { kinds: LLM_PII_KINDS }).text.slice(0, RESUME_DIGEST_CHARS);
      const seed = seedDraftFromParsedResume(row.parsedData, row.resumeMarkdown ?? null);
      return {
        id: row.id,
        name: row.name,
        updatedAt: row.lastEditedAt,
        text: text.trim(),
        roles: (seed.draft.targetRoles ?? []).slice(0, 3),
        years: typeof seed.evidence.years === 'number' ? seed.evidence.years : null,
      };
    },
    async searches(userId) {
      const { searchProfileService } = await import('../search/index.js');
      const list = await searchProfileService.list(userId);
      const items = list.profiles.map((p) => ({ id: p.id, name: p.name, isActive: p.isActive, isDefault: p.isDefault, version: p.version, filters: p.filters }));
      return { items, cap: list.maxProfiles };
    },
    async createSearch(userId, input) {
      const { searchProfileService, searchErrorToHttpError } = await import('../search/index.js');
      try {
        const p = await searchProfileService.create(userId, { name: input.name, filters: input.filters, activate: input.activate });
        return { id: p.id, name: p.name, isActive: p.isActive, isDefault: p.isDefault, version: p.version, filters: p.filters };
      } catch (err) {
        throw searchErrorToHttpError(err) ?? err;
      }
    },
    async replaceSearch(userId, id, input) {
      const { searchProfileService, searchErrorToHttpError } = await import('../search/index.js');
      try {
        const p = await searchProfileService.update(userId, id, { version: input.version, filters: input.filters });
        return { id: p.id, name: p.name, isActive: p.isActive, isDefault: p.isDefault, version: p.version, filters: p.filters };
      } catch (err) {
        throw searchErrorToHttpError(err) ?? err;
      }
    },
    async activateSearch(userId, id) {
      const { searchProfileService, searchErrorToHttpError } = await import('../search/index.js');
      try {
        const p = await searchProfileService.activate(userId, id);
        return { id: p.id, name: p.name, isActive: p.isActive, isDefault: p.isDefault, version: p.version, filters: p.filters };
      } catch (err) {
        throw searchErrorToHttpError(err) ?? err;
      }
    },
    async matches(userId, input) {
      const [{ feedService, itemOwesCreditLine }, { FILTER_FIELDS }] = await Promise.all([import('../feed/index.js'), import('../search/index.js')]);
      // Exactly the profile's filters: every field of the active search the profile does not set is cleared.
      const overrides: Record<string, unknown> = Object.fromEntries(FILTER_FIELDS.map((f) => [f, undefined]));
      Object.assign(overrides, input.filters);
      const items = await feedService.preview(userId, {
        filters: overrides as never,
        sort: 'best_fit',
        limit: input.limit,
        relevance: input.relevance || undefined,
        locale: input.locale,
        favorTargetCompanies: true,
      });
      return items.filter((item) => !itemOwesCreditLine(item));
    },
    async trackerEntries(userId) {
      const { trackerCore } = await import('../tracker/index.js');
      const res = await trackerCore.list(userId, { limit: 200 });
      return { entries: res.entries.map(liteEntry), statusCounts: res.statusCounts };
    },
    async trackerFacts(userId) {
      const { trackerCore } = await import('../tracker/index.js');
      return (await trackerCore.followUps(userId)) as TrackerFact[];
    },
    async setFollowUp(userId, entryId, date) {
      const { trackerCore, TrackerNotFoundError } = await import('../tracker/index.js');
      try {
        // A date-only follow-up is stored at noon UTC, so it is the same calendar day in every time zone the tracker shows.
        return liteEntry(await trackerCore.patch(userId, entryId, { followUpAt: date ? `${date}T12:00:00.000Z` : null }));
      } catch (err) {
        if (err instanceof TrackerNotFoundError) {
          const { HttpError } = await import('../../platform/http.js');
          const { ALICE_ERROR_REASONS } = await import('./contract.js');
          throw new HttpError('not_found', 'That application is not in your list.', { reason: ALICE_ERROR_REASONS.entryNotFound });
        }
        throw err;
      }
    },
    async readyToCheck(userId) {
      const { getAgentService } = await import('../agent/index.js');
      const res = await getAgentService().listQueue(userId, { state: 'ready_for_review', limit: 20 });
      return res.items.map((i) => ({
        queueItemId: i.id,
        entryId: i.trackerEntryId,
        company: i.job?.companyName ?? null,
        title: i.job?.title ?? null,
        at: i.updatedAt,
      }));
    },
  };
}
