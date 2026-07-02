// backend/src/interview-engine/scoring/interviewScorer.ts
//
// Deterministic, free, never-throws scorer over the candidate's transcript
// turns. Produces a 0..100 overall, a 5-dimension breakdown, strengths, gaps,
// and a one-line summary. Mirrors the proven heuristic in RAMockService but
// operates on the engine's TranscriptTurn shape (role: 'candidate').
//
// CJK-aware: word counts use Intl.Segmenter for Han/Kana/Hangul text (a full
// Chinese answer is NOT one "word"), and structure/number signals include CJK
// connectives and numerals. All prose (notes/strengths/gaps/summary) is
// localized; breakdown `key`s stay English — they are stable identifiers that
// reportTypes.toCanonicalDimKey maps to the canonical dimension keys.
//
// (A richer LLM-based evaluation can be layered later; this guarantees every
// session gets a usable report even with no LLM.)

import type { TranscriptTurn } from '../types.js';

export interface ScoreBreakdownItem {
  key: string;
  value: number;
  note: string;
}

export interface InterviewScore {
  overall: number;
  breakdown: ScoreBreakdownItem[];
  strengths: string[];
  gaps: string[];
  summary: string;
}

// ── Locale ───────────────────────────────────────────────────────────────────

export type ScorerLocale = 'en' | 'zh' | 'zh-TW' | 'ja' | 'ko' | 'es' | 'fr' | 'pt' | 'de';

/**
 * Keep in sync with voice/voiceCatalog.ts normalizeLocale (the canonical
 * normalizer). Duplicated locally so scoring/ stays dependency-free of the
 * voice layer — same prefix rules, same fallback to 'en'.
 */
export function normalizeScorerLocale(input?: string | null): ScorerLocale {
  const raw = (input || '').trim().toLowerCase().replace('_', '-');
  if (!raw) return 'en';
  if (raw === 'zh-tw' || raw === 'zh-hant' || raw === 'zh-hk' || raw.startsWith('zh-tw') || raw.includes('hant')) return 'zh-TW';
  if (raw.startsWith('zh')) return 'zh';
  if (raw.startsWith('ja')) return 'ja';
  if (raw.startsWith('ko')) return 'ko';
  if (raw.startsWith('es')) return 'es';
  if (raw.startsWith('fr')) return 'fr';
  if (raw.startsWith('pt')) return 'pt';
  if (raw.startsWith('de')) return 'de';
  return 'en';
}

// ── CJK-aware word-equivalent counting ───────────────────────────────────────

// Han (incl. ext A + compatibility) / Hiragana / Katakana / Hangul syllables.
const CJK_CHAR_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/;

/**
 * "CJK-dominant" gates which counting strategy runs. The threshold is lenient
 * (≥25% CJK of countable chars) because Intl.Segmenter also counts Latin words
 * correctly, so mixed text (e.g. Chinese prose naming English tools) is safer
 * routed through segmentation than through a whitespace split that would
 * collapse each CJK run to one "word".
 */
function isCjkDominant(text: string): boolean {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    if (CJK_CHAR_RE.test(ch)) cjk++;
    else other++;
  }
  return cjk > 0 && cjk * 3 >= other;
}

// One Segmenter per locale — construction is not free and the scorer runs per
// turn. `null` is cached too so an environment without Intl.Segmenter doesn't
// retry the constructor on every call.
const segmenterCache = new Map<string, Intl.Segmenter | null>();
function getWordSegmenter(locale: ScorerLocale): Intl.Segmenter | null {
  const cached = segmenterCache.get(locale);
  if (cached !== undefined) return cached;
  let seg: Intl.Segmenter | null = null;
  try {
    if (typeof Intl !== 'undefined' && typeof (Intl as { Segmenter?: unknown }).Segmenter === 'function') {
      seg = new Intl.Segmenter(locale, { granularity: 'word' });
    }
  } catch {
    seg = null;
  }
  segmenterCache.set(locale, seg);
  return seg;
}

/**
 * Count word-equivalents in a way that treats languages fairly: whitespace
 * split for Latin text, dictionary word segmentation for CJK-dominant text
 * (falling back to chars/2 — the mean CJK word is ~2 chars — when
 * Intl.Segmenter is unavailable).
 */
