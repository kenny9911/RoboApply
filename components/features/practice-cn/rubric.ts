// components/features/practice-cn/rubric.ts — CLIENT MIRROR of the GoApply
// practice rubric and report builder (TASK_PLAN.md WP-66):
//   server/src/features/cn/interview/contract.ts (report types),
//   server/src/features/cn/interview/rubric.ts   (STAR, fillers, areas),
//   server/src/features/cn/interview/report.ts   (answers → report block).
// The web build cannot import server/src, so this is a copy. Change the
// server files first, then copy the change here: the parity test
// (__tests__/rubricParity.test.ts) runs both on the zh fixture and fails on
// any difference. CnReport uses it when the session carries no stored block.

// ─── Types (contract.ts) ─────────────────────────────────────────────────

export const CN_AI_INTERVIEW_FORMAT_ID = 'cn_ai_interview';

/** The three report areas: communication, logic, behaviour. */
export const CN_AREA_KEYS = ['communication', 'logic', 'behaviour'] as const;
export type CnAreaKey = (typeof CN_AREA_KEYS)[number];

/**
 * Where an area value comes from:
 *   ai_review    — the AI review of this practice (shown with the AI label);
 *   text_checks  — the free text checks on the transcript (no model);
 *   star_check   — the STAR check below (no model);
 *   mixed        — the AI review did not finish everywhere (client only,
 *                  when it cannot tell which part finished).
 */
export type CnAreaBasis = 'ai_review' | 'text_checks' | 'star_check' | 'mixed';

export interface CnAreaScore {
  key: CnAreaKey;
  /** 0–100, or null when there is nothing to score ("—"). */
  value: number | null;
  basis: CnAreaBasis;
}

export const STAR_PARTS = ['situation', 'task', 'action', 'result'] as const;
export type StarPart = (typeof STAR_PARTS)[number];

export interface StarCheck {
  situation: boolean;
  task: boolean;
  action: boolean;
  result: boolean;
  /** Parts present, 0–4. */
  parts: number;
  missing: StarPart[];
}

export interface FillerHit {
  word: string;
  count: number;
}

export interface FillerCount {
  total: number;
  /** Most frequent first, ties in list order. */
  top: FillerHit[];
}

/** One answer of the practice, as checked. */
export interface CnAnswerCheck {
  /** 0-based answer order. */
  index: number;
  /** The question asked before this answer, or null when none was recorded. */
  question: string | null;
  /** Answer length: characters (Chinese) or words (other text). */
  length: number;
  /** STAR check, or null when the question did not ask for a story. */
  star: StarCheck | null;
  fillers: FillerCount;
}

export interface CnStarSummary {
  /** Answers to story questions. */
  storyAnswers: number;
  /** Story answers with all four parts. */
  complete: number;
  /** The part missing most often across story answers, or null. */
  missingMost: StarPart | null;
}

export interface CnFillerSummary {
  total: number;
  /** Fillers per 100 units of answer text, one decimal; null with no answer text. */
  per100: number | null;
  /** `chars` for Chinese answers, `words` otherwise. */
  unit: 'chars' | 'words';
  top: FillerHit[];
}

/** The GoApply practice report block (stored as `report.cn` on a GoApply InterviewSession). */
export interface CnPracticeReport {
  version: 1;
  formatId: string;
  language: string;
  generatedAt: string;
  areas: CnAreaScore[];
  star: CnStarSummary;
  fillers: CnFillerSummary;
  answers: CnAnswerCheck[];
}

/** A transcript turn in the shape both practice paths can provide. */
export interface CnTurn {
  role: 'interviewer' | 'candidate';
  text: string;
}

/** Breakdown rows as stored on a session (canonical or the scorer's English keys). */
export interface CnBreakdownRow {
  key: string;
  value: number;
}

// ─── Rubric (rubric.ts): text helpers ──────────────────────────────────────────────────────────

const CJK_CHAR_RE = /[㐀-䶿一-鿿豈-﫿]/;
const PUNCT_OR_SPACE_RE = /[\s\p{P}\p{S}]/u;

