// The context pack's per-file cap, shared by the claude api engine (src/engines/claude-api.js) and the scan collector (src/audit-units.js sizes unit parts from it).
const PER_FILE = 48 * 1024;
const fileCap = (limit) => Math.min(PER_FILE, Math.max(8 * 1024, limit / 6)); // a smaller cap on source/test files when the pack is tight, so each file and its test fit
const packLimit = (env) => (env.CONTEXT_PACK_BYTES === undefined || env.CONTEXT_PACK_BYTES === '' ? 250000 : Math.max(0, parseInt(env.CONTEXT_PACK_BYTES, 10) || 0)); // the pack's size: the engine and the collector both read it here, so they plan the same number of calls
module.exports = { PER_FILE, fileCap, packLimit };
