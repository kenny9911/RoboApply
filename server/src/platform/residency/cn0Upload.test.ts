// @vitest-environment node
//
// GoApply resume uploads through the real candidate ingest seam
// (server/src/lib/candidateResumeIngest.ts) with the real GoHire parse and
// storage services; only the network and the local parse/summary helpers are
// faked. (The file keeps its name from the CN-0 rule it first tested.)
//
// D5 (GOAPPLY_PARITY_PLAN.md §3.6), the default: a GoApply upload keeps the
// original on the shared store under goapply/, stores the text as parsed,
// keeps images, tries GoHire first and reads the file with the local pipeline
// when GoHire is not configured or cannot read it, exactly as RoboApply does.
//
// The former CN-0 rule is the opt-in CN_STORAGE_MODE=discard (no original, no
// photo, redacted text); CN_STORAGE_MODE=redact redacts the text only.
// REQ-WP15-03 (INT-10) still holds for both: the ingest runs
// applyResumeUploadPolicy after parse and summary on every path (GoHire, the
// local PDF fallback after a GoHire 500, Word/text files and the LinkedIn text
// path).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/PDFService.js', () => ({ pdfService: { extractText: vi.fn(async () => '') } }));
vi.mock('../../services/DocumentParsingService.js', () => ({
  documentParsingService: { extractText: vi.fn(async () => '') },
  DocumentParsingService: { isAcceptedUpload: () => true },
}));
vi.mock('../../agents/ResumeParseAgent.js', () => ({ resumeParseAgent: { parse: vi.fn() } }));
vi.mock('../../services/ResumeSummaryService.js', () => ({
  generateResumeSummaryHighlight: vi.fn(async () => ({ summary: '后端工程师', highlight: '支付系统' })),
}));
vi.mock('../../services/ResumeParserService.js', () => ({ normalizeExtractedText: (s: string) => s }));

import { runWithBrand } from '../../lib/requestContext.js';
import { setUserBrandLookup } from '../brand/userBrand.js';
import { ingestCandidateResume } from '../../lib/candidateResumeIngest.js';
import { pdfService } from '../../services/PDFService.js';
import { documentParsingService } from '../../services/DocumentParsingService.js';
import { resumeParseAgent } from '../../agents/ResumeParseAgent.js';
import {
  ResumeOriginalFileStorageService,
  resumeOriginalFileStorageService,
  type S3ClientLike,
} from '../../services/ResumeOriginalFileStorageService.js';
import type { ParsedResume } from '../../types/index.js';

const PRC_ID = '11010519491231002X';

const PAYLOAD = {
  success: true,
  data: {
    rawText: `张三\n身份证号：${PRC_ID}\n电话：138 0013 8000\n健康状况：良好\n2019-2023 某公司 后端工程师，负责支付系统与推荐系统的设计与实现。`,
    name: '张三',
    phone: '138 0013 8000',
    photo: 'data:image/jpeg;base64,AAAA',
    experience: [{ company: '某公司', role: '后端工程师', description: '负责支付系统' }],
    education: [{ school: '某大学', degree: '本科' }],
    otherPersonalInformation: { 身份证号: PRC_ID, 健康状况: '良好' },
  },
};

const LOCAL_TEXT = `张三\n身份证号：${PRC_ID}\n健康状况：良好\n2019-2023 某公司 后端工程师，负责支付系统与推荐系统的设计与实现。`;
const LOCAL_PARSED = {
  name: '张三',
  email: '',
  phone: '',
  summary: '',
  skills: [],
  experience: [{ company: '某公司', role: '后端工程师', description: '负责支付系统' }],
  education: [],
  certifications: [],
  languages: [],
  projects: [],
  rawText: LOCAL_TEXT,
} as unknown as ParsedResume;

/** A valid 1×1 PNG (so the image → PDF wrapper has something real to embed). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Nothing the ingest hands back for storage carries the ID number, the health detail or a photo. */
function expectNothingSensitive(result: { rawText: string; markdown: string; parsed: unknown; summary: string; highlight: string }): void {
  const stored = JSON.stringify([result.rawText, result.markdown, result.parsed, result.summary, result.highlight]);
  expect(stored).not.toContain(PRC_ID);
  expect(stored).not.toContain('良好');
  expect(stored).not.toContain('data:image');
}

