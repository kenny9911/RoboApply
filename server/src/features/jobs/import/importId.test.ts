// @vitest-environment node
//
// WP-35 — signed draft ids and saved-job ids.

import { describe, expect, it } from 'vitest';
import { DRAFT_TTL_SEC, draftImportId, isConfirmableDraft, jobIdFromImportId, jobImportId, verifyDraftImportId } from './importId.js';

const env = { JWT_SECRET: 'test-secret' };
const now = new Date('2026-10-10T12:00:00Z');

describe('import ids', () => {
  it('round-trips a draft for its user only', () => {
    const id = draftImportId({ userId: 'u1', status: 'needs_fields', missingFields: ['company'], reason: null }, { env, now });
    expect(id.startsWith('draft_')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(512);
    expect(verifyDraftImportId(id, 'u1', { env, now })).toMatchObject({ status: 'needs_fields', missingFields: ['company'], reason: null });
    expect(verifyDraftImportId(id, 'u2', { env, now })).toBeNull();
  });

  it('keeps the reason and expires after the TTL', () => {
    const id = draftImportId({ userId: 'u1', status: 'needs_text', missingFields: ['title', 'company', 'description'], reason: 'blocked_site' }, { env, now });
    expect(verifyDraftImportId(id, 'u1', { env, now })?.reason).toBe('blocked_site');
    const later = new Date(now.getTime() + (DRAFT_TTL_SEC + 5) * 1000);
    expect(verifyDraftImportId(id, 'u1', { env, now: later })).toBeNull();
  });

  it('rejects a tampered or foreign-key token', () => {
    const id = draftImportId({ userId: 'u1', status: 'failed', missingFields: [], reason: 'fetch_failed' }, { env, now });
    const [body, sig] = id.slice('draft_'.length).split('.');
    const forged = Buffer.from(JSON.stringify({ u: 'u1', s: 'f', m: [], r: -1, x: 9_999_999_999 })).toString('base64url');
    expect(verifyDraftImportId(`draft_${forged}.${sig}`, 'u1', { env, now })).toBeNull();
    expect(verifyDraftImportId(`draft_${body}.${sig}`, 'u1', { env: { JWT_SECRET: 'other' }, now })).toBeNull();
    expect(verifyDraftImportId('draft_nodot', 'u1', { env, now })).toBeNull();
  });

  it('every draft carries its own single-use nonce; only drafts to check or complete are confirmable', () => {
    const a = verifyDraftImportId(draftImportId({ userId: 'u1', status: 'needs_fields', missingFields: [], reason: null }, { env, now }), 'u1', { env, now });
    const b = verifyDraftImportId(draftImportId({ userId: 'u1', status: 'needs_fields', missingFields: [], reason: null }, { env, now }), 'u1', { env, now });
    expect(a?.nonce).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(a?.nonce).not.toBe(b?.nonce);
    expect(isConfirmableDraft(a)).toBe(true);
    const text = verifyDraftImportId(draftImportId({ userId: 'u1', status: 'needs_text', missingFields: [], reason: 'blocked_site' }, { env, now }), 'u1', { env, now });
    expect(isConfirmableDraft(text)).toBe(true);
    const failed = verifyDraftImportId(draftImportId({ userId: 'u1', status: 'failed', missingFields: [], reason: 'fetch_failed' }, { env, now }), 'u1', { env, now });
    expect(failed?.status).toBe('failed');
    expect(isConfirmableDraft(failed)).toBe(false);
    expect(isConfirmableDraft(a ? { ...a, nonce: null } : null)).toBe(false);
    expect(isConfirmableDraft(null)).toBe(false);
  });

  it('without a secret, drafts are unsigned and never verify', () => {
    const id = draftImportId({ userId: 'u1', status: 'needs_fields', missingFields: [], reason: null }, { env: {}, now });
    expect(id.startsWith('draft_')).toBe(true);
    expect(verifyDraftImportId(id, 'u1', { env: {}, now })).toBeNull();
  });

  it('wraps saved job ids', () => {
    expect(jobImportId('cj1')).toBe('job_cj1');
    expect(jobIdFromImportId('job_cj1')).toBe('cj1');
    expect(jobIdFromImportId('job_')).toBeNull();
    expect(jobIdFromImportId('draft_x')).toBeNull();
  });
});
