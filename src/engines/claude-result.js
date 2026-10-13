#!/usr/bin/env node
// Reads `claude -p --output-format json` stdout and writes what the adapter needs. Usage: node claude-result.js <claude stdout> <answer out> <usage out>
// answer out = structured_output as JSON (else the result text, for extract-json.js to try); usage out = the normalized usage shape (src/engines/README.md).
// Prints one line, "ok" or "error <subtype>: <message>" (the CLI's own message, classified by the caller). Never throws.
const fs = require('node:fs');
const [inp, ans, use] = process.argv.slice(2);
const n = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
let r = null;
try { const j = JSON.parse(fs.readFileSync(inp, 'utf8')); r = Array.isArray(j) ? [...j].reverse().find((e) => e?.type === 'result') : j; } catch { /* garbage */ }
if (!r || typeof r !== 'object') { console.log('error unparsable: claude printed no JSON result'); process.exit(0); }
fs.writeFileSync(ans, r.structured_output && typeof r.structured_output === 'object' ? JSON.stringify(r.structured_output) : typeof r.result === 'string' ? r.result : '');
const per = {}; // model -> tokens; modelUsage when present, else the top-level usage under the requested model
for (const [m, x] of Object.entries(r.modelUsage && typeof r.modelUsage === 'object' ? r.modelUsage : {})) per[m] = { i: n(x?.inputTokens), cr: n(x?.cacheReadInputTokens), cw: n(x?.cacheCreationInputTokens), o: n(x?.outputTokens) };
if (!Object.keys(per).length && r.usage) per[process.env.MODEL || 'claude'] = { i: n(r.usage.input_tokens), cr: n(r.usage.cache_read_input_tokens), cw: n(r.usage.cache_creation_input_tokens), o: n(r.usage.output_tokens) };
const sum = (k) => Object.values(per).reduce((a, x) => a + x[k], 0);
fs.writeFileSync(use, JSON.stringify({
  ...(Object.keys(per).length === 1 && { currentModel: Object.keys(per)[0] }),
  totalCostUsd: n(r.total_cost_usd), totalApiDurationMs: n(r.duration_api_ms),
  tokenDetails: { input: { tokenCount: sum('i') }, cache_read: { tokenCount: sum('cr') }, cache_write: { tokenCount: sum('cw') }, output: { tokenCount: sum('o') } },
  // the copilot shape: a model's inputTokens already include its cache read and write tokens
  modelMetrics: Object.fromEntries(Object.entries(per).map(([m, x]) => [m, { usage: { inputTokens: x.i + x.cr + x.cw, cacheReadTokens: x.cr, cacheWriteTokens: x.cw, outputTokens: x.o } }])),
}));
const bad = r.is_error === true || (typeof r.subtype === 'string' && r.subtype !== 'success');
console.log(bad ? `error ${r.subtype || 'error'}: ${String(r.result ?? r.error ?? '').replace(/\s+/g, ' ').slice(0, 300)}` : 'ok');
