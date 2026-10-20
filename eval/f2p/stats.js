// Small exact statistics for the F2P report. Node built-ins only.
const rng = (a) => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const shuffle = (a, r) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// Wilson 95% interval of x/n; null when n = 0.
function wilson(x, n, z = 1.96) {
  if (!n) return null;
  const p = x / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

const LF = [0]; for (let i = 1; i < 2000; i++) LF[i] = LF[i - 1] + Math.log(i);
const lchoose = (n, k) => LF[n] - LF[k] - LF[n - k];
// Two-sided Fisher exact p of [[a, n1-a], [b, n2-b]] (sum of tables no more likely than the observed).
function fisher2(a, n1, b, n2) {
  const K = a + b, N = n1 + n2, lo = Math.max(0, K - n2), hi = Math.min(K, n1);
  const lp = (x) => lchoose(n1, x) + lchoose(n2, K - x) - lchoose(N, K), p0 = lp(a);
  let p = 0; for (let x = lo; x <= hi; x++) if (lp(x) <= p0 + 1e-9) p += Math.exp(lp(x));
  return Math.min(1, p);
}

// Newcombe 95% interval for p1 - p2 from two Wilson intervals.
function newcombe(x1, n1, x2, n2) {
  const a = wilson(x1, n1), b = wilson(x2, n2); if (!a || !b) return null;
  const p1 = x1 / n1, p2 = x2 / n2;
  return [p1 - p2 - Math.sqrt((p1 - a[0]) ** 2 + (b[1] - p2) ** 2), p1 - p2 + Math.sqrt((a[1] - p1) ** 2 + (p2 - b[0]) ** 2)];
}

// Smallest difference (1-pp grid) with simulated Fisher power >= 0.8 for control rate p0, findings independent. Unclustered: overstates power, not used for the decision.
function mddUnclustered(n1, n2, p0, { sims = 2000, seed = 1, alpha = 0.05 } = {}) {
  const cache = new Map(), p = (a, b) => { const k = a * 4096 + b; if (!cache.has(k)) cache.set(k, fisher2(a, n1, b, n2)); return cache.get(k); };
  for (let d = 1; d <= 100 - Math.round(p0 * 100); d++) {
    const r = rng(seed), p1 = p0 + d / 100; let hit = 0;
    for (let s = 0; s < sims; s++) {
      let a = 0, b = 0;
      for (let i = 0; i < n1; i++) if (r() < p1) a++;
      for (let i = 0; i < n2; i++) if (r() < p0) b++;
      if (p(a, b) < alpha) hit++;
    }
    if (hit / sims >= 0.8) return d / 100;
  }
  return null;
}

// Gamma(a, 1) draw (Marsaglia-Tsang; a < 1 boosted) from a uniform source r.
function gamma(a, r) {
  if (a < 1) return gamma(a + 1, r) * Math.pow(r() || 1e-12, 1 / a);
  const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r()); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = r() || 1e-12;
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}
// Beta with mean p and intra-class correlation icc: a + b = 1/icc - 1.
const beta = (p, icc, r) => { const k = 1 / icc - 1, x = gamma(p * k, r), y = gamma((1 - p) * k, r); return x / (x + y); };

// Clustered MDD: smallest NEAR-FAR difference (1-pp grid, binary search) with simulated power >= 0.8 when the test is "PR-cluster bootstrap 95% interval of the difference excludes 0".
// near / far: per-PR finding counts ({pr: n} or an array); a PR's true rate is Beta(mean p, icc), drawn independently per arm and PR. FAR mean = p0, NEAR mean = p0 + delta.
function mdd(near, far, p0, { icc = 0.3, sims = 1000, reps = 1000, seed = 1 } = {}) {
  const N = Object.fromEntries(Object.entries(near)), F = Object.fromEntries(Object.entries(far));
  const prs = [...new Set([...Object.keys(N), ...Object.keys(F)])], P = prs.length;
  const nA = prs.map((k) => N[k] || 0), nB = prs.map((k) => F[k] || 0);
  const power = (delta) => {
    const r = rng(seed), pa = p0 + delta; let hit = 0;
    for (let s = 0; s < sims; s++) {
      const hA = nA.map((n) => { if (!n) return 0; const q = beta(pa, icc, r); let h = 0; for (let i = 0; i < n; i++) if (r() < q) h++; return h; });
      const hB = nB.map((n) => { if (!n) return 0; const q = beta(p0, icc, r); let h = 0; for (let i = 0; i < n; i++) if (r() < q) h++; return h; });
      const d = [];
      for (let b = 0; b < reps; b++) {
        let ha = 0, na = 0, hb = 0, nb = 0;
        for (let i = 0; i < P; i++) { const j = Math.floor(r() * P); ha += hA[j]; na += nA[j]; hb += hB[j]; nb += nB[j]; }
        if (na && nb) d.push(ha / na - hb / nb);
      }
      if (d.length < reps / 2) continue;
      d.sort((u, v) => u - v);
      const lo = d[Math.floor(0.025 * d.length)], hi = d[Math.min(d.length - 1, Math.floor(0.975 * d.length))];
      if (lo > 0 || hi < 0) hit++;
    }
    return hit / sims;
  };
  const top = 100 - Math.round(p0 * 100);
  if (power(top / 100) < 0.8) return null;
  let lo = 1, hi = top;
  while (lo < hi) { const m = (lo + hi) >> 1; if (power(m / 100) >= 0.8) hi = m; else lo = m + 1; }
  return lo / 100;
}

// PR-cluster bootstrap 95% interval for rate(A) - rate(B). Rows: [{pr, hit}] per arm; PRs are resampled with replacement.
function bootDiff(A, B, { reps = 2000, seed = 1 } = {}) {
  const prs = [...new Set([...A, ...B].map((x) => x.pr))], r = rng(seed), by = (S) => { const m = {}; for (const x of S) (m[x.pr] = m[x.pr] || []).push(x.hit ? 1 : 0); return m; };
  const ma = by(A), mb = by(B), out = [];
  const rate = (m, pick) => { let h = 0, n = 0; for (const p of pick) for (const v of m[p] || []) { h += v; n++; } return n ? h / n : null; };
  for (let i = 0; i < reps; i++) {
    const pick = prs.map(() => prs[Math.floor(r() * prs.length)]), x = rate(ma, pick), y = rate(mb, pick);
    if (x !== null && y !== null) out.push(x - y);
  }
  out.sort((u, v) => u - v);
  return out.length ? [out[Math.floor(0.025 * out.length)], out[Math.min(out.length - 1, Math.floor(0.975 * out.length))]] : null;
}

module.exports = { rng, shuffle, wilson, fisher2, newcombe, mddUnclustered, mdd, bootDiff };
