// @vitest-environment node
//
// WP-12 / TW-08: scripts/check-zh-variants.mjs — mainland vocabulary fails in
// zh-TW bundles, Taiwan vocabulary fails in zh bundles (CN_TW_LAUNCH_PLAN.md
// §4.2 WP-TW-LOCALE, §9). Acceptance: a planted 简历 in zh-TW and a planted 履歷
// in zh both fail.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations
import * as zh from '../../scripts/check-zh-variants.mjs';

const ROOT = process.cwd();
const roots: string[] = [];

function tree(files: Record<string, unknown>, glossary?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'zh-variants-'));
  roots.push(root);
  mkdirSync(join(root, 'i18n/glossary'), { recursive: true });
  if (glossary === undefined) copyFileSync(join(ROOT, 'i18n/glossary/zh-variants.json'), join(root, 'i18n/glossary/zh-variants.json'));
  else writeFileSync(join(root, 'i18n/glossary/zh-variants.json'), JSON.stringify(glossary));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const CLEAN = {
  'i18n/messages/zh.json': { resume: { title: '我的简历' }, jobs: { pay: '面议' } },
  'i18n/messages/zh-TW.json': { resume: { title: '我的履歷' }, jobs: { pay: '面議' } },
  'i18n/messages/en.json': { resume: { title: '简历 履歷 is fine in English bundles' } },
};

