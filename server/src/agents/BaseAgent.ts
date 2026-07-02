import { Message, LLMOptions } from '../types/index.js';
import { LLMService, llmService } from '../services/llm/LLMService.js';
import { LanguageService, languageService } from '../services/LanguageService.js';
import { logger } from '../services/LoggerService.js';
import { getCurrentRequestId } from '../lib/requestContext.js';
import { withLLMRetry } from '../services/llm/withRetry.js';

/**
 * Abstract base class for all agents
 * Provides common functionality for LLM interaction and language detection
 */
export abstract class BaseAgent<TInput, TOutput> {
  protected llm: LLMService;
  protected language: LanguageService;
  protected name: string;

  constructor(name: string) {
    this.name = name;
    this.llm = llmService;
    this.language = languageService;
  }

  /**
   * LLM temperature. Override in subclasses that need deterministic output (e.g. scoring).
   */
  protected getTemperature(): number {
    return 0.7;
  }

  /**
   * Cap on completion tokens. `undefined` lets the provider use the model's
   * default. OpenRouter pre-checks credits against this cap, so an unset value
   * on a 65k-context model can fail with HTTP 402 even when the actual output
   * is tiny — agents with small structured outputs should override.
   */
  protected getMaxTokens(): number | undefined {
    return undefined;
  }

  /**
   * Cap on a thinking model's reasoning tokens, separate from getMaxTokens().
   * Via OpenRouter, reasoning tokens count toward max_tokens — an always-on
   * reasoning model (deepseek-v4-pro, gemini dynamic thinking) can burn the
   * whole budget thinking and return empty content (finish_reason=length).
   * Agents that override getMaxTokens() with a small cap should set this to
   * leave the answer ≥4k tokens of headroom. Non-OpenRouter providers ignore
   * the option, so `undefined` (the default) changes nothing anywhere.
   */
  protected getReasoningMaxTokens(): number | undefined {
    return undefined;
  }

  /**
   * Opt into the provider's API-level JSON mode (response_format json_object /
   * Gemini responseMimeType). Returns `undefined` by default so behaviour is
   * unchanged for every existing agent.
   *
   * Override to `'json_object'` ONLY when this agent's prompt produces a PURE
   * JSON object with NO surrounding prose. JSON mode constrains the model to
   * emit nothing but the JSON object, which eliminates the "wrapped the JSON in
   * a sentence / extra markdown / partial fence" failure mode that surfaces as
   * a parse_failed error — but it also SUPPRESSES any pre-JSON reasoning text.
   * Agents that emit a <scratchpad> (or any reasoning) before the JSON
   * (e.g. ResumeMatchAgent) MUST NOT enable it, or that reasoning is lost.
   *
   * Threaded into both execute() and executeWithJsonResponse() so it applies on
   * every call path. Providers without a native JSON mode ignore the flag.
   */
  protected getResponseFormat(): 'json_object' | undefined {
    return undefined;
  }

  /**
   * Get the agent-specific system prompt
   * Override this in subclasses to define the agent's behavior
   */
  protected abstract getAgentPrompt(): string;

  /**
   * Format the input into a user message for the LLM
   * Override this in subclasses to customize input formatting
   */
  protected abstract formatInput(input: TInput): string;

  /**
   * Parse the LLM response into the expected output format
   * Override this in subclasses to customize output parsing
   */
  protected abstract parseOutput(response: string): TOutput;

