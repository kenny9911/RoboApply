// @vitest-environment node
// WP-75 (ARCH §10.6 steps 3 and 9) and INT-13 (wave5 WP-93 #44, #46, #48,
// #49): the V1 auto-apply routers, services, agents and board adapters, the
// legacy V2 job score/detail and search routes and their helpers are gone,
// and app.ts no longer mounts them.
// Importing app.ts would open a port and start node-cron, so this reads the
// source and the file tree instead. The 404 of each unmounted V2 path is
// asserted in roboapply/v2/routes/index.unmounted.test.ts.
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
  // INT-13: the V1 agents (deleted together: the author agent imported the
  // tailor agent's claim checker) and the last dead V1/V2 helpers.
  'roboapply/agents',
  'roboapply/engine/agents',
  'roboapply/v2/agents/RAOnboardingPrefExtractAgent.ts',
  'roboapply/lib/cacheKey.ts',
  'roboapply/lib/localTime.ts',
  'roboapply/v2/lib/raQueueMessages.ts',
  // INT-13: the legacy job score/detail route and /v2/search.
  'roboapply/v2/routes/jobs.ts',
  'roboapply/v2/routes/jobs.score.test.ts',
  'roboapply/v2/routes/search.ts',
  'roboapply/v2/services/RAJobIndexService.ts',
  'features/match/legacyView.ts',
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

const v2IndexSource = fs.readFileSync(path.join(SRC, 'roboapply/v2/routes/index.ts'), 'utf8');
const ROOT = path.resolve(SRC, '../..');

describe('V1 engine cleanup (WP-75, INT-13)', () => {
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

  it.each(['jobs', 'search', 'queue', 'activity', 'integrations', 'onboarding'])('the V2 aggregate neither imports nor mounts /%s', (name) => {
    expect(v2IndexSource).not.toContain(`./${name}.js`);
    expect(v2IndexSource).not.toMatch(new RegExp(`router\\.use\\(\\s*'/${name}'`));
  });

  it('the V2 aggregate still mounts the live legacy sub-routers (and /discover, pending an owner decision)', () => {
    for (const mount of ['goal', 'tracker', 'resumes', 'insights', 'preferences', 'mock', 'discover', 'admin']) {
      expect(v2IndexSource).toMatch(new RegExp(`router\\.use\\('/${mount}'`));
    }
  });

  it.each(['queue', 'activity', 'integrations', 'savedSearches', 'insights', 'keywords'])('lib/fixtures/%s.ts is deleted and not re-exported', (name) => {
    expect(fs.existsSync(path.join(ROOT, 'lib/fixtures', `${name}.ts`))).toBe(false);
    expect(fs.readFileSync(path.join(ROOT, 'lib/fixtures/index.ts'), 'utf8')).not.toContain(`'./${name}'`);
  });
});
