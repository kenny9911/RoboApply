// server/src/features/extension/questionTypes.ts — which application-form
// questions AI may draft (TASK_PLAN.md WP-55a; ruling H2), and how a saved
// answer-bank entry is matched to a question.
//
// The protected types (work authorization, sponsorship, criminal history,
// EEO / disability / veteran, personal facts such as birth date or 政治面貌,
// salary history or expectation, years of experience, degrees,
// certifications, clearance, notice period, grades and test scores) are
// facts about the person. They
// come only from the answer bank or the profile, or are left for the user —
// a model never writes them. Everything else is `free_text`, which AI may
// draft for the side panel.
//
// Languages: the rules cover English and Chinese fully, plus the common
// German, French, Spanish, Portuguese, Italian, Dutch, Japanese and Korean
// wordings. That list can never be complete, so drafting fails closed:
// `draftableLanguage()` lets AI draft only questions that read as English or
// Chinese. Anything else (another script, accented Latin, or Latin text with
// no English word) gets no AI draft, whatever the classifier says.
//
// The classifier errs on the side of "protected": a question that mentions
// any protected topic is protected, even when it is also open-ended (a
// wrongly protected question only costs the user typing; a wrongly open one
// lets a model state a fact). Order matters only to pick the most specific
// label (sponsorship before work authorization, salary history before salary
// expectation, EEO before personal facts).
//
// Bank matching for protected questions is strict: a saved answer is reused
// only for the same question (same words once filler words are dropped), or
// through a canonical key whose place qualifier matches the question. A
// "yes" saved for the UK is never offered for a US question.

import type { ProtectedQuestionType, QuestionType } from './contract.js';

/**
 * Grades and test scores. 成绩 and 排名 also mean achievements and rankings at
 * work ("请描述你在上一份工作中取得的主要成绩"), and "academic performance" or
 * "test results" turn up in open questions, so those words count only with a
 * study context next to them, or as the whole field label. Mirrored in
 * extension/src/mapping/questions.ts (keep the two lists the same).
 */
export const GRADES_RE = new RegExp(
  [
    // The whole label and nothing else: "成绩", "排名情况", "Academic performance", "Exam results".
    String.raw`^[\s*:：?？()（）]*(?:成绩|成績|排名|academic\s+(?:performance|results?)|(?:test|exam(?:ination)?)\s+results?)(?:情况|情況)?[\s*:：?？()（）]*$`,
    String.raw`\bgpa\b|\bgrades\b|grade\s+(?:point|average)|class\s+rank|academic\s+(?:rank(?:ing)?|standing|record)`,
    String.raw`academic\s+(?:performance|results?)\s*[(:（：-]?\s*(?:gpa|grades?|scores?|marks?|percentage)`,
    String.raw`(?:test|exam(?:ination)?)\s+scores?|\byour\s+exam(?:ination)?\s+results?`,
    String.raw`\b(?:sat|act|gre|gmat|lsat|toeic|jlpt|hsk)\s*(?:scores?|results?|level|成绩|成績|分数|分數)`,
    String.raw`\bielts\b|\btoefl\b|\bcet[-\s]?[46]\b|\btem[-\s]?[48]\b`,
    '绩点|績點|四六级|四六級|四级|六级|四級|六級|英语等级|英語等級|雅思|托福|专四|专八|專四|專八|平均分|均分|考试分数|考試分數',
    // 成绩 with a study word in front (在校成绩, 大学期间取得的成绩), right after a subject
    // or an exam (英语成绩, 笔试成绩), or as 成绩单 / 成绩排名.
    '(?:学习|學習|在校|学业|學業|学校|學校|学期|學期|本科|硕士|碩士|博士|研究生|大学|大學|高中|高考).{0,8}成[绩績]',
    '(?:课程|課程|专业课|專業課|各科|考试|考試|笔试|筆試|英语|英語|外语|外語).{0,2}成[绩績]|成[绩績](?:单|單|排名)',
    // 排名 of a class, year or major, or given as a share ("排名前10%").
    String.raw`(?:专业|專業|年级|年級|班级|班級|综合|綜合|学业|學業|学习|學習|院系|同届|同屆|成绩|成績)排名|排名.{0,4}(?:前\s*\d|\d+\s*%|百分)`,
  ].join('|'),
  'i',
);

