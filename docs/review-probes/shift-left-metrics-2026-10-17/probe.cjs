// Read-only probes of functions loaded from one immutable Git commit. No model/network calls.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../../..');
const SHA = 'cb235b11f4234570f6506d0a278d786554b287d3';
const loaded = new Map(), hashes = {};
function fromGit(rel) {
  if (loaded.has(rel)) return loaded.get(rel).exports;
  const body = execFileSync('git', ['show', SHA + ':' + rel], {cwd:ROOT, encoding:'utf8', stdio:['ignore','pipe','pipe']});
  hashes[rel] = crypto.createHash('sha256').update(body).digest('hex');
  if (rel.endsWith('.json')) { const value = JSON.parse(body); loaded.set(rel,{exports:value}); return value; }
  const mod = new Module(path.join(ROOT, rel));
  loaded.set(rel, mod);
  mod.filename = path.join(ROOT, rel);
  mod.paths = Module._nodeModulePaths(ROOT);
  mod.require = (id) => {
    if (!id.startsWith('.')) return require(id);
    const stem = path.posix.normalize(path.posix.join(path.posix.dirname(rel), id));
    if (path.posix.extname(stem)) return fromGit(stem);
    let selected;
    for (const candidate of [stem+'.js', stem+'.json', stem+'/index.js']) {
      try { execFileSync('git', ['cat-file', '-e', SHA+':'+candidate], {cwd:ROOT, stdio:'ignore'}); selected=candidate; break; } catch {}
    }
    if (!selected) throw new Error('Missing snapshot dependency: '+id+' from '+rel);
    return fromGit(selected);
  };
  mod._compile(body, mod.filename);
  return mod.exports;
}
const {grade, aggregate} = fromGit('eval/grade.js');
const expected = (extras={}) => ({kind:'missing_test',path:'a.js',line:10,...extras});
const spec = (finding=expected(), extras={}) => ({id:'probe',goal:'test_quality',expected:{findings:finding?[finding]:[],...extras}});
const observed = (comments=[], summary='## SpecGuard\nReviewed.') => ({comments,reviews:[],summary,latency_s:1});
const finding = (extras={}) => ({kind:'missing_test',confidence:'high',path:'a.js',line:10,title:'Boundary',body:'Expected boundary assertion',...extras});
const pick = r => ({tp:r.tp,fp:r.fp,fn:r.fn,pass:r.pass,text_misses:r.text_misses.length,clean_ok:r.clean_ok});
const results=[];
const hidden='## SpecGuard\n<details><summary>Details: low-confidence</summary>\n\n- ❌ **Missing test:** Boundary \`a.js:10\` (low confidence) — Unconfirmed\n</details>';
const a=grade(spec(expected({allow_summary:true})),observed([],hidden));
const b=grade(spec(null,{expect_clean:true}),observed([],hidden));
assert.equal(a.tp,1); assert.equal(b.fp,0);
results.push({id:'M1',name:'allow_summary credits a low-confidence item inside Details; the same item costs no FP on a clean case',positive:pick(a),negative:pick(b)});
const text=grade(spec(expected({text:'exact-now'})), observed([finding({body:'Different behaviour, no required explanation'})]));
assert.equal(text.tp,1);assert.equal(text.text_misses.length,1);assert.equal(text.pass,false);
results.push({id:'M2',name:'Semantic text failure remains a positional TP by the documented contract',result:pick(text)});
const extra=grade(spec(),observed([finding(),finding({path:'other.js',line:30})]));
assert.equal(extra.fp,1);assert.equal(extra.pass,true);
results.push({id:'M3',name:'Documented pass contract permits FP in positive cases',result:pick(extra),aggregate:aggregate([extra])});
const success=grade(spec(),observed([finding()]));
const conditional=aggregate([success,{id:'failed-positive',goal:'test_quality',error:'provider failed',expected_seed_count:1}]);
assert.equal(conditional.recall,1);assert.equal(conditional.errors,1);
results.push({id:'M4',name:'Infrastructure failures excluded from metric denominator; one delivered of two intended positives still reports conditional recall 1',aggregate:conditional});
const weekly=fromGit('eval/weekly-report.js');
const post=fromGit('src/post.js');
const loc={path:'a.js',line:10,quote:'return boundary(value);'};
const data={requirements:[],requirements_source:'none',not_reviewed:'',coverage:[{id:'O1',obligation:'Boundary A',source:'from behaviour',behaviour:loc,change:loc,evidence:[],status:'missing_test',reason:'No test',alignment:{status:'not_applicable',reason:'No explicit requirement'}}],findings:[],standards:{status:'no_rules',sources:[],reason:'None'},layering:{status:'checked',reason:'None'}};
const low={kind:'missing_test',path:'a.js',line:10,title:'Boundary A',body:'Missing assertion',confidence:'low',obligation_ids:['O1']};
const built=post.buildSummary({cov:{reports:0},data:{...data,findings:[low]},items:[{f:low,why:'low confidence'}],notes:[],blob:'https://github.com/example/repo/blob/abc/'});
const renderedPositive=grade(spec(expected({allow_summary:true})),observed([],built));
const renderedClean=grade(spec(null,{expect_clean:true}),observed([],built));
assert.equal(renderedPositive.tp,1);assert.equal(renderedClean.fp,0);
results.push({id:'M1b',name:'Same asymmetry using the actual product summary renderer and coverage row',positive:pick(renderedPositive),negative:pick(renderedClean),summary:built});
const counts={v:1,pr:1,head:'abc',outcome_valid:true,complete:false,since:{addressed:1,open:0,dismissed:0,not_observed:0},sum:[{fp:'0123456789abcdef',path:'a.js',line:10,kind:'missing_test'}]};
const ds={repo:'example/repo',since:'2026-10-01',until:'2026-10-17',prs:[{number:1,user:{login:'author',type:'User'},created_at:'2026-10-01',labels:[{name:'review-arm:0'}]}],baseline:[],review_comments:[],issue_comments:[{issue_url:'https://api.github.com/repos/example/repo/issues/1',body:'<!-- specguard:summary -->\n<!-- specguard:counts '+JSON.stringify(counts)+' -->\n### Missing unit tests (1)\n- Boundary \`a.js:10\` — add assertion',updated_at:'2026-10-17T00:00:00Z'}],threads:[]};
const wf=weekly.findingsOf(ds), analysis=weekly.analyze(ds);
assert.equal(wf.length,0);assert.equal(analysis.specguard.findings,1);
results.push({id:'M5',name:'Summary-only finding has valid fix-through counts but is absent from the blind-label candidate list',label_candidates:wf.length,fix_through_findings:analysis.specguard.findings,fix_through_A:analysis.specguard.A});
const audit=fromGit('src/audit-post.js');
const production=['function computeThreshold(value) {','  return value < 128;','}'];
const f={unit:'aaaaaaaa',kind:'missing_test',path:'src/threshold.js',line:2,quote:production[1].trim(),title:'No boundary assertion',body:'No test exists in this synthetic fixture',skeleton:"test('boundary', () => { assert.equal(computeThreshold(127), true); });"};
const units=new Map([['aaaaaaaa',{id:'aaaaaaaa',path:f.path,tests:[]}]]);
const input={requirements:[],not_requirements:[],not_reviewed:[],unit_findings:[f]};
const run=(tracked)=>audit.verify(input,{read:p=>p===f.path?production:null,tracked,units});
const control=run(new Set([f.path])), baseline=run(new Set([f.path,...Array.from({length:200},(_,i)=>'testdata/baselines/unrelated/b'+i+'.txt')]));
assert.equal(control.unit_findings[0].low,false);assert.equal(baseline.unit_findings[0].low,true);
results.push({id:'M6',name:'200 unrelated baseline paths demote an otherwise identical missing-test finding; an intentional conservative gate, not evidence of actual coverage',control:control.unit_findings[0].low,with_baselines:baseline.unit_findings[0].low,reason:baseline.unit_findings[0].lowWhy});
const trace=fromGit('src/trace.js');
if (typeof trace.sizeVariants==='function') results.push({id:'M7',name:'Known follow-up: comma-separated size literal retrieval',plain:trace.sizeVariants('1048576 bytes'),formatted:trace.sizeVariants('1,048,576 bytes')});
const report={snapshot:SHA,created_at:new Date().toISOString(),method:'Immutable Git source loaded by CommonJS; deterministic synthetic observations; no external repository execution.',results,loaded_source_hashes:hashes};
fs.writeFileSync(path.join(ROOT,'docs/shift-left-metrics-probe-results-2026-10-17.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));

