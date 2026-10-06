// Pure grading for the real-model evaluation. No I/O. See eval/README.md for the observation shape.
const arr = (v) => (v === undefined ? [] : [].concat(v));
const lc = (s) => String(s || '').toLowerCase();
const STATUS = /^(covered|weak_test|missing_test|higher_level_only|needs_human|unknown): /;

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
  const items = [...s.matchAll(/^- \*\*(.+?)\*\* \(`([^`]+):(\d+)`, (\w+)(?:, ([^)]*))?\)/gm)]
    .map((m) => ({ title: m[1], path: m[2], line: +m[3], kind: m[4], why: m[5] || '' }));
  const rows = [];
  for (const ln of s.split('\n')) {
    if (!ln.startsWith('| ')) continue;
    const c = ln.split(/(?<!\\)\|/).map((x) => x.trim());
    const st = STATUS.exec(c[4] || '');
    const at = /; (\S+?):(\d+) — /.exec(c[2] || '');
    if (st && at) rows.push({ status: st[1], path: at[1], line: +at[2] });
  }
  const notes = /<summary>Validation notes \(\d+\)<\/summary>\n\n([\s\S]*?)\n<\/details>/.exec(s);
  return {
    items, rows, notes: notes ? notes[1].split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)) : [],
    skipped: /Nothing to review/.test(s),
    incomplete: /Could not complete/i.test(s) || /Partially reviewed/.test(s) || /Standards tooling: incomplete/.test(s),
  };
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
    const hit = comments.some((c) => (!m.kind || c.kind === m.kind) && (!m.path || c.path === m.path)
      && (m.line === undefined || Math.abs((c.line ?? 1e9) - m.line) <= (m.tolerance ?? 1)) && (!re || re.test(`${c.title}\n${c.body}`)));
    return hit || (!!re && !m.kind && !m.path && m.line === undefined && reviews.some((r) => re.test(r.body || '')));
  };
  const mustNot = (exp.must_not || []).filter(violates);

  const complete = obs.summary != null && !sum.incomplete;
  // With the raw artifact, JSON validity is about the model output alone; a skipped run has none. Without it, fall back to the summary.
  const jsonValid = obs.raw_findings_present === undefined || sum.skipped ? complete : !!(obs.raw_findings_present && obs.raw_findings_valid_json);
  const skipOk = exp.expect_skip ? sum.skipped && comments.length === 0 : true;
  const cleanOk = exp.expect_clean ? posted.length === 0 : true;
  return {
    id: spec.id, goal: spec.goal, tp, fp: falsePositives.length, acceptable: acceptable.length, fn: missed.length, summary_only: sum.items.length,
    matched, missed, false_positives: falsePositives, acceptable_findings: acceptable, must_not_violations: mustNot, text_misses: textMisses,
    json_valid: jsonValid, complete, degraded: sum.notes.length > 0, validation_notes: sum.notes, skip_ok: skipOk, clean_ok: cleanOk,
    pass: !missed.length && !mustNot.length && !textMisses.length && jsonValid && complete && skipOk && cleanOk,
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

module.exports = { grade, aggregate, parseComment, parseSummary };
