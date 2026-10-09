// server/src/features/account-v2/index.ts — public surface (FND-5; owner WP-79).
// The legacy login route calls `twoFactorService.requiresChallenge` (WP-79's challenge hook).

import { NotImplementedError } from '../../platform/http.js';

export * from './contract.js';
export { createStudentRouter, createTwoFactorRouter } from './routes.js';

export interface TwoFactorService {
  requiresChallenge(userId: string): Promise<boolean>;
}

export const twoFactorService: TwoFactorService = {
  async requiresChallenge() {
    throw new NotImplementedError('twoFactor.requiresChallenge');
  },
};
