import { describe, expect, it } from 'vitest';
import { parseDuration } from './duration';

describe('parseDuration', () => {
  it('parses hours', () => {
    expect(parseDuration('1h')).toBe(3600);
  });
});
