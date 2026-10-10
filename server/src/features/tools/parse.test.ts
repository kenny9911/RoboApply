// @vitest-environment node
//
// WP-57: the brand's parser path for anonymous files, and the two
// deterministic checks (no model call, nothing written).

import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  gohire: vi.fn(),
  pdf: vi.fn(),
  doc: vi.fn(),
  agent: vi.fn(),
  isEnabled: vi.fn(),
  llmChat: vi.fn(),
}));

vi.mock('../../lib/prisma.js', () => ({ default: {} }));
vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../services/GoHireResumeParseService.js', () => ({ goHireResumeParseService: { parseResumeFile: m.gohire } }));
vi.mock('../../services/PDFService.js', () => ({ pdfService: { extractText: m.pdf } }));
vi.mock('../../services/DocumentParsingService.js', () => ({ documentParsingService: { extractText: m.doc } }));
vi.mock('../../agents/ResumeParseAgent.js', () => ({ resumeParseAgent: { parse: m.agent } }));
vi.mock('../../services/llm/LLMService.js', () => ({ llmService: { chat: m.llmChat }, LLMService: class {} }));
vi.mock('../../platform/flags.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isEnabled: m.isEnabled }));

import { getBrand } from '../../platform/brand/registry.js';
import { HttpError } from '../../platform/http.js';
import { bySeverity, runChecklist, runRequirementRows } from './checks.js';
import { CN_RESUME_MD, FILES, POSTING, WEAK_RESUME_MD } from './fixtures.js';
import { defaultParseUpload, nameFromFile, stripControl, textToMarkdown } from './parse.js';

afterEach(() => vi.resetAllMocks());

const PLAIN_TEXT = [
  'Sam Rivera',
  'sam@example.test',
  '',
  'Experience',
  '• Responsible for helping customers',
  '• Built a returns process used by 4 stores',
  '',
  'Education:',
  'BA History, State University',
].join('\n');

describe('text helpers', () => {
  it('textToMarkdown marks the name, known section words and bullets, and invents nothing', () => {
    const md = textToMarkdown(PLAIN_TEXT);
    expect(md.split('\n')).toEqual([
      '# Sam Rivera',
      'sam@example.test',
      '',
      '## Experience',
      '- Responsible for helping customers',
      '- Built a returns process used by 4 stores',
      '',
      '## Education',
      'BA History, State University',
    ]);
    expect(textToMarkdown('工作经历\n- 负责接口开发')).toBe('## 工作经历\n- 负责接口开发');
  });

  it('nameFromFile tidies the file name; stripControl drops NUL and C0 controls', () => {
    expect(nameFromFile('C:\\docs\\Sam_Rivera_Resume.pdf')).toBe('Sam Rivera Resume');
    expect(nameFromFile('')).toBe('Resume');
    expect(stripControl('a\u0000b\u0007c\td\ne')).toBe('abc\td\ne');
  });
});

const input = (brandId: 'roboapply' | 'goapply', name = 'cv.pdf', mimeType = 'application/pdf') => ({
  buffer: FILES.pdf(),
  fileName: name,
  mimeType,
  brand: getBrand(brandId),
});

describe('defaultParseUpload', () => {
  it('RoboApply never sends the file to GoHire; with the text model on it runs the structured parse', async () => {
    m.pdf.mockResolvedValue(PLAIN_TEXT);
    m.isEnabled.mockResolvedValue(true);
    m.agent.mockResolvedValue({ name: 'Sam Rivera', email: 'sam@example.test', experience: [], education: [], skills: ['Excel'] });
    const out = await defaultParseUpload(input('roboapply'));
    expect(m.gohire).not.toHaveBeenCalled();
    expect(m.agent).toHaveBeenCalledTimes(1);
    expect(out.via).toBe('local_ai');
    expect(out.markdown).toContain('# Sam Rivera');
    expect(out.name).toBe('cv');
  });

  it('with the brand text model off: no structured parse, the deterministic text pass', async () => {
    m.doc.mockResolvedValue(PLAIN_TEXT);
    m.isEnabled.mockResolvedValue(false);
    const out = await defaultParseUpload(input('roboapply', 'cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    expect(m.agent).not.toHaveBeenCalled();
    expect(m.pdf).not.toHaveBeenCalled();
    expect(out.via).toBe('local_text');
    expect(out.markdown).toContain('## Experience');
  });

  it('a failed structured parse falls back to the text pass', async () => {
    m.pdf.mockResolvedValue(PLAIN_TEXT);
    m.isEnabled.mockResolvedValue(true);
    m.agent.mockRejectedValue(new Error('timeout'));
    expect((await defaultParseUpload(input('roboapply'))).via).toBe('local_text');
  });

  it('GoApply uses GoHire when it answers, the local path when it does not', async () => {
    m.gohire.mockResolvedValueOnce({
      rawText: '李明',
      parsed: { name: '李明', email: 'li@example.test', experience: [], education: [], skills: ['Java', 'MySQL'] },
    });
    const viaGoHire = await defaultParseUpload(input('goapply'));
    expect(viaGoHire.via).toBe('gohire');
    expect(m.gohire).toHaveBeenCalledWith(expect.objectContaining({ brand: 'goapply' }));
    expect(m.pdf).not.toHaveBeenCalled();

    m.gohire.mockResolvedValueOnce(null);
    m.pdf.mockResolvedValue(PLAIN_TEXT);
    m.isEnabled.mockResolvedValue(false);
    expect((await defaultParseUpload(input('goapply'))).via).toBe('local_text');
  });

  it('GoApply never runs the structured parse for an anonymous visitor, even with ai.text on', async () => {
    m.gohire.mockResolvedValue(null);
    m.pdf.mockResolvedValue(PLAIN_TEXT);
    m.isEnabled.mockResolvedValue(true);
    m.agent.mockResolvedValue({ name: 'Sam Rivera', experience: [], education: [], skills: [] });
    const out = await defaultParseUpload(input('goapply'));
    expect(m.agent).not.toHaveBeenCalled();
    expect(m.llmChat).not.toHaveBeenCalled();
    expect(out.via).toBe('local_text');
    expect(out.markdown).toContain('## Experience');
  });

  it('no readable text → 422 file_unreadable', async () => {
    m.pdf.mockResolvedValue('   ');
    const e = await defaultParseUpload(input('roboapply')).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).details).toEqual({ reason: 'file_unreadable' });
    m.pdf.mockRejectedValue(new Error('broken pdf'));
    await expect(defaultParseUpload(input('roboapply'))).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('checks (through WP-22’s public surface)', () => {
  it('runChecklist grades with rules only: zero model calls', async () => {
    const r = await runChecklist(WEAK_RESUME_MD, 'intl');
    expect(['fair', 'needs_work', 'good', 'excellent']).toContain(r.label);
    expect(r.issues.map((i) => i.type)).toEqual(expect.arrayContaining(['weak_verb', 'no_numbers']));
    expect(r.issues.every((i) => i.source !== 'ai')).toBe(true);
    expect(m.llmChat).not.toHaveBeenCalled();
  });

  it('the cn profile reads Chinese conventions', async () => {
    const r = await runChecklist(CN_RESUME_MD, 'cn');
    expect(r.profile).toBe('cn');
    expect(r.issues.some((i) => i.type.startsWith('cn_'))).toBe(true);
  });

  it('runRequirementRows reads the pasted posting', async () => {
    const k = await runRequirementRows(WEAK_RESUME_MD, POSTING, 'intl');
    expect(k.fit).toBeNull();
    expect(k.keywordSource).toBe('posting');
    expect(k.rows.find((r) => r.key === 'title')?.status).toBe('fail');
  });

  it('bySeverity keeps the rules order inside a severity', () => {
    const list = [
      { id: 'a', severity: 'optional' },
      { id: 'b', severity: 'urgent' },
      { id: 'c', severity: 'critical' },
      { id: 'd', severity: 'urgent' },
    ];
    expect(bySeverity(list).map((x) => x.id)).toEqual(['b', 'd', 'c', 'a']);
  });
});
