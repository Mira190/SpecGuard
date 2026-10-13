#!/usr/bin/env node
// The claude adapter's default mode (claude_mode: api): ONE Anthropic Messages API call, no agent loop and no CLI. SpecGuard already inlines the diff, test candidates, leads, requirements and rule files
// into the prompt (src/prompt.js), so the model needs no tools: the agent loop re-sends the whole context every turn and its cost cannot be bounded up front (two live runs: $3.58 and $3.44 against a $1 budget).
// Env: CTX PROMPT_FILE (or PROMPT) ANTHROPIC_API_KEY (environment only) MODEL (empty = claude-haiku-5-5) MAX_BUDGET_USD (default 1.00; a HARD bound: checked before the call) MAX_OUTPUT_TOKENS (default 16000) CONTEXT_PACK_BYTES (repository files appended to the prompt, default 300000, 0 = off; read from GITHUB_WORKSPACE or the cwd) EFFORT (ignored, noted) TIMEOUT (minutes) CHECK (audit = scan schema) FAST_MODELS.
// Files in CTX as in src/engines/README.md: findings.json usage.json engine-status engine-notes engine-error engine-model.json. Never throws, never prints the key.
const fs = require('node:fs');
const path = require('node:path');
const { block, cut, LIMITS } = require('../prompt.js');
const { parseCandidates } = require('../focus.js');

const ENDPOINT = 'https://api.anthropic.com/v1/messages', API_VERSION = '2023-06-01';
// ponytail: USD per million tokens, one row per model worth pricing (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-10-14). Haiku 5.5 has a second card above 100K prompt tokens.
// Cache read = 0.1x input, 5-minute cache write = 1.25x. A model that is not here is priced at DEFAULT_PRICE (a high card, so the pre-flight stays conservative) and the cost is noted as an estimate. Add a row when a model needs exact cost.
const PRICES = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5, longFrom: 100000, longIn: 0.5, longOut: 2.5 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-opus-5': { in: 5, out: 25 },
};
const DEFAULT_PRICE = { in: 5, out: 25 };
const priceOf = (model, promptTokens) => { const p = PRICES[model] || DEFAULT_PRICE; return p.longFrom && promptTokens > p.longFrom ? { in: p.longIn, out: p.longOut } : { in: p.in, out: p.out }; };
const cost = (model, u) => { // u = the API usage object
  const i = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0, o = u.output_tokens || 0, p = priceOf(model, i + cr + cw);
  return (i * p.in + cr * p.in * 0.1 + cw * p.in * 1.25 + o * p.out) / 1e6;
};
// Worst case before the call: the whole prompt as cache WRITE for the static part (1.25x) and plain input for the rest, and every allowed output token. bytes / 3.5 over-counts tokens for English and code.
const worstCase = (model, sysBytes, userBytes, maxTokens) => {
  const s = Math.ceil(sysBytes / 3.5), u = Math.ceil(userBytes / 3.5), p = priceOf(model, s + u);
  return { tokens: s + u, usd: (s * 1.25 * p.in + u * p.in + maxTokens * p.out) / 1e6 };
};

// Structured outputs accept a subset of JSON Schema: every object closed (additionalProperties:false), no string/number bounds, no uniqueItems/maxItems, no if/then/else, minItems only 0 or 1.
// post.js validates the answer against the full schema anyway.
const DROP = new Set(['$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'uniqueItems', 'maxItems', 'if', 'then', 'else']);
function strict(s) {
  if (Array.isArray(s)) return s.map(strict);
  if (!s || typeof s !== 'object') return s;
  const o = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k) || (k === 'minItems' && v > 1)) continue;
    o[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([n, p]) => [n, strict(p)])) : strict(v);
  }
  if (o.type === 'object' || o.properties) o.additionalProperties = false;
  return o;
}

