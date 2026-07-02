// Per-model pricing in USD per 1M tokens. Source of truth: comments in repo
// root .env. When you bump prices, update both places.
//
// Exported so the unified rate-card resolver (lib/rateCard.ts) can use this as
// its hardcoded DEFAULT tier — keeping the project invariant that an empty
// rate-card DB resolves byte-for-byte to these constants.
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // ── Google Gemini (OpenRouter + direct) ─────────────────────────────
  'google/gemini-pro-latest': { input: 2.00, output: 12.00 },
  'google/gemini-flash-latest': { input: 1.50, output: 9.00 },
  'google/gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
  'google/gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'google/gemini-3.5-flash': { input: 1.50, output: 9.00 },
  'google/gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
  'google/gemini-3.1-flash-image-preview': { input: 0.25, output: 1.50 },
  'gemini-pro-latest': { input: 2.00, output: 12.00 },
  'gemini-flash-latest': { input: 1.50, output: 9.00 },
  'gemini-3.1-pro-preview': { input: 2.00, output: 12.00 },
  'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
  'gemini-3.5-flash': { input: 1.50, output: 9.00 },
  'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.50 },
  'gemini-3.1-flash-image-preview': { input: 0.25, output: 1.50 },

  // ── Anthropic Claude (OpenRouter + direct) ──────────────────────────
  'anthropic/claude-opus-4.8': { input: 5.00, output: 25.00 },
  'anthropic/claude-opus-4.7': { input: 5.00, output: 25.00 },
  'anthropic/claude-opus-4.6': { input: 5.00, output: 25.00 },
  'anthropic/claude-sonnet-4.6': { input: 3.00, output: 15.00 },
  'anthropic/claude-haiku-4.5': { input: 1.00, output: 5.00 },
  'claude-opus-4-8': { input: 5.00, output: 25.00 },
  'claude-opus-4-7': { input: 5.00, output: 25.00 },
  'claude-opus-4-6': { input: 5.00, output: 25.00 },
  'claude-opus-4-6-20250408': { input: 5.00, output: 25.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6-20250408': { input: 3.00, output: 15.00 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00 },

  // ── OpenAI (OpenRouter + direct) ────────────────────────────────────
  'openai/gpt-5.5': { input: 5.00, output: 30.00 },
  'openai/gpt-5.4': { input: 2.50, output: 15.00 },
  'openai/gpt-5.4-mini': { input: 0.75, output: 4.50 },
  'openai/gpt-oss-120b': { input: 0.039, output: 0.19 },
  'gpt-5.5': { input: 5.00, output: 30.00 },
  'gpt-5.4': { input: 2.50, output: 15.00 },
  'gpt-5.4-mini': { input: 0.75, output: 4.50 },

  // ── DeepSeek ────────────────────────────────────────────────────────
  'deepseek/deepseek-v4-pro': { input: 0.435, output: 0.87 },
  'deepseek/deepseek-v4-flash': { input: 0.10, output: 0.20 },
  'deepseek-v4-pro': { input: 0.435, output: 0.87 },
  'deepseek-v4-flash': { input: 0.10, output: 0.20 },

  // ── Moonshot Kimi ───────────────────────────────────────────────────
  // Default Kimi pricing — non-thinking ($0.7448 in / $4.655 out per 1M).
  // Thinking-mode (256K context) at the provider is $0.60 in / $3.00 out
  // per 1M, but it shares the same model id, so we keep one entry. If a
  // call site needs thinking-mode billing accuracy, calculate manually.
  'moonshotai/kimi-k2.6': { input: 0.7448, output: 4.655 },
  'moonshotai/kimi-k2.5': { input: 0.60, output: 3.00 },
  'kimi-k2.6': { input: 0.7448, output: 4.655 },
  'kimi-k2.5': { input: 0.60, output: 3.00 },

  // ── Other OpenRouter models ─────────────────────────────────────────
  'xiaomi/mimo-v2.5-pro': { input: 1.00, output: 3.00 },
  'xiaomi/mimo-v2.5-flash': { input: 0.09, output: 0.29 },
  'z-ai/glm-5': { input: 0.95, output: 2.55 },
  'z-ai/glm-4.7': { input: 0.40, output: 1.50 },
  'minimax/minimax-m2.7': { input: 0.30, output: 1.20 },
  'x-ai/grok-4.1-fast': { input: 0.20, output: 0.50 },
  'x-ai/grok-code-fast-1': { input: 0.20, output: 1.50 },

  // ── MiniMax (direct OpenAICompatibleProvider, bare model ids) ────────
  // Direct api.minimax.chat serves bare ids (no `minimax/` slug). Same list
  // pricing as the OpenRouter route above. m3: $0.30/M in, $1.20/M out.
  'minimax-m2.7': { input: 0.30, output: 1.20 },
  'minimax-m3': { input: 0.30, output: 1.20 },
  'minimax/minimax-m3': { input: 0.30, output: 1.20 },

  // ── Ollama (self-hosted, no per-token API cost) ─────────────────────
  // Local inference has no marginal token cost, so bill at $0 rather than the
  // $1/$3 default (which would over-report platform spend). Add the specific
  // model ids you actually run — the calculateModelCost warning below names any
  // id still hitting the default so the gap is easy to spot.
  'qwen3': { input: 0, output: 0 },
  'qwen2.5': { input: 0, output: 0 },
  'llama3.3': { input: 0, output: 0 },
  'llama3.1': { input: 0, output: 0 },
  'mistral': { input: 0, output: 0 },

  // ── Default fallback ────────────────────────────────────────────────
  'default': { input: 1.00, output: 3.00 },
};