export function countWordEquivalents(text: string, locale?: string): number {
  const t = (text ?? '').trim();
  if (!t) return 0;
  if (!isCjkDominant(t)) return t.split(/\s+/).length;
  const seg = getWordSegmenter(normalizeScorerLocale(locale));
  if (seg) {
    let n = 0;
    for (const part of seg.segment(t)) {
      if (part.isWordLike) n++;
    }
    if (n > 0) return n;
  }
  return Math.max(1, Math.round(t.replace(/\s+/g, '').length / 2));
}

// ── Signal regexes ───────────────────────────────────────────────────────────

const NUMBER_RE = /\b\d[\d.,%]*\b|\b(?:percent|x|%|\$)\b/i;
// CJK numerals have no word boundaries and bare 一/十 appear in everyday words
// (一起, 十分), so a CJK numeral only counts when paired with a percent form or
// a unit/measure word. Full-width digits / ％ / explicit percent words count
// on their own.
const NUMBER_CJK_RE = /[０-９]|％|百分之|パーセント|퍼센트|[一二三四五六七八九十百千万萬億亿两兩零〇]+\s*(?:%|％|倍|割|年|个|個|月|日|天|周|週|人|名|件|次|回|位|万|萬|億|亿|千|百|배|명|년|개|월|번|회|건)/;

const STRUCTURE_RE = /\b(because|so that|which|then|after|resulted|led to|so we|as a result|increased|reduced|shipped|launched|improved|decreased)\b/i;
// CJK causal/sequence connectives — \b is meaningless in CJK, so plain
// alternation. Simplified + Traditional Chinese, Japanese, Korean.
const STRUCTURE_CJK_RE = /因为|因為|所以|然后|然後|结果|結果|导致|導致|提升|降低|因此|于是|於是|首先|最后|最後|ので|だから|その結果|したがって|そのため|により|그래서|때문에|결과|따라서|덕분에|먼저|마지막으로/;

// ── Localized prose ──────────────────────────────────────────────────────────

type DimKey = 'Structure' | 'Specificity' | 'Communication' | 'Confidence' | 'Role fit';

interface ScorerStrings {
  /** Localized dimension labels — used ONLY in strengths/gaps prose; breakdown keys stay English. */
  dims: Record<DimKey, string>;
  noAnswers: { note: string; strength: string; gap: string; summary: string };
  structure: { high: string; mid: string; low: string };
  specificity: { high: string; some: string; none: string };
  communication: { short: string; high: string; mid: string };
  confidence: { high: string; mid: string; low: string };
  roleFit: { thin: (n: number) => string; high: string; mid: string };
  strengthFallback: string;
  gapFallback: string;
  summary: { top: string; strong: string; good: string; base: string };
}

