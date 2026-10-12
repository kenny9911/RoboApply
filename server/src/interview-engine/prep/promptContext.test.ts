// @vitest-environment node
//
// A stored prep turned into what each interview stage reads
// (prep/promptContext.ts): the question designer gets the plan, the company
// style and the loop's pattern + market directives; the live interviewer gets
// short sentences that never claim inside knowledge of the company; the
// graders get the patterns', the market's and the company's criteria,
// labelled as researched or as the usual practice.
// Run: npx vitest run server/src/interview-engine/prep/promptContext.test.ts

import { describe, expect, it } from 'vitest';
import { INTERVIEW_PATTERNS, MARKET_NORMS, type InterviewPatternKey } from '../skills/index.js';
import { describeCompanyStyle, storedPrepFromBody, type StoredPrep } from './contract.js';
import { buildPrepPromptContext, prepEvaluationLens, renderPrepForBlueprint, renderPrepForVoice } from './promptContext.js';

const STYLE = {
  company: 'Acme AI',
  summary: 'A recruiter screen, a customer-deployment exercise and a values round.',
  stages: [{ name: 'Values round', description: 'Questions mapped to published principles' }],
  values: ['Customer obsession', 'Ownership'],
  evaluates: ['Ownership of customer outcomes'],
  questionThemes: ['A time a deployment went wrong'],
  tips: [],
  patterns: ['values-principles', 'customer-scenario'],
  sources: [{ title: 'Acme careers', url: 'https://acme.example/careers' }],
  basis: 'sources',
};

const PLAN = {
  role: 'Forward Deployed Engineer',
  company: 'Acme AI',
  industry: null,
  market: 'jp',
  requirements: { summary: 'Ships AI systems at customer sites.', seniority: 'Senior', mustHave: ['Python'], niceToHave: [], responsibilities: ['Deploy with customers'], competencies: [] },
  companyStyle: STYLE,
  interviewers: [
    { key: 'i1', name: 'Kenji Mori', title: 'Hiring manager', background: 'Runs the deployment team', style: 'Direct', archetype: 'depth', difficulty: 3, voiceGender: 'male', focusKeys: ['f1'], patterns: ['project-deep-dive'] },
  ],
  focuses: [
    { key: 'f1', label: 'Customer deployment', description: 'Debug a model at a customer site', format: 'technical', patterns: ['customer-scenario'], topics: ['Debugging on site', 'Scoping with the customer'] },
  ],
  strategy: {
    summary: 'Opens with motivation, then one deployment in depth.',
    stages: [{ name: 'Opening', goal: 'Rapport', share: 0.2 }, { name: 'Close', goal: '', share: 0.1 }],
    tactics: ['Asks for the numbers behind each result'],
    prepTips: [],
  },
};

function prepFrom(plan: Record<string, unknown> = {}): StoredPrep {
  const prep = storedPrepFromBody({ plan: { ...PLAN, ...plan } }, 'intl', 'us');
  if (!prep) throw new Error('fixture plan did not clean');
  return prep;
}

const directive = (key: InterviewPatternKey, stage: 'blueprintDirective' | 'voiceDirective' | 'evaluationLens') =>
  `${INTERVIEW_PATTERNS[key].labelEn}: ${INTERVIEW_PATTERNS[key][stage]}`;

