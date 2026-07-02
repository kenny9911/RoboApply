import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { getCurrentRequestId, getCurrentUserId, getCurrentUserName } from '../lib/requestContext.js';
import { calculateAudioModelCost, calculateModelCost, calculateSearchCost, calculateFireCrawlCost } from '../lib/modelPricing.js';
import type { LLMOptions, Message, MessageContent } from '../types/index.js';

// Log levels
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

// Log entry structure
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  levelName: string;
  category: string;
  message: string;
  metadata?: Record<string, unknown>;
  requestId?: string;
  // Populated from either (a) the AsyncLocalStorage request context set by
  // the auth middleware, or (b) the RequestContext map when a requestId is
  // explicitly passed. Lets admins grep `userId=abc123` across the log
  // stream to see every step a given user triggered.
  userId?: string;
  // Display name (or email fallback) for the same user. Logged alongside
  // userId so terminal output shows `[user:abc12345 Kenny]` and operators
  // can scan logs without an id-to-name lookup.
  userName?: string;
  duration?: number;
}

// LLM usage tracking
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  provider: string;
  cost: number;
  duration: number;
  status: 'success' | 'error';
  /**
   * Resolved at logLLMCall time from the active agent stack on the request.
   * Lets the REQUEST SUMMARY show per-agent token/cost totals so we can see
   * how much each sub-agent (e.g. ResumeParseAgent vs ResumeSemanticTagAgent)
   * is contributing inside a parent flow.
   */
  agentName?: string | null;
  requestMessages?: unknown[] | null;
  requestOptions?: Record<string, unknown> | null;
  responsePreview?: string | null;
  errorMessage?: string | null;
  /**
   * True when this call was routed through the user's BYOK key. Cost
   * stays at 0 in that case — the user's external provider was billed.
   */
  byok?: boolean;
  /**
   * Minutes of audio billed by the provider. Set for per-minute audio SKUs
   * (OpenAI gpt-4o-transcribe, Whisper, gpt-4o-mini-tts). When present, cost
   * is computed via calculateAudioModelCost(model, audioMinutes) instead of
   * the token formula.
   */
  audioMinutes?: number;
}

interface LogLLMCallInput {
  requestId?: string;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  duration: number;
  status?: 'success' | 'error';
  messages?: Message[];
  options?: LLMOptions | Record<string, unknown>;
  responseText?: string | null;
  errorMessage?: string | null;
  /**
   * True if this call was routed through the user's own BYOK key. When
   * true, `cost` is forced to 0 in the resulting LLMCallLog row — the
   * user's external provider was billed, not the platform.
   * See docs/prd-byok.md.
   */
  byok?: boolean;
  /**
   * Minutes of audio billed by the provider. Used by audio SKUs that price
   * per minute, not per token (OpenAI gpt-4o-transcribe, Whisper, gpt-4o-mini-tts).
   * When set, cost is calculateAudioModelCost(model, audioMinutes) and the
   * prompt/completion token fields are kept as 0 (or the model's text-token
   * output if the provider returns it) so the log row stays well-formed.
   */
  audioMinutes?: number;
  /**
   * Tavily web-search credits billed by this call (basic search = 1, advanced
   * = 2). Used by non-LLM external-API surfaces (WebSearchService) that price
   * per search credit, not per token. When set, cost is
   * calculateSearchCost(searchCredits) and the prompt/completion token fields
   * stay 0 so the log row + ApiRequestLog rollup stay well-formed.
   */
  searchCredits?: number;
  /**
   * Firecrawl pages scraped by this call. Used by the FireCrawlService (company
   * AI research deep-crawl) which prices per page, not per token. When set, cost
   * is calculateFireCrawlCost(firecrawlPages) and the token fields stay 0.
   */
  firecrawlPages?: number;
  /**
   * For `status: 'error'` only — true when the failure is a transient/retryable
   * class (connection blip, 5xx, rate limit) that `withLLMRetry` will re-run.
   * Such a failed attempt is logged at WARN, not ERROR: the operation usually
   * recovers on the next attempt, so screaming ERROR for a hiccup we self-heal
   * is misleading. The LLMCallLog row + cost accounting are written identically
   * regardless — only the console severity changes. A genuine (non-transient)
   * or final failure still logs at ERROR (transient omitted / false).
   */
  transient?: boolean;
}

// Request context for tracking
export interface RequestContext {
  requestId: string;
  userId?: string;
  userName?: string;
  startTime: number;
  endpoint: string;
  method: string;
  steps: StepLog[];
  llmCalls: LLMUsage[];
  totalCost: number;
  totalTokens: number;
  endTime?: number;
  duration?: number;
  status?: 'success' | 'error';
  statusCode?: number;
}

export interface RequestUsageSnapshot {
  requestId: string;
  userId?: string;
  endpoint: string;
  method: string;
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  totalCost: number;
  lastModel: string | null;
  lastProvider: string | null;
  llmCallsCount: number;
  llmCalls: LLMUsage[];
  startedAt: string;
  endedAt?: string;
  status?: 'success' | 'error';
  statusCode?: number;
}

// Step logging
export interface StepLog {
  step: number;
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'started' | 'completed' | 'failed';
  metadata?: Record<string, unknown>;
}

