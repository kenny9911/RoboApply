// server/src/features/account-v2/twoFactor.ts
//
// Seeker two-factor sign-in with an authenticator app (F-TRUST-07, V2).
//
//   status        enabled / pending / recovery codes left / whether it can be turned on here
//   enrol         a new secret (shown once, as a QR code and as text); not trusted yet
//   verify        the first code confirms enrolment → 10 recovery codes, shown once;
//                 every other session of the user is signed out
//   disable       needs a current code or a recovery code
//   regenerate    new recovery codes (the old ones stop working); needs a current code
//   requiresChallenge / checkSecondFactor   the sign-in hook (loginChallenge.ts)
//
// Enrolment opens only when `totpAvailability` says every sign-in path runs
// the check (readiness.ts). A user who already has it on keeps it on whatever
// the configuration: the challenge never switches itself off. Recovery codes
// work without the sealing key, so a lost key never locks anyone out for good.
//
// Key (sealing.ts): GoApply seals with `CN_TOTP_ENCRYPTION_KEY` when set, else
// with the shared `TOTP_ENCRYPTION_KEY`, and opens a stored secret with either,
// so adding a CN key later locks nobody out.

import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { HttpError, type ErrorCode } from '../../platform/http.js';
import type { TotpEnrolResponse, TotpVerifyResponse, TwoFactorStatus } from './contract.js';
import { ACCOUNT_V2_ERROR_CODES } from './contract.js';
import { totpAvailability, type SignInPath } from './readiness.js';
import { SealError, seal, totpKey, totpKeys, unsealWithAny } from './sealing.js';
import { StoreUnavailableError, createPrismaTwoFactorStore, type TwoFactorRow, type TwoFactorStore } from './store.js';
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, matchRecoveryCode, otpauthUri, verifyTotp } from './totp.js';

export interface TwoFactorDeps {
  store: TwoFactorStore;
  env: () => EnvSource;
  now: () => Date;
  /** Signs out every other session of the user (after turning two-factor on or off). */
  revokeOtherSessions: (userId: string, keepSessionToken: string | null) => Promise<void>;
  /**
   * Ends every bearer JWT issued before `at` (`User.tokensValidAfter`; the
   * auth middleware rejects older tokens). Called when two-step sign-in is
   * turned on and when it is turned off, next to the session sign-out: a
   * 7-day JWT taken before the change must not keep working. Optional so a
   * caller that builds the service by hand keeps compiling; production
   * (`defaultTwoFactorDeps`) always sets it.
   */
  cutOffBearerTokens?: (userId: string, at: Date) => Promise<void>;
  /** PNG data URL of a QR code for `text`, or null when it cannot be drawn (the text secret still works). */
  qrDataUrl: (text: string) => Promise<string | null>;
  /** The sign-in paths readiness checks (default SIGN_IN_PATHS; tests pass a fully gated list). */
  signInPaths?: readonly SignInPath[];
}

export type SecondFactor = { code: string; recoveryCode?: undefined } | { recoveryCode: string; code?: undefined };

export type SecondFactorResult = { ok: true; method: 'totp' | 'recovery'; recoveryCodesLeft: number } | { ok: false };

function fail(code: ErrorCode, reason: string, message: string): HttpError {
  return new HttpError(code, message, { reason });
}

function storageError(): HttpError {
  return new HttpError('storage_unavailable', 'Two-step sign-in is not available yet.', { reason: 'storage_unavailable' });
}

async function defaultQrDataUrl(text: string): Promise<string | null> {
  try {
    const mod = (await import('qrcode')) as unknown as { default?: { toDataURL: QrFn }; toDataURL?: QrFn };
    const toDataURL = mod.default?.toDataURL ?? mod.toDataURL;
    return toDataURL ? await toDataURL(text, { errorCorrectionLevel: 'M', margin: 1, width: 240 }) : null;
  } catch {
    return null;
  }
}
type QrFn = (text: string, options: Record<string, unknown>) => Promise<string>;

async function defaultRevokeOtherSessions(userId: string, keep: string | null): Promise<void> {
  const { default: prisma } = await import('../../lib/prisma.js');
  await prisma.session.deleteMany({ where: { userId, ...(keep ? { token: { not: keep } } : {}) } });
}

