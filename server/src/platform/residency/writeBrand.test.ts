// @vitest-environment node
//
// Which brand owns a residency-critical write. Every deployment serves both
// brands unless ALLOWED_BRANDS / BRAND_LOCK narrows it (D5), so a write made
// outside a request can no longer take "the brand of this deployment": it
// takes the stored brand of the user who owns the data, and writes nothing
// when even that is unknown. RoboApply is never guessed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runWithBrand } from '../../lib/requestContext.js';
import { setUserBrandLookup } from '../brand/userBrand.js';
import { WriteBrandUnknownError, resolveOwnerWriteBrand, resolveWriteBrand } from './writeBrand.js';

const PROD = { NODE_ENV: 'production' };
const lookups: string[] = [];

beforeEach(() => {
  lookups.length = 0;
  setUserBrandLookup(async (userId) => {
    lookups.push(userId);
    if (userId === 'boom') throw new Error('database unavailable');
    return ({ intl_user: 'roboapply', cn_user: 'goapply', odd_user: 'someotherbrand' })[userId] ?? null;
  });
});
afterEach(() => setUserBrandLookup(null));

describe('resolveWriteBrand (no owner known)', () => {
  it('an explicit brand wins, then the unit of work', () => {
    expect(resolveWriteBrand('goapply', PROD)).toBe('goapply');
    expect(runWithBrand('goapply', () => resolveWriteBrand(undefined, PROD))).toBe('goapply');
    expect(runWithBrand('goapply', () => resolveWriteBrand('roboapply', PROD))).toBe('roboapply');
  });

  it('production with no deployment scope serves both brands: no context means no brand, never RoboApply', () => {
    expect(resolveWriteBrand(undefined, PROD)).toBeNull();
    expect(resolveWriteBrand(null, {})).toBeNull();
    expect(resolveWriteBrand(undefined, { ...PROD, ALLOWED_BRANDS: 'roboapply,goapply' })).toBeNull();
  });

  it('a deployment that can serve only one brand implies it', () => {
    expect(resolveWriteBrand(undefined, { ...PROD, ALLOWED_BRANDS: 'roboapply' })).toBe('roboapply');
    expect(resolveWriteBrand(undefined, { ...PROD, BRAND_LOCK: 'goapply' })).toBe('goapply');
    expect(resolveWriteBrand(undefined, { ...PROD, DEPLOY_REGION: 'cn-mainland' })).toBe('goapply');
  });
});

describe('resolveOwnerWriteBrand (the owner is known)', () => {
  it("with no context, the owner's stored brand decides, on a deployment that serves both brands", async () => {
    expect(await resolveOwnerWriteBrand(undefined, 'intl_user', PROD)).toBe('roboapply');
    expect(await resolveOwnerWriteBrand(undefined, 'cn_user', PROD)).toBe('goapply');
    expect(lookups).toEqual(['intl_user', 'cn_user']);
  });

  it('an explicit brand and the unit of work come first, without a lookup', async () => {
    expect(await resolveOwnerWriteBrand('goapply', 'intl_user', PROD)).toBe('goapply');
    expect(await runWithBrand('roboapply', () => resolveOwnerWriteBrand(undefined, 'cn_user', PROD))).toBe('roboapply');
    expect(lookups).toEqual([]);
  });

  it('no context and no owner: nothing is written (null), and the error names brand_context_missing', async () => {
    expect(await resolveOwnerWriteBrand(undefined, undefined, PROD)).toBeNull();
    expect(await resolveOwnerWriteBrand(undefined, 'nobody', PROD)).toBeNull();
    // A stored value that is not a brand, and a lookup that fails, are not evidence about the brand.
    expect(await resolveOwnerWriteBrand(undefined, 'odd_user', PROD)).toBeNull();
    expect(await resolveOwnerWriteBrand(undefined, 'boom', PROD)).toBeNull();
    const error = new WriteBrandUnknownError('Original resume file');
    expect(error.code).toBe('brand_context_missing');
    expect(error.message).toMatch(/no brand for this write/);
  });

  it('an owner of a brand this deployment does not serve gets null, not the deployment brand', async () => {
    expect(await resolveOwnerWriteBrand(undefined, 'cn_user', { ...PROD, ALLOWED_BRANDS: 'roboapply' })).toBeNull();
    expect(await resolveOwnerWriteBrand(undefined, 'intl_user', { ...PROD, BRAND_LOCK: 'goapply' })).toBeNull();
  });

  it('an unknown owner falls back to the brand a one-brand deployment implies', async () => {
    expect(await resolveOwnerWriteBrand(undefined, 'nobody', { ...PROD, ALLOWED_BRANDS: 'roboapply' })).toBe('roboapply');
    expect(await resolveOwnerWriteBrand(undefined, 'boom', { ...PROD, DEPLOY_REGION: 'cn-mainland', ALLOWED_BRANDS: 'goapply' })).toBe('goapply');
  });
});
