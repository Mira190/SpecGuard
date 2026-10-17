const {ROOT,SHA,fromGit,hashes,overrides}=require('./loader.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
let blobs=new Map(),files=[];
function noMatch(){const e=Error('synthetic no match');e.status=1;throw e;}
const gitRead=(bin,args,opts={})=>{if(bin!=='git')throw Error('Unexpected '+bin);
 if(args.includes('cat-file'))return Buffer.concat(String(opts.input).trim().split('\n').map(sha=>{const b=blobs.get(sha);return b?Buffer.concat([Buffer.from(sha+' blob '+b.length+'\n'),b,Buffer.from('\n')]):Buffer.from(sha+' missing\n');}));
 if(args.includes('ls-files'))return args.includes('-z')?files.map(x=>x.path).join('\0')+'\0':files.map(x=>x.path).join('\n');
 if(args.includes('--is-shallow-repository'))return 'false\n';if(args.includes('log'))return '';
 if(args.includes('rev-parse'))return SHA+'\n';return noMatch();
};
overrides['child_process']=overrides['node:child_process']={execFileSync:gitRead};
const audit=fromGit('src/audit-post.js'),units=fromGit('src/audit-units.js'),grade=fromGit('eval/grade.js'),results=[];
function boundary(v){
 const src='const LOWER_LIMIT = '+v+';\nexport function tooLow(value) {\n  return value < LOWER_LIMIT;\n}\n';
 const test='import { tooLow } from "../src/range.js";\nit("pins equality", () => {\n  assert.equal(tooLow('+v+'), false);\n});\n';
 blobs=new Map();files=Object.entries({'src/range.js':src,'test/range.test.js':test}).map(([p,s])=>{const b=Buffer.from(s),sha=crypto.createHash('sha1').update(b).digest('hex');blobs.set(sha,b);return {path:p,sha,size:b.length};});
 const r=units.inventory({cwd:ROOT,head:SHA,files,now:Date.now(),budgetMs:40000,maxUnits:12});
 return r.rows.find(x=>x.path==='src/range.js').boundary;
}
const positive=boundary(10),negative=boundary(-10);
assert.equal(positive.length,0);assert.equal(negative.length,1);
results.push({id:'U2',name:'Negative numeric boundary explicitly present in an assertion still yields boundary_unpinned',positive_control:positive,negative});
const legacy=grade.aggregate([{id:'old',goal:'test',tp:1,fp:1,fn:0,summary_only:0}]);assert.equal(legacy.recall_delivered,null);assert.equal(legacy.precision_delivered,0);
results.push({id:'U3',name:'Legacy rows have unknown delivered TP but precision_delivered is 0 instead of null',precision_delivered:legacy.precision_delivered,recall_delivered:legacy.recall_delivered});
async function citation(failed){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'specguard-new-review-')),ctx=path.join(root,'ctx');fs.mkdirSync(ctx);fs.mkdirSync(path.join(root,'src'));
 const text=['function criticalBoundary(value) {','  if (value > 10) return value;','  throw new Error("missing boundary branch");','}'].join('\n')+'\n';fs.writeFileSync(path.join(root,'src/unit.js'),text);files=[{path:'src/unit.js'}];
 const put=(n,x)=>fs.writeFileSync(path.join(ctx,n),typeof x==='string'?x:JSON.stringify(x));
 put('audit-meta.json',{head:SHA,docs:0,max_units:12,units:{total:1,picked:1},limitations:[]});
 put('audit-docs.txt','');put('audit-candidates.txt','');put('engine-status','success');put('pack-cut.txt','');
 put('audit-units.txt',[1,2].map(k=>['aaaaaaaa','src/unit.js',5,'why','none','-','abcdef12','part '+k+'/2 lines '+(k*2-1)+'-'+k*2].join('\t')+'\n').join(''));
 put('audit-inventory.json',{eligible:1,units:1,selected:{units:1},forced:[],rotation:{picked:1,reviewed:1,total:1},all_parts:true,parts_left:[],parts_left_n:0,parts_left_by_path:{},rows:[],unreviewed:[]});
 put('scan-parts.json',failed?{calls:2,failed:[{part:'units',units:['aaaaaaaa'],keys:['aaaaaaaa:2'],reason:'timeout'}],dropped:[]}:{calls:1,failed:[],dropped:[],droppedParts:['aaaaaaaa:2']});
 put('findings.json',{docs_reviewed:[],requirements:[],not_requirements:[],not_reviewed:[],unit_findings:[{unit:'aaaaaaaa',kind:'missing_test',path:'src/unit.js',line:3,quote:'throw new Error("missing boundary branch");',title:'Boundary case lacks a test',body:'Exercise the rejection boundary.',skeleton:'test("boundary", () => { assert.throws(() => criticalBoundary(0)); });'}]});
 const keys=['CTX','GITHUB_WORKSPACE','SCAN_ISSUE','AUDIT_ISSUE','SKIP','ENGINE','TEST_PATHS'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));Object.assign(process.env,{CTX:ctx,GITHUB_WORKSPACE:root,SCAN_ISSUE:'false',AUDIT_ISSUE:'false',SKIP:'false',ENGINE:'',TEST_PATHS:''});
 let summary='';const outputs={},core={setOutput:(k,v)=>outputs[k]=v,warning:()=>{},summary:{addRaw(s){summary=s;return this;},async write(){}}};
 try{await audit({github:{rest:{}},context:{repo:{owner:'o',repo:'r'},sha:SHA},core});const data=JSON.parse(fs.readFileSync(path.join(ctx,'audit.json'),'utf8'));assert.equal(data.unit_findings.length,1);assert.equal(data.unit_findings[0].low,false);assert.match(summary,/part 1 of 2/);
 return {unexecuted_part:failed?'failed':'dropped',retained:data.unit_findings.length,low:data.unit_findings[0].low,status:outputs.status,citation_line:data.unit_findings[0].line,reviewed:summary.split('\n').find(x=>x.startsWith('**Reviewed in parts**'))};
 }finally{for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];const p=fs.realpathSync(root);assert.equal(path.dirname(p),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(p).startsWith('specguard-new-review-'));fs.rmSync(p,{recursive:true,force:true});}
}
(async()=>{results.unshift({id:'U1',name:'A quote in an unexecuted part is accepted as a non-low finding',dropped:await citation(false),failed:await citation(true)});
 const label=fromGit('eval/label-export.js'),base={tool:'specguard',repo:'o/r',pr:1,path:'a.js',line:1,ref:'b'.repeat(16)};
 assert.equal(label.findingId(base),label.findingId({...base,path:'moved.js',line:50,ref:'b'.repeat(40)}));
 const cap=fromGit('src/pack-cap.js');assert.throws(()=>cap.packLimit({CONTEXT_PACK_BYTES:'x'}),/integer/);assert.equal(cap.packLimit({}),250000);
 const e2e=grade.aggregate([{id:'ok',goal:'test',tp:1,fp:0,fn:0,tp_delivered:1,fn_delivered:0,summary_only:0},{id:'old-error',goal:'test',error:'failed'}]);assert.equal(e2e.recall_delivered_e2e,null);
 const controls=['SpecGuard identity stable across channel and location changes','Invalid pack config rejected; default retained','Unknown expected count in old error gives null end-to-end recall'];
 const out={snapshot:SHA,created_at:new Date().toISOString(),method:'Immutable Git modules, synthetic file fixtures and controlled Git reads; no provider/network/GitHub writes.',results,controls,source_hashes:hashes};
 fs.writeFileSync(path.join(ROOT,'docs/unknown-unknown-incremental-probes-2026-10-17.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});

