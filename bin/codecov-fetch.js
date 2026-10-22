#!/usr/bin/env node
'use strict';
// Fetch a public Codecov report for one commit: node codecov-fetch.js <owner> <repo> <sha> <flag|-> <out.json>
// Anonymous GET to https://api.codecov.io only (hard-coded host); no auth header, ever. Node built-ins only.
const fs = require('node:fs');
const { MAX_BYTES } = require('./codecov-to-lcov.js');

const HOST = 'api.codecov.io';

function buildUrl(owner, repo, sha, flag) {
  if (!/^[A-Za-z0-9._-]+$/.test(owner || '') || !/^[A-Za-z0-9._-]+$/.test(repo || '')) throw new Error('bad owner or repo');
  if (!/^[0-9a-f]{40}$/.test(sha || '')) throw new Error('sha must be 40 hex characters');
  let u = `https://${HOST}/api/v2/github/${encodeURIComponent(owner)}/repos/${encodeURIComponent(repo)}/report/?sha=${sha}`;
  if (flag) u += `&flag=${encodeURIComponent(flag)}`;
  return u;
}

function assertAllowed(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.host !== HOST || u.username || u.password) throw new Error(`refused host: only https://${HOST} is allowed`);
}

// fetchImpl is injectable for tests; the default is the global fetch.
async function fetchReport({ owner, repo, sha, flag, fetchImpl = fetch }) {
  const url = buildUrl(owner, repo, sha, flag);
  assertAllowed(url);
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    // no headers beyond Accept: nothing that identifies or authenticates us; redirects are refused so the host cannot change
    res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (res.status < 500) break;
  }
  if (res.status !== 200) throw new Error(`Codecov answered HTTP ${res.status}`);
  if (!/json/i.test(res.headers.get('content-type') || '')) throw new Error('Codecov answer is not JSON');
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('report larger than 50 MB refused');
  try { JSON.parse(text); } catch { throw new Error('Codecov answer is not valid JSON'); }
  return text;
}

if (require.main === module) {
  const [owner, repo, sha, flag, out] = process.argv.slice(2);
  fetchReport({ owner, repo, sha, flag: flag === '-' ? '' : flag })
    .then((text) => { fs.writeFileSync(out, text); console.error('codecov-fetch: report saved'); })
    .catch((e) => { console.error(`codecov-fetch: ${e.message}`); process.exit(1); });
}

module.exports = { buildUrl, assertAllowed, fetchReport, HOST };