const SHARED_BUCKET = {
  NODE_ENV: 'production',
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'intl-bucket',
  S3_ACCESS_KEY_ID: 'intl-id',
  S3_SECRET_ACCESS_KEY: 'intl-secret',
};
const CN_BUCKET = {
  CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
  CN_S3_BUCKET: 'cn-bucket',
  CN_S3_ACCESS_KEY_ID: 'cn-id',
  CN_S3_SECRET_ACCESS_KEY: 'cn-secret',
};

/**
 * Route the ingest's storage calls through a real storage service whose S3
 * client is a fake that records every command (production env; by default
 * only the shared bucket is configured, the D5 fallback), so nothing touches
 * disk or the network. The storage switches a test set in process.env
 * (CN_STORAGE_MODE, CN_RESIDENCY_STRICT) are passed on, so the store and the
 * ingest see the same deployment.
 */
function fakeBucketCalls(extra: Record<string, string> = {}): Array<{ command: string; bucket: unknown; key: string }> {
  const sent: Array<{ command: string; bucket: unknown; key: string }> = [];
  const backing = new ResumeOriginalFileStorageService({
    env: {
      ...SHARED_BUCKET,
      ...(process.env.CN_STORAGE_MODE ? { CN_STORAGE_MODE: process.env.CN_STORAGE_MODE } : {}),
      ...(process.env.CN_RESIDENCY_STRICT ? { CN_RESIDENCY_STRICT: process.env.CN_RESIDENCY_STRICT } : {}),
      ...extra,
    },
    createS3Client: () =>
      ({
        send: (async (command: { constructor: { name: string }; input: { Bucket?: unknown; Key?: string } }) => {
          sent.push({ command: command.constructor.name, bucket: command.input.Bucket, key: String(command.input.Key ?? '') });
          return {};
        }) as unknown as S3ClientLike['send'],
      }) as S3ClientLike,
  });
  vi.spyOn(resumeOriginalFileStorageService, 'isConfigured').mockImplementation((brand) => backing.isConfigured(brand));
  vi.spyOn(resumeOriginalFileStorageService, 'saveFile').mockImplementation((params) => backing.saveFile(params));
  return sent;
}

const saved: Record<string, string | undefined> = {};
const KEYS = [
  'GOHIRE_API_KEY',
  'GOHIRE_PARSE_BRANDS',
  'GOHIRE_API_BASE',
  'GOHIRE_PARSE_ENABLED',
  'DEPLOY_REGION',
  'CN_STORAGE_MODE',
  'CN_RESIDENCY_STRICT',
  'ALLOWED_BRANDS',
  'BRAND_LOCK',
];

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GOHIRE_API_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })));
  // No owner is known unless a test says so (never the database).
  setUserBrandLookup(async () => null);
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(pdfService.extractText).mockReset().mockResolvedValue('');
  vi.mocked(documentParsingService.extractText).mockReset().mockResolvedValue('');
  vi.mocked(resumeParseAgent.parse).mockReset();
  setUserBrandLookup(null);
});

const PDF_UPLOAD = { buffer: Buffer.from('%PDF-1.4 scanned resume'), fileName: 'resume.pdf', mimeType: 'application/pdf', userId: 'user_cn' };
const DOCX_UPLOAD = {
  buffer: Buffer.from('PK docx bytes'),
  fileName: 'resume.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  userId: 'user_cn',
};
const PNG_UPLOAD = { buffer: PNG_1X1, fileName: 'resume.png', mimeType: 'image/png', userId: 'user_cn' };

function localParseOnce(extract: 'pdf' | 'doc' = 'pdf'): void {
  if (extract === 'pdf') vi.mocked(pdfService.extractText).mockResolvedValueOnce(LOCAL_TEXT);
  else vi.mocked(documentParsingService.extractText).mockResolvedValueOnce(LOCAL_TEXT);
  vi.mocked(resumeParseAgent.parse).mockResolvedValueOnce(LOCAL_PARSED);
}