class LoggerService extends EventEmitter {
  private readonly maxLoggedPromptChars = 12000;
  private readonly maxLoggedResponseChars = 12000;
  private readonly maxLoggedUrlChars = 1000;
  private logLevel: LogLevel;
  private requestContexts: Map<string, RequestContext> = new Map();
  private completedRequestContexts: Map<string, { context: RequestContext; completedAt: number }> = new Map();
  // userId → display name cache. Populated when auth middleware resolves
  // req.user; consulted by `log()` so background callers (matchingAudit,
  // batch imports) that only know the userId still get the name rendered
  // in their log lines without having to thread it through every call site.
  // Bounded by `userNameCacheMaxSize` with FIFO eviction.
  private userNameCache: Map<string, string> = new Map();
  private readonly userNameCacheMaxSize = 1000;
  // Active-agent stack per requestId. BaseAgent pushes its name on execute()
  // entry and pops in finally; logLLMCall reads the top to attribute the
  // call to the leaf agent. Cleared when endRequest finalizes.
  private agentStacks: Map<string, string[]> = new Map();
  // Always-on per-request LLM cost tally. Unlike `requestContexts` (which is
  // only created by startRequest, and skipped for audit-skipped RoboApply
  // routes), this is written UNCONDITIONALLY by logLLMCall keyed by the
  // effective requestId. It lets writeDeductionLog attribute a REAL cost to
  // RoboApply feature debits even though those routes are audit-skipped.
  // Bounded by costTallyMax (FIFO eviction) + costTallyTtlMs prune. No
  // poll-noise leak: only logLLMCall writes, so no-LLM polls never create an
  // entry. See lib/deductionCost.ts + docs/roboapply-admin-billing.
  private costTallies: Map<string, { promptTokens: number; completionTokens: number; totalCost: number; lastModel: string | null; lastProvider: string | null; llmCalls: number; at: number }> = new Map();
  private readonly costTallyMax = 5000;
  private readonly costTallyTtlMs = 30 * 60_000; // 30 min
  private readonly snapshotTtlMs = 6 * 60 * 60 * 1000; // 6 hours
  private globalStats = {
    totalRequests: 0,
    totalLLMCalls: 0,
    totalTokens: 0,
    totalCost: 0,
    totalDuration: 0,
  };

  // File logging
  private logDir: string;
  private currentDate: string;
  private allLogStream: fs.WriteStream | null = null;
  private errorLogStream: fs.WriteStream | null = null;
  private llmLogStream: fs.WriteStream | null = null;
  private requestLogStream: fs.WriteStream | null = null;
  private fileLoggingEnabled: boolean;

