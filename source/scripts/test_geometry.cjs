/* Browser checks for module 30 (geometry): simplification, LOD chains, LODMesh, InstancedLOD,
   impostors and VirtualGeometry (cluster DAG, per-cluster cut, crack check), plus rock-field screenshots.
   node scripts/test_geometry.cjs            (screenshots are always written to .test-output/geometry-*.png) */
const {openPage}=require('./harness.cjs');const path=require('path');
let failed=0;
(async()=>{
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/30-geometry.js'],libs:true,atlas:false,viewport:{width:640,height:400},name:'geometry'});
 page.setDefaultTimeout(300000);
 const test=async(name,fn)=>{try{const info=await fn();console.log('PASS '+name+(info?'  '+JSON.stringify(info):''));}catch(e){failed++;console.log('FAIL '+name+'\n  '+(e&&e.message||e));}};
 const ev=(fn,arg)=>page.evaluate(fn,arg);
 await ev(async()=>{
  const T=THREE,KE=KitsuneEngine;window.T=T;window.KE=KE;
  const renderer=new T.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;document.body.append(renderer.domElement);
  window.R=renderer;window.ready=await KE.geometryReady();
  /* Render a scene and return {counts of pixel classes} from the drawing buffer. */
  window.classify=(scene,camera,w,h)=>{const prev=new T.Vector2();renderer.getSize(prev);renderer.setSize(w,h,false);renderer.info.reset();renderer.render(scene,camera);const tris=renderer.info.render.triangles,calls=renderer.info.render.calls;
    const gl=renderer.getContext(),px=new Uint8Array(w*h*4);gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,px);renderer.setSize(prev.x,prev.y,false);return {px,tris,calls};};
 });
 const ready=await ev(()=>window.ready);

 await test('meshoptimizer backend is ready',async()=>{if(!ready.simplifier||!ready.clusterizer)throw Error(JSON.stringify(ready));return ready;});

 await test('proceduralRock builds a closed ~100k-triangle rock',async()=>{const r=await ev(()=>{const g=KE.proceduralRock(T,{detail:6,seed:3});window.rock=g;
   return {tris:g.index.count/3,verts:g.attributes.position.count,attrs:Object.keys(g.attributes),r:g.boundingSphere.radius};});
   if(r.tris<100000||r.verts!==10*72*72+2||!r.attrs.includes('normal')||!r.attrs.includes('uv')||!r.attrs.includes('color'))throw Error(JSON.stringify(r));return r;});

 await test('simplify hits target ratio (+-20%) and keeps bbox within 5%',async()=>{const r=await ev(()=>{const out={};const b0=window.rock.boundingBox,s0=b0.getSize(new T.Vector3());
   const bboxDev=g=>{g.computeBoundingBox();const b=g.boundingBox;return Math.max(...['x','y','z'].map(k=>Math.max(Math.abs(b.min[k]-b0.min[k]),Math.abs(b.max[k]-b0.max[k]))/s0[k]));};
   for(const [name,o] of [['half',{ratio:.5}],['tenth',{ratio:.1,targetError:1}],['js-quarter',{ratio:.25,targetError:Infinity,backend:'js'}]]){const t0=performance.now(),g=KE.simplify(T,window.rock,o);
     out[name]={target:o.ratio,ratio:+(g.index.count/3/(window.rock.index.count/3)).toFixed(4),bbox:+bboxDev(g).toFixed(4),error:+g.userData.simplifyError.toExponential(2),backend:g.userData.backend,ms:Math.round(performance.now()-t0),attrs:Object.keys(g.attributes).length};g.dispose();}
   return out;});
   for(const k in r){const v=r[k];if(Math.abs(v.ratio-v.target)>v.target*.2||v.bbox>.05||v.attrs!==4)throw Error(k+' '+JSON.stringify(v));}return r;});

 await test('buildLODs errors are monotonic and triangles decrease',async()=>{const r=await ev(()=>{const lods=KE.buildLODs(T,window.rock);window.lods=lods;return lods.map(l=>({tris:l.triangles,err:+l.error.toExponential(3)}));});
   for(let i=1;i<r.length;i++)if(!(r[i].err>=r[i-1].err)||!(r[i].tris<r[i-1].tris))throw Error(JSON.stringify(r));if(r.length<4||r[0].err!==0)throw Error(JSON.stringify(r));return r;});

 await test('LODMesh switches with distance, with hysteresis and dithered crossfade',async()=>{const r=await ev(()=>{
   const cam=new T.PerspectiveCamera(50,1.6,.05,2000),mesh=new KE.LODMesh(T,window.lods,new T.MeshStandardMaterial(),{pixelError:1.5,hysteresis:.1,castShadow:true});mesh.updateMatrixWorld();
   const at=d=>{cam.position.set(0,0,d);cam.lookAt(0,0,0);cam.updateMatrixWorld();return mesh.update(cam,400);};
   const levels=[2,4,8,16,32,64,128,256,512].map(d=>[d,at(d)]);
   /* find the 0->1 switch distance, then probe the hysteresis band */
   at(1);let d=1;while(at(d)===0&&d<500)d*=1.01;const up=d;const back=at(up*.97);at(1);const fromNear=at(up*.97);
   const fade=new KE.LODMesh(T,window.lods,new T.MeshStandardMaterial(),{crossfade:.25});fade.updateMatrixWorld();cam.position.set(0,0,1);cam.lookAt(0,0,0);cam.updateMatrixWorld();fade.update(cam,400);
   cam.position.set(0,0,600);cam.updateMatrixWorld();fade.update(cam,400);const visibleDuring=fade.meshes.filter(m=>m.visible).length,fading=fade.stats().fading;
   const shadowProxy=!!(mesh.shadowProxy&&(mesh.shadowProxy.visible||mesh.meshes.some(m=>m.castShadow)));
   mesh.dispose();fade.dispose();return {levels,switchAt:+up.toFixed(2),backAt97pct:back,nearAt97pct:fromNear,visibleDuring,fading,shadowProxy};});
   const L=r.levels.map(x=>x[1]);for(let i=1;i<L.length;i++)if(L[i]<L[i-1])throw Error('non-monotonic '+JSON.stringify(r));
   if(L[0]!==0||L[L.length-1]<3||r.backAt97pct!==1||r.nearAt97pct!==0||r.visibleDuring!==2||!r.fading||!r.shadowProxy)throw Error(JSON.stringify(r));return r;});

 await test('InstancedLOD: 5,000 instances cull behind camera, far ones use low LODs/impostors, far fewer triangles',async()=>{const r=await ev(()=>{
   const small=KE.proceduralRock(T,{detail:3,seed:5}),mat=new T.MeshStandardMaterial({vertexColors:true,roughness:.9});
   const scene=new T.Scene();scene.add(new T.HemisphereLight(0xffffff,0x444444,1));const cam=new T.PerspectiveCamera(55,1.6,.1,500);cam.position.set(0,2,0);cam.lookAt(0,1.5,10);cam.updateMatrixWorld();
   const N=5000,il=new KE.InstancedLOD(T,small,mat,{count:N,pixelError:1.5,castShadow:true,shadowDistance:30}),m=new T.Matrix4(),q=new T.Quaternion(),s=new T.Vector3(),p=new T.Vector3(),rnd=KE.random(9);
   for(let i=0;i<N;i++){p.set((rnd()*2-1)*120,0,(rnd()*2-1)*120);q.setFromAxisAngle(new T.Vector3(0,1,0),rnd()*6.28);const k=.4+rnd()*.8;s.set(k,k,k);il.setMatrixAt(i,m.compose(p,q,s));}
   scene.add(il.object);scene.updateMatrixWorld();
   const t0=performance.now();for(let i=0;i<20;i++){il._dirty=true;il.update(cam,200);}const updMs=(performance.now()-t0)/20;
   const st=il.stats();const lod=classify(scene,cam,320,200);
   /* impostors: bake from LOD0 and re-run */
   const imp=il.bakeImpostor(R,{size:512,frames:8});il.update(cam,200);const st2=il.stats();const lod2=classify(scene,cam,320,200);
   il.object.visible=false;const ref=new T.InstancedMesh(small,mat,N);for(let i=0;i<N;i++)ref.setMatrixAt(i,il.getMatrixAt(i,m));ref.frustumCulled=false;scene.add(ref);const full=classify(scene,cam,320,200);scene.remove(ref);ref.dispose();il.object.visible=true;
   /* toggle visibility and count */
   il.setVisibleAt(0,false);il.count=4000;il.update(cam,200);const st3=il.stats();
   const out={updateMs:+updMs.toFixed(2),culled:st.culled,visible:st.visible,levels:st.levels,trisLOD:lod.tris,trisImpostor:lod2.tris,trisFull:full.tris,impostors:st2.impostors,levels2:st2.levels,callsLOD:lod2.calls,shadowCasters:st.shadowCasters,count3:st3.visible+st3.culled,coverage:+imp.coverage(R).toFixed(3)};
   il.dispose();small.dispose();return out;});
   if(r.culled<N_BEHIND(r)||r.visible<500)throw Error('culling '+JSON.stringify(r));
   const far=r.levels.slice(2).reduce((a,b)=>a+b,0);if(far<r.levels[0])throw Error('far instances should use coarse levels '+JSON.stringify(r));
   if(!(r.trisLOD<r.trisFull*.25)||!(r.trisImpostor<=r.trisLOD)||r.impostors<1||r.count3!==3999||r.coverage<.05)throw Error(JSON.stringify(r));return r;});

 await test('VirtualGeometry builds a multi-level cluster DAG; selected triangles shrink with distance; cuts are watertight',async()=>{const r=await ev(()=>{
   const t0=performance.now();const data=KE.VirtualGeometry.build(T,window.rock,{clusterTriangles:128});const buildMs=performance.now()-t0;window.vgData=data;
   const vg=new KE.VirtualGeometry(T,data,new T.MeshStandardMaterial(),{pixelError:1});vg.frustumCull=false;vg.updateMatrixWorld();
   const cam=new T.PerspectiveCamera(50,1.6,.05,2000);
   /* welded ids per render vertex for an exact edge-balance (hole) check */
   const P=data.attributes.position.array,map=new Map(),wid=new Int32Array(data.renderVertices);for(let v=0;v<data.renderVertices;v++){const k=P[v*3]+','+P[v*3+1]+','+P[v*3+2];let id=map.get(k);if(id===undefined){id=map.size;map.set(k,id);}wid[v]=id;}
   const open=()=>{const idx=vg.geometry.index.array,n=vg.geometry.drawRange.count,E=new Map();for(let i=0;i<n;i+=3)for(let k=0;k<3;k++){const a=wid[idx[i+k]],b=wid[idx[i+(k+1)%3]];if(a===b)continue;const key=a<b?a*1e7+b:b*1e7+a;E.set(key,(E.get(key)||0)+(a<b?1:-1));}let bad=0;for(const v of E.values())if(v!==0)bad++;return bad;};
   const rows=[];for(const d of [1.5,3,6,12,24,48,96,200]){cam.position.set(d*.6,d*.3,d);cam.lookAt(0,0,0);cam.updateMatrixWorld();vg.update(cam,400);const s=vg.stats();rows.push({d,tris:s.triangles,clusters:s.selectedClusters,mixed:s.clustersPerLevel.filter(x=>x>0).length,openEdges:open()});}
   const s=vg.stats();vg.dispose();return {buildMs:Math.round(buildMs),levels:s.levels,clusters:s.clusters,groups:s.groups,levelTriangles:s.levelTriangles,rows,backend:s.backend};});
   if(r.levels<5)throw Error('too few levels '+JSON.stringify(r));
   for(let i=1;i<r.rows.length;i++)if(r.rows[i].tris>r.rows[i-1].tris)throw Error('triangles grow with distance '+JSON.stringify(r.rows));
   if(!(r.rows[r.rows.length-1].tris<r.rows[0].tris/50))throw Error('not enough reduction '+JSON.stringify(r.rows));
   if(r.rows.some(x=>x.openEdges))throw Error('open edges '+JSON.stringify(r.rows));if(!r.rows.some(x=>x.mixed>=2))throw Error('no mixed-level cut tested');return r;});

 await test('VirtualGeometry: no cracks at level transitions (back-face check on a contrasting background)',async()=>{const r=await ev(()=>{
   /* Closed mesh, DoubleSide: front faces white, back faces red, background black. A crack exposes red
      (interior back faces) or black. Baseline = full-detail source mesh; negative control = a naive
      per-cluster level mix that ignores the DAG, which must produce visible cracks. */
   const mat=new T.ShaderMaterial({side:T.DoubleSide,vertexShader:'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:'void main(){gl_FragColor=gl_FrontFacing?vec4(1.):vec4(1.,0.,0.,1.);}'});
   const scene=new T.Scene();scene.background=new T.Color(0x000000);const vg=new KE.VirtualGeometry(T,window.vgData,mat,{pixelError:1,frustumCull:true});scene.add(vg);
   const W=480,H=300,cam=new T.PerspectiveCamera(40,W/H,.05,500);const count=px=>{let red=0,white=0,black=0;for(let i=0;i<px.length;i+=4){const r=px[i],g=px[i+1];if(r>200&&g<60)red++;else if(r>200&&g>200)white++;else black++;}return {red,white,black};};
   const ref=new T.Mesh(window.rock,mat);const out=[];
   for(const [d,pe] of [[3.2,1],[5,1],[7,2],[10,4],[4,.5]]){cam.position.set(d*.5,d*.35,d);cam.lookAt(0,0,0);cam.updateMatrixWorld();vg.pixelError=pe;scene.updateMatrixWorld();
     vg.update(cam,H);const s=vg.stats();const a=count(classify(scene,cam,W,H).px);scene.remove(vg);scene.add(ref);const b=count(classify(scene,cam,W,H).px);scene.remove(ref);scene.add(vg);
     out.push({d,pixelError:pe,levelsInCut:s.clustersPerLevel.map((c,l)=>c?l:-1).filter(l=>l>=0),tris:s.triangles,red:a.red,white:a.white,refRed:b.red,refWhite:b.white});}
   /* negative control: level 0 on one side, level 3 on the other, chosen per cluster (ignores groups) */
   const D=window.vgData;cam.position.set(0,.8,3.4);cam.lookAt(0,0,0);cam.updateMatrixWorld();
   vg.debugCut((c,D)=>{const x=D.clusterSphere[c*4];return x<0?D.clusterLevel[c]===0:D.clusterLevel[c]===3;});const neg=count(classify(scene,cam,W,H).px);
   R.setSize(W,H,false);R.render(scene,cam);window.negShot=true;vg.freeze=false;vg.dispose();mat.dispose();
   return {out,negative:neg};});
   await page.screenshot({path:path.join(outDir,'geometry-crack-negative-control.png'),timeout:120000});
   for(const o of r.out){if(o.levelsInCut.length<2&&o.d<9)throw Error('cut not mixed '+JSON.stringify(o));if(o.red>o.refRed+Math.max(3,o.white*.0005))throw Error('crack pixels '+JSON.stringify(o));}
   if(r.negative.red<20)throw Error('negative control failed to show cracks '+JSON.stringify(r.negative));return r;});

 await test('VirtualGeometry: cluster frustum culling, shadow cut, debug colours, stats, dispose',async()=>{const r=await ev(()=>{
   const vg=new KE.VirtualGeometry(T,window.vgData,new T.MeshStandardMaterial(),{pixelError:1,castShadow:true});vg.updateMatrixWorld();const cam=new T.PerspectiveCamera(30,1.6,.05,500);
   cam.position.set(0,0,2.2);cam.lookAt(0,0,0);cam.updateMatrixWorld();vg.frustumCull=false;vg.update(cam,400);const all=vg.stats();
   vg.frustumCull=true;cam.lookAt(1.2,0,0);cam.updateMatrixWorld();vg.update(cam,400);const culled=vg.stats();
   const noChange=vg.update(cam,400);vg.setDebugColors('level');const dbg=!!vg.geometry.getAttribute('color')&&vg.mesh.material===vg.debugMaterial;vg.setDebugColors(false);const off=!vg.geometry.getAttribute('color')&&vg.mesh.material!==vg.debugMaterial;
   const info0=R.info.memory.geometries;const sc=new T.Scene();sc.add(vg);R.render(sc,cam);const info1=R.info.memory.geometries;vg.dispose();
   return {allTris:all.triangles,culledTris:culled.triangles,culledClusters:culled.culledClusters,shadowTris:culled.shadowTriangles,noChange,dbg,off,geoms:[info0,info1,R.info.memory.geometries],inScene:!!vg.parent,refs:window.vgData.refs};});
   if(!(r.culledTris<r.allTris*.8)||!(r.culledClusters>0)||!(r.shadowTris>0&&r.shadowTris<r.allTris)||r.noChange!==false||!r.dbg||!r.off||r.inScene)throw Error(JSON.stringify(r));return r;});

 await test('Impostor: octahedral atlas is non-empty and renders like the mesh at distance',async()=>{const r=await ev(()=>{
   const mat=new T.MeshStandardMaterial({vertexColors:true,roughness:.9}),mesh=new T.Mesh(window.lods[2].geometry,mat);mesh.rotation.y=.4;
   const imp=KE.Impostor.bake(T,R,mesh,{size:1024,frames:8,mode:'octahedral'}),bb=KE.Impostor.bake(T,R,mesh,{size:512,frames:8,mode:'billboard',lit:false});
   const scene=new T.Scene();scene.background=new T.Color(0x000000);scene.add(new T.HemisphereLight(0xffffff,0x303030,1.2));const sun=new T.DirectionalLight(0xffffff,2);sun.position.set(3,5,2);scene.add(sun);
   const W=320,H=200,cam=new T.PerspectiveCamera(40,W/H,.1,500);cam.position.set(0,4,24);cam.lookAt(0,0,0);cam.updateMatrixWorld();
   const mask=px=>{const m=new Uint8Array(W*H);let n=0;for(let i=0;i<W*H;i++)if(px[i*4]+px[i*4+1]+px[i*4+2]>30){m[i]=1;n++;}return {m,n};};
   scene.add(mesh);const a=mask(classify(scene,cam,W,H).px);scene.remove(mesh);
   const q=imp.createMesh();q.rotation.y=.4;scene.add(q);const b=mask(classify(scene,cam,W,H).px);scene.remove(q);
   const iq=bb.createInstancedMesh(3),m4=new T.Matrix4();for(let i=0;i<3;i++)iq.setMatrixAt(i,m4.makeTranslation((i-1)*3,0,0));scene.add(iq);const c=mask(classify(scene,cam,W,H).px);scene.remove(iq);
   let inter=0,uni=0;for(let i=0;i<W*H;i++){if(a.m[i]&&b.m[i])inter++;if(a.m[i]||b.m[i])uni++;}
   const out={coverage:+imp.coverage(R).toFixed(3),billboardCoverage:+bb.coverage(R).toFixed(3),meshPx:a.n,impostorPx:b.n,iou:+(inter/Math.max(1,uni)).toFixed(3),billboardPx:c.n,frameRes:imp.frameResolution};
   /* side-by-side shading check: mesh (left) vs octahedral impostor (right), three views */
   R.setSize(640,400,false);const cam2=new T.PerspectiveCamera(35,1.6,.1,100);const views=[[0,1.2,9],[5,4,6],[-7,2.5,-5]];window.impShots=views.length;
   window.impView=k=>{const v=views[k];scene.add(mesh,q);mesh.position.set(-1.6,0,0);q.position.set(1.6,0,0);q.rotation.y=mesh.rotation.y;cam2.position.set(...v);cam2.lookAt(0,0,0);cam2.updateMatrixWorld();R.render(scene,cam2);scene.remove(mesh,q);mesh.position.set(0,0,0);q.position.set(0,0,0);};
   window.impostorForField=imp;bb.dispose();return out;});
   for(let k=0;k<3;k++){await ev(k=>window.impView(k),k);await page.screenshot({path:path.join(outDir,'geometry-impostor-'+k+'.png'),timeout:120000});}
   if(r.coverage<.1||r.billboardCoverage<.05||r.impostorPx<50||r.iou<.7||r.billboardPx<100)throw Error(JSON.stringify(r));return r;});

 await test('Impostor casts shadows through its depth material',async()=>{const r=await ev(()=>{
   /* sun from +x at 45 deg: the shadow lands around x=-2.5 on the ground, away from the impostor's own footprint.
      Sample that ground patch with castShadow off and on (impostor visible both times). */
   const imp=window.impostorForField,W=320,H=200;R.shadowMap.enabled=true;R.shadowMap.type=T.PCFShadowMap;
   const scene=new T.Scene();scene.background=new T.Color(0x000000);const sun=new T.DirectionalLight(0xffffff,2);sun.position.set(12,12,0);sun.castShadow=true;Object.assign(sun.shadow.camera,{left:-6,right:6,top:6,bottom:-6,near:1,far:40});scene.add(sun,sun.target);
   const ground=new T.Mesh(new T.PlaneGeometry(14,14),new T.MeshStandardMaterial({color:0xffffff}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
   const q=imp.createMesh();q.position.set(0,2.5,0);scene.add(q);
   const cam=new T.PerspectiveCamera(50,W/H,.1,100);cam.position.set(0,14,.01);cam.lookAt(0,0,0);cam.updateMatrixWorld();
   const pt=new T.Vector3(-2.5-imp.center.x,0,-imp.center.z).project(cam),sx=Math.round((pt.x*.5+.5)*W),sy=Math.round((pt.y*.5+.5)*H);
   const lum=px=>{let s=0;for(let y=sy-3;y<=sy+3;y++)for(let x=sx-3;x<=sx+3;x++){const i=(y*W+x)*4;s+=px[i]+px[i+1]+px[i+2];}return s/49/3;};
   q.castShadow=false;const noShadow=lum(classify(scene,cam,W,H).px);q.castShadow=true;const shadow=lum(classify(scene,cam,W,H).px);R.shadowMap.enabled=false;
   return {sample:[sx,sy],noShadow:+noShadow.toFixed(1),shadow:+shadow.toFixed(1)};});
   if(!(r.shadow<r.noShadow*.7))throw Error(JSON.stringify(r));return r;});

 await test('VirtualGeometry JS fallback builds a crack-free DAG',async()=>{const r=await ev(()=>{
   const g=KE.proceduralRock(T,{detail:4,seed:11}),vg=new KE.VirtualGeometry(T,g,new T.MeshBasicMaterial(),{backend:'js',pixelError:1});vg.frustumCull=false;vg.updateMatrixWorld();const data=vg.data;
   const P=data.attributes.position.array,map=new Map(),wid=new Int32Array(data.renderVertices);for(let v=0;v<data.renderVertices;v++){const k=P[v*3]+','+P[v*3+1]+','+P[v*3+2];let id=map.get(k);if(id===undefined){id=map.size;map.set(k,id);}wid[v]=id;}
   const open=()=>{const idx=vg.geometry.index.array,n=vg.geometry.drawRange.count,E=new Map();for(let i=0;i<n;i+=3)for(let k=0;k<3;k++){const a=wid[idx[i+k]],b=wid[idx[i+(k+1)%3]];if(a===b)continue;const key=a<b?a*1e7+b:b*1e7+a;E.set(key,(E.get(key)||0)+(a<b?1:-1));}let bad=0;for(const v of E.values())if(v!==0)bad++;return bad;};
   const cam=new T.PerspectiveCamera(50,1.6,.05,1000),rows=[];for(const d of [2,8,20,40,80,160]){cam.position.set(d*.6,d*.3,d);cam.lookAt(0,0,0);cam.updateMatrixWorld();vg.update(cam,400);const s=vg.stats();rows.push({d,tris:s.triangles,mixed:s.clustersPerLevel.filter(x=>x>0).length,open:open()});}
   const out={backend:data.backend,levels:data.levelCount,buildMs:Math.round(data.buildMs),rows};vg.dispose();g.dispose();return out;});
   if(r.backend!=='js'||r.levels<3||r.rows.some(x=>x.open)||!(r.rows[r.rows.length-1].tris<r.rows[0].tris))throw Error(JSON.stringify(r));return r;});

 await test('meshStats counts draws and triangles',async()=>{const r=await ev(()=>{const g=new T.Group(),m=new T.Mesh(new T.BoxGeometry(),new T.MeshBasicMaterial()),im=new T.InstancedMesh(new T.BoxGeometry(),m.material,10);im.count=4;g.add(m,im);const s=KE.meshStats(g);return s;});
   if(r.triangles!==12+48||r.drawCalls!==2||r.instances!==4)throw Error(JSON.stringify(r));return r;});

 /* ---------- rock field screenshots ---------- */
 await test('rock field screenshots (normal shading and debug colours)',async()=>{const r=await ev(()=>{
   const W=640,H=400;R.setSize(W,H,false);R.shadowMap.enabled=true;R.shadowMap.type=T.PCFSoftShadowMap;R.toneMapping=T.ACESFilmicToneMapping;
   const scene=new T.Scene();scene.background=new T.Color(0x9fc3e0);scene.fog=new T.Fog(0x9fc3e0,40,140);
   scene.add(new T.HemisphereLight(0xcfe3ff,0x4a4034,.55));const sun=new T.DirectionalLight(0xfff1dd,1.9);sun.position.set(14,10,3);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);
   Object.assign(sun.shadow.camera,{left:-16,right:16,top:16,bottom:-16,near:1,far:60});sun.shadow.bias=-.0005;sun.target.position.set(0,0,-4);scene.add(sun,sun.target);
   const ground=new T.Mesh(new T.PlaneGeometry(300,300),new T.MeshStandardMaterial({color:new T.Color(0x56663a).convertSRGBToLinear(),roughness:1}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
   const rockMat=new T.MeshStandardMaterial({vertexColors:true,roughness:.92});
   const big=[];const rnd=KE.random(21);
   for(let i=0;i<9;i++){const vg=new KE.VirtualGeometry(T,window.vgData,rockMat,{pixelError:1,castShadow:true,receiveShadow:true});const d=4+i*i*1.1,a=(rnd()-.5)*1.4;const k=1+rnd()*1.2;
     vg.position.set(Math.sin(a)*d+(i%2?2:-2),.25*k,-Math.cos(a)*d);vg.scale.setScalar(k);vg.rotation.y=rnd()*6;scene.add(vg);big.push(vg);}
   const small=KE.proceduralRock(T,{detail:4,seed:7}),N=1500,il=new KE.InstancedLOD(T,small,rockMat,{count:N,pixelError:1.5,castShadow:true,receiveShadow:true,shadowDistance:25,debugColors:false});
   const m=new T.Matrix4(),q=new T.Quaternion(),s=new T.Vector3(),p=new T.Vector3(),up=new T.Vector3(0,1,0);
   for(let i=0;i<N;i++){const d=3+Math.pow(rnd(),.7)*110,a=(rnd()-.5)*2.2;p.set(Math.sin(a)*d,0,-Math.cos(a)*d);q.setFromAxisAngle(up,rnd()*6.28);const k=.15+rnd()*.35;s.set(k,k*.8,k);p.y=k*.2;il.setMatrixAt(i,m.compose(p,q,s));}
   il.bakeImpostor(R,{size:1024,frames:8,pixels:40});scene.add(il.object);
   const cam=new T.PerspectiveCamera(55,W/H,.1,300);cam.position.set(0,3.2,7);cam.lookAt(0,1,-12);cam.updateMatrixWorld();
   window.field={scene,cam,big,il,rockMat,small};
   R.render(scene,cam);const st=KE.meshStats(scene),vs=big.map(v=>v.stats().triangles),ils=il.stats();
   return {stats:st,vgTris:vs,il:{levels:ils.levels,impostors:ils.impostors,visible:ils.visible,triangles:ils.triangles,full:ils.fullDetailTriangles},renderTris:R.info.render.triangles,calls:R.info.render.calls};});
   await page.screenshot({path:path.join(outDir,'geometry-field.png'),timeout:120000});
   await ev(()=>{const f=window.field;for(const v of f.big)v.setDebugColors('cluster');const il=f.il;il.meshes.forEach((m,i)=>{m.material=m.material.clone();m.material.vertexColors=false;m.material.color.setHex([0x3ecf6e,0xf2d13d,0xf28c28,0xe8453c,0xd13dc9][i%5]);});
     il.impostorMesh.material=il.impostorMesh.material;R.render(f.scene,f.cam);});
   await page.screenshot({path:path.join(outDir,'geometry-field-debug.png'),timeout:120000});
   await ev(()=>{const f=window.field;for(const v of f.big)v.setDebugColors('level');R.render(f.scene,f.cam);});
   await page.screenshot({path:path.join(outDir,'geometry-field-levels.png'),timeout:120000});
   const d=await ev(()=>{const f=window.field;const g0=R.info.memory.geometries;for(const v of f.big)v.dispose();f.il.dispose();f.small.dispose();R.render(f.scene,f.cam);return {before:g0,after:R.info.memory.geometries,refs:window.vgData.refs};});
   if(!(r.vgTris[0]>r.vgTris[r.vgTris.length-1])||r.il.impostors<1||d.refs!==0)throw Error(JSON.stringify({r,d}));return {...r,dispose:d};});

 await close();
 if(failed){console.log(failed+' geometry test(s) FAILED');process.exit(1);}
 console.log('all geometry tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
function N_BEHIND(r){return Math.floor(5000*.35);}
