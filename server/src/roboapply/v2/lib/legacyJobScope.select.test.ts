// @vitest-environment node
//
// The job-scope select against the generated Prisma client.
//
// `GET /v2/resumes` answered 500 for every user with one resume tailored to a
// job: the select named `provider`, a column `RAJob` does not have, and
// `prisma as any` hid the type error while the fake Prisma used by the other
// tests ignores `select` entirely. These tests read the generated model so a
// column that does not exist fails here, and they run the visibility check on
// rows shaped exactly like what the select returns (no `provider`).

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { Prisma } from '../../../generated/prisma/client.js';
import { LEGACY_JOB_SCOPE_SELECT, legacyJobVisible } from './legacyJobScope.js';

const OFF = { CN_RECRUITMENT_INFO_MODE: 'off' };
const ON = { CN_RECRUITMENT_INFO_MODE: 'partner_deeplink' };

/** A row as Prisma returns it for the scope select: only the selected columns. */
function selected(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(LEGACY_JOB_SCOPE_SELECT).map((k) => [k, row[k] ?? null]));
}

describe('LEGACY_JOB_SCOPE_SELECT', () => {
  it('names only columns that exist on the RAJob model', () => {
    const columns = new Set<string>(Object.values(Prisma.RAJobScalarFieldEnum));
    const unknown = Object.keys(LEGACY_JOB_SCOPE_SELECT).filter((k) => !columns.has(k));
    expect(unknown).toEqual([]);
    expect(columns.has('provider')).toBe(false);
  });

  it('the resume service and the insight service build their selects from it', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    for (const rel of ['../services/RAResumeService.ts', '../services/RAInsightService.ts']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(src, rel).toContain('LEGACY_JOB_SCOPE_SELECT');
      // No hand-written copy of the scope columns (the copy is what drifted).
      expect(src, rel).not.toMatch(/visibility:\s*true,\s*ownerUserId:\s*true,\s*provider:\s*true/);
    }
  });

  it('decides visibility from the selected columns alone', () => {
    const publicIntl = selected({ market: 'intl', visibility: 'public', ownerUserId: null, sourceBoard: 'greenhouse' });
    const ownCn = selected({ market: 'cn', visibility: 'private', ownerUserId: 'u1', sourceBoard: 'user_import' });
    const otherCn = selected({ market: 'cn', visibility: 'private', ownerUserId: 'u2', sourceBoard: 'user_import' });
    const bankCn = selected({ market: 'cn', visibility: 'public', ownerUserId: null, sourceBoard: 'gohire' });
    const seed = selected({ market: 'intl', visibility: 'public', ownerUserId: null, sourceBoard: 'seed' });

    expect(legacyJobVisible(publicIntl, 'u1', { market: 'intl', env: {} })).toBe(true);
    expect(legacyJobVisible(seed, 'u1', { market: 'intl', env: {} })).toBe(false);
    // A user's own import is recognised by visibility + owner, without `provider`.
    expect(legacyJobVisible(ownCn, 'u1', { market: 'cn', env: OFF })).toBe(true);
    expect(legacyJobVisible(otherCn, 'u1', { market: 'cn', env: ON })).toBe(false);
    expect(legacyJobVisible(bankCn, 'u1', { market: 'cn', env: OFF })).toBe(false);
    expect(legacyJobVisible(bankCn, 'u1', { market: 'cn', env: ON })).toBe(true);
  });
});
