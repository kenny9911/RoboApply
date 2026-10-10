// roboapply/lib/api/interviewEngine.ts
//
// Typed client for the Interview Engine — the real-time AI voice
// interview backend (backend/src/interview-engine/*), mounted at
// /api/v1/interview-engine. Uses the shared `roboApi` wrapper so it inherits
// cookie + Bearer auth and the X-Robo-Locale header.

import { roboApi, RoboApiError } from './client';
import { API_BASE } from '../config';

const BASE = '/api/v1/interview-engine';

export type InterviewMode = 'voice' | 'video';
/** 'preparing' — the session row exists but the interview plan (blueprint +
 *  interviewer prompt + voice) is still being written by POST /prepare. Treat
 *  it like 'created' anywhere a list or summary is shown. */
export type InterviewStatus =
  | 'preparing' | 'created' | 'live' | 'finalizing' | 'completed' | 'failed' | 'expired';

/** Machine codes the interview-engine endpoints put in `{error}` (contract C5). */
export type IEErrorCode =
  | 'insufficient_credits'
  | 'llm_unavailable'
  | 'prepare_failed'
  | 'not_ready'
  | 'session_failed'
  | 'session_ended'
  | 'worker_unavailable'
  | 'no_answer';

const IE_ERROR_CODES: ReadonlySet<string> = new Set<IEErrorCode>([
  'insufficient_credits',
  'llm_unavailable',
  'prepare_failed',
  'not_ready',
  'session_failed',
  'session_ended',
  'worker_unavailable',
  'no_answer',
]);

/** What a failed interview-engine call means to the UI. `code` is the
 *  contract code when the server sent one; `network` is true when the request
 *  never got an answer (offline, proxy reset, timeout). */
export interface IEErrorInfo {
  code: IEErrorCode | null;
  status: number | null;
  network: boolean;
  /** session.error for a 409 session_failed. */
  reason: string | null;
  /** The session snapshot some error bodies carry (503/500 from /prepare). */
  session: IESessionDetail | null;
}

/** Normalize any thrown value from `interviewEngineApi` into IEErrorInfo. */
export function ieErrorInfo(err: unknown): IEErrorInfo {
  if (err instanceof RoboApiError) {
    const payload = (err.payload ?? {}) as Record<string, unknown>;
    const raw = typeof payload.error === 'string' ? payload.error : null;
    const code = raw && IE_ERROR_CODES.has(raw) ? (raw as IEErrorCode) : null;
    const session =
      payload.session && typeof payload.session === 'object'
        ? (payload.session as IESessionDetail)
        : null;
    return {
      code,
      status: err.status ?? null,
      network: err.code === 'network_error',
      reason: typeof payload.reason === 'string' ? payload.reason : null,
      session,
    };
  }
  return { code: null, status: null, network: true, reason: null, session: null };
}

/** session.error values written by /prepare that a Retry can recover from. */
export const RETRYABLE_PREPARE_ERRORS: ReadonlySet<string> = new Set(['llm_unavailable', 'prepare_failed']);

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
  /** Why the interviewer asked this — the signal they were probing for. May be
   *  '' on legacy reports generated before this field existed. */
  intent?: string;
  answerSummary: string;
  keyQuote?: string;
  analysis: string;
  correction: string;
  suggestion: string;
  modelAnswer: string;
  /** Sharp, tactical professional/technical pointers. May be absent/[] on
   *  legacy reports or a flawless answer. */
  tips?: string[];
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
  /** Machine reason for a 'failed' session (llm_unavailable · prepare_failed ·
   *  no_answer · worker codes). Absent on older APIs. */
  error?: string | null;
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
  /** 'parley' = the Parley pilot transport: `url`/`token` are empty and the
   *  page joins Parley with `parley` instead of a LiveKit room. */
  transport?: 'parley';
  parley?: IEParleyJoin;
  /** False when the server's join token cannot publish a camera (GoApply: local
   *  preview only; WP-63a). Absent = legacy server, treat as allowed. */
  cameraPublish?: boolean;
}