  /**
   * Wraps `this.llm.chat()` and emits a per-agent `AGENT_LLM` log line with
   * tokens-in / tokens-out / cost / duration / provider / model after the
   * call returns. The underlying LLMService already records each call into
   * the per-request snapshot via `logger.logLLMCall()`; this method reads
   * the freshly-appended snapshot entries and surfaces them attributed to
   * `this.name` so per-agent cost is visible even in async batch contexts
   * where the requestAudit middleware has already finalized.
   *
   * Returns the raw response string from the LLM, identical to llm.chat().
   */
  protected async chatLogged(messages: Message[], options: LLMOptions): Promise<string> {
    const reqId = options.requestId;
    const snapshotBefore = reqId ? logger.getRequestSnapshot(reqId) : null;
    const beforeCount = snapshotBefore?.llmCalls.length ?? 0;
    const startedAt = Date.now();

    let response: string;
    try {
      response = await this.llm.chat(messages, options);
    } finally {
      const durationMs = Date.now() - startedAt;
      if (reqId) {
        const snapshotAfter = logger.getRequestSnapshot(reqId);
        const newCalls = (snapshotAfter?.llmCalls ?? []).slice(beforeCount);
        if (newCalls.length > 0) {
          const promptTokens = newCalls.reduce((s, c) => s + c.promptTokens, 0);
          const completionTokens = newCalls.reduce((s, c) => s + c.completionTokens, 0);
          const totalTokens = newCalls.reduce((s, c) => s + c.totalTokens, 0);
          const cost = newCalls.reduce((s, c) => s + c.cost, 0);
          const last = newCalls[newCalls.length - 1];
          logger.info(
            'AGENT_LLM',
            `${this.name}: LLM call complete`,
            {
              agent: this.name,
              provider: last.provider,
              model: last.model,
              status: last.status,
              promptTokensIn: promptTokens,
              completionTokensOut: completionTokens,
              totalTokens,
              cost: Number(cost.toFixed(6)),
              formattedCost: `$${cost.toFixed(6)}`,
              durationMs,
              byok: last.byok === true,
              ...(newCalls.length > 1
                ? { callCount: newCalls.length, note: 'multiple calls (fallback used)' }
                : {}),
            },
            reqId,
          );
        }
      }
    }

    return response;
  }

  /**
   * Resolve the instruction block prepended to the system prompt when the
   * caller supplies an explicit user locale. Defaults to the one-line
   * LANGUAGE_INSTRUCTIONS hint. Agents whose base prompts contain their own
   * language guidance (e.g. the match agents' "dominant language of the
   * JD + resume") should override this with
   * `languageService.getStrictOutputLanguageDirective` so the user-selected
   * language wins over the in-body rule.
   */
  protected getLocaleDirective(locale: string): string | null {
    return this.language.getLanguageInstructionFromLocale(locale);
  }

  /**
   * Build the system prompt with language detection
   * @param jdContent Optional JD content for language detection
   * @param requestId Optional request ID for logging
   * @param locale Optional user locale override (e.g. 'zh', 'ja', 'fr')
   */
  protected buildSystemPrompt(jdContent?: string, requestId?: string, locale?: string): string {
    const basePrompt = this.getAgentPrompt();

    // Prefer explicit locale from user's UI language setting
    if (locale) {
      const localeInstruction = this.getLocaleDirective(locale);
      if (localeInstruction) {
        const lang = this.language.getLanguageFromLocale(locale);
        logger.logLanguageDetection(requestId || '', lang || locale, 'locale');
        return `${localeInstruction}\n\n${basePrompt}`;
      }
    }

    if (jdContent) {
      const detectedLanguage = this.language.detectLanguage(jdContent);
      const languageInstruction = this.language.getLanguageInstruction(jdContent);

      logger.logLanguageDetection(requestId || '', detectedLanguage, 'auto');

      return `${languageInstruction}\n\n${basePrompt}`;
    }

    return basePrompt;
  }

