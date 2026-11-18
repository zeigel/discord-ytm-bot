import { describe, expect, it } from 'vitest';
import { Mutex } from '../src/utils/mutex.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Mutex', () => {
  it('runs tasks one at a time, in call order', async () => {
    const mutex = new Mutex();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`${name}:start`);
      await sleep(ms);
      events.push(`${name}:end`);
    };
    await Promise.all([
      mutex.runExclusive(task('a', 15)),
      mutex.runExclusive(task('b', 1)),
      mutex.runExclusive(task('c', 5)),
    ]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('never overlaps tasks', async () => {
    const mutex = new Mutex();
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await sleep(1);
      running--;
    };
    await Promise.all(Array.from({ length: 10 }, () => mutex.runExclusive(task)));
    expect(maxRunning).toBe(1);
  });

  it('keeps going after a task throws, and rejects only that caller', async () => {
    const mutex = new Mutex();
    let failure: unknown;
    const bad = mutex.runExclusive(() => {
      throw new Error('boom');
    });
    bad.catch((err: unknown) => {
      failure = err;
    });
    const good = await mutex.runExclusive(() => 42);
    expect(good).toBe(42);
    expect((failure as Error).message).toBe('boom');
  });

  it('returns the task result for sync and async tasks', async () => {
    const mutex = new Mutex();
    expect(await mutex.runExclusive(() => 'sync')).toBe('sync');
    expect(await mutex.runExclusive(async () => 'async')).toBe('async');
  });
});
