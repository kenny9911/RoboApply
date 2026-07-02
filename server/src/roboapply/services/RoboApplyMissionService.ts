// backend/src/roboapply/services/RoboApplyMissionService.ts
//
// CRUD for RoboApplyMission. Single source of truth for:
//   - Mission creation (called by /onboarding/complete)
//   - Intent edits (PATCH /missions/intent)
//   - Pause / resume
//   - Tier / dailyCap / reviewMode mutations
//
// Boundary: imports from backend/src/lib + roboapply/agents only. Never
// imports recruiter services.

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';
import roboApplyIntentParserAgent, {
  RoboApplyIntentParseError,
  type RoboApplyParsedIntent,
  type RoboApplyLocale,
} from '../agents/RoboApplyIntentParserAgent.js';

// ─── Public types ───────────────────────────────────────────────────────

export type RoboApplyTier = 'free' | 'premium' | 'premium_plus' | 'starter' | 'growth';
export type RoboApplyReviewMode = 'auto' | 'review_first';

export interface CreateMissionInput {
  userId: string;
  intentText: string;
  tier: RoboApplyTier;
  dailyCap?: number | null;
  timezone: string;
  locale: RoboApplyLocale;
  resumeId?: string | null;
  reviewMode?: RoboApplyReviewMode | null;
  coverLetterToneOverride?: string | null;
}

export interface MissionSnapshot {
  id: string;
  userId: string;
  intentText: string;
  parsedIntent: RoboApplyParsedIntent | null;
  intentVersion: number;
  intentParsedAt: string | null;
  tier: RoboApplyTier;
  reviewMode: RoboApplyReviewMode;
  dailyCap: number;
  coverLetterToneOverride: string | null;
  enabled: boolean;
  pausedUntil: string | null;
  pausedReason: string | null;
  timezone: string;
  locale: string;
  resumeId: string | null;
  lastDigestSentAt: string | null;
  lastSubmissionAt: string | null;
  totalSubmitted: number;
  totalSkipped: number;
  totalUndone: number;
  totalFailed: number;
  createdAt: string;
  updatedAt: string;
}

// ─── Errors ─────────────────────────────────────────────────────────────

export type RoboApplyMissionErrorCode =
  | 'mission_exists'
  | 'mission_not_found'
  | 'invalid_input'
  | 'intent_parse_failed';

export class RoboApplyMissionError extends Error {
  constructor(
    public readonly code: RoboApplyMissionErrorCode,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'RoboApplyMissionError';
  }
}

// ─── Constants ──────────────────────────────────────────────────────────

const TIER_DAILY_CAPS: Record<RoboApplyTier, number> = {
  free: 3,
  premium: 15,
  premium_plus: 30,
  // Mock-interview subscription plans. Auto-apply caps mirror premium/premium_plus
  // so starter/growth don't fall through to the free default (auto-apply is
  // orthogonal to mock-interview credits).
  starter: 15,
  growth: 30,
};

// ─── Helpers ────────────────────────────────────────────────────────────

function clampDailyCap(tier: RoboApplyTier, requested: number | null | undefined): number {
  const tierMax = TIER_DAILY_CAPS[tier] ?? 3;
  if (requested == null || !Number.isFinite(requested) || requested <= 0) {
    return tierMax;
  }
  return Math.max(1, Math.min(tierMax, Math.floor(requested)));
}

function resolveReviewMode(tier: RoboApplyTier, requested: RoboApplyReviewMode | null | undefined): RoboApplyReviewMode {
  // Free tier is LOCKED to review_first per CTO ruling R2 + PRD §7.
  if (tier === 'free') return 'review_first';
  return requested ?? 'auto';
}

