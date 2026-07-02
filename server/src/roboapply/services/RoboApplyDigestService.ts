// backend/src/roboapply/services/RoboApplyDigestService.ts
//
// 07:00 user-local cron entry point. For each enabled mission whose user-
// local time matches the target hour:
//   1. Build the RoboApplyDigestInput from yesterday's + today's runs.
//   2. Invoke RoboApplyDigestAgent.compose() — agent runs CitationGuard
//      internally and writes the `roboapply_digest` audit row on success.
//      LLM failure returns a deterministic fallback (no audit row).
//   3. Persist RoboApplyDigest. Idempotent on (missionId, dayBucketUtc) —
//      a second call within the same UTC day is a no-op.
//   4. Send the email via existing EmailService.
//   5. Bump mission.lastDigestSentAt.

import prisma from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { logger } from '../../services/LoggerService.js';
import { runConcurrent } from '../../utils/concurrency.js';
import emailService, { escapeHtml } from '../../services/EmailService.js';
import roboApplyDigestAgent, {
  type RoboApplyDigestInput,
  type DigestRunReference,
  type DigestStandoutResponse,
} from '../agents/RoboApplyDigestAgent.js';
import type { RoboApplyLocale } from '../agents/RoboApplyIntentParserAgent.js';
import { utcDayBucket, userLocalHour } from '../lib/localTime.js';

// ─── Constants ──────────────────────────────────────────────────────────

const DIGEST_TARGET_LOCAL_HOUR = 7;
const PER_BATCH_CONCURRENCY = 3;

// ─── Public types ───────────────────────────────────────────────────────

