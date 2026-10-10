// server/src/interview-engine/routes/practiceGate.ts
//
// The brand rules every first-party practice route checks BEFORE anything
// reaches a model (TASK_PLAN §2.2: GoApply AI calls go through `aiAllowed`).
//
//   RoboApply (market intl): always open.
//   GoApply   (market cn):   AI practice needs a bound phone (403
//       phone_binding_required) and a live `ai_resume_parsing` consent
//       (aiAllowed → 503 ai_unavailable / ai_consent_required); voice also
//       needs the `ai.interviewVoice` capability (503 ai_unavailable /
//       voice_unavailable — the setup then offers the written practice).
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
  const [{ phoneBindingRequired }, { aiAllowed }, { isEnabledForBrand }] = await Promise.all([
    import('../../features/auth-cn/index.js'),
    loadConsent(),
    import('../../platform/flags.js'),
  ]);
  let reason: PracticeGateReason | null = null;
  // Both lookups fail closed: an error counts as "not allowed".
  if (await phoneBindingRequired(userId).catch(() => true)) reason = 'phone_binding_required';
  else if (!(await aiAllowed({ id: userId, brand: brand.id }).catch(() => false))) reason = 'ai_consent_required';
  const voiceOn = isEnabledForBrand('ai.interviewVoice', brand, process.env);
  return {
    ai: { allowed: reason === null, reason },
    voice: { available: reason === null && voiceOn, reason: reason ?? (voiceOn ? null : 'voice_unavailable') },
  };
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
