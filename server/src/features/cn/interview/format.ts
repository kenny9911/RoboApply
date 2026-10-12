// server/src/features/cn/interview/format.ts — the GoApply AI-interview
// practice format: a 20–30 minute script and the zh question sets
// (TASK_PLAN.md WP-66; F-INT-06).
//
// The script follows the shape of the one-way, timed AI interviews that
// mainland employers commonly use for campus and early-career roles: a short
// self-introduction, motivation, several "tell me about a time" story
// questions, one situational question, one structured-thinking question, one
// role question and a closing. Each question has thinking time and an answer
// limit. No vendor is named anywhere (user copy: "模拟企业常用的 AI 面试形式").
//
// The question sets are written for this product (no third-party question
// bank). Selection is deterministic per seed, so a session can be replayed and
// two sessions with different seeds get different questions.

import {
  CN_AI_INTERVIEW_FORMAT_ID,
  CN_FORMAT_COMPATIBLE_TYPES,
  CN_FORMAT_DEFAULT_MINUTES,
  CN_FORMAT_MAX_MINUTES,
  CN_FORMAT_MIN_MINUTES,
  CN_SECTION_IDS,
  type CnPlannedQuestion,
  type CnQuestion,
  type CnScript,
  type CnScriptSection,
  type CnSectionId,
} from './contract.js';
import { isStoryQuestion } from './rubric.js';

// ─── zh question sets ──────────────────────────────────────────────────────

const STAR_HINT_ZH = '讲一个真实经历：当时的情况、你的任务、你具体做了什么、结果如何。';
const STAR_HINT_EN = 'Tell one real story: the situation, your task, what you did, and the result.';

function story(id: string, section: CnSectionId, zh: string, en: string): CnQuestion {
  return { id, section, zh, en, story: true, hintZh: STAR_HINT_ZH, hintEn: STAR_HINT_EN };
}

function plain(id: string, section: CnSectionId, zh: string, en: string, hintZh: string, hintEn: string): CnQuestion {
  return { id, section, zh, en, story: false, hintZh, hintEn };
}

