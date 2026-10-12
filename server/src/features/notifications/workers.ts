// server/src/features/notifications/workers.ts — the `email.send` worker (owner WP-39a).
//
// server/src/platform/queue/registry.ts (FND-5) imports `workers` from every
// area and registers them; the `queue-drain` cron and request-time kicks run
// them inside `runWithBrand(item.brand)`.
//
// `email.send` delivers one email through the platform `sendEmail` (payload
// `EmailSendPayload`: `{ template, to?, userId?, locale?, params }`):
//   - the address is `to`, else the user's own email; placeholder and
//     `.invalid` addresses are never sent to (GoApply phone/WeChat accounts);
//   - the locale is the payload's, else the person's, else the brand default;
//   - a deactivated or soft-deleted account gets transactional mail only;
//   - non-transactional mail waits out the person's quiet hours (the item is
//     deferred, not failed) and passes the preference gate installed here;
//   - a transport failure retries with backoff; an unknown template or a
//     malformed payload is permanent (`dead` at once).
// Template modules register on import: the notify set is imported here; other
// areas import theirs from their own workers.ts (e.g. compliance).

import { getBrand, isBrandId, type BrandId } from '../../platform/brand/registry.js';
import {
  EMAIL_SEND_KIND,
  getEmailTemplate,
  sendEmail as platformSendEmail,
  type EmailSendPayload,
  type SendEmailInput,
  type SendEmailResult,
} from '../../platform/email/index.js';
import { DeferWorkError, PermanentWorkError, type WorkerDefinition } from '../../platform/queue/index.js';
import {
  deliverableEmail,
  inQuietHours,
  installEmailPreferenceGate,
  isLiveAccount,
  msUntilQuietEnds,
  normalizeQuietHours,
  resolveTimeZone,
  type PreferencesRepo,
  type QuietHours,
} from '../alerts/index.js';
import '../../platform/email/templates/notify/index.js';

export const NOTIFICATIONS_WORK_KINDS = { emailSend: EMAIL_SEND_KIND } as const;

export interface EmailWorkerRecipient {
  /** False for a deactivated or soft-deleted account: only transactional mail still goes out. */
  active: boolean;
  email: string | null;
  locale: string | null;
  timeZone: string;
  quietHours: QuietHours;
}

export interface EmailWorkerDeps {
  /** The person's address, language and quiet hours; null when the account is gone. */
  loadRecipient(userId: string, brand: BrandId): Promise<EmailWorkerRecipient | null>;
  sendEmail(input: SendEmailInput): Promise<SendEmailResult>;
  now?: () => Date;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function parseEmailSendPayload(raw: unknown): EmailSendPayload {
  if (!isObj(raw) || typeof raw.template !== 'string' || !raw.template) throw new PermanentWorkError('email.send: payload needs a template');
  if (raw.params !== undefined && !isObj(raw.params)) throw new PermanentWorkError('email.send: params must be an object');
  const to = typeof raw.to === 'string' && raw.to.trim() ? raw.to.trim() : undefined;
  const userId = typeof raw.userId === 'string' && raw.userId ? raw.userId : null;
  if (!to && !userId) throw new PermanentWorkError('email.send: payload needs `to` or `userId`');
  return {
    template: raw.template,
    to,
    userId,
    locale: typeof raw.locale === 'string' && raw.locale ? raw.locale : null,
    params: (raw.params as Record<string, unknown> | undefined) ?? {},
  };
}

export function createEmailSendWorker(deps: EmailWorkerDeps): WorkerDefinition {
  return {
    kind: EMAIL_SEND_KIND,
    concurrency: 4,
    async handler(item) {
      const payload = parseEmailSendPayload(item.payload);
      const template = getEmailTemplate(payload.template);
      if (!template) throw new PermanentWorkError(`email.send: unknown template "${payload.template}"`);
      const brandId: BrandId = isBrandId(item.brand) ? item.brand : 'roboapply';
      const brand = getBrand(brandId);
      const now = (deps.now ?? (() => new Date()))();

      const recipient = payload.userId ? await deps.loadRecipient(payload.userId, brandId) : null;
      if (payload.userId && !recipient && !payload.to) return; // account deleted since: nothing to send
      // A deactivated or soft-deleted account gets transactional mail only (e.g. the deletion notice).
      if (recipient && !recipient.active && template.category !== 'transactional') return;
      const to = payload.to ?? recipient?.email ?? null;
      if (!to) return; // no deliverable address (e.g. a GoApply phone account): in-app only

      if (template.category !== 'transactional' && recipient && inQuietHours(now, recipient.timeZone, recipient.quietHours)) {
        throw new DeferWorkError(msUntilQuietEnds(now, recipient.timeZone, recipient.quietHours), 'quiet_hours');
      }

      const result = await deps.sendEmail({
        template,
        to,
        userId: payload.userId ?? null,
        locale: payload.locale ?? recipient?.locale ?? null,
        params: payload.params,
        brand,
      });
      if (result.status === 'failed') throw new Error(`email.send: ${String(result.reason ?? 'transport failed')}`);
    },
  };
}

async function db() {
  return (await import('../../lib/prisma.js')).default;
}

export function createPrismaEmailRecipientLoader(prefs?: PreferencesRepo): EmailWorkerDeps['loadRecipient'] {
  return async (userId, brand) => {
    const p = await db();
    const user = await p.user.findUnique({
      where: { id: userId },
      select: {
        isActive: true,
        email: true,
        emailIsPlaceholder: true,
        seekerProfile: { select: { locale: true, timezone: true, notificationPreferences: true, deletedAt: true } },
      },
    });
    if (!user) return null;
    const active = isLiveAccount(user);
    const facts = active && prefs ? await prefs.load(userId) : null;
    const stored = user.seekerProfile?.notificationPreferences;
    const quiet =
      facts?.quietHours ??
      normalizeQuietHours(stored && typeof stored === 'object' && !Array.isArray(stored) ? ((stored as Record<string, unknown>).quietHours as QuietHours) : null);
    return {
      active,
      email: deliverableEmail(user.email, user.emailIsPlaceholder),
      locale: user.seekerProfile?.locale ?? null,
      timeZone: resolveTimeZone(user.seekerProfile?.timezone, brand),
      quietHours: quiet,
    };
  };
}

// The gate decides every non-transactional email (alerts, reminders, tips, product news).
installEmailPreferenceGate();

export const workers: WorkerDefinition[] = [
  createEmailSendWorker({ loadRecipient: createPrismaEmailRecipientLoader(), sendEmail: (input) => platformSendEmail(input) }),
];
