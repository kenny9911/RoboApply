// @vitest-environment node
//
// WP-63a acceptance: the retention purge deletes recordings and transcripts
// (objects and rows) older than the window, on both brands, each from the
// bucket the brand uses (D5: the shared bucket for GoApply unless CN_S3_BUCKET
// gives it its own) — and leaves newer sessions, the scores and the other
// brand alone.
// Run: npx vitest run server/src/features/interview/retention.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;

const h = vi.hoisted(() => {
  const sessions = new Map<string, Row>();
  const written = new Map<string, Row>();
  const users: Record<string, string> = { uR: 'roboapply', uG: 'goapply' };
  const deleted: Array<{ key: string; bucket: string | undefined }> = [];
  const failKeys = new Set<string>();

  const isEmpty = (t: unknown) => Array.isArray(t) && t.length === 0;
  function liveWhere(r: Row, where: Row): boolean {
    if (where.user?.brand && users[r.userId] !== where.user.brand) return false;
    if (where.createdAt?.lt && !(r.createdAt < where.createdAt.lt)) return false;
    if (where.id?.gt && !(r.id > where.id.gt)) return false;
    if (where.OR) {
      const any = (where.OR as Row[]).some((c) => {
        const [k, v] = Object.entries(c)[0]!;
        if (k === 'NOT') return !isEmpty(r.transcript);
        return (v as Row).not === null ? r[k] != null : false;
      });
      if (!any) return false;
    }
    return true;
  }
  // Honours the select, so a missing field in the real query shows up here.
  const pick = (r: Row, select: Row) => Object.fromEntries(Object.keys(select).map((k) => [k, structuredClone(r[k] ?? null)]));
  const prisma = {
    interviewSession: {
      findMany: vi.fn(async ({ where, take, select }: { where: Row; take: number; select: Row }) =>
        [...sessions.values()]
          .filter((r) => liveWhere(r, where))
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, take)
          .map((r) => pick(r, select))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        Object.assign(sessions.get(where.id)!, data);
      }),
    },
    rAMockSession: {
      findMany: vi.fn(async ({ where, take, select }: { where: Row; take: number; select: Row }) =>
        [...written.values()]
          .filter((r) => users[r.userId] === where.user.brand && r.createdAt < where.createdAt.lt && !isEmpty(r.transcript))
          .filter((r) => !where.id?.gt || r.id > where.id.gt)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, take)
          .map((r) => pick(r, select))),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
        Object.assign(written.get(where.id)!, data);
      }),
    },
  };
  return { sessions, written, deleted, failKeys, prisma, users };
});

vi.mock('../../lib/prisma.js', () => ({ default: h.prisma }));
vi.mock('../../interview-engine/storage/r2Storage.js', async () => {
  const { getR2Creds } = await import('../../interview-engine/config.js');
  return {
    interviewR2Storage: {
      isConfigured: () => getR2Creds() !== null,
      deleteObject: async (key: string) => {
        if (h.failKeys.has(key)) return false;
        h.deleted.push({ key, bucket: getR2Creds()?.bucket });
        return true;
      },
      recordingKey: (id: string, ext = 'mp4') => `interviews/${id}/recording.${ext}`,
      transcriptJsonKey: (id: string) => `interviews/${id}/transcript.json`,
      transcriptTextKey: (id: string) => `interviews/${id}/transcript.txt`,
      reportKey: (id: string) => `interviews/${id}/report.json`,
    },
  };
});

import {
  afterSideOnly,
  defaultRetentionDeps,
  purgeInterviewArtifacts,
  redactQuotes,
  redactReportQuotes,
  retentionCutoff,
  sessionObjectKeys,
  RETENTION_BATCH_SIZE,
} from './retention.js';
import { runInterviewRetention } from './cron.js';
import { getBrand } from '../../platform/brand/registry.js';
import { createBudget, type Budget } from '../../platform/queue/index.js';

