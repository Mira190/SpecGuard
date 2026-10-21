#!/usr/bin/env node
// V2 corpus: a seeded, stratified, bug-blind sample of merged PRs per repo, plus the "later tested" proxy data. Offline except `sample`'s gh calls (read-only, selected rows only). No model calls.
//   node eval/replay/v2-sample.js sample --repos <clones dir> --out eval/replay/v2-corpus.json --text <pr-text cache json> [--seed 20261021] [--since 2025-07-01] [--follow-days 90]
//   node eval/replay/v2-sample.js later  --repos <clones dir> --corpus eval/replay/v2-corpus.json --out <raw json, outside the repo> [--follow-days 90]
// sample: per repo, pool = squash commits "... (#N)" with one parent in [since, HEAD date - follow-days]; minus every sha / `repo#pr` of the earlier corpora (every 40-hex string in the nine corpus files, plus repo#fix.number of the pairs files); Fisher-Yates shuffle (mulberry32(seed));
//   walk the shuffled order, keep commits with a code file in the repo's source scope (langchain: also coreOnly), by changed-line stratum s1 [30,150) s2 [150,500) s3 [500,1200]; quotas 3/4/3.
//   Changed lines = numstat added+deleted, EXCLUDING docs and lockfiles (paths matching DOCS in ../szz) and binary files.
//   Rows keep the PR body and merge_match (GitHub merge_commit_sha === row sha; null on fallback).
//   Short s3 is filled by extra s2 rows (stratum s3, drawn_from s2), then short s2 by extra s1 rows (drawn_from s1); s1 has no fallback; still short -> reported in `short`, no throw.
// later: for each corpus row, first-parent commits after the merge (committer date in (merge, merge + follow-days]) that add/modify a file in the repo's unit-test scope. The scorer (testsName) is separate.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { listCommits, mulberry32, DOCS } = require('../szz');
const { isCode } = require('./testgap-score');
const { coreOnly } = require('./coverage-e1-confirm-build');
const { git, tryGit } = require('./holdout2-null');

const DAY = 864e5, QUOTAS = { s1: 3, s2: 4, s3: 3 }, STRATA = ['s1', 's2', 's3'];
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : process.argv[i + 1]; };
const here = (f) => path.join(__dirname, f);
const PY = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;
// clone dir name -> GitHub repo, source scope (code file in unit scope), unit-test scope (mirrors eval/f2p/repos.json `cover`)
const CLONES = {
  hono: { gh: 'honojs/hono', src: 'src/', test: { dir: 'src/', file_re: /\.test\.tsx?$/, exclude: 'runtime-tests/' } },
  langchain: { gh: 'langchain-ai/langchain', src: 'libs/core/langchain_core/', core: true, test: { dir: 'libs/core/tests/unit_tests/', file_re: PY } },
  sqlglot: { gh: 'tobymao/sqlglot', src: 'sqlglot/', test: { dir: 'tests/', file_re: PY } },
};

