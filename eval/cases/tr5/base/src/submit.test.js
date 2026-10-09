const test = require('node:test');
const assert = require('node:assert/strict');
const { submitClaim, LateSubmissionError } = require('./submit.js');

const day = (n) => n * 86400000;

test('accepts a claim reported on the last day of the window', () => {
  assert.equal(submitClaim({ incidentAt: 0 }, day(30)).status, 'received');
});

test('refuses a claim reported one day later', () => {
  assert.throws(() => submitClaim({ incidentAt: 0 }, day(31)), LateSubmissionError);
});