export const CN_QUESTION_SETS: Readonly<Record<CnSectionId, readonly CnQuestion[]>> = {
  self_intro: [
    plain('intro-1', 'self_intro', '请用两分钟做一个自我介绍。', 'Please introduce yourself in two minutes.',
      '先说你是谁、学什么或做什么，再挑一两段和这个岗位最相关的经历。', 'Say who you are and what you study or do, then pick one or two experiences that fit this role.'),
    plain('intro-2', 'self_intro', '请简单介绍一下你自己，以及你和这个岗位最相关的一段经历。', 'Briefly introduce yourself and the one experience most relevant to this role.',
      '控制在两分钟内，重点放在和岗位相关的部分。', 'Keep it under two minutes and focus on what fits the role.'),
    plain('intro-3', 'self_intro', '如果用三个词形容你自己，你会选哪三个？每个词请配一个简短的事例。', 'If you described yourself in three words, which would you choose? Back each word with a short, real case.',
      '每个词配一个简短的真实例子。', 'Back each word with one short, real example.'),
  ],
  motivation: [
    plain('mot-1', 'motivation', '你为什么想申请这个岗位？', 'Why do you want this role?',
      '说清楚你对岗位的理解，以及你的经历为什么适合。', 'Show what you understand about the role and why your experience fits.'),
    plain('mot-2', 'motivation', '你未来三到五年的职业规划是什么？这个岗位在其中起什么作用？', 'What are your career plans for the next three to five years, and where does this role fit?',
      '规划要具体、现实，并和岗位联系起来。', 'Be specific and realistic, and connect the plan to the role.'),
    plain('mot-3', 'motivation', '你是如何了解我们这个行业的？你觉得它最吸引你的地方是什么？', 'How did you learn about this industry, and what draws you to it most?',
      '可以提到你做过的了解或实践。', 'Mention what you have read, done or tried.'),
    plain('mot-4', 'motivation', '在选择工作时，你最看重哪三点？为什么？', 'When choosing a job, what three things matter most to you, and why?',
      '给出排序和理由，避免空泛。', 'Rank them and give a reason for each.'),
  ],
  behavioral: [
    story('beh-team', 'behavioral', '请讲一次你在团队中和他人合作完成一项任务的经历。你在其中承担了什么角色？', 'Tell me about a time you worked with others to finish a task. What was your role?'),
    story('beh-conflict', 'behavioral', '请讲一次你和同学或同事意见不一致的经历，你是怎么处理的？', 'Tell me about a time you disagreed with a classmate or colleague. How did you handle it?'),
    story('beh-failure', 'behavioral', '请讲一次你没有达到预期目标的经历。你从中学到了什么？', 'Tell me about a time you fell short of a goal. What did you learn?'),
    story('beh-pressure', 'behavioral', '请讲一次你在时间很紧、压力很大的情况下完成任务的经历。', 'Tell me about a time you finished a task under tight time and pressure.'),
    story('beh-initiative', 'behavioral', '请讲一次你主动发现问题并推动解决的经历。', 'Tell me about a time you spotted a problem yourself and pushed to solve it.'),
    story('beh-learning', 'behavioral', '请讲一次你在很短时间内学会一项新技能或新知识的经历。', 'Tell me about a time you learned a new skill or subject in a short time.'),
    story('beh-ambiguity', 'behavioral', '请讲一次任务要求不明确时，你是如何推进工作的。', 'Tell me about a time the task was unclear. How did you move it forward?'),
    story('beh-priority', 'behavioral', '请讲一次你需要同时处理多项任务的经历，你是如何安排优先级的？', 'Tell me about a time you had several tasks at once. How did you set priorities?'),
    story('beh-persuade', 'behavioral', '请讲一次你说服别人接受你的想法的经历。', 'Tell me about a time you persuaded someone to accept your idea.'),
    story('beh-mistake', 'behavioral', '请讲一次你犯了错误的经历，你是怎么弥补的？', 'Tell me about a time you made a mistake. How did you put it right?'),
  ],
  situational: [
    plain('sit-1', 'situational', '如果你负责的项目在截止日期前一周发现严重问题，你会怎么做？', 'If a week before the deadline you found a serious problem in a project you lead, what would you do?',
      '按步骤说：先判断、再沟通、再行动。', 'Answer in steps: assess, communicate, then act.'),
    plain('sit-2', 'situational', '如果你的上级给你布置了一项你认为不合理的任务，你会怎么处理？', 'If your manager gave you a task you thought made no sense, how would you handle it?',
      '说明你会如何了解原因、表达意见并推进。', 'Explain how you would find out why, say what you think, and still move forward.'),
    plain('sit-3', 'situational', '如果团队成员一直没有完成他负责的部分，影响了整体进度，你会怎么做？', 'If a teammate kept missing their part and it delayed everyone, what would you do?',
      '兼顾任务和关系。', 'Balance the work and the relationship.'),
    plain('sit-4', 'situational', '如果客户对你的方案很不满意，并且情绪激动，你会怎么回应？', 'If a client was very unhappy with your proposal and upset, how would you respond?',
      '先处理情绪，再处理问题。', 'Calm the situation first, then solve the problem.'),
    plain('sit-5', 'situational', '如果你同时收到两位领导互相冲突的要求，你会怎么办？', 'If two managers gave you conflicting requests at the same time, what would you do?',
      '说明你如何确认优先级并让双方知情。', 'Explain how you would settle the priority and keep both informed.'),
    plain('sit-6', 'situational', '入职第一个月，你会做哪些事情来尽快熟悉工作？', 'In your first month, what would you do to get up to speed quickly?',
      '给出具体、有顺序的计划。', 'Give a specific plan in order.'),
  ],
  logic: [
    plain('log-1', 'logic', '请估算一下你所在城市一天大约卖出多少杯咖啡，并说明你的思路。', 'Estimate how many cups of coffee are sold in your city in one day, and walk through your thinking.',
      '先拆分，再给出假设和计算，最后检查是否合理。', 'Break it down, state your assumptions and maths, then sanity-check the result.'),
    plain('log-2', 'logic', '一家奶茶店最近一个月销量下降了两成，你会从哪些方面分析原因？', 'A milk-tea shop’s sales fell by a fifth last month. How would you look for the cause?',
      '用分类的方式列出可能原因，再说先查哪一个。', 'Group the possible causes, then say which you would check first.'),
    plain('log-3', 'logic', '请用“总—分—总”的结构，介绍一件你最近读过或学过的东西。', 'Using a "point, details, point" structure, explain something you recently read or learned.',
      '先给结论，再展开要点，最后总结。', 'Lead with the point, give the details, then sum up.'),
    plain('log-4', 'logic', '如果让你给一位从没用过智能手机的长辈讲清楚如何视频通话，你会怎么讲？', 'How would you explain to an older relative who has never used a smartphone how to make a video call?',
      '步骤清楚、用词简单。', 'Clear steps and simple words.'),
    plain('log-5', 'logic', '学校想提高图书馆的使用率，请你提出三条建议，并说明理由和优先顺序。', 'Your school wants more students to use the library. Suggest three ideas, with reasons and an order of priority.',
      '每条建议都要有理由，并说明为什么这样排序。', 'Give a reason for each idea and explain the order.'),
    plain('log-6', 'logic', '你认为远程办公对团队效率是利大于弊还是弊大于利？请说明你的观点和依据。', 'Does remote work help or hurt a team’s output more? Give your view and your reasons.',
      '先表明观点，再给两到三条依据，最后说明适用条件。', 'State your view, give two or three reasons, then say when it holds.'),
  ],
  role: [
    plain('role-1', 'role', '结合这个岗位，你认为做好这份工作最重要的能力是什么？你具备哪些？', 'For this role, what ability matters most for doing the job well, and which of it do you have?',
      '先说你对岗位的理解，再用经历证明。', 'Say how you see the role, then prove it with your experience.'),
    story('role-2', 'role', '请讲一段和这个岗位最相关的实习、项目或课程经历，你具体负责了什么？', 'Describe a time in an internship, project or course that is most relevant to this role. What exactly were you responsible for?'),
    plain('role-3', 'role', '如果你入职这个岗位，你觉得第一个季度最需要解决的问题是什么？', 'If you joined in this role, what do you think is the first problem to solve in your first three months?',
      '基于你对岗位的了解，给出具体的想法。', 'Base it on what you know about the role and be specific.'),
  ],
  closing: [
    plain('close-1', 'closing', '最后，关于你自己，还有什么想补充的吗？', 'Finally, is there anything else you would like to add about yourself?',
      '可以补充前面没讲到的亮点，控制在一分钟内。', 'Add a strength you have not mentioned yet, in under a minute.'),
    plain('close-2', 'closing', '请用一句话总结：我们为什么应该选择你？', 'In one sentence: why should we choose you?',
      '一句话、有依据。', 'One sentence, with evidence.'),
  ],
};

