// Report tables of the F2P oracle (README "Headline measures", "Reporting commitments"). Pure functions over results.json rows + candidates.
const { wilson, fisher2, newcombe, bootDiff } = require('./stats');

const ARMS = ['NEAR', 'FAR']; // UNTOUCHED was not run: structural zero by construction
// Exclusion classes reported per arm. A NEAR fix touches nearby code and is more likely to change signatures, so exclusions can bias NEAR downward.
const CLASSES = ['api_shift', 'invalid_bad_call', 'invalid_test_setup', 'invalid_throw_on_fixed', 'invalid_other', 'flaky', 'unrunnable'];
const klass = (r) => (r.verdict === 'invalid' ? (['bad_call', 'test_setup', 'throw_on_fixed'].includes(r.subtype) ? `invalid_${r.subtype}` : r.subtype === 'compile' ? 'invalid_compile' : 'invalid_other') : r.verdict);
// Excluded tests that the sensitivity line counts as verified when claim_match is yes: api_shift and every invalid class except compile/import/collection error.
const SENS = ['api_shift', 'invalid_bad_call', 'invalid_test_setup', 'invalid_throw_on_fixed', 'invalid_other'];

// rows: results.json entries { id, pr, verdict, subtype?, claim_match? }; armOf: id -> arm.
function tables(rows, armOf) {
  const out = {};
  for (const a of ARMS) {
    const rs = rows.filter((r) => armOf[r.id] === a), run = rs.filter((r) => r.verdict !== 'unrunnable');
    const hit = (f) => run.filter((r) => f(r) && r.claim_match === 'yes');
    const primary = hit((r) => r.verdict === 'verified'), secondary = hit((r) => r.verdict === 'verified' || r.verdict === 'verified_throw'), sens = hit((r) => r.verdict === 'verified' || r.verdict === 'verified_throw' || SENS.includes(klass(r)));
    const exclusions = Object.fromEntries(CLASSES.map((c) => [c, rs.filter((r) => klass(r) === c).length]));
    out[a] = { total: rs.length, runnable: run.length, exclusions, verdicts: count(rs.map((r) => r.verdict)), verified_no: run.filter((r) => r.verdict === 'verified' && r.claim_match === 'no').length, verified_unsure: run.filter((r) => r.verdict === 'verified' && r.claim_match === 'unsure').length,
      primary: primary.length, secondary: secondary.length, sensitivity: sens.length, rows: { primary, secondary, sens }, prs: [...new Set(run.map((r) => r.pr))] };
  }
  return out;
}
const count = (xs) => xs.reduce((o, x) => ((o[x] = (o[x] || 0) + 1), o), {});

// NEAR vs FAR for one measure ('primary' | 'secondary' | 'sensitivity'): rates, Wilson, difference, Newcombe, Fisher (descriptive when the power rule says so), PR-cluster bootstrap.
function compare(t, rows, armOf, measure) {
  const x1 = t.NEAR[measure], n1 = t.NEAR.runnable, x2 = t.FAR[measure], n2 = t.FAR.runnable;
  const flag = (a) => (r) => armOf[r.id] === a && r.verdict !== 'unrunnable';
  const hitIds = new Set(t.NEAR.rows[measure === 'sensitivity' ? 'sens' : measure].concat(t.FAR.rows[measure === 'sensitivity' ? 'sens' : measure]).map((r) => r.id));
  const A = rows.filter(flag('NEAR')).map((r) => ({ pr: r.pr, hit: hitIds.has(r.id) })), B = rows.filter(flag('FAR')).map((r) => ({ pr: r.pr, hit: hitIds.has(r.id) }));
  return { near: { x: x1, n: n1, wilson: wilson(x1, n1) }, far: { x: x2, n: n2, wilson: wilson(x2, n2) }, diff: n1 && n2 ? x1 / n1 - x2 / n2 : null, newcombe: n1 && n2 ? newcombe(x1, n1, x2, n2) : null, fisher_p: n1 && n2 ? fisher2(x1, n1, x2, n2) : null, bootstrap: n1 && n2 ? bootDiff(A, B, { reps: 2000, seed: 1 }) : null };
}

const pct = (x) => (x === null || x === undefined ? 'n/a' : (100 * x).toFixed(1) + '%');
const ci = (w) => (w ? `[${pct(w[0])}, ${pct(w[1])}]` : 'n/a');

function format(t, cmp) {
  const L = [];
  L.push('Exclusions per arm (count of findings):', ['class', ...ARMS].join('\t'));
  for (const c of [...CLASSES, 'invalid_compile']) L.push([c, ...ARMS.map((a) => (c === 'invalid_compile' ? count0(t[a], c) : t[a].exclusions[c]))].join('\t'));
  L.push('', ['arm', 'findings', 'runnable', 'verified+yes', 'verified-or-throw+yes', 'sensitivity (excluded+yes counted)', 'verified/no', 'verified/unsure'].join('\t'));
  for (const a of ARMS) L.push([a, t[a].total, t[a].runnable, t[a].primary, t[a].secondary, t[a].sensitivity, t[a].verified_no, t[a].verified_unsure].join('\t'));
  for (const [m, c] of Object.entries(cmp)) L.push('', `${m}: NEAR ${c.near.x}/${c.near.n} ${ci(c.near.wilson)} vs FAR ${c.far.x}/${c.far.n} ${ci(c.far.wilson)}; diff ${pct(c.diff)} Newcombe ${ci(c.newcombe)}; Fisher p ${c.fisher_p === null ? 'n/a' : c.fisher_p.toFixed(4)}; PR-cluster bootstrap ${ci(c.bootstrap)}`);
  return L.join('\n');
}
const count0 = (a, c) => a.verdicts.invalid_compile || 0;

module.exports = { tables, compare, format, klass, CLASSES, SENS, ARMS };
