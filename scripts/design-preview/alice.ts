// Alice fixtures for the design preview (example data only; nothing reaches a
// server). `/alice?alice=intake|choosing|refining|saved` opens on a stage, and
// the turn stream advances it the way the server would (a message in intake →
// two profiles, choose → version 1, a comment → version 2, save → saved), so
// the whole flow can be clicked through. The progress steps are replayed from
// the fixture with short gaps.

import type {
  AliceApplicationsView,
  AliceBrief,
  AliceJobProfile,
  AliceMatchesResponse,
  AliceMessageView,
  AliceProfilesResponse,
  AliceRevision,
  AliceStage,
  AliceStreamEvent,
  AliceThreadView,
} from '../../lib/api/contracts/alice';
import type { FeedItem } from '../../lib/api/contracts/feed';

const day = 24 * 60 * 60 * 1000;
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const dayIso = (days: number) => new Date(Date.now() + days * day).toISOString().slice(0, 10);

const brief: AliceBrief = {
  roles: ['Product designer', 'Design systems designer'],
  levels: ['senior'],
  workModels: ['remote', 'hybrid'],
  places: [{ label: 'Seattle', city: 'Seattle', country: 'US' }],
  pay: { amount: 150000, currency: 'USD', period: 'year' },
  industries: ['Developer tools', 'B2B SaaS'],
  avoidIndustries: ['Gambling'],
  companyKinds: ['scaleup', 'startup'],
  companySizes: [],
  companies: ['Figma', 'Linear'],
  avoidCompanies: [],
  dreamJob: 'Owning a design system that a hundred engineers actually enjoy using, with time to talk to users every week.',
  values: ['Ownership', 'Learning'],
  dealbreakers: ['Weekly travel'],
  timing: 'soon',
  jobTypes: ['full_time'],
  needsSponsorship: null,
  notes: [],
};

const profileA: AliceJobProfile = {
  id: 'a',
  label: 'Systems steward',
  headline: 'Senior product designer who owns the design system at a developer-tools scale-up',
  summary: 'Stay at the senior level and go deep: own a design system end to end at a company that ships tools for engineers.',
  titles: ['Senior Product Designer', 'Design Systems Designer'],
  searchTitles: ['Senior Product Designer', 'Design Systems Designer'],
  levels: ['senior'],
  workModels: ['remote', 'hybrid'],
  places: [{ label: 'Seattle', city: 'Seattle', country: 'US' }],
  pay: { amount: 150000, currency: 'USD', period: 'year' },
  industries: ['Developer tools', 'B2B SaaS'],
  companyKinds: ['scaleup'],
  companySizes: ['201-1000'],
  companies: [
    { name: 'Figma', source: 'you' },
    { name: 'Linear', source: 'you' },
    { name: 'Vercel', source: 'alice' },
  ],
  skills: ['Design systems', 'Figma', 'Prototyping', 'Accessibility'],
  mustHaves: ['Owns the component library', 'Works with engineers every day'],
  niceToHaves: ['A research budget'],
  dealbreakers: ['Weekly travel'],
  whyItFits: ['Five years building the component library at a payments company', 'Led the accessibility audit of 140 components'],
  tradeoff: 'Less people leadership than a lead role; the title stays senior.',
  jobTypes: ['full_time'],
};

const profileB: AliceJobProfile = {
  ...profileA,
  id: 'b',
  label: 'Step up to lead',
  headline: 'Design lead at an early start-up, building the design practice from the first hire',
  summary: 'Take the step up: lead design at a small start-up where you set the system, the process and the first hires.',
  titles: ['Design Lead', 'Founding Product Designer'],
  searchTitles: ['Design Lead', 'Founding Product Designer'],
  levels: ['lead_staff'],
  workModels: ['remote'],
  companyKinds: ['startup'],
  companySizes: ['11-50', '51-200'],
  companies: [
    { name: 'Linear', source: 'you' },
    { name: 'Raycast', source: 'alice' },
  ],
  mustHaves: ['Sets the design process', 'Hires the next designers'],
  niceToHaves: ['Equity'],
  whyItFits: ['Mentored three designers', 'Ran the design review for two product teams'],
  tradeoff: 'More scope and risk; less depth on any one system, and a smaller team around you.',
};

