// server/src/features/auth-cn/index.ts — public surface (FND-5; owner WP-11).

import { NotImplementedError } from '../../platform/http.js';

export * from './contract.js';
export { createAuthCnAdminRouter, createPhoneAuthRouter, createWechatAuthRouter } from './routes.js';

export interface AuthCnService {
  /** True when the user has a verified phone (WeChat users must bind one before AI features). */
  hasBoundPhone(userId: string): Promise<boolean>;
  /** Redeem an invite code at signup (CN_SIGNUP_MODE=invite). */
  redeemInvite(userId: string, code: string): Promise<void>;
}

/** Stub until WP-11. */
export const authCnService: AuthCnService = {
  async hasBoundPhone() {
    throw new NotImplementedError('authCn.hasBoundPhone');
  },
  async redeemInvite() {
    throw new NotImplementedError('authCn.redeemInvite');
  },
};
