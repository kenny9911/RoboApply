// server/src/features/auth/index.ts — public surface of the auth area (FND-5; owner WP-10).

import { NotImplementedError } from '../../platform/http.js';
import type { AuthMeAdditions, AuthMethodsResponse, ConsentView, IdentityView } from './contract.js';

export * from './contract.js';
export { createAccountRouter, createAuthRouter } from './routes.js';

export interface AuthFeatureService {
  listMethods(): Promise<AuthMethodsResponse>;
  /** Builds the additive `/auth/me` fields (brand, onboarding, entitlements, flags, unreadCount). */
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

const notYet = (what: string) => async (): Promise<never> => {
  throw new NotImplementedError(`auth.${what}`);
};

/** Stub until WP-10. */
export const authFeatureService: AuthFeatureService = {
  listMethods: notYet('listMethods'),
  meAdditions: notYet('meAdditions'),
  requestPasswordReset: notYet('requestPasswordReset'),
  resetPassword: notYet('resetPassword'),
  sendVerificationEmail: notYet('sendVerificationEmail'),
  verifyEmail: notYet('verifyEmail'),
  listIdentities: notYet('listIdentities'),
  unlinkIdentity: notYet('unlinkIdentity'),
  listConsents: notYet('listConsents'),
  recordConsent: notYet('recordConsent'),
};
