// server/src/features/copilot/nudges.ts — proactive nudges from real signals (F-ORION-08; WP-50).
//
// GET /copilot/nudge returns at most one nudge; the UI shows at most one per
// session (WP-51) through the popup gate. Signals, in order:
//   campus_deadline (GoApply, calendar on): an official window the user follows closes within 7 days
//   low_rating:     the latest feed rating in the last 7 days is below 6
//   agency_report:  a job report in the last 14 days while agency posts are shown
//   pay_filter:     no minimum pay set and at least MIN_SAMPLE jobs in the search list pay
// Nothing is guessed: no signal → null. Read-only.

import { MIN_SAMPLE } from '../../platform/http.js';
import type { Market } from '../../platform/brand/registry.js';
import type { FlagKey } from '../../platform/flags.js';
import type { NudgeView } from './contract.js';
import type { CopilotAreas } from './types.js';
import { indexCount } from './tools/util.js';

type PrismaClientLike = typeof import('../../lib/prisma.js').default;

export const LOW_RATING_BELOW = 6;
export const RATING_LOOKBACK_DAYS = 7;
export const REPORT_LOOKBACK_DAYS = 14;
export const CAMPUS_DEADLINE_DAYS = 7;
const DAY = 86_400_000;

export interface NudgeSignals {
  latestRating(userId: string, since: Date): Promise<{ score: number; createdAt: Date } | null>;
  reportedSince(userId: string, since: Date): Promise<boolean>;
}

/**
 * @deprecated Reads the feed area's `RAFeedRating` and `RAJobInteraction`
 * tables directly. Replace with `feedSignals.latestRating()` /
 * `feedSignals.reportedSince()` from `feed/index.ts` (REQ-50-02).
 */
export function createPrismaNudgeSignals(getDb: () => Promise<PrismaClientLike> = async () => (await import('../../lib/prisma.js')).default): NudgeSignals {
  return {
    async latestRating(userId, since) {
      const p = await getDb();
      return p.rAFeedRating.findFirst({ where: { userId, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, select: { score: true, createdAt: true } });
    },
    async reportedSince(userId, since) {
      const p = await getDb();
      const row = await p.rAJobInteraction.findFirst({ where: { userId, kind: 'report', createdAt: { gte: since } }, select: { id: true } });
      return Boolean(row);
    },
  };
}

export interface NudgeDeps {
  areas: CopilotAreas;
  signals: NudgeSignals;
  market: () => Market;
  isEnabled: (key: FlagKey) => Promise<boolean>;
  now: () => Date;
}

export async function nextNudge(userId: string, deps: NudgeDeps): Promise<NudgeView | null> {
  const now = deps.now();
  const market = deps.market();

  if (market === 'cn' && (await deps.isEnabled('jobs.campusCalendar').catch(() => false))) {
    try {
      const items = await deps.areas.campusUpcoming(userId, { limit: 5 });
      const soon = items.find((e) => {
        if (!e.applyClosesAt) return false;
        const t = Date.parse(e.applyClosesAt);
        return Number.isFinite(t) && t >= now.getTime() && t - now.getTime() <= CAMPUS_DEADLINE_DAYS * DAY;
      });
      if (soon) {
        return {
          kind: 'campus_deadline',
          prompt: `Which campus applications close soon?`,
          facts: { eventId: soon.id, companyName: soon.companyName, applyClosesAt: soon.applyClosesAt, officialUrl: soon.officialUrl, verifiedAt: soon.verifiedAt },
        };
      }
    } catch {
      // the calendar seam may not be filled yet; fall through
    }
  }

  const rating = await deps.signals.latestRating(userId, new Date(now.getTime() - RATING_LOOKBACK_DAYS * DAY)).catch(() => null);
  if (rating && rating.score < LOW_RATING_BELOW) {
    return { kind: 'low_rating', prompt: 'Help me adjust my search.', facts: { rating: rating.score, ratedAt: rating.createdAt.toISOString() } };
  }

  if (!deps.areas.postingsAllowed(market)) return null;
  let profile;
  try {
    profile = await deps.areas.activeSearchProfile(userId);
  } catch {
    return null;
  }

  if (!profile.filters.excludeAgencies && (await deps.signals.reportedSince(userId, new Date(now.getTime() - REPORT_LOOKBACK_DAYS * DAY)).catch(() => false))) {
    return { kind: 'agency_report', prompt: 'Hide posts from staffing agencies.', facts: { searchProfileId: profile.id } };
  }

  if (!profile.filters.salaryMin && profile.filters.includeUndisclosedPay !== false) {
    try {
      const listed = await deps.areas.countForFilters(userId, { ...profile.filters, includeUndisclosedPay: false });
      if (listed.count !== null && listed.count >= MIN_SAMPLE) {
        const count = indexCount(listed.count, now);
        return { kind: 'pay_filter', prompt: 'Add a minimum pay to my search.', facts: { searchProfileId: profile.id, jobsListingPay: count, capped: listed.capped } };
      }
    } catch {
      return null;
    }
  }
  return null;
}