describe('GoApply upload, the default (D5): the same as RoboApply, on the shared store', () => {
  it('a PDF with only S3_* set: the original is stored once under goapply/, the text is stored as parsed', async () => {
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PDF_UPLOAD));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'PutObjectCommand', bucket: 'intl-bucket' });
    expect(sent[0]!.key.startsWith('goapply/roboapply-resumes/user_cn/')).toBe(true);
    expect(result.original).toMatchObject({ provider: 's3', key: sent[0]!.key, fileName: 'resume.pdf' });
    // Stored verbatim: the ID number and the health line are the user's own text.
    expect(result.rawText).toContain(PRC_ID);
    expect(result.rawText).toContain('良好');
    expect(result.markdown).toContain('负责支付系统');
  });

  it('a Word file: read locally (the parse service takes PDFs only), original kept under goapply/', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    localParseOnce('doc');
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(DOCX_UPLOAD));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.rawText).toContain(PRC_ID);
    expect(sent.map((x) => x.key.startsWith('goapply/'))).toEqual([true]);
    expect(result.original?.key).toBe(sent[0]!.key);
  });

  it('with its own bucket (CN_S3_*) the original goes there under cn/, never to the shared bucket', async () => {
    const sent = fakeBucketCalls(CN_BUCKET);
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PDF_UPLOAD));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'PutObjectCommand', bucket: 'cn-bucket' });
    expect(result.original?.key.startsWith('cn/roboapply-resumes/user_cn/')).toBe(true);
  });

  it('no GOHIRE_API_KEY: a scanned PDF is read by the local pipeline (the shared models), not refused', async () => {
    delete process.env.GOHIRE_API_KEY;
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    localParseOnce();
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PDF_UPLOAD));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pdfService.extractText).toHaveBeenCalledTimes(1);
    expect(resumeParseAgent.parse).toHaveBeenCalledTimes(1);
    expect(result.rawText).toContain('后端工程师');
    expect(sent).toHaveLength(1);
  });

  it('GoHire 500: falls back to the local parser and still keeps the original', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 500 })));
    localParseOnce();
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PDF_UPLOAD));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.markdown).toContain('负责支付系统');
    expect(sent).toHaveLength(1);
    expect(result.original?.key.startsWith('goapply/')).toBe(true);
  });

  it('forceLocalParser is ignored on GoApply: GoHire stays its preferred parser when it is configured', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fakeBucketCalls();
    await runWithBrand('goapply', () => ingestCandidateResume({ ...PDF_UPLOAD, forceLocalParser: true }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(pdfService.extractText).not.toHaveBeenCalled();
    expect(resumeParseAgent.parse).not.toHaveBeenCalled();
  });

  it("a worker with no brand context files the upload under the owner's brand (production serves both brands)", async () => {
    setUserBrandLookup(async (id) => ({ user_cn: 'goapply', user_intl: 'roboapply' })[id] ?? null);
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const sent = fakeBucketCalls();
    // GoApply owner: GoHire first, original under goapply/.
    const go = await ingestCandidateResume(PDF_UPLOAD);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(go.original?.key.startsWith('goapply/roboapply-resumes/user_cn/')).toBe(true);
    // RoboApply owner: never GoHire, original under RoboApply's unchanged keys.
    localParseOnce();
    const robo = await ingestCandidateResume({ ...PDF_UPLOAD, userId: 'user_intl' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(robo.original?.key.startsWith('roboapply-resumes/user_intl/')).toBe(true);
    expect(sent.map((x) => x.bucket)).toEqual(['intl-bucket', 'intl-bucket']);
  });

  it('with neither a context nor a known owner nothing leaves the server and nothing is stored', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    localParseOnce();
    const sent = fakeBucketCalls();
    const result = await ingestCandidateResume({ ...PDF_UPLOAD, userId: 'nobody' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe('CN_STORAGE_MODE=redact (opt-in): the text is redacted, the original is still kept', () => {
  beforeEach(() => {
    process.env.CN_STORAGE_MODE = 'redact';
  });

  it('the stored text carries the marker instead of the ID number; the file is stored under goapply/', async () => {
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PDF_UPLOAD));
    const stored = JSON.stringify([result.rawText, result.markdown, result.parsed, result.summary, result.highlight]);
    expect(stored).not.toContain(PRC_ID);
    expect(stored).not.toContain('良好');
    expect(result.rawText).toContain('[已移除证件号]');
    expect(sent).toHaveLength(1);
    expect(result.original?.key.startsWith('goapply/')).toBe(true);
  });

  it('a locally parsed Word file is redacted too', async () => {
    localParseOnce('doc');
    fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(DOCX_UPLOAD));
    expect(JSON.stringify([result.rawText, result.markdown, result.parsed])).not.toContain(PRC_ID);
    expect(result.rawText).toContain('后端工程师');
  });
});

describe('CN_STORAGE_MODE=discard (opt-in, the former CN-0 rule)', () => {
  beforeEach(() => {
    process.env.CN_STORAGE_MODE = 'discard';
  });

  it('keeps no original file and no photo, and hands storage no PRC ID or health detail', async () => {
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PDF_UPLOAD));
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
    expectNothingSensitive(result);
    expect(result.markdown).toContain('负责支付系统');
  });

  it('REQ-WP15-03: GoHire 500 → local parse of a PDF: stored text has no PRC ID or health detail, no original', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 500 })));
    localParseOnce();
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PDF_UPLOAD));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expectNothingSensitive(result);
    expect(result.markdown).toContain('负责支付系统');
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('REQ-WP15-03: a .docx upload (local parse only): stored text has no PRC ID or health detail', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    localParseOnce('doc');
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(DOCX_UPLOAD));
    // The parse service takes PDFs only: a Word file never leaves this server.
    expect(fetchSpy).not.toHaveBeenCalled();
    expectNothingSensitive(result);
    expect(result.rawText).toContain('后端工程师');
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('REQ-WP15-03: LinkedIn text import (textTransform path): stored text has no PRC ID', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    vi.mocked(pdfService.extractText).mockResolvedValueOnce(`${LOCAL_TEXT}\nPage 1 of 2`);
    vi.mocked(resumeParseAgent.parse).mockResolvedValueOnce(LOCAL_PARSED);
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () =>
      ingestCandidateResume({
        buffer: Buffer.from('%PDF-1.4'),
        fileName: 'linkedin.pdf',
        mimeType: 'application/pdf',
        userId: 'user_cn',
        textTransform: (raw) => raw.replace(/\nPage \d+ of \d+/g, ''),
      }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expectNothingSensitive(result);
    expect(result.rawText).not.toContain('Page 1 of 2');
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('a GoApply image goes to GoHire as a one-page PDF and comes back redacted; the image is not kept', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PNG_UPLOAD));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expectNothingSensitive(result);
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe('CN_RESIDENCY_STRICT=true without a mainland bucket: the file is read, nothing is written to the shared bucket', () => {
  it('the ingest keeps no original (the upload route refuses the request before this, 503 storage_unavailable)', async () => {
    process.env.CN_RESIDENCY_STRICT = 'true';
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PDF_UPLOAD));
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
  });
});

