// server/src/features/onboarding/service.ts — the onboarding service (WP-30).
//
// Implements FND-5's `OnboardingService` interface plus the remaining
// endpoints (title suggest, market snapshot, resume seed). Every collaborator
// is injected (`OnboardingDeps`); `createDefaultOnboardingDeps()` wires the
// real ones. The O6 pipeline lives in match.ts.
//
// Where answers go (PUT /steps/:step is an idempotent upsert):
//   - every step: SeekerProfile.onboardingAnswers[step] (+ stage, branch)
//   - situation: RAProfile.seekerType; branch = urgent | explore
//   - basics: default search profile filters (titles, job types, places,
//     remote, sponsorship) + RAProfile.workAuth sponsorship rows
//   - goal: RAProfile.careerGoal (the feed reads answers.goal for ranking)
//   - preferences: filters (industries, skills, sizes, pay floor, work models)
//   - resume: the chosen variant id (O6 reads it)
//   - confirm: filters (levels, extra titles), the profile's email summary
//     (alertDigest), the LinkedIn link, the acquisition answer
//   - GoApply steps: validated by features/onboarding-cn (WP-31 seam);
//     `cnFields` written only with the documented keys.

import type { z } from 'zod';
import { HttpError, parseInput } from '../../platform/http.js';
import type { BrandId, ProductBrand } from '../../platform/brand/registry.js';
import type { FilterSetPatch } from '../search/index.js';
import type { CnStepValidation } from '../onboarding-cn/index.js';
import {
  ONBOARDING_EXTRA_ERROR_CODES,
  ONBOARDING_MVP_COUNTRIES,
  ROBOAPPLY_STEP_BODY_SCHEMAS,
  ResumeStepSchema,
  isStageOfBrand,
  type FirstValueContext,
  type MarketSnapshotResponse,
  type OnboardingAnswers,
  type OnboardingBranch,
  type OnboardingConfirmBodySchema,
  type OnboardingCountry,
  type OnboardingMe,
  type OnboardingResumeResponse,
  type OnboardingStage,
  type OnboardingStageResponse,
  type OnboardingStateView,
  type StepResponse,
  type TitleSuggestionView,
} from './contract.js';
import {
  basicsToFilters,
  confirmToFilters,
  parsedResumeSkills,
  preferencesToFilters,
  seedSeniorityToLevels,
  sponsorshipToWorkAuth,
  titlesToTaxonomyIds,
  validFieldsOf,
} from './mapping.js';
import type { OnboardingRecord, OnboardingRepo, ResumeVariantRow } from './repo.js';
import { OnboardingProfileMissingError } from './repo.js';
import {
  StageError,
  afterSave,
  assertStepSavable,
  branchForTiming,
  effectiveStage,
  isPaused,
  meOf,
  parseBranch,
  progressOf,
  routeFor,
  storedStage,
} from './stageMachine.js';
import type { SnapshotQuery } from './snapshot.js';

/** Request-scoped facts the service needs. */
export interface OnboardingContext {
  brand: ProductBrand;
  /** Visitor country from the edge header, when known (ISO-2). */
  country?: string | null;
  locale?: string | null;
  firstValue?: FirstValueContext;
}

/** The default search profile, as far as onboarding needs it. */
export interface SearchProfileRef {
  id: string;
  version: number;
}

