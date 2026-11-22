// server/src/features/alice/skills/intakeTopics.ts — what Alice asks about.
//
// A skill is data the subagents compose: the Intake interviewer reads the
// compact index (id, what to learn, how to ask) and answers with ids; the
// orchestrator decides readiness from the brief itself, never from the
// model's word alone. Adding a topic is a change in this file only.
//
// Readiness (drafting needs every group): `roles` (what kind of job),
// `level`, `where` (work setting or places) and `aspiration` (companies, the
// dream job or what matters). A topic the user declined counts toward its
// group, except `roles`: two profiles with no job in them cannot be searched.

import type { AliceBrief, AliceTopicId } from '../contract.js';

export type TopicGroup = 'roles' | 'level' | 'where' | 'aspiration';
export type TopicMarket = 'intl' | 'cn';

export interface IntakeTopic {
  id: AliceTopicId;
  /** Asking order (lower first). */
  order: number;
  /** The readiness group it counts toward, or null (nice to know). */
  group: TopicGroup | null;
  /** Markets where it is asked. */
  markets: readonly TopicMarket[];
  /** The brief fields it fills. */
  fields: readonly (keyof AliceBrief)[];
  /** What to learn (for the model). */
  learn: string;
  /** How to ask it well (for the model). */
  ask: string;
  /** Answered when this holds on the brief. */
  covered: (b: AliceBrief) => boolean;
}

const BOTH: readonly TopicMarket[] = ['intl', 'cn'];

export const INTAKE_TOPICS: readonly IntakeTopic[] = [
  {
    id: 'roles',
    order: 1,
    group: 'roles',
    markets: BOTH,
    fields: ['roles'],
    learn: 'The kinds of job they want next, as titles employers post. Keep the person’s own words for anything that is not a title.',
    ask: 'When the resume shows a clear role, offer it and one or two neighbouring titles as quick replies and ask which fits; with no resume, ask what work they want to do next.',
    covered: (b) => b.roles.length > 0,
  },
  {
    id: 'level',
    order: 2,
    group: 'level',
    markets: BOTH,
    fields: ['levels'],
    learn: 'The level they aim for: intern_newgrad, entry, mid, senior, lead_staff or director_exec (one or two).',
    ask: 'Offer the level the resume suggests and the one above it. Never tell them what level they are.',
    covered: (b) => b.levels.length > 0,
  },
  {
    id: 'workSetting',
    order: 3,
    group: 'where',
    markets: BOTH,
    fields: ['workModels'],
    learn: 'How they want to work: remote, hybrid or in an office (onsite). Several can hold.',
    ask: 'Quick replies for the three settings; several may be picked.',
    covered: (b) => b.workModels.length > 0,
  },
  {
    id: 'places',
    order: 4,
    group: 'where',
    markets: BOTH,
    fields: ['places', 'needsSponsorship'],
    learn: 'The cities, regions or countries they would work in, each with its city and ISO country code when the name gives them.',
    ask: 'Ask where they want to work. Skip it when they only want remote work and named no place.',
    covered: (b) => b.places.length > 0 || (b.workModels.length === 1 && b.workModels[0] === 'remote'),
  },
  {
    id: 'pay',
    order: 5,
    group: null,
    markets: BOTH,
    fields: ['pay'],
    learn: 'The lowest pay they would accept, as an amount, a currency and a period.',
    ask: 'Ask for the lowest pay that would work, in the market’s usual period and currency. Make it easy to skip; never insist.',
    covered: (b) => b.pay !== null,
  },
  {
    id: 'industries',
    order: 6,
    group: null,
    markets: BOTH,
    fields: ['industries', 'avoidIndustries'],
    learn: 'Fields of business they want, and any they would rather avoid.',
    ask: 'Offer the industries their experience points to plus one adjacent one; several may be picked.',
    covered: (b) => b.industries.length > 0 || b.avoidIndustries.length > 0,
  },
  {
    id: 'companyKind',
    order: 7,
    group: null,
    markets: BOTH,
    fields: ['companyKinds'],
    learn: 'The kind of employer: startup, scaleup, enterprise, public_sector or nonprofit.',
    ask: 'Ask what kind of company suits them; several may be picked.',
    covered: (b) => b.companyKinds.length > 0,
  },
  {
    id: 'companySize',
    order: 8,
    group: null,
    markets: BOTH,
    fields: ['companySizes'],
    learn: 'Company size in employees, as buckets: 1-10, 11-50, 51-200, 201-1000, 1001-5000, 5000+.',
    ask: 'Ask only when the kind of company left the size open; otherwise skip it.',
    covered: (b) => b.companySizes.length > 0 || b.companyKinds.length > 0,
  },
  {
    id: 'companies',
    order: 9,
    group: 'aspiration',
    markets: BOTH,
    fields: ['companies', 'avoidCompanies'],
    learn: 'Companies they admire or would love to work at, and any they would not join.',
    ask: 'Ask which companies they would love to work at, or admire for how they work. “None in mind” is a fine answer.',
    covered: (b) => b.companies.length > 0 || b.avoidCompanies.length > 0,
  },
  {
    id: 'dreamJob',
    order: 10,
    group: 'aspiration',
    markets: BOTH,
    fields: ['dreamJob'],
    learn: 'Their dream or ideal job in their own words: what they would do on a good day, with whom, for what.',
    ask: 'Ask them to describe the job they would love to have, as a day in it. Keep their words.',
    covered: (b) => b.dreamJob !== null,
  },
  {
    id: 'values',
    order: 11,
    group: 'aspiration',
    markets: BOTH,
    fields: ['values'],
    learn: 'What matters most to them in the next job (learning, pay, stability, mission, flexibility, the team, a title …).',
    ask: 'Quick replies for six common answers; up to three may be picked.',
    covered: (b) => b.values.length > 0,
  },
  {
    id: 'dealbreakers',
    order: 12,
    group: null,
    markets: BOTH,
    fields: ['dealbreakers'],
    learn: 'What they will not accept (long travel, on-call, a long commute, a kind of work).',
    ask: 'Ask what would make them say no to an offer. “Nothing in particular” is a fine answer.',
    covered: (b) => b.dealbreakers.length > 0,
  },
  {
    id: 'timing',
    order: 13,
    group: null,
    markets: BOTH,
    fields: ['timing', 'jobTypes'],
    learn: 'How soon: now, soon (the next few months) or exploring; and the kind of contract if they say (full_time, contract, part_time, internship).',
    ask: 'Ask how soon they want to start; three quick replies.',
    covered: (b) => b.timing !== null,
  },
  {
    id: 'sponsorship',
    order: 14,
    group: null,
    markets: ['intl'],
    fields: ['needsSponsorship'],
    learn: 'Whether they need visa sponsorship to work in the places they named (true or false).',
    ask: 'Ask only when they named a country where they may need a visa; offer Yes, No and Not sure. Never ask about nationality.',
    covered: (b) => b.needsSponsorship !== null,
  },
];

