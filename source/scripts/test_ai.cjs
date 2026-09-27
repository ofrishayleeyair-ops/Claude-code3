/* Tests for src/modules/70-ai.js (KE.NavMesh, KE.Crowd, KE.BT, KE.Blackboard, KE.Perception, KE.EQS, KE.FSM, KE.steering).
   Part 1 runs the pure logic in Node (vm, like test_core.cjs); part 2 opens the module in headless Chromium through
   harness.cjs and renders a top-down navmesh debug overlay with a path and a crowd mid-crossing.
     node scripts/test_ai.cjs            all tests + screenshot .test-output/ai-navmesh.png
     node scripts/test_ai.cjs --node     Node tests only */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ROOT=path.resolve(__dirname,'..');
const T=require('../assets/three.min.js');
function loadEngine(){
  const storage=new Map(),element=()=>({style:{},appendChild(){},remove(){},addEventListener(){},removeEventListener(){},querySelectorAll(){return [];}});
  const ctx={console,navigator:{hardwareConcurrency:8,deviceMemory:8},document:{createElement:element,head:element(),documentElement:element(),addEventListener(){},removeEventListener(){},hidden:false},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},performance,requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout,clearTimeout,addEventListener(){},removeEventListener(){}};
  ctx.window=ctx;vm.createContext(ctx);
  for(const f of ['src/core.js','src/modules/00-core-v3.js','src/modules/70-ai.js'])vm.runInContext(fs.readFileSync(path.join(ROOT,f),'utf8'),ctx,{filename:f});
  return ctx.KitsuneEngine;
}
const KE=loadEngine();let count=0;
const queue=[];function test(name,fn){queue.push([name,fn]);}
const V=(x,z,y=0)=>new T.Vector3(x,y,z);
const plen=p=>KE.NavMesh.pathLength(p);

/* ---------- shared test world: hills, obstacles (circle/box/rotated box), a lake hole, a thin wall with a gap, an island ---------- */
const hills=(x,z)=>Math.sin(x*.15)*1.2+Math.cos(z*.12)*1.0;
const obstacles=[{x:10,z:10,r:3},{x:-8,z:5,r:2},{minX:-20,minZ:-3,maxX:5,maxZ:-1.5},{x:-15,z:15,hx:4,hz:.5,rotation:.7}];
const inObstacle=(x,z)=>obstacles.some(o=>o.r!==undefined?Math.hypot(x-o.x,z-o.z)<o.r:o.hx!==undefined?(()=>{const dx=x-o.x,dz=z-o.z,c=Math.cos(o.rotation),s=Math.sin(o.rotation);return Math.abs(dx*c+dz*s)<o.hx&&Math.abs(-dx*s+dz*c)<o.hz;})():x>o.minX&&x<o.maxX&&z>o.minZ&&z<o.maxZ);
const lake=(x,z)=>Math.hypot(x-15,z+14)<5;
const thinWall=(x,z)=>Math.abs(x+20)<.3&&z>-25&&z<25&&Math.abs(z)>1.2;
const moat=(x,z)=>{const d=Math.hypot(x-22,z-22);return d<7&&d>=4.5;};
const blocked=(x,z)=>lake(x,z)||thinWall(x,z)||moat(x,z);
const buildWorld=()=>KE.NavMesh.build(T,{bounds:{minX:-30,minZ:-30,maxX:30,maxZ:30},heightAt:hills,cellSize:.5,agentRadius:.4,obstacles,blocked});
let world;

