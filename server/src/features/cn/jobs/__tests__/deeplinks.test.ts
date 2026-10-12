// @vitest-environment node
// WP-41 acceptance: deep links contain only the user's query.
// MKT-3G (JC-5): nine boards are named; a board is linked only once its search
// URL pattern has been confirmed; every link is https on an allow-listed host;
// the boards of the user's audience come first.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../../services/LoggerService.js', () => ({ logger: log }));

import { CN_EXTERNAL_BOARDS, ExternalLinksQuerySchema } from '../contract.js';
import {
  CN_EXTERNAL_BOARD_SPECS,
  CN_EXTERNAL_HOSTS,
  SHIPPED_BEFORE_VERIFICATION_RULE,
  audienceForIdentity,
  boardSearchUrl,
  buildExternalSearchLinks,
  cnIdentityOf,
  externalHosts,
  externalKeyword,
  isVerified,
  orderForAudience,
  resolveLinkAudience,
  type BoardSpec,
  type CnIdentityDb,
  type VerifiedBoardSpec,
} from '../deeplinks.js';

/** The three boards WP-41 shipped. */
const SHIPPED = ['boss', 'zhaopin', 'liepin'];
const CAMPUS = ['shixiseng', 'nowcoder', 'ncss', 'iguopin'];
const EXPERIENCED = ['boss', 'zhaopin', 'liepin', 'job51', 'lagou'];

/**
 * SYNTHETIC. The real table with every unconfirmed board switched on at a
 * made-up address under the reserved `.test` domain, so the order and the
 * allow-list rule are tested for all nine boards before their real patterns
 * are confirmed. None of these addresses is a real search page.
 */
const ALL_NINE: BoardSpec[] = CN_EXTERNAL_BOARD_SPECS.map((s) =>
  isVerified(s) ? s : { ...s, host: `${s.board}.search.test`, url: (k: string) => `https://${s.board}.search.test/jobs?q=${encodeURIComponent(k)}`, verifiedOn: '2026-10-11' },
);

const HOUR = 3_600_000;
const CHECK_DATE = /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * What is wrong with a confirmed board's `verifiedOn`, or null.
 *   - The three boards WP-41 shipped carry the marker until somebody checks
 *     them, and a real check date from then on.
 *   - Every other board needs a real check date: the marker is refused.
 *   - A date is a real calendar day and not in the future. "Today" is the
 *     latest date anywhere on Earth (UTC+14): the person who fills a row works
 *     from a mainland network (UTC+8), where the morning is still yesterday in
 *     UTC.
 */
