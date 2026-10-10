// @vitest-environment node
// WP-58 service: public reads show only published + verified programmes with
// their source; "待核实" after 14 days; no publish without verification; an
// edited fact clears the verification; extraction writes nothing; reminders
// need a stated, future close date.

import { describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../../platform/http.js';
import {
  adminCreate,
  adminDelete,
  adminExtract,
  adminPublish,
  adminUpdate,
  adminVerify,
  companyEvents,
  getEvent,
  listEvents,
  listSubscriptions,
  subscribe,
  unsubscribe,
  upcomingForUser,
} from '../service.js';
import { decodeCursor, encodeCursor, needsReverify, toEventView } from '../views.js';
import type { CampusLlm } from '../extract.js';
import { CAMPUS_PAGE_SIZE, PatchCampusEventBodySchema, campusCompanySlug } from '../contract.js';
import { DAY, NOW, eventRow, fakeCampusRepo, recordingLlm, serviceDeps } from './testkit.js';

const DRAFT = {
  companyName: '示例科技',
  title: '2027届校园招聘',
  graduationClass: '2027届',
  kind: 'application' as const,
  applyOpensAt: '2026-08-31T16:00:00.000Z',
  applyClosesAt: '2026-10-31T15:59:00.000Z',
  stages: [],
  cities: ['北京'],
  roles: [],
  officialUrl: 'https://campus.example.cn/2027',
};

async function rejectsWith(p: Promise<unknown>, code: string, reason?: string) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).code).toBe(code);
  if (reason) expect((err as HttpError).details).toMatchObject({ reason });
}

describe('views', () => {
  it('needsReverify after 14 days', () => {
    expect(needsReverify(new Date(NOW.getTime() - 13 * DAY), NOW)).toBe(false);
    expect(needsReverify(new Date(NOW.getTime() - 15 * DAY), NOW)).toBe(true);
    expect(needsReverify(null, NOW)).toBe(true);
  });
  it('drafts and unverified rows never get a public view', () => {
    expect(toEventView(eventRow({ status: 'draft' }), NOW)).toBeNull();
    expect(toEventView(eventRow({ verifiedAt: null }), NOW)).toBeNull();
    expect(toEventView(eventRow(), NOW)).toMatchObject({ officialUrl: 'https://campus.example.cn/2027', sourceName: '示例科技校园招聘官网', needsReverify: false });
  });
  it('cursor round-trips and ignores junk', () => {
    expect(decodeCursor(encodeCursor(60))).toBe(60);
    expect(decodeCursor('drop table')).toBe(0);
  });
});