  constructor() {
    super();
    // Local dev defaults to DEBUG so agent prepare/parse traces and per-call
    // LLM lines are visible in the terminal without having to remember a
    // LOG_LEVEL=DEBUG flag. Prod stays at INFO. An explicit LOG_LEVEL env
    // value still wins (e.g. LOG_LEVEL=WARN to quiet the dev server).
    const defaultLevel = process.env.NODE_ENV === 'production' ? 'INFO' : 'DEBUG';
    this.logLevel = this.parseLogLevel(process.env.LOG_LEVEL || defaultLevel);
    // No file logging on Vercel: /var/task (the cwd) is read-only, so the
    // mkdir below crashed the serverless function at module load (this class
    // is constructed at import time). Console output is captured by Vercel's
    // log drain anyway — file streams add nothing there.
    this.fileLoggingEnabled = process.env.FILE_LOGGING !== 'false' && !process.env.VERCEL;
    this.logDir = process.env.LOG_DIR || path.join(process.cwd(), 'logs');
    this.currentDate = this.getDateString();

    if (this.fileLoggingEnabled) {
      try {
        this.initializeLogFiles();
      } catch (err) {
        // A logger that can't open its files must never take the app down —
        // degrade to console-only (still captured by any platform log drain).
        this.fileLoggingEnabled = false;
        console.warn(
          `LoggerService: file logging disabled (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  private getDateString(): string {
    return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  }

  private initializeLogFiles(): void {
    // Create logs directory if it doesn't exist
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }

    this.openLogStreams();
    console.log(`📁 Log files initialized in: ${this.logDir}`);
  }

  private openLogStreams(): void {
    const date = this.currentDate;
    const flags = { flags: 'a' as const }; // Append mode

    this.allLogStream = fs.createWriteStream(
      path.join(this.logDir, `all-${date}.jsonl`),
      flags
    );
    
    this.errorLogStream = fs.createWriteStream(
      path.join(this.logDir, `error-${date}.jsonl`),
      flags
    );
    
    this.llmLogStream = fs.createWriteStream(
      path.join(this.logDir, `llm-${date}.jsonl`),
      flags
    );
    
    this.requestLogStream = fs.createWriteStream(
      path.join(this.logDir, `requests-${date}.jsonl`),
      flags
    );
  }

  private checkDateRotation(): void {
    const today = this.getDateString();
    if (today !== this.currentDate) {
      // Close existing streams
      this.closeLogStreams();
      
      // Update date and open new streams
      this.currentDate = today;
      this.openLogStreams();
      
      console.log(`📁 Log files rotated for: ${today}`);
    }
  }

  private closeLogStreams(): void {
    this.allLogStream?.end();
    this.errorLogStream?.end();
    this.llmLogStream?.end();
    this.requestLogStream?.end();
  }

  private writeToFile(stream: fs.WriteStream | null, entry: object): void {
    if (!this.fileLoggingEnabled || !stream) return;
    
    this.checkDateRotation();
    
    try {
      stream.write(JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  // Get log file paths
  getLogFilePaths(): { all: string; error: string; llm: string; requests: string } {
    const date = this.currentDate;
    return {
      all: path.join(this.logDir, `all-${date}.jsonl`),
      error: path.join(this.logDir, `error-${date}.jsonl`),
      llm: path.join(this.logDir, `llm-${date}.jsonl`),
      requests: path.join(this.logDir, `requests-${date}.jsonl`),
    };
  }

  // Get log directory
  getLogDirectory(): string {
    return this.logDir;
  }

  // Graceful shutdown
  shutdown(): void {
    this.closeLogStreams();
    console.log('📁 Log streams closed');
  }

  private parseLogLevel(level: string): LogLevel {
    switch (level.toUpperCase()) {
      case 'DEBUG': return LogLevel.DEBUG;
      case 'INFO': return LogLevel.INFO;
      case 'WARN': return LogLevel.WARN;
      case 'ERROR': return LogLevel.ERROR;
      default: return LogLevel.INFO;
    }
  }

  setLogLevel(level: string | LogLevel): void {
    const nextLevel = typeof level === 'string' ? this.parseLogLevel(level) : level;
    this.logLevel = nextLevel;
  }

  getLogLevel(): LogLevel {
    return this.logLevel;
  }

  getLogLevelName(): string {
    return this.getLevelName(this.logLevel);
  }

  private formatTimestamp(): string {
    return new Date().toISOString();
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(0)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60000).toFixed(2)}min`;
  }

  private truncateForLog(text: string, maxChars: number): { value: string; truncated: boolean; originalLength: number } {
    if (text.length <= maxChars) {
      return { value: text, truncated: false, originalLength: text.length };
    }

    return {
      value: `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`,
      truncated: true,
      originalLength: text.length,
    };
  }

  private sanitizeMessageContent(content: MessageContent): unknown[] {
    const parts = Array.isArray(content)
      ? content
      : [{ type: 'text' as const, text: content }];

    return parts.map((part) => {
      if (part.type === 'text') {
        const truncated = this.truncateForLog(part.text, this.maxLoggedPromptChars);
        return {
          type: 'text',
          text: truncated.value,
          originalLength: truncated.originalLength,
          truncated: truncated.truncated,
        };
      }

      const url = part.image_url.url || '';
      if (url.startsWith('data:')) {
        const mimeType = url.match(/^data:([^;,]+)/)?.[1] || 'application/octet-stream';
        return {
          type: 'image_url',
          image_url: {
            url: `[redacted data URI: ${mimeType}]`,
            mimeType,
            originalLength: url.length,
            redacted: true,
          },
        };
      }

      const truncated = this.truncateForLog(url, this.maxLoggedUrlChars);
      return {
        type: 'image_url',
        image_url: {
          url: truncated.value,
          originalLength: truncated.originalLength,
          truncated: truncated.truncated,
          redacted: false,
        },
      };
    });
  }

  private sanitizeMessages(messages?: Message[]): unknown[] | null {
    if (!messages || messages.length === 0) return null;

    return messages.map((message) => ({
      role: message.role,
      content: this.sanitizeMessageContent(message.content),
    }));
  }

  private sanitizeOptions(options?: LLMOptions | Record<string, unknown>): Record<string, unknown> | null {
    if (!options) return null;

    const cleanedEntries = Object.entries(options)
      .filter(([key, value]) => key !== 'requestId' && key !== 'signal' && value !== undefined)
      .map(([key, value]) => {
        if (typeof value === 'string') {
          const truncated = this.truncateForLog(value, this.maxLoggedUrlChars);
          return [key, truncated.value];
        }
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
          return [key, value];
        }
        if (Array.isArray(value)) {
          return [key, value.slice(0, 20)];
        }
        return [key, String(value)];
      });

    if (cleanedEntries.length === 0) return null;
    return Object.fromEntries(cleanedEntries);
  }

  private getLevelName(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG: return 'DEBUG';
      case LogLevel.INFO: return 'INFO';
      case LogLevel.WARN: return 'WARN';
      case LogLevel.ERROR: return 'ERROR';
      default: return 'UNKNOWN';
    }
  }

  private getLevelColor(level: LogLevel): string {
    switch (level) {
      case LogLevel.DEBUG: return '\x1b[36m'; // Cyan
      case LogLevel.INFO: return '\x1b[32m';  // Green
      case LogLevel.WARN: return '\x1b[33m';  // Yellow
      case LogLevel.ERROR: return '\x1b[31m'; // Red
      default: return '\x1b[0m';
    }
  }

  private pruneCompletedRequestContexts(): void {
    const now = Date.now();
    for (const [requestId, snapshot] of this.completedRequestContexts.entries()) {
      if (now - snapshot.completedAt > this.snapshotTtlMs) {
        this.completedRequestContexts.delete(requestId);
      }
    }
    this.pruneCostTallies(now);
  }

  // ── Always-on per-request LLM cost tally ──────────────────────────────────
  // Accumulates token + USD cost per requestId regardless of whether a full
  // request context exists. Used by lib/deductionCost.ts to stamp a real
  // platformCostUsd onto RoboApply / cron deduction rows.

  private tallyCost(
    requestId: string,
    promptTokens: number,
    completionTokens: number,
    cost: number,
    model: string | null,
    provider: string | null,
  ): void {
    if (!requestId) return;
    const existing = this.costTallies.get(requestId);
    if (existing) {
      existing.promptTokens += promptTokens;
      existing.completionTokens += completionTokens;
      existing.totalCost += cost;
      existing.lastModel = model ?? existing.lastModel;
      existing.lastProvider = provider ?? existing.lastProvider;
      existing.llmCalls += 1;
      existing.at = Date.now();
      return;
    }
    // FIFO-evict the oldest entry when at capacity (Map preserves insertion order).
    if (this.costTallies.size >= this.costTallyMax) {
      const oldestKey = this.costTallies.keys().next().value;
      if (oldestKey !== undefined) this.costTallies.delete(oldestKey);
    }
    this.costTallies.set(requestId, {
      promptTokens,
      completionTokens,
      totalCost: cost,
      lastModel: model ?? null,
      lastProvider: provider ?? null,
      llmCalls: 1,
      at: Date.now(),
    });
  }

  private pruneCostTallies(now: number): void {
    for (const [requestId, tally] of this.costTallies.entries()) {
      if (now - tally.at > this.costTallyTtlMs) this.costTallies.delete(requestId);
    }
  }

  /** Read the accumulated LLM cost + tokens for a requestId, or null if none. */
  getRequestCostTally(requestId: string | null | undefined): {
    costUsd: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string | null;
    provider: string | null;
    llmCalls: number;
  } | null {
    if (!requestId) return null;
    const t = this.costTallies.get(requestId);
    if (!t) return null;
    return {
      costUsd: t.totalCost,
      promptTokens: t.promptTokens,
      completionTokens: t.completionTokens,
      totalTokens: t.promptTokens + t.completionTokens,
      model: t.lastModel,
      provider: t.lastProvider,
      llmCalls: t.llmCalls,
    };
  }

  /** Drop a requestId's tally (call after reading it for a cron unit so the
   *  map doesn't retain per-unit entries longer than needed). */
  clearRequestCostTally(requestId: string | null | undefined): void {
    if (!requestId) return;
    this.costTallies.delete(requestId);
  }

  /**
   * Fold a pre-aggregated LLM-usage figure into a parent request — its context
   * (so the REQUEST SUMMARY + requestAudit ApiRequestLog roll-up stay correct)
   * AND its always-on cost tally. Used when sub-work ran under a CHILD requestId
   * (e.g. the parallel Eval-V3 evaluators, isolated for accurate per-stage cost)
   * and must be re-attributed to the parent for billing/analytics.
   *
   * Does NOT touch globalStats — the underlying calls already counted there when
   * they were logged under the child id. Idempotency is the caller's concern
   * (read the child tally once, fold once, then clearRequestCostTally(child)).
   */
  recordAggregateCall(
    requestId: string | undefined,
    agentName: string,
    m: { promptTokens: number; completionTokens: number; cost: number; model: string | null; provider: string | null },
  ): void {
    if (!requestId) return;
    const totalTokens = m.promptTokens + m.completionTokens;
    // Parent cost tally (always-on, used by writeDeductionLog / cron units).
    this.tallyCost(requestId, m.promptTokens, m.completionTokens, m.cost, m.model, m.provider);
    // Parent request context (when one exists) — append a synthetic call so the
    // snapshot's per-agent rollup + totals include this sub-work.
    const ctx = this.requestContexts.get(requestId) ?? this.completedRequestContexts.get(requestId)?.context;
    if (!ctx) return;
    ctx.llmCalls.push({
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      totalTokens,
      model: m.model ?? 'aggregate',
      provider: m.provider ?? 'aggregate',
      cost: m.cost,
      duration: 0,
      status: 'success',
      agentName,
    });
    ctx.totalTokens += totalTokens;
    ctx.totalCost += m.cost;
  }

  private log(level: LogLevel, category: string, message: string, metadata?: Record<string, unknown>, requestId?: string): void {
    if (level < this.logLevel) return;

    const effectiveRequestId = requestId || getCurrentRequestId() || undefined;
    // Resolve userId: prefer the per-request context stored in the logger
    // (set by setRequestUserId when auth ran), otherwise fall back to the
    // AsyncLocalStorage user. Metadata.userId wins if the caller passed it
    // explicitly.
    const contextUserId = effectiveRequestId
      ? this.requestContexts.get(effectiveRequestId)?.userId
      : undefined;
    const alsUserId = getCurrentUserId();
    const metaUserId = metadata && typeof metadata.userId === 'string' ? (metadata.userId as string) : undefined;
    const effectiveUserId = metaUserId || contextUserId || alsUserId || undefined;

    // Resolve userName with the same precedence as userId, then fall back
    // to the userId→name cache so background callers that only set the id
    // still get a name on the log line.
    const contextUserName = effectiveRequestId
      ? this.requestContexts.get(effectiveRequestId)?.userName
      : undefined;
    const alsUserName = getCurrentUserName();
    const metaUserName = metadata && typeof metadata.userName === 'string' ? (metadata.userName as string) : undefined;
    const cachedUserName = effectiveUserId ? this.userNameCache.get(effectiveUserId) : undefined;
    const effectiveUserName = metaUserName || contextUserName || alsUserName || cachedUserName || undefined;

    const entry: LogEntry = {
      timestamp: this.formatTimestamp(),
      level,
      levelName: this.getLevelName(level),
      category,
      message,
      metadata,
      requestId: effectiveRequestId,
      ...(effectiveUserId ? { userId: effectiveUserId } : {}),
      ...(effectiveUserName ? { userName: effectiveUserName } : {}),
    };

    // Console output with colors
    const color = this.getLevelColor(level);
    const reset = '\x1b[0m';
    const dim = '\x1b[2m';

    let logLine = `${dim}[${entry.timestamp}]${reset} ${color}[${entry.levelName}]${reset} ${dim}[${category}]${reset}`;

    if (effectiveRequestId) {
      logLine += ` ${dim}(${effectiveRequestId.substring(0, 8)})${reset}`;
    }
    if (effectiveUserId) {
      const namePart = effectiveUserName ? ` ${effectiveUserName}` : '';
      logLine += ` ${dim}[user:${effectiveUserId.substring(0, 8)}${namePart}]${reset}`;
    }

    logLine += ` ${message}`;

    if (metadata && Object.keys(metadata).length > 0) {
      // Format metadata nicely
      const metaStr = Object.entries(metadata)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' | ');
      logLine += ` ${dim}{ ${metaStr} }${reset}`;
    }

    console.log(logLine);

    // Write to all log file
    this.writeToFile(this.allLogStream, entry);

    // Write errors to error log file
    if (level >= LogLevel.ERROR) {
      this.writeToFile(this.errorLogStream, entry);
    }

    // Emit event for external log handlers
    this.emit('log', entry);
  }

