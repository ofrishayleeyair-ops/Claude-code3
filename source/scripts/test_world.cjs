/* Tests for 32-world.js: KE.Heightfield, KE.GPUTerrain, KE.WorldPartition, KE.scatterCell.
   node scripts/test_world.cjs            (node unit tests + browser tests + screenshots)
   node scripts/test_world.cjs --node     (node unit tests only)
   Screenshots: .test-output/world-aerial.png, world-ground.png, world-lod.png */
const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'..');
let failed=0;
const check=(name,ok,info)=>{if(ok)console.log('PASS '+name+(info!==undefined?'  '+JSON.stringify(info):''));else{failed++;console.log('FAIL '+name+(info!==undefined?'  '+JSON.stringify(info):''));}};

/* ---------- node unit tests (pure logic) ---------- */
function loadNode(){
  const KE={settings:{lod:1},modules:{},registerModule(n,i){this.modules[n]=i;},GLSL:{hash:'',noise:''},
    random:(seed=1)=>{let s=Number(seed)>>>0;return ()=>{s+=0x6D2B79F5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};}};
  const prev=global.window;global.window={KitsuneEngine:KE};
  // runInThisContext keeps V8's fast global lookups (a separate vm context makes the noise ~10x slower)
  vm.runInThisContext(fs.readFileSync(path.join(ROOT,'src/modules/32-world.js'),'utf8'),{filename:'32-world.js'});
  global.window=prev;return KE;
}
const roughness=hf=>{let s=0,n=0;const S=hf.size,d=hf.data;for(let j=1;j<S-1;j++)for(let i=1;i<S-1;i++){const k=j*S+i,l=(d[k-1]+d[k+1]+d[k-S]+d[k+S])/4-d[k];s+=l*l;n++;}return Math.sqrt(s/n);};
async function nodeTests(){
  const KE=loadNode(),H=KE.Heightfield;
  check('module registers world',!!KE.modules.world&&KE.modules.world.provides.includes('GPUTerrain'));
  {const a=H.generate({size:129,worldSize:2048,seed:5,islands:true}),b=H.generate({size:129,worldSize:2048,seed:5,islands:true}),c=H.generate({size:129,worldSize:2048,seed:6,islands:true});
    let same=true,diff=0;for(let i=0;i<a.data.length;i++){if(a.data[i]!==b.data[i])same=false;diff+=Math.abs(a.data[i]-c.data[i]);}
    check('generate is deterministic per seed',same&&diff>0,{range:[+a.minHeight.toFixed(1),+a.maxHeight.toFixed(1)]});
    // the landscape is a function of world position: a half-size bake of the same seed matches at shared samples
    const h=H.generate({size:65,worldSize:1024,seed:5,islands:true,originX:-512,originZ:-512,centerX:0});
    const fn=H.terrainFunction({seed:5,worldSize:2048,islands:true,centerX:0,centerZ:0});
    check('generate samples the world-space terrain function',Math.abs(a.heightAt(100,-300)-fn(100,-300))<Math.abs(a.maxHeight-a.minHeight)*.05&&Math.abs(a.sample(64,64)-fn(0,0))<1e-3,{a:a.sample(64,64),f:fn(0,0),h:h.size});
    const n=a.normalAt(10,20),len=Math.hypot(n.x,n.y,n.z);check('normalAt is unit length and slopeAt >= 0',Math.abs(len-1)<1e-6&&a.slopeAt(10,20)>=0);}
  for(const sim of [385,129]){
    const hf=H.generate({size:257,worldSize:2048,seed:11,islands:true}),v0=hf.volume(),r0=roughness(hf);
    H.erode(hf,{iterations:20000,seed:3,simSize:sim});const st=hf.erosionStats,v1=hf.volume(),r1=roughness(hf);
    const err=Math.abs((v1-v0)+st.lostVolume);
    check(`erosion (simSize ${Math.min(sim,257)}) reduces roughness`,r1<r0*.99,{r0:+r0.toFixed(4),r1:+r1.toFixed(4)});
    check(`erosion (simSize ${Math.min(sim,257)}) conserves volume (only off-map sediment lost)`,err<=Math.max(1,st.erodedVolume*1e-3),{dV:+(v1-v0).toFixed(1),lost:+st.lostVolume.toFixed(1),eroded:+st.erodedVolume.toFixed(0)});
    check(`erosion (simSize ${Math.min(sim,257)}) records flow and delta masks`,!!(hf.masks&&hf.masks.flow&&hf.masks.delta)&&hf.masks.flow.some(v=>v>0));
  }
  {const hf=H.generate({size:129,worldSize:512,seed:2,amplitude:200}),v0=hf.volume();let m0=0;for(let i=0;i<128;i++)m0=Math.max(m0,Math.abs(hf.data[64*129+i+1]-hf.data[64*129+i]));
    H.thermalErode(hf,{iterations:30,talus:.6});let m1=0;for(let i=0;i<128;i++)m1=Math.max(m1,Math.abs(hf.data[64*129+i+1]-hf.data[64*129+i]));
    check('thermal erosion conserves volume and relaxes steep slopes',Math.abs(hf.volume()-v0)<Math.abs(v0)*1e-6+1e-3&&m1<m0,{m0:+m0.toFixed(2),m1:+m1.toFixed(2)});}
  {const img={width:4,height:3,data:new Uint8Array([0,50,100,150, 10,60,110,160, 20,70,120,255]),channels:1};const hf=H.fromImage(img,{size:9,worldSize:80,maxHeight:255});
    check('fromImage resamples gray data',Math.abs(hf.sample(0,0))<1e-6&&Math.abs(hf.sample(8,8)-255)<1e-4&&hf.size===9);}
  {const hf=H.generate({size:65,worldSize:512,seed:3}),b=H.biomes(hf,{waterLevel:0});let ok=b.data.length===65*65*4;for(let i=0;i<b.data.length;i+=4)if(b.data[i]+b.data[i+1]+b.data[i+2]+b.data[i+3]>255)ok=false;
    check('biome weights are a partition of unity (dirt = remainder)',ok);}
  await worldPartitionTests(KE);
}
function busy(ms){const t=performance.now();while(performance.now()-t<ms){}}
async function worldPartitionTests(KE){
  // nearest-first within budget, hysteresis, no double loads
  {const live=new Set(),order=[];let doubles=0,perUpdate=[],count=0;
    const wp=new KE.WorldPartition({cellSize:100,loadRadius:300,unloadRadius:360,budgetMs:2.5,prefetch:0,
      load:c=>{if(live.has(c.key))doubles++;live.add(c.key);order.push(c.distance);count++;busy(1);return {k:c.key};},unload:(c,d)=>{if(!live.delete(c.key))doubles++;if(!d||d.k!==c.key)doubles++;}});
    const P={x:50,z:50};let guard=0;do{count=0;const before=order.length;wp.update(P,1/60);perUpdate.push(count);if(order.length===before&&wp.isReady(P))break;}while(++guard<200);
    const sortedFirst=order.slice(0,6).every((d,i,a)=>i===0||d>=a[i-1]-1e-9),maxPer=Math.max(...perUpdate);
    const expected=[...wp.cells.values()].filter(c=>c.distance<=300).length;
    check('WorldPartition loads nearest-first',sortedFirst&&order[0]===0,{first:order.slice(0,6).map(v=>+v.toFixed(1))});
    check('WorldPartition respects the frame budget (<= 3 x 1 ms loads per update at 2.5 ms)',maxPer<=3&&perUpdate.length>5,{maxPer,updates:perUpdate.length});
    check('WorldPartition loads every cell within loadRadius',wp.isReady(P)&&live.size===expected&&expected>=25,{live:live.size,expected});
    // move 30 m: cells slightly beyond loadRadius but inside unloadRadius stay loaded (hysteresis)
    const liveBefore=new Set(live);wp.update({x:80,z:50},1/60,Infinity);let kept=true;for(const k of liveBefore){const c=wp.cells.get(k);if(c&&c.distance<=360&&c.state!=='loaded')kept=false;}
    check('WorldPartition keeps cells inside unloadRadius (hysteresis)',kept);
    // move far: everything unloads
    for(let i=0;i<5;i++)wp.update({x:5000,z:5000},1/60,Infinity);const s=wp.stats();
    check('WorldPartition unloads cells beyond unloadRadius',![...liveBefore].some(k=>live.has(k))&&s.unloaded>=expected,{unloaded:s.unloaded});
    wp.dispose();check('WorldPartition never double-loads and dispose unloads all',doubles===0&&live.size===0&&s.doubleLoads===0,{doubles,live:live.size});}
  // async loads: cancellation of pending promise loads; late results are discarded through unload
  {const pending=new Map(),live=new Set();let discarded=0;
    const wp=new KE.WorldPartition({cellSize:100,loadRadius:150,unloadRadius:200,maxConcurrent:3,budgetMs:5,bounds:{minX:-1000,minZ:-1000,maxX:1000,maxZ:1000},
      load:(c,ctx)=>new Promise(res=>pending.set(c.key,{res,ctx})),unload:(c,d)=>{if(d&&d.late)discarded++;live.delete(c.key);}});
    wp.update({x:0,z:0},1/60);const s1=wp.stats();
    check('WorldPartition limits in-flight async loads',s1.inflight===3&&s1.loading===3,{inflight:s1.inflight});
    wp.update({x:5000,z:0},1/60);const s2=wp.stats();const aborted=[...pending.values()].every(p=>p.ctx.signal.aborted);
    for(const [k,p] of pending){p.res({late:true});}await new Promise(r=>setTimeout(r,0));const s3=wp.stats();
    check('WorldPartition cancels pending loads out of range',s2.cancelled===3&&aborted&&s3.loaded===0&&discarded===3&&s3.inflight===0,{cancelled:s2.cancelled,discarded,loaded:s3.loaded});
    // back in range: loads again (after the cancelled promise settled, never two at once)
    pending.clear();wp.update({x:0,z:0},1/60);const ks=[...pending.keys()];for(const k of ks)pending.get(k).res({late:false});await new Promise(r=>setTimeout(r,0));
    wp.update({x:0,z:0},1/60);check('WorldPartition reloads after cancellation settles',wp.stats().loaded>=3&&wp.stats().doubleLoads===0,{loaded:wp.stats().loaded});wp.dispose();}
  // generator loads: time-sliced, cancelled with iterator.return() (finally blocks run)
  {let finalized=0,finished=0,entered=0;const wp=new KE.WorldPartition({cellSize:100,loadRadius:120,unloadRadius:150,budgetMs:1,maxConcurrent:8,bounds:{minX:-1000,minZ:-1000,maxX:1000,maxZ:1000},
      load:function*(c){entered++;try{for(let i=0;i<50;i++){busy(.1);yield;}finished++;return c.key;}finally{finalized++;}}});
    wp.update({x:0,z:0},1/60);wp.update({x:0,z:0},1/60);const s1=wp.stats();wp.update({x:9000,z:0},1/60);const s2=wp.stats();
    // generators that already ran their body get return(): their finally blocks run; unstarted ones simply never run
    check('WorldPartition steps generator loads under the budget and cancels them with return()',s1.loading>0&&s1.loaded===0&&entered>0&&s2.cancelled===s1.loading&&finalized===entered&&finished===0&&s2.inflight===0,{loading:s1.loading,entered,finalized});
    wp.dispose();}
  // HLOD proxies
  {const proxies=new Map();let created=0;const wp=new KE.WorldPartition({cellSize:100,loadRadius:150,unloadRadius:200,hlodRadius:600,budgetMs:Infinity,
      load:c=>({c:c.key}),unload:()=>{},hlod:c=>{created++;const p={key:c.key};proxies.set(c.key,p);return p;},hlodUnload:(c,p)=>{proxies.delete(c.key);}});
    wp.update({x:0,z:0},1/60);let bad=0,inRing=0;for(const c of wp.cells.values()){if(c.state==='loaded'&&proxies.has(c.key))bad++;if(c.distance>150&&c.distance<=600){inRing++;if(!proxies.has(c.key))bad++;}}
    check('WorldPartition shows HLOD proxies between loadRadius and hlodRadius only',bad===0&&inRing>20&&proxies.size===inRing,{proxies:proxies.size,inRing});
    wp.update({x:400,z:0},1/60);let swapped=true;for(const c of wp.cells.values()){if(c.state==='loaded'&&proxies.has(c.key))swapped=false;if(c.distance>650&&proxies.has(c.key))swapped=false;}
    check('WorldPartition swaps proxies for loaded cells and drops far proxies',swapped&&wp.stats().hlodRemoved>0,{removed:wp.stats().hlodRemoved});
    wp.dispose();check('WorldPartition dispose removes proxies',proxies.size===0);}
}

