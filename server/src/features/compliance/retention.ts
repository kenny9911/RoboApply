// server/src/features/compliance/retention.ts
//
// The retention schedule (PRODUCT_PLAN.md F-TRUST-06; TASK_PLAN.md WP-13, H30).
// One table drives three things, so they cannot drift apart:
//   1. the deletions compliance-daily runs (`runRetention`),
//   2. the schedule printed in both privacy notices ({{retention_schedule}}),
//   3. the schedule shown in Settings → Privacy (GET /compliance/retention).
//
// Every row says who enforces it. Rows enforced elsewhere name the job
// (account-purge for closed accounts); `provider` rows are infrastructure
// settings (database backups — the period comes from BACKUP_RETENTION_DAYS and
// renders "Not listed" until ops sets it); `not_automated` rows are published
// commitments whose automation is not built yet — they are listed honestly,
// never claimed as automatic. Practice interview recordings are
// 'interview-retention': WP-63a's `runInterviewRetention`, run by compliance-daily
// (flipped at the Wave 4 gate). 'tools-purge' is features/tools/cron.ts
// (`runToolsPurge`, in jobs-maintain and hourly in reminders) and
// 'visitor-alerts' is features/visitor/digest.ts (`runAnonAlertDigests`, in
// job-alerts): retention.test.ts runs both jobs against the published periods.
// 'kept_minimum' rows are not deletions — the period is the least time a
// record is kept (billing consent records, 3 years); the same test proves no
// rule here touches them.
//
// Deletions are brand-scoped (each cron run is inside one brand), batched,
// and return quickly when nothing is due (cost guard, FND-3).

import prisma from '../../lib/prisma.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { BrandId } from '../../platform/brand/registry.js';
import type { Budget } from '../../platform/queue/index.js';
import { DATA_EXPORT_TTL_DAYS, type RetentionRuleView } from './contract.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RETENTION_BATCH = 500;
/** Max batches per rule per run, so one backlog cannot eat the whole budget. */
export const RETENTION_MAX_BATCHES = 20;

export type RetentionDb = Pick<
  typeof prisma,
  | 'rACopilotMessage'
  | 'rAJobInteraction'
  | 'rAFeedSession'
  | 'rAProductEvent'
  | 'rAApplicationArtifact'
  | 'rAAuthToken'
  | 'rAPhoneOtp'
  | 'rAAiContentLabelLog'
  | 'rAContentSafetyEvent'
  | 'rAResumeVariant'
  | 'rACoverLetter'
  | 'rATrackerEntry'
  | 'rACopilotMemory'
>;

export interface RetentionRunContext {
  db: RetentionDb;
  brand: BrandId;
  now: Date;
  budget?: Pick<Budget, 'remainingMs'>;
}

export interface RetentionRule extends RetentionRuleView {
  /** Records the rule covers (for the notice and the tests). */
  covers: string;
  /** Period read from configuration (rows whose period we do not set ourselves); null → "Not listed". */
  keepFromEnv?: (env: EnvSource) => RetentionRuleView['keep'];
  /** Deletes what is due; returns rows deleted (and rows held back, if any). */
  run?: (ctx: RetentionRunContext) => Promise<{ deleted: number; blocked?: number }>;
}

type Keep = NonNullable<RetentionRuleView['keep']>;

/**
 * Cutoff for "keep N <unit>" at `now`. Months are calendar months (UTC); the
 * day is clamped to the target month's last day, so 31 March minus one month
 * is 28/29 February — never an early 3 March.
 */
export function retentionCutoff(keep: Keep, now: Date): Date {
  if (keep.unit === 'hours') return new Date(now.getTime() - keep.amount * HOUR_MS);
  if (keep.unit === 'days') return new Date(now.getTime() - keep.amount * DAY_MS);
  const monthIndex = now.getUTCFullYear() * 12 + now.getUTCMonth() - keep.amount;
  const year = Math.floor(monthIndex / 12);
  const month = monthIndex - year * 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds()),
  );
}

