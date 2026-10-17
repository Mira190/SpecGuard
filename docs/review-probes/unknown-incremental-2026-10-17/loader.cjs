const path=require('node:path'),{execFileSync}=require('node:child_process'),Module=require('node:module'),crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'../../..'),SHA=process.env.SPECGUARD_REVIEW_SHA||'44ed3eb8f093981c685027d0c1596aa78fa92939',cache=new Map(),hashes={},overrides={};
function fromGit(rel){if(cache.has(rel))return cache.get(rel).exports;
 const s=execFileSync('git',['show',SHA+':'+rel],{cwd:ROOT,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 hashes[rel]=crypto.createHash('sha256').update(s).digest('hex');
 if(rel.endsWith('.json')){const m={exports:JSON.parse(s)};cache.set(rel,m);return m.exports;}
 const m=new Module(path.join(ROOT,rel));cache.set(rel,m);m.filename=path.join(ROOT,rel);m.paths=Module._nodeModulePaths(ROOT);
 m.require=(id)=>{if(overrides[id])return overrides[id];if(!id.startsWith('.'))return require(id);
 const stem=path.posix.normalize(path.posix.join(path.posix.dirname(rel),id));if(path.posix.extname(stem))return fromGit(stem);
 for(const p of [stem+'.js',stem+'.json',stem+'/index.js']){try{execFileSync('git',['cat-file','-e',SHA+':'+p],{cwd:ROOT,stdio:'ignore'});}catch{continue;}return fromGit(p);}throw Error('Missing '+id+' in '+rel);};
 m._compile(s,m.filename);return m.exports;}
module.exports={ROOT,SHA,fromGit,hashes,overrides};