// Audio models billed per minute of audio (not per token). Used by ASR and
// TTS surfaces (e.g. the GoHire `/transcribe` endpoint that uses
// `gpt-4o-transcribe` via OpenAI's audio API).
export const AUDIO_MODEL_PRICING_PER_MINUTE: Record<string, number> = {
  'gpt-4o-transcribe': 0.006,
  'gpt-4o-mini-transcribe': 0.012,
  'gpt-4o-mini-tts': 0.012,
  'whisper-1': 0.006,
  'whisper': 0.006,
};

export function normalizeModelForPricing(model: string): string {
  const normalized = model.trim().replace(/^models\//i, '');

  switch (normalized) {
    case 'anthropic/claude-opus-4.8':
    case 'claude-opus-4.8':
      return 'claude-opus-4-8';
    case 'anthropic/claude-opus-4.7':
    case 'claude-opus-4.7':
      return 'claude-opus-4-7';
    case 'anthropic/claude-opus-4.6':
    case 'claude-opus-4.6':
    case 'claude-opus-4-6-20250408':
      return 'claude-opus-4-6';
    case 'anthropic/claude-sonnet-4.7':
    case 'claude-sonnet-4.7':
      return 'claude-sonnet-4-7';
    case 'anthropic/claude-sonnet-4.6':
    case 'claude-sonnet-4.6':
    case 'claude-sonnet-4-6-20250408':
      return 'claude-sonnet-4-6';
    case 'anthropic/claude-haiku-4.5':
    case 'claude-haiku-4.5':
      return 'claude-haiku-4-5';
    default:
      return normalized;
  }
}

// Models we've already warned about hitting the default tier — one warning per
// unique id per process keeps the signal visible without flooding the logs (this
// runs on every LLM call). NB: we use console.* here, not LoggerService, because
// LoggerService imports this module — importing it back would be a require cycle.
const warnedUnpricedModels = new Set<string>();

export function calculateModelCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const normalizedModel = normalizeModelForPricing(model);
  const explicit = MODEL_PRICING[normalizedModel] || MODEL_PRICING[model];
  const pricing = explicit || MODEL_PRICING.default;

  if (!explicit && model !== 'default') {
    // No pricing row — this model is being billed at the $1/$3 default, which
    // silently mis-costs any newly added model. Surface it once so a row can be
    // added to MODEL_PRICING above.
    if (!warnedUnpricedModels.has(normalizedModel)) {
      warnedUnpricedModels.add(normalizedModel);
      console.warn(
        `[modelPricing] No pricing row for model "${model}"` +
          (normalizedModel !== model ? ` (normalized "${normalizedModel}")` : '') +
          ` — billing at default $${MODEL_PRICING.default.input}/$${MODEL_PRICING.default.output} per 1M. ` +
          'Add a row to MODEL_PRICING in backend/src/lib/modelPricing.ts.',
      );
    }
  }

  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

export function calculateAudioModelCost(model: string, minutes: number): number {
  const normalized = model.trim().replace(/^models\//i, '').toLowerCase();
  const rate = AUDIO_MODEL_PRICING_PER_MINUTE[normalized] ?? 0;
  return rate * Math.max(0, minutes);
}

// Tavily web-search pricing. Tavily bills per "API credit": a basic search
// costs 1 credit, an advanced search 2 credits. The per-credit USD rate is
// plan-dependent (pay-as-you-go ≈ $0.008/credit); override at runtime with
// TAVILY_COST_PER_CREDIT_USD (no redeploy) to match the active Tavily plan.
export const DEFAULT_TAVILY_COST_PER_CREDIT_USD = 0.008;

export function calculateSearchCost(credits: number): number {
  if (!Number.isFinite(credits) || credits <= 0) return 0;
  const perCredit = Number(process.env.TAVILY_COST_PER_CREDIT_USD) || DEFAULT_TAVILY_COST_PER_CREDIT_USD;
  return credits * perCredit;
}

// Firecrawl scrape pricing. Firecrawl bills per page scraped; the per-page USD
// rate is plan-dependent (pay-as-you-go ≈ $0.001/page for /scrape). Override at
// runtime with FIRECRAWL_COST_PER_PAGE_USD (no redeploy) to match the plan.
export const DEFAULT_FIRECRAWL_COST_PER_PAGE_USD = 0.001;

export function calculateFireCrawlCost(pages: number): number {
  if (!Number.isFinite(pages) || pages <= 0) return 0;
  const perPage = Number(process.env.FIRECRAWL_COST_PER_PAGE_USD) || DEFAULT_FIRECRAWL_COST_PER_PAGE_USD;
  return pages * perPage;
}

export function isClaudeModelWithFixedPricing(model: string): boolean {
  const normalized = normalizeModelForPricing(model);
  return (
    normalized === 'claude-opus-4-8' ||
    normalized === 'claude-opus-4-7' ||
    normalized === 'claude-opus-4-6' ||
    normalized === 'claude-sonnet-4-7' ||
    normalized === 'claude-sonnet-4-6' ||
    normalized === 'claude-haiku-4-5'
  );
}