  /**
   * Attach a userId (and optionally a display name) to an active request
   * context. Called from the auth middleware once `req.user` is resolved.
   * After this, every log line emitted with the same requestId (or within
   * the same ALS context) carries userId automatically. When `userName` is
   * provided it's also stored in the userId→name cache so background
   * callers that only set the id later still render the name.
   */
  setRequestUserId(requestId: string, userId: string, userName?: string): void {
    const ctx = this.requestContexts.get(requestId);
    if (ctx) {
      ctx.userId = userId;
      if (userName) ctx.userName = userName;
    }
    if (userName) this.cacheUserName(userId, userName);
  }

  /**
   * Attach a display name to an active request context. If the context
   * already has a userId, the name is also written to the userId→name
   * cache so subsequent background log lines for the same user pick it up.
   */
  setRequestUserName(requestId: string, userName: string): void {
    if (!userName) return;
    const ctx = this.requestContexts.get(requestId);
    if (ctx) {
      ctx.userName = userName;
      if (ctx.userId) this.cacheUserName(ctx.userId, userName);
    }
  }

  private cacheUserName(userId: string, userName: string): void {
    // FIFO eviction when the cache is full. Map iteration order is
    // insertion order, so the first key is the oldest. Re-set on hit to
    // refresh recency.
    if (this.userNameCache.has(userId)) {
      this.userNameCache.delete(userId);
    } else if (this.userNameCache.size >= this.userNameCacheMaxSize) {
      const firstKey = this.userNameCache.keys().next().value;
      if (firstKey !== undefined) this.userNameCache.delete(firstKey);
    }
    this.userNameCache.set(userId, userName);
  }

