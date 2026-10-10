// JobTicker — SERVER component: loads the ticker for the request's brand
// (lib/server/publicApi.ts, unstable_cache 5 min) and renders JobTickerView.
// Renders nothing on GoApply (the API answers empty; its home shows the
// campus strip), when nothing may be shown publicly, or when the read fails.
// Import from './server' (never from the client index).

import { getServerBrandId } from '../../../lib/server/brand';
import { loadTicker } from '../../../lib/server/publicApi';
import { JobTickerView } from './JobTickerView';

export async function JobTicker() {
  try {
    const res = await loadTicker(await getServerBrandId());
    if (res.status !== 'ok' || !res.data.items.length) return null;
    return <JobTickerView items={res.data.items} now={new Date().toISOString()} />;
  } catch {
    return null;
  }
}
