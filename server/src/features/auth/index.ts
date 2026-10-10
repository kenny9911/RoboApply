// server/src/features/auth/index.ts — public surface of the auth area (WP-10).
// Other areas import from here (or contract.ts) only.

import type { AuthMeAdditions, AuthMethodsResponse, ConsentView, IdentityView } from './contract.js';
import { authService } from './service.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { getCurrentBrand } from '../../platform/brand/brandContext.js';

export * from './contract.js';
export { createAccountRouter, createAuthRouter } from './routes.js';
export { AuthError, authErrors } from './errors.js';
export { createAuthFeatureService, onboardingFor, authService } from './service.js';
export type { AuthFeatureServiceImpl, AuthServiceDeps, OAuthSignupContext, SignupRequestContext } from './service.js';
export { signupRequestContext } from './requestContext.js';
export type { GoApplySignupDeps, GoApplySignupPlan } from './goapplySignup.js';

/** The FND-5 interface, now backed by the real service (brand from the current request/unit of work). */
export interface AuthFeatureService {
  listMethods(): Promise<AuthMethodsResponse>;
  /** Builds the additive `/auth/me` fields (brand, onboarding, entitlements, flags, unreadCount, emailVerified). */
  meAdditions(userId: string): Promise<AuthMeAdditions>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, password: string): Promise<{ userId: string }>;
  sendVerificationEmail(userId: string): Promise<void>;
  verifyEmail(token: string): Promise<{ userId: string }>;
  listIdentities(userId: string): Promise<IdentityView[]>;
  unlinkIdentity(userId: string, identityId: string): Promise<void>;
  listConsents(userId: string): Promise<ConsentView[]>;
  recordConsent(userId: string, input: { type: string; granted: boolean; proseVersion: string }): Promise<ConsentView>;
}

const brand = (): ProductBrand => getCurrentBrand();

export const authFeatureService: AuthFeatureService = {
  listMethods: async () => authService.listMethods({ brand: brand() }),
  meAdditions: (userId) => authService.meAdditions(userId, brand()),
  requestPasswordReset: (email) => authService.requestPasswordReset({ email, brand: brand() }),
  resetPassword: async (token, password) => ({ userId: (await authService.resetPassword({ token, password, brand: brand() })).userId }),
  sendVerificationEmail: async (userId) => {
    await authService.sendVerificationEmail({ userId, brand: brand() });
  },
  verifyEmail: async (token) => {
    const res = await authService.verifyEmail({ token, brand: brand() });
    return { userId: res.signIn?.userId ?? '' };
  },
  listIdentities: (userId) => authService.listIdentities(userId),
  unlinkIdentity: async (userId, identityId) => {
    await authService.unlinkIdentity(userId, identityId);
  },
  listConsents: (userId) => authService.listConsents(userId, brand()),
  recordConsent: (userId, input) => authService.recordConsent(userId, brand(), input),
};
