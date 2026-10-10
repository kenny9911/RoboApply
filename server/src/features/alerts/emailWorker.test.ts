// @vitest-environment node
// Tests for server/src/features/notifications/workers.ts (the `email.send`
// worker, owned by WP-39a; notifications/__tests__/ belongs to WP-39b).
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/LoggerService.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../lib/prisma.js', () => ({ default: {} }));

import { createBudget, DeferWorkError, PermanentWorkError, type LeasedWorkItem } from '../../platform/queue/index.js';
import type { SendEmailInput, SendEmailResult } from '../../platform/email/index.js';
import { NOTIFY_TEMPLATES } from '../../platform/email/templates/notify/index.js';
import { createEmailSendWorker, parseEmailSendPayload, workers, type EmailWorkerRecipient } from '../notifications/workers.js';

const ctx = { budget: createBudget(10_000), leaseOwner: 't' };
const item = (payload: unknown, brand: 'roboapply' | 'goapply' = 'roboapply'): LeasedWorkItem => ({
  id: 'w1',
  kind: 'email.send',
  brand,
  userId: 'u1',
  payload: payload as never,
  attempts: 1,
  maxAttempts: 5,
  dedupeKey: null,
  priority: 100,
});

const person = (over: Partial<EmailWorkerRecipient> = {}): EmailWorkerRecipient => ({
  active: true,
  email: 'u1@example.com',
  locale: 'ja',
  timeZone: 'Asia/Tokyo',
  quietHours: { start: '21:00', end: '08:00' },
  ...over,
});

function setup(rec: EmailWorkerRecipient | null, result: SendEmailResult = { status: 'sent' }, now = new Date('2026-10-10T03:00:00Z')) {
  const sent: SendEmailInput[] = [];
  const worker = createEmailSendWorker({
    loadRecipient: async () => rec,
    sendEmail: async (input) => (sent.push(input), result),
    now: () => now,
  });
  return { worker, sent };
}

const followUp = {
  template: NOTIFY_TEMPLATES.followUpReminder,
  userId: 'u1',
  params: { entryId: 'e1', title: 'Engineer', company: 'Acme', appliedAt: '2026-09-30T10:00:00Z', days: 10 },
};

describe('email.send worker', () => {
  it('is registered for the email.send kind', () => {
    expect(workers.map((w) => w.kind)).toEqual(['email.send']);
  });

  it("sends to the person's address in their language, on the item's brand", async () => {
    const { worker, sent } = setup(person()); // 12:00 Tokyo
    await worker.handler(item(followUp), ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'u1@example.com', userId: 'u1', locale: 'ja' });
    expect((sent[0]!.brand as { id: string }).id).toBe('roboapply');
  });

  it('defers non-transactional mail until quiet hours end (no attempt spent)', async () => {
    const { worker, sent } = setup(person(), { status: 'sent' }, new Date('2026-10-10T13:00:00Z')); // 22:00 Tokyo
    const err = await worker.handler(item(followUp), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(DeferWorkError);
    expect((err as DeferWorkError).delayMs).toBe(10 * 3_600_000);
    expect(sent).toHaveLength(0);
  });

  it('transactional mail is not held by quiet hours', async () => {
    await import('../../platform/email/templates/billing/index.js');
    const { worker, sent } = setup(person(), { status: 'sent' }, new Date('2026-10-10T13:00:00Z'));
    await worker.handler(item({ template: 'billing.cancel_none', userId: 'u1', params: {} }), ctx);
    expect(sent).toHaveLength(1);
  });

  it('never sends to a placeholder address or a deleted account', async () => {
    const none = setup(person({ email: null }));
    await none.worker.handler(item(followUp, 'goapply'), ctx);
    expect(none.sent).toHaveLength(0);
    const gone = setup(null);
    await gone.worker.handler(item(followUp), ctx);
    expect(gone.sent).toHaveLength(0);
  });

  it('a deactivated or soft-deleted account gets transactional mail only', async () => {
    await import('../../platform/email/templates/billing/index.js');
    const gone = setup(person({ active: false }));
    await gone.worker.handler(item(followUp), ctx);
    await gone.worker.handler(item({ ...followUp, to: 'u1@example.com' }), ctx); // an explicit address does not bring reminders back
    expect(gone.sent).toHaveLength(0);
    await gone.worker.handler(item({ template: 'billing.cancel_none', userId: 'u1', params: {} }), ctx);
    expect(gone.sent).toHaveLength(1);
  });

  it('an explicit address wins', async () => {
    const { worker, sent } = setup(person());
    await worker.handler(item({ ...followUp, to: 'other@example.com' }), ctx);
    expect(sent[0]!.to).toBe('other@example.com');
  });

  it('retries a transport failure; an unknown template or a bad payload is permanent', async () => {
    const failing = setup(person(), { status: 'failed', reason: 'resend 500' });
    await expect(failing.worker.handler(item(followUp), ctx)).rejects.toThrow(/resend 500/);
    const ok = setup(person());
    await expect(ok.worker.handler(item({ template: 'nope.missing', userId: 'u1', params: {} }), ctx)).rejects.toBeInstanceOf(PermanentWorkError);
    expect(() => parseEmailSendPayload({ params: {} })).toThrow(PermanentWorkError);
    expect(() => parseEmailSendPayload({ template: 'x.y', params: {} })).toThrow(/to` or `userId/);
  });

  it('a suppressed send (preference off) is done, not retried', async () => {
    const { worker } = setup(person(), { status: 'suppressed', reason: 'preference_off' });
    await expect(worker.handler(item(followUp), ctx)).resolves.toBeUndefined();
  });
});