async function defaultCutOffBearerTokens(userId: string, at: Date): Promise<void> {
  const { default: prisma } = await import('../../lib/prisma.js');
  await prisma.user.update({ where: { id: userId }, data: { tokensValidAfter: at }, select: { id: true } });
}

export function defaultTwoFactorDeps(): TwoFactorDeps {
  return {
    store: createPrismaTwoFactorStore(),
    env: () => process.env,
    now: () => new Date(),
    revokeOtherSessions: defaultRevokeOtherSessions,
    cutOffBearerTokens: defaultCutOffBearerTokens,
    qrDataUrl: defaultQrDataUrl,
  };
}

export class TwoFactorService {
  constructor(private readonly d: TwoFactorDeps) {}

  private enabled(row: TwoFactorRow | null): row is TwoFactorRow & { enabledAt: Date } {
    return Boolean(row?.enabledAt);
  }

  private async load(userId: string): Promise<TwoFactorRow | null> {
    if (!this.d.store.available()) throw storageError();
    return this.d.store.find(userId);
  }

  async status(userId: string, brand: ProductBrand): Promise<TwoFactorStatus> {
    const storeAvailable = this.d.store.available();
    const availability = totpAvailability(brand, { env: this.d.env(), storeAvailable, paths: this.d.signInPaths });
    const row = storeAvailable ? await this.d.store.find(userId) : null;
    const on = this.enabled(row);
    return {
      enabled: on,
      enrolledAt: on ? row.enabledAt.toISOString() : null,
      recoveryCodesLeft: on ? row.recoveryCodeHashes.length : 0,
      pending: Boolean(row && !row.enabledAt),
      available: availability.available,
    };
  }

  async enrol(userId: string, brand: ProductBrand, accountLabel: string): Promise<TotpEnrolResponse> {
    const availability = totpAvailability(brand, { env: this.d.env(), storeAvailable: this.d.store.available(), paths: this.d.signInPaths });
    if (!availability.available) {
      if (availability.reason === 'storage_unavailable') throw storageError();
      throw fail('provider_not_configured', ACCOUNT_V2_ERROR_CODES.notAvailable, 'Two-step sign-in cannot be turned on yet.');
    }
    const existing = await this.load(userId);
    if (this.enabled(existing)) throw fail('conflict', ACCOUNT_V2_ERROR_CODES.alreadyEnabled, 'Two-step sign-in is already on.');
    const key = totpKey(brand.id, this.d.env())!;
    const secret = generateTotpSecret();
    await this.d.store.upsertPending({ userId, brand: brand.id, secretSealed: seal(secret, key, userId) });
    const uri = otpauthUri({ issuer: brand.name, account: accountLabel, secret });
    return { otpauthUri: uri, secret, qrDataUrl: await this.d.qrDataUrl(uri) };
  }

  private openSecret(row: TwoFactorRow, brand: ProductBrand): string {
    // Every key the brand may have sealed with: GoApply's own key, then the
    // shared one. A secret sealed before a CN key was added still opens.
    const keys = totpKeys(brand.id, this.d.env());
    if (!keys.length) throw fail('provider_not_configured', ACCOUNT_V2_ERROR_CODES.keyMissing, 'Codes cannot be checked right now. Use a recovery code.');
    try {
      return unsealWithAny(row.secretSealed, keys, row.userId);
    } catch (err) {
      if (err instanceof SealError) {
        throw fail('provider_not_configured', ACCOUNT_V2_ERROR_CODES.keyMissing, 'Codes cannot be checked right now. Use a recovery code.');
      }
      throw err;
    }
  }

