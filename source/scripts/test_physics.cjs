/* Browser tests for src/modules/40-physics.js (KE.Physics3D on Rapier). Run: node source/scripts/test_physics.cjs */
const path=require('path');
const {openPage,ROOT}=require('./harness.cjs');
let passed=0,failed=0;
function check(name,cond,detail=''){if(cond){passed++;console.log('PASS '+name);}else{failed++;console.log('FAIL '+name+(detail?' :: '+detail:''));}}
const near=(a,b,e)=>Math.abs(a-b)<=e;

(async()=>{
const {page,close}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/40-physics.js'],libs:true,atlas:false,viewport:{width:960,height:600},name:'physics'});
try{
/* shared helpers inside the page */
await page.evaluate(()=>{
  const THREE=window.THREE,KE=window.KitsuneEngine;
  window.H={
    world:async(o={})=>KE.Physics3D.create(THREE,o),
    run:(p,seconds,dt=1/60,each)=>{const n=Math.round(seconds/dt);for(let i=0;i<n;i++){if(each)each(i*dt);p.step(dt);}},
    box:(w=1,h=1,d=1,color=0xc08050)=>new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color})),
    ground:(p,size=40,y=0)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(size,1,size),new THREE.MeshStandardMaterial({color:0x6a8a50}));m.position.set(0,y-.5,0);return {mesh:m,body:p.addBox(m,{type:'fixed'})};},
  };
});

/* ---------- 1. availability and graceful failure ---------- */
{const r=await page.evaluate(async()=>{const KE=window.KitsuneEngine,saved=window.RAPIER;window.RAPIER=undefined;const avail=KE.Physics3D.available;let msg='';
  try{await KE.Physics3D.create(window.THREE);}catch(e){msg=e.message;}window.RAPIER=saved;
  return {avail,msg,after:KE.Physics3D.available,module:!!KE.modules.physics3d};});
check('available is false and create rejects clearly without RAPIER',r.avail===false&&/RAPIER is missing/.test(r.msg),JSON.stringify(r));
check('available is true with RAPIER and module registered',r.after===true&&r.module);}

/* ---------- 2. heightfield orientation and resting height ---------- */
{const r=await page.evaluate(async()=>{const p=await H.world();
  const hAt=(x,z)=>.6*Math.sin(x*.35)+.4*Math.cos(z*.5)+x*.04-z*.02+1;
  const hf=p.addHeightfield({heightAt:hAt,minX:-10,minZ:-6,sizeX:20,sizeZ:12,resolutionX:40,resolutionZ:24});
  p.step(1/60);
  let maxErr=0;for(let j=1;j<40;j+=4)for(let i=1;i<24;i+=3){const x=-10+20*j/40,z=-6+12*i/24;const hit=p.raycast([x,50,z],[0,-1,0],100);maxErr=Math.max(maxErr,hit?Math.abs(hit.point.y-hAt(x,z)):99);}
  // mid-cell error is bounded by the triangulation of a smooth function
  let midErr=0;for(const [x,z] of [[1.13,.37],[-4.4,2.2],[6.6,-3.1]]){const hit=p.raycast([x,50,z],[0,-1,0],100);midErr=Math.max(midErr,Math.abs(hit.point.y-hAt(x,z)));}
  const box=H.box(.5,.5,.5);box.position.set(2.2,6,-1.3);const b=p.addBox(box,{friction:.9,restitution:0});
  H.run(p,4);const e=1e-3,nx=hAt(2.2+e,-1.3)-hAt(2.2-e,-1.3),nz=hAt(2.2,-1.3+e)-hAt(2.2,-1.3-e);const slope=Math.atan(Math.hypot(nx,nz)/(2*e));
  const ground=hAt(box.position.x,box.position.z),expected=ground+.25/Math.cos(slope);
  const v=b.getVelocity().length();const out={maxErr,midErr,y:box.position.y,expected,v,shape:b.shape,type:hf.type};p.dispose();return out;});
check('heightfield samples match heightAt at grid vertices (non-square, X/Z not swapped)',r.maxErr<1e-4,'maxErr '+r.maxErr);
check('heightfield mid-cell error small for smooth terrain',r.midErr<.03,'midErr '+r.midErr);
check('box falls and rests on heightfield at the right height',near(r.y,r.expected,.03)&&r.v<.05,JSON.stringify(r));}

