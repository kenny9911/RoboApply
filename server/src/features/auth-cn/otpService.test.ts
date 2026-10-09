// @vitest-environment node
//
// WP-11 acceptance (OTP): hashed codes, 5-minute expiry, 5 wrong tries → 30-min
// lock, persisted limits (1/60 s and 10/day per phone, 10/h and 30/day per
// IP), SMS_DAILY_MAX fail-closed, provider failure, single use.

import { describe, expect, it } from 'vitest';
import { HttpError } from '../../platform/http.js';
import { AuthCnError } from './errors.js';
import { createOtpService, hashOtp, otpSecret, smsDailyMax } from './otpService.js';
import { BASE_ENV, clock, fakeDb, memoryLimiter, recordingSms } from './__tests__/testkit.js';

const PHONE = '+8613812345678';

function setup(env = BASE_ENV) {
  const { fake, db } = fakeDb();
  const c = clock();
  const limiter = memoryLimiter(c.now);
  const sms = recordingSms();
  const otp = createOtpService({ db, sms, consume: limiter.consume, now: c.now, env, secret: 'test-secret', brandName: () => 'GoApply' });
  return { fake, db, c, limiter, sms, otp };
}

async function codeError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AuthCnError || err instanceof HttpError) return err.code;
    throw err;
  }
  return 'resolved';
}

describe('sendCode', () => {
  it('stores only an HMAC of the code, expiring in 5 minutes, and texts brand + code', async () => {
    const { fake, otp, sms, c } = setup();
    await expect(otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1' })).resolves.toEqual({ resendInSec: 60 });
    const code = sms.lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(sms.sent[0]).toEqual({ phoneE164: PHONE, code, brandName: 'GoApply' });
    const rows = fake.$rows('rAPhoneOtp');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(code);
    expect(rows[0]!.codeHash).toBe(hashOtp('test-secret', 'goapply', PHONE, 'login', code));
    expect((rows[0]!.expiresAt as Date).getTime() - c.now().getTime()).toBe(5 * 60 * 1000);
    expect(rows[0]!.ipHash).not.toContain('1.1.1.1');
  });

  it('allows one send per 60 s per phone, then again after the window', async () => {
    const { otp, c } = setup();
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1' });
    await expect(codeError(otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.2' }))).resolves.toBe('rate_limited');
    c.advance(60_000);
    await expect(otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.3' })).resolves.toEqual({ resendInSec: 60 });
  });

  it('caps 10 sends per phone per day', async () => {
    const { otp, c } = setup();
    for (let i = 0; i < 10; i++) {
      await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: `2.2.2.${i}` });
      c.advance(61_000);
    }
    await expect(codeError(otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '2.2.2.99' }))).resolves.toBe('rate_limited');
  });

  it('caps 10 sends per IP per hour', async () => {
    const { otp } = setup();
    for (let i = 0; i < 10; i++) {
      await otp.sendCode({ brand: 'goapply', phoneE164: `+8613900000${String(i).padStart(3, '0')}`, purpose: 'login', ip: '3.3.3.3' });
    }
    await expect(codeError(otp.sendCode({ brand: 'goapply', phoneE164: '+8613900000999', purpose: 'login', ip: '3.3.3.3' }))).resolves.toBe(
      'rate_limited',
    );
  });

  it('an IP over its own limit never uses up the per-phone budget of the number it targets', async () => {
    const { otp, sms } = setup();
    for (let i = 0; i < 10; i++) {
      await otp.sendCode({ brand: 'goapply', phoneE164: `+8613900000${String(i).padStart(3, '0')}`, purpose: 'login', ip: '6.6.6.6' });
    }
    // The blocked IP hammers the victim's number…
    for (let i = 0; i < 15; i++) {
      await expect(codeError(otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '6.6.6.6' }))).resolves.toBe('rate_limited');
    }
    // …and the victim can still get a code right away (no 60 s / daily phone hit was counted).
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '7.7.7.7' });
    expect(sms.sent.at(-1)!.phoneE164).toBe(PHONE);
  });

  it('stops at SMS_DAILY_MAX (sms_daily_cap) and fails closed when the counters are unreadable', async () => {
    const { otp, sms, limiter } = setup({ ...BASE_ENV, SMS_DAILY_MAX: '2' });
    await otp.sendCode({ brand: 'goapply', phoneE164: '+8613900000001', purpose: 'login', ip: '4.4.4.1' });
    await otp.sendCode({ brand: 'goapply', phoneE164: '+8613900000002', purpose: 'login', ip: '4.4.4.2' });
    await expect(codeError(otp.sendCode({ brand: 'goapply', phoneE164: '+8613900000003', purpose: 'login', ip: '4.4.4.3' }))).resolves.toBe(
      'sms_daily_cap',
    );
    limiter.fail(true);
    await expect(otp.sendCode({ brand: 'goapply', phoneE164: '+8613900000004', purpose: 'login', ip: '4.4.4.4' })).rejects.toThrow('db down');
    expect(sms.sent).toHaveLength(2);
  });

  it('defaults SMS_DAILY_MAX', () => {
    expect(smsDailyMax({})).toBe(1000);
    expect(smsDailyMax({ SMS_DAILY_MAX: 'abc' })).toBe(1000);
    expect(smsDailyMax({ SMS_DAILY_MAX: '50' })).toBe(50);
  });

  it('answers sms_send_failed and voids the code when the provider fails', async () => {
    const { otp, sms, fake } = setup();
    sms.setResult({ ok: false, errorCode: 'isv.MOBILE_NUMBER_ILLEGAL' });
    await expect(codeError(otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1' }))).resolves.toBe('sms_send_failed');
    expect(fake.$rows('rAPhoneOtp')[0]!.consumedAt).toBeInstanceOf(Date);
  });

  it('supersedes the previous unused code', async () => {
    const { otp, sms, c } = setup();
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1' });
    const first = sms.lastCode();
    c.advance(61_000);
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1' });
    const second = sms.lastCode();
    if (first !== second) {
      await expect(codeError(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: first }))).resolves.toBe('otp_invalid');
    }
    await expect(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: second })).resolves.toBeTruthy();
  });
});