/** True when at least a quarter of the countable characters are Chinese. */
export function isChineseText(text: string): boolean {
  let han = 0;
  let other = 0;
  for (const ch of text) {
    if (PUNCT_OR_SPACE_RE.test(ch)) continue;
    if (CJK_CHAR_RE.test(ch)) han++;
    else other++;
  }
  return han > 0 && han * 3 >= other;
}

/** Answer length: characters without spaces/punctuation (Chinese) or words (other text). */
export function answerLength(text: string, unit: 'chars' | 'words'): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  if (unit === 'words') return t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  let n = 0;
  for (const ch of t) if (!PUNCT_OR_SPACE_RE.test(ch)) n++;
  return n;
}

// ─── Filler words ──────────────────────────────────────────────────────────
//
// A pause marker is punctuation, an ellipsis or a space (speech-to-text writes
// most pauses as a comma). Rules, in this order:
//   1. 嗯 / 呃 / 唔 — always a filler (a run like 嗯嗯 counts once);
//   2. 额 / 啊 / 哎 — only alone between pause markers (so 金额, 是啊 do not count);
//   3. 那个 / 就是 / 然后 — only right before a pause marker or repeated
//      (那个那个); 那个项目 and 然后我做了 are normal speech;
//   4. 就是说 / 怎么说呢 / 你知道吧 / 你懂吧 / 对吧 — always;
//   5. English: um, uh, erm, hmm; "you know" and "I mean" before a pause;
//      "like," before a comma; basically; literally.
// No lookbehind, so the client mirror runs on every supported browser.

const BREAK = '[，,。.！!？?、；;：:…\\s—-]';

interface FillerRule {
  word: string;
  re: RegExp;
}

export const FILLER_RULES: readonly FillerRule[] = [
  { word: '嗯', re: /嗯+/g },
  { word: '呃', re: /呃+/g },
  { word: '唔', re: /唔+/g },
  { word: '额', re: new RegExp(`(?:^|${BREAK})额(?=${BREAK}|$)`, 'g') },
  { word: '啊', re: new RegExp(`(?:^|${BREAK})啊(?=${BREAK}|$)`, 'g') },
  { word: '哎', re: new RegExp(`(?:^|${BREAK})哎(?=${BREAK}|$)`, 'g') },
  { word: '那个', re: new RegExp(`那个(?=${BREAK}|$|那个)`, 'g') },
  { word: '就是', re: new RegExp(`就是(?=${BREAK}|$|就是)`, 'g') },
  { word: '然后', re: new RegExp(`然后(?=${BREAK}|$|然后)`, 'g') },
  { word: '就是说', re: /就是说/g },
  { word: '怎么说呢', re: /怎么说呢/g },
  { word: '你知道吧', re: /你知道吧/g },
  { word: '你懂吧', re: /你懂吧/g },
  { word: '对吧', re: /对吧/g },
  { word: 'um', re: /\b(?:um+|uhm+)\b/gi },
  { word: 'uh', re: /\buh+\b/gi },
  { word: 'erm', re: /\berm+\b/gi },
  { word: 'hmm', re: /\bhmm+\b/gi },
  { word: 'you know', re: /\byou know(?=[,.!?;:…]|\s*$)/gi },
  { word: 'I mean', re: /\bi mean(?=[,.!?;:…]|\s*$)/gi },
  { word: 'like', re: /\blike(?=,)/gi },
  { word: 'basically', re: /\bbasically\b/gi },
  { word: 'literally', re: /\bliterally\b/gi },
];

function countMatches(text: string, re: RegExp): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const m = text.match(new RegExp(re.source, flags));
  return m ? m.length : 0;
}

/** Filler words in one answer, most frequent first. */
export function countFillers(text: string): FillerCount {
  const t = text ?? '';
  const hits: FillerHit[] = [];
  for (const rule of FILLER_RULES) {
    const count = countMatches(t, rule.re);
    if (count > 0) hits.push({ word: rule.word, count });
  }
  return { total: hits.reduce((s, h) => s + h.count, 0), top: sortHits(hits) };
}

