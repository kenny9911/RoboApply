// server/src/features/auth-cn/index.ts — public surface (FND-5; filled by WP-11).
//
// Other areas import auth-cn only from here:
//   - `authCnService.hasBoundPhone(userId)` / `phoneBindingRequired(userId)`
//   - `assertPhoneBound(userId)` and the `requirePhoneBound()` gate for AI
//     routes (403 phone_binding_required for WeChat accounts without a phone)
//   - email signup in invite mode (WP-10): `isInviteRedeemable(brand, code)`
//     for early feedback, then `redeemInviteInTx(tx, brand, code)` INSIDE the
//     transaction that creates the User (a failed redemption rolls the
//     account back; the last use of a code cannot be spent twice)
//   - `goapplySignupOpen(env)` / `cnSignupMode(env)` / `requiredSignupConsents(env)`

import type { BrandId } from '../../platform/brand/registry.js';
import { parseBrandId } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { defaultAuthCnDb } from './db.js';
import { createInviteService, redeemInviteIn, type InviteTx } from './inviteService.js';
import { hasBoundPhone } from './phoneBinding.js';

export * from './contract.js';
export { createAuthCnAdminRouter, createPhoneAuthRouter, createWechatAuthRouter } from './routes.js';
export { AuthCnError } from './errors.js';
export { assertPhoneBound, hasBoundPhone, phoneBindingRequired, requirePhoneBound } from './phoneBinding.js';
export { cnSignupMode, goapplySignupOpen, isCn0, requiredSignupConsents, requiredSignupConsentsWithProse } from './signupPolicy.js';
export { isPlaceholderEmail, PLACEHOLDER_EMAIL_DOMAIN } from './accounts.js';
export { redeemInviteIn, type InviteTx } from './inviteService.js';

export interface AuthCnService {
  /** True when the user has a verified phone (WeChat users must bind one before AI features). */
  hasBoundPhone(userId: string): Promise<boolean>;
  /**
   * Spend one use of an invite code inside the caller's transaction (the one
   * that creates the User). Signup MUST use this. Throws AuthCnError('invite_invalid').
   */
  redeemInviteInTx(tx: InviteTx, brand: BrandId, code: string): Promise<void>;
  /**
   * @deprecated for signup: runs in its own transaction AFTER the account
   * exists, so two signups racing for the last use both get accounts. Use
   * `redeemInviteInTx` in the account-creation transaction instead. Kept for
   * the Foundation seam signature only. Throws AuthCnError('invite_invalid').
   */
  redeemInvite(userId: string, code: string): Promise<void>;
  /** Read-only: would this code work on this brand now? (validate before creating the account). */
  isInviteRedeemable(brand: BrandId, code: string): Promise<boolean>;
}

const invites = () => createInviteService({ db: defaultAuthCnDb(), now: () => new Date() });

export const authCnService: AuthCnService = {
  hasBoundPhone: (userId) => hasBoundPhone(userId),
  async redeemInviteInTx(tx, brand, code) {
    await redeemInviteIn(tx, brand, code, new Date());
  },
  async redeemInvite(userId, code) {
    const user = await defaultAuthCnDb().user.findUnique({ where: { id: userId }, select: { brand: true } });
    const brand = parseBrandId(user?.brand);
    if (!brand) throw new HttpError('not_found', 'User not found.');
    await invites().redeem(brand, code);
  },
  isInviteRedeemable: (brand, code) => invites().isRedeemable(brand, code),
};