/** Repeated find-ids → delete-by-ids, bounded by batches and the budget. */
async function deleteInBatches(
  ctx: RetentionRunContext,
  findIds: (take: number) => Promise<Array<{ id: string }>>,
  deleteIds: (ids: string[]) => Promise<{ count: number }>,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < RETENTION_MAX_BATCHES; i += 1) {
    if (ctx.budget && ctx.budget.remainingMs() < 5_000) break;
    const rows = await findIds(RETENTION_BATCH);
    if (rows.length === 0) break;
    const { count } = await deleteIds(rows.map((r) => r.id));
    deleted += count;
    if (rows.length < RETENTION_BATCH) break;
  }
  return deleted;
}

/**
 * Deletes the stored file of an application artifact. The exporter that
 * writes `RAApplicationArtifact.storageKey` (WP-36b) registers it; until then
 * rows that still point at a stored file are held back (never orphaned).
 */
export type ArtifactStorageDeleter = (row: { id: string; storageKey: string; userId: string }) => Promise<boolean>;
let artifactStorageDeleter: ArtifactStorageDeleter | null = null;

/** Extension point for WP-36b (TASK_PLAN.md §2.1 rule 3). */
export function registerArtifactStorageDeleter(fn: ArtifactStorageDeleter | null): void {
  artifactStorageDeleter = fn;
}

/**
 * Deletes the stored original of a resume (RAResumeVariant.originalFileKey).
 * Default: the resume-original object store; tests inject a fake. A `false`
 * result holds the row back so the file is never orphaned.
 */
export type ResumeOriginalDeleter = (ref: { provider: string | null; key: string; fileName: string | null; mimeType: string | null }) => Promise<boolean>;
const defaultResumeOriginalDeleter: ResumeOriginalDeleter = async (ref) => {
  const { resumeOriginalFileStorageService: s } = await import('../../services/ResumeOriginalFileStorageService.js');
  return s.deleteFile(ref);
};
let resumeOriginalDeleter: ResumeOriginalDeleter = defaultResumeOriginalDeleter;

/** Tests only: replace (or with null, restore) the resume-original deleter. */
export function setResumeOriginalDeleterForTests(fn: ResumeOriginalDeleter | null): void {
  resumeOriginalDeleter = fn ?? defaultResumeOriginalDeleter;
}

/** Soft-deleted rows (deletedAt set) are hard-deleted this long after deletion. */
export const SOFT_DELETE_KEEP: Keep = { amount: 30, unit: 'days' };

/**
 * Hard-delete rows the user deleted (deletedAt) more than 30 days ago, for one
 * brand: cover letters, tracker entries, Assistant memories, then resumes.
 * Resumes: the stored original goes first (row held back if that fails); a
 * resume a live cover letter still uses is held back too, because deleting it
 * would cascade-delete that cover letter (RACoverLetter.resumeVariantId).
 */
