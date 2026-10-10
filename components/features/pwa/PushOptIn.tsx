'use client';

// PushOptIn — "Get alerts on this device" (F-NOTIF-07; WP-61; ARCHITECTURE.md §8.4).
//
// The ONLY place the browser's notification permission is requested, and
// only when the person clicks the button. Renders nothing when web push is
// off for the brand (`webPush`; always off on GoApply), when the browser
// cannot do push, or when the server has no VAPID keys (no UI entry for a
// missing capability). Turning it on also adds "This device" to the job-alert
// and reminder channels in the notification settings (WP-39b), so alerts
// mirror to push; turning it off removes only this device.
//
// "Alerts are on" is shown only when BOTH halves worked: the device is
// subscribed AND "This device" is in the person's alert/reminder channels.
// When the settings cannot carry push (preferences unavailable, 'push' not in
// `availableChannels`, no configurable alert/reminder category), nothing is
// asked of the browser and the error shows. When saving the channels fails
// after subscribing, the new subscription is removed again and the error shows.
//
// Meant for /settings#notifications next to the channel switches (see the
// WP-61 handoff's request to WP-39b's owner); also usable after a person sets
// up a job alert.

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Btn } from '../../v3/primitives/Btn';
import { toast } from '../../v3/primitives/Toast';
import { useFlag } from '../../../lib/flags';
import { useNotificationPreferences, usePatchNotificationPreferences } from '../../../hooks/notifications';
import { usePushSubscription } from '../../../hooks/pwa';
import type { NotificationCategory, NotificationChannel, NotificationPreferencesView } from '../../../lib/api/contracts/notifications';
import styles from './pwa.module.css';

/** Categories that get "This device" when the person opts in. */
export const PUSH_OPT_IN_CATEGORIES: readonly NotificationCategory[] = ['alert', 'reminder'];

/**
 * The channel patch that adds "This device" to the opt-in categories, or null
 * when the settings cannot carry push (then alerts would never arrive, so the
 * opt-in must not claim they are on). An empty patch means push is already chosen.
 */
export function pushChannelPatch(view: NotificationPreferencesView | null | undefined): Partial<Record<NotificationCategory, NotificationChannel[]>> | null {
  if (!view || !view.availableChannels.includes('push')) return null;
  const cats = PUSH_OPT_IN_CATEGORIES.filter((cat) => view.configurableCategories.includes(cat));
  if (!cats.length) return null;
  const channels: Partial<Record<NotificationCategory, NotificationChannel[]>> = {};
  for (const cat of cats) {
    const current = view.channels[cat] ?? ['in_app'];
    if (!current.includes('push')) channels[cat] = [...current, 'push'];
  }
  return channels;
}

export function PushOptIn({ className }: { className?: string }) {
  const t = useTranslations('pwa.push');
  const webPush = useFlag('webPush');
  const device = usePushSubscription({ enabled: webPush });
  const prefs = useNotificationPreferences({ enabled: webPush && device.available });
  const patch = usePatchNotificationPreferences();
  const [failed, setFailed] = useState<'failed' | 'unavailable' | null>(null);
  const [saving, setSaving] = useState(false);
  // The click handler awaits the browser; read the newest settings afterwards.
  const latest = useRef(prefs.data);
  latest.current = prefs.data;

  if (!webPush || device.status === 'unsupported' || device.status === 'checking' || !device.available) return null;

  const onEnable = async () => {
    setFailed(null);
    setSaving(true);
    try {
      // 1. Can the settings carry "This device"? If not, do not even ask the browser.
      let view = latest.current;
      if (!view) {
        try {
          view = (await prefs.refetch()).data;
        } catch {
          view = undefined;
        }
      }
      const channels = pushChannelPatch(view);
      if (!channels) {
        setFailed('unavailable');
        return;
      }
      // 2. Subscribe this device (asks the browser's permission).
      if (!(await device.enable())) return;
      // 3. Add push to the channels; undo the subscription when that fails.
      if (Object.keys(channels).length) {
        try {
          await patch.mutateAsync({ channels });
        } catch {
          await device.disable();
          setFailed('failed');
          return;
        }
      }
      toast({ message: t('turnedOn'), tone: 'ok' });
    } finally {
      setSaving(false);
    }
  };
  const onDisable = async () => {
    setFailed(null);
    await device.disable();
    toast({ message: t('turnedOff'), tone: 'ok' });
  };

  const on = device.status === 'on';
  const busy = device.pending || saving;
  return (
    <section className={[styles.card, className].filter(Boolean).join(' ')} aria-labelledby="pwa-push-title" data-testid="push-opt-in">
      <div className={styles.cardText}>
        <h3 id="pwa-push-title" className={styles.cardTitle}>
          {t('title')}
        </h3>
        <p className={styles.text}>{device.status === 'blocked' ? t('blocked') : on ? t('onBody') : t('offBody')}</p>
        {device.error || failed ? (
          <p className={styles.error} role="alert">
            {failed === 'unavailable' ? t('unavailable') : t('failed')}
          </p>
        ) : null}
      </div>
      {device.status === 'blocked' ? null : (
        <div className={styles.cardAction}>
          {on ? (
            <Btn onClick={() => void onDisable()} disabled={busy} aria-busy={busy}>
              {busy ? t('working') : t('disable')}
            </Btn>
          ) : (
            <Btn variant="primary" onClick={() => void onEnable()} disabled={busy} aria-busy={busy}>
              {busy ? t('working') : t('enable')}
            </Btn>
          )}
        </div>
      )}
    </section>
  );
}

export default PushOptIn;
