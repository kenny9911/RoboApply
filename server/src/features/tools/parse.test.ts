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
import { anonymousAiAllowed, defaultParseUpload, nameFromFile, stripControl, textToMarkdown, withReadableDates } from './parse.js';

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

  it('a structured parse that gives a computed length as the duration still yields dated roles', async () => {
    m.pdf.mockResolvedValue(PLAIN_TEXT);
    m.isEnabled.mockResolvedValue(true);
    m.agent.mockResolvedValue({
      name: 'Sam Rivera',
      experience: [
        { role: 'Senior Product Designer', company: 'Shop Co', duration: '4 years 8 months', startDate: 'March 2022', endDate: 'Present', location: 'Portland, OR', achievements: ['Designed the returns flow'] },
        { role: 'Product Designer', company: 'Beta', duration: '2 yrs', startDate: '2020-03', endDate: '2022-02', achievements: [] },
        { role: 'Designer', company: 'Gamma', duration: 'Jan 2018 – Feb 2020 (2 yrs 2 mos)', startDate: '2018', endDate: '2020', achievements: [] },
      ],
      education: [],
      skills: ['Figma'],
    });
    const out = await defaultParseUpload(input('roboapply'));
    expect(out.via).toBe('local_ai');
    expect(out.markdown).toContain('**Senior Product Designer — Shop Co** · March 2022 – Present · Portland, OR');
    expect(out.markdown).toContain('**Product Designer — Beta** · 2020-03 – 2022-02');
    expect(out.markdown).toContain('**Designer — Gamma** · Jan 2018 – Feb 2020 (2 yrs 2 mos)');
    expect(out.markdown).not.toContain('4 years 8 months');
    const k = await runRequirementRows(out.markdown, { title: 'Senior Product Designer', text: 'Requirements:\n- 5+ years of product design experience' }, 'intl', () => new Date('2026-10-11T12:00:00Z'));
    const years = k.rows.find((r) => r.key === 'years');
    // Jan 2018 – Feb 2020, Mar 2020 – Feb 2022 and Mar 2022 – Oct 2026: 8.6, not the 2.1 the one readable role gave.
    expect(years?.params).toEqual({ required: 5, found: 8.6 });
    expect(years?.status).toBe('pass');
  });

  it('withReadableDates changes only a duration that holds no dates, and never the input', () => {
    const parsed = {
      name: 'Sam',
      experience: [
        { role: 'A', duration: '4 years 8 months', startDate: 'March 2022', endDate: 'Present' },
        { role: 'B', duration: '', startDate: 'June 2019', endDate: 'February 2022' },
        { role: 'C', duration: 'June 2017 – May 2019', startDate: '2017', endDate: '2019' },
        { role: 'D', duration: '3 years', startDate: '', endDate: '' },
        { role: 'E', duration: '1 yr', startDate: '2016', endDate: null },
        null,
      ],
    };
    const before = JSON.stringify(parsed);
    const out = withReadableDates(parsed) as typeof parsed;
    expect(out.experience.map((e) => e?.duration)).toEqual(['March 2022 – Present', 'June 2019 – February 2022', 'June 2017 – May 2019', '3 years', '2016', undefined]);
    expect(JSON.stringify(parsed)).toBe(before);
    expect(withReadableDates(null)).toBeNull();
    expect(withReadableDates({ name: 'Sam' })).toEqual({ name: 'Sam' });
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

  it('GoApply runs the structured parse only for a run that carried the ticked notice', async () => {
    m.gohire.mockResolvedValue(null);
    m.pdf.mockResolvedValue(PLAIN_TEXT);
    m.isEnabled.mockResolvedValue(true);
    m.agent.mockResolvedValue({ name: 'Sam Rivera', experience: [], education: [], skills: [] });
    // No notice on the run (a caller that did not go through the service's check): never a model.
    const without = await defaultParseUpload(input('goapply'));
    expect(m.agent).not.toHaveBeenCalled();
    expect(m.llmChat).not.toHaveBeenCalled();
    expect(without.via).toBe('local_text');
    expect(without.markdown).toContain('## Experience');
    // With the notice: the same structured parse RoboApply runs.
    const withNotice = await defaultParseUpload({ ...input('goapply'), consented: true });
    expect(m.agent).toHaveBeenCalledTimes(1);
    expect(withNotice.via).toBe('local_ai');
    expect(m.isEnabled).toHaveBeenLastCalledWith('ai.text', { brand: expect.objectContaining({ id: 'goapply' }) });
  });

  it('GoApply with the notice but the text model off: the deterministic text pass', async () => {
    m.gohire.mockResolvedValue(null);
    m.pdf.mockResolvedValue(PLAIN_TEXT);
    m.isEnabled.mockResolvedValue(false);
    const out = await defaultParseUpload({ ...input('goapply'), consented: true });
    expect(m.agent).not.toHaveBeenCalled();
    expect(out.via).toBe('local_text');
  });

  it('anonymousAiAllowed: RoboApply always; GoApply only with the ticked notice', () => {
    expect(anonymousAiAllowed(getBrand('roboapply'))).toBe(true);
    expect(anonymousAiAllowed(getBrand('roboapply'), false)).toBe(true);
    expect(anonymousAiAllowed(getBrand('goapply'))).toBe(false);
    expect(anonymousAiAllowed(getBrand('goapply'), false)).toBe(false);
    expect(anonymousAiAllowed(getBrand('goapply'), true)).toBe(true);
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
