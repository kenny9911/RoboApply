// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRANDS } from '../brand/registry.js';
import {
  EMAIL_LOCALES,
  EmailI18nError,
  createEmailTranslator,
  emailI18nDir,
  formatMessage,
  isValidMessage,
  loadEmailMessages,
  loadEnglishWithStaging,
  normalizeEmailLocale,
  setEmailI18nDirForTests,
  type Messages,
} from './i18n.js';

function tmpBundles(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-i18n-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(content));
  }
  return dir;
}

afterEach(() => setEmailI18nDirForTests(null));

describe('loader', () => {
  it('merges staging/*.en.json over en.json, and the locale over that', () => {
    const dir = tmpBundles({
      'en.json': { shell: { unsubscribe: 'Unsubscribe' }, auth: { reset: { subject: 'Old subject' } } },
      'zh.json': { shell: { unsubscribe: '退订' } },
      'staging/auth.en.json': { auth: { reset: { subject: 'Reset your %BRAND% password', cta: 'Choose a new password' } } },
      'staging/notify.en.json': { notify: { alert: { subject: '{count, plural, one {# new job} other {# new jobs}}' } } },
      'staging/ignored.zh.json': { notify: { alert: { subject: 'ignored' } } },
    });
    setEmailI18nDirForTests(dir);
    const en = loadEnglishWithStaging(dir);
    expect((en.auth as Messages).reset).toEqual({ subject: 'Reset your %BRAND% password', cta: 'Choose a new password' });

    const zh = createEmailTranslator(BRANDS.goapply, 'zh');
    expect(zh('shell.unsubscribe')).toBe('退订');
    // Untranslated staging keys render in English under zh until INT translates them.
    expect(zh('auth.reset.subject')).toBe('Reset your GoApply password');
    expect(zh('notify.alert.subject', { count: 3 })).toBe('3 new jobs');
    const en2 = createEmailTranslator(BRANDS.roboapply, 'en');
    expect(en2('auth.reset.subject')).toBe('Reset your RoboApply password');
    expect(en2('notify.alert.subject', { count: 1 })).toBe('1 new job');
  });

  it('throws on a missing key instead of shipping it', () => {
    setEmailI18nDirForTests(tmpBundles({ 'en.json': { a: { b: 'x' } } }));
    const t = createEmailTranslator(BRANDS.roboapply, 'en');
    expect(t.has('a.b')).toBe(true);
    expect(t.has('a.c')).toBe(false);
    expect(() => t('a.c')).toThrow(EmailI18nError);
    expect(() => t('a')).toThrow(EmailI18nError);
  });

  it('clamps the locale to the brand', () => {
    expect(normalizeEmailLocale('ja', BRANDS.goapply)).toBe('zh');
    expect(normalizeEmailLocale('en', BRANDS.goapply)).toBe('en');
    expect(normalizeEmailLocale('zh-TW', BRANDS.roboapply)).toBe('zh-TW');
    expect(normalizeEmailLocale('xx', BRANDS.roboapply)).toBe('en');
    expect(normalizeEmailLocale(null)).toBe('en');
  });
});

describe('message format subset', () => {
  it('formats arguments, plurals (=n, one, other, #), selects and quotes', () => {
    expect(formatMessage('Hi {name}', { name: 'Ana' }, 'en')).toBe('Hi Ana');
    expect(formatMessage('{n, plural, =0 {none} one {# job} other {# jobs}}', { n: 0 }, 'en')).toBe('none');
    expect(formatMessage('{n, plural, one {# job} other {# jobs}}', { n: 1200 }, 'en')).toBe('1,200 jobs');
    expect(formatMessage('{tier, select, great {Great fit} other {Fit}}', { tier: 'great' }, 'en')).toBe('Great fit');
    expect(formatMessage("It''s '{literal}'", {}, 'en')).toBe("It's {literal}");
    expect(formatMessage("you're #1", {}, 'en')).toBe("you're #1");
    expect(formatMessage('On {d}', { d: new Date('2026-10-10T00:00:00Z') }, 'en')).toBe('On October 10, 2026');
    expect(formatMessage('{x}', { x: undefined }, 'en')).toBe('');
  });

  it('rejects malformed patterns', () => {
    expect(isValidMessage('{a, plural, one {x}}')).toBe(false);
    expect(isValidMessage('{a, number}')).toBe(false);
    expect(isValidMessage('{unclosed')).toBe(false);
    expect(isValidMessage('stray }')).toBe(false);
    expect(isValidMessage('{a, plural, one {# x} other {# y}}')).toBe(true);
  });
});

