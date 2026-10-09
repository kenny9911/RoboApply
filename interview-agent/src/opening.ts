// Opening plan: a SHORT non-interruptible greeting, then the first question as
// a normal INTERRUPTIBLE turn.
//
// Why: the legacy control plane composes one `openingLine` = greeting + intro +
// the whole first blueprint question (up to ~535 chars in zh, 90+ s of speech)
// and the worker spoke it with allowInterruptions:false — a monologue the
// candidate could not cut, and many quit before it ended.
//
// Metadata shapes accepted (backward compatible in both directions):
//  - NEW:    openingGreeting (+ openingQuestion) — used verbatim.
//  - LEGACY: openingLine only — split here at the localized "let's begin"
//            marker the control-plane templates always emit, else at a
//            sentence boundary under the greeting budget.
//
// Pure module; unit-tested against the compiled output.

/** Spoken-greeting budget. ~150 chars for alphabetic scripts; CJK packs far
 *  more speech per character, so it gets a tighter character budget. */
export const GREETING_MAX_CHARS = 150;
export const GREETING_MAX_CHARS_CJK = 80;

export interface OpeningMeta {
  language?: string;
  openingLine?: string;
  openingGreeting?: string;
  openingQuestion?: string;
}

export interface OpeningPlan {
  /** Non-interruptible, short. Empty ⇒ greet via the LLM opening instruction. */
  greeting: string;
  /** Interruptible first question; null when the greeting already covers it. */
  question: string | null;
  source: 'split-fields' | 'legacy-marker' | 'legacy-sentences' | 'legacy-short' | 'none';
}

/** "Let's begin" sentences the control-plane OPENING_LINES templates emit right
 *  before the first question (voiceSystemPrompt.ts). */
const BEGIN_MARKERS = [
  "Let's dive in.",
  '我们开始吧。',
  '我們開始吧。',
  'それでは始めましょう。',
  '그럼 시작하겠습니다.',
  'Empecemos.',
  'Commençons.',
  'Vamos começar.',
  'Fangen wir an.',
];

export function isCjkLanguage(language: string | undefined): boolean {
  const l = (language ?? '').toLowerCase();
  return l.startsWith('zh') || l.startsWith('cmn') || l.startsWith('ja') || l.startsWith('ko');
}

/** Character count by code point (a CJK character counts as one). */
export function charLength(text: string): number {
  return Array.from(text).length;
}

export function greetingBudget(language: string | undefined): number {
  return isCjkLanguage(language) ? GREETING_MAX_CHARS_CJK : GREETING_MAX_CHARS;
}

/** Split into sentences, keeping terminators. Handles Latin (. ! ? followed by
 *  whitespace) and CJK full-width terminators (。！？ — no space follows). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const chars = Array.from(text);
  let buf = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    buf += ch;
    const next = chars[i + 1];
    const fullWidth = ch === '。' || ch === '！' || ch === '？';
    const halfWidth = (ch === '.' || ch === '!' || ch === '?') && (next === undefined || /\s/.test(next));
    if (fullWidth || halfWidth) {
      // Absorb a closing quote/bracket that belongs to the sentence.
      while (chars[i + 1] && /["'”’」』）)]/u.test(chars[i + 1]!)) {
        i += 1;
        buf += chars[i];
      }
      if (buf.trim()) out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function joinSentences(sentences: string[], cjk: boolean): string {
  return sentences.join(cjk ? '' : ' ').trim();
}

/** Keep the first sentence (always) plus following sentences while the result
 *  plus `tail` fits the budget. */
function fitGreeting(sentences: string[], tail: string, budget: number, cjk: boolean): string {
  if (sentences.length === 0) return tail.trim();
  const kept: string[] = [sentences[0]!];
  for (let i = 1; i < sentences.length; i += 1) {
    const candidate = joinSentences([...kept, sentences[i]!, ...(tail ? [tail] : [])], cjk);
    if (charLength(candidate) > budget) continue; // drop a long middle sentence, keep trying shorter ones
    kept.push(sentences[i]!);
  }
  return joinSentences([...kept, ...(tail ? [tail] : [])], cjk);
}

export function planOpening(meta: OpeningMeta): OpeningPlan {
  const language = meta.language;
  const cjk = isCjkLanguage(language);
  const budget = greetingBudget(language);

  const greetingField = (meta.openingGreeting ?? '').trim();
  if (greetingField) {
    const q = (meta.openingQuestion ?? '').trim();
    return { greeting: greetingField, question: q || null, source: 'split-fields' };
  }

  const line = (meta.openingLine ?? '').trim();
  if (!line) {
    const q = (meta.openingQuestion ?? '').trim();
    return { greeting: '', question: q || null, source: 'none' };
  }

  // Legacy combined line: split at the template's "let's begin" marker.
  for (const marker of BEGIN_MARKERS) {
    const at = line.indexOf(marker);
    if (at === -1) continue;
    const head = line.slice(0, at).trim();
    const question = line.slice(at + marker.length).trim();
    const greeting = fitGreeting(splitSentences(head), marker, budget, cjk);
    return { greeting, question: question || null, source: 'legacy-marker' };
  }

  if (charLength(line) <= budget) {
    return { greeting: line, question: null, source: 'legacy-short' };
  }

  // Unknown long line: greeting = leading sentences under budget; the rest is
  // spoken as the interruptible first question.
  const sentences = splitSentences(line);
  if (sentences.length <= 1) {
    // One giant sentence: nothing safe to split — speak it interruptibly.
    return { greeting: '', question: line, source: 'legacy-sentences' };
  }
  const kept: string[] = [];
  for (const s of sentences) {
    const candidate = joinSentences([...kept, s], cjk);
    if (kept.length > 0 && charLength(candidate) > budget) break;
    kept.push(s);
  }
  // Never let the greeting swallow every sentence of a long line.
  if (kept.length === sentences.length) kept.pop();
  const greeting = joinSentences(kept, cjk);
  const question = joinSentences(sentences.slice(kept.length), cjk);
  if (!greeting || charLength(greeting) > budget) {
    return { greeting: '', question: line, source: 'legacy-sentences' };
  }
  return { greeting, question: question || null, source: 'legacy-sentences' };
}
