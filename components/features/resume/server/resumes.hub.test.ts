// @vitest-environment node
// WP-36b: resume hub routes (server/src/roboapply/v2/routes/resumes.ts) —
// auth, base-resume limit, primary, target title, layout, export guard (ruling
// C12), file record, AI marks per brand and AI provenance, upload residency,
// and the removed LinkedIn URL import. Prisma, storage and ingest are faked; no
// network beyond 127.0.0.1, no database.
//
// Lives in the WP's own folder (TASK_PLAN.md §2 ownership); INT may move it
// next to the route. The router is loaded by path so the web type-check does
// not pull the server's untyped modules (pdfkit) in.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const mocks = vi.hoisted(() => ({
  db: { variants: [] as Row[], trackers: [] as Row[], jobs: [] as Row[], artifacts: [] as Row[], labelLogs: [] as Row[] },
  userId: 'user1',
  brand: 'roboapply' as 'roboapply' | 'goapply',
  unverified: null as null | ((id: string) => Promise<number>),
  storage: null as any,
  ingest: vi.fn(),
  registerCompliance: vi.fn(),
  setPurge: vi.fn(),
  putObjects: 0,
}));

// ── tiny in-memory Prisma ─────────────────────────────────────────────────
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return (cond.in as unknown[]).includes(v);
      if ('not' in cond) return v !== cond.not;
      if ('lt' in cond) return v < cond.lt;
    }
    if (cond === null) return v === null || v === undefined;
    return v === cond;
  });
}
function table(rows: () => Row[], prefix: string) {
  return {
    findFirst: async ({ where }: Row = {}) => rows().find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: Row) => rows().find((r) => r.id === where.id) ?? null,
    findMany: async ({ where }: Row = {}) => rows().filter((r) => matches(r, where)),
    count: async ({ where }: Row = {}) => rows().filter((r) => matches(r, where)).length,
    create: async ({ data }: Row) => {
      const row = { id: `${prefix}${rows().length + 1}`, createdAt: new Date(), ...data };
      rows().push(row);
      return row;
    },
    update: async ({ where, data }: Row) => {
      const row = rows().find((r) => r.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = rows().filter((r) => matches(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    },
  };
}

vi.mock('../../../../server/src/lib/prisma.js', () => {
  const client: Row = {
    rAResumeVariant: table(() => mocks.db.variants, 'v'),
    rATrackerEntry: table(() => mocks.db.trackers, 't'),
    rAJob: table(() => mocks.db.jobs, 'j'),
    rAApplicationArtifact: table(() => mocks.db.artifacts, 'art'),
    rAAiContentLabelLog: table(() => mocks.db.labelLogs, 'log'),
  };
  client.$transaction = async (arg: any) => (typeof arg === 'function' ? arg(client) : Promise.all(arg));
  return { default: client };
});

vi.mock('../../../../server/src/roboapply/v2/lib/raAuth.js', () => ({
  // Signed out when the test sends `x-test-anon` (the real guard answers 401).
  requireAuth: (req: Row, res: { status(n: number): { json(b: unknown): void } }, next: () => void) => {
    if (req.headers['x-test-anon']) return res.status(401).json({ error: 'unauthorized' });
    req.user = { id: mocks.userId, subscriptionTier: 'free' };
    next();
  },
}));
vi.mock('../../../../server/src/roboapply/v2/lib/raLocale.js', () => ({ RA_DEFAULT_LOCALE: 'en', getRequestLocale: (req: Row) => req.headers['x-test-locale'] ?? 'en' }));
vi.mock('../../../../server/src/services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../../../server/src/lib/candidateResumeIngest.js', () => ({
  isAcceptedResumeUpload: () => true,
  readCandidateResumeOriginal: vi.fn(),
  ingestCandidateResume: (...args: unknown[]) => mocks.ingest(...args),
  CandidateResumeIngestError: class extends Error {},
}));
vi.mock('../../../../server/src/roboapply/v2/services/RAResumeAIService.js', () => ({
  raResumeAIService: {},
  applyTailorSelections: (md: string) => md,
  AiUnavailableError: class extends Error {},
  ResumeNotFoundError: class extends Error {},
  RewriteValidationError: class extends Error {},
}));
vi.mock('../../../../server/src/features/resume/index.js', async () => {
  const contract = await import('../../../../server/src/features/resume/contract.js');
  const { NotImplementedError } = await import('../../../../server/src/platform/http.js');
  return {
    ...contract,
    unverifiedClaimsCount: (id: string) => (mocks.unverified ? mocks.unverified(id) : Promise.reject(new NotImplementedError('resume.unverifiedClaimsCount'))),
    resumeAiAvailable: async () => false,
  };
});
vi.mock('../../../../server/src/features/compliance/index.js', async () => {
  const a = await import('../../../../server/src/features/compliance/aiLabel.js');
  return {
    ...a,
    complianceService: {
      implicitLabelMetadata: a.implicitLabelMetadata,
      explicitFooterLine: a.explicitFooterLine,
      logAiContentLabel: (i: any) => a.logAiContentLabel(i),
    },
    registerArtifactStorageDeleter: (fn: unknown) => mocks.registerCompliance(fn),
  };
});
vi.mock('../../../../server/src/roboapply/services/SeekerAccountPurgeService.js', () => ({ setArtifactStorageDeleter: (fn: unknown) => mocks.setPurge(fn) }));
vi.mock('../../../../server/src/services/ResumeOriginalFileStorageService.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../server/src/services/ResumeOriginalFileStorageService.js')>('../../../../server/src/services/ResumeOriginalFileStorageService.js');
  return {
    ...actual,
    resumeOriginalFileStorageService: new Proxy({}, { get: (_t, prop) => {
      const target = mocks.storage;
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    } }),
  };
});

