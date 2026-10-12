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
export {
  CHALLENGE_COOKIE_PATH,
  TWO_FACTOR_PAGE,
  TWO_FACTOR_UNAVAILABLE_CODE,
  TwoFactorChallengeError,
  TwoFactorUnavailableError,
  clearChallengeCookie,
  redirectToTwoFactor,
  sendTwoFactorRequired,
  sendTwoFactorUnavailable,
  setChallengeCookie,
  twoFactorPagePath,
  twoFactorRequiredBody,
} from './challengeResponse.js';
export type { IssuedChallenge, TwoFactorRequiredBody } from './challengeResponse.js';
export { TwoFactorService } from './twoFactor.js';
export type { SecondFactor, SecondFactorResult, TwoFactorDeps } from './twoFactor.js';
export { StudentService, eligibleSchoolDomain } from './student.js';
export type { StudentDeps } from './student.js';

import type { ProductBrand } from '../../platform/brand/registry.js';
import { createPrismaChallengeStore, type ChallengeDb, type LoginChallengeDeps } from './loginChallenge.js';
import { studentServiceInstance, twoFactorServiceInstance } from './routes.js';
import { createPrismaTwoFactorStore } from './store.js';
import { TwoFactorService, defaultTwoFactorDeps } from './twoFactor.js';
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

/** The delegates the sign-in gate touches when it runs on a caller's client. */
export type LoginChallengeDb = ChallengeDb & {
  session: { deleteMany(args: { where: { token: string } }): Promise<unknown> };
  user: { findUnique(args: object): Promise<{ isActive?: boolean | null; seekerProfile?: { deletedAt?: Date | null } | null } | null> };
};

export interface LoginChallengeOverrides {
  /**
   * Run the gate on this database client instead of the shared one (areas
   * whose services take an injected client, e.g. auth-cn; their tests pass
   * the in-memory fake). The two-factor table is read through it too.
   */
  db?: LoginChallengeDb;
  /** Mint the session after the second step (default: `createSeekerSession`). */
  createSession?: (userId: string) => Promise<{ token: string }>;
  now?: () => Date;
}

/** Production collaborators for the sign-in gate (lazy imports keep tests free of the database). */
export function loginChallengeDeps(overrides: LoginChallengeOverrides = {}): LoginChallengeDeps {
  const own = overrides.db;
  const db = async (): Promise<LoginChallengeDb> => own ?? ((await import('../../lib/prisma.js')).default as unknown as LoginChallengeDb);
  return {
    twoFactor: own ? new TwoFactorService({ ...defaultTwoFactorDeps(), store: createPrismaTwoFactorStore(own) }) : twoFactorServiceInstance(),
    challenges: createPrismaChallengeStore(db),
    now: overrides.now ?? (() => new Date()),
    invalidateSession: async (token) => {
      if (own) {
        await own.session.deleteMany({ where: { token } });
        return;
      }
      const { invalidateSeekerSession } = await import('../../roboapply/engine/lib/seekerSession.js');
      await invalidateSeekerSession(token);
    },
    createSession: async (userId) => {
      if (overrides.createSession) return overrides.createSession(userId);
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
