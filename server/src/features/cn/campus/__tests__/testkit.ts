// Fakes for the campus calendar tests: in-memory repositories, a recording
// LLM and page fetcher. No database, no network.

import type { LLMChatResult } from '../../../../platform/llm/index.js';
import type { CampusLlm } from '../extract.js';
import type { CampusNotifyRepository, CampusProfile, DueReminder } from '../notify.js';
import type { CampusEventWrite, CampusRepository } from '../repository.js';
import type { CampusServiceDeps } from '../service.js';
import type { FetchedPage } from '../source.js';
import { compareByClose, eventMatches, type CampusEventRow, type CampusSubscriptionRow } from '../views.js';
import { campusCompanySlug, CAMPUS_REMINDER_DAYS } from '../contract.js';

export const NOW = new Date('2026-10-10T04:00:00.000Z');
export const DAY = 24 * 60 * 60 * 1000;

export function eventRow(over: Partial<CampusEventRow> = {}): CampusEventRow {
  return {
    id: 'ev_1',
    market: 'cn',
    companyName: '示例科技',
    companyId: null,
    title: '2027届校园招聘',
    graduationClass: '2027届',
    kind: 'application',
    applyOpensAt: new Date('2026-09-01T00:00:00+08:00'),
    applyClosesAt: new Date('2026-10-31T23:59:00+08:00'),
    stages: [{ kind: 'bishi', startsAt: '2026-11-05T01:00:00.000Z' }],
    cities: ['北京', '上海'],
    roles: ['产品'],
    officialUrl: 'https://campus.example.cn/2027',
    sourceUrl: null,
    sourceName: '示例科技校园招聘官网',
    sourceNote: null,
    status: 'published',
    verifiedAt: new Date(NOW.getTime() - 2 * DAY),
    verifiedByUserId: 'admin_1',
    createdBy: 'admin_1',
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    ...over,
  };
}

export interface FakeSub extends CampusSubscriptionRow {
  userId: string;
  lastNotifiedAt: Date | null;
  brand: string;
}

export interface FakeCampusRepo extends CampusRepository {
  events: Map<string, CampusEventRow>;
  subs: FakeSub[];
  classes: Map<string, number>;
  creates: number;
  brandOf: Map<string, string>;
}

let seq = 0;

