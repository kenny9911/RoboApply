// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createSqlRecorder } from '../../test/sqlSnapshot.js';
import {
  SKILL_ALIASES,
  createSkillSuggestService,
  escapeLike,
  querySkillRows,
  rankSkillSuggestions,
  skillQueryLongEnough,
  skillSearchTerms,
} from './skills.js';

describe('skill query helpers', () => {
  it('needs 2 characters, or 1 Chinese character', () => {
    expect(skillQueryLongEnough('p')).toBe(false);
    expect(skillQueryLongEnough(' py ')).toBe(true);
    expect(skillQueryLongEnough('算')).toBe(true);
  });

  it('escapes LIKE wildcards and expands well-known aliases', () => {
    expect(escapeLike('100%_c\\')).toBe('100\\%\\_c\\\\');
    expect(skillSearchTerms('k8s')).toEqual(['k8s', 'Kubernetes']);
    expect(skillSearchTerms('Kubernetes')).toEqual(['Kubernetes']);
    expect(skillSearchTerms('SQL')).toEqual(['SQL']);
    for (const v of Object.values(SKILL_ALIASES)) expect(v.trim().length).toBeGreaterThan(0);
  });
});

describe('querySkillRows', () => {
  it('aggregates only public, canonical, unarchived jobs of the market (D3 filter), parameterized', async () => {
    const sql = createSqlRecorder({ results: [[{ label: 'Python', n: 5n }]] });
    const rows = await querySkillRows(sql.client as never, 'cn', 'py_', 10);
    expect(rows).toEqual([{ label: 'Python', n: 5 }]);
    const last = sql.last()!;
    expect(last.text).toContain(`j."market" = $1 AND j."visibility" = 'public' AND j."isCanonical" = true AND j."archivedAt" IS NULL`);
    expect(last.text).toContain('"RAKeywordExtraction"');
    expect(last.text).toContain('unnest(jobs."skills")');
    expect(last.values).toEqual(['cn', '%py\\_%', '%py\\_%', 60, 'py\\_%', 10]);
  });
});

describe('rankSkillSuggestions', () => {
  it('merges spellings, ranks prefix then frequency, and never returns counts', () => {
    const out = rankSkillSuggestions('py', [[{ label: 'Python', n: 3 }, { label: 'numpy', n: 9 }], [{ label: 'python', n: 2 }]], 10);
    expect(out).toEqual([
      { value: 'Python', label: 'Python', source: 'postings' },
      { value: 'numpy', label: 'numpy', source: 'postings' },
    ]);
  });

  it('uses an alias only to widen the search: a spelling no post names is never suggested', () => {
    expect(rankSkillSuggestions('k8s', [[], []], 10)).toEqual([]);
    expect(rankSkillSuggestions('k8s', [[], [{ label: 'Kubernetes', n: 4 }]], 10)).toEqual([{ value: 'Kubernetes', label: 'Kubernetes', source: 'postings' }]);
  });
});

describe('createSkillSuggestService', () => {
  it('queries nothing for a too-short query and once per search term otherwise', async () => {
    const sql = createSqlRecorder({ results: [[{ label: 'Kubernetes', n: 1 }], []] });
    const svc = createSkillSuggestService(async () => sql.client as never);
    expect(await svc.suggest('k', 'intl')).toEqual([]);
    expect(sql.calls).toHaveLength(0);
    const out = await svc.suggest('k8s', 'intl');
    expect(sql.calls).toHaveLength(2);
    expect(out[0]).toMatchObject({ value: 'Kubernetes' });
  });

  it('memoises an answer per market and query for the TTL, and forgets failures', async () => {
    let clock = 0;
    const sql = createSqlRecorder({ results: [[{ label: 'pandas', n: 2 }], [{ label: 'pandas', n: 5 }], [{ label: 'pandas', n: 1 }]] });
    const svc = createSkillSuggestService(async () => sql.client as never, { ttlMs: 1000, now: () => clock });
    await svc.suggest('Pandas', 'intl');
    await svc.suggest('pandas ', 'intl');
    expect(sql.calls).toHaveLength(1);
    await svc.suggest('pandas', 'cn');
    expect(sql.calls).toHaveLength(2);
    clock = 1000;
    await svc.suggest('pandas', 'intl');
    expect(sql.calls).toHaveLength(3);

    let fail = true;
    const flaky = createSkillSuggestService(
      async () => {
        if (fail) throw new Error('db down');
        return sql.client as never;
      },
      { ttlMs: 1000, now: () => clock },
    );
    await expect(flaky.suggest('sql', 'intl')).rejects.toThrow('db down');
    fail = false;
    await expect(flaky.suggest('sql', 'intl')).resolves.toBeInstanceOf(Array);
  });
});
