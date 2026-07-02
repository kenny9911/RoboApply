// lib/mockInterview/ai.ts
//
// Heuristic AI used by the Mock Interview surface — same signatures the real
// LLM-backed endpoints will eventually expose. We deliberately do MORE than a
// chatbot loop so the report is useful: every helper returns deterministic
// structured output the UI can render directly.
//
// When the real backend lands: only the bodies change. Tests against this
// file pin behaviour for the heuristic; we'll add LLM-output snapshots in
// V2.1 to keep the two implementations aligned.

import type {
  InterviewerStyle,
  MockInterview,
  MockQuestion,
  MockReport,
  MockSession,
  MockTurn,
  QuestionScore,
} from './types';

// ─────────────────────────────────────────────────────────────────────
// Interviewer-style text
// ─────────────────────────────────────────────────────────────────────

const GREETINGS: Record<InterviewerStyle, string> = {
  friendly:
    "Hey, great to meet you. I'm going to ask you 6 questions over the next ~15 minutes. Take your time, think out loud, and we'll go at your pace. Ready when you are.",
  curious:
    "Welcome. I'm here to learn how you think — not just what you know. I'll ask 6 questions, and I'll dig in when something catches my ear. Whenever you're ready.",
  tough:
    "We have 15 minutes and 6 questions. I'll keep us moving. If your answer is thin, I will probe — that's how I help. Let's start.",
};

const PROBES: Record<InterviewerStyle, string[]> = {
  friendly: [
    "That's a great start — can you give me a specific example?",
    'Walk me through how that played out in practice.',
    "Tell me a bit more about the outcome — what changed?",
  ],
  curious: [
    'Interesting — what made you choose that approach over the alternatives?',
    'Where did that decision land you in the end?',
    'What did you actually measure to know it worked?',
  ],
  tough: [
    'Be specific — what numbers, what time frame, what tradeoffs?',
    "That's the textbook answer. Walk me through what YOU actually did.",
    "I'm not hearing the impact yet — what changed because of you?",
  ],
};

const CLOSINGS: Record<InterviewerStyle, string> = {
  friendly:
    "That's everything from me — really enjoyed this. Open your report whenever you're ready.",
  curious:
    "We're out of time. I'd want to talk to you again. Your report is one tap away.",
  tough:
    "Time's up. The report will tell you the honest version. Go look at it.",
};

const ACKS: Record<InterviewerStyle, string[]> = {
  friendly: ['Got it. Next one.', "Nice — let's keep going.", "Okay, moving on."],
  curious: ['Mm. Okay.', 'Interesting. Next.', 'Got it. Moving on.'],
  tough: ['Noted. Next.', 'Okay. Next question.', 'Got it.'],
};

// ─────────────────────────────────────────────────────────────────────
// Turn-generation
// ─────────────────────────────────────────────────────────────────────

const SHORT_ANSWER_CHARS = 80;

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function buildGreeting(style: InterviewerStyle): MockTurn {
  return {
    id: newId('turn'),
    role: 'interviewer',
    text: GREETINGS[style],
    at: nowIso(),
    questionId: null,
  };
}

export function buildClosing(style: InterviewerStyle): MockTurn {
  return {
    id: newId('turn'),
    role: 'interviewer',
    text: CLOSINGS[style],
    at: nowIso(),
    questionId: null,
  };
}

/** Builds the interviewer's primary turn for a question — optionally
 *  prefixed with a short ack of the previous answer. */
export function buildQuestionTurn(
  q: MockQuestion,
  style: InterviewerStyle,
  isFirst: boolean,
): MockTurn {
  const text = isFirst ? q.prompt : `${pick(ACKS[style])} ${q.prompt}`;
  return {
    id: newId('turn'),
    role: 'interviewer',
    text,
    at: nowIso(),
    questionId: q.id,
  };
}

/** Decide whether to probe the candidate's answer. Returns the follow-up turn
 *  or null if the answer was good enough. */
export function maybeFollowUp(
  q: MockQuestion,
  answer: string,
  style: InterviewerStyle,
): MockTurn | null {
  const trimmed = answer.trim();
  const tooShort = trimmed.length < SHORT_ANSWER_CHARS;
  const noNumbers = !/\d/.test(trimmed);
  const noConcreteExample = !/for example|specifically|at \w+|when i|i (led|built|shipped|owned|drove|reduced)/i.test(
    trimmed,
  );

  const shouldProbe = tooShort || (q.kind === 'behavioral' && noConcreteExample);
  if (!shouldProbe) return null;

  const text =
    q.followUp ??
    (tooShort
      ? pick(PROBES[style])
      : 'Can you give me a specific example — a real moment, with details?');

  return {
    id: newId('turn'),
    role: 'interviewer',
    text,
    at: nowIso(),
    questionId: q.id,
    followUp: true,
  };
}