export function topicsFor(market: TopicMarket): IntakeTopic[] {
  return INTAKE_TOPICS.filter((t) => t.markets.includes(market)).sort((a, b) => a.order - b.order);
}

export function topicById(id: string): IntakeTopic | undefined {
  return INTAKE_TOPICS.find((t) => t.id === id);
}

/** The topic of each readiness group, for the thread view (`required`). */
export const REQUIRED_TOPICS: readonly AliceTopicId[] = ['roles', 'level', 'workSetting', 'companies'];

export interface Readiness {
  ready: boolean;
  /** Groups still open. */
  missing: TopicGroup[];
}

/** Whether the brief is enough to write two profiles. */
export function readiness(brief: AliceBrief, declined: readonly AliceTopicId[], market: TopicMarket): Readiness {
  const groups: TopicGroup[] = ['roles', 'level', 'where', 'aspiration'];
  const topics = topicsFor(market);
  const missing = groups.filter((g) => {
    const inGroup = topics.filter((t) => t.group === g);
    return !inGroup.some((t) => t.covered(brief) || (g !== 'roles' && declined.includes(t.id)));
  });
  return { ready: missing.length === 0, missing };
}

/** Topics covered by the brief (deterministic), in asking order. */
export function coveredTopics(brief: AliceBrief, market: TopicMarket): AliceTopicId[] {
  return topicsFor(market)
    .filter((t) => t.covered(brief))
    .map((t) => t.id);
}

/** The next topic to ask: the first open required group, then the rest in order. */
export function nextTopic(brief: AliceBrief, declined: readonly AliceTopicId[], market: TopicMarket): AliceTopicId | null {
  const open = topicsFor(market).filter((t) => !t.covered(brief) && !declined.includes(t.id));
  const { missing } = readiness(brief, declined, market);
  const required = open.find((t) => t.group !== null && missing.includes(t.group));
  return (required ?? open[0])?.id ?? null;
}

/** The compact index the Intake interviewer reads. */
export function renderTopicIndex(market: TopicMarket): string {
  return topicsFor(market)
    .map((t) => `- ${t.id}${t.group ? ` (needed: ${t.group})` : ''}: learn ${t.learn} Ask: ${t.ask}`)
    .join('\n');
}
