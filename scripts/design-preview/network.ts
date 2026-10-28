// No request ever reaches native fetch. CSP also rejects connections, media,
// external images, frames, and form submissions as a second local boundary.
import type { PublicBrand } from '../../lib/api/contracts/brand';
import type { MatchExplanation } from '../../lib/api/contracts/compliance';
import type { FeedItem, FeedQueryResponse, FitTier, NewCountResponse } from '../../lib/api/contracts/feed';
import type { JobDetailResponse, ScoreJobResponse } from '../../lib/api/contracts/jobs/detail';
import type { SearchProfileListWire } from '../../lib/api/contracts/search';
import type { ResolvedFlags } from '../../lib/flags';

const base = '/api/v1/roboapply';
const credits = { balance: 120, periodAllotment: 180, tier: 'starter', currentPeriodEnd: '2026-10-01T00:00:00.000Z', creditMinutes: 1 };

// Practice fixtures. The recent-practice lane and the debrief are the two
// parts of /practice that render SERVER data, so the preview carries examples
// of both or those surfaces review as permanently empty.
const day = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
const recentSessions = [
  {
    id: 'ie_preview', status: 'completed', source: 'app', role: 'Senior Product Manager',
    interviewType: 'behavioral', personaId: 'maya', mode: 'video', language: 'en',
    durationMinutes: 30, overall: 78, externalRef: null,
    createdAt: ago(2), startedAt: ago(2), endedAt: ago(2),
  },
  {
    id: 'ie_preview_2', status: 'completed', source: 'app', role: 'Frontend Engineer',
    interviewType: 'technical', personaId: 'kai', mode: 'video', language: 'en',
    durationMinutes: 45, overall: 64, externalRef: null,
    createdAt: ago(6), startedAt: ago(6), endedAt: ago(6),
  },
  {
    id: 'ie_preview_3', status: 'completed', source: 'app', role: 'Data Analyst',
    interviewType: 'behavioral', personaId: 'maya', mode: 'voice', language: 'en',
    durationMinutes: 15, overall: 71, externalRef: null,
    createdAt: ago(11), startedAt: ago(11), endedAt: ago(11),
  },
  {
    id: 'ie_preview_4', status: 'completed', source: 'app', role: 'Product Designer',
    interviewType: 'behavioral', personaId: 'okonkwo', mode: 'video', language: 'en',
    durationMinutes: 30, overall: 55, externalRef: null,
    createdAt: ago(19), startedAt: ago(19), endedAt: ago(19),
  },
];

