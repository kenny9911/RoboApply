// server/src/features/alerts/index.ts — public surface of alerts, reminders and delivery (FND-5; owner WP-39a).
//
// Extension points (TASK_PLAN.md §2.1 rule 3):
//   - `registerDeliveryChannel(id, impl)`: WP-61 (web push) and WP-73 (WeChat
//     公众号) add channels after WP-39a's wave. Every alert, reminder and
//     lifecycle message goes in-app first, then email, then each registered
//     channel serving the brand (deliver.ts).
//   - `registerReminderProducer({ name, task, markets })`: reminder producers
//     for the hourly `reminders` runner (`runReminders`).
//   - `notifyUser(input)`: what a producer calls to send one reminder (quiet
//     hours, "Tips and reminders", in-app + email + channels).
// Email templates: `server/src/platform/email/templates/notify/` (`NOTIFY_TEMPLATES`).

import type { DeliveryChannel, DeliveryChannelId } from './contract.js';
import type { NotifyUserInput, NotifyUserResult } from './notify.js';

export * from './contract.js';
export { createAlertsRouter } from './routes.js';
export { createJobAlertsTask, jobCard } from './service.js';
export type { JobAlertsDeps } from './service.js';
export { defaultDeliverDeps, deliverMessage, inAppCopy } from './deliver.js';
export type { DeliverDeps, DeliverOutcome, InAppRow, NotifyCategory, NotifyMessage } from './deliver.js';
export { notifyUserWith } from './notify.js';
export type { NotifyUserDeps, NotifyUserInput, NotifyUserResult } from './notify.js';
export { createRemindersRunner, registerReminderProducer, reminderProducers, resetReminderProducersForTests, runReminders } from './reminders.js';
export type { ReminderProducer } from './reminders.js';
export {
  TIPS_DEFAULT_OFF_COUNTRIES,
  categoryAllowed,
  channelAllowed,
  createEmailPreferenceGate,
  createPrismaPreferencesRepo,
  installEmailPreferenceGate,
  isLiveAccount,
  parseStoredPrefs,
  tipsEnabled,
  tipsRemindersDefault,
} from './preferences.js';
export type { PreferenceFacts, PreferencesRepo, StoredNotificationPrefs } from './preferences.js';
export { createPrismaAlertsRepo, deliverableEmail } from './repo.js';
export type { AlertProfileRow, AlertsRepo, JobCardRow, Recipient } from './repo.js';
export { instantAllowance, selectAlertJobs } from './selection.js';
export {
  DEFAULT_QUIET_HOURS,
  digestDue,
  inQuietHours,
  localDayKey,
  normalizeQuietHours,
  localTime,
  msUntilQuietEnds,
  resolveTimeZone,
  startOfLocalDay,
} from './time.js';
export type { QuietHours } from './time.js';
export { NOTIFY_TEMPLATES } from '../../platform/email/templates/notify/index.js';

const channels = new Map<string, DeliveryChannel>();

/** Register (or replace with the same impl) a delivery channel. A different impl for a taken id throws. */
export function registerDeliveryChannel(id: DeliveryChannelId, impl: DeliveryChannel): void {
  if (impl.id !== id) throw new Error(`alerts: channel id mismatch ("${id}" vs "${impl.id}")`);
  const existing = channels.get(id);
  if (existing && existing !== impl) throw new Error(`alerts: a delivery channel "${id}" is already registered`);
  channels.set(id, impl);
}

/** Registered channels, optionally only those serving a brand. */
export function deliveryChannels(brand?: 'roboapply' | 'goapply'): DeliveryChannel[] {
  const all = [...channels.values()];
  return brand ? all.filter((c) => c.brands.includes(brand)) : all;
}

/** Test seam. */
export function resetDeliveryChannelsForTests(): void {
  channels.clear();
}

/** Send one reminder or notice to a person (see notify.ts). Production wiring; lazy so importing opens no pool. */
export async function notifyUser(input: NotifyUserInput): Promise<NotifyUserResult> {
  const [{ notifyUserWith }, { createPrismaAlertsRepo }, { createPrismaPreferencesRepo }, deliverMod] = await Promise.all([
    import('./notify.js'),
    import('./repo.js'),
    import('./preferences.js'),
    import('./deliver.js'),
    import('../../platform/email/templates/notify/index.js'),
  ]);
  const deliverDeps = deliverMod.defaultDeliverDeps((b) => deliveryChannels(b.id));
  return notifyUserWith(input, {
    repo: createPrismaAlertsRepo(),
    prefs: createPrismaPreferencesRepo(),
    deliver: (msg) => deliverMod.deliverMessage(msg, deliverDeps),
  });
}
