// server/src/features/resume/check/ResumeCheckAgent.ts
//
// The AI pass of the resume check (WP-22): one LLM call that looks for what
// rules cannot see — misspelled words and a vague summary. Runs only when
// `aiAllowed(user)` and the brand's `ai.text` capability are both true; the
// service never loads this module otherwise (zero LLMService calls).
//
// Prompt hygiene: the caller passes text from `resumeForLlm()` (no name,
// contact block, photo, 籍贯, 政治面貌, gender, birth date or family lines).

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { getTaskModel, getTaskReasoningEffort } from '../../../lib/llm/llmTaskSettings.js';
import { currentBrandPersona } from '../../../platform/brand/persona.js';
import { MAX_SPELLING, parseAiPassOutput, type AiPassInput, type AiPassOutput } from './aiPass.js';

export class ResumeCheckAgent extends BaseAgent<AiPassInput, AiPassOutput> {
  constructor() {
    super('ResumeCheckAgent');
  }

  protected getTemperature(): number {
    return 0.1;
  }

  protected getMaxTokens(): number | undefined {
    return 600;
  }

  protected getReasoningEffort() {
    return getTaskReasoningEffort('rewrite');
  }

  protected getResponseFormat(): 'json_object' {
    return 'json_object';
  }

  protected getAgentPrompt(): string {
    return `${currentBrandPersona('resume proofreader')}. You read one resume and report two things as STRICT JSON.

1. "spelling": up to ${MAX_SPELLING} words that are misspelled. Copy each misspelled word EXACTLY as it appears in the resume ("word") and give the correct spelling ("suggestion"). Ignore names, company names, product names, abbreviations, code identifiers and words in another language. Do not report style or grammar. If there are none, return [].
2. "summaryVague": true only when the resume has a summary or self-evaluation section and it is generic (it could describe almost anyone and names no role, area or result). Otherwise false.

Never invent anything. Return ONLY {"spelling":[{"word":"...","suggestion":"..."}],"summaryVague":false}.`;
  }

  protected formatInput(input: AiPassInput): string {
    const parts = [`PROFILE: ${input.profile === 'cn' ? 'Chinese resume conventions' : 'International resume conventions'}`];
    if (input.targetTitle) parts.push(`TARGET ROLE: ${input.targetTitle.slice(0, 120)}`);
    parts.push(`## Resume\n${input.resumeText.slice(0, 12_000)}`);
    return parts.join('\n\n');
  }

  protected parseOutput(response: string): AiPassOutput {
    return parseAiPassOutput(response);
  }

  async run(input: AiPassInput, options: { requestId?: string; locale?: string; signal?: AbortSignal } = {}): Promise<AiPassOutput> {
    return this.execute(input, input.resumeText, options.requestId, options.locale, getTaskModel('rewrite'), options.signal);
  }
}