/* ---------- 3. stacked tower stability ---------- */
{const r=await page.evaluate(async()=>{const p=await H.world();H.ground(p);const boxes=[];
  for(let i=0;i<6;i++){const m=H.box(.8,.5,.8);m.position.set(0,.25+i*.5+.001*i,0);boxes.push({m,b:p.addBox(m,{friction:.7,restitution:0})});}
  H.run(p,3);let maxDrift=0,maxDy=0;boxes.forEach(({m},i)=>{maxDrift=Math.max(maxDrift,Math.hypot(m.position.x,m.position.z));maxDy=Math.max(maxDy,Math.abs(m.position.y-(.25+i*.5)));});
  const up=new window.THREE.Vector3(0,1,0).applyQuaternion(boxes[5].m.quaternion).y;const s=p.stats();p.dispose();return {maxDrift,maxDy,up,sleeping:s.sleeping,bodies:s.bodies};});
check('tower of 6 boxes stays standing for 3 s',r.maxDrift<.05&&r.maxDy<.03&&r.up>.999,JSON.stringify(r));}

/* ---------- 4. raycast accuracy, raycastAll, shape casts, overlaps ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,p=await H.world();
  const m=H.box(2,2,2);m.position.set(5,1,0);m.rotation.y=Math.PI/6;const wall=p.addBox(m,{type:'fixed'});
  const s2=H.box(1,1,1);s2.position.set(9,1,0);const far=p.addBox(s2,{type:'fixed'});
  const sensorM=H.box(1,1,1);sensorM.position.set(2,1,0);p.addBox(sensorM,{type:'fixed',sensor:true});
  p.step(1/60);
  // analytic hit of the ray y=1,z=0 from x=0 along +x against the rotated square: face normal (-cos30, 0, sin30)
  const n=new THREE.Vector3(-Math.cos(Math.PI/6),0,Math.sin(Math.PI/6));const faceDist=1;const center=new THREE.Vector3(5,1,0);
  // plane: n·(x - (center + n*1)) = 0 -> along +x: t = (n·(center+n) - n·origin)/(n·dir)
  const origin=new THREE.Vector3(0,1,0),dir=new THREE.Vector3(1,0,0),t=n.dot(center.clone().addScaledVector(n,faceDist).sub(origin))/n.dot(dir);
  const hit=p.raycast(origin,dir,100);const hitNoSensor=hit;const hitSensor=p.raycast(origin,dir,100,{solidOnly:false});
  const excl=p.raycast(origin,dir,100,{exclude:wall});const all=p.raycastAll(origin,dir,100);
  const sc=p.sphereCast([0,1,0],.5,[1,0,0],100);const ov=p.overlapSphere([5,1,0],.3);const ov2=p.overlapSphere([20,1,0],.3);
  const out={dist:hit.distance,t,nDot:hit.normal.dot(n),body:hit.body===wall,sensorHit:hitSensor&&hitSensor.distance,excl:excl&&excl.body===far,exclDist:excl&&excl.distance,
    all:all.length,allSorted:all.every((h,i)=>!i||all[i-1].distance<=h.distance),sc:sc&&sc.distance,scBody:sc&&sc.body===wall,scNormal:sc&&sc.normal.dot(n),ov:ov.length===1&&ov[0]===wall,ov2:ov2.length,miss:p.raycast([0,10,0],[0,1,0],50)};
  p.dispose();return out;});
check('raycast distance matches analytic hit on rotated box',near(r.dist,r.t,1e-3),JSON.stringify(r));
check('raycast normal matches rotated face normal',r.nDot>.9999&&r.body,String(r.nDot));
check('raycast skips sensors by default, hits them with solidOnly:false',near(r.sensorHit,1.5,1e-3));
check('raycast exclude and raycastAll ordering',r.excl&&near(r.exclDist,8.5,1e-3)&&r.all===2&&r.allSorted,JSON.stringify(r));
check('sphereCast and overlapSphere',r.scBody&&near(r.sc,r.t-.5/Math.cos(Math.PI/6),.01)&&r.scNormal>.999&&r.ov&&r.ov2===0&&r.miss===null,JSON.stringify(r));}

/* ---------- 5. sensor trigger enter/exit and contact events ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,p=await H.world();H.ground(p);
  const zone=H.box(3,1,3);zone.position.set(0,3,0);const sensor=p.addBox(zone,{type:'fixed',sensor:true});
  const ball=new THREE.Mesh(new THREE.SphereGeometry(.3,16,12),new THREE.MeshStandardMaterial());ball.position.set(0,6,0);const b=p.addSphere(ball,{restitution:0});
  const trig=[],cb=[],contacts=[];
  const off=p.on('trigger',(s,o,entered)=>trig.push({s:s===sensor,o:o===b,entered,t:p.time}));sensor.onTrigger=(o,e)=>cb.push(e);
  p.on('contact',(a,c,info)=>{if(info.started)contacts.push({pair:(a===b||c===b),impulse:info.impulse,py:info.point&&info.point.y,ny:info.normal&&Math.abs(info.normal.y)});});
  H.run(p,3);off();const s=p.stats();p.dispose();return {trig,cb,contacts,contactsActive:s.contacts};});
check('sensor trigger fires enter then exit',r.trig.length===2&&r.trig[0].entered===true&&r.trig[1].entered===false&&r.trig.every(e=>e.s&&e.o)&&r.cb.join()==='true,false',JSON.stringify(r.trig));
check('contact event fires with impulse, point and normal',r.contacts.length>=1&&r.contacts[0].pair&&r.contacts[0].impulse>0&&near(r.contacts[0].py,0,.05)&&r.contacts[0].ny>.95,JSON.stringify(r.contacts.slice(0,2)));}

/* ---------- 6. hinge joint ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,p=await H.world();
  const door=H.box(1,2,.1);door.position.set(.5,2,0);const d=p.addBox(door,{angularDamping:.05});
  const hinge=p.joint(d,null,{type:'hinge',anchor:[0,2,0],axis:[0,1,0]});
  d.applyImpulse([0,0,.05],[1,2,0]);let maxAnchorErr=0,minY=9;const edge=new THREE.Vector3();
  H.run(p,2,1/60,()=>{edge.set(-.5,0,0).applyQuaternion(door.quaternion).add(door.position);maxAnchorErr=Math.max(maxAnchorErr,edge.distanceTo(new THREE.Vector3(0,2,0)));minY=Math.min(minY,door.position.y);});
  const ang=hinge.angle();const axisTilt=new THREE.Vector3(0,1,0).applyQuaternion(door.quaternion).y;
  // limits and motor
  const door2=H.box(1,2,.1);door2.position.set(10.5,2,0);const d2=p.addBox(door2);const h2=p.joint(d2,null,{type:'hinge',anchor:[10,2,0],axis:[0,1,0],limits:[-.4,.4]});
  d2.applyImpulse([0,0,.5],[11,2,0]);let maxLim=0;H.run(p,1.5,1/60,()=>{maxLim=Math.max(maxLim,Math.abs(h2.angle()));});
  const door3=H.box(1,2,.1);door3.position.set(20.5,2,0);const d3=p.addBox(door3);const h3=p.joint(d3,null,{type:'hinge',anchor:[20,2,0],axis:[0,1,0],motor:{targetVelocity:2,maxForce:50}});
  H.run(p,.5);const motorAng=h3.angle();
  // ball + rope + fixed joints keep their constraints
  const a=H.box(.4,.4,.4);a.position.set(0,5,5);const ba=p.addBox(a,{type:'fixed'});const c=H.box(.4,.4,.4);c.position.set(1.5,5,5);const bc=p.addBox(c);
  const rope=p.joint(ba,bc,{type:'rope'});H.run(p,2);const ropeLen=a.position.distanceTo(c.position);
  const out={maxAnchorErr,minY,ang,axisTilt,maxLim,motorAng,ropeLen,joints:p.stats().joints};hinge.dispose();out.afterDispose=p.stats().joints;p.dispose();return out;});
check('hinge joint keeps its anchor and axis while swinging',r.maxAnchorErr<.03&&r.minY>1.95&&r.axisTilt>.999&&Math.abs(r.ang)>.5,JSON.stringify(r));
check('hinge limits and motor',r.maxLim<.47&&r.motorAng>.6,JSON.stringify(r));
check('rope joint bounds distance; joint dispose removes it',r.ropeLen<1.53&&r.joints===4&&r.afterDispose===3,JSON.stringify(r));}

/* ---------- 7. character controller ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,p=await H.world();H.ground(p,80);
  // gentle 15 degree ramp rising along +x starting at x=0
  const ang=15*Math.PI/180,L=8,th=.2,ramp=H.box(L,th,4);ramp.rotation.z=ang;
  ramp.position.set(Math.cos(ang)*L/2+Math.sin(ang)*th/2,Math.sin(ang)*L/2-Math.cos(ang)*th/2,0);p.addBox(ramp,{type:'fixed'});
  const rampH=x=>Math.tan(ang)*x;
  const hero=new THREE.Group();hero.position.set(-2,0,0);const ch=p.character(hero,{radius:.35,height:1.6});
  const v=new THREE.Vector3(2.5,0,0);let t=0;while(ch.position.x<3.5&&t<6){ch.move(v,1/60);p.step(1/60);t+=1/60;}
  const slope={x:ch.position.x,y:ch.position.y,expected:rampH(ch.position.x),grounded:ch.grounded,objY:hero.position.y};
  // steep 60 degree ramp: cannot climb
  const steep=H.box(6,.2,4);const a2=60*Math.PI/180;steep.rotation.z=a2;steep.position.set(Math.cos(a2)*3,Math.sin(a2)*3-.1,-12);p.addBox(steep,{type:'fixed'});
  const hero3=new THREE.Group();hero3.position.set(-2,0,-12);const ch3=p.character(hero3,{maxSlope:45*Math.PI/180});for(let i=0;i<180;i++){ch3.move(v,1/60);p.step(1/60);}
  // wall
  const wall=H.box(.4,3,4);wall.position.set(3.2,1.5,12);p.addBox(wall,{type:'fixed'});
  const hero2=new THREE.Group();hero2.position.set(0,0,12);const ch2=p.character(hero2);for(let i=0;i<150;i++){ch2.move(v,1/60);p.step(1/60);}
  const wallX=ch2.position.x,wallHit=ch2.collisions.length;
  // push a dynamic crate
  const crate=H.box(.8,.8,.8);crate.position.set(2,.4,24);const cb=p.addBox(crate,{density:.3,friction:.3});
  const hero4=new THREE.Group();hero4.position.set(0,0,24);const ch4=p.character(hero4);H.run(p,.3);
  for(let i=0;i<150;i++){ch4.move(v,1/60);p.step(1/60);}const pushed=crate.position.x-2;
  // jump
  const hero5=new THREE.Group();hero5.position.set(-10,0,-24);const ch5=p.character(hero5);for(let i=0;i<10;i++){ch5.move(new THREE.Vector3(),1/60);p.step(1/60);}
  const wasGrounded=ch5.grounded,jumped=ch5.jump(5);let peak=0;for(let i=0;i<120;i++){ch5.move(new THREE.Vector3(),1/60);p.step(1/60);peak=Math.max(peak,ch5.position.y);}
  const out={slope,steepY:ch3.position.y,steepX:ch3.position.x,wallX,wallHit,pushed,wasGrounded,jumped,peak,landed:ch5.grounded&&ch5.position.y<.05};
  ch.dispose();out.bodiesAfterDispose=p.stats().characters;p.dispose();return out;});
check('character walks up a gentle 15deg slope',r.slope.x>3&&near(r.slope.y,r.slope.expected,.1)&&r.slope.grounded&&near(r.slope.objY,r.slope.y,.1),JSON.stringify(r.slope));
check('character cannot climb a 60deg slope',r.steepY<.6,JSON.stringify({y:r.steepY,x:r.steepX}));
check('character is blocked by a wall',r.wallX<3-.35+.05&&r.wallX>2.3&&r.wallHit>0,JSON.stringify({x:r.wallX,hits:r.wallHit}));
check('character pushes a dynamic crate',r.pushed>.5,String(r.pushed));
check('character jumps and lands',r.wasGrounded&&r.jumped&&r.peak>1&&r.peak<1.6&&r.landed,JSON.stringify(r));
check('character dispose unregisters it',r.bodiesAfterDispose===4);}

/* ---------- 8. fracture ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,KE=window.KitsuneEngine,p=await H.world();const scene=new THREE.Scene();H.ground(p,40,-5);
  const m=H.box(1,1,1);m.scale.set(1.2,.8,1);m.position.set(0,3,0);m.rotation.set(.3,.5,.1);scene.add(m);const b=p.addBox(m);b.setVelocity([1,0,0]);
  p.step(1/60);const orig=1.2*.8*1;
  const pieces=p.fracture(b,{pieces:8,seed:7,point:m.position.clone().add(new THREE.Vector3(.5,0,0)),impulse:new THREE.Vector3(-2,0,0),scatter:0});
  const vol=pieces.reduce((s,q)=>s+q.volume,0),colVol=pieces.reduce((s,q)=>s+q.collider.volume(),0);
  const inScene=pieces.every(q=>q.object.parent===scene),removed=b.removed&&!m.parent;const y0=pieces.map(q=>q.object.position.y);
  const vx=pieces.reduce((s,q)=>s+q.getVelocity().x*q.mass,0);
  H.run(p,1);const fell=pieces.every((q,i)=>q.object.position.y<y0[i]-1);
  // sphere source keeps its volume; non-convex source falls back to its hull
  const sg=new THREE.SphereGeometry(.6,24,16),sm=new THREE.Mesh(sg,new THREE.MeshStandardMaterial());sm.position.set(5,2,0);scene.add(sm);const sb=p.addFromObject(sm);
  let sv=0;{const r2=KE.Physics3D.fractureGeometry(THREE,sg,{pieces:12,seed:2});sv=r2.pieces.reduce((s,q)=>s+q.volume,0);r2.pieces.forEach(q=>q.geometry.dispose());}
  let meshV=0;{const a=sg.attributes.position,ix=sg.index;for(let i=0;i<ix.count;i+=3){const A=new THREE.Vector3().fromBufferAttribute(a,ix.getX(i)),B=new THREE.Vector3().fromBufferAttribute(a,ix.getX(i+1)),C=new THREE.Vector3().fromBufferAttribute(a,ix.getX(i+2));meshV+=A.dot(B.cross(C))/6;}}
  const tk=KE.Physics3D.fractureGeometry(THREE,new THREE.TorusKnotGeometry(.5,.15,64,8),{pieces:6,seed:4});
  const interior=new THREE.MeshStandardMaterial({color:0xff0000});const sp=p.fracture(sb,{pieces:10,seed:5,interiorMaterial:interior});
  const matOK=sp.every(q=>Array.isArray(q.object.material)&&q.object.material[1]===interior&&q.object.geometry.groups.length>=1);
  const out={n:pieces.length,vol,colVol,orig,inScene,removed,fell,vx,sphereShape:sb.shape,sv,meshV,tkConvex:tk.convex,tkN:tk.pieces.length,sn:sp.length,matOK,debris:p.stats().debris};
  p.remove(pieces[0]);out.debrisAfter=p.stats().debris;out.geomDisposed=!pieces[0].object.parent;p.dispose();out.afterDispose=scene.children.filter(c=>c.name.endsWith('-piece')).length;return out;});
check('fracture produces the requested number of pieces',r.n===8,String(r.n));
check('fracture pieces conserve volume (within 15%)',Math.abs(r.vol/r.orig-1)<.15&&Math.abs(r.colVol/r.orig-1)<.15,JSON.stringify({vol:r.vol,colVol:r.colVol,orig:r.orig}));
check('fracture replaces the original, pieces are in the scene and fall',r.inScene&&r.removed&&r.fell,JSON.stringify(r));
check('fracture pieces inherit momentum (initial +x velocity minus impulse)',near(r.vx,.96*1-2,.25),String(r.vx));
check('sphere fracture keeps mesh volume; non-convex source uses its hull',Math.abs(r.sv/r.meshV-1)<.02&&r.tkConvex===false&&r.tkN===6&&r.sphereShape==='sphere',JSON.stringify(r));
check('interior material applied to cut faces; debris tracked and disposed',r.sn===10&&r.matOK&&r.debris===18&&r.debrisAfter===17&&r.geomDisposed&&r.afterDispose===0,JSON.stringify(r));}

/* ---------- 9. explosion ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,p=await H.world();H.ground(p);const list=[];
  for(let i=0;i<8;i++){const a=i/8*Math.PI*2,m=H.box(.5,.5,.5);m.position.set(Math.cos(a)*2,.25,Math.sin(a)*2);list.push(p.addBox(m));}
  const far=H.box(.5,.5,.5);far.position.set(12,.25,0);const fb=p.addBox(far);H.run(p,2);const slept=list.every(b=>b.isSleeping());
  const n=p.explode(new THREE.Vector3(0,0,0),5,6,{upward:.3});p.step(1/60);
  const rad=list.map(b=>{const v=b.getVelocity(),d=b.getPosition().setY(0).normalize();return {out:v.x*d.x+v.z*d.z,up:v.y};});
  const out={n,slept,minOut:Math.min(...rad.map(x=>x.out)),minUp:Math.min(...rad.map(x=>x.up)),farV:fb.getVelocity().length(),awake:list.every(b=>!b.isSleeping())};p.dispose();return out;});
check('explode imparts outward (and upward) velocity to bodies in range and wakes them',r.n===8&&r.minOut>1&&r.minUp>0&&r.farV<1e-3&&r.awake,JSON.stringify(r));}

/* ---------- 10. buoyancy ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,p=await H.world();
  const a=H.box(1,.6,1);a.position.set(0,2,0);a.rotation.set(.2,.3,.1);const ba=p.addBox(a,{density:.5});const fa=p.addBuoyancy(ba,{waterLevel:0,density:1});
  const c=H.box(1,.5,1);c.position.set(3,.3,0);const bc=p.addBox(c,{density:.25});p.addBuoyancy(bc,{waterLevel:0});
  const w=H.box(1,.6,1);w.position.set(-3,0,0);const bw=p.addBox(w,{density:.5});let tt=0;p.addBuoyancy(bw,{waterLevel:(x,z,t)=>.3*Math.sin(t*2)});
  H.run(p,8);const up=new THREE.Vector3(0,1,0).applyQuaternion(a.quaternion);let minW=9,maxW=-9;H.run(p,3.2,1/60,()=>{minW=Math.min(minW,w.position.y);maxW=Math.max(maxW,w.position.y);});
  const out={ya:a.position.y,yc:c.position.y,va:ba.getVelocity().length(),submerged:fa.submerged,upright:Math.abs(up.y),waveRange:maxW-minW};p.dispose();return out;});
check('buoyancy floats a half-density box with its center at the water line, upright',near(r.ya,0,.03)&&r.va<.05&&near(r.submerged,.5,.05)&&r.upright>.99,JSON.stringify(r));
check('buoyancy: quarter-density box rides higher; wave function bobs the body',near(r.yc,.125,.03)&&r.waveRange>.3,JSON.stringify(r));}

/* ---------- 11. transform sync: parents, scale fitting, interpolation, auto shapes ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,p=await H.world({gravity:[0,-9.81,0]});H.ground(p,40,-20);
  const parent=new THREE.Group();parent.position.set(3,1,-2);parent.rotation.y=.7;parent.scale.setScalar(2);const scene=new THREE.Scene();scene.add(parent);
  const m=H.box(1,1,1);m.position.set(.5,2,0);parent.add(m);scene.updateMatrixWorld(true);const b=p.addBox(m);
  const he=b.collider.halfExtents();H.run(p,.5);scene.updateMatrixWorld(true);const wp=new THREE.Vector3();m.getWorldPosition(wp);const errP=wp.distanceTo(b._prevP.clone().lerp(b._curP,p.alpha));
  // interpolation: half a step leaves the object between previous and current simulated poses
  const q=H.box(.5,.5,.5);q.position.set(10,10,10);const qb=p.addBox(q,{linearDamping:0});p.step(1/60);p.step(1/60);const prev=qb._prevP.y,cur=qb._curP.y;p.step(.5/60);const mid=q.position.y;
  const sm=new THREE.Mesh(new THREE.IcosahedronGeometry(.4,2),new THREE.MeshStandardMaterial());sm.scale.setScalar(1.5);sm.position.set(-5,5,0);const sb=p.addFromObject(sm);
  const g=new THREE.Group();const g1=H.box(1,.2,1);g1.position.y=-.4;const g2=new THREE.Mesh(new THREE.SphereGeometry(.3,12,8),new THREE.MeshStandardMaterial());g2.position.y=.3;g.add(g1,g2);g.position.set(-8,5,0);
  const gb=p.addFromObject(g);const cap=new THREE.Mesh(new THREE.CylinderGeometry(.3,.3,2,12),new THREE.MeshStandardMaterial());cap.rotation.z=Math.PI/2;cap.position.set(-12,5,0);const cb=p.addCapsule(cap);
  const convex=p.addConvex(new THREE.Mesh(new THREE.ConeGeometry(.5,1,8),new THREE.MeshStandardMaterial()));
  const out={he:[he.x,he.y,he.z],errP,prev,cur,mid,sphere:sb.shape,sr:sb.collider.radius(),gShape:gb.shape,gColliders:gb.colliders.length,gKinds:gb.colliders.map(c=>c.shapeType()),capR:cb.collider.radius(),capH:cb.collider.halfHeight(),convexType:convex.collider.shapeType(),
    bodyOf:p.bodyOf(m)===b};p.dispose();return out;});
check('scaled parent: collider fitted with world scale (2x)',near(r.he[0],1,1e-4)&&near(r.he[1],1,1e-4)&&near(r.he[2],1,1e-4),JSON.stringify(r.he));
check('object under a transformed parent follows its body in world space',r.errP<1e-4&&r.bodyOf,String(r.errP));
check('render interpolation places object between the last two steps',r.mid<r.prev&&r.mid>r.cur&&near(r.mid,(r.prev+r.cur)/2,1e-3),JSON.stringify(r));
check('auto shape: round mesh -> sphere, group -> compound, capsule axis fit',r.sphere==='sphere'&&near(r.sr,.6,.02)&&r.gShape==='compound'&&r.gColliders===2&&near(r.capR,.3,.01)&&near(r.capH,.7,.01),JSON.stringify(r));}

/* ---------- 12. KE.terrain integration ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,KE=window.KitsuneEngine,p=await H.world();
  const land=KE.terrain(THREE,{w:24,h:20,sub:2,height:(i,j)=>Math.sin(i*.4)*1.2+Math.cos(j*.3)*.8,material:new THREE.MeshStandardMaterial()});
  const t=p.addTerrain(land);p.step(1/60);let maxErr=0;for(let i=0;i<20;i++){const x=1+Math.floor(i*1.13*2)/2,z=1+Math.floor(i*.93*2)/2;const h=p.raycast([x,40,z],[0,-1,0],100);maxErr=Math.max(maxErr,Math.abs(h.point.y-land.heightAt(x,z)));}
  let midErr=0;for(const [x,z] of [[5.3,7.1],[12.2,3.3],[17.9,15.6]]){const h=p.raycast([x,40,z],[0,-1,0],100);midErr=Math.max(midErr,Math.abs(h.point.y-land.heightAt(x,z)));}
  const ex=p.addTerrain(land,{exact:true});p.step(1/60);let exErr=0;for(const [x,z] of [[5.3,7.1],[12.2,3.3],[17.9,15.6]]){const h=p.raycast([x,40,z],[0,-1,0],100,{exclude:t});exErr=Math.max(exErr,Math.abs(h.point.y-land.heightAt(x,z)));}
  const out={maxErr,midErr,exErr,res:t.resolution};p.dispose();land.dispose();return out;});
check('addTerrain heightfield matches KE.terrain vertices; exact mode matches triangles',r.maxErr<1e-4&&r.midErr<.1&&r.exErr<1e-3&&r.res.x===46&&r.res.z===38,JSON.stringify(r));}

/* ---------- 13. vehicle ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,p=await H.world();H.ground(p,200);
  const car=H.box(1.6,.5,3);car.position.set(0,1,0);const chassis=p.addBox(car,{density:100});
  const wheels=[[-.8,0,1],[.8,0,1],[-.8,0,-1],[.8,0,-1]].map((pos,i)=>({position:pos,radius:.35,suspensionRestLength:.3,steering:i<2,object:new THREE.Mesh(new THREE.CylinderGeometry(.35,.35,.2,12),new THREE.MeshStandardMaterial())}));
  const v=p.vehicle(chassis,{wheels});H.run(p,1);const z0=car.position.z,rest=car.position.y;v.setEngineForce(400);H.run(p,2);
  const up=new THREE.Vector3(0,1,0).applyQuaternion(car.quaternion).y;const out={z0,rest,dz:car.position.z-z0,speed:v.speed,up,contact:v.wheelInContact(0),wheelY:wheels[0].object.position.y};p.dispose();return out;});
check('raycast vehicle rests on its wheels and drives forward (+Z)',r.contact&&r.rest>.3&&r.rest<1.2&&r.dz>1&&r.up>.95,JSON.stringify(r));}

/* ---------- 14. stats, pause, debug renderer and dispose ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,p=await H.world();const scene=new THREE.Scene();H.ground(p);const bs=[];
  for(let i=0;i<5;i++){const m=H.box(.5,.5,.5);m.position.set(i,3,0);scene.add(m);bs.push(p.addBox(m));}
  p.debug(scene,true);H.run(p,.5);const lines=scene.getObjectByName('physics-debug');const vc=lines?lines.geometry.drawRange.count:0;
  const s=p.stats();p.pause(true);const y=bs[0].getPosition().y;p.step(1/60);const pausedY=bs[0].getPosition().y;p.pause(false);
  p.timeScale=0;const n0=p.step(1/60);p.timeScale=1;
  const handles=[...p.bodies.values()];p.dispose();let threw=false;try{p.step(1/60);}catch(e){threw=/disposed/.test(e.message);}
  return {vc,s,pausedSame:y===pausedY,n0,hasLines:!!lines,linesGone:!scene.getObjectByName('physics-debug'),worldNull:p.world===null&&p.eventQueue===null,handlesFreed:handles.every(b=>b.rigidBody===null&&b.removed),threw,objectsKept:scene.children.length===5};});
check('stats report bodies/colliders/awake/stepMs',r.s.bodies===6&&r.s.colliders===6&&r.s.dynamic===5&&r.s.awake>=5&&r.s.stepMs>0,JSON.stringify(r.s));
check('debug renderer draws collider wireframes',r.hasLines&&r.vc>100,String(r.vc));
check('pause and timeScale stop the simulation',r.pausedSame&&r.n0===0);
check('dispose frees world, event queue, handles and debug lines',r.linesGone&&r.worldNull&&r.handlesFreed&&r.threw&&r.objectsKept,JSON.stringify(r));}

/* ---------- 15. screenshot: lit scene mid-simulation with a tower, fracture debris and debug wireframes ---------- */
{const r=await page.evaluate(async()=>{const THREE=window.THREE,KE=window.KitsuneEngine,p=await H.world();
  const lin=hex=>new THREE.Color(hex).convertSRGBToLinear();
  const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setSize(960,600);renderer.outputEncoding=THREE.sRGBEncoding;renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;document.body.appendChild(renderer.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color(0xa9c9e6);scene.fog=new THREE.Fog(lin(0xa9c9e6),24,60);
  const cam=new THREE.PerspectiveCamera(46,960/600,.1,200);cam.position.set(6.2,4.1,8.6);cam.lookAt(-.2,1.3,-.4);
  scene.add(new THREE.HemisphereLight(lin(0xcfe3ff),lin(0x4a3a2a),.55));const sun=new THREE.DirectionalLight(lin(0xfff0d8),2.2);sun.position.set(-6,12,7);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.bias=-.0005;
  Object.assign(sun.shadow.camera,{left:-10,right:10,top:10,bottom:-10,near:1,far:40});scene.add(sun);
  const land=KE.terrain(THREE,{w:41,h:41,sub:1,height:(i,j)=>{const x=i-20,z=j-20,r=Math.hypot(x,z);return r<8?0:Math.min(3,(r-8)*.3)*(.75+.25*Math.sin(i*.7+j*.3));},
    tint:(i,j)=>{const n=.85+.15*Math.sin(i*1.7+j*.9)*Math.cos(j*1.3-i*.4);return [n,n,n];},material:new THREE.MeshStandardMaterial({color:lin(0x6f8f4e),roughness:.95,vertexColors:true})});
  for(const m of land){m.position.set(-20.5,0,-20.5);m.receiveShadow=true;scene.add(m);}scene.updateMatrixWorld(true);p.addTerrain(land);
  const palette=[0xb5652e,0xd08a4a,0x9c4f27,0xc97a3c].map(lin);const mk=(w,h,d,c)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color:c,roughness:.75}));m.castShadow=m.receiveShadow=true;scene.add(m);return m;};
  // tower of six crates
  for(let i=0;i<6;i++){const m=mk(.8,.5,.8,palette[i%4]);m.position.set(-4,.25+i*.5,-1.2);m.rotation.y=i*.12;p.addBox(m,{friction:.8,restitution:0});}
  // brick wall, one course knocked by a ball
  const bricks=[];for(let y=0;y<5;y++)for(let x=0;x<5;x++){const m=mk(.9,.4,.45,palette[(x*3+y)%4]);m.position.set(.2+x*.92+(y%2)*.46,.2+y*.405,-2.2);bricks.push(p.addBox(m,{friction:.7}));}
  const ball=new THREE.Mesh(new THREE.SphereGeometry(.32,32,20),new THREE.MeshStandardMaterial({color:lin(0x3b5f9e),roughness:.25,metalness:.3}));ball.castShadow=true;ball.position.set(3.6,.9,1.5);scene.add(ball);const bb=p.addSphere(ball,{density:6});
  H.run(p,1.2);bb.setVelocity([0,1.5,-11]);
  // a stone block fractured mid-air by an impact
  const big=mk(1.3,1.3,1.3,lin(0x8a8f96));big.material.roughness=.9;big.position.set(1.9,3.1,2.4);big.rotation.set(.35,.5,.1);const bigB=p.addBox(big,{density:2.5});H.run(p,.15);
  const interior=new THREE.MeshStandardMaterial({color:lin(0xd9cdb8),roughness:1});
  const pieces=p.fracture(bigB,{pieces:16,seed:11,point:big.position.clone().add(new THREE.Vector3(-.5,-.4,-.3)),impulse:new THREE.Vector3(-4,8,1),interiorMaterial:interior});
  pieces.forEach(q=>{q.object.castShadow=q.object.receiveShadow=true;});
  H.run(p,.3);p.step(1/60-1e-6);
  p.debug(scene,true,{fixed:false});
  renderer.render(scene,cam);
  const s=p.stats();return {pieces:pieces.length,bodies:s.bodies,lines:scene.getObjectByName('physics-debug').geometry.drawRange.count};});
await page.screenshot({path:path.join(ROOT,'.test-output/physics.png')});
check('screenshot scene built (tower, bricks, fracture, debug lines)',r.pieces===16&&r.lines>0,JSON.stringify(r));}

}catch(e){console.log('FAIL exception '+(e.stack||e.message));failed++;}
await close().catch(e=>{console.log('FAIL browser errors: '+e.message);failed++;});
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed?1:0);
})();
