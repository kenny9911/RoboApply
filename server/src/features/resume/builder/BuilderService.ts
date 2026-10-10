// server/src/features/resume/builder/BuilderService.ts
//
// The guided resume builder (WP-65; PRODUCT_PLAN.md F-RES-17, F-RES-12 cn,
// TW-04): config per brand and locale, AI suggestions, and creating the
// resume from a draft.
//
// AI rules (TASK_PLAN.md §2.2): suggestions run only when `aiAllowed(user)`
// and the brand's text model are available — otherwise 503 `ai_unavailable`
// before any model module loads (zero LLMService calls); the builder itself
// works without AI. A suggestion costs one `rewrite` credit (refunded when the
// call fails or every suggestion is dropped). CitationGuard drops suggestions
// that add numbers the user did not write. GoApply logs the AI-content label.
// Personal details never reach a prompt (prompt.ts) and never enter the
// resume text (compose.ts): the export renderer places them.

import { logger } from '../../../services/LoggerService.js';
import { HttpError } from '../../../platform/http.js';
import { CreditReplayError, type CreditService } from '../../../platform/credits/index.js';
import { hasInventedNumber } from '../check/citationGuard.js';
import type {
  BuilderConfigView,
  BuilderCreateResponse,
  BuilderDraft,
  BuilderSuggestBody,
  BuilderSuggestResponse,
} from '../contract.js';
import { composeBuilderResume } from './compose.js';
import { builderPromptInput, MAX_SUGGESTIONS, type BuilderPromptInput } from './prompt.js';
import { builderConfigFor, builderVariantFor } from './sections.js';

export interface BuilderServiceDeps {
  credits: CreditService;
  /** AI consent AND the brand's text model (resumeAiAvailable). */
  aiAvailable(userId: string): Promise<boolean>;
  market(): 'intl' | 'cn';
  /** The model call (BuilderSuggestAgent). */
  suggest(input: BuilderPromptInput): Promise<{ suggestions: string[] }>;
  logAiLabel(input: { userId: string; contentId: string; kind: string }): Promise<void>;
  /** Create a base resume (RAResumeService.create); throws HttpError conflict `resume_limit_reached` when full. */
  createResume(userId: string, input: { name: string; markdown: string }, locale?: string): Promise<{ id: string }>;
  /** Save the layout (template, page, personal details, photo). */
  saveLayout(userId: string, id: string, layout: Record<string, unknown>): Promise<void>;
  /** Hub target title and AI provenance (RAResumeService.patch). */
  patchMeta(userId: string, id: string, meta: { targetTitle?: string; aiAssisted?: boolean }): Promise<void>;
  /** Remove a resume this create just made when finishing it failed (RAResumeService.delete). */
  deleteResume(userId: string, id: string): Promise<void>;
  /**
   * GoApply: true when this server issued builder suggestions to the user since
   * `since` (RAAiContentLabelLog, kind `resume_builder`). Optional; absent = unknown.
   */
  builderAiUsedSince?(userId: string, since: Date): Promise<boolean>;
}

/** Builder suggestions issued within this window mark a GoApply create as AI-assisted. */
export const BUILDER_AI_WINDOW_MS = 24 * 60 * 60 * 1000;