  // Public logging methods
  debug(category: string, message: string, metadata?: Record<string, unknown>, requestId?: string): void {
    this.log(LogLevel.DEBUG, category, message, metadata, requestId);
  }

  info(category: string, message: string, metadata?: Record<string, unknown>, requestId?: string): void {
    this.log(LogLevel.INFO, category, message, metadata, requestId);
  }

  warn(category: string, message: string, metadata?: Record<string, unknown>, requestId?: string): void {
    this.log(LogLevel.WARN, category, message, metadata, requestId);
  }

  error(category: string, message: string, metadata?: Record<string, unknown>, requestId?: string): void {
    this.log(LogLevel.ERROR, category, message, metadata, requestId);
  }

  // Request tracking
  startRequest(requestId: string, endpoint: string, method: string): RequestContext {
    const existing = this.requestContexts.get(requestId);
    if (existing) {
      return existing;
    }

    const completed = this.completedRequestContexts.get(requestId);
    if (completed) {
      return completed.context;
    }

    const context: RequestContext = {
      requestId,
      startTime: Date.now(),
      endpoint,
      method,
      steps: [],
      llmCalls: [],
      totalCost: 0,
      totalTokens: 0,
    };

    this.requestContexts.set(requestId, context);
    this.globalStats.totalRequests++;

    this.info('REQUEST', `▶ Started: ${method} ${endpoint}`, {
      requestId: requestId.substring(0, 8),
    }, requestId);

    return context;
  }

  endRequest(requestId: string, status: 'success' | 'error', statusCode?: number): void {
    this.pruneCompletedRequestContexts();

    const context = this.requestContexts.get(requestId);
    if (!context) return;

    const duration = Date.now() - context.startTime;
    context.endTime = Date.now();
    context.duration = duration;
    context.status = status;
    context.statusCode = statusCode;
    this.globalStats.totalDuration += duration;

    const symbol = status === 'success' ? '✓' : '✗';
    const logMethod = status === 'success' ? 'info' : 'error';

    this[logMethod]('REQUEST', `${symbol} Completed: ${context.method} ${context.endpoint}`, {
      status,
      statusCode,
      duration: this.formatDuration(duration),
      steps: context.steps.length,
      llmCalls: context.llmCalls.length,
      totalTokens: context.totalTokens,
      totalCost: `$${context.totalCost.toFixed(6)}`,
    }, requestId);

    // Log summary
    this.logRequestSummary(context, duration);

    this.completedRequestContexts.set(requestId, {
      context: { ...context, llmCalls: [...context.llmCalls], steps: [...context.steps] },
      completedAt: Date.now(),
    });
    this.requestContexts.delete(requestId);
    this.agentStacks.delete(requestId);
  }

