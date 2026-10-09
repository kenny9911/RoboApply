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
// Components (props contract `AuthMethodProps`):
//   email_password  components/auth/methods/EmailMethod.tsx      WP-10 (stub)
//   google          components/auth/methods/GoogleMethod.tsx     WP-10 (stub)
//   line            components/auth/methods/LineMethod.tsx       WP-10 (stub)
//   phone_otp       components/features/auth-cn/PhoneMethod.tsx  WP-11 (stub: FND-6b)
//   wechat          components/features/auth-cn/WechatMethod.tsx WP-11 (stub: FND-6b)
// All five are wired below already; the stubs render nothing, so the owners
// only fill the component files and never touch this hot file. Until WP-10
// moves login/signup onto useAuthMethods(), those pages keep their current
// form.

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
