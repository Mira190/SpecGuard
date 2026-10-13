import { isLate } from './deadline';

test('very old claims are late', () => {
  expect(isLate(60 * 864e5)).toBe(true);
});