const STRINGS: Record<ScorerLocale, ScorerStrings> = {
  en: {
    dims: { Structure: 'Structure', Specificity: 'Specificity', Communication: 'Communication', Confidence: 'Confidence', 'Role fit': 'Role fit' },
    noAnswers: {
      note: 'No answers recorded.',
      strength: 'Session started — complete a few answers to get a graded report.',
      gap: 'No answers were recorded. Run the interview through to the end for a real score.',
      summary: 'No answers recorded.',
    },
    structure: {
      high: 'Clear situation → action → result on most answers.',
      mid: 'Mostly structured; a few jumped to the result.',
      low: 'Answers tended to ramble — set up situation, action, result.',
    },
    specificity: {
      high: 'Strong use of concrete numbers.',
      some: 'Some metrics; aim for one number per story.',
      none: 'No measurable outcomes surfaced — add before → after numbers.',
    },
    communication: {
      short: 'Answers were very short — give enough to evaluate.',
      high: 'Good depth and pacing.',
      mid: 'Reasonable depth; lead with the headline.',
    },
    confidence: {
      high: 'Decisive and owned.',
      mid: 'Mostly assured; a few hedged.',
      low: 'Tended to hedge — commit and use ownership verbs.',
    },
    roleFit: {
      thin: (n) => `${n} answer(s) were thin — fuller engagement strengthens fit.`,
      high: 'Engaged with every prompt.',
      mid: 'Answered most prompts; fuller engagement helps.',
    },
    strengthFallback: 'You engaged with the prompts — a clear base to build on.',
    gapFallback: 'Keep tightening: one crisp metric per answer and a clear position on every question.',
    summary: {
      top: 'Authentic and specific — a strong session.',
      strong: 'Strong on metrics; watch hedging on the harder questions.',
      good: 'Good framing; get to the point faster and quantify more.',
      base: 'A solid rep — add structure and concrete numbers next time.',
    },
  },
  zh: {
    dims: { Structure: '结构', Specificity: '具体性', Communication: '表达', Confidence: '自信', 'Role fit': '岗位匹配' },
    noAnswers: {
      note: '未记录到回答。',
      strength: '面试已开始——完成几个回答后即可获得评分报告。',
      gap: '没有记录到任何回答。请完整进行一次面试以获得真实评分。',
      summary: '未记录到回答。',
    },
    structure: {
      high: '大多数回答都有清晰的“情境 → 行动 → 结果”结构。',
      mid: '整体有结构，但有几个回答直接跳到了结果。',
      low: '回答偏散——先讲情境，再讲行动，最后给结果。',
    },
    specificity: {
      high: '善于用具体数字支撑论点。',
      some: '有一些量化指标；争取每个故事都带一个数字。',
      none: '没有出现可衡量的成果——补充“之前 → 之后”的对比数字。',
    },
    communication: {
      short: '回答过于简短——信息量要足够支撑评估。',
      high: '深度和节奏都不错。',
      mid: '深度尚可；先说结论，再展开。',
    },
    confidence: {
      high: '表达果断，有主人翁意识。',
      mid: '大体自信，个别回答有些含糊。',
      low: '语气偏犹豫——明确立场，多用第一人称的担当动词。',
    },
    roleFit: {
      thin: (n) => `有 ${n} 个回答过于单薄——更投入的回答能体现匹配度。`,
      high: '每个问题都有认真回应。',
      mid: '回应了大部分问题；更充分的投入会更好。',
    },
    strengthFallback: '你对每个问题都有回应——这是一个可以继续构建的基础。',
    gapFallback: '继续打磨：每个回答带一个清晰的数字，每个问题给出明确立场。',
    summary: {
      top: '真实而具体——一场高质量的练习。',
      strong: '数字运用出色；注意在较难的问题上不要含糊。',
      good: '框架不错；更快切入重点，多一些量化。',
      base: '一次扎实的练习——下次加强结构并补充具体数字。',
    },
  },
  'zh-TW': {
    dims: { Structure: '結構', Specificity: '具體性', Communication: '表達', Confidence: '自信', 'Role fit': '職位匹配' },
    noAnswers: {
      note: '未記錄到回答。',
      strength: '面試已開始——完成幾個回答後即可獲得評分報告。',
      gap: '沒有記錄到任何回答。請完整進行一次面試以獲得真實評分。',
      summary: '未記錄到回答。',
    },
    structure: {
      high: '大多數回答都有清晰的「情境 → 行動 → 結果」結構。',
      mid: '整體有結構，但有幾個回答直接跳到了結果。',
      low: '回答偏鬆散——先講情境，再講行動，最後給結果。',
    },
    specificity: {
      high: '善於用具體數字支撐論點。',
      some: '有一些量化指標；爭取每個故事都帶一個數字。',
      none: '沒有出現可衡量的成果——補充「之前 → 之後」的對比數字。',
    },
    communication: {
      short: '回答過於簡短——資訊量要足夠支撐評估。',
      high: '深度和節奏都不錯。',
      mid: '深度尚可；先說結論，再展開。',
    },
    confidence: {
      high: '表達果斷，有當責意識。',
      mid: '大致自信，個別回答有些含糊。',
      low: '語氣偏猶豫——明確立場，多用第一人稱的當責動詞。',
    },
    roleFit: {
      thin: (n) => `有 ${n} 個回答過於單薄——更投入的回答能展現匹配度。`,
      high: '每個問題都有認真回應。',
      mid: '回應了大部分問題；更充分的投入會更好。',
    },
    strengthFallback: '你對每個問題都有回應——這是一個可以繼續累積的基礎。',
    gapFallback: '繼續打磨：每個回答帶一個清晰的數字，每個問題給出明確立場。',
    summary: {
      top: '真實而具體——一場高品質的練習。',
      strong: '數字運用出色；注意在較難的問題上不要含糊。',
      good: '框架不錯；更快切入重點，多一些量化。',
      base: '一次紮實的練習——下次加強結構並補充具體數字。',
    },
  },
  ja: {
    dims: { Structure: '構成', Specificity: '具体性', Communication: 'コミュニケーション', Confidence: '自信', 'Role fit': '職務適合性' },
    noAnswers: {
      note: '回答が記録されていません。',
      strength: 'セッションは開始されました。いくつか回答を完了すると採点レポートが得られます。',
      gap: '回答が記録されませんでした。最後まで面接を行うと実際のスコアが得られます。',
      summary: '回答が記録されていません。',
    },
    structure: {
      high: 'ほとんどの回答で「状況 → 行動 → 結果」が明確でした。',
      mid: '概ね構造的でしたが、いくつかは結果に飛んでいました。',
      low: '回答が散漫になりがちでした。状況・行動・結果の順で組み立てましょう。',
    },
    specificity: {
      high: '具体的な数字を効果的に使えていました。',
      some: '一部に指標がありました。各エピソードに数字を1つ入れることを目指しましょう。',
      none: '測定可能な成果が出てきませんでした。「前 → 後」の数字を加えましょう。',
    },
    communication: {
      short: '回答が非常に短いです。評価に足る情報量を出しましょう。',
      high: '深さとテンポが良好です。',
      mid: '深さは十分です。まず結論から話しましょう。',
    },
    confidence: {
      high: '決断力があり、当事者意識が伝わりました。',
      mid: '概ね自信がありましたが、一部曖昧な表現がありました。',
      low: '断定を避ける傾向がありました。立場を明確にし、主体的な動詞を使いましょう。',
    },
    roleFit: {
      thin: (n) => `${n} 件の回答が薄めでした。より踏み込んだ回答が適合性を高めます。`,
      high: 'すべての質問にしっかり向き合えていました。',
      mid: 'ほとんどの質問に回答できました。より踏み込むとさらに良くなります。',
    },
    strengthFallback: '質問にきちんと向き合えていました。ここから積み上げていけます。',
    gapFallback: '引き続き磨きましょう。各回答に明確な数字を1つ、各質問に明確な立場を。',
    summary: {
      top: '誠実で具体的。非常に良いセッションでした。',
      strong: '数字の使い方が優れています。難しい質問での曖昧さに注意しましょう。',
      good: '枠組みは良好です。より早く要点に入り、定量化を増やしましょう。',
      base: '堅実な練習でした。次回は構成と具体的な数字を強化しましょう。',
    },
  },
  ko: {
    dims: { Structure: '구조', Specificity: '구체성', Communication: '의사소통', Confidence: '자신감', 'Role fit': '직무 적합성' },
    noAnswers: {
      note: '기록된 답변이 없습니다.',
      strength: '세션이 시작되었습니다. 몇 개의 답변을 완료하면 채점 리포트를 받을 수 있습니다.',
      gap: '기록된 답변이 없습니다. 면접을 끝까지 진행해야 실제 점수를 받을 수 있습니다.',
      summary: '기록된 답변이 없습니다.',
    },
    structure: {
      high: '대부분의 답변에서 상황 → 행동 → 결과가 명확했습니다.',
      mid: '대체로 구조적이었으나 일부는 결과로 바로 건너뛰었습니다.',
      low: '답변이 산만한 편이었습니다. 상황, 행동, 결과 순으로 구성하세요.',
    },
    specificity: {
      high: '구체적인 수치를 효과적으로 활용했습니다.',
      some: '일부 지표가 있었습니다. 이야기마다 숫자 하나를 목표로 하세요.',
      none: '측정 가능한 성과가 드러나지 않았습니다. 전 → 후 수치를 추가하세요.',
    },
    communication: {
      short: '답변이 매우 짧았습니다. 평가할 수 있을 만큼 충분히 말하세요.',
      high: '깊이와 속도가 좋았습니다.',
      mid: '깊이는 적절했습니다. 핵심부터 말하세요.',
    },
    confidence: {
      high: '결단력 있고 주도적이었습니다.',
      mid: '대체로 자신감이 있었으나 일부 답변이 모호했습니다.',
      low: '얼버무리는 경향이 있었습니다. 입장을 명확히 하고 주도적인 동사를 사용하세요.',
    },
    roleFit: {
      thin: (n) => `${n}개의 답변이 빈약했습니다. 더 충실한 답변이 적합도를 높입니다.`,
      high: '모든 질문에 성실히 답했습니다.',
      mid: '대부분의 질문에 답했습니다. 더 충실히 참여하면 좋습니다.',
    },
    strengthFallback: '질문에 성실히 임했습니다. 여기서부터 쌓아갈 수 있는 기반입니다.',
    gapFallback: '계속 다듬으세요. 답변마다 명확한 수치 하나, 질문마다 분명한 입장을 제시하세요.',
    summary: {
      top: '진정성 있고 구체적이었습니다. 훌륭한 세션입니다.',
      strong: '수치 활용이 뛰어납니다. 어려운 질문에서 얼버무리지 않도록 주의하세요.',
      good: '틀은 좋습니다. 더 빨리 핵심에 들어가고 더 많이 수치화하세요.',
      base: '탄탄한 연습이었습니다. 다음에는 구조와 구체적인 수치를 보강하세요.',
    },
  },
  es: {
    dims: { Structure: 'Estructura', Specificity: 'Especificidad', Communication: 'Comunicación', Confidence: 'Confianza', 'Role fit': 'Encaje con el puesto' },
    noAnswers: {
      note: 'No se registraron respuestas.',
      strength: 'La sesión comenzó: completa algunas respuestas para obtener un informe calificado.',
      gap: 'No se registró ninguna respuesta. Realiza la entrevista completa para obtener una puntuación real.',
      summary: 'No se registraron respuestas.',
    },
    structure: {
      high: 'Situación → acción → resultado claros en la mayoría de las respuestas.',
      mid: 'En general estructuradas; algunas saltaron directamente al resultado.',
      low: 'Las respuestas tendían a divagar: plantea situación, acción y resultado.',
    },
    specificity: {
      high: 'Buen uso de cifras concretas.',
      some: 'Algunas métricas; intenta incluir un número en cada historia.',
      none: 'No surgieron resultados medibles: añade cifras de antes → después.',
    },
    communication: {
      short: 'Respuestas muy cortas: da suficiente material para evaluar.',
      high: 'Buena profundidad y buen ritmo.',
      mid: 'Profundidad razonable; empieza por lo esencial.',
    },
    confidence: {
      high: 'Con decisión y sentido de responsabilidad.',
      mid: 'En general con seguridad; algunas respuestas con rodeos.',
      low: 'Tendencia a los rodeos: comprométete y usa verbos de responsabilidad.',
    },
    roleFit: {
      thin: (n) => `${n} respuesta(s) quedaron escasas: una participación más completa refuerza el encaje.`,
      high: 'Respondió a todas las preguntas.',
      mid: 'Respondió a la mayoría de las preguntas; una participación más completa ayuda.',
    },
    strengthFallback: 'Participaste en las preguntas: una base clara sobre la que construir.',
    gapFallback: 'Sigue puliendo: una métrica clara por respuesta y una posición definida en cada pregunta.',
    summary: {
      top: 'Auténtico y específico: una sesión sólida.',
      strong: 'Fuerte en métricas; cuidado con los rodeos en las preguntas difíciles.',
      good: 'Buen planteamiento; ve antes al grano y cuantifica más.',
      base: 'Una buena práctica: añade estructura y cifras concretas la próxima vez.',
    },
  },
  fr: {
    dims: { Structure: 'Structure', Specificity: 'Précision', Communication: 'Communication', Confidence: 'Assurance', 'Role fit': 'Adéquation au poste' },
    noAnswers: {
      note: 'Aucune réponse enregistrée.',
      strength: 'La session a démarré — complétez quelques réponses pour obtenir un rapport noté.',
      gap: 'Aucune réponse n’a été enregistrée. Menez l’entretien jusqu’au bout pour obtenir un vrai score.',
      summary: 'Aucune réponse enregistrée.',
    },
    structure: {
      high: 'Situation → action → résultat clairs sur la plupart des réponses.',
      mid: 'Globalement structuré ; quelques réponses sont passées directement au résultat.',
      low: 'Les réponses avaient tendance à se disperser — posez la situation, l’action, le résultat.',
    },
    specificity: {
      high: 'Bon usage de chiffres concrets.',
      some: 'Quelques métriques ; visez un chiffre par exemple raconté.',
      none: 'Aucun résultat mesurable n’est ressorti — ajoutez des chiffres avant → après.',
    },
    communication: {
      short: 'Réponses très courtes — donnez assez de matière pour être évalué.',
      high: 'Bonne profondeur et bon rythme.',
      mid: 'Profondeur correcte ; commencez par l’essentiel.',
    },
    confidence: {
      high: 'Décidé et responsable.',
      mid: 'Globalement assuré ; quelques réponses hésitantes.',
      low: 'Tendance à l’hésitation — engagez-vous et utilisez des verbes d’appropriation.',
    },
    roleFit: {
      thin: (n) => `${n} réponse(s) trop minces — un engagement plus complet renforce l’adéquation.`,
      high: 'A répondu à toutes les questions.',
      mid: 'A répondu à la plupart des questions ; un engagement plus complet aiderait.',
    },
    strengthFallback: 'Vous avez répondu aux questions — une base claire sur laquelle construire.',
    gapFallback: 'Continuez à affiner : une métrique nette par réponse et une position claire sur chaque question.',
    summary: {
      top: 'Authentique et précis — une très bonne session.',
      strong: 'Solide sur les métriques ; attention aux hésitations sur les questions difficiles.',
      good: 'Bon cadrage ; allez plus vite à l’essentiel et quantifiez davantage.',
      base: 'Un bon entraînement — ajoutez de la structure et des chiffres concrets la prochaine fois.',
    },
  },
  pt: {
    dims: { Structure: 'Estrutura', Specificity: 'Especificidade', Communication: 'Comunicação', Confidence: 'Confiança', 'Role fit': 'Adequação à vaga' },
    noAnswers: {
      note: 'Nenhuma resposta registrada.',
      strength: 'A sessão começou — complete algumas respostas para receber um relatório avaliado.',
      gap: 'Nenhuma resposta foi registrada. Conduza a entrevista até o fim para obter uma pontuação real.',
      summary: 'Nenhuma resposta registrada.',
    },
    structure: {
      high: 'Situação → ação → resultado claros na maioria das respostas.',
      mid: 'Em geral estruturadas; algumas pularam direto para o resultado.',
      low: 'As respostas tendiam a divagar — apresente situação, ação e resultado.',
    },
    specificity: {
      high: 'Bom uso de números concretos.',
      some: 'Algumas métricas; busque um número por história.',
      none: 'Nenhum resultado mensurável apareceu — inclua números de antes → depois.',
    },
    communication: {
      short: 'Respostas muito curtas — dê material suficiente para avaliação.',
      high: 'Boa profundidade e bom ritmo.',
      mid: 'Profundidade razoável; comece pelo essencial.',
    },
    confidence: {
      high: 'Com decisão e senso de dono.',
      mid: 'Em geral seguro; algumas respostas hesitantes.',
      low: 'Tendência a hesitar — assuma posição e use verbos de protagonismo.',
    },
    roleFit: {
      thin: (n) => `${n} resposta(s) ficaram rasas — um engajamento mais completo fortalece o encaixe.`,
      high: 'Respondeu a todas as perguntas.',
      mid: 'Respondeu à maioria das perguntas; um engajamento mais completo ajuda.',
    },
    strengthFallback: 'Você se engajou com as perguntas — uma base clara para construir.',
    gapFallback: 'Continue lapidando: uma métrica clara por resposta e uma posição definida em cada pergunta.',
    summary: {
      top: 'Autêntico e específico — uma sessão forte.',
      strong: 'Forte em métricas; cuidado com hesitações nas perguntas mais difíceis.',
      good: 'Bom enquadramento; vá mais rápido ao ponto e quantifique mais.',
      base: 'Um bom treino — acrescente estrutura e números concretos na próxima vez.',
    },
  },
  de: {
    dims: { Structure: 'Struktur', Specificity: 'Konkretheit', Communication: 'Kommunikation', Confidence: 'Selbstsicherheit', 'Role fit': 'Passung zur Rolle' },
    noAnswers: {
      note: 'Keine Antworten aufgezeichnet.',
      strength: 'Die Session hat begonnen — beantworten Sie einige Fragen, um einen bewerteten Bericht zu erhalten.',
      gap: 'Es wurden keine Antworten aufgezeichnet. Führen Sie das Interview bis zum Ende, um eine echte Bewertung zu erhalten.',
      summary: 'Keine Antworten aufgezeichnet.',
    },
    structure: {
      high: 'Klares Situation → Handlung → Ergebnis in den meisten Antworten.',
      mid: 'Überwiegend strukturiert; einige sprangen direkt zum Ergebnis.',
      low: 'Die Antworten schweiften ab — bauen Sie Situation, Handlung, Ergebnis auf.',
    },
    specificity: {
      high: 'Starker Einsatz konkreter Zahlen.',
      some: 'Einige Kennzahlen; streben Sie eine Zahl pro Beispiel an.',
      none: 'Keine messbaren Ergebnisse erkennbar — ergänzen Sie Vorher-Nachher-Zahlen.',
    },
    communication: {
      short: 'Sehr kurze Antworten — liefern Sie genug Substanz für eine Bewertung.',
      high: 'Gute Tiefe und gutes Tempo.',
      mid: 'Angemessene Tiefe; beginnen Sie mit der Kernaussage.',
    },
    confidence: {
      high: 'Entschlossen und mit Verantwortungsbewusstsein.',
      mid: 'Überwiegend sicher; einige Antworten wirkten zögerlich.',
      low: 'Neigung zum Zögern — beziehen Sie Position und verwenden Sie aktive Verben.',
    },
    roleFit: {
      thin: (n) => `${n} Antwort(en) blieben dünn — mehr Substanz stärkt die Passung.`,
      high: 'Auf jede Frage eingegangen.',
      mid: 'Die meisten Fragen beantwortet; mehr Substanz hilft.',
    },
    strengthFallback: 'Sie haben sich auf die Fragen eingelassen — eine klare Basis zum Aufbauen.',
    gapFallback: 'Weiter verfeinern: eine prägnante Kennzahl pro Antwort und eine klare Position zu jeder Frage.',
    summary: {
      top: 'Authentisch und konkret — eine starke Session.',
      strong: 'Stark bei Kennzahlen; Vorsicht vor Zögern bei den schwierigeren Fragen.',
      good: 'Gute Rahmung; kommen Sie schneller auf den Punkt und quantifizieren Sie mehr.',
      base: 'Eine solide Übung — beim nächsten Mal Struktur und konkrete Zahlen ergänzen.',
    },
  },
};

