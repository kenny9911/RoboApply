// hooks/copilot/stopTurn.ts — tell the server to stop the reply being written
// (the Stop button; POST /copilot/threads/:id/stop).
//
// Aborting the fetch is not enough: a proxy between the browser and the API
// (the dev rewrite, a platform router) may keep the upstream request open
// after the browser left, so the server went on writing and stored the full
// answer while the screen said "Stopped.". The Stop button therefore also
// names the thread to stop.
//
// The call is the `stopTurn(threadId)` wrapper in lib/api/copilot.ts (every
// Assistant endpoint is wrapped there; the API-boundary check refuses the URL
// anywhere else). It is imported by name, so a missing wrapper is a type error.

import { stopTurn } from '../../lib/api/copilot';

/** Ask the server to stop the running reply of `threadId`. Never throws; false when it could not be asked. */
export async function requestStopTurn(threadId: string | null | undefined): Promise<boolean> {
  if (!threadId) return false;
  try {
    await stopTurn(threadId);
    return true;
  } catch {
    // Stop is best effort: the stream was aborted on this side either way.
    return false;
  }
}
