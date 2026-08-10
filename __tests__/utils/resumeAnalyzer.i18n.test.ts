// Every analyzer issue message resolves, in every locale.
//
// lib/resumeAnalyzer emits an i18n KEY per issue and AnalyzerPanel resolves it
// with a template literal — `t(`analyzer.issue.${issue.messageKey}`)`. That is
// invisible to scripts/check-copy.mjs, which can only follow literal t('…')
// calls, and next-intl renders a missing key as its own dotted path instead of
// throwing. So a typo'd or untranslated key would ship as the literal string
// "resume.analyzer.issue.skills_few" with a green build and a clean copy gate.
//
// This test closes that hole: it compiles every key against every bundle with
// a throwing onError, which also catches malformed ICU (an unbalanced plural
// arm in a translated bundle only fails at render time otherwise).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';

import {
  ANALYZER_MESSAGE_KEYS,
  analyzeResume,
  type AnalyzerMessageValues,
} from '../../lib/resumeAnalyzer';
import { parseResumeMarkdown } from '../../lib/resumeStructure';

const MESSAGES_DIR = join(process.cwd(), 'i18n/messages');
const LOCALES = readdirSync(MESSAGES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''));

function bundle(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), 'utf8'));
}

/** The panel resolves keys the same way: by template literal, off a namespace. */
type Translate = (key: string, values?: Record<string, unknown>) => string;

/** Superset of every value any issue message can take; extra values are inert. */
const VALUES: Required<AnalyzerMessageValues> = {
  where: 'Acme',
  entry: 2,
  count: 3,
  words: 42,
};

// Plural rules split on the count, so a message that reads fine at 3 can still
// be malformed at 0 or 1.
const COUNTS = [0, 1, 2, 3, 11];

describe('analyzer issue messages are translated', () => {
  it.each(LOCALES)('%s resolves every analyzer message key', (locale) => {
    const t = createTranslator({
      locale,
      messages: bundle(locale),
      namespace: 'resume',
      onError: (err) => {
        throw err;
      },
    }) as unknown as Translate;

    // The position fallback the panel substitutes for {where} on an unnamed entry.
    const fallback = t('analyzer.issue.entry_fallback', { index: VALUES.entry });
    expect(fallback).not.toContain('analyzer.issue');
    expect(fallback).not.toMatch(/[{}]/);

    for (const key of ANALYZER_MESSAGE_KEYS) {
      for (const count of COUNTS) {
        const text = t(`analyzer.issue.${key}`, { ...VALUES, count });
        // next-intl's fallback for a missing key is the dotted path itself.
        expect(text, `${locale}: ${key} did not resolve`).not.toContain(
          `analyzer.issue.${key}`,
        );
        expect(text.trim(), `${locale}: ${key} is empty`).not.toBe('');
        // An unsubstituted placeholder means the translator renamed or dropped
        // one — ICU leaves it in the output rather than erroring.
        expect(text, `${locale}: ${key} left a placeholder unfilled`).not.toMatch(
          /\{(where|count|words|index)\b/,
        );
      }
    }
  });

  it('every catalog key under analyzer.issue is one the analyzer can emit', () => {
    const en = bundle('en') as {
      resume: { analyzer: { issue: Record<string, string> } };
    };
    const known = new Set<string>([...ANALYZER_MESSAGE_KEYS, 'entry_fallback']);
    for (const key of Object.keys(en.resume.analyzer.issue)) {
      expect(known.has(key), `en.json has an unreachable string for "${key}"`).toBe(true);
    }
  });

  it('analyzeResume only emits declared message keys', () => {
    const declared = new Set<string>(ANALYZER_MESSAGE_KEYS);
    // An empty resume trips the required-field rules; a populated-but-weak one
    // trips the bullet, skill and education rules. Together they cover the set.
    const empty = parseResumeMarkdown('');
    const weak = parseResumeMarkdown(
      [
        '# Ada Lovelace',
        '',
        '## Experience',
        '',
        '### · ',
        '- Was responsible for various things across the team',
        '',
        '## Skills',
        '',
        'Analytical Engines',
      ].join('\n'),
    );
    for (const resume of [empty, weak]) {
      for (const issue of analyzeResume(resume).issues) {
        expect(declared.has(issue.messageKey), `undeclared key ${issue.messageKey}`).toBe(
          true,
        );
      }
    }
  });
});
