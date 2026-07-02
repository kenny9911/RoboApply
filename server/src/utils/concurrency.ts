/**
 * Run async tasks with bounded concurrency.
 * Returns PromiseSettledResult for each task (fulfilled or rejected).
 */
export async function runConcurrent<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];
  const executing = new Set<Promise<void>>();

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const p = (async () => {
      try {
        const value = await task();
        results.push({ status: 'fulfilled', value });
      } catch (reason: any) {
        results.push({ status: 'rejected', reason });
      }
    })();
    const tracked = p.finally(() => executing.delete(tracked));
    executing.add(tracked);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
  return results;
}