import { runWithBrand } from '../../../../server/src/lib/requestContext.js';
import { ResumeOriginalFileStorageService } from '../../../../server/src/services/ResumeOriginalFileStorageService.js';

/** A storage service over a fake S3 that counts PutObject calls. */
function realStorage(env: Record<string, string | undefined>) {
  return new ResumeOriginalFileStorageService({
    env,
    createS3Client: () => ({
      send: (async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'PutObjectCommand') mocks.putObjects += 1;
        return {};
      }) as any,
    }),
  });
}
const INTL_S3 = { S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'i', S3_SECRET_ACCESS_KEY: 's', NODE_ENV: 'production' };

const ROUTER = '../../../../server/src/roboapply/v2/routes/resumes.js';

const MD = '# Ada Lovelace\n\nada@example.com\n\n## Experience\n\n**Acme** — Engineer · 2021-03 – Present\n- Built things\n';

function variant(extra: Row = {}): Row {
  const row = {
    id: `v${mocks.db.variants.length + 1}`,
    userId: 'user1',
    name: 'Main',
    kind: 'base',
    sourceKind: 'upload',
    resumeMarkdown: MD,
    resumeContentHash: 'h',
    isPrimary: false,
    deletedAt: null,
    targetJobId: null,
    basedOnVariantId: null,
    unverifiedClaims: 0,
    layout: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    lastEditedAt: new Date('2026-10-01T00:00:00Z'),
    ...extra,
  };
  mocks.db.variants.push(row);
  return row;
}

