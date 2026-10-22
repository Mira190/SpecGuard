'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildUrl, assertAllowed, fetchReport } = require('./codecov-fetch.js');

const SHA = 'a'.repeat(40);
const reply = (status, body, type = 'application/json') => ({ status, headers: { get: () => type }, text: async () => body });
const recorder = (...replies) => { const calls = []; const fn = async (url, init) => { calls.push({ url, init }); return replies.shift(); }; fn.calls = calls; return fn; };

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
  const f = recorder(reply(200, '{"files":[]}'));
  assert.equal(await fetchReport({ owner: 'o', repo: 'r', sha: SHA, fetchImpl: f }), '{"files":[]}');
  assert.equal(f.calls.length, 1);
  const { init } = f.calls[0];
  assert.deepEqual(Object.keys(init.headers).map((k) => k.toLowerCase()), ['accept']);
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal);
});

test('a non-200 answer is an error naming the status, never the body', async () => {
  const f = recorder(reply(404, 'SECRET-BODY-TEXT'));
  await assert.rejects(fetchReport({ owner: 'o', repo: 'r', sha: SHA, fetchImpl: f }), (e) => /HTTP 404/.test(e.message) && !/SECRET/.test(e.message));
});

test('a non-JSON answer is refused without echoing it', async () => {
  await assert.rejects(fetchReport({ owner: 'o', repo: 'r', sha: SHA, fetchImpl: recorder(reply(200, 'SECRET<html>', 'text/html')) }), (e) => /not JSON/.test(e.message) && !/SECRET/.test(e.message));
  await assert.rejects(fetchReport({ owner: 'o', repo: 'r', sha: SHA, fetchImpl: recorder(reply(200, 'SECRET{')) }), (e) => /not valid JSON/.test(e.message) && !/SECRET/.test(e.message));
});

test('one retry on 5xx, not on 4xx', async () => {
  const ok = recorder(reply(503, ''), reply(200, '{}'));
  assert.equal(await fetchReport({ owner: 'o', repo: 'r', sha: SHA, fetchImpl: ok }), '{}');
  assert.equal(ok.calls.length, 2);
  const bad = recorder(reply(500, ''), reply(500, ''), reply(200, '{}'));
  await assert.rejects(fetchReport({ owner: 'o', repo: 'r', sha: SHA, fetchImpl: bad }), /HTTP 500/);
  assert.equal(bad.calls.length, 2);
  const nf = recorder(reply(429, ''), reply(200, '{}'));
  await assert.rejects(fetchReport({ owner: 'o', repo: 'r', sha: SHA, fetchImpl: nf }), /HTTP 429/);
  assert.equal(nf.calls.length, 1);
});
