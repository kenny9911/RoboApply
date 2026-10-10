// @vitest-environment node
//
// Acceptance (TASK_PLAN.md WP-15): a CN-0 GoApply upload stores no original
// file and no photo, and the text it hands to storage has no PRC ID number.
// Runs the real candidate ingest seam (server/src/lib/candidateResumeIngest.ts)
// with the real GoHire parse and storage services; only the network and the
// local parse/summary helpers are faked.
//
// REQ-WP15-03 (INT-10): the ingest runs applyResumeUploadPolicy after parse and
// summary on every path — GoHire, the local PDF fallback after a GoHire 500,
// Word/text files and the LinkedIn text path — and a GoApply image goes to
// GoHire only (the upload fails when GoHire cannot read it; no local OCR).

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

/**
 * Route the ingest's storage calls through a real storage service whose S3
 * client is a fake that records every command (production env, intl and CN
 * buckets both configured), so nothing touches disk or the network.
 */
function fakeBucketCalls(): Array<{ command: string; bucket: unknown; key: string }> {
  const sent: Array<{ command: string; bucket: unknown; key: string }> = [];
  const backing = new ResumeOriginalFileStorageService({
    env: {
      NODE_ENV: 'production',
      S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
      S3_BUCKET: 'intl-bucket',
      S3_ACCESS_KEY_ID: 'intl-id',
      S3_SECRET_ACCESS_KEY: 'intl-secret',
      CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
      CN_S3_BUCKET: 'cn-bucket',
      CN_S3_ACCESS_KEY_ID: 'cn-id',
      CN_S3_SECRET_ACCESS_KEY: 'cn-secret',
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
const KEYS = ['GOHIRE_API_KEY', 'GOHIRE_PARSE_BRANDS', 'GOHIRE_API_BASE', 'GOHIRE_PARSE_ENABLED', 'DEPLOY_REGION'];

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.GOHIRE_API_KEY = 'test-key';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PAYLOAD), { status: 200 })));
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CN-0 GoApply upload', () => {
  it('keeps no original file and no photo, and hands storage no PRC ID or health detail', async () => {
    const save = vi.spyOn(resumeOriginalFileStorageService, 'saveFile');
    const result = await runWithBrand('goapply', () =>
      ingestCandidateResume({
        buffer: Buffer.from('%PDF-1.4 scanned resume'),
        fileName: 'resume.pdf',
        mimeType: 'application/pdf',
        userId: 'user_cn',
      }),
    );

    expect(result.original).toBeNull();
    expect(save).not.toHaveBeenCalled();

    const stored = JSON.stringify([result.rawText, result.markdown, result.parsed, result.summary, result.highlight]);
    expect(stored).not.toContain(PRC_ID);
    expect(stored).not.toContain('良好');
    expect(stored).not.toContain('data:image');
    expect(result.markdown).toContain('负责支付系统');
  });

  it('when GoHire fails and the local parser runs, still keeps no original file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 500 })));
    vi.mocked(pdfService.extractText).mockResolvedValueOnce(LOCAL_TEXT);
    vi.mocked(resumeParseAgent.parse).mockResolvedValueOnce(LOCAL_PARSED);
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () =>
      ingestCandidateResume({ buffer: Buffer.from('%PDF-1.4'), fileName: 'resume.pdf', mimeType: 'application/pdf', userId: 'user_cn' }),
    );
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('REQ-WP15-03: GoHire 500 → local parse of a PDF: stored text has no PRC ID or health detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 500 })));
    vi.mocked(pdfService.extractText).mockResolvedValueOnce(LOCAL_TEXT);
    vi.mocked(resumeParseAgent.parse).mockResolvedValueOnce(LOCAL_PARSED);
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () =>
      ingestCandidateResume({ buffer: Buffer.from('%PDF-1.4'), fileName: 'resume.pdf', mimeType: 'application/pdf', userId: 'user_cn' }),
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expectNothingSensitive(result);
    expect(result.markdown).toContain('负责支付系统');
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('REQ-WP15-03: a .docx upload (local parse only): stored text has no PRC ID or health detail', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    vi.mocked(documentParsingService.extractText).mockResolvedValueOnce(LOCAL_TEXT);
    vi.mocked(resumeParseAgent.parse).mockResolvedValueOnce(LOCAL_PARSED);
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () =>
      ingestCandidateResume({
        buffer: Buffer.from('PK docx bytes'),
        fileName: 'resume.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        userId: 'user_cn',
      }),
    );
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

  it('forceLocalParser is ignored on GoApply: the PDF still goes to GoHire, never to the local pipeline', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const result = await runWithBrand('goapply', () =>
      ingestCandidateResume({ buffer: Buffer.from('%PDF-1.4'), fileName: 'resume.pdf', mimeType: 'application/pdf', userId: 'user_cn', forceLocalParser: true }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(pdfService.extractText).not.toHaveBeenCalled();
    expect(resumeParseAgent.parse).not.toHaveBeenCalled();
    expectNothingSensitive(result);
  });
});

