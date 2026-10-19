// Cut relevance analysis, both corpora. Usage: node an.js  -> an-result.json + audit/packets-{R,S}.md + audit/key-{R,S}.json
const fs=require('fs'),path=require('path'),{execFileSync:x}=require('child_process');
const W='C:/Files/Projects/SpecGuard-wt-cut/src/';
const post=require(W+'post.js'),{parseCandidates}=require(W+'focus.js'),tm=require(W+'test-map.js');
const rd=(p)=>{try{return fs.readFileSync(p,'utf8')}catch{return null}};
const OTHER=[/Diff over `max_diff_kb`/,/The diff exceeded/,/Large PR: focused review/,/Candidate tests were not looked up/,/Requirement tracing was not done/,/Requirement collection (?:did not cover|status was unavailable)/,/Delivery degraded/,/review engine/];
const status=(s)=>(/specguard:status=(\w+)/.exec(s)||[])[1]||'';
const headline=(s)=>{const m=/\n(\*\*[^\n]+\*\*)/.exec(s.replace(/<!--[\s\S]*?-->/g,''));return m?m[1]:''};
const isClean=(h)=>/^\*\*✅/.test(h);
const inc=(s)=>/"execution_complete":false/.test(s)?'incomplete':'complete'; // incomplete[] non-empty (the cut and the other collector reasons); status=incomplete also covers model-level degrade
const {parseSummary}=require('C:/Files/Projects/SpecGuard-wt-cut/eval/grade.js');
const onlyCutOf=(sum)=>inc(sum)==='incomplete'&&/Review context was cut/.test(sum)&&!OTHER.some(re=>re.test(sum.split('<details>')[0]));
const gitShow=(dir,sha)=>{const c=new Map();return (f)=>{if(!c.has(f)){let v=null;try{v=x('git',['-C',dir,'show',`${sha}:${f}`],{maxBuffer:1<<27,stdio:['ignore','pipe','ignore']}).toString().split(/\r?\n/)}catch{}c.set(f,v)}return c.get(f)}};
const cases=[];
// ---- corpus 1
for(const r of fs.readdirSync('out').filter(d=>/^r\d+$/.test(d))){const run=r.slice(1);
 for(const id of fs.readdirSync(`out/${r}/run0-A`)){
  const dirs={A:`out/${r}/run0-A/${id}/`,R:`out/${r}/run0-R/${id}/`,S:`out/${r}/run0-S/${id}/`};if(!rd(dirs.S+'summary.md'))continue;
  const sum={},post_={};for(const k in dirs){sum[k]=rd(dirs[k]+'summary.md');post_[k]=JSON.parse(rd(dirs[k]+'posted.json')||'{"comments":[]}')}
  const pub=rd(`holdout2-raw/${run}/replay-${id}/summary.md`)||'';
  const meta=JSON.parse(rd(`out/${r}/_prep/${id}/meta.json`)),res=JSON.parse(rd(`holdout2-raw/${run}/replay-${id}/result.json`));
  const d=dirs.A+'ctx/',cr=(f)=>rd(d+f)||'';
  const read=gitShow(path.join('repos',path.basename(res.repo)),meta.head);
  const payload=(k)=>{const m=/<!-- specguard:counts (\{.*\}) -->/.exec(sum[k]);const c=m?JSON.parse(m[1]):{};return JSON.stringify([post_[k].comments,c.findings,c.sum,c.posted,parseSummary(sum[k]).items])};
  const body=(k)=>sum[k].split('<details>')[0].replace(/<!--[\s\S]*?-->/g,'').replace(/^.*Review context was cut.*\n/gm,'');
  cases.push({corpus:1,pr:id,run,repo:res.repo,head:meta.head,read,d,
   faithful:status(pub)===status(sum.A)&&headline(pub)===headline(sum.A)&&(+((/"inline":(\d+)/.exec(pub)||[])[1]??-1))===post_.A.comments.length,
   A:{st:inc(sum.A),onlyCut:onlyCutOf(sum.A),clean:isClean(headline(sum.A))},
   arms:Object.fromEntries(['R','S'].map(k=>[k,{st:inc(sum[k]),clean:isClean(headline(sum[k])),gatedNote:/candidate test file was only partly visible/.test(sum[k]),same:payload('A')===payload(k),headSame:true}]))});
 }}