// The prompt is "static prefix (skill, references, schema) + --- + per-PR context" (src/prompt.js): the prefix becomes the cached system block, the rest the user message.
const SPLIT = '\n\n---\n\nContext directory (absolute path):';
const NO_TOOLS = 'This run has no file tools: you cannot Read, Grep or Glob. Ignore every instruction above to read files or to stay within a tool budget. Use only the context inlined below; where the answer would need a file you cannot see, mark it unknown and say so. Output only the JSON object.\n\n';
const NO_TOOLS_PACK = 'This run has no file tools: you cannot Read, Grep or Glob. Ignore every instruction above to read files or to stay within a tool budget. Instead, the blocks after "Repository files" at the end hold files read from the repository: each is the full current text of the file it names (line-numbered where its note says so), unless its note says where it was cut. Anything that is neither inlined nor in those blocks was not read: where the answer would need it, mark it unknown and say so. Output only the JSON object.\n\n';
function messages(prompt, pack = '') {
  const at = prompt.indexOf(SPLIT);
  const system = at > 0 ? prompt.slice(0, at) : '', user = at > 0 ? prompt.slice(at + 2) : prompt; // keep "---" at the head of the user part
  return { system, user: (pack ? NO_TOOLS_PACK : NO_TOOLS) + user + (pack ? `\n${pack}\n\nReminder: output only the JSON object matching the schema.\n` : '') };
}

