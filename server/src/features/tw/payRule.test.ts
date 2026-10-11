// @vitest-environment node
//
// MKT-5F (JT-6): the pay-disclosure rule from config. The database is a small
// in-memory fake of the one AppConfig row; no network, no real database.
import { describe, expect, it } from 'vitest';

import { TW_PAY_RULE_CONFIG_KEY, TW_PAY_RULE_LIMITS } from './contract.js';
import {
  TW_PAY_RULE_CALLER_MAX_AGE_S,
  TW_PAY_RULE_DEFAULT,
  TW_PAY_RULE_HOLD_MS,
  TW_PAY_RULE_MAX_STALE_MS,
  TwPayRuleValidationError,
  adminTwPayRule,
  createTwPayRuleHold,
  parseStoredTwPayRule,
  publicTwPayRule,
  readTwPayRule,
  saveTwPayRule,
  taipeiToday,
  validateTwPayRule,
} from './payRule.js';
import type { TwPayRuleRead } from './payRule.js';
import { fakeAppConfig } from './testkit.js';

const NOW = new Date('2026-10-12T03:00:00.000Z');

const ENTRY = { thresholdTwd: 50_000, lawLabel: '就業服務法第5條第2項第6款', sourceUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5', asOf: '2026-10-12' };

describe('the default: the law in force as read on 2026-10-11', () => {
  it('is NT$40,000, the provision in the law\'s own words, the Ministry of Justice law database and the day it was read', () => {
    expect(TW_PAY_RULE_DEFAULT).toEqual({
      thresholdTwd: 40000,
      lawLabel: '就業服務法第5條第2項第6款',
      sourceUrl: 'https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5',
      asOf: '2026-10-11',
    });
    expect(Object.isFrozen(TW_PAY_RULE_DEFAULT)).toBe(true);
    // The default passes the rules an admin's entry must pass.
    expect(validateTwPayRule(TW_PAY_RULE_DEFAULT, NOW)).toEqual([]);
    expect(TW_PAY_RULE_CONFIG_KEY).toBe('tw.payRule.v1');
  });

  it('ACCEPT: with no row the note gets NT$40,000, the law link and 2026-10-11, marked as the default', async () => {
    const { db, calls } = fakeAppConfig();
    const read = await readTwPayRule(db, NOW);
    expect(read).toEqual({ stored: 'default', rule: { ...TW_PAY_RULE_DEFAULT, updatedAt: null, updatedBy: null } });
    expect(publicTwPayRule(read)).toEqual({ ...TW_PAY_RULE_DEFAULT, isDefault: true });
    expect(calls).toEqual([{ op: 'findUnique', key: 'tw.payRule.v1' }]);
  });
});

describe('validation of an entry', () => {
  const issuesOf = (over: Record<string, unknown>) => validateTwPayRule({ ...ENTRY, ...over }, NOW).map((i) => i.path);

  it('accepts a whole number of thousands inside the bounds, an https link and a day up to today in Taipei', () => {
    expect(validateTwPayRule(ENTRY, NOW)).toEqual([]);
    for (const thresholdTwd of [10_000, 40_000, 50_000, 52_000, 200_000]) expect(issuesOf({ thresholdTwd }), String(thresholdTwd)).toEqual([]);
    expect(TW_PAY_RULE_LIMITS).toMatchObject({ minTwd: 10_000, maxTwd: 200_000, stepTwd: 1_000 });
  });

  it.each([45_500, 40_001, 9_000, 0, -40_000, 201_000, 1_000_000, 40_000.5, Number.NaN, Number.POSITIVE_INFINITY, '50000', null, undefined])('ACCEPT: threshold %s is refused', (thresholdTwd) => {
    expect(issuesOf({ thresholdTwd })).toEqual(['thresholdTwd']);
  });

  it.each(['http://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=N0090001&flno=5', 'law.moj.gov.tw', 'javascript:alert(1)', 'ftp://law.moj.gov.tw/x', 'https://', 'https://user:pass@law.moj.gov.tw/x', '', '   ', `https://law.moj.gov.tw/${'x'.repeat(500)}`, 7, null])(
    'ACCEPT: source %s is refused (https only)',
    (sourceUrl) => {
      expect(issuesOf({ sourceUrl })).toEqual(['sourceUrl']);
    },
  );

  it.each(['2026-10-13', '2027-01-01', '2026-02-30', '2026-13-01', '2026/10/11', '11-10-2026', '20261011', 'today', '', null, 20261011])('ACCEPT: as-of %s is refused (a real day, not in the future)', (asOf) => {
    expect(issuesOf({ asOf })).toEqual(['asOf']);
  });

  it('"today" is Taipei\'s day: an entry dated today in Taipei passes while UTC is still on the day before', () => {
    const lateUtc = new Date('2026-10-11T16:30:00.000Z');
    expect(taipeiToday(lateUtc)).toBe('2026-10-12');
    expect(validateTwPayRule({ ...ENTRY, asOf: '2026-10-12' }, lateUtc)).toEqual([]);
    expect(validateTwPayRule({ ...ENTRY, asOf: '2026-10-13' }, lateUtc).map((i) => i.path)).toEqual(['asOf']);
    expect(taipeiToday(new Date('2026-10-11T15:59:59.000Z'))).toBe('2026-10-11');
  });

  it('the provision is one line of at most 120 characters', () => {
    expect(issuesOf({ lawLabel: '' })).toEqual(['lawLabel']);
    expect(issuesOf({ lawLabel: '   ' })).toEqual(['lawLabel']);
    expect(issuesOf({ lawLabel: '條'.repeat(121) })).toEqual(['lawLabel']);
    expect(issuesOf({ lawLabel: '第5條\n第2項' })).toEqual(['lawLabel']);
    expect(issuesOf({ lawLabel: 7 })).toEqual(['lawLabel']);
    expect(issuesOf({ lawLabel: '條'.repeat(120) })).toEqual([]);
  });

  it('reports every broken field at once, and never throws on junk', () => {
    expect(validateTwPayRule({ thresholdTwd: 45_500, lawLabel: '', sourceUrl: 'http://x.test', asOf: '2030-01-01' }, NOW).map((i) => i.path)).toEqual(['thresholdTwd', 'lawLabel', 'sourceUrl', 'asOf']);
    for (const junk of [null, undefined, 'x', 7, [], {}]) expect(validateTwPayRule(junk, NOW).map((i) => i.path)).toEqual(['thresholdTwd', 'lawLabel', 'sourceUrl', 'asOf']);
  });
});

describe('save and read', () => {
  it('ACCEPT: storing 50,000 with a new as-of date changes what the next read answers, with no deploy', async () => {
    const { db, rows } = fakeAppConfig();
    expect(publicTwPayRule(await readTwPayRule(db, NOW))).toMatchObject({ thresholdTwd: 40000, asOf: '2026-10-11', isDefault: true });
    const saved = await saveTwPayRule(db, ENTRY, 'admin_1', NOW);
    expect(saved).toEqual({ ...ENTRY, updatedAt: '2026-10-12T03:00:00.000Z', updatedBy: 'admin_1' });
    // The stored value is the documented shape under the documented key.
    expect(JSON.parse(rows.get('tw.payRule.v1')!.value)).toEqual({ thresholdTwd: 50000, lawLabel: ENTRY.lawLabel, sourceUrl: ENTRY.sourceUrl, asOf: '2026-10-12', updatedAt: '2026-10-12T03:00:00.000Z', updatedBy: 'admin_1' });
    expect(rows.get('tw.payRule.v1')!.updatedBy).toBe('admin_1');
    const read = await readTwPayRule(db, NOW);
    expect(read).toEqual({ stored: 'config', rule: saved });
    expect(publicTwPayRule(read)).toEqual({ thresholdTwd: 50000, lawLabel: ENTRY.lawLabel, sourceUrl: ENTRY.sourceUrl, asOf: '2026-10-12', isDefault: false });
    // A second save replaces the first.
    await saveTwPayRule(db, { ...ENTRY, thresholdTwd: 52_000 }, 'admin_2', new Date('2026-10-12T05:00:00.000Z'));
    expect(publicTwPayRule(await readTwPayRule(db, NOW))).toMatchObject({ thresholdTwd: 52000, isDefault: false });
    expect(rows.size).toBe(1);
  });

  it('trims what an admin typed and stores nothing else', async () => {
    const { db, rows } = fakeAppConfig();
    await saveTwPayRule(db, { ...ENTRY, lawLabel: `  ${ENTRY.lawLabel} `, sourceUrl: ` ${ENTRY.sourceUrl} `, asOf: ' 2026-10-12 ', extra: 'x' } as never, null, NOW);
    expect(JSON.parse(rows.get('tw.payRule.v1')!.value)).toEqual({ ...ENTRY, updatedAt: '2026-10-12T03:00:00.000Z', updatedBy: null });
  });

  it('ACCEPT: an invalid entry (45,500, an http link, a future date) is refused and nothing is written', async () => {
    const { db, rows, calls } = fakeAppConfig();
    for (const bad of [{ ...ENTRY, thresholdTwd: 45_500 }, { ...ENTRY, sourceUrl: 'http://law.moj.gov.tw/x' }, { ...ENTRY, asOf: '2026-10-13' }, {}, null]) {
      await expect(saveTwPayRule(db, bad, 'admin_1', NOW)).rejects.toBeInstanceOf(TwPayRuleValidationError);
    }
    const err = await saveTwPayRule(db, { ...ENTRY, thresholdTwd: 45_500, asOf: '2030-01-01' }, 'admin_1', NOW).catch((e: unknown) => e);
    expect((err as TwPayRuleValidationError).issues.map((i) => i.path)).toEqual(['thresholdTwd', 'asOf']);
    expect(rows.size).toBe(0);
    expect(calls.filter((c) => c.op === 'upsert')).toEqual([]);
  });

  it('a stored value that is not a valid rule gives no rule at all: never the default, never a number we cannot vouch for', async () => {
    const stored = (value: string) => fakeAppConfig({ 'tw.payRule.v1': { value, updatedBy: 'someone' } }).db;
    for (const value of [
      'not json',
      '[]',
      '"x"',
      '{}',
      JSON.stringify({ ...ENTRY, thresholdTwd: 45_500 }),
      JSON.stringify({ ...ENTRY, thresholdTwd: '50000' }),
      JSON.stringify({ ...ENTRY, sourceUrl: 'http://law.moj.gov.tw/x' }),
      JSON.stringify({ ...ENTRY, asOf: '2031-01-01' }),
      JSON.stringify({ TWD: ENTRY }),
    ]) {
      const read = await readTwPayRule(stored(value), NOW);
      expect(read, value).toEqual({ stored: 'invalid', rule: null, updatedAt: null, updatedBy: 'someone' });
      expect(publicTwPayRule(read), value).toBeNull();
      expect(parseStoredTwPayRule(value, NOW), value).toBeNull();
    }
    expect(parseStoredTwPayRule(null, NOW)).toBeNull();
    expect(parseStoredTwPayRule('', NOW)).toBeNull();
  });

  it('the admin view says where the answer comes from and who stored it', async () => {
    const empty = fakeAppConfig();
    expect(adminTwPayRule(await readTwPayRule(empty.db, NOW))).toEqual({
      rule: { ...TW_PAY_RULE_DEFAULT, isDefault: true },
      stored: 'default',
      updatedAt: null,
      updatedBy: null,
      default: { ...TW_PAY_RULE_DEFAULT },
      limits: TW_PAY_RULE_LIMITS,
    });
    await saveTwPayRule(empty.db, ENTRY, 'admin_1', NOW);
    expect(adminTwPayRule(await readTwPayRule(empty.db, NOW))).toMatchObject({ rule: { thresholdTwd: 50000, isDefault: false }, stored: 'config', updatedAt: '2026-10-12T03:00:00.000Z', updatedBy: 'admin_1' });
    const broken = fakeAppConfig({ 'tw.payRule.v1': { value: 'not json', updatedBy: 'admin_9' } });
    expect(adminTwPayRule(await readTwPayRule(broken.db, NOW))).toMatchObject({ rule: null, stored: 'invalid', updatedBy: 'admin_9', default: { thresholdTwd: 40000 } });
  });

  it('the rule is a note about the law: the module has no way to write it to a job, a filter or a pay field', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('./payRule.ts', import.meta.url), 'utf8'));
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/rAJob|salaryMin|salaryMax|salaryAnnual|FilterSet|searchProfile/);
    expect(code).toMatch(/appConfig/);
  });
});