export function fakeCampusRepo(events: CampusEventRow[] = []): FakeCampusRepo {
  const map = new Map(events.map((e) => [e.id, { ...e }]));
  const repo: FakeCampusRepo = {
    events: map,
    subs: [],
    classes: new Map(),
    creates: 0,
    brandOf: new Map(),
    async listPublished(market, filter, now, skip, take) {
      return [...map.values()].filter((r) => eventMatches(r, market, filter, now)).sort(compareByClose).slice(skip, skip + take);
    },
    async listPublishedByCompanySlug(market, slug, now, take) {
      return [...map.values()]
        .filter((r) => eventMatches(r, market, {}, now) && campusCompanySlug(r.companyName).toLowerCase() === slug.toLowerCase())
        .sort(compareByClose)
        .slice(0, take);
    },
    async findEvent(id) {
      const r = map.get(id);
      return r ? { ...r } : null;
    },
    async eventsByIds(ids) {
      return ids.map((id) => map.get(id)).filter((r): r is CampusEventRow => !!r);
    },
    async adminList(market, status, skip, take) {
      return [...map.values()].filter((r) => r.market === market && (!status || r.status === status)).slice(skip, skip + take);
    },
    async createEvent(data) {
      repo.creates += 1;
      seq += 1;
      const row = eventRow({
        id: `ev_new_${seq}`,
        companyId: null,
        applyOpensAt: null,
        applyClosesAt: null,
        stages: [],
        cities: [],
        roles: [],
        sourceUrl: null,
        sourceName: null,
        sourceNote: null,
        kind: 'application',
        ...(data as Partial<CampusEventRow>),
        createdAt: NOW,
        updatedAt: NOW,
      });
      map.set(row.id, row);
      return { ...row };
    },
    async updateEvent(id, data: CampusEventWrite) {
      const r = map.get(id);
      if (!r) throw new Error('missing');
      for (const [k, v] of Object.entries(data)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v;
      r.updatedAt = NOW;
      return { ...r };
    },
    async deleteEvent(id) {
      map.delete(id);
      repo.subs = repo.subs.filter((s) => s.eventId !== id);
    },
    async userLabels(ids) {
      return new Map(ids.map((id) => [id, `Staff ${id}`]));
    },
    async listSubscriptions(userId) {
      return repo.subs.filter((s) => s.userId === userId);
    },
    async subscribedEventIds(userId, eventIds) {
      return new Set(repo.subs.filter((s) => s.userId === userId && s.eventId && eventIds.includes(s.eventId)).map((s) => s.eventId!));
    },
    async upsertEventSubscription(userId, eventId, channel) {
      let s = repo.subs.find((x) => x.userId === userId && x.eventId === eventId);
      if (s) s.channel = channel;
      else {
        seq += 1;
        s = { id: `sub_${seq}`, userId, kind: 'event', eventId, companyNameNormalized: null, graduationClass: null, channel, createdAt: NOW, lastNotifiedAt: null, brand: repo.brandOf.get(userId) ?? 'goapply' };
        repo.subs.push(s);
      }
      return { ...s };
    },
    async upsertCompanySubscription(userId, companyNameNormalized, graduationClass, channel) {
      let s = repo.subs.find((x) => x.userId === userId && x.kind === 'company' && x.companyNameNormalized === companyNameNormalized);
      if (s) Object.assign(s, { graduationClass, channel });
      else {
        seq += 1;
        s = { id: `sub_${seq}`, userId, kind: 'company', eventId: null, companyNameNormalized, graduationClass, channel, createdAt: NOW, lastNotifiedAt: null, brand: repo.brandOf.get(userId) ?? 'goapply' };
        repo.subs.push(s);
      }
      return { ...s };
    },
    async deleteSubscription(userId, id) {
      const before = repo.subs.length;
      repo.subs = repo.subs.filter((s) => !(s.id === id && s.userId === userId));
      return repo.subs.length < before;
    },
    async graduationClassOf(userId) {
      return repo.classes.get(userId) ?? null;
    },
  };
  return repo;
}

/** Notify repository over the same in-memory state, plus an inbox ledger. */
export interface FakeNotifyRepo extends CampusNotifyRepository {
  inbox: Array<{ userId: string; templateKey: string; eventId: string }>;
  profileOf: Map<string, CampusProfile>;
}

/** `lock: false` makes withFollowLock a no-op (to show what the lock prevents). */
export function fakeNotifyRepo(campus: FakeCampusRepo, opts: { lock?: boolean } = {}): FakeNotifyRepo {
  const tails = new Map<string, Promise<unknown>>();
  const repo: FakeNotifyRepo = {
    inbox: [],
    profileOf: new Map(),
    async dueReminders(brand, market, now, afterId, take) {
      const horizon = now.getTime() + Math.max(...CAMPUS_REMINDER_DAYS) * DAY;
      const out: DueReminder[] = [];
      for (const s of [...campus.subs].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (afterId && s.id <= afterId) continue;
        if (s.kind !== 'event' || s.brand !== brand || !s.eventId) continue;
        const ev = campus.events.get(s.eventId);
        if (!ev || ev.market !== market || ev.status !== 'published' || !ev.verifiedAt || !ev.applyClosesAt) continue;
        const t = ev.applyClosesAt.getTime();
        if (t <= now.getTime() || t > horizon) continue;
        out.push({ subscriptionId: s.id, userId: s.userId, lastNotifiedAt: s.lastNotifiedAt, channel: s.channel, event: { ...ev } });
        if (out.length >= take) break;
      }
      return out;
    },
    async claimReminder(id, windowStart, now) {
      const s = campus.subs.find((x) => x.id === id);
      if (!s || (s.lastNotifiedAt && s.lastNotifiedAt.getTime() >= windowStart.getTime())) return false;
      s.lastNotifiedAt = now;
      return true;
    },
    async recentlyPublished(market, since, now) {
      return [...campus.events.values()].filter(
        (e) => e.market === market && e.status === 'published' && e.verifiedAt && e.verifiedAt >= since && (!e.applyClosesAt || e.applyClosesAt >= now),
      );
    },
    async followers(brand, normalized, cls) {
      return [...new Set(campus.subs.filter((s) => s.kind === 'company' && s.brand === brand && s.companyNameNormalized === normalized && s.graduationClass === cls).map((s) => s.userId))];
    },
    async emailFollowers(brand, normalized, cls, userIds) {
      return new Set(
        campus.subs
          .filter((s) => s.kind === 'company' && s.brand === brand && s.companyNameNormalized === normalized && s.graduationClass === cls && s.channel === 'email' && userIds.includes(s.userId))
          .map((s) => s.userId),
      );
    },
    async alreadyNotified(userIds, eventId) {
      return new Set(repo.inbox.filter((i) => i.eventId === eventId && i.templateKey === 'campus.followed' && userIds.includes(i.userId)).map((i) => i.userId));
    },
    async profiles(userIds) {
      return new Map(userIds.filter((u) => repo.profileOf.has(u)).map((u) => [u, repo.profileOf.get(u)!]));
    },
    async withFollowLock(eventId, fn) {
      if (opts.lock === false) return fn();
      // Mirrors pg_advisory_xact_lock: callers for one programme run one after another.
      const prev = tails.get(eventId) ?? Promise.resolve();
      const run = prev.then(fn, fn);
      tails.set(eventId, run.catch(() => undefined));
      return run;
    },
  };
  return repo;
}

export interface RecordingLlm extends CampusLlm {
  calls: number;
  reply: string;
}

export function recordingLlm(reply: string): RecordingLlm {
  const llm: RecordingLlm = {
    calls: 0,
    reply,
    async chatWithUsage() {
      llm.calls += 1;
      return { content: llm.reply, model: 'deepseek-chat', usage: { promptTokens: 10, completionTokens: 10 } } as unknown as LLMChatResult;
    },
  };
  return llm;
}

export const OFFICIAL_HTML = `<!doctype html><html><head><title>示例科技2027届校园招聘官网</title><script>var x = "2030年1月1日";</script></head>
<body><h1>示例科技 2027届校园招聘</h1>
<p>面向2027届毕业生（2026年9月至2027年8月毕业）。</p>
<p>网申时间：2026年9月1日-2026年10月31日 23:59</p>
<p>笔试时间：2026年11月5日</p>
<p>工作地点：北京、上海、深圳</p>
<p>招聘岗位：产品、研发</p>
</body></html>`;

export function fakePage(html = OFFICIAL_HTML, finalUrl = 'https://campus.example.cn/2027'): (url: string) => Promise<FetchedPage> {
  return async () => ({ finalUrl, html, contentType: 'text/html; charset=utf-8', fetchedAt: NOW });
}

export function serviceDeps(repo: FakeCampusRepo, over: Partial<CampusServiceDeps> = {}): CampusServiceDeps {
  return {
    repo,
    now: () => NOW,
    env: {},
    llm: recordingLlm('{}'),
    fetchPage: fakePage(),
    resolveModel: () => ({ model: 'deepseek-chat', provider: 'deepseek', available: true }),
    ...over,
  };
}

export const slugOf = campusCompanySlug;
