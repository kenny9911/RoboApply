// server/src/features/auth-cn/services.ts — wires the area services with their
// defaults (Prisma, the SMS platform, DB rate limits, fetch). Routes take an
// optional `Partial<AuthCnServices>` so tests inject fakes.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { getBrand, parseBrandId } from '../../platform/brand/registry.js';
import { createSmsService, type FetchLike } from '../../platform/sms/index.js';
import { loginChallengeDeps, type LoginChallengeDb } from '../account-v2/index.js';
import { defaultSessionIssuer, type SessionIssuer, type SignInGate } from './accounts.js';
import { defaultAccountHooks, type AccountHooks } from './hooks.js';
import { defaultAuthCnDb, type AuthCnDb } from './db.js';
import { createInviteService, type InviteService } from './inviteService.js';
import { createOtpService, defaultConsume, otpSecret, type ConsumeFn, type OtpService } from './otpService.js';
import { createPhoneAuthService, type PhoneAuthService } from './phoneAuthService.js';
import { createWechatAuthService, type WechatAuthService } from './wechatAuthService.js';

export interface AuthCnServices {
  db: AuthCnDb;
  otp: OtpService;
  phone: PhoneAuthService;
  wechat: WechatAuthService;
  invites: InviteService;
  issueSession: SessionIssuer;
  /** Second-factor gate for every session these routes mint (runs on the same database). */
  signInGate: SignInGate;
  env: EnvSource;
}

export interface AuthCnServiceOptions {
  db?: AuthCnDb;
  env?: EnvSource;
  now?: () => Date;
  fetch?: FetchLike;
  consume?: ConsumeFn;
  sms?: Parameters<typeof createOtpService>[0]['sms'];
  issueSession?: SessionIssuer;
  signInGate?: SignInGate;
  /**
   * Growth and credit seams around account creation, phone binding and
   * WeChat linking (hooks.ts). Default: the production seams, unless a
   * database was injected — then none run (a test's fake database is not
   * the one those seams write to); such a caller passes its own hooks.
   */
  hooks?: AccountHooks;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export function createAuthCnServices(options: AuthCnServiceOptions = {}): AuthCnServices {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const db = options.db ?? defaultAuthCnDb();
  const fetchFn = options.fetch ?? defaultFetch;
  const consume = options.consume ?? defaultConsume();
  const otp = createOtpService({
    db,
    sms: options.sms ?? createSmsService({ env, fetch: fetchFn, now }),
    consume,
    now,
    env,
    secret: () => otpSecret(env),
    brandName: (brand) => getBrand(parseBrandId(brand) ?? 'goapply').name,
  });
  const hooks = options.hooks ?? (options.db ? undefined : defaultAccountHooks());
  const issueSession = options.issueSession ?? defaultSessionIssuer;
  return {
    db,
    otp,
    phone: createPhoneAuthService({ db, otp, env, now, consume, hooks }),
    wechat: createWechatAuthService({ db, env, now, fetch: fetchFn, hooks }),
    invites: createInviteService({ db, now }),
    issueSession,
    signInGate:
      options.signInGate ??
      (() => loginChallengeDeps({ db: db as unknown as LoginChallengeDb, createSession: issueSession, now })),
    env,
  };
}