export function makeCandidateTurn(text: string, questionId: string | null): MockTurn {
  return {
    id: newId('turn'),
    role: 'candidate',
    text: text.trim(),
    at: nowIso(),
    questionId,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Filler-word counter + STAR detection
// ─────────────────────────────────────────────────────────────────────

const FILLER_RE = /\b(uh|um|hmm|er|like|you know|sort of|kind of|basically|literally|i mean|so yeah|you see)\b/gi;

export function countFillerWords(text: string): number {
  const matches = text.toLowerCase().match(FILLER_RE);
  return matches ? matches.length : 0;
}

export function countWords(text: string): number {
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}

const STAR_SIGNALS = {
  situation: /\b(at|when i was|during|while at|previously|in (my|the) last|on the team|the context)\b/i,
  task: /\b(my (job|task|role|goal)|i was responsible|i needed to|the challenge|the ask was|we had to)\b/i,
  action: /\b(i (led|built|designed|owned|drove|shipped|reduced|increased|partnered|migrated|reorganized|rewrote))\b/i,
  result: /\b(\d+\s*%|by \d+|\$\d+|reduced|increased|grew|cut|saved|hit|reached|launched|delivered|kpi|metric|nps|csat)\b/i,
};

export function detectStar(text: string): QuestionScore['starStructure'] {
  return {
    situation: STAR_SIGNALS.situation.test(text),
    task: STAR_SIGNALS.task.test(text),
    action: STAR_SIGNALS.action.test(text),
    result: STAR_SIGNALS.result.test(text),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Scoring + report
// ─────────────────────────────────────────────────────────────────────

function scoreOneQuestion(q: MockQuestion, answer: string): QuestionScore {
  const star = detectStar(answer);
  const starHits = Object.values(star).filter(Boolean).length;
  const wordCount = countWords(answer);
  const fillers = countFillerWords(answer);

  // Keyword hits — only matters for technical / system_design.
  const keywordHits = (q.expectedKeywords ?? []).filter((k) =>
    new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(answer),
  );

  let score = 50;
  // Length: too short, too long, just right.
  if (wordCount < 20) score -= 25;
  else if (wordCount > 350) score -= 5;
  else if (wordCount >= 60 && wordCount <= 220) score += 15;

  // STAR structure (for any kind — but most relevant to behavioral).
  if (q.kind === 'behavioral' || q.kind === 'case') {
    score += starHits * 8; // +0..+32
  }
  // Keyword hits.
  if (q.expectedKeywords && q.expectedKeywords.length > 0) {
    const ratio = keywordHits.length / q.expectedKeywords.length;
    score += Math.round(ratio * 30); // +0..+30
  }
  // Filler penalty (light).
  score -= Math.min(15, fillers * 2);

  score = Math.max(0, Math.min(100, score));

  const strengths: string[] = [];
  const improvements: string[] = [];

  if (wordCount >= 60 && wordCount <= 220) strengths.push('Right-sized answer length.');
  if (star.action) strengths.push('You named the action you took — recruiters love that.');
  if (star.result) strengths.push('You quantified the impact.');
  if (keywordHits.length > 0) {
    strengths.push(`Hit the key concepts: ${keywordHits.slice(0, 4).join(', ')}.`);
  }
  if (!star.situation && (q.kind === 'behavioral' || q.kind === 'case')) {
    improvements.push('Open with the situation — where, when, who else was involved.');
  }
  if (!star.result && (q.kind === 'behavioral' || q.kind === 'case')) {
    improvements.push('Land with a concrete outcome — a number, a metric, a "before vs after".');
  }
  if (wordCount < 30) improvements.push('Your answer was short — recruiters parse short answers as "no real experience".');
  if (wordCount > 320) improvements.push('Trim to ~2 minutes. Long answers signal you cannot pick the punchline.');
  if (fillers > 4) improvements.push(`You used ${fillers} filler words — pause instead of "um" or "you know".`);
  if (q.expectedKeywords && keywordHits.length === 0) {
    improvements.push(`Missing the key terms an interviewer is listening for (${q.expectedKeywords.slice(0, 3).join(', ')}).`);
  }
  if (strengths.length === 0) strengths.push('You engaged with the question.');
  if (improvements.length === 0) improvements.push('Strong answer overall — keep this version.');

  return {
    questionId: q.id,
    prompt: q.prompt,
    score,
    strengths,
    improvements,
    answer: answer.trim(),
    sampleAnswer: q.sampleAnswer ?? null,
    starStructure: star,
  };
}

export function generateReport(
  mock: MockInterview,
  session: MockSession,
): MockReport {
  // Group candidate turns by question id; concatenate when there were multiple
  // (e.g. after a follow-up probe).
  const answersByQ = new Map<string, string>();
  let totalCandidateText = '';
  for (const t of session.turns) {
    if (t.role !== 'candidate') continue;
    totalCandidateText += ` ${t.text}`;
    if (t.questionId) {
      const prev = answersByQ.get(t.questionId) ?? '';
      answersByQ.set(t.questionId, `${prev} ${t.text}`.trim());
    }
  }

  const perQuestion: QuestionScore[] = mock.questions.map((q) =>
    scoreOneQuestion(q, answersByQ.get(q.id) ?? ''),
  );

  const answeredCount = perQuestion.filter((p) => p.answer.length > 0).length;
  const avgScore =
    answeredCount > 0
      ? Math.round(
          perQuestion.filter((p) => p.answer.length > 0).reduce((s, p) => s + p.score, 0) /
            answeredCount,
        )
      : 0;

  const fillers = countFillerWords(totalCandidateText);
  const words = countWords(totalCandidateText);

  // Time the candidate actually spoke (rough: from first to last candidate turn).
  const candidateTurns = session.turns.filter((t) => t.role === 'candidate');
  let elapsedMin = mock.duration;
  if (candidateTurns.length >= 2) {
    const start = new Date(candidateTurns[0].at).getTime();
    const end = new Date(candidateTurns[candidateTurns.length - 1].at).getTime();
    const minutes = Math.max(0.5, (end - start) / 60_000);
    elapsedMin = Math.max(0.5, minutes);
  }
  const wpm = words > 0 ? Math.round(words / elapsedMin) : 0;

  // Per-dimension scoring.
  const technical = Math.round(
    perQuestion
      .filter((p) => true)
      .reduce((s, p) => s + p.score, 0) / Math.max(1, perQuestion.length),
  );
  const structureHits = perQuestion.reduce(
    (s, p) =>
      s +
      Number(p.starStructure.situation) +
      Number(p.starStructure.task) +
      Number(p.starStructure.action) +
      Number(p.starStructure.result),
    0,
  );
  const structure = Math.min(
    100,
    Math.round((structureHits / Math.max(1, perQuestion.length * 4)) * 100),
  );
  const fillerRate = words > 0 ? fillers / words : 0;
  const confidence = Math.max(0, Math.min(100, Math.round(100 - fillerRate * 800)));
  const communication = Math.round(
    Math.max(0, Math.min(100, 100 - Math.abs(140 - wpm) * 0.5)),
  );

  // Top strength / improvement extraction.
  const flatStrengths = perQuestion.flatMap((p) => p.strengths);
  const flatImprovements = perQuestion.flatMap((p) => p.improvements);
  const topStrengths = dedup(flatStrengths).slice(0, 3);
  const topImprovements = dedup(flatImprovements).slice(0, 3);

  return {
    id: newId('rep'),
    sessionId: session.id,
    mockId: mock.id,
    mockTitle: mock.title,
    createdAt: nowIso(),
    score: avgScore,
    dimensions: { communication, technical, structure, confidence },
    fillerCount: fillers,
    topStrengths,
    topImprovements,
    perQuestion,
    wpm,
    candidateWords: words,
  };
}

function dedup<T>(arr: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of arr) {
    const k = String(v);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Custom mock creation (JD / topic)
// ─────────────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','and','for','with','you','your','our','will','have','has','this','that','from','into',
  'over','about','their','they','them','who','what','when','where','our','team','role','job',
  'work','years','must','should','can','able','using','use','be','is','a','an','or','of','in',
  'on','to','as','at','by','we','us','all','any','such','may','one','plus','including',
  'preferred','required',
]);

function extractTopTerms(text: string, n: number): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s+/.#-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[.,;:]+$/, ''))
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map((p) => p[0])
    .slice(0, n);
}

/** Generate a 6-question custom mock from a job description. The questions
 *  are templated from the top extracted skill terms; this is deliberately
 *  fast and deterministic so the UI feels responsive. */
export function makeMockFromJd(jd: string, title: string): MockInterview {
  const skills = extractTopTerms(jd, 6);
  const id = `mk_custom_${Date.now().toString(36)}`;
  const questions: MockQuestion[] = [
    {
      id: 'q1', kind: 'behavioral',
      prompt: `Walk me through your most relevant experience for the ${title || 'role'} we just described.`,
      followUp: 'Pick the one project that maps closest, and go deeper.',
    },
    {
      id: 'q2', kind: 'technical',
      prompt: skills[0]
        ? `The JD calls out ${skills[0]}. Walk me through where you've used it and the hardest call you had to make.`
        : 'What is the hardest technical decision you have made recently?',
      expectedKeywords: skills.slice(0, 3),
    },
    {
      id: 'q3', kind: 'case',
      prompt: skills[1]
        ? `Design a system or process around ${skills[1]} for this team. Five minutes.`
        : 'Pick a system you would design for this team. Five minutes.',
      expectedKeywords: skills.slice(0, 4),
    },
    {
      id: 'q4', kind: 'technical',
      prompt: skills[2]
        ? `Where does ${skills[2]} usually go wrong, and how do you catch it before it ships?`
        : 'Where does this kind of work usually go wrong, and how do you catch it early?',
    },
    {
      id: 'q5', kind: 'behavioral',
      prompt: `Tell me about a time you disagreed with a teammate on ${skills[3] || 'a critical decision'}. How did it resolve?`,
    },
    {
      id: 'q6', kind: 'behavioral',
      prompt: `Why this team, why now? Be specific to the JD.`,
    },
  ];
  return {
    id,
    title: title || 'Custom Mock from JD',
    description: 'Tailored to the job description you pasted in.',
    category: 'other',
    duration: 15,
    difficulty: 'medium',
    gradient: { from: '#dbeafe', to: '#ddd6fe' },
    skills,
    questions,
    isCustom: true,
    customSource: { kind: 'jd', label: title || 'Pasted JD' },
    createdAt: nowIso(),
  };
}

export function makeMockFromTopic(topic: string): MockInterview {
  const id = `mk_custom_${Date.now().toString(36)}`;
  const t = topic.trim() || 'a topic of your choice';
  return {
    id,
    title: `Mock: ${t}`,
    description: `A focused 6-question drill on ${t}.`,
    category: 'other',
    duration: 15,
    difficulty: 'medium',
    gradient: { from: '#dcfce7', to: '#a7f3d0' },
    skills: [t],
    questions: [
      { id: 'q1', kind: 'technical', prompt: `Explain ${t} as if I were brand new to it.` },
      { id: 'q2', kind: 'technical', prompt: `Walk me through a real project where ${t} mattered.` },
      { id: 'q3', kind: 'case', prompt: `Design a small system that depends heavily on ${t}.` },
      { id: 'q4', kind: 'technical', prompt: `Where does ${t} usually go wrong in production?` },
      { id: 'q5', kind: 'behavioral', prompt: `Tell me about a time you had to learn ${t} fast.` },
      { id: 'q6', kind: 'behavioral', prompt: `Who is the person you learned the most about ${t} from, and what stuck?` },
    ],
    isCustom: true,
    customSource: { kind: 'topic', label: t },
    createdAt: nowIso(),
  };
}

export function makeMockFromResume(summary: string, targetTitle: string): MockInterview {
  const skills = extractTopTerms(summary, 5);
  const id = `mk_custom_${Date.now().toString(36)}`;
  return {
    id,
    title: `Mock from your resume: ${targetTitle || 'your target role'}`,
    description: 'Probes the claims on your most recent resume, then asks for the receipts.',
    category: 'other',
    duration: 15,
    difficulty: 'medium',
    gradient: { from: '#fef3c7', to: '#fde68a' },
    skills,
    questions: [
      { id: 'q1', kind: 'behavioral', prompt: `Walk me through your most recent role end-to-end — three minutes.` },
      { id: 'q2', kind: 'behavioral', prompt: skills[0] ? `Your resume claims experience with ${skills[0]}. Tell me the moment that earned that line.` : 'Pick the strongest line on your resume. Defend it.' },
      { id: 'q3', kind: 'behavioral', prompt: 'Pick a number from your resume. Tell me how it was actually measured.' },
      { id: 'q4', kind: 'behavioral', prompt: 'Tell me about a decision you owned that did not work out.' },
      { id: 'q5', kind: 'case', prompt: skills[1] ? `Design a project that combines ${skills[0]} and ${skills[1]} for a new team.` : 'Design a small project for a new team.' },
      { id: 'q6', kind: 'behavioral', prompt: 'What is the one thing on your resume you most want to defend in this interview?' },
    ],
    isCustom: true,
    customSource: { kind: 'resume', label: targetTitle || 'Your resume' },
    createdAt: nowIso(),
  };
}