// ─── The script ────────────────────────────────────────────────────────────

/**
 * The 25-minute plan: 9 questions. Thinking time + answer limits add up to
 * 22.5 minutes, leaving room for the interviewer's lines; the 20-minute plan
 * asks 2 story questions (19.5 min of limits), the 30-minute plan 4 (25.5).
 * Limits are maxima: most answers finish early.
 */
export const CN_SCRIPT_SECTIONS: readonly CnScriptSection[] = [
  { id: 'self_intro', questions: 1, prepSeconds: 30, answerSeconds: 90 },
  { id: 'motivation', questions: 1, prepSeconds: 30, answerSeconds: 90 },
  { id: 'behavioral', questions: 3, prepSeconds: 30, answerSeconds: 150 },
  { id: 'situational', questions: 1, prepSeconds: 30, answerSeconds: 120 },
  { id: 'logic', questions: 1, prepSeconds: 60, answerSeconds: 150 },
  { id: 'role', questions: 1, prepSeconds: 30, answerSeconds: 120 },
  { id: 'closing', questions: 1, prepSeconds: 0, answerSeconds: 60 },
];

/** Clamp a planned duration into the format's 20–30 minute range. */
export function clampCnMinutes(minutes: number | null | undefined): number {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return CN_FORMAT_DEFAULT_MINUTES;
  return Math.max(CN_FORMAT_MIN_MINUTES, Math.min(CN_FORMAT_MAX_MINUTES, Math.round(minutes)));
}

/** Story questions per plan length: 2 at 20–22 min, 3 at 23–27, 4 at 28–30. */
export function storyQuestionCount(minutes: number): number {
  const m = clampCnMinutes(minutes);
  if (m <= 22) return 2;
  if (m >= 28) return 4;
  return 3;
}