describe('the shipped bundles (server/src/i18n/email)', () => {
  function flatten(m: Messages, prefix = ''): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') out[key] = v;
      else Object.assign(out, flatten(v, key));
    }
    return out;
  }
  const dir = emailI18nDir();
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Messages;

  it('has all 9 locale files and the staging files for auth, billing, notify, growth, coaching', () => {
    for (const l of EMAIL_LOCALES) expect(fs.existsSync(path.join(dir, `${l}.json`))).toBe(true);
    for (const area of ['auth', 'billing', 'notify', 'growth', 'coaching']) {
      expect(read(`staging/${area}.en.json`)).toHaveProperty(area);
      expect(Object.keys(read(`staging/${area}.en.json`))).toEqual([area]);
    }
  });

  it('every translated key exists in English, every message parses, and no bundle names a brand literally', () => {
    const en = flatten(loadEnglishWithStaging(dir));
    expect(Object.keys(en).length).toBeGreaterThan(10);
    for (const l of EMAIL_LOCALES) {
      const file = path.join(dir, `${l}.json`);
      const raw = fs.readFileSync(file, 'utf8');
      expect(raw, `${l}.json`).not.toMatch(/RoboApply|GoApply/);
      const flat = flatten(read(`${l}.json`));
      for (const [k, v] of Object.entries(flat)) {
        expect(en, `${l}:${k} has no English source`).toHaveProperty([k]);
        expect(isValidMessage(v), `${l}:${k}`).toBe(true);
      }
    }
    for (const [k, v] of Object.entries(en)) expect(isValidMessage(v), `en:${k}`).toBe(true);
  });

  it('renders the shipped strings per brand and locale', () => {
    // `billing.renewal.*` and `billing.fridayNudge.*` were retired at the WP-91
    // merge (no template reads them); these are keys the templates read today.
    const tEn = createEmailTranslator(BRANDS.roboapply, 'en');
    expect(tEn('billing.renewalReminder.subjectAuto', { date: 'October 14, 2026' })).toBe('Your RoboApply plan renews on October 14, 2026');
    expect(tEn('tracker.inbox.noReply', { name: 'Acme', days: 1 })).toBe('No reply from Acme for 1 day.');
    expect(tEn('tracker.inbox.noReply', { name: 'Acme', days: 12 })).toBe('No reply from Acme for 12 days.');
    // GoApply in Simplified Chinese: its own words come from zh.json, and the brand is substituted in any language.
    const tZh = createEmailTranslator(BRANDS.goapply, 'zh');
    expect(tZh('tracker.inboxCn.followUpDue', { name: 'Acme' })).toBe('今天是你为 Acme 设定的跟进日期。');
    const zhSubject = tZh('billing.renewalReminder.subjectManual', { date: '2026-10-14' });
    expect(zhSubject).toContain('GoApply');
    expect(zhSubject).not.toMatch(/%BRAND%|RoboApply/);
    // A locale without a string falls back to English (ko has none until it is translated).
    const ko = flatten(read('ko.json'));
    expect(createEmailTranslator(BRANDS.roboapply, 'ko')('billing.renewalReminder.ctaAuto')).toBe(ko['billing.renewalReminder.ctaAuto'] ?? 'Manage or cancel');
    expect(loadEmailMessages('ja')).toHaveProperty('shell.unsubscribe');
    // The retired keys are gone from every bundle.
    for (const l of EMAIL_LOCALES) {
      const keys = Object.keys(flatten(read(`${l}.json`)));
      expect(keys.filter((k) => k.startsWith('billing.renewal.') || k.startsWith('billing.fridayNudge.')), l).toEqual([]);
    }
  });
});
