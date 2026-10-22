'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildUrl, assertAllowed, fetchReport } = require('./codecov-fetch.js');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const good = (sha = SHA) => JSON.stringify({ totals: {}, files: [], commit_file_url: `https://app.codecov.io/github/o/r/commit/${sha}/tree/` });
const reply = (status, body, type = 'application/json', extra = {}) => ({ status, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? type : extra[k.toLowerCase()] ?? null) }, text: async () => body });
const recorder = (...replies) => { const calls = []; const fn = async (url, init) => { calls.push({ url, init }); return replies.shift(); }; fn.calls = calls; return fn; };
const args = (fetchImpl) => ({ owner: 'o', repo: 'r', sha: SHA, fetchImpl, retryDelayMs: 0 });

test('builds the exact URL; the flag is appended and encoded', () => {
  assert.equal(buildUrl('honojs', 'hono', SHA), `https://api.codecov.io/api/v2/github/honojs/repos/hono/report/?sha=${SHA}`);
  assert.equal(buildUrl('o', 'r', SHA, 'unit tests&x=1'), `https://api.codecov.io/api/v2/github/o/repos/r/report/?sha=${SHA}&flag=unit%20tests%26x%3D1`);
});

test('owner, repo and sha are validated, so they cannot change the host or path', () => {
  assert.throws(() => buildUrl('evil.com/x?', 'r', SHA), /bad owner/);
  assert.throws(() => buildUrl('o', 'r/../x', SHA), /bad owner/);
  assert.throws(() => buildUrl('o', 'r', 'main'), /sha/);
});

test('host allow-list: only https://api.codecov.io', () => {
  assertAllowed(buildUrl('o', 'r', SHA));
  for (const u of ['https://evil.example/x', 'http://api.codecov.io/x', 'https://api.codecov.io.evil.example/x', 'https://user:pw@api.codecov.io/x', 'https://api.codecov.io:8443/x']) {
    assert.throws(() => assertAllowed(u), /refused host/, u);
  }
});

test('sends one anonymous GET: no auth, cookie or token header; redirects refused; timeout set', async () => {
  const f = recorder(reply(200, good()));
  assert.equal(await fetchReport(args(f)), good());
  assert.equal(f.calls.length, 1);
  const { init } = f.calls[0];
  assert.deepEqual(Object.keys(init.headers).map((k) => k.toLowerCase()), ['accept']);
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal);
});

test('a report for another sha (or without commit_file_url) is refused', async () => {
  await assert.rejects(fetchReport(args(recorder(reply(200, good(OTHER))))), /report is not for the requested sha/);
  await assert.rejects(fetchReport(args(recorder(reply(200, '{"files":[]}')))), /report is not for the requested sha/);
  await assert.rejects(fetchReport(args(recorder(reply(200, '[]')))), /report is not for the requested sha/);
});

test('a non-200 answer is an error naming the status, never the body', async () => {
  const f = recorder(reply(404, 'SECRET-BODY-TEXT'));
  await assert.rejects(fetchReport(args(f)), (e) => /HTTP 404/.test(e.message) && !/SECRET/.test(e.message));
});

test('a non-JSON answer is refused without echoing it', async () => {
  await assert.rejects(fetchReport(args(recorder(reply(200, 'SECRET<html>', 'text/html')))), (e) => /not JSON/.test(e.message) && !/SECRET/.test(e.message));
  await assert.rejects(fetchReport(args(recorder(reply(200, 'SECRET{')))), (e) => /not valid JSON/.test(e.message) && !/SECRET/.test(e.message));
});

test('one retry on 5xx, not on 4xx', async () => {
  const ok = recorder(reply(503, ''), reply(200, good()));
  assert.equal(await fetchReport(args(ok)), good());
  assert.equal(ok.calls.length, 2);
  const bad = recorder(reply(500, ''), reply(500, ''), reply(200, good()));
  await assert.rejects(fetchReport(args(bad)), /HTTP 500/);
  assert.equal(bad.calls.length, 2);
  const nf = recorder(reply(429, ''), reply(200, good()));
  await assert.rejects(fetchReport(args(nf)), /HTTP 429/);
  assert.equal(nf.calls.length, 1);
});

test('the retry waits before the second request', async () => {
  const f = recorder(reply(500, ''), reply(200, good()));
  const t0 = Date.now();
  await fetchReport({ ...args(f), retryDelayMs: 60 });
  assert.ok(Date.now() - t0 >= 50);
});

test('a content-length over the cap is refused before the body is read', async () => {
  let read = false;
  const r = reply(200, good(), 'application/json', { 'content-length': String(50 * 1024 * 1024 + 1) });
  r.text = async () => { read = true; return good(); };
  await assert.rejects(fetchReport(args(recorder(r))), /50 MB/);
  assert.equal(read, false);
});
