// @vitest-environment node
//
// The one tokenizer of the lexical leg (MKT-2H item 2; SM-11 "产品 经理
// segments consistently at ingest and query").

import { describe, expect, it } from 'vitest';
import { normalizeTitle } from '../jobs/taxonomy/index.js';
import { MAX_QUERY_TOKENS, QUERY_STOPWORDS, queryTokens, segmentForSearch, toTsQuery } from './segment.js';

describe('segmentForSearch', () => {
  it('gives the same tokens with and without a space: 产品经理 and 产品 经理', () => {
    expect(segmentForSearch('产品经理')).toEqual(segmentForSearch('产品 经理'));
    expect(segmentForSearch('产品经理')).toEqual(['产品', '经理']);
  });

  it('gives a Traditional query the tokens of a Simplified document, and the reverse', () => {
    expect(segmentForSearch('產品經理')).toEqual(segmentForSearch('产品经理'));
    expect(segmentForSearch('資深後端工程師')).toEqual(segmentForSearch('资深后端工程师'));
    // Taiwan vocabulary, not only characters: 軟體 is 软件.
    expect(segmentForSearch('軟體工程師')).toEqual(segmentForSearch('软件工程师'));
    expect(segmentForSearch('資料分析師')).toEqual(segmentForSearch('数据分析师'));
  });

  it('a document that contains a query phrase contains the tokens of that query', () => {
    const doc = new Set(segmentForSearch('北京 · 高级产品经理（电商方向），负责产品规划'));
    for (const token of queryTokens('產品經理')) expect(doc.has(token), token).toBe(true);
    const tw = new Set(segmentForSearch('誠徵資深軟體工程師，熟悉資料庫設計'));
    for (const token of queryTokens('软件工程师 数据库')) expect(tw.has(token), token).toBe(true);
  });

  it('keeps tech tokens as the title normaliser spells them', () => {
    const tokens = segmentForSearch('Senior C++ Engineer (Node.js)');
    expect(tokens).toEqual(['senior', 'cpp', 'engineer', 'nodejs']);
    expect(segmentForSearch('C# / .NET developer')).toEqual(['csharp', 'dotnet', 'developer']);
    // The same spellings as jobs/taxonomy normalizeTitle.
    for (const [raw, token] of [['C++', 'cpp'], ['C#', 'csharp'], ['Node.js', 'nodejs']] as const) {
      expect(normalizeTitle(raw)).toBe(token);
      expect(segmentForSearch(raw)).toEqual([token]);
    }
    expect(normalizeTitle('.NET')).toBe('dotnet');
    expect(segmentForSearch('ASP.NET Core')).toEqual(['asp', 'dotnet', 'core']);
  });

  it('".NET" is the platform only where it is written as one: a domain or an e-mail address keeps "net"', () => {
    expect(segmentForSearch('.NET')).toEqual(['dotnet']);
    expect(segmentForSearch('Java/.NET, (.NET 8) and VB.NET')).toEqual(['java', 'dotnet', 'dotnet', '8', 'and', 'vb', 'dotnet']);
    expect(segmentForSearch('熟悉.NET开发')).toContain('dotnet');
    // A posting that says where to apply must not match a ".NET" query.
    for (const text of ['apply at careers.acme.net today', 'https://jobs.acme.net/apply', 'write to hr@acme.net', 'x.net y', 'kotlin.net']) {
      const tokens = segmentForSearch(text);
      expect(tokens, text).not.toContain('dotnet');
      expect(tokens, text).toContain('net');
    }
    expect(segmentForSearch('x.net y')).toEqual(['x', 'net', 'y']);
    expect(segmentForSearch('kotlin.net')).toEqual(['kotlin', 'net']);
  });

  it('lower-cases, folds full-width forms and splits Latin text on anything that is not a letter or a digit', () => {
    expect(segmentForSearch('Ｓenior  Data-Engineer/ETL, 3D & H5')).toEqual(['senior', 'data', 'engineer', 'etl', '3d', 'h5']);
    expect(segmentForSearch('Café manager — Zürich')).toEqual(['café', 'manager', 'zürich']);
  });

  it('splits mixed text into its scripts', () => {
    expect(segmentForSearch('熟悉Kubernetes和微服务架构')).toEqual(expect.arrayContaining(['熟悉', 'kubernetes', '服务', '架构']));
    expect(segmentForSearch('Java开发')).toEqual(['java', '开发']);
  });

  describe('fallback for words the segmenter does not know', () => {
    it('one-character pieces in a row also give their bigram', () => {
      const tokens = segmentForSearch('鸿蒙开发');
      if (tokens.includes('鸿') && tokens.includes('蒙')) expect(tokens).toContain('鸿蒙');
      // Whatever the segmenter makes of 鸿蒙, a document that holds the word holds every token of a query for it.
      const doc = new Set(segmentForSearch('招聘鸿蒙开发工程师，负责应用开发'));
      for (const token of queryTokens('鸿蒙开发')) expect(doc.has(token), token).toBe(true);
    });

    it('a lone piece is glued to the word beside it', () => {
      const tokens = segmentForSearch('软件工程师');
      if (tokens.includes('师')) expect(tokens).toContain('程师');
      expect(tokens).toContain('软件');
    });

    it('never glues a function word to its neighbour', () => {
      const tokens = segmentForSearch('北京的产品经理');
      expect(tokens).not.toContain('的产');
      expect(tokens).not.toContain('京的');
      expect(tokens).toEqual(expect.arrayContaining(['北京', '产品', '经理']));
    });

    it('a segment longer than four characters also gives its character bigrams', () => {
      const tokens = segmentForSearch('エンジニア');
      if (tokens.includes('エンジニア')) expect(tokens).toEqual(expect.arrayContaining(['エン', 'ンジ', 'ジニ', 'ニア']));
    });
  });

  it('answers no token for nothing', () => {
    expect(segmentForSearch('')).toEqual([]);
    expect(segmentForSearch(null)).toEqual([]);
    expect(segmentForSearch(undefined)).toEqual([]);
    expect(segmentForSearch('  — / ·  ')).toEqual([]);
  });

  it('keeps repeats and order (a document keeps its term frequency)', () => {
    expect(segmentForSearch('Rust rust RUST go')).toEqual(['rust', 'rust', 'rust', 'go']);
  });
});

