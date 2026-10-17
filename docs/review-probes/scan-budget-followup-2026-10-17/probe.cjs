const {ROOT,SHA,fromGit,hashes,overrides}=require('./loader.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const gitRead=(bin,args)=>{if(bin!=='git')throw Error('Unexpected '+bin);
 if(args.includes('ls-files'))return args.includes('-z')?'src/unit.js\0':'src/unit.js\n';
 if(args.includes('rev-parse'))return SHA+'\n';
 const e=Error('synthetic no match');e.status=1;throw e;
};
overrides['node:child_process']=overrides['child_process']={execFileSync:gitRead};
const audit=fromGit('src/audit-post.js'),api=fromGit('src/engines/claude-api.js'),id='aaaaaaaa',results=[];
async function fixture({rows=1,left=true,dropped=false,failed=false,engine=false}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'specguard-scan-review-')),ctx=path.join(root,'ctx');fs.mkdirSync(ctx);
 const write=(name,text)=>{const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof text==='string'?text:JSON.stringify(text));};
 const put=(n,v)=>write('ctx/'+n,v);
 write('src/unit.js','function criticalBoundary(value) {\n return value > 10;\n}\nmodule.exports = {criticalBoundary};\n');
 put('audit-meta.json',{head:SHA,docs:0,max_units:12,units:{total:1,picked:1},limitations:left?['1 unit part not reached (budget): src/unit.js part 2 of 2']:[]});
 put('audit-units.txt',Array.from({length:rows},(_,k)=>[id,'src/unit.js',5,'why','none','-','abcdef12','part '+(k+1)+'/2 lines '+(k*2+1)+'-'+(k*2+2)].join('\t')+'\n').join(''));
 put('audit-inventory.json',{eligible:1,units:1,with_tests:0,without_tests:1,not_inventoried:0,selected:{units:1},forced:[],rotation:{picked:1,reviewed:1,total:1},all_parts:true,parts_left:left?[{path:'src/unit.js',part:2,of:2}]:[],rows:[],unreviewed:[]});
 put('audit-docs.txt','');put('audit-candidates.txt','');put('engine-status','success');
 const found={docs_reviewed:[],requirements:[],not_requirements:[],unit_findings:[],not_reviewed:[]};put('findings.json',found);
 if(dropped)put('scan-parts.json',{calls:1,failed:[],dropped:[],droppedParts:[id+':2']});
 if(failed)put('scan-parts.json',{calls:2,failed:[{part:'units',units:[id],reason:'second part timeout'}],dropped:[]});
 const keys=['CTX','GITHUB_WORKSPACE','SCAN_ISSUE','AUDIT_ISSUE','SKIP','ENGINE','HEAD_SHA','TEST_PATHS'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{CTX:ctx,GITHUB_WORKSPACE:root,SCAN_ISSUE:'false',AUDIT_ISSUE:'false',SKIP:'false',HEAD_SHA:SHA,TEST_PATHS:''});delete process.env.ENGINE;
 const outputs={},warnings=[];let summary='',request='';
 const core={setOutput:(k,v)=>outputs[k]=v,warning:m=>warnings.push(m),summary:{addRaw(s){summary=s;return this;},async write(){}}};
 try{
 if(engine)await api.run({CHECK:'audit',CTX:ctx,GITHUB_WORKSPACE:root,PROMPT:'Review the unit described by metadata; never invent unseen code.',ANTHROPIC_API_KEY:'sk-ant-synthetic-review',MODEL:'claude-haiku-5-5',CONTEXT_PACK_BYTES:'0',MAX_BUDGET_USD:'1',MAX_OUTPUT_TOKENS:'4000'},{fetchFn:async(_url,opts)=>{request=JSON.stringify(JSON.parse(opts.body).messages);return {ok:true,status:200,text:async()=>JSON.stringify({id:'synthetic',model:'claude-haiku-5-5',stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(found)}],usage:{input_tokens:100,output_tokens:100}})};},sleep:async()=>{}});
 await audit({github:{rest:{}},context:{repo:{owner:'o',repo:'r'},sha:SHA},core});
 return {outputs,warnings,summary,request,engine_status:fs.readFileSync(path.join(ctx,'engine-status'),'utf8').trim(),pack_cut_exists:fs.existsSync(path.join(ctx,'pack-cut.txt'))};
 }finally{for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];
 const p=fs.realpathSync(root),t=fs.realpathSync(os.tmpdir());assert.equal(path.dirname(p),t);assert.ok(path.basename(p).startsWith('specguard-scan-review-'));fs.rmSync(p,{recursive:true,force:true});}
}
(async()=>{
 const one=await fixture();assert.equal(one.outputs.status,'complete');assert.match(one.summary,/part 2 not reached \(budget\)/);
 results.push({id:'N1',name:'Collector-deferred part is disclosed but status is complete',status:one.outputs.status,lines:one.summary.split('\n').filter(x=>/Reviewed in parts|not reached/.test(x))});
 const drop=await fixture({rows:2,left:false,dropped:true});assert.equal(drop.outputs.status,'incomplete');assert.match(drop.summary,/parts 1, 2 of 2/);assert.match(drop.summary,/Unit parts not reached/);
 results.push({id:'N2',name:'Budget-dropped part is also labelled reviewed in parts',status:drop.outputs.status,lines:drop.summary.split('\n').filter(x=>/Reviewed in parts|Unit parts not reached/.test(x))});
 const bad=await fixture({rows:2,left:false,failed:true});assert.equal(bad.outputs.status,'incomplete');assert.match(bad.summary,/1 unit were not reviewed: the unit call failed/);
 results.push({id:'N3',name:'One failed part makes the whole partly successful unit not reviewed',status:bad.outputs.status,lines:bad.summary.split('\n').filter(x=>/unit call failed|selected this run/.test(x))});
 const off=await fixture({rows:1,left:false,engine:true});assert.equal(off.engine_status,'success');assert.equal(off.pack_cut_exists,false);assert.equal(off.outputs.status,'complete');assert.doesNotMatch(off.request,/criticalBoundary/);
 results.push({id:'N4',name:'Zero pack can produce complete scan without source',status:off.outputs.status,engine_status:off.engine_status,pack_cut_exists:off.pack_cut_exists,source_was_sent:false});
 const units=fromGit('src/audit-units.js'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'specguard-static-review-'));
 try{
  const rows=Array.from({length:101},(_,i)=>({id:i.toString(16).padStart(8,'0'),path:'src/u'+i+'.js',score:1,why:'why',tests:['test/u'+i+'.test.js'],ver:'abcdef12',loc:3,pub:1,churn:0,fixes:0,signals:{tests:1,noAssert:0,skipped:0,asserts:1,weak:[],unread:0},unref:[{name:'missingExport'+i,line:1}]}));
  const selected=rows[100];
  units.write(temp,SHA,12,{rows,picked:[selected],carried:[],unitRooms:[[selected.id]],unitCalls:1,totals:{},rotation:{picked:1,reviewed:101,total:101},shallow:false,limitations:[],forced:[],stale:[],review:r=>r===selected?'this run':'reviewed earlier'});
  const persisted=JSON.parse(fs.readFileSync(path.join(temp,'audit-inventory.json'),'utf8'));
  const before=units.staticLeads([{...selected,leads:{unref:selected.unref,weak:[]}}]).items.length,after=units.staticLeads(persisted.rows.filter(r=>r.id===selected.id)).items.length;
  assert.equal(before,1);assert.equal(after,0);assert.equal(persisted.rows.length,100);
  results.push({id:'N5',name:'Static leads disappear for selected units beyond the 100 retained inventory rows',inventory_units:rows.length,persisted_rows:persisted.rows.length,selected_unit:selected.path,lead_before_serialization:before,lead_available_to_publisher:after});
 }finally{const p=fs.realpathSync(temp);assert.equal(path.dirname(p),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(p).startsWith('specguard-static-review-'));fs.rmSync(p,{recursive:true,force:true});}
 const out={snapshot:SHA,created_at:new Date().toISOString(),method:'Immutable Git modules; local file fixtures, controlled Git reads, mocked provider and GitHub; no network or product changes.',results,source_hashes:hashes};
 fs.writeFileSync(path.join(ROOT,'docs/scan-budget-followup-probe-results-2026-10-17.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});