function randomKey(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export class BuilderService {
  constructor(private readonly deps: BuilderServiceDeps) {}

  async config(userId: string, input: { locale?: string | null; page: 'letter' | 'a4' }): Promise<BuilderConfigView> {
    const aiAvailable = await this.deps.aiAvailable(userId);
    return builderConfigFor({ market: this.deps.market(), locale: input.locale, page: input.page, aiAvailable });
  }

  async suggest(userId: string, body: BuilderSuggestBody, options: { idempotencyKey?: string | null } = {}): Promise<BuilderSuggestResponse> {
    if (!(await this.deps.aiAvailable(userId))) throw new HttpError('ai_unavailable');
    const input = builderPromptInput(body);
    if (!input.notes && input.context.length === 0) {
      throw new HttpError('invalid_request', 'Write a few notes first.', { reason: 'notes_required' });
    }
    // Numbers may come only from what the user wrote.
    const sources = [input.targetTitle, input.entry?.title ?? '', input.entry?.organization ?? '', input.notes, ...input.context];
    const key = options.idempotencyKey || randomKey('builder');
    let result: BuilderSuggestResponse;
    try {
      result = await this.deps.credits.withCredit(
        { userId, bucket: 'rewrite', idempotencyKey: key, refType: 'resume_builder_suggest', refId: body.kind },
        async () => {
          let out: { suggestions: string[] };
          try {
            out = await this.deps.suggest(input);
          } catch (err) {
            logger.warn('RESUME_BUILDER', 'suggestion failed', { userId, kind: body.kind, error: err instanceof Error ? err.message : String(err) });
            throw new HttpError('ai_unavailable', 'Suggestions could not be written right now. No credit was used.');
          }
          const kept: string[] = [];
          let blocked = 0;
          for (const raw of out.suggestions) {
            const text = raw.trim();
            if (!text || kept.includes(text)) continue;
            if (hasInventedNumber(text, sources)) {
              blocked += 1;
              continue;
            }
            kept.push(text);
          }
          if (kept.length === 0) {
            throw new HttpError(
              'conflict',
              blocked > 0 ? 'The suggestions added numbers that are not in your notes, so they were not used. No credit was used.' : 'No suggestion came back. No credit was used.',
              { reason: blocked > 0 ? 'citation_guard' : 'no_suggestion', blocked },
            );
          }
          return { suggestions: kept.slice(0, MAX_SUGGESTIONS).map((text) => ({ text, aiWritten: true as const })), blocked };
        },
      );
    } catch (err) {
      if (err instanceof CreditReplayError) {
        throw new HttpError('conflict', err.code === 'request_already_completed' ? 'This request was already completed.' : 'This request is still running.', { reason: err.code });
      }
      throw err;
    }
    if (this.deps.market() === 'cn') {
      try {
        await this.deps.logAiLabel({ userId, contentId: `resume_builder:${key}`, kind: 'resume_builder' });
      } catch (err) {
        logger.debug('RESUME_BUILDER', 'AI label log unavailable', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return result;
  }

  /**
   * Create the base resume, then its layout and hub fields — all or nothing:
   * when finishing fails, the new resume is removed again (so a retry never
   * makes a duplicate or uses a second slot) and the error is passed on.
   *
   * AI provenance over-labels rather than under-labels (TASK_PLAN.md §2.2):
   * the client flag is sticky once a suggestion was added, and on GoApply the
   * server also marks the resume AI-assisted when it issued builder
   * suggestions to this user within the last 24 hours.
   */
  async create(userId: string, draft: BuilderDraft, options: { locale?: string | null } = {}): Promise<BuilderCreateResponse> {
    const market = this.deps.market();
    const variant = builderVariantFor({ market, locale: options.locale });
    const composed = composeBuilderResume(draft, variant);
    let aiAssisted = draft.aiAssisted === true;
    if (!aiAssisted && market === 'cn' && this.deps.builderAiUsedSince) {
      try {
        aiAssisted = await this.deps.builderAiUsedSince(userId, new Date(Date.now() - BUILDER_AI_WINDOW_MS));
      } catch (err) {
        logger.debug('RESUME_BUILDER', 'AI provenance lookup unavailable', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const { id } = await this.deps.createResume(userId, { name: composed.name, markdown: composed.markdown }, options.locale ?? undefined);
    try {
      await this.deps.saveLayout(userId, id, composed.layout);
      const meta: { targetTitle?: string; aiAssisted?: boolean } = {};
      if (composed.targetTitle) meta.targetTitle = composed.targetTitle;
      if (aiAssisted) meta.aiAssisted = true;
      if (Object.keys(meta).length) await this.deps.patchMeta(userId, id, meta);
    } catch (err) {
      logger.error('RESUME_BUILDER', 'finishing a new resume failed; removing it', {
        userId,
        resumeId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await this.deps.deleteResume(userId, id);
      } catch (cleanupErr) {
        logger.error('RESUME_BUILDER', 'could not remove the unfinished resume', {
          userId,
          resumeId: id,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
      throw err;
    }
    return { resumeId: id };
  }
}
