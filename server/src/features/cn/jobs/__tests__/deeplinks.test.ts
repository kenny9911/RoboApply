// @vitest-environment node
// WP-41 acceptance: deep links contain only the user's query.

import { describe, expect, it } from 'vitest';
import { CN_EXTERNAL_HOSTS, buildExternalSearchLinks, externalKeyword } from '../deeplinks.js';

describe('external search deep links', () => {
  it('one link per board, on the board host, carrying only the keyword', () => {
    const { links } = buildExternalSearchLinks('产品经理', '上海');
    expect(links.map((l) => l.board)).toEqual(['boss', 'zhaopin', 'liepin']);
    for (const l of links) {
      const url = new URL(l.url);
      expect(CN_EXTERNAL_HOSTS).toContain(url.host);
      expect(url.protocol).toBe('https:');
      const params = [...url.searchParams.entries()];
      expect(params).toHaveLength(1);
      expect(params[0]![1]).toBe('产品经理 上海');
      expect(url.hash).toBe('');
    }
  });

  it('control characters and extra spaces are removed; no city → only the query', () => {
    expect(externalKeyword(' java\n后端\t ', '')).toBe('java 后端');
    const { links } = buildExternalSearchLinks('数据分析');
    expect(new URL(links[0]!.url).searchParams.get('query')).toBe('数据分析');
  });

  it('a query that is only whitespace builds nothing', () => {
    expect(buildExternalSearchLinks('   ')).toEqual({ links: [] });
  });

  it('special characters are encoded, not interpreted', () => {
    const { links } = buildExternalSearchLinks('a&userId=1#x');
    for (const l of links) {
      const url = new URL(l.url);
      expect([...url.searchParams.keys()]).toHaveLength(1);
      expect([...url.searchParams.values()][0]).toBe('a&userId=1#x');
    }
  });
});