// ---- pure pieces (tested) ----
const stratumOf = (n) => (n >= 30 && n < 150 ? 's1' : n >= 150 && n < 500 ? 's2' : n >= 500 && n <= 1200 ? 's3' : null);
const prOf = (subject) => { const m = /\(#(\d+)\)\s*$/.exec(subject); return m ? +m[1] : null; };
// squash-style single-parent commits only; adds .pr
const poolOf = (commits) => commits.filter((c) => c.parents.length === 1 && prOf(c.subject) != null).map((c) => ({ ...c, pr: prOf(c.subject) }));
const shuffle = (arr, seed) => { const a = arr.slice(), r = mulberry32(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const isExcluded = (ex, sha, key) => ex.shas.has(sha) || ex.keys.has(key);
const addEx = (ex, sha, repo, pr) => { if (sha) ex.shas.add(sha); if (repo && pr != null) ex.keys.add(`${repo}#${pr}`); };
const sumNumstat = (s) => s.split('\n').filter(Boolean).reduce((t, l) => { const [a, d, ...p] = l.split('\t'); return DOCS.test(p.join('\t')) ? t : t + (a === '-' ? 0 : +a || 0) + (d === '-' ? 0 : +d || 0); }, 0);
// walk the shuffled order with classify(c) -> {stratum, ...} | {drop: reason}; stop once the quotas plus both fallbacks are certainly covered
function walk(order, classify, q = QUOTAS) {
  const acc = [], funnel = { examined: 0, size: 0, no_unit_code: 0, not_core: 0 }, n = { s1: 0, s2: 0, s3: 0 };
  for (const c of order) {
    if (n.s1 >= q.s1 + q.s2 && n.s2 >= q.s2 + q.s3 && n.s3 >= q.s3) break;
    funnel.examined++;
    const k = classify(c);
    if (k.drop) { funnel[k.drop]++; continue; }
    n[k.stratum]++; acc.push({ ...c, ...k });
  }
  return { accepted: acc, funnel };
}
// accepted: classified candidates in shuffled order -> rows with stratum/drawn_from, short {stratum: missing}, fallback count
function select(accepted, q = QUOTAS) {
  const by = (s) => accepted.filter((c) => c.stratum === s), own = {}, extra = {};
  for (const s of STRATA) { own[s] = by(s).slice(0, q[s]); extra[s] = by(s).slice(q[s]); }
  const fb3 = extra.s2.slice(0, Math.max(0, q.s3 - own.s3.length)), fb2 = extra.s1.slice(0, Math.max(0, q.s2 - own.s2.length));
  const rows = [...own.s1.map((c) => ({ ...c, drawn_from: 's1' })), ...own.s2.map((c) => ({ ...c, drawn_from: 's2' })), ...fb2.map((c) => ({ ...c, stratum: 's2', drawn_from: 's1' })),
    ...own.s3.map((c) => ({ ...c, drawn_from: 's3' })), ...fb3.map((c) => ({ ...c, stratum: 's3', drawn_from: 's2' }))];
  const short = {};
  for (const s of STRATA) { const m = q[s] - rows.filter((r) => r.stratum === s).length; if (m > 0) short[s] = m; }
  return { rows, short, fallback: fb2.length + fb3.length };
}
const inTestScope = (t, p) => p.startsWith(t.dir) && t.file_re.test(p) && !(t.exclude && (p.startsWith(t.exclude) || p.includes('/' + t.exclude)));

// ---- git side ----
const EXCLUDE_FILES = ['pairs', 'holdout-pairs', 'holdout2-pairs', 'clean', 'holdout-clean', 'holdout2-clean', 'coverage-e1-confirm', 'coverage-e1-design', 'coverage-e3-manifest'];
// texts: { name: raw file text } -> { shas, keys, files: {name: {shas, keys}} }; every 40-hex string anywhere counts, plus the structured repo#pr keys
function exclusionsFrom(texts) {
  const ex = { shas: new Set(), keys: new Set(), files: {} };
  for (const [name, text] of Object.entries(texts)) {
    const e = { shas: new Set(text.match(/\b[0-9a-f]{40}\b/g) || []), keys: new Set() }, j = JSON.parse(text);
    if (name.endsWith('pairs')) for (const p of j.pairs || []) { addEx(e, p.introducing?.merge_commit, p.repo, p.introducing?.number); if (p.fix && p.fix.number != null) addEx(e, null, p.repo, p.fix.number); }
    else if (name.endsWith('clean')) for (const c of Array.isArray(j) ? j : j.prs || j.clean || j.pairs || []) addEx(e, c.merge_commit, c.repo, c.number);
    else if (name === 'coverage-e1-confirm') for (const r of j.rows || []) addEx(e, r.buggy_sha, r.repo, r.kind === 'bug' ? r.introducing?.number : r.pr ?? r.pr_number);
    else if (name === 'coverage-e1-design') for (const r of j) { const m = /(\d+)$/.exec(r.replay_id || ''); addEx(e, r.buggy_sha, r.repo, m ? +m[1] : null); }
    else if (name === 'coverage-e3-manifest') for (const x of [...(j.bugs || []), ...(j.controls || [])]) addEx(e, x.introducing, x.repo, x.pr);
    e.shas.forEach((s) => ex.shas.add(s)); e.keys.forEach((k) => ex.keys.add(k)); ex.files[name] = { shas: e.shas.size, keys: e.keys.size };
  }
  return ex;
}
const loadExcluded = () => exclusionsFrom(Object.fromEntries(EXCLUDE_FILES.map((f) => [f, fs.readFileSync(here(f + '.json'), 'utf8')])));
function ghText(gh, pr) { // read-only
  try { return JSON.parse(execFileSync('gh', ['api', `repos/${gh}/pulls/${pr}`, '--jq', '{title,body,merge_commit_sha}'], { encoding: 'utf8', maxBuffer: 1 << 26 })); } catch { return { failed: true }; }
}
function sampleRepo({ dir, clone, tbl, ex, since, followDays, seed, q = QUOTAS }) {
  const head = git(dir, 'rev-parse', 'HEAD').trim(), head_date = git(dir, 'log', '-1', '--format=%cI', 'HEAD').trim(), until = new Date(Date.parse(head_date) - followDays * DAY).toISOString();
  const all = poolOf(listCommits(dir, since, until)), pool = all.filter((c) => !isExcluded(ex, c.sha, `${tbl.gh}#${c.pr}`));
  const classify = (c) => {
    const parent = c.parents[0], n = sumNumstat(git(dir, 'diff', '--numstat', '--no-renames', parent, c.sha)), stratum = stratumOf(n);
    if (!stratum) return { drop: 'size' };
    const files = git(dir, 'diff', '--name-only', '--no-renames', parent, c.sha).split('\n').filter(Boolean), code = files.filter((f) => isCode(f) && f.startsWith(tbl.src));
    if (!code.length) return { drop: 'no_unit_code' };
    if (tbl.core && !coreOnly(files)) return { drop: 'not_core' };
    return { stratum, changed_lines: n, code_files: code.length, parent };
  };
  const { accepted, funnel } = walk(shuffle(pool, seed), classify, q), sel = select(accepted, q);
  const taken = Object.fromEntries(STRATA.map((s) => [s, sel.rows.filter((r) => r.stratum === s).length]));
  return { meta: { gh: tbl.gh, head, head_date, until }, funnel: { pool: all.length, excluded: all.length - pool.length, ...funnel, taken, fallback: sel.fallback }, short: sel.short, picked: sel.rows };
}
// clones: injectable table (tests); text(gh, pr) injectable fetcher
function sample({ repos, since, followDays, seed, ex, cache, clones = CLONES, text = ghText, q = QUOTAS }) {
  const out = { seed, since, follow_days: followDays, exclusions: { files: ex.files || {}, shas: ex.shas.size, keys: ex.keys.size }, repos: {}, quotas: q, funnel: {}, short: {}, pr_text_fallback: 0, merge_mismatch: 0, rows: [] };
  for (const clone of Object.keys(clones).sort()) {
    const dir = path.join(repos, clone), r = sampleRepo({ dir, clone, tbl: clones[clone], ex, since, followDays, seed, q });
    out.repos[clone] = r.meta; out.funnel[clone] = r.funnel; if (Object.keys(r.short).length) out.short[clone] = r.short;
    for (const c of r.picked) { // PR text for selected rows only, in sequence
      const key = `${r.meta.gh}#${c.pr}`;
      if (!cache[key] || cache[key].failed || !('merge_commit_sha' in cache[key])) cache[key] = text(r.meta.gh, c.pr);
      const t = cache[key], fb = t.failed, merge_match = fb ? null : t.merge_commit_sha === c.sha;
      if (fb) out.pr_text_fallback++;
      if (merge_match === false) out.merge_mismatch++;
      out.rows.push({ id: `${clone}-${c.pr}`, repo: r.meta.gh, clone, pr: c.pr, sha: c.sha, parent: c.parent, date: c.date, changed_lines: c.changed_lines, stratum: c.stratum, drawn_from: c.drawn_from,
        code_files: c.code_files, title: fb ? c.subject : t.title || '', body: fb ? '' : t.body || '', merge_match, pr_text: fb ? 'commit' : 'github' });
    }
  }
  out.rows.sort((a, b) => (a.clone < b.clone ? -1 : a.clone > b.clone ? 1 : a.stratum < b.stratum ? -1 : a.stratum > b.stratum ? 1 : 0)); // stable: order taken within a stratum
  const ids = out.rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new Error('ids are not unique');
  return out;
}
// per corpus row: later first-parent commits (date in (merge, merge+followDays]) that add/modify a unit-test file
function later({ repos, corpus, followDays, clones = CLONES }) {
  const heads = {}, memo = {}, rows = [];
  for (const row of corpus.rows) {
    const dir = path.join(repos, row.clone), t = clones[row.clone].test;
    if (!heads[row.clone]) heads[row.clone] = { sha: git(dir, 'rev-parse', 'HEAD').trim(), date: git(dir, 'log', '-1', '--format=%cI', 'HEAD').trim() };
    const m = Date.parse(row.date), end = m + followDays * DAY, avail = Math.min(followDays, Math.floor((Date.parse(heads[row.clone].date) - m) / DAY));
    const commits = [];
    for (const l of git(dir, 'log', '--first-parent', 'HEAD', '--format=%H%x1f%P%x1f%cI').split('\n').filter(Boolean)) {
      const [sha, parents, date] = l.split('\x1f'), d = Date.parse(date);
      if (!(d > m && d <= end)) continue;
      const k = `${row.clone}@${sha}`, p1 = parents.split(' ').filter(Boolean)[0];
      if (!memo[k]) memo[k] = tryGit(dir, 'diff-tree', '--no-commit-id', '--root', '-r', '--name-status', '--no-renames', ...(p1 ? [p1, sha] : [sha])).split('\n').filter(Boolean).map((x) => x.split('\t')).map(([status, p]) => ({ path: p, status }));
      const test_files = memo[k].filter((f) => (f.status === 'A' || f.status === 'M') && inTestScope(t, f.path));
      if (test_files.length) commits.push({ sha, date, test_files });
    }
    rows.push({ id: row.id, sha: row.sha, merge_date: row.date, follow_end: new Date(end).toISOString(), follow_days_available: avail, commits });
  }
  return { follow_days: followDays, generated_from: null, heads, rows };
}

function main() {
  const cmd = process.argv[2], repos = arg('repos'), followDays = +arg('follow-days', 90);
  if (cmd === 'sample') {
    const textFile = arg('text'); let cache = {}; try { cache = JSON.parse(fs.readFileSync(textFile, 'utf8')); } catch { /* none yet */ }
    const out = sample({ repos, since: arg('since', '2025-07-01'), followDays, seed: +arg('seed', 20261021), ex: loadExcluded(), cache });
    fs.writeFileSync(textFile, JSON.stringify(cache, null, 1) + '\n');
    fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1) + '\n');
    for (const c of Object.keys(out.repos)) console.log(c.padEnd(10), STRATA.map((s) => `${s}=${out.rows.filter((r) => r.clone === c && r.stratum === s).length}/${QUOTAS[s]}`).join(' '), JSON.stringify(out.funnel[c]));
    console.log(JSON.stringify({ short: out.short, pr_text_fallback: out.pr_text_fallback, merge_mismatch: out.merge_mismatch, exclusions: { shas: out.exclusions.shas, keys: out.exclusions.keys }, rows: out.rows.length }));
  } else if (cmd === 'later') {
    const corpus = JSON.parse(fs.readFileSync(arg('corpus'), 'utf8')), out = later({ repos, corpus, followDays });
    out.generated_from = path.basename(arg('corpus'));
    fs.writeFileSync(arg('out'), JSON.stringify(out, null, 1) + '\n');
    console.log(JSON.stringify({ rows: out.rows.length, with_later_tests: out.rows.filter((r) => r.commits.length).length }));
  } else throw new Error('usage: v2-sample.js sample|later (see header)');
}
if (require.main === module) main();
module.exports = { CLONES, QUOTAS, stratumOf, prOf, poolOf, shuffle, isExcluded, addEx, exclusionsFrom, sumNumstat, walk, select, inTestScope, sample, sampleRepo, later };
