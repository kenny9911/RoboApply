// server/src/features/jobs/taxonomy/match.ts
//
// Title → role matching and the role typeahead over taxonomy v1.
//
// Matching is deterministic and explainable (no LLM): a posting title is
// normalized (case, width, punctuation, bracketed notes, tech spellings like
// C++ / C# / .NET / Node.js), then compared with every role's labels and
// synonyms as written and with level words removed ("Senior", "II",
// "Intern", 高级, 资深, 校招 …). The best score wins:
//   - exact phrase                         1.0
//   - every synonym word appears in the title (Latin) or the synonym is a
//     substring of the title (CJK)         0.5 + 0.5 × coverage, +0.05 when contiguous
//   - the modifier lexicon (below)         0.85 (a role phrase found in the title wins a tie with it)
// Roles marked `generic` ("Software engineer") lose 0.15 so a specific role
// wins whenever both match. Below `minScore` (0.6) there is no match: an
// honest "unknown" beats a wrong category (D3). A score of 0.9 or more means
// the title names the role outright; enrichment may overrule anything weaker
// (enrich/reconcile.ts, `TITLE_MATCH_TRUSTED`).
//
// One word, many professions (SM-2). "Architect", "designer", "developer",
// "engineer", "analyst", "consultant", "manager", "specialist" and
// "technician" (and 设计师, 工程师, 顾问, 专员, 经理, 分析师) are head nouns:
// the word alone says nothing about the discipline.
//   1. A role phrase that is exactly a head noun ("architect" → the building
//      profession, "developer" → software engineer, "consultant" → management
//      consultant) matches only when it is the whole title once level words
//      are removed ("Senior Architect", "Developer II"). Inside a longer title
//      it scores nothing. The same holds for the other ambiguous one-word
//      phrases listed in `ALONE_ONLY_PHRASES` ("pm", "pt", "controller" …).
//      Alone, a head noun is its role at full score; an ambiguous word is
//      its role at 0.85, so enrichment may still overrule it.
//   2. In "<modifiers> <head noun>" the modifiers decide. The modifier lexicon
//      says, per head noun, which roles its modifier words point at. It is
//      built from the taxonomy itself (every role phrase that ends in a head
//      noun gives its other words, together, to its role: "medical device
//      engineer" counts only when the title has both words) plus
//      `EXPLICIT_MODIFIERS` (software words beside "architect" → software
//      architect; building words → the building profession; software words
//      beside "developer" → software engineer). The role that shares the most
//      modifier words with the title scores 0.85; a catch-all role gives way
//      to a specific one, and a tie between two specific roles is no match
//      (enrichment decides). A phrase that needs a level word to name its role
//      ("lead software engineer" → tech lead, "smart contract engineer",
//      "lead generation specialist") gives the lexicon nothing: without that
//      word its other words name someone else ("Software Engineer, Payments").
//   3. A one-word role phrase beside a head noun is a modifier too ("Nurse
//      Manager", "DevOps Consultant", "Device Driver Engineer"): it does not
//      score by itself there, it votes in the lexicon like any other word.
// English titles end on the role, so of two one-word phrases with the same
// score the later one wins ("Physician Recruiter" is a recruiter).
//
// Chinese. Phrases are compared without spaces, by substring (an English
// phrase inside a mixed title still needs its whole words: "cto" is not found
// in "Art Director 艺术总监"). A Chinese title ends on its role too: a phrase
// that another role's phrase follows is that role's modifier and does not
// score (新媒体销售 is a sales title, 行政司机 a driver, 数据分析产品经理 a product
// manager); a catch-all role's phrase never displaces the words before it
// (Java开发工程师). 开发 and 研发
// before 工程师 are filler (前端研发工程师 is a 前端工程师); 开发工程师 inside a
// longer title still says "software" weakly (系统开发工程师, under 0.9, so
// enrichment may overrule it), 研发工程师 does not (an R&D engineer of any
// discipline). 管培生 and 储备干部
// are entry tracks, removed like level words. A mixed-language title that
// closes on a Chinese head word ("Machine Learning 工程師") is also read with
// the English head noun. The taxonomy's Chinese phrases are Simplified: a
// Taiwan title is matched in its mainland reading, which the caller makes
// (normalize `foldTwToCn`; ingest, enrichment and the backfill all do), since
// this area imports no other.
//
// Results are kept for the last few thousand titles: one posting is matched
// for many readers, and the function is pure.

import { TAXONOMY_NODES, taxonomyAncestors, taxonomyLabel, type TaxonomyLevel, type TaxonomyNode } from './taxonomy.js';

const CJK = /[㐀-鿿豈-﫿]/;

