// The context pack's per-file cap, shared by the claude api engine (src/engines/claude-api.js) and the scan collector (src/audit-units.js sizes unit parts from it).
const PER_FILE = 48 * 1024;
const fileCap = (limit) => Math.min(PER_FILE, Math.max(8 * 1024, limit / 6)); // a smaller cap on source/test files when the pack is tight, so each file and its test fit
module.exports = { PER_FILE, fileCap };
