'use client';

// components/v3/shell/signOutCleanup.ts — what this BROWSER must forget when
// an account signs out of it (INT-12; wave-4 carry-over WP-93 #7).
//
// Two things, in this order:
//   1. Web push (WP-61): delete this device's push row and unsubscribe the
//      browser, so alerts for the account that signed out stop arriving on a
//      shared computer. It needs the session, so it runs BEFORE the session
//      cookie is cleared.
//   2. Resume builder (WP-65): remove the unsent builder drafts and their
//      draft photos from localStorage, so the next person at this browser
//      cannot open them. Photos already on a saved resume are NOT cleared
//      (they are keyed by the resume id only its owner can open; clearing
//      them too is an owner decision still pending — pass
//      `{ resumePhotos: true }` to `clearResumeBuilderDeviceData` when made).
//
// It never throws and never holds sign-out back: the push step gives up after
// SIGN_OUT_PUSH_TIMEOUT_MS on its own, and a failure in one step does not skip
// the other.
//
// The two steps are also exported one by one, for the flows whose request can
// still FAIL and leave the user signed in ("Sign out everywhere", deleting the
// account): those forget the push device first (it needs the session), and
// clear the drafts only once the request has worked, so a failed request never
// costs the user their unsent drafts.
//
// Callers:
//   • AvatarMenu "Sign out" — `cleanUpDeviceOnSignOut()`, then the session
//     ends whatever the logout request answers.
//   • Settings "Sign out everywhere" (app/(auth)/settings/page.tsx) and the
//     delete-account modal (components/v3/account/deleteAccountModal.tsx) —
//     `forgetPushOnSignOut()`, the request, then `clearDraftsOnSignOut()` and
//     `leaveSignedOut()` on success.
//   • lib/api/client.ts on `auth_expired` — `lib` may not import `components`
//     or feature hooks, so the app shell registers this function with
//     `registerSessionCleanup` (see `useSessionCleanupRegistration`, mounted by
//     AppShell) and the client runs whatever is registered before it clears
//     the dead session.

import { useEffect } from 'react';

import { forgetPushDeviceOnSignOut } from '../../../hooks/pwa';
import { clearResumeBuilderDeviceData } from '../../../hooks/resume/useResumePhoto';
import { registerSessionCleanup } from '../../../lib/api/client';

/** Step 1 — needs the session, so it runs before the session ends. Never throws. */
export async function forgetPushOnSignOut(): Promise<void> {
  try {
    await forgetPushDeviceOnSignOut();
  } catch {
    // Never blocks sign-out. Unsubscribing is best effort: a row left behind
    // is pruned by the server the first time a push to it fails.
  }
}

/** Step 2 — local only (unsent builder drafts and their draft photos). Never throws. */
export function clearDraftsOnSignOut(): void {
  try {
    clearResumeBuilderDeviceData();
  } catch {
    // Storage unavailable (private mode): nothing was kept there either.
  }
}

/** Both steps, in order. Never throws. */
export async function cleanUpDeviceOnSignOut(): Promise<void> {
  await forgetPushOnSignOut();
  clearDraftsOnSignOut();
}

/**
 * Leave a session that has just ended: drop the localStorage bearer fallback
 * (left in place it would ride along on the next sign-in) and go to /login
 * with a HARD navigation, which is what drops the TanStack cache still holding
 * the previous account's jobs and applications.
 */
export function leaveSignedOut(): void {
  try {
    window.localStorage.removeItem('auth_token');
  } catch {
    // Storage unavailable (private mode): there was no fallback token either.
  }
  window.location.assign('/login');
}

/** Register the cleanup with the API client for the lifetime of the app shell. */
export function useSessionCleanupRegistration(): void {
  useEffect(() => registerSessionCleanup(cleanUpDeviceOnSignOut), []);
}
