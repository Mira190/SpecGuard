// Per-runner parsing of one test run into { outcome: pass | assert_fail | throw | error, msg?, frames? } (README "Running"). Pure functions over report text.
const fs = require('node:fs');
const { verdict: mutVerdict } = require('../mutation/mutate');
const { throwOrigin } = require('./verdict');

const rel = (f, cwd) => String(f).replace(/\\/g, '/').replace(cwd.replace(/\\/g, '/') + '/', '').replace(/^file:\/\/\//, '');
// 'at fn (path:line:col)' / 'at path:line:col' frames of a JS stack, innermost first, as 'path:line'.
const jsFrames = (stack, cwd) => [...String(stack).matchAll(/\bat (?:.*? \()?([^\s()]+?):(\d+):\d+\)?/g)].map((m) => `${rel(m[1], cwd)}:${m[2]}`);

const vitestFailures = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).testResults.flatMap((x) => x.assertionResults || []).filter((a) => a.status === 'failed').flatMap((a) => a.failureMessages || []).join('\n'); } catch { return ''; } };
// vitest --reporter=json. Assertion-vs-error classification is mutate.js verdict(); a thrown non-assertion error also gets its stack origin.
function parseVitest(res, jsonFile, cwd) {
  const v = mutVerdict(res, jsonFile);
  if (v.status === 'survived') return { outcome: 'pass' };
  if (v.status === 'killed') return { outcome: 'assert_fail', msg: vitestFailures(jsonFile).slice(0, 1200) }; // msg is for the claim_match labeller only; it never affects the outcome
  if (v.status === 'timeout') return { outcome: 'error', msg: 'timeout' };
  if (!/^non-assertion/.test(v.reason)) return { outcome: 'error', msg: v.reason };
  let msgs = [];
  try { msgs = JSON.parse(fs.readFileSync(jsonFile, 'utf8')).testResults.flatMap((s) => s.assertionResults || []).filter((a) => a.status === 'failed').flatMap((a) => a.failureMessages || []); } catch { /* no detail */ }
  const first = msgs[0] || '';
  return { outcome: 'throw', msg: first.split('\n')[0], ...throwOrigin(jsFrames(first, cwd), first.split('\n')[0]) };
}

// pytest --junitxml. <error> (collection, fixture) is an error; a <failure> is an assertion when its text says so, else a thrown error with the traceback frames.
function parsePytest(xml, cwd = '') {
  const cases = [...String(xml).matchAll(/<testcase\b[^>]*?(?:\/>|>([\s\S]*?)<\/testcase>)/g)].map((m) => m[1] || '');
  if (!cases.length) return { outcome: 'error', msg: 'no tests collected' };
  if (cases.some((c) => /<error\b/.test(c))) return { outcome: 'error', msg: 'collection or fixture error' };
  const fails = cases.filter((c) => /<failure\b/.test(c));
  if (!fails.length) return cases.every((c) => /<skipped\b/.test(c)) ? { outcome: 'error', msg: 'all tests skipped' } : { outcome: 'pass' };
  const text = fails.map((c) => c.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')).join('\n');
  if (fails.some((c) => /AssertionError|^\s*E\s+assert\b|message="assert\b/m.test(c))) return { outcome: 'assert_fail', msg: text.slice(0, 1200) };
  const frames = [...text.matchAll(/^(\S+\.py):(\d+): /gm)].map((m) => `${rel(m[1], cwd)}:${m[2]}`).reverse();
  const msg = (/message="([^"]*)"/.exec(fails[0]) || [])[1] || 'exception';
  return { outcome: 'throw', msg, ...throwOrigin(frames, msg) };
}

// go test -json. Build failure is an error; a panic is a throw (frames from the goroutine trace); other test failures (t.Error, testify) are assertion failures.
function parseGo(jsonl, cwd = "", stderr = "") {
  const ev = String(jsonl).split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const out = ev.map((e) => e.Output || '').join('');
  if (/\[build failed\]|\[setup failed\]|cannot find package|no required module/.test(out)) return { outcome: 'error', msg: 'build or setup failed' };
  if (!ev.some((e) => e.Action === 'pass' || e.Action === 'fail') || !ev.some((e) => e.Test)) return { outcome: 'error', msg: `no tests ran: ${(out + ' ' + (stderr || '')).replace(/\s+/g, ' ').trim().slice(-200)}` };
  if (!ev.some((e) => e.Action === 'fail')) return { outcome: 'pass' };
  if (/^panic: /m.test(out)) {
    const msg = (/^panic: (.*)$/m.exec(out) || [])[1] || 'panic';
    const frames = [...out.matchAll(/^\s+(\S+\.go):(\d+) \+0x/gm)].map((m) => `${rel(m[1], cwd)}:${m[2]}`);
    return { outcome: 'throw', msg, ...throwOrigin(frames, msg) };
  }
  return { outcome: 'assert_fail', msg: out.slice(-1200) };
}

module.exports = { parseVitest, parsePytest, parseGo, jsFrames };
