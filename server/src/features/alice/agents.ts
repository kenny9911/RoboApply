// server/src/features/alice/agents.ts — Alice's model subagents.
//
// Each is a BaseAgent: one structured JSON call, retries, per-agent cost
// lines, the strict `content` language directive (they author what the
// person reads) and the output-language reminder as the first line of the
// user message. Parsers are tolerant (fences and stray prose are dropped);
// the orchestrator cleans every value through contract.ts before it is
// stored or shown, so a parser here only has to find the JSON.
//
//   AliceIntakeAgent         an answer → facts learned + the next question
//   AliceGoalAnalystAgent    resume + brief → the open question and two directions
//   AliceProfileWriterAgent  analysis + brief → two job profiles
//   AliceProfileEditorAgent  a profile + a comment → the next version and what changed
//   AliceRouterAgent         free text after the intake → one action
//   AliceReporterAgent       computed application facts → two or three sentences
//
// Model keys (LLM gateway areas, docs/llm-gateway.md): the conversation and
// the profiles use `onboarding` (Assistant), the router `intentParser`
// (Assistant), the report `insights` (Insights). An unassigned key resolves
// exactly as before.

import { BaseAgent } from '../../agents/BaseAgent.js';
import { getModelSetting } from '../../lib/llm/llmModels.js';
import type { ReasoningEffort } from '../../services/llm/reasoningEffort.js';
import type { AliceAnalysis, AliceBrief, AliceJobProfile, AliceReportFacts, AliceTopicId } from './contract.js';