const practiceReport = {
  session: {
    ...recentSessions[0],
    candidateName: 'Avery Chen', characteristics: null, voice: null, questions: [],
    webSources: [], interviewerBrief: null, requirements: null,
    breakdown: [
      { key: 'roleFit', value: 74, note: 'You reached for the right examples but described them at a level a peer would use, not a hiring manager.' },
      { key: 'structure', value: 61, note: 'Three answers started with context and never arrived at the decision you made.' },
      { key: 'specificity', value: 52, note: 'One number across the whole interview.' },
      { key: 'communication', value: 83, note: 'Clear, unhurried, easy to follow.' },
      { key: 'confidence', value: 80, note: 'You held your ground when the interviewer pushed back on the pricing call.' },
    ],
    strengths: [
      'You answer the question that was asked, not the one you prepared for.',
      'Your pace holds steady when the interviewer pushes back.',
    ],
    gaps: [
      'Your impact is described, never measured — a hiring manager cannot size the work.',
      'Two answers ended without saying what happened in the end.',
    ],
    summary: 'A solid, well-paced interview held back by unmeasured impact.',
    recommendations: [
      {
        title: 'Put a number on the migration story',
        priority: 'high',
        detail: 'You spent ninety seconds on the billing migration without once saying how much it moved. That story is your strongest and it currently lands as effort rather than outcome.',
        example: 'Before: "we improved reliability." After: "cut failed charges from 2.1% to 0.3% across 40k monthly transactions."',
        drill: 'Re-tell three stories in ninety seconds each. One number per story, spoken in the first two sentences.',
        linkedDimension: 'specificity',
      },
      {
        title: 'Close every answer with the outcome',
        priority: 'medium',
        detail: 'Two answers stopped at the decision. The interviewer had to ask what happened next, which spends time you could use on the next question.',
        example: 'End with one sentence: "We shipped it in six weeks and churn on that cohort dropped by a third."',
        linkedDimension: 'structure',
      },
    ],
    questionAnalysis: [
      {
        questionIndex: 0, blueprintIndex: 0, missed: false,
        question: 'Tell me about a product decision you got wrong.',
        intent: 'They want to see whether you can name your own error without softening it.',
        answerSummary: 'Shipped a pricing change without talking to support first.',
        keyQuote: 'in hindsight we probably should have looped support in earlier',
        analysis: 'You named the mistake, then immediately hedged it with "probably". The hedge reads as unfinished reflection.',
        correction: 'You never said what the mistake cost.',
        suggestion: 'State the error flatly, then the cost, then what you changed.',
        modelAnswer: 'A strong answer says: "I shipped it without support. They absorbed 300 extra tickets in week one. Now support signs off on any pricing change."',
        tips: ['Drop the hedging adverbs', 'Name the cost before the lesson'],
        rating: 'adequate', score: 58, tags: ['hedged'],
      },
      {
        questionIndex: 1, blueprintIndex: 1, missed: false,
        question: 'How do you decide what not to build?',
        intent: 'They are testing whether you have a real prioritisation method or a vocabulary for one.',
        answerSummary: 'Described a scoring rubric across reach, confidence and effort.',
        keyQuote: 'we score everything and the top of the list wins',
        analysis: 'The method is sound and you explained it cleanly.',
        correction: '',
        suggestion: 'Add the example of something the rubric killed.',
        modelAnswer: 'Follow the method with one thing it stopped you shipping, and what you did instead.',
        tips: ['Name one killed project'],
        rating: 'strong', score: 84, tags: [],
      },
    ],
    reportPending: false, recordingAvailable: false, transcriptAvailable: true,
  },
  transcript: [
    { role: 'interviewer', text: 'Thanks for making the time. Tell me about a product decision you got wrong.', ts: 1 },
    { role: 'candidate', text: 'Sure. Last year we shipped a pricing change and in hindsight we probably should have looped support in earlier.', ts: 2 },
    { role: 'interviewer', text: 'What happened when it went out?', ts: 3 },
    { role: 'candidate', text: 'Support got busy. We rolled part of it back the following week.', ts: 4 },
    { role: 'interviewer', text: 'How do you decide what not to build?', ts: 5 },
    { role: 'candidate', text: 'We score everything on reach, confidence and effort, and the top of the list wins the quarter.', ts: 6 },
  ],
  recordingUrl: null,
  transcriptUrl: null,
};

// Jobs feed fixtures. /jobs lists jobs only when `jobs.feed` is on, so the
// public brand switches on that one capability; every other flag stays off
// as before (a key the payload leaves out reads as off). The first page holds
// six fictional postings that cover the card's states: each fit tier, a quick
// estimate, the direct-posting badge, pay not listed, a logo fallback, a saved
// job and quoted badges. Sources are named "Example …" and every link points
// at the reserved .example domain.
const brand = {
  id: 'roboapply', market: 'intl', name: 'RoboApply', canonicalOrigin: 'https://www.roboapply.io',
  locales: ['en', 'zh', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'pt', 'de'], defaultLocale: 'en',
  currency: 'USD', defaultCountry: 'US', authMethods: ['email_password'], paymentRails: [],
  flags: { hiringContacts: 'off', 'jobs.feed': true },
  otherBrand: { id: 'goapply', name: 'GoApply', canonicalOrigin: 'https://www.goapply.top' },
} satisfies Omit<PublicBrand, 'flags'> & { flags: Partial<ResolvedFlags> };

const searchProfiles: SearchProfileListWire = {
  profiles: [{
    id: 'sp_preview', name: 'Example search', isDefault: true, isActive: true, version: 1, schemaVersion: 1,
    filters: { titles: ['Product designer'], workModels: ['remote', 'hybrid'], seniority: ['mid', 'senior'], postedWithinDays: 30 },
    alertInstantMax: 0, alertDigest: null, createdAt: ago(40), updatedAt: ago(3),
  }],
  maxProfiles: 1, maxInstantAlerts: 1, proMaxProfiles: null, upgradable: false,
};

