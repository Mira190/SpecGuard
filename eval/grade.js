// Pure grading for the real-model evaluation. No I/O. See eval/README.md for the observation shape.
const arr = (v) => (v === undefined ? [] : [].concat(v));
const lc = (s) => String(s || '').toLowerCase();
// The obligations table shows a status as a word ("Weak test: reason", src/post.js STATUS_LABEL); the old tokens still parse.
const STATUS_WORD = { Evidenced: 'covered', 'Weak test': 'weak_test', 'Missing test': 'missing_test', 'Higher-level only': 'higher_level_only', 'Needs a person': 'needs_human', 'Not assessed': 'unknown' };
const STATUS = /^(covered|weak_test|missing_test|higher_level_only|needs_human|unknown|Evidenced|Weak test|Missing test|Higher-level only|Needs a person|Not assessed): /;
// A summary list item that carries its own text: "- Title `path:line` (why) — sentence" under a kind heading ("### ❌ Missing unit tests (2)"), or the older labelled form "- ❌ **Missing test:** Title ...". A posted finding links its title to the comment (`[Title](url)`) and is not counted here.
const ITEM_KIND = { 'Missing test': 'missing_test', 'Weak test': 'weak_test', Mismatch: 'spec_mismatch', Violation: 'standard', 'Move down': 'pushdown' };
const HEAD_KIND = { 'Missing unit tests': 'missing_test', 'Weak unit tests': 'weak_test', 'Spec mismatches': 'spec_mismatch', 'Coding standard violations': 'standard', 'Tests to move down': 'pushdown' };
const HEAD = /^### \S+ (.+?)(?: \(\d+\))?[ \t]*$/gm;
const ITEM = /^- (?:(?:❌ )?\*\*(Missing test|Weak test|Mismatch|Violation|Move down):\*\* )?(?!\[)(.+?) \[?`([^`\n]+):(\d+)`(?:\]\([^)\n]*\))?(?: \(([^)\n]*)\))?/gm;
const ALIGN =['consistent', 'mismatch', 'impacted', 'not_verifiable', 'not_applicable', 'unknown'];
const TRACE_HEAD = /^\|\s*Requirement\s*\|\s*Changed\s*\|\s*Implementation\s*\|\s*Tests\s*\|\s*Alignment\s*\|\s*Reflected in\s*\|/i;
const YES = '✓✔✅', NO = '✗✘❌✕';
// "spec ✓ tests ✗ PR ✗" (labelled) or "✓ ✗ ✓" (spec, tests, PR in that order). null = not stated.
function parseReflected(cell) {
  const out = { spec: null, tests: null, pr: null };
  const mark = (c) => (YES.includes(c) ? true : NO.includes(c) ? false : null);
  for (const k of Object.keys(out)) {
    const m = new RegExp(`\\b${k}\\b\\W{0,3}([${YES}${NO}]|yes|no|true|false)`, 'i').exec(cell);
    if (m) out[k] = /^(yes|true)$/i.test(m[1]) ? true : /^(no|false)$/i.test(m[1]) ? false : mark(m[1]);
  }
  const marks = [...cell].filter((c) => (YES + NO).includes(c));
  if (marks.length === 3 && Object.values(out).every((v) => v === null)) [out.spec, out.tests, out.pr] = marks.map(mark);
  return out;
}

// Parses a review comment the Action posted (src/post.js commentBody). Null when it is not ours.
function parseComment(c) {
  const body = c.body || '';
  const m = /kind: (\w+), confidence: (high|low)(?:, rule: ([^\n]+))?/.exec(body);
  if (!m) return null;
  const link = /\[[^\]\n]+:(\d+)\]\(https?:[^)\s]*#L\d+/.exec(body);
  const src = /\b(issue (?:[\w.-]+\/[\w.-]+)?#\d+|PR body) AC \d+\b/.exec(body);
  return {
    kind: m[1], confidence: m[2], rule: m[3] || '', path: c.path,
    line: c.line ?? c.original_line ?? (link ? +link[1] : null),
    level: c.subject_type === 'file' ? 'file' : 'inline',
    title: (/^\*\*(.+?)\*\*/.exec(body) || [])[1] || '',
    body, source: src ? src[0] : '',
  };
}

// Parses the sticky summary (src/post.js buildSummary): the collapsed items and the coverage table rows.
function parseSummary(text) {
  const s = String(text || '');
  const heads = [...s.matchAll(HEAD)], details = s.indexOf('<details><summary>Details:'); // a bare item takes its kind from the nearest heading above it, in the visible part only
  const items = [...s.matchAll(ITEM)].map((m) => ({ title: m[2], path: m[3], line: +m[4], kind: m[1] ? ITEM_KIND[m[1]] : (details < 0 || m.index < details) && HEAD_KIND[(heads.filter((h) => h.index < m.index).pop() || [])[1]], why: m[5] || '' })).filter((i) => i.kind);
  const rows = [], trace = [], lines = s.split('\n'), traceLines = new Set();
  // Traceability table: the header row, then table rows until the first other line.
  const th = lines.findIndex((l) => TRACE_HEAD.test(l));
  if (th >= 0) for (let i = th; i < lines.length && lines[i].startsWith('|'); i++) {
    traceLines.add(i);
    const c = lines[i].split(/(?<!\\)\|/).map((x) => x.trim());
    if (i === th || /^:?-+:?$/.test(c[1] || '')) continue;
    trace.push({ requirement: c[1], changed: c[2], implementation: c[3], tests: c[4], alignment: ALIGN.find((a) => new RegExp(`\\b${a.replace('_', '[ _]')}\\b`, 'i').test(c[5] || '')) || '', reflected: parseReflected(c[6] || ''), raw: lines[i] });
  }
  lines.forEach((ln, i) => {
    if (!ln.startsWith('| ') || traceLines.has(i)) return;
    const c = ln.split(/(?<!\\)\|/).map((x) => x.trim());
    const st = STATUS.exec(c[4] || '');
    const at = /; (\S+?):(\d+) — /.exec(c[2] || '');
    if (st && at) rows.push({ status: STATUS_WORD[st[1]] || st[1], path: at[1], line: +at[2], text: ln });
  });
  // "Pre-existing drift (not caused by this PR)" section: up to the next heading or the end of its <details>. Null when absent.
  const pe = /Pre-existing drift \(not caused by this PR\)/.exec(s);
  const preExisting = pe ? s.slice(pe.index + pe[0].length).split(/\n#{1,6} |\n\*\*[^\n]+\*\*\n|<\/details>/)[0].replace(/^\*\*/, '').trim() : null;
  const notes = /Validation notes \(\d+\)(?:<\/summary>|\*\*)\n\n([\s\S]*?)(?=\n\n\*\*|\n<\/details>|\n*$)/.exec(s);
  return {
    items, rows, trace, preExisting, noRequirementDocs: /No requirement documents found/.test(s), notes: notes ? notes[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)) : [],
    skipped: /Nothing to review/.test(s),
    incomplete: /Could not complete/i.test(s) || /Partially reviewed|The diff exceeded `max_diff_kb`/.test(s) || /Standards tooling: incomplete/.test(s),
  };
}

// The summary restricted to items and coverage rows under a path prefix (combined runs); every other line is kept.
function filterSummary(text, prefix) {
  if (text == null) return text;
  return text.split('\n').filter((ln) => {
    const m = /^- (?:❌ )?\*\*[^*\n]+:\*\* .*?\[?`([^`:\n]+):\d+`/.exec(ln) || (ln.startsWith('| ') ? /; (\S+?):\d+ — /.exec(ln.split(/(?<!\\)\|/)[2] || '') : null);
    return !m || m[1].startsWith(prefix);
  }).join('\n');
}

