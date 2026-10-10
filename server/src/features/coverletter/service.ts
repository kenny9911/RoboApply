// server/src/features/coverletter/service.ts
//
// Cover letters (WP-37; PRODUCT_PLAN.md F-CL-01/02; ARCH §3.6).
//
//   create      resume variant + job (or a pasted post) → checked letter     credit `cover_letter`
//   regenerate  same letter, new tone/length/language → new version          credit `cover_letter`
//   rewrite     instruction → new version                                      20/day/letter, no credit
//   patch       user edit (autosaved; one `edit` version per 10 minutes), title, attach to an application
//   restore     a stored version → new `restore` version
//   export      PDF/DOCX with the AI label (+ RAApplicationArtifact when attached to an application)
//
// AI gate (TASK_PLAN.md §2.2): `aiAvailable` = aiAllowed(user) AND the
// brand's `ai.text` capability. When false, create/regenerate/rewrite answer
// 503 ai_unavailable before any credit or LLM call (zero LLMService calls);
// reading, editing, restoring and exporting still work.
//
// Honesty: the writer cites every sentence; claimCheck.ts and the ported
// fact-checker reject a letter that writes a job-post fact as the
// candidate's own experience (one retry with the problems called out, then
// 409 cover_letter_claim_rejected, credit released). Prompts carry
// `resumeForLlm` text with PII redacted and `profileSnapshotForLlm` only; the
// signature is placed after the model ran. The letter is never sent by us.

import { logger } from '../../services/LoggerService.js';
import { HttpError, isErrorCode } from '../../platform/http.js';
import { CreditReplayError, type CreditService } from '../../platform/credits/index.js';
import type { BrandId } from '../../platform/brand/registry.js';
import {
  COVER_LETTER_ERROR_CODES as E,
  LETTERS_PAGE_SIZE,
  LETTER_LENGTHS,
  LETTER_LOCALES,
  LETTER_TONES,
  REWRITES_PER_LETTER_PER_DAY,
  type CoverLetterSummary,
  type CoverLetterView,
  type DeleteLetterResponse,
  type LetterCitation,
  type LetterLength,
  type LetterLocale,
  type LetterTone,
  type ListLettersResponse,
  type VersionReason,
} from './contract.js';
import { checkLetterClaims, normalizeText, quotedIn, retryNote, splitSentences, type LetterSentence } from './claimCheck.js';
import type { FactCheckInput, FactCheckOutput, WriterInput, WriterOutput, WriterSentence } from './CoverLetterAgent.js';
import {
  assembleBody,
  citationsForBody,
  draftSentences,
  parseCitations,
  parseVersions,
  previewOf,
  pushVersion,
  remapCitations,
  sentenceViews,
  signatureFromResume,
  userSentencesOf,
  versionViews,
  type LetterDraft,
} from './letterBody.js';
import {
  contentDisposition,
  letterFileName,
  pdfFontsAvailable,
  renderLetterDocx,
  renderLetterPdf,
  sha256,
  type ExportAiLabel,
} from './letterExport.js';
import type { CoverLetterStore, LetterRow } from './store.js';

/** A pasted job post kept with a letter, so rewrites and regeneration can read it again (SR-37-1). */
export interface PostingSnapshot {
  title: string;
  company: string;
  text: string;
}