test('module registers and exposes the API',()=>{
  assert.ok(KE.modules.ai);for(const k of ['NavMesh','Crowd','BT','Blackboard','Perception','EQS','FSM','steering'])assert.ok(KE[k],k);
  assert.equal(typeof KE.findPath,'function');
});
test('navmesh: clean convex polygons far fewer than walkable cells, holes and islands',()=>{
  world=buildWorld();const s=world.stats();
  assert.ok(s.walkableCells>10000,'walkable '+s.walkableCells);
  assert.ok(s.polys*20<s.walkableCells,'polys '+s.polys+' vs cells '+s.walkableCells);
  assert.ok(s.islands>=2,'islands '+s.islands);
  for(const p of world.polys){assert.ok(p.n>=3&&p.n<=6);for(let i=0;i<p.n;i++){const a=i,b=(i+1)%p.n,c=(i+2)%p.n;
    const cr=(p.x[b]-p.x[a])*(p.z[c]-p.z[a])-(p.z[b]-p.z[a])*(p.x[c]-p.x[a]);assert.ok(cr>=-1e-7,'non-convex polygon');}}
  // polygon area is conservative: never more than the walkable cells cover
  assert.ok(s.area<=s.walkableCells*.25+1e-6&&s.area>s.walkableCells*.25*.95,'area '+s.area);
  // holes: obstacle/lake centres are not walkable, open ground is
  assert.ok(!world.isWalkable(10,10)&&!world.isWalkable(15,-14)&&!world.isWalkable(-8,5)&&!world.isWalkable(0,-2.2));
  assert.ok(world.isWalkable(0,5)&&world.isWalkable(-25,-25));
  console.log('   ',JSON.stringify({cells:s.cells,walkable:s.walkableCells,polys:s.polys,verts:s.verts,links:s.links,islands:s.islands,tiles:s.tiles,buildMs:+s.buildMs.toFixed(1)}));
});
test('navmesh: paths are valid and within 10% of a fine-grid A* reference',()=>{
  const nav=world,rng=KE.random(7),cs=nav.cellSize,B=nav.bounds;let n=0,worst=0,sum=0,skipped=0;
  const ci=v=>Math.floor((v.x-B.minX)/cs),cj=v=>Math.floor((v.z-B.minZ)/cs);
  for(let it=0;it<160;it++){
    const a=nav.randomPoint(rng),b=nav.randomPoint(rng);
    const ia=nav.findNearest(a.x,a.z,.1).poly.island,ib=nav.findNearest(b.x,b.z,.1).poly.island,p=nav.findPath(a,b);
    if(ia!==ib){assert.equal(p.length,0,'path across islands');skipped++;continue;}
    assert.ok(p.length>=2,'no path on the same island');
    assert.ok(Math.hypot(p[0].x-a.x,p[0].z-a.z)<1e-6&&Math.hypot(p[p.length-1].x-b.x,p[p.length-1].z-b.z)<1e-6);
    for(let i=1;i<p.length;i++){const A=p[i-1],Bp=p[i],m=Math.ceil(Math.hypot(Bp.x-A.x,Bp.z-A.z)/.05);
      for(let k=0;k<=m;k++){const x=A.x+(Bp.x-A.x)*k/m,z=A.z+(Bp.z-A.z)*k/m;
        assert.ok(nav.isWalkable(x,z),'path sample off mesh '+x+','+z);assert.ok(!blocked(x,z)&&!inObstacle(x,z),'path sample blocked '+x+','+z);}
      assert.ok(Math.abs(Bp.y-hills(Bp.x,Bp.z))<1e-6,'y from heightAt');}
    const grid=KE.findPath({width:nav.W,height:nav.H,start:[ci(a),cj(a)],goal:[ci(b),cj(b)],diagonal:true,walkable:(i,j)=>!!nav.walk[j*nav.W+i]});
    assert.ok(grid.length,'grid reference found no path');
    let gl=0;for(let i=1;i<grid.length;i++)gl+=Math.hypot(grid[i][0]-grid[i-1][0],grid[i][1]-grid[i-1][1])*cs;
    const L=plen(p),straight=Math.hypot(b.x-a.x,b.z-a.z),ratio=L/(gl+cs*1.5);
    assert.ok(L>=straight-1e-6);assert.ok(ratio<=1.1,'path '+L.toFixed(2)+' vs grid '+gl.toFixed(2));worst=Math.max(worst,ratio);sum+=ratio;n++;}
  assert.ok(n>100);console.log('    pairs',n,'cross-island',skipped,'worst ratio',worst.toFixed(3),'mean',(sum/n).toFixed(3));
});
test('navmesh: separate island returns [] (partial walks to the closest reachable point)',()=>{
  const nav=world;assert.ok(!nav.isWalkable(22,26.5)&&nav.isWalkable(22,22));
  assert.equal(nav.findPath(V(0,0),V(22,22)).length,0);
  assert.ok(nav.findPath(V(21,21),V(23,23.5)).length>=2,'path inside the island');
  const part=nav.findPath(V(0,0),V(22,22),{partial:true});assert.ok(part.length>=2&&nav.lastPathPartial);
  const end=part[part.length-1];assert.ok(Math.hypot(end.x-22,end.z-22)>=7&&Math.hypot(end.x-22,end.z-22)<8.5,'partial end '+end.x+','+end.z);
  assert.equal(nav.findPath(V(0,0),V(500,500)).length,0);
});
test('navmesh: narrow passages respect the agent radius',()=>{
  const mk=w=>KE.NavMesh.build(T,{bounds:{minX:-6,minZ:-6,maxX:6,maxZ:6},heightAt:()=>0,cellSize:.25,agentRadius:.4,blocked:(x,z)=>Math.abs(x)<.25&&Math.abs(z)>w/2});
  const closed=mk(.7);assert.equal(closed.findPath(V(-4,0),V(4,0)).length,0);assert.equal(closed.stats().islands,2);
  const open=mk(1.6),p=open.findPath(V(-4,3),V(4,3.5));assert.ok(p.length>=4&&plen(p)>8.5,'path bends through the gap');
  for(let i=1;i<p.length;i++){const A=p[i-1],B=p[i];if((A.x<=0)!==(B.x<=0)){const t=-A.x/(B.x-A.x),z=A.z+(B.z-A.z)*t;assert.ok(Math.abs(z)<=.8-.4+.125+1e-6,'crossing z '+z);}}
});
test('navmesh: nearestPoint, raycast, heightAt, clearance and seeded randomPoint',()=>{
  const nav=world,out=V(0,0);
  assert.ok(nav.nearestPoint(V(10,10),out));assert.ok(Math.abs(Math.hypot(out.x-10,out.z-10)-3.4)<.45&&nav.isWalkable(out.x,out.z));
  assert.equal(nav.nearestPoint(V(200,200),V(0,0)),null);
  const hit=nav.raycast(V(0,10),V(20,10));assert.ok(hit.hit&&hit.point.x>6.3&&hit.point.x<7.2,'hit '+hit.point.x);assert.ok(hit.normal.x>.5);
  assert.ok(!nav.raycast(V(0,20),V(5,25)).hit);assert.ok(nav.raycast(V(10,10),V(0,0)).hit,'start off mesh');
  assert.ok(Math.abs(nav.heightAt(3,4)-hills(3,4))<1e-9);assert.ok(nav.clearanceAt(0,20)>3&&nav.clearanceAt(10,13.2)<1);
  const r1=KE.random(5),r2=KE.random(5);for(let i=0;i<30;i++){const a=nav.randomPoint(r1),b=nav.randomPoint(r2);assert.ok(a.equals(b)&&nav.isWalkable(a.x,a.z));}
  const near=V(-25,25);for(let i=0;i<20;i++){const p=nav.randomPoint(r1,near,3);assert.ok(p&&Math.hypot(p.x-near.x,p.z-near.z)<=3+1e-9);}
});
test('navmesh: dynamic obstacle reroutes and re-carves only affected tiles',()=>{
  const nav=KE.NavMesh.build(T,{bounds:{minX:-24,minZ:-24,maxX:24,maxZ:24},heightAt:()=>0,cellSize:.5,tileSize:12});
  const A=V(-10,0),B=V(10,0),p0=nav.findPath(A,B);assert.equal(p0.length,2);assert.ok(Math.abs(plen(p0)-20)<1e-6);
  const rev=nav.revision,id=nav.addObstacle({x:0,z:0,r:2});assert.ok(nav.revision>rev);
  const tiles=nav.stats().tiles;assert.ok(nav.lastRebuild.tiles>0&&nav.lastRebuild.tiles<=4&&nav.lastRebuild.tiles<tiles,'rebuilt '+nav.lastRebuild.tiles+'/'+tiles);
  const p1=nav.findPath(A,B);assert.ok(p1.length>2&&plen(p1)>20.2&&plen(p1)<22.5,'detour '+plen(p1));
  for(let i=1;i<p1.length;i++)for(let k=0;k<=40;k++){const x=p1[i-1].x+(p1[i].x-p1[i-1].x)*k/40,z=p1[i-1].z+(p1[i].z-p1[i-1].z)*k/40;assert.ok(Math.hypot(x,z)>=2+.4-.25,'inside obstacle clearance');}
  const box=nav.addObstacle({x:0,z:6,hx:1,hz:6,rotation:0});assert.ok(nav.findPath(A,B).length>2);
  assert.ok(nav.removeObstacle(id)&&nav.removeObstacle(box));assert.ok(!nav.removeObstacle(id));
  const p2=nav.findPath(A,B);assert.equal(p2.length,2);assert.ok(Math.abs(plen(p2)-20)<1e-6);
});
test('navmesh: toJSON/fromJSON round trip keeps topology, paths and dynamic re-carving',()=>{
  const json=JSON.parse(JSON.stringify(world.toJSON()));const nav=KE.NavMesh.fromJSON(T,json,{heightAt:hills});
  const a=world.stats(),b=nav.stats();for(const k of ['polys','verts','links','islands'])assert.equal(b[k],a[k],k);
  const rng=KE.random(11);for(let i=0;i<20;i++){const s=world.randomPoint(rng),e=world.randomPoint(rng);assert.ok(Math.abs(plen(world.findPath(s,e))-plen(nav.findPath(s,e)))<1e-3);}
  nav.addObstacle({x:0,z:20,r:2});assert.ok(nav.lastRebuild.tiles>0&&!nav.isWalkable(0,20));
  const bare=KE.NavMesh.fromJSON(T,world.toJSON({grid:false}));assert.equal(bare.stats().polys,a.polys);assert.throws(()=>bare.addObstacle({x:0,z:0,r:1}));
  assert.ok(Math.abs(bare.heightAt(3,4)-hills(3,4))<.35,'interpolated height without heightAt');
  assert.throws(()=>KE.NavMesh.fromJSON(T,{format:'nope'}));assert.throws(()=>KE.NavMesh.build(T,{bounds:{minX:0,minZ:0,maxX:-1,maxZ:1}}));
});
test('navmesh: async build through KE.jobs matches the synchronous build',()=>{
  let nav=null;KE.NavMesh.buildAsync(T,{bounds:{minX:-30,minZ:-30,maxX:30,maxZ:30},heightAt:hills,cellSize:.5,obstacles,blocked}).then(n=>nav=n);
  for(let i=0;i<200&&KE.jobs.pending;i++)KE.jobs.run(4);
  return Promise.resolve().then(()=>{assert.ok(nav);assert.equal(nav.stats().polys,world.stats().polys);});
});
test('crowd: 40 agents cross without overlap, reach their targets and stay on the mesh',()=>{
  const nav=KE.NavMesh.build(T,{bounds:{minX:-20,minZ:-20,maxX:20,maxZ:20},heightAt:(x,z)=>Math.sin(x*.15)*.6,cellSize:.5,obstacles:[{x:0,z:0,r:2.5},{x:-3,z:8,r:1.5},{x:4,z:-8,r:1.5}]});
  const crowd=new KE.Crowd(nav,{maxAgents:64}),agents=[],targets=[],rng=KE.random(9);let arrivals=0;crowd.onArrive=()=>arrivals++;
  for(let i=0;i<40;i++){const side=i<20?-1:1,k=i%20,row=Math.floor(k/5),col=k%5,r=.35+rng()*.15;
    const a=crowd.addAgent({position:V(side*(12+row*1.3),(col-2)*2.4),radius:r,maxSpeed:3+rng()*.8,maxAccel:10});
    const t=V(-side*(12+row*1.3),(col-2)*2.4);a.setTarget(t);agents.push(a);targets.push(t);}
  let minRatio=Infinity,off=0,steps=0;const dt=1/30;
  for(let s=0;s<30*40;s++){crowd.update(dt);steps++;
    if(s>=30)for(let i=0;i<40;i++)for(let j=i+1;j<40;j++){const a=agents[i],b=agents[j];minRatio=Math.min(minRatio,Math.hypot(a.position.x-b.position.x,a.position.z-b.position.z)/(a.radius+b.radius));}
    for(const a of agents){if(!nav.isWalkable(a.position.x,a.position.z,1e-3))off++;if(Math.abs(a.position.y-Math.sin(a.position.x*.15)*.6)>1e-6)off++;}
    if(agents.every(a=>a.state==='arrived'))break;}
  const far=Math.max(...agents.map((a,i)=>Math.hypot(a.position.x-targets[i].x,a.position.z-targets[i].z)));
  console.log('    steps',steps,'min pair distance/(ri+rj)',minRatio.toFixed(3),'max distance to target',far.toFixed(3));
  assert.ok(agents.every(a=>a.state==='arrived'),'not all arrived');assert.equal(arrivals,40);
  assert.ok(far<.5);assert.ok(minRatio>=.8,'overlap '+minRatio);assert.equal(off,0,'left the mesh');
  assert.ok(crowd.removeAgent(agents[0])&&!crowd.removeAgent(agents[0])&&crowd.agents.length===39&&crowd.agents.every((a,i)=>a.index===i));
});
test('crowd: agents replan around a dynamic obstacle and handle unreachable targets',()=>{
  const nav=KE.NavMesh.build(T,{bounds:{minX:-16,minZ:-16,maxX:16,maxZ:16},heightAt:()=>0,cellSize:.5,tileSize:8,blocked:(x,z)=>Math.hypot(x-10,z-10)<3.5&&Math.hypot(x-10,z-10)>2});
  const crowd=new KE.Crowd(nav),a=crowd.addAgent({position:V(-10,0),maxSpeed:3}),b=crowd.addAgent({position:V(-10,-6)});a.setTarget(V(10,0));b.setTarget(V(10,10));
  let inside=0;for(let s=0;s<30*12;s++){if(s===20)nav.addObstacle({x:2,z:0,r:1.6});crowd.update(1/30);if(s>20&&Math.hypot(a.position.x-2,a.position.z)<1.6+.3)inside++;}
  assert.equal(inside,0);assert.equal(a.state,'arrived');assert.equal(b.state,'unreachable');assert.ok(Math.hypot(b.position.x-10,b.position.z-10)>3.4);
  a.setTarget(null);assert.equal(a.state,'idle');crowd.update(1/30);assert.ok(a.speed<3);
});
test('blackboard: get/set/has/delete, change events, parent scope',()=>{
  const root=new KE.Blackboard({team:'red'}),bb=new KE.Blackboard({hp:10},root),log=[];
  const off=bb.onChange('hp',(v,o)=>log.push(['hp',v,o]));bb.onChange((v,o,k)=>log.push(['*',k]));
  assert.equal(bb.get('team'),'red');assert.ok(bb.has('team'));bb.set('hp',10);bb.set('hp',7);off();bb.set('hp',5);assert.ok(bb.delete('hp'));assert.ok(!bb.has('hp'));assert.equal(bb.get('hp',99),99);
  assert.deepEqual(log,[['hp',7,10],['*','hp'],['*','hp'],['*','hp']]);
});
test('BT: composites, decorators, wait, actions and debug state',()=>{
  const {BT}=KE,log=[];const act=(name,results)=>{let i=0;return BT.action(()=>{log.push(name);return results[Math.min(i++,results.length-1)];},{name,onEnter:()=>log.push(name+'+'),onExit:(c,s)=>log.push(name+'-'+s)});};
  let t=BT.tree(BT.sequence([act('a',['success']),act('b',['running','success']),act('c',['failure'])]));
  assert.equal(t.tick(.1),'running');assert.equal(t.tick(.1),'failure');assert.deepEqual(log,['a+','a','a-success','b+','b','b','b-success','c+','c','c-failure']);
  log.length=0;t=BT.tree(BT.sequence([act('a',['success']),act('b',['running','running','success'])],{memory:false}));t.tick();t.tick();assert.deepEqual(log.filter(x=>x==='a'),['a','a'],'reactive re-evaluates');
  log.length=0;t=BT.tree(BT.selector([act('a',['failure']),act('b',['success']),act('c',['success'])]));assert.equal(t.tick(),'success');assert.ok(!log.includes('c'));
  t=BT.tree(BT.parallel([act('p',['running','success']),act('q',['running','running','success'])],{success:'all'}));assert.equal(t.tick(),'running');assert.equal(t.tick(),'running');assert.equal(t.tick(),'success');
  log.length=0;t=BT.tree(BT.parallel([act('p',['running','success']),act('q',['running'])],{success:'one'}));t.tick();assert.equal(t.tick(),'success');assert.ok(log.includes('q-aborted'),'losing branch halted');
  t=BT.tree(BT.parallel([act('p',['failure']),act('q',['running'])],{success:'all'}));assert.equal(t.tick(),'failure');
  assert.equal(BT.tree(BT.inverter(act('x',['success']))).tick(),'failure');assert.equal(BT.tree(BT.succeeder(act('x',['failure']))).tick(),'success');assert.equal(BT.tree(BT.failer(act('x',['success']))).tick(),'failure');
  let n=0;t=BT.tree(BT.repeat(BT.action(()=>{n++;}),{count:3}));assert.equal(t.tick(),'running');assert.equal(t.tick(),'running');assert.equal(t.tick(),'success');assert.equal(n,3);
  n=0;t=BT.tree(BT.retry(BT.action(()=>{n++;return false;}),{count:3}));assert.equal(t.tick(),'running');t.tick();assert.equal(t.tick(),'failure');assert.equal(n,3);
  n=0;t=BT.tree(BT.selector([BT.cooldown(BT.action(()=>{n++;}),2),BT.action(()=>'failure')]));
  assert.equal(t.tick(.5),'success');assert.equal(t.tick(.5),'failure');t.tick(.5);t.tick(.5);assert.equal(t.tick(.5),'success');assert.equal(n,2);
  log.length=0;t=BT.tree(BT.timeout(act('slow',['running']),{duration:1}));for(let i=0;i<3;i++)assert.equal(t.tick(.4),'running');assert.equal(t.tick(.4),'failure');assert.deepEqual(log.slice(-1),['slow-aborted']);
  t=BT.tree(BT.wait(1));const st=[];for(let i=0;i<5;i++)st.push(t.tick(.25));assert.deepEqual(st,['running','running','running','running','success']);
  t=BT.tree(BT.wait([1,2]),{seed:3});let k=0;while(t.tick(.1)==='running')k++;assert.ok(k>=9&&k<=20);
  assert.throws(()=>BT.tree(BT.action(()=>'maybe')).tick(),/invalid status/);assert.throws(()=>BT.sequence([]));assert.throws(()=>BT.blackboardCondition('k','~=',1));
  const shared=BT.action(()=>'running',{name:'shared'}),t1=BT.tree(shared),t2=BT.tree(BT.sequence([shared,shared]));t1.tick();assert.equal(t2.debugState().children[1].running,false,'instances keep separate memory');
  const d=BT.tree(BT.selector([BT.blackboardCondition('enemy','set',act('chase',['running']),{abort:'self'}),act('patrol',['running'])],{name:'root'}));d.tick();
  const ds=d.debugState();assert.equal(ds.name,'root');assert.equal(ds.children[0].status,'failure');assert.equal(ds.children[1].running,true);assert.ok(/> patrol/.test(d.debugString()));
});
test('BT: observer aborts self / lower / both (selector and sequence)',()=>{
  const {BT}=KE,log=[];const run=name=>BT.action(()=>{log.push(name);return 'running';},{name,onExit:(c,s)=>log.push(name+'-'+s)});
  const mk=abort=>{const bb=new KE.Blackboard();return {bb,t:BT.tree(BT.selector([BT.blackboardCondition('enemy','set',run('chase'),{abort}),run('patrol')]),{blackboard:bb})};};
  // self: chase aborts as soon as the enemy is gone, the selector falls through to patrol in the same tick
  let {bb,t}=mk('self');bb.set('enemy',1);t.tick(.1);assert.deepEqual(log,['chase']);bb.delete('enemy');t.tick(.1);assert.deepEqual(log,['chase','chase-aborted','patrol']);
  // self does not preempt a lower-priority branch
  log.length=0;bb.set('enemy',1);t.tick(.1);assert.deepEqual(log,['patrol']);
  // lower: patrol is aborted when the enemy appears; chase is not aborted when it disappears
  log.length=0;({bb,t}=mk('lower'));t.tick(.1);bb.set('enemy',1);t.tick(.1);assert.deepEqual(log,['patrol','patrol-aborted','chase']);
  log.length=0;bb.delete('enemy');t.tick(.1);assert.deepEqual(log,['chase']);
  // none: neither
  log.length=0;({bb,t}=mk('none'));t.tick(.1);bb.set('enemy',1);t.tick(.1);assert.deepEqual(log,['patrol','patrol']);
  // both
  log.length=0;({bb,t}=mk('both'));t.tick(.1);bb.set('enemy',1);t.tick(.1);bb.delete('enemy');t.tick(.1);assert.deepEqual(log,['patrol','patrol-aborted','chase','chase-aborted','patrol']);
  // lower abort in a sequence: an earlier guard turning false stops the running tail
  log.length=0;const bb2=new KE.Blackboard({ok:true});const t2=BT.tree(BT.sequence([BT.blackboardCondition('ok','truthy',BT.action(()=>'success'),{abort:'lower'}),run('work')]),{blackboard:bb2});
  assert.equal(t2.tick(),'running');bb2.set('ok',false);assert.equal(t2.tick(),'failure');assert.deepEqual(log,['work','work-aborted']);
  // plain condition decorator with a function
  let hp=10;log.length=0;const t3=BT.tree(BT.selector([BT.condition(()=>hp<5,run('flee'),{abort:'lower'}),run('fight')]));t3.tick();hp=2;t3.tick();assert.deepEqual(log,['fight','fight-aborted','flee']);
});
test('BT: fromJSON with a registry, validation errors',()=>{
  const {BT}=KE,log=[];
  const registry={actions:{patrol:()=>{log.push('patrol');return 'running';},shoot:{fn:()=>{log.push('shoot');return 'success';},onEnter:()=>log.push('aim')}},conditions:{lowHp:(ctx)=>ctx.hp<3},
    subtrees:{combat:{type:'sequence',children:[{type:'action',action:'shoot'},{type:'wait',duration:.5}]}}};
  const json={type:'selector',name:'guard',children:[{type:'condition',condition:'lowHp',child:{type:'action',action:'patrol'},abort:'lower'},
    {type:'blackboardCondition',key:'target',op:'set',abort:'both',child:{type:'subtree',ref:'combat'}},{type:'repeat',count:2,child:{type:'action',action:'patrol'}}]};
  const bb=new KE.Blackboard(),t=BT.tree(BT.fromJSON(json,registry),{blackboard:bb}),ctx={hp:10};
  t.tick(.1,ctx);assert.deepEqual(log,['patrol']);bb.set('target','p1');t.tick(.1,ctx);assert.deepEqual(log,['patrol','aim','shoot']);
  assert.equal(t.debugState().children[1].children[0].name,'combat');
  assert.throws(()=>BT.fromJSON({type:'action',action:'nope'},registry),/unknown action/);
  assert.throws(()=>BT.fromJSON({type:'teleport'},registry),/unknown node type/);
  assert.throws(()=>BT.fromJSON({type:'subtree',ref:'loop'},{subtrees:{loop:{type:'subtree',ref:'loop'}}}),/recursive/);
  assert.throws(()=>BT.fromJSON({type:'action',action:'constructor'},{actions:{}}),/unknown action/);
  assert.throws(()=>BT.fromJSON({type:'blackboardCondition',key:'a',op:'eval'},registry));
});
test('perception: FOV, range, occlusion, memory, detection time',()=>{
  const self={position:V(0,0),heading:0},seen=[],lost=[],forgot=[];
  const wall=(a,b)=>{if((a.z-3)*(b.z-3)>0)return true;const t=(3-a.z)/(b.z-a.z),x=a.x+(b.x-a.x)*t;return Math.abs(x)>1;};
  const P=new KE.Perception(T,{sight:{range:10,fov:90,lineOfSight:wall},memory:2,onSee:t=>seen.push(t.name),onLose:t=>lost.push(t.name),onForget:t=>forgot.push(t.name)});
  const mk=(name,x,z)=>({name,position:V(x,z)});const front=mk('front',3,5),hidden=mk('hidden',0,5),behind=mk('behind',0,-5),side=mk('side',8,1),far=mk('far',0,12);
  P.update(.1,self,[front,hidden,behind,side,far]);
  assert.deepEqual(seen,['front']);assert.ok(P.canSee(front)&&!P.canSee(hidden)&&!P.canSee(behind)&&!P.canSee(side)&&!P.canSee(far));
  front.position.set(-6,0,-2);P.update(.1,self,[front]);assert.deepEqual(lost,['front']);
  const r=P.get(front);assert.ok(r&&!r.visible&&r.lastKnown.x===3&&r.lastKnown.z===5);
  for(let i=0;i<18;i++)P.update(.1,self,[front]);assert.ok(P.get(front),'still remembered');for(let i=0;i<3;i++)P.update(.1,self,[front]);assert.deepEqual(forgot,['front']);assert.equal(P.get(front),null);
  // turning toward a target makes it visible; quaternion forward (+Z rotated)
  const q=new T.Object3D();q.rotation.y=Math.PI;q.updateMatrix();const P2=new KE.Perception(T,{sight:{range:10,fov:60}});P2.update(.1,q,[behind,front]);assert.ok(P2.canSee(behind)&&!P2.canSee(front));
  // detection time: awareness ramps up before the target counts as seen
  const P3=new KE.Perception({sight:{range:10,fov:120,detectTime:1}}),tgt=mk('t',0,8);let steps=0;while(!P3.canSee(tgt)&&steps<100){P3.update(.1,self,[tgt]);steps++;}
  assert.ok(steps>=6&&steps<=10,'steps '+steps);const P4=new KE.Perception({sight:{range:10,fov:120,detectTime:1}});let s2=0,near=mk('n',0,2);while(!P4.canSee(near)&&s2<100){P4.update(.1,self,[near]);s2++;}assert.ok(s2<steps,'closer is faster');
  // navmesh line of sight
  const P5=new KE.Perception({sight:{range:30,fov:360,lineOfSight:world,height:0,targetHeight:0}});P5.update(.1,{position:V(10,5),heading:0},[mk('a',10,15),mk('b',15,5)]);
  assert.equal([...P5.known.values()].filter(r=>r.visible).map(r=>r.target.name).join(),'b');
});
test('perception: hearing via hear() and KE.events noise, best()',()=>{
  const heard=[],P=new KE.Perception({hearing:{range:10},onHear:(s,r)=>heard.push(r.sense)}),self={position:V(0,0),heading:0};P.update(.1,self,[]);
  assert.ok(P.hear(V(0,-6),1,'rock'));assert.equal(P.hear(V(0,-15),1),null);assert.ok(P.hear(V(0,-15),2));
  const off=P.listen();KE.events.emit('noise',{position:V(4,4),loudness:1,source:'step'});KE.events.emit('noise',V(1,1),.5);off();KE.events.emit('noise',{position:V(1,1),source:'x'});
  assert.equal(heard.length,4);assert.ok(P.get('step')&&P.get('step').lastKnown.x===4&&P.get('step').sense==='hearing');assert.equal(P.get('x'),null);
  assert.equal(P.best().target,'noise');const tgt={position:V(0,4)};P.update(.1,self,[tgt]);assert.equal(P.best().target,tgt);P.dispose();assert.equal(P.known.size,0);
});
test('EQS: generators, filters and weighted scoring pick the best point',()=>{
  const goal=V(3,4);let r=KE.EQS.query({generator:{type:'grid',center:V(0,0),radius:5,spacing:1},tests:[KE.EQS.tests.distance(goal)]});
  assert.ok(r.best.x===3&&r.best.z===4);assert.ok(r.items.every(i=>i.score<=r.bestScore));
  r=KE.EQS.query({generator:{type:'ring',center:V(0,0),radius:6,count:16},tests:[KE.EQS.tests.distance(goal,{prefer:'far'})]});assert.ok(Math.hypot(r.best.x+3.6,r.best.z+4.8)<1.3);
  // on the navmesh: projection drops obstacle points; a hard filter plus two weighted tests
  r=KE.EQS.query({nav:world,generator:{type:'grid',center:V(10,10),radius:6,spacing:1},tests:[
    {fn:p=>Math.hypot(p.x-10,p.z-10),filter:{min:4}},KE.EQS.tests.distance(V(10,20),{weight:2}),KE.EQS.tests.clearance(world,{weight:.5})]});
  assert.ok(r.items.filter(i=>i.valid).every(i=>world.isWalkable(i.position.x,i.position.z)&&Math.hypot(i.position.x-10,i.position.z-10)>=4));
  let bestBrute=null;for(const it of r.items)if(it.valid&&(!bestBrute||it.score>bestBrute.score))bestBrute=it;assert.equal(r.bestItem,bestBrute);assert.ok(r.best.z>13.5,'toward the goal '+r.best.z);
  // cover: hidden from the enemy by the obstacle, close to us
  const enemy=V(10,1);r=KE.EQS.query({nav:world,generator:{type:'navRandom',center:V(10,10),radius:8,count:80},seed:4,tests:[KE.EQS.tests.visibility(enemy,world,{want:false}),KE.EQS.tests.distance(V(10,16))]});
  assert.ok(r.best&&world.raycast(enemy,r.best).hit,'best point is in cover');assert.ok(r.best.z>12);
  assert.throws(()=>KE.EQS.query({generator:{type:'spiral'}}));
});
test('FSM: enter/exit order, guarded transitions, update-returned states',()=>{
  const log=[],ctx={alert:false};
  const f=new KE.FSM({initial:'patrol',context:ctx,states:{
    patrol:{enter:(c,m,from)=>log.push('patrol+'+from),exit:()=>log.push('patrol-'),transitions:[{to:'chase',when:c=>c.alert}]},
    chase:{enter:()=>log.push('chase+'),exit:()=>log.push('chase-'),update:(c,dt,m)=>m.time>1?'search':null},
    search:{enter:(c,m)=>{log.push('search+');m.change('patrol');}}},any:[{to:'dead',when:c=>c.dead}],onChange:n=>log.push('>'+n)});
  f.states.dead={};f.update(.5);ctx.alert=true;f.update(.1);assert.equal(f.state,'chase');ctx.alert=false;f.update(.6);f.update(.6);assert.equal(f.state,'patrol');assert.equal(f.previous,'search');
  assert.deepEqual(log,['patrol+null','>patrol','patrol-','chase+','>chase','chase-','search+','>search','patrol+search','>patrol']);
  ctx.dead=true;f.update(.1);assert.ok(f.is('dead'));assert.throws(()=>f.change('flying'));
});
test('steering: seek, flee, arrive, pursue, evade, wander, separate, force',()=>{
  const S=KE.steering,a={position:V(0,0),velocity:V(0,0),maxSpeed:2},o=V(0,0);
  S.seek(a,V(3,4),o);assert.ok(Math.abs(o.length()-2)<1e-9&&Math.abs(o.x-1.2)<1e-9);
  S.flee(a,V(3,4),o);assert.ok(o.x<0&&o.z<0);S.flee(a,V(30,40),o,5);assert.equal(o.length(),0);
  S.arrive(a,V(0,1),o,2);assert.ok(Math.abs(o.length()-1)<1e-9);S.arrive(a,V(0,.01),o);assert.equal(o.length(),0);
  S.pursue(a,{position:V(10,0),velocity:V(0,5)},o);assert.ok(o.z>0);S.evade(a,{position:V(10,0),velocity:V(0,5)},o);assert.ok(o.x<0&&o.z<0);
  const rng=KE.random(2);for(let i=0;i<20;i++){S.wander(a,o,{rng,dt:.1});assert.ok(Math.abs(o.length()-2)<1e-9);}
  S.separate(a,[{position:V(.5,0)},{position:V(5,0)}],o,1);assert.ok(o.x<0&&o.z===0);
  S.force(V(2,0),{velocity:V(-2,0)},1,o);assert.ok(Math.abs(o.x-1)<1e-9);
});

