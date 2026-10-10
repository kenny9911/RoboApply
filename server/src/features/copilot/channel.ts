// server/src/features/copilot/channel.ts — a push-based async iterable for turn events (WP-50).
//
// The turn runner pushes SSE events as the model streams; the route (or
// WP-78's visitor route) iterates them and writes each one. Breaking out of
// the loop calls `onReturn` (the route also aborts the model call).

export class EventChannel<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;
  onReturn: (() => void) | null = null;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.queue.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined as unknown as T, done: true });
  }

  get closed(): boolean {
    return this.ended;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length) return Promise.resolve({ value: this.queue.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: async (): Promise<IteratorResult<T>> => {
        this.onReturn?.();
        this.end();
        return { value: undefined as unknown as T, done: true };
      },
    };
  }
}

/** Collect every event (tests and non-streaming callers). */
export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of stream) out.push(e);
  return out;
}
