// @vitest-environment node
//
// Legal documents on disk, the export and purge workers, and compliance-daily.

import { describe, expect, it, vi } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { createBudget, type CronContext } from '../../platform/queue/index.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { LEGAL_DOC_FILES } from './contract.js';
import { createComplianceDaily, reconcilePiRequests, type ComplianceCronDb } from './cron.js';
import {
  buildUserDataExport,
  handleDataExport,
  readExportForOwner,
  registerExportSection,
  sweepExpiredExports,
  type ExportDb,
  type ExportStore,
} from './dataExport.js';
import { fillPlaceholders, loadLegalDoc, parseFrontMatter, readLegalSource } from './legalDocs.js';
import { createEmailTranslator, resetEmailI18nCache } from '../../platform/email/i18n.js';
import { getEmailTemplate } from '../../platform/email/templates/registry.js';
import { COMPLIANCE_EMAIL_KEYS, DATA_EXPORT_READY_TEMPLATE } from './emails.js';
import { defaultAccountCloser, handleAccountPurge, pendingPurgeNote } from './purge.js';
import { workers } from './workers.js';

const goapply = getBrand('goapply');
const roboapply = getBrand('roboapply');

/** Files WP-13 owns (referral-terms → WP-60, coaching → WP-72). */
const OWNED = {
  intl: ['terms', 'privacy', 'cookies', 'refunds', 'subscription-terms', 'ai-disclosure', 'tw-pdpa-notice'],
  cn: ['user-agreement', 'privacy', 'pi-collection-list', 'third-party-sharing', 'ai-content-labels', 'complaints'],
} as const;

describe('legal documents', () => {
  it('every owned skeleton exists, is marked draft and has a title', () => {
    for (const market of ['intl', 'cn'] as const) {
      for (const file of OWNED[market]) {
        const src = readLegalSource(market, file);
        expect(src, `${market}/${file}`).toBeTruthy();
        const { meta, body } = parseFrontMatter(src!);
        expect(meta.status).toBe('draft');
        expect(meta.title).toBeTruthy();
        expect(body).toMatch(/DRAFT/);
        expect(Object.values(LEGAL_DOC_FILES[market])).toContain(file);
      }
    }
  });

  it('every placeholder is filled; unset values say so instead of inventing', () => {
    for (const [brand, market] of [[roboapply, 'intl'], [goapply, 'cn']] as const) {
      for (const [doc, file] of Object.entries(LEGAL_DOC_FILES[market])) {
        if (!(OWNED[market] as readonly string[]).includes(file!)) continue;
        const out = loadLegalDoc(brand, doc, { env: { NODE_ENV: 'test' } });
        expect(out.markdown, `${market}/${doc}`).not.toMatch(/\{\{|%BRAND%/);
        expect(out.draft).toBe(true);
      }
    }
    expect(loadLegalDoc(goapply, 'privacy', { env: {} }).markdown).toContain('未披露');
    expect(loadLegalDoc(roboapply, 'privacy', { env: {} }).markdown).toContain('Not listed');
    expect(loadLegalDoc(roboapply, 'privacy', { env: { LEGAL_ENTITY_NAME: 'Example Ltd' } }).markdown).toContain('Example Ltd');
  });

  it('privacy notices publish the retention schedule and minimum age; CN-0 names the offshore region', () => {
    const intl = loadLegalDoc(roboapply, 'privacy', { env: {} }).markdown;
    expect(intl).toContain('| Assistant conversations | 12 months |');
    expect(intl).toContain('16 or older');
    expect(intl).toContain('connected-on date');
    const cn = loadLegalDoc(goapply, 'privacy', { env: { DEPLOY_REGION: '' } }).markdown;
    expect(cn).toContain('| 求职助手对话 | 12 个月 |');
    expect(cn).toContain('处理地区为美国');
    expect(cn).not.toContain('境内处理和存储');
    expect(loadLegalDoc(goapply, 'privacy', { env: { DEPLOY_REGION: 'cn-mainland' } }).markdown).toContain('境内处理和存储');
  });

  it('production GoApply serves documents only when CN_LEGAL_DOCS_VERSION is set and the file is approved', () => {
    expect(() => loadLegalDoc(goapply, 'privacy', { env: { NODE_ENV: 'production' } })).toThrow(expect.objectContaining({ code: 'not_found' }));
    // version set but the file is still a draft skeleton → still not served
    expect(() => loadLegalDoc(goapply, 'privacy', { env: { NODE_ENV: 'production', CN_LEGAL_DOCS_VERSION: '2026-11' } })).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    );
    // RoboApply production: served, marked draft
    expect(loadLegalDoc(roboapply, 'terms', { env: { NODE_ENV: 'production' } }).draft).toBe(true);
    // the intl version var never unlocks GoApply (no cross-brand fallback)
    expect(loadLegalDoc(roboapply, 'terms', { env: { LEGAL_DOCS_VERSION: 'v1' } }).version).toBe('v1');
    expect(loadLegalDoc(goapply, 'terms', { env: { LEGAL_DOCS_VERSION: 'v1' } }).version).toBeNull();
  });

  it('front matter and placeholder helpers', () => {
    expect(parseFrontMatter('---\ntitle: "X"\nstatus: approved\n---\n# Body')).toEqual({ meta: { title: 'X', status: 'approved' }, body: '# Body' });
    expect(parseFrontMatter('# No meta')).toEqual({ meta: {}, body: '# No meta' });
    expect(fillPlaceholders('{{a}} {{ b }} {{c}}', { a: '1', b: '2' })).toBe('1 2 {{c}}');
  });
});

// ── Data export ────────────────────────────────────────────────────────────

function memStore(): ExportStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async save({ userId, buffer }) {
      const key = `data-exports/${userId}/${files.size}`;
      files.set(key, buffer);
      return { provider: 'mem', key };
    },
    async read(ref) {
      return files.get(ref.key)!;
    },
    async remove(ref) {
      return files.delete(ref.key);
    },
  };
}

