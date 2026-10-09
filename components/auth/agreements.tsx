'use client';

// components/auth/agreements.tsx — the state every sign-in method on the
// login/signup page shares (WP-10): the mode, the visitor's signup agreements
// (age, Taiwan PDPA notice, marketing), the carried entry attribution and
// `next`. The page provides it; methods read it, so ticking "I'm 16 or
// older" once covers email, Google and LINE alike (and WP-11's phone/WeChat
// methods can read the same context).

import { createContext, useContext, type ReactNode } from 'react';
import type { ConsentInput, SignupAttribution } from '../../lib/api/auth';

/** Version of the signup agreement wording shown on this page (stored with each consent row). */
export const SIGNUP_PROSE_VERSION = '2026-10-10.signup.v1';

export interface SignupAgreements {
  age: boolean;
  pdpa: boolean;
  marketing: boolean;
  /** The PDPA notice applies (zh-TW locale or a visitor from Taiwan, RoboApply). */
  pdpaRequired: boolean;
}

export interface AuthEntryValue {
  mode: 'login' | 'signup';
  agreements: SignupAgreements | null;
  attribution: SignupAttribution | undefined;
  next: string | null;
  locale: string;
  /** Update the agreements (signup page). */
  setAgreements?: (next: SignupAgreements) => void;
  /** Called when a method needs the agreements but they are not ticked. */
  onAgreementsMissing?: () => void;
}

const AuthEntryContext = createContext<AuthEntryValue | null>(null);

export function AuthEntryProvider({ value, children }: { value: AuthEntryValue; children: ReactNode }) {
  return <AuthEntryContext.Provider value={value}>{children}</AuthEntryContext.Provider>;
}

export function useAuthEntry(): AuthEntryValue | null {
  return useContext(AuthEntryContext);
}

/** True when the required boxes are ticked. */
export function agreementsComplete(a: SignupAgreements | null): boolean {
  return !!a && a.age && (!a.pdpaRequired || a.pdpa);
}

/** The consent rows a signup sends. Marketing travels separately (`marketingOptIn`). */
export function consentsFrom(a: SignupAgreements): ConsentInput[] {
  const rows: ConsentInput[] = [{ type: 'age_16_plus', granted: a.age, proseVersion: SIGNUP_PROSE_VERSION }];
  if (a.pdpaRequired) rows.push({ type: 'tw_pdpa_notice', granted: a.pdpa, proseVersion: SIGNUP_PROSE_VERSION });
  return rows;
}