describe('the in-process hold of the rule (review finding: the open route is not a database read per request)', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const read = (amount: number): TwPayRuleRead => ({ stored: 'config', rule: { ...TW_PAY_RULE_DEFAULT, thresholdTwd: amount, updatedAt: null, updatedBy: null } });

  it('the 5 minutes an edit may take are one minute here and four at the caller', () => {
    expect(TW_PAY_RULE_MAX_STALE_MS).toBe(300_000);
    expect(TW_PAY_RULE_HOLD_MS).toBe(60_000);
    expect(TW_PAY_RULE_CALLER_MAX_AGE_S).toBe(240);
    expect(TW_PAY_RULE_HOLD_MS + TW_PAY_RULE_CALLER_MAX_AGE_S * 1000).toBe(TW_PAY_RULE_MAX_STALE_MS);
  });

  it('keeps one read for a minute and reads again after it', async () => {
    const hold = createTwPayRuleHold();
    let loads = 0;
    const load = async () => read(40_000 + 1000 * ++loads);
    expect((await hold.read(load, at(0))).rule?.thresholdTwd).toBe(41_000);
    expect((await hold.read(load, at(1))).rule?.thresholdTwd).toBe(41_000);
    expect((await hold.read(load, at(TW_PAY_RULE_HOLD_MS - 1))).rule?.thresholdTwd).toBe(41_000);
    expect(loads).toBe(1);
    expect((await hold.read(load, at(TW_PAY_RULE_HOLD_MS))).rule?.thresholdTwd).toBe(42_000);
    expect(loads).toBe(2);
    // The minute counts from the read that is held, not from the first one.
    expect((await hold.read(load, at(2 * TW_PAY_RULE_HOLD_MS - 1))).rule?.thresholdTwd).toBe(42_000);
    expect(loads).toBe(2);
  });

  it('requests that arrive while a read is under way wait for that one read', async () => {
    const hold = createTwPayRuleHold();
    let loads = 0;
    let release: (value: TwPayRuleRead) => void = () => undefined;
    const load = () => {
      loads += 1;
      return new Promise<TwPayRuleRead>((resolve) => (release = resolve));
    };
    const waiting = [hold.read(load, at(0)), hold.read(load, at(5)), hold.read(load, at(9))];
    expect(loads).toBe(1);
    release(read(50_000));
    expect((await Promise.all(waiting)).map((r) => r.rule?.thresholdTwd)).toEqual([50_000, 50_000, 50_000]);
    expect((await hold.read(load, at(20))).rule?.thresholdTwd).toBe(50_000);
    expect(loads).toBe(1);
  });

  it('a read that fails is not kept: everyone waiting gets the failure, and the next request reads again', async () => {
    const hold = createTwPayRuleHold();
    let loads = 0;
    const failing = async () => {
      loads += 1;
      throw new Error('database is away');
    };
    await expect(Promise.all([hold.read(failing, at(0)), hold.read(failing, at(1))])).rejects.toThrow('database is away');
    expect(loads).toBe(1);
    expect((await hold.read(async () => read(40_000), at(2))).rule?.thresholdTwd).toBe(40_000);
  });

  it('clear() forgets the value, and a read that began before it cannot put its old answer back', async () => {
    const hold = createTwPayRuleHold();
    expect((await hold.read(async () => read(40_000), at(0))).rule?.thresholdTwd).toBe(40_000);
    hold.clear();
    expect((await hold.read(async () => read(50_000), at(1))).rule?.thresholdTwd).toBe(50_000);
    // A slow read of the old row, a save in between, then the old read lands.
    const fresh = createTwPayRuleHold();
    let release: (value: TwPayRuleRead) => void = () => undefined;
    const slow = fresh.read(() => new Promise<TwPayRuleRead>((resolve) => (release = resolve)), at(0));
    fresh.clear();
    release(read(40_000));
    expect((await slow).rule?.thresholdTwd).toBe(40_000);
    // The one who asked before the save got the old row; nobody after it does.
    expect((await fresh.read(async () => read(50_000), at(2))).rule?.thresholdTwd).toBe(50_000);
  });

  it('a clock that went backwards is not trusted: the row is read again', async () => {
    const hold = createTwPayRuleHold();
    let loads = 0;
    const load = async () => read(40_000 + 1000 * ++loads);
    await hold.read(load, at(10_000));
    expect((await hold.read(load, at(0))).rule?.thresholdTwd).toBe(42_000);
  });

  it('holds what the row says, whatever it says: the default and an unreadable row too', async () => {
    const hold = createTwPayRuleHold();
    const empty = fakeAppConfig();
    expect((await hold.read(() => readTwPayRule(empty.db, NOW), NOW)).stored).toBe('default');
    expect((await hold.read(() => readTwPayRule(empty.db, NOW), NOW)).stored).toBe('default');
    expect(empty.calls).toHaveLength(1);
    const broken = fakeAppConfig({ 'tw.payRule.v1': { value: 'not json' } });
    const other = createTwPayRuleHold();
    expect(publicTwPayRule(await other.read(() => readTwPayRule(broken.db, NOW), NOW))).toBeNull();
    expect(publicTwPayRule(await other.read(() => readTwPayRule(broken.db, NOW), NOW))).toBeNull();
    expect(broken.calls).toHaveLength(1);
  });
});