describe('check-zh-variants', () => {
  it('passes clean bundles', () => {
    const r = zh.evaluate(tree(CLEAN));
    expect(r.violations).toEqual([]);
    expect(r.files).toEqual(['i18n/messages/zh-TW.json', 'i18n/messages/zh.json']);
  });

  it('fails on a planted 简历 in zh-TW, naming the file, key and term', () => {
    const root = tree({ ...CLEAN, 'i18n/messages/zh-TW.json': { resume: { title: '上傳你的简历' } } });
    expect(zh.evaluate(root).violations).toEqual([
      { file: 'i18n/messages/zh-TW.json', key: 'resume.title', term: '简历', variant: 'zh-TW' },
    ]);
  });

  it('fails on a planted 履歷 in zh', () => {
    const root = tree({ ...CLEAN, 'i18n/messages/zh.json': { resume: { title: '我的履歷' } } });
    expect(zh.evaluate(root).violations).toEqual([
      { file: 'i18n/messages/zh.json', key: 'resume.title', term: '履歷', variant: 'zh' },
    ]);
  });

  it('checks every mainland term in zh-TW, including Traditional-script forms (簡歷, 視頻, 用戶 …)', () => {
    const terms: string[] = JSON.parse(readFileSync(join(ROOT, 'i18n/glossary/zh-variants.json'), 'utf8')).banned['zh-TW'].terms;
    for (const must of ['简历', '簡歷', '岗位', '网申', '校招', '视频', '視頻', '软件', '信息', '默认', '用户', '用戶', '登录', '质量', '网络', '账号', '数据', '數據']) {
      expect(terms).toContain(must);
    }
    const root = tree({ ...CLEAN, 'i18n/messages/zh-TW.json': { a: terms.join(' / ') } });
    const hits = zh.evaluate(root).violations.map((v: { term: string }) => v.term);
    expect(hits.sort()).toEqual([...terms].sort());
  });

  it('checks staging, brand override, email and extension bundles, and arrays', () => {
    const root = tree({
      ...CLEAN,
      'i18n/staging/jobsTw.zh-TW.json': { jobsTw: { a: '岗位' } },
      'i18n/staging/campus.zh.json': { campus: { list: ['ok', '職缺'] } },
      'i18n/brands/goapply/zh.json': { landing: { a: '面議' } },
      'server/src/i18n/email/zh-TW.json': { auth: { subject: '登录' } },
      'extension/_locales/zh_TW/messages.json': { fill: { message: '一键填表 视频' } },
      'i18n/staging/landing.en.json': { landing: { a: '简历' } },
    });
    const v = zh.evaluate(root).violations.map((x: { file: string; key: string; term: string }) => `${x.file}#${x.key}:${x.term}`);
    expect(v.sort()).toEqual(
      [
        'extension/_locales/zh_TW/messages.json#fill.message:视频',
        'i18n/brands/goapply/zh.json#landing.a:面議',
        'i18n/staging/campus.zh.json#campus.list.1:職缺',
        'i18n/staging/jobsTw.zh-TW.json#jobsTw.a:岗位',
        'server/src/i18n/email/zh-TW.json#auth.subject:登录',
      ].sort(),
    );
  });

  it('ignores keys (only values are copy)', () => {
    const root = tree({ ...CLEAN, 'i18n/messages/zh-TW.json': { 简历: '履歷' } });
    expect(zh.evaluate(root).violations).toEqual([]);
  });

  it('honours an allow row (exact key or prefix) for one term only', () => {
    const glossary = JSON.parse(readFileSync(join(ROOT, 'i18n/glossary/zh-variants.json'), 'utf8'));
    glossary.allow = [
      { key: 'legal.quote', term: '用户', reason: 'quoting a mainland document title' },
      { file: 'i18n/messages/zh-TW.json', key: 'glossary.', term: '简历', reason: 'glossary page' },
    ];
    const root = tree(
      {
        ...CLEAN,
        'i18n/messages/zh-TW.json': { legal: { quote: '《用户协议》', other: '用户' }, glossary: { a: '简历', b: '视频' } },
      },
      glossary,
    );
    const v = zh.evaluate(root).violations.map((x: { key: string; term: string }) => `${x.key}:${x.term}`);
    expect(v.sort()).toEqual(['glossary.b:视频', 'legal.other:用户']);
  });

  it('reports invalid JSON instead of crashing', () => {
    const root = tree({ ...CLEAN, 'i18n/staging/x.zh.json': '{ not json' });
    const r = zh.evaluate(root);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('i18n/staging/x.zh.json');
  });

  it('classifies bundle paths by variant', () => {
    const cases: Array<[string, string | null]> = [
      ['i18n/messages/zh.json', 'zh'],
      ['i18n/messages/zh-TW.json', 'zh-TW'],
      ['i18n/staging/legal.zh.json', 'zh'],
      ['i18n/staging/jobsTw.zh-TW.json', 'zh-TW'],
      ['extension/_locales/zh_CN/messages.json', 'zh'],
      ['extension/_locales/zh_TW/messages.json', 'zh-TW'],
      ['components/job-search/messages.zh-TW.json', 'zh-TW'],
      ['i18n/messages/en.json', null],
      ['i18n/staging/zhVariants.en.json', null],
      ['i18n/messages/zh.ts', null],
    ];
    for (const [p, want] of cases) expect(zh.variantOf(p), p).toBe(want);
  });

  it('fails the CLI with exit 1 and a readable line; exits 0 when clean', () => {
    const bad = tree({ ...CLEAN, 'i18n/messages/zh-TW.json': { resume: { title: '简历' } } });
    const r = spawnSync(process.execPath, ['scripts/check-zh-variants.mjs', '--root', bad], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('i18n/messages/zh-TW.json  resume.title: "简历" is mainland vocabulary in a zh-TW bundle');
    const ok = spawnSync(process.execPath, ['scripts/check-zh-variants.mjs', '--root', tree(CLEAN)], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
  });

  it('fails closed when the glossary is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'zh-variants-'));
    roots.push(root);
    const r = spawnSync(process.execPath, ['scripts/check-zh-variants.mjs', '--root', root], { encoding: 'utf8' });
    expect(r.status).toBe(1);
  });

  it('this checkout is clean', () => {
    const r = zh.evaluate(ROOT);
    expect(r.errors).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.files).toContain('i18n/messages/zh-TW.json');
    expect(r.files).toContain('server/src/i18n/email/zh.json');
  });
});
