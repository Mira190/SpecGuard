process.env.SPECGUARD_REVIEW_SHA='489009da4c55b08157a52b2ee5c2d6628e5d5e87';
const {ROOT,SHA,fromGit,hashes,overrides}=require('./loader.cjs');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const prompt='Review one unit part.',pack={text:'synthetic source context',notWhole:[],note:''};
const parts=[{prompt,pack,units:['aaaaaaaa'],keys:['aaaaaaaa:1']},{prompt,pack,units:['aaaaaaaa'],keys:['aaaaaaaa:2'],extra:true}];
overrides['../scan-parts.js']={plan:()=>({parts,sub:()=>{throw Error('Unexpected retry');}})};
const api=fromGit('src/engines/claude-api.js'),model='claude-haiku-5-5',tokens=4000;
const m=api.messages(prompt,pack.text),per=api.worstCase(model,Buffer.byteLength(m.system),Buffer.byteLength(m.user),tokens).usd,budget=per*1.5;
async function run(withUsage){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'specguard-admit-review-')),ctx=path.join(root,'ctx');fs.mkdirSync(ctx);let calls=0;
 const found={docs_reviewed:[],requirements:[],not_requirements:[],unit_findings:[],not_reviewed:[]};
 try{
 await api.run({CHECK:'audit',CTX:ctx,GITHUB_WORKSPACE:root,PROMPT:prompt,ANTHROPIC_API_KEY:'sk-ant-synthetic-review',MODEL:model,CONTEXT_PACK_BYTES:'250000',MAX_BUDGET_USD:String(budget),MAX_OUTPUT_TOKENS:String(tokens)},
 {fetchFn:async()=>{calls++;return {ok:true,status:200,text:async()=>JSON.stringify({model,stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(found)}],...(withUsage?{usage:{input_tokens:100,output_tokens:tokens}}:{})})};},sleep:async()=>{}});
 const read=n=>fs.readFileSync(path.join(ctx,n),'utf8');
 return {calls,usage:JSON.parse(read('usage.json')),parts:JSON.parse(read('scan-parts.json')),status:fs.existsSync(path.join(ctx,'engine-status'))?read('engine-status').trim():'success (no failure marker)'};
 }finally{const p=fs.realpathSync(root);assert.equal(path.dirname(p),fs.realpathSync(os.tmpdir()));assert.ok(path.basename(p).startsWith('specguard-admit-review-'));fs.rmSync(p,{recursive:true,force:true});}
}
(async()=>{const unknown=await run(false),known=await run(true);assert.equal(unknown.calls,2);assert.equal(unknown.usage.totalCostUsd,0);assert.equal(known.calls,1);assert.ok(2*per>budget);
 const out={snapshot:SHA,id:'U4',created_at:new Date().toISOString(),method:'Real pending-PR adapter; controlled two-part plan and provider responses; no network.',per_call_reserve:per,budget,two_call_reserve:2*per,unknown_usage:{calls:unknown.calls,cost_recorded:unknown.usage.totalCostUsd,status:unknown.status},known_usage_control:{calls:known.calls,cost_recorded:known.usage.totalCostUsd,status:known.status},source_hashes:hashes};
 fs.writeFileSync(path.join(ROOT,'docs/unknown-unknown-runtime-admission-probe-2026-10-17.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exitCode=1;});

