// Shared pieces of the pack-changed-first measurement (eval/replay/prereg-pack-changed-first.md). Offline, no model call.
// A Tree is a scratch checkout of a commit built without `git checkout`: files are written from the object store, a symlink can get the content of its
// target (follow=true, as on the Linux runner where packRead follows links), and the index is loaded with `git read-tree` so contextPack's `git ls-files` works.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const api = require('../../../src/engines/claude-api.js');
const post = require('../../../src/post.js');
const { matches } = require('../../../src/standards-map.js');
const { parseCandidates } = require('../../../src/focus.js');

const git = (cwd, args, opt = {}) => execFileSync('git', args, { cwd, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'ignore'], ...opt });
const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const lines = (p) => rd(p).replace(/\r\n/g, '\n').split('\n').filter(Boolean);

class Tree {
  constructor(clone, dir, follow = false) {
    this.follow = follow; this.clone = clone; this.dir = dir; this.sha = null; this.cur = new Map();
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(path.join(dir, '.git'))) {
      git(dir, ['init', '-q']);
      fs.writeFileSync(path.join(dir, '.git', 'objects', 'info', 'alternates'), path.resolve(clone, git(clone, ['rev-parse', '--git-path', 'objects']).toString().trim()).split(path.sep).join('/') + '\n');
    }
  }
  entries(sha) {
    const m = new Map();
    for (const e of git(this.clone, ['ls-tree', '-r', '-z', sha]).toString().split('\0').filter(Boolean)) { const t = e.indexOf('\t'), [mode, type, blob] = e.slice(0, t).split(' '); if (type === 'blob') m.set(e.slice(t + 1), { mode, blob }); }
    return m;
  }
  blobs(shas) { // sha -> Buffer, one git process per 2000 blobs
    const out = new Map();
    for (let i = 0; i < shas.length; i += 2000) {
      const ch = shas.slice(i, i + 2000), buf = git(this.clone, ['cat-file', '--batch'], { input: ch.join('\n') + '\n' });
      let at = 0;
      for (const s of ch) { const nl = buf.indexOf(10, at), size = +buf.subarray(at, nl).toString().split(' ')[2]; out.set(s, buf.subarray(nl + 1, nl + 1 + size)); at = nl + 1 + size + 1; }
    }
    return out;
  }
  put(p, buf) { // a path that was a directory in the previous commit (or a file under a path that is now a file) is cleared first
    const f = path.join(this.dir, p), go = () => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, buf); };
    try { go(); } catch {
      try {
        fs.rmSync(f, { recursive: true, force: true });
        for (let d = path.dirname(f); d.length > this.dir.length; d = path.dirname(d)) { try { if (fs.statSync(d).isFile()) fs.rmSync(d); } catch { /* absent */ } }
        go();
      } catch { this.skipped = (this.skipped || 0) + 1; }
    }
  }
  moveTo(sha) {
    sha = git(this.clone, ['rev-parse', sha]).toString().trim();
    if (this.sha === sha) return this;
    const next = this.entries(sha), old = this.cur, write = [];
    for (const p of old.keys()) if (!next.has(p)) fs.rmSync(path.join(this.dir, p), { force: true });
    for (const [p, e] of next) if (e.mode !== '160000' && (!old.has(p) || old.get(p).blob !== e.blob || old.get(p).mode !== e.mode)) write.push([p, e]);
    const links = [...next].filter(([, e]) => e.mode === '120000'), data = this.blobs([...new Set([...write.map(([, e]) => e.blob), ...links.map(([, e]) => e.blob)])]);
    for (const [p, e] of write) if (e.mode !== '120000' || !this.follow) this.put(p, data.get(e.blob)); // follow=false: a symlink is the plain file holding its target, as git writes it with core.symlinks=false (how the holdout-2 collector ran on Windows)
    const target = (p, depth = 0) => { // content of the file a symlink points to, inside the tree
      const e = next.get(p);
      if (!e || depth > 5) return null;
      if (e.mode !== '120000') { try { return fs.readFileSync(path.join(this.dir, p)); } catch { return null; } }
      const t = path.posix.normalize(path.posix.join(path.posix.dirname(p), data.get(e.blob).toString().trim()));
      return t.startsWith('..') ? null : target(t, depth + 1);
    };
    for (const [p] of this.follow ? links : []) { fs.rmSync(path.join(this.dir, p), { force: true }); const c = target(p); if (c) this.put(p, c); }
    git(this.dir, ['read-tree', sha]);
    this.sha = sha; this.cur = next;
    return this;
  }
  destroy() { fs.rmSync(this.dir, { recursive: true, force: true }); }
}