/** What the browser needs to join a Parley session (WebRTC straight to the node). */
export interface IEParleyJoin {
  baseUrl: string;
  sessionId: string;
  clientToken: string;
  expiresAt: string;
  iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
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

/** The fields a session is created from. Sessions are created through
 *  `practiceApi.create` (PracticeCreateBody), the one first-party create route. */
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

// ─── Practice from a job (WP-43) ───────────────────────────────────────────
//
// First-party practice routes on the engine router (cookie only):
//   GET  /api/v1/interview-engine/v1/practice/setup?job=&resume=
//   POST /api/v1/interview-engine/v1/practice/sessions
//   GET  /api/v1/interview-engine/v1/practice/sessions/:id
//   GET  /api/v1/interview-engine/v1/practice/jobs?ids=
// Written practice (GoApply without voice) — first-party wrappers over the
// text interview that check the brand gate (phone, AI consent), load the job
// server-side, meter credits and tick the checklist when scored:
//   POST /api/v1/interview-engine/v1/practice/text/start | /next-turn | /:id/score

/** What the user asked to record for one session; the server honours it only with consent. */
export interface PracticeRecordingRequest {
  audio: boolean;
  video: boolean;
}

/** POST /practice/sessions body: the engine create body plus the job, resume and recording choice. */
export interface PracticeCreateBody extends Omit<IECreateBody, 'resumeContext'> {
  jobId?: string | null;
  /** Resume (variant) to practise with; omitted → the job's tailored one, else the primary. */
  resumeId?: string | null;
  recording?: PracticeRecordingRequest;
}

export interface PracticeCreateResponse {
  session: IESessionDetail;
  practice: { jobId: string | null; resumeId: string | null; recording: PracticeRecordingRequest };
}

export type PracticeGateReason = 'phone_binding_required' | 'ai_consent_required' | 'voice_unavailable';
export type FirstPracticeGrant = 'granted' | 'already_granted' | 'in_progress' | 'no_profile' | 'failed';

export interface PracticeFirstState {
  /** Email verification (RoboApply) or a verified phone (GoApply) unlocks the free first practice. */
  method: 'email' | 'phone';
  verified: boolean;
  grant: FirstPracticeGrant | null;
}

export interface PracticeSetupJob {
  id: string;
  title: string;
  companyName: string;
  location: string | null;
  jdText: string;
  closed: boolean;
}

export interface PracticeSetup {
  market: 'intl' | 'cn';
  job: PracticeSetupJob | null;
  resume: { id: string; name: string; kind: 'chosen' | 'tailored' | 'primary' | 'latest' } | null;
  firstPractice: PracticeFirstState;
  voice: { available: boolean; reason: PracticeGateReason | null };
  ai: { allowed: boolean; reason: PracticeGateReason | null };
  /** `available` = recording can happen at all here; `consent` = the user's standing grants. */
  recording: { available: boolean; consent: PracticeRecordingRequest };
}

export interface PracticeSessionInfo {
  sessionId: string;
  status: InterviewStatus;
  job: { id: string; title: string | null; companyName: string | null } | null;
  recording: { consented: boolean; video: boolean; available: boolean };
  completedAt: string | null;
}

const PRACTICE = `${BASE}/v1/practice`;

export const practiceApi = {
  setup: (query: { job?: string | null; resume?: string | null } = {}) => {
    const params = new URLSearchParams();
    if (query.job) params.set('job', query.job);
    if (query.resume) params.set('resume', query.resume);
    const qs = params.toString();
    return roboApi.get<PracticeSetup>(`${PRACTICE}/setup${qs ? `?${qs}` : ''}`);
  },
  create: (body: PracticeCreateBody) => roboApi.post<PracticeCreateResponse>(`${PRACTICE}/sessions`, body),
  info: (sessionId: string) =>
    roboApi.get<{ practice: PracticeSessionInfo }>(`${PRACTICE}/sessions/${encodeURIComponent(sessionId)}`),
  /** The job checklist's "Practiced" step: jobId → ISO time of the latest completed practice. */
  practicedJobs: (jobIds: string[]) =>
    roboApi.get<{ practiced: Record<string, string> }>(
      `${PRACTICE}/jobs?ids=${jobIds.map(encodeURIComponent).join(',')}`,
    ),
};

// Written practice (no voice).
const TEXT = `${PRACTICE}/text`;

export interface TextPracticeStartBody {
  /** Used when there is no job; with a job the server uses the job's title. */
  role: string;
  interviewerId: string;
  typeId: string;
  language?: string;
  durationMinutes?: number;
  /** Loaded and market-checked on the server (404 job_not_found). */
  jobId?: string | null;
}

export interface TextPracticeQuestion {
  q: string;
  hint: string;
  coachTip: { kind: 'good' | 'careful'; text: string } | null;
}

export interface TextPracticeTurn {
  who: 'them' | 'you';
  text: string;
}

export interface TextPracticeScore {
  overall: number;
  delta: number | null;
  breakdown: Array<{ key: string; value: number; note: string }>;
  strengths: string[];
  gaps: string[];
  durationMinutes: number;
  /**
   * GoApply only: the practice report block (communication / logic / story
   * answers, STAR, filler words). Read it with `asCnPracticeReport`
   * (components/features/practice-cn) and render `<CnReportView>`.
   */
  cn?: unknown;
}

/** GoApply AI-interview format: thinking and answer time per question, in question order. */
export interface TextPracticeCnFormat {
  formatId: string;
  minutes: number;
  questions: Array<{ prepSeconds: number; answerSeconds: number; story: boolean }>;
}

export interface TextPracticeStartResult {
  sessionId: string;
  questions: TextPracticeQuestion[];
  jobId: string | null;
  /** Present only when the practice runs the GoApply AI-interview format. */
  cnFormat?: TextPracticeCnFormat | null;
}

export interface TextPracticeScoreResult extends TextPracticeScore {
  /** The practice was answered: it counted for the checklist and the job's "Practiced" step. */
  practiceCounted: boolean;
  jobId: string | null;
}

export const textPracticeApi = {
  start: (body: TextPracticeStartBody) =>
    roboApi.post<TextPracticeStartResult>(`${TEXT}/start`, body),
  nextTurn: (body: { sessionId: string; answer: string; questionIndex: number }) =>
    roboApi.post<{ nextIndex: number | null; turns: TextPracticeTurn[]; coachTip: TextPracticeQuestion['coachTip'] }>(
      `${TEXT}/next-turn`,
      body,
    ),
  score: (sessionId: string) =>
    roboApi.post<TextPracticeScoreResult>(`${TEXT}/${encodeURIComponent(sessionId)}/score`, {}),
};

/** Machine fields of a practice create/setup error (beyond IEErrorInfo). */
export interface PracticeErrorInfo {
  code: 'job_not_found' | 'phone_binding_required' | 'ai_unavailable' | 'insufficient_credits' | null;
  reason: string | null;
  firstPractice: PracticeFirstState | null;
}

export function practiceErrorInfo(err: unknown): PracticeErrorInfo {
  if (!(err instanceof RoboApiError)) return { code: null, reason: null, firstPractice: null };
  const p = (err.payload ?? {}) as Record<string, unknown>;
  const raw = typeof p.error === 'string' ? p.error : null;
  const code =
    raw === 'job_not_found' || raw === 'phone_binding_required' || raw === 'ai_unavailable' || raw === 'insufficient_credits'
      ? raw
      : null;
  const fp = p.firstPractice && typeof p.firstPractice === 'object' ? (p.firstPractice as PracticeFirstState) : null;
  return { code, reason: typeof p.reason === 'string' ? p.reason : null, firstPractice: fp };
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
  const headers = keepaliveHeaders();
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

/** Shared auth headers for the raw keepalive fetches below (mirrors roboApi:
 *  cookie + localStorage Bearer fallback). */
function keepaliveHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = window.localStorage.getItem('auth_token');
    if (token) headers['Authorization'] = `Bearer ${token}`;
  } catch {
    // localStorage blocked — the session cookie still authenticates.
  }
  return headers;
}

