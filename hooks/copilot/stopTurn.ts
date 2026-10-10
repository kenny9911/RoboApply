// hooks/copilot/stopTurn.ts — tell the server to stop the reply being written
// (the Stop button; POST /copilot/threads/:id/stop).
//
// Aborting the fetch is not enough: a proxy between the browser and the API
// (the dev rewrite, a platform router) may keep the upstream request open
// after the browser left, so the server went on writing and stored the full
// answer while the screen said "Stopped.". The Stop button therefore also
// names the thread to stop.
//
// The call itself belongs in lib/api/copilot.ts (`stopTurn(threadId)`): every
// Assistant endpoint is wrapped there, and the API-boundary check
// (scripts/check-api-boundary.mjs) refuses the URL anywhere else. That file is
// not this area's to edit, so until the wrapper is added (FIX-5 handoff,
// Request 1) THE STOP BUTTON DOES NOT REACH THE SERVER: this is a no-op that
// warns in development, and stopTurn.test.ts has a tripwire that goes red the
// moment the wrapper exists. Then replace the by-name lookup below with
//   import { stopTurn } from '../../lib/api/copilot';
// so that a missing wrapper is a type error, and delete the tripwire.

import * as copilotApi from '../../lib/api/copilot';

type StopTurn = (threadId: string) => Promise<unknown>;

/** Looked up by name at run time, so the bundler does not ask for an export that is not there yet. */
const WRAPPER_NAME = 'stopTurn';

function wrapper(): StopTurn | null {
  try {
    const fn = (copilotApi as unknown as Record<string, unknown>)[WRAPPER_NAME];
    return typeof fn === 'function' ? (fn as StopTurn) : null;
  } catch {
    // A module double without the export (tests): nothing to call.
    return null;
  }
}

let warned = false;

/** Ask the server to stop the running reply of `threadId`. Never throws; false when it could not be asked. */
export async function requestStopTurn(threadId: string | null | undefined): Promise<boolean> {
  if (!threadId) return false;
  const stop = wrapper();
  if (!stop) {
    if (!warned && process.env.NODE_ENV !== 'production') {
      warned = true;
      console.warn('[assistant] Stop did not reach the server: lib/api/copilot.ts has no stopTurn wrapper yet (see hooks/copilot/stopTurn.ts).');
    }
    return false;
  }
  try {
    await stop(threadId);
    return true;
  } catch {
    // Stop is best effort: the stream was aborted on this side either way.
    return false;
  }
}
