/* Browser checks for kitsune foliage (24-foliage.js): procedural trees, foliage/shadow materials,
   world-anchored interactive grass, shell fur and the instanced spawner, plus three screenshots.
   node scripts/test_foliage.cjs [func] [forest] [grass] [fox]   (no argument = everything) */
const {openPage}=require('./harness.cjs');const path=require('path');
const want=process.argv.slice(2).filter(a=>!a.startsWith('-'));const run=k=>!want.length||want.includes(k);
let failed=0;
const test=async(name,fn)=>{try{await fn();console.log('PASS '+name);}catch(e){failed++;console.log('FAIL '+name+'\n  '+(e&&e.stack||e));}};
const assert=(c,msg)=>{if(!c)throw new Error(msg);};
const MODULES=['src/modules/00-core-v3.js','src/modules/14-shadows.js','src/modules/18-gi.js','src/modules/24-foliage.js'];

/* Common page helpers: renderer, sky gradient, lights. */
const PRELUDE=()=>{
  const T=THREE,KE=KitsuneEngine;
  window.mkRenderer=(w=innerWidth,h=innerHeight)=>{const r=new T.WebGLRenderer({antialias:true,preserveDrawingBuffer:true});r.setPixelRatio(1);r.setSize(w,h);r.outputEncoding=T.sRGBEncoding;r.toneMapping=T.ACESFilmicToneMapping;r.toneMappingExposure=1;
    r.shadowMap.enabled=true;r.shadowMap.type=T.PCFSoftShadowMap;document.body.innerHTML='';document.body.appendChild(r.domElement);return r;};
  window.skyTexture=(top,mid,bottom)=>{const c=document.createElement('canvas');c.width=4;c.height=256;const g=c.getContext('2d'),gr=g.createLinearGradient(0,0,0,256);gr.addColorStop(0,top);gr.addColorStop(.55,mid);gr.addColorStop(1,bottom);g.fillStyle=gr;g.fillRect(0,0,4,256);
    const t=new T.CanvasTexture(c);t.encoding=T.sRGBEncoding;return t;};
  window.fbm=(x,z)=>{let s=0,a=1,f=1;for(let i=0;i<4;i++){s+=a*Math.sin(x*f*.9+i*1.7)*Math.cos(z*f*1.1-i*2.3);a*=.5;f*=2.03;}return s;};
  window.terrainMesh=(heightAt,size,seg,colorAt)=>{const g=new T.PlaneGeometry(size,size,seg,seg);g.rotateX(-Math.PI/2);const p=g.attributes.position,c=new Float32Array(p.count*3);
    for(let i=0;i<p.count;i++){const x=p.getX(i),z=p.getZ(i);p.setY(i,heightAt(x,z));const col=colorAt(x,z);c[i*3]=Math.pow(col[0],2.2);c[i*3+1]=Math.pow(col[1],2.2);c[i*3+2]=Math.pow(col[2],2.2);}
    g.setAttribute('color',new T.BufferAttribute(c,3));g.computeVertexNormals();const m=new T.Mesh(g,new T.MeshStandardMaterial({vertexColors:true,roughness:.97}));m.receiveShadow=true;return m;};
};

