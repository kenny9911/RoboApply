// @vitest-environment node
//
// WP-93 (wave 3 i18n, WP-38): the tracker CSV takes its header and its stage
// and outcome words from the server i18n loader (namespace `tracker` of the
// email bundles, server/src/i18n/email), not from csv.ts.
//   - `tracker.csv` in the request locale for RoboApply: WP-92 translated it,
//     so zh-TW reads Traditional labels and zh its own Simplified words (a
//     key a locale lacks still falls back to English);
//   - GoApply in Simplified Chinese keeps its own ladder words (`tracker.csvCn`).
//     WP-91 routed them to zh.json at the merge; en.json keeps an English
//     source for the same keys (every translated key has one).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { BRANDS } from '../../platform/brand/registry.js';
import { emailI18nDir, isValidMessage, loadEnglishWithStaging, resetEmailI18nCache, setEmailI18nDirForTests } from '../../platform/email/i18n.js';
import { CN_TRACKER_LADDER } from '../cn/tracker/index.js';
import { ALL_TRACKER_STATUSES, OUTCOME_STATUS, type TrackerEntryView } from './contract.js';
import { CSV_COLUMNS, CSV_GROUP, csvGroupFor, csvWords, isSimplifiedChinese, trackerCsv } from './csv.js';
import { INTL_TRACKER_LADDER } from './stages.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EMAIL_DIR = emailI18nDir();
type Group = Record<'header' | 'stage' | 'outcome', Record<string, string>>;
/** English as the loader reads it: en.json with anything staged since on top. */
const english = () => loadEnglishWithStaging(EMAIL_DIR) as unknown as { tracker: Record<'csv' | 'csvCn', Group> };
/** The zh bundle, which holds GoApply's own words. */
const chinese = () => JSON.parse(fs.readFileSync(path.join(EMAIL_DIR, 'zh.json'), 'utf8')) as { tracker: { csvCn: Group } };
/** One shipped locale bundle (`tracker.csv` is translated in each; WP-92). */
const localeBundle = (locale: string) => JSON.parse(fs.readFileSync(path.join(EMAIL_DIR, `${locale}.json`), 'utf8')) as { tracker: { csv: Group } };
/** The words each group is exported with: `tracker.csv` in English, `tracker.csvCn` in Simplified Chinese. */
const bundle = () => ({ tracker: { csv: english().tracker.csv, csvCn: chinese().tracker.csvCn } });

const entry = (over: Partial<TrackerEntryView> = {}): TrackerEntryView => ({
  id: 'e1',
  userId: 'u1',
  jobId: null,
  status: 'applied',
  excitementStars: 0,
  maxSalary: null,
  maxSalaryCurrency: null,
  notesMarkdown: null,
  dateSaved: '2026-10-01T00:00:00.000Z',
  dateApplied: '2026-10-02T09:00:00.000Z',
  deadline: null,
  followUpAt: null,
  appliedVia: 'manual',
  linkedRunId: null,
  job: null,
  externalSnapshot: { title: 'Analyst', companyName: 'Acme', applyUrl: null },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  source: 'manual',
  stageDetail: null,
  outcome: null,
  interviewAt: null,
  offer: null,
  tailoredVariantId: null,
  coverLetterId: null,
  ...over,
});

const header = (csv: string) => csv.replace(/^﻿/, '').split('\r\n')[0]!;
const cells = (csv: string, row = 1) => csv.replace(/^﻿/, '').split('\r\n')[row]!.split(',');

afterEach(() => {
  setEmailI18nDirForTests(null);
  resetEmailI18nCache();
});