/** Level words removed in the second pass (Latin tokens). */
const LEVEL_TOKENS = new Set([
  'senior',
  'sr',
  'junior',
  'jr',
  'staff',
  'principal',
  'lead',
  'intern',
  'internship',
  'trainee',
  'graduate',
  'grad',
  'new',
  'entry',
  'level',
  'mid',
  'experienced',
  'i',
  'ii',
  'iii',
  'iv',
  'v',
  '1',
  '2',
  '3',
  '4',
  'remote',
  'hybrid',
  'onsite',
  'contract',
  'temporary',
  'part',
  'time',
  'full',
  'fulltime',
  'parttime',
]);

/**
 * Level words removed in the second pass (Chinese), longest first. 管培生 and
 * 储备干部 are entry tracks, not functions: "销售管培生" is a sales title and a
 * bare 管培生 names no role, so it stays unknown rather than being filed
 * under a category it does not state (D3).
 */
const CJK_LEVEL_WORDS = [
  '管理培训生', '应届毕业生', '储备干部', '校园招聘', '管培生', '助理级', '实习生', '应届生', '毕业生',
  '高级', '资深', '初级', '中级', '实习', '校招', '社招', '秋招', '春招', '应届', '储备', '急招', '兼职', '全职',
];
/** A class year in a campus title: "2027届", "27届". */
const CJK_CLASS_YEAR = /\d{2,4}\s*届/g;

/** Lower-case, full-width → half-width, bracketed notes removed, tech spellings joined, punctuation → spaces. */
export function normalizeTitle(input: string): string {
  let s = input.normalize('NFKC').toLowerCase();
  s = s.replace(/[(（[【][^)）\]】]*[)）\]】]/g, ' ');
  s = s
    .replace(/c\+\+/g, 'cpp')
    .replace(/c#/g, 'csharp')
    .replace(/\.net\b/g, 'dotnet')
    .replace(/node\.js/g, 'nodejs')
    .replace(/\be-commerce\b/g, 'ecommerce')
    .replace(/&/g, ' and ');
  s = s.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
  return s;
}

/** Remove level words (second matching pass). */
export function stripLevelWords(normalized: string): string {
  let s = normalized.replace(CJK_CLASS_YEAR, ' ');
  for (const w of CJK_LEVEL_WORDS) s = s.split(w).join(' ');
  const tokens = s.split(' ').filter((t) => t && !LEVEL_TOKENS.has(t));
  return tokens.join(' ');
}

/** At or above this score the title names its role outright; enrichment may overrule anything weaker. */
export const TITLE_MATCH_TRUSTED = 0.9;
/** The score of a role chosen by the modifier lexicon. */
export const MODIFIER_MATCH_SCORE = 0.85;

/** Head nouns: the word alone names no discipline (SM-2). */
export const HEAD_NOUNS = ['architect', 'designer', 'developer', 'engineer', 'analyst', 'consultant', 'manager', 'specialist', 'technician'] as const;
/** The Chinese head words, in mainland characters (a Taiwan title is folded before matching). */
export const CJK_HEAD_WORDS = ['设计师', '工程师', '顾问', '专员', '经理', '分析师'] as const;

const HEAD_NOUN_SET: ReadonlySet<string> = new Set(HEAD_NOUNS);
const CJK_HEAD_WORD_SET: ReadonlySet<string> = new Set(CJK_HEAD_WORDS);

/**
 * One-word role phrases that mean something else in many titles. Like a head
 * noun, each matches only when it is the whole title once level words are
 * removed, and then at `MODIFIER_MATCH_SCORE` (the word is ambiguous even
 * alone, so enrichment may still overrule it); a longer synonym of the role
 * ("financial controller", "food server") matches by its own words. Reviewed
 * against the one-word English phrases of the level-3 roles; the value says why.
 */
