// No request ever reaches native fetch. CSP also rejects connections, media,
// external images, frames, and form submissions as a second local boundary.
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
};

// The live room is the only preview surface that POSTs before it can render.
const postFixtures: Record<string, unknown> = {
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