const v1: AliceRevision = { version: 1, profile: { ...profileA, id: 'p' }, comment: null, notes: [], changed: [], origin: 'pick', at: at(20) };
const v2: AliceRevision = {
  version: 2,
  profile: { ...profileA, id: 'p', workModels: ['remote'], places: [{ label: 'Anywhere in the US', city: null, country: 'US' }], dealbreakers: ['Weekly travel', 'On-call rotations'] },
  comment: 'Remote only please, anywhere in the US, and no on-call',
  notes: ['Remote only now, anywhere in the US', 'Added on-call rotations to your dealbreakers'],
  changed: ['workModels', 'places', 'dealbreakers'],
  origin: 'edit',
  at: at(8),
};

function msg(id: string, role: 'user' | 'alice', text: string, blocks: AliceMessageView['blocks'], minutesAgo: number, agent: AliceMessageView['agent'] = role === 'alice' ? 'intake' : null): AliceMessageView {
  return { id, role, text, blocks, agent, at: at(minutesAgo) };
}

const greeting = msg('m0', 'alice', '', [{ type: 'greeting', hasResume: true, resumeName: 'Avery Chen — Product designer' }], 60, 'system');
const intakeMessages: AliceMessageView[] = [
  greeting,
  msg('m1', 'user', '', [{ type: 'action', action: 'resume', label: 'Avery Chen — Product designer' }], 58),
  msg('m2', 'alice', '', [{ type: 'resume', resumeName: 'Avery Chen — Product designer', roles: ['Product designer'], years: 7 }], 58),
  msg('m3', 'alice', 'Your resume shows seven years of product design, most of it on a design system. Is that the kind of work you want next?', [], 58),
  msg('m4', 'user', 'Yes, product design, ideally owning a design system again. Senior level.', [], 55),
  msg('m5', 'alice', 'Senior, and design systems at the centre: noted.\n\nHow do you want to work: remote, hybrid or in the office?', [{ type: 'learned', topics: ['roles', 'level'] }], 55),
  msg('m6', 'user', 'Remote, hybrid', [], 52),
  msg('m7', 'alice', 'Which companies would you love to work at, or admire for how they work?', [{ type: 'learned', topics: ['workSetting'] }], 52),
];

const choosingMessages: AliceMessageView[] = [
  ...intakeMessages,
  msg('m8', 'user', 'Figma and Linear. I care about ownership and learning; no weekly travel.', [], 40),
  msg('m9', 'alice', 'Thanks, that gives me a clear picture.', [{ type: 'learned', topics: ['companies', 'values', 'dealbreakers'] }, { type: 'notice', code: 'enough_questions' }], 40),
  msg('m10', 'alice', 'Here are two directions your answers leave open. Which one is closer?', [{ type: 'profiles', labels: [profileA.label, profileB.label] }], 39, 'writer'),
];

const refiningMessages: AliceMessageView[] = [
  ...choosingMessages,
  msg('m11', 'user', '', [{ type: 'action', action: 'choose', label: profileA.label }], 25),
  msg('m12', 'alice', '', [{ type: 'revision', version: 1, changed: [] }], 25, 'editor'),
  msg('m13', 'user', 'Remote only please, anywhere in the US, and no on-call', [], 9),
  msg('m14', 'alice', 'Done: remote only, anywhere in the US, and on-call is now a dealbreaker.', [{ type: 'revision', version: 2, changed: ['workModels', 'places', 'dealbreakers'] }], 8, 'editor'),
];

const savedMessages: AliceMessageView[] = [
  ...refiningMessages,
  msg('m15', 'user', '', [{ type: 'action', action: 'save', label: 'Systems steward' }], 4),
  msg('m16', 'alice', '', [{ type: 'saved', profileId: 'jp_preview', name: 'Systems steward', search: { id: 'sp_preview', name: 'Example search', mode: 'replaced' } }], 4, 'system'),
  msg('m17', 'alice', '', [{ type: 'matches', profileId: 'jp_preview', count: 4 }], 4, 'scout'),
  msg('m18', 'user', 'Remind me to follow up with Figma on Friday', [], 2),
  msg('m19', 'alice', '', [{ type: 'reminder', entryId: 'te_figma', company: 'Figma', title: 'Group Product Manager', date: dayIso(4) }], 2, 'reminders'),
];

const allTopics = ['roles', 'level', 'workSetting', 'places', 'pay', 'industries', 'companyKind', 'companySize', 'companies', 'dreamJob', 'values', 'dealbreakers', 'timing', 'sponsorship'] as const;