export const ALONE_ONLY_PHRASES: Readonly<Record<string, string>> = {
  pm: 'product, project or program manager, and the afternoon shift',
  apm: 'associate product manager, or application performance monitoring',
  tpm: 'technical program manager, total productive maintenance, or a security chip',
  cpo: 'chief product, people or procurement officer',
  cmo: 'chief marketing or medical officer, or a contract manufacturer',
  cio: 'chief information or investment officer',
  ae: 'account executive, application engineer, or After Effects',
  sdr: 'sales development representative, or software-defined radio',
  csm: 'customer success manager, or certified scrum master',
  ba: 'business analyst, or a bachelor of arts',
  ea: 'executive assistant, enrolled agent, or a company name',
  gp: 'general practitioner, or general partner',
  np: 'nurse practitioner, or a two-letter code in other titles',
  pt: 'physical therapist, or part time',
  cra: 'clinical research associate, or the Community Reinvestment Act in banking',
  crc: 'clinical research coordinator, or other three-letter codes',
  fe: 'front end, finite element, or further education',
  rater: 'search quality rater, or an insurance rater',
  controller: 'finance controller, document controller, air traffic controller, or a device',
  trainer: 'corporate trainer, personal trainer, or animal trainer',
  principal: 'a school principal, or the level word in "Principal Engineer"',
  registrar: 'a school registrar, a medical grade, or a domain registrar',
  clerk: 'office, law, payroll, shipping or sales clerk',
  writer: 'copywriter, technical writer, grant writer, medical writer, or a service writer in a garage',
  auditor: 'financial auditor, quality auditor, energy auditor, or a hotel night auditor',
  correspondent: 'a news correspondent, or correspondent banking',
  producer: 'a film producer, a game producer, or an insurance producer (sales)',
  server: 'restaurant staff, or a computer',
  steward: 'cabin crew, a data steward, or a shop steward',
  行政: 'administration, or the grade in 行政总厨 (executive chef), 行政司机, 行政总监',
  人事: 'human resources, or one half of 人事行政 and 人事财务 titles',
  新媒体: 'new media as a function, or the channel in 新媒体销售, 新媒体主播, 新媒体设计',
  客户服务: 'customer service, or the department in 客户服务工程师 and 客户服务经理',
  运营专员: 'operations of any department: 物流运营专员, 门店运营专员, 产品运营专员',
  运营助理: 'operations of any department, like 运营专员',
};

/**
 * `ALONE_ONLY_PHRASES` words that became role names with SM-2 and so never
 * filed a longer title under their role: `oneWordRolesIn` leaves them out (a
 * role a row holds beside one of these words was not put there by the retired
 * one-word rule).
 */
const ALONE_ONLY_SINCE_SM2: ReadonlySet<string> = new Set(['fe', '行政', '人事', '新媒体', '客户服务', '运营专员', '运营助理']);

/**
 * 研发工程师 is the head word 工程师 with a filler and no discipline: an R&D
 * engineer in software, hardware, chemistry or machinery. Like a head word it
 * names its role (the catch-all software engineer) only as the whole title.
 * 开发工程师 is different: "development engineer" inside a longer title is a
 * software title far more often than not, so it keeps a weak vote there.
 */
const CJK_CROSS_DISCIPLINE: ReadonlySet<string> = new Set(['研发工程师']);

/**
 * 开发 and 研发 before 工程师 are filler in most mainland titles: 前端研发工程师
 * is a 前端工程师. A title is also compared without them, at a small discount
 * so that a role whose name carries the word (测试开发工程师, 运维开发工程师)
 * still wins on its exact name.
 */
const CJK_FILLER = /(?:开发|研发)(?=工程师)/g;
const FILLER_DISCOUNT = 0.95;

function withoutFiller(compact: string): string {
  return compact.replace(CJK_FILLER, '');
}

interface Phrase {
  nodeId: string;
  text: string;
  tokens: string[];
  cjk: boolean;
  /** The text without spaces, and without the filler (Chinese comparison). */
  compact: string;
  plain: string;
  /** A head noun or an `ALONE_ONLY_PHRASES` entry: matches only as the whole title. */
  aloneOnly: boolean;
  /** False for a phrase that is a bare head word once the filler is removed (开发工程师): it never matches through the filler. */
  fillerMatch: boolean;
  /** What the phrase scores as the whole title: 1, or less for an ambiguous word. */
  exact: number;
}

function buildPhrases(nodes: readonly TaxonomyNode[]): Phrase[] {
  const out: Phrase[] = [];
  for (const n of nodes) {
    const raw = [n.en, n.zh, ...n.synonyms.en, ...n.synonyms.zh];
    const seen = new Set<string>();
    for (const r of raw) {
      const text = normalizeTitle(r);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const compact = text.replace(/ /g, '');
      const plain = withoutFiller(compact);
      const ambiguous = Object.hasOwn(ALONE_ONLY_PHRASES, text);
      const aloneOnly = HEAD_NOUN_SET.has(text) || CJK_HEAD_WORD_SET.has(compact) || CJK_CROSS_DISCIPLINE.has(compact) || ambiguous;
      const fillerMatch = !CJK_HEAD_WORD_SET.has(plain);
      out.push({ nodeId: n.id, text, tokens: text.split(' '), cjk: CJK.test(text), compact, plain, aloneOnly, fillerMatch, exact: ambiguous ? MODIFIER_MATCH_SCORE : 1 });
    }
  }
  return out;
}