/** Stable sort: count desc, then rule order. */
export function sortHits(hits: FillerHit[]): FillerHit[] {
  const order = new Map(FILLER_RULES.map((r, i) => [r.word, i]));
  return [...hits].sort((a, b) => b.count - a.count || (order.get(a.word) ?? 99) - (order.get(b.word) ?? 99));
}

/** Merge per-answer filler counts. */
export function mergeFillers(counts: FillerCount[]): FillerHit[] {
  const byWord = new Map<string, number>();
  for (const c of counts) for (const h of c.top) byWord.set(h.word, (byWord.get(h.word) ?? 0) + h.count);
  return sortHits([...byWord].map(([word, count]) => ({ word, count })));
}

// ─── STAR completeness ─────────────────────────────────────────────────────
//
// A part counts when the answer carries one of its cue phrases (zh or en).
// The cues are deliberately plain; the report lists them.

export const STAR_CUES: Readonly<Record<StarPart, readonly RegExp[]>> = {
  situation: [
    /当时|那时候?|那年|之前在|曾经在|有一次|背景是|情况是|实习期间|大[一二三四]的?时候/,
    /在.{0,15}?(期间|的时候|时候|项目|公司|实习|学校|学院|社团|团队|比赛|课程)/,
    /\b(when i was|at the time|back in|during (my|our|the)|the situation|at my (last|previous)|while (i was|working|studying)|last (year|summer|semester|term))\b/i,
  ],
  task: [
    /任务|目标|负责|职责|需要(我|我们)|要求(我|我们)|挑战是|难点|问题是|我的工作是|目的是/,
    /\b(my (task|goal|job|role|responsibility)|i was (responsible|asked|tasked)|we (needed|had) to|i (needed|had) to|the (goal|challenge|problem) was|our goal)\b/i,
  ],
  action: [
    /我(先|首先|就|决定|主动|组织|设计|提出|带领|联系|整理|分析|推动|协调|写了|做了|采取|找了|安排|制定|调整|学习|查了|和.{0,8}?沟通)/,
    /采取了|具体(做法|来说|地)|于是我|然后我|接着我|第一步|第二步/,
    /\bi (decided|built|led|wrote|designed|created|organi[sz]ed|reached out|analy[sz]ed|proposed|implemented|took|started|set up|talked|spoke|ran|made|asked|called|worked out|split|prioriti[sz]ed|scheduled|fixed|tested|researched)\b|\bmy approach\b|\bfirst,? i\b|\bthen i\b/i,
  ],
  result: [
    /结果|最终|最后|成功|提升了|提高了|降低了|减少了|增加了|达到|完成了|获得|拿到|收获|学到|效果|反馈|节省了|按时/,
    /[0-9０-９]+(\.[0-9]+)?\s*(%|％|个|人|万|倍|天|分|名|小时)|百分之/,
    /\b(as a result|in the end|resulted|ultimately|the outcome|increased|reduced|improved|achieved|saved|grew|won|delivered|launched|shipped|learned)\b|\d+(\.\d+)?\s?%/i,
  ],
};

export const STAR_PART_ORDER: readonly StarPart[] = ['situation', 'task', 'action', 'result'];

/** Which STAR parts an answer carries. */
export function checkStar(text: string): StarCheck {
  const t = text ?? '';
  const has = (part: StarPart) => STAR_CUES[part].some((re) => re.test(t));
  const situation = has('situation');
  const task = has('task');
  const action = has('action');
  const result = has('result');
  const flags: Record<StarPart, boolean> = { situation, task, action, result };
  const missing = STAR_PART_ORDER.filter((p) => !flags[p]);
  return { situation, task, action, result, parts: 4 - missing.length, missing };
}

