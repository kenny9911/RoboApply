// @vitest-environment node
//
// WP-10 acceptance: after the account purge, ZERO rows remain for the user
// in every RA* table — by cascade (as the schema declares it) or by the
// purge's explicit deletes for the FK-less models — and the stored
// application files are deleted first. Also: the purge is brand-aware
// (GoApply ≤ 15 days for PIPL) and the self-serve data wipe clears the
// clone's application-data tables while keeping the account and resumes.
//
// The schema is read from server/prisma/schema/*.prisma, so a model added
// later is covered (or this test names it) without editing the test.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('../../lib/prisma.js', async () => {
  const { createFakePrisma } = await import('../../test/fakePrisma.js');
  const db = createFakePrisma();
  h.db = db;
  return { default: db, prisma: db };
});
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../interview-engine/storage/r2Storage.js', () => ({
  interviewR2Storage: { isConfigured: () => true, deleteSessionArtifacts: vi.fn(async () => ({ attempted: 1, failed: 0 })) },
}));
vi.mock('../../services/ResumeOriginalFileStorageService.js', () => ({
  resumeOriginalFileStorageService: { deleteFile: vi.fn(async () => true) },
}));

import type { createFakePrisma } from '../../test/fakePrisma.js';
import { purgeAccountNow, runAccountPurgeSweep, setArtifactStorageDeleter } from '../../roboapply/services/SeekerAccountPurgeService.js';
import { WIPED_CLONE_TABLES, wipeSeekerApplicationData } from '../../roboapply/services/SeekerAccountDataWipeService.js';
import { growthService } from '../growth/index.js';

type Fake = ReturnType<typeof createFakePrisma>;
const db = () => h.db as Fake;

// ── Schema reading ─────────────────────────────────────────────────────────

const SCHEMA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../prisma/schema');

interface ModelInfo {
  name: string;
  hasUserId: boolean;
  userRelation: 'Cascade' | 'SetNull' | 'other' | null;
}

function readModels(): ModelInfo[] {
  const out: ModelInfo[] = [];
  for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.prisma'))) {
    const src = readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
    for (const m of src.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const body = m[2]!;
      const hasUserId = /^\s+userId\s+String/m.test(body);
      const rel = /^\s+user\s+User\??\s+@relation\(([^)]*)\)/m.exec(body);
      const onDelete = rel ? /onDelete:\s*(\w+)/.exec(rel[1]!)?.[1] : undefined;
      out.push({ name: m[1]!, hasUserId, userRelation: rel ? (onDelete === 'Cascade' ? 'Cascade' : onDelete === 'SetNull' ? 'SetNull' : 'other') : null });
    }
  }
  return out;
}

const MODELS = readModels();
const RA_USER_MODELS = MODELS.filter((m) => m.name.startsWith('RA') && m.hasUserId);
const delegate = (model: string) => model[0]!.toLowerCase() + model.slice(1);

/**
 * Rows the purge must NOT delete, with the reason (mirrors FND-1b's
 * NO_CASCADE list): logs the operator must keep and purge on their own
 * schedule, and proof that a personal-information request was handled.
 */
const KEPT_BY_DESIGN: Record<string, string> = {
  RAAiContentLabelLog: 'AI-label log; compliance-daily purges it at 6 months (WP-13)',
  RAContentSafetyEvent: 'content-safety log; compliance-daily purges it (WP-13)',
  RAPersonalInfoRequest: 'SET NULL: proof the request was handled outlives the account',
  RABillingConsentArchive: 'proof of a checkout acknowledgement that must outlive the account (AB 2863); compliance-daily deletes it at retainUntil',
};

// ── Fake cascade: deleting a User removes the rows the schema cascades ─────

function installCascade() {
  const users = db().user as unknown as { deleteMany: (args: { where: { id: string } }) => Promise<{ count: number }> };
  const original = users.deleteMany.bind(users);
  users.deleteMany = async (args) => {
    const id = args.where.id;
    const res = await original(args);
    if (res.count === 0) return res;
    for (const m of RA_USER_MODELS) {
      const rows = db().$rows(delegate(m.name));
      if (m.userRelation === 'Cascade') {
        const keep = rows.filter((r) => r.userId !== id);
        rows.length = 0;
        rows.push(...keep);
      } else if (m.userRelation === 'SetNull') {
        for (const r of rows) if (r.userId === id) r.userId = null;
      }
    }
    for (const t of ['seekerProfile', 'session']) {
      const rows = db().$rows(t);
      const keep = rows.filter((r) => r.userId !== id);
      rows.length = 0;
      rows.push(...keep);
    }
    return res;
  };
}

