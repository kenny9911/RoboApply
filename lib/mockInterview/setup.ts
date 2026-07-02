// lib/mockInterview/setup.ts
//
// One-stop helpers that bind the Setup page's three picks (track + persona
// + format) into a session-ready MockInterview. We deliberately go through
// the existing AI fixture path so a setup session lands at the existing
// `/mock-interview/[id]` route without a backend change.

import { FIXTURE_MOCKS } from './fixtures';
import { mockStore } from './store';
import { personaById, type PersonaId } from './personas';
import { formatById, type FormatId } from './formats';
import { ALL_TRACKS, type Track } from './tracks';
import type { MockInterview, MockQuestion } from './types';

export interface SetupSelection {
  trackId: string;
  personaId: PersonaId;
  formatId: FormatId;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

const FORMAT_GRADIENT: Record<FormatId, { from: string; to: string }> = {
  behavioral:   { from: '#c6ff3a', to: '#b691ff' },
  technical:    { from: '#67e8f9', to: '#8b5cf6' },
  system_design:{ from: '#b691ff', to: '#67e8f9' },
  case:         { from: '#f97316', to: '#ec4899' },
  culture:      { from: '#c6ff3a', to: '#06b6d4' },
  final_round:  { from: '#ff7ad9', to: '#b691ff' },
};

const BEHAVIORAL_QS: MockQuestion[] = [
  { id: 'q1', kind: 'behavioral', prompt: 'Walk me through your highest-stakes project end to end.' },
  { id: 'q2', kind: 'behavioral', prompt: 'Tell me about a time you disagreed with your manager. How did it land?' },
  { id: 'q3', kind: 'behavioral', prompt: 'Pick a decision you reversed. What did you learn?' },
  { id: 'q4', kind: 'behavioral', prompt: 'Tell me about feedback you got that genuinely changed how you work.' },
  { id: 'q5', kind: 'behavioral', prompt: 'When did you say no to scope under pressure?' },
  { id: 'q6', kind: 'behavioral', prompt: 'Tell me about the proudest thing you have NOT shipped yet.' },
];

const TECHNICAL_QS: MockQuestion[] = [
  { id: 'q1', kind: 'technical', prompt: 'Pick the hardest technical decision you made this year. Walk me through it.' },
  { id: 'q2', kind: 'technical', prompt: 'A core system you own is 10x slower than yesterday. Triage live.' },
  { id: 'q3', kind: 'technical', prompt: 'Pick your favorite trade-off in the stack you use most. Defend it.' },
  { id: 'q4', kind: 'technical', prompt: 'Walk me through how you debug a flaky, occasional, production-only bug.' },
  { id: 'q5', kind: 'technical', prompt: 'Pick a piece of infrastructure you would rebuild from scratch. Why?' },
  { id: 'q6', kind: 'technical', prompt: 'Tell me about a security mistake you almost shipped — or did.' },
];

const SYSTEM_DESIGN_QS: MockQuestion[] = [
  { id: 'q1', kind: 'system_design', prompt: 'Design a real-time collaborative editor for 100k concurrent users.' },
  { id: 'q2', kind: 'system_design', prompt: 'Design a job queue that survives a 10x burst without losing work.' },
  { id: 'q3', kind: 'system_design', prompt: 'Design a feature-flag service with global low-latency reads.' },
  { id: 'q4', kind: 'system_design', prompt: 'Design a notification system across email, push, in-app, and SMS.' },
  { id: 'q5', kind: 'system_design', prompt: 'Design a search system over 100M docs with sub-200ms p99.' },
  { id: 'q6', kind: 'system_design', prompt: 'Design rate-limiting that handles bursty users and stays fair.' },
];

const CASE_QS: MockQuestion[] = [
  { id: 'q1', kind: 'case', prompt: 'Our key metric dropped 12% week-over-week. You have one hour — go.' },
  { id: 'q2', kind: 'case', prompt: 'Pick a product you love. Tell me what you would kill first and why.' },
  { id: 'q3', kind: 'case', prompt: 'Design a 30-day experiment to lift activation 20%.' },
  { id: 'q4', kind: 'case', prompt: 'A competitor just shipped your roadmap. What is your response by Friday?' },
  { id: 'q5', kind: 'case', prompt: 'Your CAC just doubled. Walk me through your triage.' },
  { id: 'q6', kind: 'case', prompt: 'You have 2 engineers and 6 weeks. What ships?' },
];

const CULTURE_QS: MockQuestion[] = [
  { id: 'q1', kind: 'behavioral', prompt: 'What is the thing you obsess over that nobody asked you to obsess over?' },
  { id: 'q2', kind: 'behavioral', prompt: 'Tell me about a teammate who made you better. What did they do?' },
  { id: 'q3', kind: 'behavioral', prompt: 'When have you done something that was clearly outside your job?' },
  { id: 'q4', kind: 'behavioral', prompt: 'What is the kind of company that gets the best version of you?' },
  { id: 'q5', kind: 'behavioral', prompt: 'Pick a recent failure. Tell me what it taught you about yourself.' },
  { id: 'q6', kind: 'behavioral', prompt: 'Why this team, why now? Specific.' },
];

const FINAL_ROUND_QS: MockQuestion[] = [
  { id: 'q1', kind: 'behavioral', prompt: 'Tell me about the moment you most felt you levelled up.' },
  { id: 'q2', kind: 'technical', prompt: 'Pick the deepest technical thing you understand. Explain it like I am sharp but new.' },
  { id: 'q3', kind: 'system_design', prompt: 'Sketch the system you would design for our product on day 1.' },
  { id: 'q4', kind: 'case', prompt: 'Our north star is flat for two quarters. First-month plan.' },
  { id: 'q5', kind: 'behavioral', prompt: 'Tell me about a decision you fought to reverse. How did it land?' },
  { id: 'q6', kind: 'behavioral', prompt: 'Why us — and what would have to be true 18 months in?' },
];

const QUESTIONS_BY_FORMAT: Record<FormatId, MockQuestion[]> = {
  behavioral: BEHAVIORAL_QS,
  technical: TECHNICAL_QS,
  system_design: SYSTEM_DESIGN_QS,
  case: CASE_QS,
  culture: CULTURE_QS,
  final_round: FINAL_ROUND_QS,
};

/** Materialise a one-off MockInterview for the selected setup and persist
 *  it as a custom mock so the existing /mock-interview/[id] route can load
 *  it without a backend change. */
export function buildSetupMock(
  selection: SetupSelection,
): MockInterview & { persona: PersonaId; format: FormatId; trackId: string } {
  const track: Track =
    ALL_TRACKS.find((t) => t.id === selection.trackId) ?? ALL_TRACKS[0];
  const persona = personaById(selection.personaId);
  const format = formatById(selection.formatId);

  const baseQs = QUESTIONS_BY_FORMAT[format.id];
  // Re-id each question so we don't collide with an existing mock's question
  // ids that may live in localStorage already.
  const questions = baseQs.map((q, i) => ({ ...q, id: `${newId('q')}_${i}` }));

  const id = newId('mk_setup');
  const m: MockInterview & { persona: PersonaId; format: FormatId; trackId: string } = {
    id,
    title: `${track.title} · ${format.title}`,
    description: `${persona.name} — ${persona.archetype}. ${persona.style}`,
    category: 'other',
    duration: 15,
    difficulty: persona.difficulty,
    gradient: FORMAT_GRADIENT[format.id],
    skills: [track.title, format.title],
    questions,
    isCustom: true,
    customSource: { kind: 'topic', label: `${track.title} · ${persona.name}` },
    createdAt: new Date().toISOString(),
    persona: persona.id,
    format: format.id,
    trackId: track.id,
  };

  mockStore.saveCustomMock(m);
  // Persist the selection alongside so the live page can read the persona.
  try {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        `roboapply:mock-interview:setup:${id}`,
        JSON.stringify({ persona: persona.id, format: format.id, trackId: track.id }),
      );
    }
  } catch {
    /* best-effort */
  }
  return m;
}