describe('GoApply image uploads', () => {
  it('go to GoHire as a one-page PDF and come back redacted; the image is not kept', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const sent = fakeBucketCalls();
    const result = await runWithBrand('goapply', () =>
      ingestCandidateResume({ buffer: PNG_1X1, fileName: 'resume.png', mimeType: 'image/png', userId: 'user_cn' }),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = (fetchSpy.mock.calls[0]![1] as { body: FormData }).body;
    const file = body.get('file') as File;
    expect(file.name).toBe('resume.pdf');
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdfService.extractText).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).not.toHaveBeenCalled();
    expectNothingSensitive(result);
    expect(result.original).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('fail closed when GoHire is down: no local OCR, nothing parsed, nothing stored', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 500 })));
    const sent = fakeBucketCalls();
    await expect(
      runWithBrand('goapply', () =>
        ingestCandidateResume({ buffer: PNG_1X1, fileName: 'resume.png', mimeType: 'image/png', userId: 'user_cn' }),
      ),
    ).rejects.toMatchObject({ name: 'CandidateResumeIngestError', code: 'image_parse_unavailable' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(pdfService.extractText).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).not.toHaveBeenCalled();
    expect(resumeParseAgent.parse).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('fail closed for a format GoHire cannot take (WebP), even with forceLocalParser', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await expect(
      runWithBrand('goapply', () =>
        ingestCandidateResume({ buffer: Buffer.from('RIFF....WEBP'), fileName: 'resume.webp', mimeType: 'image/webp', userId: 'user_cn', forceLocalParser: true }),
      ),
    ).rejects.toMatchObject({ code: 'image_parse_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).not.toHaveBeenCalled();
  });

  it('fail closed when GoHire parsing is switched off for GoApply', async () => {
    process.env.GOHIRE_PARSE_ENABLED = 'false';
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await expect(
      runWithBrand('goapply', () =>
        ingestCandidateResume({ buffer: PNG_1X1, fileName: 'resume.png', mimeType: 'image/png', userId: 'user_cn' }),
      ),
    ).rejects.toMatchObject({ code: 'image_parse_unavailable' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(documentParsingService.extractText).not.toHaveBeenCalled();
  });
});

describe('RoboApply in the same deployment', () => {
  it('never calls GoHire, parses locally and stores the original once in the intl bucket (not under cn/)', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    vi.mocked(pdfService.extractText).mockResolvedValueOnce(LOCAL_TEXT);
    vi.mocked(resumeParseAgent.parse).mockResolvedValueOnce(LOCAL_PARSED);
    const sent = fakeBucketCalls();

    const result = await runWithBrand('roboapply', () =>
      ingestCandidateResume({ buffer: Buffer.from('%PDF-1.4'), fileName: 'resume.pdf', mimeType: 'application/pdf', userId: 'user_intl' }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ command: 'PutObjectCommand', bucket: 'intl-bucket' });
    expect(sent[0]!.key.startsWith('cn/')).toBe(false);
    expect(result.original?.key).toBe(sent[0]!.key);
    expect(result.original?.key.startsWith('roboapply-resumes/user_intl/')).toBe(true);
    // RoboApply text is stored as parsed (no CN-0 rule).
    expect(result.rawText).toContain(PRC_ID);
  });

  it('reads an image with the local pipeline as before (no GoHire, original kept)', async () => {
    const fetchSpy = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    vi.mocked(documentParsingService.extractText).mockResolvedValueOnce(LOCAL_TEXT);
    vi.mocked(resumeParseAgent.parse).mockResolvedValueOnce(LOCAL_PARSED);
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
    vi.mocked(pdfService.extractText).mockResolvedValueOnce(LOCAL_TEXT);
    vi.mocked(resumeParseAgent.parse).mockResolvedValueOnce(LOCAL_PARSED);
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
