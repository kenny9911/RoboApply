import pdf from 'pdf-parse';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { llmService } from './llm/LLMService.js';
import { GoogleProvider } from './llm/GoogleProvider.js';
import { withLLMRetry } from './llm/withRetry.js';
import { generateRequestId, logger } from './LoggerService.js';
import { runConcurrent } from '../utils/concurrency.js';
import { getModelSetting, getProviderSetting } from '../lib/llm/llmModels.js';
import { resolveProviderCredential } from '../lib/llm/systemCredentials.js';
import type { Message, MessageContent, ProviderExtra } from '../types/index.js';

const PDF_LLM_MAX_TOKENS = 24000;

// Silence pdf.js CFF/Type2 font-hinting warnings ("Warning: Not enough
// parameters for hstem; actual: 0, expected: 2") that flood the logs when a
// resume embeds a malformed/subsetted font — pdf-parse bundles pdf.js v1.10.100,
// whose charstring parser emits one console.log warning per broken glyph (a
// single bad upload can produce hundreds). They are benign: pdf.js recovers and
// text extraction is unaffected. Drop the warnings tier to errors-only.
//
// Node caches the build module by path, so this is the SAME singleton pdf-parse
// lazily requires on first pdf() call; the verbosity is forwarded to pdf.js's
// in-process fake worker via the 'configure' message, which is where the font
// warnings originate. Real pdf.js errors still surface (errors tier kept).
//
// NB: the UMD build's top-level export is a wrapper; the verbosity controls
// (VERBOSITY_LEVELS + the verbosity get/set) live on the nested `.PDFJS`
// namespace, which shares the one bundle-global verbosity that warn() reads.
try {
  const pdfjsBuild = createRequire(import.meta.url)('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  const ns = pdfjsBuild?.PDFJS;
  if (ns?.VERBOSITY_LEVELS) ns.verbosity = ns.VERBOSITY_LEVELS.errors;
} catch {
  // Non-fatal: if pdf-parse bundles a different pdf.js build, logs stay noisy
  // but parsing is unaffected.
}

export class PDFService {
  /**
   * Set during pdftotext extraction when the raw output has a high density of
   * short alphanumeric fragment lines — a strong signal that a watermark/tracking
   * string has been scattered across the text by pdftotext's layout engine.
   * When true, extractText() skips the early-return on quality-pass and forces
   * the LLM vision path, which handles watermarked PDFs much better.
   */
  private _watermarkScatterDetected = false;

  /** Safe multimodal model used when the resolved vision model is text-only. */
  private static readonly SAFE_VISION_FALLBACK = 'google/gemini-3-flash-preview';

  /**
   * Known TEXT-ONLY model families. Vision/OCR extraction sends image parts to
   * the model, so routing one of these here produces an API error or empty/
   * garbage content. The classic trap: the default model (LLM_MODEL) is set to a
   * text-only reasoning model like `deepseek-v4-pro`, the `vision` purpose is
   * left unset, and `getPreferredVisionModel` falls through to that default.
   * Conservative denylist — we only OVERRIDE when we're confident the model
   * can't see, so an unrecognised (possibly multimodal) model is left untouched.
   */
  private isKnownTextOnlyModel(model: string): boolean {
    const m = model.toLowerCase();
    // -vl / vision variants ARE multimodal — never treat those as text-only.
    if (m.includes('-vl') || m.includes('vision') || m.includes('omni')) return false;
    return (
      m.includes('deepseek') || // all current DeepSeek models are text-only
      m.includes('kimi') || m.includes('moonshot') || // Kimi K2 family: text-only
      /(^|\/)o[134](-|$|\b)/.test(m) // OpenAI o-series text reasoners
    );
  }

  private getPreferredVisionModel(): string | undefined {
    // DB-first resolution (mirrors the rest of the LLM-settings-DB stack):
    //   DB 'vision' purpose (admin LLM settings) ?? env LLM_VISION_MODEL   ← getModelSetting('vision')
    //   then PDF-specific env PDF_VISION_MODEL
    //   then the default model (DB defaultModel ?? env LLM_MODEL)
    // Read per-call so an admin's DB change applies without a restart. DB now
    // wins over PDF_VISION_MODEL: that env var previously overrode the DB and
    // pinned OCR to Google-direct, which a DB reroute could not fix (the
    // 2026-06-24 parse-resume outage — China deploy could not reach Google).
    // DB 'vision' purpose (admin LLM settings) ?? env LLM_VISION_MODEL. This is
    // the authoritative admin-controllable value and MUST win over the legacy
    // PDF_VISION_MODEL env var.
    const dbOrEnvVision = getModelSetting('vision');
    const pdfEnvVision = process.env.PDF_VISION_MODEL?.trim();
    // Surface the footgun: a stale PDF_VISION_MODEL on a box where an admin set
    // the vision model via DB/LLM settings is silently ignored (correct), but
    // operators must know — pinning OCR to the wrong vendor via this env was a
    // contributor to the 2026-06-24 parse-resume outage.
    if (pdfEnvVision && dbOrEnvVision && pdfEnvVision !== dbOrEnvVision) {
      logger.warn(
        'PDF_SERVICE',
        `PDF_VISION_MODEL="${pdfEnvVision}" is ignored — the admin 'vision' LLM setting "${dbOrEnvVision}" ` +
          'takes precedence. Remove PDF_VISION_MODEL or set the vision model via admin LLM settings.',
      );
    }
    const resolved = (
      dbOrEnvVision ||
      pdfEnvVision ||
      getModelSetting('defaultModel') ||
      ''
    ).trim();

    if (!resolved) return undefined;

    // Guard: never send images to a text-only model (e.g. a deepseek-v4-pro
    // default). Fall back to a multimodal model so OCR keeps working regardless
    // of what the global default / admin config points at.
    if (this.isKnownTextOnlyModel(resolved)) {
      logger.warn(
        'PDF_SERVICE',
        `Configured vision model "${resolved}" is text-only; using ${PDFService.SAFE_VISION_FALLBACK} for OCR. ` +
          'Pin a multimodal model via LLM_VISION_MODEL / the "vision" purpose in admin LLM settings.',
      );
      return PDFService.SAFE_VISION_FALLBACK;
    }

    return resolved;
  }

  /**
   * Race a promise against a timeout. Used to bound pdf-parse and other
   * library calls that have no built-in timeout and can stall on corrupt
   * PDFs, blocking the batch worker until the frontend gives up.
   */
  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  }

  private getDirectGoogleVisionProvider(model?: string): GoogleProvider | null {
    const resolvedModel = (model || this.getPreferredVisionModel() || '').trim();
    if (!resolvedModel) {
      return null;
    }

    const normalized = resolvedModel.toLowerCase();

    // Do NOT pin OCR to the raw Google-direct SDK when the platform is routing
    // through OpenRouter (LLM_PROVIDER / DB provider = openrouter) or the vision
    // model is explicitly openrouter-prefixed. Bypassing LLMService here was the
    // root cause of the 2026-06-24 parse-resume outage: an admin DB/route change
    // could not move OCR off Google-direct (the China deploy can't reach Google),
    // because this method ignored the configured provider. Returning null makes
    // runMultimodalExtraction fall through to llmService.chat, which honors the
    // configured provider + DB routing (incl. the domestic NewAPI gateway).
    if (getProviderSetting()?.toLowerCase() === 'openrouter' || normalized.startsWith('openrouter/')) {
      return null;
    }

    // Route the google credential through the 3-tier resolver (system DB key →
    // env) so an admin-configured Google system key + base URL apply to the PDF
    // vision path too — this is the only provider construction outside LLMService.
    const cred = resolveProviderCredential('google');
    if (!cred.apiKey) {
      return null;
    }

    if (!normalized.startsWith('google/') && !normalized.startsWith('gemini')) {
      return null;
    }

    const extra: ProviderExtra = {
      ...(cred.baseUrl ? { baseUrl: cred.baseUrl } : {}),
      ...(cred.tuning.proxyKey ? { proxyKey: cred.tuning.proxyKey } : {}),
      ...(cred.tuning.timeoutMs !== undefined ? { timeoutMs: cred.tuning.timeoutMs } : {}),
    };
    return new GoogleProvider(cred.apiKey, resolvedModel, extra);
  }

  private async runMultimodalExtraction(messages: Message[], requestId: string | undefined, category: string, signal?: AbortSignal): Promise<string> {
    const model = this.getPreferredVisionModel();
    const googleProvider = this.getDirectGoogleVisionProvider(model);
    const effectiveRequestId = requestId || generateRequestId();
    const startTime = Date.now();

    if (googleProvider) {
      logger.info(category, 'Using direct Google multimodal extraction', {
        model: model || '(default)',
      }, effectiveRequestId);

      try {
        const response = await googleProvider.chat(messages, {
          temperature: 0.1,
          maxTokens: PDF_LLM_MAX_TOKENS,
          requestId: effectiveRequestId,
          ...(model ? { model } : {}),
          ...(signal ? { signal } : {}),
        });

        logger.logLLMCall({
          requestId: effectiveRequestId,
          model: response.model || model || 'gemini',
          provider: googleProvider.getProviderName(),
          promptTokens: response.usage.promptTokens,
          completionTokens: response.usage.completionTokens,
          duration: Date.now() - startTime,
          status: 'success',
          messages,
          options: {
            temperature: 0.1,
            maxTokens: PDF_LLM_MAX_TOKENS,
            ...(model ? { model } : {}),
          },
          responseText: response.content,
        });

        return response.content;
      } catch (error) {
        logger.logLLMCall({
          requestId: effectiveRequestId,
          model: model || 'gemini',
          provider: googleProvider.getProviderName(),
          promptTokens: 0,
          completionTokens: 0,
          duration: Date.now() - startTime,
          status: 'error',
          messages,
          options: {
            temperature: 0.1,
            maxTokens: PDF_LLM_MAX_TOKENS,
            ...(model ? { model } : {}),
          },
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    logger.info(category, 'Using configured generic multimodal provider', {
      provider: llmService.getProvider(),
      model: model || '(default)',
    }, effectiveRequestId);

    return llmService.chat(messages, {
      temperature: 0.1,
      maxTokens: PDF_LLM_MAX_TOKENS,
      requestId: effectiveRequestId,
      ...(model ? { visionModel: model } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /**
   * Check if a string looks like a hash/encoded garbage
   */
  private isHashLikeGarbage(str: string): boolean {
    const trimmed = str.trim();
    if (trimmed.length < 20) return false;

    const spaces = (trimmed.match(/\s/g) || []).length;
    const lowercase = (trimmed.match(/[a-z]/g) || []).length;
    const uppercase = (trimmed.match(/[A-Z]/g) || []).length;
    const digits = (trimmed.match(/[0-9]/g) || []).length;
    const tildes = (trimmed.match(/~/g) || []).length;

    // Tildes and other non-meaningful symbols count toward the "hash" ratio
    const alphanumericRatio = (lowercase + uppercase + digits + tildes) / trimmed.length;

    if (alphanumericRatio > 0.9 && spaces === 0 &&
        lowercase > 0 && uppercase > 0 && digits > 0 &&
        trimmed.length > 25) {
      return true;
    }

    if (trimmed.length > 30) {
      const halfLen = Math.floor(trimmed.length / 2);
      const firstHalf = trimmed.substring(0, halfLen);
      if (trimmed.includes(firstHalf + firstHalf.substring(0, 10))) {
        return true;
      }
    }

    if (/^[A-Za-z0-9+/=_~-]{30,}$/.test(trimmed)) {
      return true;
    }

    // Multi-token: line is composed of space-separated hash-like tokens
    // e.g. "a744c9d5f407585e1HZ-0t-... a744c9d5f407585e1HZ-0t-..."
    if (spaces > 0 && trimmed.length > 40) {
      const tokens = trimmed.split(/\s+/);
      if (tokens.length <= 6 && tokens.every(t => /^[A-Za-z0-9+/=_~-]{15,}$/.test(t))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Find repeated long alphanumeric tokens that appear 3+ times — these are almost
   * certainly watermarks / tracking codes. Returns the set of such tokens so callers
   * can strip every occurrence (including fragments scattered by layout extraction).
   */
  private findWatermarkTokens(text: string, requestId?: string): Set<string> {
    // Match tokens of 20+ chars composed of alphanumerics, hyphens, underscores, tildes
    const longTokens = text.match(/[A-Za-z0-9_~-]{20,}/g) || [];
    const freq = new Map<string, number>();
    for (const token of longTokens) {
      freq.set(token, (freq.get(token) || 0) + 1);
    }
    const watermarks = new Set<string>();
    for (const [token, count] of freq) {
      if (count >= 3 && this.isHashLikeGarbage(token)) {
        watermarks.add(token);
      }
    }
    if (freq.size > 0) {
      logger.info('PDF_WATERMARK', `Token scan: ${longTokens.length} long tokens, ${freq.size} unique, ${watermarks.size} identified as watermarks`, {
        candidates: [...freq.entries()].filter(([, c]) => c >= 2).map(([t, c]) => ({ token: t.substring(0, 40) + (t.length > 40 ? '...' : ''), count: c, isGarbage: this.isHashLikeGarbage(t) })),
        watermarks: [...watermarks].map(w => w.substring(0, 50)),
      }, requestId);
    }
    return watermarks;
  }

  /**
   * Strong CJK watermark trigger phrases. These terms only appear in PDF
   * watermarks/stamps applied by recruitment platforms and document
   * management systems — they're never used by candidates to describe
   * their own work, so matching any one is a high-confidence watermark
   * signal even without a repetition count.
   *
   *   招聘专用       — "recruitment use only"
   *   内部资料/使用  — "internal materials / use"
   *   请勿/禁止/严禁/不得 外传 — "do not share"
   *   机密/保密 文件 — "confidential document"
   *   请勿翻印/复制  — "do not copy"
   *   仅供 XX 使用   — "for XX use only"
   *   内部传阅       — "internal circulation"
   *   版权所有 YYYY  — "copyright YYYY"
   */
  private static readonly CJK_WATERMARK_TRIGGERS = /招聘专用|内部资料|内部使用|内部传阅|(?:请勿|禁止|严禁|不得)\s*外传|机密文件|保密文件|请勿翻印|严禁复制|仅供[^。\n]{0,12}使用|版权所有.{0,20}\d{4}/;

  /**
   * Find CJK watermark lines — full lines that contain any of the strong
   * CJK watermark trigger phrases. Returned values are exact line strings
   * suitable for `stripWatermarks`. We deliberately do NOT require a
   * repetition count: the trigger phrases above are diagnostic on their
   * own. This catches rotated/diagonal watermarks that pdftotext slices at
   * different column positions, yielding fragments like
   *   "询有限公司 招聘专用"
   *   "理咨询有限公司 招聘专用"
   *   "上海璞弛企业管理咨询有限公司 招聘专用"
   * Each fragment is a distinct string but all of them are still watermarks.
   */
  private findCjkWatermarkPhrases(text: string, requestId?: string): Set<string> {
    const watermarks = new Set<string>();
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.length < 4 || line.length > 120) continue;
      if (PDFService.CJK_WATERMARK_TRIGGERS.test(line)) {
        watermarks.add(line);
      }
    }
    if (watermarks.size > 0) {
      logger.info('PDF_WATERMARK', `CJK scan: ${watermarks.size} watermark line(s) matched trigger phrase`, {
        samples: [...watermarks].slice(0, 8).map(w => w.length > 80 ? w.substring(0, 80) + '…' : w),
      }, requestId);
    }
    return watermarks;
  }

  /**
   * Strip all occurrences of known watermark tokens from text, including when
   * they appear as part of a longer string or on a line with other content.
   */
  private stripWatermarks(text: string, watermarks: Set<string>): string {
    if (watermarks.size === 0) return text;
    // Build a regex that matches any of the watermark strings
    const escaped = [...watermarks].map(w => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));
    const re = new RegExp(`\\s*(?:${escaped.join('|')})\\s*`, 'g');
    return text.replace(re, ' ');
  }

  /**
   * Clean up extracted text by removing garbled characters
   */
  private cleanText(text: string, requestId?: string): string {
    let cleaned = text;

    logger.info('PDF_CLEAN', `cleanText input: ${text.length} chars`, {
      preview: text.substring(0, 300).replace(/\n/g, '\\n'),
    }, requestId);

    // Strip repeated watermark tokens before any other processing
    const watermarks = this.findWatermarkTokens(cleaned, requestId);
    const cjkWatermarks = this.findCjkWatermarkPhrases(cleaned, requestId);
    for (const phrase of cjkWatermarks) watermarks.add(phrase);
    if (watermarks.size > 0) {
      cleaned = this.stripWatermarks(cleaned, watermarks);
      logger.info('PDF_CLEAN', `After watermark strip: ${cleaned.length} chars (removed ${text.length - cleaned.length})`, {
        preview: cleaned.substring(0, 300).replace(/\n/g, '\\n'),
      }, requestId);
    }

    const cjkPattern = '\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\uac00-\ud7af';

    cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
    cleaned = cleaned.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');
    cleaned = cleaned.replace(/[\uFFFD\uFFFF]/g, '');
    cleaned = cleaned.replace(/[\uE000-\uF8FF]/g, '');

    cleaned = cleaned.replace(/[A-Za-z0-9_-]{25,}/g, (match) => {
      if (match.includes(' ') || match.startsWith('http')) return match;
      if (this.isHashLikeGarbage(match)) return '';
      return match;
    });

    const safeCharsPattern = new RegExp(`[^\\w\\s${cjkPattern}.,;:!?'"()\\[\\]{}<>@#$%&*+=\\-/]{3,}`, 'g');
    cleaned = cleaned.replace(safeCharsPattern, ' ');

    cleaned = cleaned.replace(/\(cid:\d+\)/g, '');
    cleaned = cleaned.replace(/\\u[0-9a-fA-F]{4}/g, '');

    const alphanumericCjkPattern = new RegExp(`[\\w${cjkPattern}]`, 'g');
    cleaned = cleaned.split('\n').map(line => {
      // Collapse whitespace first so padded table-layout lines aren't misjudged
      const trimmed = line.trim().replace(/\s+/g, ' ');
      if (this.isHashLikeGarbage(trimmed)) return '';
      const alphanumericCount = (trimmed.match(alphanumericCjkPattern) || []).length;
      const totalLength = trimmed.length;
      if (totalLength > 5 && alphanumericCount / totalLength < 0.3) return '';
      return line;
    }).join('\n');

    const lines = cleaned.split('\n');
    const seenLines = new Set<string>();
    const uniqueLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 10 || !seenLines.has(trimmed)) {
        uniqueLines.push(line);
        if (trimmed.length >= 10) seenLines.add(trimmed);
      }
    }
    cleaned = uniqueLines.join('\n');

    cleaned = cleaned.replace(/[ \t]+/g, ' ');
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    cleaned = cleaned.replace(/^\s+|\s+$/gm, '');

    cleaned = cleaned.split('\n').filter(line => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return true;
      if (trimmed.length === 1 && /[•·○●■□▪▫]/.test(trimmed)) return false;
      if (/^\d{1,3}$/.test(trimmed)) return false;
      return true;
    }).join('\n');

    cleaned = cleaned.trim();

    logger.info('PDF_CLEAN', `cleanText output: ${cleaned.length} chars`, {
      preview: cleaned.substring(0, 300).replace(/\n/g, '\\n'),
    }, requestId);

    return cleaned;
  }

  /**
   * Check if pdftotext binary is available on this system.
   * Caches result after first check.
   */
  private pdftotextAvailable: boolean | null = null;
  private async isPdftotextAvailable(): Promise<boolean> {
    if (this.pdftotextAvailable !== null) return this.pdftotextAvailable;
    return new Promise((resolve) => {
      const proc = spawn('pdftotext', ['-v'], { stdio: 'ignore' });
      proc.on('error', () => { this.pdftotextAvailable = false; resolve(false); });
      proc.on('close', (code) => { this.pdftotextAvailable = code === 0 || code === 99; resolve(this.pdftotextAvailable); });
    });
  }

  /**
   * Extract text from a PDF using the system pdftotext binary (poppler-utils).
   * Much better than pdf-parse for CJK text and complex layouts.
   * Pipes the PDF buffer to stdin, reads from stdout — no temp files needed.
   */
  async extractWithPdftotext(buffer: Buffer, requestId?: string, useLayout = true): Promise<string> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      // -layout preserves the visual layout (multi-column, tables) but can
      // scatter watermark characters within words on English PDFs.
      // -enc UTF-8 ensures correct CJK output.
      // '-' for both input and output means stdin/stdout.
      const args = useLayout
        ? ['-layout', '-enc', 'UTF-8', '-', '-']
        : ['-enc', 'UTF-8', '-', '-'];
      const proc = spawn('pdftotext', args);

      let stdout = '';
      let stderr = '';
      let settled = false;
      const resolveOnce = (value: string) => { if (!settled) { settled = true; clearTimers(); resolve(value); } };
      const rejectOnce = (err: Error) => { if (!settled) { settled = true; clearTimers(); reject(err); } };

      // Hard timeout: SIGTERM first, escalate to SIGKILL if the process
      // doesn't exit within 2 s. Without this a malformed PDF can hang
      // pdftotext indefinitely, accumulating zombies and leaking memory.
      const timeoutMs = Number(process.env.PDF_PDFTOTEXT_TIMEOUT_MS || 30_000);
      let killTimer: NodeJS.Timeout | null = null;
      const termTimer = setTimeout(() => {
        logger.warn('PDF_PDFTOTEXT', `pdftotext exceeded ${timeoutMs}ms — sending SIGTERM`, {
          mode: useLayout ? 'layout' : 'raw',
        }, requestId);
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        killTimer = setTimeout(() => {
          logger.error('PDF_PDFTOTEXT', 'pdftotext did not exit after SIGTERM — SIGKILL', {}, requestId);
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
        }, 2_000);
        rejectOnce(new Error(`pdftotext timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const clearTimers = () => {
        clearTimeout(termTimer);
        if (killTimer) clearTimeout(killTimer);
      };

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString('utf-8'); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString('utf-8'); });

      proc.on('error', (err) => {
        rejectOnce(new Error(`pdftotext spawn failed: ${err.message}`));
      });

      proc.on('close', (code) => {
        if (settled) return; // already rejected by timeout
        const elapsedMs = Date.now() - startTime;
        if (code !== 0) {
          rejectOnce(new Error(`pdftotext exited with code ${code}: ${stderr}`));
          return;
        }

        logger.info('PDF_PDFTOTEXT', `Raw stdout: ${stdout.length} chars (${useLayout ? 'layout' : 'raw'})`, {
          preview: stdout.substring(0, 400).replace(/\n/g, '\\n'),
        }, requestId);

        // Detect watermark scatter: count lines that are short alnum fragments
        // (1-3 chars, purely alphanumeric). A high ratio (>25%) means the PDF has
        // a tracking/watermark string whose characters were scattered across the
        // text by pdftotext's layout engine, making the output unreliable.
        {
          const nonEmptyLines = stdout.split('\n').filter(l => l.trim().length > 0);
          const fragmentCount = nonEmptyLines.filter(l => {
            const t = l.trim();
            return t.length <= 3 && /^[A-Za-z0-9+/=_~-]+$/.test(t);
          }).length;
          if (nonEmptyLines.length > 20 && fragmentCount / nonEmptyLines.length > 0.25) {
            this._watermarkScatterDetected = true;
            logger.info('PDF_PDFTOTEXT', `Watermark scatter detected: ${fragmentCount}/${nonEmptyLines.length} fragment lines (${(fragmentCount / nonEmptyLines.length * 100).toFixed(0)}%)`, {}, requestId);
          }
          // Same signal for CJK watermarks: when 3+ lines contain trigger
          // phrases like 招聘专用 / 内部资料 / 请勿外传, the document is
          // heavily watermarked. Stripping them inline isn't enough — the
          // watermark is usually rotated diagonally across the page, so
          // pdftotext also interleaves fragments inside real content lines.
          // Force the LLM-vision fallback so we get a clean re-read.
          const cjkWatermarkLineCount = nonEmptyLines.filter(l =>
            PDFService.CJK_WATERMARK_TRIGGERS.test(l)
          ).length;
          if (cjkWatermarkLineCount >= 3) {
            this._watermarkScatterDetected = true;
            logger.info('PDF_PDFTOTEXT', `CJK watermark scatter detected: ${cjkWatermarkLineCount} lines contain trigger phrases`, {}, requestId);
          }
        }

        // Strip repeated watermark tokens before line-level cleanup
        const watermarks = this.findWatermarkTokens(stdout, requestId);
        const cjkWatermarks = this.findCjkWatermarkPhrases(stdout, requestId);
        for (const phrase of cjkWatermarks) watermarks.add(phrase);
        let preClean = stdout;
        if (watermarks.size > 0) {
          preClean = this.stripWatermarks(stdout, watermarks);
          logger.info('PDF_PDFTOTEXT', `After watermark strip: ${preClean.length} chars (removed ${stdout.length - preClean.length})`, {
            preview: preClean.substring(0, 400).replace(/\n/g, '\\n'),
          }, requestId);
        }

        // Clean watermark noise — short alphanumeric-only fragments scattered
        // by -layout mode from watermark/tracking strings like
        // "6e72aef5715f42b81HZ709S6FFRUxYW-UfOZWOeqmP7VNxNg"
        const isAlnumToken = (s: string) => /^[A-Za-z0-9+/=_~-]+$/.test(s);

        const cleaned = preClean
          .split('\n')
          .filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return true; // keep blank lines for structure
            // Remove full watermark/hash strings
            if (this.isHashLikeGarbage(trimmed)) return false;
            // Remove lines composed entirely of short alphanumeric tokens
            // e.g. "R Ux", "9 S6", "H Z7", "2 b8", "7 15", "N  g"
            const tokens = trimmed.split(/\s+/);
            if (tokens.every(t => t.length <= 3 && isAlnumToken(t))) return false;
            // Remove standalone single CJK page numbers
            if (/^\d{1,3}$/.test(trimmed)) return false;
            return true;
          })
          .map(line => {
            const hasCjk = /[\u4e00-\u9fff]/.test(line);
            // Strip inline watermark fragments: 1-2 char alnum tokens surrounded by 2+ spaces
            // Works for both CJK and English: "Education  Vd  Shanghai" → "Education  Shanghai"
            // Safe: normal English words have single spaces, not 2+
            let cleaned = line.replace(/\s{2,}[A-Za-z0-9~]{1,2}\s{2,}/g, '  ');
            // Strip trailing watermark fragments (1-2 char for English, up to 3 for CJK)
            // e.g. "Ding Yi  W" → "Ding Yi", "崔晋闻  个人简历  O" → "崔晋闻  个人简历"
            const trailingLimit = hasCjk ? 3 : 2;
            const trailingRe = new RegExp(`(\\s{2,}[A-Za-z0-9+/=_~-]{1,${trailingLimit}})+\\s*$`);
            cleaned = cleaned.replace(trailingRe, '').trimEnd();
            return cleaned;
          })
          .join('\n')
          // Repair watermark-broken English words per line.
          // After watermark chars are removed, gaps remain inside words:
          //   "P rodu c t M anager" → "Product Manager"
          //   "Co mm er c iali z ation" → "Commercialization"
          // Only apply aggressive joining on lines with 2+ single-char alpha
          // tokens (sign of watermark damage), to avoid breaking normal text.
          .split('\n').map(line => {
            const tokens = line.trim().split(/\s+/);
            const singleCharAlpha = tokens.filter(t => /^[a-zA-Z]$/.test(t)).length;
            if (singleCharAlpha < 2) return line;
            let fixed = line;
            // Multiple passes to handle chains like "er c iali z ation"
            for (let i = 0; i < 3; i++) {
              fixed = fixed.replace(/([a-z]{2,}) ([a-z]) ([a-z]{2,})/g, '$1$2$3');
            }
            // Rejoin trailing single char: "Produc t" → "Product"
            for (let i = 0; i < 3; i++) {
              fixed = fixed.replace(/([a-z]{3,}) ([a-z])\b/g, '$1$2');
            }
            // Rejoin single uppercase + lowercase: "M arketing" → "Marketing"
            fixed = fixed.replace(/\b([A-Z]) ([a-z]{2,})/g, '$1$2');
            // Rejoin 2-char prefix + fragment: "Co mmercialization" → "Commercialization"
            // Safe on damaged lines only (wouldn't run on "He went")
            fixed = fixed.replace(/\b([A-Z][a-z]) ([a-z]{2,})/g, '$1$2');
            return fixed;
          }).join('\n')
          // Strip Private Use Area characters (icon font glyphs from PDF templates)
          .replace(/[\uE000-\uF8FF]/g, '')
          // Collapse excessive blank lines
          .replace(/\n{3,}/g, '\n\n')
          // Collapse excessive horizontal whitespace (layout padding)
          .replace(/[ \t]{4,}/g, '  ')
          .trim();

        logger.info('PDF_PDFTOTEXT', `pdftotext completed in ${elapsedMs}ms (${useLayout ? 'layout' : 'raw'})`, {
          rawChars: stdout.length,
          cleanedChars: cleaned.length,
          elapsedMs,
          mode: useLayout ? 'layout' : 'raw',
          preview: cleaned.substring(0, 200),
        }, requestId);

        resolveOnce(cleaned);
      });

      // Pipe the PDF buffer to pdftotext's stdin
      try {
        proc.stdin.write(buffer);
        proc.stdin.end();
      } catch (err) {
        rejectOnce(err instanceof Error ? err : new Error('pdftotext stdin write failed'));
      }
    });
  }

  /**
   * Try pdftotext in both layout and raw modes, compare results, return the better one.
   * Layout mode preserves spatial structure (tables, columns) but can scatter watermark
   * characters within words. Raw mode extracts in content-stream order, keeping watermark
   * text on separate lines where noise filters can remove it.
   */
  private async extractBestPdftotext(buffer: Buffer, requestId?: string): Promise<string> {
    const [layoutText, rawText] = await Promise.all([
      this.extractWithPdftotext(buffer, requestId, true).catch(() => ''),
      this.extractWithPdftotext(buffer, requestId, false).catch(() => ''),
    ]);

    if (!layoutText && !rawText) {
      throw new Error('pdftotext failed in both layout and raw modes');
    }
    if (!rawText) return layoutText;
    if (!layoutText) return rawText;

    const { text: bestText, usedLayout } = this.pickBetterPdftotext(layoutText, rawText, requestId);

    // If raw mode won, check if it's missing a name that layout mode preserved.
    // Layout mode often keeps the candidate name at the top even when watermark
    // scatters elsewhere; raw mode can lose it entirely.
    if (!usedLayout) {
      const layoutName = this.findNameLineInTop(layoutText);
      const rawName = this.findNameLineInTop(rawText);
      if (layoutName && !rawName) {
        logger.info('PDF_PDFTOTEXT', `Prepending name from layout mode: "${layoutName}"`, {}, requestId);
        return layoutName + '\n' + bestText;
      }
    }

    return bestText;
  }

  /**
   * Look for a name-like line in the first 15 non-empty lines of text.
   * Returns the line if found, null otherwise.
   */
  private findNameLineInTop(text: string): string | null {
    // Only check the first 3 non-empty lines — a name is virtually always at the top.
    const topLines = text.split('\n').slice(0, 15).map(l => l.trim()).filter(Boolean).slice(0, 3);
    // English name: 2-3 capitalized words, excluding university/company names
    const englishName = topLines.find(l =>
      /^[A-Z][a-z]+ [A-Z][a-z]+(\s[A-Z][a-z]+)?$/.test(l) &&
      !/University|Institute|College|Company|Corporation|Education|Experience|School|Academy|Center|Technology|Engineering/i.test(l)
    );
    if (englishName) return englishName;
    // CJK name: 2-4 characters only
    const cjkName = topLines.find(l => /^[\u3400-\u9fff]{2,4}$/.test(l));
    if (cjkName) return cjkName;
    return null;
  }

  /**
   * Compare layout-mode vs raw-mode pdftotext output and pick the one with
   * more recognisable content.
   * - Real English words (4+ letters) are a strong signal — watermark fragments break them.
   * - CJK character count is stable across modes for CJK resumes.
   * - Resume section keywords get a bonus.
   */
  private pickBetterPdftotext(layoutText: string, rawText: string, requestId?: string): { text: string; usedLayout: boolean } {
    const contentScore = (text: string) => {
      const realWords = (text.match(/\b[a-zA-Z]{4,}\b/g) || []).length;
      const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const sections = (
        text.match(/\b(?:Education|Experience|Skills|Summary|Projects|University|Company|Manager|Engineer|Director|Bachelor|Master|Degree|Internship|Responsibilities|Achievements)\b/gi) || []
      ).length + (
        text.match(/(?:教育背景|教育经历|工作经历|工作经验|专业技能|项目经历|自我评价|求职意向)/g) || []
      ).length;
      return { realWords, cjk, sections, total: realWords + cjk + sections * 10 };
    };

    const layoutScore = contentScore(layoutText);
    const rawScore = contentScore(rawText);

    // For CJK-heavy text, prefer layout mode when scores are close — layout
    // preserves two-column structure and field labels, while raw mode interleaves
    // columns and breaks field labels across lines.
    const isCjkHeavy = layoutScore.cjk > 100 || rawScore.cjk > 100;
    const margin = isCjkHeavy ? 0.05 : 0; // 5% margin for CJK
    const usedLayout = layoutScore.total >= rawScore.total * (1 - margin);
    logger.info('PDF_PDFTOTEXT', `Comparing layout vs raw mode → ${usedLayout ? 'layout' : 'raw'}${isCjkHeavy ? ' (CJK layout preference)' : ''}`, {
      layout: { chars: layoutText.length, ...layoutScore },
      raw: { chars: rawText.length, ...rawScore },
    }, requestId);

    return { text: usedLayout ? layoutText : rawText, usedLayout };
  }

  /**
   * Detect if extracted text is garbled (poor extraction quality).
   */
  isExtractionQualityGood(text: string, requestId?: string): boolean {
    if (!text || text.length < 20) {
      logger.info('PDF_QUALITY', `Quality check FAIL: text too short (${text?.length ?? 0} chars)`, {}, requestId);
      return false;
    }

    const commonCjkRe = /[\u4e00-\u9fff]/g;
    const rareCjkRe = /[\u2E80-\u2EFF\u3400-\u4DBF\uA000-\uA4CF\uA490-\uA4CF\uF900-\uFAFF]/g;
    const extRareRe = /[\u1200-\u137F\u13A0-\u13FF\u1680-\u169F\u16A0-\u16FF\u1780-\u17FF\u1800-\u18AF\u1900-\u194F\u1950-\u197F\u19E0-\u19FF\u1A00-\u1A1F\u2C00-\u2C5F\u2D00-\u2D2F\u2D80-\u2DDF\uA800-\uA82F\uA840-\uA87F\uAB00-\uAB2F]/g;
    const latinRe = /[a-zA-Z0-9@.]/g;

    const commonCjkCount = (text.match(commonCjkRe) || []).length;
    const rareCjkCount = (text.match(rareCjkRe) || []).length;
    const extRareCount = (text.match(extRareRe) || []).length;
    const latinCount = (text.match(latinRe) || []).length;

    const totalChars = text.replace(/\s/g, '').length;
    if (totalChars === 0) {
      logger.info('PDF_QUALITY', 'Quality check FAIL: zero non-whitespace chars', {}, requestId);
      return false;
    }

    const hasEmail = /@\w+\.\w+/.test(text);
    const hasPhone = /\d{3,4}[-\s]?\d{3,4}[-\s]?\d{4}/.test(text);
    const garbledCharCount = rareCjkCount + extRareCount;

    logger.info('PDF_QUALITY', 'Quality analysis', {
      totalChars, commonCjkCount, rareCjkCount, extRareCount, garbledCharCount,
      latinCount, hasEmail, hasPhone,
      garbledRatio: (garbledCharCount / totalChars).toFixed(3),
      cjkRatio: (commonCjkCount / totalChars).toFixed(3),
    }, requestId);

    if (garbledCharCount > totalChars * 0.1) {
      logger.info('PDF_QUALITY', 'Quality check FAIL: high garbled char ratio', {}, requestId);
      return false;
    }

    const nonLatinCount = totalChars - latinCount;
    const latinRatio = latinCount / totalChars;
    // Only apply CJK ratio checks when text is NOT predominantly Latin/English.
    // English-only resumes have zero CJK but are perfectly valid.
    if (latinRatio < 0.5) {
      if (nonLatinCount > 50 && commonCjkCount < nonLatinCount * 0.3) {
        logger.info('PDF_QUALITY', 'Quality check FAIL: low common CJK ratio', {}, requestId);
        return false;
      }

      if ((hasEmail || hasPhone) && commonCjkCount < 10 && nonLatinCount > 100) {
        logger.info('PDF_QUALITY', 'Quality check FAIL: contact info readable but text garbled', {}, requestId);
        return false;
      }
    }

    logger.info('PDF_QUALITY', 'Quality check PASS', { totalChars, commonCjkCount, latinCount }, requestId);
    return true;
  }

  /**
   * Compare two text extractions and return which one is richer for resume parsing.
   * Counts common CJK characters, date ranges, contact signals, and resume section headers.
   * Returns 'a' if textA is better, 'b' if textB is better.
   */
  private compareExtractionQuality(textA: string, textB: string, requestId?: string): 'a' | 'b' {
    const score = (text: string) => {
      const commonCjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
      const dateRanges = (text.match(/(19|20)\d{2}[./-]\d{1,2}\s*(?:-|–|—|~|至)/g) || []).length;
      const hasEmail = /@\w+\.\w+/.test(text) ? 1 : 0;
      const hasPhone = /1[3-9]\d{9}/.test(text) ? 1 : 0;
      // Resume section headers (Chinese + English)
      const sectionHeaders = (text.match(/(?:教育背景|教育经历|工作经历|工作经验|实习经历|项目经历|项目经验|专业技能|自我评价|求职意向|荣誉奖项|获奖情况|Education|Experience|Projects|Skills)/g) || []).length;
      // Proper noun density — CJK strings of 2-8 chars between punctuation/spaces (likely names)
      const properNouns = (text.match(/[\u4e00-\u9fff]{2,8}/g) || []).length;
      // English word count — real words (4+ letters) to detect watermark damage
      const englishWords = (text.match(/\b[a-zA-Z]{4,}\b/g) || []).length;
      return {
        commonCjk,
        dateRanges,
        contacts: hasEmail + hasPhone,
        sectionHeaders,
        properNouns,
        englishWords,
        total: commonCjk * 2 + englishWords + dateRanges * 10 + (hasEmail + hasPhone) * 5 + sectionHeaders * 15 + properNouns,
      };
    };

    const scoreA = score(textA);
    const scoreB = score(textB);

    logger.info('PDF_QUALITY', 'Comparing extraction quality', {
      textA: { chars: textA.length, ...scoreA },
      textB: { chars: textB.length, ...scoreB },
      winner: scoreA.total >= scoreB.total ? 'A (pdf-parse)' : 'B (LLM)',
    }, requestId);

    return scoreA.total >= scoreB.total ? 'a' : 'b';
  }

  /**
   * Extract text from a PDF by sending the raw PDF only when we can talk to
   * Gemini directly. Generic OpenAI-style chat providers do not reliably
   * support PDF data URIs, so this path is provider-aware by design.
   */
  async extractTextWithDirectLLM(buffer: Buffer, requestId?: string, pdfParseText?: string, signal?: AbortSignal): Promise<string> {
    if (!this.getDirectGoogleVisionProvider()) {
      throw new Error('Direct PDF extraction requires direct Google Gemini access');
    }

    const base64Pdf = buffer.toString('base64');
    const sizeKB = Math.round(buffer.length / 1024);

    logger.info('PDF_LLM', `Sending raw PDF directly to LLM (${sizeKB}KB)`, {
      sizeKB,
      visionModel: this.getPreferredVisionModel() || '(default)',
      hasPdfParseRef: !!pdfParseText,
    }, requestId);

    // When pdf-parse text is available, use dual-input reconciliation:
    // The LLM uses the visual PDF for correct structure/layout, and the
    // pdf-parse text as a character-accuracy reference for proper nouns.
    const promptText = pdfParseText
      ? `Extract ALL text content from this PDF document.

IMPORTANT — DUAL-SOURCE RECONCILIATION:
I also provide raw text extracted from this PDF by a text parser (see "RAW TEXT REFERENCE" below).
The raw text has ACCURATE characters (especially proper nouns: company names, school names, project names, person names) but its STRUCTURE may be wrong (sections mixed up, columns interleaved, content out of order).

Your task:
1. Use the VISUAL LAYOUT of the PDF for correct section structure, reading order, and entry formatting.
2. Cross-reference with the RAW TEXT REFERENCE to ensure ALL proper nouns and detailed content are character-accurate. If you see a company/school/project name in the raw text that seems garbled or missing in your visual read, USE the raw text version.
3. For each work experience entry, ensure you capture: date range, company name, location, job title/role — all on one structured line.
4. For each project entry: date range, project name, role.
5. For each education entry: date range, institution name, degree, major.

Ignore any watermarks, tracking codes, or repeated alphanumeric strings — do NOT include them in the output.
Also ignore Chinese/Japanese watermark phrases like "招聘专用", "内部资料", "机密文件", "请勿外传", "仅供XX使用", "版权所有" — and any company name attached to such a phrase (e.g. "XX有限公司 招聘专用") is a watermark, NOT the candidate's employer. Do NOT include these in the extracted text and do NOT treat them as work experience.
Preserve the original language (Chinese, Japanese, English, etc.). Do NOT translate, summarize, or omit any content.
Output plain text only.

--- RAW TEXT REFERENCE (for character accuracy) ---
${pdfParseText.substring(0, 12000)}
--- END RAW TEXT REFERENCE ---`
      : `Extract ALL text content from this PDF document.
Output the text EXACTLY as it appears, preserving the original language (Chinese, Japanese, English, etc.).
Maintain the document structure with sections, headings, and bullet points.
IMPORTANT: Preserve ALL proper nouns exactly — company names (e.g. 蔚来汽车, 中信证券, Google), school/university names (e.g. 武汉大学, 清华大学), project names, and person names. These are critical and must not be lost or garbled.
Include ALL details: job title, company name, department, responsibilities, requirements, qualifications, skills, salary, benefits, contact info, etc.
Ignore any watermarks, tracking codes, or repeated alphanumeric strings (e.g. long hash-like strings) — do NOT include them in the output.
Also ignore Chinese/Japanese watermark phrases like "招聘专用", "内部资料", "机密文件", "请勿外传", "仅供XX使用", "版权所有" — and any company name attached to such a phrase (e.g. "XX有限公司 招聘专用") is a watermark, NOT the candidate's employer. Do NOT include these in the extracted text and do NOT treat them as work experience.
Do NOT translate, summarize, or omit any content. Output plain text only.`;

    const contentParts: MessageContent = [
      {
        type: 'text' as const,
        text: promptText,
      },
      {
        type: 'image_url' as const,
        image_url: { url: `data:application/pdf;base64,${base64Pdf}` },
      },
    ];

    const messages: Message[] = [
      { role: 'user', content: contentParts },
    ];

    const startTime = Date.now();

    try {
      const extractedText = await this.runMultimodalExtraction(messages, requestId, 'PDF_LLM', signal);

      const elapsedMs = Date.now() - startTime;
      logger.info('PDF_LLM', `Direct LLM extraction completed`, {
        chars: extractedText.length,
        lines: extractedText.split('\n').length,
        elapsedMs,
        preview: extractedText.substring(0, 150),
      }, requestId);

      return extractedText;
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('PDF_LLM', `Direct LLM extraction failed after ${elapsedMs}ms: ${errMsg}`, {
        stack: error instanceof Error ? error.stack : undefined,
      }, requestId);
      throw error;
    }
  }

  /**
   * Convert PDF pages to images and OCR them page-by-page.
   *
   * Pages are processed in parallel with bounded concurrency. Each page
   * gets its own retry (via withLLMRetry) so a single transient provider
   * blip doesn't silently drop a page — which was the old behaviour and
   * produced "resume parsed but work history is missing" bugs for paid
   * users uploading 20+ page scanned PDFs.
   *
   * A page failure is only fatal when the success ratio drops below
   * PDF_VISION_MIN_SUCCESS_RATIO (default 0.75) — otherwise we return the
   * pages we got and let ResumeParseValidation flag the parse as
   * incomplete for a reparse task. Returning something is better than
   * returning nothing for the user's day-to-day experience.
   *
   * Env knobs:
   *   PDF_VISION_CONCURRENCY         page parallelism (default 4)
   *   PDF_VISION_PAGE_ATTEMPTS       retries per page  (default 2)
   *   PDF_VISION_MIN_SUCCESS_RATIO   threshold 0..1    (default 0.75)
   */
  /**
   * Vision-extract text from a single raster image (PNG / JPG).
   *
   * Used when a user uploads a resume as a photo or scan rather than a
   * PDF/Word document. Mirrors the per-page prompt of `extractTextWithVision`
   * but skips the "page N of M" wording (it's always one image) and skips
   * pdf-to-img rasterization (we already have an image buffer).
   *
   * `mimeType` is preserved into the data-URI so the vision provider sees
   * the format correctly — Gemini / GPT-4o / Claude all dispatch on it.
   * Accepts `image/png`, `image/jpeg`, `image/webp`, `image/heic` — anything
   * the underlying vision model supports. Unsupported types degrade to an
   * empty string on the provider side; the caller surfaces that as a parse
   * failure.
   *
   * Returns clean text suitable for `ResumeParseAgent`. Empty string when
   * the vision call returned nothing usable (caller decides what to do —
   * usually surface "couldn't read this image").
   */
  async extractImage(
    buffer: Buffer,
    mimeType: string,
    requestId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const safeMime = (mimeType || '').toLowerCase() || 'image/png';
    const sizeKb = Math.round(buffer.length / 1024);
    logger.info('IMG_VISION', `Vision-extracting single image (${safeMime}, ${sizeKb}KB)`, {
      mimeType: safeMime,
      bufferSize: buffer.length,
    }, requestId);

    const startTime = Date.now();

    const prompt = `Extract ALL text content from this image of a resume / CV.
Output the text EXACTLY as it appears, preserving the original language (Chinese, Japanese, English, etc.).
Maintain the document structure with sections, headings, and bullet points.
IMPORTANT: Preserve ALL proper nouns exactly — company names, school/university names, project names, and person names. These are critical and must not be lost or garbled.
For each work / project / education entry, capture: date range, organization name, role/degree on one structured line.
Ignore any watermarks, tracking codes, or repeated alphanumeric strings — do NOT include them in the output.
Also ignore Chinese/Japanese watermark phrases like "招聘专用", "内部资料", "机密文件", "请勿外传", "仅供XX使用", "版权所有" — and any company name attached to such a phrase (e.g. "XX有限公司 招聘专用") is a watermark, NOT the candidate's employer.
Do NOT translate, summarize, or omit any content. Output plain text only.`;

    const messages: Message[] = [{
      role: 'user',
      content: [
        { type: 'text' as const, text: prompt },
        {
          type: 'image_url' as const,
          image_url: { url: `data:${safeMime};base64,${buffer.toString('base64')}` },
        },
      ] as MessageContent,
    }];

    try {
      const text = await withLLMRetry(
        () => this.runMultimodalExtraction(messages, requestId, 'IMG_VISION', signal),
        { label: 'image-vision', attempts: 2, requestId, signal },
      );
      const trimmed = (text || '').trim();
      const elapsedMs = Date.now() - startTime;
      logger.info('IMG_VISION', `Image vision extraction completed: ${trimmed.length} chars in ${elapsedMs}ms`, {
        chars: trimmed.length,
        elapsedMs,
        preview: trimmed.substring(0, 120),
      }, requestId);
      return trimmed;
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('IMG_VISION', `Image vision extraction failed after ${elapsedMs}ms: ${errMsg}`, {
        elapsedMs,
        mimeType: safeMime,
      }, requestId);
      throw error;
    }
  }

  async extractTextWithVision(buffer: Buffer, requestId?: string, pdfParseText?: string, signal?: AbortSignal): Promise<string> {
    logger.info('PDF_VISION', 'Converting PDF pages to images for vision extraction...', {}, requestId);

    let images: Buffer[];
    try {
      const { pdf: pdfToImg } = await import('pdf-to-img');
      images = [];
      const document = await pdfToImg(buffer, { scale: 2.0 });
      for await (const image of document) {
        images.push(Buffer.from(image));
      }
      logger.info('PDF_VISION', `Converted ${images.length} pages to images`, {
        pages: images.length,
      }, requestId);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : 'Unknown error';
      logger.error('PDF_VISION', `pdf-to-img conversion failed: ${errMsg}`, {
        stack: error instanceof Error ? error.stack : undefined,
      }, requestId);
      throw new Error(`PDF to image conversion failed: ${errMsg}`);
    }

    if (images.length === 0) {
      throw new Error('PDF has no pages to extract');
    }

    const concurrency = Math.max(1, Number(process.env.PDF_VISION_CONCURRENCY || 4));
    const pageAttempts = Math.max(1, Number(process.env.PDF_VISION_PAGE_ATTEMPTS || 2));
    const minSuccessRatio = Math.min(1, Math.max(0, Number(process.env.PDF_VISION_MIN_SUCCESS_RATIO || 0.75)));

    const startTime = Date.now();
    // Pre-allocate so the final join preserves page order regardless of
    // which page settles first under concurrent execution.
    const pageResults: (string | null)[] = new Array(images.length).fill(null);
    const failedPages: number[] = [];

    const buildPrompt = (pageNumber: number): string => (pdfParseText
      ? `Extract ALL text content from page ${pageNumber} of ${images.length} of this document.

IMPORTANT — I also provide raw text extracted from this PDF by a text parser (see below).
The raw text has ACCURATE characters (especially proper nouns: company names, school names, project names) but may have wrong structure.
Use the VISUAL LAYOUT of the image for correct reading order and structure, but cross-reference with the raw text to ensure proper nouns are character-accurate.
For each work/project/education entry, capture: date range, organization name, role/degree on one structured line.
Ignore watermarks and tracking codes. Also ignore Chinese/Japanese watermark phrases like "招聘专用", "内部资料", "机密文件", "请勿外传", "仅供XX使用", "版权所有" — and any company name attached to such a phrase (e.g. "XX有限公司 招聘专用") is a watermark, NOT the candidate's employer. Preserve original language. Output plain text only.

--- RAW TEXT REFERENCE ---
${pdfParseText.substring(0, 12000)}
--- END ---`
      : `Extract ALL text content from page ${pageNumber} of ${images.length} of this document.
Output the text EXACTLY as it appears, preserving the original language (Chinese, Japanese, English, etc.).
Maintain the document structure with sections, headings, and bullet points.
IMPORTANT: Preserve ALL proper nouns exactly — company names, school/university names, project names, and person names. These are critical and must not be lost or garbled.
Ignore any watermarks, tracking codes, or repeated alphanumeric strings — do NOT include them in the output.
Also ignore Chinese/Japanese watermark phrases like "招聘专用", "内部资料", "机密文件", "请勿外传", "仅供XX使用", "版权所有" — and any company name attached to such a phrase (e.g. "XX有限公司 招聘专用") is a watermark, NOT the candidate's employer.
Include ALL details from this page only. Do NOT translate, summarize, or omit any content. Output plain text only.`);

    const tasks = images.map((img, index) => async () => {
      const pageNumber = index + 1;
      const pageStart = Date.now();
      const messages: Message[] = [{
        role: 'user',
        content: [
          { type: 'text' as const, text: buildPrompt(pageNumber) },
          { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${img.toString('base64')}` } },
        ] as MessageContent,
      }];

      try {
        const pageText = await withLLMRetry(
          () => this.runMultimodalExtraction(messages, requestId, 'PDF_VISION', signal),
          {
            label: `vision-page-${pageNumber}`,
            attempts: pageAttempts,
            requestId,
            signal,
          },
        );
        const trimmed = pageText.trim();
        if (trimmed) {
          pageResults[index] = trimmed;
        } else {
          failedPages.push(pageNumber);
        }
        logger.info('PDF_VISION', `Extracted page ${pageNumber}/${images.length}`, {
          pageNumber,
          chars: pageText.length,
          elapsedMs: Date.now() - pageStart,
        }, requestId);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        failedPages.push(pageNumber);
        logger.warn('PDF_VISION', `Page ${pageNumber}/${images.length} extraction failed after ${pageAttempts} attempts: ${errMsg}`, {
          pageNumber,
          elapsedMs: Date.now() - pageStart,
        }, requestId);
      }
    });

    await runConcurrent(tasks, concurrency);

    const successfulPages = pageResults.filter((t): t is string => t !== null && t.length > 0);
    const successRatio = successfulPages.length / images.length;
    const elapsedMs = Date.now() - startTime;

    if (successfulPages.length === 0) {
      throw new Error(`Vision OCR returned no text for any PDF page (attempted ${images.length} pages in ${elapsedMs}ms)`);
    }

    if (successRatio < minSuccessRatio) {
      // Too many pages missing — caller (extractText) can still fall back
      // to whatever the local pdftotext/pdf-parse result was. A partial
      // vision result below threshold is worse than no vision result.
      throw new Error(
        `Vision OCR extracted only ${successfulPages.length}/${images.length} pages ` +
        `(< ${Math.round(minSuccessRatio * 100)}% threshold). ` +
        `Failed pages: ${failedPages.sort((a, b) => a - b).join(', ')}`,
      );
    }

    if (failedPages.length > 0) {
      logger.warn('PDF_VISION', `Partial vision extraction: ${successfulPages.length}/${images.length} pages succeeded`, {
        failedPages: failedPages.sort((a, b) => a - b),
        successRatio: Number(successRatio.toFixed(2)),
      }, requestId);
    }

    // Assemble in page order, skipping nulls.
    const extractedText = pageResults.filter((t): t is string => !!t).join('\n\n');
    logger.info('PDF_VISION', `Vision extraction completed: ${extractedText.length} chars in ${elapsedMs}ms`, {
      pagesAttempted: images.length,
      pagesExtracted: successfulPages.length,
      concurrency,
      pageAttempts,
    }, requestId);
    return extractedText;
  }

  /**
   * Extract text content from a PDF buffer.
   * Strategy:
   *   1. Try pdftotext (poppler) — best CJK support, layout-aware, fast
   *   2. If pdftotext unavailable/fails → try pdf-parse (JS fallback)
   *   3. Quality check on best local result
   *   4. If quality poor → send PDF to LLM with local text as character reference
   *   5. Compare all results, pick the richest one
   *   6. Last resort → return whatever we have
   */
  async extractText(buffer: Buffer, requestId?: string, signal?: AbortSignal): Promise<string> {
    this._watermarkScatterDetected = false;

    logger.info('PDF_EXTRACT', `Starting PDF extraction (${Math.round(buffer.length / 1024)}KB)`, {
      bufferSizeKB: Math.round(buffer.length / 1024),
    }, requestId);

    // Step 1: Try pdftotext (poppler-utils) — best quality for CJK + complex layouts
    let localText = '';
    let localSource = '';

    if (await this.isPdftotextAvailable()) {
      try {
        localText = await this.extractBestPdftotext(buffer, requestId);
        localSource = 'pdftotext';
        logger.info('PDF_EXTRACT', `pdftotext succeeded: ${localText.length} chars`, {
          preview: localText.substring(0, 500).replace(/\n/g, '\\n'),
        }, requestId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown';
        // pdftotext producing no usable text in both modes is the EXPECTED outcome
        // for image-only / watermark-only PDFs (the real content lives in the image
        // layer) — a normal fall-through to pdf-parse / OCR, not a failure. Reserve
        // WARN for a genuine pdftotext exec error (binary missing, spawn, timeout).
        if (errMsg.includes('layout and raw modes')) {
          logger.info('PDF_EXTRACT', 'pdftotext yielded no usable text (likely image-only/watermarked PDF), falling back to pdf-parse', {}, requestId);
        } else {
          logger.warn('PDF_EXTRACT', `pdftotext failed: ${errMsg}, falling back to pdf-parse`, {}, requestId);
        }
      }
    } else {
      logger.info('PDF_EXTRACT', 'pdftotext not available, using pdf-parse', {}, requestId);
    }

    // Step 2: Fallback to pdf-parse if pdftotext didn't work
    if (!localText) {
      try {
        const originalWarn = console.warn;
        console.warn = (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes('private use area')) return;
          originalWarn.apply(console, args);
        };
        try {
          const startTime = Date.now();
          // pdf-parse has no built-in timeout; wrap in Promise.race so a
          // corrupt PDF can't stall the event loop / batch worker forever.
          const pdfParseTimeoutMs = Number(process.env.PDF_PARSE_TIMEOUT_MS || 60_000);
          const data = await this.withTimeout(pdf(buffer), pdfParseTimeoutMs, 'pdf-parse');
          logger.info('PDF_EXTRACT', `pdf-parse raw output: ${data.text.length} chars`, {
            preview: data.text.substring(0, 300).replace(/\n/g, '\\n'),
          }, requestId);
          localText = this.cleanText(data.text, requestId);
          localSource = 'pdf-parse';
          logger.info('PDF_EXTRACT', `pdf-parse completed in ${Date.now() - startTime}ms`, {
            rawChars: data.text.length, cleanedChars: localText.length,
            preview: localText.substring(0, 150),
          }, requestId);
        } finally {
          console.warn = originalWarn;
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : 'Unknown error';
        logger.warn('PDF_EXTRACT', `pdf-parse failed: ${errMsg}`, {}, requestId);
      }
    }

    // Step 3: Quality check — if local extraction is good AND no watermark scatter, return immediately.
    // Watermark scatter means the text passed quality checks (watermark chars are ASCII, not garbled CJK)
    // but the content is structurally damaged — words broken, fragments injected inline, sections disordered.
    // The LLM vision path handles these PDFs much better.
    if (localText.length > 0 && this.isExtractionQualityGood(localText, requestId) && !this._watermarkScatterDetected) {
      logger.info('PDF_EXTRACT', `Using ${localSource} result (quality OK)`, { chars: localText.length }, requestId);
      return localText;
    }

    if (this._watermarkScatterDetected) {
      logger.info('PDF_EXTRACT', 'Watermark scatter detected — forcing LLM extraction despite quality check pass', {
        localChars: localText.length,
      }, requestId);
    } else if (localText.length > 0) {
      logger.info('PDF_EXTRACT', `${localSource} quality poor, trying LLM extraction with local text as reference`, {
        localChars: localText.length,
      }, requestId);
    }

    // Step 4: LLM extraction with local text as character-accuracy reference
    const localRef = localText.length > 50 ? localText : undefined;
    let llmText = '';

    // The direct PDF→Gemini path only works with DIRECT Google access — generic
    // OpenAI-style / OpenRouter providers don't reliably accept PDF data URIs
    // (extractTextWithDirectLLM throws immediately when no direct Google provider
    // is resolvable). When the vision model is routed through OpenRouter (e.g. the
    // China deploy that can't reach Google directly), this path is intentionally
    // unavailable, so skip it cleanly and go straight to image OCR — that's the
    // expected routing, not a failure worth a WARN on every scanned/watermarked PDF.
    if (this.getDirectGoogleVisionProvider()) {
      try {
        const directText = await this.extractTextWithDirectLLM(buffer, requestId, localRef, signal);
        if (directText && directText.trim().length > 20) {
          llmText = directText;
          logger.info('PDF_EXTRACT', 'Direct LLM extraction succeeded', { chars: llmText.length }, requestId);
        }
      } catch (directError) {
        const errMsg = directError instanceof Error ? directError.message : 'Unknown';
        logger.warn('PDF_EXTRACT', `Direct LLM failed: ${errMsg}, trying image fallback`, {}, requestId);
      }
    } else {
      logger.info('PDF_EXTRACT', 'Direct PDF→Gemini path unavailable (vision model not routed to direct Google); using image OCR', {}, requestId);
    }

    if (!llmText) {
      try {
        const visionText = await this.extractTextWithVision(buffer, requestId, localRef, signal);
        if (visionText && visionText.trim().length > 20) {
          llmText = visionText;
          logger.info('PDF_EXTRACT', 'Vision extraction succeeded', { chars: llmText.length }, requestId);
        }
      } catch (visionError) {
        const errMsg = visionError instanceof Error ? visionError.message : 'Unknown';
        logger.error('PDF_EXTRACT', `Vision extraction also failed: ${errMsg}`, {}, requestId);
      }
    }

    // Step 5: Pick the best result — compare local vs LLM
    if (llmText && localText.length > 0) {
      // When watermark scatter was detected, prefer LLM — local text has inline
      // fragment damage that character counts can't detect.
      if (this._watermarkScatterDetected) {
        logger.info('PDF_EXTRACT', 'Using LLM result (watermark scatter in local text)', {
          localChars: localText.length, llmChars: llmText.length,
        }, requestId);
        return llmText;
      }
      const winner = this.compareExtractionQuality(localText, llmText, requestId);
      if (winner === 'a') {
        logger.info('PDF_EXTRACT', `${localSource} richer than LLM — using ${localSource}`, {
          localChars: localText.length, llmChars: llmText.length,
        }, requestId);
        return localText;
      }
      logger.info('PDF_EXTRACT', 'LLM extraction richer — using LLM result', {
        localChars: localText.length, llmChars: llmText.length,
      }, requestId);
      return llmText;
    }

    if (llmText) return llmText;

    // Step 6: Last resort
    if (localText.length > 0) {
      logger.warn('PDF_EXTRACT', `All LLM methods failed, returning ${localSource} text`, {
        chars: localText.length,
      }, requestId);
      return localText;
    }

    throw new Error('PDF extraction failed: no text could be extracted by any method');
  }

  /**
   * Extract text and metadata from a PDF buffer
   */
  async extractWithMetadata(buffer: Buffer, requestId?: string): Promise<{
    text: string;
    numPages: number;
    info: Record<string, unknown>;
  }> {
    // We always need pdf-parse for metadata (numPages, info)
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes('private use area')) return;
      originalWarn.apply(console, args);
    };

    let data: { text: string; numpages: number; info: Record<string, unknown> };
    try {
      const pdfParseTimeoutMs = Number(process.env.PDF_PARSE_TIMEOUT_MS || 60_000);
      data = await this.withTimeout(pdf(buffer), pdfParseTimeoutMs, 'pdf-parse');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to parse PDF: ${message}`);
    } finally {
      console.warn = originalWarn;
    }

    // Step 1: Try pdftotext first for text extraction
    let localText = '';
    let localSource = '';

    if (await this.isPdftotextAvailable()) {
      try {
        localText = await this.extractBestPdftotext(buffer, requestId);
        localSource = 'pdftotext';
        logger.info('PDF_EXTRACT', `extractWithMetadata: pdftotext succeeded (${localText.length} chars)`, {}, requestId);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown';
        logger.warn('PDF_EXTRACT', `extractWithMetadata: pdftotext failed: ${errMsg}`, {}, requestId);
      }
    }

    // Step 2: Fallback to pdf-parse text if pdftotext didn't work
    if (!localText) {
      localText = this.cleanText(data.text, requestId);
      localSource = 'pdf-parse';
    }

    // Step 3: Quality check — if local extraction is good AND no watermark scatter, return immediately
    if (localText.length > 0 && this.isExtractionQualityGood(localText, requestId) && !this._watermarkScatterDetected) {
      return { text: localText, numPages: data.numpages, info: data.info || {} };
    }

    // Step 4: LLM extraction with local text as character-accuracy reference
    if (this._watermarkScatterDetected) {
      logger.info('PDF_EXTRACT', 'extractWithMetadata: watermark scatter detected — forcing LLM extraction', {}, requestId);
    } else if (localText.length > 0) {
      logger.info('PDF_EXTRACT', `extractWithMetadata: ${localSource} quality poor, trying LLM`, {}, requestId);
    }

    const localRef = localText.length > 50 ? localText : undefined;
    let llmText = '';

    // Direct PDF→Gemini only works with direct Google access; skip cleanly when
    // the vision model is routed elsewhere (e.g. OpenRouter) and go to image OCR.
    if (this.getDirectGoogleVisionProvider()) {
      try {
        llmText = await this.extractTextWithDirectLLM(buffer, requestId, localRef);
      } catch (err) {
        logger.warn('PDF_EXTRACT', 'extractWithMetadata: direct LLM failed, trying vision', {}, requestId);
      }
    } else {
      logger.info('PDF_EXTRACT', 'extractWithMetadata: direct PDF→Gemini path unavailable; using image OCR', {}, requestId);
    }

    if (!llmText || llmText.trim().length <= 20) {
      try {
        llmText = await this.extractTextWithVision(buffer, requestId, localRef);
      } catch (err) {
        logger.warn('PDF_EXTRACT', 'extractWithMetadata: vision also failed', {}, requestId);
      }
    }

    // Step 5: Pick the best result
    let finalText = localText;
    if (llmText && llmText.trim().length > 20 && localText.length > 0) {
      if (this._watermarkScatterDetected) {
        finalText = llmText;
      } else {
        const winner = this.compareExtractionQuality(localText, llmText, requestId);
        finalText = winner === 'a' ? localText : llmText;
      }
    } else if (llmText && llmText.trim().length > 20) {
      finalText = llmText;
    }

    return { text: finalText, numPages: data.numpages, info: data.info || {} };
  }
}

export const pdfService = new PDFService();