  private logRequestSummary(context: RequestContext, totalDuration: number): void {
    // Skip the boxed console summary ONLY for trivial GET reads (list endpoints
    // like GET /interviews with no steps + no LLM calls). ALWAYS print it for
    // mutations (POST/PUT/PATCH/DELETE — resume match, evaluate, rerun, …) even
    // when their LLM calls were logged under a CHILD request context (so the
    // parent shows llmCalls=0) — those must stay visible. The request-log FILE
    // below is written either way for the audit trail.
    const hasDetail = context.steps.length > 0 || context.llmCalls.length > 0;
    const isTrivialRead = !hasDetail && context.method === 'GET';
    if (!isTrivialRead) {
    console.log('\n' + '─'.repeat(80));
    console.log(`📊 REQUEST SUMMARY [${context.requestId.substring(0, 8)}]`);
    console.log('─'.repeat(80));
    console.log(`   Endpoint:      ${context.method} ${context.endpoint}`);
    console.log(`   Total Duration: ${this.formatDuration(totalDuration)}`);
    console.log(`   Steps:         ${context.steps.length}`);
    console.log(`   LLM Calls:     ${context.llmCalls.length}`);
    
    if (context.llmCalls.length > 0) {
      console.log('\n   📈 LLM Usage:');
      context.llmCalls.forEach((call, i) => {
        const agentTag = call.agentName ? ` <${call.agentName}>` : '';
        console.log(`      [${i + 1}] ${call.model}${agentTag} (${call.status})`);
        console.log(`          Tokens: ${call.promptTokens} in / ${call.completionTokens} out = ${call.totalTokens} total`);
        console.log(`          Cost:   $${call.cost.toFixed(6)}`);
        console.log(`          Time:   ${this.formatDuration(call.duration)}`);
        if (call.errorMessage) {
          console.log(`          Error:  ${call.errorMessage}`);
        }
      });

      // Per-agent rollup. Lets the dev see "ResumeParseAgent: 4 calls,
      // 12345 tokens, $0.0023" instead of having to hand-add the per-call
      // numbers above. Calls without a captured agent name fall under
      // "(unattributed)" so nothing silently drops out of the totals.
      const byAgent = new Map<string, { calls: number; promptTokens: number; completionTokens: number; totalTokens: number; cost: number; duration: number }>();
      for (const call of context.llmCalls) {
        const key = call.agentName || '(unattributed)';
        const slot = byAgent.get(key) ?? { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0, duration: 0 };
        slot.calls += 1;
        slot.promptTokens += call.promptTokens;
        slot.completionTokens += call.completionTokens;
        slot.totalTokens += call.totalTokens;
        slot.cost += call.cost;
        slot.duration += call.duration;
        byAgent.set(key, slot);
      }
      if (byAgent.size > 0) {
        const rows = Array.from(byAgent.entries()).sort((a, b) => b[1].cost - a[1].cost);
        console.log('\n   🤖 Agent Totals:');
        for (const [name, slot] of rows) {
          console.log(`      • ${name}: ${slot.calls} call${slot.calls === 1 ? '' : 's'} · ${slot.totalTokens} tokens (${slot.promptTokens} in / ${slot.completionTokens} out) · $${slot.cost.toFixed(6)} · ${this.formatDuration(slot.duration)}`);
        }
      }

      console.log(`\n   💰 Total Cost:   $${context.totalCost.toFixed(6)}`);
      console.log(`   🔢 Total Tokens: ${context.totalTokens}`);
    }

    if (context.steps.length > 0) {
      console.log('\n   📋 Steps:');
      context.steps.forEach((step) => {
        const statusIcon = step.status === 'completed' ? '✓' : step.status === 'failed' ? '✗' : '○';
        const duration = step.duration ? this.formatDuration(step.duration) : 'N/A';
        console.log(`      [${step.step}] ${statusIcon} ${step.name} (${duration})`);
      });
    }

    console.log('─'.repeat(80) + '\n');
    }

    // Write to dedicated request log file (always — audit trail).
    this.writeToFile(this.requestLogStream, {
      timestamp: this.formatTimestamp(),
      requestId: context.requestId,
      endpoint: context.endpoint,
      method: context.method,
      status: context.status,
      statusCode: context.statusCode,
      duration: totalDuration,
      formattedDuration: this.formatDuration(totalDuration),
      stepsCount: context.steps.length,
      llmCallsCount: context.llmCalls.length,
      totalTokens: context.totalTokens,
      totalCost: context.totalCost,
      formattedCost: `$${context.totalCost.toFixed(6)}`,
      steps: context.steps.map(s => ({
        step: s.step,
        name: s.name,
        status: s.status,
        duration: s.duration,
      })),
      llmCalls: context.llmCalls.map(c => ({
        status: c.status,
        agentName: c.agentName ?? null,
        model: c.model,
        provider: c.provider,
        promptTokens: c.promptTokens,
        completionTokens: c.completionTokens,
        totalTokens: c.totalTokens,
        cost: c.cost,
        duration: c.duration,
        errorMessage: c.errorMessage,
      })),
    });
  }

  // Step tracking
  startStep(requestId: string, stepName: string): number {
    const context = this.requestContexts.get(requestId);
    if (!context) return 0;

    const stepNumber = context.steps.length + 1;
    const step: StepLog = {
      step: stepNumber,
      name: stepName,
      startTime: Date.now(),
      status: 'started',
    };

    context.steps.push(step);

    this.debug('STEP', `[${stepNumber}] Started: ${stepName}`, undefined, requestId);

    return stepNumber;
  }

