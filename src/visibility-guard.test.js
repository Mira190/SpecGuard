const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { decide } = require('./visibility-guard.js');

test('decide: private or internal target needs a non-public control repository; public target is always allowed; unknown fails closed', () => {
  assert.equal(decide('public', 'public').ok, true);
  assert.equal(decide('private', 'public').ok, true);
  assert.equal(decide('private', 'private').ok, true);
  assert.equal(decide('internal', 'internal').ok, true);
  assert.equal(decide('public', 'private').ok, false);
  assert.equal(decide('public', 'internal').ok, false);
  assert.match(decide('public', 'private').reason, /private or internal control repository/);
  for (const bad of ['', undefined, 'weird']) {
    assert.equal(decide(bad, 'public').ok, false);
    assert.equal(decide('private', bad).ok, false);
    assert.equal(decide('public', bad).ok, false);
  }
});

test('specguard-run.yml: the visibility guard runs in the resolve job, before the review job checks the target out', () => {
  const y = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'specguard-run.yml'), 'utf8').replace(/\r\n/g, '\n');
  const g = y.indexOf('node src/visibility-guard.js');
  assert.ok(g > y.indexOf('node src/resolve-inputs.js'), 'after the target is resolved');
  assert.ok(g < y.indexOf('\n  review:'), 'in the resolve job');
  assert.ok(g < y.indexOf('repository: ${{ needs.resolve.outputs.repo }}'), 'before the target checkout');
  assert.match(y, /CONTROL_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(y, /TARGET_REPO: \$\{\{ steps\.in\.outputs\.repo \}\}/);
});
