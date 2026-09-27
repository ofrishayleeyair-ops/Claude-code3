/* Browser checks for KE.CascadedShadows (14-shadows.js) and KE.LightPool (16-lights.js).
   node scripts/test_shadows.cjs [--shots] */
const {openPage}=require('./harness.cjs');const path=require('path');const shots=process.argv.includes('--shots');
(async()=>{
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/10-pipeline.js','src/modules/14-shadows.js','src/modules/16-lights.js'],viewport:{width:800,height:500},name:'shadows'});
 await page.evaluate(()=>{
  const T=THREE,KE=KitsuneEngine;KE.applyPreset('high');
  const renderer=new T.WebGLRenderer();renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;document.body.append(renderer.domElement);
  const scene=new T.Scene();scene.background=new T.Color(0x8fb4d8);const camera=new T.PerspectiveCamera(60,innerWidth/innerHeight,.1,150);camera.position.set(0,2.2,6);camera.lookAt(0,1,-20);
  const sun=new T.DirectionalLight(0xfff0dd,3);sun.position.set(30,40,20);sun.target.position.set(0,0,0);scene.add(sun,sun.target,new T.HemisphereLight(0xbfd8ff,0x404030,.5));
  const ground=new T.Mesh(new T.PlaneGeometry(400,400),new T.MeshStandardMaterial({color:0x9a9a88,roughness:1}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
  const colMat=new T.MeshStandardMaterial({color:0xc06040,roughness:.7});
  for(let z=4;z>-120;z-=5)for(const x of [-4,4]){const c=new T.Mesh(new T.BoxGeometry(.8,3,.8),colMat);c.position.set(x,1.5,z);c.castShadow=c.receiveShadow=true;scene.add(c);}
  const lamb=new T.Mesh(new T.SphereGeometry(.7,24,16),new T.MeshLambertMaterial({color:0xffffff}));lamb.position.set(1.5,.7,0);lamb.castShadow=lamb.receiveShadow=true;scene.add(lamb);
  const csm=new KE.CascadedShadows(T,scene,{sun,cascades:3,mapSize:1024,maxFar:120});csm.setupScene();
  // many lanterns
  const lights=new KE.LightPool(T,scene,{max:4});const ids=[];for(let z=2;z>-120;z-=3)ids.push(lights.add({position:[0,.6,z],color:0xffa050,intensity:3,distance:6,flicker:.15}));
  window.t={T,KE,renderer,scene,camera,sun,csm,lights,ids,ground,frame(dt=1/60){csm.update(camera);lights.update(dt,camera);renderer.render(scene,camera);}};
 });
 const test=async(name,fn)=>{await fn();console.log('PASS '+name);};const shot=async n=>{if(shots)await page.screenshot({path:path.join(outDir,'shadows-'+n+'.png')});};
 await test('cascades compile and render',async()=>{const r=await page.evaluate(()=>{for(let i=0;i<3;i++)t.frame();return {lights:t.csm.lights.length,splits:t.csm.splits.map(v=>+v.toFixed(2)),programs:t.renderer.info.programs.length};});if(r.lights!==3||r.splits.length!==4)throw Error(JSON.stringify(r));console.log('  ',JSON.stringify(r));await shot('near');});
 const bands=async()=>page.evaluate(()=>{const gl=t.renderer.getContext(),W=gl.drawingBufferWidth,H=gl.drawingBufferHeight;const grab=()=>{t.frame();const b=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,b);return b;};
   const toggle=v=>{t.renderer.shadowMap.enabled=v;t.scene.traverse(o=>{if(o.material)[o.material].flat().forEach(m=>m.needsUpdate=true);});};
   const on=grab();toggle(false);const off=grab();toggle(true);t.frame();
   // bands by projected depth of the ground: rows near the bottom are near, rows just below the horizon are far
   const horizon=new t.T.Vector3(0,0,-500).project(t.camera),hy=Math.round((horizon.y*.5+.5)*H),out={near:0,mid:0,far:0,beyond:0};
   const rowFor=z=>Math.round((new t.T.Vector3(0,0,z).project(t.camera).y*.5+.5)*H);const r1=rowFor(-8),r2=rowFor(-35),r3=rowFor(-110),r4=rowFor(-140);
   for(let y=0;y<hy;y++)for(let x=0;x<W;x+=2){const i=(y*W+x)*4,a=on[i]+on[i+1]+on[i+2],b=off[i]+off[i+1]+off[i+2];if(b>60&&a<b*.75){if(y<r1)out.near++;else if(y<r2)out.mid++;else if(y<r3)out.far++;else if(y>r4&&y<hy-1)out.beyond++;}}
   return out;});
 await test('shadows appear in near, middle and far cascades but not beyond the shadow distance',async()=>{const r=await bands();console.log('  ',JSON.stringify(r));if(!(r.near>200&&r.mid>60&&r.far>3))throw Error('missing cascade shadows '+JSON.stringify(r));if(r.beyond>r.far)throw Error('shadows past distance '+JSON.stringify(r));});
 await test('light pool keeps a fixed real-light count and no recompiles',async()=>{const r=await page.evaluate(()=>{t.frame();const p0=t.renderer.info.programs.length;const zs=[];for(let i=0;i<120;i++){t.camera.position.z-=.5;t.frame(1/30);}const active=t.lights.real.filter(r=>r.light.intensity>0.01).length;return {p0,p1:t.renderer.info.programs.length,active,real:t.lights.real.length,virtual:t.lights.count};});
   if(r.p1!==r.p0||r.active<1||r.active>4||r.real!==4)throw Error(JSON.stringify(r));console.log('  ',JSON.stringify(r));});
 await test('night view with pooled lanterns',async()=>{await page.evaluate(()=>{t.sun.intensity=.05;t.scene.background.set(0x05070d);t.scene.children.filter(o=>o.isHemisphereLight).forEach(h=>h.intensity=.05);for(let i=0;i<30;i++)t.frame(1/30);});await shot('night');});
 await test('settings resize the pool and cascade count',async()=>{const r=await page.evaluate(()=>{t.KE.setSettings({lights:8,cascades:4});t.frame();return {pool:t.lights.real.length,cascades:t.csm.lights.length};});if(r.pool!==8||r.cascades!==4)throw Error(JSON.stringify(r));});
 await test('dispose restores materials and removes lights',async()=>{const r=await page.evaluate(()=>{t.csm.dispose();t.lights.dispose();t.frame();let pl=0,dl=0;t.scene.traverse(o=>{if(o.isPointLight)pl++;if(o.isDirectionalLight)dl++;});return {pl,dl,def:'USE_KE_CSM' in t.ground.material.defines};});if(r.pl!==0||r.dl!==1||r.def)throw Error(JSON.stringify(r));});
 await close();
})().catch(e=>{console.error(e);process.exit(1);});
