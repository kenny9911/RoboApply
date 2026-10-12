// server/src/interview-engine/prep/promptContext.ts
//
// A session's stored prep (contract.ts `StoredPrep`) turned into what each
// stage of the interview reads — the "skills applied" for this one practice:
//
//   blueprint  the question designer: the generated interviewer and focus,
//              the planned strategy, the company style, the chosen patterns'
//              and the market's blueprint directives;
//   voice      the live interviewer: their background, the company they are
//              hiring for, how its loop runs, the patterns' and market's
//              voice directives;
//   evaluation the graders: the patterns', the market's and the company's
//              lens, appended to the archetype and domain lenses.
//
// A session without prep gets none of this and runs exactly as before.

import { marketDirectives, patternDirectives } from '../skills/index.js';
import { clip, describeCompanyStyle, type PrepRequirements, type StoredPrep } from './contract.js';

export interface PrepPromptContext {
  interviewerBackground: string;
  focusLabel: string;
  focusDescription: string;
  focusTopics: string[];
  company: string | null;
  /** The researched style, condensed (null without a company). */
  companyBrief: string | null;
  /** True when the style was found in public sources (else it is the usual practice). */
  companySourced: boolean;
  requirements: PrepRequirements;
  strategySummary: string;
  strategyStages: string[];
  tactics: string[];
  marketLabel: string | null;
  blueprintDirectives: string[];
  voiceDirectives: string[];
}

function combinedPatterns(prep: StoredPrep): string[] {
  const keys = [...prep.focus.patterns, ...prep.interviewer.patterns, ...(prep.companyStyle?.patterns ?? [])];
  return [...new Set(keys)].slice(0, 5);
}

export function buildPrepPromptContext(prep: StoredPrep): PrepPromptContext {
  const patterns = patternDirectives(combinedPatterns(prep));
  const market = marketDirectives(prep.market);
  return {
    interviewerBackground: prep.interviewer.background,
    focusLabel: prep.focus.label,
    focusDescription: prep.focus.description,
    focusTopics: prep.focus.topics,
    company: prep.company,
    companyBrief: prep.companyStyle ? describeCompanyStyle(prep.companyStyle) : null,
    companySourced: prep.companyStyle?.basis === 'sources',
    requirements: prep.requirements,
    strategySummary: prep.strategy.summary,
    strategyStages: prep.strategy.stages.map((stage) => `${stage.name}${stage.goal ? ` — ${stage.goal}` : ''}`),
    tactics: prep.strategy.tactics,
    marketLabel: market?.label ?? null,
    blueprintDirectives: [...patterns.blueprint, ...(market ? market.blueprint.map((d) => `Market norms (${market.label}): ${d}`) : [])],
    voiceDirectives: [...patterns.voice, ...(market ? market.voice.map((d) => `Market norms (${market.label}): ${d}`) : [])],
  };
}

/** The prep's grading lens: the loop's patterns, the market, and the company's stated criteria. */
export function prepEvaluationLens(prep: StoredPrep): string | null {
  const parts: string[] = [];
  const patterns = patternDirectives(combinedPatterns(prep));
  if (patterns.evaluation.length) parts.push(`Loop patterns — ${patterns.evaluation.join(' ')}`);
  const market = marketDirectives(prep.market);
  if (market) parts.push(`Market norms (${market.label}) — ${market.evaluation.join(' ')}`);
  const style = prep.companyStyle;
  if (style && (style.evaluates.length || style.values.length)) {
    const criteria = [...style.values, ...style.evaluates].slice(0, 8).join('; ');
    parts.push(
      style.basis === 'sources'
        ? `${style.company}'s criteria from public sources — weigh answers against: ${criteria}.`
        : `What companies like ${style.company} usually look for in this role: ${criteria}.`,
    );
  }
  if (prep.focus.topics.length) parts.push(`This practice focused on "${clip(prep.focus.label, 80)}": ${prep.focus.topics.join('; ')}.`);
  return parts.length ? parts.join('\n') : null;
}

/** The prompt block for the question designer (InterviewBlueprintAgent). */
export function renderPrepForBlueprint(ctx: PrepPromptContext): string {
  const blocks: string[] = [];
  const plan: string[] = [];
  if (ctx.interviewerBackground) plan.push(`Interviewer background: ${ctx.interviewerBackground}`);
  plan.push(`Focus of this practice: ${ctx.focusLabel}${ctx.focusDescription ? ` — ${ctx.focusDescription}` : ''}`);
  if (ctx.focusTopics.length) plan.push(`Must cover: ${ctx.focusTopics.join('; ')}`);
  if (ctx.strategySummary) plan.push(`Planned strategy: ${ctx.strategySummary}`);
  if (ctx.strategyStages.length) plan.push(`Planned stages: ${ctx.strategyStages.join(' | ')}`);
  if (ctx.tactics.length) plan.push(`Interviewer tactics: ${ctx.tactics.join('; ')}`);
  blocks.push(`## Interview prep (planned for this candidate — follow it)\n${plan.join('\n')}`);
  const req = ctx.requirements;
  const reqLines = [
    req.summary ? `Summary: ${req.summary}` : '',
    req.seniority ? `Level: ${req.seniority}` : '',
    req.mustHave.length ? `Must-haves: ${req.mustHave.join('; ')}` : '',
    req.niceToHave.length ? `Nice-to-haves: ${req.niceToHave.join('; ')}` : '',
    req.responsibilities.length ? `Responsibilities: ${req.responsibilities.join('; ')}` : '',
    req.competencies.length ? `Competencies: ${req.competencies.join('; ')}` : '',
  ].filter(Boolean);
  if (reqLines.length) blocks.push(`## Prepared requirements (a job post, when given, outranks these)\n${reqLines.join('\n')}`);
  if (ctx.companyBrief) {
    blocks.push(
      `## Company interview style (${ctx.companySourced ? 'researched from public sources' : 'no reliable public description found — usual practice for this kind of company'}; reflect it in the questions, never present a question as the company's own)\n${ctx.companyBrief}`,
    );
  }
  if (ctx.blueprintDirectives.length) {
    blocks.push(`## Interview patterns and market norms of this loop (binding, like the format)\n${ctx.blueprintDirectives.map((d) => `- ${d}`).join('\n')}`);
  }
  return blocks.join('\n\n');
}

/** The sentences for the live interviewer's system prompt (kept short: it is spoken against a clock). */
export function renderPrepForVoice(ctx: PrepPromptContext): string[] {
  const lines: string[] = [];
  if (ctx.interviewerBackground) lines.push(`Your background: ${clip(ctx.interviewerBackground, 200)}`);
  if (ctx.company) {
    lines.push(
      `You are interviewing the candidate for a role at ${clip(ctx.company, 80)}. Run the conversation the way this company's interviews are described${ctx.companySourced ? '' : ' for companies like it'}, without claiming inside knowledge of its hiring decisions and without presenting any question as the company's real question.`,
    );
  }
  const description = clip(ctx.focusDescription, 200).replace(/[.。!！?？]+$/u, '');
  lines.push(`This practice focuses on: ${clip(ctx.focusLabel, 80)}${description ? ` — ${description}` : ''}.`);
  for (const directive of ctx.voiceDirectives.slice(0, 5)) lines.push(clip(directive, 420));
  return lines;
}