export interface OnboardingDeps {
  repo: OnboardingRepo;
  now?: () => Date;
  searchProfiles: {
    /** The default profile (created from legacy preferences on first use). */
    getDefault(userId: string): Promise<SearchProfileRef>;
    update(userId: string, id: string, input: { version: number; filtersPatch?: FilterSetPatch; alertDigest?: 'daily' | 'weekly' | null }): Promise<SearchProfileRef>;
  };
  profile: {
    setLinkedin(userId: string, url: string, brand: ProductBrand): Promise<void>;
    setSponsorship(userId: string, needs: Record<string, 'yes' | 'no' | 'not_sure'>, brand: ProductBrand): Promise<void>;
  };
  /** WP-31 validator; `ctx.answers` (stored onboardingAnswers) carries the G2 identity G3/G4 depend on. */
  validateCnStep(step: string, body: unknown, ctx: { answers: Record<string, unknown> | null }): Promise<CnStepValidation>;
  /** WP-31 writer: the step's consent records (ledger), `RAProfile.cnFields` and default-filter patch. */
  applyCnStep(userId: string, brand: ProductBrand, result: CnStepValidation, opts: { locale?: string | null }): Promise<unknown>;
  snapshot(q: SnapshotQuery): Promise<MarketSnapshotResponse>;
  titleSuggest(q: string, locale: string): TitleSuggestionView[];
  /** Deterministic resume seed (raResumeSeed). */
  seedResume(row: ResumeVariantRow): { roles: string[]; seniority: string | null; years: number | null };
  /** AI role suggestions for a resume with no readable titles; null when not allowed / failed. Only called when aiAllowed. */
  aiSeedRoles?(row: ResumeVariantRow, locale: string): Promise<string[] | null>;
  aiAllowed(userId: string): Promise<boolean>;
  /** Consume one onboarding resume use (10/day, persisted); false when spent. Returns retry seconds when refused. */
  consumeResumeQuota(userId: string): Promise<{ allowed: boolean; retryAfterSec: number }>;
  /**
   * Grant the free onboarding resume check (WP-22 seam; idempotent per user).
   * Only a 'granted' answer queues a check: a later call never spends the
   * user's own resume_check allowance.
   */
  grantFreeResumeCheck(userId: string): Promise<'granted' | 'already_granted'>;
  /** Queue the free check for one resume (dedupe is per user, so at most one is ever queued). */
  queueResumeCheck(userId: string, variantId: string, targetTitle: string | null): Promise<void>;
  /** Non-fatal problems (tests leave it out). */
  warn?(message: string, meta: Record<string, unknown>): void;
}

export interface OnboardingServiceImpl {
  meFor(userId: string, brand: BrandId): Promise<OnboardingMe>;
  getState(userId: string, ctx: OnboardingContext): Promise<OnboardingStateView>;
  saveStep(userId: string, step: string, body: Record<string, unknown>, ctx: OnboardingContext): Promise<StepResponse>;
  confirm(userId: string, body: z.infer<typeof OnboardingConfirmBodySchema>, ctx: OnboardingContext): Promise<OnboardingStageResponse>;
  complete(userId: string, ctx: OnboardingContext): Promise<OnboardingStageResponse>;
  skip(userId: string, ctx: OnboardingContext): Promise<OnboardingStageResponse>;
  titleSuggest(q: string, locale: string): TitleSuggestionView[];
  marketSnapshot(query: { taxonomyId: string; country: string; city?: string }, ctx: OnboardingContext): Promise<MarketSnapshotResponse>;
  resume(userId: string, resumeVariantId: string, ctx: OnboardingContext): Promise<OnboardingResumeResponse>;
  /** Apply the stored answers to the search profile again (O6 "Saving what you're looking for"). */
  applyAnswers(userId: string, ctx: OnboardingContext): Promise<SearchProfileRef>;
}

const CN_STEPS = new Set(['consent', 'identity', 'education', 'intent', 'tags', 'confirm']);

export function stageErrorToHttp(err: StageError): HttpError {
  const code = err.reason === 'onboarding_step_required' ? 'invalid_request' : 'conflict';
  return new HttpError(code, err.message, { reason: err.reason });
}

function rethrow(err: unknown): never {
  if (err instanceof StageError) throw stageErrorToHttp(err);
  if (err instanceof OnboardingProfileMissingError) throw new HttpError('not_found', 'Finish creating your account first.');
  throw err;
}

/** Visitor country → an MVP country, else null (no guessing). */
export function defaultCountry(country: string | null | undefined, locale: string | null | undefined): OnboardingCountry | null {
  const c = (country ?? '').toUpperCase();
  if ((ONBOARDING_MVP_COUNTRIES as readonly string[]).includes(c) && c !== 'REMOTE') return c as OnboardingCountry;
  if (locale === 'zh-TW') return 'TW';
  return null;
}

function omitSkip(body: Record<string, unknown>): Record<string, unknown> {
  const { skip: _skip, ...rest } = body;
  return rest;
}

