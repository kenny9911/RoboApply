// @vitest-environment node
//
// The visitor job list's own rules that live in this file: the public job path
// on BOTH brands (D5, GOAPPLY_PARITY_PLAN §3.11; gap G115), the public-page
// re-check, never a fit or a tracker state, and the capability gate (GoApply:
// on by default, off with CN_RECRUITMENT_INFO_MODE=off). No database, no network.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RequestHandler } from 'express';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getBrand } from '../../platform/brand/registry.js';
import { setFlagOverrideLoader } from '../../platform/flags.js';
import { startRouteHarness, type RouteHarness } from '../../test/routeHarness.js';
import type { VisitorFeedResponse } from '../visitor/contract.js';
import type { PublicFeedItem } from './contract.js';
import { publicItem } from './items.js';
import { createPublicFeedRouter, createPublicFeedService, publicPathFor } from './publicRoutes.js';
import { feedRow } from './testkit.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const ROBO = 'localhost:3621';
const GO = 'goapply.localhost:3621';
type Env<T> = { success: boolean; data: T; code?: string };

const robo = getBrand('roboapply');
const go = getBrand('goapply');

const cnItem = (id: string): PublicFeedItem =>
  publicItem(feedRow({ id, market: 'cn', title: '后端工程师', companyName: '示例汽车', sourceBoard: 'smartrecruiters', sourceName: '示例汽车 · SmartRecruiters' }), null, NOW);
const intlItem = (id: string): PublicFeedItem => publicItem(feedRow({ id, title: 'Data Analyst', companyName: 'Acme' }), null, NOW);

describe('publicPathFor', () => {
  it('the public job page on both brands: the same path rule (no brand has "no public page")', () => {
    expect(publicPathFor(intlItem('j1'), robo)).toBe('/job/j1-data-analyst-acme');
    const path = publicPathFor(cnItem('c1'), go);
    expect(path).not.toBeNull();
    expect(path).toMatch(/^\/job\/c1(?:-|$)/);
    // The path is a function of the job alone, so the two brands cannot disagree about it.
    expect(publicPathFor(cnItem('c1'), robo)).toBe(path);
    expect(publicPathFor(cnItem('c1'))).toBe(path);
  });
});

describe('the visitor list service', () => {
  it('GoApply items carry their public page, their source and their own apply link; a row that fails the public-page re-check is dropped', async () => {
    const publicList = vi.fn(async () => [cnItem('c1'), cnItem('c2'), cnItem('c3')]);
    const stillPublic = vi.fn(async (ids: string[]) => new Set(ids.filter((id) => id !== 'c2')));
    const svc = createPublicFeedService({ publicList, stillPublic, now: () => NOW });
    const res = await svc.list({ role: '后端' }, go);
    expect(res.items.map((i) => i.jobId)).toEqual(['c1', 'c3']);
    for (const item of res.items) {
      expect(item.path).toMatch(/^\/job\/c[13]/);
      expect(item.source).toMatchObject({ via: 'ats', original: '示例汽车' });
      expect(item.apply).toMatchObject({ target: 'employer' });
      expect(item).not.toHaveProperty('fit');
      expect(item).not.toHaveProperty('tracker');
    }
    expect(stillPublic).toHaveBeenCalledWith(['c1', 'c2', 'c3'], go, NOW);
  });

  it('RoboApply is unchanged: the same path as before', async () => {
    const svc = createPublicFeedService({ publicList: async () => [intlItem('j1')], stillPublic: async (ids) => new Set(ids), now: () => NOW });
    expect((await svc.list({}, robo)).items[0]!.path).toBe('/job/j1-data-analyst-acme');
  });
});

describe('GET /public/feed on GoApply', () => {
  const pass: RequestHandler = (_req, _res, next) => next();
  const deps = { publicList: async () => [cnItem('c1')], stillPublic: async (ids: string[]) => new Set(ids), now: () => NOW, rateLimiter: pass };
  let h: RouteHarness;

  beforeAll(async () => {
    setFlagOverrideLoader(async () => []);
    const off = { CN_RECRUITMENT_INFO_MODE: 'off' };
    h = await startRouteHarness({
      env: {},
      mounts: [
        ['/default/feed', createPublicFeedRouter({ env: {}, publicFeed: deps })],
        ['/off/feed', createPublicFeedRouter({ env: off, publicFeed: deps })],
      ],
    });
  });
  afterAll(async () => {
    setFlagOverrideLoader(null);
    await h.close();
  });

  it('nothing set: the list answers with the public job path (the feed is on by default, D5)', async () => {
    const res = await h.request<Env<VisitorFeedResponse>>('GET', '/default/feed', { host: GO });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]!.path).toMatch(/^\/job\/c1/);
    // Market cn: the CDN keeps a list 60 s, so the off switch is not outlived by cached postings.
    expect(res.headers.get('cache-control')).toBe('public, max-age=0, s-maxage=60');
  });

  it('CN_RECRUITMENT_INFO_MODE=off: 404 feature_disabled on GoApply; RoboApply does not read that switch', async () => {
    const res = await h.request<Env<unknown>>('GET', '/off/feed', { host: GO });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('feature_disabled');
    expect((await h.request<Env<VisitorFeedResponse>>('GET', '/off/feed', { host: ROBO })).status).toBe(200);
  });
});