describe('toTsQuery', () => {
  it('is the OR of the distinct tokens, each quoted', () => {
    expect(toTsQuery('产品经理 Rust')).toBe("'产品' | '经理' | 'rust'");
    expect(toTsQuery('Rust rust RUST')).toBe("'rust'");
  });

  it('builds the same query for a Traditional and a Simplified spelling', () => {
    expect(toTsQuery('產品經理')).toBe(toTsQuery('产品经理'));
  });

  it('leaves function words, bare numbers and one-character CJK tokens out of a query, never out of a document', () => {
    expect(toTsQuery('backend jobs at climate startups using Rust')).toBe("'backend' | 'climate' | 'startups' | 'rust'");
    expect(toTsQuery('北京的产品经理工作')).toBe("'北京' | '产品' | '经理'");
    expect(toTsQuery('Java 15薪')).toBe("'java'");
    expect(segmentForSearch('backend jobs at climate startups')).toContain('jobs');
    expect(segmentForSearch('北京的产品经理')).toContain('的');
    expect(QUERY_STOPWORDS.has('jobs')).toBe(true);
  });

  it('keeps what is left when a query is only such tokens', () => {
    expect(toTsQuery('jobs')).toBe("'jobs'");
    expect(toTsQuery('厨')).toBe("'厨'");
    expect(toTsQuery('2026')).toBe("'2026'");
  });

  it('carries at most 24 tokens, the first ones', () => {
    const text = Array.from({ length: 40 }, (_, i) => `term${i}`).join(' ');
    const tokens = queryTokens(text);
    expect(tokens).toHaveLength(MAX_QUERY_TOKENS);
    expect(MAX_QUERY_TOKENS).toBe(24);
    expect(tokens[0]).toBe('term0');
    expect(tokens[23]).toBe('term23');
    expect(toTsQuery(text)!.split(' | ')).toHaveLength(24);
  });

  it('is null for a text with no token, and only ever holds quoted letters and digits', () => {
    expect(toTsQuery('')).toBeNull();
    expect(toTsQuery(' !!! ')).toBeNull();
    // Operators of to_tsquery cannot come through: they are not letters or digits.
    expect(toTsQuery("rust' | !go & (c) :* <-> \\")).toBe("'rust' | 'go' | 'c'");
  });
});
