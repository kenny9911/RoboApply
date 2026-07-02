// lib/mockInterview/types.ts
//
// Type surface for the Mock Interview feature. Lives outside the API surface
// because the V2 backend doesn't have these endpoints yet — we serve from
// fixtures (system-built mocks) + localStorage (user custom mocks + session
// transcripts + reports). When the backend lands, the only thing that has to
// change is the `useMockInterview*` hook implementations.

export type MockCategory =
  | 'all'
  | 'it'
  | 'data'
  | 'ai'
  | 'product'
  | 'business'
  | 'project'
  | 'media'
  | 'design'
  | 'marketing'
  | 'finance'
  | 'other';

export type Difficulty = 'easy' | 'medium' | 'hard';

export type InterviewerStyle = 'friendly' | 'curious' | 'tough';

export type QuestionKind = 'behavioral' | 'technical' | 'system_design' | 'case' | 'roleplay';

export interface MockQuestion {
  id: string;
  prompt: string;
  kind: QuestionKind;
  /** Optional probe template — "Can you give a specific example?" — picked at
   *  runtime when the heuristic decides the answer was thin. */
  followUp?: string;
  /** One-sentence reference answer used in the report. */
  sampleAnswer?: string;
  /** Keywords we hope to see in a strong answer. Used by the scorer. */
  expectedKeywords?: string[];
}

export interface MockInterview {
  id: string;
  title: string;
  description: string;
  category: Exclude<MockCategory, 'all'>;
  /** Duration in minutes. */
  duration: number;
  difficulty: Difficulty;
  /** Two-stop gradient (top-left → bottom-right). */
  gradient: { from: string; to: string };
  skills: string[];
  questions: MockQuestion[];
  /** A custom mock the user authored — flag drives the Custom-tab list. */
  isCustom?: boolean;
  /** Optional source (only for custom): jd, resume, topic. */
  customSource?: { kind: 'jd' | 'resume' | 'topic'; label: string };
  createdAt?: string;
}

export interface MockTurn {
  id: string;
  /** Whose turn — interviewer or you. */
  role: 'interviewer' | 'candidate';
  /** Plain-text content. Markdown is fine — we render through InlineMd. */
  text: string;
  /** Wall-clock ISO. */
  at: string;
  /** When role === 'interviewer', which question this turn relates to. Null
   *  for greeting / closing turns. */
  questionId: string | null;
  /** When role === 'interviewer', flags this as a follow-up rather than a
   *  primary question. */
  followUp?: boolean;
}

export interface MockSession {
  id: string;
  mockId: string;
  startedAt: string;
  endedAt: string | null;
  style: InterviewerStyle;
  turns: MockTurn[];
  /** Set when the user has finished — drives the report page. */
  reportId: string | null;
}

export interface QuestionScore {
  questionId: string;
  prompt: string;
  /** 0..100. */
  score: number;
  strengths: string[];
  improvements: string[];
  /** The answer the user gave (concatenated if multi-turn). */
  answer: string;
  sampleAnswer: string | null;
  /** Whether the answer had Situation / Task / Action / Result chunks. */
  starStructure: { situation: boolean; task: boolean; action: boolean; result: boolean };
}

export interface MockReport {
  id: string;
  sessionId: string;
  mockId: string;
  mockTitle: string;
  createdAt: string;
  /** Overall 0..100. */
  score: number;
  /** Sub-dimensions, each 0..100. */
  dimensions: {
    communication: number;
    technical: number;
    structure: number;
    confidence: number;
  };
  /** Count of filler words detected across the whole session. */
  fillerCount: number;
  /** Highlight cards. */
  topStrengths: string[];
  topImprovements: string[];
  perQuestion: QuestionScore[];
  /** Average words per minute across the session (heuristic). */
  wpm: number;
  /** Total words the candidate spoke. */
  candidateWords: number;
}