/** Words that make "architect" a software role and "developer" a software engineer. */
const SOFTWARE_CONTEXT: readonly string[] = (
  'software ai ml machine learning genai llm data cloud aws azure gcp java python dotnet csharp cpp golang go javascript typescript nodejs ' +
  'backend frontend fullstack full stack web mobile ios android api apis platform platforms systems system solution solutions enterprise ' +
  'application applications app apps integration integrations infrastructure devops security cyber cybersecurity network networks it ' +
  'technical technology tech digital database databases salesforce sap oracle servicenow workday dynamics microservices kubernetes ' +
  'blockchain crypto embedded firmware iot analytics bi erp crm saas identity storage compute middleware automation'
).split(/\s+/);

/** More words that mark a "developer" as a software one (languages, frameworks and products). */
const DEVELOPER_CONTEXT: readonly string[] = (
  'rust scala kotlin swift ruby rails php perl cobol mainframe abap apex sql plsql tsql etl react angular vue svelte django flask spring ' +
  'laravel wordpress drupal magento shopify sharepoint mulesoft pega appian rpa uipath powerbi tableau unity unreal game games ' +
  'tools tooling sdk ui ux client server code coding low'
).split(/\s+/);

/** Words that keep an "architect" in the building profession. */
const BUILDING_CONTEXT: readonly string[] = (
  'building buildings architectural architecture landscape residential commercial healthcare hospitality housing multifamily retail ' +
  'education k12 interiors interior urban registered licensed construction historic preservation civic studio aia ncarb revit job captain'
).split(/\s+/);

/**
 * Modifier words the taxonomy's own phrases do not carry. Each entry says:
 * beside this head noun, these words point at this role.
 */
export const EXPLICIT_MODIFIERS: ReadonlyArray<{ head: (typeof HEAD_NOUNS)[number]; role: string; words: readonly string[] }> = [
  // Chinese has two words (建筑师 / 架构师); 后端, 云 and 数据 cover mixed-language titles ("后端 Architect").
  { head: 'architect', role: 'software_architect', words: [...SOFTWARE_CONTEXT, '后端', '云', '数据'] },
  { head: 'architect', role: 'architect', words: BUILDING_CONTEXT },
  { head: 'developer', role: 'software_engineer', words: [...SOFTWARE_CONTEXT, ...DEVELOPER_CONTEXT] },
];

const ROLE_NODES = TAXONOMY_NODES.filter((n) => n.level === 3);
const ROLE_PHRASES = buildPhrases(ROLE_NODES);
const ALL_PHRASES = buildPhrases(TAXONOMY_NODES);
const NODE_BY_ID = new Map(TAXONOMY_NODES.map((n) => [n.id, n]));

/** Words that are never a modifier. */
const LEXICON_STOP = new Set(['and', 'of', 'in', 'the', 'for', 'to', 'a', 'an', 'on', 'at', 'with', 'or']);

/**
 * One line of the modifier lexicon: beside its head noun, these words
 * together point at this role. A taxonomy phrase with several modifiers
 * ("medical device engineer") counts only when the title has all of them, so
 * "device" alone never makes a title biomedical.
 */
interface LexiconEntry {
  role: string;
  words: string[];
  /** True for a one-word role phrase, which is a modifier beside every head noun and belongs to none. */
  anyHead: boolean;
}

/** The entries of one head noun, findable by any of their Latin words; entries with a Chinese word apart. */
interface HeadLexicon {
  byWord: Map<string, LexiconEntry[]>;
  chinese: LexiconEntry[];
}

function buildModifierLexicon(): ReadonlyMap<string, HeadLexicon> {
  const lexicon = new Map<string, HeadLexicon>(HEAD_NOUNS.map((h) => [h, { byWord: new Map(), chinese: [] }]));
  const isModifier = (word: string) => !!word && !LEXICON_STOP.has(word) && !LEVEL_TOKENS.has(word) && !HEAD_NOUN_SET.has(word);
  const add = (head: string, words: string[], role: string, anyHead = false) => {
    const kept = [...new Set(words.filter(isModifier))];
    if (!kept.length) return;
    const entry: LexiconEntry = { role, words: kept, anyHead };
    const target = lexicon.get(head)!;
    if (kept.some((w) => CJK.test(w))) {
      target.chinese.push(entry);
      return;
    }
    for (const w of kept) target.byWord.set(w, [...(target.byWord.get(w) ?? []), entry]);
  };
  for (const phrase of ROLE_PHRASES) {
    if (phrase.cjk || phrase.aloneOnly) continue;
    if (phrase.tokens.length === 1) {
      // A one-word role phrase is a modifier beside any head noun ("Nurse Manager").
      for (const head of HEAD_NOUNS) add(head, [phrase.text], phrase.nodeId, true);
      continue;
    }
    // Every role phrase of the form "<modifiers> <head noun>" gives its modifiers to its role.
    const head = phrase.tokens[phrase.tokens.length - 1]!;
    if (!HEAD_NOUN_SET.has(head)) continue;
    const modifiers = phrase.tokens.slice(0, -1);
    // A phrase that needs a level word to name its role must not vote without it: "lead software
    // engineer" would give "software" to the tech lead, "smart contract engineer" "smart" to blockchain.
    if (modifiers.some((word) => LEVEL_TOKENS.has(word))) continue;
    add(head, modifiers, phrase.nodeId);
  }
  for (const entry of EXPLICIT_MODIFIERS) {
    if (!NODE_BY_ID.has(entry.role)) continue;
    for (const word of entry.words) add(entry.head, [normalizeTitle(word)], entry.role);
  }
  return lexicon;
}

