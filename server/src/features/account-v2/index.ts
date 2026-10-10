// server/src/features/account-v2/index.ts — public surface (owner WP-79).
//
//   twoFactorService.requiresChallenge(userId)   is two-step sign-in on for this user?
//   gateSessionForSignIn / startLoginChallenge   call right after a sign-in path minted a session
//   completeLoginChallenge                       the second step (POST /auth/login/2fa)
//   loginChallengeDeps()                         production collaborators for the two above
//   studentService.isVerified(userId)            checkout seam for the student plans
//   SIGN_IN_PATHS / totpAvailability             which sign-in paths run the check (readiness.ts)

export * from './contract.js';
export { createStudentRouter, createTwoFactorRouter, studentServiceInstance, twoFactorServiceInstance } from './routes.js';
export type { AccountV2RouterDeps } from './routes.js';
export { SIGN_IN_PATHS, totpAvailability } from './readiness.js';
export type { SignInPath, TotpAvailability, TotpUnavailableReason } from './readiness.js';
export {
  CHALLENGE_COOKIE,
  CHALLENGE_KIND,
  completeLoginChallenge,
  createMemoryChallengeStore,
  createPrismaChallengeStore,
  gateSessionForSignIn,
  hashChallengeToken,
  startLoginChallenge,
} from './loginChallenge.js';
export type { ChallengeStore, CompletedSignIn, GateOutcome, LoginChallengeDeps } from './loginChallenge.js';
export { TwoFactorService } from './twoFactor.js';
export type { SecondFactor, SecondFactorResult, TwoFactorDeps } from './twoFactor.js';
export { StudentService, eligibleSchoolDomain } from './student.js';
export type { StudentDeps } from './student.js';

import type { ProductBrand } from '../../platform/brand/registry.js';
import { createPrismaChallengeStore, type LoginChallengeDeps } from './loginChallenge.js';
import { studentServiceInstance, twoFactorServiceInstance } from './routes.js';
import type { SecondFactor, SecondFactorResult } from './twoFactor.js';

export interface TwoFactorSeam {
  requiresChallenge(userId: string): Promise<boolean>;
  checkSecondFactor(userId: string, brand: ProductBrand, factor: SecondFactor): Promise<SecondFactorResult>;
}

export const twoFactorService: TwoFactorSeam = {
  requiresChallenge: (userId) => twoFactorServiceInstance().requiresChallenge(userId),
  checkSecondFactor: (userId, brand, factor) => twoFactorServiceInstance().checkSecondFactor(userId, brand, factor),
};

export const studentService = {
  isVerified: (userId: string): Promise<boolean> => studentServiceInstance().isVerified(userId),
};

/** Production collaborators for the sign-in gate (lazy imports keep tests free of the database). */
export function loginChallengeDeps(): LoginChallengeDeps {
  const db = async () => (await import('../../lib/prisma.js')).default;
  return {
    twoFactor: twoFactorServiceInstance(),
    challenges: createPrismaChallengeStore(db),
    now: () => new Date(),
    invalidateSession: async (token) => {
      const { invalidateSeekerSession } = await import('../../roboapply/engine/lib/seekerSession.js');
      await invalidateSeekerSession(token);
    },
    createSession: async (userId) => {
      const { createSeekerSession } = await import('../../roboapply/engine/lib/seekerSession.js');
      return createSeekerSession(userId);
    },
    accountAllowed: async (userId) => {
      const prisma = await db();
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { isActive: true, seekerProfile: { select: { deletedAt: true } } } });
      return Boolean(user && user.isActive !== false && !user.seekerProfile?.deletedAt);
    },
    userAttemptAllowed: async (userId) => {
      const { consumeRateLimit, rateLimitKey, rateLimitWindows } = await import('../../platform/ratelimit/index.js');
      const r = await consumeRateLimit({ key: rateLimitKey('totpLoginPerUser', 'user', userId), windows: rateLimitWindows('totpLoginPerUser') });
      return r.allowed;
    },
  };
}
