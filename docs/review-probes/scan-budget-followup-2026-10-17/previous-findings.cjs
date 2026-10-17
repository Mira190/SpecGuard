const {ROOT,SHA,fromGit}=require('./loader.cjs');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const w=fromGit('eval/weekly-report.js'),fp='b'.repeat(16),full='b'.repeat(40);
function ds(sum,inline=false,addressed=false){return {repo:'o/r',since:'2026-10-01',until:'2026-10-17',baseline:[],threads:[],prs:[{number:5,created_at:'2026-10-01',user:{login:'dev',type:'User'},labels:[{name:'review-arm:0'}]}],review_comments:inline?[{id:1,pr:5,path:'b.js',line:4,body:'Boundary <!-- specguard:fp='+full+' -->'}]:[],issue_comments:[{issue_url:'https://api.github.com/repos/o/r/issues/5',body:'<!-- specguard:summary -->\n<!-- specguard:counts '+JSON.stringify({pr:5,complete:true,outcome_valid:true,since:{addressed:addressed?1:0,open:addressed?0:1,dismissed:0,not_observed:0},sum,outcomes:[{fp:inline?full:fp,outcome:addressed?'addressed':'open'}]})+' -->'}]};}
const e={fp,path:'b.js',line:4,kind:'missing_test',title:'Boundary'},before=w.findingsOf(ds([e])),labels=new Map([[before[0].fid,'valid']]);
const resolved=w.analyze(ds([],false,true),{labels});assert.equal(resolved.specguard.A,1);assert.equal(resolved.joint.with_outcome,0);assert.equal(resolved.labels.unmatched.length,1);
const promoted=w.findingsOf(ds([e],true));assert.notEqual(before[0].fid,promoted[0].fid);
const result={snapshot:SHA,created_at:new Date().toISOString(),F1:{before_pool:before.length,after_pool:resolved.channels.summary.findings,A:resolved.specguard.A,unmatched:resolved.labels.unmatched.length},F2:{summary:before[0].fid,inline:promoted[0].fid}};
fs.writeFileSync(path.join(ROOT,'docs/scan-budget-followup-previous-findings-2026-10-17.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
