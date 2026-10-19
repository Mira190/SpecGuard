// Corpus 2: apply decision A vs R to downloaded dogfood ctx (A = main rule, R = cutRelevant) -> c2-result.json
const fs=require('fs'),{execFileSync:x}=require('child_process');
const post=require('C:/Files/Projects/SpecGuard-wt-cut/src/post.js'),{parseCandidates}=require('C:/Files/Projects/SpecGuard-wt-cut/src/focus.js');
const tm=require('C:/Files/Projects/SpecGuard-wt-cut/src/test-map.js');
const man=require('./c2-manifest.json'),out=[];
for(const p of man){const d=`c2/pr${p.pr}/`;if(!fs.existsSync(d+'findings.json'))continue;
 const rd=(n)=>{try{return fs.readFileSync(d+n,'utf8')}catch{return ''}};
 const show=(f)=>{try{return x('git',['-C','sg','show',`${p.sha}:${f}`],{maxBuffer:1<<26,stdio:['ignore','pipe','ignore']}).toString().split(/\r?\n/)}catch{return null}};
 const packCut=new Set(rd('pack-cut.txt').split('\n').filter(Boolean).map(l=>l.split('\t')[0]));
 const cands=parseCandidates(rd('test-candidates.txt')),shown=new Map(rd('pack-shown.txt').split('\n').filter(Boolean).map(l=>l.split('\t'))),dm=post.parseDiff(rd('diff.patch'));
 const past=(f)=>!shown.has(f)||[...(dm.get(f)?.changed.RIGHT.keys()||[])].some(n=>n>+shown.get(f));
 const gated=/candidate test file was only partly visible/.test(rd('summary.md'));
 const files=rd('files.txt').split('\n').filter(Boolean);
 const lostA=[...new Set(files.flatMap(f=>[...(packCut.has(f)&&past(f)?[f]:[]),...(cands.get(f)||[]).filter(c=>packCut.has(c))]))];
 const lostR=[...new Set(files.flatMap(f=>[...(packCut.has(f)&&past(f)?[f]:[]),...(cands.get(f)||[]).filter(c=>packCut.has(c)&&(gated||post.cutRelevant(f,c,dm,show)))]))];
 const sumCut=/Review context was cut/.test(rd('summary.md'));
 out.push({pr:p.pr,run:p.run,sha:p.sha,sumCut,lostA,lostR,gated,flip:lostA.length>0&&lostR.length===0,
  detail:lostA.length&&!lostR.length?files.flatMap(f=>(cands.get(f)||[]).filter(c=>packCut.has(c)).map(c=>({f,c,names:[...(dm.get(f)?.changed.RIGHT.keys()||[])].map(n=>[n,tm.enclosingName(show(f)||[],n)]),shown:shown.get(c)}))):undefined});}
fs.writeFileSync('c2-result.json',JSON.stringify(out,null,1));
const k=(f)=>out.filter(f).length;
console.log('PRs',out.length,'A incomplete(cut)',k(o=>o.lostA.length),'R incomplete(cut)',k(o=>o.lostR.length),'flips',k(o=>o.flip),'summary-cut',k(o=>o.sumCut),'A-vs-summary mismatches',k(o=>o.sumCut!==o.lostA.length>0));