// Fictional marks drawn inline: the preview loads no remote image.
const mark = (tile: string, shape: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="${tile}"/>${shape}</svg>`)}`;
const pay = (min: number | null, max: number | null, currency: string, period: 'year' | 'hour') => ({
  pay: { min, max, currency, period, text: null },
  salary: { text: null, min, max, currency, period, months: null },
});
const why = (tier: FitTier, aligned: string, missing: string): MatchExplanation => ({
  mode: 'personalized',
  headline: { key: 'legal.explain.headline.personalized', params: { tier } },
  reasons: [{ key: 'legal.explain.reason.title_level' }, { key: 'legal.explain.reason.skillsAligned', params: { skills: aligned } }],
  gaps: [{ key: 'legal.explain.gap.skillsMissing', params: { skills: missing } }],
  notices: [{ key: 'legal.explain.notice.notHiringChance' }, { key: 'legal.explain.notice.factors' }, { key: 'legal.explain.notice.turnOff' }],
});
const unflagged = { postedAtEstimated: false, isNew: false, fromRecruiterBank: false, employerVerified: false, isAgency: false, tracker: null };

const feedJobs: FeedItem[] = [
  {
    ...unflagged, jobId: 'job_preview_1', position: 0, isNew: true,
    title: 'Senior Product Designer, Design Systems',
    company: { id: 'co_preview_1', name: 'Paperline Studio', logoUrl: mark('#B7C49A', '<circle cx="20" cy="20" r="9" fill="#121313"/>') },
    location: 'Remote, United States', workModel: 'remote', employmentType: 'full_time', seniority: 'senior',
    ...pay(150000, 180000, 'USD', 'year'),
    postedAt: ago(1), firstSeenAt: ago(1), lastSeenAt: ago(0),
    // Direct from employer: a verified employer's own post in the recruiter bank.
    source: { name: 'Example recruiter bank', kind: 'bank', original: 'Paperline Studio', url: 'https://jobs.example/paperline/senior-product-designer', lastVerifiedAt: ago(0), via: 'bank' },
    apply: { url: 'https://jobs.example/paperline/senior-product-designer', target: null },
    fromRecruiterBank: true, employerVerified: true,
    badges: [{ kind: 'direct_from_employer', label: 'direct_from_employer' }, { kind: 'remote', label: 'remote' }],
    fit: { tier: 'great', score: 91, kind: 'ai', topGap: 'They ask for motion design; your resume shows little of it.', topOverlap: 'You built and ran a design system used by four product teams.', confidence: 'high', confidenceReason: null },
    explanation: why('great', 'Figma, design systems, accessibility', 'motion design'),
  },
  {
    ...unflagged, jobId: 'job_preview_2', position: 1,
    title: 'Product Designer, Growth',
    company: { id: 'co_preview_2', name: 'Harbor & Finch', logoUrl: mark('#A9C3DC', '<path d="M11 28 20 11 29 28Z" fill="#121313"/>') },
    location: 'London, United Kingdom', workModel: 'hybrid', employmentType: 'full_time', seniority: 'mid',
    ...pay(70000, 85000, 'GBP', 'year'),
    postedAt: ago(4), firstSeenAt: ago(3), lastSeenAt: ago(1),
    source: { name: 'Example job board', kind: 'provider', original: null, url: 'https://jobs.example/harbor-finch/product-designer-growth', lastVerifiedAt: ago(1) },
    apply: { url: 'https://jobs.example/harbor-finch/product-designer-growth', target: null },
    badges: [{ kind: 'sponsorship', label: 'sponsorship', quote: 'We can sponsor a Skilled Worker visa for this role.' }],
    fit: { tier: 'good', score: 78, kind: 'ai', topGap: 'They want experiment design; your resume names A/B tests but not how you ran them.', topOverlap: 'Your onboarding redesign lifted activation, which is the work this team owns.', confidence: 'high', confidenceReason: null },
    explanation: why('good', 'user research, prototyping', 'experiment design'),
  },
  {
    ...unflagged, jobId: 'job_preview_3', position: 2,
    title: 'UX Researcher',
    company: { id: 'co_preview_3', name: 'Lakeside Health Cooperative', logoUrl: mark('#C2D9CB', '<rect x="11" y="11" width="18" height="18" rx="4" fill="#121313"/>') },
    location: 'Toronto, Canada', workModel: 'onsite', employmentType: 'full_time', seniority: 'mid',
    // Pay not listed: the posting states none, so both fields are null (never 0).
    pay: null, salary: null,
    // The posting states no date: the card says when it was first seen instead.
    postedAt: ago(9), postedAtEstimated: true, firstSeenAt: ago(9), lastSeenAt: ago(2),
    source: { name: 'Example careers page', kind: 'ats_public', original: 'Lakeside Health Cooperative', url: 'https://jobs.example/lakeside/ux-researcher', lastVerifiedAt: ago(2), via: 'ats' },
    apply: { url: 'https://jobs.example/lakeside/ux-researcher', target: 'employer' },
    badges: [],
    fit: { tier: 'possible', score: 58, kind: 'pre', topGap: 'They ask for clinical research experience.', topOverlap: 'Your interview studies line up with the post.', confidence: 'medium', confidenceReason: null },
    explanation: why('possible', 'usability testing', 'clinical research'),
  },
  {
    ...unflagged, jobId: 'job_preview_4', position: 3,
    title: 'Staff Interaction Designer, Payments Platform and Risk Tooling',
    // No logo: the card shows the company initial.
    company: { id: 'co_preview_4', name: 'Kestrel Mobility Group', logoUrl: null },
    location: 'Austin, Texas, United States', workModel: 'onsite', employmentType: 'contract', seniority: 'lead_staff',
    ...pay(85, 110, 'USD', 'hour'),
    postedAt: ago(12), firstSeenAt: ago(12), lastSeenAt: ago(5),
    source: { name: 'Example job board', kind: 'provider', original: null, url: 'https://jobs.example/kestrel/staff-interaction-designer', lastVerifiedAt: ago(5) },
    apply: { url: 'https://jobs.example/kestrel/staff-interaction-designer', target: null },
    isAgency: true,
    badges: [{ kind: 'clearance_required', label: 'clearance_required', quote: 'Candidates must hold an active security clearance.' }],
    fit: { tier: 'unlikely', score: 34, kind: 'pre', topGap: 'They ask for eight years at staff level; your resume shows four.', topOverlap: null, confidence: 'low', confidenceReason: 'no_level_stated' },
    explanation: why('unlikely', 'interaction design', 'payments, risk tooling'),
  },
  {
    ...unflagged, jobId: 'job_preview_5', position: 4,
    title: 'Design Engineer',
    company: { id: 'co_preview_5', name: 'Tidewater Robotics', logoUrl: mark('#E58E6D', '<path d="M10 25h20M10 18h20" stroke="#121313" stroke-width="4" stroke-linecap="round"/>') },
    location: 'Remote, United States', workModel: 'remote', employmentType: 'full_time', seniority: 'mid',
    ...pay(130000, 155000, 'USD', 'year'),
    postedAt: ago(6), firstSeenAt: ago(6), lastSeenAt: ago(1),
    source: { name: 'Example job board', kind: 'provider', original: null, url: 'https://jobs.example/tidewater/design-engineer', lastVerifiedAt: ago(1) },
    apply: { url: 'https://jobs.example/tidewater/design-engineer', target: null },
    tracker: { status: 'saved' },
    badges: [],
    fit: { tier: 'good', score: 72, kind: 'ai', topGap: 'They want production React; your resume shows prototypes only.', topOverlap: 'Your component library work is the core of this role.', confidence: 'high', confidenceReason: null },
    explanation: why('good', 'TypeScript, component libraries', 'production React'),
  },
  {
    ...unflagged, jobId: 'job_preview_6', position: 5,
    title: 'Lead Product Designer',
    company: { id: 'co_preview_6', name: 'Orchard Ledger', logoUrl: mark('#D4D0E6', '<path d="M12 28V12h7a6 6 0 0 1 0 12h-7" fill="none" stroke="#121313" stroke-width="4"/>') },
    location: 'New York, New York, United States', workModel: 'hybrid', employmentType: 'full_time', seniority: 'lead_staff',
    ...pay(175000, null, 'USD', 'year'),
    postedAt: ago(2), firstSeenAt: ago(2), lastSeenAt: ago(0),
    source: { name: 'Example careers page', kind: 'ats_public', original: 'Orchard Ledger', url: 'https://jobs.example/orchard-ledger/lead-product-designer', lastVerifiedAt: ago(0), via: 'ats' },
    apply: { url: 'https://jobs.example/orchard-ledger/lead-product-designer', target: 'employer' },
    badges: [{ kind: 'sponsorship', label: 'sponsorship', quote: 'H-1B transfers and new sponsorship considered.' }],
    fit: { tier: 'great', score: 86, kind: 'ai', topGap: 'They ask for people management; you have led projects, not reports.', topOverlap: 'Eight years of fintech product design, the domain this team works in.', confidence: 'high', confidenceReason: null },
    explanation: why('great', 'fintech, design leadership', 'people management'),
  },
];

const feedPage: FeedQueryResponse = { items: feedJobs, cursor: null, endOfFeed: true, hiddenByTier: 0, sessionId: 'fs_preview', order: 'personalized', sort: 'recommended', thin: false };

// The split detail (`/jobs?job=<id>` on a wide screen) reads the job and its fit.
const fitView = (job: FeedItem): ScoreJobResponse['fit'] => ({
  jobId: job.jobId, score: job.fit?.score ?? null, tier: job.fit?.tier ?? null, kind: job.fit?.kind ?? 'pre', dimensions: [],
  summary: job.fit?.topOverlap ?? null, strengths: job.fit?.topOverlap ? [job.fit.topOverlap] : [], gaps: job.fit?.topGap ? [job.fit.topGap] : [],
  keywordsMatched: [], keywordsMissing: [], skills: { aligned: [], missing: [], listed: 0 },
  topOverlap: job.fit?.topOverlap ?? null, topGap: job.fit?.topGap ?? null, scoredAt: ago(1), resumeVariantId: null,
  estimateReason: null, summaryLocaleStale: false, cached: true, confidence: job.fit?.confidence,
});
const jobDetail = (job: FeedItem): JobDetailResponse => ({
  job: {
    id: job.jobId, title: job.title, companyName: job.company.name, location: job.location, workModel: job.workModel,
    employmentType: job.employmentType, seniority: job.seniority, pay: job.pay, payText: null,
    summary: { text: `${job.company.name} is hiring a ${job.title} to work with its product and engineering teams. This posting is fictional example data.`, aiWritten: true },
    sections: [
      { kind: 'responsibilities', body: 'Shape the product from early research to shipped detail.\nWork with engineers on every release.\nShare work early and often.' },
      { kind: 'qualifications', body: 'A portfolio of shipped product work.\nComfort presenting decisions and the evidence behind them.' },
    ],
    skills: [{ skill: 'Figma', kind: 'hard', required: true }, { skill: 'Prototyping', kind: 'hard', required: false }, { skill: 'Communication', kind: 'soft', required: true }],
    sponsorship: { status: 'not_stated', quote: null }, requirements: [],
    applyUrl: job.apply?.url ?? null, apply: job.apply, salary: job.salary,
    postedAt: job.postedAt, postedAtEstimated: job.postedAtEstimated ?? false, firstSeenAt: job.firstSeenAt, lastSeenAt: job.lastSeenAt, isNew: job.isNew,
    closedAt: null, status: 'open',
    source: { ...job.source, originalName: job.source.original ?? null },
    fromRecruiterBank: job.fromRecruiterBank, employerVerified: job.employerVerified, isAgency: job.isAgency,
    visibility: 'public', badges: job.badges,
  },
  company: { id: job.company.id, name: job.company.name, slug: null, logoUrl: job.company.logoUrl, domain: null, facts: {}, openJobs: null },
  fit: job.fit ? fitView(job) : null,
  explanation: (job.explanation as MatchExplanation | undefined) ?? null,
  tracker: job.tracker ? { id: `tr_${job.jobId}`, status: job.tracker.status, dateApplied: null } : null,
  checklist: { saved: job.tracker?.status === 'saved', tailoredResumeId: null, coverLetterId: null, practiced: null, applied: false },
  similarIds: [], autofill: { supported: false, atsType: null }, people: { mode: 'off', searchLinks: [] }, marketMeta: {},
});
const newCount: NewCountResponse = { count: 0, since: null };

const fixtures: Record<string, unknown> = {
  [`${base}/account`]: {
    id: 'design-preview-avery', email: 'avery@example.test', name: 'Avery Chen',
    provider: 'email', hasPassword: true, memberSince: '2026-05-01T00:00:00.000Z',
    readinessScore: 78, tier: 'starter', subscriptionStatus: 'active',
    currentPeriodEnd: credits.currentPeriodEnd, cancelAtPeriodEnd: false,
  },
  [`${base}/billing/credits`]: credits,
  [`${base}/billing/history`]: { invoices: [] },
  [`${base}/billing/plan`]: {
    region: { market: 'other', currency: 'USD', method: 'stripe', source: 'design-preview' },
    current: { tier: 'free', status: 'active', amountMinor: 0, currency: 'USD', currentPeriodEnd: null, cancelAtPeriodEnd: false, hasStripeCustomer: false, manualRenewal: false },
    credits, plans: [], stripeConfigured: false, alipayConfigured: false,
  },
  '/api/v1/interview-engine/sessions/recent': { sessions: recentSessions },
  '/api/v1/interview-engine/sessions/ie_preview/report': practiceReport,
  '/api/v1/interview-engine/sessions/ie_preview': {
    session: { ...practiceReport.session, status: 'live', startedAt: new Date(Date.now() - 214_000).toISOString(), endedAt: null },
  },
  '/api/v1/public/brand': brand,
  [`${base}/search-profiles`]: searchProfiles,
  [`${base}/feed/new-count`]: newCount,
  ...Object.fromEntries(feedJobs.map((job) => [`${base}/jobs/${job.jobId}`, jobDetail(job)])),
};

// The live room and the jobs feed are the preview surfaces that POST before they can render.
const postFixtures: Record<string, unknown> = {
  [`${base}/feed/query`]: feedPage,
  ...Object.fromEntries(feedJobs.map((job) => [`${base}/jobs/${job.jobId}/score`, { fit: fitView(job) } satisfies ScoreJobResponse])),
  '/api/v1/interview-engine/sessions/ie_preview/connection': {
    connection: {
      sessionId: 'ie_preview', url: 'wss://preview.invalid', token: 'preview', roomName: 'preview',
      identity: 'preview-candidate', mode: 'video', language: 'en',
      voice: { provider: 'preview', model: 'preview', voiceId: 'preview', languageCode: 'en-US' },
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), agentDispatched: true, recording: false,
    },
  },
};