describe('buildPrepPromptContext', () => {
  it('carries the chosen patterns (focus, interviewer, company; de-duplicated) and the market’s directives', () => {
    const ctx = buildPrepPromptContext(prepFrom());
    expect(ctx.blueprintDirectives).toEqual([
      directive('customer-scenario', 'blueprintDirective'),
      directive('project-deep-dive', 'blueprintDirective'),
      directive('values-principles', 'blueprintDirective'),
      `Market norms (Japan): ${MARKET_NORMS.jp.blueprintDirective}`,
    ]);
    expect(ctx.voiceDirectives).toEqual([
      directive('customer-scenario', 'voiceDirective'),
      directive('project-deep-dive', 'voiceDirective'),
      directive('values-principles', 'voiceDirective'),
      `Market norms (Japan): ${MARKET_NORMS.jp.voiceDirective}`,
    ]);
    expect(ctx.marketLabel).toBe('Japan');
  });

  it('carries the plan: interviewer, focus, strategy and the company brief', () => {
    const prep = prepFrom();
    const ctx = buildPrepPromptContext(prep);
    expect(ctx).toMatchObject({
      interviewerBackground: 'Runs the deployment team',
      focusLabel: 'Customer deployment',
      focusDescription: 'Debug a model at a customer site',
      focusTopics: ['Debugging on site', 'Scoping with the customer'],
      company: 'Acme AI',
      companySourced: true,
      requirements: prep.requirements,
      strategySummary: 'Opens with motivation, then one deployment in depth.',
      strategyStages: ['Opening — Rapport', 'Close'],
      tactics: ['Asks for the numbers behind each result'],
    });
    expect(ctx.companyBrief).toBe(describeCompanyStyle(prep.companyStyle!));
    expect(ctx.companyBrief).toContain('Acme AI (from public sources)');
  });

  it('uses at most five patterns', () => {
    const ctx = buildPrepPromptContext(
      prepFrom({
        interviewers: [{ ...PLAN.interviewers[0], patterns: ['bar-raiser', 'hr-final', 'cross-team'] }],
        focuses: [{ ...PLAN.focuses[0], patterns: ['presentation-qa', 'group-discussion', 'one-way-video'] }],
      }),
    );
    expect(ctx.blueprintDirectives.filter((d) => !d.startsWith('Market norms'))).toHaveLength(5);
  });

  it('without a company style there is no brief, and nothing claims sources', () => {
    const ctx = buildPrepPromptContext(prepFrom({ company: null, companyStyle: null }));
    expect(ctx).toMatchObject({ company: null, companyBrief: null, companySourced: false });
  });
});

describe('prepEvaluationLens', () => {
  it('a researched style: the company’s criteria from public sources, with the loop’s patterns, market and focus', () => {
    const lens = prepEvaluationLens(prepFrom())!;
    expect(lens).toContain(`Loop patterns — ${directive('customer-scenario', 'evaluationLens')}`);
    expect(lens).toContain(`Market norms (Japan) — ${MARKET_NORMS.jp.evaluationLens}`);
    expect(lens).toContain("Acme AI's criteria from public sources — weigh answers against: Customer obsession; Ownership; Ownership of customer outcomes.");
    expect(lens).toContain('This practice focused on "Customer deployment": Debugging on site; Scoping with the customer.');
  });

  it('a general style is labelled as what companies like it usually look for, never as the company’s own', () => {
    const lens = prepEvaluationLens(prepFrom({ companyStyle: { ...STYLE, sources: [], basis: 'general' } }))!;
    expect(lens).toContain('What companies like Acme AI usually look for in this role: Customer obsession; Ownership; Ownership of customer outcomes.');
    expect(lens).not.toContain('from public sources');
  });

  it('a style with no criteria adds no company line; a bare plan still has the market lens', () => {
    expect(prepEvaluationLens(prepFrom({ companyStyle: { ...STYLE, values: [], evaluates: [] } }))).not.toContain('Acme AI');
    const bare = prepFrom({
      market: 'us',
      company: null,
      companyStyle: null,
      interviewers: [{ ...PLAN.interviewers[0], patterns: [] }],
      focuses: [{ ...PLAN.focuses[0], patterns: [], topics: [] }],
    });
    expect(prepEvaluationLens(bare)).toBe(`Market norms (United States and Canada) — ${MARKET_NORMS.us.evaluationLens}`);
  });
});