  endStep(requestId: string, stepNumber: number, status: 'completed' | 'failed' = 'completed', metadata?: Record<string, unknown>): void {
    const context = this.requestContexts.get(requestId);
    if (!context) return;

    const step = context.steps.find(s => s.step === stepNumber);
    if (!step) return;

    step.endTime = Date.now();
    step.duration = step.endTime - step.startTime;
    step.status = status;
    step.metadata = metadata;

    const symbol = status === 'completed' ? '✓' : '✗';
    this.debug('STEP', `[${stepNumber}] ${symbol} ${step.name}`, {
      duration: this.formatDuration(step.duration),
      ...metadata,
    }, requestId);
  }

  // LLM call tracking
  logLLMCall(input: LogLLMCallInput): LLMUsage {
    const effectiveRequestId = input.requestId || getCurrentRequestId() || `untracked_${Date.now()}`;
    const status = input.status || 'success';
    const promptTokens = input.promptTokens;
    const completionTokens = input.completionTokens;
    const totalTokens = promptTokens + completionTokens;
    // BYOK calls run on the user's own provider account — platform pays
    // nothing, so don't roll any model cost into the per-request totals
    // (would inflate admin "platform spend" analytics).
    const isByok = input.byok === true;
    const audioMinutes = typeof input.audioMinutes === 'number' && input.audioMinutes > 0
      ? input.audioMinutes
      : undefined;
    const searchCredits = typeof input.searchCredits === 'number' && input.searchCredits > 0
      ? input.searchCredits
      : undefined;
    const firecrawlPages = typeof input.firecrawlPages === 'number' && input.firecrawlPages > 0
      ? input.firecrawlPages
      : undefined;
    const cost = isByok
      ? 0
      : audioMinutes !== undefined
        ? calculateAudioModelCost(input.model, audioMinutes)
        : searchCredits !== undefined
          ? calculateSearchCost(searchCredits)
          : firecrawlPages !== undefined
            ? calculateFireCrawlCost(firecrawlPages)
            : this.calculateCost(input.model, promptTokens, completionTokens);
    const responsePreview = input.responseText
      ? this.truncateForLog(input.responseText, this.maxLoggedResponseChars).value
      : null;
    const errorMessage = input.errorMessage
      ? this.truncateForLog(input.errorMessage, this.maxLoggedResponseChars).value
      : null;
    const agentName = this.getCurrentAgentName(effectiveRequestId);

    const usage: LLMUsage = {
      promptTokens,
      completionTokens,
      totalTokens,
      model: input.model,
      provider: input.provider,
      cost,
      duration: input.duration,
      status,
      agentName: agentName ?? null,
      requestMessages: this.sanitizeMessages(input.messages),
      requestOptions: this.sanitizeOptions(input.options),
      responsePreview,
      errorMessage,
      byok: isByok,
      audioMinutes,
    };

    const context = this.requestContexts.get(effectiveRequestId);
    if (context) {
      context.llmCalls.push(usage);
      context.totalCost += cost;
      context.totalTokens += totalTokens;
    }

    // Always-on cost tally (independent of the request context) so
    // audit-skipped routes (RoboApply) and cron units still get an accurate
    // per-request cost for their deduction rows.
    this.tallyCost(effectiveRequestId, promptTokens, completionTokens, cost, input.model, input.provider);

    this.globalStats.totalLLMCalls++;
    this.globalStats.totalTokens += totalTokens;
    this.globalStats.totalCost += cost;

    // Recovered-by-retry transients log at WARN, not ERROR — the operation
    // self-heals on the next attempt, so an ERROR here is a false alarm. Real
    // (non-transient) and final failures stay ERROR. Success stays INFO.
    const logMethod = status === 'success' ? 'info' : input.transient ? 'warn' : 'error';
    this[logMethod]('LLM', status === 'success' ? 'API call completed' : input.transient ? 'API call failed (transient — will retry)' : 'API call failed', {
      ...(agentName ? { agent: agentName } : {}),
      model: input.model,
      provider: input.provider,
      status,
      tokens: `${promptTokens}/${completionTokens}/${totalTokens}`,
      ...(audioMinutes !== undefined ? { audioMinutes: audioMinutes.toFixed(3) } : {}),
      cost: `$${cost.toFixed(6)}`,
      duration: this.formatDuration(input.duration),
      error: errorMessage || undefined,
    }, effectiveRequestId);

    this.writeToFile(this.llmLogStream, {
      timestamp: this.formatTimestamp(),
      requestId: effectiveRequestId,
      ...usage,
      formattedCost: `$${cost.toFixed(6)}`,
      formattedDuration: this.formatDuration(input.duration),
    });

    return usage;
  }

  calculateCost(model: string, promptTokens: number, completionTokens: number): number {
    return calculateModelCost(model, promptTokens, completionTokens);
  }

  // ── Agent attribution stack ───────────────────────────────────────────
  // BaseAgent pushes its name on execute() entry and pops in a finally so
  // logLLMCall can attribute each LLM call to the *leaf* agent in the stack.
  // No-op when requestId is missing — keeps the call sites single-path.
  pushAgent(requestId: string | undefined, agentName: string): void {
    if (!requestId) return;
    let stack = this.agentStacks.get(requestId);
    if (!stack) {
      stack = [];
      this.agentStacks.set(requestId, stack);
    }
    stack.push(agentName);
  }

  popAgent(requestId: string | undefined): void {
    if (!requestId) return;
    const stack = this.agentStacks.get(requestId);
    if (!stack) return;
    stack.pop();
    if (stack.length === 0) this.agentStacks.delete(requestId);
  }

