/** Log the provider's diagnostic message without serializing response headers. */
export function errorMessage(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== 'object') break;
    const nested = (current as { error?: unknown }).error;
    if (!nested || nested === current) break;
    current = nested;
  }
  const message = current && typeof current === 'object' && 'message' in current
    ? String(current.message)
    : typeof current === 'string' ? current : 'unknown error';
  return message.split('\n')[0]!.slice(0, 500);
}

/** AgentSession.close() does not close the TTS model or its recovery tasks. */
export class SessionLifecycle {
  private stopped = false;
  private heardAudio = false;
  private closePromise?: Promise<void>;
  private resolveClosed!: (value: 'closed') => void;
  readonly whenClosed = new Promise<'closed'>((resolve) => { this.resolveClosed = resolve; });

  constructor(
    private readonly closeTts: () => Promise<void>,
    private readonly warn: (message: string) => void,
  ) {}

  get active(): boolean { return !this.stopped; }

  recordAudio(): void {
    if (this.active) this.heardAudio = true;
  }

  close(): Promise<void> {
    // Latch synchronously: a pending greeting can settle before cleanup finishes.
    this.stopped = true;
    this.resolveClosed('closed');
    this.closePromise ??= Promise.resolve().then(this.closeTts).catch((error: unknown) => {
      this.warn(`TTS cleanup failed: ${errorMessage(error)}`);
    });
    return this.closePromise;
  }

  /** A settled SpeechHandle can mean zero audio; only a speaking event proves it played. */
  async greet(
    speak: (repeat: boolean) => Promise<void>,
    fallback?: () => Promise<void>,
  ): Promise<boolean> {
    if (!this.active) return false;
    try {
      await speak(false);
    } catch (error) {
      this.warn(`primary greeting failed: ${errorMessage(error)}`);
      if (this.active && fallback) {
        try {
          await fallback();
        } catch (fallbackError) {
          this.warn(`fallback greeting failed: ${errorMessage(fallbackError)}`);
        }
      }
    }

    if (this.active && !this.heardAudio) {
      this.warn('greeting produced no audible frames — re-issuing once');
      try {
        await speak(true);
      } catch (error) {
        this.warn(`greeting re-issue failed: ${errorMessage(error)}`);
      }
    }
    return this.active && this.heardAudio;
  }
}