export interface RewriteBudget {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export interface CoverLetterDeps {
  store: CoverLetterStore;
  credits: Pick<CreditService, 'withCredit'>;
  /** aiAllowed(user) AND isEnabled('ai.text'). */
  aiAvailable: (userId: string) => Promise<boolean>;
  brandId: () => BrandId;
  market: () => 'intl' | 'cn';
  /** profileSnapshotForLlm(userId).text; '' when unavailable. */
  profileText: (userId: string) => Promise<string>;
  /** Resume text for a prompt: resumeForLlm + PII redaction (name removed). */
  resumeForPrompt: (markdown: string, name: string | null) => string;
  /** Free text for a prompt (pasted posts, instructions, the current letter): PII redaction. */
  redact: (text: string, name: string | null) => string;
  /** Pending Verify-details claims on a resume variant (WP-36a); 0 when unknown. */
  unverifiedClaims: (variantId: string) => Promise<number>;
  write: (input: WriterInput, options: { signal?: AbortSignal }) => Promise<WriterOutput>;
  factCheck: (input: FactCheckInput, options: { signal?: AbortSignal }) => Promise<FactCheckOutput>;
  /** Count `cost` rewrites for a letter today (0 = read only). */
  rewriteBudget: (letterId: string, cost: number) => Promise<RewriteBudget>;
  /** The configured writing model id (stored on the letter), or null. */
  modelId: () => string | null;
  label: {
    implicit: (input: { contentId: string; provider: string; userEdited: boolean; brand: BrandId }) => ExportAiLabel;
    newContentId: (brand: BrandId) => string;
    footerLine: (locale: string) => string;
    footerEnabled: (brand: BrandId) => boolean;
    log: (input: { userId: string; contentId: string; kind: string; provider: string; artifactId: string; brand: BrandId }) => Promise<void>;
  };
  /** Pasted job posts, kept on the letter (`RACoverLetter.postingSnapshot`, SR-37-1) so rewrites can read them again. */
  postings: {
    read: (letterId: string) => Promise<PostingSnapshot | null>;
    write: (letterId: string, snapshot: PostingSnapshot) => Promise<void>;
  };
  now?: () => Date;
}

export interface CreateLetterInput {
  jobId?: string;
  jd?: PostingSnapshot;
  resumeVariantId: string;
  tone?: LetterTone;
  length?: LetterLength;
  locale?: LetterLocale;
  trackerEntryId?: string;
}

export interface ExportResult {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  contentDisposition: string;
  sha256: string;
}

const MIN_RESUME_CHARS = 50;
const FILE_PREFIX: Record<string, string> = { zh: '求职信', 'zh-TW': '求職信' };
const CONTENT_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
} as const;

