const TIMEOUT = 30000;

function buildRequest(url) {
  if (!url.startsWith('https://')) throw new Error('https required');
  return { url, timeoutMs: TIMEOUT };
}

module.exports = { buildRequest, TIMEOUT };
