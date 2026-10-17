const REQUEST_TIMEOUT_MS = 30 * 1000;

function buildRequest(url) {
  if (!url.startsWith('https://')) throw new Error('https required');
  return { url, timeoutMs: REQUEST_TIMEOUT_MS };
}

module.exports = { buildRequest, REQUEST_TIMEOUT_MS };
