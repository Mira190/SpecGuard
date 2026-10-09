import { calcPremium } from './premium';

test('caps the premium', () => {
  expect(calcPremium('auto', 10)).toBe(200);
});