  getCurrentAgentName(requestId: string | undefined): string | undefined {
    if (!requestId) return undefined;
    const stack = this.agentStacks.get(requestId);
    return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
  }

  // Agent logging
  logAgentStart(requestId: string, agentName: string, input: Record<string, unknown>): void {
    this.info('AGENT', `🤖 ${agentName} started`, {
      inputSize: JSON.stringify(input).length,
    }, requestId);
  }

  logAgentEnd(requestId: string, agentName: string, success: boolean, outputSize?: number): void {
    const symbol = success ? '✓' : '✗';
    this.info('AGENT', `${symbol} ${agentName} completed`, {
      success,
      outputSize,
    }, requestId);
  }

  // PDF parsing logging
  logPDFParse(requestId: string, fileSize: number, extractedChars: number, duration: number): void {
    this.info('PDF', `Parsed PDF document`, {
      fileSize: `${(fileSize / 1024).toFixed(1)}KB`,
      extractedChars,
      duration: this.formatDuration(duration),
    }, requestId);
  }

  // Language detection logging
  logLanguageDetection(requestId: string, detectedLanguage: string, confidence: string): void {
    this.debug('LANGUAGE', `Detected language: ${detectedLanguage}`, {
      confidence,
    }, requestId);
  }

  /**
   * Return aggregated token/cost data for a request so the usage tracker
   * middleware can persist it to the database.
   */
  getRequestContext(requestId: string): {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    totalCost: number;
    lastModel: string | null;
    lastProvider: string | null;
  } | null {
    const snapshot = this.getRequestSnapshot(requestId);
    if (!snapshot) return null;

    return {
      promptTokens: snapshot.promptTokens,
      completionTokens: snapshot.completionTokens,
      totalTokens: snapshot.totalTokens,
      totalCost: snapshot.totalCost,
      lastModel: snapshot.lastModel,
      lastProvider: snapshot.lastProvider,
    };
  }

  hasActiveRequestContext(requestId: string): boolean {
    return this.requestContexts.has(requestId);
  }

  getRequestSnapshot(requestId: string): RequestUsageSnapshot | null {
    this.pruneCompletedRequestContexts();

    const ctx = this.requestContexts.get(requestId) ?? this.completedRequestContexts.get(requestId)?.context;
    if (!ctx) return null;

    let promptTokens = 0;
    let completionTokens = 0;
    let lastModel: string | null = null;
    let lastProvider: string | null = null;

    for (const call of ctx.llmCalls) {
      promptTokens += call.promptTokens;
      completionTokens += call.completionTokens;
      lastModel = call.model;
      lastProvider = call.provider;
    }

    const now = Date.now();
    const durationMs = ctx.duration ?? ((ctx.endTime ?? now) - ctx.startTime);

    return {
      requestId: ctx.requestId,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      endpoint: ctx.endpoint,
      method: ctx.method,
      durationMs,
      promptTokens,
      completionTokens,
      totalTokens: ctx.totalTokens,
      totalCost: ctx.totalCost,
      lastModel,
      lastProvider,
      llmCallsCount: ctx.llmCalls.length,
      llmCalls: [...ctx.llmCalls],
      startedAt: new Date(ctx.startTime).toISOString(),
      endedAt: ctx.endTime ? new Date(ctx.endTime).toISOString() : undefined,
      status: ctx.status,
      statusCode: ctx.statusCode,
    };
  }

  getActiveRequestSnapshots(): RequestUsageSnapshot[] {
    this.pruneCompletedRequestContexts();

    return Array.from(this.requestContexts.keys())
      .map((requestId) => this.getRequestSnapshot(requestId))
      .filter((snapshot): snapshot is RequestUsageSnapshot => Boolean(snapshot));
  }

  // Get global statistics
  getGlobalStats(): typeof this.globalStats {
    return { ...this.globalStats };
  }

  // Print global stats summary
  printGlobalStats(): void {
    console.log('\n' + '═'.repeat(80));
    console.log('📊 GLOBAL STATISTICS');
    console.log('═'.repeat(80));
    console.log(`   Total Requests:  ${this.globalStats.totalRequests}`);
    console.log(`   Total LLM Calls: ${this.globalStats.totalLLMCalls}`);
    console.log(`   Total Tokens:    ${this.globalStats.totalTokens.toLocaleString()}`);
    console.log(`   Total Cost:      $${this.globalStats.totalCost.toFixed(4)}`);
    console.log(`   Total Duration:  ${this.formatDuration(this.globalStats.totalDuration)}`);
    if (this.globalStats.totalRequests > 0) {
      console.log(`   Avg per Request: ${this.formatDuration(this.globalStats.totalDuration / this.globalStats.totalRequests)}`);
    }
    console.log('═'.repeat(80) + '\n');
  }
}

// Singleton instance
export const logger = new LoggerService();

// Request ID generator
/**
 * Always returns a FRESH unique id. Do NOT inherit from AsyncLocalStorage —
 * doing so silently aliases fire-and-forget background work (`void (async
 * () => {})()`) onto its parent Express request. The parent request gets
 * `endRequest()`'d before the background LLM call lands, so `logLLMCall`
 * finds no live context and the call's tokens / cost vanish from both
 * `ApiRequestLog` and `LLMCallLog`. Callers that want the inherited id
 * should call `getCurrentRequestId()` explicitly first (see
 * `LLMService.chat` for the canonical pattern: explicit > ALS > fresh).
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