describe('data export worker', () => {
  const now = new Date('2026-10-10T08:00:00.000Z');

  it('builds the file without secrets, marks the request done and enqueues the email', async () => {
    const db = createFakePrisma({
      seed: {
        user: [{ id: 'u1', email: 'a@example.test', name: 'A', brand: 'roboapply', passwordHash: 'SECRET', createdAt: now }],
        rAPersonalInfoRequest: [{ id: 'r1', brand: 'roboapply', userId: 'u1', kind: 'copy', status: 'open', dueAt: now, createdAt: now, closedAt: null, detail: {} }],
      },
    });
    const store = memStore();
    const enqueue = vi.fn(async () => ({ id: 'e1', kind: 'email.send', status: 'queued' as const, dedupeKey: null, created: true }));
    await handleDataExport({ payload: { requestId: 'r1' } }, { db: db as unknown as ExportDb, store, now: () => now, enqueue });
    const req = db.$rows('rAPersonalInfoRequest')[0]!;
    expect(req).toMatchObject({ status: 'done', closedAt: now });
    expect((req.detail as { export: { expiresAt: string } }).export.expiresAt).toBe('2026-10-17T08:00:00.000Z');
    const text = [...store.files.values()][0]!.toString('utf8');
    expect(text).toContain('a@example.test');
    expect(text).not.toContain('SECRET');
    expect(enqueue).toHaveBeenCalledWith('email.send', { template: 'compliance.data_export_ready', userId: 'u1', params: { days: 7 } }, expect.objectContaining({ dedupeKey: 'compliance.export.email:r1' }));

    const file = await readExportForOwner('u1', 'r1', { db: db as unknown as ExportDb, store, now: () => now });
    expect(file.fileName).toBe('data-export-2026-10-10.json');
    await expect(readExportForOwner('u2', 'r1', { db: db as unknown as ExportDb, store })).rejects.toMatchObject({ code: 'not_found' });

    // the sweep deletes it after 7 days
    const later = () => new Date('2026-10-18T00:00:00.000Z');
    expect(await sweepExpiredExports({ db: db as unknown as ExportDb, store, now: later, brand: 'roboapply' })).toBe(1);
    expect(store.files.size).toBe(0);
    expect(await sweepExpiredExports({ db: db as unknown as ExportDb, store, now: later, brand: 'roboapply' })).toBe(0);
  });

  it('storage not configured → request stays open with a note, item dead', async () => {
    const db = createFakePrisma({
      seed: { rAPersonalInfoRequest: [{ id: 'r1', brand: 'roboapply', userId: 'u1', kind: 'copy', status: 'open', dueAt: now, createdAt: now, closedAt: null, detail: {} }] },
    });
    const store: ExportStore = { save: async () => null, read: async () => Buffer.from(''), remove: async () => true };
    await expect(handleDataExport({ payload: { requestId: 'r1' } }, { db: db as unknown as ExportDb, store, now: () => now, enqueue: vi.fn() })).rejects.toMatchObject({
      name: 'PermanentWorkError',
    });
    expect(db.$rows('rAPersonalInfoRequest')[0]).toMatchObject({ status: 'open', detail: { handlingNotes: [expect.objectContaining({ note: 'storage_unavailable' })] } });
  });

  it('a failing section is reported, not dropped silently; sections are extensible', async () => {
    registerExportSection('zz_test_section', async () => {
      throw new Error('table missing');
    });
    const out = await buildUserDataExport('u1', createFakePrisma() as unknown as ExportDb, now);
    expect(out.sectionsUnavailable).toContain('zz_test_section');
  });

  it('covers every user-created data set, without storage keys or session internals', async () => {
    const db = createFakePrisma({
      seed: {
        user: [{ id: 'u1', email: 'a@example.test', brand: 'roboapply' }],
        rACoverLetter: [{ id: 'cl1', userId: 'u1', title: 'Letter', bodyMarkdown: 'Dear team', creditLedgerId: 'L1' }],
        rASavedSearch: [{ id: 's1', userId: 'u1', name: 'Remote PM', query: { q: 'pm' } }],
        rAAnswerBankItem: [{ id: 'q1', userId: 'u1', questionKey: 'notice', questionText: 'Notice period?', answer: '2 weeks', source: 'user', locale: 'en' }],
        rAAgentQueueItem: [{ id: 'aq1', userId: 'u1', jobId: 'j1', state: 'picked', weekKey: '2026-W41', addedVia: 'feed' }],
        rAContact: [{ id: 'ct1', ownerUserId: 'u1', fullName: 'Pat Lee', title: 'Engineer', companyNameNormalized: 'acme', source: 'linkedin_csv' }],
        rAContactImport: [{ id: 'ci1', userId: 'u1', kind: 'linkedin_csv', fileName: 'Connections.csv', rowCount: 3, importedCount: 3 }],
        interviewSession: [{ id: 'is1', userId: 'u1', role: 'PM', transcriptText: 'Tell me about…', recordingKey: 'r2/secret-key', roomName: 'room-1', overall: 70 }],
      },
    });
    const out = await buildUserDataExport('u1', db as unknown as ExportDb, now);
    for (const name of ['coverLetters', 'savedSearches', 'answerBank', 'readyToApplyQueue', 'contacts', 'contactImports', 'practiceInterviews']) {
      expect(out[name], name).toHaveLength(1);
    }
    // (a section registered by the test above fails on purpose)
    expect(((out.sectionsUnavailable as string[] | undefined) ?? []).filter((n) => n !== 'zz_test_section')).toEqual([]);
    const text = JSON.stringify(out);
    expect(text).toContain('Dear team');
    expect(text).toContain('Pat Lee');
    expect(text).toContain('Tell me about');
    expect(text).not.toContain('r2/secret-key');
    expect(text).not.toContain('room-1');
  });

  it('registers both workers', () => {
    expect(workers.map((w) => w.kind).sort()).toEqual(['compliance.export', 'compliance.purge']);
  });
});

