// @vitest-environment node
//
// FIX-8: GoApply brand copy overrides (ARCHITECTURE.md §1.7; TASK_PLAN.md R-22).
// `i18n/brands/goapply/{zh,en}.json` did not exist and nothing loaded them, so
// the mainland brand showed LinkedIn import, "cancelling takes one click",
// email-alert and visa wording that does not apply there. lib/i18n.ts now
// merges the override bundle over the locale bundle per brand × locale.
//
// Key parity between the two override files is en ⊆ zh, not equality: the
// staging merge (scripts/i18n-merge-staging.mjs, R-22) writes a staged Chinese
// rewording of an existing key into goapply/zh.json only, by design, and that
// must not turn this file red at integration.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseIcu, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { describe, expect, it } from 'vitest';

import { STAGING_EN } from '../i18n/staging/index';
import { brandOverrides, loadMessages } from './i18n';
import { LOCALES } from './localeConfig';

type Tree = Record<string, unknown>;
const at = (obj: unknown, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Tree | undefined)?.[k], obj);
const read = (rel: string) => JSON.parse(readFileSync(join(process.cwd(), rel), 'utf8')) as Tree;
function leaves(obj: unknown, prefix = ''): string[] {
  if (!obj || typeof obj !== 'object') return prefix ? [prefix] : [];
  return Object.entries(obj as Tree).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

/** Argument names an ICU message reads (select and plural branches included). */
function icuArgs(message: string): Set<string> {
  const out = new Set<string>();
  const walk = (els: MessageFormatElement[]) => {
    for (const el of els) {
      if (el.type === TYPE.literal || el.type === TYPE.pound) continue;
      if ('value' in el && typeof el.value === 'string') out.add(el.value);
      if (el.type === TYPE.select || el.type === TYPE.plural) for (const opt of Object.values(el.options)) walk(opt.value);
      if (el.type === TYPE.tag) walk(el.children);
    }
  };
  walk(parseIcu(message));
  return out;
}

const ZH = read('i18n/brands/goapply/zh.json');
const EN = read('i18n/brands/goapply/en.json');
const BASE_EN = read('i18n/messages/en.json');

describe('GoApply brand copy overrides: loaded per brand × locale', () => {
  it('GoApply zh: LinkedIn import reads as resume import; RoboApply zh is untouched', () => {
    const go = loadMessages('zh', 'goapply');
    const robo = loadMessages('zh', 'roboapply');
    expect(at(go, 'onboarding.resume.linkedin.title')).toBe('导入已有的简历');
    expect(at(go, 'onboarding.resume.linkedin.choose')).toBe('上传简历 PDF');
    expect(at(go, 'resume.subtitle')).not.toMatch(/LinkedIn/);
    expect(at(robo, 'onboarding.resume.linkedin.title')).toBe(at(read('i18n/messages/zh.json'), 'onboarding.resume.linkedin.title'));
    expect(at(robo, 'resume.subtitle')).toMatch(/LinkedIn/);
  });

  it('GoApply: passes never renew, so no "cancelling takes one click", no "cancel a subscription", no visa or work-permit wording', () => {
    const go = loadMessages('zh', 'goapply');
    expect(at(go, 'credits.planSheet.sub')).toBe('Pro 会提高你的每日次数上限。会员卡只付一次，到期后不会自动续费。');
    for (const key of ['credits.planSheet.sub', 'credits.cancel.help', 'credits.cancel.helpNoDate']) expect(at(go, key), key).not.toMatch(/取消只需点一下/);
    for (const key of ['credits.cancelPage.footerLink', 'landing.pricingPage.cancelLink', 'landing.help.cancelLink']) expect(at(go, key), key).toBe('续费与取消说明');
    expect(at(go, 'landing.pricingPage.instantAlerts')).toBe('即时职位提醒');
    for (const key of ['fit.compared.keys.logistics', 'jobs.score.rubric.location_pay_visa', 'landing.ranking.fitParts.logistics', 'landing.home.faq.q3.a', 'extensionWeb.page.facts']) {
      expect(at(go, key), key).not.toMatch(/签证|工作许可/);
    }
    // No promise of a spoken interview (GoApply practice is text), no email or WeChat step in the invite flow.
    expect(at(go, 'auth.brand.feature_interview')).not.toMatch(/对话/);
    expect(at(go, 'invite.how.step2')).toBe('好友通过链接注册新的 GoApply 账号，完成账号验证，并完成设置。');
    expect(at(go, 'invite.how.step3')).not.toMatch(/邮件|邮箱/);
    // Changing the phone number now says where support is.
    expect(at(go, 'authCn.change.noOtherWay')).toMatch(/“帮助”页面/);
  });

  it('GoApply en gets the same overrides in English; every other key is the locale bundle unchanged', () => {
    const go = loadMessages('en', 'goapply');
    const robo = loadMessages('en', 'roboapply');
    expect(at(go, 'onboarding.resume.linkedin.title')).toBe('Bring in a resume you already have');
    expect(at(go, 'credits.planSheet.sub')).toBe('Pro raises your daily limits. A pass is paid once and never renews.');
    expect(at(go, 'invite.how.step2')).toBe('Your friend creates a new GoApply account with the link, confirms it and finishes setting up.');
    expect(at(robo, 'credits.planSheet.sub')).toBe('Pro raises your daily limits. Cancelling takes one click.');
    // Apart from the product names (the %BRAND% / %OTHER_BRAND% tokens), nothing else differs.
    const names = (s: string) => s.replace(/GoApply|RoboApply/g, '%NAME%');
    const overridden = new Set(leaves(EN));
    for (const key of leaves(robo).filter((k) => !overridden.has(k))) {
      const a = at(go, key);
      const b = at(robo, key);
      if (typeof a === 'string' && typeof b === 'string') expect(names(a), key).toBe(names(b));
    }
  });

  it('RoboApply has no override bundle in any locale; GoApply has one for each of its locales only', () => {
    for (const locale of LOCALES) expect(brandOverrides('roboapply', locale), locale).toBeNull();
    expect(brandOverrides('goapply', 'zh')).toBeTruthy();
    expect(brandOverrides('goapply', 'en')).toBeTruthy();
    expect(brandOverrides('goapply', 'ja')).toBeNull();
    // A locale GoApply does not serve keeps its own bundle.
    expect(at(loadMessages('ja', 'goapply'), 'credits.planSheet.sub')).toBe(at(read('i18n/messages/ja.json'), 'credits.planSheet.sub'));
  });
});

describe('GoApply brand copy overrides: the bundles', () => {
  const english = { ...BASE_EN } as Tree;

  // Key rule: en ⊆ zh — every key the English override rewords is reworded in Chinese too (Chinese
  // is GoApply's primary language; an English-only override would leave it on the general wording).
  // The reverse is NOT required: scripts/i18n-merge-staging.mjs (R-22) routes a staged Chinese
  // rewording of a key that already exists in zh.json into i18n/brands/goapply/zh.json ONLY, so
  // zh may hold keys en does not (GoApply English then keeps the general English wording).
  it('every key the English override rewords is reworded in Chinese too; zh may hold more (R-22 zh routing)', () => {
    const zhKeys = new Set(leaves(ZH));
    for (const key of leaves(EN)) expect(zhKeys.has(key), key).toBe(true);
    expect(leaves(EN).length).toBeGreaterThan(20);
  });

  it('every override is the wording of a key that exists in English (bundle or staging): overrides add no key', () => {
    for (const key of new Set([...leaves(ZH), ...leaves(EN)])) {
      const base = at(english, key) ?? at(STAGING_EN, key);
      expect(typeof base, key).toBe('string');
    }
  });

  it('every override is a non-empty ICU string that reads no argument the base message does not pass', () => {
    for (const [name, bundle] of [['zh', ZH], ['en', EN]] as const) {
      for (const key of leaves(bundle)) {
        const value = at(bundle, key);
        expect(typeof value, `${name}:${key}`).toBe('string');
        expect((value as string).trim().length, `${name}:${key}`).toBeGreaterThan(0);
        const base = icuArgs((at(english, key) ?? at(STAGING_EN, key)) as string);
        for (const arg of icuArgs(value as string)) expect(base.has(arg), `${name}:${key} reads {${arg}}`).toBe(true);
      }
    }
  });

  it('no literal product name (the %BRAND% token only), and none of the wording the overrides exist to remove', () => {
    for (const [name, bundle] of [['zh', ZH], ['en', EN]] as const) {
      for (const key of leaves(bundle)) {
        const value = at(bundle, key) as string;
        expect(value, `${name}:${key}`).not.toMatch(/RoboApply|GoApply/i);
        expect(value, `${name}:${key}`).not.toMatch(/LinkedIn|领英|签证|工作许可|visa|sponsorship|work permit|work authori/i);
        expect(value, `${name}:${key}`).not.toMatch(/取消只需点一下|Cancelling takes one click|Cancel a subscription/);
      }
    }
  });
});