(async()=>{
  for(const [name,fn] of queue){const t0=Date.now();await fn();count++;console.log('PASS '+name+' ('+(Date.now()-t0)+' ms)');}
  console.log(count+' node tests passed');
  /* ---------- browser: debug overlay rendering ---------- */
  if(process.argv.includes('--node'))return;
  const {openPage}=require('./harness.cjs');
  const {page,close,outDir}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/70-ai.js'],viewport:{width:640,height:400},name:'ai'});
  try{
  const r=await page.evaluate(()=>{
    const T=THREE,KE=KitsuneEngine,W=73,H=46,water=-.55;
    const basin=(x,z)=>Math.max(0,1-Math.hypot(x-17,z-30)/8.5),mound=(x,z)=>Math.max(0,1-Math.hypot(x-61,z-11)/4.2);
    const ht=(x,z)=>1.5+.8*Math.sin(x*.16)*Math.cos(z*.13)+.4*Math.sin(z*.31+x*.07)-4.2*Math.min(1,basin(x,z)*1.6)+4.3*Math.min(1,Math.max(0,1-Math.hypot(x-17,z-30)/4.2)*2.6)+6*mound(x,z);
    const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(innerWidth,innerHeight);renderer.outputEncoding=T.sRGBEncoding;document.body.append(renderer.domElement);
    const scene=new T.Scene();scene.background=new T.Color(0x1a1f2b);
    const land=KE.terrain(T,{w:W,h:H,sub:1,chunk:48,height:(i,j)=>ht(i+.5,j+.5),tint:(i,j)=>{const x=i+.5,z=j+.5,y=ht(x,z),m=mound(x,z);return y<water+.5?[.42,.36,.2]:m>.15?[.2,.19,.16]:[.07+.02*Math.sin(i*.7)*Math.cos(j*.5),.2+.03*Math.sin(j*.9),.05];},material:new T.MeshLambertMaterial({vertexColors:true})});
    land.forEach(m=>scene.add(m));const heightAt=land.heightAt;
    scene.add(new T.HemisphereLight(0xdfefff,0x3a3220,.5));const sun=new T.DirectionalLight(0xfff1d6,.55);sun.position.set(-20,40,-10);scene.add(sun);
    const wmesh=new T.Mesh(new T.CircleGeometry(8.6,48),new T.MeshBasicMaterial({color:0x2f6fa8,transparent:true,opacity:.8}));wmesh.rotation.x=-Math.PI/2;wmesh.position.set(17,water,30);scene.add(wmesh);
    const rocks=[[30,12,1.6],[36,31,2.2],[49,17,1.4],[56,34,2],[24,17,1.2],[9,11,1.1]],rockMat=new T.MeshLambertMaterial({color:0x8d8a84});
    for(const [x,z,r] of rocks){const m=new T.Mesh(new T.DodecahedronGeometry(r,0),rockMat);m.scale.set(1,.7,1);m.position.set(x,heightAt(x,z)+r*.3,z);scene.add(m);}
    const walls=[{minX:41,minZ:.5,maxX:42,maxZ:20},{minX:41,minZ:25,maxX:42,maxZ:45.5}],wallMat=new T.MeshLambertMaterial({color:0xc9b79c});
    for(const w of walls){const m=new T.Mesh(new T.BoxGeometry(w.maxX-w.minX,1.6,w.maxZ-w.minZ),wallMat);m.position.set((w.minX+w.maxX)/2,heightAt((w.minX+w.maxX)/2,(w.minZ+w.maxZ)/2)+.6,(w.minZ+w.maxZ)/2);scene.add(m);}
    const nav=KE.NavMesh.build(T,{bounds:{minX:.5,minZ:.5,maxX:72.5,maxZ:45.5},heightAt,cellSize:.5,agentRadius:.4,maxSlope:38,waterLevel:water+.15,obstacles:[...rocks.map(([x,z,r])=>({x,z,r})),...walls]});
    const stats=nav.stats();const overlay=nav.debugMesh(T,{opacity:.4});scene.add(overlay);
    const path=nav.findPath(new T.Vector3(3,0,43),new T.Vector3(70,0,3));const ribbon=nav.debugPath(T,path,{width:.35});scene.add(ribbon);
    const crowd=new KE.Crowd(nav,{maxAgents:64}),rng=KE.random(21);
    for(let i=0;i<36;i++){const L=i%2===0,x=L?4+rng()*14:56+rng()*14,z=6+rng()*36;const p=nav.nearestPoint(new T.Vector3(x,0,z));const a=crowd.addAgent({position:p,radius:.4,maxSpeed:3+rng()});
      a.setTarget(nav.randomPoint(rng,new T.Vector3(L?64:10,0,22),7)||p);}
    for(let s=0;s<150;s++)crowd.update(1/30);
    const view=crowd.debugView(T);scene.add(view.object);
    /* perception with real Object3D occluders (THREE raycaster): the wall hides one target, not the other */
    const wallMeshes=scene.children.filter(o=>o.isMesh&&o.geometry.type==='BoxGeometry');scene.updateMatrixWorld(true);
    const P=new KE.Perception(T,{sight:{range:30,fov:180,height:.9,targetHeight:.7,lineOfSight:wallMeshes}}),g={position:new T.Vector3(36,heightAt(36,22.5),22.5),heading:Math.PI/2};
    const tA={position:new T.Vector3(47,heightAt(47,10),10)},tB={position:new T.Vector3(47,heightAt(47,22.5),22.5)};P.update(.1,g,[tA,tB]);const occl=!P.canSee(tA)&&P.canSee(tB);
    const onMesh=crowd.agents.every(a=>nav.isWalkable(a.position.x,a.position.z,1e-3)),moving=crowd.agents.filter(a=>a.state==='moving').length;
    const cam=new T.OrthographicCamera(-36.5,36.5,23,-23,.1,200);cam.position.set(36.5,80,23);cam.up.set(0,0,-1);cam.lookAt(36.5,0,23);
    renderer.render(scene,cam);
    const fillTris=overlay.children[0].geometry.attributes.position.count/3,edgeSegs=overlay.children[1].geometry.attributes.position.count/2;
    window.__ai={renderer,scene,nav,overlay,ribbon,view,land};
    return {occl,stats,pathPoints:path.length,pathLen:KE.NavMesh.pathLength(path),onMesh,moving,fillTris,edgeSegs,info:renderer.info.render.triangles};
  });
  console.log('   ',JSON.stringify(r));
  const shot=path.join(outDir,'ai-navmesh.png');await page.screenshot({path:shot,timeout:120000});console.log('    screenshot',shot);
  await page.evaluate(()=>{const a=window.__ai,c=new THREE.OrthographicCamera(-14,14,8.75,-8.75,.1,200);c.position.set(40,80,22);c.up.set(0,0,-1);c.lookAt(40,0,22);a.renderer.render(a.scene,c);});
  const shot2=path.join(outDir,'ai-crowd.png');await page.screenshot({path:shot2,timeout:120000});console.log('    screenshot',shot2);
  assert.ok(r.occl,'Object3D occluders block sight');
  assert.ok(r.stats.polys>20&&r.stats.polys*20<r.stats.walkableCells,'polys');assert.ok(r.stats.islands>=2,'pond island is separate');
  assert.ok(r.pathPoints>=3&&r.pathLen>60);assert.ok(r.onMesh);assert.ok(r.moving>10,'crowd mid-crossing');assert.ok(r.fillTris>r.stats.polys&&r.edgeSegs>r.stats.verts);
  console.log('PASS browser: navmesh debug overlay, path ribbon and crowd view render');
  const d=await page.evaluate(()=>{const a=window.__ai;a.overlay.dispose();a.ribbon.dispose();a.view.dispose();a.nav.dispose();const left=a.scene.getObjectByName('ke-navmesh-debug')||a.scene.getObjectByName('ke-crowd-debug')||a.scene.getObjectByName('ke-navmesh-path');a.renderer.render(a.scene,new THREE.PerspectiveCamera());return {left:!!left,geos:a.renderer.info.memory.geometries};});
  assert.ok(!d.left,'debug objects removed on dispose');console.log('PASS browser: debug views dispose');
  }finally{await close();}
})().catch(e=>{console.error(e);process.exit(1);});