// ---- corpus 2
const man=require('./c2-manifest.json');
for(const p of man){const d=`c2/pr${p.pr}/`;if(!rd(d+'findings.json'))continue;
 const sumA=rd(d+'summary.md')||'';
 cases.push({corpus:2,pr:'pr'+p.pr,run:p.run,repo:'Mira190/SpecGuard',head:p.sha,read:gitShow('sg',p.sha),d,A:{st:inc(sumA),onlyCut:onlyCutOf(sumA),clean:isClean(headline(sumA))},sumA});}
// ---- candidate level
const names=[];
for(const c of cases){
 const cr=(f)=>rd(c.d+f)||'';
 const packCut=new Set(cr('pack-cut.txt').split('\n').filter(Boolean).map(l=>l.split('\t')[0])),ctext=cr('test-candidates.txt'),cands=parseCandidates(ctext),why=post.candReasons(ctext);
 const shown=new Map(cr('pack-shown.txt').split('\n').filter(Boolean).map(l=>l.split('\t'))),dm=post.parseDiff(cr('diff.patch')),files=cr('files.txt').split('\n').filter(Boolean);
 const past=(f)=>!shown.has(f)||[...(dm.get(f)?.changed.RIGHT.keys()||[])].some(n=>n>+shown.get(f));
 const gated=c.corpus===1?c.arms.R.gatedNote:/candidate test file was only partly visible/.test(c.sumA);
 const memo=new Map();
 c.changedLost=files.filter(f=>packCut.has(f)&&past(f));
 c.cuts=files.flatMap(f=>(cands.get(f)||[]).filter(t=>packCut.has(t)).map(t=>({f,t,reason:why.get(f+'\0'+t)||'',shownN:shown.has(t)?+shown.get(t):0,
   R:gated||post.cutRelevant(f,t,dm,c.read,memo),S:gated||post.STRONG.test(why.get(f+'\0'+t)||'')})));
 c.gated=gated;c.dm=dm;
 for(const f of new Set(c.cuts.map(u=>u.f))){const m=dm.get(f),src=c.read(f);if(m&&src)c['names_'+f]=[...new Set([...m.changed.RIGHT.keys()].map(n=>tm.enclosingName(src,n)))]}
 for(const k of ['R','S']){const lost=c.changedLost.length+c.cuts.filter(u=>u[k]).length;
  if(c.corpus===2)c.arms={...(c.arms||{}),[k]:{st:c.A.onlyCut?(lost?'incomplete':'complete'):c.A.st,clean:false,gatedNote:gated,same:true}};
  // consistency of the offline decision with the full post.js result (corpus 1)
  if(c.corpus===1&&c.A.onlyCut)c.arms[k].offlineOk=(lost===0)===(c.arms[k].st!=='incomplete');}
}
const out={};const C1=cases.filter(c=>c.corpus===1),C2=cases.filter(c=>c.corpus===2);
const rate=(a,b)=>`${a}/${b}`;
for(const [nm,set] of [['corpus1',C1],['corpus2',C2]]){
 const o={runs:set.length,faithful:nm==='corpus1'?rate(set.filter(c=>c.faithful).length,set.length):'n/a',incompleteA:rate(set.filter(c=>c.A.st==='incomplete').length,set.length),onlyCutRuns:set.filter(c=>c.A.onlyCut).length};
 for(const k of ['R','S']){
  const flipRuns=set.filter(c=>c.A.onlyCut&&c.arms[k].st!=='incomplete');
  const byPr=new Map();for(const c of set.filter(c=>c.A.onlyCut)){if(!byPr.has(c.pr))byPr.set(c.pr,[]);byPr.get(c.pr).push(c)}
  const flipPrs=[...byPr].filter(([,cs])=>cs.every(c=>c.arms[k].st!=='incomplete'));
  o[k]={incompleteArm:rate(set.filter(c=>c.arms[k].st==='incomplete').length,set.length),
   flipRuns:rate(flipRuns.length,set.filter(c=>c.A.onlyCut).length),flipPRs:rate(flipPrs.length,byPr.size),
   gate1_identical:nm==='corpus1'?rate(set.filter(c=>c.arms[k].same).length,set.length):'by construction (status only)',
   gate2_cleanWithGated:rate(set.filter(c=>c.arms[k].clean&&c.arms[k].gatedNote).length,set.length),
   becameClean:rate(set.filter(c=>c.arms[k].clean&&!c.A.clean).length,set.length),
   offlineMismatch:nm==='corpus1'?set.filter(c=>c.arms[k].offlineOk===false).length:'n/a'};
 }
 out[nm]=o;}
fs.writeFileSync('an-result.json',JSON.stringify(out,null,1));console.log(JSON.stringify(out,null,1));
module.exports={cases};
