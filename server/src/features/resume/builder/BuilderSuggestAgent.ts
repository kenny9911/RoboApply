// server/src/features/resume/builder/BuilderSuggestAgent.ts
//
// The guided builder's AI suggestions (WP-65): bullets from the user's notes
// for one entry, a summary, or a 自我评价. One LLM call. Loaded only after
// `aiAllowed(user)` and the brand's `ai.text` capability both pass, so with AI
// off the builder makes zero LLMService calls.
//
// Prompt hygiene: the caller passes `builderPromptInput()` output (sensitive
// lines dropped, contact / ID details masked); see prompt.ts.

import { BaseAgent } from '../../../agents/BaseAgent.js';
import { getTaskModel, getTaskReasoningEffort } from '../../../lib/llm/llmTaskSettings.js';
import { currentBrandPersona } from '../../../platform/brand/persona.js';
import type { BuilderSuggestKind } from '../contract.js';
import { builderSystemPrompt, formatBuilderPrompt, parseBuilderOutput, type BuilderPromptInput } from './prompt.js';

export interface BuilderSuggestOutput {
  suggestions: string[];
}

export class BuilderSuggestAgent extends BaseAgent<BuilderPromptInput, BuilderSuggestOutput> {
  private kind: BuilderSuggestKind = 'bullets';
  private docLanguage: BuilderPromptInput['docLanguage'] = 'en';

  constructor() {
    super('ResumeBuilderSuggestAgent');
  }

  protected getTemperature(): number {
    return 0.4;
  }

  protected getMaxTokens(): number | undefined {
    return 900;
  }

  protected getReasoningEffort() {
    return getTaskReasoningEffort('rewrite');
  }

  protected getResponseFormat(): 'json_object' {
    return 'json_object';
  }

  /** The document language wins over the UI language (authoring agent). */
  protected getLocaleDirective(locale: string): string | null {
    return this.language.getStrictOutputLanguageDirective(locale, 'content') ?? super.getLocaleDirective(locale);
  }

  protected getAgentPrompt(): string {
    return `${currentBrandPersona('resume writing assistant')}. ${builderSystemPrompt(this.kind, this.docLanguage)}`;
  }

  protected formatInput(input: BuilderPromptInput): string {
    return formatBuilderPrompt(input);
  }

  protected parseOutput(response: string): BuilderSuggestOutput {
    return { suggestions: parseBuilderOutput(response) };
  }

  async run(input: BuilderPromptInput, options: { requestId?: string; signal?: AbortSignal } = {}): Promise<BuilderSuggestOutput> {
    this.kind = input.kind;
    this.docLanguage = input.docLanguage;
    return this.execute(input, undefined, options.requestId, input.docLanguage, getTaskModel('rewrite'), options.signal);
  }
}
