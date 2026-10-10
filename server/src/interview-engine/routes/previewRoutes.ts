// backend/src/interview-engine/routes/previewRoutes.ts
//
// Pre-launch "Market Job Requirements" preview (cookie/JWT-authed UI surface).
// Surfaces the SAME market-grounded requirements + sample questions that will
// drive a real session — WITHOUT creating a session, room, agent, or recording.
// Reuses interviewPromptService.previewRequirements() (Tavily best-effort +
// blueprint agent with heuristic fallback), so it inherits the never-throws
// posture and degrades to a sensible role-based brief if everything fails.
//
//   POST /requirements/preview   { role?, jdText?, interviewType?, personaId?, language? }
//        → { requirements, webSources, sampleQuestions, inferredRole?, groundedOn, domain }
//
// NOT mounted on the external /v1 (X-API-Key) surface — internal UI only.
//
// Brand gate (INT-09, R7): the preview calls a model, so it checks the same
// gate as every other AI practice route FIRST. A GoApply user without a bound
// phone (403 phone_binding_required) or without the AI consent (503
// ai_unavailable) gets the refusal with zero model calls and zero searches.
// With the gate open the preview is the same on both brands (D5): grounded on
// the job post, else on a web search of the role. The search query is checked
// for personal information before it is sent, on either brand; a refused or
// failed search degrades to a role-based preview, never an error.

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { findPersona, findSessionType, findType, DEFAULT_PERSONA, DEFAULT_TYPE } from '../catalog/interviewCatalog.js';
import { CN_AI_INTERVIEW_FORMAT_ID, usesCnFormat } from '../../features/cn/interview/index.js';
import { normalizeCharacteristics } from '../prompt/characteristics.js';
import { normalizeLocale } from '../voice/voiceCatalog.js';
import { interviewPromptService } from '../prompt/interviewPromptService.js';
import { handleEngineError } from './errors.js';
import { aiGateOpen, currentBrand, marketOf } from './practiceGate.js';

const router = Router();

router.post('/requirements/preview', requireAuth, async (req: Request, res: Response) => {
  try {
    // Before anything else: no model call and no search for a user the brand's AI gate refuses.
    const brand = await currentBrand();
    if (!(await aiGateOpen(req, res, brand))) return res;
    const market = marketOf(brand);
    const b = req.body ?? {};
    const role = typeof b.role === 'string' ? b.role.trim() : '';
    const jdText = typeof b.jdText === 'string' ? b.jdText.trim().slice(0, 8000) : '';
    const persona = (typeof b.personaId === 'string' && findPersona(b.personaId)) || DEFAULT_PERSONA;
    let type = (typeof b.interviewType === 'string' && findType(b.interviewType, market)) || DEFAULT_TYPE;
    // Keep the preview on the format the session will run (GoApply: a general
    // type at its default length runs the AI-interview practice format).
    if (usesCnFormat({ market, typeId: type.id, minutes: type.minutes })) type = findSessionType(CN_AI_INTERVIEW_FORMAT_ID) ?? type;
    const language = normalizeLocale(typeof b.language === 'string' ? b.language : undefined);
    const characteristics = normalizeCharacteristics(undefined, persona.difficulty);

    const result = await interviewPromptService.previewRequirements({
      role,
      personaName: persona.name,
      personaRole: persona.role,
      personaStyle: persona.style,
      personaDifficulty: persona.difficulty,
      archetype: persona.archetype, // keep the preview's question style aligned with the real session
      typeLabel: type.label,
      typeSub: type.sub,
      typeId: type.id,
      language,
      durationMinutes: type.minutes,
      characteristics,
      jdText: jdText || undefined,
      // The account name must never reach the web search (no-PI vendor).
      knownValues: [req.user!.name ?? null],
      requestId: getCurrentRequestId() ?? undefined,
    });

    return res.json({
      requirements: result.requirements,
      webSources: result.webSources,
      sampleQuestions: result.questions.slice(0, 3).map((q) => q.q),
      inferredRole: result.inferredRole || undefined,
      groundedOn: result.groundedOn,
      // Domain-expert lens the session will be designed and graded with
      // (null ⇒ generic). Lets the UI show "Legal expert panel joined".
      domain: result.domain,
    });
  } catch (err) {
    return handleEngineError(res, 'preview', err, { userId: req.user?.id });
  }
});

export default router;
