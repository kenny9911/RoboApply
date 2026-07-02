// roboapply/lib/api/interviewEngine.ts
//
// Typed client for the RoboHire Interview Engine — the real-time AI voice
// interview backend (backend/src/interview-engine/*), mounted at
// /api/v1/interview-engine. Uses the shared `roboApi` wrapper so it inherits
// cookie + Bearer auth and the X-Robo-Locale header.

import { roboApi } from './client';
import { API_BASE } from '../config';

const BASE = '/api/v1/interview-engine';

export type InterviewMode = 'voice' | 'video';
export type InterviewStatus =
  | 'created' | 'live' | 'finalizing' | 'completed' | 'failed' | 'expired';

export interface IEPersona {
  id: string;
  name: string;
  role: string;
  difficulty: number;
  style: string;
  blurb: string;
  voiceGender?: 'female' | 'male' | 'neutral';
}

export interface IEType {
  id: string;
  label: string;
  sub: string;
  minutes: number;
}

/** The market-grounded role spec the interview screens for. Mirrors the
 *  backend BlueprintRequirements (interviewer playbook stays server-side). */
export interface IERequirements {
  roleSummary: string;
  seniorityBar: string;
  mustHaveSkills: string[];
  coreResponsibilities: string[];
  successSignals: string[];
  domainContext: string;
}

export interface IECatalog {
  personas: IEPersona[];
  types: IEType[];
}

export interface IECharacteristics {
  difficulty: number;
  tone: string;
  pacing: string;
  followUpDepth: number;
  mustCoverTopics: string[];
  focusAreas: string[];
  allowCandidateQuestions: boolean;
}

export interface IESeedQuestion {
  q: string;
  hint: string;
  coachTip: { kind: 'good' | 'careful'; text: string };
}

export type IEDimensionKey = 'structure' | 'specificity' | 'communication' | 'confidence' | 'roleFit';
export type IEQuestionRating = 'strong' | 'adequate' | 'weak' | 'missed';
export type IERecommendationPriority = 'high' | 'medium' | 'low';

export interface IEQuestionAnalysisItem {
  questionIndex: number;
  blueprintIndex: number | null;
  missed: boolean;
  question: string;
  answerSummary: string;
  keyQuote?: string;
  analysis: string;
  correction: string;
  suggestion: string;
  modelAnswer: string;
  rating: IEQuestionRating;
  score: number;
  tags?: string[];
}

export interface IERecommendation {
  title: string;
  priority: IERecommendationPriority;
  detail: string;
  example: string;
  drill?: string;
  linkedDimension?: IEDimensionKey;
}

