// server/src/features/alice/skills/index.ts — Alice's skills, one registry.
//
// Skills are data the subagents compose (docs/alice/ALICE.md §2 "Skills").
// A planner reads a compact index and answers with ids; the step that needs a
// skill receives its full directive. The registry lists every skill so the
// design record and the tests can check that each one is used.

export { INTAKE_TOPICS, REQUIRED_TOPICS, coveredTopics, nextTopic, readiness, renderTopicIndex, topicById, topicsFor } from './intakeTopics.js';
export type { IntakeTopic, Readiness, TopicGroup, TopicMarket } from './intakeTopics.js';
export { PROFILE_AXES, axisById, axisDirective, renderAxisIndex } from './profileAxes.js';
export type { ProfileAxis } from './profileAxes.js';
export { marketNorms } from './marketNorms.js';
export type { AliceMarket, MarketNorms } from './marketNorms.js';
export { ALICE_AVOID_WORDS, voiceDirective } from './voice.js';
export { filtersFromProfile, placesToFilters, relevanceText } from './profileFilters.js';
export { NEEDS_ORDER, needsYou } from './followUps.js';
export type { ReadyToCheck, TrackerFact } from './followUps.js';

/** The skills, by what they hold (the design record's table). */
export const ALICE_SKILLS = [
  { id: 'intakeTopics', holds: 'what Alice asks about, in what order, and when there is enough to draft' },
  { id: 'profileAxes', holds: 'the ways two job profiles differ, and how to pick the one that matters' },
  { id: 'marketNorms', holds: 'pay period and currency, title conventions and what not to ask, per market' },
  { id: 'voice', holds: 'how Alice speaks and the product copy rules restated for a model' },
  { id: 'profileFilters', holds: 'a job profile → the saved search it drives, and the words to rank by' },
  { id: 'followUps', holds: 'when an application needs the person, in order' },
] as const;