describe('account purge worker (withdrawn cross-border consent)', () => {
  const now = new Date('2026-10-10T08:00:00.000Z');
  const seed = () =>
    createFakePrisma({
      seed: { rAPersonalInfoRequest: [{ id: 'r1', brand: 'goapply', userId: 'u1', kind: 'withdraw_consent', status: 'in_progress', dueAt: now, createdAt: now, closedAt: null, detail: {} }] },
    });

  it('closes the account and, with the purge seam, deletes it and closes the request', async () => {
    const db = seed();
    const closer = { close: vi.fn(async () => {}), purgeNow: vi.fn(async () => true) };
    expect(await handleAccountPurge({ payload: { userId: 'u1', piRequestId: 'r1' } }, { db: db as never, closer, now: () => now })).toEqual({ purged: true });
    expect(closer.close).toHaveBeenCalledWith('u1');
    expect(db.$rows('rAPersonalInfoRequest')[0]).toMatchObject({ status: 'done', closedAt: now });
  });

  it('without the seam: closed now, request stays in progress with the expected sweep date and a manual-action note', async () => {
    const db = createFakePrisma({
      seed: {
        rAPersonalInfoRequest: [
          // Filed Monday 12 Oct: 15 working days → Monday 2 Nov.
          { id: 'r1', brand: 'goapply', userId: 'u1', kind: 'withdraw_consent', status: 'in_progress', dueAt: new Date('2026-11-02T08:00:00.000Z'), createdAt: now, closedAt: null, detail: {} },
        ],
      },
    });
    const closer = { close: vi.fn(async () => {}), purgeNow: vi.fn(async () => false) };
    expect(await handleAccountPurge({ payload: { userId: 'u1', piRequestId: 'r1' } }, { db: db as never, closer, now: () => now, env: {} })).toEqual({ purged: false });
    const row = db.$rows('rAPersonalInfoRequest')[0]! as { status: string; detail: { handlingNotes: Array<{ by: string; note: string }> } };
    expect(row.status).toBe('in_progress');
    expect(row.detail.handlingNotes).toEqual([
      expect.objectContaining({
        by: 'system',
        note: 'account closed; the account-purge sweep deletes it on or after 2026-11-09 (30 days after closing), which is after this request\'s due date 2026-11-02: delete the account by hand before 2026-11-02',
      }),
    ]);
    await expect(handleAccountPurge({ payload: {} }, { db: db as never, closer })).rejects.toMatchObject({ name: 'PermanentWorkError' });
  });

  it('the note follows ACCOUNT_PURGE_RETENTION_DAYS and only asks for manual action when the sweep is late', () => {
    const closed = new Date('2026-10-12T00:00:00.000Z');
    const due = new Date('2026-11-02T00:00:00.000Z');
    expect(pendingPurgeNote(closed, due, { ACCOUNT_PURGE_RETENTION_DAYS: '7' })).toBe(
      'account closed; the account-purge sweep deletes it on or after 2026-10-19 (7 days after closing)',
    );
    expect(pendingPurgeNote(closed, due, {})).toContain('delete the account by hand before 2026-11-02');
  });

  it('default closer: purges at once when WP-10 exports purgeAccountNow, reports false while it does not', async () => {
    const purgeAccountNow = vi.fn(async () => ({ blocked: false }));
    vi.doMock('../../roboapply/services/SeekerAccountPurgeService.js', () => ({ purgeAccountNow }));
    expect(await defaultAccountCloser.purgeNow('u1')).toBe(true);
    expect(purgeAccountNow).toHaveBeenCalledWith('u1');
    purgeAccountNow.mockResolvedValueOnce({ blocked: true });
    expect(await defaultAccountCloser.purgeNow('u1')).toBe(false);
    // Today's module: no such export (an ESM namespace yields undefined for it).
    vi.resetModules();
    vi.doMock('../../roboapply/services/SeekerAccountPurgeService.js', () => ({ purgeAccountNow: undefined, runAccountPurgeSweep: vi.fn() }));
    expect(await defaultAccountCloser.purgeNow('u1')).toBe(false);
    vi.doUnmock('../../roboapply/services/SeekerAccountPurgeService.js');
  });

  it('with the seam, the worker closes the request as done (end to end through the default closer)', async () => {
    vi.resetModules();
    vi.doMock('../../roboapply/services/SeekerAccountPurgeService.js', () => ({ purgeAccountNow: vi.fn(async () => true) }));
    const db = seed();
    const closer = { close: vi.fn(async () => {}), purgeNow: defaultAccountCloser.purgeNow };
    expect(await handleAccountPurge({ payload: { userId: 'u1', piRequestId: 'r1' } }, { db: db as never, closer, now: () => now })).toEqual({ purged: true });
    expect(db.$rows('rAPersonalInfoRequest')[0]).toMatchObject({ status: 'done', closedAt: now });
    vi.doUnmock('../../roboapply/services/SeekerAccountPurgeService.js');
  });
});

