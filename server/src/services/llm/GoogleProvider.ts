import { GoogleGenerativeAI } from '@google/generative-ai';
import { Message, LLMOptions, LLMProvider, LLMResponse, ProviderExtra } from '../../types/index.js';
import { resolveLlmRequestTimeoutMs } from './providerTuning.js';

export class GoogleProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI;
  private defaultModel: string;
  private readonly retryDelayMs = 800;
  // Retained so chat() can resolve a MODEL-AWARE timeout per request — the
  // construction default model (gemini-flash) differs from the per-call model.
  private readonly extra?: ProviderExtra;
  private readonly requestOptions?: { baseUrl?: string; customHeaders?: Record<string, string> };

  constructor(apiKey: string, defaultModel: string, extra?: ProviderExtra) {
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.extra = extra;
    // Optional proxy support for geo-restricted regions. DB-resolved values win;
    // env is the fallback (unchanged when unset).
    const baseUrl = extra?.baseUrl ?? process.env.GEMINI_BASE_URL;
    const proxyKey = extra?.proxyKey ?? process.env.LLM_PROXY_KEY;
    if (baseUrl) {
      this.requestOptions = {
        baseUrl,
        ...(proxyKey ? { customHeaders: { 'X-Proxy-Key': proxyKey } } : {}),
      };
    }
    // Extract model name from provider/model format (e.g., "google/gemini-3-flash-preview" -> "gemini-3-flash-preview")
    this.defaultModel = defaultModel.includes('/')
      ? defaultModel.split('/')[1]
      : defaultModel;
  }

  /**
   * Resolve the per-call request timeout. DB-resolved timeout (extra.timeoutMs,
   * which already folds in GOOGLE_LLM_TIMEOUT_MS/LLM_TIMEOUT_MS for the system
   * path) wins, else GOOGLE_LLM_TIMEOUT_MS, else LLM_TIMEOUT_MS, else the
   * purpose-aware default — 90s for the fast gemini-flash OCR/parse path, the
   * reasoning backstop for a thinking gemini-*pro*. Computed per call so the
   * model the request actually uses drives the ceiling (the OCR outage hung
   * because a fixed 600s × internal retries blew past the proxy cut).
   */
  private resolveTimeoutMs(model: string): number {
    return resolveLlmRequestTimeoutMs(this.extra, 'GOOGLE_LLM_TIMEOUT_MS', { model });
  }

  getProviderName(): string {
    return 'google';
  }

  async chat(messages: Message[], options?: LLMOptions): Promise<LLMResponse> {
    let modelName = options?.model || this.defaultModel;
    // Extract model name if it includes provider prefix
    if (modelName.includes('/')) {
      modelName = modelName.split('/')[1];
    }

    const model = this.genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
        maxOutputTokens: options?.maxTokens,
        // API-level JSON mode. Gemini's native structured-output knob — forces
        // a single application/json response (compatible with thinking models).
        // No "prompt must mention json" precondition (that's OpenAI-only), so we
        // gate purely on the caller's responseFormat flag.
        ...(options?.responseFormat === 'json_object'
          ? { responseMimeType: 'application/json' }
          : {}),
      },
    }, this.requestOptions);

    // Convert messages to Gemini format
    const systemMessage = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    // Check if any message has multimodal content (images)
    const hasImages = chatMessages.some(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
    );

    // Build content parts for Gemini
    const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

    if (systemMessage) {
      const sysText = typeof systemMessage.content === 'string' ? systemMessage.content : systemMessage.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join('\n');
      parts.push({ text: `System Instructions: ${sysText}\n\n` });
    }

    for (const msg of chatMessages) {
      const role = msg.role === 'assistant' ? 'Assistant' : 'User';
      if (typeof msg.content === 'string') {
        parts.push({ text: `${role}: ${msg.content}\n\n` });
      } else {
        // Multimodal content
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ text: `${role}: ${part.text}\n\n` });
          } else if (part.type === 'image_url') {
            // Extract base64 from data URI: data:image/png;base64,xxxxx
            const dataUri = part.image_url.url;
            const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              parts.push({ inlineData: { mimeType: match[1], data: match[2] } });
            }
          }
        }
      }
    }

    const result = await this.generateContentWithRetry(
      model,
      hasImages ? parts : parts.map(p => 'text' in p ? p.text : '').join(''),
      this.resolveTimeoutMs(modelName),
      options?.signal,
    );
    const response = result.response;
    const text = response.text();

    if (!text) {
      throw new Error('No content in Google Gemini response');
    }

    // Gemini returns usage metadata
    const usageMetadata = response.usageMetadata;

    return {
      content: text,
      usage: {
        promptTokens: usageMetadata?.promptTokenCount || 0,
        completionTokens: usageMetadata?.candidatesTokenCount || 0,
        totalTokens: usageMetadata?.totalTokenCount || 0,
      },
      model: modelName,
    };
  }

  private async generateContentWithRetry(
    model: ReturnType<GoogleGenerativeAI['getGenerativeModel']>,
    prompt: string | Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    const maxAttempts = 2;

    // Already gone before we even start — fail fast without building the race.
    if (signal?.aborted) throw makeAbortError();

    // The @google/generative-ai SDK call isn't directly abortable here, so we
    // race it against a signal-driven rejection. When the caller's signal fires
    // (client/proxy disconnect), this rejects with an AbortError immediately —
    // unwinding the chain so withLLMRetry sees AbortError and does NOT retry,
    // instead of the orphaned request burning the full retry budget for minutes
    // after the connection is gone (the 2026-06-24 parse-resume outage). Built
    // once outside the loop (one listener) and cleaned up in `finally`.
    let abortReject: ((err: Error) => void) | null = null;
    const onAbort = () => abortReject?.(makeAbortError());
    const abortRejection: Promise<never> | null = signal
      ? new Promise<never>((_resolve, reject) => {
          abortReject = reject;
          signal.addEventListener('abort', onAbort, { once: true });
        })
      : null;
    // If the request settles normally and the signal fires only afterwards,
    // abortRejection has no remaining consumer — suppress the otherwise-unhandled
    // rejection. The race below is the real consumer while the call is in flight.
    abortRejection?.catch(() => {});

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (signal?.aborted) throw makeAbortError();
        try {
          const racers: Array<Promise<unknown>> = [
            model.generateContent(prompt),
            new Promise<never>((_resolve, reject) => {
              setTimeout(() => {
                reject(new Error(`Google model request timed out after ${timeoutMs}ms`));
              }, timeoutMs);
            }),
          ];
          if (abortRejection) racers.push(abortRejection);
          return await Promise.race(racers) as Awaited<ReturnType<typeof model.generateContent>>;
        } catch (error) {
          // A user/proxy abort must never be retried — fail fast and propagate.
          const isLastAttempt = attempt === maxAttempts;
          if (signal?.aborted || isAbortError(error) || isLastAttempt || !this.shouldRetryHighDemandError(error)) {
            throw error;
          }

          await this.sleep(this.retryDelayMs);
        }
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    throw new Error('Failed to generate content after retry');
  }

  private shouldRetryHighDemandError(error: unknown): boolean {
    const fallbackMessage = String(error ?? '');
    if (!error || typeof error !== 'object') {
      return this.isRetryableMessage(fallbackMessage);
    }

    const err = error as {
      status?: number | string;
      statusCode?: number | string;
      code?: number | string;
      message?: string;
    };

    const rawStatus = err.status ?? err.statusCode ?? err.code;
    const status = typeof rawStatus === 'string' ? Number(rawStatus) : rawStatus;
    const message = typeof err.message === 'string' ? err.message : fallbackMessage;

    if (status === 503) {
      return true;
    }

    return this.isRetryableMessage(message);
  }

  private isRetryableMessage(message: string): boolean {
    const normalized = message.toLowerCase();

    return (
      normalized.includes('503 service unavailable') ||
      (normalized.includes('service unavailable') && normalized.includes('high demand')) ||
      normalized.includes('currently experiencing high demand') ||
      normalized.includes('spikes in demand are usually temporary') ||
      normalized.includes('fetch failed') ||
      normalized.includes('timed out') ||
      normalized.includes('timeout')
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Build an Error tagged so `withLLMRetry`'s `isTransientLLMError` short-circuits
 * it (it checks `name === 'AbortError'` / `code === 'ABORT_ERR'`). Matches the
 * shape the OpenAI/Anthropic SDKs throw on `signal` abort, so the retry layer
 * treats a Google-direct abort identically to every other provider's.
 */
function makeAbortError(): Error {
  const err = new Error('Google model request aborted by caller') as Error & { code?: string };
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; code?: string };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}
