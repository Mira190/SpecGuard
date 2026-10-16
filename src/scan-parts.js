// Scan parts for the claude api engine (src/engines/claude-api.js): one Messages call cannot answer a large design document and many units at once.
// plan() splits the scan's context into a unit part (audit-units.txt: units + their matched tests) and block parts (at most `batch` candidate blocks each: their audit-candidates.txt and audit-evidence.txt rows
// and a pack of the files those rows cite). Each part's prompt is rendered by prompt.js from a filtered copy of the ctx files (a temp dir), not by a second prompt builder.
// -> null when the blocks fit one call (<= batch; or none), else { parts: [{ prompt, pack, cids? }], packCut }: the unit part first, then the block parts in candidate order (the rotation priority); cids = the part's blocks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROW = /^[0-9a-f]{8}\t/;
const lines = (s) => s.replace(/\r\n/g, '\n').split('\n').filter(Boolean);

function plan({ ctx, root, batch, limit, schemaFile, contextPack, evidencePack, assembleAudit }) {
  const rd = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8'); } catch { return ''; } };
  const cands = lines(rd('audit-candidates.txt')).filter((l) => ROW.test(l));
  if (cands.length <= batch) return null; // ponytail: a document that fits one call keeps the single call; the unit pack and the blocks then share it
  const evidence = lines(rd('audit-evidence.txt')), bodies = lines(rd('audit-blocks.txt')), units = rd('audit-units.txt');
  let meta = {}; try { meta = JSON.parse(rd('audit-meta.json')); } catch { /* the prompt falls back to its defaults */ }
  const skillDir = path.join(__dirname, '..', 'skills', 'spec-audit'), out = [];
  let tmp;
  const render = (files, m) => {
    for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { force: true });
    for (const [n, s] of Object.entries({ 'standards.txt': rd('standards.txt'), 'test-layout.txt': rd('test-layout.txt'), ...files })) if (s && s.trim()) fs.writeFileSync(path.join(tmp, n), s);
    fs.writeFileSync(path.join(tmp, 'audit-meta.json'), JSON.stringify(m));
    return assembleAudit({ skillDir, ctxDir: tmp, schemaPath: schemaFile }).split(tmp.replace(/\\/g, '/')).join(ctx.replace(/\\/g, '/'));
  };
  // a pack that throws shows nothing: every unit file and its matched tests count as cut (pack-cut.txt), not as fully seen
  const pack = () => { try { return contextPack(tmp, root, limit); } catch (e) { console.log(`::warning::Context pack failed (${String(e?.message ?? e).split('\n')[0]}); the unit files and their tests are listed as cut`); return { text: '', note: '', notWhole: [...new Set(lines(units).map((l) => l.split('\t')).filter((u) => u[1]).flatMap((u) => [u[1], ...(u[4] && u[4] !== 'none' ? u[4].split(', ') : [])]))] }; } };
  let packCut = [];
  const { units: _u, max_units, ...bm } = meta;
  const block = (rows) => {
    const cids = rows.map((l) => l.split('\t')[0]), set = new Set(cids), ev = evidence.filter((l) => set.has(l.split('\t')[0]));
    const prompt = render({ 'audit-docs.txt': rd('audit-docs.txt'), 'audit-candidates.txt': rows.join('\n') + '\n', 'audit-blocks.txt': bodies.filter((l) => set.has(l.split('\t')[0])).join('\n'),'audit-evidence.txt': ev.join('\n') }, { ...bm, candidates: cids.length, candidates_listed: cids.length });
    // the pack: windows around the lines the evidence rows cite, not whole files (evidencePack in claude-api.js; the single call loads the same)
    const p = evidencePack(root, ev, limit);
    return { prompt, pack: p, cids, blockCuts: p.blockCuts };
  };
  const byCid = new Map(cands.map((l) => [l.split('\t')[0], l]));
  const withTmp = (f) => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-part-')); try { return f(); } finally { fs.rmSync(tmp, { recursive: true, force: true }); } };
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specguard-part-'));
    if (units.trim()) {
      const { candidates, candidates_listed, ...m } = meta;
      const prompt = render({ 'audit-units.txt': units }, m), p = limit > 0 ? pack() : { text: '', note: '', notWhole: [] };
      packCut = p.notWhole;
      out.push({ prompt, pack: p });
    }
    for (let i = 0; i < cands.length; i += batch) out.push(block(cands.slice(i, i + batch)));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  // sub(cids): the part for a subset of blocks (a part whose reply overflowed is split and re-rendered)
  return { parts: out, packCut, sub: (cids) => withTmp(() => block(cids.map((c) => byCid.get(c)))) };
}

module.exports = { plan };