function grade(spec, obs) {
  const exp = spec.expected || {};
  const comments = obs.comments || [], reviews = obs.reviews || [];
  const posted = comments.filter((c) => c.confidence === 'high');
  const sum = parseSummary(obs.summary);
  const used = new Set(), matched = [], missed = [], textMisses = [];
  const summaryHits = [...sum.items, ...sum.rows.filter((r) => ['weak_test', 'missing_test', 'higher_level_only'].includes(r.status))
    .map((r) => ({ kind: r.status === 'higher_level_only' ? 'pushdown' : r.status, path: r.path }))];
  let tp = 0;
  for (const e of exp.findings || []) {
    const tol = e.tolerance ?? 2;
    let best = -1, bestD = Infinity;
    posted.forEach((o, j) => {
      if (used.has(j) || !arr(e.kind).includes(o.kind) || !arr(e.path).includes(o.path)) return;
      if (e.rule && !lc(o.rule).includes(lc(e.rule))) return;
      const d = o.line == null ? 1e9 : Math.abs(o.line - e.line);
      if (d > tol && !(e.source && o.source === e.source)) return;
      if (d < bestD) { best = j; bestD = d; }
    });
    if (best >= 0) {
      used.add(best); tp++; matched.push({ expected: e, observed: posted[best] });
      if (e.text && !new RegExp(e.text, 'i').test(`${posted[best].title}\n${posted[best].body}`)) textMisses.push(e);
    } else if (e.allow_summary && summaryHits.some((h) => arr(e.kind).includes(h.kind) && arr(e.path).includes(h.path))) {
      tp++; matched.push({ expected: e, observed: null, via_summary: true });
    } else missed.push(e);
  }
  // Reasonable findings the fixture truly leaves untested but did not seed: neither TP nor FP.
  const spare = [...(exp.acceptable || [])], acceptable = [], falsePositives = [];
  for (const { kind, path, line, title } of posted.filter((_, j) => !used.has(j))) {
    const k = spare.findIndex((a) => arr(a.kind).includes(kind) && arr(a.path).includes(path) && line != null && Math.abs(line - a.line) <= (a.tolerance ?? 2));
    if (k >= 0) acceptable.push({ kind, path, line, title, reason: spare.splice(k, 1)[0].reason });
    else falsePositives.push({ kind, path, line, title });
  }

  const violates = (m) => {
    if (m.state) return reviews.some((r) => r.state === m.state);
    const re = m.text && new RegExp(m.text, 'i');
    const hit = comments.some((c) => (!m.kind || c.kind === m.kind) && (!m.path || c.path === m.path) && (!m.confidence || c.confidence === m.confidence)
      && (m.line === undefined || Math.abs((c.line ?? 1e9) - m.line) <= (m.tolerance ?? 1)) && (!re || re.test(`${c.title}\n${c.body}`)));
    return hit || (!!re && !m.kind && !m.path && m.line === undefined && reviews.some((r) => re.test(r.body || '')));
  };
  const mustNot = (exp.must_not || []).filter(violates);

  // Summary-level expectations (traceability). Every failed check is listed in summary_misses.
  const text = String(obs.summary || ''), re = (p) => new RegExp(p, 'i'), sm = [];
  for (const p of exp.summary_has || []) if (!re(p).test(text)) sm.push(`missing /${p}/`);
  for (const p of exp.summary_lacks || []) if (re(p).test(text)) sm.push(`must not contain /${p}/`);
  for (const r of exp.rows_not || []) if (sum.rows.some((x) => x.status === r.status && (!r.text || re(r.text).test(x.text)))) sm.push(`coverage row ${r.status} /${r.text || ''}/`);
  if (exp.pre_existing !== undefined && !(sum.preExisting != null && (exp.pre_existing === true || re(exp.pre_existing).test(sum.preExisting)))) sm.push(`no Pre-existing drift section matching ${JSON.stringify(exp.pre_existing)}`);
  for (const t of exp.trace || []) {
    const row = sum.trace.find((x) => !t.requirement || re(t.requirement).test(x.requirement));
    if (!row) { sm.push(`no Traceability row for /${t.requirement || ''}/`); continue; }
    if (t.alignment && !arr(t.alignment).includes(row.alignment)) sm.push(`/${t.requirement}/ alignment ${row.alignment || '(none)'}, want ${arr(t.alignment).join('|')}`);
    if (t.alignment_not && arr(t.alignment_not).includes(row.alignment)) sm.push(`/${t.requirement}/ alignment must not be ${row.alignment}`);
    for (const [k, v] of Object.entries(t.reflected || {})) if (row.reflected[k] !== v) sm.push(`/${t.requirement}/ reflected ${k} is ${row.reflected[k]}, want ${v}`);
  }

  const complete = obs.summary != null && !sum.incomplete;
  // With the raw artifact, JSON validity is about the model output alone; a skipped run has none. Without it, fall back to the summary.
  const jsonValid = obs.raw_findings_present === undefined || sum.skipped ? complete : !!(obs.raw_findings_present && obs.raw_findings_valid_json);
  const skipOk = exp.expect_skip ? sum.skipped && comments.length === 0 : true;
  const cleanOk = exp.expect_clean ? posted.length === 0 : true;
  return {
    id: spec.id, goal: spec.goal, tp, fp: falsePositives.length, acceptable: acceptable.length, fn: missed.length, summary_only: sum.items.length,
    matched, missed, summary_misses: sm, false_positives: falsePositives, acceptable_findings: acceptable, must_not_violations: mustNot, text_misses: textMisses,
    json_valid: jsonValid, complete, degraded: sum.notes.length > 0, validation_notes: sum.notes, skip_ok: skipOk, clean_ok: cleanOk,
    pass: !missed.length && !mustNot.length && !sm.length && !textMisses.length && jsonValid && complete && skipOk && cleanOk,
    latency_s: obs.latency_s ?? null,
  };
}

