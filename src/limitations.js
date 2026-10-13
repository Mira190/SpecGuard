// Limitation kinds, decided here and nowhere else (requirements.js emits the strings, post.js reads the kind).
// A FACT is a note about the PR or an unreadable reference: it reaches the summary but never makes the run incomplete.
// Every other limitation is a GAP: requirement text that really was not collected (the PR itself, timeouts, caps on closing issues), so the run is incomplete.
const FACT_LIMITATION = /^(?:No requirement text available|requirements-index\.md exceeded |Referenced but not readable: |Context trimmed: |Could not read (?:issue|history issue) |Not read: other-repo reference )/;
const isFactLimitation = (l) => FACT_LIMITATION.test(String(l));
module.exports = { FACT_LIMITATION, isFactLimitation };
