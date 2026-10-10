// components/features/agent/options.ts — runtime copies of the agent
// contract's option lists (lib/api/contracts/agent is type-only, FND-7).
// `satisfies` keeps every value a legal contract value; a test
// (agent.test.tsx) checks the lists equal the server contract's.

import type { AgentSettings, AgentSetupResponse } from '../../../lib/api/contracts/agent';

export const WEEKLY_TARGETS = [5, 10, 20, 30] as const satisfies readonly AgentSettings['weeklyTarget'][];
export const MIN_TIERS = ['great', 'good', 'possible'] as const satisfies readonly AgentSettings['minTier'][];
export const COVER_LETTER_MODES = ['when_required', 'always', 'never'] as const satisfies readonly AgentSettings['coverLetterMode'][];
export const FILE_NAME_STYLES = ['name_company_role', 'name_role', 'company_role_name', 'name_date'] as const satisfies readonly AgentSettings['fileNameStyle'][];
export const SETUP_STEPS = ['profile', 'calibrate', 'answers', 'weekly', 'extension', 'done'] as const satisfies readonly AgentSetupResponse['step'][];
