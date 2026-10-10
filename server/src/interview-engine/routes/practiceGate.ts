// server/src/interview-engine/routes/practiceGate.ts
//
// The brand rules every first-party practice route checks BEFORE anything
// reaches a model (TASK_PLAN §2.2: GoApply AI calls go through `aiAllowed`).
//
//   RoboApply (market intl): always open.
//   GoApply   (market cn):   AI practice needs a bound phone where one can be
//       bound (403 phone_binding_required; auth-cn decides) and a live
//       `ai_resume_parsing` consent (aiAllowed → 503 ai_unavailable /
//       ai_consent_required): GoApply's extra consent steps, which stay (D5).
//       Voice follows the `ai.interviewVoice` capability, which is ON by
//       default and runs on the shared LiveKit project when GoApply has no
//       plane of its own, AND a configuration a voice session can start on
//       (config.ts `voiceRoutingProblem`: an interview model the worker of
//       the plane can run; under CN_LLM_DOMESTIC_ONLY / CN_RESIDENCY_STRICT a
//       plane of its own). Without any LiveKit, with
//       FLAG_GOAPPLY_INTERVIEW_VOICE=false, or with such a problem, it is off
//       (503 ai_unavailable / voice_unavailable) and the setup offers the
//       written practice, never a voice option whose every start fails.
//
// Shared by the practice routes (externalRoutes.ts), the requirements preview
// (previewRoutes.ts) and the session routes that call a model
// (internalRoutes.ts: prepare, coach), so none of them can skip it.

import type { Request, Response } from 'express';
import type { ProductBrand } from '../../platform/brand/registry.js';

export type PracticeGateReason = 'phone_binding_required' | 'ai_consent_required' | 'voice_unavailable';

export interface PracticeGate {
  /** Live (voice/video) practice can start. */
  voice: { available: boolean; reason: PracticeGateReason | null };
  /** AI practice of any kind (voice or text) is allowed for this user. */
  ai: { allowed: boolean; reason: PracticeGateReason | null };
}

/** The brand of the current request (RoboApply when there is no brand context). */
export async function currentBrand(): Promise<ProductBrand> {
  const { getCurrentBrandOrDefault } = await import('../../platform/brand/brandContext.js');
  return getCurrentBrandOrDefault();
}

export function marketOf(brand: ProductBrand): 'intl' | 'cn' {
  return brand.market === 'cn' ? 'cn' : 'intl';
}

/**
 * The consent module, loaded once. The gate and the recording-consent read
 * run side by side on GoApply; one shared import keeps them on one module
 * instance (and one load) instead of two concurrent dynamic imports.
 */
let consentModule: Promise<typeof import('../../platform/consent/index.js')> | null = null;
export function loadConsent(): Promise<typeof import('../../platform/consent/index.js')> {
  consentModule ??= import('../../platform/consent/index.js');
  consentModule.catch(() => {
    consentModule = null;
  });
  return consentModule;
}

/** The brand rules for practice (RoboApply: always open; GoApply: phone, AI consent, voice capability). */
export async function practiceGate(userId: string, brand: ProductBrand): Promise<PracticeGate> {
  if (brand.market !== 'cn') {
    return { voice: { available: true, reason: null }, ai: { allowed: true, reason: null } };
  }
  const [{ phoneBindingRequired }, { aiAllowed }, { isEnabledForBrand }, config] = await Promise.all([
    import('../../features/auth-cn/index.js'),
    loadConsent(),
    import('../../platform/flags.js'),
    import('../config.js'),
  ]);
  let reason: PracticeGateReason | null = null;
  // Both lookups fail closed: an error counts as "not allowed".
  if (await phoneBindingRequired(userId).catch(() => true)) reason = 'phone_binding_required';
  else if (!(await aiAllowed({ id: userId, brand: brand.id }).catch(() => false))) reason = 'ai_consent_required';
  // The capability says the media plane is there and the product switch is
  // on; the routing check says a session can really start on it. Either one
  // missing = voice is unavailable and the written practice is offered.
  const voiceOn = isEnabledForBrand('ai.interviewVoice', brand, process.env) && voiceCanStart(config, brand);
  // Why voice is off, or runs on another plane than the operator set up, is
  // logged once (variable names only): a half-set CN_ voice or speech group is
  // never silent (PAR-1 request P4-2).
  try {
    config.warnVoiceConfigProblemsOnce(brand.id);
  } catch {
    /* the log line is best-effort */
  }
  return {
    ai: { allowed: reason === null, reason },
    voice: { available: reason === null && voiceOn, reason: reason ?? (voiceOn ? null : 'voice_unavailable') },
  };
}

/** A voice session of the brand can start (fails closed: an unreadable configuration is "no"). */
function voiceCanStart(config: typeof import('../config.js'), brand: ProductBrand): boolean {
  try {
    return config.voiceRoutingProblem(brand.id) === null;
  } catch {
    return false;
  }
}

export function gateStatus(reason: PracticeGateReason): number {
  return reason === 'phone_binding_required' ? 403 : 503;
}

export function gateBody(reason: PracticeGateReason) {
  return reason === 'phone_binding_required'
    ? { error: 'phone_binding_required', bindRoute: '/bind-phone' }
    : { error: 'ai_unavailable', reason };
}

/** Why AI practice is refused for this user on this brand, or null when it is allowed. */
export async function aiGateReason(userId: string, brand: ProductBrand): Promise<PracticeGateReason | null> {
  const gate = await practiceGate(userId, brand);
  return gate.ai.allowed ? null : gate.ai.reason ?? 'ai_consent_required';
}

/**
 * GoApply: no AI practice (voice or written) without a bound phone and the AI
 * consent. Sends the refusal (403 / 503); false = stop, nothing was sent to a model.
 */
export async function aiGateOpen(req: Request, res: Response, brand: ProductBrand): Promise<boolean> {
  const reason = await aiGateReason(req.user!.id, brand);
  if (!reason) return true;
  res.status(gateStatus(reason)).json(gateBody(reason));
  return false;
}
