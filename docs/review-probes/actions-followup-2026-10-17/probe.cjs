// Deterministic review evidence. Product modules are loaded from an immutable Git tree.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '../../..');
const SHA = process.argv[2] || 'ab2cfc0aafe098d5e47704ebe36df85d687847e5';
const loaded = new Map(), hashes = {};
function fromGit(rel) {
  if (loaded.has(rel)) return loaded.get(rel).exports;
  const body = execFileSync('git', ['show', SHA + ':' + rel], {cwd:ROOT, encoding:'utf8', stdio:['ignore','pipe','pipe']});
  hashes[rel] = crypto.createHash('sha256').update(body).digest('hex');
  if (rel.endsWith('.json')) { const value = JSON.parse(body); loaded.set(rel,{exports:value}); return value; }
  const mod = new Module(path.join(ROOT, rel));
  loaded.set(rel, mod); mod.filename = path.join(ROOT, rel); mod.paths = Module._nodeModulePaths(ROOT);
  mod.require = (id) => {
    if (!id.startsWith('.')) return require(id);
    const stem = path.posix.normalize(path.posix.join(path.posix.dirname(rel), id));
    if (path.posix.extname(stem)) return fromGit(stem);
    for (const candidate of [stem+'.js', stem+'.json', stem+'/index.js']) {
      try { execFileSync('git', ['cat-file', '-e', SHA+':'+candidate], {cwd:ROOT, stdio:'ignore'}); } catch { continue; }
      return fromGit(candidate);
    }
    throw new Error('Missing snapshot dependency: '+id+' from '+rel);
  };
  mod._compile(body, mod.filename); return mod.exports;
}
const weekly = fromGit('eval/weekly-report.js');
const labeling = fromGit('eval/label-export.js');
const results = [];
const fp = 'b'.repeat(16), fp40 = 'b'.repeat(40);
function dataset(sum, outcome = 'open', inline = false) {
  const since = {addressed:0,open:0,dismissed:0,not_observed:0}; since[outcome]=1;
  const counts = {v:1,pr:5,complete:true,outcome_valid:true,since,sum,outcomes:[{fp:inline?fp40:fp,kind:'missing_test',outcome}]};
  return {repo:'o/r',since:'2026-10-01',until:'2026-10-17',baseline:[],threads:[],
    prs:[{number:5,created_at:'2026-10-01T00:00:00Z',user:{login:'dev',type:'User'},labels:[{name:'review-arm:0'}]}],
    issue_comments:[{issue_url:'https://api.github.com/repos/o/r/issues/5',updated_at:'2026-10-17T00:00:00Z',body:'<!-- specguard:summary -->\n<!-- specguard:counts '+JSON.stringify(counts)+' -->'}],
    review_comments:inline?[{id:100,pr:5,path:'b.js',line:4,body:'Missing boundary assertion <!-- specguard:fp='+fp40+' -->',user:{login:'github-actions[bot]',type:'Bot'}}]:[]};
}
const entry = {fp,path:'b.js',line:4,kind:'missing_test',title:'Missing boundary assertion'};
const before = dataset([entry]), pool = weekly.findingsOf(before), labels = new Map([[pool[0].fid,'valid']]);
const initial = weekly.analyze(before,{labels});
assert.equal(initial.joint.with_outcome,1);
const after = weekly.analyze(dataset([],'addressed'),{labels});
assert.equal(after.specguard.findings,1); assert.equal(after.specguard.A,1);
assert.equal(after.channels.summary.findings,0); assert.equal(after.channels.summary.fix_through.findings,1);
assert.equal(after.joint.with_outcome,0); assert.equal(after.labels.unmatched.length,1);
results.push({id:'F1',name:'Resolved summary finding disappears from rebuilt blind-label pool',before:{pool:pool.length,joint:initial.joint},after:{pool:after.channels.summary.findings,outcomes:after.specguard.findings,A:after.specguard.A,joint:after.joint,unmatched:after.labels.unmatched}});
const promoted = weekly.findingsOf(dataset([entry],'open',true));
assert.equal(promoted.length,1); assert.notEqual(promoted[0].fid,pool[0].fid);
const p = weekly.analyze(dataset([entry],'open',true),{labels});
assert.equal(p.labels.unmatched.length,1);
results.push({id:'F2',name:'Summary-to-inline promotion changes blind-label id with the same location and fingerprint prefix',before:{id:pool[0].fid,ref:pool[0].ref},after:{id:promoted[0].fid,ref:promoted[0].ref,unmatched:p.labels.unmatched}});
const retrieval = fromGit('eval/trace-recall/analyze.js');
const cases = {target:{sha:'target-a'},cases:[{id:'x',expect:{code:[{file:'a.js',lines:[2,4]}],tests:['a.test.js'],requirement:{file:'r.md',lines:[8,9]}}}]};
const good = {target:{sha:'target-a'},variants:[{case:'x',variant:'C',status:'ok',trace_ms:10,cand_ms:5,code_to_req:[{candidates:[{path:'r.md',line:8,score:10}]}],test_candidates:'a.js\n  a.test.js  (same stem)\n'}]};
const bad = {target:{sha:'target-a'},variants:[{case:'x',variant:'C',status:'trace failed: timeout',cand_ms:5,test_candidates:good.variants[0].test_candidates}]};
const failed = retrieval.analyze(bad,cases), fmt = retrieval.format(failed);
assert.equal(failed.directions['code->req'].requirement.hit_at_3.rate,0);
assert.equal(failed.runtime_ms.p50,5); assert.doesNotMatch(fmt,/failed|error|timeout/);
const empty = structuredClone(bad); empty.variants[0].status='ok';
assert.deepEqual(retrieval.analyze(empty,cases),failed);
results.push({id:'F3',name:'Failed trace is indistinguishable from successful empty retrieval in analysis output',result:failed,formatted:fmt});
const wrong = structuredClone(good); wrong.target.sha='different-target';
assert.deepEqual(retrieval.analyze(wrong,cases),retrieval.analyze(good,cases));
results.push({id:'F4',name:'Retrieval analysis accepts results for a mismatched target SHA',expected:cases.target.sha,supplied:wrong.target.sha,metric:retrieval.analyze(wrong,cases).directions['code->req'].requirement.hit_at_3});
const {grade,aggregate}=fromGit('eval/grade.js');
const spec={id:'hidden',goal:'test_quality',expected:{findings:[{kind:'missing_test',path:'a.js',line:10,allow_summary:true}]}};
const hidden='## SpecGuard\n<details><summary>Details: low-confidence</summary>\n\n- **Missing test:** Boundary `a.js:10` (low confidence) — Unconfirmed\n</details>';
const obs={comments:[],reviews:[],summary:hidden};
const hiddenGrade=grade(spec,obs);
assert.equal(hiddenGrade.tp,1); assert.equal(hiddenGrade.tp_delivered,0);
const fpGrade=grade({id:'clean',goal:'test_quality',expected:{findings:[],expect_clean:true}},{comments:[{kind:'missing_test',confidence:'high',path:'z.js',line:10,title:'Extra',body:'No evidence'}],reviews:[],summary:'## SpecGuard\nReviewed.'});
assert.equal(fpGrade.fp,1);
const metrics=aggregate([hiddenGrade,fpGrade]);
assert.equal(metrics.precision,0.5); assert.equal(metrics.recall_delivered,0);
results.push({id:'F5',name:'Delivered recall exists but precision still uses raw TP; the exposure sets remain different',raw_tp:metrics.tp,fp:metrics.fp,precision:metrics.precision,recall_delivered:metrics.recall_delivered,delivered_precision_if_added:0});
const visible=grade(spec,{...obs,comments:[{kind:'missing_test',confidence:'high',path:'a.js',line:10,title:'Boundary',body:'Missing'}],summary:'## SpecGuard\nReviewed.'});
const legacyError={id:'legacy-error',goal:'test_quality',error:'provider failed'};
const unknown=aggregate([visible,legacyError]);
const known=aggregate([visible,{...legacyError,expected_findings:1}]);
assert.equal(unknown.recall_delivered_e2e,1); assert.equal(known.recall_delivered_e2e,0.5);
results.push({id:'F6',name:'Legacy error with unknown expected count is treated as zero rather than an unknown E2E denominator',legacy_error:unknown.recall_delivered_e2e,stamped_error:known.recall_delivered_e2e});
const check=fromGit('eval/trace-recall/candidates.js');
assert.throws(()=>check.checkCandidates('x',{status:1,stderr:'failure'}),/step failed/);
assert.doesNotThrow(()=>check.checkCandidates('x',{status:0}));
results.push({id:'C1',name:'Control: candidate-step failures now throw; successful empty output is allowed',verified:true});
const collectSource=execFileSync('git',['show',SHA+':src/collect.sh'],{cwd:ROOT,encoding:'utf8'});
const script=check.extractCandidates(collectSource);
const virtual=new Map(), ctx=path.resolve(ROOT,'virtual-probe-ctx');
virtual.set(path.join(ctx,'files.txt'),'a.js\n'); virtual.set('a.js','function alpha() {}\n');
const virtualFs={
  readFileSync:(p)=>{if(!virtual.has(p))throw new Error('ENOENT');return virtual.get(p);},
  writeFileSync:(p,s)=>virtual.set(p,String(s)),
  appendFileSync:(p,s)=>virtual.set(p,(virtual.get(p)||'')+String(s)),
};
const gitMock=(bin,args)=>{
  if(args[0]==='ls-files')return 'a.js\0a.test.js\0';
  if(args.includes('diff')){const e=new Error('diff timeout'); e.status=124; throw e;}
  return '';
};
require('node:vm').runInNewContext(script,{
  require:(name)=>{const id=name.replace(/^node:/,'');return id==='fs'?virtualFs:id==='path'?path:id==='child_process'?{execFileSync:gitMock}:id.endsWith('test-map.js')?fromGit('src/test-map.js'):id.endsWith('trace.js')?fromGit('src/trace.js'):(()=>{throw new Error(id);})();},
  process:{argv:['node','-',path.join(ROOT,'src/trace.js'),ctx],env:{BASE_SHA:'base',HEAD_SHA:'head'}}, console,
});
const limits=virtual.get(path.join(ctx,'collect-limits.txt'))||'';
assert.equal(limits,''); assert.match(virtual.get(path.join(ctx,'test-candidates.txt')),/a.test.js/);
results.push({id:'F8',name:'Actual candidates heredoc silently discards git diff timeout and produces ordinary candidates without collect-limits',injected_error:'git diff timeout, status 124',limits,candidates:virtual.get(path.join(ctx,'test-candidates.txt'))});
const trace=fromGit('src/trace.js');
const temp=fs.mkdtempSync(path.join(__dirname,'trace-off-'));
try {
  const n=trace.run({ctx:temp,cwd:ROOT,base:'unused',head:'unused',trace:'off'});
  const data=JSON.parse(fs.readFileSync(path.join(temp,'trace-candidates.json'),'utf8'));
  assert.equal(n,0); assert.deepEqual(data.limitations,[]); assert.equal(data.code_to_requirement.length,0);
  results.push({id:'F7',name:'Control: inherited TRACE=off makes trace return valid empty output without limitations; harness inherits that variable',count:n,candidates:data});
} finally {
  // Remove only the files this probe created, then its own empty directory.
  for(const f of fs.readdirSync(temp)) fs.unlinkSync(path.join(temp,f)); fs.rmdirSync(temp);
}
const output={snapshot:SHA,created_at:new Date().toISOString(),method:'Immutable Git modules; deterministic synthetic observations; no model calls or network; product files untouched.',results,loaded_source_hashes:hashes};
fs.writeFileSync(path.resolve(ROOT,process.argv[3] || 'docs/latest-pr-actions-probe-results-2026-10-17.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
