import { isLate } from './deadline';

test('late claims are rejected', () => {
  expect(isLate(46)).toBe(true);
  expect(isLate(44)).toBe(false);
});
