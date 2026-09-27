/* Browser checks for KE.VFX (50-vfx.js): GPU/CPU backend selection, spawning and lifetime, forces,
   collision, attractors, shapes, local space, sorting, soft particles, presets, budget and disposal,
   plus screenshots of a night scene with several presets.
   node scripts/test_vfx.cjs [--no-shots]   (screenshots go to .test-output/vfx-*.png) */
const {openPage}=require('./harness.cjs');const path=require('path');
const shots=!process.argv.includes('--no-shots');
let failed=0;
const test=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+': '+(e&&e.message||e));}};
const assert=(c,msg)=>{if(!c)throw new Error(msg);};

(async()=>{
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/50-vfx.js'],viewport:{width:640,height:400},name:'vfx'});
 await page.evaluate(()=>{
  const T=THREE,KE=KitsuneEngine;
  const renderer=new T.WebGLRenderer({antialias:false});renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;document.body.append(renderer.domElement);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(50,innerWidth/innerHeight,.1,200);camera.position.set(0,2,8);camera.lookAt(0,1,0);camera.updateMatrixWorld();
  /* Aggregate statistics over live particles of a state read-back. */
  const live=(s,fn)=>{const n=s.width*s.height;let c=0;for(let i=0;i<n;i++){const life=s.velocity[i*4+3],age=s.position[i*4+3];if(life>0&&age<life){c++;fn&&fn(s.position[i*4],s.position[i*4+1],s.position[i*4+2],s.velocity[i*4],s.velocity[i*4+1],s.velocity[i*4+2],i);}}return c;};
  const run=(vfx,n,dt=1/60)=>{for(let i=0;i<n;i++)vfx.update(dt,camera);};
  window.t={T,KE,renderer,scene,camera,live,run};
 });
 const ev=(fn,arg)=>page.evaluate(fn,arg);

 await test('node-side: module registered and internals exposed',async()=>{
  const r=await ev(()=>({mod:!!t.KE.modules.vfx,prov:t.KE.modules.vfx.provides,internals:Object.keys(t.KE.VFX.internals)}));
  assert(r.mod&&r.prov.includes('VFX')&&r.internals.includes('curlNoise'),JSON.stringify(r));
 });

 await test('curl noise is divergence-free (CPU reference, finite differences)',async()=>{
  const r=await ev(()=>{const {curlNoise}=t.KE.VFX.internals,o=[0,0,0],h=1e-3;let maxDiv=0,meanMag=0;const rnd=t.KE.random(3);
   for(let k=0;k<200;k++){const x=rnd()*20-10,y=rnd()*20-10,z=rnd()*20-10;const c=(a,b,cc)=>{curlNoise(a,b,cc,o,2);return o.slice();};
    const d=(c(x+h,y,z)[0]-c(x-h,y,z)[0]+c(x,y+h,z)[1]-c(x,y-h,z)[1]+c(x,y,z+h)[2]-c(x,y,z-h)[2])/(2*h);const m=c(x,y,z);meanMag+=Math.hypot(...m)/200;maxDiv=Math.max(maxDiv,Math.abs(d));}
   return {maxDiv,meanMag};});
  assert(r.meanMag>.3&&r.maxDiv<r.meanMag*1e-2,JSON.stringify(r));
 });

 await test('GPU path is chosen on SwiftShader; CPU path when forced',async()=>{
  const r=await ev(()=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const a=vfx.emitter({capacity:128}),b=vfx.emitter({capacity:128,gpu:false});
   const out={sys:vfx.gpuSupported(),a:a.gpu,b:b.gpu,reason:b.fallbackReason,stats:vfx.stats()};vfx.dispose();return out;});
  assert(r.sys===true&&r.a===true&&r.b===false&&/gpu:false/.test(r.reason)&&r.stats.gpuEmitters===1&&r.stats.cpuEmitters===1,JSON.stringify(r));
 });

 for(const gpu of [true,false]){
  const tag=gpu?'GPU':'CPU';
  await test(tag+': burst N gives alive = N, then 0 after max life',async()=>{
   const r=await ev(gpu=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const e=vfx.emitter({gpu,capacity:512,spawn:{rate:0},init:{life:[.5,1],speed:[0,1]}});
    e.burst(300);t.run(vfx,1);const a1=e.alive,c1=e.countAlive();t.run(vfx,36);const a2=e.alive,c2=e.countAlive();t.run(vfx,40);const a3=e.alive,c3=e.countAlive(),d3=e.drawn;vfx.dispose();return {a1,c1,a2,c2,a3,c3,d3};},gpu);
   assert(r.a1===300&&r.c1===300,'after burst '+JSON.stringify(r));
   /* 37 frames = .617 s into a uniform [.5,1] lifetime: about 300*(1-.617)/.5 = 230 remain */
   assert(r.c2>195&&r.c2<265&&Math.abs(r.a2-r.c2)<25,'mid-life estimate '+JSON.stringify(r));
   assert(r.a3===0&&r.c3===0&&r.d3===0,'after max life '+JSON.stringify(r));
  });
  await test(tag+': gravity makes particles fall (state read-back matches integration)',async()=>{
   const r=await ev(gpu=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const e=vfx.emitter({gpu,capacity:256,position:[0,5,0],spawn:{rate:0},init:{life:[5,5],speed:[0,0]},forces:{gravity:[0,-10,0]}});
    e.burst(100);t.run(vfx,1);let y0=0,y1=0,vy=0;t.live(e.readState(),(x,y)=>{y0+=y/100;});t.run(vfx,60);const n=t.live(e.readState(),(x,y,z,vx,vyy)=>{y1+=y/100;vy+=vyy/100;});vfx.dispose();return {y0,y1,vy,n};},gpu);
   /* 60 semi-implicit Euler steps of 1/60 s under g=-10: dy = -10*(1/60)^2*(60*61/2) = -5.083 */
   assert(r.n===100&&Math.abs(r.y0-5)<.01&&Math.abs(r.y1-(5-5.083))<.05&&Math.abs(r.vy+10)<.05,JSON.stringify(r));
  });
  await test(tag+': plane collision keeps particles above the plane (bounce, friction)',async()=>{
   const r=await ev(gpu=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const e=vfx.emitter({gpu,capacity:256,position:[0,2,0],spawn:{rate:0},init:{life:[6,6],speed:[1,4],direction:'random'},forces:{gravity:[0,-9.8,0]},collision:{plane:.5,bounce:.4,friction:.3}});
    e.burst(200);let minY=1e9,maxY=-1e9;for(let k=0;k<12;k++){t.run(vfx,10,1/30);t.live(e.readState(),(x,y)=>{minY=Math.min(minY,y);});}
    let speed=0;const n=t.live(e.readState(),(x,y,z,vx,vy,vz)=>{maxY=Math.max(maxY,y);speed+=Math.hypot(vx,vy,vz)/200;});vfx.dispose();return {minY,maxY,speed,n};},gpu);
   assert(r.n===200&&r.minY>=.5-1e-3&&r.maxY<.7&&r.speed<.6,JSON.stringify(r));
  });
  await test(tag+': heightAt collision (baked height texture on GPU) follows terrain',async()=>{
   const r=await ev(gpu=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const h=(x,z)=>.6*Math.sin(x*1.3)+.3*z;
    const e=vfx.emitter({gpu,capacity:256,position:[0,4,0],spawn:{rate:0,shape:{type:'box',size:[4,0,4]}},init:{life:[8,8],speed:[0,0]},forces:{gravity:[0,-9.8,0]},collision:{heightAt:h,bounce:0,friction:.8,resolution:96}});
    e.burst(200);t.run(vfx,90,1/30);let err=0,below=0;const n=t.live(e.readState(),(x,y,z)=>{const d=y-h(x,z);err=Math.max(err,Math.abs(d));if(d<-.05)below++;});vfx.dispose();return {err,below,n};},gpu);
   assert(r.n===200&&r.below===0&&r.err<.15,JSON.stringify(r));
  });
  await test(tag+': collision die kills particles at the ground',async()=>{
   const r=await ev(gpu=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const e=vfx.emitter({gpu,capacity:128,position:[0,3,0],spawn:{rate:0},init:{life:[9,9],speed:[0,0]},forces:{gravity:[0,-9.8,0]},collision:{plane:0,die:true}});
    e.burst(100);t.run(vfx,20,1/30);const a=e.countAlive();t.run(vfx,20,1/30);const b=e.countAlive();vfx.dispose();return {a,b};},gpu);
   assert(r.a===100&&r.b===0,JSON.stringify(r));
  });
  await test(tag+': attractor pulls particles inward',async()=>{
   const r=await ev(gpu=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const e=vfx.emitter({gpu,capacity:256,position:[3,1,0],spawn:{rate:0,shape:{type:'sphere',radius:2,surfaceOnly:true}},init:{life:[9,9],speed:[0,0]},forces:{drag:1.5,attractor:{position:[0,0,0],strength:6,radius:0}}});
    e.burst(150);t.run(vfx,1);const dist=()=>{let d=0;const n=t.live(e.readState(),(x,y,z)=>{d+=Math.hypot(x-3,y-1,z);});return d/n;};const d0=dist();t.run(vfx,45,1/30);const d1=dist();vfx.dispose();return {d0,d1};},gpu);
   assert(Math.abs(r.d0-2)<.05&&r.d1<r.d0*.45,JSON.stringify(r));
  });
  await test(tag+': spawn shapes (sphere surface, box, line, cone, ring, mesh) stay in bounds',async()=>{
   const r=await ev(gpu=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const out={};const mesh=new t.T.Mesh(new t.T.SphereGeometry(1.5,24,16));mesh.position.set(0,1,0);mesh.updateMatrixWorld();
    const check=(name,shape,fn)=>{const e=vfx.emitter({gpu,capacity:256,position:[0,0,0],spawn:{rate:0,shape},init:{life:[5,5],speed:[0,0]}});e.burst(200);t.run(vfx,1);let bad=0;const n=t.live(e.readState(),(x,y,z)=>{if(!fn(x,y,z))bad++;});out[name]={n,bad};e.dispose();};
    check('sphere',{type:'sphere',radius:1,surfaceOnly:true},(x,y,z)=>Math.abs(Math.hypot(x,y,z)-1)<1e-3);
    check('hemisphere',{type:'hemisphere',radius:1},(x,y,z)=>Math.hypot(x,y,z)<=1.001&&y>=-1e-4);
    check('box',{type:'box',size:[2,1,4]},(x,y,z)=>Math.abs(x)<=1.001&&Math.abs(y)<=.501&&Math.abs(z)<=2.001);
    check('line',{type:'line',from:[-2,0,0],to:[2,0,0],radius:.1},(x,y,z)=>Math.abs(x)<=2.001&&Math.hypot(y,z)<=.101);
    check('disc',{type:'disc',radius:1.5},(x,y,z)=>Math.hypot(x,z)<=1.501&&Math.abs(y)<1e-4);
    check('ring',{type:'ring',radius:2,width:.1},(x,y,z)=>Math.abs(Math.hypot(x,y,z)-2)<=.11);
    check('mesh',{type:'mesh',mesh},(x,y,z)=>Math.abs(Math.hypot(x,y-1,z)-1.5)<.08);
    vfx.dispose();mesh.geometry.dispose();return out;},gpu);
   for(const [k,v] of Object.entries(r))assert(v.n===200&&v.bad===0,k+' '+JSON.stringify(r));
  });
  await test(tag+': local space follows attachTo; world space leaves particles behind',async()=>{
   const r=await ev(gpu=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const parent=new t.T.Object3D();t.scene.add(parent);
    const mk=space=>vfx.emitter({gpu,space,attachTo:parent,position:[0,1,0],capacity:64,spawn:{rate:0},init:{life:[5,5],speed:[0,0]}});const L=mk('local'),W=mk('world');
    L.burst(20);W.burst(20);t.run(vfx,1);parent.position.set(10,0,0);parent.rotation.y=Math.PI/2;parent.updateMatrixWorld();t.run(vfx,2);
    const mean=e=>{const m=[0,0,0];const n=t.live(e.readState(),(x,y,z)=>{m[0]+=x/n0;m[1]+=y/n0;m[2]+=z/n0;});return m;};const n0=20;
    const lw=new t.T.Vector3(...mean(L)).applyMatrix4(L.matrix),ww=mean(W);
    /* offset [1,0,0] under a parent yawed 90 degrees: rotated to [0,0,-1] with attachRotation, unrotated without */
    const A=vfx.emitter({gpu,attachTo:parent,position:[1,0,0],capacity:64,spawn:{rate:0},init:{life:[5,5],speed:[0,0]}}),B=vfx.emitter({gpu,attachTo:parent,attachRotation:false,position:[1,0,0],capacity:64,spawn:{rate:0},init:{life:[5,5],speed:[0,0]}});
    A.burst(20);B.burst(20);t.run(vfx,1);const aw=mean(A),bw=mean(B);t.scene.remove(parent);vfx.dispose();return {lw:lw.toArray(),ww,aw,bw};},gpu);
   assert(Math.abs(r.lw[0]-10)<.01&&Math.abs(r.lw[1]-1)<.01&&Math.abs(r.ww[0])<.01&&Math.abs(r.ww[1]-1)<.01,JSON.stringify(r));
   assert(Math.abs(r.aw[0]-10)<.01&&Math.abs(r.aw[2]+1)<.01&&Math.abs(r.bw[0]-11)<.01&&Math.abs(r.bw[2])<.01,'attachRotation '+JSON.stringify(r));
  });
 }

 await test('GPU and CPU backends agree statistically (cone + drag + wind)',async()=>{
  const r=await ev(()=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const cfg=gpu=>({gpu,seed:5,capacity:1024,spawn:{rate:0,shape:{type:'cone',radius:.2,angle:.4}},init:{life:[9,9],speed:[2,3],direction:'shape'},forces:{gravity:[0,-2,0],drag:.5,wind:[1,0,0]}});
   const g=vfx.emitter(cfg(true)),c=vfx.emitter(cfg(false));g.burst(800);c.burst(800);t.run(vfx,40,1/30);const m=e=>{const s=[0,0,0];const n=t.live(e.readState(),(x,y,z)=>{s[0]+=x;s[1]+=y;s[2]+=z;});return s.map(v=>v/n);};
   const out={g:m(g),c:m(c)};vfx.dispose();return out;});
  for(let i=0;i<3;i++)assert(Math.abs(r.g[i]-r.c[i])<.08,JSON.stringify(r));
 });

 await test('WebGL1 renderer falls back to the CPU backend and renders',async()=>{
  const r=await ev(()=>{const {T,KE}=t;const canvas=document.createElement('canvas');canvas.width=160;canvas.height=100;const gl=canvas.getContext('webgl');const r1=new T.WebGLRenderer({canvas,context:gl});
   const scene=new T.Scene(),cam=new T.PerspectiveCamera(50,1.6,.1,50);cam.position.set(0,1,5);const vfx=new KE.VFX(T,r1,scene,{budget:1});
   const e=vfx.create('fire'),g=vfx.create('trail'),sm=vfx.create('smoke');for(let i=0;i<10;i++){g.setPosition(i*.2,1,0);vfx.update(1/30,cam);r1.render(scene,cam);}
   const px=new Uint8Array(4*160*100);gl.readPixels(0,0,160,100,gl.RGBA,gl.UNSIGNED_BYTE,px);let lit=0;for(let i=0;i<px.length;i+=4)if(px[i]>40)lit++;
   const out={webgl2:r1.capabilities.isWebGL2,gpu:vfx.gpuSupported(),eg:e.gpu,reason:e.fallbackReason,alive:e.alive+g.alive+sm.alive,lit};vfx.dispose();r1.dispose();return out;});
  assert(r.webgl2===false&&r.gpu===false&&r.eg===false&&/float render targets/.test(r.reason)&&r.alive>20&&r.lit>50,JSON.stringify(r));
 });

 await test('bursts during a paused (dt=0) update are not lost',async()=>{
  const r=await ev(()=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const out={};for(const gpu of [true,false]){const e=vfx.emitter({gpu,capacity:128,spawn:{rate:0},init:{life:[5,5]}});e.burst(30);vfx.update(0,t.camera);out[gpu?'gpu':'cpu']=e.countAlive();}vfx.dispose();return out;});
  assert(r.gpu===30&&r.cpu===30,JSON.stringify(r));
 });

 await test('prewarm starts looping effects in steady state; teleports do not smear spawns',async()=>{
  const r=await ev(()=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const snow=vfx.create('snow',{ground:0});vfx.update(1/30,t.camera);let low=0;t.live(snow.readState(),(x,y)=>{if(y<3)low++;});
   const tr=vfx.emitter({capacity:512,spawn:{rate:0,rateOverDistance:10},init:{life:[5,5],speed:[0,0]}});tr.setPosition(0,0,0);vfx.update(1/30,t.camera);tr.setPosition(1,0,0);vfx.update(1/30,t.camera);const walk=tr.countAlive();
   tr.setPosition(100,0,0);vfx.update(1/30,t.camera);const jump=tr.countAlive()-walk;vfx.dispose();return {low,walk,jump};});
  assert(r.low>50&&r.walk===10&&r.jump===0,JSON.stringify(r));
 });

 await test('rate emission, duration/loop, setRate and stop({clear})',async()=>{
  const r=await ev(()=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const e=vfx.emitter({capacity:2048,spawn:{rate:100},init:{life:[10,10]}});
   t.run(vfx,60);const a=e.countAlive();e.setRate(0);t.run(vfx,30);const b=e.countAlive();e.stop({clear:true});t.run(vfx,1);const c=e.countAlive(),cd=e.drawn;
   const f=vfx.emitter({capacity:512,spawn:{rate:200,duration:.5,loop:false},init:{life:[10,10]}});t.run(vfx,60);const d=f.countAlive(),pl=f.playing;
   const g=vfx.emitter({capacity:512,spawn:{rate:0,bursts:[{time:0,count:10,cycle:.25}]},init:{life:[10,10]}});t.run(vfx,56);const bursts=g.countAlive();vfx.dispose();return {a,b,c,cd,d,pl,bursts};});
  assert(Math.abs(r.a-100)<=2&&r.b===r.a&&r.c===0&&r.cd===0&&Math.abs(r.d-100)<=2&&r.pl===false&&r.bursts===40,JSON.stringify(r));
 });

 await test('budget: capacity x budget, at least 64, never above requested; follows KE.settings.vfx',async()=>{
  const r=await ev(()=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:.35});const a=vfx.emitter({capacity:1000}).capacity,b=vfx.emitter({capacity:100}).capacity,c=vfx.emitter({capacity:10}).capacity,d=vfx.emitter({capacity:1000,scaleWithBudget:false}).capacity;vfx.dispose();
   const prev=t.KE.settings.vfx;t.KE.setSettings({vfx:1});const v2=new t.KE.VFX(t.T,t.renderer,t.scene);const e1=v2.emitter({capacity:1000}).capacity;t.KE.setSettings({vfx:.6});const e2=v2.emitter({capacity:1000}).capacity,b2=v2.budget;v2.dispose();t.KE.setSettings({vfx:prev});
   return {a,b,c,d,e1,e2,b2};});
  assert(r.a===350&&r.b===64&&r.c===10&&r.d===1000&&r.e1===1000&&r.e2===600&&r.b2===.6,JSON.stringify(r));
 });

 await test('GPU sortAlpha produces back-to-front order',async()=>{
  const r=await ev(()=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const e=vfx.emitter({capacity:300,spawn:{rate:0,shape:{type:'box',size:[6,6,6]}},init:{life:[5,5],speed:[0,0]},render:{blending:'alpha',sortAlpha:true}});
   e.burst(250);t.run(vfx,2);const rt=e.backend.sort.rt,cur=e.material.uniforms.tSort.value===rt[0].texture?rt[0]:rt[1],W=rt[0].width,H=rt[0].height,px=new Float32Array(W*H*4);t.renderer.readRenderTargetPixels(cur,0,0,W,H,px);
   let bad=0,valid=0;for(let i=0;i<250;i++){if(px[i*4]>-1e29)valid++;if(i&&px[i*4]>px[(i-1)*4]+1e-4)bad++;}
   /* the keys must be the true view depths of the referenced slots */
   const s=e.readState(),m=t.camera.matrixWorldInverse,v=new t.T.Vector3();let keyErr=0;for(let i=0;i<valid;i++){const sl=px[i*4+1];v.set(s.position[sl*4],s.position[sl*4+1],s.position[sl*4+2]).applyMatrix4(m);keyErr=Math.max(keyErr,Math.abs(-v.z-px[i*4]));}
   vfx.dispose();return {bad,valid,keyErr};});
  assert(r.bad===0&&r.valid===250&&r.keyErr<1e-3,JSON.stringify(r));
 });

 await test('soft particles fade against KE.sceneUniforms depth only when keHasScene=1',async()=>{
  const r=await ev(()=>{const {T,KE,renderer,scene}=t;const W=64,H=64,U=KE.sceneUniforms(T);const cam=new T.PerspectiveCamera(40,1,.1,50);cam.position.set(0,0,5);cam.lookAt(0,0,0);cam.updateMatrixWorld();
   const depth=new T.DataTexture(new Float32Array(W*H*4).fill(5.05),W,H,T.RGBAFormat,T.FloatType);depth.needsUpdate=true;
   const rt=new T.WebGLRenderTarget(W,H);const vfx=new KE.VFX(T,renderer,scene,{budget:1});const e=vfx.emitter({capacity:64,spawn:{rate:0},init:{life:[9,9],speed:[0,0],size:[2,2]},render:{blending:'alpha',texture:'soft',softness:.5,colorOverLife:[[0,0xffffff,1],[1,0xffffff,1]]}});
   e.burst(1);vfx.update(1/60,cam);const px=new Uint8Array(4);const shot=()=>{renderer.setRenderTarget(rt);renderer.setClearColor(0,1);renderer.clear();renderer.render(scene,cam);renderer.readRenderTargetPixels(rt,W/2,H/2,1,1,px);renderer.setRenderTarget(null);return px[0];};
   const hard=shot();U.keSceneDepth.value=depth;U.keHasScene.value=1;U.keResolution.value.set(W,H);const soft=shot();U.keHasScene.value=0;U.keSceneDepth.value=null;
   const layer=e.mesh.layers.mask;vfx.dispose();rt.dispose();depth.dispose();return {hard,soft,layer};});
  /* particle at view depth 5, scene depth 5.05, softness .5 -> fade 0.1 */
  assert(r.hard>180&&r.soft<r.hard*.35&&r.layer===(1<<1),JSON.stringify(r));
 });

 await test('all presets construct and simulate on GPU and CPU',async()=>{
  const r=await ev(()=>{const vfx=new t.KE.VFX(t.T,t.renderer,t.scene,{budget:1});const out={};
   for(const gpu of [true,false])for(const name of Object.keys(vfx.presets)){const cfg=vfx.presets[name]({position:[0,0,0],ground:0});
    const e=vfx.emitter(cfg.layers?{...cfg,layers:cfg.layers.map(c=>({...c,gpu}))}:{...cfg,gpu});
    for(let i=0;i<12;i++){if(name==='trail')e.setPosition(Math.sin(i*.3)*2,1,i*.1);vfx.update(1/30,t.camera);}t.renderer.render(t.scene,t.camera);
    out[name+(gpu?'':'/cpu')]={alive:e.countAlive(),drawn:e.drawn};e.dispose();}
   out._count=Object.keys(vfx.presets).length;out._create=(()=>{const g=vfx.create('explosion',{position:[1,0,0]});const n=g.emitters.length;g.dispose();return n;})();vfx.dispose();return out;});
  assert(r._count===14&&r._create===3,JSON.stringify(r));
  for(const [k,v] of Object.entries(r))if(k[0]!=='_')assert(v.alive>0&&v.drawn>0,k+' '+JSON.stringify(v));
 });

 await test('dispose returns renderer.info.memory to baseline',async()=>{
  const r=await ev(()=>{const {T,KE,renderer,scene,camera}=t;renderer.render(scene,camera);const base={...renderer.info.memory};const vfx=new KE.VFX(T,renderer,scene,{budget:1});
   const mesh=new T.Mesh(new T.SphereGeometry(1,8,6));
   for(const n of ['fire','smoke','sparks','magic','trail'])vfx.create(n,{ground:(x,z)=>0});vfx.emitter({capacity:128,spawn:{shape:{type:'mesh',mesh}},collision:{heightAt:()=>0}});vfx.emitter({capacity:128,gpu:false,render:{ribbons:true}});vfx.create('explosion');
   for(let i=0;i<6;i++){vfx.update(1/30,camera);renderer.render(scene,camera);}const during={...renderer.info.memory},children=scene.children.length;vfx.dispose();mesh.geometry.dispose();renderer.render(scene,camera);
   return {base,during,after:{...renderer.info.memory},children,left:scene.children.length};});
  assert(r.during.textures>r.base.textures&&r.after.textures===r.base.textures&&r.after.geometries===r.base.geometries&&r.left===r.children-10,JSON.stringify(r));
 });

 if(shots){
  await test('screenshot: night scene with fire, sparks, magic, smoke and fireflies',async()=>{
   await ev(()=>{const {T,KE,renderer}=t;const scene=new T.Scene();scene.background=new T.Color(0x05070d);scene.fog=new T.FogExp2(0x05070d,.035);
    const cam=new T.PerspectiveCamera(46,innerWidth/innerHeight,.1,200);cam.position.set(0,3.1,10.5);cam.lookAt(0,1.3,0);
    const ground=new T.Mesh(new T.PlaneGeometry(60,60),new T.MeshStandardMaterial({color:0x1b1e24,roughness:.95}));ground.rotation.x=-Math.PI/2;scene.add(ground);
    scene.add(new T.HemisphereLight(0x33405a,0x0a0a0c,.6));const glow=new T.PointLight(0xff8a3a,6,9,2);glow.position.set(-5.6,1,0);scene.add(glow);
    const logs=new T.MeshStandardMaterial({color:0x2a1a10,roughness:.9});for(let i=0;i<4;i++){const l=new T.Mesh(new T.CylinderGeometry(.09,.09,1.1,8),logs);l.rotation.set(Math.PI/2,0,i*Math.PI/4);l.position.set(-5.6,.08,0);scene.add(l);}
    /* moonlight on the shared sun uniforms (a KE.SkyAtmosphere or KE.Pipeline would publish these) lights the smoke */
    const U=KE.sceneUniforms(T);U.keSunColor.value.setRGB(.6,.68,.95);U.keSunDirection.value.set(-.45,.7,.55).normalize();
    const vfx=new KE.VFX(T,renderer,scene,{budget:1});
    vfx.create('fire',{position:[-5.6,0,0]});vfx.create('embers',{position:[-5.6,0,0]});vfx.create('sparks',{position:[-2.8,0,0],ground:0});
    vfx.create('magic',{position:[0,0,0]});vfx.create('smoke',{position:[2.9,0,0]});vfx.create('fireflies',{position:[5.8,0,0],scale:.55});
    for(let i=0;i<150;i++)vfx.update(1/30,cam);renderer.render(scene,cam);const st=vfx.stats();vfx.dispose();U.keSunColor.value.setRGB(1,1,1);return st;});
   await page.screenshot({path:path.join(outDir,'vfx-night.png'),timeout:120000});
  });
  await test('screenshot: montage of every preset (and explosion/splash over time)',async()=>{
   await page.setViewportSize({width:960,height:750});
   await ev(()=>{const {T,KE}=t;const W=240,H=150,cols=4;t.renderer.domElement.style.display='none';
    const renderer=new T.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});renderer.setSize(W,H);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;
    const out=document.createElement('canvas');out.width=W*cols;out.height=H*5;out.style.cssText='position:fixed;left:0;top:0';document.body.append(out);const g=out.getContext('2d');g.font='12px sans-serif';
    const names=['fire','smoke','sparks','embers','fireflies','magic','rain','snow','dust','leaves','waterSplash','explosion','portal','trail','explosion@.1','explosion@.5','explosion@1.2','waterSplash@.12','waterSplash@.6'];
    const views={fire:[0,1.3,3.2,0,.8,0],smoke:[0,3,9,0,2.6,0],sparks:[0,1.5,5,0,1,0],embers:[0,2,6,0,2,0],fireflies:[0,1.6,7,0,1,0],magic:[0,1.4,4,0,1,0],rain:[0,2,9,0,2,0],snow:[0,2,9,0,2,0],dust:[0,1.6,8,0,1,0],leaves:[0,2.5,9,0,2,0],waterSplash:[0,1.2,4,0,.6,0],explosion:[0,3,10,0,2,0],portal:[0,1.5,5,0,1.4,0],trail:[0,1.5,5,0,1,0]};
    const at0={waterSplash:.35,explosion:.25};
    names.forEach((full,i)=>{const [n,at]=full.split('@'),day=['rain','snow','dust','leaves','waterSplash'].includes(n),scene=new T.Scene();scene.background=new T.Color(day?0x5a6878:0x05070d);
     const ground=new T.Mesh(new T.PlaneGeometry(80,80),new T.MeshStandardMaterial({color:day?0x4a5040:0x1b1e24,roughness:.95}));ground.rotation.x=-Math.PI/2;scene.add(ground,new T.HemisphereLight(day?0xc0d0e0:0x33405a,0x202020,day?1.2:.6));
     const cam=new T.PerspectiveCamera(50,W/H,.1,200),v=views[n];cam.position.set(v[0],v[1],v[2]);cam.lookAt(v[3],v[4],v[5]);
     const vfx=new KE.VFX(T,renderer,scene,{budget:1}),e=vfx.create(n,{ground:0}),steps=at?Math.max(1,Math.round(+at*30)):at0[n]?Math.round(at0[n]*30):120;
     for(let k=0;k<steps;k++){if(n==='trail')e.setPosition(Math.sin(k*.08)*1.6,1+Math.sin(k*.13)*.4,Math.cos(k*.08)*.8);vfx.update(1/30,cam);}
     renderer.render(scene,cam);g.drawImage(renderer.domElement,(i%cols)*W,Math.floor(i/cols)*H);g.fillStyle='#fff';g.fillText(full,(i%cols)*W+6,Math.floor(i/cols)*H+14);vfx.dispose();ground.geometry.dispose();ground.material.dispose();});
    renderer.dispose();});
   await page.screenshot({path:path.join(outDir,'vfx-presets.png'),timeout:120000});
  });
 }

 await close();
 if(failed){console.log(failed+' test(s) failed');process.exit(1);}
 console.log('all vfx tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
