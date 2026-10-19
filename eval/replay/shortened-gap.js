#!/usr/bin/env node
// Deterministic replay, no model call: the same saved collector ctx and the same fixed empty answer through two post.js files (main and branch).
// Reports every run whose status changes, why (deleted lines omitted, or added lines omitted and the file not shown whole), and whether any headline turned green.
// The pack is re-run per case (lib.js of the pack-analysis scripts) and written as pack-cut.txt / pack-shown.txt the way src/engines/claude-api.js writes them.
// usage: node shortened-gap.js --evidence DIR --lib DIR --sg-repo DIR --out DIR --main POST_JS --branch POST_JS [--only name,name]
//   --evidence  the evidence dir (pack/{holdout,specguard,fresh1,conf,confh}.json rows, out/, c2/, repos/, ...)   --lib  eval/replay/pack-analysis (lib.js)
//   --sg-repo   a SpecGuard clone holding the c2 PR heads   --main/--branch  the two post.js files to compare
const fs = require('node:fs');
const path = require('node:path');
const { fakeGithub } = require('../local.js');
const o = require('node:util').parseArgs({ options: { evidence: { type: 'string' }, lib: { type: 'string' }, 'sg-repo': { type: 'string' }, out: { type: 'string' }, main: { type: 'string' }, branch: { type: 'string' }, only: { type: 'string', default: '' }, classify: { type: 'boolean' } } }).values;
if (!o.evidence || !o.lib || !o['sg-repo'] || !o.out || !o.main || !o.branch) { console.error('usage: see the header of this file'); process.exit(2); }
const { Tree, pack, rd } = require(path.resolve(o.lib, 'lib.js'));
const ev = o.evidence, P = path.join(ev, 'pack'), out = path.resolve(o.out);
const json = (p) => JSON.parse(rd(p));
const fresh = (dir, list) => (id) => { const m = /^(.*)-([0-9a-f]{12})$/.exec(id), row = rd(list).split('\n').find((l) => l.split('\t')[1]?.startsWith(m[2])); return { clone: path.join(ev, 'repos', m[1]), head: row.split('\t')[1], ctx: path.join(P, dir, m[1], m[2], 'ctx'), follow: false, gh: path.join(P, dir, m[1], m[2], 'gh-output.txt') }; };
const where = {
  holdout(id) { for (const r of fs.readdirSync(path.join(ev, 'out')).filter((d) => /^r\d+$/.test(d))) { const prep = path.join(ev, 'out', r, '_prep', id); if (fs.existsSync(path.join(prep, 'ctx', 'diff.patch'))) return { clone: path.join(ev, 'repos', path.basename(json(path.join(ev, 'holdout2-raw', r.slice(1), `replay-${id}`, 'result.json')).repo)), head: json(path.join(prep, 'meta.json')).head, ctx: path.join(prep, 'ctx'), follow: false, gh: path.join(prep, 'gh-output.txt') }; } },
  specguard(id) { const m = json(path.join(ev, 'c2-manifest.json')).find((x) => `pr${x.pr}` === id); return { clone: o['sg-repo'], head: m.sha, ctx: path.join(ev, 'c2', id), follow: true, gh: '' }; },
  fresh1: fresh('fresh', path.join(P, 'fresh-step1.txt')), conf: fresh('conf-fresh', path.join(P, 'conf', 'list.txt')), confh: fresh('confh-fresh', path.join(P, 'confh', 'list.txt')),
};
const names = (o.only ? o.only.split(',') : Object.keys(where));
const cases = names.flatMap((name) => json(path.join(P, `${name}.json`)).filter((r) => !r.error).map((r) => ({ name, id: r.id, w: where[name](r.id) }))).sort((a, b) => a.w.clone.localeCompare(b.w.clone));
const arms = { main: require(path.resolve(o.main)), branch: require(path.resolve(o.branch)) };
const empty = (ctx) => { const src = rd(path.join(ctx, 'standards.txt')).split('\n').map((x) => x.trim()).filter(Boolean); return { requirements: [], requirements_source: 'none', not_reviewed: '', coverage: [], findings: [], standards: src.length ? { status: 'checked', sources: src, reason: 'Fixed empty answer of the replay.' } : { status: 'no_rules', sources: [], reason: 'Fixed empty answer of the replay.' }, layering: { status: 'checked', reason: 'Fixed empty answer of the replay.' } }; };
const MARK = /^… \d+ more changed lines in this file not shown/m, REASON = /Deleted lines of (.*?) not shown \(diff shortened\)/;