export interface DigestComposeOutcome {
  missionId: string;
  status: 'sent' | 'persisted_no_email' | 'already_sent_today' | 'no_mission' | 'failed';
  digestId?: string;
  emailSent?: boolean;
  reason?: string;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Compose + send the digest for ONE mission. Idempotent on
 * (missionId, today's UTC day) — a duplicate call within the same UTC day
 * returns 'already_sent_today' without re-running the LLM or re-sending the
 * email.
 */
export async function composeAndSendDigestForMission(
  missionId: string,
  ctx: { requestId?: string | null } = {},
): Promise<DigestComposeOutcome> {
  const mission = await prisma.roboApplyMission.findUnique({
    where: { id: missionId },
    select: {
      id: true,
      userId: true,
      tier: true,
      locale: true,
      timezone: true,
      enabled: true,
      pausedUntil: true,
      lastDigestSentAt: true,
      createdAt: true,
      user: {
        select: { email: true, name: true },
      },
    },
  });

  if (!mission) {
    return { missionId, status: 'no_mission', reason: 'mission not found' };
  }

  const today = utcDayBucket();

  // Idempotency check — if a digest already exists for this (mission, day),
  // bail. The mission.lastDigestSentAt + the RoboApplyDigest unique
  // constraint are both guards; we check the persisted row first because
  // it survives restarts.
  const existing = await prisma.roboApplyDigest.findUnique({
    where: { missionId_dayBucketUtc: { missionId: mission.id, dayBucketUtc: today } },
    select: { id: true, sentAt: true },
  });
  if (existing && existing.sentAt) {
    return { missionId, status: 'already_sent_today', digestId: existing.id };
  }

  // ── Build the digest input.
  const input = await buildDigestInput(mission);
  const firstName = (mission.user?.name ?? '').split(/\s+/)[0] || '';

  // ── Compose via the Sonnet agent. Failure returns a deterministic
  // fallback (no audit row).
  const output = await roboApplyDigestAgent.compose(
    { ...input, firstName },
    { userId: mission.userId, requestId: ctx.requestId ?? null },
  );

  // ── Persist the digest row. Idempotent — if we lost a race to a sibling
  // process, upsert keeps the schema clean.
  const digest = await prisma.roboApplyDigest.upsert({
    where: { missionId_dayBucketUtc: { missionId: mission.id, dayBucketUtc: today } },
    create: {
      missionId: mission.id,
      dayBucketUtc: today,
      emailSubject: output.emailSubject || `RoboApply: daily digest`,
      emailBody: output.emailBody || '(empty digest)',
      appNarration: output.appNarration || '',
      citedRunIds: output.citedRunIds,
      modelUsed: output.modelUsed,
      citationGuardPassed: output.citationGuardPassed,
    },
    update: {
      emailSubject: output.emailSubject || 'RoboApply: daily digest',
      emailBody: output.emailBody || '(empty digest)',
      appNarration: output.appNarration || '',
      citedRunIds: output.citedRunIds,
      modelUsed: output.modelUsed,
      citationGuardPassed: output.citationGuardPassed,
    },
  });

  // ── Send the email. Failure logs but doesn't unwind the persisted row —
  // the digest is still available via SSE/Mission Control replay.
  let emailSent = false;
  if (mission.user?.email && emailService.isConfigured) {
    try {
      emailSent = await emailService.send({
        to: mission.user.email,
        subject: output.emailSubject || 'RoboApply: daily digest',
        html: renderDigestEmailHtml({
          firstName,
          markdownBody: output.emailBody,
          appUrl: process.env.PUBLIC_APP_URL || process.env.APP_URL || process.env.FRONTEND_URL || 'https://robohire.io',
        }),
      });
    } catch (err) {
      logger.error(
        'ROBOAPPLY_DIGEST',
        'email send threw',
        { missionId: mission.id, error: err instanceof Error ? err.message : String(err) },
        ctx.requestId ?? undefined,
      );
    }
  }

  if (emailSent) {
    await prisma.roboApplyDigest.update({
      where: { id: digest.id },
      data: { sentAt: new Date() },
    });
    await prisma.roboApplyMission.update({
      where: { id: mission.id },
      data: { lastDigestSentAt: new Date() },
    });
    return { missionId, status: 'sent', digestId: digest.id, emailSent: true };
  }

  return {
    missionId,
    status: 'persisted_no_email',
    digestId: digest.id,
    emailSent: false,
    reason: emailService.isConfigured ? 'send_failed' : 'email_service_not_configured',
  };
}

/**
 * Fan-out digest cron. Called from the global UTC tick — picks missions
 * whose user-local time matches DIGEST_TARGET_LOCAL_HOUR and dispatches
 * compose+send for each.
 */
export async function composeAndSendDigestsForLocalHour(
  ctx: { requestId?: string | null } = {},
): Promise<{ missionsTargeted: number; sent: number; persistedNoEmail: number; failed: number }> {
  // Pre-filter to enabled+unpaused missions. We then check each mission's
  // user-local hour in JS — the IANA TZ math doesn't lend itself to SQL
  // filtering without bringing in a TZ db.
  const candidates = await prisma.roboApplyMission.findMany({
    where: {
      enabled: true,
      OR: [{ pausedUntil: null }, { pausedUntil: { lte: new Date() } }],
    },
    select: { id: true, timezone: true },
  });

  const now = new Date();
  const targeted = candidates.filter((m) => userLocalHour(m.timezone || 'UTC', now) === DIGEST_TARGET_LOCAL_HOUR);

  let sent = 0;
  let persistedNoEmail = 0;
  let failed = 0;

  const tasks = targeted.map((m) => async () => {
    try {
      const outcome = await composeAndSendDigestForMission(m.id, ctx);
      if (outcome.status === 'sent') sent += 1;
      else if (outcome.status === 'persisted_no_email') persistedNoEmail += 1;
      else if (outcome.status === 'failed') failed += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        'ROBOAPPLY_DIGEST',
        'compose-and-send threw',
        { missionId: m.id, error: err instanceof Error ? err.message : String(err) },
        ctx.requestId ?? undefined,
      );
    }
  });

  await runConcurrent(tasks, PER_BATCH_CONCURRENCY);

  return { missionsTargeted: targeted.length, sent, persistedNoEmail, failed };
}

/** Retrieve today's digest for SSE replay / Mission Control /digest/today. */
export async function getTodayDigestForUser(userId: string) {
  const mission = await prisma.roboApplyMission.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!mission) return null;