async function runSoftDeletedRows(ctx: RetentionRunContext): Promise<{ deleted: number; blocked?: number }> {
  const cutoff = retentionCutoff(SOFT_DELETE_KEEP, ctx.now);
  const due = { deletedAt: { lt: cutoff }, user: { brand: ctx.brand } };
  let deleted = 0;
  deleted += await deleteInBatches(
    ctx,
    (take) => ctx.db.rACoverLetter.findMany({ where: due, select: { id: true }, take }),
    (ids) => ctx.db.rACoverLetter.deleteMany({ where: { id: { in: ids } } }),
  );
  deleted += await deleteInBatches(
    ctx,
    (take) => ctx.db.rATrackerEntry.findMany({ where: due, select: { id: true }, take }),
    (ids) => ctx.db.rATrackerEntry.deleteMany({ where: { id: { in: ids } } }),
  );
  deleted += await deleteInBatches(
    ctx,
    (take) => ctx.db.rACopilotMemory.findMany({ where: due, select: { id: true }, take }),
    (ids) => ctx.db.rACopilotMemory.deleteMany({ where: { id: { in: ids } } }),
  );

  // Resumes with no stored original and no live cover letter go in batches.
  deleted += await deleteInBatches(
    ctx,
    (take) =>
      ctx.db.rAResumeVariant.findMany({
        where: { ...due, originalFileKey: null, coverLetters: { none: { deletedAt: null } } },
        select: { id: true },
        take,
      }),
    (ids) => ctx.db.rAResumeVariant.deleteMany({ where: { id: { in: ids } } }),
  );
  // Resumes with a stored original: file first, then the row.
  let blocked = 0;
  const stored = await ctx.db.rAResumeVariant.findMany({
    where: { ...due, originalFileKey: { not: null }, coverLetters: { none: { deletedAt: null } } },
    select: { id: true, originalFileProvider: true, originalFileKey: true, originalFileName: true, originalFileMimeType: true },
    take: RETENTION_BATCH,
  });
  for (const row of stored) {
    if (ctx.budget && ctx.budget.remainingMs() < 5_000) break;
    let ok = false;
    try {
      ok = row.originalFileKey
        ? await resumeOriginalDeleter({ provider: row.originalFileProvider, key: row.originalFileKey, fileName: row.originalFileName, mimeType: row.originalFileMimeType })
        : false;
    } catch {
      ok = false;
    }
    if (!ok) {
      blocked += 1;
      continue;
    }
    const { count } = await ctx.db.rAResumeVariant.deleteMany({ where: { id: row.id } });
    deleted += count;
  }
  // Resumes a live cover letter still uses: counted as held back.
  blocked += await ctx.db.rAResumeVariant.count({ where: { ...due, coverLetters: { some: { deletedAt: null } } } });
  return blocked ? { deleted, blocked } : { deleted };
}

/**
 * `RAJobInteraction.kind` values the 13-month rule leaves alone: admin review
 * decisions (WP-74) are an operator record about a posting, not the user's
 * activity; they are read by the admin console until RAJobReview replaces them.
 */
export const JOB_INTERACTION_KINDS_KEPT: readonly string[] = ['admin_review'];

/** `RAAuthToken.kind` of a known sign-in device mark (features/auth/tokens.ts AUTH_TOKEN_KINDS.knownDevice). */
export const KNOWN_DEVICE_TOKEN_KIND = 'known_device';
/** A mark lives this long after the last sign-in from that device (TOKEN_TTL_MS.known_device; a test keeps them equal). */
export const KNOWN_DEVICE_KEEP: Keep = { amount: 90, unit: 'days' };

/** Consent types that record a purchase term the user accepted; kept at least `BILLING_CONSENT_KEEP`. */
export const BILLING_CONSENT_TYPES: readonly string[] = ['auto_renew_ack', 'withdrawal_waiver', 'cn_pay_terms_ack'];
export const BILLING_CONSENT_KEEP: Keep = { amount: 36, unit: 'months' };

/** BACKUP_RETENTION_DAYS (the provider's point-in-time history window); unset or invalid → null ("Not listed"). */
export function backupRetentionFromEnv(env: EnvSource): RetentionRuleView['keep'] {
  const raw = env.BACKUP_RETENTION_DAYS?.trim();
  if (!raw || !/^\d{1,4}$/.test(raw)) return null;
  const amount = Number(raw);
  return amount > 0 ? { amount, unit: 'days' } : null;
}

const keep = (amount: number, unit: Keep['unit']): Keep => ({ amount, unit });