/* ---------- browser tests ---------- */
async function browserTests(){
  const {openPage}=require('./harness.cjs');
  const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/10-pipeline.js','src/modules/12-sky.js','src/modules/14-shadows.js','src/modules/22-water.js','src/modules/32-world.js'],atlas:true,viewport:{width:640,height:400},name:'world'});
  page.setDefaultTimeout(300000);
  const setup=await page.evaluate(async()=>{
    const T=THREE,KE=KitsuneEngine;await KE.loadVisualAssets();KE.applyPreset('high');
    const renderer=new T.WebGLRenderer();renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;document.body.append(renderer.domElement);
    const t0=performance.now();const hf=KE.Heightfield.generate({size:1025,worldSize:2048,seed:11,islands:true,amplitude:180});const tg=performance.now()-t0;
    KE.Heightfield.erode(hf,{iterations:80000,seed:3});const te=performance.now()-t0-tg;KE.Heightfield.thermalErode(hf,{iterations:4,talus:1.1});
    const terrain=new KE.GPUTerrain(T,{heightfield:hf,castShadow:true,textureSize:256,waterLevel:0});const tt=performance.now()-t0-tg-te;
    const scene=new T.Scene(),camera=new T.PerspectiveCamera(55,innerWidth/innerHeight,1,9000);KE.prepareCamera(camera);scene.add(terrain.object);
    window.W={T,KE,renderer,scene,camera,hf,terrain};
    return {gen:Math.round(tg),erode:Math.round(te),terrain:Math.round(tt),range:[+hf.minHeight.toFixed(1),+hf.maxHeight.toFixed(1)],stats:terrain.stats()};
  });
  console.log('   setup',JSON.stringify(setup));
  check('GPUTerrain builds a CDLOD quadtree over the heightfield',setup.stats.levels===6&&setup.stats.vertexSpacing===2);

  // rendered height (float target, top-down orthographic, 'height' debug output) vs CPU heightAt
  const rh=await page.evaluate(()=>{const {T,KE,renderer,hf,terrain}=W;const caps=KE.capabilities(renderer);if(!caps.floatRT)return {skipped:true};
    // pick a hilly land point, put the LOD camera there (LOD 0, no morph within ~130 m) and render 120 x 120 m around it
    let best=null;for(let j=300;j<700;j+=16)for(let i=300;i<700;i+=16){const x=hf.originX+i*hf.spacing,z=hf.originZ+j*hf.spacing,h=hf.heightAt(x,z),s=hf.slopeAt(x,z);if(h>20&&(!best||s>best.s))best={x,z,s};}
    const cx=best.x,cz=best.z,R=24,N=192,rt=new T.WebGLRenderTarget(N,N,{type:T.FloatType,format:T.RGBAFormat,minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:true});
    // LOD camera 30 m above the centre looking down with a wide fov: its frustum covers the whole measured area
    const lod=new T.PerspectiveCamera(140,1,1,5000);lod.position.set(cx,terrain.heightAt(cx,cz)+30,cz);lod.up.set(0,0,-1);lod.lookAt(cx,terrain.heightAt(cx,cz),cz);
    const ortho=new T.OrthographicCamera(-R,R,R,-R,1,2000);ortho.position.set(cx,hf.maxHeight+50,cz);ortho.up.set(0,0,-1);ortho.lookAt(cx,0,cz);ortho.updateMatrixWorld();
    const scene=new T.Scene();scene.add(terrain.object);
    const measure=()=>{terrain.update(lod);terrain.setDebug('height');const fr=new T.Frustum().setFromProjectionMatrix(new T.Matrix4().multiplyMatrices(ortho.projectionMatrix,ortho.matrixWorldInverse));
      renderer.setRenderTarget(rt);renderer.setClearColor(0x000000,0);renderer.clear();renderer.render(scene,ortho);renderer.setRenderTarget(null);renderer.setClearColor(0x000000,1);terrain.setDebug(null);
      // Rasterisers snap vertices to a sub-pixel grid (SwiftShader: 1/16 px), which moves the surface sideways
      // by a fraction of a pixel; the tolerance therefore grows with the local slope times the pixel size.
      const px=new Float32Array(N*N*4);renderer.readRenderTargetPixels(rt,0,0,N,N,px);let max=0,sum=0,n=0,ratio=0;const pix=2*R/N;
      for(let y=0;y<N;y++)for(let x=0;x<N;x++){const wx=cx-R+(x+.5)/N*2*R,wz=cz+R-(y+.5)/N*2*R,g=px[(y*N+x)*4],c=terrain.heightAt(wx,wz),e=Math.abs(g-c);
        max=Math.max(max,e);sum+=e;n++;ratio=Math.max(ratio,e/(.002+.12*terrain.slopeAt(wx,wz)*pix));}
      return {max,mean:sum/n,ratio,sample:px[(N/2*N+N/2)*4]};};
    const before=measure();
    // sculpt: CPU and GPU (sub-rectangle upload) must agree afterwards
    const h0=terrain.heightAt(cx,cz),r=terrain.sculpt({x:cx,z:cz,radius:18,strength:9,mode:'raise'}),h1=terrain.heightAt(cx,cz);
    const after=measure();scene.remove(terrain.object);W.scene.add(terrain.object);rt.dispose();
    return {before,after,h0,h1,rect:r,levels:terrain.stats().levelCounts,center:[cx,cz]};});
  if(rh.skipped)console.log('SKIP rendered height test (no float render targets)');else{
    check('heightAt matches the rendered surface (float depth pass, LOD 0)',rh.before.ratio<=1&&rh.before.mean<.004,{max:+rh.before.max.toFixed(4),mean:+rh.before.mean.toFixed(5),tolRatio:+rh.before.ratio.toFixed(3),levels:rh.levels});
    check('sculpt updates the CPU heightfield',rh.h1-rh.h0>8.5&&rh.h1-rh.h0<9.01,{dh:+(rh.h1-rh.h0).toFixed(3)});
    check('sculpt updates the GPU height texture (sub-rectangle upload)',rh.after.ratio<=1&&rh.after.mean<.004&&Math.abs(rh.after.sample-rh.before.sample)>1,{max:+rh.after.max.toFixed(4),tolRatio:+rh.after.ratio.toFixed(3),before:+rh.before.sample.toFixed(2),after:+rh.after.sample.toFixed(2)});}

  const lodr=await page.evaluate(()=>{const {T,renderer,scene,camera,terrain}=W;const c=camera;
    c.position.set(0,120,300);c.lookAt(0,60,0);terrain.update(c);const low=terrain.stats();renderer.info.reset();renderer.info.autoReset=false;renderer.render(scene,c);const calls=renderer.info.render.calls;renderer.info.autoReset=true;
    c.position.set(0,4000,300);c.lookAt(0,0,0);terrain.update(c);const high=terrain.stats();
    return {low:{p:low.patches,t:low.triangles,lc:low.levelCounts},high:{p:high.patches,t:high.triangles,lc:high.levelCounts},calls};});
  check('fewer patches and triangles when the camera is high',lodr.high.p<lodr.low.p&&lodr.high.t<lodr.low.t&&lodr.low.lc[0]>0&&lodr.high.lc[0]===0,lodr);
  check('all terrain patches are one instanced draw call',lodr.calls===1&&lodr.low.p>10,{calls:lodr.calls,patches:lodr.low.p});

  const misc=await page.evaluate(()=>{const {T,KE,terrain,hf}=W;const out={};
    // raycast: vertical and slanted rays land on the surface; THREE.Raycaster integration
    const hit=terrain.raycast({x:120,y:900,z:-40},{x:0,y:-1,z:0});out.vertical=hit?Math.abs(hit.point.y-terrain.heightAt(120,-40)):-1;
    let worst=0,misses=0;for(let i=0;i<40;i++){const a=i*.7,o={x:Math.cos(a)*900,y:400,z:Math.sin(a)*900},d={x:-o.x,y:-400,z:-o.z};const h=terrain.raycast(o,d,5000);if(!h){misses++;continue;}worst=Math.max(worst,Math.abs(h.point.y-terrain.heightAt(h.point.x,h.point.z)));}
    out.slanted=worst;out.misses=misses;const rc=new T.Raycaster(new T.Vector3(0,800,0),new T.Vector3(.2,-1,.1).normalize());const is=rc.intersectObject(terrain.object);out.raycaster=is.length?Math.abs(is[0].point.y-terrain.heightAt(is[0].point.x,is[0].point.z)):-1;
    out.up=terrain.raycast({x:0,y:hf.maxHeight+10,z:0},{x:0,y:1,z:0});
    // other sculpt modes and setHeightRegion
    const x=-200,z=150,h0=terrain.heightAt(x,z);terrain.sculpt({x,z,radius:25,strength:1,mode:'flatten',height:h0+3});out.flatten=terrain.heightAt(x,z)-h0;
    terrain.sculpt({x,z,radius:25,strength:1,mode:'smooth'});terrain.sculpt({x,z,radius:25,strength:2,mode:'lower'});
    const v=new Float32Array(9*9).fill(42);terrain.setHeightRegion(100,100,9,9,v);out.region=hf.sample(104,104);
    // time-sliced erosion through KE.jobs matches the synchronous result
    const a=KE.Heightfield.generate({size:129,worldSize:512,seed:4}),b=a.clone();KE.Heightfield.erode(a,{iterations:8000,seed:9});
    const jobs=new KE.Jobs();let done=false,res=null;KE.Heightfield.erode(b,{iterations:8000,seed:9,jobs,batch:500}).then(r=>{done=true;res=r;});
    return new Promise(resolve=>{let runs=0,maxMs=0;const step=()=>{const t=performance.now();jobs.run(2);maxMs=Math.max(maxMs,performance.now()-t);runs++;if(!done&&runs<5000)return setTimeout(step,0);
      let same=true;for(let i=0;i<a.data.length;i++)if(a.data[i]!==b.data[i]){same=false;break;}out.jobs={runs,maxMs,same,resolved:res===b};resolve(out);};step();});});
  check('raycast hits the rendered surface (vertical, slanted, THREE.Raycaster)',misc.vertical>=0&&misc.vertical<1e-3&&misc.slanted<1e-3&&misc.misses===0&&misc.raycaster>=0&&misc.raycaster<1e-3&&misc.up===null,misc);
  check('sculpt flatten/smooth/lower and setHeightRegion',Math.abs(misc.flatten-3)<.01&&misc.region===42,{flatten:misc.flatten,region:misc.region});
  check('erosion is time-sliceable through KE.jobs and deterministic',misc.jobs.same&&misc.jobs.resolved&&misc.jobs.runs>3,misc.jobs);

  const par=await page.evaluate(async()=>{const KE=W.KE,H=KE.Heightfield,o={size:257,worldSize:1024,seed:5,islands:true,amplitude:120};const pool=H.workers({size:3});const out={workers:pool.size};
    const a=H.generate(o),b=await H.generate({...o,workers:pool});let maxd=0;for(let i=0;i<a.data.length;i++)maxd=Math.max(maxd,Math.abs(a.data[i]-b.data[i]));out.maxDiff=maxd;
    const fnOk=H.generate({...o,workers:pool,falloff:()=>1});out.fnFallbackSync=!(fnOk&&typeof fnOk.then==='function');
    const v0=b.volume(),e=await H.erode(b,{iterations:12000,seed:3,workers:pool});out.vol=+(e.volume()/v0).toFixed(5);out.parallel=e.erosionStats.parallel;out.eroded=e.erosionStats.erodedVolume>0;
    let changed=0;for(let i=0;i<a.data.length;i++)if(Math.abs(a.data[i]-e.data[i])>1e-3)changed++;out.changed=changed;out.flow=!!(e.masks&&e.masks.flow);out.tasks=pool.tasksRun;pool.dispose();out.disposed=pool.size===0;return out;});
  check('worker pool: parallel generation equals the single-threaded bake; parallel erosion conserves volume and carves',par.workers>0&&par.maxDiff===0&&par.parallel&&par.parallel.workers===par.workers&&par.fnFallbackSync&&Math.abs(par.vol-1)<.002&&par.eroded&&par.changed>1000&&par.flow&&par.disposed,par);

  const sc=await page.evaluate(()=>{const {T,KE,renderer,scene,camera,terrain,hf}=W;
    const part=(g,hex)=>{const c=new T.Color(hex),n=g.attributes.position.count,a=new Float32Array(n*3);for(let i=0;i<n;i++){a[i*3]=c.r;a[i*3+1]=c.g;a[i*3+2]=c.b;}g.setAttribute('color',new T.BufferAttribute(a,3));return g;};
    const pine=T.BufferGeometryUtils.mergeBufferGeometries([part(new T.CylinderGeometry(.22,.34,2.6,6).translate(0,1.3,0),0x5a4030),part(new T.ConeGeometry(2.3,5.5,8).translate(0,4.6,0),0x2c5226),
      part(new T.ConeGeometry(1.7,4.4,8).translate(0,7.2,0),0x356030),part(new T.ConeGeometry(1,3,8).translate(0,9.4,0),0x3d6a34)]);const rock=new T.DodecahedronGeometry(1.2,0);
    const types=[{geometry:pine,material:new T.MeshStandardMaterial({vertexColors:true,roughness:.9}),weight:3,slope:[0,.6],height:[2,120],scale:[.7,1.4],castShadow:true},
      {geometry:rock,material:new T.MeshStandardMaterial({color:0x8a857c,roughness:.85,flatShading:true}),weight:1,slope:[0,1.2],height:[1,200],scale:[.6,2.2],align:.7,sink:.3}];
    const cell={ix:0,iz:1};const a=KE.scatterCell(T,{cell,cellSize:128,heightfield:terrain,spacing:5,density:.6,seed:21,types,waterLevel:1});
    const b=KE.scatterCell(T,{cell,cellSize:128,heightfield:terrain,spacing:5,density:.6,seed:21,types,waterLevel:1});
    const c=KE.scatterCell(T,{cell,cellSize:128,heightfield:terrain,spacing:5,density:.6,seed:22,types,waterLevel:1});
    const mats=g=>g.children.map(m=>Array.from(m.instanceMatrix.array));const same=JSON.stringify(mats(a))===JSON.stringify(mats(b)),differ=JSON.stringify(mats(a))!==JSON.stringify(mats(c));
    let onGround=0,inside=true;const m=new T.Matrix4(),p=new T.Vector3(),q=new T.Quaternion(),s=new T.Vector3();
    for(const mesh of a.children)for(let i=0;i<mesh.count;i++){mesh.getMatrixAt(i,m);m.decompose(p,q,s);const sink=mesh.userData.typeIndex===1?.3*s.x:0;if(Math.abs(p.y+sink-terrain.heightAt(p.x,p.z))<1e-3)onGround++;if(p.x<0||p.x>=128||p.z<128||p.z>=256)inside=false;}
    // neighbouring cell shares no points; dispose keeps the shared geometry usable
    const n=KE.scatterCell(T,{cell:{ix:1,iz:1},cellSize:128,heightfield:terrain,spacing:5,density:.6,seed:21,types,waterLevel:1});
    scene.add(a,n);camera.position.set(64,terrain.heightAt(64,190)+40,300);camera.lookAt(64,terrain.heightAt(64,190),190);terrain.update(camera);renderer.render(scene,camera);
    const meshCount=a.children.length,instanced=a.children.every(m=>m.isInstancedMesh);a.userData.dispose();b.userData.dispose();c.userData.dispose();renderer.render(scene,camera);const stillOk=pine.attributes.position.count>0&&!!pine.index;
    window.W.scatterTypes=types;n.userData.dispose();
    return {count:a.userData.count,meshes:meshCount,same,differ,onGround,inside,stillOk,instanced};});
  check('scatterCell returns InstancedMeshes, deterministic per (seed, cell)',sc.same&&sc.differ&&sc.instanced&&sc.meshes===2&&sc.count>50,sc);
  check('scatter instances sit on the terrain inside their cell',sc.onGround===sc.count&&sc.inside,{onGround:sc.onGround,count:sc.count});

  // shadows + CSM chaining, sky, water, pipeline: the aerial screenshot
  const aer=await page.evaluate(()=>{const {T,KE,renderer,scene,camera,terrain,hf}=W;
    const sun=new T.DirectionalLight(0xffffff,3);scene.add(sun,sun.target);const sky=new KE.SkyAtmosphere(T,renderer,scene,{sun,time:.13});
    const csm=new KE.CascadedShadows(T,scene,{sun,cascades:3,mapSize:1024,maxFar:1400});csm.setupMaterial(terrain.material);
    const water=new KE.Water(T,scene,{level:0,sky,radius:7000,fadeStart:300,fadeEnd:1500});const pipeline=new KE.Pipeline(T,renderer,{sun});pipeline.set({fog:{density:.0006,falloff:.0035,height:0,start:80}});
    // forest near the ground view
    const nz=KE.noise2D(5),density=(x,z)=>Math.max(0,Math.min(.8,nz(x*.006,z*.006)*1.8+.3));W.scatterTypes[0].height=[2,85];
    const forest=new T.Group();scene.add(forest);for(let iz=-6;iz<6;iz++)for(let ix=-6;ix<6;ix++){const g=KE.scatterCell(T,{cell:{ix,iz},cellSize:128,heightfield:terrain,spacing:6,density,seed:21,types:W.scatterTypes,waterLevel:1.5});forest.add(g);}
    W.frame=(n=1,dt=1/30)=>{for(let i=0;i<n;i++){sky.update(dt,camera);terrain.update(camera);csm.update(camera);pipeline.options.fog.color.copy(sky.fogColor);water.update(dt,camera,{pipeline});pipeline.render(scene,camera,dt);}};
    Object.assign(W,{sun,sky,csm,water,pipeline,forest});
    camera.position.set(-1050,860,980);camera.lookAt(60,-90,-60);W.frame(3);
    const key=terrain.material.customProgramCacheKey();return {key,csm:csm.materials.has(terrain.material),stats:terrain.stats()};});
  check('default material chains with KE.CascadedShadows.setupMaterial',aer.csm&&/ke-cdlod/.test(aer.key)&&/ke-csm/.test(aer.key),{key:aer.key});
  await page.screenshot({path:path.join(outDir,'world-aerial.png'),timeout:120000});

  const gr=await page.evaluate(()=>{const {terrain,hf,camera}=W;
    // ground view: a low coastal spot looking up at the highest peak
    let peak=0;for(let i=1;i<hf.data.length;i++)if(hf.data[i]>hf.data[peak])peak=i;const px=hf.originX+(peak%hf.size)*hf.spacing,pz=hf.originZ+Math.floor(peak/hf.size)*hf.spacing;
    let best=null;for(let a=0;a<64;a++)for(let r=300;r<=900;r+=50){const x=px+Math.cos(a/64*6.283)*r,z=pz+Math.sin(a/64*6.283)*r,h=terrain.heightAt(x,z),s=terrain.slopeAt(x,z);if(h>3&&h<22&&s<.25){const score=-Math.abs(r-550)-s*400;if(!best||score>best.score)best={x,z,h,score};}}
    camera.position.set(best.x,best.h+2.2,best.z);const dx=px-best.x,dz=pz-best.z;camera.lookAt(best.x+dx*.5,best.h+(hf.maxHeight-best.h)*.28,best.z+dz*.5);W.frame(3);
    return {pos:[best.x,best.h],peak:[px,pz,hf.maxHeight],stats:terrain.stats()};});
  console.log('   ground view',JSON.stringify({pos:gr.pos,patches:gr.stats.patches,levels:gr.stats.levelCounts}));
  await page.screenshot({path:path.join(outDir,'world-ground.png'),timeout:120000});

  const lw=await page.evaluate(()=>{const {terrain,camera,renderer,scene,forest,water}=W;forest.visible=false;water.mesh.visible=false;
    camera.position.set(-330,190,470);camera.lookAt(140,0,-60);terrain.update(camera);terrain.setDebug('wireframe');
    // KE.Pipeline resets renderer.info before its passes, so a direct render right after it would run with the same
    // info.render.frame and Three would skip this frame's instance-buffer upload; start a new frame explicitly.
    renderer.info.reset();renderer.render(scene,camera);return terrain.stats();});
  check('LOD rings: several levels selected in the oblique view',lw.levelCounts.filter(v=>v>0).length>=4,{levels:lw.levelCounts});
  await page.screenshot({path:path.join(outDir,'world-lod.png'),timeout:120000});

  const disp=await page.evaluate(()=>{const {terrain,renderer,scene,camera}=W;terrain.setDebug(null);const g0=renderer.info.memory.geometries,t0=renderer.info.memory.textures;terrain.dispose();
    return {inScene:!!scene.getObjectByName('ke-gpu-terrain'),g0,g1:renderer.info.memory.geometries,t0,t1:renderer.info.memory.textures};});
  check('dispose removes the terrain and frees its GPU resources',!disp.inScene&&disp.g1<disp.g0&&disp.t1<disp.t0,disp);
  await close();
}

(async()=>{
  await nodeTests();
  if(!process.argv.includes('--node'))await browserTests();
  if(failed){console.log(failed+' check(s) failed');process.exit(1);}
  console.log('all world checks passed');
})().catch(e=>{console.error(e);process.exit(1);});