const NOW = new Date('2026-10-10T05:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function session(id: string, userId: string, ageDays: number, extra: Row = {}): Row {
  const row = {
    id, userId, createdAt: daysAgo(ageDays),
    recordingKey: `interviews/${id}/recording.mp4`, recordingMimeType: 'audio/mp4', recordingBytes: 10, recordingDurationSec: 60,
    egressId: `EG_${id}`, transcriptKey: `interviews/${id}/transcript.json`,
    transcript: [{ role: 'candidate', text: 'my answer', ts: 1 }], transcriptText: 'my answer',
    overall: 72, report: { version: '2' }, strengths: [], gaps: [], summary: null, breakdown: null,
    ...extra,
  };
  h.sessions.set(id, row);
  return row;
}

const ENV = {
  S3_BUCKET: 'intl-bucket', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b',
  CN_S3_BUCKET: 'cn-bucket', CN_S3_ACCESS_KEY_ID: 'c', CN_S3_SECRET_ACCESS_KEY: 'd',
};
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { ...process.env };
  Object.assign(process.env, ENV);
  delete process.env.INTERVIEW_RETENTION_DAYS;
  delete process.env.CN_INTERVIEW_RETENTION_DAYS;
  h.sessions.clear();
  h.written.clear();
  h.deleted.length = 0;
  h.failKeys.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('purgeInterviewArtifacts', () => {
  it('deletes objects and transcript rows older than 90 days, on both brands, from each brand’s bucket', async () => {
    session('a_old_intl', 'uR', 120);
    session('b_new_intl', 'uR', 30);
    session('c_old_cn', 'uG', 91);
    session('d_new_cn', 'uG', 89);

    const intl = await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW });
    const cn = await purgeInterviewArtifacts({ brand: 'goapply', now: NOW });
    expect(intl).toMatchObject({ sessions: 1, objectsPending: 0, retentionDays: 90 });
    expect(cn).toMatchObject({ sessions: 1, objectsPending: 0 });

    for (const id of ['a_old_intl', 'c_old_cn']) {
      expect(h.sessions.get(id)).toMatchObject({
        transcript: [], transcriptText: null, transcriptKey: null, recordingKey: null,
        recordingMimeType: null, recordingBytes: null, recordingDurationSec: null, egressId: null,
        overall: 72, report: { version: '2' },
      });
    }
    for (const id of ['b_new_intl', 'd_new_cn']) {
      expect(h.sessions.get(id)!.transcriptText).toBe('my answer');
      expect(h.sessions.get(id)!.recordingKey).not.toBeNull();
    }
    expect(h.deleted.filter((d) => d.key.startsWith('interviews/a_old_intl/')).every((d) => d.bucket === 'intl-bucket')).toBe(true);
    expect(h.deleted.filter((d) => d.key.startsWith('interviews/c_old_cn/')).every((d) => d.bucket === 'cn-bucket')).toBe(true);
    expect(h.deleted.map((d) => d.key).sort()).toEqual([
      'interviews/a_old_intl/recording.mp4', 'interviews/a_old_intl/report.json', 'interviews/a_old_intl/transcript.json', 'interviews/a_old_intl/transcript.txt',
      'interviews/c_old_cn/recording.mp4', 'interviews/c_old_cn/report.json', 'interviews/c_old_cn/transcript.json', 'interviews/c_old_cn/transcript.txt',
    ]);
  });

  it('only touches the brand it runs for', async () => {
    session('a_old_intl', 'uR', 200);
    await purgeInterviewArtifacts({ brand: 'goapply', now: NOW });
    expect(h.sessions.get('a_old_intl')!.transcriptText).toBe('my answer');
    expect(h.deleted).toEqual([]);
  });

  it('clears written-practice transcripts older than the window', async () => {
    h.written.set('t1', { id: 't1', userId: 'uG', createdAt: daysAgo(100), transcript: [{ who: 'you', text: 'x' }], strengths: [], gaps: [], note: null, breakdown: null });
    h.written.set('t2', { id: 't2', userId: 'uG', createdAt: daysAgo(10), transcript: [{ who: 'you', text: 'y' }], strengths: [], gaps: [], note: null, breakdown: null });
    const r = await purgeInterviewArtifacts({ brand: 'goapply', now: NOW });
    expect(r.writtenTranscripts).toBe(1);
    expect(h.written.get('t1')!.transcript).toEqual([]);
    expect(h.written.get('t2')!.transcript).toHaveLength(1);
  });

  it('keeps object keys for the next run when a delete fails, but clears the transcript text', async () => {
    session('a_old', 'uR', 100);
    h.failKeys.add('interviews/a_old/recording.mp4');
    const r = await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW });
    expect(r.objectsPending).toBe(1);
    expect(h.sessions.get('a_old')).toMatchObject({ transcriptText: null, transcript: [], recordingKey: 'interviews/a_old/recording.mp4' });
    h.failKeys.clear();
    await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW });
    expect(h.sessions.get('a_old')!.recordingKey).toBeNull();
  });

  it('GoApply with no bucket of its own purges from the shared bucket, by session id (G55)', async () => {
    delete process.env.CN_S3_BUCKET;
    session('c_old', 'uG', 100);
    session('a_old', 'uR', 100);
    const r = await purgeInterviewArtifacts({ brand: 'goapply', now: NOW });
    expect(r).toMatchObject({ sessions: 1, objectsPending: 0 });
    expect(h.sessions.get('c_old')).toMatchObject({ transcriptText: null, recordingKey: null, transcriptKey: null });
    // Only its own session's keys, in the shared bucket; RoboApply's session is untouched.
    expect(h.deleted.length).toBeGreaterThan(0);
    expect(h.deleted.every((d) => d.bucket === 'intl-bucket' && d.key.startsWith('interviews/c_old/'))).toBe(true);
    expect(h.sessions.get('a_old')!.recordingKey).toBe('interviews/a_old/recording.mp4');
  });

  it('without any usable bucket, never claims objects are gone', async () => {
    // A bucket of its own with a missing key is not configured (never the shared keys).
    delete process.env.CN_S3_SECRET_ACCESS_KEY;
    session('c_old', 'uG', 100);
    const r = await purgeInterviewArtifacts({ brand: 'goapply', now: NOW });
    expect(r).toMatchObject({ sessions: 1, objectsDeleted: 0, objectsPending: 1 });
    expect(h.sessions.get('c_old')).toMatchObject({ transcriptText: null, recordingKey: 'interviews/c_old/recording.mp4' });
    expect(h.deleted).toEqual([]);
    // The same for a deployment with no storage at all, on either brand.
    for (const k of Object.keys(ENV)) delete process.env[k];
    session('a_old', 'uR', 100);
    expect(await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW })).toMatchObject({ objectsDeleted: 0, objectsPending: 1 });
    expect(h.sessions.get('a_old')!.recordingKey).toBe('interviews/a_old/recording.mp4');
  });

  it('uses a shorter per-brand window when configured', async () => {
    process.env.CN_INTERVIEW_RETENTION_DAYS = '30';
    session('c_mid', 'uG', 45);
    session('a_mid', 'uR', 45);
    expect((await purgeInterviewArtifacts({ brand: 'goapply', now: NOW })).sessions).toBe(1);
    expect((await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW })).sessions).toBe(0);
  });

  it('pages through more than one batch and stops starting batches when the budget is spent', async () => {
    for (let i = 0; i < RETENTION_BATCH_SIZE + 5; i += 1) session(`s${String(i).padStart(3, '0')}`, 'uR', 100);
    expect((await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW })).sessions).toBe(RETENTION_BATCH_SIZE + 5);
    session('z_late', 'uR', 100);
    const spent = createBudget(1_000);
    const r = await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW, budget: spent });
    expect(r).toMatchObject({ stoppedBy: 'budget', sessions: 0 });
  });

  it('purges written practice first, so a backlog of undeletable recordings cannot starve it', async () => {
    for (let i = 0; i < RETENTION_BATCH_SIZE * 2; i += 1) {
      const id = `p${String(i).padStart(3, '0')}`;
      session(id, 'uR', 100);
      h.failKeys.add(`interviews/${id}/recording.mp4`);
    }
    h.written.set('w1', { id: 'w1', userId: 'uR', createdAt: daysAgo(100), transcript: [{ who: 'you', text: 'x' }], strengths: [], gaps: [], note: null, breakdown: null });
    // Room for two batches only: the written pass and one live batch.
    let checks = 0;
    const budget = { exhausted: () => (checks += 1) > 2 } as unknown as Budget;
    const r = await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW, budget });
    expect(r).toMatchObject({ stoppedBy: 'budget', writtenTranscripts: 1, sessions: RETENTION_BATCH_SIZE });
    expect(h.written.get('w1')!.transcript).toEqual([]);
  });
});