/** The published schedule, in notice order. */
export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    id: 'assistant_messages',
    covers: 'RACopilotMessage',
    keep: keep(12, 'months'),
    enforcedBy: 'compliance-daily',
    run: async (ctx) => {
      const where = { createdAt: { lt: retentionCutoff(keep(12, 'months'), ctx.now) }, thread: { user: { brand: ctx.brand } } };
      const deleted = await deleteInBatches(
        ctx,
        (take) => ctx.db.rACopilotMessage.findMany({ where, select: { id: true }, take }),
        (ids) => ctx.db.rACopilotMessage.deleteMany({ where: { id: { in: ids } } }),
      );
      return { deleted };
    },
  },
  {
    id: 'job_interactions',
    covers: "RAJobInteraction (every kind except 'admin_review')",
    keep: keep(13, 'months'),
    enforcedBy: 'compliance-daily',
    run: async (ctx) => {
      const where = {
        createdAt: { lt: retentionCutoff(keep(13, 'months'), ctx.now) },
        kind: { notIn: [...JOB_INTERACTION_KINDS_KEPT] },
        user: { brand: ctx.brand },
      };
      const deleted = await deleteInBatches(
        ctx,
        (take) => ctx.db.rAJobInteraction.findMany({ where, select: { id: true }, take }),
        (ids) => ctx.db.rAJobInteraction.deleteMany({ where: { id: { in: ids } } }),
      );
      return { deleted };
    },
  },
  {
    id: 'feed_impressions',
    covers: 'RAFeedSession',
    keep: keep(13, 'months'),
    enforcedBy: 'compliance-daily',
    run: async (ctx) => {
      const where = { createdAt: { lt: retentionCutoff(keep(13, 'months'), ctx.now) }, user: { brand: ctx.brand } };
      const deleted = await deleteInBatches(
        ctx,
        (take) => ctx.db.rAFeedSession.findMany({ where, select: { id: true }, take }),
        (ids) => ctx.db.rAFeedSession.deleteMany({ where: { id: { in: ids } } }),
      );
      return { deleted };
    },
  },
  {
    id: 'product_events',
    covers: 'RAProductEvent',
    keep: keep(13, 'months'),
    enforcedBy: 'compliance-daily',
    run: async (ctx) => {
      const where = { brand: ctx.brand, createdAt: { lt: retentionCutoff(keep(13, 'months'), ctx.now) } };
      const deleted = await deleteInBatches(
        ctx,
        (take) => ctx.db.rAProductEvent.findMany({ where, select: { id: true }, take }),
        (ids) => ctx.db.rAProductEvent.deleteMany({ where: { id: { in: ids } } }),
      );
      return { deleted };
    },
  },
  { id: 'closed_accounts', covers: 'User (+ cascades) after account deletion', keep: keep(30, 'days'), enforcedBy: 'account-purge' },
  {
    id: 'soft_deleted_rows',
    covers: 'RAResumeVariant (+ stored original), RACoverLetter, RATrackerEntry, RACopilotMemory with deletedAt set',
    keep: SOFT_DELETE_KEEP,
    enforcedBy: 'compliance-daily',
    run: runSoftDeletedRows,
  },
  {
    id: 'application_artifacts',
    covers: 'RAApplicationArtifact',
    keep: keep(180, 'days'),
    enforcedBy: 'compliance-daily',
    run: async (ctx) => {
      const cutoff = retentionCutoff(keep(180, 'days'), ctx.now);
      // Rows with no stored file go at once.
      const plain = { createdAt: { lt: cutoff }, storageKey: null, user: { brand: ctx.brand } };
      let deleted = await deleteInBatches(
        ctx,
        (take) => ctx.db.rAApplicationArtifact.findMany({ where: plain, select: { id: true }, take }),
        (ids) => ctx.db.rAApplicationArtifact.deleteMany({ where: { id: { in: ids } } }),
      );
      // Rows with a stored file: file first, then the row (never orphan the file).
      const stored = await ctx.db.rAApplicationArtifact.findMany({
        where: { createdAt: { lt: cutoff }, storageKey: { not: null }, user: { brand: ctx.brand } },
        select: { id: true, storageKey: true, userId: true },
        take: RETENTION_BATCH,
      });
      let blocked = 0;
      for (const row of stored) {
        const ok = artifactStorageDeleter && row.storageKey ? await artifactStorageDeleter({ id: row.id, storageKey: row.storageKey, userId: row.userId }) : false;
        if (!ok) {
          blocked += 1;
          continue;
        }
        const { count } = await ctx.db.rAApplicationArtifact.deleteMany({ where: { id: row.id } });
        deleted += count;
      }
      return { deleted, blocked };
    },
  },
  { id: 'inactive_accounts', covers: 'Accounts with no sign-in for 24 months, after a 30-day notice email', keep: keep(24, 'months'), enforcedBy: 'not_automated' },
  {
    id: 'auth_tokens',
    covers: 'RAAuthToken, RAPhoneOtp',
    keep: keep(24, 'hours'),
    enforcedBy: 'compliance-daily',
    run: async (ctx) => {
      // Kept until 24 hours after they expire.
      const cutoff = retentionCutoff(keep(24, 'hours'), ctx.now);
      const tokens = await deleteInBatches(
        ctx,
        (take) => ctx.db.rAAuthToken.findMany({ where: { brand: ctx.brand, expiresAt: { lt: cutoff } }, select: { id: true }, take }),
        (ids) => ctx.db.rAAuthToken.deleteMany({ where: { id: { in: ids } } }),
      );
      const otps = await deleteInBatches(
        ctx,
        (take) => ctx.db.rAPhoneOtp.findMany({ where: { brand: ctx.brand, expiresAt: { lt: cutoff } }, select: { id: true }, take }),
        (ids) => ctx.db.rAPhoneOtp.deleteMany({ where: { id: { in: ids } } }),
      );
      return { deleted: tokens + otps };
    },
  },
  {
    // The mark's `expiresAt` is the last sign-in from that device + 90 days:
    // every sign-in from a known device moves it (features/auth/service.ts
    // registerDevice). Deleted here as soon as that moment has passed, not
    // 24 hours later with the other tokens.
    id: 'known_devices',
    covers: "RAAuthToken kind 'known_device': sha256 of account × browser × OS, plus the browser and OS names",
    keep: KNOWN_DEVICE_KEEP,
    enforcedBy: 'compliance-daily',
    run: async (ctx) => {
      const where = { brand: ctx.brand, kind: KNOWN_DEVICE_TOKEN_KIND, expiresAt: { lte: ctx.now } };
      const deleted = await deleteInBatches(
        ctx,
        (take) => ctx.db.rAAuthToken.findMany({ where, select: { id: true }, take }),
        (ids) => ctx.db.rAAuthToken.deleteMany({ where: { id: { in: ids } } }),
      );
      return { deleted };
    },
  },
  {
    id: 'ai_label_logs',
    covers: 'RAAiContentLabelLog',
    keep: keep(180, 'days'),
    enforcedBy: 'compliance-daily',
    run: async (ctx) => {
      const where = { brand: ctx.brand, createdAt: { lt: retentionCutoff(keep(180, 'days'), ctx.now) } };
      const deleted = await deleteInBatches(
        ctx,
        (take) => ctx.db.rAAiContentLabelLog.findMany({ where, select: { id: true }, take }),
        (ids) => ctx.db.rAAiContentLabelLog.deleteMany({ where: { id: { in: ids } } }),
      );
      return { deleted };
    },
  },
  {
    id: 'content_safety_events',
    covers: 'RAContentSafetyEvent',
    keep: keep(180, 'days'),
    enforcedBy: 'compliance-daily',
    run: async (ctx) => {
      const where = { brand: ctx.brand, createdAt: { lt: retentionCutoff(keep(180, 'days'), ctx.now) } };
      const deleted = await deleteInBatches(
        ctx,
        (take) => ctx.db.rAContentSafetyEvent.findMany({ where, select: { id: true }, take }),
        (ids) => ctx.db.rAContentSafetyEvent.deleteMany({ where: { id: { in: ids } } }),
      );
      return { deleted };
    },
  },
  // Enforced by WP-63a's runInterviewRetention (features/interview/cron.ts),
  // which compliance-daily runs per brand (INTERVIEW_RETENTION_DAYS, default
  // and cap 90). Flipped from 'not_automated' at the Wave 4 gate (WP-63a R4).
  { id: 'interview_recordings', covers: 'Practice interview recordings and transcripts', keep: keep(90, 'days'), enforcedBy: 'interview-retention' },
  // Free tools (WP-57): the cached report and the text read from the visitor's
  // file. `runToolsPurge` deletes the row once its 24 h have passed (TOOLS_LIMITS.cacheHours).
  { id: 'tool_results', covers: "RAAuthToken kinds 'tool_result' / 'tool_result_alias' (free-tool results)", keep: keep(24, 'hours'), enforcedBy: 'tools-purge' },
  // Signed-out job alerts (WP-78): `runAnonAlertDigests` purges both on every run.
  {
    id: 'anon_alerts_unconfirmed',
    covers: 'RAAnonAlertSubscription status pending, counted from the last confirm link sent',
    keep: keep(72, 'hours'),
    enforcedBy: 'visitor-alerts',
  },
  {
    id: 'anon_alerts_unsubscribed',
    covers: 'RAAnonAlertSubscription status unsubscribed (with the address), counted from the unsubscribe',
    keep: keep(30, 'days'),
    enforcedBy: 'visitor-alerts',
  },
  // A minimum, not a deletion: nothing in this file reads or deletes
  // SeekerConsentRecord (RetentionDb has no delegate for it). The records go
  // only with the account (closed_accounts).
  {
    id: 'billing_consent_records',
    covers: `SeekerConsentRecord of type ${BILLING_CONSENT_TYPES.join(' / ')} (checkout and plan switch)`,
    keep: BILLING_CONSENT_KEEP,
    enforcedBy: 'kept_minimum',
  },
  // Data export files: deleted by compliance-daily's export sweep (dataExport.ts).
  { id: 'data_exports', covers: 'Data export files', keep: keep(DATA_EXPORT_TTL_DAYS, 'days'), enforcedBy: 'compliance-daily' },
  // The database provider's history window, as ops configured it (not assumed).
  { id: 'backups', covers: 'Database backups', keep: null, keepFromEnv: backupRetentionFromEnv, enforcedBy: 'provider' },
];