const RULES: ReadonlyArray<[ProtectedQuestionType, RegExp]> = [
  [
    'sponsorship',
    /sponsor|visa\s+(status|support|transfer)|visum|visado|\bvisto\b|ビザ|在留資格|비자|(require|need)s?\s+(a\s+|an\s+|any\s+)?(work\s+|employment\s+)?visa|without\s+(any\s+)?(restriction|sponsorship|a\s+visa)|h-?1b|\bopt\b|\bcpt\b|担保|保荐|签证|簽證|擔保/i,
  ],
  [
    'work_authorization',
    /(authori[sz]ed|eligible|right|permit(ted)?|legally\s+able|allowed)\s+(to\s+)?work|work(ing)?\s+(authori[sz]ation|permit|eligibility|visa|rights?)|right\s+to\s+work|(can|could|are|will)\s+you\s+(legally\s+)?work\s+in\b|able\s+to\s+(legally\s+)?work\s+in\b|citizenship|citizen\b|nationality|permanent\s+resident|green\s+card|arbeitserlaubnis|arbeitsgenehmigung|aufenthalts?(titel|erlaubnis)|staatsangeh|permis\s+de\s+travail|autoris[ée]e?\s+à\s+travailler|nationalit|permiso\s+de\s+(trabajo|residencia)|autorizad[oa]\s+(para|a)\s+trabajar|autoriza[çc][ãa]o\s+de\s+trabalho|nacionalidad|permesso\s+di\s+(lavoro|soggiorno)|cittadinanza|werkvergunning|就労|労働許可|국적|취업\s*허가|체류|工作许可|工作許可|工作签证|工作簽證|居留|国籍|國籍|户口|戶口/i,
  ],
  ['criminal_history', /convict|felony|misdemeanou?r|criminal|offen[cs]e|arrest|vorstrafe|führungszeugnis|casier\s+judiciaire|antecedentes\s+(penales|criminais)|casellario|犯罪歴|범죄|犯罪|刑事|前科|违法记录|違法記錄/i],
  ['disability', /disabilit|handicap|behinderung|discapacidad|deficiência|deficiencia|disabilità|障害|장애|残疾|殘疾|身心障碍|身心障礙/i],
  ['veteran', /veteran|military\s+service|armed\s+forces|wehrdienst|service\s+militaire|servicio\s+militar|serviço\s+militar|병역|군필|兵役|退伍|军人|軍人|服役/i],
  [
    'eeo',
    /\bgender\b|\bsex\b|pronoun|race\b|racial|ethnic|hispanic|latino|sexual\s+orientation|transgender|equal\s+(employment\s+)?opportunity|\beeo\b|geschlecht|\bsexe\b|\bgénero\b|\bgenero\b|\bsesso\b|geslacht|성별|性别|性別|民族|种族|種族|性取向/i,
  ],
  [
    'personal',
    /date\s+of\s+birth|birth\s*(date|day|year)|\bdob\b|\bage\b|how\s+old|\b(1[68]|21)\s*(\+|years?\s+(of\s+age|old)|or\s+(older|over|above))|(over|above|under)\s+(the\s+age\s+of\s+)?(1[68]|21)\b|(minimum|legal|working)\s+age|at\s+least\s+(1[68]|21)\b|geburtsdatum|geburtstag|\balter\b|familienstand|date\s+de\s+naissance|âge|situation\s+familiale|fecha\s+de\s+nacimiento|\bedad\b|estado\s+civil|data\s+de\s+nascimento|\bidade\b|data\s+di\s+nascita|età|geboortedatum|leeftijd|生年月日|年齢|생년월일|나이|연령|marital|married|religio|family\s+members?|place\s+of\s+(birth|origin)|national\s+id|id\s+(card\s+)?number|social\s+security|\bssn\b|passport\s+number|health\s+(condition|status)|政治面貌|籍贯|籍貫|出生日期|出生年月|生日|年龄|年齡|婚姻|婚否|已婚|未婚|宗教|家庭成员|家庭成員|身份证|身分證|健康状况|健康狀況|党员|黨員/i,
  ],
  [
    'salary_history',
    /(current|previous|prior|last|present)\s+(base\s+|annual\s+|monthly\s+)?(salary|compensation|pay|wage|ctc|income|earnings)|salary\s+history|compensation\s+history|pay\s+history|(aktuelles|derzeitiges|letztes)\s+gehalt|salaire\s+actuel|salario\s+actual|sal[áa]rio\s+atual|stipendio\s+attuale|huidig\s+salaris|現在の年収|現年収|현재\s*연봉|(当前|目前|现在|現在|上一份|上份|过往|過往|之前|以前|原|现|現)\s*(工作|职位|職位|公司)?\s*(的)?\s*(年|月)?(薪|工资|工資|收入|待遇)/i,
  ],
  [
    'salary_expectation',
    /salary|compensation|pay\s+(range|expectation|requirement)|expected\s+(pay|ctc)|\bctc\b|(desired|target|base|expected)\s+(base\s+)?pay|wage|remuneration|expect(ed|ing)?\s+to\s+(earn|make|be\s+paid)|how\s+much\s+(do|would|will)\s+you\s+(expect|want|like|need)|(hourly|daily|day|weekly|monthly)\s+rate|rate\s+of\s+pay|pay\s+rate|gehalt|vergütung|verguetung|\blohn|salaire|rémunération|remuneration|pr[ée]tentions?\s+salariales?|salario|sueldo|remuneraci[óo]n|pretensi[óo]n|sal[áa]rio|remunera[çc][ãa]o|pretens[ãa]o|stipendio|retribuzione|\bral\b|salaris|年収|給与|給料|月給|연봉|급여|희망\s*연봉|期望薪|期望月薪|期望年薪|薪资|薪資|薪酬|薪水|工资|工資|月薪|年薪|待遇/i,
  ],
  [
    'years_of_experience',
    /years?\s+(of\s+)?(professional\s+|relevant\s+|work\s+|industry\s+|hands-on\s+)?experience|how\s+many\s+years|how\s+long\s+have\s+you|number\s+of\s+years|years?\s+(in|with|of|using|working)\b|berufserfahrung|jahre(n)?\s+(an\s+)?erfahrung|ann[ée]es\s+d.exp[ée]rience|a[ñn]os\s+de\s+experiencia|anos\s+de\s+experi[êe]ncia|anni\s+di\s+esperienza|jaren?\s+(werk)?ervaring|経験年数|実務経験|경력|工作年限|从业年限|從業年限|几年|幾年|多少年|年经验|年經驗|年工作经验|经验年限|經驗年限/i,
  ],
  ['clearance', /clearance|security\s+(vetting|check)|\bts\/sci\b|sicherheitsüberprüfung|habilitation|安全许可|安全審查|政审|政審/i],
  // Grades and test scores (WP-93): the user's own record. Before `degree` and
  // `certification`, so "CET-4 certificate score" and "学位课程绩点" read as grades.
  ['grades', GRADES_RE],
  ['degree', /\bdegree\b|bachelor|master'?s|\bph\.?d\b|doctorate|level\s+of\s+education|highest\s+education|diploma|graduated|abschluss|studium|diplôme|dipl[oô]me|t[íi]tulo\s+universitario|licenciatura|gradua[çc][ãa]o|laurea|opleidingsniveau|最終学歴|학력|학위|学历|學歷|学位|學位|毕业|畢業/i],
  ['certification', /certif|licen[cs]e[ds]?\b|licensure|accredit|zertifi|führerschein|permis\s+de\s+conduire|licencia|carteira\s+de\s+habilita|patente|rijbewijs|資格|免許|자격증|면허|证书|證書|资格证|資格證|执照|執照/i],
  [
    'notice_period',
    /notice\s+period|start\s+date|when\s+(can|could|would)\s+you\s+(start|begin|join)|when\s+are\s+you\s+available|(available|availability)\s+to\s+(start|begin|join)|earliest.*(start|begin|join)|join(ing)?\s+date|kündigungsfrist|eintrittstermin|eintrittsdatum|frühestens|pr[ée]avis|date\s+de\s+d[ée]but|disponibilit|preaviso|fecha\s+de\s+(inicio|incorporaci)|aviso\s+pr[ée]vio|data\s+de\s+in[íi]cio|preavviso|opzegtermijn|startdatum|入社可能|入社日|입사\s*가능|입사일|到岗|到崗|到职|到職|入职|入職|离职通知|離職通知/i,
  ],
];

/** The type of an application-form question (see the file header). */
export function classifyQuestion(question: string): QuestionType {
  const text = question.replace(/\s+/g, ' ').trim();
  for (const [type, re] of RULES) if (re.test(text)) return type;
  return 'free_text';
}

// ── Which languages AI may draft in ─────────────────────────────────────────

/** A letter that is neither Latin nor Han: kana, Hangul, Cyrillic, Arabic, Thai, … */
const OTHER_SCRIPT_LETTER = /[^\p{Script=Latin}\p{Script=Han}\P{L}]/u;
const HAN = /\p{Script=Han}/u;
/** A Latin letter outside a–z (é, ä, ñ, ß …): not English. */
const ACCENTED_LATIN = /(?![a-zA-Z])\p{Script=Latin}/u;
/** English loanwords that carry accents and do not make a question foreign. */
const ENGLISH_ACCENTED = /(?<!\p{L})(r[ée]sum[ée]s?|caf[ée]|na[ïi]ve|clich[ée]s?)(?!\p{L})/giu;
/**
 * Words that mark a Latin-script question as English. Words that are also
 * common in German, Dutch, French, Spanish, Portuguese or Italian ("in",
 * "is", "an", "was", "will", "die", "do", "de", "a") are left out on purpose.
 */
const ENGLISH_WORDS = new Set(
  (
    'the you your yours yourself why what how which who whom whose when where are does did have has had would could should shall ' +
    'tell describe explain share give list please about this that these those there their they them with and for from our ' +
    'we us any anything else other why want wanted interest interests interested interesting role position job company team ' +
    'work worked working experience project projects cover letter summary motivation additional information info comments ' +
    'comment portfolio website link url linkedin github twitter profile example examples proud challenge challenges ' +
    'yourself hear heard learn learned like love enjoy goal goals strength strengths weakness weaknesses greatest ' +
    'biggest favorite favourite ideal success successful achievement achievements accomplishment approach handle handled ' +
    'situation time times problem problems solve solved lead led manage managed help helped mission product customers ' +
    'customer users user why should hire best most fit culture values value contribute contribution background question ' +
    'questions note notes optional answer briefly short essay paragraph words characters referral referred who name been ' +
    'being into than then think thought feel believe know knowledge skill skills writing sample samples'
  ).split(/\s+/),
);

/**
 * Whether AI may draft an answer to this question: it reads as English or
 * Chinese. Fails closed — any other script, accented Latin letters, or Latin
 * text without a single English word means no draft.
 */
export function draftableLanguage(question: string): boolean {
  const text = question.normalize('NFC');
  if (OTHER_SCRIPT_LETTER.test(text)) return false;
  if (HAN.test(text)) return true;
  if (ACCENTED_LATIN.test(text.replace(ENGLISH_ACCENTED, ''))) return false;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.some((w) => ENGLISH_WORDS.has(w));
}

export function isProtectedQuestionType(type: QuestionType): type is ProtectedQuestionType {
  return type !== 'free_text';
}

/** Lowercase, punctuation-free, single-spaced text for answer-bank matching. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CJK = /[㐀-鿿]/;

function tokens(text: string): Set<string> {
  const norm = normalizeQuestion(text);
  // CJK has no spaces: compare character bigrams there.
  if (CJK.test(norm)) {
    const chars = norm.replace(/\s+/g, '');
    const out = new Set<string>();
    for (let i = 0; i < chars.length - 1; i++) out.add(chars.slice(i, i + 2));
    return out;
  }
  return new Set(norm.split(' ').filter((w) => w.length > 1));
}

/** Jaccard overlap of the two questions' words (CJK: bigrams), 0–1. */
export function questionSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return 0;
  let both = 0;
  for (const t of ta) if (tb.has(t)) both += 1;
  return both / (ta.size + tb.size - both);
}

