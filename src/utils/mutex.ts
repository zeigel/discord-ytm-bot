/**
 * Async mutex built on a promise chain. Tasks run one at a time, in the order runExclusive was called.
 * A task that throws rejects only its own caller; the chain keeps going.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(task: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