/** Seconds of thinking + answering the plan asks for. */
export function scriptSeconds(questions: ReadonlyArray<Pick<CnPlannedQuestion, 'prepSeconds' | 'answerSeconds'>>): number {
  return questions.reduce((sum, q) => sum + q.prepSeconds + q.answerSeconds, 0);
}

/** FNV-1a 32-bit; stable across runtimes. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** `count` distinct items from `items`, ordered by a seeded hash (deterministic). */
function pick<T extends { id: string }>(items: readonly T[], count: number, seed: string): T[] {
  return [...items]
    .map((item) => ({ item, rank: hash(`${seed}:${item.id}`) }))
    .sort((a, b) => a.rank - b.rank || a.item.id.localeCompare(b.item.id))
    .slice(0, Math.max(0, Math.min(count, items.length)))
    .map(({ item }) => item);
}

export interface BuildCnScriptInput {
  /** Selection seed (a session id, or user id + date). Same seed → same questions. */
  seed: string;
  /** Planned minutes; clamped to 20–30. */
  minutes?: number | null;
  /** Interview language; anything but English runs the zh set. */
  language?: string | null;
  /**
   * Role questions written for this job (in the session language), used for
   * the `role` slot instead of the generic ones when present.
   */
  roleQuestions?: string[];
}

export function cnScriptLanguage(language: string | null | undefined): 'zh' | 'en' {
  return (language ?? '').trim().toLowerCase().startsWith('en') ? 'en' : 'zh';
}

/** Build the ordered question plan for one practice. Pure and deterministic. */
export function buildCnScript(input: BuildCnScriptInput): CnScript {
  const minutes = clampCnMinutes(input.minutes ?? CN_FORMAT_DEFAULT_MINUTES);
  const language = cnScriptLanguage(input.language);
  const questions: CnPlannedQuestion[] = [];
  const roleQuestions = (input.roleQuestions ?? []).map((q) => q.trim()).filter(Boolean);

  for (const section of CN_SCRIPT_SECTIONS) {
    const count = section.id === 'behavioral' ? storyQuestionCount(minutes) : section.questions;
    let chosen: CnQuestion[];
    if (section.id === 'role' && roleQuestions.length) {
      chosen = roleQuestions.slice(0, count).map((text, i) => ({
        id: `role-job-${i + 1}`,
        section: 'role' as const,
        zh: text,
        en: text,
        story: isStoryQuestion(text),
        hintZh: CN_QUESTION_SETS.role[0]!.hintZh,
        hintEn: CN_QUESTION_SETS.role[0]!.hintEn,
      }));
    } else {
      chosen = pick(CN_QUESTION_SETS[section.id], count, `${input.seed}:${section.id}`);
    }
    for (const q of chosen) {
      questions.push({
        ...q,
        order: questions.length,
        prepSeconds: section.prepSeconds,
        answerSeconds: section.answerSeconds,
      });
    }
  }

  return { formatId: CN_AI_INTERVIEW_FORMAT_ID, minutes, language, questions };
}

/** The question text in the script's language. */
export function questionText(q: Pick<CnQuestion, 'zh' | 'en'>, language: 'zh' | 'en'): string {
  return language === 'en' ? q.en : q.zh;
}

/** The hint in the script's language. */
export function questionHint(q: Pick<CnQuestion, 'hintZh' | 'hintEn'>, language: 'zh' | 'en'): string {
  return language === 'en' ? q.hintEn : q.hintZh;
}

// Per-question answer tips (question-set content, shown with the question in
// text practice). Timing is never written into a tip: the UI renders it from
// the plan's prepSeconds/answerSeconds (practiceCn.format.timing).
const STORY_TIP_ZH = '只讲一个故事，重点说你本人做了什么，结果尽量具体。';
const STORY_TIP_EN = 'Tell one story, focus on what you did yourself, and make the result specific.';
const PLAIN_TIP_ZH = '先说结论，再分两三点说明，最后简短总结。';
const PLAIN_TIP_EN = 'Lead with your conclusion, give two or three points, then sum up briefly.';

/** The answer tip in the script's language: STAR for story questions, conclusion-first otherwise. */
export function questionTip(q: Pick<CnQuestion, 'story'>, language: 'zh' | 'en'): string {
  if (q.story) return language === 'en' ? STORY_TIP_EN : STORY_TIP_ZH;
  return language === 'en' ? PLAIN_TIP_EN : PLAIN_TIP_ZH;
}

