// backend/src/roboapply/services/accountPurgeHelpers.test.ts
//
// Unit tests for the pure account-purge selection logic: retention parsing,
// due-date cutoff, the seeker-only role guard, and candidate partitioning.
// Excluded from the server tsc build (tsconfig excludes src/**/*.test.ts); run
// via the root vitest config: npx vitest run server/src/roboapply/services/accountPurgeHelpers.test.ts

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PURGE_RETENTION_DAYS,
  isPurgeDue,
  isPurgeSafeRoleSet,
  partitionPurgeCandidates,
  purgeCutoff,
  resolveRetentionDays,
  type PurgeCandidate,
} from './accountPurgeHelpers.js';

const NOW = new Date('2026-07-10T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

describe('resolveRetentionDays', () => {
  it('defaults to 30 when unset or blank', () => {
    expect(DEFAULT_PURGE_RETENTION_DAYS).toBe(30);
    expect(resolveRetentionDays(undefined)).toBe(30);
    expect(resolveRetentionDays('')).toBe(30);
    expect(resolveRetentionDays('   ')).toBe(30);
  });

  it('parses a valid integer override', () => {
    expect(resolveRetentionDays('14')).toBe(14);
    expect(resolveRetentionDays('90')).toBe(90);
  });

  it('floors fractional values', () => {
    expect(resolveRetentionDays('7.9')).toBe(7);
  });

  it('never lets a bad value shorten retention below one day', () => {
    expect(resolveRetentionDays('0')).toBe(30);
    expect(resolveRetentionDays('-5')).toBe(30);
    expect(resolveRetentionDays('soon')).toBe(30);
    expect(resolveRetentionDays('NaN')).toBe(30);
  });
});

describe('isPurgeDue', () => {
  it('is false for accounts that were never soft-deleted', () => {
    expect(isPurgeDue(null, NOW, 30)).toBe(false);
    expect(isPurgeDue(undefined, NOW, 30)).toBe(false);
  });

  it('is false inside the retention window', () => {
    expect(isPurgeDue(daysAgo(0), NOW, 30)).toBe(false);
    expect(isPurgeDue(daysAgo(29), NOW, 30)).toBe(false);
  });

  it('is true exactly at the cutoff and beyond (inclusive lte, matching the DB query)', () => {
    expect(isPurgeDue(purgeCutoff(NOW, 30), NOW, 30)).toBe(true);
    expect(isPurgeDue(daysAgo(30), NOW, 30)).toBe(true);
    expect(isPurgeDue(daysAgo(31), NOW, 30)).toBe(true);
    expect(isPurgeDue(daysAgo(365), NOW, 30)).toBe(true);
  });

  it('respects a non-default retention', () => {
    expect(isPurgeDue(daysAgo(8), NOW, 7)).toBe(true);
    expect(isPurgeDue(daysAgo(8), NOW, 14)).toBe(false);
  });
});

describe('isPurgeSafeRoleSet', () => {
  it('accepts pure seeker accounts (what SeekerAuthService signup creates)', () => {
    expect(isPurgeSafeRoleSet('seeker', ['seeker'])).toBe(true);
  });

  it('accepts the legacy candidate spelling and seeker/candidate mixes', () => {
    expect(isPurgeSafeRoleSet('candidate', ['candidate'])).toBe(true);
    expect(isPurgeSafeRoleSet('seeker', ['seeker', 'candidate'])).toBe(true);
  });

  it('rejects any non-seeker role anywhere on the row', () => {
    expect(isPurgeSafeRoleSet('admin', ['admin'])).toBe(false);
    expect(isPurgeSafeRoleSet('user', ['user'])).toBe(false);
    // Multi-role recruiter+candidate — hard delete would cascade recruiter data.
    expect(isPurgeSafeRoleSet('user', ['user', 'candidate'])).toBe(false);
    expect(isPurgeSafeRoleSet('seeker', ['seeker', 'internal'])).toBe(false);
  });

  it('rejects rows with no role information rather than guessing', () => {
    expect(isPurgeSafeRoleSet('', [])).toBe(false);
    expect(isPurgeSafeRoleSet(null, null)).toBe(false);
  });

  it('tolerates a roles list missing the primary role (checks the union)', () => {
    expect(isPurgeSafeRoleSet('seeker', [])).toBe(true);
    expect(isPurgeSafeRoleSet('admin', [])).toBe(false);
  });
});

describe('partitionPurgeCandidates', () => {
  const mk = (userId: string, deletedDaysAgo: number | null, role = 'seeker', roles = [role]): PurgeCandidate => ({
    userId,
    deletedAt: deletedDaysAgo === null ? null : daysAgo(deletedDaysAgo),
    role,
    roles,
  });

  it('routes each candidate to exactly one bucket', () => {
    const candidates = [
      mk('due-old', 45),
      mk('due-boundary', 30),
      mk('fresh', 3),
      mk('never-deleted', null),
      mk('admin-stale', 60, 'admin', ['admin']),
      mk('multi-role-stale', 60, 'user', ['user', 'candidate']),
    ];
    const { due, notYetDue, unsafeRole } = partitionPurgeCandidates(candidates, NOW, 30);
    expect(due.map((c) => c.userId)).toEqual(['due-old', 'due-boundary']);
    expect(notYetDue.map((c) => c.userId)).toEqual(['fresh', 'never-deleted']);
    expect(unsafeRole.map((c) => c.userId)).toEqual(['admin-stale', 'multi-role-stale']);
    expect(due.length + notYetDue.length + unsafeRole.length).toBe(candidates.length);
  });

  it('classifies an unsafe role as notYetDue while retention has not elapsed (time wins)', () => {
    // An admin-ish row inside the window is not flagged yet — it may be fixed
    // or re-activated before the cutoff; it becomes unsafeRole only once due.
    const { due, notYetDue, unsafeRole } = partitionPurgeCandidates([mk('admin-fresh', 5, 'admin', ['admin'])], NOW, 30);
    expect(due).toEqual([]);
    expect(unsafeRole).toEqual([]);
    expect(notYetDue.map((c) => c.userId)).toEqual(['admin-fresh']);
  });

  it('handles an empty candidate list', () => {
    expect(partitionPurgeCandidates([], NOW, 30)).toEqual({ due: [], notYetDue: [], unsafeRole: [] });
  });
});
