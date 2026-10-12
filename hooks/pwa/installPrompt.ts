// hooks/pwa/installPrompt.ts — pure rules of the PWA install prompt (F-MOB-03; WP-61).
//
// "Install prompt once, after the second session; no app-download modal":
//   - a session is a browser session (sessionStorage marker); the count lives
//     in localStorage (a per-device convenience; installing is per device);
//   - the prompt is eligible from the second session on, only when the
//     browser can install (a captured `beforeinstallprompt`, or iOS Safari's
//     manual "Add to Home Screen"), never when already running installed,
//     never inside WeChat (its webview cannot install; WP-11 owns that
//     guidance), and only if it was never shown before — on this device
//     (localStorage) or on the account (ui-state dismissal `pwa.installPrompt`).
// Every storage access is wrapped: private windows and blocked storage just
// mean no prompt.

export const PWA_SESSION_COUNT_KEY = 'ra_pwa_sessions';
export const PWA_SESSION_MARK_KEY = 'ra_pwa_session';
export const PWA_INSTALL_SHOWN_KEY = 'ra_pwa_install_shown';
/** ui-state dismissal key recorded when the prompt is shown (any answer). */
export const PWA_INSTALL_DISMISSAL = 'pwa.installPrompt';
/** Sessions before the prompt may show. */
export const PWA_MIN_SESSIONS = 2;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeGet(store: KeyValueStore | null, key: string): string | null {
  try {
    return store ? store.getItem(key) : null;
  } catch {
    return null;
  }
}

function safeSet(store: KeyValueStore | null, key: string, value: string): boolean {
  try {
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Count this browser session once (idempotent within a session) and return
 * the total. Returns 0 when storage is unavailable (no prompt then).
 */
export function countSession(local: KeyValueStore | null, session: KeyValueStore | null): number {
  const current = Number(safeGet(local, PWA_SESSION_COUNT_KEY));
  const count = Number.isFinite(current) && current > 0 ? Math.floor(current) : 0;
  if (safeGet(session, PWA_SESSION_MARK_KEY)) return count;
  if (!safeSet(session, PWA_SESSION_MARK_KEY, '1')) return count;
  const next = count + 1;
  return safeSet(local, PWA_SESSION_COUNT_KEY, String(next)) ? next : count;
}

export function shownOnDevice(local: KeyValueStore | null): boolean {
  return Boolean(safeGet(local, PWA_INSTALL_SHOWN_KEY));
}

export function markShownOnDevice(local: KeyValueStore | null, at: Date = new Date()): void {
  safeSet(local, PWA_INSTALL_SHOWN_KEY, at.toISOString());
}

export type InstallPlatform = 'prompt' | 'ios' | null;

export interface InstallEnvironment {
  userAgent: string;
  /** `display-mode: standalone` or iOS `navigator.standalone`. */
  standalone: boolean;
  /** A `beforeinstallprompt` event was captured. */
  promptAvailable: boolean;
}

export function isWeChat(userAgent: string): boolean {
  return /MicroMessenger/i.test(userAgent);
}

/** iOS / iPadOS Safari (not Chrome/Firefox/Edge on iOS, which cannot add to the home screen the same way). */
export function isIosSafari(userAgent: string): boolean {
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && /Mobile\//i.test(userAgent));
  return ios && /Safari/i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|MicroMessenger/i.test(userAgent);
}

/** How this browser can install, or null. */
export function installPlatform(env: InstallEnvironment): InstallPlatform {
  if (env.standalone || isWeChat(env.userAgent)) return null;
  if (env.promptAvailable) return 'prompt';
  if (isIosSafari(env.userAgent)) return 'ios';
  return null;
}

export interface InstallEligibility {
  sessions: number;
  platform: InstallPlatform;
  shownOnDevice: boolean;
  /** The account already saw it (ui-state dismissal), or null while unknown. */
  shownOnAccount: boolean | null;
}

export function installPromptEligible(e: InstallEligibility): boolean {
  return e.sessions >= PWA_MIN_SESSIONS && e.platform !== null && !e.shownOnDevice && e.shownOnAccount === false;
}