/** True when the question asks for one real past story. */
export function isStoryQuestion(question: string | null | undefined): boolean {
  const q = (question ?? '').trim();
  if (!q) return false;
  return (
    /举.{0,4}?例子?|讲.{0,6}?(一次|一个|一段)|说说.{0,6}?(一次|一段)|描述.{0,6}?(一次|一段)|分享.{0,6}?(一次|一段)|有没有.{0,10}?(的时候|经历)|有一次你/.test(q) ||
    /tell me about a time|describe a (time|situation)|give (me )?an example|walk me through a (time|situation)|a time (when|you)|share an (example|experience)/i.test(q)
  );
}

/** A short follow-up to the previous question ("结果呢？", "What did you do exactly?"). */
export function isFollowUp(question: string | null | undefined): boolean {
  const q = (question ?? '').trim();
  if (!q) return false;
  const short = isChineseText(q) ? answerLength(q, 'chars') <= 30 : answerLength(q, 'words') <= 14;
  if (!short) return false;
  return (
    /^(那|那么|好的?[，,]?)?(结果|最后|后来|你(具体|个人|当时)|具体|能(具体|再)|为什么|然后呢)|结果呢|后来呢|你个人/.test(q) ||
    /^(and |so |okay,? )?(what (was|did|happened)|how did|can you (say|tell|give) (me )?more|what exactly|why did)/i.test(q)
  );
}

export function summarizeStar(checks: Array<StarCheck | null>): CnStarSummary {
  const story = checks.filter((c): c is StarCheck => c !== null);
  const missCount: Record<StarPart, number> = { situation: 0, task: 0, action: 0, result: 0 };
  for (const c of story) for (const p of c.missing) missCount[p]++;
  let missingMost: StarPart | null = null;
  for (const p of STAR_PART_ORDER) {
    if (missCount[p] > 0 && (missingMost === null || missCount[p] > missCount[missingMost])) missingMost = p;
  }
  return { storyAnswers: story.length, complete: story.filter((c) => c.parts === 4).length, missingMost };
}

// ─── Areas ────────────────────────────────────────────────────────────────

type CanonicalKey = 'structure' | 'specificity' | 'communication' | 'confidence' | 'roleFit';

/** Same mapping as interview-engine reportTypes.toCanonicalDimKey (scorer English keys → canonical). */
export function canonicalKey(raw: string): CanonicalKey | null {
  const k = (raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '');
  switch (k) {
    case 'structure':
      return 'structure';
    case 'specificity':
      return 'specificity';
    case 'communication':
      return 'communication';
    case 'confidence':
      return 'confidence';
    case 'rolefit':
      return 'roleFit';
    default:
      return null;
  }
}

function mean(values: Array<number | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  return Math.max(0, Math.min(100, Math.round(v.reduce((s, x) => s + x, 0) / v.length)));
}

/**
 * The three areas.
 *   communication = mean(communication, confidence)  — from the review
 *   logic         = mean(structure, specificity)     — from the review
 *   behaviour     = share of STAR parts present across story answers
 * With no answers at all every area is null ("—"), never 0.
 */
export function scoreAreas(input: {
  breakdown: readonly CnBreakdownRow[] | null | undefined;
  basis: Exclude<CnAreaBasis, 'star_check'>;
  star: Array<StarCheck | null>;
  answered: number;
}): CnAreaScore[] {
  const byKey = new Map<CanonicalKey, number>();
  for (const row of input.breakdown ?? []) {
    const key = canonicalKey(row?.key ?? '');
    if (key && typeof row.value === 'number' && Number.isFinite(row.value)) byKey.set(key, row.value);
  }
  const none = input.answered === 0;
  const stories = input.star.filter((c): c is StarCheck => c !== null);
  const behaviour = none || stories.length === 0
    ? null
    : Math.round((100 * stories.reduce((s, c) => s + c.parts, 0)) / (4 * stories.length));
  return [
    { key: 'communication', value: none ? null : mean([byKey.get('communication'), byKey.get('confidence')]), basis: input.basis },
    { key: 'logic', value: none ? null : mean([byKey.get('structure'), byKey.get('specificity')]), basis: input.basis },
    { key: 'behaviour', value: behaviour, basis: 'star_check' },
  ];
}