// ── Signals ──────────────────────────────────────────────────────────────────

interface Signals {
  answerCount: number;
  totalWords: number;
  numericAnswers: number;
  structuredAnswers: number;
  emptyAnswers: number;
  avgWords: number;
}

function gatherSignals(turns: TranscriptTurn[], locale?: string): Signals {
  const answers = turns.filter((t) => t.role === 'candidate' && !t.interim);
  let totalWords = 0;
  let numericAnswers = 0;
  let structuredAnswers = 0;
  let emptyAnswers = 0;
  for (const t of answers) {
    const text = (t.text ?? '').trim();
    const words = countWordEquivalents(text, locale);
    totalWords += words;
    if (words < 3) emptyAnswers++;
    if (NUMBER_RE.test(text) || NUMBER_CJK_RE.test(text)) numericAnswers++;
    if (STRUCTURE_RE.test(text) || STRUCTURE_CJK_RE.test(text) || text.split(/[.;。！？!?]/).filter((s) => s.trim()).length >= 3) structuredAnswers++;
  }
  const answerCount = answers.length;
  return { answerCount, totalWords, numericAnswers, structuredAnswers, emptyAnswers, avgWords: answerCount ? totalWords / answerCount : 0 };
}

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}
function lengthScore(avgWords: number): number {
  if (avgWords <= 0) return 25;
  return clampScore(28 + 62 * (1 - Math.exp(-avgWords / 45)));
}
function ratioScore(part: number, whole: number, floor: number, ceil: number): number {
  if (whole <= 0) return floor;
  return clampScore(floor + (ceil - floor) * (part / whole));
}

