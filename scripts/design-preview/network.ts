// No request ever reaches native fetch. CSP also rejects connections, media,
// external images, frames, and form submissions as a second local boundary.
const base = '/api/v1/roboapply';
const credits = { balance: 120, periodAllotment: 180, tier: 'starter', currentPeriodEnd: '2026-10-01T00:00:00.000Z', creditMinutes: 1 };
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
  '/api/v1/interview-engine/sessions/recent': { sessions: [] },
};

function blocked(message: string) {
  const banner = document.querySelector('#design-preview-banner span');
  if (banner) banner.textContent = message;
}
window.fetch = async (input, init) => {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, window.location.href);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const data = url.origin === window.location.origin && method === 'GET' ? fixtures[url.pathname] : undefined;
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
