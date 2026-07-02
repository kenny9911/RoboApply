// lib/mockInterview/personas.ts
//
// Six distinct interviewer personas — picked so a user can roleplay against
// the full archetype range they'll meet on the loop. Each carries:
//   • An archetype tag ("The Skeptical VP")
//   • A difficulty (easy/medium/hard) — drives the probe / heat in ai.ts
//   • A one-line style summary (used on persona cards + live banner)
//   • A signature gradient (orb tint)
//   • A signature opener line + probe line that ai.ts pulls from when the
//     active interviewer is this persona

import type { Difficulty } from './types';

export type PersonaId = 'maya' | 'voss' | 'kai' | 'priya' | 'rex' | 'june';

export interface Persona {
  id: PersonaId;
  name: string;
  archetype: string;
  difficulty: Difficulty;
  /** One sentence shown on the picker + live banner. */
  style: string;
  /** Two-stop gradient (orb tint). */
  gradient: { from: string; to: string };
  /** A persona-tinted opener. */
  opener: string;
  /** A persona-tinted probe used when the candidate's answer is thin. */
  probe: string;
  /** Acknowledgement before the next question. */
  ack: string;
}

export const PERSONAS: Persona[] = [
  {
    id: 'maya',
    name: 'Maya',
    archetype: 'The Warm Recruiter',
    difficulty: 'easy',
    style: 'Friendly and curious. Will give you space to land your answer.',
    gradient: { from: '#c6ff3a', to: '#a7f3d0' },
    opener:
      "Hey, so excited to meet you! I'm Maya — I'll keep this easy. Just talk to me like we're getting coffee.",
    probe: "Love it — can you walk me through one specific moment?",
    ack: "Okay, that's a great one. Let's keep going.",
  },
  {
    id: 'voss',
    name: 'Dr. Voss',
    archetype: 'The Skeptical VP',
    difficulty: 'hard',
    style: "Doesn't believe you yet. Bring numbers, bring evidence, bring receipts.",
    gradient: { from: '#ff7ad9', to: '#b691ff' },
    opener:
      "Dr. Voss. I've read your resume. I have follow-ups. Don't tell me the version you've rehearsed — tell me what actually happened.",
    probe: "I'm not hearing the receipts yet. What metric moved, by how much, over how long?",
    ack: "Noted. Next.",
  },
  {
    id: 'kai',
    name: 'Kai',
    archetype: 'The Whiteboard Veteran',
    difficulty: 'hard',
    style: 'Just wants to see you reason through a hard problem in real time.',
    gradient: { from: '#67e8f9', to: '#8b5cf6' },
    opener:
      "Kai. Think out loud — I care about how you reason more than what you remember. Whenever you're ready.",
    probe: "Pause — walk me through your thinking, not your conclusion.",
    ack: "Right. Try this one.",
  },
  {
    id: 'priya',
    name: 'Priya',
    archetype: 'The Behavioral Probe',
    difficulty: 'medium',
    style: 'Will probe every claim until you bleed real numbers and real people.',
    gradient: { from: '#b691ff', to: '#67e8f9' },
    opener:
      "I'm Priya. I'll ask 'tell me about a time' a lot. Pick real stories with real people in them — I'll know if it's generic.",
    probe: "Who pushed back, what did they say, and what did you do in the next 24 hours?",
    ack: "Okay, I have a feel for it. Moving on.",
  },
  {
    id: 'rex',
    name: 'Rex',
    archetype: 'The Curveball',
    difficulty: 'medium',
    style: 'Asks the question you did not prepare for. Plays with your assumptions.',
    gradient: { from: '#f97316', to: '#ec4899' },
    opener:
      "Rex. I'm going to ask things you didn't prep for. That's the point — I want the first version of your brain, not the practiced one.",
    probe: "Forget your script. What do you actually think?",
    ack: "Interesting answer. Try this.",
  },
  {
    id: 'june',
    name: 'June',
    archetype: 'The Founder',
    difficulty: 'medium',
    style: 'Cares about ownership, urgency, and obsession. Speed of thought matters.',
    gradient: { from: '#c6ff3a', to: '#06b6d4' },
    opener:
      "June. I run this place. I have ten minutes. Tell me the things that would make me bet on you — fast.",
    probe: "What did YOU own? Not the team — you.",
    ack: "Okay. Next.",
  },
];

export function personaById(id: string | undefined | null): Persona {
  return PERSONAS.find((p) => p.id === id) ?? PERSONAS[1];
}
