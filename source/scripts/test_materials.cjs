/* Browser checks for KE.MaterialGraph / KE.shaderGraph / KE.materialLibrary (20-materials.js).
   node scripts/test_materials.cjs            (writes .test-output/materials-*.png)
   Page 1: validation, every node type (lit + unlit, fragment + vertex stage), instances, parameter updates,
           WPO silhouettes, shadow-pass alpha clip, hook chaining, labelled library gallery.
   Page 2: composition with KE.CascadedShadows, KE.ProbeVolume and KE.Pipeline (refraction, depth fade). */
const {openPage}=require('./harness.cjs');const path=require('path');
let failed=0;
const test=async(name,fn)=>{try{const info=await fn();console.log('PASS '+name+(info?'  '+info:''));}catch(e){failed++;console.log('FAIL '+name+'\n  '+String(e&&e.stack||e).split('\n').slice(0,6).join('\n  '));}};
const assert=(c,msg)=>{if(!c)throw new Error(msg);};

/* Node-only checks of the pure code generator (module loaded into a vm with a minimal KE stub). */
async function nodeOnly(){
 const vm=require('vm'),fs=require('fs');const KE={registerModule(){},settings:{preset:'high',tex:256},LAYERS:{TRANSLUCENT:1}};const ctx={window:{KitsuneEngine:KE},console,performance:{now:()=>0}};vm.createContext(ctx);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/modules/20-materials.js'),'utf8'),ctx);const MG=KE.MaterialGraph;
 await test('node: helpers are deduplicated and every generated identifier is declared once',async()=>{
  const g={nodes:[{id:'a',type:'Noise',kind:'perlin',in:{p:'@worldPos'}},{id:'b',type:'Noise',kind:'fbm',in:{p:'@worldPos'}},{id:'c',type:'Noise',kind:'fbm',octaves:3,in:{p:'@worldPos'}},{id:'v',type:'Noise',kind:'voronoi',in:{p:'@worldPos'}},
    {id:'s',type:'Add',in:{a:'a',b:'b'}},{id:'s2',type:'Add',in:{a:'s',b:'c'}},{id:'s3',type:'Add',in:{a:'s2',b:'v.edge'}},{id:'unused',type:'Noise',kind:'simplex'}],outputs:{roughness:'s3',baseColor:'s3',worldPositionOffset:{type:'Multiply',in:{a:'@worldNormal',b:'a'}}}};
  const out=MG.generate(g),frag=out.fragmentDeclarations+'\n'+out.fragmentMain,count=(src,re)=>(src.match(re)||[]).length;
  assert(count(frag,/float kmgPerlin3\(/g)===1&&count(frag,/vec3 kmgHash33\(/g)===1,'helper duplicated');
  assert(count(frag,/kmgFbm_fbm_perlin3_5\(vec3/g)===1&&count(frag,/kmgFbm_fbm_perlin3_3\(vec3/g)===1,'fbm variants');
  assert(!/kmgSimplex/.test(frag),'dead node was compiled');
  const decl=[...(out.fragmentMain.matchAll(/^\s*(?:float|vec[234]|mat3) (kmg\w+) =/gm))].map(m=>m[1]);assert(decl.length===new Set(decl).size,'duplicate locals '+decl);
  assert(/kmgPerlin3/.test(out.vertexDeclarations)&&/kmgWPO/.test(out.vertexMain),'vertex stage WPO');
  assert(MG.cacheKey(g)===MG.cacheKey(JSON.parse(JSON.stringify(g))),'key not deterministic');
  const g2=JSON.parse(JSON.stringify(g));g2.nodes[0].kind='value';assert(MG.cacheKey(g)!==MG.cacheKey(g2),'key ignores structure');
  return `(${decl.length} locals, key ${out.key})`;});
 await test('node: builder produces a plain JSON graph; literals and swizzles',async()=>{
  const graph=KE.shaderGraph.build(g=>({baseColor:g.lerp(g.color('#2d5a27'),g.param('tip','color','#b8d468'),g.noise(g.worldPos().xz.mul(.4),{kind:'fbm'})),roughness:.8}));
  const json=JSON.parse(JSON.stringify(graph));const v=MG.validate(json);assert(v.ok,JSON.stringify(v.errors));
  assert(json.nodes.some(n=>n.type==='Noise'&&n.kind==='fbm')&&json.params.tip.type==='color','builder output '+JSON.stringify(json).slice(0,300));
  const out=MG.generate(json);assert(/vKmgWorldPos\.xz \* vec2\(0\.4\)/.test(out.fragmentMain),'swizzle/broadcast codegen');});
}

async function pageOne(){
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/20-materials.js'],viewport:{width:640,height:400},name:'materials'});
 await page.evaluate(()=>{
  const T=THREE,KE=KitsuneEngine,MG=KE.MaterialGraph;
  window.__errs=[];const ce=console.error.bind(console);console.error=(...a)=>{window.__errs.push(a.map(String).join(' ').slice(0,4000));ce(...a);};
  const renderer=new T.WebGLRenderer({preserveDrawingBuffer:true});renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.debug.checkShaderErrors=true;document.body.append(renderer.domElement);
  const rt=new T.WebGLRenderTarget(64,64),buf=new Uint8Array(64*64*4);
  const read=(scene,cam,target=rt)=>{renderer.setRenderTarget(target);renderer.setClearColor(0x000000,1);renderer.clear();renderer.render(scene,cam);renderer.setRenderTarget(null);renderer.readRenderTargetPixels(target,0,0,target.width,target.height,buf);return buf;};
  const px=(b,x,y,w=64)=>{const i=(y*w+x)*4;return [b[i],b[i+1],b[i+2],b[i+3]];};
  const source=m=>{const p=renderer.properties.get(m).currentProgram;if(!p)return '';const gl=renderer.getContext();return gl.getAttachedShaders(p.program).map(s=>gl.getShaderSource(s)).join('\n');};
  const texData=new Uint8Array(16*16*4);for(let i=0;i<256;i++){texData.set([(i*37)&255,(i*11)&255,200,(i*5)&255],i*4);}const tex=new T.DataTexture(texData,16,16,T.RGBAFormat);tex.wrapS=tex.wrapT=T.RepeatWrapping;tex.needsUpdate=true;
  window.t={T,KE,MG,renderer,rt,read,px,source,tex};
 });

 await test('validate() reports cycles, unknown refs/types/params, type and stage errors, bad CustomGLSL',async()=>{
  const r=await page.evaluate(()=>{const {MG}=t,v=g=>MG.validate(g),codes=res=>res.errors.map(e=>e.code+':'+(e.node||'')+':'+e.message);
   const out={};
   out.ok=v({nodes:[{id:'n',type:'Noise',kind:'fbm',in:{p:'wp'}},{id:'wp',type:'WorldPosition'}],params:{tint:{type:'color',value:'#ff0000'}},outputs:{baseColor:{type:'Lerp',in:{a:'#000000',b:{type:'Param',name:'tint'},alpha:'n'}}}});
   out.cycle=v({nodes:[{id:'a',type:'Add',in:{a:'b',b:1}},{id:'b',type:'Multiply',in:{a:'a',b:2}}],outputs:{roughness:'a'}});
   out.unusedCycle=v({nodes:[{id:'a',type:'Add',in:{a:'b'}},{id:'b',type:'Add',in:{a:'a'}}],outputs:{roughness:.5}});
   out.mismatch=v({nodes:[{id:'u',type:'UV'},{id:'w',type:'WorldPosition'},{id:'s',type:'Add',in:{a:'u',b:'w'}}],outputs:{baseColor:'s'}});
   out.outType=v({nodes:[{id:'w',type:'WorldPosition'}],outputs:{roughness:'w'}});
   out.stage=v({nodes:[{id:'s',type:'ScreenUV'},{id:'a',type:'Append',in:{a:'s',b:0}}],outputs:{worldPositionOffset:'a'}});
   out.unknown=v({nodes:[{id:'x',type:'Bogus'},{id:'y',type:'Add',in:{a:'missing'}},{id:'p',type:'Param',name:'nope'}],outputs:{roughness:'y',metallic:'p'}});
   out.custom=[v({nodes:[{id:'c',type:'CustomGLSL',code:'a; discard',inputs:{a:'float'}}],outputs:{roughness:'c'}}),v({nodes:[{id:'c',type:'CustomGLSL',code:'a = 1.0',inputs:{a:'float'}}],outputs:{roughness:'c'}}),
     v({nodes:[{id:'c',type:'CustomGLSL',code:'texture2D(foo, a.xy).r',inputs:{a:'vec2'}}],outputs:{roughness:'c'}}),v({nodes:[{id:'c',type:'CustomGLSL',code:'#define X 1\na',inputs:{a:'float'}}],outputs:{roughness:'c'}}),
     v({nodes:[{id:'c',type:'CustomGLSL',code:'mix(a, b.x, 0.5) * 1e-2 + 2.5',inputs:{a:'float',b:'vec3'}}],outputs:{roughness:'c'}})];
   out.physical=v({nodes:[],outputs:{clearcoat:1}});
   out.swizzle=v({nodes:[{id:'u',type:'UV'}],outputs:{roughness:'u.z'}});
   return {ok:out.ok.ok,okTypes:out.ok.types,cycle:codes(out.cycle),unusedCycle:codes(out.unusedCycle),mismatch:codes(out.mismatch),outType:codes(out.outType),stage:codes(out.stage),unknown:codes(out.unknown),
     custom:out.custom.map(x=>x.ok?'ok':codes(x)[0]),physical:codes(out.physical),swizzle:codes(out.swizzle)};});
  assert(r.ok&&r.okTypes.n==='float'&&r.okTypes.wp==='vec3','valid graph rejected '+JSON.stringify(r.okTypes));
  assert(r.cycle.some(e=>e.startsWith('cycle')),'cycle not caught '+r.cycle);assert(r.unusedCycle.some(e=>e.startsWith('cycle')),'unreachable cycle not caught');
  assert(r.mismatch.some(e=>e.startsWith('type:s')&&/vec2 and vec3/.test(e)),'vec2+vec3 not caught '+r.mismatch);
  assert(r.outType.some(e=>/expects float, got vec3/.test(e)),'output type not caught '+r.outType);
  assert(r.stage.some(e=>e.startsWith('stage:s')),'fragment-only node in WPO not caught '+r.stage);
  assert(r.unknown.some(e=>/unknown node type 'Bogus'/.test(e))&&r.unknown.some(e=>/unknown node 'missing'/.test(e))&&r.unknown.some(e=>/unknown param 'nope'/.test(e)),'unknown refs '+r.unknown);
  assert(r.custom.slice(0,4).every(c=>c!=='ok'&&/custom/.test(c))&&r.custom[4]==='ok','CustomGLSL validation '+JSON.stringify(r.custom));
  assert(r.physical.some(e=>/requires model 'physical'/.test(e)),'physical output on standard not caught');
  assert(r.swizzle.some(e=>/reads past vec2/.test(e)),'bad swizzle not caught');
  return `(${r.cycle.length+r.mismatch.length+r.stage.length+r.unknown.length} errors reported as expected)`;
 });

 await test('every node type compiles and renders (standard + unlit, fragment and vertex stage)',async()=>{
  const r=await page.evaluate(()=>{const {T,MG,renderer,read,px,tex}=t;
   const scene=new T.Scene(),cam=new T.PerspectiveCamera(50,1,.1,20);cam.position.set(0,.3,2.4);cam.lookAt(0,0,0);scene.add(new T.DirectionalLight(0xffffff,2),new T.AmbientLight(0xffffff,.4));
   const geo=new T.SphereGeometry(.8,24,12);geo.setAttribute('color',new T.Float32BufferAttribute(new Array(geo.attributes.position.count*3).fill(.7),3));const mesh=new T.Mesh(geo);scene.add(mesh);
   const special={Constant:{value:.5},Float:{value:.25},Vec2:{value:[.2,.4]},Vec3:{value:[.1,.2,.3]},Vec4:{value:[.1,.2,.3,1]},Color:{value:'#ff8800'},Param:{name:'p'},
     Texture2D:{param:'tex'},TriplanarSample:{param:'tex',space:'linear'},TriplanarNormal:{param:'tex'},NormalMap:{param:'tex'},ParallaxOcclusion:{param:'tex',steps:8,channel:'a'},
     ComponentMask:{mask:'yx',in:{x:[1,2,3]}},CustomGLSL:{code:'a * 2.0 + sin(b) * vec3(0.5, 0.2, 0.1).zyx',out:'vec3',inputs:{a:'vec3',b:'float'},in:{a:[.1,.2,.3],b:1}},Compare:{op:'<=',in:{a:.2,b:.5}},
     Append:{in:{a:[.1,.2],b:.5}},Remap:{clamp:true,in:{x:.3,inMin:0,inMax:2,outMin:1,outMax:3}}};
   const cases=[];for(const type of Object.keys(MG.nodeTypes)){if(MG.nodeTypes[type].virtual)continue;cases.push([type,{...(special[type]||{})}]);}
   for(const kind of ['value','perlin','simplex','voronoi','fbm','ridged','turbulence'])for(const p of ['@uv','@worldPos'])cases.push(['Noise',{kind,octaves:3,in:{p}},kind+(p==='@uv'?'2D':'3D')]);
   for(const op of ['>','>=','<','==','!='])cases.push(['Compare',{op},op]);
   cases.push(['Noise',{kind:'voronoi',in:{p:'@worldPos'},port:'edge'},'voronoi.edge'],['Noise',{kind:'fbm',base:'simplex',octaves:2,in:{p:'@worldPos'},port:'signed'},'fbm-simplex.signed'],['UV',{channel:1},'uv2'],['Bump',{space:'world'},'world']);
   const fails=[],stats={frag:0,vert:0,unlit:0};
   for(const [type,props,label] of cases){const name=type+(label?'('+label+')':''),{port,...p}=props;
     const graph={params:{p:{type:'color',value:'#33aa66'},tex:{type:'texture',value:tex}},nodes:[{id:'n',type,...p}]};
     const ref=port?'n.'+port:'n';const v=MG.validate({...graph,outputs:{emissive:ref==='n'?'n':{type:'Append',in:{a:ref,b:[0,0]}}}});
     if(v.types.n===undefined){fails.push(name+': '+JSON.stringify(v.errors.concat(v.warnings)));continue;}
     const ty=port?'float':v.types.n,adapt=ty==='vec2'?{type:'Append',in:{a:ref,b:0}}:ref;
     const vertexOK=MG.nodeTypes[type].stage!=='fragment';
     for(const model of ['standard','unlit']){const before=window.__errs.length;let m;
       try{const outs={emissive:adapt,baseColor:[.2,.2,.2]};if(vertexOK)outs.worldPositionOffset={type:'Multiply',in:{a:adapt,b:0}};
         m=MG.compile(T,{...graph,outputs:outs},{model});mesh.material=m;const b=read(scene,cam),c=px(b,32,32);
         if(window.__errs.length>before)fails.push(name+'/'+model+': '+window.__errs.slice(before).join(' | ').slice(0,1500));
         else if(c.slice(0,3).some(x=>!Number.isFinite(x)))fails.push(name+'/'+model+': bad pixel');
         else{stats[model==='unlit'?'unlit':'frag']++;if(vertexOK&&model==='standard')stats.vert++;}}
       catch(e){fails.push(name+'/'+model+': '+e.message);}finally{if(m)m.dispose();}}}
   return {cases:cases.length,types:Object.keys(MG.nodeTypes).filter(k=>!MG.nodeTypes[k].virtual).length,fails,stats,programs:renderer.info.programs.length};});
  assert(!r.fails.length,r.fails.join('\n'));
  return `(${r.types} node types, ${r.cases} cases; lit ${r.stats.frag}, unlit ${r.stats.unlit}, vertex-stage ${r.stats.vert})`;
 });

 await test('instances share one program yet render different colours; unset params follow the parent',async()=>{
  const r=await page.evaluate(()=>{const {T,MG,KE,renderer,read,px}=t;
   const scene=new T.Scene(),cam=new T.OrthographicCamera(-1,1,1,-1,.1,10);cam.position.z=2;
   const base=KE.shaderGraph(T,g=>({baseColor:[0,0,0],roughness:1,emissive:g.param('tint','color','#ff0000').mul(g.param('gain','float',1))}),{name:'inst-base'});
   const a=new T.Mesh(new T.PlaneGeometry(1,2),base);a.position.x=-.5;scene.add(a);read(scene,cam);const programs0=renderer.info.programs.length,patches0=MG.stats.patches;
   const inst=MG.instance(base,{tint:'#0000ff'});const b=new T.Mesh(new T.PlaneGeometry(1,2),inst);b.position.x=.5;scene.add(b);
   let buf=read(scene,cam);const left=px(buf,16,32),right=px(buf,48,32);
   const same=renderer.properties.get(base).currentProgram===renderer.properties.get(inst).currentProgram,keys=[base.customProgramCacheKey(),inst.customProgramCacheKey()];
   base.params.gain=.5;buf=read(scene,cam);const left2=px(buf,16,32),right2=px(buf,48,32);
   inst.params.gain=1;base.params.tint='#00ff00';buf=read(scene,cam);const left3=px(buf,16,32),right3=px(buf,48,32);
   return {left,right,left2,right2,left3,right3,same,keys,programsAdded:renderer.info.programs.length-programs0,patches:MG.stats.patches-patches0,parent:MG.parentOf(inst)===base,instGainOwn:inst.getParam('gain')};});
  assert(r.same&&r.keys[0]===r.keys[1],'instance did not share the program');assert(r.programsAdded===0,'instance created '+r.programsAdded+' programs');
  assert(r.left[0]>200&&r.left[2]<30&&r.right[2]>200&&r.right[0]<30,'colours '+JSON.stringify([r.left,r.right]));
  assert(r.left2[0]<150&&r.left2[0]>60&&r.right2[2]<150&&r.right2[2]>60,'parent gain did not propagate to the instance '+JSON.stringify([r.left2,r.right2]));
  assert(r.left3[1]>60&&r.left3[0]<30&&r.right3[2]>200,'override/propagation mix '+JSON.stringify([r.left3,r.right3]));
  return `(program shared, key ${r.keys[0].slice(0,20)}…, ${r.patches} onBeforeCompile for the instance, 0 new programs)`;
 });

 await test('parameter updates do not recompile; cache key depends on structure only',async()=>{
  const r=await page.evaluate(()=>{const {T,MG,KE,renderer,read,px,tex}=t;
   const scene=new T.Scene(),cam=new T.OrthographicCamera(-1,1,1,-1,.1,10);cam.position.z=2;
   const graph=g=>({baseColor:[0,0,0],roughness:1,emissive:g.texture2D(g.param('map','texture',null),[.5,.5],{space:'linear'}).rgb.mul(g.param('tint','color','#808080')).mul(g.param('k','float',1)).add(g.param('off','vec3',[0,0,0]))});
   const m=KE.shaderGraph(T,graph);scene.add(new T.Mesh(new T.PlaneGeometry(2,2),m));read(scene,cam);
   const p0=renderer.info.programs.length,patch0=MG.stats.patches,v0=m.version,prog0=renderer.properties.get(m).currentProgram;const seen=[];
   for(const [k,v] of [['tint','#ff0000'],['k',.25],['off',[0,.5,0]],['map',tex],['map',null],['tint',new T.Color(0,0,1)]]){m.params[k]=v;const b=read(scene,cam);seen.push(px(b,32,32).slice(0,3).join(','));}
   const g1=KE.shaderGraph.build(graph),g2=KE.shaderGraph.build(graph);g2.params.tint.value='#00ff00';g2.params.k.value=7;const g3=KE.shaderGraph.build(g=>({...graph(g),roughness:.5}));
   return {programs:renderer.info.programs.length-p0,patches:MG.stats.patches-patch0,version:m.version-v0,sameProgram:renderer.properties.get(m).currentProgram===prog0,seen,
     keyEqual:MG.cacheKey(g1)===MG.cacheKey(g2),keyDiff:MG.cacheKey(g1)!==MG.cacheKey(g3)};});
  assert(r.programs===0&&r.patches===0&&r.version===0&&r.sameProgram,'recompiled '+JSON.stringify(r));
  assert(new Set(r.seen).size>=5,'param edits did not change the output '+r.seen.join(' / '));
  assert(r.keyEqual&&r.keyDiff,'cache key not structural');
  return `(6 edits: ${r.seen.join(' | ')})`;
 });

 await test('worldPositionOffset changes the silhouette (also for InstancedMesh)',async()=>{
  const r=await page.evaluate(()=>{const {T,MG,KE,read}=t;
   const scene=new T.Scene(),cam=new T.OrthographicCamera(-1.2,1.2,1.2,-1.2,.1,10);cam.position.z=3;
   const flat=KE.shaderGraph(T,g=>({emissive:[1,1,1]}),{model:'unlit'}),puff=KE.shaderGraph(T,g=>({emissive:[1,1,1],worldPositionOffset:g.worldNormal().mul(g.param('amount','float',.3))}),{model:'unlit'});
   const count=b=>{let n=0;for(let i=0;i<b.length;i+=4)if(b[i]>128)n++;return n;};
   const mesh=new T.Mesh(new T.SphereGeometry(.5,32,16),flat);scene.add(mesh);const c0=count(read(scene,cam));mesh.material=puff;const c1=count(read(scene,cam));
   puff.params.amount=0;const c2=count(read(scene,cam));
   // instanced: two instances offset along x; WPO must follow each instance's world position
   scene.remove(mesh);const lit=KE.shaderGraph(T,g=>({baseColor:[0,0,0],emissive:[1,1,1],worldPositionOffset:g.vec3(0,g.worldPos().x.sign().mul(.4),0)}));const im=new T.InstancedMesh(new T.BoxGeometry(.4,.4,.4),lit,2);
   im.setMatrixAt(0,new T.Matrix4().makeTranslation(-.6,0,0));im.setMatrixAt(1,new T.Matrix4().makeTranslation(.6,0,0));scene.add(im);const b=read(scene,cam);
   const rowHit=(x0,x1)=>{let top=-1,bot=99;for(let y=0;y<64;y++)for(let x=x0;x<x1;x++)if(b[(y*64+x)*4]>128){top=Math.max(top,y);bot=Math.min(bot,y);}return [bot,top];};
   return {c0,c1,c2,left:rowHit(0,32),right:rowHit(32,64)};});
  assert(r.c1>r.c0*1.8&&Math.abs(r.c2-r.c0)<r.c0*.05,'silhouette '+JSON.stringify(r));
  assert(r.left[1]<32&&r.right[0]>32,'instanced WPO did not use the per-instance world position '+JSON.stringify(r));
  return `(covered pixels ${r.c0} -> ${r.c1}; instances moved to rows ${r.left} / ${r.right})`;
 });

 await test('alpha clip and WPO reach the shadow pass via bind(); previous onBeforeCompile hooks chain',async()=>{
  const r=await page.evaluate(()=>{const {T,MG,KE,renderer,read,source}=t;
   renderer.shadowMap.enabled=true;const scene=new T.Scene(),cam=new T.OrthographicCamera(-2,2,2,-2,.1,20);cam.position.set(0,6,0);cam.lookAt(0,0,0);
   const sun=new T.DirectionalLight(0xffffff,3);sun.position.set(0,5,0);sun.castShadow=true;sun.shadow.mapSize.set(256,256);Object.assign(sun.shadow.camera,{left:-2,right:2,top:2,bottom:-2});scene.add(sun,new T.AmbientLight(0xffffff,.05));
   const floor=new T.Mesh(new T.PlaneGeometry(4,4),new T.MeshStandardMaterial({color:0xffffff,roughness:1}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
   const lib=KE.materialLibrary(T,{size:128}),dm=lib.dissolve({amount:0});const ball=new T.Mesh(new T.PlaneGeometry(2.4,2.4),dm);ball.rotation.x=-Math.PI/2;ball.position.y=1;ball.castShadow=true;ball.visible=true;
   dm.colorWrite=false;dm.depthWrite=false;dm.shadowSide=T.DoubleSide;MG.bind(ball);scene.add(ball);
   const dark=b=>{let n=0;for(let i=0;i<b.length;i+=4)if(b[i]<60)n++;return n;};const rt2=new T.WebGLRenderTarget(64,64);
   const d0=dark(read(scene,cam,rt2));dm.params.amount=.55;const d1=dark(read(scene,cam,rt2));dm.params.amount=1.2;const d2=dark(read(scene,cam,rt2));
   const hasDepth=!!ball.customDepthMaterial&&ball.customDepthMaterial.isMeshDepthMaterial;renderer.shadowMap.enabled=false;
   // hook chaining
   const pm=new T.MeshStandardMaterial();let called=0;pm.onBeforeCompile=sh=>{called++;sh.fragmentShader='/* prev-hook */\n'+sh.fragmentShader;};
   MG.apply(T,pm,{nodes:[],outputs:{baseColor:'#ff0000'}});const s2=new T.Scene();s2.add(new T.Mesh(new T.PlaneGeometry(2,2),pm));const c2=new T.OrthographicCamera(-1,1,1,-1,.1,10);c2.position.z=2;read(s2,c2);
   const src=source(pm);return {d0,d1,d2,hasDepth,called,chained:src.includes('prev-hook')&&src.includes('kmgO_baseColor'),key:pm.customProgramCacheKey()};});
  assert(r.hasDepth,'bind() did not set customDepthMaterial');
  assert(r.d0>1000&&r.d1<r.d0*.8&&r.d1>100&&r.d2<50,'shadow did not follow alpha clip '+JSON.stringify(r));
  assert(r.called===1&&r.chained,'previous hook not chained '+JSON.stringify(r));
  return `(shadow texels ${r.d0} -> ${r.d1} -> ${r.d2})`;
 });

 await test('every material output compiles (standard/physical/unlit, toon + subsurface, point/directional shadow passes); registerNode + clone',async()=>{
  const r=await page.evaluate(()=>{const {T,MG,KE,renderer,read,tex}=t;const before=window.__errs.length;renderer.shadowMap.enabled=true;
   MG.registerNode('Checker',{category:'procedural',inputs:[['uv','vec2','@uv'],['scale','float',8]],out:'float',glsl:(c,a)=>{c.helper('kmgChecker',`float kmgChecker(vec2 p){vec2 q=floor(p);return mod(q.x+q.y,2.0);}`);return `kmgChecker(${a.uv} * ${a.scale})`;}});
   const scene=new T.Scene(),cam=new T.PerspectiveCamera(50,1,.1,20);cam.position.set(0,1,3);cam.lookAt(0,0,0);
   const sun=new T.DirectionalLight(0xffffff,2);sun.position.set(2,4,3);sun.castShadow=true;const pt=new T.PointLight(0xffaa66,3,10);pt.position.set(-1,1.5,1);pt.castShadow=true;pt.shadow.mapSize.set(128,128);sun.shadow.mapSize.set(256,256);
   scene.add(sun,pt,new T.AmbientLight(0xffffff,.2));const floor=new T.Mesh(new T.PlaneGeometry(6,6),new T.MeshStandardMaterial());floor.rotation.x=-Math.PI/2;floor.position.y=-.8;floor.receiveShadow=true;scene.add(floor);
   const full=g=>({baseColor:g.lerp('#335577','#ddccaa',g.checker(g.uv(),6)),metallic:.2,roughness:g.noise(g.worldPos(),{kind:'simplex',scale:3}),normal:g.normalMap(tex,g.uv().mul(2),.5),emissive:g.color('#110800'),
     opacity:.9,alphaClip:g.ditherOpacity(.95),ao:.8,worldPositionOffset:g.worldNormal().mul(g.time().sin().mul(.02)),subsurface:g.color('#ff4020').mul(.3),refraction:.3});
   const mats=[KE.shaderGraph(T,g=>({...full(g),clearcoat:.8,clearcoatRoughness:.1,sheen:g.color('#4060ff')}),{model:'physical',toon:{steps:4}}),KE.shaderGraph(T,full,{model:'standard',normalSpace:'tangent'}),
     KE.shaderGraph(T,g=>({...full(g),baseColor:'#ff0000'}),{model:'unlit'}),KE.shaderGraph(T,g=>({...full(g),normal:g.triplanarNormal(tex,g.worldPos(),g.worldNormal(),2,4,1)}),{model:'standard',normalSpace:'world',flatShading:true,side:'double'})];
   mats.forEach((m,i)=>{const mesh=new T.Mesh(new T.TorusKnotGeometry(.3,.1,64,8),m);mesh.position.x=(i-1.5)*.9;mesh.castShadow=mesh.receiveShadow=true;scene.add(mesh);MG.bind(mesh,m,{translucentLayer:false});});
   KE.prepareCamera(cam);read(scene,cam);read(scene,cam);
   const base=KE.shaderGraph(T,g=>({baseColor:g.param('tint','color','#ff0000')}));const cl=base.clone();cl.params.tint='#00ff00';
   renderer.shadowMap.enabled=false;
   return {errors:window.__errs.slice(before),cloneIndependent:base.params.tint.r>.9&&cl.params.tint.g>.9&&cl.params.tint.r<.1,cloneShares:base.customProgramCacheKey()===cl.customProgramCacheKey(),
     checker:!!MG.nodeTypes.Checker,depth:mats.every(m=>!!MG.shadowMaterials(m))};});
  assert(!r.errors.length,r.errors.join('\n').slice(0,3000));assert(r.cloneIndependent&&r.cloneShares,'clone '+JSON.stringify(r));assert(r.checker&&r.depth,'registerNode/shadow materials '+JSON.stringify(r));
 });

 await test('library gallery renders every material (screenshot)',async()=>{
  const r=await page.evaluate(async()=>{const {T,MG,KE,renderer}=t;
   renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1;renderer.shadowMap.enabled=false;MG.setTime(2.6);
   const scene=new T.Scene(),W=innerWidth,H=innerHeight,cam=new T.PerspectiveCamera(30,W/H,.1,50);cam.position.set(0,.55,11.6);cam.lookAt(0,-.05,0);cam.updateMatrixWorld();KE.prepareCamera(cam);
   const pm=new T.PMREMGenerator(renderer),envCube=KE.environment(T),env=pm.fromCubemap(envCube).texture;scene.environment=env;scene.background=new T.Color(0x1c2027);
   const sun=new T.DirectionalLight(0xfff4e6,2.2);sun.position.set(-3,4,6);scene.add(sun,new T.HemisphereLight(0x9fb6d0,0x2a2520,.15));
   const bc=document.createElement('canvas');bc.width=bc.height=256;const bx=bc.getContext('2d'),gr=bx.createLinearGradient(0,0,0,256);gr.addColorStop(0,'#2a3140');gr.addColorStop(1,'#14171d');bx.fillStyle=gr;bx.fillRect(0,0,256,256);
   bx.fillStyle='rgba(255,255,255,.035)';for(let y=0;y<16;y++)for(let x=0;x<16;x++)if((x+y)%2)bx.fillRect(x*16,y*16,16,16);const btex=new T.CanvasTexture(bc);btex.encoding=T.sRGBEncoding;
   const back=new T.Mesh(new T.PlaneGeometry(16,10),new T.MeshBasicMaterial({map:btex,toneMapped:false}));back.position.z=-2.5;scene.add(back);
   const lib=KE.materialLibrary(T,{size:256}),r=KE.random(4);
   const rock=(()=>{const g=new T.SphereGeometry(.46,72,48),p=g.attributes.position,v=new T.Vector3();for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i);const n=v.clone().normalize();
     const d=1+.16*Math.sin(n.x*4.1+n.y*2.3)*Math.cos(n.z*3.7)+.07*Math.sin(n.x*11+n.z*9)+.04*Math.sin(n.y*17);v.multiplyScalar(d);v.y*=.82;p.setXYZ(i,v.x,v.y,v.z);}g.computeVertexNormals();return g;})();
   const sphere=new T.SphereGeometry(.44,64,32),knot=new T.TorusKnotGeometry(.26,.09,128,16),torus=new T.TorusGeometry(.3,.14,32,64);
   const blade=(()=>{const g=new T.PlaneGeometry(.05,.42,1,5);g.translate(0,.21,0);const p=g.attributes.position;for(let i=0;i<p.count;i++){const y=p.getY(i)/.42;p.setX(i,p.getX(i)*(1-y*.9));p.setZ(i,y*y*.06);}g.computeVertexNormals();return g;})();
   const items=[['pbrTriplanar',rock],['parallaxStone','box'],['mossyRock',rock],['snowCovered',rock],['carPaint',sphere],
     ['glass',sphere],['hologram',knot],['dissolve',sphere],['forceField',sphere],['lava',sphere],
     ['waterPuddle','puck'],['toon',torus],['foliageSSS',sphere],['stylizedGrass','grass'],['carPaint inst.',sphere]];
   const labels=[],meshes=[];let carPaint=null;
   items.forEach(([name,geo],i)=>{const col=i%5,row=Math.floor(i/5),pos=new T.Vector3((col-2)*1.32,(1-row)*1.5,0);let obj;
     if(name==='carPaint inst.')obj=new T.Mesh(sphere,MG.instance(carPaint,{paintColor:'#0b3a9a',flipColor:'#02081c'}));
     else if(geo==='grass'){const m=lib.create(name),n=420,im=new T.InstancedMesh(blade,m,n),M=new T.Matrix4(),q=new T.Quaternion(),s=new T.Vector3();
       for(let k=0;k<n;k++){const a=r()*Math.PI*2,d=Math.sqrt(r())*.46;q.setFromEuler(new T.Euler((r()-.5)*.3,r()*Math.PI*2,(r()-.5)*.3));s.setScalar(.7+r()*.6);M.compose(new T.Vector3(Math.cos(a)*d,-.2,Math.sin(a)*d*.6),q,s);im.setMatrixAt(k,M);}
       obj=new T.Group();const base=new T.Mesh(new T.CylinderGeometry(.48,.5,.06,40),new T.MeshStandardMaterial({color:new T.Color('#3a2f22').convertSRGBToLinear(),roughness:1}));base.position.y=-.23;obj.add(base,im);obj.rotation.x=.22;}
     else if(geo==='box'){obj=new T.Mesh(new T.BoxGeometry(.66,.66,.66),lib.create(name));obj.rotation.set(.45,.62,0);}
     else if(geo==='puck'){obj=new T.Mesh(new T.CylinderGeometry(.5,.5,.14,64),lib.create(name));obj.rotation.x=.38;}
     else{obj=new T.Mesh(geo,lib.create(name));if(name==='carPaint')carPaint=obj.material;if(geo===knot)obj.rotation.set(.3,.4,0);if(geo===torus)obj.rotation.set(.9,.2,0);}
     obj.position.copy(pos);scene.add(obj);obj.traverse(o=>{if(o.isMesh&&MG.isGraphMaterial(o.material))MG.bind(o);});meshes.push(obj);
     const sp=pos.clone().add(new T.Vector3(0,-.62,0)).project(cam);labels.push({name,x:(sp.x*.5+.5)*W,y:(-sp.y*.5+.5)*H,cx:(pos.clone().project(cam).x*.5+.5)*W,cy:(-pos.clone().project(cam).y*.5+.5)*H});});
   renderer.setRenderTarget(null);renderer.setClearColor(0x000000,1);renderer.render(scene,cam);
   const gl=renderer.getContext(),pix=new Uint8Array(4),stats=[];
   const bgPix=new Uint8Array(4);gl.readPixels(6,Math.round(H/2),1,1,gl.RGBA,gl.UNSIGNED_BYTE,bgPix);const bg=(bgPix[0]+bgPix[1]+bgPix[2])/3;
   for(const l of labels){let sum=0,var2=0,n=0;const vals=[];for(let dy=-15;dy<=15;dy+=5)for(let dx=-15;dx<=15;dx+=5){gl.readPixels(Math.round(l.cx+dx),Math.round(H-l.cy+dy),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pix);const L=(pix[0]+pix[1]+pix[2])/3;vals.push(L);sum+=L;n++;}
     const mean=sum/n;for(const v of vals)var2+=(v-mean)*(v-mean);stats.push({name:l.name,mean:+mean.toFixed(1),sd:+Math.sqrt(var2/n).toFixed(1)});}
   const css=document.createElement('style');css.textContent='.lbl{position:absolute;transform:translate(-50%,0);font:600 10px/1.2 system-ui,sans-serif;color:#e8edf3;text-shadow:0 1px 2px #000;white-space:nowrap;letter-spacing:.02em}';document.head.append(css);
   for(const l of labels){const d=document.createElement('div');d.className='lbl';d.textContent=l.name;d.style.left=l.x+'px';d.style.top=l.y+'px';document.body.append(d);}
   window.gallery={scene,cam,meshes};return {stats,bg,programs:renderer.info.programs.length};});
  await page.screenshot({path:path.join(outDir,'materials-gallery.png'),timeout:120000});
  const bg=r.stats.filter(s=>Math.abs(s.mean-r.bg)<3&&s.sd<2);assert(!bg.length,'tiles look empty: '+JSON.stringify(bg));
  return `(${r.stats.length} tiles, ${r.programs} programs; centre luma ${r.stats.map(s=>s.name.split(' ')[0]+'='+s.mean).join(' ')})`;
 });

 await test('gallery close-ups (animated time) render',async()=>{
  await page.evaluate(()=>{const {T,MG,renderer}=t,{scene,cam}=window.gallery;document.querySelectorAll('.lbl').forEach(e=>e.remove());MG.setTime(4.1);
   const c=cam.clone();c.fov=13;c.position.set(-1.32,.9,11.6);c.lookAt(-1.32,.75,0);c.updateProjectionMatrix();renderer.render(scene,c);});
  await page.screenshot({path:path.join(outDir,'materials-closeup.png'),timeout:120000});
  await page.evaluate(()=>{const {T,MG,renderer}=t,{scene,cam}=window.gallery;const c=cam.clone();c.fov=13;c.position.set(1.32,-.6,11.6);c.lookAt(1.32,-.75,0);c.updateProjectionMatrix();renderer.render(scene,c);});
  await page.screenshot({path:path.join(outDir,'materials-closeup2.png'),timeout:120000});
 });
 await close();
}

async function pageTwo(){
 const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/10-pipeline.js','src/modules/14-shadows.js','src/modules/18-gi.js','src/modules/20-materials.js'],viewport:{width:640,height:400},name:'materials-pipe'});
 await test('composes with CascadedShadows + ProbeVolume hooks and the Pipeline scene copies (refraction, depth fade)',async()=>{
  const r=await page.evaluate(async()=>{const T=THREE,KE=KitsuneEngine,MG=KE.MaterialGraph;KE.applyPreset('high');MG.setTime(1.7);
   const renderer=new T.WebGLRenderer();renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;document.body.append(renderer.domElement);
   const scene=new T.Scene(),cam=new T.PerspectiveCamera(50,innerWidth/innerHeight,.1,120);cam.position.set(0,2.1,5.4);cam.lookAt(0,.45,0);KE.prepareCamera(cam);
   const pm=new T.PMREMGenerator(renderer);scene.environment=pm.fromCubemap(KE.environment(T)).texture;scene.background=new T.Color(0x8aa2b8);
   const sun=new T.DirectionalLight(0xfff1dd,3.2);sun.position.set(-4,6,3);scene.add(sun,sun.target);
   const lib=KE.materialLibrary(T,{size:256});
   const floor=new T.Mesh(new T.PlaneGeometry(14,14),lib.parallaxStone({tiling:5}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;scene.add(floor);
   const add=(mat,geo,x,y,z,s=1)=>{const m=new T.Mesh(geo,mat);m.position.set(x,y,z);m.scale.setScalar(s);m.castShadow=m.receiveShadow=true;scene.add(m);MG.bind(m);return m;};
   const sph=new T.SphereGeometry(.5,48,24);
   const rock=add(lib.mossyRock(),new T.IcosahedronGeometry(.6,3),-1.9,.35,-.4);const glass=add(lib.glass(),sph,-.55,.5,.5);const field=add(lib.forceField(),new T.SphereGeometry(.75,48,24),.85,.1,-.2);
   const dis=add(lib.dissolve({amount:.35}),sph,2.1,.5,.3);const lava=add(lib.lava(),sph,.2,.5,-1.6);const snow=add(lib.snowCovered(),new T.IcosahedronGeometry(.55,3),-.9,.4,-1.8);
   const csm=new KE.CascadedShadows(T,scene,{sun,cascades:2,mapSize:1024,maxFar:30});csm.setupScene();
   const gi=new KE.ProbeVolume(T,renderer,scene,{bounds:new T.Box3(new T.Vector3(-4,0,-4),new T.Vector3(4,3,4)),spacing:4,faceSize:8,probesPerFrame:2});gi.tag(scene);gi.setupScene();
   const pipeline=new KE.Pipeline(T,renderer,{sun});
   for(let i=0;i<5;i++){csm.update(cam);gi.update(cam);pipeline.render(scene,cam,1/30);}
   const gl=renderer.getContext(),src=m=>{const p=renderer.properties.get(m).currentProgram;return p?gl.getAttachedShaders(p.program).map(s=>gl.getShaderSource(s)).join('\n'):'';};
   const S=KE.sceneUniforms(T);
   return {rockCSM:/keCascades/.test(src(rock.material)),rockGI:/vKeWorld/.test(src(rock.material)),rockGraph:/kmgO_baseColor/.test(src(rock.material)),glassLayer:glass.layers.mask,fieldLayer:field.layers.mask,
     glassRefr:/kmgSceneColor/.test(src(glass.material)),hasScene:S.keHasScene.value,disDepth:!!dis.customDepthMaterial};});
  await page.screenshot({path:path.join(outDir,'materials-pipeline.png'),timeout:120000});
  assert(r.rockCSM&&r.rockGI&&r.rockGraph,'hooks did not compose '+JSON.stringify(r));
  assert(r.glassLayer===2&&r.fieldLayer===2&&r.glassRefr&&r.disDepth,'translucent/refraction wiring '+JSON.stringify(r));
  return '(graph + CSM + GI patches in one program; glass/force field on KE.LAYERS.TRANSLUCENT)';
 });
 await close();
}

(async()=>{
 await nodeOnly();await pageOne();await pageTwo();
 if(failed){console.log(failed+' test(s) failed');process.exit(1);}console.log('all material tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