function toMissionSnapshot(row: Awaited<ReturnType<typeof prisma.roboApplyMission.findUnique>>): MissionSnapshot {
  if (!row) throw new RoboApplyMissionError('mission_not_found', 'Mission not found');
  return {
    id: row.id,
    userId: row.userId,
    intentText: row.intentText,
    parsedIntent: (row.parsedIntent as RoboApplyParsedIntent | null) ?? null,
    intentVersion: row.intentVersion,
    intentParsedAt: row.intentParsedAt?.toISOString() ?? null,
    tier: row.tier as RoboApplyTier,
    reviewMode: row.reviewMode as RoboApplyReviewMode,
    dailyCap: row.dailyCap,
    coverLetterToneOverride: row.coverLetterToneOverride ?? null,
    enabled: row.enabled,
    pausedUntil: row.pausedUntil?.toISOString() ?? null,
    pausedReason: row.pausedReason ?? null,
    timezone: row.timezone,
    locale: row.locale,
    resumeId: row.resumeId ?? null,
    lastDigestSentAt: row.lastDigestSentAt?.toISOString() ?? null,
    lastSubmissionAt: row.lastSubmissionAt?.toISOString() ?? null,
    totalSubmitted: row.totalSubmitted,
    totalSkipped: row.totalSkipped,
    totalUndone: row.totalUndone,
    totalFailed: row.totalFailed,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────

export async function createMission(input: CreateMissionInput, requestId?: string | null): Promise<MissionSnapshot> {
  if (!input.intentText || input.intentText.trim().length < 5) {
    throw new RoboApplyMissionError('invalid_input', 'Intent text is required');
  }
  const existing = await prisma.roboApplyMission.findUnique({ where: { userId: input.userId } });
  if (existing) {
    throw new RoboApplyMissionError('mission_exists', 'User already has a RoboApply mission', { id: existing.id });
  }

  const dailyCap = clampDailyCap(input.tier, input.dailyCap ?? null);
  const reviewMode = resolveReviewMode(input.tier, input.reviewMode ?? null);

  // Persist the mission BEFORE attempting the intent parse — if the parse
  // fails, the mission row still exists with parsedIntent=null and the
  // matcher cron will retry on the next sweep.
  const created = await prisma.roboApplyMission.create({
    data: {
      userId: input.userId,
      intentText: input.intentText,
      tier: input.tier,
      reviewMode,
      dailyCap,
      timezone: input.timezone,
      locale: input.locale,
      resumeId: input.resumeId ?? null,
      coverLetterToneOverride: input.coverLetterToneOverride ?? null,
      enabled: true,
    },
  });

  // Fire-and-forget the intent parser. We don't block the user-facing
  // onboarding response on it; the parse completes asynchronously and the
  // matcher reads it on the next 5am tick.
  void (async () => {
    try {
      const parsed = await roboApplyIntentParserAgent.parse(
        {
          intentText: input.intentText,
          locale: input.locale,
        },
        {
          userId: input.userId,
          requestId,
          missionId: created.id,
        },
      );
      await prisma.roboApplyMission.update({
        where: { id: created.id },
        data: {
          parsedIntent: parsed as unknown as Prisma.InputJsonValue,
          intentParsedAt: new Date(),
        },
      });
    } catch (err) {
      logger.error(
        'ROBOAPPLY_MISSION',
        'Intent parse failed for newly-created mission',
        {
          userId: input.userId,
          missionId: created.id,
          error: err instanceof Error ? err.message : String(err),
        },
        requestId ?? undefined,
      );
    }
  })();

  const fresh = await prisma.roboApplyMission.findUnique({ where: { id: created.id } });
  return toMissionSnapshot(fresh);
}

export async function getMissionForUser(userId: string): Promise<MissionSnapshot | null> {
  const row = await prisma.roboApplyMission.findUnique({ where: { userId } });
  if (!row) return null;
  return toMissionSnapshot(row);
}

export async function updateIntent(
  userId: string,
  intentText: string,
  ctx: { requestId?: string | null } = {},
): Promise<MissionSnapshot> {
  if (!intentText || intentText.trim().length < 5) {
    throw new RoboApplyMissionError('invalid_input', 'Intent text is required');
  }
  const existing = await prisma.roboApplyMission.findUnique({ where: { userId } });
  if (!existing) {
    throw new RoboApplyMissionError('mission_not_found', 'No RoboApply mission for this user');
  }
  // Bump intentVersion — this is the cache-key salt for downstream cover
  // letter cache. Existing letters generated against the OLD version still
  // work for today's queue (matcher de-selects them from tomorrow's pick).
  const nextVersion = existing.intentVersion + 1;
  let parsed: RoboApplyParsedIntent | null = null;
  try {
    parsed = await roboApplyIntentParserAgent.parse(
      {
        intentText,
        locale: existing.locale as RoboApplyLocale,
      },
      {
        userId,
        requestId: ctx.requestId,
        missionId: existing.id,
      },
    );
  } catch (err) {
    if (err instanceof RoboApplyIntentParseError) {
      // We still persist the new intentText (so the user sees what they typed)
      // but leave parsedIntent at the previous version. The matcher uses the
      // last good parsedIntent until the next successful parse.
      logger.warn(
        'ROBOAPPLY_MISSION',
        'Intent parse failed; persisting text without parsed structure',
        { userId, missionId: existing.id, code: err.code },
        ctx.requestId ?? undefined,
      );
    } else {
      throw err;
    }
  }

  await prisma.roboApplyMission.update({
    where: { id: existing.id },
    data: {
      intentText,
      intentVersion: nextVersion,
      intentParsedAt: parsed ? new Date() : existing.intentParsedAt,
      ...(parsed ? { parsedIntent: parsed as unknown as Prisma.InputJsonValue } : {}),
    },
  });

  return toMissionSnapshot(
    await prisma.roboApplyMission.findUnique({ where: { id: existing.id } }),
  );
}

export interface PauseInput {
  /** null / undefined → indefinite. 24 / 168 → hours-from-now. */
  durationHours?: number | null;
  reason?: string | null;
}

export async function pauseMission(userId: string, input: PauseInput = {}): Promise<MissionSnapshot> {
  const existing = await prisma.roboApplyMission.findUnique({ where: { userId } });
  if (!existing) {
    throw new RoboApplyMissionError('mission_not_found', 'No RoboApply mission for this user');
  }
  let pausedUntil: Date;
  if (input.durationHours == null || !Number.isFinite(input.durationHours) || input.durationHours <= 0) {
    // Indefinite — set to year 2099. Resume explicitly flips it back.
    pausedUntil = new Date(Date.UTC(2099, 0, 1));
  } else {
    const hours = Math.max(1, Math.min(24 * 365, Math.floor(input.durationHours)));
    pausedUntil = new Date(Date.now() + hours * 60 * 60 * 1000);
  }
  await prisma.roboApplyMission.update({
    where: { id: existing.id },
    data: {
      pausedUntil,
      pausedReason: input.reason ?? null,
    },
  });
  return toMissionSnapshot(await prisma.roboApplyMission.findUnique({ where: { id: existing.id } }));
}

export async function resumeMission(userId: string): Promise<MissionSnapshot> {
  const existing = await prisma.roboApplyMission.findUnique({ where: { userId } });
  if (!existing) {
    throw new RoboApplyMissionError('mission_not_found', 'No RoboApply mission for this user');
  }
  await prisma.roboApplyMission.update({
    where: { id: existing.id },
    data: { pausedUntil: null, pausedReason: null },
  });
  return toMissionSnapshot(await prisma.roboApplyMission.findUnique({ where: { id: existing.id } }));
}

export interface UpdateSettingsInput {
  reviewMode?: RoboApplyReviewMode | null;
  dailyCap?: number | null;
  coverLetterToneOverride?: string | null;
}

export async function updateSettings(
  userId: string,
  input: UpdateSettingsInput,
): Promise<MissionSnapshot> {
  const existing = await prisma.roboApplyMission.findUnique({ where: { userId } });
  if (!existing) {
    throw new RoboApplyMissionError('mission_not_found', 'No RoboApply mission for this user');
  }
  const data: Prisma.RoboApplyMissionUpdateInput = {};
  if (input.reviewMode !== undefined && input.reviewMode !== null) {
    data.reviewMode = resolveReviewMode(existing.tier as RoboApplyTier, input.reviewMode);
  }
  if (input.dailyCap !== undefined && input.dailyCap !== null) {
    data.dailyCap = clampDailyCap(existing.tier as RoboApplyTier, input.dailyCap);
  }
  if (input.coverLetterToneOverride !== undefined) {
    // Top-tier only (Premium+ / Growth).
    if (
      existing.tier !== 'premium_plus' &&
      existing.tier !== 'growth' &&
      input.coverLetterToneOverride &&
      input.coverLetterToneOverride.trim()
    ) {
      throw new RoboApplyMissionError(
        'invalid_input',
        'coverLetterToneOverride is Premium+ only',
        { tier: existing.tier },
      );
    }
    data.coverLetterToneOverride = input.coverLetterToneOverride
      ? input.coverLetterToneOverride.slice(0, 2_000)
      : null;
  }
  if (Object.keys(data).length === 0) {
    return toMissionSnapshot(existing);
  }
  await prisma.roboApplyMission.update({ where: { id: existing.id }, data });
  return toMissionSnapshot(await prisma.roboApplyMission.findUnique({ where: { id: existing.id } }));
}

/** Internal helper — bump submission/skip/undo counters atomically. */
export async function incrementMissionCounter(
  missionId: string,
  counter: 'totalSubmitted' | 'totalSkipped' | 'totalUndone' | 'totalFailed',
  delta: number = 1,
): Promise<void> {
  if (delta === 0) return;
  await prisma.roboApplyMission.update({
    where: { id: missionId },
    data: { [counter]: { increment: delta } },
  });
}

export const roboApplyMissionService = {
  createMission,
  getMissionForUser,
  updateIntent,
  pauseMission,
  resumeMission,
  updateSettings,
  incrementMissionCounter,
};

export const __test = {
  TIER_DAILY_CAPS,
  clampDailyCap,
  resolveReviewMode,
};

export default roboApplyMissionService;