function thread(stage: AliceStage): AliceThreadView {
  const intakeBrief: AliceBrief = { ...brief, places: [], pay: null, industries: [], avoidIndustries: [], companyKinds: [], companies: [], dreamJob: null, values: [], dealbreakers: [], timing: null, jobTypes: [] };
  const b = stage === 'intake' ? intakeBrief : brief;
  const covered = stage === 'intake' ? (['roles', 'level', 'workSetting'] as const) : allTopics.filter((t) => t !== 'sponsorship' && t !== 'companySize');
  const messages = stage === 'intake' ? intakeMessages : stage === 'choosing' ? choosingMessages : stage === 'refining' ? refiningMessages : savedMessages;
  return {
    id: 'th_preview',
    stage,
    locale: 'en',
    resume: { id: 'cm_rv_base', name: 'Avery Chen — Product designer', updatedAt: at(60 * 24 * 3) },
    resumeSkipped: false,
    brief: b,
    topics: { all: [...allTopics], required: ['roles', 'level', 'workSetting', 'companies'], covered: [...covered], declined: stage === 'intake' ? [] : ['sponsorship'] },
    ready: stage !== 'intake',
    pending: stage === 'intake' ? { topic: 'companies', quickReplies: ['Figma', 'Linear', 'Notion', 'None in mind'], multiSelect: true } : null,
    analysis:
      stage === 'intake'
        ? null
        : {
            summary: 'You want to keep designing systems and to own more of them. The open question is whether to go deeper at your level or step up to lead.',
            strengths: ['Seven years on a design system'],
            motivations: ['Ownership', 'Learning'],
            constraints: ['No weekly travel'],
            axis: 'scope',
            question: 'Go deeper at senior level, or step up to lead?',
            directions: [
              { id: 'a', label: profileA.label, summary: profileA.summary },
              { id: 'b', label: profileB.label, summary: profileB.summary },
            ],
          },
    drafts: stage === 'choosing' ? [profileA, profileB] : [],
    revisions: stage === 'refining' || stage === 'saved' ? [v1, v2] : [],
    currentVersion: stage === 'refining' || stage === 'saved' ? 2 : 0,
    savedProfile:
      stage === 'saved'
        ? {
            id: 'jp_preview',
            name: 'Systems steward',
            profile: { ...v2.profile, id: 'jp_preview' },
            version: 1,
            status: 'active',
            search: { id: 'sp_preview', name: 'Example search', isActive: true },
            canUndoReplace: true,
            createdAt: at(4),
            updatedAt: at(4),
          }
        : null,
    saveTarget: stage === 'refining' ? { mode: 'choose', search: { id: 'sp_preview', name: 'Example search' } } : null,
    messages,
    createdAt: at(60),
    updatedAt: at(2),
  };
}

const applications: AliceApplicationsView = {
  market: 'intl',
  stages: [
    { status: 'bookmarked', count: 4 },
    { status: 'applied', count: 5 },
    { status: 'first_call', count: 1 },
    { status: 'interviewing', count: 1 },
    { status: 'final_round', count: 0 },
    { status: 'offer', count: 0 },
    { status: 'rejected', count: 2 },
  ],
  facts: { active: 11, waiting: 5, interviewing: 2, offers: 0, needsYou: 3, noReply: 1, remindersDue: 0, readyToCheck: 1, appliedThisWeek: 2 },
  needsYou: [
    { kind: 'interview_tomorrow', entryId: 'te_stripe', queueItemId: null, company: 'Stripe', title: 'Senior Product Manager', at: new Date(Date.now() + day).toISOString(), days: null },
    { kind: 'ready_to_check', entryId: null, queueItemId: 'q_preview', company: 'Notion', title: 'Product Lead, AI', at: at(90), days: null },
    { kind: 'no_reply_10d', entryId: 'te_anthropic', queueItemId: null, company: 'Anthropic', title: 'AI Engineer, Claude Platform', at: new Date(Date.now() - 12 * day).toISOString(), days: 12 },
  ],
  reminders: [{ entryId: 'te_figma', company: 'Figma', title: 'Group Product Manager', status: 'applied', date: dayIso(4), due: false }],
  open: [
    { entryId: 'te_figma', company: 'Figma', title: 'Group Product Manager', status: 'applied', followUpAt: `${dayIso(4)}T12:00:00.000Z` },
    { entryId: 'te_stripe', company: 'Stripe', title: 'Senior Product Manager', status: 'interviewing', followUpAt: null },
    { entryId: 'te_anthropic', company: 'Anthropic', title: 'AI Engineer, Claude Platform', status: 'applied', followUpAt: null },
  ],
  asOf: new Date().toISOString(),
};

