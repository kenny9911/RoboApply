// server/src/features/alerts/notify.ts
//
// `notifyUser()` — the one call a reminder producer makes (WP-38 follow-ups
// and interview dates, WP-52 kit not opened / weekly list, WP-58 网申截止,
// later areas). It applies the shared rules and then fans out through
// deliver.ts:
//   - the person exists and belongs to the brand;
//   - the category preference ("Tips and reminders" for `tips`);
//   - quiet hours (21:00–08:00 local, or the person's own): the call answers
//     `deferred` with the time quiet hours end, and the producer tries again
//     on a later run (it must keep its own "already sent" marker until then);
//   - in-app row, email, registered channels.
//
// Producers that prefer the queue can instead write their own
// SeekerNotification and enqueue `email.send` (notifications/workers.ts),
// which applies the same quiet-hours rule by deferring the item.

import type { AlertKind } from './contract.js';
import type { DeliverOutcome, NotifyCategory, NotifyMessage } from './deliver.js';
import { categoryAllowed, type PreferencesRepo } from './preferences.js';
import type { AlertsRepo } from './repo.js';
import { inQuietHours, msUntilQuietEnds } from './time.js';

export interface NotifyUserInput {
  userId: string;
  /** A registered `notify.*` email template (also the in-app templateKey). */
  templateKey: string;
  params: Record<string, unknown>;
  /** In-app deep link. */
  href: string | null;
  category: NotifyCategory;
  kind?: AlertKind;
  relatedEntity?: { type: string; id: string } | null;
  /** Expected brand (default: the person's own). A mismatch is skipped. */
  brand?: 'roboapply' | 'goapply';
  now?: Date;
}

export type NotifyUserResult =
  | { status: 'delivered'; outcome: DeliverOutcome }
  | { status: 'deferred'; retryAt: Date }
  | { status: 'skipped'; reason: 'no_user' | 'other_brand' | 'preference_off' };

export interface NotifyUserDeps {
  repo: Pick<AlertsRepo, 'recipients'>;
  prefs: PreferencesRepo;
  deliver(msg: NotifyMessage): Promise<DeliverOutcome>;
}

export async function notifyUserWith(input: NotifyUserInput, deps: NotifyUserDeps): Promise<NotifyUserResult> {
  const now = input.now ?? new Date();
  const recipient = (await deps.repo.recipients([input.userId])).get(input.userId);
  if (!recipient) return { status: 'skipped', reason: 'no_user' };
  if (input.brand && recipient.brand !== input.brand) return { status: 'skipped', reason: 'other_brand' };
  const facts = await deps.prefs.load(input.userId);
  if (!facts) return { status: 'skipped', reason: 'no_user' };
  if (!categoryAllowed(facts, input.category)) return { status: 'skipped', reason: 'preference_off' };
  if (inQuietHours(now, facts.timeZone, facts.quietHours)) {
    return { status: 'deferred', retryAt: new Date(now.getTime() + msUntilQuietEnds(now, facts.timeZone, facts.quietHours)) };
  }
  const outcome = await deps.deliver({
    recipient,
    kind: input.kind ?? 'reminder',
    category: input.category,
    templateKey: input.templateKey,
    params: input.params,
    href: input.href,
    relatedEntity: input.relatedEntity ?? null,
    prefs: facts.prefs,
  });
  return { status: 'delivered', outcome };
}
