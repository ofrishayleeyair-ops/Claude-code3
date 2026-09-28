/* Runs every engine test suite in sequence and writes a verification record.
     node scripts/test_all.cjs [--out ../verification.json] [--only pipeline,gi] [--skip audio]
   Browser suites use headless Chromium with software WebGL2 (SwiftShader), so the whole run takes a while.
   Each suite's PASS lines are counted; a suite passes when its process exits 0. */
const {spawnSync}=require('child_process'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=path.resolve(__dirname,'..'),REPO=path.resolve(ROOT,'..');
const arg=(k,d)=>{const i=process.argv.indexOf(k);return i>0?process.argv[i+1]:d;};
const out=path.resolve(ROOT,arg('--out','../verification.json')),only=(arg('--only','')||'').split(',').filter(Boolean),skip=(arg('--skip','')||'').split(',').filter(Boolean);
const NODE_PATH=[process.env.NODE_PATH,'/tmp/kitsune-npm/node_modules'].filter(Boolean).join(':');
// [name, command, args, timeout seconds, kind]
const SUITES=[
  ['core','node',['scripts/test_core.cjs'],120,'node'],
  ['build','python3',['scripts/test_build.py'],120,'node'],
  ['pipeline','node',['scripts/test_pipeline.cjs'],900,'browser'],
  ['sky','node',['scripts/test_sky.cjs'],900,'browser'],
  ['shadows','node',['scripts/test_shadows.cjs'],900,'browser'],
  ['gi','node',['scripts/test_gi.cjs'],900,'browser'],
  ['water','node',['scripts/test_water.cjs'],900,'browser'],
  ['weather','node',['scripts/test_weather.cjs'],900,'browser'],
  ['foliage','node',['scripts/test_foliage.cjs'],1200,'browser'],
  ['materials','node',['scripts/test_materials.cjs'],1200,'browser'],
  ['geometry','node',['scripts/test_geometry.cjs'],1200,'browser'],
  ['world','node',['scripts/test_world.cjs'],1200,'browser'],
  ['hd','node',['scripts/test_hd.cjs'],600,'browser'],
  ['physics','node',['scripts/test_physics.cjs'],900,'browser'],
  ['cloth','node',['scripts/test_cloth.cjs'],600,'browser'],
  ['vfx','node',['scripts/test_vfx.cjs','--no-shots'],900,'browser'],
  ['animation','node',['scripts/test_animation.cjs'],900,'browser'],
  ['ai','node',['scripts/test_ai.cjs'],1200,'browser'],
  ['audio','node',['scripts/test_audio.cjs'],1500,'browser'],
  ['editor','node',['scripts/test_editor.cjs','--pipeline'],1200,'browser'],
  ['game','node',['scripts/test_browser.cjs','../spirit-isle.html','/tmp/kitsune-browser'],900,'browser'],
  ['open-world','node',['scripts/test_open_world.cjs'],900,'browser'],
  ['visuals','node',['scripts/test_visuals.cjs'],300,'node'],
  ['resources','node',['scripts/test_resources.cjs'],300,'node'],
];
const results={};let failed=0;
for(const [name,cmd,args,timeout,kind] of SUITES){
  if(only.length&&!only.includes(name))continue;if(skip.includes(name))continue;
  if(!fs.existsSync(path.join(ROOT,args[0]))){results[name]={status:'missing'};continue;}
  const t0=Date.now();process.stdout.write(`${name.padEnd(10)} … `);
  const r=spawnSync(cmd,args,{cwd:ROOT,encoding:'utf8',timeout:timeout*1000,env:{...process.env,NODE_PATH},maxBuffer:64*1024*1024});
  const text=(r.stdout||'')+(r.stderr||''),passes=(text.match(/^\s*PASS\b/gm)||[]).length+(text.match(/\.\.\. ok$/gm)||[]).length;
  const ok=r.status===0,sec=+((Date.now()-t0)/1000).toFixed(1);if(!ok)failed++;
  results[name]={status:ok?'pass':(r.error&&r.error.code==='ETIMEDOUT'?'timeout':'fail'),checks:passes,seconds:sec,kind};
  if(!ok)results[name].tail=text.trim().split('\n').slice(-6).join('\n');
  console.log(`${ok?'pass':'FAIL'}  ${passes} checks  ${sec}s`);
}
const sha=f=>{try{return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');}catch(e){return null;}};
const files={};for(const f of ['SKILL.md','assets/starter.html','assets/kitsune-engine.js','assets/three.min.js','assets/three-addons.js','assets/kitsune-libs.js','scripts/build.py','scripts/build_engine.py'])files[f]=sha(path.join(ROOT,f));
for(const f of fs.readdirSync(path.join(ROOT,'src/modules')).sort())files['src/modules/'+f]=sha(path.join(ROOT,'src/modules',f));
files['../spirit-isle.html']=sha(path.join(REPO,'spirit-isle.html'));
let modules=[];try{modules=fs.readdirSync(path.join(ROOT,'src/modules')).filter(f=>f.endsWith('.js')).sort();}catch(e){}
const record={product:'kitsune enginev3',codename:'Tenko',runtime_version:'3.0.0',three_revision:'128',date:new Date().toISOString(),
  environment:'Headless Chromium (Playwright) with SwiftShader software WebGL2 on a 4-CPU Linux container; Node '+process.version,
  modules,suites:results,
  not_verified:['Frame rate or frame time on any physical GPU, phone or tablet','Touch input on real devices','Audio output on real speakers (audio tests render the graph offline)','Visual parity with Unreal Engine 5 (no side-by-side comparison exists)'],
  sha256:files};
fs.writeFileSync(out,JSON.stringify(record,null,2)+'\n');
console.log(`\n${failed?failed+' suite(s) failed':'all suites passed'} · wrote ${path.relative(process.cwd(),out)}`);process.exit(failed?1:0);
