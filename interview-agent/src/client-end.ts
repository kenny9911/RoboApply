// Candidate-initiated end (contract C8). The control plane relays the
// browser's End as a reliable data message {type:'end'} on topic `ie`. The
// worker then: stops taking turns, latches the lifecycle (cancels a pending
// greeting/question, nudges, time notes), closes the session with a bound so
// the interrupted assistant item is committed, and shuts the job down — the
// job's shutdown callback drains the transcript → metrics → usage, then posts
// the 'ended' lifecycle the control plane waits on before deleting the room.
//
// Steps are injected so the ordering and idempotency are unit-testable without
// the LiveKit SDK.

export interface ClientEndSteps {
  /** Stop accepting candidate audio (no new user turns). */
  stopInput: () => void;
  /** Cut the current interviewer speech, if any. May throw if not running. */
  interrupt: () => void;
  /** Latch the session lifecycle closed. */
  closeLifecycle: () => Promise<void>;
  /** Close the AgentSession (commits the interrupted assistant item). */
  closeSession: () => Promise<void>;
  /** Release the job; its shutdown callback drains and posts 'ended'. */
  shutdown: (reason: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Whether the AgentSession is running (interrupt/close only then). */
  sessionStarted: () => boolean;
  warn: (message: string) => void;
  closeTimeoutMs: number;
}

export const CLIENT_END_REASON = 'client_end';

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Returns a once-only trigger: repeated 'end' messages share one run. */
export function createClientEndHandler(steps: ClientEndSteps): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => {
    if (running) return running;
    running = (async () => {
      try {
        steps.stopInput();
      } catch (err) {
        steps.warn(`end: disabling audio input failed: ${describe(err)}`);
      }
      const started = steps.sessionStarted();
      if (started) {
        try {
          steps.interrupt();
        } catch (err) {
          steps.warn(`end: interrupt failed: ${describe(err)}`);
        }
      }
      await steps.closeLifecycle();
      if (started) {
        try {
          await Promise.race([steps.closeSession(), steps.sleep(steps.closeTimeoutMs)]);
        } catch (err) {
          steps.warn(`end: session close failed: ${describe(err)}`);
        }
      }
      steps.shutdown(CLIENT_END_REASON);
    })();
    return running;
  };
}
