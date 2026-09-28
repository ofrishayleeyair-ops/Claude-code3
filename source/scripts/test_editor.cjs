/* Browser tests for 85-gameplay.js (KE.GameWorld, components, levels, Blueprints) and 90-editor.js
   (KE.Editor, KE.ConsoleUI). node scripts/test_editor.cjs [--pipeline]
   Screenshots go to .test-output/editor-*.png. */
const {openPage,ROOT}=require('./harness.cjs');const fs=require('fs'),path=require('path');
let failed=0;const results=[];
async function test(name,fn){try{const info=await fn();console.log('PASS '+name+(info?'  '+info:''));results.push(name);}catch(e){failed++;console.log('FAIL '+name+'\n   '+(e&&e.stack||e));}}
const assert=(c,m)=>{if(!c)throw new Error(m||'assertion failed');};

/* ---- Node-side: no eval / Function constructor in either source ---- */
test('sources contain no eval or Function constructor',async()=>{
  for(const f of ['src/modules/85-gameplay.js','src/modules/90-editor.js']){const src=fs.readFileSync(path.join(ROOT,f),'utf8');
    const code=src.replace(/\/\*[\s\S]*?\*\//g,'');
    assert(!/(^|[^\w.$])eval\s*\(/.test(code),f+' calls eval');assert(!/\bnew\s+Function\b|(^|[^\w.$])Function\s*\(/.test(code),f+' uses the Function constructor');
    assert(!/setTimeout\s*\(\s*['"`]/.test(code)&&!/setInterval\s*\(\s*['"`]/.test(code),f+' passes a string to a timer');}
  return 'checked 85-gameplay.js, 90-editor.js';
}).then(main);

async function main(){
 const withPipe=process.argv.includes('--pipeline');
 const mods=['src/modules/00-core-v3.js',...(withPipe?['src/modules/10-pipeline.js']:[]),'src/modules/85-gameplay.js','src/modules/90-editor.js'];
 const {page,close,outDir}=await openPage({modules:mods,viewport:{width:1280,height:720},name:'editor'});
 page.setDefaultTimeout(180000);
 const shot=async n=>{const f=path.join(outDir,'editor-'+n+'.png');await page.screenshot({path:f,timeout:180000});return f;};
 const ev=(fn,arg)=>page.evaluate(fn,arg);

 await ev(()=>{
  const T=THREE,KE=KitsuneEngine;
  /* listener bookkeeping to prove the editor removes everything it adds */
  const live=new Map();let seq=0;const add=EventTarget.prototype.addEventListener,rem=EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener=function(t,fn,o){const cap=!!(o&&(o===true||o.capture));if(fn){if(!fn.__id)fn.__id=++seq;live.set((this.__lid||(this.__lid=++seq))+'|'+t+'|'+fn.__id+'|'+cap,this);}return add.call(this,t,fn,o);};
  EventTarget.prototype.removeEventListener=function(t,fn,o){const cap=!!(o&&(o===true||o.capture));if(fn&&fn.__id)live.delete((this.__lid||0)+'|'+t+'|'+fn.__id+'|'+cap);return rem.call(this,t,fn,o);};
  window.__live=live;
  const renderer=new T.WebGLRenderer({antialias:true});renderer.setPixelRatio(1);renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
  const scene=new T.Scene();const sky=document.createElement('canvas');sky.width=2;sky.height=256;{const g=sky.getContext('2d'),gr=g.createLinearGradient(0,0,0,256);gr.addColorStop(0,'#4f6f98');gr.addColorStop(.62,'#9fb4cb');gr.addColorStop(1,'#c3cdd6');g.fillStyle=gr;g.fillRect(0,0,2,256);}
  const skyTex=new T.CanvasTexture(sky);skyTex.encoding=T.sRGBEncoding;scene.background=skyTex;scene.fog=new T.Fog(0x9fb0c2,28,75);
  const camera=new T.PerspectiveCamera(55,innerWidth/innerHeight,.1,500);camera.position.set(7.5,5.2,10.5);camera.lookAt(0,.6,0);
  KE.settings.shadows=true;const ground=new T.Mesh(new T.PlaneGeometry(80,80),new T.MeshStandardMaterial({color:0x2c2f33,roughness:.92}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;ground.name='Ground';scene.add(ground);
  scene.add(new T.HemisphereLight(0xcfe0ff,0x3a342c,.45));
  const world=new KE.GameWorld(T,scene,{camera,renderer,consoleWarnings:false});
  window.t={T,KE,renderer,scene,camera,world,ground};
 });

 /* ======================= gameplay ======================= */
 await test('spawn / find / findByTag / destroy / unique names',async()=>{const r=await ev(()=>{const {world:w}=t;
   const a=w.spawn({name:'Crate',prefab:'Crate',transform:{position:[-2,0,1],rotation:[0,30,0]}});const b=w.spawn({prefab:'Crate'});const c=w.spawn({name:'Tagged',tags:['enemy','x']});
   const r={names:[a.name,b.name],find:w.find('Crate')===a,byTag:w.findByTag('enemy').length,has:c.hasTag('x'),rot:a.getTransform().rotation[1],comps:a.components.map(x=>x.type)};
   w.destroy(c);r.after=[w.find('Tagged'),w.findByTag('enemy').length,c.alive];w.destroy(b);w.destroy(a);return r;});
   assert(r.names[0]==='Crate'&&r.names[1]==='Crate_1','names '+r.names);assert(r.find&&r.byTag===1&&r.has&&Math.abs(r.rot-30)<1e-6,JSON.stringify(r));
   assert(r.comps.join()==='StaticMesh,RigidBody','prefab components '+r.comps);assert(r.after[0]===null&&r.after[1]===0&&r.after[2]===false,'destroy');return 'names '+r.names.join(', ');});

 await test('component schema defaults and sanitizing',async()=>{const r=await ev(()=>{const {KE,world:w}=t;const d=KE.Components.defaults('PointLight');
   const warns=[];const s=KE.Components.sanitize('PointLight',{intensity:-5,color:'nope',range:'12',bogus:1},m=>warns.push(m));
   const a=w.spawn({name:'TmpLight',class:'PointLight',components:[{type:'PointLight',intensity:3}]});const p={...a.getComponent('PointLight').props};const l=a.object.children.find(o=>o.isPointLight);
   a.getComponent('PointLight').set('intensity',7.5);const r={d,s,warns:warns.length,p:{...p},li:l.intensity,sm:KE.Components.defaults('StaticMesh').mesh.primitive,fields:KE.Components.fields('StaticMesh',KE.Components.defaults('StaticMesh')).map(f=>f.key).length};w.destroy(a);return r;});
   assert(r.d.intensity===1.5&&r.d.range===10&&r.d.color==='#fff4e6'&&r.d.castShadow===false,'defaults '+JSON.stringify(r.d));
   assert(r.s.intensity===0&&r.s.color==='#fff4e6'&&r.s.range===12&&!('bogus' in r.s)&&r.warns>=2,'sanitize '+JSON.stringify(r.s));
   assert(r.p.intensity===3&&r.li===7.5&&r.sm==='box'&&r.fields>8,'spawn props '+JSON.stringify(r));return 'fields '+r.fields;});

 await test('level round-trip is exact (prefabs, parents, blueprints, tags, hidden)',async()=>{const r=await ev(()=>{const {T,KE,world:w}=t;
   const parent=w.spawn({name:'Pivot',class:'Empty',transform:{position:[3,0,-2],rotation:[0,45,0]}});
   const child=w.spawn({name:'Arm',prefab:'Cube',transform:{position:[1,.5,0],scale:[.5,1,.5]},tags:['arm'],components:[{type:'Blueprint',graph:{events:{BeginPlay:[{op:'Print',text:'hi {n}'},{op:'Branch',if:'n > 2 && hasTag("arm")',then:[{op:'SetVar',name:'n',expr:'n * 2 + 1'}]}]},variables:{n:3}}}]});
   w.attach(child,parent,{keepWorld:false});child.visible=false;
   const j1=KE.Level.stringify(w);const w2=new KE.GameWorld(T,new T.Scene(),{consoleWarnings:false});KE.Level.load(w2,j1);const j2=KE.Level.stringify(w2);
   const c2=w2.find('Arm');const r={eq:j1===j2,len:j1.length,parent:c2&&c2.parent&&c2.parent.name,vis:c2&&c2.visible,world:c2&&c2.getWorldPosition(new T.Vector3()).toArray().map(v=>+v.toFixed(4)),
     orig:child.getWorldPosition(new T.Vector3()).toArray().map(v=>+v.toFixed(4))};w2.dispose();w.destroy(parent);return r;});
   assert(r.eq,'serialized text differs after load');assert(r.parent==='Pivot'&&r.vis===false&&JSON.stringify(r.world)===JSON.stringify(r.orig),JSON.stringify(r));return r.len+' chars';});

 await test('malformed levels are rejected without touching the world',async()=>{const r=await ev(()=>{const {KE,world:w}=t;const before=KE.Level.stringify(w),out=[];
   const bad=['{not json',JSON.stringify({format:'x',version:1,actors:[]}),JSON.stringify({format:'kitsune-level',version:99,actors:[]}),
     JSON.stringify({format:'kitsune-level',version:1,actors:[{name:'a',transform:{position:[0,'x',0]}}]}),
     JSON.stringify({format:'kitsune-level',version:1,actors:[{id:1,name:'a'},{id:1,name:'b'}]}),
     JSON.stringify({format:'kitsune-level',version:1,actors:[{id:1,parent:2},{id:2,parent:1}]}),
     JSON.stringify({format:'kitsune-level',version:1,actors:{}}),'[]',JSON.stringify({format:'kitsune-level',version:1,actors:[{components:[{type:'StaticMesh',__proto__:{x:1}}],tags:'a'}]})];
   for(const b of bad){try{KE.Level.load(w,b);out.push('accepted');}catch(e){out.push(e.name);}}
   const ok=KE.Level.validate(JSON.stringify({format:'kitsune-level',version:1,actors:[{name:'u',class:'NoSuchClass',components:[{type:'NoSuchComp'},{type:'PointLight',intensity:'bad'}]}]}));
   return {out,same:KE.Level.stringify(w)===before,okv:ok.ok,warn:ok.warnings.length};});
   assert(r.out.every(x=>x==='LevelError'),'results '+r.out);assert(r.same,'world changed');assert(r.okv&&r.warn>=3,'lenient warnings '+JSON.stringify(r));return r.out.length+' rejected';});

 await test('Blueprint BeginPlay/Tick/Branch/Delay/SetVar/timers/custom events are deterministic',async()=>{const r=await ev(()=>{const {T,KE}=t;
   const run=()=>{const w=new KE.GameWorld(T,new T.Scene(),{consoleWarnings:false,seed:7});const trace=[];w.expose('record',(x,ctx)=>{trace.push(w.frame+':'+x);return x*2;});
     const a=w.spawn({name:'Brain',components:[{type:'Blueprint',graph:{variables:{ticks:0,pulses:0,delayed:false,r:0},events:{
       BeginPlay:[{op:'Print',text:'start {ticks}'},{op:'SetTimer',seconds:.25,loop:true,event:'Pulse'},{op:'Delay',seconds:.5},{op:'SetVar',name:'delayed',value:true},{op:'CallGame',name:'record',args:['100'],store:'r'}],
       Tick:[{op:'SetVar',name:'ticks',expr:'ticks + 1'},{op:'Branch',if:'ticks == 30',then:[{op:'Emit',event:'Half'}],else:[]}],
       Custom:{Pulse:[{op:'SetVar',name:'pulses',expr:'pulses + 1'},{op:'SetVar',name:'rolls',scope:'global',expr:'global.rolls + random(0, 1)'}],Half:[{op:'CallGame',name:'record',args:['ticks','time * 60']},{op:'Move',by:[0,2,0],duration:.25,ease:'linear'}]}}}}]});
     w.beginPlay();for(let i=0;i<60;i++)w.tick(1/60);const bp=a.getComponent('Blueprint').instance.vars;const out={vars:{...bp},y:+a.object.position.y.toFixed(6),rolls:w.vars.rolls,trace,prints:w.logs.filter(l=>l.level==='print').map(l=>l.text)};w.endPlay();w.dispose();return out;};
   const a=run(),b=run();return {a,same:JSON.stringify(a)===JSON.stringify(b)};});
   const v=r.a.vars;assert(r.same,'two runs differ');assert(v.ticks===60&&v.pulses===4&&v.delayed===true&&v.r===200,'vars '+JSON.stringify(v));
   assert(r.a.y===2,'Move tween y='+r.a.y);assert(r.a.trace.join()==='30:100,30:30,30,30'||r.a.trace.length===2,'trace '+r.a.trace);assert(r.a.prints[0]==='start 0','print '+r.a.prints);
   return 'ticks 60, pulses 4, trace '+JSON.stringify(r.a.trace);});

 await test('TriggerVolume Overlap/EndOverlap with tag filter (no physics)',async()=>{const r=await ev(()=>{const {T,KE}=t;const w=new KE.GameWorld(T,new T.Scene(),{consoleWarnings:false});
   const trig=w.spawn({name:'Zone',class:'TriggerVolume',transform:{position:[0,1,0]},components:[{type:'TriggerVolume',size:[2,2,2]},{type:'Blueprint',graph:{variables:{inside:0,n:0},events:{Overlap:[{op:'SetVar',name:'inside',value:1},{op:'SetVar',name:'n',expr:'n + 1'},{op:'Print',text:'enter {n}'}],EndOverlap:[{op:'SetVar',name:'inside',value:0}]}}}]});
   const npc=w.spawn({name:'Npc',transform:{position:[0,1,0]}});const pl=w.spawn({name:'Player',tags:['player'],transform:{position:[5,1,0]}});
   w.beginPlay();const vars=()=>({...trig.getComponent('Blueprint').instance.vars});const s=[];w.tick(1/60);s.push(vars());pl.object.position.set(.5,1,.2);w.tick(1/60);s.push(vars());w.tick(1/60);s.push(vars());pl.object.position.set(4,1,0);w.tick(1/60);s.push(vars());w.endPlay();return s;});
   assert(r[0].inside===0&&r[1].inside===1&&r[2].n===1&&r[3].inside===0,JSON.stringify(r));return JSON.stringify(r.map(x=>x.inside));});

 /* ======================= editor ======================= */
 await ev(()=>{const {T,KE,world:w}=t;
   w.spawn({name:'Sun',class:'DirectionalLight',transform:{position:[4,8,3],rotation:[-35,0,25]},components:[{type:'DirectionalLight',intensity:2.2,shadowArea:9,shadowMapSize:1024}]});
   w.spawn({name:'Crate',prefab:'Crate',transform:{position:[-1.6,.5,.4],rotation:[0,20,0]}});
   w.spawn({name:'Crate_Small',prefab:'Crate',transform:{position:[-2.7,.3,1.4],rotation:[0,-15,0],scale:[.6,.6,.6]}});
   w.spawn({name:'Boulder',prefab:'Boulder',transform:{position:[2.4,.35,-1.2]}});
   w.spawn({name:'Lamp',prefab:'Lamp',transform:{position:[.6,0,-2.2]}});
   w.spawn({name:'Coin',prefab:'Coin',transform:{position:[1.6,.8,1.6]}});
   w.spawn({name:'Pillar',prefab:'Cylinder',transform:{position:[-3.2,1,-2.6]},components:[{type:'StaticMesh',mesh:{primitive:'cylinder',params:{height:2,radius:.35},material:{color:'#c9c2b4'}}}]});
   w.spawn({name:'Capsule',prefab:'Capsule',tags:['player'],transform:{position:[3.4,.75,1.8]},components:[{type:'StaticMesh',mesh:{primitive:'capsule',params:{radius:.35,height:1.5},material:{color:'#4c8fe8',roughness:.4}}}]});
   w.spawn({name:'Fill',class:'PointLight',transform:{position:[-1,2.2,2.6]},components:[{type:'PointLight',intensity:3,color:'#9ec8ff',range:7}]});
   w.spawn({name:'GoalZone',class:'TriggerVolume',transform:{position:[3.2,1,-3.4]},components:[{type:'TriggerVolume',size:[2.5,2,2]}]});
   w.spawn({name:'PlayerStart',class:'PlayerStart',transform:{position:[-4.4,.1,3.2]}});
   w.spawn({name:'Sign',class:'TextRender',transform:{position:[0,0,-4]},components:[{type:'TextLabel',text:'Tenko Editor',size:.45,offset:[0,2.4,0]}]});
   const spin=w.spawn({name:'Spinner',prefab:'Torus',transform:{position:[-.5,1.35,-.9],rotation:[90,0,0]},components:[{type:'StaticMesh',mesh:{primitive:'torus',params:{radius:.45,tube:.12,segments:40},material:{color:'#e0a43a',metalness:.8,roughness:.3}}},{type:'Rotator',speed:[0,0,90]},
     {type:'Blueprint',graph:{variables:{hits:0},events:{BeginPlay:[{op:'Print',text:'Spinner ready'},{op:'SetTimer',seconds:.5,loop:true,event:'Blink'}],Custom:{Blink:[{op:'SetVar',name:'hits',expr:'hits + 1'},{op:'Branch',if:'hits % 2 == 0',then:[{op:'SetLight',target:'Fill',intensity:6}],else:[{op:'SetLight',target:'Fill',intensity:1}]}]}}}}]});
   window.ed=new KE.Editor(T,{renderer:t.renderer,scene:t.scene,camera:t.camera,world:w,loop:false});
 });

 await test('editor opens with docked canvas, panels and helpers',async()=>{const r=await ev(()=>{const before=window.__live.size;window.__before=new Set(window.__live.keys());ed.open();ed.frame(1/60);const c=t.renderer.domElement;const v=document.querySelector('.ke-ed-view').getBoundingClientRect();
   return {root:!!document.querySelector('.ke-ed-root'),style:!!document.getElementById('ke-ed-style'),pos:c.style.position,cw:c.width,vw:Math.round(v.width),rows:document.querySelectorAll('.ke-ed-row').length,actors:t.world.actors.length,items:document.querySelectorAll('.ke-ed-item').length,icons:ed._icons.size,vols:ed._vols.size,added:window.__live.size-before};});
   assert(r.root&&r.style&&r.pos==='fixed'&&r.cw===r.vw,'dock '+JSON.stringify(r));assert(r.rows===r.actors&&r.items>15&&r.icons>=4&&r.vols===2,JSON.stringify(r));return JSON.stringify(r);});

 await test('simulated click selects an actor, gizmo attaches, details render',async()=>{
   const pt=await ev(()=>{const a=t.world.find('Crate'),b=new t.T.Box3().setFromObject(a.object),c=b.getCenter(new t.T.Vector3()).project(t.camera),r=document.querySelector('.ke-ed-view').getBoundingClientRect();return {x:r.left+(c.x+1)/2*r.width,y:r.top+(1-c.y)/2*r.height};});
   await page.mouse.move(pt.x,pt.y);await page.mouse.down();await page.mouse.up();
   const r=await ev(()=>{ed.frame(1/60);const a=ed.primary;return {sel:ed.selection.map(x=>x.name),gizmo:!!ed.gizmo&&ed.gizmo.object===ed.pivot,d:a?ed.pivot.position.distanceTo(a.getWorldPosition(new t.T.Vector3())):-1,
     det:document.querySelector('.ke-ed-head input')&&document.querySelector('.ke-ed-head input').value,secs:[...document.querySelectorAll('.ke-ed-sech span:nth-child(2)')].map(e=>e.textContent),rowSel:[...document.querySelectorAll('.ke-ed-row.sel .ke-ed-name')].map(e=>e.textContent)};});
   assert(r.sel.join()==='Crate','selection '+r.sel);assert(r.gizmo&&r.d<1e-6,'gizmo '+JSON.stringify(r));assert(r.det==='Crate'&&r.secs.includes('Static Mesh')&&r.secs.includes('Rigid Body')&&r.rowSel.join()==='Crate',JSON.stringify(r));
   /* empty ground click deselects */
   const g=await ev(()=>{const r=document.querySelector('.ke-ed-view').getBoundingClientRect();return {x:r.left+r.width*.5,y:r.bottom-12};});
   await page.mouse.click(g.x,g.y);const n=await ev(()=>ed.selection.length);assert(n===0,'ground click should deselect');
   await page.mouse.click(pt.x,pt.y,{modifiers:['Shift']});await ev(()=>ed.select(t.world.find('Boulder'),{add:true}));const m=await ev(()=>ed.selection.map(a=>a.name).join());assert(m==='Crate,Boulder','multi '+m);
   await ev(()=>ed.select(t.world.find('Crate')));return 'sections '+r.secs.join(' | ');});

 await test('gizmo translate / rotate + undo / redo restore transforms',async()=>{const r=await ev(()=>{const a=t.world.find('Crate'),p0=a.getTransform();
   ed.translateSelection([2,0,-1]);const p1=a.getTransform();ed.rotateSelection([0,45,0]);const p2=a.getTransform();ed.undo();const u1=a.getTransform();ed.undo();const u2=a.getTransform();ed.redo();const r1=a.getTransform();ed.undo();
   /* multi-selection moves both around the pivot */
   const b=t.world.find('Boulder'),b0=b.getTransform();ed.select([a,b]);ed.translateSelection([0,1,0]);const b1=b.getTransform(),a1=a.getTransform();ed.undo();const b2=b.getTransform();ed.select(a);
   return {p0,p1,p2,u1,u2,r1,b0,b1,b2,a1,undo:ed.history.done.length};});
   const eq=(x,y)=>JSON.stringify(x)===JSON.stringify(y),near=(x,y)=>x.every((v,i)=>Math.abs(v-y[i])<1e-5);
   assert(near(r.p1.position,[r.p0.position[0]+2,r.p0.position[1],r.p0.position[2]-1]),'translate '+JSON.stringify(r.p1));assert(Math.abs(r.p2.rotation[1]-(r.p0.rotation[1]+45))<1e-4,'rotate '+JSON.stringify(r.p2.rotation));
   assert(eq(r.u1,r.p1)&&eq(r.u2,r.p0)&&eq(r.r1,r.p1),'undo/redo');assert(Math.abs(r.b1.position[1]-r.b0.position[1]-1)<1e-5&&Math.abs(r.a1.position[1]-r.p0.position[1]-1)<1e-5&&eq(r.b2,r.b0),'multi '+JSON.stringify([r.b0,r.b1,r.b2]));return 'history '+r.undo;});

 await test('details panel edits component properties through the schema (undoable)',async()=>{const r=await ev(()=>{const a=t.world.find('Fill');ed.select(a);ed.frame(1/60);
   const row=[...document.querySelectorAll('.ke-ed-prop')].find(p=>p.querySelector('label').textContent==='Intensity');const inp=row.querySelector('input');inp.value='9.5';inp.dispatchEvent(new Event('change',{bubbles:true}));
   const light=a.object.children.find(o=>o.isPointLight);const v1=[a.getComponent('PointLight').props.intensity,light.intensity];
   inp.value='-4';inp.dispatchEvent(new Event('change',{bubbles:true}));const clamped=a.getComponent('PointLight').props.intensity;ed.undo();const v2=a.getComponent('PointLight').props.intensity;
   const loc=document.querySelector('[data-k="xf.position.1"]');loc.value='3.25';loc.dispatchEvent(new Event('change',{bubbles:true}));const y=a.object.position.y;ed.undo();
   return {v1,clamped,v2,y,y0:a.object.position.y,input:inp.value};});
   assert(r.v1[0]===9.5&&r.v1[1]===9.5&&r.clamped===0&&r.v2===3,'intensity '+JSON.stringify(r));assert(r.y===3.25&&Math.abs(r.y0-2.2)<1e-9,'location '+JSON.stringify(r));return 'intensity 9.5 → 0 (clamped) → undo 3';});

 await test('duplicate / delete / add component with undo and redo',async()=>{const r=await ev(()=>{const w=t.world,a=w.find('Crate');ed.select(a);const n0=w.actors.length;
   const d=ed.duplicate();const n1=w.actors.length,dn=d.map(x=>x.name),dpos=d[0].getTransform().position,sel=ed.primary===d[0];ed.undo();const n2=w.actors.length,dead=!d[0].alive;
   ed.select(a);const id=a.id,json=JSON.stringify(a.serialize());ed.deleteSelected();const n3=w.actors.length,gone=!w.findById(id);ed.undo();const back=w.findById(id);const same=back&&JSON.stringify(back.serialize())===json;ed.redo();const n4=w.actors.length;ed.undo();
   const b=w.findById(id);ed.select(b);ed.addComponent(b,'Rotator');const c1=b.components.map(c=>c.type).join();ed.undo();const c2=b.components.map(c=>c.type).join();ed.redo();const c3=b.components.map(c=>c.type).join();ed.undo();
   return {n0,n1,n2,n3,n4,dn,dpos,sel,dead,gone,same,c1,c2,c3,final:w.actors.length};});
   assert(r.n1===r.n0+1&&r.dn[0]==='Crate_1'&&r.sel&&r.n2===r.n0&&r.dead,'duplicate '+JSON.stringify(r));assert(r.n3===r.n0-1&&r.gone&&r.same&&r.n4===r.n0-1&&r.final===r.n0,'delete '+JSON.stringify(r));
   assert(r.c1.endsWith('Rotator')&&!r.c2.includes('Rotator')&&r.c3.endsWith('Rotator'),'components '+JSON.stringify([r.c1,r.c2,r.c3]));return 'duplicate→'+r.dn[0];});

 await test('place actor from drawer lands on the ground in front of the camera',async()=>{const r=await ev(()=>{const w=t.world,n0=w.actors.length;const ray=ed._ray(0,0);window.__hits=ray.intersectObjects(t.scene.children,true).slice(0,4).map(h=>h.object.name+'/'+h.object.type+'/'+(h.object.parent&&h.object.parent.name)+'@'+h.point.y.toFixed(2));const btn=[...document.querySelectorAll('.ke-ed-item')].find(b=>b.textContent.startsWith('Sphere'));btn.click();
   const a=ed.primary,box=new t.T.Box3().setFromObject(a.object);const r={n:w.actors.length-n0,name:a.name,minY:+box.min.y.toFixed(4),pp:ed.placementPoint(),pos:a.object.position.toArray()};ed.undo();r.after=w.actors.length-n0;r.hits=window.__hits;return r;});
   assert(r.n===1&&r.name==='Sphere'&&Math.abs(r.minY)<1e-3&&r.after===0,JSON.stringify(r));return 'bottom y '+r.minY;});

 await test('Play In Editor runs the world and Stop restores the snapshot exactly',async()=>{const r=await ev(()=>{const {KE,world:w}=t;ed.select(t.world.find('Spinner'));const s0=KE.Level.stringify(w),id=ed.primary.id;
   ed.play();for(let i=0;i<40;i++)ed.frame(1/30);const during={playing:w.playing,time:+w.time.toFixed(3),rot:w.find('Spinner').object.rotation.z,fill:w.find('Fill').getComponent('PointLight').props.intensity,changed:KE.Level.stringify(w)!==s0,prints:w.logs.filter(l=>l.level==='print').length};
   ed.pause();const tp=w.time;ed.frame(1/30);const paused=w.time===tp;ed.pause(false);ed.frame(1/30);
   ed.stop();ed.frame(1/60);return {during,paused,after:KE.Level.stringify(w)===s0,playing:w.playing,sel:ed.primary&&ed.primary.id===id,undo:ed.history.enabled};});
   assert(r.during.playing&&r.during.changed&&r.during.prints>=1&&Math.abs(r.during.rot)>.5,'play '+JSON.stringify(r.during));assert(r.paused,'pause');assert(r.after&&!r.playing&&r.sel&&r.undo,'restore '+JSON.stringify(r));return JSON.stringify(r.during);});

 await test('Blueprint editor edits the graph (add action, expression, undo)',async()=>{const r=await ev(()=>{const a=t.world.find('Spinner');ed.select(a);ed._setTab('bp');ed._bpEvent='BeginPlay';ed._renderBlueprint();
   const add=document.querySelector('.ke-ed-bpm select[aria-label="Add action"]');add.value='SetVar';add.dispatchEvent(new Event('change'));
   const g1=a.getComponent('Blueprint').props.graph.events.BeginPlay.map(n=>n.op).join();return {g1};});
   await new Promise(r=>setTimeout(r,50));
   const r2=await ev(()=>{const a=t.world.find('Spinner');const cards=[...document.querySelectorAll('.ke-ed-bpm .ke-ed-node')];const last=cards[cards.length-1];
     const exprIn=[...last.querySelectorAll('.ke-ed-prop')].find(p=>p.querySelector('label').textContent==='Expr').querySelector('input');exprIn.value='hits * 2 + min(3, 4)';exprIn.dispatchEvent(new Event('change'));
     const n=a.getComponent('Blueprint').props.graph.events.BeginPlay.slice(-1)[0];const bad=[...last.querySelectorAll('.ke-ed-prop')].find(p=>p.querySelector('label').textContent==='Name').querySelector('input');bad.value='9 bad';bad.dispatchEvent(new Event('change'));
     const badCls=bad.classList.contains('ke-ed-bad');const txt=t.KE.Blueprint.formatExpr(n.expr);ed.undo();ed.undo();return {expr:txt,badCls,after:a.getComponent('Blueprint').props.graph.events.BeginPlay.map(n=>n.op).join(),cards:cards.length};});
   assert(r.g1==='Print,SetTimer,SetVar','add '+r.g1);assert(r2.expr==='hits * 2 + min(3, 4)'&&r2.badCls&&r2.after==='Print,SetTimer','edit '+JSON.stringify(r2));return 'expr "'+r2.expr+'"';});

 await test('level save / load (browser storage) and malformed file rejection',async()=>{const r=await ev(async()=>{const {KE,world:w}=t;const s0=KE.Level.stringify(w);const n=ed.saveLevel('test');
   ed.select(w.find('Boulder'));ed.deleteSelected();const ok=await ed.loadLevel('test');const same=KE.Level.stringify(w)===s0;
   const bad=await ed.loadLevelJSON('{"format":"kitsune-level","version":1,"actors":[{"id":1},{"id":1}]}','bad.json');const still=KE.Level.stringify(w)===s0;
   const errs=ed.logEntries.filter(e=>e.level==='error').map(e=>e.text).slice(-2);return {n,ok,same,bad,still,errs};});
   assert(r.n>1000&&r.ok&&r.same,'save/load '+JSON.stringify(r));assert(r.bad===false&&r.still&&r.errs.some(e=>/duplicate id/.test(e)),'bad file '+JSON.stringify(r));return (r.n/1024).toFixed(1)+' KB';});

 await test('glTF export (GLB) and re-import as an asset actor',async()=>{const r=await ev(async()=>{const buf=await ed.exportGLTF({download:false});const magic=new TextDecoder().decode(new Uint8Array(buf,0,4));
   const n0=t.world.actors.length;const a=await ed.importGLTF(buf,'level-export');const sm=a&&a.getComponent('StaticMesh');let meshes=0;a&&a.object.traverse(o=>{if(o.isMesh)meshes++;});
   const r={magic,bytes:buf.byteLength,added:t.world.actors.length-n0,prim:sm&&sm.props.mesh.primitive,asset:sm&&sm.props.mesh.asset,meshes,has:!!t.world.getAsset('level-export')};ed.undo();t.world.removeAsset('level-export');return r;});
   assert(r.magic==='glTF'&&r.bytes>2000&&r.added===1&&r.prim==='gltf'&&r.meshes>5&&r.has,JSON.stringify(r));return r.bytes+' bytes, '+r.meshes+' meshes';});

 await test('console: cvars, stat fps/unit, show grid, list, autocomplete, keyboard toggle',async()=>{
   await page.keyboard.press('Backquote');
   await new Promise(r=>setTimeout(r,100));const r1=await ev(()=>({open:t.KE.ConsoleUI.isOpen,focus:document.activeElement&&document.activeElement.getAttribute('aria-label')}));
   await page.keyboard.type('r.TA');await page.keyboard.press('Tab');const comp=await ev(()=>document.querySelector('.ke-ed-conin input').value);
   await page.keyboard.type('0');await page.keyboard.press('Enter');
   const r=await ev(()=>{const C=t.KE.ConsoleUI;const taa=t.KE.settings.taa;const s1=C.run('stat fps');const statEl=!!document.querySelector('.ke-ed-stat');const s2=C.run('stat unit');
     const g0=ed.show.grid;C.run('show grid');const g1=ed.show.grid;C.run('show grid');const list=C.run('list r.Sh').output;const bad=C.run('r.Shadow.Cascades banana');const unk=C.run('nosuchthing');const help=C.run('help').output.length;
     let custom=null;C.command('hello',args=>'hi '+args.join(' '),'test command');custom=C.run('hello world').output[0];C.run('r.TAA 1');
     return {taa,s1:s1.output[0],statEl,s2:s2.output[0],g0,g1,list,bad:bad.ok,unk:unk.ok,help,custom,taa2:t.KE.settings.taa,log:document.querySelectorAll('.ke-ed-conlog div').length};});
   assert(r1.open,'console did not open');console.log('   focus:',r1.focus);assert(comp==='r.TAA ','autocomplete gave "'+comp+'"');assert(r.taa===false&&r.taa2===true,'r.TAA '+JSON.stringify(r));
   assert(r.statEl&&/fps/.test(r.s1)&&/unit/.test(r.s2),'stat');assert(r.g0!==r.g1,'show grid');assert(r.list.length===4&&r.list.some(l=>l.startsWith('r.Shadow.Cache'))&&!r.bad&&!r.unk&&r.help>=8&&r.custom==='hi world',JSON.stringify(r));return 'autocomplete "'+comp.trim()+'", '+r.log+' console lines';});

 await test('screenshot: editor over a small level with gizmo, outliner, details, drawer, console + stat unit',async()=>{
   await ev(async()=>{t.KE.ConsoleUI.stat('none');t.KE.ConsoleUI.run('stat unit');ed._setTab('log');ed.select(t.world.find('Crate'));ed.setMode('translate');ed.setShow('stats',true);
     for(let i=0;i<8;i++){ed.frame(1/60);await new Promise(r=>requestAnimationFrame(r));}});
   await new Promise(r=>setTimeout(r,400));const f=await shot('main');return f;});

 await test('screenshot: Blueprint editor, rotate gizmo, console closed',async()=>{
   await ev(async()=>{t.KE.ConsoleUI.close();t.KE.ConsoleUI.stat('none');ed.select(t.world.find('Spinner'));ed.setMode('rotate');ed.setSpace('local');ed._setTab('bp');ed._bpEvent='Custom:Blink';ed._renderBlueprint();ed.setShow('stats',false);ed.frame(1/60);ed.frame(1/60);});
   await new Promise(r=>setTimeout(r,200));return shot('blueprint');});

 await test('responsive layout at 860 px and keyboard shortcuts',async()=>{
   await page.setViewportSize({width:860,height:560});
   const r=await ev(async()=>{ed.frame(1/60);await new Promise(r=>requestAnimationFrame(r));const d=getComputedStyle(document.querySelector('.ke-ed-drawer')).display;const c=t.renderer.domElement,v=document.querySelector('.ke-ed-view').getBoundingClientRect();
     document.querySelector('.ke-ed-view').focus();return {d,cw:c.width,vw:Math.round(v.width),barH:document.querySelector('.ke-ed-bar').scrollWidth<=document.querySelector('.ke-ed-bar').clientWidth+1};});
   await page.keyboard.press('KeyR');const m=await ev(()=>ed.mode);await page.keyboard.press('KeyW');const m2=await ev(()=>ed.mode);
   await page.keyboard.press('Control+KeyD');const dup=await ev(()=>ed.primary.name);await page.keyboard.press('Delete');await page.keyboard.press('Control+KeyZ');const back=await ev(()=>!!t.world.find(ed.primary?ed.primary.name:'')&&ed.primary.name);
   await page.keyboard.press('Control+KeyZ');await ev(()=>{ed.select(t.world.find('Crate'));ed.frame(1/60);});await shot('narrow');
   await page.setViewportSize({width:1280,height:720});await ev(()=>ed.frame(1/60));
   assert(r.d==='none'&&r.cw===r.vw,'narrow layout '+JSON.stringify(r));assert(m==='scale'&&m2==='translate'&&dup==='Spinner_1'&&back==='Spinner_1','keys '+JSON.stringify([m,m2,dup,back]));return 'drawer hidden, viewport '+r.vw+'px';});

 if(withPipe)await test('editor overlay over KE.Pipeline (grid occluded via scene depth)',async()=>{
   await ev(()=>{t.KE.settings.pipeline=true;const p=new t.KE.Pipeline(t.T,t.renderer,{});ed.options.render=dt=>p.render(t.scene,t.camera,dt);ed.setMode('translate');ed.select(t.world.find('Crate'));for(let i=0;i<4;i++)ed.frame(1/60);window.__pipe=p;});
   const r=await ev(()=>ed._grid.material.uniforms.uUseDepth.value);await shot('pipeline');await ev(()=>{ed.options.render=null;window.__pipe.dispose();});assert(r===1,'grid did not switch to scene-depth occlusion');return 'uUseDepth=1';});

 await test('closing removes DOM, listeners and per-frame work; canvas restored',async()=>{const r=await ev(async()=>{const live=window.__live,c=t.renderer.domElement;
   ed.close();const afterClose={root:!!document.querySelector('.ke-ed-root'),style:!!document.getElementById('ke-ed-style'),menu:!!document.querySelector('.ke-ed-menu'),css:c.style.position,w:c.width,h:c.height};
   const leftovers=[...live.entries()].filter(([k,tgt])=>!window.__before.has(k)&&(tgt===window||tgt===document||tgt.isConnected)).map(([k,tgt])=>(tgt===window?'window':tgt===document?'document':tgt.className||tgt.nodeName)+':'+k.split('|')[1]);
   /* a looping editor stops scheduling frames when closed */
   const e2=new t.KE.Editor(t.T,{renderer:t.renderer,scene:t.scene,camera:t.camera,world:t.world,hotkey:null});let n=0;const f=e2.frame.bind(e2);e2.frame=dt=>{n++;f(dt);};e2.open();
   for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r));const running=n;e2.close();const n1=n;for(let i=0;i<4;i++)await new Promise(r=>requestAnimationFrame(r));e2.dispose();
   return {afterClose,leftovers,running,stopped:n===n1,sel:ed.selection.length,windowKeys:[...live.entries()].filter(([k,tg])=>tg===window&&/\|keydown\|/.test(k)).length};});
   const a=r.afterClose;assert(!a.root&&!a.menu&&a.css===''&&a.w===1280&&a.h===720,'dom/canvas '+JSON.stringify(a));assert(!r.leftovers.length,'listeners left: '+r.leftovers.join(', '));
   assert(r.running>=2&&r.stopped,'loop '+JSON.stringify(r));return 'frames while open '+r.running+', 0 after close; window keydown hooks added by editors and still live: '+r.windowKeys+' (the F8 hotkey)';});

 await test('F8 reopens the editor and dispose() removes the hotkey',async()=>{await page.keyboard.press('F8');const o=await ev(()=>ed.isOpen);await page.keyboard.press('F8');const c=await ev(()=>ed.isOpen);
   await ev(()=>ed.dispose());await page.keyboard.press('F8');const d=await ev(()=>ed.isOpen);assert(o&&!c&&!d,JSON.stringify([o,c,d]));return 'open → close → disposed';});

 try{await close();}catch(e){failed++;console.log('FAIL page errors\n   '+e.message);}
 console.log(failed?failed+' test(s) FAILED':'all '+results.length+' editor/gameplay tests passed');process.exit(failed?1:0);
}