const cat = (f) => (/\.(md|mdx|rst|txt)$/i.test(f) ? 'doc' : /(^|[/._-])(test|tests|spec|__tests__)([/._-]|$)/i.test(f) ? 'test' : 'src');
// one arm's pack on one PR; arm '' = main (EXP_PACK unset)
function pack(arm, ctx, root, limit = 250000) {
  const old = process.env['EXP_PACK'];
  if (arm) process.env['EXP_PACK'] = arm; else delete process.env['EXP_PACK'];
  try { return api.contextPack(ctx, root, limit); } finally { if (old === undefined) delete process.env['EXP_PACK']; else process.env['EXP_PACK'] = old; }
}
const blocks = (text) => { const m = {}; for (const x of text.matchAll(/<untrusted-data name="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/untrusted-data>/g)) m[x[1]] = x[0]; return m; };
// the post.js lost rule (src/post.js, "Review context was cut") on a pack result: changed files with a changed line past what was shown, and the cut candidate tests of changed files
function lost(ctx, p) {
  const files = lines(path.join(ctx, 'files.txt')), dm = post.parseDiff(rd(path.join(ctx, 'diff.patch'))), cut = new Set(p.notWhole), cands = parseCandidates(rd(path.join(ctx, 'test-candidates.txt')));
  const out = [], tests = [];
  for (const f of files) {
    if (cut.has(f)) {
      const ch = [...(dm.get(f)?.changed.RIGHT.keys() || [])], s = p.shown.has(f) ? p.shown.get(f) : 0, past = ch.filter((n) => n > s), un = past.length;
      if (un) out.push({ f, un, nch: ch.length, cat: cat(f), past });
    }
    for (const x of cands.get(f) || []) if (cut.has(x) && !tests.includes(x)) tests.push(x);
  }
  const zero = files.filter((f) => (dm.get(f)?.changed.LEFT.size || 0) > 0 && !blocks(p.text)[f]); // amendment 2: a changed file with deleted lines that the pack shows with 0 lines
  return { out, tests, zero };
}
// in-scope rules of main's list (scope covers at least one changed file; no map = all)
function inScope(ctx) {
  const std = lines(path.join(ctx, 'standards.txt'));
  let map;
  try { map = new Map(JSON.parse(rd(path.join(ctx, 'standards-map.json'))).map((e) => [e.path, e.scope])); } catch { return std; }
  const ch = lines(path.join(ctx, 'files.txt')).map((f) => path.posix.normalize(f.replace(/\\/g, '/')));
  return std.filter((p) => !map.has(p) || ch.some((f) => matches(map.get(p), f)));
}
// every measure of one pack; a: the measure() of main on the same PR (for gate 6 and byte identity)
function measure(arm, ctx, root, limit = 250000, a = null) {
  const p = pack(arm, ctx, root, limit), b = blocks(p.text), std = lines(path.join(ctx, 'standards.txt')), ins = inScope(ctx), l = lost(ctx, p);
  const size = (f) => Buffer.byteLength(b[f] || ''), files = lines(path.join(ctx, 'files.txt'));
  const r = {
    arm, bytes: Buffer.byteLength(p.text), lostFiles: l.out, lostAny: l.out.length > 0, lostSrc: l.out.some((x) => x.cat !== 'doc'), lostCode: l.out.some((x) => x.cat === 'src'), unseen: l.out.reduce((n, x) => n + x.un, 0), unseenKeys: l.out.flatMap((x) => x.past.map((n) => x.f + ":" + n)),
    zeroDel: l.zero, contentLost: l.out.length + l.zero.length > 0, contentKeys: [...l.out.flatMap((x) => x.past.map((n) => x.f + ":" + n)), ...l.zero.map((f) => f + ":DEL")], cutTests: l.tests, notice: l.out.length + l.tests.length > 0, ruleBytes: std.reduce((n, f) => n + size(f), 0), rules: std.length, ruleShown: std.filter((f) => b[f]), inScope: ins.length, inScopeDropped: ins.filter((f) => !b[f]),
    cut: [...p.notWhole].sort(), maxFile: Math.max(0, ...Object.values(b).map((x) => Buffer.byteLength(x))), reviewBytes: files.reduce((n, f) => n + size(f), 0),
    ruleEmptyButInScope: !std.some((f) => b[f]) && ins.length > 0,
  };
  if (a) {
    const ab = blocks(a.pack.text);
    r.ruleLostVsA = ins.filter((f) => ab[f] && !b[f]); // in-scope rules that A showed and this arm dropped (the rule cost)
    r.ruleChangedVsA = ins.filter((f) => ab[f] && b[f] && ab[f] !== b[f]); // shown by both, at different bytes (cut differently)
    r.gate6 = [...r.ruleLostVsA, ...r.ruleChangedVsA]; // must be empty wherever A loses no changed line
    r.ruleBlocksOf = Object.fromEntries(ins.map((f) => [f, Buffer.byteLength(b[f] || '')]));
    r.sameText = a.pack.text === p.text && a.pack.note === p.note;
  }
  Object.defineProperty(r, 'pack', { value: p, enumerable: false });
  return r;
}
module.exports = { Tree, pack, measure, lost, inScope, blocks, lines, rd, cat };
