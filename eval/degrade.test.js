const test = require('node:test');
const assert = require('node:assert/strict');
const { builtin, fromCtxDir, evaluate, table } = require('./degrade.js');

// A cosmetic defect (fence, case, numbers as strings, a dropped optional field, shifted lines, trimmed quotes) must not cost the
// review: no hard failure, every baseline finding delivered at the same place, every verified row still verified, nothing new.
// An output that is really unusable (truncated, ledger missing, most rows garbage) must still go to the repair turn.
const fixtures = [...builtin(), ...(process.env.SG_PILOT_CTX ? [fromCtxDir(process.env.SG_PILOT_CTX)] : [])];

for (const fx of fixtures) {
  test(`degrade ${fx.name}: cosmetic defects keep the review, unusable output is rejected`, async () => {
    const results = await evaluate(fx);
    assert.ok(results[0].total > 0, 'the fixture must deliver at least one finding');
    const bad = results.filter((r) => !r.ok);
    assert.deepEqual(bad.map((r) => `${r.id}: ${r.route} ${r.why} findings ${r.kept}/${r.total} rows ${r.rows}/${r.rowsTotal} new ${r.extra}`), []);
    assert.ok(results.filter((r) => r.expect === 'reject').every((r) => r.route === 'repair'));
  });
}

test('degrade table: one line per trial and a FAIL marker', () => {
  const t = table([{ fixture: 'x', id: 'm', expect: 'ok', route: 'ok', why: '', kept: 1, total: 2, rows: 3, rowsTotal: 3, extra: 0, ok: false }]);
  assert.match(t.split('\n')[1], /x\s+m\s+ok\s+ok\s+1\/2\s+3\/3\s+0\s+FAIL/);
});