const MODIFIER_LEXICON = buildModifierLexicon();

/**
 * The roles the lexicon lists for a head noun: every role with a phrase that
 * ends on it, or an explicit modifier beside it ("architect" → the building
 * profession, software, cloud, data, security and network architects …).
 * Empty for a word that is not a head noun.
 */
export function headNounRoles(head: string): string[] {
  const lexicon = MODIFIER_LEXICON.get(head);
  if (!lexicon) return [];
  const out = new Set<string>();
  for (const phrase of ROLE_PHRASES) if (phrase.text === head) out.add(phrase.nodeId);
  for (const entries of lexicon.byWord.values()) for (const e of entries) if (!e.anyHead) out.add(e.role);
  for (const e of lexicon.chinese) out.add(e.role);
  return [...out];
}

/** Latin words and Chinese runs of a normalized title, split where the script changes ("后端architect" → 后端, architect). */
function scriptTokens(text: string): string[] {
  return text.match(/[㐀-鿿豈-﫿]+|[^㐀-鿿豈-﫿\s]+/g) ?? [];
}

/** One form a title is matched in, with what the comparisons need worked out once. */
interface TitleVariant {
  text: string;
  tokens: string[];
  tokenSet: Set<string>;
  cjk: boolean;
  compact: string;
  plain: string;
  /** Words and Chinese runs, split where the script changes. */
  script: string[];
  scriptSet: Set<string>;
  /** Index in `script` of the head noun (the last head-noun word: English titles end on the role), or -1. */
  headIndex: number;
}

function toVariant(text: string): TitleVariant {
  const tokens = text.split(' ');
  const cjk = CJK.test(text);
  const compact = cjk ? text.replace(/ /g, '') : text;
  const script = cjk ? scriptTokens(text) : tokens;
  let headIndex = -1;
  for (let i = script.length - 1; i >= 0; i--) {
    if (HEAD_NOUN_SET.has(script[i]!)) {
      headIndex = i;
      break;
    }
  }
  return { text, tokens, tokenSet: new Set(tokens), cjk, compact, plain: cjk ? withoutFiller(compact) : compact, script, scriptSet: new Set(script), headIndex };
}

/**
 * The English head noun a Chinese head word stands for in a mixed-language
 * title ("Machine Learning 工程師"), in both scripts: such titles are common
 * in Taiwan and Hong Kong postings.
 */
const CJK_HEAD_TO_ENGLISH: Readonly<Record<string, string>> = {
  工程师: 'engineer',
  工程師: 'engineer',
  设计师: 'designer',
  設計師: 'designer',
  分析师: 'analyst',
  分析師: 'analyst',
  顾问: 'consultant',
  顧問: 'consultant',
  经理: 'manager',
  經理: 'manager',
  专员: 'specialist',
  專員: 'specialist',
  架构师: 'architect',
  架構師: 'architect',
};

/** "machine learning 工程师" → "machine learning engineer"; null unless the title is Latin words followed by one Chinese head word. */
function englishHeadVariant(text: string): string | null {
  const tokens = scriptTokens(text);
  if (tokens.length < 2) return null;
  const head = CJK_HEAD_TO_ENGLISH[tokens[tokens.length - 1]!];
  if (!head || tokens.slice(0, -1).some((t) => CJK.test(t))) return null;
  return [...tokens.slice(0, -1), head].join(' ');
}

/**
 * The forms a title is matched in: as written and with level words removed,
 * and for a mixed-language title also with its closing Chinese head word read
 * as the English head noun.
 */
function titleVariants(title: string): TitleVariant[] {
  const raw = normalizeTitle(title);
  if (!raw) return [];
  const texts = [raw, stripLevelWords(raw)];
  if (CJK.test(raw)) {
    for (const t of [...texts]) {
      const mixed = englishHeadVariant(t);
      if (mixed) texts.push(mixed);
    }
  }
  return [...new Set(texts.filter(Boolean))].map(toVariant);
}

/** The head noun of a title ("Java Backend Architect" → "architect"), or null. */
export function headNounOf(title: string): string | null {
  for (const v of titleVariants(title)) if (v.headIndex >= 0) return v.script[v.headIndex]!;
  return null;
}

