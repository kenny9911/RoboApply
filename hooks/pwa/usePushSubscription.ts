'use client';

// hooks/pwa/usePushSubscription.ts — "Get alerts on this device" (F-NOTIF-07; WP-61).
//
//   const device = usePushSubscription();
//   device.enable()   ← ONLY from a click: asks the browser's permission,
//                       registers public/sw.js, subscribes with the VAPID key
//                       and stores the subscription (POST /push/subscriptions)
//   device.disable()  ← unsubscribes here and deletes the server row
//
// On mount it only LOOKS: an existing registration's subscription, the
// current permission and — when the browser has a subscription — whether the
// server row for that endpoint belongs to the signed-in account
// (POST /push/subscriptions/lookup). "on" needs all three. A browser still
// holding another account's subscription (shared device) or one the server
// pruned after repeated failures reads as "off", so a click re-claims it
// through the subscribe upsert. It never requests permission and never
// registers the service worker on load (ARCHITECTURE.md §8.4).
//
// `forgetPushDeviceOnSignOut()` is for the sign-out flow: it deletes this
// device's row (when it is the signed-in account's) and unsubscribes the
// browser, so a signed-out account stops getting alerts on a shared device.

import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { createPushSubscription, deletePushSubscription, getVapidPublicKey, lookupPushSubscription } from '../../lib/api/push';
import { RoboApiError } from '../../lib/api/client';

export const PUSH_SW_URL = '/sw.js';
export const PUSH_SUBSCRIPTION_ID_KEY = 'ra_push_subscription_id';
export const VAPID_QUERY_KEY = ['push', 'vapid-public-key'] as const;

export type PushPermission = 'default' | 'granted' | 'denied';
export type PushDeviceStatus = 'unsupported' | 'checking' | 'off' | 'on' | 'blocked';

export interface PushDevice {
  status: PushDeviceStatus;
  /** The server has VAPID keys (false hides the opt-in: no UI entry for a missing capability). */
  available: boolean;
  pending: boolean;
  error: 'failed' | null;
  enable(): Promise<boolean>;
  disable(): Promise<void>;
}

/** VAPID public key (URL-safe base64) → the bytes `applicationServerKey` wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normal = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normal);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** A short device label for the settings list ("Chrome on macOS"); no full user-agent string is stored. */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';
  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent)
      ? 'iOS'
      : /Mac OS X|Macintosh/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function permission(): PushPermission {
  try {
    return (window.Notification?.permission as PushPermission) ?? 'default';
  } catch {
    return 'default';
  }
}

function readId(): string | null {
  try {
    return window.localStorage.getItem(PUSH_SUBSCRIPTION_ID_KEY);
  } catch {
    return null;
  }
}

function writeId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(PUSH_SUBSCRIPTION_ID_KEY, id);
    else window.localStorage.removeItem(PUSH_SUBSCRIPTION_ID_KEY);
  } catch {
    /* blocked storage: disable() re-reads the id from the server */
  }
}

async function existingSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

/** The signed-in account's row id for this browser's subscription, or null (not theirs, or pruned). */
async function ownedSubscriptionId(sub: PushSubscription, signal?: AbortSignal): Promise<string | null> {
  const { subscription } = await lookupPushSubscription({ endpoint: sub.endpoint }, { signal });
  return subscription ? subscription.id : null;
}

/** Delete the signed-in account's row for `sub` (a 404 means it is already gone). */
async function deleteOwnRow(sub: PushSubscription | null): Promise<void> {
  let id = readId();
  if (!id && sub) id = await ownedSubscriptionId(sub);
  if (!id) return;
  try {
    await deletePushSubscription(id);
  } catch (err) {
    if (!(err instanceof RoboApiError && err.status === 404)) throw err;
  }
}

/** How long sign-out waits for the device clean-up before it goes ahead anyway. */
export const SIGN_OUT_PUSH_TIMEOUT_MS = 3000;

/**
 * For the sign-out flow (call BEFORE the session is cleared): removes this
 * device's server row when it belongs to the signed-in account and
 * unsubscribes the browser, so alerts for the account that signed out stop
 * arriving on this (possibly shared) device. Never throws and never waits
 * longer than `SIGN_OUT_PUSH_TIMEOUT_MS`; it does nothing when the browser
 * has no push subscription. Unsubscribing in the browser alone already stops
 * delivery: the push service then answers 404/410 and the server prunes the row.
 */
export async function forgetPushDeviceOnSignOut(): Promise<void> {
  if (!pushSupported()) return;
  const work = (async () => {
    const sub = await existingSubscription();
    if (!sub) {
      writeId(null);
      return;
    }
    try {
      await deleteOwnRow(sub);
    } catch {
      /* the browser unsubscribe below still stops delivery */
    }
    writeId(null);
    await sub.unsubscribe();
  })().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SIGN_OUT_PUSH_TIMEOUT_MS);
  });
  await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);
}

function subscriptionBody(sub: PushSubscription) {
  const json = sub.toJSON();
  return {
    endpoint: json.endpoint ?? sub.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    userAgent: deviceLabel(navigator.userAgent ?? ''),
  };
}

export function usePushSubscription({ enabled = true }: { enabled?: boolean } = {}): PushDevice {
  const supported = enabled && pushSupported();
  const [status, setStatus] = useState<PushDeviceStatus>(supported ? 'checking' : 'unsupported');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<'failed' | null>(null);

  const vapid = useQuery({
    queryKey: VAPID_QUERY_KEY,
    queryFn: ({ signal }) => getVapidPublicKey({ signal }),
    enabled: supported,
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    if (!supported) {
      setStatus('unsupported');
      return undefined;
    }
    let live = true;
    const abort = new AbortController();
    void (async () => {
      try {
        const sub = await existingSubscription();
        if (!live) return;
        if (permission() === 'denied') {
          setStatus('blocked');
          return;
        }
        if (!sub || permission() !== 'granted') {
          setStatus('off');
          return;
        }
        // The browser has a subscription; "on" only when the server row is
        // this account's (not another account's on a shared device, not pruned).
        const id = await ownedSubscriptionId(sub, abort.signal);
        if (!live) return;
        writeId(id);
        setStatus(id ? 'on' : 'off');
      } catch {
        if (live) setStatus('off');
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
  }, [supported]);

  const enable = useCallback(async () => {
    if (!supported || !vapid.data) return false;
    setPending(true);
    setError(null);
    try {
      const answer = await window.Notification.requestPermission();
      if (answer !== 'granted') {
        setStatus(answer === 'denied' ? 'blocked' : 'off');
        return false;
      }
      const reg = await navigator.serviceWorker.register(PUSH_SW_URL, { scope: '/' });
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapid.data.publicKey) }));
      const view = await createPushSubscription(subscriptionBody(sub));
      writeId(view.id);
      setStatus('on');
      return true;
    } catch {
      setError('failed');
      return false;
    } finally {
      setPending(false);
    }
  }, [supported, vapid.data]);

  const disable = useCallback(async () => {
    if (!supported) return;
    setPending(true);
    setError(null);
    try {
      const sub = await existingSubscription();
      // The id is remembered on this device; otherwise the lookup finds this
      // account's row for the endpoint (nothing is re-registered to find it).
      await deleteOwnRow(sub);
      writeId(null);
      if (sub) await sub.unsubscribe();
      setStatus('off');
    } catch {
      setError('failed');
    } finally {
      setPending(false);
    }
  }, [supported]);

  return { status, available: Boolean(vapid.data), pending, error, enable, disable };
}