describe('renderPrepForVoice', () => {
  it('names the company and how its interviews are described, without claiming inside knowledge', () => {
    const lines = renderPrepForVoice(buildPrepPromptContext(prepFrom()));
    expect(lines[0]).toBe('Your background: Runs the deployment team');
    expect(lines[1]).toBe(
      "You are interviewing the candidate for a role at Acme AI. Run the conversation the way this company's interviews are described, without claiming inside knowledge of its hiring decisions and without presenting any question as the company's real question.",
    );
    expect(lines[2]).toBe('This practice focuses on: Customer deployment — Debug a model at a customer site.');
    expect(lines.slice(3)).toEqual(buildPrepPromptContext(prepFrom()).voiceDirectives);
  });

  it('the focus line ends with one full stop, whatever the description ends with', () => {
    const focusLine = (description: string) =>
      renderPrepForVoice(buildPrepPromptContext(prepFrom({ focuses: [{ ...PLAN.focuses[0], description }] }))).find((line) => line.startsWith('This practice focuses on'));
    expect(focusLine('Why Acme, why now.')).toBe('This practice focuses on: Customer deployment — Why Acme, why now.');
    expect(focusLine('为什么选择我们。')).toBe('This practice focuses on: Customer deployment — 为什么选择我们.');
    expect(focusLine('Ready?!')).toBe('This practice focuses on: Customer deployment — Ready.');
    expect(focusLine('')).toBe('This practice focuses on: Customer deployment.');
  });

  it('a general style is described for companies like it', () => {
    const lines = renderPrepForVoice(buildPrepPromptContext(prepFrom({ companyStyle: { ...STYLE, sources: [] } })));
    expect(lines[1]).toContain("the way this company's interviews are described for companies like it, without claiming inside knowledge");
  });

  it('without a company there is no company line; directives are capped at five; every line is one line', () => {
    const lines = renderPrepForVoice(
      buildPrepPromptContext(
        prepFrom({
          company: null,
          companyStyle: null,
          interviewers: [{ ...PLAN.interviewers[0], patterns: ['bar-raiser', 'hr-final', 'cross-team'] }],
          focuses: [{ ...PLAN.focuses[0], patterns: ['presentation-qa', 'group-discussion', 'one-way-video'] }],
        }),
      ),
    );
    expect(lines.some((line) => line.includes('You are interviewing the candidate for a role at'))).toBe(false);
    // Background + focus + at most five directives.
    expect(lines).toHaveLength(7);
    for (const line of lines) expect(line).not.toMatch(/\n/);
  });

  it('no pattern or market directive is long enough to be cut (a market’s guardrail sentence comes last)', () => {
    for (const market of Object.values(MARKET_NORMS)) {
      const line = `Market norms (${market.labelEn}): ${market.voiceDirective}`;
      expect(line.length, market.key).toBeLessThanOrEqual(420);
    }
    for (const pattern of Object.values(INTERVIEW_PATTERNS)) {
      expect(`${pattern.labelEn}: ${pattern.voiceDirective}`.length, pattern.key).toBeLessThanOrEqual(420);
    }
    const lines = renderPrepForVoice(buildPrepPromptContext(prepFrom({ market: 'cn' })));
    expect(lines.at(-1)).toBe(`Market norms (Mainland China): ${MARKET_NORMS.cn.voiceDirective}`);
    expect(lines.at(-1)).toMatch(/Never ask about age.*heard locally\.$/);
  });
});

describe('renderPrepForBlueprint', () => {
  it('lays out the plan, the requirements, the company style (labelled by basis) and the binding directives', () => {
    const ctx = buildPrepPromptContext(prepFrom());
    const brief = renderPrepForBlueprint(ctx);
    expect(brief).toContain('## Interview prep (planned for this candidate — follow it)');
    expect(brief).toContain('Focus of this practice: Customer deployment — Debug a model at a customer site');
    expect(brief).toContain('Must cover: Debugging on site; Scoping with the customer');
    expect(brief).toContain('Planned stages: Opening — Rapport | Close');
    expect(brief).toContain('## Prepared requirements (a job post, when given, outranks these)\nSummary: Ships AI systems at customer sites.');
    expect(brief).toContain('## Company interview style (researched from public sources; reflect it in the questions, never present a question as the company\'s own)');
    expect(brief).toContain(`- Market norms (Japan): ${MARKET_NORMS.jp.blueprintDirective}`);

    const general = renderPrepForBlueprint(buildPrepPromptContext(prepFrom({ companyStyle: { ...STYLE, sources: [] } })));
    expect(general).toContain('## Company interview style (no reliable public description found — usual practice for this kind of company;');
    const none = renderPrepForBlueprint(buildPrepPromptContext(prepFrom({ company: null, companyStyle: null })));
    expect(none).not.toContain('## Company interview style');
  });
});
