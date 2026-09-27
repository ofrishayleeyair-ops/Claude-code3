/* Browser checks for KE.Pipeline (10-pipeline.js): every pass compiles and renders, debug views,
   history/exposure behaviour, resize handling, settings mapping and disposal.
   node scripts/test_pipeline.cjs [--shots]  (screenshots go to .test-output/pipeline-*.png) */
const {openPage}=require('./harness.cjs');const path=require('path');
const shots=process.argv.includes('--shots');
(async()=>{
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/10-pipeline.js'],atlas:true,viewport:{width:800,height:500},name:'pipeline'});
 await page.evaluate(async()=>{
  const T=THREE,KE=KitsuneEngine;await KE.loadVisualAssets();
  const renderer=new T.WebGLRenderer({antialias:false});renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;document.body.append(renderer.domElement);
  const scene=new T.Scene();scene.background=new T.Color(0x9ec4e0);scene.environment=KE.environment(T);scene.fog=new T.Fog(0x9ec4e0,30,120);
  const camera=new T.PerspectiveCamera(55,innerWidth/innerHeight,.15,400);camera.position.set(34,9,58);camera.lookAt(48,3,40);KE.prepareCamera(camera);
  const sun=new T.DirectionalLight(0xfff1d6,3);sun.position.set(80,60,20);sun.target.position.set(48,0,40);sun.castShadow=true;Object.assign(sun.shadow.camera,{left:-40,right:40,top:40,bottom:-40,near:1,far:200});sun.shadow.mapSize.set(1024,1024);scene.add(sun,sun.target,new T.HemisphereLight(0xcfe6ff,0x4a5a3c,.6));
  const tex=KE.materials(T,256),mat=KE.splatMaterial(T,tex,{scale:.36});
  const h=(x,z)=>2+Math.sin(x*.15)*Math.cos(z*.12)*2.5-Math.max(0,Math.hypot(x-48,z-48)-30)*.4;
  const land=KE.terrain(T,{w:97,h:97,sub:1,chunk:48,height:h,weights:(x,z)=>{const y=h(x,z);return [y>1?1:0,y<=1?1:0,0,0,0,0,0,0];},material:mat});land.forEach(m=>scene.add(m));
  const red=new T.MeshStandardMaterial({color:0xb84a2a,roughness:.5}),gold=new T.MeshStandardMaterial({color:0xd9b25a,roughness:.25,metalness:1}),white=new T.MeshStandardMaterial({color:0xeeeeee,roughness:.9});
  const add=(g,m,x,z,y=0)=>{const o=new T.Mesh(g,m);o.position.set(x,land.heightAt(x,z)+y,z);o.castShadow=o.receiveShadow=true;scene.add(o);return o;};
  for(let i=0;i<6;i++)add(new T.BoxGeometry(1.2,4+i,1.2),red,40+i*3,38,2+i/2);
  add(new T.SphereGeometry(1.6,48,32),gold,50,46,1.6);add(new T.TorusKnotGeometry(1.2,.4,160,24),white,44,48,2.4);
  const emissive=new T.Mesh(new T.SphereGeometry(.5,24,16),new T.MeshStandardMaterial({color:0xffb060,emissive:0xff8a30,emissiveIntensity:12}));emissive.position.set(47,land.heightAt(47,42)+2,42);scene.add(emissive);
  // A translucent-layer plane that samples scene colour/depth (like water) to exercise the shared uniforms.
  const U=KE.sceneUniforms(T),wm=new T.ShaderMaterial({uniforms:{...U},transparent:true,vertexShader:'varying vec4 vClip;varying vec3 vView;void main(){vec4 mv=modelViewMatrix*vec4(position,1.);vView=mv.xyz;vClip=projectionMatrix*mv;gl_Position=vClip;}',
    fragmentShader:KE.GLSL_SCENE_DECL+'varying vec4 vClip;varying vec3 vView;void main(){vec2 uv=vClip.xy/vClip.w*.5+.5;float depth=texture2D(keSceneDepth,uv).r+vView.z;vec3 below=texture2D(keSceneColor,uv+vec2(sin(uv.y*80.+keTime)*.003,0.)).rgb;float a=keHasScene>.5?clamp(depth*.35,0.,1.):.5;gl_FragColor=vec4(mix(below,vec3(.05,.25,.3),a*.8),1.);}'});
  const water=new T.Mesh(new T.PlaneGeometry(200,200),wm);water.rotation.x=-Math.PI/2;water.position.set(48,.4,48);water.layers.set(KE.LAYERS.TRANSLUCENT);scene.add(water);
  KE.applyPreset('ultra');
  const pipeline=new KE.Pipeline(T,renderer,{sun,fog:{color:new T.Color(.6,.72,.85),density:.01}});
  window.t={T,KE,renderer,scene,camera,sun,pipeline,water,U,emissive};
 });
 const results={};const shot=async name=>{if(shots)await page.screenshot({path:path.join(outDir,'pipeline-'+name+'.png')});};
 const frames=async(n,fn='')=>page.evaluate(([n,fn])=>{for(let i=0;i<n;i++){if(fn)eval(fn);t.pipeline.render(t.scene,t.camera,1/60);}return t.pipeline.stats;},[n,fn]);
 const test=async(name,fn)=>{await fn();console.log('PASS '+name);};
 await test('ultra pipeline renders all passes without errors',async()=>{const s=await frames(12);if(s.passes<20)throw Error('too few passes '+s.passes);results.passes=s.passes;await shot('ultra');});
 await test('scene uniforms are published for translucent materials',async()=>{const r=await page.evaluate(()=>({has:t.U.keHasScene.value,color:!!t.U.keSceneColor.value,depth:!!t.U.keSceneDepth.value,res:t.U.keResolution.value.toArray()}));if(!r.has||!r.color||!r.depth||r.res[0]<10)throw Error(JSON.stringify(r));});
 await test('camera projection is restored after jitter',async()=>{const r=await page.evaluate(()=>{const a=t.camera.projectionMatrix.clone();t.pipeline.render(t.scene,t.camera,1/60);return {same:t.camera.projectionMatrix.equals(a),view:!!(t.camera.view&&t.camera.view.enabled),mask:t.camera.layers.mask,bg:!!t.scene.background,fog:!!t.scene.fog};});if(!r.same||r.view||r.mask!==3||!r.bg||!r.fog)throw Error(JSON.stringify(r));});
 await test('output is sane (not black, not saturated)',async()=>{const r=await page.evaluate(()=>{const gl=t.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;t.renderer.setRenderTarget(null);t.pipeline.render(t.scene,t.camera,1/60);const px=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);let s=0,sat=0,n=0;for(let i=0;i<px.length;i+=4*97){const l=(px[i]+px[i+1]+px[i+2])/3;s+=l;if(l>=250)sat++;n++;}return {mean:s/n,sat:sat/n};});results.luma=r;if(r.mean<40||r.mean>220||r.sat>.2)throw Error(JSON.stringify(r));});
 for(const view of ['ao','depth','bloom','raw','lighting','localexposure']) await test('debug view '+view,async()=>{await page.evaluate(v=>{KitsuneEngine.cvars.set('r.ViewMode',v);},view);await frames(2);await shot('view-'+view);});
 await page.evaluate(()=>KitsuneEngine.cvars.set('r.ViewMode','lit'));
 await test('local exposure compresses scene contrast',async()=>{const r=await page.evaluate(()=>{const gl=t.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight;
   const spread=on=>{t.KE.cvars.set('r.LocalExposure',on?1:0);for(let i=0;i<4;i++)t.pipeline.render(t.scene,t.camera,1/60);const px=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);const L=[];for(let i=0;i<px.length;i+=4*53)L.push(px[i]*.2126+px[i+1]*.7152+px[i+2]*.0722);L.sort((a,b)=>a-b);return {p10:L[Math.floor(L.length*.1)],p90:L[Math.floor(L.length*.9)]};};
   const off=spread(false),on=spread(true);return {off,on};});results.localExposure=r;
  if(!(r.on.p90-r.on.p10<r.off.p90-r.off.p10))throw Error('contrast not reduced '+JSON.stringify(r));});
 await test('auto exposure adapts to brightness changes',async()=>{const r=await page.evaluate(()=>{const read=()=>{const gl=t.renderer.getContext();const px=new Float32Array(4);t.renderer.readRenderTargetPixels(t.pipeline.adapt[t.pipeline.frame&1],0,0,1,1,px);return px[0];};for(let i=0;i<30;i++)t.pipeline.render(t.scene,t.camera,.1);const a=read();t.sun.intensity*=8;for(let i=0;i<30;i++)t.pipeline.render(t.scene,t.camera,.1);const b=read();t.sun.intensity/=8;for(let i=0;i<30;i++)t.pipeline.render(t.scene,t.camera,.1);return {a,b};});if(!(r.b>r.a+1))throw Error('log luminance did not rise: '+JSON.stringify(r));results.exposure=r;});
 await test('each quality preset renders',async()=>{for(const p of ['low','medium','high','ultra','cinematic']){await page.evaluate(p=>t.KE.applyPreset(p),p);await frames(3);}await shot('cinematic');await page.evaluate(()=>t.KE.applyPreset('ultra'));});
 await test('temporal upscaling renders at a reduced internal resolution',async()=>{const r=await page.evaluate(()=>{t.KE.setSettings({upscale:.5});for(let i=0;i<16;i++)t.pipeline.render(t.scene,t.camera,1/60);const gl=t.renderer.getContext(),w=gl.drawingBufferWidth,h=gl.drawingBufferHeight,px=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);let s=0,n=0;for(let i=0;i<px.length;i+=4*97){s+=(px[i]+px[i+1]+px[i+2])/3;n++;}
   const out={size:t.pipeline.size,internal:t.pipeline.internal,mean:s/n};t.KE.setSettings({upscale:1});t.pipeline.render(t.scene,t.camera,1/60);out.native=t.pipeline.internal;return out;});
   if(r.internal[0]!==Math.round(r.size[0]*.5)||r.native[0]!==r.size[0]||r.mean<40)throw Error(JSON.stringify(r));await shot('upscale50');});
 await test('pipeline disabled falls back to direct rendering',async()=>{const r=await page.evaluate(()=>{t.KE.setSettings({pipeline:false});t.pipeline.render(t.scene,t.camera,1/60);const e=t.pipeline.enabled;t.KE.setSettings({pipeline:true});return e;});if(r)throw Error('still enabled');});
 await test('resize rebuilds targets',async()=>{await page.setViewportSize({width:390,height:700});const r=await page.evaluate(()=>{t.renderer.setSize(innerWidth,innerHeight);t.camera.aspect=innerWidth/innerHeight;t.camera.updateProjectionMatrix();t.pipeline.render(t.scene,t.camera,1/60);return t.pipeline.size;});if(r[0]!==390)throw Error(JSON.stringify(r));await frames(8);await shot('mobile');await page.setViewportSize({width:800,height:500});await page.evaluate(()=>{t.renderer.setSize(innerWidth,innerHeight);t.camera.aspect=innerWidth/innerHeight;t.camera.updateProjectionMatrix();});await frames(4);});
 await test('dispose releases render targets and programs',async()=>{const r=await page.evaluate(()=>{const before=t.renderer.info.memory.textures;t.pipeline.dispose();return {before,after:t.renderer.info.memory.textures,has:t.U.keHasScene.value};});if(r.after>=r.before||r.has!==0)throw Error(JSON.stringify(r));results.textures=r;});
 console.log(JSON.stringify(results));await close();
})().catch(e=>{console.error(e);process.exit(1);});
