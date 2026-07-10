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

import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getCurrentRequestId } from '../../lib/requestContext.js';
import { findPersona, findType, DEFAULT_PERSONA, DEFAULT_TYPE } from '../catalog/interviewCatalog.js';
import { normalizeCharacteristics } from '../prompt/characteristics.js';
import { normalizeLocale } from '../voice/voiceCatalog.js';
import { interviewPromptService } from '../prompt/interviewPromptService.js';
import { handleEngineError } from './errors.js';

const router = Router();

router.post('/requirements/preview', requireAuth, async (req: Request, res: Response) => {
  try {
    const b = req.body ?? {};
    const role = typeof b.role === 'string' ? b.role.trim() : '';
    const jdText = typeof b.jdText === 'string' ? b.jdText.trim().slice(0, 8000) : '';
    const persona = (typeof b.personaId === 'string' && findPersona(b.personaId)) || DEFAULT_PERSONA;
    const type = (typeof b.interviewType === 'string' && findType(b.interviewType)) || DEFAULT_TYPE;
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