/** True when a planned length already sits in the format's 20–30 minute range. */
export function fitsCnFormatMinutes(minutes: number): boolean {
  return Number.isFinite(minutes) && clampCnMinutes(minutes) === Math.round(minutes);
}

/**
 * True when a practice of this type on this market runs in the AI-interview
 * format. The explicit format id always does. A general type on the cn market
 * does too, but when the caller passes the planned `minutes` it must already
 * fit 20–30: a 10- or 45-minute behavioural practice keeps its own length and
 * the general pipeline instead of being silently re-timed.
 */
export function usesCnFormat(input: {
  market: string | null | undefined;
  typeId: string | null | undefined;
  minutes?: number | null;
}): boolean {
  const typeId = (input.typeId ?? '').trim();
  if (typeId === CN_AI_INTERVIEW_FORMAT_ID) return true;
  if (input.market !== 'cn' || !CN_FORMAT_COMPATIBLE_TYPES.includes(typeId)) return false;
  return typeof input.minutes !== 'number' || fitsCnFormatMinutes(input.minutes);
}

/** Every question in the sets (fixtures, vendor-name tests). */
export function allCnQuestions(): CnQuestion[] {
  return CN_SECTION_IDS.flatMap((id) => [...CN_QUESTION_SETS[id]]);
}

// ─── Model-facing directives (English, never shown to the user) ────────────

/** Question-design directive for the interview engine's blueprint agent. */
export const CN_FORMAT_BLUEPRINT_DIRECTIVE =
  'Design this as the one-way, timed AI video interview that mainland Chinese employers commonly use for campus and early-career hiring. ' +
  'Run a fixed script in this order: a two-minute self-introduction; one motivation question (why this role, career plan); two to four ' +
  '"tell me about a time" story questions on teamwork, conflict, failure, pressure, initiative or learning, each graded for a complete ' +
  'Situation-Task-Action-Result arc; one situational "what would you do if" question; one structured-thinking question (an estimate, a ' +
  'root-cause breakdown or a "point, details, point" explanation); one question tied to the role or job post; and a short closing. ' +
  'Each question is read once, the candidate gets thinking time and a time limit, and the interviewer gives no hints. Allow at most ' +
  'one short follow-up per question, only to ask for a missing STAR part or a missing step. Keep a neutral, even tone; never react to ' +
  'answers with praise or criticism during the interview. Write questions in the session language (Simplified Chinese by default) using ' +
  'mainland wording. Never name any assessment vendor or platform, and never say the result predicts a real hiring decision.';

/** Grading lens added to the evaluation for sessions in this format. */
export const CN_FORMAT_EVALUATION_LENS =
  'This practice follows the timed AI-interview format mainland employers commonly use. Weigh three areas: communication (clear, ' +
  'fluent, few filler words, within the time limit), logic (a clear structure: conclusion first, grouped points, a summary) and ' +
  'behaviour (story answers with a complete Situation-Task-Action-Result arc and a personal contribution). Judge only what the ' +
  'transcript shows and never predict a real hiring outcome.';

/** Focus areas for the format (model-facing). */
export const CN_FORMAT_FOCUS_AREAS: readonly string[] = [
  'communication and fluency',
  'logical structure',
  'STAR completeness in story answers',
  'motivation and role understanding',
  'composure within time limits',
];

/** Script phases for a text practice strategy (model-facing names). */
export function cnStrategyPhases(minutes: number): Array<{ name: string; minutes: number; goal: string }> {
  const m = clampCnMinutes(minutes);
  const stories = storyQuestionCount(m);
  const storyMinutes = Math.max(6, m - 13);
  return [
    { name: 'Self-introduction', minutes: 2, goal: 'A two-minute introduction focused on what fits the role.' },
    { name: 'Motivation', minutes: 2, goal: 'Why this role and how it fits the candidate’s plans.' },
    { name: 'Story questions', minutes: storyMinutes, goal: `${stories} real stories, each with situation, task, action and result.` },
    { name: 'Situational and structured thinking', minutes: 5, goal: 'One "what would you do" question and one structured-thinking question.' },
    { name: 'Role and closing', minutes: Math.max(2, m - storyMinutes - 9), goal: 'One role question, then a short closing.' },
  ];
}
