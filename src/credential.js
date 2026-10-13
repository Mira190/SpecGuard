#!/usr/bin/env node
// Detects what kind of LLM credential the user gave, by prefix, and resolves the engine and the model name for it.
// Env: LLM_TOKEN (llm_token || copilot_token; never argv), ENGINE (auto | copilot | claude | anything else, left for validate-inputs.sh), MODEL.
// Writes kind (copilot | anthropic | empty), engine and model to $GITHUB_OUTPUT and logs "credential: <kind>". The token, or any part of it, is never printed.
const fs = require('node:fs');

const KINDS = [[/^(github_pat_|gho_|ghu_)/, 'copilot'], [/^sk-ant-/, 'anthropic']];
const ENGINE_OF = { copilot: 'copilot', anthropic: 'claude' };
// ponytail: a tiny alias map, one row per model worth a short name; full ids always pass through unchanged. Add a row when a model needs a short name.
const ALIASES = { 'haiku-5.5': { copilot: 'claude-haiku-5.5', claude: 'claude-haiku-5-5' } };

function detect(token) { // -> { kind } or { error }; the error text never contains the token
  const t = String(token || '').trim();
  if (!t) return { kind: '' };
  if (t.startsWith('ghp_')) return { error: 'classic GitHub PATs are not supported by Copilot; use a fine-grained PAT with Copilot Requests' };
  const hit = KINDS.find(([re]) => re.test(t));
  return hit ? { kind: hit[1] } : { error: 'unrecognized credential type (expected a GitHub fine-grained PAT or an Anthropic API key)' };
}

function resolveEngine(engine, kind) { // auto: by credential kind; no token = Copilot on the job token. An explicit engine must match the credential.
  const e = engine || 'auto';
  if (e === 'auto') return { engine: kind ? ENGINE_OF[kind] : 'copilot' };
  if (e === 'claude' && kind !== 'anthropic') return { error: 'engine claude needs an Anthropic API key (sk-ant-...) as llm_token' };
  if (e === 'copilot' && kind === 'anthropic') return { error: 'engine copilot needs a GitHub fine-grained PAT; the credential is an Anthropic API key (use engine: auto or claude)' };
  return { engine: e };
}

const resolveModel = (model, engine) => ALIASES[String(model || '').trim().toLowerCase()]?.[engine] ?? String(model || '').trim();

function resolve({ token, engine, model }) {
  const d = detect(token);
  if (d.error) return d;
  const e = resolveEngine(String(engine ?? '').trim(), d.kind);
  return e.error ? e : { kind: d.kind, engine: e.engine, model: resolveModel(model, e.engine) };
}

if (require.main === module) {
  const env = process.env;
  if (/[\r\n]/.test(`${env.ENGINE || ''}${env.MODEL || ''}`)) { console.log('::error::engine and model must be a single line'); process.exit(1); } // would inject extra GITHUB_OUTPUT lines
  const r = resolve({ token: env.LLM_TOKEN, engine: env.ENGINE, model: env.MODEL });
  if (r.error) { console.log(`::error::${r.error}`); process.exit(1); }
  console.log(`credential: ${r.kind || 'job token'}`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `kind=${r.kind}\nengine=${r.engine}\nmodel=${r.model}\n`);
}
Object.assign(module.exports, { detect, resolveEngine, resolveModel, resolve });
