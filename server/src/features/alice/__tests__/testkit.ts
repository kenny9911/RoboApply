// Test kit for Alice: the memory store, scripted subagents and fake seams.
// No database, no model: every subagent answers what the test scripted.

import { vi } from 'vitest';
import { BRANDS } from '../../../platform/brand/registry.js';
import { HttpError } from '../../../platform/http.js';
import type { FeedItem } from '../../feed/contract.js';
import type { FilterSet } from '../../search/contract.js';
import type { AliceAgents, IntakeOutput, RouterOutput } from '../agents.js';
import type { AliceStreamEvent, AliceThreadView } from '../contract.js';
import type { AliceDeps, SearchRef, TrackerEntryLite } from '../deps.js';
import { createAliceService } from '../service.js';
import type { TrackerFact, ReadyToCheck } from '../skills/followUps.js';
import { createMemoryAliceStore } from '../store.js';

export const USER = 'u_alice';

export function intakeOut(over: Partial<IntakeOutput> = {}): IntakeOutput {
  return { learned: {}, cleared: [], declined: [], ack: '', question: 'What kind of job do you want next?', topic: 'roles', quickReplies: ['Product designer'], multiSelect: false, wantsProfiles: false, ...over };
}

export const PROFILE_A = {
  label: 'Steady climb',
  headline: 'Senior product designer at a payments scale-up',
  summary: 'Grow in payments design.',
  titles: ['Senior Product Designer'],
  searchTitles: ['Senior Product Designer'],
  levels: ['senior'],
  workModels: ['remote'],
  places: [{ label: 'Berlin', city: 'Berlin', country: 'DE' }],
  pay: { amount: 85000, currency: 'EUR', period: 'year' },
  industries: ['Fintech'],
  companyKinds: ['scaleup'],
  companySizes: [],
  companies: [{ name: 'Stripe', source: 'you' }],
  skills: ['Figma'],
  mustHaves: ['Own a design system'],
  niceToHaves: [],
  dealbreakers: ['Weekly travel'],
  whyItFits: ['Six years in checkout design'],
  tradeoff: 'Less scope than a lead role.',
  jobTypes: ['full_time'],
};

export const PROFILE_B = { ...PROFILE_A, label: 'Step up', headline: 'Design lead at an early start-up', titles: ['Design Lead'], searchTitles: ['Design Lead'], levels: ['lead_staff'], companyKinds: ['startup'] };

export function scriptedAgents() {
  const intake = vi.fn(async (): Promise<IntakeOutput> => intakeOut());
  const analyst = vi.fn(async () => ({
    summary: 'A designer who wants payments work.',
    strengths: ['Checkout design'],
    motivations: ['Ownership'],
    constraints: ['No travel'],
    axis: 'scope',
    question: 'Stay senior or step up?',
    directions: [
      { label: 'Steady climb', summary: 'Senior, bigger company.' },
      { label: 'Step up', summary: 'Lead, smaller company.' },
    ],
  }));
  const writer = vi.fn(async () => ({ profiles: [PROFILE_A, PROFILE_B] as unknown[], message: 'Here are two directions. Which is closer?' }));
  const editor = vi.fn(async (input: { profile: Record<string, unknown> }) => ({ profile: { ...input.profile, workModels: ['remote', 'hybrid'] }, notes: ['Hybrid added'], message: 'I added hybrid work.', learned: {} }));
  const router = vi.fn(async (): Promise<RouterOutput> => ({ action: 'answer', draftId: null, comment: '', entryIds: [], date: null, reply: 'I can help with that.' }));
  const reporter = vi.fn(async () => ({ message: 'You have 2 open applications.' }));
  const agents: AliceAgents = {
    intake: { run: intake as never },
    analyst: { run: analyst as never },
    writer: { run: writer as never },
    editor: { run: editor as never },
    router: { run: router as never },
    reporter: { run: reporter as never },
  };
  return { agents, intake, analyst, writer, editor, router, reporter };
}

export function job(id: string, over: Partial<FeedItem> = {}): FeedItem {
  return {
    jobId: id,
    title: 'Senior Product Designer',
    company: { id: null, name: 'Stripe', logoUrl: null },
    location: 'Berlin, Germany',
    workModel: 'remote',
    employmentType: 'full_time',
    seniority: 'senior',
    pay: null,
    postedAt: null,
    lastSeenAt: null,
    source: { name: 'Example', kind: 'provider' },
    fromRecruiterBank: false,
    employerVerified: false,
    isAgency: false,
    badges: [],
    fit: { tier: 'good', score: 74, kind: 'pre', topGap: 'Payments regulation', topOverlap: 'Checkout design' },
    tracker: null,
    ...over,
  };
}

