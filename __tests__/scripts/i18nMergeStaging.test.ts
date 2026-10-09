// @vitest-environment node
//
// scripts/i18n-merge-staging.mjs (ARCHITECTURE.md §10.1.3; FND-7). Each test
// builds a throwaway checkout (9 bundles, staging, email bundles) and runs the
// script's `main()` against it with `--root`.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations
import * as merge from '../../scripts/i18n-merge-staging.mjs';

const LOCALES = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'];
const roots: string[] = [];

function write(root: string, rel: string, value: unknown) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
}
const read = (root: string, rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

function fixture(staging: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'i18n-merge-'));
  roots.push(root);
  for (const l of LOCALES) {
    write(root, `i18n/messages/${l}.json`, {
      common: { save: l === 'en' ? 'Save' : `save-${l}`, close: l === 'en' ? 'Close' : `close-${l}` },
      jobs: { title: l === 'en' ? 'Jobs' : `jobs-${l}`, old: l === 'en' ? 'Old key' : `old-${l}` },
    });
    write(root, `server/src/i18n/email/${l}.json`, { shell: { sentBy: l === 'en' ? 'Sent by %BRAND%' : `sent-${l} %BRAND%` } });
  }
  write(root, 'server/src/i18n/email/staging/auth.en.json', { auth: {} });
  write(root, 'i18n/staging/jobs.en.json', { jobs: {} });
  for (const [name, value] of Object.entries(staging)) write(root, `i18n/staging/${name}`, value);
  // index.ts as `--index` would write it (without validating, so invalid fixtures still load).
  writeFileSync(join(root, 'i18n/staging/index.ts'), merge.renderIndex(root));
  return root;
}