describe('helpers', () => {
  const storage = {
    isConfigured: () => true, deleteObject: async () => true,
    recordingKey: (id: string) => `rec/${id}`, transcriptJsonKey: (id: string) => `tj/${id}`, transcriptTextKey: (id: string) => `tt/${id}`,
    reportKey: (id: string) => `rp/${id}`,
  };
  it('lists only the objects a session can own', () => {
    expect(sessionObjectKeys({ id: 'x', recordingKey: null, transcriptKey: null, egressId: null }, storage)).toEqual([]);
    expect(sessionObjectKeys({ id: 'x', recordingKey: null, transcriptKey: null, egressId: 'EG' }, storage)).toEqual(['rec/x']);
    expect(sessionObjectKeys({ id: 'x', recordingKey: 'k', transcriptKey: 'tj/x', egressId: 'EG' }, storage)).toEqual(['k', 'tj/x', 'tt/x', 'rp/x']);
    expect(sessionObjectKeys({ id: 'x', recordingKey: null, transcriptKey: null, egressId: null, report: { version: '2' } }, storage)).toEqual(['rp/x']);
  });
  it('computes the cutoff in whole days', () => {
    expect(retentionCutoff(NOW, 90).toISOString()).toBe('2026-07-12T05:00:00.000Z');
  });
});

