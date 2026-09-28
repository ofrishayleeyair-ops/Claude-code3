/* Browser checks for KE.Water (22-water.js) with KE.Pipeline and KE.SkyAtmosphere.
   node scripts/test_water.cjs [--shots] */
const {openPage}=require('./harness.cjs');const path=require('path');const shots=process.argv.includes('--shots');
(async()=>{
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/10-pipeline.js','src/modules/12-sky.js','src/modules/14-shadows.js','src/modules/22-water.js','src/modules/32-world.js'],atlas:true,viewport:{width:800,height:500},name:'water'});
 await page.evaluate(async()=>{
  const T=THREE,KE=KitsuneEngine;await KE.loadVisualAssets();KE.applyPreset('high');
  const renderer=new T.WebGLRenderer();renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;document.body.append(renderer.domElement);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(58,innerWidth/innerHeight,.1,600);camera.position.set(16,3.2,70);camera.lookAt(40,0,45);KE.prepareCamera(camera);
  const sun=new T.DirectionalLight(0xffffff,3);scene.add(sun,sun.target);
  const tex=KE.materials(T,256),mat=KE.splatMaterial(T,tex,{scale:.36});const h=(x,z)=>{const d=Math.hypot(x-48,z-48);return 3.2-d*.11+Math.sin(x*.2)*Math.cos(z*.17)*.8;};
  const land=KE.terrain(T,{w:97,h:97,sub:1,chunk:48,height:h,weights:(x,z)=>{const y=h(x,z);const s=Math.min(1,Math.max(0,(1.2-y)*1.5));return [1-s,s,0,0,0,0,0,0];},material:mat});land.forEach(m=>{m.castShadow=true;scene.add(m);});
  const rocks=new T.MeshStandardMaterial({color:0x8a8478,roughness:.85});for(let i=0;i<8;i++){const r=new T.Mesh(new T.IcosahedronGeometry(.8+i*.1,1),rocks);const x=22+i*3.5,z=58-i*1.2;r.position.set(x,h(x,z)-.2,z);r.castShadow=r.receiveShadow=true;scene.add(r);}
  const sky=new KE.SkyAtmosphere(T,renderer,scene,{sun,time:.14});const csm=new KE.CascadedShadows(T,scene,{sun,cascades:3,mapSize:1024,maxFar:100});csm.setupScene();
  const water=new KE.Water(T,scene,{level:0,sky,heightAt:h,bakedCenter:new T.Vector3(48,0,48),bakedSize:160});
  const pipeline=new KE.Pipeline(T,renderer,{sun});
  window.t={T,KE,renderer,scene,camera,sun,sky,water,pipeline,csm,frame(n=1,dt=1/30){for(let i=0;i<n;i++){sky.update(dt,camera);csm.update(camera);pipeline.options.fog.color.copy(sky.fogColor);water.update(dt,camera,{pipeline});pipeline.render(scene,camera,dt);}}};
 });
 const test=async(name,fn)=>{await fn();console.log('PASS '+name);};const shot=async n=>{if(shots)await page.screenshot({path:path.join(outDir,'water-'+n+'.png')});};
 await test('CPU wave queries are consistent',async()=>{const r=await page.evaluate(()=>{const w=t.water;let maxErr=0,maxH=0;for(let i=0;i<50;i++){const x0=Math.random()*80,z0=Math.random()*80,d=w.displacement(x0,z0,3.7).clone();const h=w.heightAt(x0+d.x,z0+d.z,3.7);maxErr=Math.max(maxErr,Math.abs(h-d.y));maxH=Math.max(maxH,Math.abs(h));}const n=w.normalAt(10,10,1);return {maxErr,maxH,ny:n.y};});
   if(r.maxErr>.01||r.maxH>1||r.ny<.5)throw Error(JSON.stringify(r));console.log('  ',JSON.stringify(r));});
 await test('water renders with pipeline (shoreline view)',async()=>{await page.evaluate(()=>t.frame(10));await shot('shore');});
 await test('rain ripples and sunset',async()=>{await page.evaluate(()=>{t.water.rain=1;t.sky.setTime(.6);t.sky.refresh();t.frame(10);t.water.rain=0;});await shot('sunset');});
 await test('underwater switches fog and restores it',async()=>{const r=await page.evaluate(()=>{t.sky.setTime(.2);t.sky.refresh();const d0=t.pipeline.options.fog.density;t.camera.position.set(20,-1.2,62);t.camera.lookAt(30,-.5,50);t.frame(6);const under=t.water.underwater,d1=t.pipeline.options.fog.density;t.KE.cvars;return {under,d0,d1};});
   await shot('underwater');const r2=await page.evaluate(()=>{t.camera.position.set(16,3.2,70);t.camera.lookAt(40,0,45);t.frame(3);return {under:t.water.underwater,d:t.pipeline.options.fog.density};});
   if(!r.under||!(r.d1>r.d0)||r2.under||r2.d!==r.d0)throw Error(JSON.stringify([r,r2]));});
 await test('fallback without pipeline renders with baked depth',async()=>{await page.evaluate(()=>{for(let i=0;i<3;i++){t.sky.update(1/30,t.camera);t.water.update(1/30,t.camera);t.renderer.render(t.scene,t.camera);}});await shot('direct');});
 await test('river: profile falls monotonically and stays below the ground; carve cuts a channel; queries agree',async()=>{const r=await page.evaluate(()=>{const {T,KE}=t;
   const hf=KE.Heightfield?null:null;const ground=(x,z)=>8+Math.sin(x*.05)*3+z*.05+Math.cos(z*.07)*2;
   const path=KE.River.profile([[10,10],[40,30],[70,20],[100,60]],ground,{width:[6,14],depth:[1.2,2],step:3,minSlope:.003,lateral:10});const P=path.pts;let mono=true,below=true;
   for(let i=1;i<P.length;i++)if(P[i].y>P[i-1].y-1e-6)mono=false;for(const p of P)if(p.y>ground(p.x,p.z)+1e-6)below=false;
   const S=65,field={size:S,spacing:2,originX:0,originZ:0,data:new Float32Array(S*S),masks:{flow:new Float32Array(S*S)},recomputeRange(){},version:0};for(let j=0;j<S;j++)for(let i=0;i<S;i++)field.data[j*S+i]=ground(i*2,j*2);
   const before=field.data.slice(),res=KE.River.carve(field,path,{bank:3,valley:20,valleySlope:.5});let deeper=0,raised=0,maxStep=0;for(let k=0;k<S*S;k++){if(field.data[k]<before[k]-.01)deeper++;if(field.data[k]>before[k]+.6)raised++;}
   for(let j=0;j<S;j++)for(let i=1;i<S;i++)maxStep=Math.max(maxStep,Math.abs(field.data[j*S+i]-field.data[j*S+i-1]));
   const river=new KE.River(T,t.scene,{profile:path,sky:t.sky});const mid=river.pointAt(river.length*.5),n=river.nearest(mid.x+mid.nx*1,mid.z+mid.nz*1),f=river.flowAt(mid.x,mid.z),edge=river.edgeDistance(mid.x+mid.nx*(mid.w*.5+5),mid.z+mid.nz*(mid.w*.5+5));
   t.frame(3);river.update(1/30);const inScene=!!t.scene.getObjectByName('ke-river');river.dispose();
   return {n:P.length,mono,below,deeper,raised,maxStep:+maxStep.toFixed(2),carved:res.carved,near:+n.d.toFixed(2),ny:+Math.abs(n.y-mid.y).toFixed(3),flow:+Math.hypot(f.x,f.z).toFixed(2),edge:+edge.toFixed(2),inScene,gone:!t.scene.getObjectByName('ke-river')};});
   if(!r.mono||!r.below||r.deeper<50||r.raised>0||r.maxStep>2.5||Math.abs(r.near-1)>.05||r.ny>.01||!(r.flow>0)||Math.abs(r.edge-5)>.3||!r.inScene||!r.gone)throw Error(JSON.stringify(r));console.log('  ',JSON.stringify(r));});
 await test('boat models: wasen and yakatabune build, float at their draft and dispose',async()=>{const r=await page.evaluate(()=>{const {T,KE}=t;const out=[];for(const style of ['wasen','yakatabune']){const b=KE.boatModel(T,{style,seed:3});t.scene.add(b.group);
   const box=new T.Box3().setFromObject(b.group);let meshes=0,lanterns=0;b.group.traverse(o=>{if(o.isMesh){meshes++;if(o.userData.lantern)lanterns++;}});out.push({style,len:+(box.max.x-box.min.x).toFixed(2),h:+(box.max.y-box.min.y).toFixed(2),draft:+b.draft.toFixed(2),meshes,lanterns});b.dispose();}
   t.frame(1);return out;});
   const [w,y]=r;if(!(w.len>4&&w.len<7&&w.meshes>=6&&y.len>8&&y.lanterns===4&&w.draft>0))throw Error(JSON.stringify(r));console.log('  ',JSON.stringify(r));});
 await test('dispose',async()=>{const r=await page.evaluate(()=>{t.water.dispose();return !!t.scene.getObjectByName('ke-water');});if(r)throw Error('mesh still in scene');});
 await close();
})().catch(e=>{console.error(e);process.exit(1);});