  const today = utcDayBucket();
  const digest = await prisma.roboApplyDigest.findUnique({
    where: { missionId_dayBucketUtc: { missionId: mission.id, dayBucketUtc: today } },
  });
  if (!digest) return null;

  // Hydrate the cited runs so the UI can deep-link.
  const citedRuns = digest.citedRunIds.length > 0
    ? await prisma.roboApplyRun.findMany({
        where: { id: { in: digest.citedRunIds }, missionId: mission.id },
        select: {
          id: true,
          jobId: true,
          matchScore: true,
          status: true,
          plannedSubmitAt: true,
          actualSubmitAt: true,
          job: { select: { title: true, companyName: true } },
        },
      })
    : [];

  return {
    digest: {
      id: digest.id,
      emailSubject: digest.emailSubject,
      emailBody: digest.emailBody,
      appNarration: digest.appNarration,
      citedRunIds: digest.citedRunIds,
      modelUsed: digest.modelUsed,
      citationGuardPassed: digest.citationGuardPassed,
      sentAt: digest.sentAt?.toISOString() ?? null,
      dayBucketUtc: digest.dayBucketUtc.toISOString(),
    },
    citedRuns,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function buildDigestInput(mission: {
  id: string;
  userId: string;
  tier: string;
  locale: string;
  timezone: string;
  lastDigestSentAt: Date | null;
  createdAt: Date;
}): Promise<Omit<RoboApplyDigestInput, 'firstName'>> {
  const now = new Date();
  const yesterdayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [todayQueued, yesterdayRuns, recentSkips] = await Promise.all([
    prisma.roboApplyRun.findMany({
      where: {
        missionId: mission.id,
        status: 'previewing',
      },
      orderBy: { matchScore: 'desc' },
      take: 30,
      select: {
        id: true,
        matchScore: true,
        rationaleForPick: true,
        job: { select: { title: true, companyName: true } },
      },
    }),
    prisma.roboApplyRun.findMany({
      where: {
        missionId: mission.id,
        OR: [
          { actualSubmitAt: { gte: yesterdayStart } },
          { failedAt: { gte: yesterdayStart } },
        ],
      },
      select: {
        id: true,
        status: true,
        matchScore: true,
        job: { select: { title: true, companyName: true } },
        boardResponse: true,
      },
      take: 60,
    }),
    prisma.roboApplyRun.findMany({
      where: {
        missionId: mission.id,
        status: 'skipped_by_user',
        updatedAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { updatedAt: 'desc' },
      take: 8,
      select: {
        id: true,
        failureReason: true,
        job: { select: { companyName: true } },
      },
    }),
  ]);

  const todayQueuedRefs: DigestRunReference[] = todayQueued.map((r) => ({
    runId: r.id,
    jobTitle: r.job?.title ?? '',
    companyName: r.job?.companyName ?? '',
    matchScore: r.matchScore,
    status: 'previewing',
    aiAngle: r.rationaleForPick,
  }));

  let submittedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const standouts: DigestStandoutResponse[] = [];
  for (const r of yesterdayRuns) {
    if (r.status === 'submitted') submittedCount += 1;
    else if (r.status === 'failed') failedCount += 1;
    else if (r.status === 'skipped_by_user') skippedCount += 1;

    // Standout signal — V1 doesn't track recruiter-viewed yet; placeholder.
    if (r.boardResponse && typeof r.boardResponse === 'object' && (r.boardResponse as Record<string, unknown>).recruiterViewed) {
      standouts.push({
        runId: r.id,
        companyName: r.job?.companyName ?? '',
        signal: 'recruiter_viewed',
        at: now.toISOString(),
      });
    }
  }

  return {
    missionId: mission.id,
    isFirstDay: mission.lastDigestSentAt == null,
    tier: mapTier(mission.tier),
    todayQueued: todayQueuedRefs,
    yesterday: {
      submittedCount,
      failedCount,
      skippedCount,
      standouts,
    },
    marketWatcher: {
      boardsScanned: 2, // Greenhouse + manual_link in V1
      jobsConsidered: yesterdayRuns.length + todayQueuedRefs.length,
      lastScanIso: now.toISOString(),
    },
    recentSkips: recentSkips.map((r) => ({
      runId: r.id,
      reason: r.failureReason ?? 'user_skip',
      companyName: r.job?.companyName ?? '',
    })),
    locale: (mission.locale ?? 'en') as RoboApplyLocale,
    tone: 'warm_coach',
  };
}

function mapTier(tier: string): 'free' | 'premium' | 'premium_plus' {
  if (tier === 'premium') return 'premium';
  if (tier === 'premium_plus') return 'premium_plus';
  return 'free';
}

/** Minimal markdown → HTML for the digest email. Doesn't pull in a full
 *  parser; matches the project pattern of small inline renderers for
 *  transactional emails. */
function renderDigestEmailHtml(opts: {
  firstName: string;
  markdownBody: string;
  appUrl: string;
}): string {
  // Convert lightweight markdown to HTML. Paragraphs split on blank lines;
  // - bullets become <li>; **bold** becomes <strong>; *italic* becomes <em>.
  const lines = (opts.markdownBody || '').split(/\n/);
  const blocks: string[] = [];
  let bullets: string[] = [];
  for (const ln of lines) {
    if (ln.match(/^\s*[-*]\s+/)) {
      bullets.push(ln.replace(/^\s*[-*]\s+/, ''));
      continue;
    }
    if (bullets.length > 0) {
      blocks.push(`<ul style="margin: 8px 0 16px 20px; padding: 0;">${bullets.map((b) => `<li style="margin: 4px 0;">${formatInline(b)}</li>`).join('')}</ul>`);
      bullets = [];
    }
    if (ln.trim().length === 0) {
      blocks.push('');
    } else {
      blocks.push(`<p style="margin: 12px 0; color: #1e293b; font-size: 15px; line-height: 1.5;">${formatInline(ln)}</p>`);
    }
  }
  if (bullets.length > 0) {
    blocks.push(`<ul style="margin: 8px 0 16px 20px; padding: 0;">${bullets.map((b) => `<li style="margin: 4px 0;">${formatInline(b)}</li>`).join('')}</ul>`);
  }

  const url = opts.appUrl.replace(/\/$/, '') + '/mission';

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 0 auto; padding: 24px;">
    <h1 style="margin: 0 0 16px; font-size: 22px; color: #0f172a;">RoboApply morning briefing</h1>
    ${blocks.filter(Boolean).join('\n')}
    <a href="${escapeHtml(url)}" style="display: inline-block; margin-top: 12px; padding: 10px 20px; background: linear-gradient(135deg, #3B84E2 0%, #9154FD 100%); color: white; text-decoration: none; border-radius: 6px; font-weight: 500; font-size: 14px;">Open Mission Control</a>
    <p style="margin-top: 32px; color: #94a3b8; font-size: 12px;">— RoboApply</p>
  </div>`;
}

function formatInline(text: string): string {
  // Order matters: escape FIRST, then apply formatting so user content can't
  // sneak HTML into the email.
  const escaped = escapeHtml(text);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
}

export const roboApplyDigestService = {
  composeAndSendDigestForMission,
  composeAndSendDigestsForLocalHour,
  getTodayDigestForUser,
};

export const __test = {
  DIGEST_TARGET_LOCAL_HOUR,
  PER_BATCH_CONCURRENCY,
  buildDigestInput,
  renderDigestEmailHtml,
  formatInline,
  mapTier,
};

export default roboApplyDigestService;