function run(root: string, ...args: string[]) {
  const out: string[] = [];
  const log = { log: (s: string) => out.push(s), error: (s: string) => out.push(s) };
  const code = merge.main([...args, '--root', root], log);
  return { code, out: out.join('\n') };
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('validation (nothing is written when it fails)', () => {
  it('requires exactly one top-level key equal to the namespace', () => {
    const root = fixture({ 'jobs.en.json': { jobs: { a: 'A' }, extra: { b: 'B' } } });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('exactly one top-level key "jobs"');
    expect(read(root, 'i18n/messages/en.json').jobs.a).toBeUndefined();
  });

  it('rejects ICU that does not parse', () => {
    const root = fixture({ 'jobs.en.json': { jobs: { n: '{count, plural, one {# job} other {# jobs}' } } });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ICU does not parse');
  });

  it('rejects a literal product name, empty strings and non-strings', () => {
    const root = fixture({ 'jobs.en.json': { jobs: { a: 'Welcome to GoApply', b: '', c: 3 } } });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('jobs.a: literal product name');
    expect(r.out).toContain('jobs.b: empty string');
    expect(r.out).toContain('jobs.c: must be a string');
  });

  it('allows RoboHire/GoHire only as a parameter or under the source-name namespaces', () => {
    const bad = fixture({ 'jobs.en.json': { jobs: { a: 'Posted on GoHire' } } });
    expect(run(bad).out).toContain('literal RoboHire/GoHire');
    const ok = fixture({
      'jobs.en.json': { jobs: { a: 'Posted on {sourceName}' } },
      'legal.en.json': { legal: { processors: 'GoHire (resume parsing)' } },
      'people.en.json': { people: { sourceRoboHire: 'From RoboHire' } },
    });
    expect(run(ok).code).toBe(0);
  });

  it('rejects a .zh.json key with no English source', () => {
    const root = fixture({ 'jobsCn.en.json': { jobsCn: {} }, 'jobsCn.zh.json': { jobsCn: { orphan: '孤儿' } } });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('jobsCn.orphan has no English source');
  });

  it('refuses extension staging content while extension/ does not exist', () => {
    const root = fixture({ 'extension.en.json': { extension: { fill: 'Fill this form' } } });
    const r = run(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain('extension/ does not exist');
  });
});

describe('merge', () => {
  it('adds new keys, records pending translation, and empties the staging file', () => {
    const root = fixture({ 'jobs.en.json': { jobs: { headline: 'Jobs for you', nested: { a: 'A' } } } });
    expect(run(root).code).toBe(0);
    const en = read(root, 'i18n/messages/en.json');
    expect(en.jobs).toMatchObject({ title: 'Jobs', headline: 'Jobs for you', nested: { a: 'A' } });
    expect(read(root, 'i18n/staging/jobs.en.json')).toEqual({ jobs: {} });
    const pending = read(root, 'i18n/staging/_pending-translation.json');
    expect(pending).toEqual(
      expect.arrayContaining([
        { bundle: 'web', path: 'jobs.headline', en: 'Jobs for you', reason: 'new' },
        { bundle: 'web', path: 'jobs.nested.a', en: 'A', reason: 'new' },
      ]),
    );
    // Other locales are untouched (the translator fills them).
    expect(read(root, 'i18n/messages/ja.json').jobs.headline).toBeUndefined();
  });

  it('a changed English value deletes the stale translations in the 8 other locales', () => {
    const root = fixture({ 'jobs.en.json': { jobs: { title: 'Your jobs' } } });
    expect(run(root).code).toBe(0);
    expect(read(root, 'i18n/messages/en.json').jobs.title).toBe('Your jobs');
    for (const l of LOCALES.filter((x) => x !== 'en')) {
      const b = read(root, `i18n/messages/${l}.json`);
      expect(b.jobs.title, l).toBeUndefined();
      expect(b.jobs.old, l).toBe(`old-${l}`);
    }
    expect(read(root, 'i18n/staging/_pending-translation.json')).toContainEqual({ bundle: 'web', path: 'jobs.title', en: 'Your jobs', reason: 'changed' });
  });

  it('applies <ns>.remove.json across all 9 bundles and resets it to []', () => {
    const root = fixture({ 'clean.remove.json': ['jobs.old', 'common.close'] });
    expect(run(root).code).toBe(0);
    for (const l of LOCALES) {
      const b = read(root, `i18n/messages/${l}.json`);
      expect(b.jobs.old, l).toBeUndefined();
      expect(b.common.close, l).toBeUndefined();
      expect(b.common.save, l).toBeDefined();
    }
    expect(read(root, 'i18n/staging/clean.remove.json')).toEqual([]);
  });

  it('routes zh staging: new keys into zh.json, existing keys into the GoApply override bundle (R-22)', () => {
    const root = fixture({
      'jobs.en.json': { jobs: { campus: 'Campus calendar' } },
      'jobs.zh.json': { jobs: { campus: '校招日历', title: '职位' } },
    });
    expect(run(root).code).toBe(0);
    expect(read(root, 'i18n/messages/zh.json').jobs.campus).toBe('校招日历');
    // `jobs.title` already had a zh translation → GoApply-only override.
    expect(read(root, 'i18n/messages/zh.json').jobs.title).toBe('jobs-zh');
    expect(read(root, 'i18n/brands/goapply/zh.json')).toEqual({ jobs: { title: '职位' } });
    const entry = read(root, 'i18n/staging/_pending-translation.json').find((e: { path: string }) => e.path === 'jobs.campus');
    expect(entry.provided).toEqual(['zh']);
    expect(read(root, 'i18n/staging/jobs.zh.json')).toEqual({ jobs: {} });
  });

  it('merges server email staging into server/src/i18n/email/en.json', () => {
    const root = fixture();
    write(root, 'server/src/i18n/email/staging/auth.en.json', { auth: { reset: { subject: 'Reset your %BRAND% password' } } });
    expect(run(root).code).toBe(0);
    expect(read(root, 'server/src/i18n/email/en.json').auth.reset.subject).toBe('Reset your %BRAND% password');
    expect(read(root, 'server/src/i18n/email/staging/auth.en.json')).toEqual({ auth: {} });
    expect(read(root, 'i18n/staging/_pending-translation.json')).toContainEqual({
      bundle: 'email',
      path: 'auth.reset.subject',
      en: 'Reset your %BRAND% password',
      reason: 'new',
    });
  });

  it('merges extension staging when the package exists', () => {
    const root = fixture({ 'extension.en.json': { extension: { fill: 'Fill this form' } } });
    write(root, 'extension/src/i18n/en.json', { extension: { title: 'Panel' } });
    expect(run(root).code).toBe(0);
    expect(read(root, 'extension/src/i18n/en.json').extension).toEqual({ title: 'Panel', fill: 'Fill this form' });
    // Extension namespaces never enter the web bundles or STAGING_EN.
    expect(read(root, 'i18n/messages/en.json').extension).toBeUndefined();
    expect(readFileSync(join(root, 'i18n/staging/index.ts'), 'utf8')).not.toContain("'./extension.en.json'");
  });

  it('--dry-run prints the plan and writes nothing', () => {
    const root = fixture({ 'jobs.en.json': { jobs: { headline: 'Jobs for you' } } });
    const r = run(root, '--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('new     web:jobs.headline');
    expect(read(root, 'i18n/messages/en.json').jobs.headline).toBeUndefined();
    expect(read(root, 'i18n/staging/jobs.en.json')).toEqual({ jobs: { headline: 'Jobs for you' } });
    expect(existsSync(join(root, 'i18n/staging/_pending-translation.json'))).toBe(false);
  });
});

describe('--check (INT final gate) and --index', () => {
  it('fails while any staging file has content and passes once merged', () => {
    const root = fixture({ 'jobs.en.json': { jobs: { headline: 'Jobs for you' } } });
    const before = run(root, '--check');
    expect(before.code).toBe(1);
    expect(before.out).toContain('jobs.en.json: not merged yet');
    expect(run(root).code).toBe(0);
    expect(run(root, '--check').code).toBe(0);
  });

  it('fails on a stale index.ts', () => {
    const root = fixture();
    write(root, 'i18n/staging/newArea.en.json', { newArea: {} });
    const r = run(root, '--check');
    expect(r.code).toBe(1);
    expect(r.out).toContain('index.ts is stale');
    expect(run(root, '--index').code).toBe(0);
    expect(run(root, '--check').code).toBe(0);
  });

  it('index.ts imports every web namespace and exports STAGING_EN', () => {
    const root = fixture({ 'growth.en.json': { growth: {} }, 'extension-cn.en.json': { 'extension-cn': {} } });
    run(root, '--index');
    const src = readFileSync(join(root, 'i18n/staging/index.ts'), 'utf8');
    expect(src).toContain("import growth from './growth.en.json';");
    expect(src).toContain("import jobs from './jobs.en.json';");
    expect(src).not.toContain('./extension-cn.en.json');
    expect(src).toContain('export const STAGING_EN');
  });
});

describe('this checkout', () => {
  it('every staging file is valid and index.ts is current', () => {
    const { errors } = merge.validateStaging(process.cwd());
    expect(errors).toEqual([]);
    expect(merge.indexIsFresh(process.cwd())).toBe(true);
  });

  it('every planned namespace has a staging file (Appendix A + FND-4 taxonomy)', () => {
    const names = merge
      .listStagingFiles(process.cwd())
      .filter((f: { kind: string; bundle: string }) => f.kind === 'en' && f.bundle !== 'email')
      .map((f: { ns: string }) => f.ns);
    for (const ns of [
      'accountV2', 'admin', 'applications', 'assistant', 'auth', 'authCn', 'billingCn', 'brand', 'campus', 'coaching',
      'competitiveness', 'coverLetter', 'credits', 'extension', 'extension-cn', 'extensionWeb', 'filters', 'fit', 'growth',
      'inbox', 'invite', 'jobDetail', 'jobImport', 'jobs', 'jobsCn', 'jobsTw', 'landing', 'legal', 'nav', 'notifyCn', 'offers',
      'onboarding', 'onboardingCn', 'people', 'practice', 'practiceCn', 'practiceQuestions', 'profile', 'pwa', 'ready',
      'resume', 'resumeBuilder', 'resumeCheck', 'seo', 'tailor', 'taxonomy', 'tools', 'visitor',
    ]) {
      expect(names, ns).toContain(ns);
    }
  });

  it('every existing English string parses as ICU (the validator rejects nothing that ships today)', () => {
    const en = JSON.parse(readFileSync(join(process.cwd(), 'i18n/messages/en.json'), 'utf8'));
    const bad = [...merge.leaves(en)].filter(([, v]: [string, string]) => merge.icuError(v)).map(([k]: [string]) => k);
    expect(bad).toEqual([]);
  });
});
