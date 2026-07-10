// backend/src/interview-engine/coaching/interviewCoachService.ts
//
// Orchestrates the live interview COACH: resolves the owned session, derives the
// persona's ARCHETYPE coaching focus, and asks InterviewCoachAgent for a one-line
// hint or nudge. NEVER throws — any failure returns null so the live room degrades
// silently (the coach is an aid, never a blocker).

import { interviewSessionService } from '../sessions/InterviewSessionService.js';
import { findPersona } from '../catalog/interviewCatalog.js';
import type { InterviewArchetype } from '../catalog/interviewArchetypes.js';
import { getDomainExpert } from '../catalog/domainExperts.js';
import { interviewCoachAgent, type CoachMode, type CoachTip } from './InterviewCoachAgent.js';

/** What the coach should push the candidate toward, per archetype. One line each;
 *  ID-aligned with interviewArchetypes.ts. */
const COACH_DIRECTIVES: Record<InterviewArchetype, string> = {
  warmup:
    'Help them relax and be authentic: a clear, warm, well-told story about their motivation and fit — no need to stress-prove depth.',
  behavioral:
    'Push for one specific STAR story: a real situation, what THEY personally did (not "we"), and a concrete result. Separate their action from the team.',
  breadth:
    'Push for range: name alternatives and trade-offs, reference the wider landscape, and connect ideas across areas — do not tunnel on a single point.',
  potential:
    'Push them to think out loud: clarify the problem, state assumptions, structure it into parts, and reason step by step — the process matters more than the final answer.',
  depth:
    'Push for first-hand specifics: the exact decision, the real numbers, what actually broke — replace any buzzword or summary with a concrete instance.',
  communication:
    'Push for clarity: lead with the headline, use plain language, give one concrete example, and cut the rambling and jargon. Make the point land.',
  pressure:
    'Help them stay composed: take a beat, hold their position with reasons, concede gracefully only when truly wrong — do not fold or ramble under the pushback.',
};

export interface CoachRequest {
  userId: string;
  sessionId: string;
  mode: CoachMode;
  question: string;
  answer?: string;
  requestId?: string;
  signal?: AbortSignal;
}

export const interviewCoachService = {
  /** Returns a coach tip, or null on any failure / missing inputs. Never throws. */
  async coach(req: CoachRequest): Promise<CoachTip | null> {
    try {
      const question = (req.question || '').trim();
      const answer = (req.answer || '').trim();
      // A nudge needs something to react to; a hint needs a question.
      if (req.mode === 'nudge' && answer.length < 8) return null;
      if (req.mode === 'hint' && !question) return null;

      // Ownership check (throws if not owned / not found) — same gate as detail.
      const session = await interviewSessionService.getOwned(req.userId, req.sessionId);

      const persona = session.personaId ? findPersona(session.personaId) : undefined;
      const archetype = (persona?.archetype ?? 'behavioral') as InterviewArchetype;
      const archetypeFocus = COACH_DIRECTIVES[archetype] ?? COACH_DIRECTIVES.behavioral;

      // Domain lens: the blueprint JSON carries the domain resolved at create
      // time (see interviewPromptService) — the coach's field context uses the
      // expert's summary so nudges speak the candidate's professional language.
      const bp = (session.blueprint ?? {}) as { domain?: { key?: unknown } };
      const domainExpert = getDomainExpert(typeof bp.domain?.key === 'string' ? bp.domain.key : null);

      const tip = await interviewCoachAgent.run(
        {
          mode: req.mode,
          question,
          answerSoFar: answer,
          role: session.role || '',
          personaName: persona?.name ?? 'the interviewer',
          personaRole: persona?.role ?? '',
          archetypeFocus,
          domainFocus: domainExpert ? `${domainExpert.labelEn}: ${domainExpert.summary}` : undefined,
          language: session.language || 'en',
        },
        { requestId: req.requestId, signal: req.signal },
      );
      return tip;
    } catch {
      return null;
    }
  },
};