export function readSetupForMock(mockId: string): { persona: PersonaId; format: FormatId; trackId: string } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`roboapply:mock-interview:setup:${mockId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Latest 3 finished reports — surfaced as "Recent sessions" on Setup. */
export function listRecentSessions(): {
  reportId: string;
  mockId: string;
  mockTitle: string;
  score: number;
  createdAt: string;
}[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem('roboapply:mock-interview:v1');
    if (!raw) return [];
    const parsed = JSON.parse(raw) as {
      reports?: Record<
        string,
        { id: string; mockId: string; mockTitle: string; score: number; createdAt: string }
      >;
    };
    const reports = Object.values(parsed.reports ?? {});
    reports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return reports.slice(0, 3).map((r) => ({
      reportId: r.id,
      mockId: r.mockId,
      mockTitle: r.mockTitle,
      score: r.score,
      createdAt: r.createdAt,
    }));
  } catch {
    return [];
  }
}

/** Score delta vs the previous session for the same mock — used on Results. */
export function deltaFor(mockId: string, currentReportId: string): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem('roboapply:mock-interview:v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      reports?: Record<string, { id: string; mockId: string; score: number; createdAt: string }>;
    };
    const reports = Object.values(parsed.reports ?? {});
    const sorted = reports
      .filter((r) => r.mockId === mockId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const idx = sorted.findIndex((r) => r.id === currentReportId);
    if (idx <= 0) return null;
    return sorted[idx].score - sorted[idx - 1].score;
  } catch {
    return null;
  }
}
