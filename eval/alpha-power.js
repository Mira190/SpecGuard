#!/usr/bin/env node
// Power of the label-export alpha gate (docs/validation-plan.md, Step 4): how often two labellers with a given raw agreement pass it at
// n doubly labelled findings. Seeded; prints a table. Model: each finding is valid with probability --prevalence; with probability
// agreement both labellers give the same label, otherwise they split (which one says valid is a coin flip).
//   node eval/alpha-power.js [--prevalence 0.25] [--trials 200] [--seed 1] [--agreement 0.95,0.90] [--n 30,60,100,150]
const { alpha, alphaInterval, classify } = require('./label-export');
const { mulberry32 } = require('./szz');

// share of trials whose sheet is decision grade on the statistics alone (the minimum-n rule of label-export is not applied: the table is why it exists)
function power({ prevalence = 0.25, agreement, n, trials = 200, seed = 1 }) {
  const r = mulberry32(seed + n * 1009 + Math.round(agreement * 1e4)); let pass = 0, passDrop = 0, sumA = 0;
  for (let t = 0; t < trials; t++) {
    const us = Array.from({ length: n }, () => {
      const v = r() < prevalence ? 'valid' : 'invalid', o = v === 'valid' ? 'invalid' : 'valid';
      if (r() < agreement) return [v, v];
      return r() < 0.5 ? [v, o] : [o, v];
    });
    const a = alpha(us), ci = alphaInterval(us); sumA += a ?? 0;
    if (classify(a, ci && ci[0]) === 'reliable') pass++;
    if (classify(a, ci && ci[0], Infinity, ci ? ci[2] : 1) === 'reliable') passDrop++;
  }
  return { agreement, n, meanAlpha: sumA / trials, decisionGrade: pass / trials, withDropRule: passDrop / trials };
}

if (require.main === module) {
  const { values: o } = require('node:util').parseArgs({ options: { prevalence: { type: 'string', default: '0.25' }, trials: { type: 'string', default: '200' }, seed: { type: 'string', default: '1' },
    agreement: { type: 'string', default: '0.95,0.90' }, n: { type: 'string', default: '30,60,100,150' } } });
  console.log(`prevalence ${o.prevalence}, ${o.trials} trials, seed ${o.seed}; decision grade = alpha >= 0.800 and bootstrap lower >= 0.667; in brackets: the same with the 5% dropped-draw rule`);
  console.log('raw agreement | mean alpha | ' + o.n.split(',').map((n) => `n=${n}`).join(' | '));
  for (const ag of o.agreement.split(',').map(Number)) {
    const rows = o.n.split(',').map((n) => power({ prevalence: +o.prevalence, agreement: ag, n: +n, trials: +o.trials, seed: +o.seed }));
    console.log(`${ag.toFixed(2)} | ${(rows.reduce((s, x) => s + x.meanAlpha, 0) / rows.length).toFixed(2)} | ${rows.map((x) => `${(100 * x.decisionGrade).toFixed(0)}% (${(100 * x.withDropRule).toFixed(0)}%)`).join(' | ')}`);
  }
}
module.exports = { power };