/** Parse the first JSON object of a model answer (fences and stray prose tolerated). */
export function parseJsonObject(response: string): Record<string, unknown> | null {
  const cleaned = (response || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(cleaned);
  if (direct) return direct;
  const match = cleaned.match(/\{[\s\S]*\}/);
  return match ? tryParse(match[0]) : null;
}

export interface AliceRunOptions {
  requestId?: string;
  locale: string;
  signal?: AbortSignal;
}

const conversationModel = (): string | undefined => getModelSetting('onboarding') ?? undefined;
const routerModel = (): string | undefined => getModelSetting('intentParser') ?? getModelSetting('fast') ?? undefined;
const reportModel = (): string | undefined => getModelSetting('insights') ?? undefined;

/** The profile JSON shape every profile-writing agent answers with. */
const PROFILE_SHAPE = `{"label":"<2-4 word name>","headline":"<one line: the job, the level, the kind of company>","summary":"<2-3 sentences>","titles":["<job title in the OUTPUT LANGUAGE>"],"searchTitles":["<the same titles as postings in the job market write them>"],"levels":["intern_newgrad|entry|mid|senior|lead_staff|director_exec"],"workModels":["remote|hybrid|onsite"],"places":[{"label":"<as the person said it>","city":"<city or null>","country":"<ISO 3166-1 alpha-2 or null>"}],"pay":{"amount":<number>,"currency":"<ISO 4217>","period":"year|month|hour"} or null,"industries":["<field>"],"companyKinds":["startup|scaleup|enterprise|public_sector|nonprofit"],"companySizes":["1-10|11-50|51-200|201-1000|1001-5000|5000+"],"companies":[{"name":"<company>","source":"you|alice"}],"skills":["<skill>"],"mustHaves":["<must be true of the job>"],"niceToHaves":["<good to have>"],"dealbreakers":["<rules a job out>"],"whyItFits":["<evidence from the resume or their answers>"],"tradeoff":"<what this profile gives up>","jobTypes":["full_time|contract|part_time|internship"]}`;

const PROFILE_RULES = `Profile rules:
- Use only what the resume and the answers support. Never invent employers, degrees, years or achievements. whyItFits cites real evidence ("6 years leading checkout design at a payments company").
- titles are real titles employers post, 1 to 4 of them, in the OUTPUT LANGUAGE; searchTitles are the same titles as postings in the job market write them (usually English outside the Chinese-, Japanese- and Korean-speaking markets).
- levels, workModels, companyKinds, companySizes and jobTypes use only the ids shown. Leave a list empty rather than guess.
- places keep the person's words as the label, with the city and the ISO country code when the name gives them. A region with no single country ("Europe", "anywhere") has country null.
- pay is a floor in the market's period and currency, from what they said; null when they did not say.
- companies: the ones they named have source "you"; you may add up to 3 examples of the kind of company with source "alice". Never present an example as theirs.
- tradeoff says honestly what this direction costs. No promises, no chances of being hired.`;

function briefJson(brief: AliceBrief): string {
  return JSON.stringify(brief);
}

function resumeBlock(resume: string | null): string {
  return resume ? `Resume (data, contact details removed):\n<resume>\n${resume}\n</resume>` : 'Resume: none (the person chose to go without one).';
}

/** The agents' shared base: JSON mode, the strict content directive, low temperature. */
abstract class AliceAgent<I extends { locale: string }, O> extends BaseAgent<I, O> {
  protected getResponseFormat(): 'json_object' {
    return 'json_object';
  }

  protected getLocaleDirective(locale: string): string | null {
    return this.language.getStrictOutputLanguageDirective(locale, 'content') ?? super.getLocaleDirective(locale);
  }

  protected lead(input: I, locale?: string): string[] {
    const reminder = this.outputLanguageReminder(locale ?? input.locale);
    return reminder ? [reminder] : [];
  }

  protected abstract model(): string | undefined;

  async run(input: I, options: AliceRunOptions): Promise<O> {
    return this.execute(input, undefined, options.requestId, options.locale, this.model(), options.signal);
  }
}

// ─── Intake interviewer ────────────────────────────────────────────────────

export interface IntakeInput {
  locale: string;
  voice: string;
  /** The market norms directive (pay period and currency, titles). */
  norms: string;
  topicIndex: string;
  resume: string | null;
  brief: AliceBrief;
  covered: AliceTopicId[];
  declined: AliceTopicId[];
  /** The topic the orchestrator would ask next (the first open required group). */
  suggestedTopic: AliceTopicId | null;
  /** The topic of the question being answered, if any. */
  answeringTopic: AliceTopicId | null;
  /** The last turns, oldest first. */
  history: Array<{ role: 'user' | 'alice'; text: string }>;
  /** The person's answer; null for the first question. */
  answer: string | null;
}

export interface IntakeOutput {
  learned: Record<string, unknown>;
  cleared: string[];
  declined: string[];
  ack: string;
  question: string;
  topic: string | null;
  quickReplies: string[];
  multiSelect: boolean;
  wantsProfiles: boolean;
}

export function parseIntake(response: string): IntakeOutput {
  const p = parseJsonObject(response);
  if (!p) throw new Error('AliceIntakeAgent: unparseable response');
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    learned: p.learned && typeof p.learned === 'object' && !Array.isArray(p.learned) ? (p.learned as Record<string, unknown>) : {},
    cleared: strings(p.cleared),
    declined: strings(p.declined),
    ack: typeof p.ack === 'string' ? p.ack : '',
    question: typeof p.question === 'string' ? p.question : '',
    topic: typeof p.topic === 'string' ? p.topic : null,
    quickReplies: strings(p.quickReplies),
    multiSelect: p.multiSelect === true,
    wantsProfiles: p.wantsProfiles === true,
  };
}

