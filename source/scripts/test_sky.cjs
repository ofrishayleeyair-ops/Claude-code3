/* Browser checks for KE.SkyAtmosphere (12-sky.js) together with KE.Pipeline:
   cube capture, PMREM sky light, sun colour through the day, night moonlight, cloud quality levels.
   node scripts/test_sky.cjs [--shots] */
const {openPage}=require('./harness.cjs');const path=require('path');const shots=process.argv.includes('--shots');
(async()=>{
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/10-pipeline.js','src/modules/12-sky.js'],atlas:true,viewport:{width:800,height:500},name:'sky'});
 await page.evaluate(async()=>{
  const T=THREE,KE=KitsuneEngine;await KE.loadVisualAssets();KE.applyPreset('high');KE.setSettings({clouds:1});
  const renderer=new T.WebGLRenderer();renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;document.body.append(renderer.domElement);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(60,innerWidth/innerHeight,.15,600);camera.position.set(30,7,70);camera.lookAt(52,6,30);KE.prepareCamera(camera);
  const sun=new T.DirectionalLight(0xffffff,3);sun.castShadow=true;Object.assign(sun.shadow.camera,{left:-50,right:50,top:50,bottom:-50,near:1,far:300});sun.shadow.mapSize.set(1024,1024);sun.shadow.bias=-.0005;scene.add(sun,sun.target);
  const hemi=new T.HemisphereLight(0xffffff,0x444444,.25);scene.add(hemi);
  const tex=KE.materials(T,256),mat=KE.splatMaterial(T,tex,{scale:.36});const h=(x,z)=>1.5+Math.sin(x*.12)*Math.cos(z*.1)*3-Math.max(0,Math.hypot(x-48,z-48)-32)*.4;
  const land=KE.terrain(T,{w:97,h:97,sub:1,chunk:48,height:h,weights:(x,z)=>{const y=h(x,z);return [y>.8?1:0,y<=.8?1:0,0,0,0,0,0,0];},material:mat});land.forEach(m=>scene.add(m));
  const red=new T.MeshStandardMaterial({color:new T.Color(0xb84a2a).convertSRGBToLinear(),roughness:.5}),white=new T.MeshStandardMaterial({color:0xdddddd,roughness:.35,metalness:.0});
  for(let i=0;i<5;i++){const b=new T.Mesh(new T.BoxGeometry(1.4,5+i*1.2,1.4),red);b.position.set(44+i*3.2,land.heightAt(44+i*3.2,40)+2.5+i*.6,40);b.castShadow=b.receiveShadow=true;scene.add(b);}
  const ball=new T.Mesh(new T.SphereGeometry(2,48,32),white);ball.position.set(52,land.heightAt(52,48)+2,48);ball.castShadow=true;scene.add(ball);
  const sky=new KE.SkyAtmosphere(T,renderer,scene,{sun,hemi,time:.2});
  const pipeline=new KE.Pipeline(T,renderer,{sun});
  window.t={T,KE,renderer,scene,camera,sun,sky,pipeline,frames(n,dt=1/30){for(let i=0;i<n;i++){sky.update(dt,camera);pipeline.fog=null;pipeline.options.fog.color.copy(sky.fogColor);pipeline.render(scene,camera,dt);}}};
 });
 const test=async(name,fn)=>{await fn();console.log('PASS '+name);};
 const shot=async n=>{if(shots)await page.screenshot({path:path.join(outDir,'sky-'+n+'.png')});};
 await test('sky builds background cube and PMREM environment',async()=>{const r=await page.evaluate(()=>{t.frames(8);return {bg:t.scene.background===t.sky.cube.texture,env:!!t.scene.environment&&t.scene.environment===t.sky.environment};});if(!r.bg||!r.env)throw Error(JSON.stringify(r));});
 for(const [name,time] of [['morning',.06],['noon',.33],['sunset',.63],['night',.83]])
  await test('time of day '+name,async()=>{const r=await page.evaluate(time=>{t.sky.setTime(time);t.sky.refresh();t.frames(12);return {i:t.sun.intensity,c:t.sun.color.toArray(),fog:t.sky.fogColor.toArray(),night:t.sky.night};},time);
   if(name==='noon'&&!(r.i>3&&r.c[2]>.6))throw Error('noon sun '+JSON.stringify(r));if(name==='sunset'&&!(r.c[0]>r.c[2]*1.5))throw Error('sunset should be warm '+JSON.stringify(r));if(name==='night'&&!(r.night>.9&&r.i<.5))throw Error('night '+JSON.stringify(r));await shot(name);console.log('  ',name,JSON.stringify(r));});
 await test('rich clouds and overcast weather render',async()=>{await page.evaluate(()=>{t.KE.setSettings({clouds:2});t.sky.setTime(.25);t.sky.setWeather({coverage:.62});t.sky.refresh();t.frames(8);});await shot('overcast');await page.evaluate(()=>{t.sky.setWeather({coverage:.42});t.KE.setSettings({clouds:1});});});
 await test('looking up at clouds',async()=>{await page.evaluate(()=>{t.sky.setTime(.2);t.sky.refresh();t.camera.lookAt(t.camera.position.x+10,t.camera.position.y+8,t.camera.position.z-20);t.frames(10);});await shot('clouds');});
 await test('dispose clears background and environment',async()=>{const r=await page.evaluate(()=>{t.sky.dispose();return {bg:t.scene.background,env:t.scene.environment};});if(r.bg||r.env)throw Error('not cleared');});
 await close();
})().catch(e=>{console.error(e);process.exit(1);});