describe('the `tracker` bundle', () => {
  it('names every column, every tracker status and every outcome in both groups', () => {
    const b = bundle();
    for (const group of ['csv', 'csvCn'] as const) {
      expect(Object.keys(b.tracker[group].header)).toEqual([...CSV_COLUMNS]);
      expect(Object.keys(b.tracker[group].stage).sort()).toEqual([...ALL_TRACKER_STATUSES].sort());
      expect(Object.keys(b.tracker[group].outcome).sort()).toEqual(Object.keys(OUTCOME_STATUS).sort());
      for (const v of [...Object.values(b.tracker[group].header), ...Object.values(b.tracker[group].stage), ...Object.values(b.tracker[group].outcome)]) {
        expect(v.trim()).not.toBe('');
        expect(isValidMessage(v)).toBe(true);
      }
    }
    // GoApply's words are Simplified Chinese and live in zh.json; English has a source for every one of those keys and no Chinese.
    const source = english().tracker;
    for (const kind of ['header', 'stage', 'outcome'] as const) expect(Object.keys(source.csvCn[kind]).sort()).toEqual(Object.keys(b.tracker.csvCn[kind]).sort());
    expect(Object.values(b.tracker.csvCn.header).every((v) => /[一-鿿]/.test(v))).toBe(true);
    expect(JSON.stringify(source)).not.toMatch(/[一-鿿]/);
    // No brand name is written into the bundles.
    expect(JSON.stringify([source, chinese().tracker])).not.toMatch(/RoboApply|GoApply/);
  });

  it('csv.ts holds no header or stage word of its own', () => {
    const src = fs.readFileSync(path.join(HERE, 'csv.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n');
    const b = bundle();
    const words = new Set(
      (['csv', 'csvCn'] as const).flatMap((g) => [...Object.values(b.tracker[g].header), ...Object.values(b.tracker[g].stage), ...Object.values(b.tracker[g].outcome)]),
    );
    for (const w of words) expect(code.includes(`'${w}'`) || code.includes(`"${w}"`), `"${w}" is hard-coded in csv.ts`).toBe(false);
    expect(code).not.toMatch(/[一-鿿]/);
    expect(code).toContain("createEmailTranslator");
  });
});

describe('which words an export uses', () => {
  it('GoApply ladder words only on the GoApply market in Simplified Chinese', () => {
    expect(csvGroupFor('zh', 'cn')).toBe(CSV_GROUP.goapply);
    expect(csvGroupFor('zh-CN', 'cn')).toBe(CSV_GROUP.goapply);
    expect(csvGroupFor('zh-Hans', 'cn')).toBe(CSV_GROUP.goapply);
    expect(csvGroupFor('zh-TW', 'cn')).toBe(CSV_GROUP.shared);
    expect(csvGroupFor('en', 'cn')).toBe(CSV_GROUP.shared);
    expect(csvGroupFor(null, 'cn')).toBe(CSV_GROUP.shared);
    // RoboApply (Taiwan included) never gets the mainland ladder words.
    for (const l of ['en', 'zh', 'zh-CN', 'zh-TW', 'ja', 'ko']) expect(csvGroupFor(l, 'intl')).toBe(CSV_GROUP.shared);
    expect(isSimplifiedChinese('zh-HK')).toBe(false);
  });

  it('en: the English header and stage words', () => {
    const csv = trackerCsv([entry(), entry({ status: 'bookmarked' }), entry({ status: 'withdrawn', outcome: 'i_withdrew' })], 'en', BRANDS.roboapply);
    expect(header(csv)).toBe('Company,Job title,Stage,How it ended,Saved on,Applied on,Interview,Follow up on,Deadline,Salary,Currency,Added from,Link,Notes');
    expect(cells(csv, 1)[2]).toBe('Applied');
    expect(cells(csv, 2)[2]).toBe('Saved');
    expect(cells(csv, 3).slice(2, 4)).toEqual(['Withdrawn', 'I withdrew']);
  });

  it('zh on GoApply: the GoApply ladder (收藏 → 网申 → 测评 → 笔试 → AI面试 → 面试 → Offer → 三方 / 未通过)', () => {
    const rows = CN_TRACKER_LADDER.map((status) => entry({ status }));
    const csv = trackerCsv([...rows, entry({ status: 'rejected', outcome: 'they_said_no' })], 'zh', BRANDS.goapply);
    expect(header(csv)).toBe('公司,职位,阶段,结果,收藏日期,投递日期,面试时间,跟进日期,截止日期,薪资,币种,来源,链接,备注');
    expect(rows.map((_r, i) => cells(csv, i + 1)[2])).toEqual(['收藏', '网申', '测评', '笔试', 'AI面试', '面试', 'Offer', '三方', '未通过']);
    expect(cells(csv, rows.length + 1).slice(2, 4)).toEqual(['未通过', '未通过']);
    // The same file through the market shorthand, and through a zh-CN tag.
    expect(trackerCsv(rows, 'zh-CN', 'cn')).toBe(trackerCsv(rows, 'zh', BRANDS.goapply));
    // GoApply in English reads the shared English words.
    expect(header(trackerCsv(rows, 'en', BRANDS.goapply))).toMatch(/^Company,Job title,Stage/);
  });

  it('zh-TW on RoboApply reads the Traditional labels of zh-TW.json, never the mainland ladder words', () => {
    const rows = INTL_TRACKER_LADDER.map((status) => entry({ status }));
    const csv = trackerCsv([...rows, entry({ status: 'rejected', outcome: 'they_said_no' })], 'zh-TW', BRANDS.roboapply);
    const tw = localeBundle('zh-TW').tracker.csv;
    // Every column and every stage of the ladder comes from the zh-TW bundle: nothing is left in English.
    expect(header(csv)).toBe(CSV_COLUMNS.map((c) => tw.header[c]).join(','));
    expect(header(csv)).toMatch(/^公司,職稱,階段,/);
    expect(header(csv)).not.toMatch(/[A-Za-z]/);
    expect(rows.map((_r, i) => cells(csv, i + 1)[2])).toEqual(INTL_TRACKER_LADDER.map((status) => tw.stage[status]));
    expect(cells(csv, rows.length + 1).slice(2, 4)).toEqual([tw.stage.rejected, tw.outcome.they_said_no]);
    for (const word of [...Object.values(tw.header), ...Object.values(tw.stage), ...Object.values(tw.outcome)]) expect(word).not.toMatch(/^[A-Za-z ]+$/);
    // Never the mainland ladder words, and no Simplified-only characters.
    expect(csv).not.toMatch(/网申|三方|未通过|职|阶|测|笔试|终面/);
    // RoboApply in Simplified Chinese reads its own `tracker.csv` words from zh.json, never GoApply's ladder (`tracker.csvCn`).
    const zhCsv = trackerCsv(rows, 'zh', BRANDS.roboapply);
    const zh = localeBundle('zh').tracker.csv;
    expect(header(zhCsv)).toBe(CSV_COLUMNS.map((c) => zh.header[c]).join(','));
    expect(rows.map((_r, i) => cells(zhCsv, i + 1)[2])).toEqual(INTL_TRACKER_LADDER.map((status) => zh.stage[status]));
    expect(zhCsv).not.toBe(trackerCsv(rows, 'en', BRANDS.roboapply));
    expect(zhCsv).not.toMatch(/网申|三方|未通过/);
  });

  it('once zh-TW.json translates `tracker.csv`, the export uses it with no code change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-csv-'));
    // The shipped English and GoApply's zh words, plus a zh-TW bundle written here.
    fs.writeFileSync(path.join(dir, 'en.json'), JSON.stringify({ tracker: english().tracker }));
    fs.writeFileSync(path.join(dir, 'zh.json'), JSON.stringify({ tracker: chinese().tracker }));
    fs.writeFileSync(
      path.join(dir, 'zh-TW.json'),
      JSON.stringify({ tracker: { csv: { header: { company: '公司', title: '職稱' }, stage: { applied: '已投遞', bookmarked: '已收藏' }, outcome: { they_said_no: '未錄取' } } } }),
    );
    setEmailI18nDirForTests(dir);
    try {
      const csv = trackerCsv([entry(), entry({ status: 'interviewing' }), entry({ status: 'rejected', outcome: 'they_said_no' })], 'zh-TW', BRANDS.roboapply);
      // Translated keys in Traditional Chinese; the rest still English.
      expect(header(csv).split(',').slice(0, 3)).toEqual(['公司', '職稱', 'Stage']);
      expect(cells(csv, 1)[2]).toBe('已投遞');
      expect(cells(csv, 2)[2]).toBe('Interviewing');
      expect(cells(csv, 3)[3]).toBe('未錄取');
      // GoApply's words are untouched by that translation.
      expect(cells(trackerCsv([entry()], 'zh', BRANDS.goapply), 1)[2]).toBe('网申');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a status the bundles do not name is written as its code, never a guess', () => {
    const words = csvWords('en', BRANDS.roboapply);
    expect(words.stage('mystery_stage')).toBe('mystery_stage');
    expect(words.stage('__proto__')).toBe('__proto__');
    expect(words.outcome('they_said_no')).toBe('They said no');
  });
});
