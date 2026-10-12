// WP-22 — error mapping of the resume-check hooks (platform envelope → UI state).

import { describe, expect, it } from 'vitest';

import { RoboApiError } from '../../lib/api/client';
import { RUNNING_POLL_MS, issueFixErrorKind, latestRefetchInterval, resumeCheckErrorKind } from './useResumeCheck';
import type { GradeView, LatestGradeResponse } from '../../lib/api/contracts/resume';

const apiError = (code: string, details?: Record<string, unknown>) =>
  Object.assign(Object.create(RoboApiError.prototype), { payload: { code, details } }) as RoboApiError;

describe('resumeCheckErrorKind', () => {
  it.each([
    ['credits_exhausted', undefined, 'credits_exhausted'],
    ['ai_unavailable', undefined, 'ai_unavailable'],
    ['not_found', undefined, 'not_found'],
    ['conflict', { reason: 'request_in_progress' }, 'already_running'],
    ['conflict', { reason: 'request_already_completed' }, 'failed'],
    ['internal_error', undefined, 'failed'],
  ] as const)('%s %o → %s', (code, details, kind) => {
    expect(resumeCheckErrorKind(apiError(code, details))).toBe(kind);
  });
  it('treats non-API errors as failed', () => {
    expect(resumeCheckErrorKind(new Error('network'))).toBe('failed');
  });
});

describe('issueFixErrorKind', () => {
  it.each([
    ['ai_unavailable', undefined, 'ai_unavailable'],
    ['credits_exhausted', undefined, 'credits_exhausted'],
    ['conflict', { reason: 'citation_guard' }, 'citation_guard'],
    ['conflict', { reason: 'target_changed' }, 'changed'],
    ['invalid_request', { reason: 'issue_not_fixable' }, 'failed'],
  ] as const)('%s %o → %s', (code, details, kind) => {
    expect(issueFixErrorKind(apiError(code, details))).toBe(kind);
  });
});

describe('latestRefetchInterval', () => {
  const withStatus = (status: GradeView['status'] | null): LatestGradeResponse => ({
    grade: status ? ({ status } as GradeView) : null,
    previous: null,
    stale: false,
    aiAvailable: true,
  });
  it('polls only while the newest check is running', () => {
    expect(latestRefetchInterval(withStatus('running'))).toBe(RUNNING_POLL_MS);
    expect(latestRefetchInterval(withStatus('done'))).toBe(false);
    expect(latestRefetchInterval(withStatus('failed'))).toBe(false);
    expect(latestRefetchInterval(withStatus(null))).toBe(false);
    expect(latestRefetchInterval(undefined)).toBe(false);
  });
});
