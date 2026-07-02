// lib/mockInterview/formats.ts
//
// The 6 interview formats users can pick from at setup. Each format has a
// pitch + an emoji icon + a difficulty hint, and tells ai.ts which question
// kinds to lean into when generating the live session.

import type { QuestionKind } from './types';

export type FormatId =
  | 'behavioral'
  | 'technical'
  | 'system_design'
  | 'case'
  | 'culture'
  | 'final_round';

export interface Format {
  id: FormatId;
  title: string;
  emoji: string;
  pitch: string;
  /** What the AI leans on for question generation. */
  questionKinds: QuestionKind[];
  /** Heat — drives probe frequency. */
  heat: 'low' | 'medium' | 'high';
}

export const FORMATS: Format[] = [
  {
    id: 'behavioral',
    title: 'Behavioral',
    emoji: '🗣',
    pitch: 'Tell-me-about-a-time. STAR-graded.',
    questionKinds: ['behavioral'],
    heat: 'medium',
  },
  {
    id: 'technical',
    title: 'Technical',
    emoji: '⚙️',
    pitch: 'Core concepts and real-world systems.',
    questionKinds: ['technical'],
    heat: 'high',
  },
  {
    id: 'system_design',
    title: 'System Design',
    emoji: '🧱',
    pitch: 'Whiteboard-style architecture, out loud.',
    questionKinds: ['system_design'],
    heat: 'high',
  },
  {
    id: 'case',
    title: 'Case Study',
    emoji: '📈',
    pitch: 'Walk-through with framework + numbers.',
    questionKinds: ['case'],
    heat: 'medium',
  },
  {
    id: 'culture',
    title: 'Culture & Values',
    emoji: '🌱',
    pitch: 'Ownership, urgency, the why behind the work.',
    questionKinds: ['behavioral'],
    heat: 'low',
  },
  {
    id: 'final_round',
    title: 'Final Round Panel',
    emoji: '🎯',
    pitch: 'A spicy mix from every category.',
    questionKinds: ['behavioral', 'technical', 'case', 'system_design'],
    heat: 'high',
  },
];

export function formatById(id: string | undefined | null): Format {
  return FORMATS.find((f) => f.id === id) ?? FORMATS[0];
}