const ratio = (a, b) => (b ? +(a / b).toFixed(3) : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Runs that errored (infrastructure, not the model) are counted but excluded from every metric.
function summarize(rs) {
  const ok = rs.filter((r) => !r.error);
  const n = (k) => ok.reduce((t, r) => t + r[k], 0);
  const [tp, fp, fn] = [n('tp'), n('fp'), n('fn')];
  const acceptable = ok.reduce((t, r) => t + (r.acceptable || 0), 0);
  const lat = ok.map((r) => r.latency_s).filter((x) => x != null);
  return {
    runs: rs.length, errors: rs.length - ok.length, tp, fp, acceptable, fn, summary_only: n('summary_only'),
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    json_valid_rate: ratio(ok.filter((r) => r.json_valid).length, ok.length),
    degraded_rate: ratio(ok.filter((r) => r.degraded).length, ok.length),
    pass_rate: ratio(ok.filter((r) => r.pass).length, ok.length),
    latency_median_s: median(lat), latency_max_s: lat.length ? Math.max(...lat) : null,
  };
}

function aggregate(results) {
  const by_goal = {};
  for (const g of [...new Set(results.map((r) => r.goal))]) by_goal[g] = summarize(results.filter((r) => r.goal === g));
  return { ...summarize(results), cost: 'not measured', by_goal };
}

module.exports = { grade, aggregate, parseComment, parseSummary, filterSummary };
