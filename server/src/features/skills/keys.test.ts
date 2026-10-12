// @vitest-environment node
// MKT-2G item 1: the comparison key of a skill name, in three scripts.
import { describe, expect, it } from 'vitest';

import { termKey } from './terms.js';
import { aliasKey, hasHan, isListOnlyWord, LIST_ONLY_KEYS, SHORT_NAMES_WITH_ONE_READING, slugOf } from './keys.js';

describe('aliasKey', () => {
  it('is the termKey of terms.ts for a Latin name: case, dots, dashes, spaces and plural do not matter', () => {
    for (const term of ['Node.js', 'nodejs', 'NodeJS', ' node.JS ']) expect(aliasKey(term)).toBe('nodejs');
    for (const term of ['REST APIs', 'rest api', 'Rest-API']) expect(aliasKey(term)).toBe('restapi');
    for (const term of ['Relational Databases', 'relational database']) expect(aliasKey(term)).toBe(termKey('relational database'));
    expect(aliasKey('CI/CD')).toBe('cicd');
    expect(aliasKey('PL/SQL')).toBe('plsql');
    expect(aliasKey('scikit-learn')).toBe(termKey('scikit-learn'));
  });

  it('keeps the characters that tell two languages apart', () => {
    expect(aliasKey('C++')).toBe('c++');
    expect(aliasKey('C#')).toBe('c#');
    expect(aliasKey('C')).toBe('c');
    expect(new Set(['C', 'C++', 'C#'].map(aliasKey)).size).toBe(3);
  });

  it('folds Traditional Chinese to Simplified, so one skill has one key in both scripts', () => {
    expect(aliasKey('機器學習')).toBe('机器学习');
    expect(aliasKey('机器学习')).toBe('机器学习');
    expect(aliasKey('大學英語六級')).toBe(aliasKey('大学英语六级'));
    expect(aliasKey('數據庫')).toBe(aliasKey('数据库'));
    // Taiwan vocabulary, not only characters: 資料庫 is 数据库.
    expect(aliasKey('資料庫')).toBe('数据库');
    expect(aliasKey('API 設計')).toBe(aliasKey('api 设计'));
    // English and Chinese stay different keys: they meet as two aliases of one id, not as one key.
    expect(aliasKey('machine learning')).not.toBe(aliasKey('机器学习'));
  });

  it('gives no key to a blank or punctuation-only string', () => {
    expect(aliasKey('')).toBe('');
    expect(aliasKey('   ')).toBe('');
  });

  it('is not idempotent, which is why a stored key is never keyed again', () => {
    expect(aliasKey('Amazon AWS')).toBe('amazonaws');
    expect(aliasKey('amazonaws')).not.toBe('amazonaws');
  });
});

describe('isListOnlyWord', () => {
  it('follows terms.ts for everyday words and single letters, also in the plural', () => {
    for (const word of ['rest', 'REST', 'excel', 'Excels', 'swift', 'go', 'react', 'Rails', 'rail', 'c', 'R']) expect(isListOnlyWord(word), word).toBe(true);
  });

  it('adds the names whose key is also something else in a sentence', () => {
    expect(LIST_ONLY_KEYS.has(aliasKey('.NET'))).toBe(true);
    for (const word of ['node', 'Node', '.NET', 'net', 'TS', 'NATS', 'nat']) expect(isListOnlyWord(word), word).toBe(true);
  });

  it('adds the short abbreviations that read as something else in prose, also in the plural and with dots', () => {
    // 500 ml · P.S. · Ai (a name) · PY (prior year) · CPA (cost per acquisition) · a rag · the Red Sox · "Iam"
    for (const word of ['ml', 'mL', 'ML', 'ps', 'P.S', 'AI', 'A.I', 'py', 'CPA', 'CPAs', 'rag', 'RAGs', 'Sox', 'iam', 'IAM']) expect(isListOnlyWord(word), word).toBe(true);
    for (const key of ['ml', 'ps', 'ai', 'py', 'cpa', 'rag', 'sox', 'iam']) expect(LIST_ONLY_KEYS.has(key), key).toBe(true);
  });

  it('the rule for short abbreviations: three letters or fewer count from a sentence only when listed as having one reading', () => {
    // Listed: one reading in a resume.
    for (const word of ['AWS', 'sql', 'CSS', 'git', 'JS', 'PHP', 'API', 'iOS', 'SEO', 'CFA', 'PMP', 'UX', 'QA']) expect(isListOnlyWord(word), word).toBe(false);
    // Not listed: good clinical practice, dialectical behaviour therapy, the law degree LL.M., neuro-linguistic programming,
    // Canada Pension Plan, instrument flight rules, accounts receivable, an afternoon, an hour.
    for (const word of ['GCP', 'DBT', 'LLM', 'LL.M', 'NLP', 'CPP', 'IFR', 'AR', 'pm', 'hr', 'xyz']) expect(isListOnlyWord(word), word).toBe(true);
    // The rule is about the word as written: the longer word is not short.
    for (const word of ['IFRS', 'LLMs', 'APIs', 'C++', 'C#', 'S3', 'K8s', 'EC2']) expect(isListOnlyWord(word), word).toBe(false);
    for (const name of SHORT_NAMES_WITH_ONE_READING) {
      expect(name, name).toMatch(/^[a-z]{2,3}$/);
      expect(LIST_ONLY_KEYS.has(name), name).toBe(false);
    }
  });

  it('lets an unmistakable name through', () => {
    for (const word of ['PostgreSQL', 'restful', 'Node.js', 'kubernetes', 'TypeScript', 'js', 'machine learning', '机器学习', '一建']) expect(isListOnlyWord(word), word).toBe(false);
  });
});

describe('slugOf and hasHan', () => {
  it('makes a readable id from a label', () => {
    expect(slugOf('Relational databases')).toBe('relational_databases');
    expect(slugOf('  Power BI ')).toBe('power_bi');
    expect(slugOf('scikit-learn')).toBe('scikit_learn');
    expect(slugOf('pl/sql')).toBe('pl_sql');
  });

  it('knows Chinese text', () => {
    expect(hasHan('機器學習')).toBe(true);
    expect(hasHan('api 设计')).toBe(true);
    expect(hasHan('machine learning')).toBe(false);
  });
});