/** A free-text bank answer counts as the same question at or above this overlap. */
export const BANK_MATCH_THRESHOLD = 0.75;

// ── Places (work authorization, sponsorship, clearance and pay depend on them) ──

/**
 * Countries and regions an application question can name, as canonical
 * codes. "US" is matched only in capitals (or spelled out) so that "work
 * for us" is not read as the United States.
 */
const PLACES: ReadonlyArray<[string, RegExp]> = [
  // Case-sensitive on purpose: "US", "U.S.", "USA" — never the pronoun "us".
  ['us', /\bU\.?S\.?(A\.?)?(?![A-Za-z])/],
  ['us', /united\s+states|\bamerica\b|美国|美國/i],
  ['uk', /\bUK\b|\bGB\b|united\s+kingdom|great\s+britain|\bbritain\b|\bengland\b|\bscotland\b|\bwales\b|英国|英國/i],
  ['eu', /\bEU\b|european\s+union|\beea\b|欧盟|歐盟/i],
  ['ca', /canada|加拿大/i],
  ['de', /germany|deutschland|德国|德國/i],
  ['fr', /\bfrance\b|法国|法國/i],
  ['ie', /ireland|爱尔兰|愛爾蘭/i],
  ['nl', /netherlands|holland|荷兰|荷蘭/i],
  ['es', /\bspain\b|西班牙/i],
  ['it', /\bitaly\b|意大利|義大利/i],
  ['ch', /switzerland|瑞士/i],
  ['se', /\bsweden\b|瑞典/i],
  ['pl', /\bpoland\b|波兰|波蘭/i],
  ['au', /australia|澳大利亚|澳大利亞|澳洲/i],
  ['nz', /new\s+zealand|新西兰|紐西蘭/i],
  ['sg', /singapore|新加坡/i],
  ['hk', /hong\s+kong|香港/i],
  ['mo', /macau|macao|澳门|澳門/i],
  ['tw', /taiwan|台湾|臺灣|台灣/i],
  ['jp', /\bjapan\b|日本/i],
  ['kr', /\bkorea\b|韩国|韓國/i],
  ['in', /\bindia\b|印度/i],
  ['il', /\bisrael\b|以色列/i],
  ['ae', /\buae\b|united\s+arab\s+emirates|dubai|阿联酋|阿聯酋/i],
  ['mx', /\bmexico\b|墨西哥/i],
  ['br', /\bbrazil\b|巴西/i],
  ['cn', /mainland|\bprc\b|\bchina\b|中国|中國|大陆|大陸|内地|內地/i],
];
const CURRENCIES: ReadonlyArray<[string, RegExp]> = [
  ['usd', /\busd\b|us\$/i],
  ['gbp', /\bgbp\b|£|英镑|英鎊/i],
  ['eur', /\beur\b|€|欧元|歐元/i],
  ['cny', /\bcny\b|\brmb\b|人民币|人民幣/i],
  ['twd', /\btwd\b|\bntd\b|新台币|新台幣/i],
  ['hkd', /\bhkd\b|港币|港幣/i],
  ['cad', /\bcad\b/i],
  ['aud', /\baud\b/i],
  ['sgd', /\bsgd\b/i],
  ['jpy', /\bjpy\b|日元|日圓/i],
  ['inr', /\binr\b/i],
];
/** Two-letter (and common) qualifiers a canonical bank key may carry: `work_authorization:us`. */
const KEY_PLACE_ALIASES: Record<string, string> = { gb: 'uk', usa: 'us', united_states: 'us', united_kingdom: 'uk', prc: 'cn', mainland: 'cn' };
const PLACE_CODES = new Set(PLACES.map(([code]) => code));