describe('listEvents', () => {
  const repo = fakeCampusRepo([
    eventRow({ id: 'a', applyClosesAt: new Date(NOW.getTime() + 5 * DAY) }),
    eventRow({ id: 'b', applyClosesAt: new Date(NOW.getTime() + 2 * DAY), graduationClass: '2026届', cities: ['深圳'] }),
    eventRow({ id: 'c', applyClosesAt: null, verifiedAt: new Date(NOW.getTime() - 20 * DAY) }),
    eventRow({ id: 'closed', applyClosesAt: new Date(NOW.getTime() - DAY) }),
    eventRow({ id: 'draft', status: 'draft' }),
    eventRow({ id: 'unverified', verifiedAt: null }),
    eventRow({ id: 'intl', market: 'intl' }),
  ]);
  const deps = serviceDeps(repo);

  it('lists published, verified, not-closed programmes of the market, closing soonest first', async () => {
    const list = await listEvents(deps, 'cn', {}, undefined, null);
    expect(list.items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(list.asOf).toBe(NOW.toISOString());
    expect(list.cursor).toBeNull();
    expect(list.items.find((i) => i.id === 'c')!.needsReverify).toBe(true);
  });

  it('filters by 届别, city (programmes naming no city count everywhere) and open now', async () => {
    expect((await listEvents(deps, 'cn', { class: 2026 }, undefined, null)).items.map((i) => i.id)).toEqual(['b']);
    expect((await listEvents(deps, 'cn', { city: '北京' }, undefined, null)).items.map((i) => i.id)).toEqual(['a', 'c']);
    expect((await listEvents(deps, 'cn', { openNow: true }, undefined, null)).items.map((i) => i.id)).toEqual(['b', 'a']);
  });

  it('marks the signed-in user’s reminders', async () => {
    await subscribe(deps, 'cn', 'u1', { kind: 'event', eventId: 'a', channel: 'in_app' });
    const list = await listEvents(deps, 'cn', {}, undefined, 'u1');
    expect(list.items.find((i) => i.id === 'a')!.subscribed).toBe(true);
    expect(list.items.find((i) => i.id === 'b')!.subscribed).toBe(false);
  });

  it('pages with a cursor', async () => {
    const many = fakeCampusRepo(Array.from({ length: CAMPUS_PAGE_SIZE + 3 }, (_, i) => eventRow({ id: `e${String(i).padStart(3, '0')}`, applyClosesAt: new Date(NOW.getTime() + (i + 1) * DAY) })));
    const first = await listEvents(serviceDeps(many), 'cn', {}, undefined, null);
    expect(first.items).toHaveLength(CAMPUS_PAGE_SIZE);
    const second = await listEvents(serviceDeps(many), 'cn', {}, first.cursor!, null);
    expect(second.items).toHaveLength(3);
    expect(second.cursor).toBeNull();
  });

  it('getEvent 404s for drafts and other markets', async () => {
    await expect(getEvent(deps, 'cn', 'a', null)).resolves.toMatchObject({ id: 'a' });
    await rejectsWith(getEvent(deps, 'cn', 'draft', null), 'not_found');
    await rejectsWith(getEvent(deps, 'cn', 'intl', null), 'not_found');
  });
});

describe('companyEvents', () => {
  it('finds a company by slug and 404s when it has nothing published', async () => {
    const repo = fakeCampusRepo([eventRow({ id: 'a', companyName: 'Acme China' }), eventRow({ id: 'd', companyName: 'Acme China', status: 'draft' })]);
    const out = await companyEvents(serviceDeps(repo), 'cn', 'acme-china');
    expect(out.companyName).toBe('Acme China');
    expect(out.items.map((i) => i.id)).toEqual(['a']);
    await rejectsWith(companyEvents(serviceDeps(repo), 'cn', 'nobody'), 'not_found');
  });

  it('resolves names that mix hyphens and spaces (the slug is not reversible)', async () => {
    const repo = fakeCampusRepo([
      eventRow({ id: 'tp', companyName: 'TP-LINK 普联' }),
      eventRow({ id: 'tp2', companyName: 'TP-LINK' }),
      eventRow({ id: 'tp3', companyName: 'TP LINK' }),
    ]);
    const deps = serviceDeps(repo);
    const out = await companyEvents(deps, 'cn', campusCompanySlug('TP-LINK 普联'));
    expect(out.companyName).toBe('TP-LINK 普联');
    expect(out.items.map((i) => i.id)).toEqual(['tp']);
    expect((await companyEvents(deps, 'cn', 'tp-link-普联')).items.map((i) => i.id)).toEqual(['tp']);
    // 'TP-LINK' and 'TP LINK' share a slug, so the page lists both.
    expect((await companyEvents(deps, 'cn', 'TP-LINK')).items.map((i) => i.id).sort()).toEqual(['tp2', 'tp3']);
    await rejectsWith(companyEvents(deps, 'cn', '  '), 'not_found');
  });
});

describe('subscriptions', () => {
  it('event reminders need a published programme with a future close date; idempotent', async () => {
    const repo = fakeCampusRepo([eventRow({ id: 'a' }), eventRow({ id: 'nodate', applyClosesAt: null }), eventRow({ id: 'draft', status: 'draft' })]);
    const deps = serviceDeps(repo);
    const s1 = await subscribe(deps, 'cn', 'u1', { kind: 'event', eventId: 'a', channel: 'in_app' });
    const s2 = await subscribe(deps, 'cn', 'u1', { kind: 'event', eventId: 'a', channel: 'in_app' });
    expect(s1.id).toBe(s2.id);
    expect(repo.subs).toHaveLength(1);
    await rejectsWith(subscribe(deps, 'cn', 'u1', { kind: 'event', eventId: 'nodate', channel: 'in_app' }), 'conflict', 'campus_event_no_close_date');
    await rejectsWith(subscribe(deps, 'cn', 'u1', { kind: 'event', eventId: 'draft', channel: 'in_app' }), 'not_found');
    repo.events.get('a')!.applyClosesAt = new Date(NOW.getTime() - 1000);
    await rejectsWith(subscribe(deps, 'cn', 'u2', { kind: 'event', eventId: 'a', channel: 'in_app' }), 'conflict', 'campus_event_closed');
  });

  it('follow a company per 届别 (one follow per company, class updated)', async () => {
    const repo = fakeCampusRepo();
    const deps = serviceDeps(repo);
    await subscribe(deps, 'cn', 'u1', { kind: 'company', companyName: '  Acme   China ', graduationClass: '2027届', channel: 'in_app' });
    const again = await subscribe(deps, 'cn', 'u1', { kind: 'company', companyName: 'acme china', graduationClass: '2028届', channel: 'in_app' });
    expect(repo.subs).toHaveLength(1);
    expect(again).toMatchObject({ kind: 'company', companyName: 'acme china', graduationClass: '2028届' });
  });

  it('lists with the programme and deletes only the owner’s rows', async () => {
    const repo = fakeCampusRepo([eventRow({ id: 'a' })]);
    const deps = serviceDeps(repo);
    const s = await subscribe(deps, 'cn', 'u1', { kind: 'event', eventId: 'a', channel: 'in_app' });
    const list = await listSubscriptions(deps, 'cn', 'u1');
    expect(list.items[0]).toMatchObject({ id: s.id, event: { id: 'a', subscribed: true } });
    await rejectsWith(unsubscribe(deps, 'u2', s.id), 'not_found');
    await expect(unsubscribe(deps, 'u1', s.id)).resolves.toEqual({ id: s.id });
  });
});

describe('upcomingForUser', () => {
  it('reminded programmes first, then open programmes of the user’s 届别', async () => {
    const repo = fakeCampusRepo([
      eventRow({ id: 'mine', graduationClass: '2026届', applyClosesAt: new Date(NOW.getTime() + 9 * DAY) }),
      eventRow({ id: 'open27', applyClosesAt: new Date(NOW.getTime() + 3 * DAY) }),
      eventRow({ id: 'other28', graduationClass: '2028届' }),
    ]);
    repo.classes.set('u1', 2027);
    const deps = serviceDeps(repo);
    await subscribe(deps, 'cn', 'u1', { kind: 'event', eventId: 'mine', channel: 'in_app' });
    const out = await upcomingForUser(deps, 'cn', 'u1');
    expect(out.map((e) => [e.id, e.subscribed])).toEqual([
      ['mine', true],
      ['open27', false],
    ]);
  });
});

describe('admin curation', () => {
  it('extract proposes from one page and writes nothing (no auto-publish)', async () => {
    const repo = fakeCampusRepo();
    const llm = recordingLlm(
      JSON.stringify({
        companyName: { value: '示例科技', quote: '示例科技 2027届校园招聘' },
        applyClosesAt: { value: '2026-10-31T23:59', quote: '网申时间：2026年9月1日-2026年10月31日 23:59' },
      }),
    );
    const fetchPage = vi.fn(serviceDeps(repo).fetchPage);
    const out = await adminExtract(serviceDeps(repo, { llm, fetchPage }), 'https://campus.example.cn/2027');
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(llm.calls).toBe(1);
    expect(out).toMatchObject({
      aiGenerated: true,
      draft: { officialUrl: 'https://campus.example.cn/2027', companyName: '示例科技', applyClosesAt: '2026-10-31T15:59:00.000Z', sourceName: '示例科技2027届校园招聘官网' },
    });
    expect(out.evidence.applyClosesAt).toContain('10月31日');
    expect(repo.creates).toBe(0);
    expect(repo.events.size).toBe(0);
  });

  it('extract: a reply that is not JSON, or a transport error, answers ai_unavailable (extract_failed), never 500', async () => {
    const repo = fakeCampusRepo();
    await rejectsWith(adminExtract(serviceDeps(repo, { llm: recordingLlm('Sorry, I cannot read that page.') }), 'https://campus.example.cn/2027'), 'ai_unavailable', 'extract_failed');
    await rejectsWith(adminExtract(serviceDeps(repo, { llm: recordingLlm('{"companyName": 42}') }), 'https://campus.example.cn/2027'), 'ai_unavailable', 'extract_failed');
    const broken: CampusLlm = {
      chatWithUsage: async () => {
        throw new Error('upstream 502');
      },
    };
    await rejectsWith(adminExtract(serviceDeps(repo, { llm: broken }), 'https://campus.example.cn/2027'), 'ai_unavailable', 'extract_failed');
    expect(repo.creates).toBe(0);
  });

  it('extract: aggregator URLs are refused before any fetch; no model → ai_unavailable', async () => {
    const repo = fakeCampusRepo();
    const fetchPage = vi.fn();
    await rejectsWith(adminExtract(serviceDeps(repo, { fetchPage }), 'https://www.yingjiesheng.com/job/1'), 'invalid_request', 'aggregator_source');
    await rejectsWith(
      adminExtract(serviceDeps(repo, { fetchPage, resolveModel: () => ({ model: undefined, available: false }) }), 'https://campus.example.cn/2027'),
      'ai_unavailable',
    );
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('create is always a draft; publish needs verification; verify stamps who and when', async () => {
    const repo = fakeCampusRepo();
    const onPublished = vi.fn(async () => 0);
    const deps = serviceDeps(repo, { onPublished });
    const created = await adminCreate(deps, 'cn', 'admin_1', DRAFT);
    expect(created).toMatchObject({ status: 'draft', verifiedAt: null });
    await rejectsWith(adminPublish(deps, 'cn', created.id), 'conflict', 'campus_event_not_verified');
    expect(onPublished).not.toHaveBeenCalled();
    const verified = await adminVerify(deps, 'cn', created.id, 'admin_2');
    expect(verified).toMatchObject({ verifiedAt: NOW.toISOString(), verifiedByUserId: 'admin_2', verifiedByName: 'Staff admin_2' });
    const published = await adminPublish(deps, 'cn', created.id);
    expect(published.status).toBe('published');
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it('refuses aggregator sources and inverted windows', async () => {
    const deps = serviceDeps(fakeCampusRepo());
    await rejectsWith(adminCreate(deps, 'cn', 'a', { ...DRAFT, officialUrl: 'https://www.nowcoder.com/x' }), 'invalid_request', 'aggregator_source');
    await rejectsWith(adminCreate(deps, 'cn', 'a', { ...DRAFT, sourceUrl: 'https://www.shixiseng.com/x' }), 'invalid_request', 'aggregator_source');
    await rejectsWith(
      adminCreate(deps, 'cn', 'a', { ...DRAFT, applyOpensAt: '2026-11-01T00:00:00.000Z', applyClosesAt: '2026-10-01T00:00:00.000Z' }),
      'invalid_request',
      'apply_window_inverted',
    );
  });

  it('editing a fact of a published entry clears the verification and unpublishes it; a note does not', async () => {
    const repo = fakeCampusRepo([eventRow({ id: 'p', kind: 'test' })]);
    const deps = serviceDeps(repo);
    // Parsed exactly as the PATCH route parses it: no defaults fill in omitted fields.
    const body = PatchCampusEventBodySchema.parse({ sourceNote: '官网公告' });
    expect(body).toEqual({ sourceNote: '官网公告' });
    const noted = await adminUpdate(deps, 'cn', 'p', body);
    expect(noted).toMatchObject({ kind: 'test', cities: ['北京', '上海'], roles: ['产品'], stages: [{ kind: 'bishi' }] });
    expect(noted).toMatchObject({ status: 'published', verifiedByUserId: 'admin_1' });
    const same = await adminUpdate(deps, 'cn', 'p', { applyClosesAt: repo.events.get('p')!.applyClosesAt!.toISOString() });
    expect(same.status).toBe('published');
    const edited = await adminUpdate(deps, 'cn', 'p', { applyClosesAt: '2026-11-15T15:59:00.000Z' });
    expect(edited).toMatchObject({ status: 'draft', verifiedAt: null, verifiedByUserId: null });
  });

  it('delete removes drafts and archives anything that was verified', async () => {
    const repo = fakeCampusRepo([eventRow({ id: 'p' }), eventRow({ id: 'd', status: 'draft', verifiedAt: null })]);
    const deps = serviceDeps(repo);
    await expect(adminDelete(deps, 'cn', 'd')).resolves.toEqual({ id: 'd', result: 'deleted' });
    await expect(adminDelete(deps, 'cn', 'p')).resolves.toEqual({ id: 'p', result: 'archived' });
    expect(repo.events.get('p')!.status).toBe('archived');
    await rejectsWith(adminVerify(deps, 'cn', 'p', 'a'), 'conflict');
  });

  it('an archived entry cannot be published again on its old verification', async () => {
    const onPublished = vi.fn();
    const repo = fakeCampusRepo([eventRow({ id: 'p' })]);
    const deps = { ...serviceDeps(repo), onPublished };
    await adminDelete(deps, 'cn', 'p');
    expect(repo.events.get('p')!.verifiedAt).not.toBeNull();
    await rejectsWith(adminPublish(deps, 'cn', 'p'), 'conflict', 'archived');
    expect(repo.events.get('p')!.status).toBe('archived');
    expect(onPublished).not.toHaveBeenCalled();
  });
});