export interface World {
  searches: SearchRef[];
  cap: number;
  entries: TrackerEntryLite[];
  statusCounts: Record<string, number>;
  facts: TrackerFact[];
  ready: ReadyToCheck[];
  jobs: FeedItem[];
  aiAllowed: boolean;
  agentOn: boolean;
  lastMatchFilters: FilterSet | null;
}

export function makeAlice(over: { world?: Partial<World>; deps?: Partial<AliceDeps> } = {}) {
  const store = createMemoryAliceStore();
  const scripted = scriptedAgents();
  const world: World = {
    searches: [{ id: 's_main', name: 'Main search', isActive: true, isDefault: true, version: 3, filters: { titles: ['Designer'] } }],
    cap: 1,
    entries: [],
    statusCounts: {},
    facts: [],
    ready: [],
    jobs: [job('j1'), job('j2', { company: { id: null, name: 'Figma', logoUrl: null }, workModel: 'hybrid' })],
    aiAllowed: true,
    agentOn: true,
    lastMatchFilters: null,
    ...over.world,
  };
  let searchSeq = 0;
  const deps: AliceDeps = {
    store,
    agents: scripted.agents,
    now: () => new Date('2026-11-23T09:00:00.000Z'),
    brand: () => BRANDS.roboapply,
    aiAllowed: async () => world.aiAllowed,
    flag: async () => world.agentOn,
    rateLimit: async () => undefined,
    primaryResume: async () => ({ id: 'rv1', name: 'Maya resume', updatedAt: new Date('2026-11-01T00:00:00Z') }),
    resume: async (_u, id) => (id === 'rv1' ? { id: 'rv1', name: 'Maya resume', updatedAt: new Date('2026-11-01T00:00:00Z') } : null),
    resumeDigest: async (_u, id) => (id === 'rv1' ? { id: 'rv1', name: 'Maya resume', updatedAt: new Date('2026-11-01T00:00:00Z'), text: 'Product designer, 6 years, checkout.', roles: ['Product Designer'], years: 6 } : null),
    searches: async () => ({ items: world.searches.map((s) => ({ ...s })), cap: world.cap }),
    createSearch: async (_u, input) => {
      if (world.searches.length >= world.cap) throw new HttpError('conflict', 'cap');
      const s: SearchRef = { id: `s_new${++searchSeq}`, name: input.name, isActive: input.activate, isDefault: false, version: 1, filters: input.filters };
      if (input.activate) world.searches.forEach((x) => (x.isActive = false));
      world.searches.push(s);
      return { ...s };
    },
    replaceSearch: async (_u, id, input) => {
      const s = world.searches.find((x) => x.id === id)!;
      s.filters = input.filters;
      s.version += 1;
      return { ...s };
    },
    activateSearch: async (_u, id) => {
      world.searches.forEach((x) => (x.isActive = x.id === id));
      return { ...world.searches.find((x) => x.id === id)! };
    },
    matches: async (_u, input) => {
      world.lastMatchFilters = input.filters;
      return world.jobs.slice(0, input.limit);
    },
    trackerEntries: async () => ({ entries: world.entries, statusCounts: world.statusCounts }),
    trackerFacts: async () => world.facts,
    setFollowUp: async (_u, entryId, date) => {
      const e = world.entries.find((x) => x.id === entryId);
      if (!e) throw new HttpError('not_found', 'gone');
      e.followUpAt = date ? `${date}T12:00:00.000Z` : null;
      return { ...e };
    },
    readyToCheck: async () => world.ready,
    ...over.deps,
  };
  const service = createAliceService(deps);
  const ctx = { locale: 'en', country: 'DE' };

  /** Run a turn and collect its events; returns the final thread. */
  async function turn(body: Parameters<typeof service.turn>[1]): Promise<{ events: AliceStreamEvent[]; thread: AliceThreadView }> {
    const events: AliceStreamEvent[] = [];
    await service.turn(USER, body, { ...ctx, emit: (e) => events.push(e) });
    const last = [...events].reverse().find((e) => e.event === 'thread');
    if (!last || last.event !== 'thread') throw new Error('no thread event');
    return { events, thread: last.data.thread };
  }

  return { service, store, deps, world, scripted, ctx, turn };
}
