// blind audit packets per arm
const fs=require('fs');const {cases}=require('./an.js');
const mulberry=(a)=>()=>{a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};
const shuffle=(arr,rnd)=>{const a=arr.slice();for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
const diffOf=(c,f)=>{const t=fs.readFileSync(c.d+'diff.patch','utf8');const ch=t.split(/^diff --git /m).slice(1).find(s=>s.split('\n')[0].includes(' b/'+f))||'';return ('diff --git '+ch).split('\n')};
const CAP_LINES=1500,names=[];
for(const k of ['R','S']){
 const rnd=mulberry(20261019);
 const key=(c,u)=>[c.corpus,c.pr,u.f,u.t].join('|');
 const flipCases=cases.filter(c=>c.A.onlyCut&&c.arms[k].st!=='incomplete');
 const flips=new Map();
 for(const c of flipCases)for(const u of c.cuts){const kk=key(c,u);if(!flips.has(kk))flips.set(kk,{c,u,runs:[],clean:false});const e=flips.get(kk);e.runs.push(c.corpus+':'+c.run);if(c.arms[k].clean&&!c.A.clean)e.clean=true}
 let fl=[...flips.values()];const must=fl.filter(e=>e.clean),rest=fl.filter(e=>!e.clean);
 const room=Math.max(0,120-must.length);const picked=[...must,...(rest.length>room?shuffle(rest,rnd).slice(0,room):rest)];
 const ctrlPool=new Map();for(const c of cases)for(const u of c.cuts)if(u[k]){const kk=key(c,u);if(!flips.has(kk)&&!ctrlPool.has(kk))ctrlPool.set(kk,{c,u})}
 const ctrl=shuffle([...ctrlPool.values()],rnd).slice(0,picked.length);
 const items=shuffle([...picked.map(e=>({...e,label:'flip'})),...ctrl.map(e=>({...e,label:'control'}))],rnd);
 const keyOut=[],md=[`# Audit packets (${items.length} items)\n\nFor each item answer: does the UNSEEN part of the cut test directly test a changed or deleted definition of the changed file? (yes / no, one-line reason.) The unseen part is what the reviewing model never saw.\n`];
 items.forEach((it,i)=>{const id=`P${String(i+1).padStart(3,'0')}`,{c,u}=it;
  const body=c.read(u.t)||[],un=body.slice(u.shownN),cut=un.length>CAP_LINES;
  md.push(`\n---\n\n## ${id}\n\nChanged file: \`${u.f}\`\n\n### Diff of the changed file\n\n\`\`\`diff\n${diffOf(c,u.f).slice(0,600).join('\n')}\n\`\`\`\n\n### Unseen part of the test file (${u.t === '' ? '' : 'lines '+(u.shownN+1)+' to '+body.length}${cut?`; first ${CAP_LINES} of ${un.length} unseen lines shown`:''})\n\n\`\`\`\n${un.slice(0,CAP_LINES).join('\n')}\n\`\`\`\n`);
  keyOut.push({id,label:it.label,verdictBecameClean:!!it.clean,corpus:c.corpus,pr:c.pr,runs:it.runs||[c.run],changed_file:u.f,cut_test:u.t,reason:u.reason,shown_lines:u.shownN,names_checked:c['names_'+u.f]||null,arm_counts_it:!!u[k]});
 });
 fs.writeFileSync(`audit/packets-${k}.md`,md.join('\n'));fs.writeFileSync(`audit/key-${k}.json`,JSON.stringify(keyOut,null,1));
 console.log(k,'flip items',flips.size,'(clean',must.length+')','packets',items.length);
 // flips by checked enclosing name, and relevant cuts by name
 const cnt=new Map();for(const e of flips.values())for(const n of (e.c["names_"+e.u.f]||[]).filter(Boolean))cnt.set(n,(cnt.get(n)||0)+1);
 const top=[...cnt].sort((a,b)=>b[1]-a[1]).slice(0,10),len={};for(const [n] of cnt){const b=n.length<=4?'<=4':n.length<=8?'5-8':n.length<=14?'9-14':'15+';len[b]=(len[b]||0)+1}
 names.push({arm:k,flipNamesTop10:top,flipNameLengthDistribution:len});
}
fs.writeFileSync('an-names.json',JSON.stringify(names,null,1));console.log(JSON.stringify(names));