export class AliceIntakeAgent extends AliceAgent<IntakeInput, IntakeOutput> {
  constructor() {
    super('AliceIntakeAgent');
  }
  protected model() {
    return conversationModel();
  }
  protected getTemperature(): number {
    return 0.4;
  }
  protected getMaxTokens(): number {
    return 1400;
  }
  protected getReasoningMaxTokens(): number {
    return 500;
  }
  /** A conversational turn: little thinking, a quick answer (measured: 36 s at the provider's default, Gemini 3.8 Flash). */
  protected getReasoningEffort(): ReasoningEffort {
    return 'low';
  }
  protected getAgentPrompt(): string {
    return `You run the intake conversation of a job search. From the person's latest answer you record what you learned, then ask the next question.

Return ONE JSON object, nothing else:
{"learned":{<only the brief fields this answer gives, with their whole new value>},"cleared":["<brief field the person took back>"],"declined":["<topic id they skipped or have no preference on>"],"ack":"<one short, warm sentence that reflects what they said in plain words (never 'I have recorded' or 'noted'), or an answer to their question; empty when there is nothing to say>","question":"<the next question, one only>","topic":"<the topic id of that question>","quickReplies":["<short answer they can tap>"],"multiSelect":false,"wantsProfiles":false}

Brief fields and their values: roles (titles, list), levels (ids intern_newgrad|entry|mid|senior|lead_staff|director_exec), workModels (remote|hybrid|onsite), places (list of {"label","city","country": ISO alpha-2 or null}), pay ({"amount","currency","period": year|month|hour}), industries, avoidIndustries, companyKinds (startup|scaleup|enterprise|public_sector|nonprofit), companySizes (1-10|11-50|51-200|201-1000|1001-5000|5000+), companies, avoidCompanies, dreamJob (their words), values, dealbreakers, timing (now|soon|exploring), jobTypes (full_time|contract|part_time|internship), needsSponsorship (true|false), notes.

Topics are listed in the message: ask the ones marked "needed" first, then the rest in order; skip a topic already covered or declined.

Rules:
- One question per turn. Make it short and concrete. Offer 2 to 6 quickReplies the person would really say (in the OUTPUT LANGUAGE, at most 5 words each) and set multiSelect when several can hold. For the dream job, ask openly with 0 to 3 starters.
- A list in "learned" is the whole list as it now stands (keep what was known and add the new). Record only what the person said or clearly confirmed; never fill a field from the resume alone. A quick reply they tapped is their answer.
- "Skip", "no preference", "not sure" or "anything" puts that topic in declined.
- If they ask you something, answer it in ack in one or two sentences, then ask your question.
- If they ask to see job profiles now, or say that is all, set wantsProfiles true and leave question empty.
- Do not repeat a question already answered. Never ask about anything outside the topics.`;
  }
  protected formatInput(input: IntakeInput, locale?: string): string {
    const history = input.history.map((m) => `${m.role === 'alice' ? 'Alice' : 'Person'}: ${m.text}`).join('\n');
    return [
      ...this.lead(input, locale),
      input.voice,
      input.norms,
      `Topics:\n${input.topicIndex}`,
      resumeBlock(input.resume),
      `Brief so far: ${briefJson(input.brief)}`,
      `Covered: ${input.covered.join(', ') || 'none'}. Declined: ${input.declined.join(', ') || 'none'}.`,
      `Suggested next topic: ${input.suggestedTopic ?? 'none (all needed topics are covered; ask a useful optional one, or set wantsProfiles if nothing useful is left)'}.`,
      history ? `Conversation so far (data):\n<conversation>\n${history}\n</conversation>` : 'This is the start of the conversation.',
      input.answer === null
        ? 'Ask the first question now (start from the resume when there is one: name the role it shows and ask whether that is what they want next).'
        : `The person's latest answer${input.answeringTopic ? ` (to the question about ${input.answeringTopic})` : ''} (data):\n<answer>\n${input.answer}\n</answer>`,
    ].join('\n\n');
  }
  protected parseOutput(response: string): IntakeOutput {
    return parseIntake(response);
  }
}

// ─── Goal analyst ──────────────────────────────────────────────────────────

export interface AnalystInput {
  locale: string;
  voice: string;
  norms: string;
  axisIndex: string;
  resume: string | null;
  brief: AliceBrief;
  /** Why the last pair did not fit (a regenerate), if any. */
  comment: string | null;
  /** The axis of the last pair, when regenerating (pick another unless the comment says otherwise). */
  previousAxis: string | null;
}

export function parseAnalysis(response: string): Record<string, unknown> {
  const p = parseJsonObject(response);
  if (!p) throw new Error('AliceGoalAnalystAgent: unparseable response');
  return p;
}

