// @vitest-environment node
//
// Bundle-level checks behind verify finding FIX-1 #5 ("locale bundle
// leftovers"): the board column label that read "Applied, 1 jobs", and a
// guard that keeps the punctuation of the zh-TW, zh and ja bundles in one
// style. (The mixed forms QA saw — "缺少的地方: …", "來自職缺說明: “…”" — are
// NOT in the bundles: the colon and the quotes are typed in JobCard.tsx and
// WhyThisJob.tsx. This guard is what shows the bundles are not the source.)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { LOCALES } from '../../lib/localeConfig';

type Tree = { [key: string]: string | Tree };
const bundle = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), 'i18n/messages', `${locale}.json`), 'utf8')) as Tree;

function leaves(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [[prefix + k, v] as [string, string]] : leaves(v, `${prefix}${k}.`),
  );
}

describe('applications.column.aria', () => {
  const label = (locale: string, count: number) =>
    createTranslator({ locale, messages: bundle(locale) as never, namespace: 'applications' as never })(
      'column.aria' as never,
      { name: 'X', count } as never,
    ) as string;

  it('reads "1 job", not "1 jobs"', () => {
    expect(label('en', 1)).toBe('X, 1 job');
    expect(label('en', 0)).toBe('X, 0 jobs');
    expect(label('en', 12)).toBe('X, 12 jobs');
  });

  it('has a singular in every language that has one', () => {
    expect(label('es', 1)).toBe('X, 1 empleo');
    expect(label('es', 3)).toBe('X, 3 empleos');
    expect(label('fr', 1)).toBe('X, 1 offre');
    expect(label('fr', 3)).toBe('X, 3 offres');
    expect(label('pt', 1)).toBe('X, 1 vaga');
    expect(label('pt', 3)).toBe('X, 3 vagas');
    expect(label('de', 1)).toBe('X, 1 Job');
    expect(label('de', 3)).toBe('X, 3 Jobs');
  });

  it('formats in all nine locales and carries the count', () => {
    for (const locale of LOCALES) {
      for (const count of [0, 1, 2, 25]) expect(label(locale, count), `${locale}:${count}`).toContain(String(count));
    }
  });
});

describe('CJK bundles keep one punctuation style', () => {
  const CJK = '\\u3040-\\u30ff\\u4e00-\\u9fff';
  // A half-width colon straight after CJK text ("缺少的地方: "), where the bundle style is "：".
  const HALF_WIDTH_COLON = new RegExp(`[${CJK}）」』]\\s?:(?!//)`);
  const offenders = (locale: string, test: (value: string) => boolean) =>
    leaves(bundle(locale))
      .filter(([, value]) => test(value))
      .map(([path]) => path);

  it('no half-width colon after CJK text in zh, zh-TW or ja', () => {
    for (const locale of ['zh', 'zh-TW', 'ja']) expect(offenders(locale, (v) => HALF_WIDTH_COLON.test(v)), locale).toEqual([]);
  });

  it('zh-TW and ja quote with 「」, never with curly or straight quotes', () => {
    for (const locale of ['zh-TW', 'ja']) expect(offenders(locale, (v) => /[“”"]/.test(v)), locale).toEqual([]);
  });
});