/**
 * End a live session without waiting for it (contract C8). The server marks
 * the session 'finalizing', tells the interviewer to stop, and finalizes in
 * the background — which can take several seconds. The browser must not sit
 * on "Ending…" for that: the report page polls. `keepalive` lets the request
 * outlive the navigation that follows immediately.
 */
export function endSessionKeepalive(sessionId: string): void {
  if (typeof window === 'undefined') return;
  try {
    void fetch(`${API_BASE}${BASE}/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: 'POST',
      headers: keepaliveHeaders(),
      credentials: 'include',
      body: '{}',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // fetch unavailable — finalize also runs on the server's abandon timer.
  }
}

export const interviewEngineApi = {
  catalog: () => roboApi.get<IECatalog>(`${BASE}/catalog`),
  preview: (body: IEPreviewBody) => roboApi.post<IEPreviewResponse>(`${BASE}/requirements/preview`, body),
  recent: () => roboApi.get<{ sessions: IESessionSummary[] }>(`${BASE}/sessions/recent`),
  // Sessions are created through `practiceApi.create` only: the server loads
  // the job, picks and redacts the resume and checks the recording consent.
  // The old browser `POST /sessions` could do none of that and was removed.
  get: (id: string) => roboApi.get<{ session: IESessionDetail }>(`${BASE}/sessions/${encodeURIComponent(id)}`),
  connection: (id: string) =>
    roboApi.post<{ connection: IEConnection }>(`${BASE}/sessions/${encodeURIComponent(id)}/connection`, {}),
  /** Build the interview plan for a 'preparing' session (contract C2). Long
   *  request (LLM). `retry: true` re-runs a session that failed to prepare. */
  prepare: (id: string, opts: { retry?: boolean; signal?: AbortSignal } = {}) =>
    roboApi.post<{ session: IESessionDetail }>(
      `${BASE}/sessions/${encodeURIComponent(id)}/prepare`,
      opts.retry ? { retry: true } : {},
      { signal: opts.signal },
    ),
  end: (id: string) => roboApi.post<{ session: IESessionDetail }>(`${BASE}/sessions/${encodeURIComponent(id)}/end`, {}),
  endKeepalive: endSessionKeepalive,
  coach: (
    id: string,
    body: { mode: IECoachMode; question: string; answer?: string },
    opts: { signal?: AbortSignal } = {},
  ) =>
    roboApi.post<{ coach: IECoachTip | null }>(
      `${BASE}/sessions/${encodeURIComponent(id)}/coach`,
      body,
      { signal: opts.signal },
    ),
  report: (id: string) => roboApi.get<IEReport>(`${BASE}/sessions/${encodeURIComponent(id)}/report`),
  remove: (id: string) => roboApi.delete<{ ok: true }>(`${BASE}/sessions/${encodeURIComponent(id)}`),
  clientEvents: postClientEvents,
};
