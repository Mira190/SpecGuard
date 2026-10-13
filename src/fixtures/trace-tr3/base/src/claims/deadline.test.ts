import { isLate } from './deadline';

test('late claims are rejected', () => {
  expect(isLate(31)).toBe(true);
  expect(isLate(29)).toBe(false);
});