describe('resume hub routes (WP-36b)', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const express = (await import('express')).default;
    const router = ((await import(/* @vite-ignore */ ROUTER)) as { default: import('express').Router }).default;
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => runWithBrand(mocks.brand, next));
    app.use('/resumes', router);
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/resumes`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    mocks.db = { variants: [], trackers: [], jobs: [], artifacts: [], labelLogs: [] };
    mocks.userId = 'user1';
    mocks.brand = 'roboapply';
    mocks.unverified = null;
    mocks.putObjects = 0;
    mocks.storage = realStorage({ ...INTL_S3, ALLOWED_BRANDS: 'roboapply,goapply' });
    mocks.ingest.mockReset();
    delete process.env.CN_AI_EXPORT_EXPLICIT_LABEL;
  });

  const json = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  describe('deleters', () => {
    it('registers the artifact-file deleter with compliance retention and the account purge', async () => {
      await vi.waitFor(() => expect(mocks.registerCompliance).toHaveBeenCalledTimes(1));
      expect(mocks.setPurge).toHaveBeenCalledTimes(1);
      const deleter = mocks.registerCompliance.mock.calls[0]![0] as (row: Row) => Promise<boolean>;
      const deleteFile = vi.fn(async () => true);
      mocks.storage = { getProviderMode: () => 'local', deleteFile };
      await expect(deleter({ id: 'a', storageKey: 'roboapply-artifacts/u/x.pdf', userId: 'u' })).resolves.toBe(true);
      expect(deleteFile).toHaveBeenCalledWith({ provider: 'local', key: 'roboapply-artifacts/u/x.pdf', fileName: null, mimeType: null });
      const purge = mocks.setPurge.mock.calls[0]![0] as (key: string) => Promise<boolean>;
      mocks.storage = { getProviderMode: () => 's3', deleteFile };
      await purge('cn/roboapply-artifacts/u/x.pdf');
      expect(deleteFile).toHaveBeenLastCalledWith({ provider: 's3', key: 'cn/roboapply-artifacts/u/x.pdf', fileName: null, mimeType: null });
    });
  });

  describe('hub: base slots, target title, list fields', () => {
    it('refuses a sixth base resume with 409 resume_limit_reached; tailored versions do not count', async () => {
      for (let i = 0; i < 4; i += 1) variant();
      variant({ kind: 'tailored_for_jd', sourceKind: 'tailored' });
      variant({ kind: 'tailored_for_jd', sourceKind: 'tailored' });
      const ok = await json('', { method: 'POST', body: JSON.stringify({ kind: 'base', name: 'Fifth', resumeMarkdown: MD }) });
      expect(ok.status).toBe(201);
      const full = await json('', { method: 'POST', body: JSON.stringify({ kind: 'from_template', name: 'Sixth', templateKey: 'standard' }) });
      expect(full).toEqual({ status: 409, body: { error: 'resume_limit_reached', code: 'resume_limit_reached', details: { limit: 5 } } });
    });

    it('refuses an upload at the limit before parsing', async () => {
      for (let i = 0; i < 5; i += 1) variant();
      const fd = new FormData();
      fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'cv.pdf');
      const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
      expect(res.status).toBe(409);
      expect(mocks.ingest).not.toHaveBeenCalled();
    });

    it('saves and clears the target title; the list carries it with the base id of tailored versions', async () => {
      const v = variant();
      variant({ kind: 'tailored_for_jd', sourceKind: 'tailored', basedOnVariantId: v.id, unverifiedClaims: 2 });
      const set = await json(`/${v.id}`, { method: 'PATCH', body: JSON.stringify({ targetTitle: '  Product Manager  ' }) });
      expect(set.body.resume.targetTitle).toBe('Product Manager');
      const list = await json('');
      expect(list.body.resumes.find((r: Row) => r.id === v.id).targetTitle).toBe('Product Manager');
      const tailored = list.body.resumes.find((r: Row) => r.kind === 'tailored_for_jd');
      expect(tailored).toMatchObject({ basedOnVariantId: v.id, unverifiedClaims: 2 });
      const cleared = await json(`/${v.id}`, { method: 'PATCH', body: JSON.stringify({ targetTitle: '' }) });
      expect(cleared.body.resume.targetTitle).toBeNull();
    });
  });

  describe('auth', () => {
    const anon = { 'x-test-anon': '1' };

    it('PATCH /:id/layout answers 401 when signed out and changes nothing', async () => {
      const v = variant({ layout: { page: 'a4' } });
      const res = await json(`/${v.id}/layout`, { method: 'PATCH', headers: anon, body: JSON.stringify({ layout: { page: 'letter' } }) });
      expect(res.status).toBe(401);
      expect(mocks.db.variants[0]!.layout).toEqual({ page: 'a4' });
    });

    it('GET /:id/export answers 401 when signed out and records nothing', async () => {
      mocks.db.trackers.push({ id: 'tr1', userId: 'user1', jobId: null, deletedAt: null });
      const v = variant();
      const res = await fetch(`${base}/${v.id}/export?format=pdf&trackerEntryId=tr1`, { headers: anon });
      expect(res.status).toBe(401);
      expect(mocks.db.artifacts).toHaveLength(0);
      expect(mocks.putObjects).toBe(0);
    });
  });

  describe('primary (F-RES-02: one primary, always a base resume)', () => {
    it('deleting the primary promotes another base resume, never a newer tailored version', async () => {
      const primary = variant({ isPrimary: true, lastEditedAt: new Date('2026-10-03T00:00:00Z') });
      const other = variant({ lastEditedAt: new Date('2026-10-01T00:00:00Z') });
      const tailored = variant({ kind: 'tailored_for_jd', sourceKind: 'tailored', basedOnVariantId: primary.id, lastEditedAt: new Date('2026-10-09T00:00:00Z') });
      expect((await json(`/${primary.id}`, { method: 'DELETE' })).status).toBeLessThan(300);
      expect(mocks.db.variants.find((r) => r.id === other.id)!.isPrimary).toBe(true);
      expect(mocks.db.variants.find((r) => r.id === tailored.id)!.isPrimary).toBe(false);
    });

    it('with no base resume left, no tailored version becomes primary', async () => {
      const primary = variant({ kind: 'from_template', sourceKind: 'template', isPrimary: true });
      const tailored = variant({ kind: 'tailored_for_jd', sourceKind: 'tailored', basedOnVariantId: primary.id, lastEditedAt: new Date('2026-10-09T00:00:00Z') });
      expect((await json(`/${primary.id}`, { method: 'DELETE' })).status).toBeLessThan(300);
      expect(mocks.db.variants.find((r) => r.id === tailored.id)!.isPrimary).toBe(false);
    });

    it('refuses to make a tailored version primary (422) and keeps the current primary', async () => {
      const primary = variant({ isPrimary: true });
      const tailored = variant({ kind: 'tailored_for_jd', sourceKind: 'tailored', basedOnVariantId: primary.id });
      const res = await json(`/${tailored.id}/primary`, { method: 'POST' });
      expect(res.status).toBe(422);
      expect(res.body.error).toBe('not_base_resume');
      expect(mocks.db.variants.find((r) => r.id === primary.id)!.isPrimary).toBe(true);
      expect(mocks.db.variants.find((r) => r.id === tailored.id)!.isPrimary).toBe(false);
    });

    it('makes another base resume primary and demotes the old one', async () => {
      const primary = variant({ isPrimary: true });
      const other = variant({ kind: 'from_template', sourceKind: 'template' });
      const res = await json(`/${other.id}/primary`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(res.body.resume.isPrimary).toBe(true);
      expect(mocks.db.variants.find((r) => r.id === primary.id)!.isPrimary).toBe(false);
    });
  });

  describe('AI provenance (SR-36b-1)', () => {
    // SCHEMA-3 added RAResumeVariant.aiAssistedAt (SR-36b-1), so the adapter now stores it.
    it('SR-36b-1: PATCH { aiAssisted: true } stamps RAResumeVariant.aiAssistedAt once', async () => {
      const v = variant();
      const res = await json(`/${v.id}`, { method: 'PATCH', body: JSON.stringify({ resumeMarkdown: MD, aiAssisted: true }) });
      expect(res.status).toBe(200);
      const first = mocks.db.variants[0]!.aiAssistedAt;
      expect(first).toBeInstanceOf(Date);
      expect(res.body.resume.aiAssisted).toBe(true);
      const again = await json(`/${v.id}`, { method: 'PATCH', body: JSON.stringify({ resumeMarkdown: MD, aiAssisted: true }) });
      expect(again.status).toBe(200);
      expect(mocks.db.variants[0]!.aiAssistedAt).toBe(first);
    });

    it.todo('SR-36b-1: after an aiAssisted PATCH the export carries the AI marks (PDF Info / XMP / DOCX properties)');

    it.each(['roboapply', 'goapply'] as const)(
      '%s: a tailored copy made without AI is stored as a plain copy and exports with no AI marks and no label log',
      async (brand) => {
        mocks.brand = brand;
        process.env.CN_AI_EXPORT_EXPLICIT_LABEL = 'on';
        // The user's own import in the brand's market (readable in every GoApply recruitment-info mode).
        mocks.db.jobs.push({ id: 'job1', title: 'Engineer', companyName: 'Acme', market: brand === 'goapply' ? 'cn' : 'intl', visibility: 'private', ownerUserId: 'user1', sourceBoard: 'user_import', provider: 'user_import' });
        const baseRow = variant({ isPrimary: true });
        // resumeAiAvailable() is false in this suite (no AI consent), so the
        // tailor agent never runs and the copy is the base resume.
        const created = await json('', {
          method: 'POST',
          body: JSON.stringify({ kind: 'tailored_for_jd', name: 'For Acme', basedOnVariantId: baseRow.id, targetJobId: 'job1' }),
        });
        expect(created.status).toBe(201);
        expect(created.body.resume).toMatchObject({ kind: 'tailored_for_jd', sourceKind: 'tailored_copy', aiAssisted: false });

        const pdf = Buffer.from(await (await fetch(`${base}/${created.body.resume.id}/export?format=pdf`)).arrayBuffer()).toString('latin1');
        expect(pdf.startsWith('%PDF')).toBe(true);
        expect(pdf).not.toContain('/AIContentID');
        expect(pdf).not.toContain('trainedAlgorithmicMedia');
        const docx = await fetch(`${base}/${created.body.resume.id}/export?format=docx`);
        expect(docx.status).toBe(200);
        expect(Buffer.from(await docx.arrayBuffer()).toString('latin1')).not.toContain('AIContentID');
        expect(mocks.db.labelLogs).toHaveLength(0);
      },
    );

    it('a version the tailor agent wrote reports aiAssisted', async () => {
      const v = variant({ kind: 'tailored_for_jd', sourceKind: 'tailored' });
      expect((await json(`/${v.id}`)).body.resume.aiAssisted).toBe(true);
    });
  });

  describe('PATCH /:id/layout', () => {
    it('validates against the contract', async () => {
      const v = variant();
      const bad = await json(`/${v.id}/layout`, { method: 'PATCH', body: JSON.stringify({ layout: { template: 'fancy' } }) });
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe('validation_failed');
    });

    it('merges into the stored layout, drops legacy keys and saves layout.template', async () => {
      const v = variant({ layout: { templateKey: 'modern', page: 'a4', spacing: { section: 8 } } });
      const res = await json(`/${v.id}/layout`, {
        method: 'PATCH',
        body: JSON.stringify({ layout: { template: 'two_column', spacing: { line: 3 }, accent: '#4f3dca' } }),
      });
      expect(res.status).toBe(200);
      expect(mocks.db.variants[0]!.layout).toEqual({ template: 'two_column', page: 'a4', spacing: { section: 8, line: 3 }, accent: '#4f3dca' });
      expect(res.body.resume.layout.template).toBe('two_column');
      expect(res.body.resume.defaultPage).toBe('letter');
    });

    it('404s on another user’s resume', async () => {
      const v = variant({ userId: 'someone-else' });
      expect((await json(`/${v.id}/layout`, { method: 'PATCH', body: JSON.stringify({ layout: { page: 'a4' } }) })).status).toBe(404);
    });

    it('GET /:id reports the Letter/A4 default for the visitor', async () => {
      const v = variant();
      const res = await json(`/${v.id}`, { headers: { 'x-vercel-ip-country': 'TW' } });
      expect(res.body.resume.defaultPage).toBe('a4');
    });
  });

  describe('GET /:id/export', () => {
    const exportOf = (id: string, qs = 'format=pdf', headers: Record<string, string> = {}) => fetch(`${base}/${id}/export?${qs}`, { headers });

    it('refuses with the ruling-C12 code while the tailor session has unverified claims', async () => {
      const v = variant({ kind: 'tailored_for_jd', sourceKind: 'tailored' });
      mocks.unverified = async () => 2;
      const res = await exportOf(v.id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'unverified_claims', code: 'unverified_claims', details: { count: 2 } });
    });

    it('falls back to the variant column until the tailor seam is filled', async () => {
      const v = variant({ unverifiedClaims: 1 });
      expect((await exportOf(v.id)).status).toBe(409);
      const ok = variant({ unverifiedClaims: 0 });
      const res = await exportOf(ok.id);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
    });

    it('rejects an unknown format or name style', async () => {
      const v = variant();
      expect((await exportOf(v.id, 'format=odt')).status).toBe(422);
      expect((await exportOf(v.id, 'format=pdf&nameStyle=everything')).status).toBe(422);
    });

    it('names the file from a preset with data we hold', async () => {
      mocks.db.jobs.push({ id: 'job1', title: 'Engineer', companyName: 'Acme' });
      const v = variant({ kind: 'tailored_for_jd', sourceKind: 'tailored', targetJobId: 'job1' });
      const res = await exportOf(v.id, 'format=docx&nameStyle=name_company_role');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''Ada%20Lovelace%20-%20Acme%20-%20Engineer.docx");
    });

    it('records the exact file on an application: sha256 + storage key, X-Artifact-Id', async () => {
      mocks.db.trackers.push({ id: 'tr1', userId: 'user1', jobId: null, deletedAt: null, externalSnapshot: { title: 'Analyst', companyName: 'Globex' } });
      const v = variant();
      const res = await exportOf(v.id, 'format=pdf&trackerEntryId=tr1&nameStyle=company_role_name');
      expect(res.status).toBe(200);
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      expect(res.headers.get('x-content-sha256')).toBe(sha);
      const art = mocks.db.artifacts[0]!;
      expect(res.headers.get('x-artifact-id')).toBe(art.id);
      expect(art).toMatchObject({
        userId: 'user1',
        trackerEntryId: 'tr1',
        kind: 'resume',
        variantId: v.id,
        format: 'pdf',
        fileSha256: sha,
        channel: 'download',
        fileName: 'Globex - Analyst - Ada Lovelace.pdf',
      });
      expect(art.storageKey).toMatch(/^roboapply-artifacts\/user1\//);
      expect(mocks.putObjects).toBe(1);
    });

    it('404s on a tracker entry that is not the user’s and records nothing', async () => {
      mocks.db.trackers.push({ id: 'tr2', userId: 'other', jobId: null, deletedAt: null });
      const v = variant();
      expect((await exportOf(v.id, 'trackerEntryId=tr2')).status).toBe(404);
      expect(mocks.db.artifacts).toHaveLength(0);
    });

    it('a plain download stores nothing and records nothing', async () => {
      const v = variant();
      expect((await exportOf(v.id)).status).toBe(200);
      expect(mocks.db.artifacts).toHaveLength(0);
      expect(mocks.putObjects).toBe(0);
    });

    it('user-written resumes carry no AI marks', async () => {
      const v = variant();
      const pdf = Buffer.from(await (await exportOf(v.id)).arrayBuffer()).toString('latin1');
      expect(pdf).not.toContain('/AIContentID');
      expect(mocks.db.labelLogs).toHaveLength(0);
    });

    it('RoboApply: an AI-written resume carries the machine-readable marker and writes no label log', async () => {
      const v = variant({ kind: 'tailored_for_jd', sourceKind: 'tailored' });
      const pdf = Buffer.from(await (await exportOf(v.id)).arrayBuffer()).toString('latin1');
      expect(pdf).toContain('/AIContentID');
      expect(pdf).toMatch(/\(RA-[0-9a-f]{24}\)/);
      expect(pdf).toContain('trainedAlgorithmicMedia');
      expect(mocks.db.labelLogs).toHaveLength(0);
    });

    it('GoApply: implicit marks + RAAiContentLabelLog (implicit_only by default, explicit with the footer on)', async () => {
      mocks.brand = 'goapply';
      const v = variant({ kind: 'tailored_for_jd', sourceKind: 'tailored', resumeMarkdown: '# 王小明\n\n## 工作经历\n\n- 负责导出\n' });
      const pdf = Buffer.from(await (await exportOf(v.id, 'format=pdf', { 'x-test-locale': 'zh' })).arrayBuffer()).toString('latin1');
      expect(pdf).toContain('/AIContentID');
      expect(pdf).toMatch(/\(GA-[0-9a-f]{24}\)/);
      expect(pdf).toContain('NotoSansSC');
      expect(mocks.db.labelLogs).toEqual([
        expect.objectContaining({ brand: 'goapply', userId: 'user1', artifactType: 'resume', labelMode: 'implicit_only', artifactId: v.id }),
      ]);

      process.env.CN_AI_EXPORT_EXPLICIT_LABEL = 'on';
      const plain = Buffer.from(await (await exportOf(v.id, 'format=docx', { 'x-test-locale': 'zh' })).arrayBuffer());
      expect(plain.length).toBeGreaterThan(1000);
      expect(mocks.db.labelLogs[1]).toMatchObject({ labelMode: 'explicit' });
    });

    it('404s on a missing resume', async () => {
      expect((await exportOf('nope')).status).toBe(404);
    });

    it('404s on another user’s resume and records nothing, even with the user’s own tracker entry', async () => {
      mocks.db.trackers.push({ id: 'tr1', userId: 'user1', jobId: null, deletedAt: null });
      const theirs = variant({ userId: 'someone-else' });
      const res = await exportOf(theirs.id, 'format=pdf&trackerEntryId=tr1');
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).not.toBe('application/pdf');
      expect(mocks.db.artifacts).toHaveLength(0);
      expect(mocks.putObjects).toBe(0);
    });
  });

  describe('upload residency (WP-15 REQ-WP15-04)', () => {
    it('GoApply on cn-mainland without CN_S3_* → 503 storage_unavailable, file never read, zero PutObject calls', async () => {
      mocks.brand = 'goapply';
      mocks.storage = realStorage({ ...INTL_S3, DEPLOY_REGION: 'cn-mainland' });
      const fd = new FormData();
      fd.append('file', new Blob(['%PDF-1.4 resume'], { type: 'application/pdf' }), 'cv.pdf');
      const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'storage_unavailable', code: 'storage_unavailable' });
      expect(mocks.ingest).not.toHaveBeenCalled();
      expect(mocks.putObjects).toBe(0);

      const li = await fetch(`${base}/import-linkedin`, { method: 'POST', body: fd });
      expect(li.status).toBe(503);
    });

    it('RoboApply uploads still go through', async () => {
      mocks.ingest.mockResolvedValue({ markdown: MD, displayName: 'Ada', rawText: 'Ada', parsed: {}, summary: '', highlight: '', original: null });
      const fd = new FormData();
      fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'cv.pdf');
      const res = await fetch(`${base}/upload`, { method: 'POST', body: fd });
      expect(res.status).toBe(201);
      expect(mocks.ingest).toHaveBeenCalledTimes(1);
    });
  });

  describe('LinkedIn (TASK_PLAN.md H9)', () => {
    it('reports URL import as off and refuses mode url', async () => {
      expect((await json('/import-linkedin/config')).body).toEqual({ urlImportEnabled: false });
      const fd = new FormData();
      fd.append('mode', 'url');
      fd.append('linkedinUrl', 'https://www.linkedin.com/in/someone');
      const res = await fetch(`${base}/import-linkedin`, { method: 'POST', body: fd });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('url_import_removed');
    });

    it('imports the user’s own PDF export with page footers stripped', async () => {
      mocks.ingest.mockResolvedValue({ markdown: MD, displayName: 'Ada', rawText: 'Ada', parsed: {}, summary: '', highlight: '', original: null });
      const fd = new FormData();
      fd.append('file', new Blob(['%PDF-1.4'], { type: 'application/pdf' }), 'Profile.pdf');
      const res = await fetch(`${base}/import-linkedin`, { method: 'POST', body: fd });
      expect(res.status).toBe(201);
      const transform = mocks.ingest.mock.calls[0]![0].textTransform as (t: string) => string;
      expect(transform('Ada\nPage 1 of 3\n\n\n\nEngineer')).toBe('Ada\n\nEngineer');
    });
  });
});