function randomKey(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function asTone(v: string): LetterTone {
  return (LETTER_TONES as readonly string[]).includes(v) ? (v as LetterTone) : 'plain';
}
function asLength(v: string): LetterLength {
  return (LETTER_LENGTHS as readonly string[]).includes(v) ? (v as LetterLength) : 'standard';
}
export function asLocale(v: string | null | undefined, fallback: LetterLocale = 'en'): LetterLocale {
  return (LETTER_LOCALES as readonly string[]).includes(v ?? '') ? (v as LetterLocale) : fallback;
}

/** Stand-in for a sentence the user wrote: the model sees the token, never the sentence, and must keep it as is. */
const userToken = (n: number) => `[[USER_${n}]]`;
const USER_TOKEN_RE = /\[\[USER_(\d+)\]\]/g;

/**
 * Replace each of the user's own sentences in `body` with a token. The model
 * never sees them (so a contact line is not redacted and then echoed with a
 * placeholder), and `restoreUserTokens` puts the exact sentences back.
 */
export function tokenizeUserSentences(body: string, userSentences: readonly string[]): { text: string; tokens: Map<string, string> } {
  const tokens = new Map<string, string>();
  let text = body;
  // Longest first, so a sentence that contains another is replaced whole.
  const ordered = [...new Set(userSentences.map((u) => u.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const sentence of ordered) {
    if (!text.includes(sentence)) continue;
    const token = userToken(tokens.size + 1);
    tokens.set(token, sentence);
    text = text.split(sentence).join(token);
  }
  return { text, tokens };
}

/** Put the user's sentences back in place of their tokens; unknown tokens are dropped. */
export function restoreUserTokens(text: string, tokens: ReadonlyMap<string, string>): string {
  if (!text.includes('[[USER_')) return text;
  return text
    .replace(USER_TOKEN_RE, (token) => tokens.get(token) ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** The vendor part of a model id ('deepseek/deepseek-chat' → 'deepseek'), for the AI label. */
export function providerOf(model: string | null | undefined): string {
  const m = (model ?? '').trim();
  if (!m) return 'llm';
  const parts = m.split('/').filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2]! : parts[0]!;
}

/** Errors that already carry a platform code (content_blocked, ai_unavailable, phone binding, …) pass through. */
function isPlatformError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return err instanceof HttpError || (isErrorCode(code) && code !== 'internal_error') || code === 'phone_binding_required';
}

function toHttp(err: unknown): unknown {
  if (err instanceof CreditReplayError) {
    return new HttpError('conflict', err.code === 'request_already_completed' ? 'This request was already completed.' : 'This request is still running.', {
      reason: err.code,
    });
  }
  return err;
}

function rewriteLimitError(budget: RewriteBudget): HttpError {
  const retryAfterSec = Math.max(1, budget.retryAfterSec || 60);
  return new HttpError(
    'rate_limited',
    `You can rewrite a letter ${REWRITES_PER_LETTER_PER_DAY} times a day. Edit it by hand, or try again tomorrow.`,
    { retryAfterSec, reason: E.rewriteLimit, limit: REWRITES_PER_LETTER_PER_DAY },
    { 'Retry-After': String(retryAfterSec) },
  );
}

interface ComposeContext {
  userId: string;
  mode: 'write' | 'rewrite';
  tone: LetterTone;
  length: LetterLength;
  locale: LetterLocale;
  posting: PostingSnapshot;
  resumeText: string;
  profileText: string;
  currentLetter?: string;
  instruction?: string;
  /** rewrite: the letter's current citations (resolves `letter` cites, exempts the user's own sentences). */
  currentCitations?: LetterCitation[];
  /** rewrite: token → the user's own sentence it stands for in `currentLetter`. */
  userTokens?: ReadonlyMap<string, string>;
}

interface Composed {
  draft: LetterDraft;
  sentences: LetterSentence[];
  userSentences: string[];
}

export class CoverLetterService {
  private readonly now: () => Date;

  constructor(private readonly deps: CoverLetterDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  // ── reads ──

  private toSummary(row: LetterRow): CoverLetterSummary {
    return {
      id: row.id,
      title: row.title || null,
      jobId: row.jobId,
      trackerEntryId: row.trackerEntryId,
      tone: asTone(row.tone),
      length: asLength(row.length),
      locale: row.locale,
      preview: previewOf(row.bodyMarkdown),
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The visible AI line printed under an export, or null when the brand has it off. */
  private footerLineFor(locale: string): string | null {
    const brand = this.deps.brandId();
    return this.deps.label.footerEnabled(brand) ? this.deps.label.footerLine(locale) : null;
  }

  toView(row: LetterRow, extra: { aiAvailable: boolean; rewritesLeftToday: number | null; postingAvailable: boolean }): CoverLetterView {
    const citations = parseCitations(row.citations);
    const versions = parseVersions(row.versions);
    return {
      id: row.id,
      title: row.title || null,
      jobId: row.jobId,
      resumeVariantId: row.resumeVariantId,
      trackerEntryId: row.trackerEntryId,
      tone: asTone(row.tone),
      length: asLength(row.length),
      locale: row.locale,
      bodyMarkdown: row.bodyMarkdown,
      citations,
      sentences: sentenceViews(row.bodyMarkdown, citations),
      versions: versionViews(versions, row.bodyMarkdown),
      aiWritten: true,
      userEdited: citations.some((c) => c.source === 'user'),
      aiAvailable: extra.aiAvailable,
      rewritesLeftToday: extra.rewritesLeftToday,
      postingAvailable: extra.postingAvailable,
      pdfAvailable: pdfFontsAvailable([row.bodyMarkdown, this.footerLineFor(row.locale)], row.locale),
      updatedAt: row.updatedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async rewritesLeft(letterId: string, ai: boolean): Promise<number | null> {
    if (!ai) return null;
    try {
      return (await this.deps.rewriteBudget(letterId, 0)).remaining;
    } catch {
      return null;
    }
  }

  /** A letter written from a job id can always re-read its post; a pasted post only when it was kept (SR-37-1). */
  private async postingAvailable(row: LetterRow): Promise<boolean> {
    if (row.jobId) return true;
    try {
      return (await this.deps.postings.read(row.id)) !== null;
    } catch {
      return false;
    }
  }

  private async view(userId: string, row: LetterRow, known?: { aiAvailable?: boolean; rewritesLeftToday?: number | null }): Promise<CoverLetterView> {
    const aiAvailable = known?.aiAvailable ?? (await this.deps.aiAvailable(userId));
    const rewritesLeftToday = known?.rewritesLeftToday !== undefined ? known.rewritesLeftToday : await this.rewritesLeft(row.id, aiAvailable);
    return this.toView(row, { aiAvailable, rewritesLeftToday, postingAvailable: await this.postingAvailable(row) });
  }

  private async letterOrThrow(userId: string, letterId: string): Promise<LetterRow> {
    const row = await this.deps.store.findLetter(userId, letterId);
    if (!row) throw new HttpError('not_found', 'Cover letter not found.', { reason: E.notFound });
    return row;
  }

  async list(userId: string, query: { jobId?: string; cursor?: string }): Promise<ListLettersResponse> {
    const [rows, aiAvailable] = await Promise.all([
      this.deps.store.listLetters(userId, { jobId: query.jobId, cursor: query.cursor, limit: LETTERS_PAGE_SIZE + 1 }),
      this.deps.aiAvailable(userId),
    ]);
    const page = rows.slice(0, LETTERS_PAGE_SIZE);
    return {
      items: page.map((r) => this.toSummary(r)),
      cursor: rows.length > LETTERS_PAGE_SIZE ? page[page.length - 1]!.id : null,
      aiAvailable,
    };
  }

  async get(userId: string, letterId: string): Promise<CoverLetterView> {
    return this.view(userId, await this.letterOrThrow(userId, letterId));
  }

  /** The newest letter for a job (Assistant, Ready to apply, job detail). */
  async getForJob(userId: string, jobId: string): Promise<CoverLetterView | null> {
    const [row] = await this.deps.store.listLetters(userId, { jobId, limit: 1 });
    return row ? this.view(userId, row) : null;
  }

  // ── AI writing ──

  private async assertAi(userId: string): Promise<void> {
    if (!(await this.deps.aiAvailable(userId))) throw new HttpError('ai_unavailable');
  }

  private async posting(userId: string, jobId: string | null, letterId?: string, jd?: PostingSnapshot): Promise<PostingSnapshot> {
    if (jd) return jd;
    if (jobId) {
      const job = await this.deps.store.findJob(userId, jobId, this.deps.market());
      if (!job) throw new HttpError('not_found', 'Job not found.', { reason: E.jobNotFound });
      const text = [job.descriptionPlain, job.responsibilities, job.qualifications].filter((t) => t && t.trim()).join('\n\n');
      return { title: job.title, company: job.companyName, text };
    }
    const saved = letterId ? await this.deps.postings.read(letterId) : null;
    if (!saved) {
      throw new HttpError('conflict', 'Rewriting needs the job post, and the post for this letter was not kept. Write a new letter and paste the post again.', {
        reason: E.postingUnavailable,
      });
    }
    return saved;
  }

  private async resumeContext(userId: string, variantId: string): Promise<{ resumeText: string; signature: string | null }> {
    const variant = await this.deps.store.findVariant(userId, variantId);
    if (!variant) throw new HttpError('not_found', 'Resume not found.', { reason: 'resume_not_found' });
    const pending = await this.deps.unverifiedClaims(variantId);
    if (pending > 0) {
      throw new HttpError('conflict', 'This resume has lines to check in Verify details. Check them, then write the letter.', {
        reason: E.resumeUnverified,
        count: pending,
      });
    }
    const signature = signatureFromResume(variant.resumeMarkdown);
    const resumeText = this.deps.resumeForPrompt(variant.resumeMarkdown, signature);
    if (resumeText.trim().length < MIN_RESUME_CHARS) {
      throw new HttpError('invalid_request', 'This resume is too short to write a letter from. Add your experience first.', { reason: E.resumeTooShort });
    }
    return { resumeText, signature };
  }

  /** Resolve `letter` cites of a rewrite to the citations of the sentence they quote. */
  private resolveCites(sentences: WriterSentence[], current: LetterCitation[]): LetterSentence[] {
    return sentences.map((s) => {
      const cites: LetterSentence['cites'] = [];
      for (const c of s.cites) {
        if (c.source !== 'letter') {
          cites.push({ source: c.source, quote: c.quote });
          continue;
        }
        for (const cc of current) {
          if (cc.source === 'user' || !cc.sentence) continue;
          if (quotedIn(c.quote, cc.sentence) || quotedIn(cc.sentence, c.quote)) cites.push({ source: cc.source, quote: cc.ref });
        }
      }
      return { text: s.text, kind: s.kind, cites };
    });
  }

  /** Write (or rewrite), check, retry once with the problems called out; throws when the second try fails too. */
  private async compose(ctx: ComposeContext): Promise<Composed> {
    const userSentences = userSentencesOf(ctx.currentCitations ?? []);
    let note: string | undefined;
    let lastIssues = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let out: WriterOutput;
      try {
        out = await this.deps.write(
          {
            mode: ctx.mode,
            tone: ctx.tone,
            length: ctx.length,
            locale: ctx.locale,
            job: { title: ctx.posting.title, company: ctx.posting.company, text: ctx.posting.text },
            resumeText: ctx.resumeText,
            profileText: ctx.profileText,
            currentLetter: ctx.currentLetter,
            instruction: ctx.instruction,
            retryNote: note,
          },
          {},
        );
      } catch (err) {
        // Never retried on another model (content_blocked, ai_unavailable, brand policy pass through).
        if (isPlatformError(err)) throw err;
        logger.warn('COVER_LETTER', 'writer failed', { userId: ctx.userId, error: err instanceof Error ? err.message : String(err) });
        throw new HttpError('ai_unavailable', 'The letter could not be written right now. No credit was used.', { reason: 'writer_failed' });
      }
      const tokens = ctx.userTokens ?? new Map<string, string>();
      const restored = (t: string) => restoreUserTokens(t, tokens);
      const draft: LetterDraft = {
        greeting: restored(out.greeting),
        closing: restored(out.closing),
        paragraphs: out.paragraphs
          .map((p) =>
            this.resolveCites(
              p.map((s) => ({ ...s, text: restored(s.text), cites: s.cites.map((c) => ({ ...c, quote: restored(c.quote) })) })).filter((s) => s.text),
              ctx.currentCitations ?? [],
            ),
          )
          .filter((p) => p.length > 0),
      };
      const sentences = draftSentences(draft);
      if (sentences.length === 0) {
        note = '## Your previous answer had no letter in it\nReturn the JSON with the letter.';
        lastIssues = 1;
        continue;
      }
      const det = checkLetterClaims({
        sentences,
        resumeText: ctx.resumeText,
        postingText: `${ctx.posting.title}\n${ctx.posting.company}\n${ctx.posting.text}`,
        companyName: ctx.posting.company,
        locale: ctx.locale,
        userSentences,
      });
      if (!det.passed) {
        logger.warn('COVER_LETTER', 'claim check failed', { userId: ctx.userId, attempt, issues: det.issues.map((i) => `${i.kind}:${i.detail}`).slice(0, 8) });
        note = retryNote(det.issues);
        lastIssues = det.issues.length;
        continue;
      }
      const userSet = new Set(userSentences.map(normalizeText));
      const toCheck = sentences.map((s) => s.text).filter((t) => !userSet.has(normalizeText(t)));
      let fc: FactCheckOutput;
      try {
        fc = toCheck.length
          ? await this.deps.factCheck({ resumeText: ctx.resumeText, postingText: ctx.posting.text, sentences: toCheck, locale: ctx.locale }, {})
          : { passed: true, violations: [] };
      } catch (err) {
        if (isPlatformError(err)) throw err;
        // Fail closed: a letter nobody could check is not shown.
        logger.warn('COVER_LETTER', 'fact check failed to run', { userId: ctx.userId, error: err instanceof Error ? err.message : String(err) });
        throw new HttpError('ai_unavailable', 'The letter could not be checked right now, so it was not saved. No credit was used.', { reason: 'fact_check_failed' });
      }
      if (!fc.passed) {
        logger.warn('COVER_LETTER', 'fact check rejected the letter', { userId: ctx.userId, attempt, violations: fc.violations.length });
        note = `## Your previous letter failed the fact check\n${fc.violations
          .slice(0, 10)
          .map((v, i) => `${i + 1}. [${v.severity}] "${v.claim}" — the resume says: "${v.originalSupport}"`)
          .join('\n')}\n\nWrite it again. Never present the employer's requirements as the candidate's experience.`;
        lastIssues = Math.max(1, fc.violations.length);
        continue;
      }
      return { draft, sentences, userSentences };
    }
    throw new HttpError(
      'conflict',
      'The AI wrote lines your resume does not show, so the letter was not saved. No credit was used. Try again, or add the missing experience to your resume.',
      { reason: E.claimRejected, issues: lastIssues },
    );
  }

  /** Body + citations for a composed letter (the user's kept sentences are marked `user`). */
  private finish(composed: Composed, locale: string, signature: string | null): { body: string; citations: LetterCitation[] } {
    const body = assembleBody(composed.draft, locale, signature);
    const citations = citationsForBody(body, composed.sentences);
    if (composed.userSentences.length) {
      const users = new Set(composed.userSentences.map(normalizeText));
      const cited = new Set(citations.map((c) => c.sentenceIdx));
      splitSentences(body).forEach((piece, idx) => {
        if (!cited.has(idx) && users.has(normalizeText(piece))) citations.push({ sentenceIdx: idx, source: 'user', ref: '', sentence: piece });
      });
      citations.sort((a, b) => a.sentenceIdx - b.sentenceIdx);
    }
    return { body, citations };
  }

  private async logGenerated(userId: string, letterId: string, model: string | null): Promise<void> {
    if (this.deps.market() !== 'cn') return;
    try {
      const brand = this.deps.brandId();
      await this.deps.label.log({ userId, contentId: this.deps.label.newContentId(brand), kind: 'cover_letter', provider: providerOf(model), artifactId: letterId, brand });
    } catch (err) {
      logger.debug('COVER_LETTER', 'AI label log unavailable', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async create(userId: string, input: CreateLetterInput, options: { idempotencyKey?: string | null; requestLocale?: string } = {}): Promise<CoverLetterView> {
    await this.assertAi(userId);
    if (input.trackerEntryId && !(await this.deps.store.ownsTrackerEntry(userId, input.trackerEntryId))) {
      throw new HttpError('not_found', 'Application not found.', { reason: E.trackerEntryNotFound });
    }
    const posting = await this.posting(userId, input.jobId ?? null, undefined, input.jd);
    const { resumeText, signature } = await this.resumeContext(userId, input.resumeVariantId);
    const tone = input.tone ?? 'plain';
    const length = input.length ?? 'standard';
    // GoApply writes in Chinese unless the caller (or the request) asks otherwise; seams that pass no locale get the brand's default.
    const locale = asLocale(input.locale ?? options.requestLocale, this.deps.market() === 'cn' ? 'zh' : 'en');
    const promptPosting: PostingSnapshot = { ...posting, text: this.deps.redact(posting.text, signature) };
    const profileText = await this.safeProfile(userId);
    const key = options.idempotencyKey || randomKey('cover_letter');

    try {
      const row = await this.deps.credits.withCredit(
        { userId, bucket: 'cover_letter', idempotencyKey: key, refType: 'cover_letter' },
        async (reservation) => {
          const composed = await this.compose({ userId, mode: 'write', tone, length, locale, posting: promptPosting, resumeText, profileText });
          const { body, citations } = this.finish(composed, locale, signature);
          const createdAt = this.now().toISOString();
          const model = this.deps.modelId();
          const created = await this.deps.store.createLetter({
            userId,
            jobId: input.jobId ?? null,
            trackerEntryId: input.trackerEntryId ?? null,
            resumeVariantId: input.resumeVariantId,
            title: [posting.title, posting.company].filter((s) => s && s.trim()).join(' · ').slice(0, 200),
            tone,
            length,
            locale,
            bodyMarkdown: body,
            versions: [{ body, reason: 'generated' satisfies VersionReason, createdAt, citations }],
            citations,
            model,
            creditLedgerId: reservation.id,
          });
          if (input.jd) await this.deps.postings.write(created.id, input.jd);
          if (input.trackerEntryId) await this.deps.store.linkTrackerEntry(userId, created.id, input.trackerEntryId, null);
          return created;
        },
      );
      await this.logGenerated(userId, row.id, row.model);
      return this.toView(row, { aiAvailable: true, rewritesLeftToday: REWRITES_PER_LETTER_PER_DAY, postingAvailable: await this.postingAvailable(row) });
    } catch (err) {
      throw toHttp(err);
    }
  }

  private async safeProfile(userId: string): Promise<string> {
    try {
      return await this.deps.profileText(userId);
    } catch (err) {
      logger.debug('COVER_LETTER', 'profile snapshot unavailable', { error: err instanceof Error ? err.message : String(err) });
      return '';
    }
  }

  async regenerate(
    userId: string,
    letterId: string,
    input: { tone?: LetterTone; length?: LetterLength; locale?: LetterLocale },
    options: { idempotencyKey?: string | null } = {},
  ): Promise<CoverLetterView> {
    await this.assertAi(userId);
    const row = await this.letterOrThrow(userId, letterId);
    const posting = await this.posting(userId, row.jobId, row.id);
    const { resumeText, signature } = await this.resumeContext(userId, row.resumeVariantId);
    const tone = input.tone ?? asTone(row.tone);
    const length = input.length ?? asLength(row.length);
    const locale = asLocale(input.locale ?? row.locale);
    const promptPosting: PostingSnapshot = { ...posting, text: this.deps.redact(posting.text, signature) };
    const profileText = await this.safeProfile(userId);
    const key = options.idempotencyKey || randomKey('cover_letter_regen');
    try {
      const updated = await this.deps.credits.withCredit(
        { userId, bucket: 'cover_letter', idempotencyKey: key, refType: 'cover_letter', refId: letterId },
        async (reservation) => {
          const composed = await this.compose({ userId, mode: 'write', tone, length, locale, posting: promptPosting, resumeText, profileText });
          const { body, citations } = this.finish(composed, locale, signature);
          const versions = pushVersion(parseVersions(row.versions), { body, reason: 'regenerate', createdAt: this.now().toISOString(), citations }, this.now());
          const saved = await this.deps.store.updateLetter(userId, letterId, {
            tone,
            length,
            locale,
            bodyMarkdown: body,
            citations,
            versions,
            model: this.deps.modelId(),
            creditLedgerId: reservation.id,
          });
          if (!saved) throw new HttpError('not_found', 'Cover letter not found.', { reason: E.notFound });
          return saved;
        },
      );
      await this.logGenerated(userId, updated.id, updated.model);
      return this.view(userId, updated, { aiAvailable: true });
    } catch (err) {
      throw toHttp(err);
    }
  }

  async rewrite(userId: string, letterId: string, instruction: string): Promise<CoverLetterView> {
    await this.assertAi(userId);
    const row = await this.letterOrThrow(userId, letterId);
    const posting = await this.posting(userId, row.jobId, row.id);
    const { resumeText, signature } = await this.resumeContext(userId, row.resumeVariantId);
    // Read-only check first: a rewrite that fails or is rejected does not use one of today's rewrites.
    const before = await this.deps.rewriteBudget(letterId, 0);
    if (!before.allowed || before.remaining <= 0) throw rewriteLimitError(before);
    const locale = asLocale(row.locale);
    const currentCitations = parseCitations(row.citations);
    const { text: tokenized, tokens: userTokens } = tokenizeUserSentences(row.bodyMarkdown, userSentencesOf(currentCitations));
    const composed = await this.compose({
      userId,
      mode: 'rewrite',
      tone: asTone(row.tone),
      length: asLength(row.length),
      locale,
      posting: { ...posting, text: this.deps.redact(posting.text, signature) },
      resumeText,
      profileText: await this.safeProfile(userId),
      currentLetter: this.deps.redact(tokenized, signature),
      instruction: this.deps.redact(instruction, signature),
      currentCitations,
      userTokens,
    });
    // Count the rewrite only now that it passed; re-check in case another tab used the last one meanwhile.
    const budget = await this.deps.rewriteBudget(letterId, 1);
    if (!budget.allowed) throw rewriteLimitError(budget);
    const { body, citations } = this.finish(composed, locale, signature);
    const versions = pushVersion(parseVersions(row.versions), { body, reason: 'rewrite', createdAt: this.now().toISOString(), citations }, this.now());
    const saved = await this.deps.store.updateLetter(userId, letterId, { bodyMarkdown: body, citations, versions, model: this.deps.modelId() });
    if (!saved) throw new HttpError('not_found', 'Cover letter not found.', { reason: E.notFound });
    await this.logGenerated(userId, saved.id, saved.model);
    return this.view(userId, saved, { aiAvailable: true, rewritesLeftToday: budget.remaining });
  }

  // ── edits ──

  async patch(userId: string, letterId: string, body: { bodyMarkdown?: string; title?: string; trackerEntryId?: string | null }): Promise<CoverLetterView> {
    const row = await this.letterOrThrow(userId, letterId);
    const update: Parameters<CoverLetterStore['updateLetter']>[2] = {};
    if (body.title !== undefined) update.title = body.title;
    if (body.bodyMarkdown !== undefined && body.bodyMarkdown !== row.bodyMarkdown) {
      const citations = remapCitations(row.bodyMarkdown, parseCitations(row.citations), body.bodyMarkdown);
      update.bodyMarkdown = body.bodyMarkdown;
      update.citations = citations;
      update.versions = pushVersion(parseVersions(row.versions), { body: body.bodyMarkdown, reason: 'edit', createdAt: this.now().toISOString(), citations }, this.now());
    }
    if (body.trackerEntryId !== undefined && body.trackerEntryId !== row.trackerEntryId) {
      if (body.trackerEntryId && !(await this.deps.store.ownsTrackerEntry(userId, body.trackerEntryId))) {
        throw new HttpError('not_found', 'Application not found.', { reason: E.trackerEntryNotFound });
      }
      update.trackerEntryId = body.trackerEntryId;
    }
    const saved = Object.keys(update).length ? await this.deps.store.updateLetter(userId, letterId, update) : row;
    if (!saved) throw new HttpError('not_found', 'Cover letter not found.', { reason: E.notFound });
    if (update.trackerEntryId !== undefined) await this.deps.store.linkTrackerEntry(userId, letterId, update.trackerEntryId, row.trackerEntryId);
    return this.view(userId, saved);
  }

  /** Attach a letter to an application (Ready to apply kit, tracker drawer). */
  async attach(userId: string, letterId: string, trackerEntryId: string | null): Promise<CoverLetterView> {
    return this.patch(userId, letterId, { trackerEntryId });
  }

  async restore(userId: string, letterId: string, versionIndex: number): Promise<CoverLetterView> {
    const row = await this.letterOrThrow(userId, letterId);
    const versions = parseVersions(row.versions);
    const v = versions[versionIndex];
    if (!v) throw new HttpError('not_found', 'That version is not stored any more.', { reason: E.versionNotFound });
    const citations = v.citations ?? remapCitations(row.bodyMarkdown, parseCitations(row.citations), v.body);
    const next = pushVersion(versions, { body: v.body, reason: 'restore', createdAt: this.now().toISOString(), citations }, this.now());
    const saved = await this.deps.store.updateLetter(userId, letterId, { bodyMarkdown: v.body, citations, versions: next });
    if (!saved) throw new HttpError('not_found', 'Cover letter not found.', { reason: E.notFound });
    return this.view(userId, saved);
  }

  async remove(userId: string, letterId: string): Promise<DeleteLetterResponse> {
    const ok = await this.deps.store.softDelete(userId, letterId, this.now());
    if (!ok) throw new HttpError('not_found', 'Cover letter not found.', { reason: E.notFound });
    return { deleted: true };
  }

  // ── export ──

  async exportFile(userId: string, letterId: string, query: { format: 'pdf' | 'docx'; trackerEntryId?: string }): Promise<ExportResult> {
    const row = await this.letterOrThrow(userId, letterId);
    if (query.trackerEntryId && !(await this.deps.store.ownsTrackerEntry(userId, query.trackerEntryId))) {
      throw new HttpError('not_found', 'Application not found.', { reason: E.trackerEntryNotFound });
    }
    const brand = this.deps.brandId();
    const contentId = this.deps.label.newContentId(brand);
    const provider = providerOf(row.model);
    const userEdited = parseCitations(row.citations).some((c) => c.source === 'user');
    const label = this.deps.label.implicit({ contentId, provider, userEdited, brand });
    const footerLine = this.footerLineFor(row.locale);
    // Refuse before any label or artifact row is written: a PDF without the glyphs would be unreadable.
    if (query.format === 'pdf' && !pdfFontsAvailable([row.bodyMarkdown, footerLine], row.locale)) {
      throw new HttpError('conflict', 'PDF is not available for this language yet. Download Word instead.', { reason: E.pdfUnavailable });
    }
    const input = { body: row.bodyMarkdown, title: row.title || 'Cover letter', locale: row.locale, label, footerLine };
    const buffer = query.format === 'pdf' ? await renderLetterPdf(input) : await renderLetterDocx(input);
    const fileName = letterFileName(row.title, query.format, FILE_PREFIX[row.locale]);
    const digest = sha256(buffer);
    try {
      await this.deps.label.log({ userId, contentId, kind: 'cover_letter', provider, artifactId: row.id, brand });
    } catch (err) {
      logger.warn('COVER_LETTER', 'AI label log failed', { error: err instanceof Error ? err.message : String(err) });
    }
    // Only the application the letter is attached to records the file as sent with it.
    if (query.trackerEntryId && query.trackerEntryId === row.trackerEntryId) {
      await this.deps.store.recordArtifact({
        userId,
        trackerEntryId: query.trackerEntryId,
        coverLetterId: row.id,
        fileName,
        format: query.format,
        fileSha256: digest,
        channel: 'download',
      });
    }
    return { buffer, fileName, contentType: CONTENT_TYPES[query.format], contentDisposition: contentDisposition(fileName), sha256: digest };
  }
}