describe('GoApply image uploads (default): GoHire first, the local pipeline as the fallback', () => {
  it('go to GoHire as a one-page PDF; the image is kept on the shared store', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PNG_UPLOAD));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = (fetchSpy.mock.calls[0]![1] as { body: FormData }).body;
    const file = body.get('file') as File;
    expect(file.name).toBe('resume.pdf');
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdfService.extractText).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).not.toHaveBeenCalled();
    expect(result.rawText).toContain('后端工程师');
    // The uploaded image itself is the original that is kept.
    expect(sent).toHaveLength(1);
    expect(result.original).toMatchObject({ fileName: 'resume.png', mimeType: 'image/png' });
    expect(result.original?.key.startsWith('goapply/')).toBe(true);
  });

  it.each([
    ['GoHire is down', () => void vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 500 }))), 1],
    ['GoHire parsing is switched off', () => void (process.env.GOHIRE_PARSE_ENABLED = 'false'), 0],
    ['there is no GOHIRE_API_KEY', () => void delete process.env.GOHIRE_API_KEY, 0],
  ])('when %s the image is read by the local pipeline, as on RoboApply', async (_label, arrange, gohireCalls) => {
    arrange();
    localParseOnce('doc');
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () => ingestCandidateResume(PNG_UPLOAD));
    expect(globalThis.fetch).toHaveBeenCalledTimes(gohireCalls);
    expect(documentParsingService.extractText).toHaveBeenCalledTimes(1);
    expect(resumeParseAgent.parse).toHaveBeenCalledTimes(1);
    expect(result.rawText).toContain('后端工程师');
    expect(sent).toHaveLength(1);
  });

  it('a format GoHire cannot take (WebP) is read locally too, without a call to GoHire', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    localParseOnce('doc');
    fakeBucketCalls();
    const result = await runWithBrand('goapply', () =>
      ingestCandidateResume({ buffer: Buffer.from('RIFF....WEBP'), fileName: 'resume.webp', mimeType: 'image/webp', userId: 'user_cn', forceLocalParser: true }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).toHaveBeenCalledTimes(1);
    expect(result.rawText).toContain('后端工程师');
  });

  it('an image nothing can read still fails the upload honestly (empty_text), never a made-up parse', async () => {
    delete process.env.GOHIRE_API_KEY;
    fakeBucketCalls();
    await expect(runWithBrand('goapply', () => ingestCandidateResume(PNG_UPLOAD))).rejects.toMatchObject({
      name: 'CandidateResumeIngestError',
      code: 'empty_text',
    });
    expect(resumeParseAgent.parse).not.toHaveBeenCalled();
  });
});