describe('verifyCode', () => {
  it('accepts the right code once', async () => {
    const { otp } = setup();
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1', code: '123456' });
    await expect(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '123456' })).resolves.toEqual({
      otpId: expect.any(String),
    });
    await expect(codeError(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '123456' }))).resolves.toBe('otp_invalid');
  });

  it('never accepts a code for another purpose or brand', async () => {
    const { otp } = setup();
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'bind', ip: '1.1.1.1', code: '123456' });
    await expect(codeError(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '123456' }))).resolves.toBe('otp_invalid');
    await expect(codeError(otp.verifyCode({ brand: 'roboapply', phoneE164: PHONE, purpose: 'bind', code: '123456' }))).resolves.toBe('otp_invalid');
  });

  it('expires after 5 minutes', async () => {
    const { otp, c } = setup();
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1', code: '123456' });
    c.advance(5 * 60 * 1000);
    await expect(codeError(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '123456' }))).resolves.toBe('otp_expired');
  });

  it('locks the number for 30 minutes after 5 wrong tries', async () => {
    const { otp, c } = setup();
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1', code: '123456' });
    for (let i = 1; i <= 4; i++) {
      const err = await otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '000000' }).catch((e: AuthCnError) => e);
      expect(err).toBeInstanceOf(AuthCnError);
      expect((err as AuthCnError).code).toBe('otp_invalid');
      expect((err as AuthCnError).details).toEqual({ attemptsLeft: 5 - i });
    }
    const fifth = await otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '000000' }).catch((e: AuthCnError) => e);
    expect((fifth as AuthCnError).code).toBe('otp_locked');
    expect((fifth as AuthCnError).status).toBe(429);
    expect((fifth as AuthCnError).details).toEqual({ retryAfterSec: 1800 });
    // Locked: even the right code and new sends are refused.
    await expect(codeError(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '123456' }))).resolves.toBe('otp_locked');
    c.advance(61_000);
    await expect(codeError(otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1' }))).resolves.toBe('otp_locked');
    // 30 minutes later the number works again.
    c.advance(30 * 60 * 1000);
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.9', code: '654321' });
    await expect(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '654321' })).resolves.toBeTruthy();
  });

  it('parallel wrong guesses still lock the number (atomic attempt counter)', async () => {
    const { otp, fake } = setup();
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1', code: '123456' });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => codeError(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: `00000${i}` }))),
    );
    expect(results.every((r) => r === 'otp_invalid' || r === 'otp_locked')).toBe(true);
    expect(results).toContain('otp_locked');
    expect(fake.$rows('rAPhoneOtp')[0]).toMatchObject({ attempts: 6, consumedAt: expect.any(Date) });
    // The right code no longer works: the number is locked.
    await expect(codeError(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '123456' }))).resolves.toBe('otp_locked');
  });

  it('persists the lock in RARateCounter (not in memory)', async () => {
    const { otp, fake } = setup();
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1', code: '123456' });
    for (let i = 0; i < 5; i++) await otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '999999' }).catch(() => null);
    const locks = fake.$rows('rARateCounter');
    expect(locks).toHaveLength(1);
    expect(String(locks[0]!.key)).toMatch(/^lock:goapply:otp:[0-9a-f]{32}$/);
    expect(String(locks[0]!.key)).not.toContain('13812345678');
  });

  it('check-only mode leaves the code usable until spent', async () => {
    const { otp } = setup();
    await otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1', code: '123456' });
    const { otpId } = await otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '123456', consume: false });
    await expect(otp.verifyCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', code: '123456', consume: false })).resolves.toEqual({ otpId });
    await otp.spend(otpId);
    await expect(codeError(otp.spend(otpId))).resolves.toBe('otp_invalid');
  });
});

describe('otpSecret', () => {
  it('uses JWT_SECRET, never a known key in production', () => {
    expect(otpSecret({ JWT_SECRET: 'k' })).toBe('k');
    expect(otpSecret({ NODE_ENV: 'development' })).toBe('development-secret-change-in-production');
    expect(() => otpSecret({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET/);
    expect(() => otpSecret({ NODE_ENV: 'production', JWT_SECRET: '  ' })).toThrow(/JWT_SECRET/);
  });

  it('a production service without JWT_SECRET sends no code', async () => {
    const { fake, db } = fakeDb();
    const c = clock();
    const sms = recordingSms();
    const env = { NODE_ENV: 'production' };
    const otp = createOtpService({ db, sms, consume: memoryLimiter(c.now).consume, now: c.now, env, secret: () => otpSecret(env), brandName: () => 'GoApply' });
    await expect(otp.sendCode({ brand: 'goapply', phoneE164: PHONE, purpose: 'login', ip: '1.1.1.1' })).rejects.toThrow(/JWT_SECRET/);
    expect(sms.sent).toHaveLength(0);
    expect(fake.$rows('rAPhoneOtp')).toHaveLength(0);
  });
});