describe('runInterviewRetention (compliance-daily)', () => {
  const ctx = (brand: 'roboapply' | 'goapply') => ({ name: 'compliance-daily', brand: getBrand(brand), budget: createBudget(240_000), now: NOW });

  it('answers no_work quickly when nothing is older than the window', async () => {
    session('b_new', 'uR', 3);
    expect(await runInterviewRetention(ctx('roboapply'))).toEqual({ skipped: 'no_work', processed: 0, retentionDays: 90 });
  });

  it('runs for each brand and reports what it purged', async () => {
    session('a_old', 'uR', 95);
    session('c_old', 'uG', 95);
    expect(await runInterviewRetention(ctx('roboapply'))).toMatchObject({ processed: 1, sessions: 1, objectsDeleted: 4 });
    expect(await runInterviewRetention(ctx('goapply'))).toMatchObject({ processed: 1, sessions: 1, objectsDeleted: 4 });
  });
});

// ─── No quote of the candidate survives the purge ────────────────────────────

const QUOTE = 'I just kind of fixed the bug quickly';
const ZH_QUOTE = '我负责了整个项目';
const richReport = () => ({
  version: '2',
  overall: 70,
  summary: `You opened well, though "${QUOTE}" undersold the work.`,
  strengths: [`Clear ownership: “${ZH_QUOTE}”.`],
  gaps: [`Vague result — "${QUOTE}".`],
  breakdown: [{ key: 'specificity', value: 60, note: `Said "${QUOTE}" with no metric.` }],
  recommendations: [
    { title: 'Quantify results', priority: 'high', detail: `When you said "${QUOTE}", no number followed.`, example: `Before: "${QUOTE}" → After: I cut p95 latency 40% in two sprints.` },
    { title: 'Name the stakes', priority: 'low', detail: 'Say why it mattered.', example: `之前：「${ZH_QUOTE}」\n之后：我带领 4 人在 6 周内上线，转化率提升 12%。` },
  ],
  questionAnalysis: [
    { questionIndex: 0, question: 'Tell me about a bug.', keyQuote: QUOTE, answerSummary: `Described a fix ("${QUOTE}").`, analysis: 'ok', correction: `Avoid "${QUOTE}".`, suggestion: 's', modelAnswer: 'm', tips: [], rating: 'weak', score: 50, missed: false, blueprintIndex: 0, intent: 'i' },
  ],
  deterministicBaseline: { overall: 70, breakdown: [] },
  degraded: false,
});