// The room probes the microphone before it mounts. The preview has no devices
// and grants no permissions, so the probe is answered with an empty stream.
if (navigator.mediaDevices) {
  navigator.mediaDevices.getUserMedia = async () => new MediaStream();
}

function blocked(message: string) {
  const banner = document.querySelector('#design-preview-banner span');
  if (banner) banner.textContent = message;
}
window.fetch = async (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, window.location.href);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const table = method === 'GET' ? fixtures : method === 'POST' ? postFixtures : undefined;
  const data = url.origin === window.location.origin && table ? table[url.pathname] : undefined;
  if (data !== undefined) return new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  blocked('Live action disabled · Example data only');
  return new Response(JSON.stringify({ success: false, code: 'preview_only', error: 'This action is unavailable in the local design preview.' }), { status: 422, headers: { 'Content-Type': 'application/json' } });
};
window.open = () => { blocked('External navigation disabled · Example data only'); return null; };
document.addEventListener('click', (event) => {
  const anchor = (event.target as Element | null)?.closest('a');
  if (!anchor?.href) return;
  const url = new URL(anchor.href, window.location.href);
  if (url.origin !== window.location.origin) {
    event.preventDefault();
    event.stopPropagation();
    blocked('External navigation disabled · Example data only');
  }
}, true);