(async()=>{
 /* ---------------- functional checks ---------------- */
 if(run('func')){
  const {page,close}=await openPage({modules:MODULES,viewport:{width:320,height:240},name:'foliage-func'});
  await page.evaluate(PRELUDE);
  await test('module registers and exposes the spec API',async()=>{const r=await page.evaluate(()=>{const KE=KitsuneEngine;const U=KE.foliageUniforms;
    return {mod:!!KE.modules.foliage,keys:Object.keys(U).sort(),inter:U.keInteractors.value.length,fns:['foliageMaterial','foliageDepthMaterial','treeGeometry','leafTexture','barkMaterial','grassField','fur','FoliageSpawner'].filter(k=>typeof KE[k]!=='function')};});
    assert(r.mod&&!r.fns.length,'missing '+r.fns);assert(JSON.stringify(r.keys)===JSON.stringify(['keGustScale','keInteractorCount','keInteractors','keTime','keWindDir','keWindStrength']),r.keys);assert(r.inter===8,'8 interactors');});
  await test('KE.foliage.update advances wind time (also KE.windUniforms) and packs interactors',async()=>{const r=await page.evaluate(()=>{const KE=KitsuneEngine,U=KE.foliageUniforms,t0=U.keTime.value,w0=KE.windUniforms.uTime.value;
    KE.foliage.update(.2,{wind:1.7,windDir:[0,1],interactors:[new THREE.Vector3(1,2,3),{position:{x:4,y:5,z:6},radius:1.5},null,{x:NaN,y:0,z:0}]});
    const out={dt:U.keTime.value-t0,dw:KE.windUniforms.uTime.value-w0,s:U.keWindStrength.value,dir:U.keWindDir.value.toArray(),n:U.keInteractorCount.value,a:U.keInteractors.value[0].toArray(),b:U.keInteractors.value[1].toArray()};
    KE.foliage.update(0,{wind:1,windDir:[.8,.6],interactors:[]});return out;});
    assert(Math.abs(r.dt-.2)<1e-9&&Math.abs(r.dw-.2)<1e-9,'time '+JSON.stringify(r));assert(r.s===1.7&&r.dir[0]===0&&r.dir[1]===1,'wind '+JSON.stringify(r));assert(r.n===2&&r.a.join()==='1,2,3,0.5'&&r.b.join()==='4,5,6,1.5','interactors '+JSON.stringify(r));});
  await test('fern clumps and flower heads are deterministic, finite and wind-weighted',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine;const out={};
    for(const [name,make] of [['fern',o=>KE.fernClump(T,o)],['flower',o=>KE.flowerHead(T,o)]]){const a=make({seed:3}),b=make({seed:3}),c=make({seed:4}),pa=a.attributes.position.array;
      let finite=true;for(const v of pa)if(!Number.isFinite(v))finite=false;for(const v of a.attributes.normal.array)if(!Number.isFinite(v))finite=false;
      const idxOK=Array.from(a.index.array).every(i=>i<a.attributes.position.count);let same=pa.length===b.attributes.position.array.length&&pa.every((v,i)=>v===b.attributes.position.array[i]),differs=pa.length!==c.attributes.position.array.length||pa.some((v,i)=>v!==c.attributes.position.array[i]);
      a.computeBoundingBox();out[name]={tris:a.index.count/3,finite,idxOK,same,differs,wind:!!a.attributes.windWeight&&a.attributes.windWeight.itemSize===4,color:!!a.attributes.color,minY:+a.boundingBox.min.y.toFixed(3),maxY:+a.boundingBox.max.y.toFixed(3)};[a,b,c].forEach(g=>g.dispose());}
    return out;});console.log('    ',JSON.stringify(r));
    for(const [k,v] of Object.entries(r))if(!(v.finite&&v.idxOK&&v.same&&v.differs&&v.wind&&v.color&&v.minY>-.2&&v.maxY>.05))throw Error(k+' '+JSON.stringify(v));});
  await test('tree generation is deterministic and geometry is valid for every species',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine,out={};
    const sig=g=>{const a=g.attributes.position.array;let h=0;for(let i=0;i<a.length;i++)h=(h*31+Math.round(a[i]*1e4))|0;return h;};
    for(const species of KE.TREE_SPECIES){const a=KE.treeGeometry(T,{species,seed:7,detail:1}),b=KE.treeGeometry(T,{species,seed:7,detail:1}),c=KE.treeGeometry(T,{species,seed:8,detail:1});
      const check=g=>{if(!g)return 'missing';const p=g.attributes.position,n=g.attributes.normal,w=g.attributes.windWeight,uv=g.attributes.uv,idx=g.index.array;if(!w||w.itemSize!==4)return 'windWeight';if(!uv)return 'uv';
        for(let i=0;i<p.array.length;i++)if(!Number.isFinite(p.array[i])||!Number.isFinite(n.array[i]))return 'NaN';for(let i=0;i<idx.length;i++)if(idx[i]>=p.count)return 'index';
        for(let i=0;i<w.array.length;i++)if(!(w.array[i]>=0&&w.array[i]<=1.0001))return 'weight range';for(let i=0;i<n.count;i++){const l=Math.hypot(n.getX(i),n.getY(i),n.getZ(i));if(Math.abs(l-1)>.02)return 'normal len';}return 'ok';};
      const lw=a.leaves.attributes.windWeight;let flutterMax=0,phases=new Set();for(let i=0;i<lw.count;i++){flutterMax=Math.max(flutterMax,lw.getZ(i));phases.add(lw.getW(i).toFixed(3));}
      const tw=a.trunk.attributes.windWeight;let rootW=1;for(let i=0;i<tw.count;i++)if(a.trunk.attributes.position.getY(i)<.05)rootW=Math.min(rootW,tw.getX(i));
      out[species]={same:sig(a.trunk)===sig(b.trunk)&&sig(a.leaves)===sig(b.leaves),differs:sig(a.trunk)!==sig(c.trunk),trunk:check(a.trunk),leaves:check(a.leaves),cards:a.stats.leafCards,height:+a.bounds.height.toFixed(2),
        want:KE.foliage.species[species].height,tris:a.stats.trunkTriangles+a.stats.leafTriangles,flutterMax,phases:phases.size,rootW};
      for(const g of [a,b,c]){g.trunk.dispose();g.leaves&&g.leaves.dispose();}}
    const h=KE.treeGeometry(T,{species:'broadleaf',seed:3,height:9});out.custom=+h.bounds.height.toFixed(2);return out;});
    for(const [k,v] of Object.entries(r)){if(k==='custom')continue;console.log('   ',k,JSON.stringify(v));
      assert(v.same&&v.differs,k+' determinism');assert(v.trunk==='ok'&&v.leaves==='ok',k+' geometry '+v.trunk+'/'+v.leaves);assert(v.cards>=(k==='palm'?5:40),k+' leaf cards');
      assert(Math.abs(v.height-v.want)<.02*v.want,k+' height '+v.height);assert(v.flutterMax>.9&&v.phases>4,k+' leaf wind weights');assert(v.rootW<.02,k+' root anchored');}
    assert(Math.abs(r.custom-9)<.1,'custom height '+r.custom);});
  await test('bamboo stands and the daisugi: deterministic, valid, tall, detail-scaled',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine,out={};
    const sig=g=>{const a=g.attributes.position.array;let h=0;for(let i=0;i<a.length;i++)h=(h*31+Math.round(a[i]*1e4))|0;return h;};
    const ok=g=>{const p=g.attributes.position,w=g.attributes.windWeight,idx=g.index.array;if(!w||!g.attributes.uv||!g.attributes.color)return 'attrs';for(let i=0;i<p.array.length;i++)if(!Number.isFinite(p.array[i]))return 'NaN';for(let i=0;i<idx.length;i++)if(idx[i]>=p.count)return 'index';return 'ok';};
    for(const [name,make] of [['bamboo',o=>KE.bambooGeometry(T,o)],['daisugi',o=>KE.daisugiGeometry(T,o)]]){const a=make({seed:4,detail:1}),b=make({seed:4,detail:1}),c=make({seed:5,detail:1}),lo=make({seed:4,detail:.4});
      out[name]={same:sig(a.trunk)===sig(b.trunk)&&sig(a.leaves)===sig(b.leaves),differs:sig(a.trunk)!==sig(c.trunk),trunk:ok(a.trunk),leaves:ok(a.leaves),height:+a.bounds.height.toFixed(1),cards:a.stats.leafCards,
        tris:a.stats.trunkTriangles+a.stats.leafTriangles,trisLow:lo.stats.trunkTriangles+lo.stats.leafTriangles};for(const g of [a,b,c,lo]){g.trunk.dispose();g.leaves.dispose();}}
    const tex=KE.leafTexture(T,{species:'bamboo',size:128}),mp=KE.leafTexture(T,{species:'maple',size:128});out.textures=[tex.userData.species,mp.userData.species];tex.dispose();mp.dispose();return out;});
    console.log('   ',JSON.stringify(r));for(const k of ['bamboo','daisugi']){const v=r[k];assert(v.same&&v.differs,k+' determinism');assert(v.trunk==='ok'&&v.leaves==='ok',k+' geometry');assert(v.height>10,k+' height');assert(v.cards>100,k+' cards');assert(v.trisLow<v.tris*.8,k+' detail scaling');}});
  await test('foliage material and its shadow depth material displace vertices identically (mesh and InstancedMesh)',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine;
    const renderer=new T.WebGLRenderer({preserveDrawingBuffer:true});renderer.setSize(64,64);const W=192,H=192,rt=new T.WebGLRenderTarget(W,H);
    const tex=KE.leafTexture(T,{species:'broadleaf',size:128}),geo=KE.treeGeometry(T,{species:'broadleaf',seed:4,leafCards:{texture:tex}});
    const leaf=KE.foliageMaterial(T,{map:tex,vertexColors:true,wind:{trunk:.05,branch:.12,leaf:.2},edgeFade:0}),bark=KE.barkMaterial(T,{species:'broadleaf'});
    const plainDepth=new T.MeshDepthMaterial({depthPacking:T.RGBADepthPacking,map:tex,alphaTest:leaf.alphaTest,side:T.DoubleSide});
    const scene=new T.Scene(),cam=new T.OrthographicCamera(-4,4,4,-4,.1,50);cam.position.set(0,2.5,20);cam.lookAt(0,2.5,0);
    const mesh=new T.Mesh(geo.leaves,leaf),inst=new T.InstancedMesh(geo.leaves,leaf,2),trunk=new T.Mesh(geo.trunk,bark);
    const m4=new T.Matrix4();inst.setMatrixAt(0,m4.makeTranslation(-1.2,0,-3));inst.setMatrixAt(1,m4.compose(new T.Vector3(1.5,.3,-6),new T.Quaternion().setFromAxisAngle(new T.Vector3(0,1,0),1.1),new T.Vector3(.8,.8,.8)));
    const mask=(obj,material)=>{scene.children.length=0;scene.add(obj);const keep=obj.material;obj.material=material;renderer.setRenderTarget(rt);renderer.setClearColor(0,0);renderer.clear();renderer.render(scene,cam);
      const px=new Uint8Array(W*H*4);renderer.readRenderTargetPixels(rt,0,0,W,H,px);renderer.setRenderTarget(null);obj.material=keep;const m=new Uint8Array(W*H);let n=0;for(let i=0;i<W*H;i++){m[i]=(px[i*4]|px[i*4+1]|px[i*4+2]|px[i*4+3])?1:0;n+=m[i];}m.n=n;return m;};
    const diff=(a,b)=>{let d=0;for(let i=0;i<a.length;i++)d+=a[i]!==b[i];return d;};
    const out={};KE.foliage.update(0,{wind:2.5,windDir:[1,.4]});KE.foliageUniforms.keTime.value=3.7;
    for(const [name,obj,mat] of [['leaves',mesh,leaf],['instanced',inst,leaf],['trunk',trunk,bark]]){const depth=KE.foliageDepthMaterial(mat);const side=depth.side;depth.side=mat.side;
      const a=mask(obj,mat),b=mask(obj,depth);depth.side=side;out[name]={covered:a.n,mismatch:diff(a,b)};
      if(name!=='trunk'){const c=mask(obj,plainDepth);out[name].vsStatic=diff(a,c);}}
    KE.foliageUniforms.keWindStrength.value=0;const calm=mask(mesh,leaf);KE.foliageUniforms.keWindStrength.value=2.5;const windy=mask(mesh,leaf);out.windMoves=diff(calm,windy);
    out.sameDepth=KE.foliageDepthMaterial(leaf)===KE.foliageDepthMaterial(leaf);out.sharedUniform=leaf.userData.keFoliage.uniforms.kfWindAmp===KE.foliageDepthMaterial(leaf).userData.keFoliageDepthOf.userData.keFoliage.uniforms.kfWindAmp;
    KE.foliage.update(0,{wind:1});KE.foliageUniforms.keTime.value=0;renderer.dispose();rt.dispose();return out;});
    console.log('   ',JSON.stringify(r));
    for(const k of ['leaves','instanced','trunk']){assert(r[k].covered>300,k+' coverage');assert(r[k].mismatch<=r[k].covered*.002,k+' colour/depth mismatch '+r[k].mismatch);}
    assert(r.leaves.vsStatic>r.leaves.covered*.05&&r.instanced.vsStatic>r.instanced.covered*.05,'a static depth material should differ (test sensitivity)');assert(r.windMoves>r.leaves.covered*.05,'wind moves leaves');assert(r.sameDepth,'depth material cached');});
  await test('foliage materials compose with KE.CascadedShadows and KE.ProbeVolume hooks',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine;
    const renderer=new T.WebGLRenderer();renderer.setSize(64,64);renderer.shadowMap.enabled=true;const scene=new T.Scene(),cam=new T.PerspectiveCamera(50,1,.1,100);cam.position.set(0,3,12);cam.lookAt(0,2,0);
    const sun=new T.DirectionalLight(0xffffff,2);sun.position.set(5,10,4);scene.add(sun,sun.target);
    const tex=KE.leafTexture(T,{species:'birch',size:64}),geo=KE.treeGeometry(T,{species:'birch',seed:2,leafCards:{texture:tex}});
    const leaf=KE.foliageMaterial(T,{map:tex,vertexColors:true}),bark=KE.barkMaterial(T,{species:'birch'});
    const lm=new T.Mesh(geo.leaves,leaf),tm=new T.Mesh(geo.trunk,bark);lm.castShadow=tm.castShadow=true;KE.foliage.attach(lm);KE.foliage.attach(tm);scene.add(lm,tm);
    const csm=new KE.CascadedShadows(T,scene,{sun,cascades:2,mapSize:256,maxFar:40});
    const gi=new KE.ProbeVolume(T,renderer,scene,{bounds:new T.Box3(new T.Vector3(-6,0,-6),new T.Vector3(6,6,6)),spacing:12,faceSize:8,probesPerFrame:1});
    csm.setupScene();gi.setupScene();const src={};
    for(const [k,m] of [['leaf',leaf],['bark',bark]]){const prev=m.onBeforeCompile;m.onBeforeCompile=function(sh,r){prev.call(this,sh,r);src[k]={fs:sh.fragmentShader,vs:sh.vertexShader};};m.needsUpdate=true;}
    csm.update(cam);gi.update(cam,1);renderer.render(scene,cam);
    const gl=renderer.getContext();const has=(k,str)=>src[k]&&(src[k].fs.includes(str)||src[k].vs.includes(str));
    const out={keys:[leaf.customProgramCacheKey(),bark.customProgramCacheKey()],leafTrans:has('leaf','kfRE_Direct'),leafCsm:has('leaf','keCsmShadow'),leafGI:has('leaf','keProbeIrradiance'),leafWind:has('leaf','kfWind('),
      barkCsm:has('bark','keCsmShadow'),barkGI:has('bark','keProbeIrradiance'),barkWind:has('bark','kfWind('),error:gl.getError(),programs:renderer.info.programs.length};
    csm.dispose();gi.dispose&&gi.dispose();renderer.dispose();return out;});
    console.log('   ',JSON.stringify(r));assert(r.leafTrans&&r.leafCsm&&r.leafGI&&r.leafWind,'leaf composition');assert(r.barkCsm&&r.barkGI&&r.barkWind,'bark composition');
    assert(r.keys.every(k=>/ke-foliage-2-main/.test(k)&&/ke-csm/.test(k)&&/ke-gi/.test(k)),'cache keys '+r.keys);});
  await test('grass placement is world-anchored (no swimming), deterministic and ring-consistent',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine;
    const opts={count:6000,radius:10,heightAt:(x,z)=>.1*x+.05*z,seed:3,density:(x,z)=>.8};
    const blades=(g,x0,z0,x1,z1)=>{const a=g.geometry.attributes.aRoot.array,sh=g.geometry.attributes.aShape.array,set=new Set();for(let i=0;i<a.length/4;i++){const x=a[i*4],z=a[i*4+2];if(sh[i*4+1]>0&&x>=x0&&x<x1&&z>=z0&&z<z1)set.add([x,a[i*4+1],z,sh[i*4],sh[i*4+1]].map(v=>v.toFixed(5)).join());}return set;};
    const eq=(a,b)=>a.size===b.size&&[...a].every(v=>b.has(v)),sub=(a,b)=>[...a].every(v=>b.has(v));
    const g=KE.grassField(T,null,opts),out={cell:g.cellSize,lod:g.lodRadius};out.first=g.update(0,0);const A=blades(g,-1.4,-1.4,1.4,1.4),F0=blades(g,6,-1.5,8.5,1.5);
    out.same=g.update(.3,.2);out.moved=g.update(1.9,-1.3);const B=blades(g,-1.4,-1.4,1.4,1.4);g.update(-2.2,2.4);g.update(0,0);const C=blades(g,-1.4,-1.4,1.4,1.4);
    const fresh=KE.grassField(T,null,opts);fresh.update(1.9,-1.3);const D=blades(fresh,-1.4,-1.4,1.4,1.4);
    g.update(7.2,0);const F1=blades(g,6,-1.5,8.5,1.5);
    const it=g.geometry.attributes.aRoot.array;let heightOk=true;for(let i=0;i<it.length/4;i+=37){if(Math.abs(it[i*4+1]-(.1*it[i*4]+.05*it[i*4+2]))>1e-4){heightOk=false;break;}}
    out.region=A.size;out.anchoredAfterMove=eq(A,B);out.anchoredAfterReturn=eq(A,C);out.historyFree=eq(A,D);out.farSubsetOfNear=F0.size>0&&F0.size<F1.size&&sub(F0,F1);out.far=F0.size;out.near=F1.size;out.heightOk=heightOk;out.capacity=g.stats.capacity;
    g.dispose();fresh.dispose();return out;});
    console.log('   ',JSON.stringify(r));assert(r.first>0&&r.same===0&&r.moved>0,'incremental cell refill');assert(r.region>50,'region blades');
    assert(r.anchoredAfterMove&&r.anchoredAfterReturn&&r.historyFree,'world anchoring');assert(r.farSubsetOfNear,'outer ring blades are a subset of the near set');assert(r.heightOk,'heightAt');assert(r.capacity<=6000*1.02,'budget');});
  await test('an interactor bends blades away (side-view silhouette drops only near it)',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine;
    const renderer=new T.WebGLRenderer({preserveDrawingBuffer:true});renderer.setSize(64,64);const W=300,H=80,rt=new T.WebGLRenderTarget(W,H);const scene=new T.Scene();scene.add(new T.DirectionalLight(0xffffff,1));
    const g=KE.grassField(T,scene,{count:9000,radius:7,bladeHeight:[.6,.6],bladeWidth:.07,density:(x,z)=>Math.abs(z)<.35?1:0,seed:9,castShadow:false});g.update(0,0);
    const cam=new T.OrthographicCamera(-3,3,.6,-.6,.1,20);cam.position.set(0,.5,6);cam.lookAt(0,.5,0);
    const profile=()=>{renderer.setRenderTarget(rt);renderer.setClearColor(0,0);renderer.clear();renderer.render(scene,cam);const px=new Uint8Array(W*H*4);renderer.readRenderTargetPixels(rt,0,0,W,H,px);renderer.setRenderTarget(null);
      const band=(x0,x1)=>{let n=0;const y0=Math.floor((.22+.1)/1.2*H);for(let y=y0;y<H;y++)for(let x=Math.floor((x0+3)/6*W);x<Math.floor((x1+3)/6*W);x++)n+=px[(y*W+x)*4+3]>0?1:0;return n;};
      return {center:band(-.45,.45),side:band(1.8,2.7)};};
    KE.foliage.update(0,{wind:0,interactors:[]});const before=profile();
    KE.foliage.update(0,{wind:0,interactors:[{position:{x:0,y:.5,z:0},radius:.5}]});const after=profile();
    KE.foliage.update(0,{wind:0,interactors:[{position:{x:0,y:3,z:0},radius:.5}]});const above=profile();
    KE.foliage.update(0,{wind:1,interactors:[]});g.dispose();rt.dispose();renderer.dispose();return {before,after,above};});
    console.log('   ',JSON.stringify(r));assert(r.before.center>60&&r.before.side>60,'tall blades visible');assert(r.after.center<r.before.center*.55,'blades near the interactor are pushed down/away');
    assert(Math.abs(r.after.side-r.before.side)<=r.before.side*.03,'blades far from the interactor unaffected');assert(Math.abs(r.above.center-r.before.center)<=r.before.center*.03,'an interactor high above does not bend blades');});
  await test('fur: shells per mesh, follows KE.settings.fur and distance LOD, disposes cleanly',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine;
    const renderer=new T.WebGLRenderer();renderer.setSize(64,64);const scene=new T.Scene(),cam=new T.PerspectiveCamera(50,1,.1,100);cam.position.set(0,.5,3);cam.lookAt(0,.4,0);scene.add(new T.DirectionalLight(0xffffff,1));
    const grp=new T.Group(),mat=new T.MeshStandardMaterial({color:0xcc6b2c}),geo=new T.SphereGeometry(.3,16,12);for(let i=0;i<3;i++){const m=new T.Mesh(geo,mat);m.position.set(i*.4-.4,.4,0);m.scale.set(1,1.2,.9);grp.add(m);}
    const eye=new T.Mesh(geo,new T.MeshStandardMaterial());eye.name='eye';grp.add(eye);scene.add(grp);KE.setSettings({fur:true});renderer.render(scene,cam);
    const base={geo:renderer.info.memory.geometries,tex:renderer.info.memory.textures};
    const fur=KE.fur(T,grp,{shells:12,include:m=>m.name!=='eye'});renderer.render(scene,cam);
    const out={meshes:fur.meshes.length,counts:fur.meshes.map(m=>m.geometry.instanceCount),parents:fur.meshes.every(m=>m.parent&&m.parent.parent===grp),rendered:fur.renderedShells,withFur:{geo:renderer.info.memory.geometries,tex:renderer.info.memory.textures}};
    KE.setSettings({fur:false});renderer.render(scene,cam);out.offVisible=fur.meshes.some(m=>m.visible);out.offRendered=fur.renderedShells;
    KE.setSettings({fur:true});renderer.render(scene,cam);out.onVisible=fur.meshes.every(m=>m.visible);
    out.set=fur.setShells(6);renderer.render(scene,cam);out.afterSet=fur.meshes.map(m=>m.geometry.instanceCount);
    cam.position.set(0,.5,30);cam.lookAt(0,.4,0);renderer.render(scene,cam);out.farRendered=fur.renderedShells;cam.position.set(0,.5,3);cam.lookAt(0,.4,0);
    fur.update(1/60,{x:3,y:0,z:0});out.inertia=fur.materials[0].uniforms.uInertia.value.length()>0;
    fur.dispose();renderer.render(scene,cam);out.after={geo:renderer.info.memory.geometries,tex:renderer.info.memory.textures};out.base=base;
    out.childrenLeft=grp.children.reduce((n,c)=>n+c.children.length,0);out.sourceIntact=!!geo.attributes.position&&!!geo.attributes.normal&&geo.index!==null;
    const gl=renderer.getContext();out.glError=gl.getError();renderer.dispose();return out;});
    console.log('   ',JSON.stringify(r));assert(r.meshes===3&&r.counts.every(c=>c===12)&&r.parents,'shell meshes');assert(r.rendered===12,'close range renders all shells');
    assert(!r.offVisible&&r.offRendered===0&&r.onVisible,'KE.settings.fur');assert(r.set===6&&r.afterSet.every(c=>c===6),'setShells');assert(r.farRendered===0,'distance LOD');assert(r.inertia,'velocity inertia');
    assert(r.childrenLeft===0&&r.sourceIntact,'dispose detaches shells and keeps source geometry');assert(r.after.geo===r.base.geo&&r.after.tex===r.base.tex,'GPU memory returns to baseline '+JSON.stringify(r));assert(r.glError===0,'gl error');});
  await test('spawner: deterministic Poisson placement, slope limit, distance LOD rebuilds and dispose',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine;
    const scene=new T.Scene(),cam=new T.PerspectiveCamera(60,1.5,.1,500);cam.position.set(0,10,0);cam.lookAt(0,0,-1);cam.updateMatrixWorld();
    const tex=KE.leafTexture(T,{species:'bush',size:64}),tree=KE.treeGeometry(T,{species:'bush',seed:1,leafCards:{texture:tex}});const mats={trunk:KE.barkMaterial(T,{}),leaves:KE.foliageMaterial(T,{map:tex})};
    const heightAt=(x,z)=>x>30?(x-30)*2:0;
    const make=()=>new KE.FoliageSpawner(T,scene,{bounds:{minX:-40,minZ:-40,maxX:40,maxZ:40},heightAt,seed:7,cellSize:10,frustumCull:false,types:[{name:'bush',geometry:tree,material:mats,spacing:3,scale:[.8,1.2],maxSlope:30,lodDistances:[25,60]}]});
    const a=make(),b=make();const ma=a.groups[0].matrices,mb=b.groups[0].matrices;let same=ma.length===mb.length;for(let i=0;same&&i<ma.length;i++)same=ma[i]===mb[i];
    let steep=0,minD=1e9;const xs=[];for(let i=0;i<a.groups[0].count;i++){const x=ma[i*16+12],z=ma[i*16+14];if(x>30.5)steep++;xs.push([x,z]);}
    for(let i=0;i<Math.min(400,xs.length);i++)for(let j=i+1;j<xs.length;j++)minD=Math.min(minD,Math.hypot(xs[i][0]-xs[j][0],xs[i][1]-xs[j][1]));
    const count=a.count;b.dispose();const r1=a.update(cam),vis1=a.visibleCount,r2=a.update(cam);const lod0=a.groups[0].levels[0].meshes[0].count,lod1=a.groups[0].levels[1].meshes[0].count;
    cam.position.set(0,10,400);cam.updateMatrixWorld();const r3=a.update(cam),vis3=a.visibleCount;
    const meshes=a.groups[0].meshes.length,depth=!!a.groups[0].meshes.find(m=>m.material===mats.leaves).customDepthMaterial;a.dispose();let left=0;scene.traverse(o=>{if(o.isInstancedMesh)left++;});
    return {count,same,steep,minD,r1,r2,r3,vis1,vis3,lod0,lod1,meshes,depth,left};});
    console.log('   ',JSON.stringify(r));assert(r.count>100&&r.same,'deterministic');assert(r.steep===0,'slope limit');assert(r.minD>=3*.999,'Poisson spacing '+r.minD);
    assert(r.r1===true&&r.r2===false&&r.r3===true,'rebuild only on change');assert(r.lod0>0&&r.lod1>0&&r.vis1===r.lod0+r.lod1&&r.vis3===0,'LOD bands');assert(r.meshes===4&&r.depth,'meshes');assert(r.left===0,'dispose');});
  await test('applyWind chains an existing hook (KE.surface) and spawner hands off to KE.InstancedLOD when present',async()=>{const r=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine;
    const renderer=new T.WebGLRenderer();renderer.setSize(64,64);const scene=new T.Scene(),cam=new T.PerspectiveCamera(50,1,.1,100);cam.position.set(0,1,3);cam.lookAt(0,0,0);scene.add(new T.DirectionalLight(0xffffff,1));
    const fern=KE.foliage.addWindWeights(T,KE.fernGeometry(T),{flutter:1});const mat=KE.surface(T,'leaf',{color:0x88aa55,textureSize:64});const surfaceKey=mat.customProgramCacheKey();
    KE.foliage.applyWind(T,mat,{wind:{trunk:0,branch:.1,leaf:.2}});let fs='',vs='';const prev=mat.onBeforeCompile;mat.onBeforeCompile=function(sh,rr){prev.call(this,sh,rr);fs=sh.fragmentShader;vs=sh.vertexShader;};
    const mesh=KE.foliage.attach(new T.Mesh(fern,mat));scene.add(mesh);renderer.render(scene,cam);
    const calls={update:0,dispose:0,opts:null};KE.InstancedLOD=class{constructor(THREE,scene,opts){calls.opts={count:opts.count,levels:opts.levels.length,parts:opts.levels[0].parts.length,depth:!!opts.levels[0].parts[0].customDepthMaterial};}update(){calls.update++;}dispose(){calls.dispose++;}};KE.InstancedLOD.foliageContract=1;
    const sp=new KE.FoliageSpawner(T,scene,{bounds:{minX:-10,minZ:-10,maxX:10,maxZ:10},seed:2,types:[{name:'fern',geometry:fern,material:mat,spacing:1.5}]});sp.update(cam);const backend=sp.backend;sp.dispose();delete KE.InstancedLOD;
    const out={surfaceKept:vs.includes('ksWorld')&&fs.includes('keDetail'),wind:vs.includes('kfWind('),key:mat.customProgramCacheKey(),surfaceKey,depth:!!mesh.customDepthMaterial,backend,calls,err:renderer.getContext().getError()};renderer.dispose();return out;});
    console.log('   ',JSON.stringify(r));assert(r.surfaceKept&&r.wind,'both hooks in the program');assert(r.key.startsWith(r.surfaceKey)&&r.key.includes('ke-foliage-2-main'),'chained cache key');assert(r.depth,'attach adds depth material');
    assert(r.backend==='InstancedLOD'&&r.calls.update===1&&r.calls.dispose===1&&r.calls.opts.count>20&&r.calls.opts.depth,'InstancedLOD hand-off '+JSON.stringify(r.calls));assert(r.err===0,'gl error');});
  await close();
 }
 /* ---------------- screenshots ---------------- */
 const shot=async(key,build,{width=640,height=400}={})=>{
  const {page,close,outDir}=await openPage({modules:MODULES,viewport:{width,height},name:'foliage-'+key});
  await page.evaluate(PRELUDE);
  const info=await page.evaluate(build);console.log('   ',key,JSON.stringify(info));
  const file=path.join(outDir,'foliage-'+key+'.png');await page.screenshot({path:file,timeout:180000});console.log('   screenshot',file);await close();return info;};

 if(run('forest'))await test('screenshot: mixed forest on a grassy hill at golden hour',()=>shot('forest',async()=>{
  const T=THREE,KE=KitsuneEngine;KE.applyPreset('high');const renderer=mkRenderer();const scene=new T.Scene();
  scene.background=skyTexture('#6f8fb8','#e8b98a','#f4c38e');scene.fog=new T.Fog(0xe6b88c,38,110);
  const cam=new T.PerspectiveCamera(52,innerWidth/innerHeight,.1,300);cam.position.set(0,1.5,19);
  const heightAt=(x,z)=>3.2*Math.exp(-((x-1)**2+(z+6)**2)/360)+.25*fbm(x*.08,z*.08);
  cam.position.y+=heightAt(0,19)+.2;cam.lookAt(0,heightAt(0,0)+2.2,-4);
  scene.add(terrainMesh(heightAt,160,150,(x,z)=>{const n=.5+.5*fbm(x*.15,z*.15);return [.3+.08*n,.34+.06*n,.14];}));
  const sun=new T.DirectionalLight(0xffc07a,3.8);sun.position.set(-46,10,-3);sun.target.position.set(0,0,-4);scene.add(sun,sun.target);
  scene.add(new T.HemisphereLight(0x9db5d6,0x4a3c22,.7));
  const tex={},mat={},geo={};const kinds=[['broadleaf',11,6.2],['broadleaf2',12,5.4],['conifer',21,8.5],['birch',31,7],['sakura',41,4.6],['bush',51,1.3]];
  for(const [k,seed,height] of kinds){const species=k.replace(/\d$/,'');tex[species]=tex[species]||KE.leafTexture(T,{species,size:512});const sp=KE.foliage.species[species];
    geo[k]=KE.treeGeometry(T,{species,seed,height,leafCards:{texture:tex[species]}});
    mat[species]=mat[species]||{trunk:KE.barkMaterial(T,{species,color:sp.barkColor,vertexColors:true}),leaves:KE.foliageMaterial(T,{map:tex[species],vertexColors:true,translucencyColor:sp.transColor,roughness:.7})};}
  const t0=performance.now(),clear=(x,z)=>Math.abs(x+z*.25)>2.6&&z<9;
  const spawner=new KE.FoliageSpawner(T,scene,{bounds:{minX:-45,minZ:-60,maxX:45,maxZ:12},heightAt,seed:5,cellSize:16,types:[
    {name:'conifer',geometry:geo.conifer,material:mat.conifer,spacing:4.5,scale:[.8,1.25],density:(x,z)=>clear(x,z)&&x<-5?.95:0},
    {name:'birch',geometry:geo.birch,material:mat.birch,spacing:3.6,scale:[.85,1.1],density:(x,z)=>clear(x,z)&&x>-6&&x<3&&z<-6?.9:0},
    {name:'sakura',geometry:geo.sakura,material:mat.sakura,spacing:6,scale:[.9,1.15],density:(x,z)=>clear(x,z)&&x>4?.9:0},
    {name:'broadleaf',geometry:geo.broadleaf,material:mat.broadleaf,spacing:6.5,scale:[.85,1.15],density:(x,z)=>clear(x,z)&&z<-14?.8:.05},
    {name:'broadleaf2',geometry:geo.broadleaf2,material:mat.broadleaf,spacing:7,scale:[.85,1.1],density:(x,z)=>clear(x,z)&&z<-10?.6:0},
    {name:'bush',geometry:geo.bush,material:mat.bush,spacing:2.8,scale:[.7,1.3],density:(x,z)=>clear(x,z)?.45:0,castShadow:false}]});
  const spawnMs=performance.now()-t0;
  const csm=new KE.CascadedShadows(T,scene,{sun,cascades:2,mapSize:1024,maxFar:70,margin:30});csm.setupScene();KE.foliage.setShadowSource(csm);
  const grass=KE.grassField(T,scene,{count:20000,radius:16,heightAt,bladeHeight:[.3,.6],density:(x,z)=>.9,tipColor:0xd8c87a,
    color:(x,z,out)=>{const n=.5+.5*fbm(x*.2+3,z*.2);out[0]=.3+.12*n;out[1]=.4+.06*n;out[2]=.14;return out;}});
  grass.update(cam.position.x,cam.position.z);spawner.update(cam);
  KE.foliage.update(1.3,{wind:1,windDir:[.7,.3]});
  for(let i=0;i<2;i++){csm.update(cam);renderer.render(scene,cam);}
  window.forest={renderer,scene,cam,spawner,grass,csm};
  return {instances:spawner.count,visible:spawner.visibleCount,spawnMs:Math.round(spawnMs),grass:grass.stats.capacity,programs:renderer.info.programs.length,tris:renderer.info.render.triangles};
 }));

 if(run('grass'))await test('screenshot: grass bending around a sphere player',()=>shot('grass',async()=>{
  const T=THREE,KE=KitsuneEngine;KE.applyPreset('high');const renderer=mkRenderer();const scene=new T.Scene();
  scene.background=skyTexture('#5d86c0','#a9c6e4','#dfe8ef');scene.fog=new T.Fog(0xcfdde8,8,26);
  const cam=new T.PerspectiveCamera(45,innerWidth/innerHeight,.05,100);cam.position.set(.4,2.3,3.1);cam.lookAt(0,.2,-.1);
  const heightAt=(x,z)=>.06*fbm(x*.4,z*.4);
  scene.add(terrainMesh(heightAt,40,80,(x,z)=>[.2,.26,.1]));
  const sun=new T.DirectionalLight(0xfff0d8,3);sun.position.set(-6,9,-4);scene.add(sun,sun.target);scene.add(new T.HemisphereLight(0xb4cdef,0x3c3a22,.7));
  const ball=new T.Mesh(new T.SphereGeometry(.42,48,32),new T.MeshStandardMaterial({color:0xd9573a,roughness:.35,metalness:.05}));ball.position.set(0,.42+heightAt(0,0),0);ball.castShadow=true;scene.add(ball);
  const csm=new KE.CascadedShadows(T,scene,{sun,cascades:1,mapSize:1024,maxFar:14,margin:10});csm.setupScene();
  const grass=KE.grassField(T,scene,{count:26000,radius:8,heightAt,bladeHeight:[.3,.62],bladeWidth:.045,shadows:csm,tipColor:0xc8cf78,
    color:(x,z,out)=>{const n=.5+.5*fbm(x*.9,z*.9+5);out[0]=.2+.12*n;out[1]=.36+.08*n;out[2]=.1;return out;}});
  grass.update(0,0);KE.foliage.update(2.1,{wind:.8,windDir:[1,.2],interactors:[{position:ball.position,radius:.5}]});
  for(let i=0;i<2;i++){csm.update(cam);renderer.render(scene,cam);}
  return {grass:grass.stats.capacity,tris:renderer.info.render.triangles,programs:renderer.info.programs.length};
 }));

 if(run('fox'))await test('screenshot: furry fox built from spheres',()=>shot('fox',async()=>{
  const T=THREE,KE=KitsuneEngine;KE.applyPreset('high');const renderer=mkRenderer();const scene=new T.Scene();
  scene.background=skyTexture('#7fa3cf','#c9d9e6','#e9e2cf');
  const cam=new T.PerspectiveCamera(36,innerWidth/innerHeight,.05,60);cam.position.set(-2.1,1.35,-2.5);cam.lookAt(0,.74,-.1);
  const lin=h=>new T.Color(h).convertSRGBToLinear();
  const ground=new T.Mesh(new T.CircleGeometry(12,48),new T.MeshStandardMaterial({color:lin(0x5d6b3c),roughness:1}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
  const sun=new T.DirectionalLight(0xfff1dc,3.2);sun.position.set(-3,5,-4.5);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-2,right:2,top:2,bottom:-2,near:.5,far:20});sun.shadow.bias=-.0005;scene.add(sun,sun.target);
  scene.add(new T.HemisphereLight(0xc4d8f2,0x5a5236,.8));
  const orange=new T.MeshStandardMaterial({color:lin(0xd0702c),roughness:.9}),cream=new T.MeshStandardMaterial({color:lin(0xf3e2c0),roughness:.95}),ink=new T.MeshStandardMaterial({color:lin(0x2b2420),roughness:.8}),
    nose=new T.MeshStandardMaterial({color:lin(0x121214),roughness:.3}),eye=new T.MeshStandardMaterial({color:lin(0x3a220c),roughness:.12});
  const fox=new T.Group();scene.add(fox);const shortFur=new Set();
  const orb=(r,m,x,y,z,sx=1,sy=1,sz=1,parent=fox)=>{const o=new T.Mesh(new T.SphereGeometry(r,28,20),m);o.position.set(x,y,z);o.scale.set(sx,sy,sz);o.castShadow=o.receiveShadow=true;parent.add(o);return o;};
  orb(.34,orange,0,.58,.03,1,1.06,1.62);orb(.28,orange,0,.78,-.3,1,1.25,1.1);orb(.255,cream,0,.65,-.38,.8,1.27,.6);shortFur.add(orb(.29,orange,0,1.03,-.43,1.12,.97,1.03));
  shortFur.add(orb(.2,orange,-.22,1.0,-.39,.82,.7,.9));shortFur.add(orb(.2,orange,.22,1.0,-.39,.82,.7,.9));shortFur.add(orb(.23,cream,0,.92,-.63,.82,.53,1.02));shortFur.add(orb(.17,cream,0,.87,-.66,.87,.32,1));orb(.07,nose,0,.96,-.86,1.05,.64,.7);
  for(const x of [-.19,.19]){const e=new T.Group();e.position.set(x,1.2,-.37);e.rotation.z=x<0?.2:-.2;fox.add(e);shortFur.add(orb(.12,orange,0,.14,0,.9,1.9,.45,e));orb(.07,ink,0,.33,.005,.7,1.1,.5,e);}
  for(const x of [-.16,.16]){orb(.062,ink,x,1.09,-.69,1.05,.68,.46);orb(.045,eye,x,1.094,-.712,.8,.9,.45);}
  for(const x of [-.205,.205])for(const z of [-.27,.34]){const leg=new T.Group();leg.position.set(x,.52,z);fox.add(leg);shortFur.add(orb(.096,orange,0,-.13,0,1,1.9,1,leg));orb(.083,ink,0,-.32,-.01,.8,1.2,.85,leg);orb(.1,ink,0,-.43,-.052,.94,.52,1.36,leg);}
  const tail=new T.Group();tail.position.set(0,.55,.41);fox.add(tail);
  for(let i=0;i<6;i++){const t=i/5;orb(.1+.12*Math.sin(Math.PI*(.2+.7*t)),t>.8?cream:orange,.04+.18*t,.08+.36*t*t,.12+.78*t,1,1,1.25,tail);}
  fox.rotation.y=.25;
  const fur=KE.fur(T,fox,{shells:24,length:.07,density:1400,thickness:.65,colorVariation:.22,include:m=>m.material===orange||m.material===cream?(shortFur.has(m)?.5:1.25):false});
  fur.update(1/60,new T.Vector3(0,0,0));
  for(let i=0;i<2;i++)renderer.render(scene,cam);
  return {meshes:fur.meshes.length,shells:fur.renderedShells,tris:renderer.info.render.triangles,programs:renderer.info.programs.length};
 }));
 console.log(failed?failed+' FAILED':'ALL PASSED');process.exit(failed?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