describe('export-ready email', () => {
  it('every key has an English string (no raw keys) and the email links to Settings → Privacy, never to the file', () => {
    resetEmailI18nCache();
    const template = getEmailTemplate(DATA_EXPORT_READY_TEMPLATE)!;
    for (const brand of [roboapply, goapply]) {
      const t = createEmailTranslator(brand, brand.defaultLocale);
      for (const key of COMPLIANCE_EMAIL_KEYS) expect(t(key, { days: 7 })).not.toContain('compliance.');
      const body = template.render({ brand, t, params: { days: 7 }, origin: 'https://example.test' });
      expect(body.subject).toContain(brand.name);
      expect(body.bodyText).toContain('7 days');
      expect(body.bodyText).toContain('https://example.test/settings#privacy');
      expect(body.bodyHtml.match(/href="[^"]*"/g)).toEqual(['href="https://example.test/settings#privacy"']);
    }
  });
});

describe('compliance-daily', () => {
  const now = new Date('2026-10-10T05:00:00.000Z');
  const ctx = (brand = goapply): CronContext => ({ name: 'compliance-daily', brand, budget: createBudget(240_000), now });

  it('idle run: no work, fast', async () => {
    const db = createFakePrisma();
    const task = createComplianceDaily({ db: db as unknown as ComplianceCronDb, sweepExports: async () => 0 });
    const t0 = Date.now();
    const res = await task(ctx());
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res).toMatchObject({ skipped: 'no_work', processed: 0, piRequests: { closed: 0, open: 0, overdue: 0 } });
  });

  it('closes requests whose account is gone and counts overdue ones (brand-scoped)', async () => {
    const db = createFakePrisma({
      seed: {
        rAPersonalInfoRequest: [
          { id: 'a', brand: 'goapply', userId: null, kind: 'withdraw_consent', status: 'in_progress', dueAt: new Date('2026-11-01'), closedAt: null },
          { id: 'b', brand: 'goapply', userId: 'u2', kind: 'access', status: 'open', dueAt: new Date('2026-10-01'), closedAt: null },
          { id: 'c', brand: 'roboapply', userId: null, kind: 'deletion', status: 'open', dueAt: new Date('2026-10-01'), closedAt: null },
        ],
      },
    });
    expect(await reconcilePiRequests(db as never, 'goapply', now)).toEqual({ closed: 1, open: 1, overdue: 1 });
    expect(db.$rows('rAPersonalInfoRequest').find((r) => r.id === 'a')).toMatchObject({ status: 'done', closedAt: now });
    expect(db.$rows('rAPersonalInfoRequest').find((r) => r.id === 'c')).toMatchObject({ status: 'open' });
  });
});
