// @vitest-environment node
// WP-75: the in-process node-cron mirror registers only the kept legacy jobs
// and the platform crons; the V1 auto-apply jobs and the Friday nudge are gone.
import { afterEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  schedule: vi.fn((_expr: string, _fn: () => void) => ({ stop: vi.fn() })),
  info: vi.fn(),
  purgeCache: vi.fn(async () => ({ deleted: 0 })),
  purgeAccounts: vi.fn(async () => ({})),
}));

vi.mock('node-cron', () => ({
  default: { validate: () => true, schedule: m.schedule },
}));
vi.mock('../../services/LoggerService.js', () => ({
  logger: { info: m.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../services/RoboApplyBillingReminderService.js', () => ({ runRenewalReminderSweep: vi.fn(async () => ({})) }));
vi.mock('../services/SeekerAccountPurgeService.js', () => ({ runAccountPurgeSweep: m.purgeAccounts }));
vi.mock('../../interview-engine/sessions/InterviewSessionService.js', () => ({
  interviewSessionService: { reconcileExpiredSessions: vi.fn(async () => ({ finalized: 0, expired: 0 })) },
}));
vi.mock('../../cron/handlers.js', () => ({
  PLATFORM_CRON_JOBS: [{ name: 'queue-drain', schedule: '*/5 * * * *', owner: 'FND-3', run: vi.fn() }],
  runPlatformCron: vi.fn(),
  purgeLegacyCoverLetterCache: m.purgeCache,
}));

import { __test, startRoboApplyCron, stopRoboApplyCron } from './RoboApplyCronService.js';

function registeredLabels(): string[] {
  return m.info.mock.calls
    .map((c) => String(c[1]))
    .filter((msg) => msg.startsWith('registered '))
    .map((msg) => msg.split(' ')[1]!);
}

describe('RoboApplyCronService (WP-75)', () => {
  afterEach(() => {
    stopRoboApplyCron();
    m.schedule.mockClear();
    m.info.mockClear();
    delete process.env.ROBOAPPLY_CRON_DISABLED;
  });

  it('registers only billing renewal, account purge, interview cleanup and the platform crons', () => {
    startRoboApplyCron();
    expect(registeredLabels()).toEqual(['billing_renewal_reminder', 'account_purge', 'interview_cleanup', 'platform_queue-drain']);
    expect(m.schedule).toHaveBeenCalledTimes(4);
  });

  it('no V1 job (matcher, digest, submitter, catchup, cache cleanup, Friday nudge) is registered', () => {
    startRoboApplyCron();
    const labels = registeredLabels();
    for (const gone of ['matcher', 'digest', 'submitter', 'catchup', 'cache_cleanup', 'billing_friday_nudge']) {
      expect(labels).not.toContain(gone);
    }
    expect(Object.keys(__test).sort()).toEqual([
      'DEFAULT_ACCOUNT_PURGE_CRON',
      'DEFAULT_INTERVIEW_CLEANUP_CRON',
      'DEFAULT_RENEWAL_REMINDER_CRON',
    ]);
  });

  it('the account purge job also clears the dead V1 cover-letter cache', async () => {
    startRoboApplyCron();
    const idx = registeredLabels().indexOf('account_purge');
    const fn = m.schedule.mock.calls[idx]![1] as () => Promise<void>;
    await fn();
    expect(m.purgeCache).toHaveBeenCalledTimes(1);
    expect(m.purgeAccounts).toHaveBeenCalledTimes(1);
  });

  it('the kill switch still registers nothing', () => {
    process.env.ROBOAPPLY_CRON_DISABLED = 'true';
    startRoboApplyCron();
    expect(m.schedule).not.toHaveBeenCalled();
  });
});