/** The public view (no implementation details); periods set by configuration are read from `env`. */
export function retentionSchedule(env: EnvSource = process.env): RetentionRuleView[] {
  return RETENTION_RULES.map(({ id, keep: k, keepFromEnv, enforcedBy }) => {
    const resolved = keepFromEnv ? keepFromEnv(env) : k;
    return { id, keep: resolved ? { ...resolved } : null, enforcedBy };
  });
}

export interface RetentionRunResult {
  deleted: Record<string, number>;
  blocked: Record<string, number>;
  total: number;
}

/** Run every rule this cron enforces, for one brand. Errors in one rule do not stop the others. */
export async function runRetention(ctx: RetentionRunContext, log: (msg: string, meta: Record<string, unknown>) => void = () => {}): Promise<RetentionRunResult> {
  const result: RetentionRunResult = { deleted: {}, blocked: {}, total: 0 };
  for (const rule of RETENTION_RULES) {
    if (!rule.run) continue;
    if (ctx.budget && ctx.budget.remainingMs() < 5_000) break;
    try {
      const out = await rule.run(ctx);
      if (out.deleted) result.deleted[rule.id] = out.deleted;
      if (out.blocked) result.blocked[rule.id] = out.blocked;
      result.total += out.deleted;
    } catch (err) {
      log('retention rule failed', { rule: rule.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

const UNIT_ZH = { hours: '小时', days: '天', months: '个月' } as const;

/** Markdown table of the schedule for the privacy notices ({{retention_schedule}}). */
export function retentionScheduleMarkdown(locale: 'en' | 'zh', env: EnvSource = process.env): string {
  const rowsEn: Record<string, string> = {
    assistant_messages: 'Assistant conversations',
    job_interactions: 'Job views, saves and other interactions',
    feed_impressions: 'Job lists shown to you',
    product_events: 'Product usage events',
    closed_accounts: 'Account data after you delete your account',
    soft_deleted_rows: 'Resumes, cover letters, tracked jobs and Assistant memories you delete',
    application_artifacts: 'Copies of files used for applications',
    inactive_accounts: 'Accounts with no sign-in (after a 30-day notice email)',
    auth_tokens: 'Sign-in codes and links, after they expire',
    known_devices: 'Devices you signed in from (a hash of account, browser and system, plus their names), after the last sign-in from that device',
    ai_label_logs: 'AI content label records',
    content_safety_events: 'Content safety check records',
    interview_recordings: 'Practice interview recordings and transcripts',
    tool_results: 'Free tool results (the report and the text read from your file)',
    anon_alerts_unconfirmed: 'Job alert sign-ups you did not confirm, after the last confirmation link',
    anon_alerts_unsubscribed: 'Job alerts you unsubscribed from without an account (with the email address)',
    billing_consent_records: 'Records that you agreed to a plan renewing automatically or to purchase terms (kept at least this long while you have an account)',
    data_exports: 'Data export files',
    backups: 'Database backups',
  };
  const rowsZh: Record<string, string> = {
    assistant_messages: '求职助手对话',
    job_interactions: '职位浏览、收藏等操作记录',
    feed_impressions: '向你展示的职位列表',
    product_events: '产品使用事件',
    closed_accounts: '注销账户后的账户数据',
    soft_deleted_rows: '你删除的简历、求职信、跟踪的职位和求职助手记忆',
    application_artifacts: '投递所用文件的副本',
    inactive_accounts: '长期未登录的账户（提前 30 天邮件通知）',
    auth_tokens: '验证码和登录链接（过期后）',
    known_devices: '你登录过的设备（账户、浏览器和系统的哈希值，以及浏览器和系统名称），自该设备最后一次登录起',
    ai_label_logs: 'AI 生成内容标识记录',
    content_safety_events: '内容安全检查记录',
    interview_recordings: '面试练习录音和文字记录',
    tool_results: '免费工具的结果（报告和从你的文件中读取的文字）',
    anon_alerts_unconfirmed: '未确认的职位提醒订阅（自最后一封确认邮件起）',
    anon_alerts_unsubscribed: '未登录时订阅、已退订的职位提醒（含邮箱地址）',
    billing_consent_records: '你同意自动续费或购买条款的记录（账户存续期间至少保存这么久）',
    data_exports: '数据导出文件',
    backups: '数据库备份',
  };
  const unitEn = (k: Keep) => `${k.amount} ${k.amount === 1 ? k.unit.replace(/s$/, '') : k.unit}`;
  const schedule = retentionSchedule(env);
  if (locale === 'zh') {
    const lines = ['| 数据 | 保存期限 |', '| --- | --- |'];
    for (const r of schedule) lines.push(`| ${rowsZh[r.id] ?? r.id} | ${r.keep ? `${r.keep.amount} ${UNIT_ZH[r.keep.unit]}` : '未披露'} |`);
    return lines.join('\n');
  }
  const lines = ['| Data | Kept for |', '| --- | --- |'];
  for (const r of schedule) lines.push(`| ${rowsEn[r.id] ?? r.id} | ${r.keep ? unitEn(r.keep) : 'Not listed'} |`);
  return lines.join('\n');
}
