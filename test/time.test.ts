import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/utils/time.js';

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [65, '1:05'],
    [599, '9:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [59.9, '0:59'],
    [-10, '0:00'],
  ])('formats %d as %s', (input, expected) => {
    expect(formatDuration(input)).toBe(expected);
  });
});
