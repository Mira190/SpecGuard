#!/usr/bin/env node
// Fact check: does a deletion hunk of a changed file that is absent from both the pack and notWhole reach the model some other way (the prompt's first 40 KB of the
// numbered diff, or the pack's "diff.numbered.txt (rest)" block), and when it reaches neither, does a run-incomplete reason fire? Offline; re-runs main's pack on the PR.
// usage: node diffgap.js <evidence-dir> <scratch-dir> <specguard-repo-dir> <out.json> <name=rows.json>...   (rows from run-arms.js; ids as there)
const fs = require('node:fs');
const path = require('node:path');
const { Tree, pack, rd, lines } = require('./lib.js');
const post = require('../../../src/post.js');
const { cut, LIMITS } = require('../../../src/prompt.js');
const [ev, scratch, sgRepo, outFile, ...specs] = process.argv.slice(2);
const wholly = (patch, f) => { const i = patch.indexOf('--- a/' + f + '\n'); return i >= 0 && patch.slice(i, i + 400).split('\n')[1] === '+++ /dev/null'; };
const P = path.join(ev, 'pack');
const where = {
  holdout(id) { for (const r of fs.readdirSync(path.join(ev, 'out')).filter((d) => /^r\d+$/.test(d))) { const prep = path.join(ev, 'out', r, '_prep', id); if (fs.existsSync(path.join(prep, 'ctx', 'diff.patch'))) return { clone: path.join(ev, 'repos', path.basename(JSON.parse(rd(path.join(ev, 'holdout2-raw', r.slice(1), 'replay-' + id, 'result.json'))).repo)), head: JSON.parse(rd(path.join(prep, 'meta.json'))).head, ctx: path.join(prep, 'ctx'), follow: false, gh: path.join(prep, 'gh-output.txt') }; } },
  specguard(id) { const m = JSON.parse(rd(path.join(ev, 'c2-manifest.json'))).find((x) => 'pr' + x.pr === id); return { clone: sgRepo, head: m.sha, ctx: path.join(ev, 'c2', id), follow: true, gh: '' }; },
};
const freshWhere = (dir, list) => (id) => { const m = /^(.*)-([0-9a-f]{12})$/.exec(id), row = rd(list).split('\n').find((l) => l.split('\t')[1]?.startsWith(m[2])); return { clone: path.join(ev, 'repos', m[1]), head: row.split('\t')[1], ctx: path.join(P, dir, m[1], m[2], 'ctx'), follow: false, gh: path.join(P, dir, m[1], m[2], 'gh-output.txt') }; };
where.fresh1 = freshWhere('fresh', path.join(P, 'fresh-step1.txt')); where.conf = freshWhere('conf-fresh', path.join(P, 'conf', 'list.txt')); where.confh = freshWhere('confh-fresh', path.join(P, 'confh', 'list.txt'));
const cands = [];
for (const s of specs) {
  const [name, file] = s.split('='), rows = JSON.parse(fs.readFileSync(file, 'utf8')).filter((r) => !r.error);
  for (const r of rows) { const w = where[name](r.id), patch = rd(path.join(w.ctx, 'diff.patch')), fs0 = r.A.zeroDel.filter((f) => !r.A.cut.includes(f) && !wholly(patch, f)); if (fs0.length) cands.push({ name, id: r.id, w, files: fs0 }); }
}
cands.sort((a, b) => a.w.clone.localeCompare(b.w.clone));
const out = []; let tree = null, cur = null;
for (const c of cands) {
  if (cur !== c.w.clone) { tree?.destroy(); cur = c.w.clone; tree = new Tree(c.w.clone, path.join(scratch, 'gap-' + path.basename(c.w.clone)), c.w.follow); }
  tree.moveTo(c.w.head);
  const p = pack('', c.w.ctx, tree.dir), numbered = rd(path.join(c.w.ctx, 'diff.numbered.txt')), usedNumbered = numbered.trim().length > 0, diff = usedNumbered ? numbered : rd(path.join(c.w.ctx, 'diff.patch'));
  const head = cut(diff, LIMITS.diff), restM = /name="diff[^"]* \(rest\)"[^>]*>/.exec(p.text), note = restM ? /lines (\d+) to (\d+) of/.exec(restM[0]) : null, rest = note ? [+note[1], +note[2]] : null;
  const dl = diff.split('\n'), focusSkipped = lines(path.join(c.w.ctx, 'focus-skipped.txt')).map((x) => x.split('\t')[0]), patchDm = post.parseDiff(rd(path.join(c.w.ctx, 'diff.patch')));
  const fileRes = c.files.map((f) => {
    // deletion lines of f in the numbered diff: inside the section of f
    let sec = false; const del = [];
    dl.forEach((l, i) => { const h = /^diff --git a\/(.*) b\/(.*)$/.exec(l.replace(/^\s*\d+ \| /, '')); if (h) sec = h[2] === f; else if (sec && /^\s*\d+ \| -/.test(l) && !/^\s*\d+ \| --- /.test(l)) del.push(i + 1); });
    const total = patchDm.get(f)?.changed.LEFT.size || 0, inPrompt = del.filter((n) => n <= head.lines).length, inRest = rest ? del.filter((n) => n > head.lines && n >= rest[0] && n <= rest[1]).length : 0;
    return { f, deletions: total, inNumbered: del.length, inPrompt, inRest, unseen: total - inPrompt - inRest, skipped: focusSkipped.includes(f) };
  });
  const gh = c.w.gh ? rd(c.w.gh) : '', collect = rd(path.join(c.w.ctx, 'collect-limits.txt'));
  const reasons = [];
  if (/partial=true/.test(gh)) reasons.push('max_diff_kb partial');
  if (lines(path.join(c.w.ctx, 'diff-dropped.txt')).length) reasons.push('diff-dropped');
  if (fileRes.some((x) => x.skipped)) reasons.push('focus-skipped file');
  const trimmed = /^… \d+ more changed lines in this file not shown/m.test(numbered);
  out.push({ name: c.name, id: c.id, files: fileRes, diffBytes: Buffer.byteLength(diff), promptCut: head.cut, restBlock: !!rest, trimmedMarker: trimmed, reasonsDiffRelated: reasons, base: rd(path.join(c.w.ctx, 'diff-base-sha')).trim(), head: c.w.head, repo: path.basename(c.w.clone) });
  console.log(c.id, JSON.stringify(fileRes.map((x) => [x.f, x.deletions, x.inPrompt, x.inRest, x.unseen])), reasons.join(','));
}
tree?.destroy();
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log('candidates', out.length);
