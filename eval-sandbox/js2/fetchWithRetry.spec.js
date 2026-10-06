import { afterEach, expect, jest, test } from '@jest/globals';
import { fetchWithRetry } from './fetchWithRetry.js';

afterEach(() => {
  jest.restoreAllMocks();
});

test('returns the response when the first attempt succeeds', async () => {
  const response = { ok: true };
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(response);
  await expect(fetchWithRetry('https://api.test/items')).resolves.toBe(response);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(fetchSpy).toHaveBeenCalledWith('https://api.test/items');
});
