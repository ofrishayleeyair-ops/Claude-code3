/* Browser checks for KE.SurfaceWeather (26-weather.js): wet darkening and gloss, puddles with ripples, snow, ramps, hooks.
   node scripts/test_weather.cjs [--shots] */
const {openPage}=require('./harness.cjs');const path=require('path');const shots=process.argv.includes('--shots');
(async()=>{
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/12-sky.js','src/modules/14-shadows.js','src/modules/26-weather.js'],viewport:{width:640,height:400},name:'weather'});
 await page.evaluate(()=>{
  const T=THREE,KE=KitsuneEngine;KE.applyPreset('high');KE.setSettings({clouds:0});
  const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;document.body.append(renderer.domElement);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(55,innerWidth/innerHeight,.1,300);camera.position.set(0,2.2,8);camera.lookAt(0,.4,-2);
  const sun=new T.DirectionalLight(0xffffff,3);scene.add(sun,sun.target);
  const std=(c,r=.85,m=0)=>new T.MeshStandardMaterial({color:new T.Color(c).convertSRGBToLinear(),roughness:r,metalness:m});
  const add=(g,mat,x,y,z)=>{const o=new T.Mesh(g,mat);o.position.set(x,y,z);o.castShadow=o.receiveShadow=true;scene.add(o);return o;};
  // Gently undulating ground so puddles only form on the flatter parts.
  const gg=new T.PlaneGeometry(80,80,160,160);gg.rotateX(-Math.PI/2);const p=gg.attributes.position;for(let i=0;i<p.count;i++){const x=p.getX(i),z=p.getZ(i);p.setY(i,Math.sin(x*.45)*Math.cos(z*.38)*.35);}gg.computeVertexNormals();
  window.ground=add(gg,std(0x8a7358,.9),0,0,0);
  add(new T.BoxGeometry(1.4,1.4,1.4),std(0xb0aca4,.7),-2.2,.9,-1);add(new T.SphereGeometry(.8,48,24),std(0xd8d8e0,.25,1),1.8,.9,-.5);
  const glazed=std(0x2a5a9a,.3);glazed.userData.kePorosity=0;add(new T.CylinderGeometry(.5,.5,1.6,32),glazed,.2,.9,-3);
  const sky=new KE.SkyAtmosphere(T,renderer,scene,{sun,time:.3});sky.setSunDirection(new T.Vector3(.85,.5,.15));renderer.toneMappingExposure=.55;
  const csm=new KE.CascadedShadows(T,scene,{sun,cascades:2,mapSize:1024,maxFar:40});csm.setupScene();
  const wx=new KE.SurfaceWeather(T,{puddleScale:.22});wx.setupScene(scene);
  window.t={T,KE,renderer,scene,camera,sky,csm,wx,frame(n=1,dt=1/30){for(let i=0;i<n;i++){sky.update(dt,camera);csm.update(camera);wx.update(dt);renderer.render(scene,camera);}},
   at(x,y,z,r=.03){const v=new T.Vector3(x,y,z).project(camera);const u=v.x*.5+.5,w=v.y*.5+.5;return this.sample(u-r,w-r,u+r,w+r);},
   sample(x0,y0,x1,y1){const gl=renderer.getContext(),W=gl.drawingBufferWidth,H=gl.drawingBufferHeight,px=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);let r=0,g=0,b=0,n=0;
    for(let y=Math.max(0,Math.floor(y0*H));y<Math.min(H,y1*H);y++)for(let x=Math.max(0,Math.floor(x0*W));x<Math.min(W,x1*W);x++){const i=(y*W+x)*4;r+=px[i];g+=px[i+1];b+=px[i+2];n++;}return [r/n,g/n,b/n];}};
  sky.refresh();t.frame(4);
 });
 const test=async(name,fn)=>{await fn();console.log('PASS '+name);};const shot=async n=>{if(shots)await page.screenshot({path:path.join(outDir,'weather-'+n+'.png'),timeout:240000});};
 const lum=c=>c[0]*.2126+c[1]*.7152+c[2]*.0722;
 await test('materials patched (transparent and opted-out skipped)',async()=>{const r=await page.evaluate(()=>{const m=new t.T.MeshStandardMaterial({transparent:true});const o=new t.T.MeshStandardMaterial();o.userData.keNoWeather=true;t.wx.setupMaterial(m);t.wx.setupMaterial(o);return {n:t.wx.materials.size,key:window.ground.material.customProgramCacheKey()};});
  if(r.n!==4||!String(r.key).includes('ke-wx'))throw Error(JSON.stringify(r));});
 // Ground in front of the objects (diffuse, away from the sun glint) and an upward-facing box top.
 const measure=()=>page.evaluate(()=>{t.frame(2);return {ground:t.at(-3.2,.05,2.2),glint:t.at(0,0,-8,.05),boxTop:t.at(-2.2,1.6,-1,.015),boxSide:t.at(-2.2,.9,-.28,.015),glazed:t.at(.2,.9,-2.5,.012)};});
 let dry;
 await test('dry baseline renders',async()=>{dry=await measure();await shot('dry');console.log('  ',JSON.stringify(dry));if(!(lum(dry.ground)>20))throw Error('scene too dark');});
 await test('wet surfaces darken; sealed materials do not',async()=>{const w=await page.evaluate(()=>{t.wx.set({wetness:1,puddles:0,rain:0});return null;});const r=await measure();console.log('  ',JSON.stringify(r));
  if(!(lum(r.ground)<lum(dry.ground)*.9))throw Error('wet ground not darker');if(!(Math.abs(lum(r.glazed)-lum(dry.glazed))<lum(dry.glazed)*.12))throw Error('glazed (porosity 0) changed too much');});
 await test('puddles with rain ripples reflect the sky',async()=>{const r=await page.evaluate(()=>{t.wx.set({wetness:1,puddles:1,rain:1});t.frame(2);
   // variance of the ground region: mirror-like puddles against rough wet soil raise contrast
   const gl=t.renderer.getContext(),W=gl.drawingBufferWidth,H=gl.drawingBufferHeight,px=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);
   const stats=()=>{let s=0,s2=0,n=0;for(let y=0;y<H*.35;y++)for(let x=0;x<W;x++){const i=(y*W+x)*4,l=px[i]*.2126+px[i+1]*.7152+px[i+2]*.0722;s+=l;s2+=l*l;n++;}const m=s/n;return {mean:m,sd:Math.sqrt(Math.max(0,s2/n-m*m))};};
   const on=stats();t.wx.set({puddles:0});t.frame(2);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);const off=stats();t.wx.set({puddles:1});t.frame(2);return {on,off};});
  await shot('rain');console.log('  ',JSON.stringify(r));if(!(r.on.sd>r.off.sd*1.1))throw Error('puddles did not add reflective contrast');});
 await test('snow whitens upward faces only',async()=>{const r=await page.evaluate(()=>{t.wx.set({wetness:0,puddles:0,rain:0,snow:1});return null;});const s=await measure();await shot('snow');console.log('  ',JSON.stringify(s));
  if(!(lum(s.boxTop)>lum(dry.boxTop)*1.15))throw Error('box top not snowy');if(!(Math.abs(lum(s.boxSide)-lum(dry.boxSide))<Math.max(8,lum(dry.boxSide)*.2)))throw Error('vertical side changed too much');
  const sat=c=>Math.max(...c)-Math.min(...c);if(!(sat(s.ground)<sat(dry.ground)))throw Error('ground not whiter');});
 await test('update() wets in rain, fills puddles later, dries and melts',async()=>{const r=await page.evaluate(()=>{const w=t.wx;w.set({wetness:0,puddles:0,snow:.5,rain:0});const log=[];
   for(let i=0;i<40;i++){w.update(.5,{raining:true});if(i===9)log.push({w:w.wetness,p:w.puddles});}const wet={w:w.wetness,p:w.puddles,rain:w.rain};w.update(.5,{raining:false,snowing:false});const after1={w:w.wetness,p:w.puddles};
   for(let i=0;i<400;i++)w.update(.5,{raining:false,snowing:false});return {early:log[0],wet,after1,dry:{w:w.wetness,p:w.puddles,s:w.snow}};});
  console.log('  ',JSON.stringify(r));if(!(r.early.w>.3&&r.early.p<r.early.w))throw Error('wetting order wrong');if(!(r.wet.w>.99&&r.wet.p>.2&&r.wet.rain>.9))throw Error('rain did not wet/fill');
  if(!(r.after1.w<r.wet.w))throw Error('not drying');if(!(r.dry.w<.01&&r.dry.p<.01&&r.dry.s<.01))throw Error('did not fully dry/melt');});
 await test('dispose restores material hooks',async()=>{const r=await page.evaluate(()=>{t.wx.dispose();t.frame(1);return window.ground.material.customProgramCacheKey();});if(String(r).includes('ke-wx'))throw Error(r);});
 await close();
})().catch(e=>{console.error(e);process.exit(1);});