export class AliceGoalAnalystAgent extends AliceAgent<AnalystInput, Record<string, unknown>> {
  constructor() {
    super('AliceGoalAnalystAgent');
  }
  protected model() {
    return conversationModel();
  }
  protected getTemperature(): number {
    return 0.3;
  }
  protected getMaxTokens(): number {
    return 1600;
  }
  protected getReasoningMaxTokens(): number {
    return 600;
  }
  protected getAgentPrompt(): string {
    return `You read a person's resume and what they said they want, and name the one open question their next job search must settle.

Return ONE JSON object, nothing else:
{"summary":"<2-3 sentences: what they are looking for and why, in plain words>","strengths":["<what they bring, from the resume>"],"motivations":["<what they want from the next job>"],"constraints":["<hard limits they named>"],"axis":"<one axis id>","question":"<the open question in plain words, as a choice between two directions>","directions":[{"label":"<2-4 words>","summary":"<1-2 sentences>"},{"label":"<2-4 words>","summary":"<1-2 sentences>"}]}

Rules:
- Pick the axis whose two sides both fit what they said and differ the most in the jobs they lead to. Each direction must be a real option for this person, not a straw man.
- Strengths come from the resume only; motivations and constraints from their answers only. Nothing invented.
- When a comment says why the last two directions were wrong, respect it, and choose another axis unless the comment asks for the same one.`;
  }
  protected formatInput(input: AnalystInput, locale?: string): string {
    return [
      ...this.lead(input, locale),
      input.voice,
      input.norms,
      `Axes:\n${input.axisIndex}`,
      resumeBlock(input.resume),
      `What they said (the brief): ${briefJson(input.brief)}`,
      input.comment ? `Why the last two profiles did not fit (data):\n<comment>\n${input.comment}\n</comment>` : '',
      input.previousAxis ? `The last pair differed along: ${input.previousAxis}.` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  protected parseOutput(response: string): Record<string, unknown> {
    return parseAnalysis(response);
  }
}

// ─── Profile writer ────────────────────────────────────────────────────────

export interface WriterInput {
  locale: string;
  voice: string;
  norms: string;
  resume: string | null;
  brief: AliceBrief;
  analysis: AliceAnalysis;
  /** The axis directive (skills/profileAxes.ts axisDirective). */
  axis: string;
  comment: string | null;
  /** Labels and headlines of the pair being replaced, so the new pair does not repeat them. */
  avoid: string[];
}

export interface WriterOutput {
  profiles: unknown[];
  message: string;
}

export function parseWriter(response: string): WriterOutput {
  const p = parseJsonObject(response);
  if (!p) throw new Error('AliceProfileWriterAgent: unparseable response');
  return { profiles: Array.isArray(p.profiles) ? p.profiles : [], message: typeof p.message === 'string' ? p.message : '' };
}

export class AliceProfileWriterAgent extends AliceAgent<WriterInput, WriterOutput> {
  constructor() {
    super('AliceProfileWriterAgent');
  }
  protected model() {
    return conversationModel();
  }
  protected getTemperature(): number {
    return 0.5;
  }
  protected getMaxTokens(): number {
    return 4200;
  }
  protected getReasoningMaxTokens(): number {
    return 1200;
  }
  protected getAgentPrompt(): string {
    return `You write two job profiles for one person: two clear pictures of the job they could aim for next, so they can say which is closer.

Return ONE JSON object, nothing else:
{"profiles":[${PROFILE_SHAPE}, <the second profile, same shape>],"message":"<one or two sentences from Alice to the person, introducing the two and asking which is closer>"}

${PROFILE_RULES}
- Profile A follows the first direction, profile B the second, and they differ where the axis says. Everything the person asked for in common (their places, pay floor, dealbreakers) holds in both.
- Do not repeat a profile listed under "avoid".`;
  }
  protected formatInput(input: WriterInput, locale?: string): string {
    return [
      ...this.lead(input, locale),
      input.voice,
      input.norms,
      resumeBlock(input.resume),
      `What they said (the brief): ${briefJson(input.brief)}`,
      `The reading of their goal: ${JSON.stringify(input.analysis)}`,
      input.axis,
      input.comment ? `What they said about the last pair (data):\n<comment>\n${input.comment}\n</comment>` : '',
      input.avoid.length ? `Avoid (the last pair): ${input.avoid.join(' | ')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  protected parseOutput(response: string): WriterOutput {
    return parseWriter(response);
  }
}

// ─── Profile editor ────────────────────────────────────────────────────────

export interface EditorInput {
  locale: string;
  voice: string;
  norms: string;
  resume: string | null;
  brief: AliceBrief;
  profile: AliceJobProfile;
  comment: string;
  /** The other draft, for context ("more like the other one"). */
  other: AliceJobProfile | null;
}

export interface EditorOutput {
  profile: unknown;
  notes: string[];
  message: string;
  learned: Record<string, unknown>;
}

export function parseEditor(response: string): EditorOutput {
  const p = parseJsonObject(response);
  if (!p) throw new Error('AliceProfileEditorAgent: unparseable response');
  return {
    profile: p.profile,
    notes: Array.isArray(p.notes) ? p.notes.filter((x): x is string => typeof x === 'string') : [],
    message: typeof p.message === 'string' ? p.message : '',
    learned: p.learned && typeof p.learned === 'object' && !Array.isArray(p.learned) ? (p.learned as Record<string, unknown>) : {},
  };
}

export class AliceProfileEditorAgent extends AliceAgent<EditorInput, EditorOutput> {
  constructor() {
    super('AliceProfileEditorAgent');
  }
  protected model() {
    return conversationModel();
  }
  protected getTemperature(): number {
    return 0.3;
  }
  protected getMaxTokens(): number {
    return 3000;
  }
  protected getReasoningMaxTokens(): number {
    return 900;
  }
  protected getAgentPrompt(): string {
    return `You revise one job profile from the person's comment. Change what the comment asks for and what follows from it; keep everything else exactly as it is.

Return ONE JSON object, nothing else:
{"profile":${PROFILE_SHAPE},"notes":["<what you changed and why, one short line each>"],"message":"<one or two sentences from Alice: what changed, and a question only if something is unclear>","learned":{<brief fields the comment states, e.g. {"dealbreakers":["no travel"]}>}}

${PROFILE_RULES}
- Keep the label unless the comment changes the direction itself.
- If the comment asks for something the resume cannot support (a level far above it), make the change and say plainly in notes what it means, without discouraging them.
- If the comment changes nothing in the profile, return it unchanged with empty notes and say so in message.`;
  }
  protected formatInput(input: EditorInput, locale?: string): string {
    return [
      ...this.lead(input, locale),
      input.voice,
      input.norms,
      resumeBlock(input.resume),
      `What they said before (the brief): ${briefJson(input.brief)}`,
      `The current profile: ${JSON.stringify(input.profile)}`,
      input.other ? `The other profile they were shown: ${JSON.stringify({ label: input.other.label, headline: input.other.headline, titles: input.other.titles, levels: input.other.levels, workModels: input.other.workModels, companyKinds: input.other.companyKinds })}` : '',
      `Their comment (data):\n<comment>\n${input.comment}\n</comment>`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  protected parseOutput(response: string): EditorOutput {
    return parseEditor(response);
  }
}

// ─── Router ────────────────────────────────────────────────────────────────

export const ROUTER_ACTIONS = ['choose', 'refine', 'regenerate', 'save', 'find_jobs', 'report', 'set_reminder', 'clear_reminder', 'new_profile', 'answer'] as const;
export type RouterAction = (typeof ROUTER_ACTIONS)[number];

export interface RouterInput {
  locale: string;
  voice: string;
  stage: string;
  today: string;
  message: string;
  /** The drafts while choosing: id, label, headline. */
  drafts: Array<{ id: string; label: string; headline: string }>;
  /** The current or saved profile's headline, if any. */
  profile: string | null;
  applications: Array<{ entryId: string; company: string | null; title: string | null; status: string }>;
}

export interface RouterOutput {
  action: RouterAction;
  draftId: 'a' | 'b' | null;
  comment: string;
  entryIds: string[];
  date: string | null;
  reply: string;
}

export function parseRouter(response: string): RouterOutput {
  const p = parseJsonObject(response);
  if (!p) throw new Error('AliceRouterAgent: unparseable response');
  const action = (ROUTER_ACTIONS as readonly string[]).includes(String(p.action)) ? (p.action as RouterAction) : 'answer';
  return {
    action,
    draftId: p.draftId === 'a' || p.draftId === 'b' ? p.draftId : null,
    comment: typeof p.comment === 'string' ? p.comment : '',
    entryIds: Array.isArray(p.entryIds) ? p.entryIds.filter((x): x is string => typeof x === 'string').slice(0, 5) : [],
    date: typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : null,
    reply: typeof p.reply === 'string' ? p.reply : '',
  };
}

export class AliceRouterAgent extends AliceAgent<RouterInput, RouterOutput> {
  constructor() {
    super('AliceRouterAgent');
  }
  protected model() {
    return routerModel();
  }
  protected getTemperature(): number {
    return 0.1;
  }
  protected getMaxTokens(): number {
    return 700;
  }
  protected getReasoningMaxTokens(): number {
    return 250;
  }
  protected getReasoningEffort(): ReasoningEffort {
    return 'low';
  }
  protected getAgentPrompt(): string {
    return `You decide what the person's message asks Alice to do, as exactly one action.

Return ONE JSON object, nothing else:
{"action":"choose|refine|regenerate|save|find_jobs|report|set_reminder|clear_reminder|new_profile|answer","draftId":"a|b|null","comment":"<the change they ask for, in their words, for choose, refine and regenerate>","entryIds":["<application id from the list>"],"date":"<YYYY-MM-DD or null>","reply":"<for answer: Alice's reply in one to three sentences; otherwise empty>"}

Actions:
- choose: while choosing between two profiles, they pick one (draftId), maybe with a change (comment).
- regenerate: neither profile fits; comment says why.
- refine: change the current profile (comment).
- save: they are happy with the profile and want it saved or used.
- find_jobs: they want jobs that fit the profile.
- report: they ask how their applications are going, what is next, or what needs them.
- set_reminder / clear_reminder: a follow-up date on one of their applications. entryIds holds the matching ids from the list (all that match when unsure); date is the day they named, resolved from today.
- new_profile: they want a different kind of job altogether and to start a new profile.
- answer: anything else (a question about the product or the job search, small talk). Answer briefly; never claim to apply or submit.`;
  }
  protected formatInput(input: RouterInput, locale?: string): string {
    const apps = input.applications.map((a) => `- ${a.entryId}: ${a.company ?? '?'} · ${a.title ?? '?'} (${a.status})`).join('\n');
    return [
      ...this.lead(input, locale),
      input.voice,
      `Stage: ${input.stage}. Today: ${input.today}.`,
      input.drafts.length ? `The two profiles shown: ${input.drafts.map((d) => `${d.id} = ${d.label}: ${d.headline}`).join(' | ')}` : '',
      input.profile ? `The current profile: ${input.profile}` : '',
      apps ? `Their open applications (data):\n${apps}` : 'They have no open applications.',
      `Their message (data):\n<message>\n${input.message}\n</message>`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  protected parseOutput(response: string): RouterOutput {
    return parseRouter(response);
  }
}

// ─── Reporter ──────────────────────────────────────────────────────────────

export interface ReporterInput {
  locale: string;
  voice: string;
  facts: AliceReportFacts;
  /** What needs them, as short lines ("interview tomorrow: Stripe, Product designer"). */
  needs: string[];
  /** Their question, when they asked one. */
  question: string | null;
}

export function parseReporter(response: string): { message: string } {
  const p = parseJsonObject(response);
  if (!p) throw new Error('AliceReporterAgent: unparseable response');
  return { message: typeof p.message === 'string' ? p.message : '' };
}

export class AliceReporterAgent extends AliceAgent<ReporterInput, { message: string }> {
  constructor() {
    super('AliceReporterAgent');
  }
  protected model() {
    return reportModel();
  }
  protected getTemperature(): number {
    return 0.3;
  }
  protected getMaxTokens(): number {
    return 600;
  }
  protected getReasoningMaxTokens(): number {
    return 200;
  }
  protected getReasoningEffort(): ReasoningEffort {
    return 'low';
  }
  protected getAgentPrompt(): string {
    return `You tell the person, in two or three sentences, how their applications stand and the one thing to do next.

Return ONE JSON object, nothing else:
{"message":"<two or three sentences>"}

Rules:
- Use only the facts given. Every number you write must be one of the numbers in the facts, written as digits. Never estimate, never predict a reply or an outcome.
- Lead with what needs them, if anything does; otherwise say plainly that nothing is waiting.
- No lists, no headings.`;
  }
  protected formatInput(input: ReporterInput, locale?: string): string {
    return [
      ...this.lead(input, locale),
      input.voice,
      `Facts: ${JSON.stringify(input.facts)}`,
      input.needs.length ? `What needs them:\n${input.needs.map((n) => `- ${n}`).join('\n')}` : 'Nothing needs them today.',
      input.question ? `Their question (data):\n<question>\n${input.question}\n</question>` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  protected parseOutput(response: string): { message: string } {
    return parseReporter(response);
  }
}

/** The process-wide subagents (stateless; safe to share). */
export interface AliceAgents {
  intake: Pick<AliceIntakeAgent, 'run'>;
  analyst: Pick<AliceGoalAnalystAgent, 'run'>;
  writer: Pick<AliceProfileWriterAgent, 'run'>;
  editor: Pick<AliceProfileEditorAgent, 'run'>;
  router: Pick<AliceRouterAgent, 'run'>;
  reporter: Pick<AliceReporterAgent, 'run'>;
}

export function createAliceAgents(): AliceAgents {
  return {
    intake: new AliceIntakeAgent(),
    analyst: new AliceGoalAnalystAgent(),
    writer: new AliceProfileWriterAgent(),
    editor: new AliceProfileEditorAgent(),
    router: new AliceRouterAgent(),
    reporter: new AliceReporterAgent(),
  };
}
