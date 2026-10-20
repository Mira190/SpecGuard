// Per-runner parsing of one test run into { outcome: pass | assert_fail | throw | error, msg?, frames? } (README "Running"). Pure functions over report text.
const fs = require('node:fs');
const { verdict: mutVerdict } = require('../mutation/mutate');
const { throwOrigin } = require('./verdict');

const rel = (f, cwd) => String(f).replace(/\\/g, '/').replace(cwd.replace(/\\/g, '/') + '/', '').replace(/^file:\/\/\//, '');
// 'at fn (path:line:col)' / 'at path:line:col' frames of a JS stack, innermost first, as 'path:line'.
const jsFrames = (stack, cwd) => [...String(stack).matchAll(/\bat (?:.*? \()?([^\s()]+?):(\d+):\d+\)?/g)].map((m) => `${rel(m[1], cwd)}:${m[2]}`);

// Same assertion marker as mutate.js (its isAssertion is not exported).
const ASSERT = /AssertionError|^Error: expect\(|expected .* to |toMatchSnapshot|Snapshot .* mismatched/m;
const vitestJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const vitestFailed = (j) => (j ? (j.testResults || []).flatMap((x) => x.assertionResults || []).filter((a) => a.status === 'failed') : []);
// vitest --reporter=json. Assertion-vs-error classification is mutate.js verdict(); a thrown non-assertion error also gets its stack origin.
// A pass needs at least one non-skipped passing test; an assertion failure next to a non-assertion failure in the same file is an error.
function parseVitest(res, jsonFile, cwd) {
  const v = mutVerdict(res, jsonFile), j = vitestJson(jsonFile), failed = vitestFailed(j);
  if (v.status === 'survived') return j && j.numPassedTests > 0 ? { outcome: 'pass' } : { outcome: 'error', msg: 'all tests skipped' };
  if (v.status === 'killed') {
    if (failed.some((a) => !(a.failureMessages || []).some((m) => ASSERT.test(m)))) return { outcome: 'error', msg: 'assertion failure and a non-assertion failure in the same file' };
    return { outcome: 'assert_fail', msg: failed.flatMap((a) => a.failureMessages || []).join('\n').slice(0, 1200) }; // msg is for the claim_match labeller only; it never affects the outcome
  }
  if (v.status === 'timeout') return { outcome: 'error', msg: 'timeout' };
  if (!/^non-assertion/.test(v.reason)) return { outcome: 'error', msg: v.reason };
  const first = failed.flatMap((a) => a.failureMessages || [])[0] || '';
  return { outcome: 'throw', msg: first.split('\n')[0], ...throwOrigin(jsFrames(first, cwd), first.split('\n')[0]) };
}

// pytest --junitxml. <error> (collection, fixture) is an error. A <failure> is an assertion when its text says so (assert, AssertionError, pytest.fail, DID NOT RAISE), else a thrown error with the traceback frames.
// Assertion failures next to a thrown error in the same file are an error; so is a file whose tests are all skipped.
const PY_ASSERT = /AssertionError|^\s*E\s+assert\b|message="assert\b|message="Failed: |DID NOT RAISE/m;
function parsePytest(xml, cwd = '') {
  const cases = [...String(xml).matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => m[1] || '');
  if (!cases.length) return { outcome: 'error', msg: 'no tests collected' };
  if (cases.some((c) => /<error\b/.test(c))) return { outcome: 'error', msg: 'collection or fixture error' };
  const fails = cases.filter((c) => /<failure\b/.test(c));
  if (!fails.length) return cases.every((c) => /<skipped\b/.test(c)) ? { outcome: 'error', msg: 'all tests skipped' } : { outcome: 'pass' };
  const clean = (c) => c.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  const asserts = fails.filter((c) => PY_ASSERT.test(c)), others = fails.filter((c) => !PY_ASSERT.test(c));
  if (asserts.length && others.length) return { outcome: 'error', msg: 'assertion failure and a thrown error in the same file' };
  const text = fails.map((c) => clean(c).replace(/<[^>]*>/g, '\n')).join('\n'); // the traceback starts right after the <failure> tag: put it on its own line so its first frame is matched
  if (asserts.length) return { outcome: 'assert_fail', msg: text.slice(0, 1200) };
  const frames = [...text.matchAll(/^(\S+\.py):(\d+): /gm)].map((m) => `${rel(m[1], cwd)}:${m[2]}`).reverse();
  const msg = (/message="([^"]*)"/.exec(fails[0]) || [])[1] || 'exception';
  return { outcome: 'throw', msg, ...throwOrigin(frames, msg) };
}

// A Go trace frame as repo-relative 'path:line', or null for the standard library, GOROOT or a dependency.
// Absolute path: repo-local when under cwd, else GOROOT or the module cache. -trimpath path: a dotted first element is a module path (the repo or a dependency, dependencies carry @v), a dotless one is the standard library.
function goFrame(p, cwd) {
  const q = p.replace(/\\/g, '/'), c = cwd.replace(/\\/g, '/');
  if (/^[A-Za-z]:\/|^\//.test(q)) return q.startsWith(c + '/') ? q.slice(c.length + 1) : null;
  return q.split('/')[0].includes('.') && !/@v\d/.test(q) ? q : null;
}
// go test -json. Build failure and test timeout are errors; a panic is a throw (frames from the goroutine trace); other test failures (t.Error, testify) are assertion failures. A pass needs a non-skipped passing test.
function parseGo(jsonl, cwd = '', stderr = '') {
  const ev = String(jsonl).split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const out = ev.map((e) => e.Output || '').join('');
  if (/\[build failed\]|\[setup failed\]|cannot find package|no required module/.test(out)) return { outcome: 'error', msg: 'build or setup failed' };
  if (!ev.some((e) => e.Action === 'pass' || e.Action === 'fail') || !ev.some((e) => e.Test)) return { outcome: 'error', msg: `no tests ran: ${(out + ' ' + (stderr || '')).replace(/\s+/g, ' ').trim().slice(-200)}` };
  if (/^panic: test timed out/m.test(out)) return { outcome: 'error', msg: 'test timed out' };
  if (!ev.some((e) => e.Action === 'fail')) return ev.some((e) => e.Test && e.Action === 'pass') ? { outcome: 'pass' } : { outcome: 'error', msg: 'all tests skipped' };
  if (/^panic: /m.test(out)) {
    const msg = (/^panic: (.*)$/m.exec(out) || [])[1] || 'panic';
    const frames = [...out.matchAll(/^\s+(\S+\.go):(\d+) \+0x/gm)].map((m) => [goFrame(m[1], cwd), m[2]]).filter(([p]) => p).map(([p, l]) => `${p}:${l}`);
    return { outcome: 'throw', msg, ...throwOrigin(frames, msg) };
  }
  return { outcome: 'assert_fail', msg: out.slice(-1200) };
}

// One run over several test files: any error is an error (a second file cannot hide it); an assertion failure next to a throw is an error; else the common non-pass outcome, else pass.
function combine(outs) {
  const bad = outs.filter((o) => o.outcome !== 'pass');
  if (!bad.length) return outs[0];
  const err = bad.find((o) => o.outcome === 'error');
  if (err) return err;
  if (bad.some((o) => o.outcome === 'assert_fail') && bad.some((o) => o.outcome === 'throw')) return { outcome: 'error', msg: 'assertion failure and a thrown error across the test files' };
  return bad[0];
}

module.exports = { parseVitest, parsePytest, parseGo, jsFrames, combine, goFrame };