export interface IESessionSummary {
  id: string;
  status: InterviewStatus;
  source: string;
  role: string;
  interviewType: string;
  personaId: string | null;
  mode: InterviewMode;
  language: string;
  durationMinutes: number;
  overall: number | null;
  externalRef: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface IESessionDetail extends IESessionSummary {
  candidateName: string | null;
  characteristics: IECharacteristics | null;
  voice: { provider: string; model: string; voiceId: string; languageCode: string; label?: string } | null;
  questions: IESeedQuestion[];
  webSources: Array<{ title: string; url: string }>;
  interviewerBrief: string | null;
  requirements: IERequirements | null;
  groundedOn?: 'jd' | 'market' | 'role';
  breakdown: Array<{ key: string; value: number; note: string }> | null;
  strengths: string[];
  gaps: string[];
  summary: string | null;
  // Rich LLM report sections (null until enrichment lands).
  recommendations: IERecommendation[] | null;
  questionAnalysis: IEQuestionAnalysisItem[] | null;
  reportDegraded?: boolean;
  reportPending?: boolean;
  recordingAvailable: boolean;
  transcriptAvailable: boolean;
}

export type IECoachMode = 'hint' | 'nudge';
/** A one-line live-coach whisper: 'good' (lime, on track) or 'careful' (amber, fix). */
export interface IECoachTip {
  kind: 'good' | 'careful';
  text: string;
}

export interface IEConnection {
  sessionId: string;
  url: string;
  token: string;
  roomName: string;
  identity: string;
  mode: InterviewMode;
  language: string;
  voice: { provider: string; model: string; voiceId: string; languageCode: string; label?: string };
  expiresAt: string;
  agentDispatched: boolean;
  recording: boolean;
}

export interface IETranscriptTurn {
  role: 'interviewer' | 'candidate' | 'system';
  text: string;
  ts: number;
  interim?: boolean;
}

export interface IEReport {
  session: IESessionDetail;
  transcript: IETranscriptTurn[];
  recordingUrl: string | null;
  transcriptUrl: string | null;
}

export interface IECreateBody {
  role: string;
  /** Optional pasted job description — rewritten into the interview brief. */
  jdText?: string;
  interviewType?: string;
  personaId?: string;
  mode?: InterviewMode;
  language?: string;
  durationMinutes?: number;
  characteristics?: Partial<IECharacteristics>;
  candidateName?: string;
  resumeContext?: string;
}

/** Pre-launch "Market Job Requirements" preview — no session/room created. */
export interface IEPreviewBody {
  role?: string;
  jdText?: string;
  interviewType?: string;
  personaId?: string;
  language?: string;
}

export interface IEPreviewResponse {
  requirements: IERequirements;
  webSources: Array<{ title: string; url: string }>;
  sampleQuestions: string[];
  inferredRole?: string;
  groundedOn: 'jd' | 'market' | 'role';
}

/** A single client-side telemetry signal from the live interview room. */
export interface IEClientEvent {
  type: string;
  ts: number;
  data?: Record<string, unknown>;
}

/**
 * Fire-and-forget client telemetry for a live session. Deliberately NOT
 * routed through `roboApi`: the final flush has to ride `keepalive: true` so
 * it survives page unload, which the shared wrapper doesn't expose. Mirrors
 * its auth (cookie + localStorage Bearer fallback). Telemetry must never
 * affect the interview, so every failure path is swallowed.
 */
export function postClientEvents(
  sessionId: string,
  events: IEClientEvent[],
  opts: { keepalive?: boolean } = {},
): void {
  if (typeof window === 'undefined' || events.length === 0) return;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = window.localStorage.getItem('auth_token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    // localStorage blocked — the session cookie still authenticates.
  }
  try {
    void fetch(
      `${API_BASE}${BASE}/sessions/${encodeURIComponent(sessionId)}/client-events`,
      {
        method: 'POST',
        headers,
        credentials: 'include',
        // Backend caps at 50 events per call; keepalive bodies are also
        // size-limited (~64KB), so trim rather than fail.
        body: JSON.stringify({ events: events.slice(0, 50) }),
        keepalive: opts.keepalive === true,
      },
    ).catch(() => undefined);
  } catch {
    // e.g. serialization failure — drop the batch.
  }
}

export const interviewEngineApi = {
  catalog: () => roboApi.get<IECatalog>(`${BASE}/catalog`),
  preview: (body: IEPreviewBody) => roboApi.post<IEPreviewResponse>(`${BASE}/requirements/preview`, body),
  recent: () => roboApi.get<{ sessions: IESessionSummary[] }>(`${BASE}/sessions/recent`),
  create: (body: IECreateBody) => roboApi.post<{ session: IESessionDetail }>(`${BASE}/sessions`, body),
  get: (id: string) => roboApi.get<{ session: IESessionDetail }>(`${BASE}/sessions/${encodeURIComponent(id)}`),
  connection: (id: string) =>
    roboApi.post<{ connection: IEConnection }>(`${BASE}/sessions/${encodeURIComponent(id)}/connection`, {}),
  end: (id: string) => roboApi.post<{ session: IESessionDetail }>(`${BASE}/sessions/${encodeURIComponent(id)}/end`, {}),
  coach: (id: string, body: { mode: IECoachMode; question: string; answer?: string }) =>
    roboApi.post<{ coach: IECoachTip | null }>(`${BASE}/sessions/${encodeURIComponent(id)}/coach`, body),
  report: (id: string) => roboApi.get<IEReport>(`${BASE}/sessions/${encodeURIComponent(id)}/report`),
  remove: (id: string) => roboApi.delete<{ ok: true }>(`${BASE}/sessions/${encodeURIComponent(id)}`),
  clientEvents: postClientEvents,
};