describe('quote redaction', () => {
  it('empties quoted spans in every script, leaves apostrophes alone', () => {
    expect(redactQuotes(`He said "${QUOTE}" and “x” and 「${ZH_QUOTE}」 and «oui» — don't`)).toBe('He said "…" and “…” and 「…」 and «…» — don\'t');
  });

  it('keeps only the after side of a rewrite example', () => {
    expect(afterSideOnly(`Before: "${QUOTE}" → After: I cut latency 40%.`)).toBe('After: I cut latency 40%.');
    expect(afterSideOnly(`Before: ${QUOTE}\nAfter: I cut latency 40%.`)).toBe('After: I cut latency 40%.');
  });

  it('removes keyQuote and every quote of the candidate from a rich report', () => {
    const out = JSON.stringify(redactReportQuotes(richReport()));
    expect(out).not.toContain(QUOTE);
    expect(out).not.toContain(ZH_QUOTE);
    expect(out).not.toContain('keyQuote');
    const r = redactReportQuotes(richReport()) as ReturnType<typeof richReport>;
    expect(r.recommendations[0]!.example).toBe('After: I cut p95 latency 40% in two sprints.');
    expect(r.recommendations[1]!.example).toBe('之后：我带领 4 人在 6 周内上线，转化率提升 12%。');
    expect(r.overall).toBe(70);
    expect(r.questionAnalysis[0]!.modelAnswer).toBe('m');
  });

  it('purges quotes from the kept report and score columns of a live session', async () => {
    session('q_old', 'uR', 100, {
      report: richReport(),
      strengths: [`Owned it: "${QUOTE}"`],
      gaps: [`「${ZH_QUOTE}」 lacked a number`],
      summary: `You said "${QUOTE}".`,
      breakdown: [{ key: 'specificity', value: 60, note: `"${QUOTE}"` }],
    });
    await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW });
    const row = JSON.stringify(h.sessions.get('q_old'));
    expect(row).not.toContain(QUOTE);
    expect(row).not.toContain(ZH_QUOTE);
    expect(row).not.toContain('keyQuote');
    expect(h.sessions.get('q_old')).toMatchObject({ overall: 72, report: { version: '2', overall: 70 } });
  });

  it('purges quotes from a written practice’s kept score', async () => {
    h.written.set('w1', {
      id: 'w1', userId: 'uR', createdAt: daysAgo(100), transcript: [{ who: 'you', text: QUOTE }],
      strengths: [`"${QUOTE}"`], gaps: [], note: `You said “${QUOTE}”.`, breakdown: [{ key: 'clarity', value: 50, note: `"${QUOTE}"` }],
    });
    await purgeInterviewArtifacts({ brand: 'roboapply', now: NOW });
    const row = JSON.stringify(h.written.get('w1'));
    expect(row).not.toContain(QUOTE);
    expect(h.written.get('w1')!.transcript).toEqual([]);
  });
});