export function createOnboardingService(deps: OnboardingDeps): OnboardingServiceImpl {
  const now = deps.now ?? (() => new Date());
  const { repo } = deps;

  async function readOrThrow(userId: string): Promise<OnboardingRecord> {
    const rec = await repo.read(userId);
    if (!rec) throw new HttpError('not_found', 'Finish creating your account first.');
    return rec;
  }

  /** Write a filter patch to the default profile; one retry on a version race. */
  async function patchFilters(userId: string, patch: FilterSetPatch, extra: { alertDigest?: 'daily' | 'weekly' | null } = {}): Promise<SearchProfileRef> {
    for (let attempt = 0; ; attempt++) {
      const profile = await deps.searchProfiles.getDefault(userId);
      try {
        return await deps.searchProfiles.update(userId, profile.id, { version: profile.version, filtersPatch: patch, ...extra });
      } catch (err) {
        if ((err as { code?: string }).code === 'version_conflict' && attempt === 0) continue;
        throw err;
      }
    }
  }

  /** Validate one step body. Returns the answers to store (and, for GoApply, the WP-31 result whose effects are applied). */
  async function validate(
    brand: ProductBrand,
    step: OnboardingStage,
    body: Record<string, unknown>,
    skip: boolean,
    stored: OnboardingAnswers,
  ): Promise<{ answers: Record<string, unknown>; cn?: CnStepValidation }> {
    if (brand.id === 'goapply' && CN_STEPS.has(step)) {
      const res = await deps.validateCnStep(step, body, { answers: stored });
      if (!res.ok) throw new HttpError('invalid_request', 'The answers are not valid.', { where: 'body', issues: res.issues ?? [] });
      return { answers: res.answers ?? {}, cn: res };
    }
    if (step === 'resume') return { answers: parseInput(ResumeStepSchema, body) as Record<string, unknown> };
    const schema = brand.id === 'roboapply' ? ROBOAPPLY_STEP_BODY_SCHEMAS[step as keyof typeof ROBOAPPLY_STEP_BODY_SCHEMAS] : undefined;
    if (!schema) throw new StageError('onboarding_step_not_available', `"${step}" is not a step that takes answers.`);
    if (!skip) return { answers: parseInput(schema as unknown as z.ZodType<Record<string, unknown>>, body) };
    // Skip keeps whatever was entered: each field is checked on its own.
    return { answers: validFieldsOf(schema as unknown as z.ZodObject, omitSkip(body)) };
  }

  /** Side effects of a saved step (after the answers are stored; each is idempotent). */
  async function applyEffects(
    userId: string,
    brand: ProductBrand,
    step: OnboardingStage,
    answers: Record<string, unknown>,
    all: OnboardingAnswers,
    skip: boolean,
    cn: CnStepValidation | undefined,
    locale: string | null | undefined,
  ): Promise<void> {
    // GoApply: WP-31 records the consents (with the prose version shown), merges cnFields and patches the default filters.
    if (cn) await deps.applyCnStep(userId, brand, cn, { locale: locale ?? null });
    if (brand.id !== 'roboapply') return;
    switch (step) {
      case 'situation':
        await repo.setProfileFields(userId, { seekerType: String(answers.seekerType) });
        return;
      case 'basics': {
        // Full answers, or the valid fields a skipped O2 kept (each applies on its own).
        const b = validFieldsOf(ROBOAPPLY_STEP_BODY_SCHEMAS.basics, answers) as Partial<z.infer<typeof ROBOAPPLY_STEP_BODY_SCHEMAS.basics>>;
        const patch = basicsToFilters(b);
        if (Object.keys(patch).length) await patchFilters(userId, patch);
        if (b.needsSponsorship && Object.keys(b.needsSponsorship).length) {
          await deps.profile.setSponsorship(userId, b.needsSponsorship, brand);
        }
        return;
      }
      case 'goal':
        if (typeof answers.goal === 'string') await repo.setProfileFields(userId, { careerGoal: answers.goal });
        else if (skip) await repo.setProfileFields(userId, { careerGoal: null });
        return;
      case 'preferences': {
        const p = ROBOAPPLY_STEP_BODY_SCHEMAS.preferences.safeParse(answers);
        if (p.success) await patchFilters(userId, preferencesToFilters(p.data));
        return;
      }
      case 'confirm': {
        const c = ROBOAPPLY_STEP_BODY_SCHEMAS.confirm.safeParse(answers);
        if (!c.success) return;
        const freq = c.data.alertFrequency ?? 'daily';
        await patchFilters(userId, confirmToFilters(c.data, all), { alertDigest: freq === 'off' ? null : freq });
        if (c.data.linkedinUrl) await deps.profile.setLinkedin(userId, c.data.linkedinUrl, brand);
        return;
      }
      default:
        return;
    }
  }

  async function saveStep(userId: string, stepRaw: string, body: Record<string, unknown>, ctx: OnboardingContext): Promise<StepResponse> {
    const brand = ctx.brand;
    try {
      if (!isStageOfBrand(brand.id, stepRaw)) {
        throw new StageError('onboarding_step_not_available', `"${stepRaw}" is not a step of this site.`);
      }
      const step = stepRaw as OnboardingStage;
      const skip = body.skip === true;
      const rec = await readOrThrow(userId);
      const { answers, cn } = await validate(brand, step, body, skip && step !== 'resume', rec.answers);
      const branchAfter: OnboardingBranch | null =
        brand.id !== 'roboapply' ? null : step === 'situation' ? branchForTiming(String(answers.timing)) : parseBranch(rec.path);
      assertStepSavable(brand.id, rec, step, { skip: skip || answers.skip === true, branchAfter });

      const t = now();
      const out = await repo.mutate(userId, (cur) => {
        assertStepSavable(brand.id, cur, step, { skip: skip || answers.skip === true, branchAfter });
        const transition = afterSave(brand.id, cur, step, branchAfter);
        const skippedList = new Set(Array.isArray(cur.answers.skipped) ? (cur.answers.skipped as string[]) : []);
        if (skip || answers.skip === true) skippedList.add(step);
        else skippedList.delete(step);
        const nextAnswers: OnboardingAnswers = { ...cur.answers, [step]: answers, skipped: [...skippedList] };
        if (transition.resumed) delete nextAnswers.leftEarly;
        const patch = {
          step: transition.step,
          path: brand.id === 'roboapply' ? transition.path : cur.path,
          answers: nextAnswers,
          ...(cur.startedAt ? {} : { startedAt: t }),
          ...(step === 'confirm' && brand.id === 'roboapply'
            ? {
                acquisitionSource: (answers.heardFrom as string | undefined) ?? null,
                acquisitionNote: (answers.heardFromNote as string | undefined) ?? null,
              }
            : {}),
        };
        return { patch, result: { transition, answers: nextAnswers, entry: cur.entry } };
      });

      await applyEffects(userId, brand, step, answers, out.answers, skip, cn, ctx.locale);
      return {
        stage: out.transition.step,
        nextStage: out.transition.nextStage,
        nextRoute: routeFor(brand.id, out.transition.nextStage, out.entry, ctx.firstValue),
      };
    } catch (err) {
      return rethrow(err);
    }
  }

  async function getState(userId: string, ctx: OnboardingContext): Promise<OnboardingStateView> {
    const rec = await readOrThrow(userId);
    const brand = ctx.brand.id;
    const at = effectiveStage(brand, rec);
    const completed = storedStage(brand, rec.step) === 'done' && !isPaused(brand, rec);
    return {
      brand,
      stage: at,
      nextRoute: completed ? null : routeFor(brand, at, rec.entry, ctx.firstValue),
      branch: brand === 'roboapply' ? parseBranch(rec.path) : null,
      answers: rec.answers,
      entry: rec.entry,
      completed,
      progress: progressOf(brand, rec),
      defaults: { country: defaultCountry(ctx.country, ctx.locale) },
    };
  }

  async function complete(userId: string, ctx: OnboardingContext): Promise<OnboardingStageResponse> {
    const brand = ctx.brand.id;
    try {
      const entry = await repo.mutate(userId, (cur) => {
        const at = effectiveStage(brand, cur);
        if (at !== 'tour' && at !== 'done') throw new StageError('onboarding_not_finished', `Finish "${at}" first.`);
        const answers = { ...cur.answers };
        delete answers.leftEarly;
        return { patch: { step: 'done', answers, completedAt: cur.completedAt ?? now() }, result: cur.entry };
      });
      return { stage: 'done', nextRoute: routeFor(brand, 'done', entry, ctx.firstValue) };
    } catch (err) {
      return rethrow(err);
    }
  }

  async function skip(userId: string, ctx: OnboardingContext): Promise<OnboardingStageResponse> {
    const brand = ctx.brand.id;
    try {
      const entry = await repo.mutate(userId, (cur) => {
        const at = effectiveStage(brand, cur);
        if (at === 'done') return { patch: null, result: cur.entry };
        if (at === 'tour') return { patch: { step: 'done', completedAt: cur.completedAt ?? now() }, result: cur.entry };
        const answers: OnboardingAnswers = { ...cur.answers, leftEarly: { at: now().toISOString(), stage: at } };
        return { patch: { step: 'done', answers, ...(cur.startedAt ? {} : { startedAt: now() }) }, result: cur.entry };
      });
      // Leaving early lands on the first-value screen, never on the carried job's page mid-setup.
      return { stage: 'done', nextRoute: routeFor(brand, 'done', { ...(entry ?? {}), jobId: undefined }, ctx.firstValue) };
    } catch (err) {
      return rethrow(err);
    }
  }

  /** The free onboarding check: queued only when this call is the one that granted it. Never throws. */
  async function startFreeCheck(userId: string, variantId: string, targetTitle: string | null): Promise<void> {
    try {
      if ((await deps.grantFreeResumeCheck(userId)) !== 'granted') return;
      await deps.queueResumeCheck(userId, variantId, targetTitle);
    } catch (err) {
      deps.warn?.('free resume check could not be queued (non-fatal)', { userId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function resume(userId: string, resumeVariantId: string, ctx: OnboardingContext): Promise<OnboardingResumeResponse> {
    const rec = await readOrThrow(userId);
    const at = effectiveStage(ctx.brand.id, rec);
    // O5 belongs to setup: once setup is finished, resumes are added from the Resume area.
    if (at === 'done' || at === 'tour') {
      throw new HttpError('conflict', 'Setup is already finished.', { reason: 'onboarding_step_not_available' });
    }
    // Ownership and readability first, so a bad id never spends a daily use.
    const row = await deps.repo.getResume(userId, resumeVariantId);
    if (!row) throw new HttpError('not_found', 'Resume not found.', { reason: ONBOARDING_EXTRA_ERROR_CODES.resumeNotFound });
    if (!row.resumeMarkdown?.trim() && !row.parsedData) {
      throw new HttpError('invalid_request', "We couldn't read this file. Try a PDF, or paste the text.", { reason: ONBOARDING_EXTRA_ERROR_CODES.resumeUnusable });
    }
    const quota = await deps.consumeResumeQuota(userId);
    if (!quota.allowed) {
      throw new HttpError(
        'rate_limited',
        'You have added the most resumes allowed today. Try again tomorrow.',
        { reason: ONBOARDING_EXTRA_ERROR_CODES.resumeDailyLimit, retryAfterSec: quota.retryAfterSec },
        { 'Retry-After': String(quota.retryAfterSec) },
      );
    }
    const seed = deps.seedResume(row);
    let roles = seed.roles;
    let aiSuggested = false;
    if (!roles.length && deps.aiSeedRoles && (await deps.aiAllowed(userId))) {
      const ai = await deps.aiSeedRoles(row, ctx.locale ?? 'en').catch(() => null);
      if (ai?.length) {
        roles = ai.slice(0, 3);
        aiSuggested = true;
      }
    }
    const response: OnboardingResumeResponse = {
      suggestedSeniority: seedSeniorityToLevels(seed.seniority, seed.years),
      suggestedTaxonomyIds: titlesToTaxonomyIds(roles),
      suggestedSkills: parsedResumeSkills(row.parsedData),
      profileDraft: { targetRoles: roles, years: seed.years, aiSuggested },
    };
    await repo
      .mutate(userId, (cur) => ({ patch: { answers: { ...cur.answers, resumeSuggestions: { ...response, resumeVariantId } } }, result: null }))
      .catch(rethrow);
    await startFreeCheck(userId, resumeVariantId, roles[0] ?? null);
    return response;
  }

  async function applyAnswers(userId: string, ctx: OnboardingContext): Promise<SearchProfileRef> {
    const rec = await readOrThrow(userId);
    if (ctx.brand.id !== 'roboapply') return deps.searchProfiles.getDefault(userId);
    let patch: FilterSetPatch = {};
    const basics = validFieldsOf(ROBOAPPLY_STEP_BODY_SCHEMAS.basics, rec.answers.basics);
    if (Object.keys(basics).length) patch = { ...patch, ...basicsToFilters(basics) };
    const prefs = ROBOAPPLY_STEP_BODY_SCHEMAS.preferences.safeParse(rec.answers.preferences);
    if (parseBranch(rec.path) === 'explore' && prefs.success && rec.answers.preferences) patch = { ...patch, ...preferencesToFilters(prefs.data) };
    if (!Object.keys(patch).length) return deps.searchProfiles.getDefault(userId);
    return patchFilters(userId, patch);
  }

  return {
    async meFor(userId, brand) {
      const rec = await repo.read(userId);
      return meOf(brand, rec ?? { step: 'done', path: null, answers: {} });
    },
    getState,
    saveStep,
    confirm: async (userId, body, ctx) => {
      const res = await saveStep(userId, 'confirm', body as Record<string, unknown>, ctx);
      return { stage: res.stage, nextRoute: res.nextRoute };
    },
    complete,
    skip,
    titleSuggest: (q, locale) => deps.titleSuggest(q, locale),
    marketSnapshot: (query, ctx) =>
      deps.snapshot({ market: ctx.brand.market, taxonomyId: query.taxonomyId, country: query.country, ...(query.city ? { city: query.city } : {}) }),
    resume,
    applyAnswers,
  };
}