async function arm(name, c, tree, ctx0) {
  const dir = path.join(out, name, `${c.name}-${c.id}`), ctx = path.join(dir, 'ctx');
  fs.rmSync(dir, { recursive: true, force: true }); fs.cpSync(ctx0, ctx, { recursive: true });
  fs.writeFileSync(path.join(ctx, 'findings.json'), JSON.stringify(empty(ctx)));
  const { github, core, posted } = fakeGithub({ headSha: c.w.head });
  const context = { repo: { owner: 'local', repo: 'eval' }, serverUrl: 'https://github.com', payload: { pull_request: { number: 1, head: { sha: c.w.head }, base: { sha: 'b'.repeat(40) } } } };
  const env = { CTX: ctx, HEAD_SHA: c.w.head, BASE_SHA: 'b'.repeat(40), GITHUB_WORKSPACE: tree.dir, SKIP: 'false', PARTIAL: String(/partial=true/.test(c.w.gh ? rd(c.w.gh) : '')), MAX_COMMENTS: '10', ENGINE: 'claude', MODEL: '', STANDARDS_REF: 'head', STANDARDS_CHECKS: '' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const log = console.log; console.log = () => {};
  try { await arms[name]({ github, context, core }); } finally { console.log = log; for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const s = posted.summary || '';
  fs.writeFileSync(path.join(dir, 'summary.md'), s);
  return { status: posted.outputs.status || /<!-- specguard:status=(\w+) -->/.exec(s)?.[1] || null, headline: (/\*\*(✅|❌|❔|⚠️)[^\n]*/.exec(s) || [''])[0].slice(0, 90), green: /\*\*✅/.test(s), reason: REASON.exec(s)?.[1] || null };
}

// --classify: for the shortened rows of a finished run, per shortened file: omitted deleted/added lines, and whether the pack showed it whole (pack-cut.txt written and not listing it)
if (o.classify) {
  const { splitDiff } = require('../../src/focus.js'), n = (t, re) => t.split('\n').filter((l) => re.test(l)).length;
  const res = JSON.parse(rd(path.join(out, 'rows.json'))).filter((r) => r.shortened).map((r) => {
    const c = path.join(out, '_ctx', r.name + '-' + r.id), patch = new Map(splitDiff(rd(path.join(c, 'diff.patch'))).map((f) => [f.path, f.text.slice(Math.max(0, f.text.search(/^@@/m)))])), cut = new Set(rd(path.join(c, 'pack-cut.txt')).split('\n').filter(Boolean).map((l) => l.split('\t')[0]));
    const files = splitDiff(rd(path.join(c, 'diff.numbered.txt'))).filter((f) => MARK.test(f.text) && patch.has(f.path)).map((f) => ({ f: f.path, del: n(patch.get(f.path), /^-/) - n(f.text, /^\s*\d+ \| -/), add: n(patch.get(f.path), /^\+/) - n(f.text, /^\s*\d+ \| \+/), packCut: cut.has(f.path) }));
    return { name: r.name, id: r.id, skipped: r.skipped, mainStatus: r.main.status, branchStatus: r.branch.status, files };
  });
  fs.writeFileSync(path.join(out, 'classify.json'), JSON.stringify(res, null, 1));
  process.exit(0);
}
(async () => {
  const rows = []; let tree = null, cur = null;
  for (const c of cases) {
    if (cur !== c.w.clone) { tree?.destroy(); cur = c.w.clone; tree = new Tree(c.w.clone, path.join(out, '_scratch', path.basename(c.w.clone)), c.w.follow); }
    try {
      tree.moveTo(c.w.head);
      const ctx0 = path.join(out, '_ctx', `${c.name}-${c.id}`);
      fs.rmSync(ctx0, { recursive: true, force: true }); fs.cpSync(c.w.ctx, ctx0, { recursive: true });
      const p = pack('', ctx0, tree.dir); // as the engine writes them (claude-api.js)
      fs.writeFileSync(path.join(ctx0, 'pack-cut.txt'), p.notWhole.map((x) => `${x}\n`).join(''));
      fs.writeFileSync(path.join(ctx0, 'pack-shown.txt'), [...p.shown].map(([x, n]) => `${x}\t${n}\n`).join(''));
      const shortened = MARK.test(rd(path.join(ctx0, 'diff.numbered.txt'))), skipped = rd(path.join(ctx0, 'focus-skipped.txt')).split('\n').filter(Boolean).length;
      const m = await arm('main', c, tree, ctx0), b = await arm('branch', c, tree, ctx0);
      rows.push({ name: c.name, id: c.id, shortened, skipped, main: m, branch: b, flip: m.status !== b.status, newReason: b.reason && !m.reason ? b.reason : null, turnedGreen: !m.green && b.green });
    } catch (e) { rows.push({ name: c.name, id: c.id, error: String(e.message).slice(0, 200) }); }
    console.error(rows.at(-1).id, rows.at(-1).error || (rows.at(-1).flip ? 'FLIP' : ''));
  }
  tree?.destroy();
  fs.writeFileSync(path.join(out, 'rows.json'), JSON.stringify(rows, null, 1));
  const ok = rows.filter((r) => !r.error), flips = ok.filter((r) => r.flip);
  console.log(JSON.stringify({ cases: rows.length, errors: rows.length - ok.length, shortened: ok.filter((r) => r.shortened).length, shortenedNoSkip: ok.filter((r) => r.shortened && !r.skipped).length, flips: flips.length, flipsOutsideShortened: flips.filter((r) => !r.shortened).length, newReasonWithoutFlip: ok.filter((r) => r.newReason && !r.flip).length, turnedGreen: ok.filter((r) => r.turnedGreen).length, mainStatus: ok.reduce((a, r) => (a[r.main.status] = (a[r.main.status] || 0) + 1, a), {}) }));
})();