  /** Confirms enrolment with the first code; returns the recovery codes (shown once). */
  async verify(userId: string, brand: ProductBrand, code: string, sessionToken: string | null): Promise<TotpVerifyResponse> {
    const row = await this.load(userId);
    if (!row) throw fail('conflict', ACCOUNT_V2_ERROR_CODES.notEnrolled, 'Start setting up two-step sign-in first.');
    if (this.enabled(row)) throw fail('conflict', ACCOUNT_V2_ERROR_CODES.alreadyEnabled, 'Two-step sign-in is already on.');
    const step = verifyTotp(this.openSecret(row, brand), code, this.d.now(), null);
    if (step === null) throw fail('invalid_request', ACCOUNT_V2_ERROR_CODES.totpInvalid, 'That code did not work. Check the time on your phone and try the newest code.');
    const recoveryCodes = generateRecoveryCodes();
    const at = this.d.now();
    // Older bearer JWTs end first: if that write fails nothing has been
    // turned on, and the person simply tries the code again.
    await this.cutOffBearerTokens(userId, at);
    await this.d.store.enable(userId, { enabledAt: at, lastUsedStep: step, recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode) });
    await this.d.revokeOtherSessions(userId, sessionToken);
    return { recoveryCodes };
  }

  /**
   * Every bearer JWT issued before `at` stops working. Runs when two-step
   * sign-in is turned on or off, before the change itself is stored, so a
   * failure here leaves the setting as it was.
   */
  private async cutOffBearerTokens(userId: string, at: Date): Promise<void> {
    if (this.d.cutOffBearerTokens) await this.d.cutOffBearerTokens(userId, at);
  }

  /** True when signing in needs a second factor. Missing table = nobody has it on. */
  async requiresChallenge(userId: string): Promise<boolean> {
    if (!this.d.store.available()) return false;
    return this.enabled(await this.d.store.find(userId));
  }

  /**
   * Checks a current code (replay-safe) or spends a recovery code. Never
   * throws for a wrong factor; throws only when the check itself cannot run
   * (storage, or a code without the sealing key — recovery codes still work).
   */
  async checkSecondFactor(userId: string, brand: ProductBrand, factor: SecondFactor): Promise<SecondFactorResult> {
    const row = await this.load(userId);
    if (!this.enabled(row)) return { ok: false };
    if (factor.recoveryCode !== undefined) {
      const idx = matchRecoveryCode(row.recoveryCodeHashes, factor.recoveryCode);
      if (idx < 0) return { ok: false };
      const spent = await this.d.store.spendRecoveryCode(userId, row.recoveryCodeHashes[idx]!);
      return spent ? { ok: true, method: 'recovery', recoveryCodesLeft: row.recoveryCodeHashes.length - 1 } : { ok: false };
    }
    const step = verifyTotp(this.openSecret(row, brand), factor.code, this.d.now(), row.lastUsedStep);
    if (step === null) return { ok: false };
    const won = await this.d.store.advanceStep(userId, step);
    return won ? { ok: true, method: 'totp', recoveryCodesLeft: row.recoveryCodeHashes.length } : { ok: false };
  }

  async disable(userId: string, brand: ProductBrand, factor: SecondFactor, sessionToken: string | null): Promise<void> {
    const row = await this.load(userId);
    if (!this.enabled(row)) {
      // A pending (unconfirmed) enrolment is simply discarded.
      if (row) await this.d.store.remove(userId);
      throw fail('conflict', ACCOUNT_V2_ERROR_CODES.notEnrolled, 'Two-step sign-in is not on.');
    }
    const result = await this.checkSecondFactor(userId, brand, factor);
    if (!result.ok) throw fail('invalid_request', ACCOUNT_V2_ERROR_CODES.totpInvalid, 'That code did not work.');
    await this.cutOffBearerTokens(userId, this.d.now());
    await this.d.store.remove(userId);
    await this.d.revokeOtherSessions(userId, sessionToken);
  }

  async regenerateRecoveryCodes(userId: string, brand: ProductBrand, code: string): Promise<TotpVerifyResponse> {
    const row = await this.load(userId);
    if (!this.enabled(row)) throw fail('conflict', ACCOUNT_V2_ERROR_CODES.notEnrolled, 'Two-step sign-in is not on.');
    const result = await this.checkSecondFactor(userId, brand, { code });
    if (!result.ok) throw fail('invalid_request', ACCOUNT_V2_ERROR_CODES.totpInvalid, 'That code did not work.');
    const recoveryCodes = generateRecoveryCodes();
    await this.d.store.replaceRecoveryCodes(userId, recoveryCodes.map(hashRecoveryCode), this.d.now());
    return { recoveryCodes };
  }
}

/** Maps the store's "table missing" error to 503 for callers outside the service. */
export function isStoreUnavailable(err: unknown): boolean {
  return err instanceof StoreUnavailableError;
}
