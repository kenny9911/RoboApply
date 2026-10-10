'use client';

// components/auth/methods/registry.ts — which sign-in methods a brand offers,
// in what order, and the component that renders each (FND-6a; ARCHITECTURE.md
// §1.6 `authMethods`; PRODUCT_PLAN.md F-ACCT-01).
//
//   RoboApply  email + password · Google · LINE (Taiwan, V2)
//   GoApply    phone + SMS code · WeChat · email (fallback)
//
// Order = the brand registry's `authMethods`. A method renders only when its
// capability is on (credentials configured; lib/flags.ts fails closed), so a
// method whose keys are missing never shows a dead button. Email + password
// needs no flag: it is the existing method and works everywhere.
//
// Placement: a brand's first methods are shown at once; a method listed in
// SECONDARY_AUTH_METHODS for the brand sits behind a "其他方式 / Other ways to
// sign in" button while another method is available (GoApply: email, behind
// phone and WeChat; PRODUCT_PLAN.md G0 row 6). With nothing else available it
// is shown at once, so the page never opens on an empty card.
//
// Components (props contract `AuthMethodProps`):
//   email_password  components/auth/methods/EmailMethod.tsx      WP-10
//   google          components/auth/methods/GoogleMethod.tsx     WP-10
//   line            components/auth/methods/LineMethod.tsx       WP-10
//   phone_otp       components/features/auth-cn/PhoneMethod.tsx  WP-11
//   wechat          components/features/auth-cn/WechatMethod.tsx WP-11
// Login and signup render them through `useAuthMethods()` (AuthEntryView).

import type { ComponentType } from 'react';

import { PhoneMethod, WechatMethod } from '../../features/auth-cn';
import { useBrand } from '../../../lib/brand/BrandProvider';
import { getBrand, type AuthMethod, type BrandId } from '../../../lib/brand/registry.generated';
import { useCapabilities, type ResolvedFlags } from '../../../lib/flags';
import { EmailMethod } from './EmailMethod';
import { GoogleMethod } from './GoogleMethod';
import { LineMethod } from './LineMethod';

export interface AuthMethodProps {
  mode: 'login' | 'signup';
  /** Same-site path to continue to after success. */
  next?: string | null;
  /** Server start URL for redirect methods (GET /auth/methods), null for forms. */
  startUrl?: string | null;
  onSuccess?: () => void;
}

export interface AuthMethodEntry {
  id: AuthMethod;
  /** 'form' renders in the page; 'redirect' starts an OAuth round trip. */
  kind: 'form' | 'redirect';
  /** Capability check; absent = always available. */
  requires?: (flags: Partial<ResolvedFlags>) => boolean;
  owner: 'auth' | 'auth-cn';
  wp: string;
}

export const AUTH_METHOD_REGISTRY: Record<AuthMethod, AuthMethodEntry> = {
  email_password: { id: 'email_password', kind: 'form', owner: 'auth', wp: 'WP-10' },
  google: { id: 'google', kind: 'redirect', requires: (f) => f['auth.google'] === true, owner: 'auth', wp: 'WP-10' },
  line: { id: 'line', kind: 'redirect', requires: (f) => f['auth.line'] === true, owner: 'auth', wp: 'WP-10' },
  phone_otp: { id: 'phone_otp', kind: 'form', requires: (f) => f['auth.phoneOtp'] === true, owner: 'auth-cn', wp: 'WP-11' },
  wechat: {
    id: 'wechat',
    kind: 'redirect',
    requires: (f) => f['auth.wechatWeb'] === true || f['auth.wechatInApp'] === true,
    owner: 'auth-cn',
    wp: 'WP-11',
  },
};

export const AUTH_METHOD_COMPONENTS: Record<AuthMethod, ComponentType<AuthMethodProps>> = {
  email_password: EmailMethod, // WP-10
  google: GoogleMethod, // WP-10
  line: LineMethod, // WP-10
  phone_otp: PhoneMethod, // WP-11
  wechat: WechatMethod, // WP-11
};

/**
 * Methods a brand keeps behind "Other ways to sign in" while it has another
 * method to show first. GoApply's first methods are the phone code and
 * WeChat; email + password is the fallback.
 */
export const SECONDARY_AUTH_METHODS: Readonly<Record<BrandId, readonly AuthMethod[]>> = {
  roboapply: [],
  goapply: ['email_password'],
};

export interface AuthMethodLayout {
  /** Shown at once, in the brand's order. */
  primary: AuthMethodEntry[];
  /** Behind the "Other ways to sign in" button. */
  secondary: AuthMethodEntry[];
}

/**
 * Pure: split the methods a visitor can use into the ones shown at once and
 * the ones behind "Other ways to sign in". A secondary method moves up when
 * nothing else is available.
 */
export function layoutAuthMethods(brandId: BrandId, methods: readonly AuthMethodEntry[]): AuthMethodLayout {
  const behind = SECONDARY_AUTH_METHODS[brandId] ?? [];
  const primary = methods.filter((m) => !behind.includes(m.id));
  if (primary.length === 0) return { primary: [...methods], secondary: [] };
  return { primary, secondary: methods.filter((m) => behind.includes(m.id)) };
}

/** Pure: the methods a brand shows for these flags, in the brand's order. */
export function authMethodsFor(brandId: BrandId, flags: Partial<ResolvedFlags> | null): AuthMethodEntry[] {
  return getBrand(brandId)
    .authMethods.map((id) => AUTH_METHOD_REGISTRY[id])
    .filter((m) => !m.requires || (flags !== null && m.requires(flags)));
}

/** The methods to render on login/signup for the current brand. */
export function useAuthMethods(): AuthMethodEntry[] {
  const brand = useBrand();
  const { flags } = useCapabilities();
  return authMethodsFor(brand.id, flags);
}