/** The lexicon entries that share a word with the title, each with the words it shares. */
function modifierHits(v: TitleVariant): Array<{ entry: LexiconEntry; hits: string[] }> {
  if (v.headIndex < 0 || v.script.length < 2) return [];
  const lexicon = MODIFIER_LEXICON.get(v.script[v.headIndex]!)!;
  const latin = new Set<string>();
  const chinese: string[] = [];
  v.script.forEach((t, i) => {
    if (i === v.headIndex) return;
    if (CJK.test(t)) chinese.push(t);
    else latin.add(t);
  });
  const seen = new Set<LexiconEntry>();
  const out: Array<{ entry: LexiconEntry; hits: string[] }> = [];
  for (const word of latin) {
    for (const entry of lexicon.byWord.get(word) ?? []) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push({ entry, hits: entry.words.filter((w) => latin.has(w)) });
    }
  }
  if (chinese.length) {
    // A Chinese run carries its modifier inside it ("云数据" names 云 and 数据).
    for (const entry of lexicon.chinese) {
      const hits = entry.words.filter((w) => (CJK.test(w) ? chinese.some((run) => run.includes(w)) : latin.has(w)));
      if (hits.length) out.push({ entry, hits });
    }
  }
  return out;
}

/**
 * The role the modifiers of "<modifiers> <head noun>" select: the one sharing
 * the most modifier words with the title. A generic role gives way to a
 * specific one on equal count; two specific roles on equal count are a tie
 * and there is no pick (enrichment decides).
 */
function lexiconPick(v: TitleVariant): { id: string; matched: string } | null {
  const shared = new Map<string, Set<string>>();
  for (const { entry, hits } of modifierHits(v)) {
    if (hits.length !== entry.words.length) continue;
    const words = shared.get(entry.role) ?? new Set<string>();
    for (const w of hits) words.add(w);
    shared.set(entry.role, words);
  }
  if (!shared.size) return null;
  let most = 0;
  for (const words of shared.values()) most = Math.max(most, words.size);
  const top = [...shared.entries()].filter(([, words]) => words.size === most);
  const specific = top.filter(([id]) => !NODE_BY_ID.get(id)?.generic);
  const winners = specific.length ? specific : top;
  if (winners.length !== 1) return null;
  const [id, words] = winners[0]!;
  return { id, matched: `${[...words].join(' ')} ${v.script[v.headIndex]!}` };
}

/**
 * Every role the modifier lexicon connects to this title, most shared words
 * first: what enrichment offers the model when the title alone does not
 * decide. A role counts here as soon as it shares one modifier word, a wider
 * net than the match itself. Empty for a title without a head noun.
 */