  /**
   * Execute the agent with the given input
   * @param input The input to process
   * @param jdContent Optional JD content for language detection
   * @param requestId Optional request ID for logging
   * @param locale Optional user locale override (e.g. 'zh', 'ja', 'fr')
   */
  async execute(
    input: TInput,
    jdContent?: string,
    requestId?: string,
    locale?: string,
    model?: string,
    signal?: AbortSignal,
    provider?: string,
    thinkingMode?: 'enabled' | 'disabled',
  ): Promise<TOutput> {
    const stepNum = requestId ? logger.startStep(requestId, `${this.name}: Execute`) : 0;

    logger.logAgentStart(requestId || '', this.name, { inputType: typeof input, model: model || 'default' });

    // Push agent name so any LLM call inside this scope is attributed to us
    // in the REQUEST SUMMARY's per-agent rollup. Falls back to the AsyncLocal
    // requestId for callers that didn't pass one explicitly.
    const attributionRequestId = requestId || getCurrentRequestId();
    logger.pushAgent(attributionRequestId, this.name);

    const systemPrompt = this.buildSystemPrompt(jdContent, requestId, locale);
    const userMessage = this.formatInput(input);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    logger.debug('AGENT', `${this.name}: Prepared messages`, {
      systemPromptLength: systemPrompt.length,
      userMessageLength: userMessage.length,
      model: model || 'default',
    }, requestId);

    try {
      const maxTokens = this.getMaxTokens();
      const reasoningMaxTokens = this.getReasoningMaxTokens();
      const responseFormat = this.getResponseFormat();
      const response = await withLLMRetry(
        () => this.chatLogged(messages, {
          temperature: this.getTemperature(),
          requestId,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(reasoningMaxTokens !== undefined ? { reasoningMaxTokens } : {}),
          ...(responseFormat ? { responseFormat } : {}),
          ...(model ? { model } : {}),
          ...(signal ? { signal } : {}),
          ...(provider ? { provider } : {}),
          ...(thinkingMode ? { thinkingMode } : {}),
        }),
        { label: `${this.name}.execute`, requestId },
      );

      logger.debug('AGENT', `${this.name}: Parsing response`, {
        responseLength: response.length,
      }, requestId);

      const output = this.parseOutput(response);

      logger.logAgentEnd(requestId || '', this.name, true, JSON.stringify(output).length);

      if (requestId && stepNum) {
        logger.endStep(requestId, stepNum, 'completed');
      }

      return output;
    } catch (error) {
      logger.error('AGENT', `${this.name}: Execution failed`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      }, requestId);

      logger.logAgentEnd(requestId || '', this.name, false);

      if (requestId && stepNum) {
        logger.endStep(requestId, stepNum, 'failed');
      }

      throw error;
    } finally {
      logger.popAgent(attributionRequestId);
    }
  }

  /**
   * Execute and return typed JSON response
   * @param input The input to process
   * @param jdContent Optional JD content for language detection
   * @param requestId Optional request ID for logging
   * @param model Optional model override
   * @param locale Optional user locale override (e.g. 'zh', 'ja', 'fr') —
   *   same semantics as execute(): when set, the locale directive wins over
   *   JD-content language auto-detection.
   * @param provider Optional per-call provider override (e.g. 'openrouter',
   *   'deepseek', 'google'). Highest-precedence routing hint in LLMService —
   *   pins the call to that provider regardless of the deploy's LLM_PROVIDER
   *   mode. Used by the `llm` selector path (see lib/llm/llmSelector.ts).
   */
  async executeWithJsonResponse(input: TInput, jdContent?: string, requestId?: string, model?: string, locale?: string, provider?: string, thinkingMode?: 'enabled' | 'disabled'): Promise<TOutput> {
    const stepNum = requestId ? logger.startStep(requestId, `${this.name}: Execute (JSON)`) : 0;

    logger.logAgentStart(requestId || '', this.name, { inputType: typeof input, outputFormat: 'JSON', model: model || 'default' });

    const attributionRequestId = requestId || getCurrentRequestId();
    logger.pushAgent(attributionRequestId, this.name);

    const systemPrompt = this.buildSystemPrompt(jdContent, requestId, locale);
    const userMessage = this.formatInput(input);

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    logger.debug('AGENT', `${this.name}: Prepared messages for JSON response`, {
      systemPromptLength: systemPrompt.length,
      userMessageLength: userMessage.length,
      model: model || 'default',
    }, requestId);

    try {
      // Use chat() + parseOutput() so agent-specific fallback logic is always used.
      // chatWithJsonResponse() throws on malformed JSON with no fallback,
      // whereas each agent's parseOutput() provides a safe default.
      const maxTokens = this.getMaxTokens();
      const reasoningMaxTokens = this.getReasoningMaxTokens();
      const responseFormat = this.getResponseFormat();
      const response = await withLLMRetry(
        () => this.chatLogged(messages, {
          temperature: this.getTemperature(),
          requestId,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          ...(reasoningMaxTokens !== undefined ? { reasoningMaxTokens } : {}),
          ...(responseFormat ? { responseFormat } : {}),
          ...(model ? { model } : {}),
          ...(provider ? { provider } : {}),
          ...(thinkingMode ? { thinkingMode } : {}),
        }),
        { label: `${this.name}.executeWithJsonResponse`, requestId },
      );

      logger.debug('AGENT', `${this.name}: Parsing JSON response`, {
        responseLength: response.length,
      }, requestId);

      const output = this.parseOutput(response);

      logger.logAgentEnd(requestId || '', this.name, true, JSON.stringify(output).length);

      if (requestId && stepNum) {
        logger.endStep(requestId, stepNum, 'completed');
      }

      return output;
    } catch (error) {
      logger.error('AGENT', `${this.name}: JSON execution failed`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      }, requestId);

      logger.logAgentEnd(requestId || '', this.name, false);

      if (requestId && stepNum) {
        logger.endStep(requestId, stepNum, 'failed');
      }

      throw error;
    } finally {
      logger.popAgent(attributionRequestId);
    }
  }
}
