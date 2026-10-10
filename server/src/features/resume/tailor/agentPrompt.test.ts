// @vitest-environment node
//
// WP-36a: the tailor agent's prompt carries the session's sections, the
// user's instruction, only the confirmed keywords and the profile snapshot,
// and states the honesty rules (posting facts are never the candidate's own;
// headings and entry lines stay). No model is called.

import { describe, expect, it, vi } from 'vitest';

const { chat } = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock('../../../services/llm/LLMService.js', () => ({ llmService: { chat, getModel: () => 'test-model' }, LLMService: class {} }));
vi.mock('../../../lib/prisma.js', () => ({ default: {} }));

import { RAResumeTailorAgent, resumeDocumentLocale } from '../../../roboapply/v2/agents/RAResumeTailorAgent.js';
import { createCreditTestKit } from '../../../platform/credits/testkit.js';
import { TailorService } from './TailorService.js';
import { createMemoryTailorStore, memoryTailorJob, memoryTailorVariant } from './memoryStore.js';

type Exposed = { formatInput(input: unknown, locale?: string): string; getAgentPrompt(): string };

describe('RAResumeTailorAgent prompt (tailor sessions)', () => {
  const agent = new RAResumeTailorAgent() as unknown as Exposed;

  it('includes sections, instruction, confirmed keywords and the profile snapshot', () => {
    const text = agent.formatInput({
      baseResumeMarkdown: '## Experience\n- Built reports.',
      jobTitle: 'Analyst',
      companyName: 'Acme',
      jobDescription: 'Build dashboards.',
      complexity: 'standard',
      sections: ['experience', 'skills'],
      experienceDepth: 'quick',
      instruction: 'Lead with reporting.',
      confirmedKeywords: ['Tableau'],
      profileContext: 'Target: analyst roles.',
    });
    expect(text).toContain('## Sections you may change\n- experience\n- skills');
    expect(text).toContain('## Keywords the candidate confirmed they have\n- Tableau');
    expect(text).toContain("## The candidate's instruction (follow it unless it breaks a hard rule)\nLead with reporting.");
    expect(text).toContain('Target: analyst roles.');
    expect(text).toContain('## Experience: quick\nKeep every existing bullet.');
    expect(text).not.toContain('Keywords to address');
  });

  it('omits the optional blocks when they are empty', () => {
    const text = agent.formatInput({ baseResumeMarkdown: '- x', jobTitle: '', jobDescription: '', complexity: 'standard' });
    expect(text).not.toContain('Sections you may change');
    expect(text).not.toContain('confirmed');
    expect(text).not.toContain("candidate's instruction");
  });

  it('states the posting and structure rules', () => {
    const prompt = agent.getAgentPrompt();
    expect(prompt).toContain("Facts from the job posting are never the candidate's own");
    expect(prompt).toContain('Keywords the candidate confirmed');
    expect(prompt).toMatch(/Keep every `##` heading/);
  });
});

describe('RAResumeTailorAgent output language (the resume decides, not the interface)', () => {
  const EN_RESUME = [
    '# Maya Lindqvist',
    '## Summary',
    'Data analyst with 4 years of experience turning operations data into dashboards and forecasts for logistics teams.',
    '## Experience',
    '- Built a weekly on-time delivery dashboard in Tableau used by 12 dispatch managers.',
  ].join('\n');
  const ZH_RESUME = ['# 林知远', '## Experience', '- 负责用户增长数据分析，搭建周报看板，覆盖 12 个业务团队的数据需求。', '- 使用 SQL 与 Python 完成留存分析，并向产品团队汇报结论。'].join('\n');
  const TW_RESUME = ['# 林知遠', '## 工作經歷', '- 負責使用者成長數據分析，建立週報看板，涵蓋 12 個業務團隊的資料需求。', '- 使用 SQL 與 Python 完成留存分析，並向產品團隊報告結論。'].join('\n');

  it('detects the language a resume is written in', () => {
    expect(resumeDocumentLocale(EN_RESUME)).toBe('en');
    // English section titles from an upload do not make a Chinese resume English.
    expect(resumeDocumentLocale(ZH_RESUME)).toBe('zh');
    expect(resumeDocumentLocale(TW_RESUME)).toBe('zh-TW');
    // A Chinese name or company in an English resume does not make it Chinese.
    expect(resumeDocumentLocale(`${EN_RESUME}\n- Worked with 字节跳动 on a data project.`)).toBe('en');
    expect(resumeDocumentLocale('SQL')).toBeNull();
    expect(resumeDocumentLocale('')).toBeNull();
  });

  it('an English resume stays English when the interface is zh-TW (and a Chinese one stays Chinese under en)', async () => {
    class Probe extends RAResumeTailorAgent {
      seen: Array<string | undefined> = [];
      async execute(_input: unknown, _jd?: string, _req?: string, locale?: string) {
        this.seen.push(locale);
        return { tailoredResumeMarkdown: '- x', changeSummary: '', citationsByLine: {} } as never;
      }
    }
    const probe = new Probe();
    const base = { jobTitle: 'Analyst', jobDescription: 'Build dashboards.', complexity: 'standard' as const };
    await probe.run({ ...base, baseResumeMarkdown: EN_RESUME }, { locale: 'zh-TW' });
    await probe.run({ ...base, baseResumeMarkdown: ZH_RESUME }, { locale: 'en' });
    // Too short to tell: the interface language is the fallback.
    await probe.run({ ...base, baseResumeMarkdown: '- SQL' }, { locale: 'zh-TW' });
    expect(probe.seen).toEqual(['en', 'zh', 'zh-TW']);
  });

  it('the directive names the resume language and forbids translating the document', () => {
    const exposed = new RAResumeTailorAgent() as unknown as { getLocaleDirective(locale: string): string | null; formatInput(input: unknown, locale?: string): string };
    const directive = exposed.getLocaleDirective('en') ?? '';
    expect(directive).toContain('The base resume is written in English');
    expect(directive).toContain('Never translate it');
    expect(directive).not.toContain('interface language is');
    const user = exposed.formatInput({ baseResumeMarkdown: EN_RESUME, jobTitle: 'Analyst', jobDescription: 'x', complexity: 'standard' }, 'en');
    expect(user).toContain('OUTPUT LANGUAGE: English');
  });
});

describe('AI consent off (TASK_PLAN.md §2.2)', () => {
  it('zero LLMService calls with the real tailor agent wired in', async () => {
    const store = createMemoryTailorStore();
    store.variants.set('rv', memoryTailorVariant('u', 'rv', '## Skills\nSQL\n'));
    store.jobs.set('j', memoryTailorJob('j', { market: 'cn' }));
    const score = vi.fn();
    const svc = new TailorService({
      store,
      credits: createCreditTestKit().credits,
      aiAvailable: async () => false,
      market: () => 'cn',
      tailor: (input, options) => new RAResumeTailorAgent().run(input, options),
      profileContext: async () => null,
      score,
      markChecklist: async () => undefined,
      logAiLabel: async () => undefined,
      assertPhoneBound: async () => undefined,
    });
    await expect(
      svc.create('u', { baseVariantId: 'rv', jobId: 'j', mode: 'guided', sections: ['skills'], keywords: [], experienceDepth: 'quick' }),
    ).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(chat).not.toHaveBeenCalled();
    expect(score).not.toHaveBeenCalled();
  });
});