/** The places and currencies a question names (canonical codes; empty when none). */
export function placesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const [code, re] of PLACES) if (re.test(text)) out.add(code);
  // "中国香港 / 中國台灣": the specific region, not the mainland.
  if (out.has('cn') && (out.has('hk') || out.has('tw') || out.has('mo')) && !/mainland|大陆|大陸|内地|內地/i.test(text)) out.delete('cn');
  for (const [code, re] of CURRENCIES) if (re.test(text)) out.add(`cur:${code}`);
  return out;
}

function placesOfKeyQualifier(qualifier: string): Set<string> {
  const q = qualifier.trim().toLowerCase();
  if (!q) return new Set();
  const alias = KEY_PLACE_ALIASES[q] ?? q;
  if (PLACE_CODES.has(alias)) return new Set([alias]);
  return placesIn(qualifier.replace(/[_-]+/g, ' ').toUpperCase());
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Protected types whose answer depends on the country or currency in the question. */
const PLACE_DEPENDENT: ReadonlySet<QuestionType> = new Set(['work_authorization', 'sponsorship', 'clearance', 'salary_history', 'salary_expectation']);

/**
 * Protected types where one canonical key covers every phrasing, so a key
 * named after the type may answer a reworded question. Not EEO / personal
 * (gender ≠ race, birth date ≠ marital status), not years of experience,
 * degree or certification (they depend on the skill or field asked about).
 */
const KEY_FALLBACK_TYPES: ReadonlySet<QuestionType> = new Set([
  'work_authorization',
  'sponsorship',
  'clearance',
  'salary_history',
  'salary_expectation',
  'notice_period',
  'criminal_history',
  'veteran',
  'disability',
]);

// ── Protected-question equality ───────────────────────────────────────────

/** Words that never change what a protected question asks. */
const FILLER_WORDS = new Set(
  'a an the please kindly select choose indicate enter provide state confirm answer your you yours are is do does did will would can could be been have has currently now presently at this time company role position job our we us for of to in on with and or if any e g eg required optional yes no'.split(
    ' ',
  ),
);
const CJK_FILLER = /请|請|您|你|的|吗|嗎|呢|是否|目前|当前|當前|现在|現在|填写|填寫|选择|選擇|贵司|貴司|我们|我們|公司|岗位|崗位|职位|職位/g;

/** What a protected question asks once filler words are dropped (order-insensitive for words). */
function protectedCore(text: string): string {
  const norm = normalizeQuestion(text);
  if (CJK.test(norm)) return norm.replace(CJK_FILLER, '').replace(/\s+/g, '');
  return [...new Set(norm.split(' ').filter((w) => w && !FILLER_WORDS.has(w)))].sort().join(' ');
}

export interface BankEntry {
  questionKey: string;
  questionText: string;
  answer: string;
  /**
   * Who wrote it: `user` typed it in the app; `ai_confirmed` is a draft the
   * user approved for one employer's form ("Save this answer"). The extension
   * fills an `ai_confirmed` answer by itself only into the same question.
   */
  source?: 'user' | 'ai_confirmed';
}

/**
 * The user's saved answer for this question, or null. Empty answers never match.
 *
 *   free_text   same normalized text, or a close wording (≥ BANK_MATCH_THRESHOLD).
 *   protected   same normalized text, or the same words once filler words are
 *               dropped ("Are you authorized to work in the US?" ≈ "Please
 *               confirm: are you currently authorized to work in the US"),
 *               and the same places / currencies; or, for KEY_FALLBACK_TYPES,
 *               the only entry whose key is `<type>` or `<type>:<place>` when
 *               its places equal the question's ("work_authorization:us" never
 *               answers a UK question; an unqualified key never answers a
 *               question that names a place it does not).
 */
export function findBankAnswer(bank: readonly BankEntry[], question: string, type: QuestionType): BankEntry | null {
  const usable = bank.filter((b) => b.answer.trim());
  const norm = normalizeQuestion(question);
  const exact = usable.find((b) => normalizeQuestion(b.questionText) === norm);
  if (exact) return exact;

  if (type === 'free_text') {
    let best: BankEntry | null = null;
    let bestScore = 0;
    for (const b of usable) {
      const score = questionSimilarity(b.questionText, question);
      if (score > bestScore) {
        best = b;
        bestScore = score;
      }
    }
    return best && bestScore >= BANK_MATCH_THRESHOLD ? best : null;
  }

  const qPlaces = placesIn(question);
  const placesMatch = (entryPlaces: Set<string>) => !PLACE_DEPENDENT.has(type) || sameSet(entryPlaces, qPlaces);

  const core = protectedCore(question);
  if (core) {
    const same = usable.find((b) => protectedCore(b.questionText) === core && placesMatch(placesIn(b.questionText)));
    if (same) return same;
  }

  if (KEY_FALLBACK_TYPES.has(type)) {
    const keyed = usable.filter((b) => b.questionKey === type || b.questionKey.startsWith(`${type}:`));
    if (keyed.length === 1) {
      const entry = keyed[0]!;
      const qualifier = entry.questionKey.slice(type.length + 1);
      // A non-place qualifier (`disability:self_id`) is a sub-question: not a match for every phrasing.
      const qualifierPlaces = placesOfKeyQualifier(qualifier);
      if (qualifier && !qualifierPlaces.size) return null;
      const entryPlaces = new Set([...qualifierPlaces, ...placesIn(entry.questionText)]);
      if (placesMatch(entryPlaces)) return entry;
    }
  }
  return null;
}

// ── Sensitive answers (consent `autofill_sensitive`, ARCH §3.8 / §6.4) ───────

/** Question types whose answers are sensitive personal information. */
const SENSITIVE_TYPES: ReadonlySet<QuestionType> = new Set(['eeo', 'disability', 'veteran', 'personal']);

/** Keys and words that mark a saved answer as sensitive whatever the classifier says (CN and EEO lists). */
const SENSITIVE_TERMS =
  /政治面貌|家庭成员|家庭成員|籍贯|籍貫|民族|出生日期|出生年月|婚姻|健康|宗教|身份证|身分證|性别|性別|gender|birth_?date|date_?of_?birth|political_?status|family_?members|native_?place|marital|ethnicity|\brace\b|religion|sexual_?orientation|disability|veteran|\beeo\b|health/i;

/**
 * Whether a saved answer is sensitive: it leaves the server only to a
 * user with a live `autofill_sensitive` consent (never into a prompt).
 */
export function isSensitiveBankEntry(entry: Pick<BankEntry, 'questionKey' | 'questionText'>): boolean {
  if (SENSITIVE_TYPES.has(classifyQuestion(entry.questionText))) return true;
  if (SENSITIVE_TYPES.has(classifyQuestion(entry.questionKey.replace(/[_:.-]+/g, ' ')))) return true;
  return SENSITIVE_TERMS.test(entry.questionKey) || SENSITIVE_TERMS.test(entry.questionText);
}