// ─── The real Prisma queries (defaultRetentionDeps) ─────────────────────────

describe('defaultRetentionDeps (Prisma queries)', () => {
  const cutoff = new Date('2026-07-12T05:00:00Z');

  it('live sessions: scoped to the brand’s users, older than the cutoff, paged by id, still holding something', async () => {
    await defaultRetentionDeps.findLiveSessions('goapply', cutoff, 'abc', 50);
    const arg = h.prisma.interviewSession.findMany.mock.calls[0]![0] as Row;
    expect(arg.where).toEqual({
      user: { brand: 'goapply' },
      createdAt: { lt: cutoff },
      id: { gt: 'abc' },
      OR: [
        { recordingKey: { not: null } },
        { transcriptKey: { not: null } },
        { transcriptText: { not: null } },
        { egressId: { not: null } },
        { NOT: { transcript: { equals: [] } } },
      ],
    });
    expect(arg.orderBy).toEqual({ id: 'asc' });
    expect(arg.take).toBe(50);
    expect(Object.keys(arg.select).sort()).toEqual(
      ['breakdown', 'egressId', 'gaps', 'id', 'recordingKey', 'report', 'strengths', 'summary', 'transcriptKey'],
    );
    await defaultRetentionDeps.findLiveSessions('roboapply', cutoff, null, 50);
    const first = h.prisma.interviewSession.findMany.mock.calls[1]![0] as Row;
    expect(first.where.user).toEqual({ brand: 'roboapply' });
    expect(first.where).not.toHaveProperty('id');
  });

  it('live sessions: clears the transcript, writes the redacted score, and the pointers only when objects are gone', async () => {
    session('p1', 'uR', 100);
    const redacted = { strengths: ['s'], gaps: ['g'], breakdown: [{ key: 'k', value: 1, note: 'n' }], report: { version: '2' }, summary: 'x' };
    await defaultRetentionDeps.clearLiveSession('p1', false, redacted);
    expect(h.prisma.interviewSession.update).toHaveBeenLastCalledWith({
      where: { id: 'p1' },
      data: { transcript: [], transcriptText: null, strengths: ['s'], gaps: ['g'], summary: 'x', breakdown: redacted.breakdown, report: { version: '2' } },
    });
    await defaultRetentionDeps.clearLiveSession('p1', true, { ...redacted, breakdown: null, report: null });
    expect(h.prisma.interviewSession.update).toHaveBeenLastCalledWith({
      where: { id: 'p1' },
      data: {
        transcript: [], transcriptText: null, strengths: ['s'], gaps: ['g'], summary: 'x',
        transcriptKey: null, recordingKey: null, recordingMimeType: null, recordingBytes: null, recordingDurationSec: null, egressId: null,
      },
    });
  });

  it('written practice: scoped to the brand’s users, older than the cutoff, paged, non-empty transcript', async () => {
    await defaultRetentionDeps.findWrittenSessions('roboapply', cutoff, 'w0', 50);
    const arg = h.prisma.rAMockSession.findMany.mock.calls[0]![0] as Row;
    expect(arg.where).toEqual({
      user: { brand: 'roboapply' },
      createdAt: { lt: cutoff },
      id: { gt: 'w0' },
      NOT: { transcript: { equals: [] } },
    });
    expect(arg).toMatchObject({ orderBy: { id: 'asc' }, take: 50 });
    expect(Object.keys(arg.select).sort()).toEqual(['breakdown', 'gaps', 'id', 'note', 'strengths']);
    h.written.set('w9', { id: 'w9', userId: 'uR', transcript: [1] });
    await defaultRetentionDeps.clearWrittenSession('w9', { strengths: [], gaps: ['g'], note: null, breakdown: null });
    expect(h.prisma.rAMockSession.update).toHaveBeenLastCalledWith({
      where: { id: 'w9' },
      data: { transcript: [], strengths: [], gaps: ['g'], note: null },
    });
  });
});