// ─── Report (report.ts) ──────────────────────────────────────────────────

/**
 * Normalise stored transcript rows from either practice path:
 *   interview engine  { role: 'interviewer' | 'candidate' | 'system', text, interim? }
 *   text practice     { who: 'them' | 'you', text }
 * System lines, interim segments and empty text are dropped.
 */
export function normalizeCnTurns(rows: unknown): CnTurn[] {
  if (!Array.isArray(rows)) return [];
  const out: CnTurn[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (r.interim === true) continue;
    const text = typeof r.text === 'string' ? r.text.trim() : '';
    if (!text) continue;
    const who = r.role ?? r.who ?? r.speaker;
    if (who === 'candidate' || who === 'you' || who === 'user') out.push({ role: 'candidate', text });
    else if (who === 'interviewer' || who === 'them' || who === 'ai' || who === 'assistant') out.push({ role: 'interviewer', text });
  }
  return out;
}

interface Answer {
  question: string | null;
  story: boolean;
  text: string;
}

/**
 * Group the transcript into answers: consecutive candidate turns are one
 * answer to the latest interviewer line; a short follow-up after a story
 * answer ("结果呢？") folds its answer into that story.
 */
export function groupAnswers(turns: readonly CnTurn[]): Answer[] {
  const answers: Answer[] = [];
  let question: string | null = null;
  let followUp = false;
  let lastRole: CnTurn['role'] | null = null;
  for (const turn of turns) {
    const prev = answers[answers.length - 1];
    if (turn.role === 'interviewer') {
      question = turn.text;
      followUp = !!prev && prev.story && isFollowUp(turn.text) && !isStoryQuestion(turn.text);
    } else if (prev && (lastRole === 'candidate' || followUp)) {
      prev.text = `${prev.text}\n${turn.text}`;
      followUp = false;
    } else {
      answers.push({ question, story: isStoryQuestion(question), text: turn.text });
    }
    lastRole = turn.role;
  }
  return answers;
}

export interface BuildCnReportInput {
  turns: readonly CnTurn[];
  /** The session's breakdown (rich canonical rows, or the scorer's English keys). */
  breakdown: readonly CnBreakdownRow[] | null | undefined;
  /** Where the breakdown came from. */
  basis: Exclude<CnAreaBasis, 'star_check'>;
  language: string;
  formatId?: string;
  /** ISO timestamp; injectable for tests. */
  now?: string;
}

export function buildCnPracticeReport(input: BuildCnReportInput): CnPracticeReport {
  const answers = groupAnswers(input.turns);
  const allText = answers.map((a) => a.text).join('\n');
  const unit: 'chars' | 'words' = isChineseText(allText) ? 'chars' : 'words';

  const checks: CnAnswerCheck[] = answers.map((a, index) => ({
    index,
    question: a.question,
    length: answerLength(a.text, unit),
    star: a.story ? checkStar(a.text) : null,
    fillers: countFillers(a.text),
  }));

  const totalLength = checks.reduce((s, c) => s + c.length, 0);
  const totalFillers = checks.reduce((s, c) => s + c.fillers.total, 0);
  const stars = checks.map((c) => c.star);

  return {
    version: 1,
    formatId: input.formatId ?? CN_AI_INTERVIEW_FORMAT_ID,
    language: input.language,
    generatedAt: input.now ?? new Date().toISOString(),
    areas: scoreAreas({ breakdown: input.breakdown, basis: input.basis, star: stars, answered: checks.length }),
    star: summarizeStar(stars),
    fillers: {
      total: totalFillers,
      per100: totalLength > 0 ? Math.round((totalFillers / totalLength) * 1000) / 10 : null,
      unit,
      top: mergeFillers(checks.map((c) => c.fillers)),
    },
    answers: checks,
  };
}
