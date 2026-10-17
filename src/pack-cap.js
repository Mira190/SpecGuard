// The context pack's per-file cap, shared by the claude api engine (src/engines/claude-api.js) and the scan collector (src/audit-units.js sizes unit parts from it).
const PER_FILE = 48 * 1024;
const fileCap = (limit) => Math.min(PER_FILE, Math.max(8 * 1024, limit / 6)); // a smaller cap on source/test files when the pack is tight, so each file and its test fit
const packLimit = (env) => { // the pack's size: the engine and the collector both read it here, so they plan the same number of calls
  const v = env.CONTEXT_PACK_BYTES;
  if (v === undefined || String(v).trim() === '') return 250000;
  if (!/^\d+$/.test(String(v).trim())) throw new Error(`context_pack_bytes must be a non-negative integer, got "${String(v).slice(0, 40)}"`); // a typo must not silently become 0 (no source sent)
  return parseInt(v, 10);
};
module.exports = { PER_FILE, fileCap, packLimit };