function verifiedOnProblem(spec: { board: string; verifiedOn: string }, now: number = Date.now()): string | null {
  if (spec.verifiedOn === SHIPPED_BEFORE_VERIFICATION_RULE) {
    return SHIPPED.includes(spec.board) ? null : `${spec.board}: only the three boards WP-41 shipped may carry the marker`;
  }
  if (!CHECK_DATE.test(spec.verifiedOn)) return `${spec.board}: verifiedOn is not a YYYY-MM-DD date`;
  const day = new Date(`${spec.verifiedOn}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== spec.verifiedOn) return `${spec.board}: verifiedOn is not a calendar day`;
  if (spec.verifiedOn > new Date(now + 14 * HOUR).toISOString().slice(0, 10)) return `${spec.board}: verifiedOn is in the future`;
  return null;
}

/** Keywords a user may type: Chinese, spaces, URL syntax, markup, control characters, other scripts. */
const KEYWORDS: Array<[label: string, q: string, city?: string]> = [
  ['Chinese with a city', '产品经理', '上海'],
  ['Latin with spaces', '  senior   java  engineer ', ''],
  ['query syntax', 'a&userId=1#x'],
  ['a URL', 'https://evil.example/?next=//x', 'x@y'],
  ['slashes and dots', '../../etc/passwd', '..'],
  ['at sign and colon', 'user:pass@evil.example'],
  ['percent and plus', '100%+ C++/C#'],
  ['markup and quotes', '<script>alert("1")</script>', "'北京'"],
  ['control characters', 'java\n后端\t开发\u0000\u007f', '深\r圳'],
  ['backslashes', '\\\\evil.example\\share'],
  ['emoji and full-width', '前端 🚀 ＡＩ', '杭州市'],
  ['mixed scripts', 'データ分析 analyste données 데이터'],
];

describe('the board table', () => {
  it('names the nine boards once each, in each audience\'s display order', () => {
    expect(CN_EXTERNAL_BOARD_SPECS.map((s) => s.board).sort()).toEqual([...CN_EXTERNAL_BOARDS].sort());
    expect(new Set(CN_EXTERNAL_BOARD_SPECS.map((s) => s.board)).size).toBe(9);
    expect(new Set(CN_EXTERNAL_BOARD_SPECS.map((s) => s.label)).size).toBe(9);
    expect(CN_EXTERNAL_BOARD_SPECS.filter((s) => s.audience === 'experienced').map((s) => s.board)).toEqual(EXPERIENCED);
    expect(CN_EXTERNAL_BOARD_SPECS.filter((s) => s.audience === 'campus').map((s) => s.board)).toEqual(CAMPUS);
    expect(CN_EXTERNAL_BOARD_SPECS.map((s) => s.label)).toEqual(['BOSS直聘', '智联招聘', '猎聘', '前程无忧', '拉勾', '实习僧', '牛客', '24365', '国聘']);
  });

  it('a board is either confirmed (host, pattern and a check date) or carries no address at all', () => {
    for (const s of CN_EXTERNAL_BOARD_SPECS) {
      if (!isVerified(s)) {
        expect([s.board, s.host, s.url]).toEqual([s.board, null, null]);
        continue;
      }
      expect(typeof s.url).toBe('function');
      expect(s.host).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(verifiedOnProblem(s)).toBeNull();
    }
  });

  it('the check-date rule: a real day, not in the future anywhere on Earth; the WP-41 marker only on the three shipped boards', () => {
    const now = Date.parse('2026-10-11T17:00:00.000Z'); // 01:00 on 12 October in mainland China
    const problem = (board: string, verifiedOn: string) => verifiedOnProblem({ board, verifiedOn }, now);
    // The three shipped boards: the marker, or the day somebody checked them.
    for (const board of SHIPPED) {
      expect(problem(board, SHIPPED_BEFORE_VERIFICATION_RULE)).toBeNull();
      expect(problem(board, '2026-10-11')).toBeNull();
    }
    // Any other board needs a date; the marker is refused.
    expect(problem('shixiseng', '2026-10-11')).toBeNull();
    expect(problem('shixiseng', SHIPPED_BEFORE_VERIFICATION_RULE)).toMatch(/marker/);
    expect(problem('job51', SHIPPED_BEFORE_VERIFICATION_RULE)).toMatch(/marker/);
    // A row dated in the local morning of a zone ahead of UTC is not "the future".
    expect(problem('shixiseng', '2026-10-12')).toBeNull();
    expect(problem('boss', '2026-10-12')).toBeNull();
    expect(problem('shixiseng', '2026-10-13')).toMatch(/future/);
    expect(problem('boss', '2027-01-01')).toMatch(/future/);
    // Not a date, or not a day that exists.
    for (const bad of ['', 'yes', '2026-10', '11/10/2026', '2026-13-01', '1999-01-01', '2026-10-11T00:00:00Z']) expect(problem('shixiseng', bad), bad).toMatch(/YYYY-MM-DD/);
    for (const bad of ['2026-02-30', '2026-04-31', '2025-02-29']) expect(problem('shixiseng', bad), bad).toMatch(/calendar day/);
  });

  it('CN_EXTERNAL_HOSTS lists exactly the hosts of the boards that are offered', () => {
    const offered = CN_EXTERNAL_BOARD_SPECS.filter(isVerified);
    expect([...CN_EXTERNAL_HOSTS].sort()).toEqual(offered.map((s) => s.host).sort());
    expect(new Set(CN_EXTERNAL_HOSTS).size).toBe(offered.length);
    expect(externalHosts(ALL_NINE)).toHaveLength(9);
  });
});

describe('external search deep links', () => {
  it('the three links WP-41 shipped are unchanged, byte for byte', () => {
    const kw = '%E4%BA%A7%E5%93%81%E7%BB%8F%E7%90%86%20%E4%B8%8A%E6%B5%B7';
    const shipped = buildExternalSearchLinks('产品经理', '上海').links.filter((l) => SHIPPED.includes(l.board));
    expect(shipped.map((l) => [l.board, l.label, l.url])).toEqual([
      ['boss', 'BOSS直聘', `https://www.zhipin.com/web/geek/job?query=${kw}`],
      ['zhaopin', '智联招聘', `https://sou.zhaopin.com/?kw=${kw}`],
      ['liepin', '猎聘', `https://www.liepin.com/zhaopin/?key=${kw}`],
    ]);
  });

  it('a board whose pattern is not confirmed is never returned', () => {
    const unconfirmed = CN_EXTERNAL_BOARD_SPECS.filter((s) => !isVerified(s)).map((s) => s.board);
    for (const audience of ['campus', 'experienced'] as const) {
      const boards = buildExternalSearchLinks('产品经理', '上海', audience).links.map((l) => l.board);
      expect(boards).toEqual(orderForAudience(CN_EXTERNAL_BOARD_SPECS.filter(isVerified), audience).map((s) => s.board));
      for (const b of unconfirmed) expect(boards).not.toContain(b);
    }
    const off: BoardSpec[] = ALL_NINE.map((s) => (s.board === 'nowcoder' ? { board: s.board, label: s.label, audience: s.audience, host: null, url: null, verifiedOn: null } : s));
    expect(buildExternalSearchLinks('x', null, 'campus', off).links.map((l) => l.board)).toEqual(['shixiseng', 'ncss', 'iguopin', ...EXPERIENCED]);
  });

  describe.each([
    ['the boards offered today', CN_EXTERNAL_BOARD_SPECS],
    ['all nine boards (SYNTHETIC addresses)', ALL_NINE],
  ])('%s', (_name, specs) => {
    const hosts = externalHosts(specs);

    it.each(KEYWORDS)('%s: every link is https, on its board\'s allow-listed host, and carries only the keyword', (_label, q, city) => {
      const keyword = externalKeyword(q, city);
      expect(keyword).not.toMatch(/[\u0000-\u001f\u007f]/);
      for (const audience of ['campus', 'experienced'] as const) {
        const { links } = buildExternalSearchLinks(q, city, audience, specs);
        expect(links).toHaveLength(specs.filter(isVerified).length);
        for (const l of links) {
          const spec = specs.find((s) => s.board === l.board)!;
          const url = new URL(l.url);
          expect(url.protocol).toBe('https:');
          expect(url.host).toBe(spec.host);
          expect(hosts).toContain(url.host);
          expect(url.username + url.password + url.port + url.hash).toBe('');
          // One query parameter, and it is the keyword: no user id, no profile data, no tracking parameter.
          const params = [...url.searchParams.entries()];
          expect(params).toHaveLength(1);
          expect(params[0]![1]).toBe(keyword);
          // The rest of the URL does not depend on what was typed.
          const fixed = buildExternalSearchLinks('x', null, audience, specs).links.find((x) => x.board === l.board)!.url;
          expect(l.url.replace(encodeURIComponent(keyword), 'x')).toBe(fixed);
          expect(l.audience).toBe(spec.audience);
          expect(l.label).toBe(spec.label);
        }
      }
    });
  });

  it('control characters and extra spaces are removed; no city → only the query', () => {
    expect(externalKeyword(' java\n后端\t ', '')).toBe('java 后端');
    const { links } = buildExternalSearchLinks('数据分析');
    expect(new URL(links[0]!.url).searchParams.get('query')).toBe('数据分析');
  });

  it('a query that is only whitespace builds nothing', () => {
    expect(buildExternalSearchLinks('   ')).toEqual({ links: [] });
    expect(buildExternalSearchLinks('\n\t', '  ', 'campus', ALL_NINE)).toEqual({ links: [] });
  });

  it('special characters are encoded, not interpreted', () => {
    const { links } = buildExternalSearchLinks('a&userId=1#x');
    for (const l of links) {
      const url = new URL(l.url);
      expect([...url.searchParams.keys()]).toHaveLength(1);
      expect([...url.searchParams.values()][0]).toBe('a&userId=1#x');
    }
  });

  it('a pattern that builds a URL off its own host, or not https, is refused', () => {
    const base = ALL_NINE.find((s) => s.board === 'shixiseng') as VerifiedBoardSpec;
    const bad: Array<[string, (k: string) => string]> = [
      ['another host', (k) => `https://other.search.test/jobs?q=${encodeURIComponent(k)}`],
      ['a host the keyword chose', (k) => `https://${k}/jobs`],
      ['a keyword that was not encoded', (k) => `https://shixiseng.search.test@${k}/`],
      ['http', (k) => `http://shixiseng.search.test/jobs?q=${encodeURIComponent(k)}`],
      ['a port', (k) => `https://shixiseng.search.test:8443/jobs?q=${encodeURIComponent(k)}`],
      ['credentials', (k) => `https://u:p@shixiseng.search.test/jobs?q=${encodeURIComponent(k)}`],
    ];
    for (const [name, url] of bad) {
      expect(() => boardSearchUrl({ ...base, url }, 'evil.example'), name).toThrow(/shixiseng/);
      expect(() => buildExternalSearchLinks('evil.example', null, 'campus', [{ ...base, url }]), name).toThrow();
    }
    expect(boardSearchUrl(base, '产品')).toBe('https://shixiseng.search.test/jobs?q=%E4%BA%A7%E5%93%81');
  });
});