export function scoreTranscript(turns: TranscriptTurn[], difficulty = 3, locale?: string): InterviewScore {
  const L = STRINGS[normalizeScorerLocale(locale)];
  const s = gatherSignals(turns, locale);
  if (s.answerCount === 0) {
    return {
      overall: 0,
      breakdown: [
        { key: 'Structure', value: 0, note: L.noAnswers.note },
        { key: 'Specificity', value: 0, note: L.noAnswers.note },
        { key: 'Communication', value: 0, note: L.noAnswers.note },
        { key: 'Confidence', value: 0, note: L.noAnswers.note },
        { key: 'Role fit', value: 0, note: L.noAnswers.note },
      ],
      strengths: [L.noAnswers.strength],
      gaps: [L.noAnswers.gap],
      summary: L.noAnswers.summary,
    };
  }

  // difficulty 1..5 → tighter grading.
  const penalty = Math.max(0, difficulty - 3) * 3;
  const structure = clampScore(ratioScore(s.structuredAnswers, s.answerCount, 55, 92) - penalty);
  const specificity = clampScore(ratioScore(s.numericAnswers, s.answerCount, 48, 95) - penalty);
  const communication = clampScore(lengthScore(s.avgWords) - penalty / 2);
  const completeness = clampScore(ratioScore(s.answerCount - s.emptyAnswers, s.answerCount, 40, 95));
  const confidence = clampScore(structure * 0.5 + completeness * 0.5 - penalty);

  const breakdown: ScoreBreakdownItem[] = [
    { key: 'Structure', value: structure, note: structure >= 80 ? L.structure.high : structure >= 60 ? L.structure.mid : L.structure.low },
    { key: 'Specificity', value: specificity, note: specificity >= 80 ? L.specificity.high : s.numericAnswers > 0 ? L.specificity.some : L.specificity.none },
    { key: 'Communication', value: communication, note: s.avgWords < 15 ? L.communication.short : communication >= 80 ? L.communication.high : L.communication.mid },
    { key: 'Confidence', value: confidence, note: confidence >= 80 ? L.confidence.high : confidence >= 60 ? L.confidence.mid : L.confidence.low },
    { key: 'Role fit', value: completeness, note: s.emptyAnswers > 0 ? L.roleFit.thin(s.emptyAnswers) : completeness >= 80 ? L.roleFit.high : L.roleFit.mid },
  ];

  const overall = clampScore(breakdown.reduce((a, b) => a + b.value, 0) / breakdown.length);

  const dimLabel = (key: string): string => L.dims[key as DimKey] ?? key;
  const sorted = [...breakdown].sort((a, b) => b.value - a.value);
  const strengths = sorted.slice(0, 2).filter((b) => b.value >= 70).map((b) => `${dimLabel(b.key)}: ${b.note}`);
  if (strengths.length === 0) strengths.push(L.strengthFallback);
  const gaps = [...sorted].reverse().slice(0, 2).filter((b) => b.value < 75).map((b) => `${dimLabel(b.key)}: ${b.note}`);
  if (gaps.length === 0) gaps.push(L.gapFallback);

  const summary =
    overall >= 85 ? L.summary.top
    : overall >= 75 ? L.summary.strong
    : overall >= 60 ? L.summary.good
    : L.summary.base;

  return { overall, breakdown, strengths: strengths.slice(0, 3), gaps: gaps.slice(0, 3), summary };
}

export const __test = { gatherSignals, isCjkDominant };