// The context pack: repository files appended to the user message, in priority order, until CONTEXT_PACK_BYTES is spent. The prompt was written for an agent that Reads files; here nobody can.
// Trust boundary: every path comes from the (PR-influenced) context files, so it is resolved against the repo root after realpath and anything outside, secret-like or binary is skipped. Nothing read here is ever logged.
const PER_FILE = 48 * 1024, MAX_FILE = 2 * 1024 * 1024, OVERHEAD = 300; // OVERHEAD: the block markup around a body
const DENY = /(^|\/)(\.git|\.specguard-(ctx|src))(\/|$)|(^|\/)(\.env(\.[^/]*)?|[^/]*\.env|[^/]*\.pem|[^/]*\.key|id_rsa[^/]*)$/i;
function packRead(root, rel) { // text of a regular, small, non-binary file inside the repo, else null
  if (!rel || /["<>\x00-\x1f]/.test(rel) || path.isAbsolute(rel)) return null; // quotes and angle brackets would break the block label
  try {
    const real = fs.realpathSync(path.resolve(root, rel)), r = path.relative(root, real).split(path.sep).join('/');
    if (!r || r === '..' || r.startsWith('../') || path.isAbsolute(r) || DENY.test(rel.replace(/\\/g, '/')) || DENY.test(r)) return null;
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_FILE) return null;
    const buf = fs.readFileSync(real);
    return buf.subarray(0, 8192).includes(0) ? null : buf.toString('utf8').replace(/\r\n/g, '\n');
  } catch { return null; }
}
function contextPack(ctx, root, limit) {
  const rd = (n) => { try { return fs.readFileSync(path.join(ctx, n), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
  const list = (n) => rd(n).split('\n').filter(Boolean);
  const parts = [], seen = new Set(), omitted = [];
  let used = 0, files = 0;
  const addFile = (p, num) => { // num: line-numbered
    const rel = path.posix.normalize(p.replace(/\\/g, '/'));
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = packRead(root, rel);
    if (!text || !text.trim()) return;
    const room = Math.min(PER_FILE, limit - used - OVERHEAD), src = text.replace(/\n$/, '').split('\n');
    if (room < 200) return void omitted.push(rel);
    const c = cut(num ? src.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join('\n') + '\n' : text, room);
    if (c.cut && c.lines < 1) return void omitted.push(rel);
    const b = block(rel, c.text, `${c.cut ? `first ${c.lines} of ${src.length} lines` : 'full file'}${num ? ', line-numbered' : ''}`);
    parts.push(b); used += Buffer.byteLength(b); files++;
  };
  const numbered = rd('diff.numbered.txt'), dname = numbered.trim() ? 'diff.numbered.txt' : 'diff.patch', diff = numbered.trim() ? numbered : rd('diff.patch');
  const head = cut(diff, LIMITS.diff);
  if (head.cut && limit - OVERHEAD >= 200) { // the part of the diff prompt.js cut ("Read ... for the rest")
    const dl = diff.replace(/\n$/, '').split('\n'), c = cut(dl.slice(head.lines).join('\n'), limit - OVERHEAD), all = dl.length;
    if (c.lines > 0) { const b = block(`${dname} (rest)`, c.text, `lines ${head.lines + 1} to ${head.lines + c.lines} of ${all}; continues the diff block above${c.cut ? '; cut at the context budget' : ''}`); parts.push(b); used += Buffer.byteLength(b); }
  }
  for (const p of list('standards.txt')) addFile(p, false);
  const focus = list('focus.txt').map((l) => l.split('\t')[0]), review = focus.length ? focus : list('files.txt');
  for (const p of review) addFile(p, true);
  const cands = parseCandidates(rd('test-candidates.txt'));
  for (const p of review) for (const t of cands.get(p) || []) addFile(t, true);
  for (const p of list('spec-files.txt')) addFile(p, false);
  const text = parts.length ? `Repository files (read from the checked-out repository; the rest of a cut diff, rule files, the files under review, their candidate tests, requirement documents):\n\n${parts.join('\n\n')}` : '';
  const note = files || omitted.length ? `context pack: ${files} files, ${Math.round(used / 1024)} KB${omitted.length ? `; not included: ${omitted.slice(0, 4).join(', ')}${omitted.length > 4 ? ` (+${omitted.length - 4} more)` : ''}` : ''}` : '';
  return { text, note };
}

const tokenRe = /github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-ant-[A-Za-z0-9_-]+|Bearer [^\s]+/g;
const fmt = (x) => x.toFixed(x < 0.1 ? 4 : 2);

// ponytail: substring table over the API's error type and message; first match wins. Same reasons as claude.sh (budget, quota, auth, rate, model).
function classify(status, type = '', message = '') {
  const t = `${type} ${message}`;
  if (status === 402 || /billing_error|credit balance/i.test(t)) return ['quota', 'The Anthropic account has no credit left or hit its quota (add credits to the API account; this is not the per-run budget)'];
  if (status === 401 || status === 403 || /authentication_error|permission_error|invalid x-api-key/i.test(t)) return ['auth', 'The Anthropic API key was rejected (check the llm_token secret)'];
  if (status === 429 || status === 529 || /rate_limit|overloaded/i.test(t)) return ['rate', 'Anthropic rate limit or overload; the next push retries'];
  if (status === 404 || /model.*(not found|not available|does not exist)|invalid model|issue with the selected model/i.test(message)) return ['model', null]; // text needs the model name
  return ['', null];
}

async function run(env = process.env, { fetchFn = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const ctx = env.CTX, key = env.ANTHROPIC_API_KEY || '';
  const scrub = (s) => { let x = String(s); if (key) x = x.split(key).join('***'); return x.replace(tokenRe, '***'); };
  const w = (n, s) => fs.writeFileSync(path.join(ctx, n), s);
  fs.mkdirSync(ctx, { recursive: true });
  const notes = [];
  if (env.EFFORT) notes.push('effort ignored: claude engine');
  const end = (status, reason, why, raw) => { // status: failed | timeout | success
    if (status !== 'success') w('engine-status', status);
    if (reason) w('engine-error', `${reason}\n${why}\n`);
    if (why) notes.unshift(`${why}${raw ? `: ${scrub(raw).slice(0, 200)}` : ''}`);
    w('engine-notes', notes.map((n) => scrub(n).slice(0, 300)).join('\n') + (notes.length ? '\n' : ''));
    if (status === 'timeout') console.log('::warning::Claude review timed out');
    else if (status === 'failed') console.log(`::warning::Claude review failed${why ? `: ${scrub(why)}` : ''}`);
  };
  try {
    if (!key) return end('failed', 'auth', 'The Anthropic API key was rejected (check the llm_token secret)', 'no ANTHROPIC_API_KEY in the environment');
    const prompt = env.PROMPT_FILE ? fs.readFileSync(env.PROMPT_FILE, 'utf8') : env.PROMPT || '';
    const model = env.MODEL || 'claude-haiku-5-5';
    const maxTokens = parseInt(env.MAX_OUTPUT_TOKENS, 10) || 16000, budget = parseFloat(env.MAX_BUDGET_USD || '1.00');
    const schema = strict(JSON.parse(fs.readFileSync(path.join(__dirname, '..', env.CHECK === 'audit' ? 'audit.schema.json' : 'findings.schema.json'), 'utf8')));
    const packBytes = env.CONTEXT_PACK_BYTES === undefined || env.CONTEXT_PACK_BYTES === '' ? 300000 : Math.max(0, parseInt(env.CONTEXT_PACK_BYTES, 10) || 0);
    let pack = { text: '', note: '' };
    if (packBytes > 0) try { pack = contextPack(ctx, fs.realpathSync(env.GITHUB_WORKSPACE || process.cwd()), packBytes); } catch { /* the pack is optional */ }
    const { system, user } = messages(prompt, pack.text); // the pre-flight below sees the pack
    const est = worstCase(model, Buffer.byteLength(system), Buffer.byteLength(user), maxTokens);
    if (est.usd > budget) { // the budget is hard here: nothing is sent
      const why = `estimated worst-case cost $${fmt(est.usd)} exceeds max_budget_usd $${fmt(budget)} (about ${Math.round(est.tokens / 1000)}k input tokens and up to ${maxTokens} output tokens on ${model}; raise max_budget_usd, lower max_output_tokens or use a cheaper model)`;
      return end('failed', 'budget', why);
    }
    if (!PRICES[model]) notes.push(`cost estimated at default rates: ${model} is not in the price table`);
    if (pack.note) notes.push(pack.note);
    const body = {
      model, max_tokens: maxTokens,
      ...(system && { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }),
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema } },
    };
    const deadline = Date.now() + (parseInt(env.TIMEOUT, 10) || 12) * 60000, t0 = Date.now();
    let res, retried = false, plain = false;
    for (;;) {
      const left = deadline - Date.now();
      if (left < 1000) return end('timeout');
      try {
        const r = await fetchFn(ENDPOINT, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(left) });
        const text = await r.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        res = { status: r.status, ok: r.ok, json, text, retryAfter: parseFloat(r.headers?.get?.('retry-after')) };
      } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return end('timeout');
        res = { status: 0, ok: false, json: null, text: `network error: ${e?.cause?.code || e?.message || e}` };
      }
      if (res.ok) break;
      const m = String(res.json?.error?.message || '');
      if (res.status === 400 && !plain && /schema|output_config|output_format|too complex/i.test(m) && !/credit balance/i.test(m)) { // the structured-output grammar was refused: ask for plain JSON once (post.js validates it)
        plain = true; delete body.output_config; notes.push('structured output unavailable for this schema; plain JSON requested'); continue;
      }
      const wait = Number.isFinite(res.retryAfter) ? res.retryAfter : 2;
      if (!retried && (res.status === 0 || res.status === 429 || res.status >= 500) && wait <= 30 && deadline - Date.now() > wait * 1000 + 1000) { retried = true; await sleep(wait * 1000); continue; }
      break;
    }
    if (!res.ok) {
      const e = res.json?.error || {}, raw = `HTTP ${res.status || 'none'}${e.type ? ` ${e.type}` : ''}: ${e.message || res.text}`.replace(/\s+/g, ' ');
      const [reason, why] = classify(res.status, e.type, e.message);
      return end('failed', reason, reason === 'model' ? `The model '${model}' is not available to this API key (check the model input)` : why || `Anthropic API request failed`, raw);
    }
    const j = res.json || {}, u = j.usage || {}, used = typeof j.model === 'string' && j.model ? j.model : model;
    const i = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0, o = u.output_tokens || 0;
    w('usage.json', JSON.stringify({
      currentModel: used, totalCostUsd: cost(used, u), totalApiDurationMs: Date.now() - t0,
      tokenDetails: { input: { tokenCount: i }, cache_read: { tokenCount: cr }, cache_write: { tokenCount: cw }, output: { tokenCount: o } },
      modelMetrics: { [used]: { usage: { inputTokens: i + cr + cw, cacheReadTokens: cr, cacheWriteTokens: cw, outputTokens: o } } }, // the copilot shape: inputTokens include the cache tokens
    }));
    try { require('../engine-model.js').run({ ctx, requested: model, turn: 'main', usage: path.join(ctx, 'usage.json'), fast: env.FAST_MODELS || '' }); } catch { /* never fails the step */ }
    if (j.stop_reason === 'refusal') return end('failed', 'policy', 'The model declined to answer (safety refusal)');
    if (j.stop_reason === 'max_tokens') return end('failed', 'length', `The reply hit max_output_tokens (${maxTokens}) before the JSON was complete (raise max_output_tokens)`);
    const answer = (Array.isArray(j.content) ? j.content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
    let found; try { found = JSON.stringify(JSON.parse(answer)); } catch { found = require('../extract-json.js').extract(answer); }
    if (!found) return end('failed', '', 'no JSON found in the engine output');
    w('findings.json', found);
    end('success');
  } catch (e) {
    end('failed', '', 'Claude API adapter error', e?.message || String(e));
  }
}

if (require.main === module) run().catch(() => {}).then(() => process.exit(0));
module.exports = { run, strict, messages, classify, cost, worstCase, PRICES };
