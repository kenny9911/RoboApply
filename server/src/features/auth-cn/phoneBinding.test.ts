// @vitest-environment node
//
// "Bind a phone before AI features" applies only when a phone can be bound
// (GOAPPLY_PARITY_PLAN.md §3.7; gaps G10, G68, G111): a WeChat-only GoApply
// account with no SMS provider configured passes every AI gate; with SMS live
// it is still asked to bind first.

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { isEnabledForBrand, requirementsMet, setFlagOverrideLoader } from '../../platform/flags.js';
import { startRouteHarness } from '../../test/routeHarness.js';
import { AuthCnError } from './errors.js';
import { assertPhoneBound, hasBoundPhone, phoneBindingAvailable, phoneBindingRequired, requirePhoneBound } from './phoneBinding.js';
import { fakeDb } from './__tests__/testkit.js';

beforeAll(() => setFlagOverrideLoader(async () => []));
afterAll(() => setFlagOverrideLoader(null));

/** No SMS provider: the state of a deployment with only the shared credentials. */
const NO_SMS = { NODE_ENV: 'production', RESEND_API_KEY: 're_test' };
/** The dev console stands in for a provider outside production. */
const SMS_DEV = { NODE_ENV: 'development', SMS_DEV_CONSOLE: 'true' };

const seed = () => ({
  user: [
    { id: 'wx', email: 'a@users.goapply.invalid', brand: 'goapply', phoneE164: null, phoneVerifiedAt: null },
    { id: 'half', email: 'h@users.goapply.invalid', brand: 'goapply', phoneE164: '+8613712345678', phoneVerifiedAt: null },
    { id: 'ph', email: 'b@users.goapply.invalid', brand: 'goapply', phoneE164: '+8613812345678', phoneVerifiedAt: new Date() },
    { id: 'em', email: 'c@example.com', brand: 'goapply', phoneE164: null, phoneVerifiedAt: null },
    { id: 'intl', email: 'd@example.com', brand: 'roboapply', phoneE164: null, phoneVerifiedAt: null },
  ],
  rAAuthIdentity: [
    { id: 'i1', userId: 'wx', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'o1' },
    { id: 'i3', userId: 'half', brand: 'goapply', provider: 'wechat', appId: 'wx_open', subject: 'o3' },
    { id: 'i2', userId: 'intl', brand: 'roboapply', provider: 'wechat', appId: 'x', subject: 'o2' },
  ],
});

describe('phoneBindingAvailable', () => {
  it('is false whenever the auth.phoneOtp requirement of GoApply is not met, and equals the capability the bind routes are gated on', () => {
    const go = getBrand('goapply');
    for (const env of [NO_SMS, SMS_DEV, {}, { NODE_ENV: 'production', SMS_DEV_CONSOLE: 'true' }, { ...NO_SMS, WECHAT_OPEN_APP_ID: 'wx', WECHAT_OPEN_APP_SECRET: 's' }]) {
      if (!requirementsMet('auth.phoneOtp', go, env)) expect(phoneBindingAvailable(env), JSON.stringify(env)).toBe(false);
      expect(phoneBindingAvailable(env), JSON.stringify(env)).toBe(isEnabledForBrand('auth.phoneOtp', go, env));
    }
    expect(phoneBindingAvailable(NO_SMS)).toBe(false);
    expect(phoneBindingAvailable(SMS_DEV)).toBe(true);
    // The operator switched the phone method off: the bind route answers 404, so no number is asked for.
    const hidden = { ...SMS_DEV, FLAG_GOAPPLY_AUTH_PHONE_OTP: 'false' };
    expect(requirementsMet('auth.phoneOtp', go, hidden)).toBe(true);
    expect(phoneBindingAvailable(hidden)).toBe(false);
    // A RoboApply switch never decides GoApply's rule.
    expect(phoneBindingAvailable({ ...SMS_DEV, FLAG_ROBOAPPLY_AUTH_PHONE_OTP: 'false' })).toBe(true);
  });
});

describe('phoneBindingRequired', () => {
  it('with SMS live: only GoApply WeChat accounts without a verified phone must bind', async () => {
    const { db } = fakeDb(seed());
    await expect(phoneBindingRequired('wx', db, SMS_DEV)).resolves.toBe(true);
    // A number that was never verified does not count as bound.
    await expect(phoneBindingRequired('half', db, SMS_DEV)).resolves.toBe(true);
    await expect(phoneBindingRequired('ph', db, SMS_DEV)).resolves.toBe(false);
    await expect(phoneBindingRequired('em', db, SMS_DEV)).resolves.toBe(false);
    await expect(phoneBindingRequired('intl', db, SMS_DEV)).resolves.toBe(false);
    await expect(phoneBindingRequired('nobody', db, SMS_DEV)).resolves.toBe(false);
    const err = await assertPhoneBound('wx', db, SMS_DEV).catch((e) => e);
    expect(err).toBeInstanceOf(AuthCnError);
    expect(err).toMatchObject({ code: 'phone_binding_required', status: 403, details: { bindRoute: '/bind-phone' } });
  });

  it('with no SMS provider nobody is asked: a number cannot be bound, so the WeChat-only account is not locked out', async () => {
    const { db } = fakeDb(seed());
    for (const id of ['wx', 'half', 'ph', 'em', 'intl', 'nobody']) await expect(phoneBindingRequired(id, db, NO_SMS), id).resolves.toBe(false);
    await expect(assertPhoneBound('wx', db, NO_SMS)).resolves.toBeUndefined();
    // The fact itself is unchanged: the account still has no bound phone.
    await expect(hasBoundPhone('wx', db)).resolves.toBe(false);
    await expect(hasBoundPhone('ph', db)).resolves.toBe(true);
  });

  it('WeChat credentials alone (no SMS) do not bring the requirement back', async () => {
    const { db } = fakeDb(seed());
    const env = { ...NO_SMS, WECHAT_OPEN_APP_ID: 'wx_open', WECHAT_OPEN_APP_SECRET: 's', WECHAT_MP_APP_ID: 'wx_mp', WECHAT_MP_APP_SECRET: 's' };
    await expect(phoneBindingRequired('wx', db, env)).resolves.toBe(false);
  });
});

describe('requirePhoneBound (the gate every AI route mounts)', () => {
  async function gateStatus(env: Record<string, string>, userId: string): Promise<{ status: number; code?: string }> {
    const { db } = fakeDb(seed());
    const router = express.Router();
    router.post(
      '/ai',
      (req, _res, next) => {
        (req as express.Request & { user?: { id: string } }).user = { id: userId };
        next();
      },
      requirePhoneBound(db, env),
      (_req, res) => {
        res.json({ success: true });
      },
    );
    const h = await startRouteHarness({ env, mounts: [['/t', router]] });
    try {
      const res = await h.request<{ code?: string }>('POST', '/t/ai', { host: 'goapply.localhost:3621', body: {} });
      return { status: res.status, code: res.body.code };
    } finally {
      await h.close();
    }
  }

  it('WeChat-only account: 403 phone_binding_required with SMS live, through with no SMS provider', async () => {
    expect(await gateStatus(SMS_DEV, 'wx')).toEqual({ status: 403, code: 'phone_binding_required' });
    expect(await gateStatus(NO_SMS, 'wx')).toEqual({ status: 200, code: undefined });
    // A bound account passes either way.
    expect(await gateStatus(SMS_DEV, 'ph')).toEqual({ status: 200, code: undefined });
    expect(await gateStatus(NO_SMS, 'ph')).toEqual({ status: 200, code: undefined });
  });
});
