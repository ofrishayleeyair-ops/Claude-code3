/* Browser checks for KE.ProbeVolume (18-gi.js): SH capture, interior darkening, colour bleeding, hooks.
   node scripts/test_gi.cjs [--shots] */
const {openPage}=require('./harness.cjs');const path=require('path');const shots=process.argv.includes('--shots');
(async()=>{
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/10-pipeline.js','src/modules/12-sky.js','src/modules/14-shadows.js','src/modules/18-gi.js'],viewport:{width:800,height:500},name:'gi'});
 await page.evaluate(()=>{
  const T=THREE,KE=KitsuneEngine;KE.applyPreset('high');KE.setSettings({clouds:0});
  const renderer=new T.WebGLRenderer();renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;document.body.append(renderer.domElement);
  const scene=new T.Scene(),camera=new T.PerspectiveCamera(60,innerWidth/innerHeight,.1,300);camera.position.set(0,2.2,9);camera.lookAt(0,1.2,0);KE.prepareCamera(camera);
  const sun=new T.DirectionalLight(0xffffff,3);scene.add(sun,sun.target);
  const std=(c,r=.9)=>new T.MeshStandardMaterial({color:new T.Color(c).convertSRGBToLinear(),roughness:r});
  const add=(g,m,x,y,z)=>{const o=new T.Mesh(g,m);o.position.set(x,y,z);o.castShadow=o.receiveShadow=true;scene.add(o);return o;};
  add(new T.BoxGeometry(60,.2,60),std(0xbfbfb8),0,-.1,0);
  // A room open toward +z: back wall, roof, a red left wall and a white right wall.
  add(new T.BoxGeometry(6,3,.2),std(0xdddddd),0,1.5,-3);add(new T.BoxGeometry(6.4,.2,6.4),std(0xdddddd),0,3.1,0);
  window.redWall=add(new T.BoxGeometry(.2,3,6),std(0xd02010),-3,1.5,0);add(new T.BoxGeometry(.2,3,6),std(0xdddddd),3,1.5,0);
  add(new T.BoxGeometry(1,1,1),std(0xeeeeee),.5,.5,-.5);
  const sky=new KE.SkyAtmosphere(T,renderer,scene,{sun,time:.3});sky.setSunDirection(new T.Vector3(.35,.55,.75));
  const csm=new KE.CascadedShadows(T,scene,{sun,cascades:2,mapSize:1024,maxFar:60});csm.setupScene();
  const gi=new KE.ProbeVolume(T,renderer,scene,{bounds:new T.Box3(new T.Vector3(-6,.4,-5),new T.Vector3(6,4.4,7)),spacing:1.5,faceSize:16});gi.tag(scene);gi.setupScene();
  const pipeline=new KE.Pipeline(T,renderer,{sun,fog:{enabled:false}});
  const probeFloor=()=>{};
  window.t={T,KE,renderer,scene,camera,sun,sky,csm,gi,pipeline,frame(n=1){for(let i=0;i<n;i++){sky.update(1/30,camera);csm.update(camera);gi.update(camera);pipeline.render(scene,camera,1/30);}},
   // mean colour of a screen rectangle (normalised coordinates)
   at(x,y,z,r=.025){const v=new T.Vector3(x,y,z).project(camera);const u=v.x*.5+.5,w=v.y*.5+.5;return this.sample(u-r,w-r,u+r,w+r);},
   sample(x0,y0,x1,y1){const gl=renderer.getContext(),W=gl.drawingBufferWidth,H=gl.drawingBufferHeight,px=new Uint8Array(W*H*4);gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,px);let r=0,g=0,b=0,n=0;for(let y=Math.floor(y0*H);y<y1*H;y++)for(let x=Math.floor(x0*W);x<x1*W;x++){const i=(y*W+x)*4;r+=px[i];g+=px[i+1];b+=px[i+2];n++;}return [r/n,g/n,b/n];}};
 });
 const test=async(name,fn)=>{await fn();console.log('PASS '+name);};const shot=async n=>{if(shots)await page.screenshot({path:path.join(outDir,'gi-'+n+'.png')});};
 await test('probe volume layout and materials',async()=>{const r=await page.evaluate(()=>({probes:t.gi.probes.length,materials:t.gi.materials.size,atlas:[t.gi.atlas.width,t.gi.atlas.height]}));if(r.probes<50||r.materials<5)throw Error(JSON.stringify(r));console.log('  ',JSON.stringify(r));});
 // Interior back-wall region and the floor strip next to the red wall, before and after GI converges.
 const measure=()=>page.evaluate(()=>{t.frame(3);return {inside:t.at(-1.2,2.2,-2.88),floorLeft:t.at(-2.5,.02,-1.2)};});
 await test('GI darkens the interior and bleeds red onto the floor',async()=>{
  const off=await page.evaluate(()=>{t.KE.setSettings({gi:false});t.frame(4);return null;});const a=await measure();await shot('off');
  await page.evaluate(()=>{t.KE.setSettings({gi:true});t.gi.bake(t.camera);t.gi.bake(t.camera);t.frame(6);});const b=await measure();await shot('on');
  const lum=c=>c[0]*.2126+c[1]*.7152+c[2]*.0722,redness=c=>c[0]/Math.max(1,(c[1]+c[2])/2);
  console.log('  ',JSON.stringify({off:a,on:b}));
  if(!(lum(b.inside)<lum(a.inside)*.97))throw Error('interior not darker with GI');if(!(redness(b.floorLeft)>redness(a.floorLeft)*1.02))throw Error('no red bleeding');});
 // Probes outside the room see sunlit ground; without the Chebyshev test they leak that light through the walls.
 await test('probe visibility reduces light leaking through walls',async()=>{
  const r=await page.evaluate(()=>{const u=t.gi.uniforms.keProbeVisOn,pt=()=>{t.pipeline.resetHistory();t.frame(3);return t.at(-2.2,1.6,-2.88);};u.value=0;const off=pt();u.value=1;const on=pt();return {off,on};});
  const lum=c=>c[0]*.2126+c[1]*.7152+c[2]*.0722;console.log('  ',JSON.stringify(r));
  if(!(lum(r.on)<lum(r.off)))throw Error('visibility did not reduce leaking');});
 await test('progress and incremental updates',async()=>{const r=await page.evaluate(()=>{const n=t.gi.update(t.camera,3);return {n,progress:t.gi.progress};});if(r.n!==3||r.progress<.99)throw Error(JSON.stringify(r));});
 await test('dispose restores material hooks',async()=>{const r=await page.evaluate(()=>{t.gi.dispose();t.frame(1);return window.redWall.material.customProgramCacheKey();});if(String(r).includes('ke-gi'))throw Error(r);});
 await close();
})().catch(e=>{console.error(e);process.exit(1);});