export function lexiconCandidates(title: string): string[] {
  const best = new Map<string, number>();
  for (const v of titleVariants(title)) {
    for (const { entry, hits } of modifierHits(v)) {
      const weight = hits.length + (hits.length === entry.words.length ? 0.5 : 0);
      if (weight > (best.get(entry.role) ?? 0)) best.set(entry.role, weight);
    }
  }
  return [...best.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
}

function containsTokensInOrder(hay: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function scorePhrase(v: TitleVariant, phrase: Phrase): number {
  if (v.text === phrase.text) return phrase.exact;
  if (phrase.cjk || v.cjk) {
    const compactTitle = v.cjk ? v.compact : v.text.replace(/ /g, '');
    // A head noun or an ambiguous word is the role only when it is the whole title.
    if (phrase.aloneOnly) return compactTitle === phrase.compact ? phrase.exact : 0;
    // An English phrase in a mixed-language title matches by whole words, never inside another word.
    if (!phrase.cjk) for (const t of phrase.tokens) if (!v.scriptSet.has(t)) return 0;
    if (compactTitle.includes(phrase.compact)) return 0.5 + 0.5 * (phrase.compact.length / compactTitle.length);
    if (!v.cjk || !phrase.fillerMatch || (v.plain === v.compact && phrase.plain === phrase.compact) || !v.plain.includes(phrase.plain)) return 0;
    return FILLER_DISCOUNT * (0.5 + 0.5 * (phrase.plain.length / v.plain.length));
  }
  if (phrase.aloneOnly) return 0;
  if (phrase.tokens.length === 1) {
    // Beside a head noun a one-word phrase is a modifier: the lexicon counts it.
    if (v.headIndex >= 0 || !v.tokenSet.has(phrase.text)) return 0;
    return Math.min(0.99, 0.5 + 0.5 / v.tokens.length + 0.05);
  }
  for (const t of phrase.tokens) if (!v.tokenSet.has(t)) return 0;
  const coverage = phrase.tokens.length / v.tokens.length;
  const contiguous = containsTokensInOrder(v.tokens, phrase.tokens) ? 0.05 : 0;
  return Math.min(0.99, 0.5 + 0.5 * coverage + contiguous);
}

export interface TitleMatch {
  id: string;
  level: TaxonomyLevel;
  score: number;
  /** The normalized label or synonym that matched (for the modifier lexicon: the modifier words and the head noun). */
  matched: string;
}

/** What follows the phrase in a Chinese title ('' when the phrase ends it, or is not in it as written). */
function restAfter(v: TitleVariant, phrase: Phrase): string {
  const at = v.compact.lastIndexOf(phrase.compact);
  if (at >= 0) return v.compact.slice(at + phrase.compact.length);
  const inPlain = v.plain.lastIndexOf(phrase.plain);
  return inPlain >= 0 ? v.plain.slice(inPlain + phrase.plain.length) : '';
}

/**
 * A Chinese title ends on its role: a phrase that another role's phrase
 * follows is that role's modifier (新媒体 in 新媒体销售, 法律顾问 in 法律顾问销售,
 * 数据分析 in 数据分析产品经理) and does not score. A catch-all role's phrase
 * (开发工程师) displaces nothing: the words before it are what make it specific.
 */
function dropModifierPhrases(v: TitleVariant, scores: Float64Array): void {
  const hits: Array<{ index: number; phrase: Phrase; rest: string }> = [];
  for (let i = 0; i < ROLE_PHRASES.length; i++) {
    const phrase = ROLE_PHRASES[i]!;
    if (scores[i]! > 0 && v.text !== phrase.text) hits.push({ index: i, phrase, rest: restAfter(v, phrase) });
  }
  if (hits.length < 2) return;
  for (const a of hits) {
    if (!a.rest) continue;
    const restPlain = withoutFiller(a.rest);
    const followed = hits.some(
      (b) =>
        b.phrase.nodeId !== a.phrase.nodeId &&
        !NODE_BY_ID.get(b.phrase.nodeId)?.generic &&
        (a.rest.includes(b.phrase.compact) || (b.phrase.fillerMatch && restPlain.includes(b.phrase.plain))),
    );
    if (followed) scores[a.index] = 0;
  }
}

/** Every role a title matches at any score, best first. */
function rankTitle(title: string): TitleMatch[] {
  const variants = titleVariants(title);
  if (!variants.length) return [];
  // Per phrase, over the forms of the title: its best score, and where a one-word phrase sits (later wins a tie).
  const score = new Float64Array(ROLE_PHRASES.length);
  const end = new Int32Array(ROLE_PHRASES.length);
  const inVariant = new Float64Array(ROLE_PHRASES.length);
  for (const v of variants) {
    for (let i = 0; i < ROLE_PHRASES.length; i++) inVariant[i] = scorePhrase(v, ROLE_PHRASES[i]!);
    if (v.cjk) dropModifierPhrases(v, inVariant);
    for (let i = 0; i < ROLE_PHRASES.length; i++) {
      const sc = inVariant[i]!;
      if (!sc || sc < score[i]!) continue;
      const phrase = ROLE_PHRASES[i]!;
      const at = phrase.tokens.length === 1 && !phrase.cjk && !v.cjk ? v.tokens.lastIndexOf(phrase.text) + 1 : 0;
      if (sc > score[i]! || at > end[i]!) end[i] = at;
      score[i] = sc;
    }
  }
  // `named`: 1 for a role phrase found in the title, 0 for a pick of the modifier lexicon (the phrase wins a tie).
  const best = new Map<string, TitleMatch & { end: number; named: number }>();
  const offer = (nodeId: string, rawScore: number, matched: string, named: number, at = 0) => {
    const sc = Math.round((NODE_BY_ID.get(nodeId)?.generic ? rawScore - 0.15 : rawScore) * 1000) / 1000;
    const cur = best.get(nodeId);
    if (!cur || sc > cur.score || (sc === cur.score && (named > cur.named || (named === cur.named && at > cur.end)))) {
      best.set(nodeId, { id: nodeId, level: 3, score: sc, matched, end: at, named });
    }
  };
  for (let i = 0; i < ROLE_PHRASES.length; i++) if (score[i]) offer(ROLE_PHRASES[i]!.nodeId, score[i]!, ROLE_PHRASES[i]!.text, 1, end[i]!);
  // "<modifiers> <head noun>": the modifiers decide.
  for (const v of variants) {
    const pick = lexiconPick(v);
    if (pick) offer(pick.id, MODIFIER_MATCH_SCORE, pick.matched, 0);
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || b.named - a.named || b.end - a.end || b.matched.length - a.matched.length || a.id.localeCompare(b.id))
    .map(({ id, level, score: sc, matched }) => ({ id, level, score: sc, matched }));
}

/** Titles repeat (one posting is matched for many readers), so the last few thousand results are kept. */
const RANK_CACHE_MAX = 4096;
const rankCache = new Map<string, TitleMatch[]>();

function rankTitleCached(title: string): TitleMatch[] {
  const hit = rankCache.get(title);
  if (hit) return hit;
  const ranked = rankTitle(title);
  if (rankCache.size >= RANK_CACHE_MAX) rankCache.delete(rankCache.keys().next().value!);
  rankCache.set(title, ranked);
  return ranked;
}

/** Ranked role matches for a posting title (best first). */
export function matchTitle(title: string, options: { limit?: number; minScore?: number } = {}): TitleMatch[] {
  const limit = options.limit ?? 3;
  const minScore = options.minScore ?? 0.6;
  const out: TitleMatch[] = [];
  for (const m of rankTitleCached(title)) {
    if (m.score < minScore || out.length >= limit) break;
    out.push({ ...m });
  }
  return out;
}

/**
 * The roles a title names only through a word that counts alone: a head noun
 * with a role of its own ("architect", "developer", "consultant") or an
 * `ALONE_ONLY_PHRASES` word, standing inside a longer title. Such a word used
 * to file the whole title under its role ("Java Backend Architect" under the
 * building profession, "Principal Engineer" under school principals). A
 * backfill uses this to tell a role stored by that retired rule from one a
 * model chose. Empty when the title is the word itself.
 */
export function oneWordRolesIn(title: string): string[] {
  const out = new Set<string>();
  const variants = titleVariants(title);
  for (const phrase of ROLE_PHRASES) {
    if (!phrase.aloneOnly || ALONE_ONLY_SINCE_SM2.has(phrase.text)) continue;
    // The word alone (after level words) is the role by name, not a retired match.
    if (variants.some((v) => v.compact === phrase.compact || v.text === phrase.text)) continue;
    if (variants.some((v) => (phrase.cjk ? v.cjk && v.compact.includes(phrase.compact) : v.scriptSet.has(phrase.text)))) out.add(phrase.nodeId);
  }
  return [...out];
}

/** The single best role for a title, or null when nothing matches well enough. */
export function bestTaxonomyMatch(title: string, minScore = 0.6): TitleMatch | null {
  return matchTitle(title, { limit: 1, minScore })[0] ?? null;
}

export interface TaxonomySuggestion {
  id: string;
  level: TaxonomyLevel;
  label: string;
  /** "Role group · Category" for roles, the category for groups, null for categories. */
  context: string | null;
  matched: string;
}

/**
 * Typeahead over categories, groups and roles. Needs 2+ characters (1 for
 * Chinese). Ranking: exact > label prefix > synonym prefix > word prefix >
 * contains.
 */
export function searchTaxonomy(q: string, options: { locale?: string; limit?: number; levels?: TaxonomyLevel[] } = {}): TaxonomySuggestion[] {
  const query = normalizeTitle(q);
  if (!query || (!CJK.test(query) && query.length < 2)) return [];
  const locale = options.locale ?? 'en';
  const limit = options.limit ?? 10;
  const levels = new Set(options.levels ?? [1, 2, 3]);
  const scored = new Map<string, { score: number; matched: string }>();
  for (const phrase of ALL_PHRASES) {
    const node = NODE_BY_ID.get(phrase.nodeId)!;
    if (!levels.has(node.level)) continue;
    const isLabel = phrase.text === normalizeTitle(node.en) || phrase.text === normalizeTitle(node.zh);
    let score = 0;
    if (phrase.text === query) score = 1;
    else if (phrase.text.startsWith(query)) score = isLabel ? 0.9 : 0.8;
    else if (phrase.tokens.some((t) => t.startsWith(query)) || phrase.text.includes(` ${query}`)) score = isLabel ? 0.75 : 0.7;
    else if (phrase.text.includes(query)) score = 0.6;
    if (!score) continue;
    const cur = scored.get(node.id);
    if (!cur || score > cur.score) scored.set(node.id, { score, matched: phrase.text });
  }
  return [...scored.entries()]
    .sort(([ia, a], [ib, b]) => b.score - a.score || NODE_BY_ID.get(ia)!.level - NODE_BY_ID.get(ib)!.level || ia.localeCompare(ib))
    .slice(0, limit)
    .map(([id, s]) => {
      const node = NODE_BY_ID.get(id)!;
      const ancestors = taxonomyAncestors(id).slice(1);
      return {
        id,
        level: node.level,
        label: taxonomyLabel(id, locale)!,
        context: ancestors.length ? ancestors.map((a) => taxonomyLabel(a.id, locale)).join(' · ') : null,
        matched: s.matched,
      };
    });
}
