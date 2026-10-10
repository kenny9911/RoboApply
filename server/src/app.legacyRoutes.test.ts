// @vitest-environment node
// WP-75 (ARCH §10.6 steps 3 and 9): the V1 auto-apply routers, services,
// agents and board adapters are gone and app.ts no longer mounts them.
// Importing app.ts would open a port and start node-cron, so this reads the
// source and the file tree instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(SRC, 'app.ts'), 'utf8');

const DELETED = [
  'roboapply/routes/missions.ts',
  'roboapply/routes/runs.ts',
  'roboapply/routes/digest.ts',
  'roboapply/routes/settings.ts',
  'roboapply/services/RoboApplyDailyMatcherService.ts',
  'roboapply/services/RoboApplyAuthorService.ts',
  'roboapply/services/RoboApplySubmitterService.ts',
  'roboapply/services/RoboApplyDigestService.ts',
  // RoboApply{Author,Digest}Agent.ts live in roboapply/agents/ (outside
  // WP-75's owns) and import SeekerResumeTailorAgent, so all three stay until
  // INT/WP-93 deletes them together (TASK_PLAN §2.1 rule 8).
  'roboapply/engine/services/boards',
  'roboapply/v2/routes/queue.ts',
  'roboapply/v2/routes/activity.ts',
  'roboapply/v2/routes/integrations.ts',
  'roboapply/v2/routes/onboarding.ts',
  'roboapply/v2/services/RAQueueService.ts',
  'roboapply/v2/services/RAActivityService.ts',
  'roboapply/v2/services/RAIntegrationsService.ts',
  'roboapply/v2/services/RAOnboardingService.ts',
  'roboapply/v2/lib/v1Bridge.ts',
  'lib/anthropicClientFactory.ts',
  'lib/linkedin',
];

describe('V1 engine cleanup (WP-75)', () => {
  it.each(['missions', 'runs', 'digest', 'settings'])('app.ts neither imports nor mounts /api/v1/roboapply/%s', (name) => {
    expect(appSource).not.toContain(`./roboapply/routes/${name}.js`);
    expect(appSource).not.toContain(`'/api/v1/roboapply/${name}'`);
  });

  it('app.ts still mounts the live legacy routers', () => {
    for (const mount of ['auth', 'billing', 'account', 'v2']) {
      expect(appSource).toContain(`'/api/v1/roboapply/${mount}'`);
    }
  });

  it.each(DELETED)('%s is deleted', (rel) => {
    expect(fs.existsSync(path.join(SRC, rel))).toBe(false);
  });
});
