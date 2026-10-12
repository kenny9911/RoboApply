// @vitest-environment node
//
// scripts/check-copy.mjs (FND-7 acceptance; TASK_PLAN.md R-12, ARCH §10.1.4).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error — plain .mjs script, no type declarations
import * as copy from '../../scripts/check-copy.mjs';

const LOCALES = ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'];
const roots: string[] = [];

function write(root: string, rel: string, value: unknown) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

/** A clean tree: 9 identical-shape bundles; `patch(locale)` returns overrides. */
function tree(patch: (locale: string) => Record<string, unknown> = () => ({})): string {
  const root = mkdtempSync(join(tmpdir(), 'check-copy-'));
  roots.push(root);
  for (const l of LOCALES) {
    write(root, `i18n/messages/${l}.json`, { common: { app: '%BRAND%', save: `Save ${l}` }, ...patch(l) });
  }
  return root;
}

type Violation = { rule: string; path: string; file: string; detail: string };
const rules = (root: string) => (copy.runCopyCheck(root).violations as Violation[]).map((v) => `${v.rule} ${v.file} ${v.path}`);

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('check-copy', () => {
  it('passes a clean tree', () => {
    expect(rules(tree())).toEqual([]);
  });

  it('fails on a banned word planted in a staging file', () => {
    const root = tree();
    write(root, 'i18n/staging/ready.en.json', { ready: { intro: 'Turn on autopilot and relax' } });
    expect(rules(root)).toContain('banned-word i18n/staging/ready.en.json ready.intro');
  });

  it('fails on a literal "GoApply" in a bundle (any bundle kind)', () => {
    const root = tree((l) => (l === 'zh' ? { common: { app: '%BRAND%', save: '保存', hello: '欢迎来到 GoApply' } } : {}));
    write(root, 'server/src/i18n/email/en.json', { shell: { sentBy: 'Sent by RoboApply' } });
    const out = rules(root);
    expect(out).toContain('literal-brand i18n/messages/zh.json common.hello');
    expect(out).toContain('literal-brand server/src/i18n/email/en.json shell.sentBy');
  });

  it('fails on "ATS." and "(JD)" (word boundaries), not on "stats"', () => {
    const root = tree();
    write(root, 'i18n/staging/resumeCheck.en.json', {
      resumeCheck: { a: 'Make it pass the ATS.', b: 'Paste the posting (JD) here', c: 'Your stats and chats' },
    });
    const out = rules(root);
    expect(out).toContain('banned-word i18n/staging/resumeCheck.en.json resumeCheck.a');
    expect(out).toContain('banned-word i18n/staging/resumeCheck.en.json resumeCheck.b');
    expect(out).not.toContain('banned-word i18n/staging/resumeCheck.en.json resumeCheck.c');
  });

  it('fails on 自動応募 in ja, but the ja term does not fire in en', () => {
    const root = tree((l) => (l === 'ja' ? { common: { app: '%BRAND%', save: '保存', auto: '自動応募をオン' } } : {}));
    expect(rules(root)).toContain('banned-word i18n/messages/ja.json common.auto');
    expect(copy.findBanned('自動応募', 'en')).toEqual([]);
  });

  it('passes "We can\'t guarantee…" and fails an affirmative guarantee', () => {
    expect(copy.findBanned("We can't guarantee an interview.", 'en')).toEqual([]);
    expect(copy.findBanned('There is no guarantee of an offer.', 'en')).toEqual([]);
    expect(copy.findBanned('We cannot guarantee results.', 'en')).toEqual([]);
    expect(copy.findBanned('Guaranteed interviews in a week.', 'en').map((r: { term: string }) => r.term)).toEqual(['guarantee']);
  });

  it('bans "unlimited" in every locale, natively', () => {
    expect(copy.findBanned('Unlimited tailoring', 'en').map((r: { term: string }) => r.term)).toContain('unlimited');
    expect(copy.findBanned('无限次定制', 'zh').length).toBeGreaterThan(0);
    expect(copy.findBanned('Personnalisation illimitée', 'fr').length).toBeGreaterThan(0);
    expect(copy.findBanned('Unbegrenzte Anpassung', 'de').length).toBeGreaterThan(0);
  });

  it('bans the CN auto-apply vocabulary and affiliation names per locale', () => {
    expect(copy.findBanned('一键投递到大厂', 'zh').length).toBeGreaterThan(0);
    expect(copy.findBanned('北森测评模拟', 'zh').length).toBeGreaterThan(0);
    expect(copy.findBanned('自動應徵', 'zh-TW').length).toBeGreaterThan(0);
  });

  it('keeps "Business Insider" (a source) while banning "insider"', () => {
    expect(copy.findBanned('In one Business Insider test', 'en')).toEqual([]);
    expect(copy.findBanned('Insider connections at Example', 'en').map((r: { term: string }) => r.term)).toEqual(['insider']);
  });

  it('honours the scoped SEO allow for "applicant tracking"', () => {
    expect(copy.findBanned('Applicant tracking system resume checker', 'en', 'seo.tools.resumeChecker.meta.title')).toEqual([]);
    expect(copy.findBanned('Applicant tracking system resume checker', 'en', 'seo.tools.resumeChecker.body').length).toBeGreaterThan(0);
  });

  it('checks %BRAND% count parity per key across locales', () => {
    const root = tree((l) => (l === 'ko' ? { common: { app: '%BRAND% %BRAND%', save: 'Save ko' } } : {}));
    expect(rules(root)).toContain('brand-token-parity i18n/messages/ko.json common.app');
  });

  it('resolves t() keys against en.json ∪ staging', () => {
    const root = tree();
    write(root, 'components/features/ready/Intro.tsx', "const t = useTranslations('ready');\nexport const a = t('intro');\nexport const b = t('missing');\n");
    write(root, 'i18n/staging/ready.en.json', { ready: { intro: 'Ready to apply' } });
    const out = rules(root);
    expect(out).toContain('missing-string components/features/ready/Intro.tsx ready.missing');
    expect(out).not.toContain('missing-string components/features/ready/Intro.tsx ready.intro');
  });

  it('keeps locale parity over i18n/messages only (staging is English-only)', () => {
    const root = tree((l) => (l === 'de' ? { common: { app: '%BRAND%' } } : {}));
    expect(rules(root)).toContain('missing-key i18n/messages/de.json common.save');
  });

  it('this checkout is clean', () => {
    expect(rules(process.cwd())).toEqual([]);
  });
});