describe('RoboApply in the same deployment', () => {
  it('never calls GoHire, parses locally and stores the original once in the shared bucket (no cn/ or goapply/ prefix)', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    localParseOnce();
    const sent = fakeBucketCalls(CN_BUCKET);

    const result = await runWithBrand('roboapply', () =>
      ingestCandidateResume({ buffer: Buffer.from('%PDF-1.4'), fileName: 'resume.pdf', mimeType: 'application/pdf', userId: 'user_intl' }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'PutObjectCommand', bucket: 'intl-bucket' });
    expect(sent[0]!.key.startsWith('cn/')).toBe(false);
    expect(sent[0]!.key.startsWith('goapply/')).toBe(false);
    expect(result.original?.key).toBe(sent[0]!.key);
    expect(result.original?.key.startsWith('roboapply-resumes/user_intl/')).toBe(true);
    // RoboApply text is stored as parsed, whatever GoApply's storage mode is.
    expect(result.rawText).toContain(PRC_ID);
  });

  it('is untouched by GoApply switches: CN_STORAGE_MODE=discard and CN_RESIDENCY_STRICT change nothing for it', async () => {
    process.env.CN_STORAGE_MODE = 'discard';
    process.env.CN_RESIDENCY_STRICT = 'true';
    localParseOnce();
    const sent = fakeBucketCalls();
    const result = await runWithBrand('roboapply', () =>
      ingestCandidateResume({ buffer: Buffer.from('%PDF-1.4'), fileName: 'resume.pdf', mimeType: 'application/pdf', userId: 'user_intl' }),
    );
    expect(sent).toHaveLength(1);
    expect(result.rawText).toContain(PRC_ID);
  });

  it('reads an image with the local pipeline as before (no GoHire, original kept)', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    localParseOnce('doc');
    const sent = fakeBucketCalls();
    const result = await runWithBrand('roboapply', () =>
      ingestCandidateResume({ buffer: PNG_1X1, fileName: 'resume.png', mimeType: 'image/png', userId: 'user_intl' }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(result.rawText).toContain(PRC_ID);
  });

  it('with GoHire opted in for RoboApply, forceLocalParser keeps the PDF on this server', async () => {
    process.env.GOHIRE_PARSE_BRANDS = 'goapply,roboapply';
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    localParseOnce();
    fakeBucketCalls();
    await runWithBrand('roboapply', () =>
      ingestCandidateResume({ buffer: Buffer.from('%PDF-1.4'), fileName: 'resume.pdf', mimeType: 'application/pdf', userId: 'user_intl', forceLocalParser: true }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.mocked(pdfService.extractText).mockClear();
    await runWithBrand('roboapply', () =>
      ingestCandidateResume({ buffer: Buffer.from('%PDF-1.4'), fileName: 'resume.pdf', mimeType: 'application/pdf', userId: 'user_intl' }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(pdfService.extractText).not.toHaveBeenCalled();
  });
});

describe('parsedResumeToMarkdown: a role keeps its dates (carry-over from the free tool)', () => {
  it('prefers startDate / endDate over a duration that holds no date; a duration with dates is kept as written', async () => {
    const { parsedResumeToMarkdown } = await import('../../lib/candidateResumeIngest.js');
    const base = { name: 'Ada Lovelace', summary: 'Engineer.', skills: [], education: [] };
    const computed = parsedResumeToMarkdown({
      ...base,
      experience: [{ company: 'Acme', role: 'Engineer', duration: '4 years 8 months', startDate: '2019-03', endDate: '2023-11', description: 'Built things' }],
    } as unknown as ParsedResume);
    expect(computed).toContain('**Engineer — Acme** · 2019-03 – 2023-11');
    expect(computed).not.toContain('4 years 8 months');
    const written = parsedResumeToMarkdown({
      ...base,
      experience: [{ company: 'Acme', role: 'Engineer', duration: '2019.03 - 2023.11', startDate: '2019-03', endDate: '2023-11', description: 'Built things' }],
    } as unknown as ParsedResume);
    expect(written).toContain('**Engineer — Acme** · 2019.03 - 2023.11');
    // No dates at all: the duration is all there is, so it stays.
    const onlyDuration = parsedResumeToMarkdown({
      ...base,
      experience: [{ company: 'Acme', role: 'Engineer', duration: '4 years 8 months', description: 'Built things' }],
    } as unknown as ParsedResume);
    expect(onlyDuration).toContain('**Engineer — Acme** · 4 years 8 months');
  });
});