const NOW = new Date('2026-10-10T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 864e5);

function seedUser(id: string, brand: string, deletedDaysAgo: number | null) {
  db().$rows('user').push({ id, email: `${id}@example.test`, brand, role: 'seeker', roles: ['seeker'] });
  // The sweep reads the user's role/brand through the relation (the fake
  // returns a nested object seeded on the row).
  db().$rows('seekerProfile').push({
    id: `p-${id}`,
    userId: id,
    deletedAt: deletedDaysAgo === null ? null : daysAgo(deletedDaysAgo),
    user: { role: 'seeker', roles: ['seeker'], brand },
  });
  for (const m of RA_USER_MODELS) {
    db().$rows(delegate(m.name)).push({ id: `${m.name}-${id}`, userId: id, storageKey: m.name === 'RAApplicationArtifact' ? `artifacts/${id}.pdf` : undefined });
  }
}

beforeEach(() => {
  for (const m of [...RA_USER_MODELS.map((x) => delegate(x.name)), 'user', 'seekerProfile', 'session', 'interviewSession', 'rAResumeVariant']) {
    db().$rows(m).length = 0;
  }
  installCascade();
});

describe('account purge removes every RA* row of the user', () => {
  it('reads a non-trivial schema (guards against a vacuous pass)', () => {
    expect(RA_USER_MODELS.length).toBeGreaterThan(40);
    expect(RA_USER_MODELS.map((m) => m.name)).toEqual(expect.arrayContaining(['RAOnboardingSession', 'RAWorkItem', 'RAProductEvent', 'RAApplicationArtifact']));
  });

  it('zero rows remain in every RA table for the purged user; the other user keeps theirs', async () => {
    seedUser('gone', 'roboapply', 31);
    seedUser('kept', 'roboapply', null);
    const deleted: string[] = [];
    setArtifactStorageDeleter(async (key) => {
      deleted.push(key);
      return true;
    });
    const events = vi.spyOn(growthService, 'deleteEventsForUser').mockResolvedValue({ deleted: 2 });

    const summary = await runAccountPurgeSweep({ now: NOW });
    expect(summary).toMatchObject({ purged: 1, blocked: 0, failed: 0 });
    expect(deleted).toEqual(['artifacts/gone.pdf']);
    expect(events).toHaveBeenCalledWith('gone');

    const leftovers = RA_USER_MODELS.filter((m) => !(m.name in KEPT_BY_DESIGN))
      .map((m) => [m.name, db().$rows(delegate(m.name)).filter((r) => r.userId === 'gone').length] as const)
      .filter(([, n]) => n > 0);
    expect(leftovers).toEqual([]);
    for (const m of RA_USER_MODELS) expect(db().$rows(delegate(m.name)).filter((r) => r.userId === 'kept')).toHaveLength(1);
    expect(db().$rows('user').map((u) => u.id)).toEqual(['kept']);
    events.mockRestore();
    setArtifactStorageDeleter(null);
  });

  it('keeps the user (blocked, retried) when an application file cannot be deleted', async () => {
    seedUser('gone', 'roboapply', 31);
    setArtifactStorageDeleter(async () => false);
    const summary = await runAccountPurgeSweep({ now: NOW });
    expect(summary).toMatchObject({ purged: 0, blocked: 1 });
    expect(db().$rows('user')).toHaveLength(1);
    expect(db().$rows('rAOnboardingSession')).toHaveLength(1);
    setArtifactStorageDeleter(null);
  });

  it('is brand-aware: GoApply purges after 15 days (PIPL), RoboApply waits for its 30', async () => {
    seedUser('cn', 'goapply', 16);
    seedUser('intl', 'roboapply', 16);
    setArtifactStorageDeleter(async () => true);
    const summary = await runAccountPurgeSweep({ now: NOW });
    expect(summary.purged).toBe(1);
    expect(db().$rows('user').map((u) => u.id)).toEqual(['intl']);
    setArtifactStorageDeleter(null);
  });
});

describe('purgeAccountNow (WP-13 statutory purge seam)', () => {
  it('hard-deletes one closed account at once, files first; the other user keeps theirs', async () => {
    seedUser('cn', 'goapply', 0);
    seedUser('kept', 'goapply', null);
    const deleted: string[] = [];
    setArtifactStorageDeleter(async (key) => {
      deleted.push(key);
      return true;
    });
    const events = vi.spyOn(growthService, 'deleteEventsForUser').mockResolvedValue({ deleted: 0 });
    expect(await purgeAccountNow('cn')).toEqual({ blocked: false });
    expect(deleted).toEqual(['artifacts/cn.pdf']);
    expect(db().$rows('user').map((u) => u.id)).toEqual(['kept']);
    // Already gone → idempotent success.
    expect(await purgeAccountNow('cn')).toEqual({ blocked: false });
    events.mockRestore();
    setArtifactStorageDeleter(null);
  });

  it('refuses an account that is not closed, and keeps it when a file cannot be deleted', async () => {
    seedUser('open', 'goapply', null);
    expect(await purgeAccountNow('open')).toEqual({ blocked: true, reason: 'account_not_closed' });
    seedUser('stuck', 'goapply', 0);
    setArtifactStorageDeleter(async () => false);
    expect((await purgeAccountNow('stuck')).blocked).toBe(true);
    expect(db().$rows('user').map((u) => u.id).sort()).toEqual(['open', 'stuck']);
    setArtifactStorageDeleter(null);
  });

  it('never hard-deletes a closed account that also holds a non-seeker role', async () => {
    seedUser('mixed', 'goapply', 0);
    const profile = db().$rows('seekerProfile').find((r) => r.userId === 'mixed')!;
    profile.user = { role: 'admin', roles: ['seeker', 'admin'], brand: 'goapply' };
    setArtifactStorageDeleter(async () => true);
    expect(await purgeAccountNow('mixed')).toEqual({ blocked: true, reason: 'unsafe_role' });
    expect(db().$rows('user').map((u) => u.id)).toEqual(['mixed']);
    setArtifactStorageDeleter(null);
  });
});

describe('self-serve data wipe', () => {
  it('clears the clone application-data tables (files first) and keeps account, profile and resumes', async () => {
    seedUser('me', 'roboapply', null);
    seedUser('other', 'roboapply', null);
    for (const t of ['rATrackerEntry', 'rAJobMatchScore']) db().$rows(t).push({ id: `${t}-x`, userId: 'me' });
    const deleted: string[] = [];
    setArtifactStorageDeleter(async (key) => {
      deleted.push(key);
      return true;
    });
    const summary = await wipeSeekerApplicationData('me');
    expect(deleted).toEqual(['artifacts/me.pdf']);
    for (const t of WIPED_CLONE_TABLES) {
      expect(summary.clone[t]).toBe(1);
      expect(db().$rows(delegate(t)).filter((r) => r.userId === 'me')).toEqual([]);
      expect(db().$rows(delegate(t)).filter((r) => r.userId === 'other')).toHaveLength(1);
    }
    expect(summary).toMatchObject({ trackerEntries: 2, matchScores: 2, applicationFilesKept: 0 });
    // Account, profile and resumes stay.
    for (const keep of ['RAResumeVariant', 'RAProfile', 'RAAuthIdentity', 'RASearchProfile']) {
      expect(db().$rows(delegate(keep)).filter((r) => r.userId === 'me')).toHaveLength(1);
    }
    expect(db().$rows('user').map((u) => u.id)).toContain('me');
    setArtifactStorageDeleter(null);
  });

  it('keeps an application file row whose stored file could not be deleted', async () => {
    seedUser('me', 'roboapply', null);
    setArtifactStorageDeleter(async () => false);
    const summary = await wipeSeekerApplicationData('me');
    expect(summary.applicationFilesKept).toBe(1);
    expect(db().$rows('rAApplicationArtifact')).toHaveLength(1);
    setArtifactStorageDeleter(null);
  });
});