describe('order by audience', () => {
  it('a campus user sees 实习僧, 牛客, 24365 and 国聘 first, then the five general boards', () => {
    const { links } = buildExternalSearchLinks('管培生', '成都', 'campus', ALL_NINE);
    expect(links.map((l) => l.board)).toEqual([...CAMPUS, ...EXPERIENCED]);
    expect(links.map((l) => l.label)).toEqual(['实习僧', '牛客', '24365', '国聘', 'BOSS直聘', '智联招聘', '猎聘', '前程无忧', '拉勾']);
    expect(links.map((l) => l.audience)).toEqual([...CAMPUS.map(() => 'campus'), ...EXPERIENCED.map(() => 'experienced')]);
  });

  it('an experienced user sees BOSS直聘, 智联招聘, 猎聘, 前程无忧 and 拉勾 first; nothing is hidden', () => {
    const { links } = buildExternalSearchLinks('后端开发', null, 'experienced', ALL_NINE);
    expect(links.map((l) => l.board)).toEqual([...EXPERIENCED, ...CAMPUS]);
    expect(buildExternalSearchLinks('后端开发', null, undefined, ALL_NINE).links.map((l) => l.board)).toEqual([...EXPERIENCED, ...CAMPUS]);
  });

  it('with only the confirmed boards, the order rule is the same', () => {
    for (const audience of ['campus', 'experienced'] as const) {
      const expected = (audience === 'campus' ? [...CAMPUS, ...EXPERIENCED] : [...EXPERIENCED, ...CAMPUS]).filter((b) => CN_EXTERNAL_BOARD_SPECS.some((s) => s.board === b && isVerified(s)));
      expect(buildExternalSearchLinks('x', null, audience).links.map((l) => l.board)).toEqual(expected);
    }
  });

  it('a board for both audiences sorts with the audience asked for', () => {
    const specs = [{ id: 'a', audience: 'experienced' }, { id: 'b', audience: 'both' }, { id: 'c', audience: 'campus' }] as const;
    expect(orderForAudience(specs, 'campus').map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(orderForAudience(specs, 'experienced').map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('audience of a user', () => {
  beforeEach(() => log.warn.mockClear());

  it('在校生 and 应届 are campus; 社招, any other value and no answer are experienced', () => {
    expect(audienceForIdentity('zaixiao')).toBe('campus');
    expect(audienceForIdentity('yingjie')).toBe('campus');
    for (const other of ['shezhao', 'wangjie', 'student', '', null, undefined]) expect(audienceForIdentity(other)).toBe('experienced');
  });

  it('the query accepts campus or experienced and nothing else', () => {
    expect(ExternalLinksQuerySchema.parse({ q: ' 运营 ', audience: 'campus' })).toEqual({ q: '运营', audience: 'campus' });
    expect(ExternalLinksQuerySchema.parse({ q: '运营' })).toEqual({ q: '运营' });
    expect(ExternalLinksQuerySchema.safeParse({ q: '运营', audience: 'both' }).success).toBe(false);
    expect(ExternalLinksQuerySchema.safeParse({ q: '运营', audience: '' }).success).toBe(false);
  });

  const db = (cnFields: unknown, onboardingAnswers: unknown): CnIdentityDb => ({
    rAProfile: { findUnique: vi.fn(async () => (cnFields === undefined ? null : { cnFields })) },
    seekerProfile: { findUnique: vi.fn(async () => (onboardingAnswers === undefined ? null : { onboardingAnswers })) },
  });

  it('reads the identity from the profile, else from the stored onboarding answer; never from a class year alone', async () => {
    expect(await cnIdentityOf('u1', db({ identity: 'zaixiao' }, undefined))).toBe('zaixiao');
    expect(await cnIdentityOf('u1', db(undefined, { identity: { cnIdentity: 'yingjie', graduationClass: 2027 } }))).toBe('yingjie');
    // The profile is the current answer: a graduate who corrected it is no longer a campus user.
    expect(await cnIdentityOf('u1', db({ identity: 'shezhao' }, { identity: { cnIdentity: 'yingjie' } }))).toBe('shezhao');
    // A profile without a valid identity falls back to the onboarding answer.
    expect(await cnIdentityOf('u1', db({ identity: 'graduate' }, { identity: { cnIdentity: 'zaixiao' } }))).toBe('zaixiao');
    expect(await cnIdentityOf('u1', db(['zaixiao'], { identity: { cnIdentity: 'zaixiao' } }))).toBe('zaixiao');
    // A class year or an age with no identity answer says nothing.
    expect(await cnIdentityOf('u1', db({ graduationClass: 2027, birthYear: 2004 }, { identity: { graduationClass: 2027 } }))).toBeNull();
    expect(await cnIdentityOf('u1', db(undefined, undefined))).toBeNull();
    expect(await cnIdentityOf('u1', db(null, 'yingjie'))).toBeNull();
    const d = db({ identity: 'yingjie' }, undefined);
    await cnIdentityOf('u9', d);
    expect(d.rAProfile.findUnique).toHaveBeenCalledWith({ where: { userId: 'u9' }, select: { cnFields: true } });
    expect(d.seekerProfile.findUnique).toHaveBeenCalledWith({ where: { userId: 'u9' }, select: { onboardingAnswers: true } });
  });

  it('an explicit audience wins and reads nothing; a failed read answers the experienced order', async () => {
    const identityOf = vi.fn(async () => 'zaixiao');
    expect(await resolveLinkAudience('experienced', 'u1', identityOf)).toBe('experienced');
    expect(await resolveLinkAudience('campus', 'u1', identityOf)).toBe('campus');
    expect(identityOf).not.toHaveBeenCalled();
    expect(await resolveLinkAudience(undefined, 'u1', identityOf)).toBe('campus');
    expect(identityOf).toHaveBeenCalledWith('u1');
    expect(await resolveLinkAudience(undefined, 'u1', async () => null)).toBe('experienced');
    expect(await resolveLinkAudience(undefined, 'u1', async () => 'shezhao')).toBe('experienced');
    // Nothing failed so far: nothing was logged.
    expect(log.warn).not.toHaveBeenCalled();
    expect(await resolveLinkAudience(undefined, 'u1', async () => Promise.reject(new Error('database down')))).toBe('experienced');
  });

  it('a failed identity read is logged once, without the user', async () => {
    expect(await resolveLinkAudience(undefined, 'user_secret_42', async () => Promise.reject(new Error('column "cnFields" does not exist')))).toBe('experienced');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('CN_JOBS', expect.stringContaining('identity read failed'), { error: 'column "cnFields" does not exist' });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('user_secret_42');
    // A rejection that is not an Error is logged as text.
    expect(await resolveLinkAudience(undefined, 'u1', async () => Promise.reject('offline'))).toBe('experienced');
    expect(log.warn).toHaveBeenLastCalledWith('CN_JOBS', expect.any(String), { error: 'offline' });
    // An explicit audience reads nothing, so it has nothing to log.
    log.warn.mockClear();
    expect(await resolveLinkAudience('campus', 'u1', async () => Promise.reject(new Error('never called')))).toBe('campus');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('a logger that throws does not fail the links', async () => {
    log.warn.mockImplementationOnce(() => {
      throw new Error('log file closed');
    });
    expect(await resolveLinkAudience(undefined, 'u1', async () => Promise.reject(new Error('database down')))).toBe('experienced');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
