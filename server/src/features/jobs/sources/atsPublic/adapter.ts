// server/src/features/jobs/sources/atsPublic/adapter.ts — the `ats_public`
// entry in the job-source registry (WP-42; MARKET_STRATEGY JI-4, JC-4).
//
// The employer boards are read by their own run, the board sync
// (features/jobs/ingest/boards.ts, cron `jobs-boards`, every 5 minutes): it
// leases due boards, reads several at once, writes each posting into the
// market of its own location and stamps the source. That run is the ONLY
// reader of a board.
//
// The adapter stays registered because three places read it: the source
// registry (which brands list `ats_public`, and under which markets), the
// daily maintenance (`sourceBoards`: these rows never expire by posting age),
// and the admin consoles (transport and state). It declares `ownRun`, so the
// planner keeps no standing `ats_public` query (one planned before the M3 gate
// is switched off by the next `jobs-plan`); its `fetch` reads nothing, so a
// query leased in the meantime finds no work and costs no request.
//
// Both markets. One board feeds both brands; a board is one source row
// ((ats, boardToken) is unique), whatever console added it. Unmetered (public
// APIs, cost model 'free'). Kill switch: ATS_PUBLIC_SOURCES_DISABLED=true
// stops every public job-board read (the board sync, "Check now", candidate
// validation and discovery).

import type { EnvSource } from '../../../../platform/brand/index.js';
import { parseBoolEnv } from '../../../../platform/brand/index.js';
import type { JobSourceAdapter, SourceFetchResult } from '../index.js';
import { PUBLIC_ATS } from './contract.js';

export const ATS_PUBLIC_KILL_SWITCH = 'ATS_PUBLIC_SOURCES_DISABLED';

export interface AtsPublicAdapterDeps {
  env?: EnvSource;
}

export function atsPublicEnabled(env: EnvSource = process.env): boolean {
  return !parseBoolEnv(env[ATS_PUBLIC_KILL_SWITCH]);
}

export function createAtsPublicAdapter(deps: AtsPublicAdapterDeps = {}): JobSourceAdapter {
  const enabled = (): boolean => {
    try {
      return atsPublicEnabled(deps.env ?? process.env);
    } catch {
      return false;
    }
  };
  return {
    provider: 'ats_public',
    kind: 'cursor',
    markets: ['intl', 'cn'],
    costModel: 'free',
    // The board sync is the only reader: no standing ingest query (see `JobSourceAdapter.ownRun`).
    ownRun: true,
    sourceBoards: [...PUBLIC_ATS],
    transport: () => 'board_api',
    disabledReason: () => (enabled() ? null : 'kill_switch'),
    isEnabled: enabled,
    // Boards are curated per company, not searched per country.
    supportsCountry: () => false,
    dailyCallLimit: () => null,
    /** The board sync is the only reader (see the header): nothing to fetch here, and nothing left to page. */
    async fetch(): Promise<SourceFetchResult> {
      return { jobs: [], calls: 0, exhausted: true };
    },
  };
}