const params = new URLSearchParams(window.location.search);
const startStage = params.get('alice');
let stage: AliceStage = startStage === 'choosing' || startStage === 'refining' || startStage === 'saved' ? startStage : 'intake';
let current = thread(stage);

export function aliceGetFixtures(base: string, jobs: FeedItem[]): Record<string, unknown> {
  const matches: AliceMatchesResponse = {
    profileId: 'jp_preview',
    searchId: 'sp_preview',
    items: jobs.slice(0, 4).map((job, i) => ({ job, meets: i === 0 ? ['titles', 'levels', 'workModels', 'companies'] : i === 1 ? ['titles', 'workModels'] : ['titles'], atNamedCompany: i === 0 })),
  };
  const profiles: AliceProfilesResponse = { items: thread('saved').savedProfile ? [thread('saved').savedProfile!] : [] };
  return {
    [`${base}/alice/applications`]: applications,
    [`${base}/alice/profiles`]: profiles,
    [`${base}/alice/profiles/jp_preview/matches`]: matches,
  };
}

/** GET /alice/thread is answered from the live preview state (it changes as turns run). */
export function aliceThread(): AliceThreadView {
  return current;
}

function sse(events: Array<AliceStreamEvent & { wait?: number }>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        await new Promise((r) => setTimeout(r, e.wait ?? 120));
        controller.enqueue(encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const step = (s: Extract<AliceStreamEvent, { event: 'progress' }>['data']['step'], state: 'running' | 'done', wait = 500) => ({ event: 'progress' as const, data: { step: s, state }, wait });

/** POST /alice/turn in the preview: advance the example thread the way the server would. */
export function aliceTurn(body: { kind?: string; text?: string; replies?: string[] }): Response {
  const userText = body.kind === 'message' ? body.text ?? '' : body.kind === 'replies' ? (body.replies ?? []).join(', ') : '';
  const next = (s: AliceStage) => {
    stage = s;
    current = thread(s);
  };
  if (body.kind === 'restart') {
    next('intake');
    return sse([{ event: 'thread', data: { thread: current } }, { event: 'done', data: {} }]);
  }
  if (stage === 'intake') {
    const user = msg(`u${Date.now()}`, 'user', userText, body.kind === 'draft_now' ? [{ type: 'action', action: 'draft_now' }] : [], 0);
    next('choosing');
    return sse([
      { event: 'message', data: { message: user } },
      step('thinking', 'running', 200),
      step('thinking', 'done', 700),
      step('reading_goals', 'running', 100),
      step('reading_goals', 'done', 900),
      step('writing_profiles', 'running', 100),
      step('writing_profiles', 'done', 1400),
      { event: 'thread', data: { thread: current } },
      { event: 'done', data: {} },
    ]);
  }
  if (stage === 'choosing' && body.kind === 'choose') {
    next('refining');
    current = { ...current, revisions: [v1], currentVersion: 1, messages: refiningMessages.slice(0, -2) };
    return sse([{ event: 'thread', data: { thread: current } }, { event: 'done', data: {} }]);
  }
  if (stage === 'refining' && (body.kind === 'refine' || body.kind === 'message')) {
    next('refining');
    return sse([step('revising', 'running', 150), step('revising', 'done', 1200), { event: 'thread', data: { thread: current } }, { event: 'done', data: {} }]);
  }
  if (stage === 'refining' && body.kind === 'save') {
    next('saved');
    return sse([step('saving', 'running', 150), step('saving', 'done', 500), step('finding_jobs', 'running', 100), step('finding_jobs', 'done', 800), { event: 'thread', data: { thread: current } }, { event: 'done', data: {} }]);
  }
  if (body.kind === 'report' || stage === 'saved') {
    const reply = msg(`a${Date.now()}`, 'alice', 'Stripe interviews you tomorrow, and a Notion application is ready for you to check. Anthropic has had no reply for 12 days.', [{ type: 'report', facts: applications.facts }], 0, 'reporter');
    current = { ...current, messages: [...current.messages, msg(`u${Date.now()}`, 'user', userText, body.kind === 'report' ? [{ type: 'action', action: 'report' }] : [], 0), reply] };
    return sse([step('checking_applications', 'running', 150), step('checking_applications', 'done', 700), { event: 'thread', data: { thread: current } }, { event: 'done', data: {} }]);
  }
  return sse([{ event: 'thread', data: { thread: current } }, { event: 'done', data: {} }]);
}
