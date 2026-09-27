/* kitsune enginev3 · KE.Physics3D — rigid-body physics on the vendored Rapier 3D (compat 0.19.3).
   A Three.js-facing layer over Rapier: collider fitting from meshes (scale-aware, compound groups),
   fixed-step simulation with render interpolation and world->local transform sync, scene queries,
   a kinematic character controller, joints, Voronoi fracture, radial explosions, buoyancy, a raycast
   vehicle, contact/trigger events and a collider debug renderer. Requires assets/kitsune-libs.js. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');

/* ---------- Rapier bootstrap ---------- */
let rapierReady=null;
function loadRapier(){
  const R=typeof window!=='undefined'?window.RAPIER:undefined;
  if(!R||typeof R.init!=='function')return Promise.reject(new Error('KE.Physics3D: window.RAPIER is missing. Load assets/kitsune-libs.js (Rapier 3D compat 0.19) before creating a physics world.'));
  if(!rapierReady)rapierReady=Promise.resolve().then(()=>R.init()).then(()=>R,e=>{rapierReady=null;throw e;});
  return rapierReady;
}

/* ---------- small helpers ---------- */
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const DEG=Math.PI/180;
function readVec(v,out){
  if(v==null)return out;
  if(Array.isArray(v)||ArrayBuffer.isView(v))return out.set(+v[0]||0,+v[1]||0,+v[2]||0);
  if(typeof v==='number')return out.set(v,v,v);
  return out.set(+v.x||0,+v.y||0,+v.z||0);
}
function readQuat(q,out,THREE){
  if(q==null)return out.set(0,0,0,1);
  if(q.isEuler)return out.setFromEuler(q);
  if(Array.isArray(q))return q.length>=4?out.set(q[0],q[1],q[2],q[3]).normalize():out.setFromEuler(new THREE.Euler(q[0]||0,q[1]||0,q[2]||0));
  return out.set(q.x||0,q.y||0,q.z||0,q.w===undefined?1:q.w).normalize();
}
const setXYZ=(o,v)=>{o.x=v.x;o.y=v.y;o.z=v.z;return o;};
function groupMask(v){if(Array.isArray(v)){let m=0;for(const i of v)m|=1<<(i&15);return m&0xffff;}return (v==null?0xffff:v)&0xffff;}
/* Rapier interaction groups: upper 16 bits = memberships, lower 16 bits = filter. */
function interactionGroups(g){if(g==null)return 0xffffffff;if(typeof g==='number')return g>>>0;return ((groupMask(g.membership)<<16)|groupMask(g.filter))>>>0;}
const TYPES=['dynamic','fixed','kinematic','kinematicVelocity'];
function isIdentity(m){const e=m.elements;return e[0]===1&&e[5]===1&&e[10]===1&&e[15]===1&&e[1]===0&&e[2]===0&&e[3]===0&&e[4]===0&&e[6]===0&&e[7]===0&&e[8]===0&&e[9]===0&&e[11]===0&&e[12]===0&&e[13]===0&&e[14]===0;}
function collectMeshes(root){const out=[];if(!root)return out;root.traverse(o=>{if(o.isMesh&&o.geometry&&o.geometry.attributes&&o.geometry.attributes.position&&!(o.userData&&o.userData.physicsIgnore))out.push(o);});return out;}

/* ---------- geometry: triangles, convex hull, volume ---------- */
/* Reads a BufferGeometry into a triangle soup (positions scaled, normals inverse-scaled, uvs, per-triangle material index). */
function readTriangles(geometry,sx,sy,sz){
  const pos=geometry.attributes.position,nor=geometry.attributes.normal,uv=geometry.attributes.uv,index=geometry.index;
  const count=index?index.count:pos.count,tris=Math.floor(count/3),flip=sx*sy*sz<0;
  const P=new Float64Array(tris*9),N=new Float64Array(tris*9),U=new Float64Array(tris*6),M=new Uint16Array(tris);
  const groups=geometry.groups||[];
  for(let t=0;t<tris;t++){
    for(let k=0;k<3;k++){const kk=flip&&k>0?3-k:k,vi=index?index.getX(t*3+kk):t*3+kk,o=t*9+k*3;
      P[o]=pos.getX(vi)*sx;P[o+1]=pos.getY(vi)*sy;P[o+2]=pos.getZ(vi)*sz;
      if(nor){let nx=nor.getX(vi)/sx,ny=nor.getY(vi)/sy,nz=nor.getZ(vi)/sz;const l=Math.hypot(nx,ny,nz)||1;N[o]=nx/l;N[o+1]=ny/l;N[o+2]=nz/l;}
      if(uv){U[t*6+k*2]=uv.getX(vi);U[t*6+k*2+1]=uv.getY(vi);}}
    if(!nor){const o=t*9,ax=P[o+3]-P[o],ay=P[o+4]-P[o+1],az=P[o+5]-P[o+2],bx=P[o+6]-P[o],by=P[o+7]-P[o+1],bz=P[o+8]-P[o+2];
      let nx=ay*bz-az*by,ny=az*bx-ax*bz,nz=ax*by-ay*bx;const l=Math.hypot(nx,ny,nz)||1;nx/=l;ny/=l;nz/=l;for(let k=0;k<3;k++){N[o+k*3]=nx;N[o+k*3+1]=ny;N[o+k*3+2]=nz;}}
    if(groups.length){const s=t*3;for(const g of groups)if(s>=g.start&&s<g.start+g.count){M[t]=g.materialIndex||0;break;}}
  }
  return {P,N,U,M,count:tris,hasUV:!!uv};
}
function soupVolume(P,count){let v=0;for(let t=0;t<count;t++){const o=t*9;v+=(P[o]*(P[o+4]*P[o+8]-P[o+5]*P[o+7])-P[o+1]*(P[o+3]*P[o+8]-P[o+5]*P[o+6])+P[o+2]*(P[o+3]*P[o+7]-P[o+4]*P[o+6]))/6;}return v;}
/* Convex hull via THREE.ConvexHull (three-addons). Returns planes (n·p - c <= 0 inside), triangle faces and volume, or null. */
function convexHull(THREE,points){
  if(!THREE.ConvexHull||points.length<4)return null;
  let hull;try{hull=new THREE.ConvexHull().setFromPoints(points);}catch(e){return null;}
  const planes=[],faces=[];let volume=0;
  for(const f of hull.faces){const vs=[];let e=f.edge;do{vs.push(e.head().point);e=e.next;}while(e&&e!==f.edge&&vs.length<64);
    if(vs.length<3)continue;planes.push({n:f.normal.clone(),c:f.constant});faces.push({verts:vs,normal:f.normal.clone()});
    for(let i=1;i<vs.length-1;i++)volume+=vs[0].dot(new THREE.Vector3().crossVectors(vs[i],vs[i+1]))/6;}
  if(!planes.length||!(volume>0))return null;
  return {planes,faces,volume};
}

/* ---------- Voronoi fracture of a (convex) triangle mesh ---------- */
/* Each piece is the intersection of the source solid with one Voronoi cell: the source polygons are clipped
   by the bisector planes between its seed and every other seed (Sutherland-Hodgman per polygon), and every
   cut is closed with a cap polygon built from the on-plane points sorted by angle. Non-convex sources are
   replaced by their convex hull first, so caps are always convex and pieces always convex. Vertex attributes
   (normal, uv) of original faces are interpolated along cuts; cap faces get flat normals and planar UVs. */
function lerpVert(a,b,t){const v=new Array(8);for(let i=0;i<8;i++)v[i]=a[i]+(b[i]-a[i])*t;const l=Math.hypot(v[3],v[4],v[5])||1;v[3]/=l;v[4]/=l;v[5]/=l;return v;}
function clipPolys(polys,nx,ny,nz,d,eps,cap){
  const out=[];
  for(const poly of polys){const vs=poly.v,L=vs.length,ds=new Float64Array(L);let anyOut=false,anyIn=false;
    for(let i=0;i<L;i++){const p=vs[i],s=p[0]*nx+p[1]*ny+p[2]*nz+d;ds[i]=s;if(s>eps)anyOut=true;else if(s<-eps)anyIn=true;}
    if(!anyOut){out.push(poly);for(let i=0;i<L;i++)if(ds[i]>=-eps)cap.push(vs[i]);continue;}
    if(!anyIn){for(let i=0;i<L;i++)if(ds[i]<=eps)cap.push(vs[i]);continue;}
    const nv=[];
    for(let i=0;i<L;i++){const j=(i+1)%L,a=vs[i],da=ds[i],db=ds[j];
      if(da<=eps){nv.push(a);if(da>=-eps)cap.push(a);}
      if((da<-eps&&db>eps)||(da>eps&&db<-eps)){const v=lerpVert(a,vs[j],da/(da-db));nv.push(v);cap.push(v);}}
    if(nv.length>=3)out.push({v:nv,m:poly.m,cut:poly.cut});}
  return out;
}
function buildCap(pts,nx,ny,nz,eps,uvScale,mat){
  const uniq=[],seen=new Map(),q=1/Math.max(eps*4,1e-9);
  for(const p of pts){const k=Math.round(p[0]*q)+','+Math.round(p[1]*q)+','+Math.round(p[2]*q);if(!seen.has(k)){seen.set(k,1);uniq.push(p);}}
  if(uniq.length<3)return null;
  let cx=0,cy=0,cz=0;for(const p of uniq){cx+=p[0];cy+=p[1];cz+=p[2];}cx/=uniq.length;cy/=uniq.length;cz/=uniq.length;
  // plane basis: u perpendicular to n, w = n x u (so increasing angle is counter-clockwise seen from +n)
  let ux,uy,uz;if(Math.abs(nx)<.9){ux=0;uy=nz;uz=-ny;}else{ux=-nz;uy=0;uz=nx;}const ul=Math.hypot(ux,uy,uz);ux/=ul;uy/=ul;uz/=ul;
  const wx=ny*uz-nz*uy,wy=nz*ux-nx*uz,wz=nx*uy-ny*ux;
  const verts=uniq.map(p=>{const dx=p[0]-cx,dy=p[1]-cy,dz=p[2]-cz;return {a:Math.atan2(dx*wx+dy*wy+dz*wz,dx*ux+dy*uy+dz*uz),
    v:[p[0],p[1],p[2],nx,ny,nz,(p[0]*ux+p[1]*uy+p[2]*uz)*uvScale,(p[0]*wx+p[1]*wy+p[2]*wz)*uvScale]};}).sort((a,b)=>a.a-b.a).map(o=>o.v);
  return {v:verts,m:mat,cut:true};
}
function fractureGeometry(THREE,geometry,o={}){
  if(!geometry||!geometry.attributes||!geometry.attributes.position)throw new TypeError('KE.Physics3D.fractureGeometry: BufferGeometry with positions required');
  const s=readVec(o.scale==null?1:o.scale,new THREE.Vector3());
  const soup=readTriangles(geometry,s.x,s.y,s.z);if(soup.count<4)throw new RangeError('KE.Physics3D.fractureGeometry: geometry has too few triangles');
  const pts=[],seenP=new Map();const box=new THREE.Box3();
  for(let i=0;i<soup.count*3;i++){const x=soup.P[i*3],y=soup.P[i*3+1],z=soup.P[i*3+2],k=x.toFixed(5)+','+y.toFixed(5)+','+z.toFixed(5);if(!seenP.has(k)){seenP.set(k,1);const v=new THREE.Vector3(x,y,z);pts.push(v);box.expandByPoint(v);}}
  const size=box.getSize(new THREE.Vector3()),diag=size.length();if(!(diag>0))throw new RangeError('KE.Physics3D.fractureGeometry: degenerate geometry');
  const eps=diag*1e-6,uvScale=o.uvScale==null?1:o.uvScale,interior=o.interiorMaterialIndex==null?null:o.interiorMaterialIndex;
  const hull=convexHull(THREE,pts),meshVolume=soupVolume(soup.P,soup.count);
  const convex=!o.forceHull&&(!hull||meshVolume>=hull.volume*(1-(o.convexTolerance==null?.02:o.convexTolerance)));
  // source polygons
  let polys=[];
  if(convex){for(let t=0;t<soup.count;t++){const v=[];for(let k=0;k<3;k++){const a=t*9+k*3;v.push([soup.P[a],soup.P[a+1],soup.P[a+2],soup.N[a],soup.N[a+1],soup.N[a+2],soup.U[t*6+k*2],soup.U[t*6+k*2+1]]);}polys.push({v,m:soup.M[t],cut:false});}}
  else{for(const f of hull.faces){const n=f.normal,ax=Math.abs(n.x),ay=Math.abs(n.y),az=Math.abs(n.z);
    polys.push({v:f.verts.map(p=>{const u=ax>=ay&&ax>=az?[p.z,p.y]:ay>=az?[p.x,p.z]:[p.x,p.y];return [p.x,p.y,p.z,n.x,n.y,n.z,u[0]*uvScale,u[1]*uvScale];}),m:0,cut:false});}}
  const planes=hull?hull.planes:[[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].map(([x,y,z])=>({n:new THREE.Vector3(x,y,z),c:x>0?box.max.x:x<0?-box.min.x:y>0?box.max.y:y<0?-box.min.y:z>0?box.max.z:-box.min.z}));
  const sourceVolume=convex?meshVolume:hull.volume;
  // seeds: rejection-sampled inside the solid with a minimum spacing; optionally clustered near the impact point
  const want=Math.max(1,Math.min(256,Math.round(o.pieces==null?8:o.pieces))),rnd=KE.random(o.seed==null?1:o.seed);
  const minSize=Math.max(o.minSize==null?.08:o.minSize,diag*1e-4),seeds=[],impact=o.point?readVec(o.point,new THREE.Vector3()):null,margin=minSize*.25;
  const inside=p=>{for(const pl of planes)if(pl.n.dot(p)-pl.c>-margin)return false;return true;};
  const gauss=()=>{let u=0;for(let i=0;i<4;i++)u+=rnd();return (u-2)*.866;};
  const sigma=diag*(o.spread==null?.22:o.spread);
  let minDist=minSize;
  for(let attempt=0,limit=want*120;seeds.length<want&&attempt<limit;attempt++){
    if(attempt===Math.floor(limit*.6))minDist*=.5;
    const p=impact&&rnd()<(o.impactBias==null?.6:o.impactBias)?new THREE.Vector3(impact.x+gauss()*sigma,impact.y+gauss()*sigma,impact.z+gauss()*sigma)
      :new THREE.Vector3(box.min.x+rnd()*size.x,box.min.y+rnd()*size.y,box.min.z+rnd()*size.z);
    if(!inside(p))continue;let ok=true;for(const q of seeds)if(q.distanceToSquared(p)<minDist*minDist){ok=false;break;}if(ok)seeds.push(p);}
  if(seeds.length<2)return {pieces:[],convex,sourceVolume,seeds};
  const pieces=[];
  for(let i=0;i<seeds.length;i++){const si=seeds[i];let cell=polys;
    const order=seeds.map((q,j)=>j).filter(j=>j!==i).sort((a,b)=>seeds[a].distanceToSquared(si)-seeds[b].distanceToSquared(si));
    for(const j of order){const sj=seeds[j];let nx=sj.x-si.x,ny=sj.y-si.y,nz=sj.z-si.z;const l=Math.hypot(nx,ny,nz);if(l<1e-12)continue;nx/=l;ny/=l;nz/=l;
      const d=-(nx*(si.x+sj.x)+ny*(si.y+sj.y)+nz*(si.z+sj.z))*.5;
      let maxS=-Infinity;for(const p of cell)for(const v of p.v){const sv=v[0]*nx+v[1]*ny+v[2]*nz+d;if(sv>maxS)maxS=sv;}
      if(maxS<=eps)continue;
      const cap=[];cell=clipPolys(cell,nx,ny,nz,d,eps,cap);if(!cell.length)break;
      const c=buildCap(cap,nx,ny,nz,eps,uvScale,interior==null?0:interior);if(c)cell.push(c);}
    if(cell.length<4)continue;
    // triangulate (fans), volume and centroid by signed tetrahedra
    const tri=[];let vol=0,mx=0,my=0,mz=0;
    for(const p of cell){const v=p.v;for(let k=1;k<v.length-1;k++){const a=v[0],b=v[k],c=v[k+1];
      const tv=(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;vol+=tv;mx+=tv*(a[0]+b[0]+c[0])/4;my+=tv*(a[1]+b[1]+c[1])/4;mz+=tv*(a[2]+b[2]+c[2])/4;
      tri.push({a,b,c,m:p.cut&&interior!=null?interior:p.m});}}
    if(!(vol>sourceVolume*1e-5))continue;
    const cx=mx/vol,cy=my/vol,cz=mz/vol;tri.sort((a,b)=>a.m-b.m);
    const n=tri.length,P=new Float32Array(n*9),N=new Float32Array(n*9),U=new Float32Array(n*6),g=new THREE.BufferGeometry();
    let gs=0,gm=tri.length?tri[0].m:0;
    tri.forEach((t,k)=>{[t.a,t.b,t.c].forEach((v,j)=>{const o=k*9+j*3;P[o]=v[0]-cx;P[o+1]=v[1]-cy;P[o+2]=v[2]-cz;N[o]=v[3];N[o+1]=v[4];N[o+2]=v[5];U[k*6+j*2]=v[6];U[k*6+j*2+1]=v[7];});
      if(t.m!==gm){g.addGroup(gs*3,(k-gs)*3,gm);gs=k;gm=t.m;}});
    if(g.groups.length||gm!==0)g.addGroup(gs*3,(n-gs)*3,gm);
    g.setAttribute('position',new THREE.BufferAttribute(P,3));g.setAttribute('normal',new THREE.BufferAttribute(N,3));g.setAttribute('uv',new THREE.BufferAttribute(U,2));
    g.computeBoundingBox();g.computeBoundingSphere();
    pieces.push({geometry:g,centroid:new THREE.Vector3(cx,cy,cz),volume:vol});}
  return {pieces,convex,sourceVolume,seeds};
}

/* ---------- Body handle ---------- */
class Body{
  constructor(physics,rigidBody,colliders,object,type,opts){
    const T=physics.THREE;
    this.physics=physics;this.rigidBody=rigidBody;this.colliders=colliders;this.collider=colliders[0]||null;
    this.object=object||null;this.id=rigidBody.handle;this.type=type;this.shape=opts.shape||'custom';
    this.userData=opts.userData||{};this.owned=false;this.removed=false;
    this.onContact=opts.onContact||null;this.onTrigger=opts.onTrigger||null;this.onContactForce=opts.onContactForce||null;
    this.syncRotation=opts.syncRotation!==false;this.objectOffset=null;
    this.localBounds=new T.Box3();this.radius=0;
    this._prevP=new T.Vector3();this._curP=new T.Vector3();this._prevQ=new T.Quaternion();this._curQ=new T.Quaternion();
    this._stamp=-1;this._synced=false;this._follow=false;this._joints=null;
  }
  _rb(){if(this.removed)throw new Error('KE.Physics3D: body '+this.id+' has been removed');return this.rigidBody;}
  get mass(){return this._rb().mass();}
  /* Current simulated pose (not interpolated). */
  getPosition(out=new this.physics.THREE.Vector3()){return out.copy(this._curP);}
  getQuaternion(out=new this.physics.THREE.Quaternion()){return out.copy(this._curQ);}
  applyImpulse(v,point){const rb=this._rb(),a=setXYZ(this.physics._a,readVec(v,this.physics._t1));
    if(point){rb.applyImpulseAtPoint(a,setXYZ(this.physics._b,readVec(point,this.physics._t2)),true);}else rb.applyImpulse(a,true);return this;}
  /* Force applied during the next fixed step only (reset afterwards). Call every step for a continuous force. */
  applyForce(v,point){const rb=this._rb(),a=setXYZ(this.physics._a,readVec(v,this.physics._t1));
    if(point)rb.addForceAtPoint(a,setXYZ(this.physics._b,readVec(point,this.physics._t2)),true);else rb.addForce(a,true);this.physics._forceBodies.add(this);return this;}
  applyTorque(v){this._rb().addTorque(setXYZ(this.physics._a,readVec(v,this.physics._t1)),true);this.physics._forceBodies.add(this);return this;}
  applyTorqueImpulse(v){this._rb().applyTorqueImpulse(setXYZ(this.physics._a,readVec(v,this.physics._t1)),true);return this;}
  setVelocity(v){this._rb().setLinvel(setXYZ(this.physics._a,readVec(v,this.physics._t1)),true);return this;}
  getVelocity(out=new this.physics.THREE.Vector3()){const l=this._rb().linvel();return out.set(l.x,l.y,l.z);}
  setAngularVelocity(v){this._rb().setAngvel(setXYZ(this.physics._a,readVec(v,this.physics._t1)),true);return this;}
  getAngularVelocity(out=new this.physics.THREE.Vector3()){const l=this._rb().angvel();return out.set(l.x,l.y,l.z);}
  setPosition(v){const rb=this._rb();readVec(v,this._curP);rb.setTranslation(setXYZ(this.physics._a,this._curP),true);this._prevP.copy(this._curP);if(!this._follow)this.physics._writeBody(this,1,true);return this;}
  setRotation(q){const rb=this._rb();readQuat(q,this._curQ,this.physics.THREE);const r=this.physics._q;r.x=this._curQ.x;r.y=this._curQ.y;r.z=this._curQ.z;r.w=this._curQ.w;rb.setRotation(r,true);this._prevQ.copy(this._curQ);if(!this._follow)this.physics._writeBody(this,1,true);return this;}
  /* Instant move without interpolation smear; velocities are cleared unless keepVelocity. */
  teleport(pos,quat,{keepVelocity=false}={}){if(pos!=null)this.setPosition(pos);if(quat!=null)this.setRotation(quat);
    if(!keepVelocity&&this.type!=='fixed'){const z=this.physics._a;z.x=z.y=z.z=0;this.rigidBody.setLinvel(z,true);this.rigidBody.setAngvel(z,true);}return this;}
  /* Kinematic bodies: target pose reached during the next step (gives contacts a proper velocity). */
  moveKinematic(pos,quat){const rb=this._rb();if(pos!=null)rb.setNextKinematicTranslation(setXYZ(this.physics._a,readVec(pos,this.physics._t1)));
    if(quat!=null){const q=readQuat(quat,this.physics._tq2,this.physics.THREE),r=this.physics._q;r.x=q.x;r.y=q.y;r.z=q.z;r.w=q.w;rb.setNextKinematicRotation(r);}return this;}
  sleep(){this._rb().sleep();return this;}
  wakeUp(){this._rb().wakeUp();return this;}
  isSleeping(){return this._rb().isSleeping();}
  setEnabled(on){this._rb().setEnabled(!!on);return this;}
  isEnabled(){return this._rb().isEnabled();}
  setGravityScale(s){this._rb().setGravityScale(s,true);return this;}
  setCcd(on){this._rb().enableCcd(!!on);return this;}
  setDamping(linear,angular){const rb=this._rb();if(linear!=null)rb.setLinearDamping(linear);if(angular!=null)rb.setAngularDamping(angular);return this;}
  setFriction(f){this._rb();for(const c of this.colliders)c.setFriction(f);return this;}
  setRestitution(r){this._rb();for(const c of this.colliders)c.setRestitution(r);return this;}
  setGroups(g){this._rb();const m=interactionGroups(g);for(const c of this.colliders){c.setCollisionGroups(m);c.setSolverGroups(m);}return this;}
  lockRotations(locked=true){this._rb().lockRotations(!!locked,true);return this;}
  dispose(opts){if(!this.removed)this.physics.remove(this,opts);}
}

/* ---------- joints ---------- */
class Joint{
  constructor(physics,joint,type,a,b,axis){this.physics=physics;this.joint=joint;this.type=type;this.bodyA=a;this.bodyB=b;this.axis=axis;this.disposed=false;this._angle0=0;}
  _j(){if(this.disposed)throw new Error('KE.Physics3D: joint has been disposed');return this.joint;}
  setLimits(min,max){const j=this._j();if(typeof j.setLimits!=='function')throw new TypeError('KE.Physics3D: '+this.type+' joints have no limits');j.setLimits(min,max);return this;}
  /* motor: {targetVelocity, targetPosition, stiffness, damping, maxForce|factor, model:'acceleration'|'force'} */
  setMotor(m={}){const j=this._j(),R=this.physics.RAPIER;if(typeof j.configureMotorVelocity!=='function')throw new TypeError('KE.Physics3D: '+this.type+' joints have no motor');
    if(m.model&&R.MotorModel)j.configureMotorModel(m.model==='force'?R.MotorModel.ForceBased:R.MotorModel.AccelerationBased);
    const gain=m.factor!=null?m.factor:m.maxForce!=null?m.maxForce:1;
    if(m.targetPosition!=null)j.configureMotor(m.targetPosition,m.targetVelocity||0,m.stiffness==null?gain*10:m.stiffness,m.damping==null?gain:m.damping);
    else j.configureMotorVelocity(m.targetVelocity||0,gain);
    this.bodyA&&!this.bodyA.removed&&this.bodyA.rigidBody.wakeUp();this.bodyB&&!this.bodyB.removed&&this.bodyB.rigidBody.wakeUp();return this;}
  /* Hinge only: rotation of B relative to A about the joint axis since creation, radians. */
  angle(){this._j();if(this.type!=='hinge')return 0;return this._rawAngle()-this._angle0;}
  _rawAngle(){const T=this.physics.THREE,qa=this.bodyA._curQ,qb=this.bodyB._curQ,r=this.physics._tq3.copy(qa).invert().multiply(qb),a=this.axis;
    let ang=2*Math.atan2(r.x*a.x+r.y*a.y+r.z*a.z,r.w);if(ang>Math.PI)ang-=2*Math.PI;if(ang<-Math.PI)ang+=2*Math.PI;return ang;}
  dispose(){if(this.disposed)return;this.disposed=true;const p=this.physics;
    if(p.world&&this.joint&&this.bodyA&&!this.bodyA.removed&&this.bodyB&&!this.bodyB.removed)p.world.removeImpulseJoint(this.joint,true);
    p.joints.delete(this);for(const b of [this.bodyA,this.bodyB])if(b&&b._joints)b._joints.delete(this);this.joint=null;}
}

/* ---------- kinematic character controller ---------- */
/* Capsule on a kinematic position-based body moved by Rapier's KinematicCharacterController:
   sliding along walls, climbing slopes up to maxSlope, auto-stepping, snapping to the ground and pushing
   dynamic bodies. The object origin is the feet; its rotation is left to the game (facing). */
class CharacterController{
  constructor(physics,object,o={}){
    const T=physics.THREE,R=physics.RAPIER;this.physics=physics;this.object=object||null;
    this.radius=o.radius==null?.35:o.radius;this.height=Math.max(o.height==null?1.5:o.height,this.radius*2+1e-3);this.halfHeight=Math.max(0,this.height/2-this.radius);
    this.maxSlope=o.maxSlope==null?45*DEG:o.maxSlope;this.stepHeight=o.stepHeight==null?.35:o.stepHeight;this.snapToGround=o.snapToGround==null?.3:o.snapToGround;
    this.slideOnSlopes=o.slideOnSlopes!==false;this.offset=o.offset==null?.02:o.offset;this.coyoteTime=o.coyoteTime==null?.12:o.coyoteTime;
    this.gravity=o.gravity==null?physics.gravity.y:o.gravity;this.maxFallSpeed=o.maxFallSpeed==null?55:o.maxFallSpeed;this.fly=!!o.fly;
    this.position=new T.Vector3();this.velocity=new T.Vector3();this.verticalVelocity=0;this.grounded=false;this.airTime=0;this.collisions=[];this.disposed=false;
    this._center=new T.Vector3();this._pending=false;this._jump=null;this._desired={x:0,y:0,z:0};this._coll=R.CharacterCollision?new R.CharacterCollision():undefined;this._collPool=[];
    if(object){object.updateWorldMatrix(true,false);object.matrixWorld.decompose(this.position,physics._tq,physics._t3);}else readVec(o.position,this.position);
    this._center.copy(this.position);this._center.y+=this.height/2;
    const desc=R.ColliderDesc.capsule(this.halfHeight,this.radius).setFriction(o.friction==null?0:o.friction);
    if(o.groups!=null){const g=interactionGroups(o.groups);desc.setCollisionGroups(g).setSolverGroups(g);}
    desc.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(R.ActiveCollisionTypes.ALL);
    const r=this.radius,hh=this.halfHeight;
    this.body=physics._makeBody(null,{type:'kinematic',position:this._center,friction:o.friction==null?0:o.friction,restitution:0,userData:o.userData||{character:this},shape:'capsule',follow:false,bounds:new T.Box3(new T.Vector3(-r,-hh-r,-r),new T.Vector3(r,hh+r,r))},[{desc}]);
    this.body.character=this;this.body.object=this.object;this.body.syncRotation=false;this.body.objectOffset=new T.Vector3(0,-this.height/2,0);this.body._synced=!!object;
    if(object)physics._objectBody.set(object,this.body);
    const c=this.controller=physics.world.createCharacterController(this.offset);
    c.setUp({x:0,y:1,z:0});c.setSlideEnabled(true);c.setMaxSlopeClimbAngle(this.maxSlope);c.setMinSlopeSlideAngle(this.slideOnSlopes?this.maxSlope:Math.PI/2);
    if(this.stepHeight>0)c.enableAutostep(this.stepHeight,o.stepMinWidth==null?this.radius*.5:o.stepMinWidth,false);else c.disableAutostep();
    if(this.snapToGround>0)c.enableSnapToGround(this.snapToGround);else c.disableSnapToGround();
    c.setCharacterMass(o.mass==null?70:o.mass);this.pushDynamic=o.pushDynamic!==false;
    this._filterGroups=o.groups!=null?interactionGroups(o.groups):undefined;
    physics.characters.add(this);
  }
  get pushDynamic(){return this._push;}
  set pushDynamic(v){this._push=!!v;if(this.controller)this.controller.setApplyImpulsesToDynamicBodies(this._push);}
  /* Request a jump; succeeds when grounded or within coyoteTime of leaving the ground. Returns true on success. */
  jump(speed=5){if(this.disposed)return false;if(this.grounded||this.airTime<=this.coyoteTime){this._jump=speed;return true;}return false;}
  /* desiredVelocity: world XZ velocity (m/s); Y is ignored unless fly:true. Gravity and jumps are integrated here. */
  move(desiredVelocity,dt){
    if(this.disposed)throw new Error('KE.Physics3D: character has been disposed');
    const p=this.physics,rb=this.body.rigidBody,c=this.controller;dt=dt>0?Math.min(dt,.1):p.fixedStep;
    const v=readVec(desiredVelocity,p._t1);
    if(this._pending){rb.setTranslation(setXYZ(p._a,this._center),true);p.world.propagateModifiedBodyPositionsToColliders();}
    let vy;
    if(this.fly){vy=v.y;this.verticalVelocity=vy;}
    else{if(this._jump!=null){this.verticalVelocity=this._jump;this._jump=null;this.grounded=false;this.airTime=this.coyoteTime+1;}
      this.verticalVelocity=Math.max(this.verticalVelocity+this.gravity*dt,-this.maxFallSpeed);vy=this.verticalVelocity;}
    if(vy>0&&c.snapToGroundEnabled())c.disableSnapToGround();else if(vy<=0&&this.snapToGround>0&&!c.snapToGroundEnabled())c.enableSnapToGround(this.snapToGround);
    const d=this._desired;d.x=v.x*dt;d.y=vy*dt;d.z=v.z*dt;
    c.computeColliderMovement(this.body.collider,d,p.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,this._filterGroups);
    const m=c.computedMovement();
    this.grounded=c.computedGrounded();
    if(!this.fly){if(this.grounded){this.airTime=0;if(this.verticalVelocity<0)this.verticalVelocity=0;}else{this.airTime+=dt;if(vy>0&&m.y<d.y*.5-1e-5)this.verticalVelocity=0;}}
    this._center.x+=m.x;this._center.y+=m.y;this._center.z+=m.z;
    rb.setNextKinematicTranslation(setXYZ(p._a,this._center));this._pending=true;
    this.velocity.set(m.x/dt,m.y/dt,m.z/dt);
    this.position.set(this._center.x,this._center.y-this.height/2,this._center.z);
    // collisions reported by the controller this move
    const n=c.numComputedCollisions();this.collisions.length=0;
    for(let i=0;i<n;i++){const hit=c.computedCollision(i,this._coll);if(!hit||!hit.collider)continue;let rec=this._collPool[i];if(!rec)rec=this._collPool[i]={body:null,normal:new p.THREE.Vector3(),point:new p.THREE.Vector3()};
      rec.body=p._colliderBody.get(hit.collider.handle)||null;rec.normal.set(hit.normal1.x,hit.normal1.y,hit.normal1.z);rec.point.set(hit.witness1.x,hit.witness1.y,hit.witness1.z);this.collisions.push(rec);}
    return this;
  }
  /* Instant placement (feet position). */
  teleport(pos){const p=this.physics;readVec(pos,this.position);this._center.copy(this.position);this._center.y+=this.height/2;
    this.body.rigidBody.setTranslation(setXYZ(p._a,this._center),true);p.world.propagateModifiedBodyPositionsToColliders();this._pending=false;
    this.verticalVelocity=0;this.velocity.set(0,0,0);this.body._curP.copy(this._center);this.body._prevP.copy(this._center);p._writeBody(this.body,1);return this;}
  dispose(){if(this.disposed)return;this.disposed=true;const p=this.physics;
    if(p.world){p.world.removeCharacterController(this.controller);if(!this.body.removed)p.remove(this.body);}
    p.characters.delete(this);this.controller=null;}
}

/* ---------- raycast vehicle ---------- */
class Vehicle{
  constructor(physics,chassis,o={}){
    const T=physics.THREE;this.physics=physics;this.chassis=chassis;this.disposed=false;
    const c=this.controller=physics.world.createVehicleController(chassis.rigidBody);
    c.indexUpAxis=1;c.setIndexForwardAxis=o.forwardAxis==null?2:o.forwardAxis;
    this.wheels=[];
    for(const w of o.wheels||[]){const i=this.wheels.length,pos=readVec(w.position,new T.Vector3()),dir=readVec(w.direction||[0,-1,0],new T.Vector3()),axle=readVec(w.axle||[-1,0,0],new T.Vector3());
      const rest=w.suspensionRestLength==null?.3:w.suspensionRestLength,radius=w.radius==null?.35:w.radius;
      c.addWheel(setXYZ({},pos),setXYZ({},dir),setXYZ({},axle),rest,radius);
      c.setWheelSuspensionStiffness(i,w.suspensionStiffness==null?30:w.suspensionStiffness);c.setWheelSuspensionCompression(i,w.suspensionCompression==null?4.4:w.suspensionCompression);
      c.setWheelSuspensionRelaxation(i,w.suspensionRelaxation==null?2.3:w.suspensionRelaxation);c.setWheelMaxSuspensionTravel(i,w.maxSuspensionTravel==null?.3:w.maxSuspensionTravel);
      c.setWheelMaxSuspensionForce(i,w.maxSuspensionForce==null?1e5:w.maxSuspensionForce);c.setWheelFrictionSlip(i,w.frictionSlip==null?2.5:w.frictionSlip);
      c.setWheelSideFrictionStiffness(i,w.sideFrictionStiffness==null?1:w.sideFrictionStiffness);
      this.wheels.push({index:i,position:pos,direction:dir.normalize(),axle:axle.normalize(),radius,steering:!!w.steering,drive:w.drive!==false,brake:w.brake!==false,object:w.object||null,spin:0});}
    this._tq=new T.Quaternion();this._tq2=new T.Quaternion();this._tv=new T.Vector3();this._tm=new T.Matrix4();this._up=new T.Vector3(0,1,0);
    physics.vehicles.add(this);
  }
  setEngineForce(f){for(const w of this.wheels)this.controller.setWheelEngineForce(w.index,w.drive?f:0);this.chassis.rigidBody.wakeUp();return this;}
  setSteering(angle){for(const w of this.wheels)this.controller.setWheelSteering(w.index,w.steering?angle:0);return this;}
  setBrake(b){for(const w of this.wheels)this.controller.setWheelBrake(w.index,w.brake?b:0);return this;}
  get speed(){return this.controller?this.controller.currentVehicleSpeed():0;}
  wheelInContact(i){return this.controller.wheelIsInContact(i);}
  _update(dt){this.controller.updateVehicle(dt,this.physics.RAPIER.QueryFilterFlags.EXCLUDE_SENSORS);}
  /* Place wheel objects: chassis-local connection point + suspension length along the wheel direction, steering about up, spin about the axle. */
  _sync(){const c=this.controller,ch=this.chassis;
    for(const w of this.wheels){if(!w.object)continue;const len=c.wheelSuspensionLength(w.index);const s=len==null?0:len;
      const o=w.object,lp=this._tv.copy(w.direction).multiplyScalar(s).add(w.position);
      const q=this._tq.setFromAxisAngle(this._up,c.wheelSteering(w.index)||0).multiply(this._tq2.setFromAxisAngle(w.axle,c.wheelRotation(w.index)||0));
      if(o.parent===ch.object){o.position.copy(lp);o.quaternion.copy(q);}
      else{const cp=this._cp||(this._cp=lp.clone()),cq=this._cq||(this._cq=q.clone());this.physics._pose(ch,this.physics.alpha,cp,cq);
        lp.applyQuaternion(cq).add(cp);q.premultiply(cq);o.quaternion.copy(this.physics._setWorldPose(o,lp,q));}}}
  dispose(){if(this.disposed)return;this.disposed=true;if(this.physics.world)this.physics.world.removeVehicleController(this.controller);this.physics.vehicles.delete(this);this.controller=null;}
}

/* ---------- the physics world ---------- */
class PhysicsWorld{
  constructor(THREE,R,o={}){
    this.THREE=THREE;this.RAPIER=R;
    const g=readVec(o.gravity==null?[0,-9.81,0]:o.gravity,new THREE.Vector3());this.gravity=g;
    this.world=new R.World({x:g.x,y:g.y,z:g.z});
    this.fixedStep=o.fixedStep>0?o.fixedStep:1/60;this.world.timestep=this.fixedStep;
    if(o.solverIterations>0)this.world.numSolverIterations=Math.round(o.solverIterations);
    this.maxSubSteps=Math.max(1,Math.round(o.maxSubSteps||4));this.maxDelta=o.maxDelta>0?o.maxDelta:.25;this.interpolate=o.interpolate!==false;
    this.eventQueue=new R.EventQueue(true);this.events=new KE.Events();this.scene=o.scene||null;
    this.timeScale=1;this.paused=false;this.time=0;this.accumulator=0;this.alpha=1;this.droppedTime=0;this.stepCount=0;this.lastSubSteps=0;this.disposed=false;
    this.maxDebris=o.maxDebris!=null?o.maxDebris:Math.round(64+192*clamp(KE.settings&&Number.isFinite(KE.settings.vfx)?KE.settings.vfx:1,0,1));this.defaults={friction:.6,restitution:.1,density:1,...(o.defaults||{})};
    this.bodies=new Map();this._colliderBody=new Map();this._objectBody=new WeakMap();this._sensors=new Set();
    this._live=[];this._liveNext=[];this._settle=[];this._followers=new Set();this._forceBodies=new Set();this._debris=[];this._buoyancy=new Map();
    this.characters=new Set();this.joints=new Set();this.vehicles=new Set();
    this._stepMs=0;this.lastStepMs=0;this._contacts=0;this._awake=0;this._fractureSeed=1;this._ground=null;this._debug=null;
    // temps (no per-step allocation on the JS side)
    this._t1=new THREE.Vector3();this._t2=new THREE.Vector3();this._t3=new THREE.Vector3();this._t4=new THREE.Vector3();this._tp=new THREE.Vector3();this._ts=new THREE.Vector3();
    this._tq=new THREE.Quaternion();this._tq2=new THREE.Quaternion();this._tq3=new THREE.Quaternion();this._tm=new THREE.Matrix4();this._tm2=new THREE.Matrix4();
    this._a={x:0,y:0,z:0};this._b={x:0,y:0,z:0};this._q={x:0,y:0,z:0,w:1};
    this._evH1=new Float64Array(64);this._evH2=new Float64Array(64);this._evS=new Uint8Array(64);this._evN=0;
    this._collisionCb=(h1,h2,started)=>{let n=this._evN;if(n>=this._evH1.length){const grow=(A,C)=>{const B=new C(A.length*2);B.set(A);return B;};this._evH1=grow(this._evH1,Float64Array);this._evH2=grow(this._evH2,Float64Array);this._evS=grow(this._evS,Uint8Array);}
      this._evH1[n]=h1;this._evH2[n]=h2;this._evS[n]=started?1:0;this._evN=n+1;};
    this._forceEvents=[];this._forceCb=e=>{this._forceEvents.push({h1:e.collider1(),h2:e.collider2(),magnitude:e.totalForceMagnitude(),force:e.totalForce(),maxDirection:e.maxForceDirection()});};
    this._activeCb=rb=>{const b=this.bodies.get(rb.handle);if(!b)return;this._awake++;if(!b._synced)return;
      b._prevP.copy(b._curP);b._prevQ.copy(b._curQ);const t=rb.translation(),r=rb.rotation();b._curP.set(t.x,t.y,t.z);b._curQ.set(r.x,r.y,r.z,r.w);
      if(b._stamp!==this.stepCount){b._stamp=this.stepCount;this._liveNext.push(b);}};
    if(o.debug&&this.scene)this.debug(this.scene,true);
  }
  _alive(){if(this.disposed)throw new Error('KE.Physics3D: world has been disposed');}
  on(name,fn){return this.events.on(name,fn);}
  once(name,fn){return this.events.once(name,fn);}
  off(name,fn){this.events.off(name,fn);}
  pause(v=true){this.paused=!!v;return this;}
  setFixedStep(h){if(!(h>0))throw new RangeError('KE.Physics3D: fixed step must be positive');this.fixedStep=h;this.world.timestep=h;return this;}
  bodyOf(object){return this._objectBody.get(object)||null;}
  getBodies(){return [...this.bodies.values()];}
  setGravity(v){readVec(v,this.gravity);this.world.gravity={x:this.gravity.x,y:this.gravity.y,z:this.gravity.z};return this;}

  /* ----- body frame & fitting ----- */
  _frame(object,o){const T=this.THREE,P=new T.Vector3(),Q=new T.Quaternion(),S=new T.Vector3(1,1,1);
    if(object){object.updateWorldMatrix(true,true);object.matrixWorld.decompose(P,Q,S);}
    if(o.position!=null)readVec(o.position,P);if(o.quaternion!=null||o.rotation!=null)readQuat(o.quaternion||o.rotation,Q,T);
    const inv=new T.Matrix4().compose(P,Q,new T.Vector3(1,1,1)).invert();return {P,Q,S,inv};}
  _rel(mesh,frame,out){return out.multiplyMatrices(frame.inv,mesh.matrixWorld);}
  _boundsInFrame(meshes,frame,box){const T=this.THREE,m=new T.Matrix4(),v=new T.Vector3();box.makeEmpty();
    for(const mesh of meshes){const g=mesh.geometry;if(!g.boundingBox)g.computeBoundingBox();const bb=g.boundingBox;if(bb.isEmpty())continue;this._rel(mesh,frame,m);
      for(let i=0;i<8;i++){v.set(i&1?bb.max.x:bb.min.x,i&2?bb.max.y:bb.min.y,i&4?bb.max.z:bb.min.z).applyMatrix4(m);box.expandByPoint(v);}}
    return box;}
  _pointsInFrame(meshes,frame){const T=this.THREE,m=new T.Matrix4(),v=new T.Vector3();let n=0;for(const mesh of meshes)n+=mesh.geometry.attributes.position.count;
    const out=new Float32Array(n*3);let k=0;
    for(const mesh of meshes){const pos=mesh.geometry.attributes.position;this._rel(mesh,frame,m);for(let i=0;i<pos.count;i++){v.fromBufferAttribute(pos,i).applyMatrix4(m);out[k++]=v.x;out[k++]=v.y;out[k++]=v.z;}}
    return out;}
  /* Sphere-likeness: all vertices near one radius and the box near-cubic. */
  _isRound(mesh,frame){const T=this.THREE,m=this._rel(mesh,frame,new T.Matrix4()),pos=mesh.geometry.attributes.position,v=new T.Vector3(),box=new T.Box3();
    for(let i=0;i<pos.count;i++)box.expandByPoint(v.fromBufferAttribute(pos,i).applyMatrix4(m));
    const size=box.getSize(new T.Vector3()),c=box.getCenter(new T.Vector3()),mx=Math.max(size.x,size.y,size.z),mn=Math.min(size.x,size.y,size.z);
    if(!(mx>0)||mn/mx<.85)return false;let maxD=0;for(let i=0;i<pos.count;i++)maxD=Math.max(maxD,v.fromBufferAttribute(pos,i).applyMatrix4(m).distanceTo(c));
    return maxD/(mx/2)<1.12;}
  /* Axis with the most circular cross-section (ties: longest); used for capsules and cylinders. */
  _roundAxis(size,o){if(o.axis)return {x:0,y:1,z:2}[o.axis];const s=[size.x,size.y,size.z];let best=1,score=Infinity;
    for(let a=0;a<3;a++){const b=s[(a+1)%3],c=s[(a+2)%3],d=Math.abs(b-c)/Math.max(b,c,1e-9)-s[a]*1e-3/Math.max(...s);if(d<score-1e-6||(Math.abs(d-score)<=1e-6&&a===1)){score=d;best=a;}}return best;}
  _axisQuat(axis){const T=this.THREE;if(axis===1)return null;return new T.Quaternion().setFromUnitVectors(new T.Vector3(0,1,0),axis===0?new T.Vector3(1,0,0):new T.Vector3(0,0,1));}
  _primitiveDesc(kind,box,o,rot){const R=this.RAPIER,T=this.THREE,size=box.getSize(new T.Vector3()),c=box.getCenter(new T.Vector3());let desc,q=rot?rot.clone():null;
    if(kind==='sphere'){const r=o.radius!=null?o.radius:Math.max(size.x,size.y,size.z)/2;desc=R.ColliderDesc.ball(Math.max(r,1e-4));}
    else if(kind==='capsule'||kind==='cylinder'||kind==='cone'){const axis=this._roundAxis(size,o),s=[size.x,size.y,size.z],half=s[axis]/2,r=o.radius!=null?o.radius:Math.max(s[(axis+1)%3],s[(axis+2)%3])/2;
      const hh=o.halfHeight!=null?o.halfHeight:kind==='capsule'?Math.max(0,half-r):half;
      desc=kind==='capsule'?R.ColliderDesc.capsule(Math.max(hh,0),Math.max(r,1e-4)):kind==='cone'?R.ColliderDesc.cone(Math.max(hh,1e-4),Math.max(r,1e-4)):R.ColliderDesc.cylinder(Math.max(hh,1e-4),Math.max(r,1e-4));
      const aq=this._axisQuat(axis);if(aq)q=q?q.multiply(aq):aq;}
    else{const he=o.halfExtents!=null?readVec(o.halfExtents,new T.Vector3()):size.multiplyScalar(.5);desc=o.roundRadius>0?R.ColliderDesc.roundCuboid(Math.max(he.x-o.roundRadius,1e-4),Math.max(he.y-o.roundRadius,1e-4),Math.max(he.z-o.roundRadius,1e-4),o.roundRadius):R.ColliderDesc.cuboid(Math.max(he.x,1e-4),Math.max(he.y,1e-4),Math.max(he.z,1e-4));}
    const off=o.offset!=null?readVec(o.offset,new T.Vector3()):c;
    if(rot&&o.offset==null)off.copy(c);
    desc.setTranslation(off.x,off.y,off.z);if(q)desc.setRotation({x:q.x,y:q.y,z:q.z,w:q.w});return desc;}
  /* Per-mesh oriented primitive in the body frame (used for compound groups). */
  _meshPrimitive(mesh,frame,kind,o){const T=this.THREE,m=this._rel(mesh,frame,new T.Matrix4()),t=new T.Vector3(),q=new T.Quaternion(),s=new T.Vector3();m.decompose(t,q,s);
    const g=mesh.geometry;if(!g.boundingBox)g.computeBoundingBox();const bb=g.boundingBox.clone();bb.min.multiply(s);bb.max.multiply(s);
    const lo=bb.min.clone().min(bb.max),hi=bb.max.clone().max(bb.min);bb.set(lo,hi);const c=bb.getCenter(new T.Vector3()).applyQuaternion(q).add(t),size=bb.getSize(new T.Vector3());
    const box=new T.Box3().setFromCenterAndSize(c,size);return this._primitiveDesc(kind,box,{...o,offset:undefined,halfExtents:undefined,radius:undefined,halfHeight:undefined},q);}

  /* ----- body creation core ----- */
  _makeBody(object,o,shapes){
    this._alive();const R=this.RAPIER,T=this.THREE,type=o.type||'dynamic';if(!TYPES.includes(type))throw new RangeError('KE.Physics3D: unknown body type '+type);
    const frame=o._frame||this._frame(object,o);
    const desc=type==='fixed'?R.RigidBodyDesc.fixed():type==='kinematic'?R.RigidBodyDesc.kinematicPositionBased():type==='kinematicVelocity'?R.RigidBodyDesc.kinematicVelocityBased():R.RigidBodyDesc.dynamic();
    desc.setTranslation(frame.P.x,frame.P.y,frame.P.z).setRotation({x:frame.Q.x,y:frame.Q.y,z:frame.Q.z,w:frame.Q.w});
    if(o.linearDamping!=null)desc.setLinearDamping(o.linearDamping);if(o.angularDamping!=null)desc.setAngularDamping(o.angularDamping);
    if(o.ccd)desc.setCcdEnabled(true);if(o.canSleep===false)desc.setCanSleep(false);if(o.gravityScale!=null)desc.setGravityScale(o.gravityScale);
    if(o.lockRotations)desc.lockRotations();if(o.dominance!=null)desc.setDominanceGroup(o.dominance);if(o.solverIterations>0)desc.setAdditionalSolverIterations(o.solverIterations);
    if(o.velocity!=null){const v=readVec(o.velocity,this._t1);desc.setLinvel(v.x,v.y,v.z);}if(o.angularVelocity!=null){const v=readVec(o.angularVelocity,this._t1);desc.setAngvel({x:v.x,y:v.y,z:v.z});}
    if(o.sleeping)desc.setSleeping(true);
    const rb=this.world.createRigidBody(desc),colliders=[],groups=o.groups!=null?interactionGroups(o.groups):null,d=this.defaults;
    const events=o.events!==false&&(type!=='fixed'||o.sensor||o.onContact||o.onTrigger);
    for(const s of shapes){const cd=s.desc;
      cd.setFriction(o.friction==null?d.friction:o.friction).setRestitution(o.restitution==null?d.restitution:o.restitution);
      if(o.mass==null)cd.setDensity(o.density==null?d.density:o.density);
      if(o.sensor){cd.setSensor(true);cd.setActiveCollisionTypes(R.ActiveCollisionTypes.ALL);}
      if(groups!=null){cd.setCollisionGroups(groups);cd.setSolverGroups(groups);}
      let ev=events?R.ActiveEvents.COLLISION_EVENTS:0;if(o.contactForceThreshold!=null){ev|=R.ActiveEvents.CONTACT_FORCE_EVENTS;cd.setContactForceEventThreshold(o.contactForceThreshold);this._hasForceBodies=true;}
      if(ev)cd.setActiveEvents(ev);
      colliders.push(this.world.createCollider(cd,rb));}
    if(o.mass!=null&&o.mass>0&&colliders.length){let total=0;const vols=colliders.map(c=>{const v=Math.max(c.volume()||0,0);total+=v;return v;});
      colliders.forEach((c,i)=>c.setMass(total>0?o.mass*vols[i]/total:o.mass/colliders.length));rb.recomputeMassPropertiesFromColliders();}
    const body=new Body(this,rb,colliders,object,type,o);
    body._curP.copy(frame.P);body._prevP.copy(frame.P);body._curQ.copy(frame.Q);body._prevQ.copy(frame.Q);
    if(o.bounds)body.localBounds.copy(o.bounds);else body.localBounds.setFromCenterAndSize(this._t1.set(0,0,0),this._t2.set(.5,.5,.5));
    body.radius=Math.max(body.localBounds.min.length(),body.localBounds.max.length(),1e-3);
    this.bodies.set(rb.handle,body);for(const c of colliders){this._colliderBody.set(c.handle,body);if(o.sensor)this._sensors.add(c.handle);}
    if(object){this._objectBody.set(object,body);
      if(type==='kinematic'&&o.follow!==false){body._follow=true;this._followers.add(body);}else if(type!=='fixed')body._synced=true;}
    return body;
  }
  _shapeOpts(o,kind,box){return {...o,shape:kind,bounds:box};}
  _requireSize(object,o,box){if(box.isEmpty()){if(o.halfExtents==null&&o.radius==null)throw new TypeError('KE.Physics3D: cannot fit a collider: object has no mesh geometry; pass halfExtents/radius');box.setFromCenterAndSize(this._t1.set(0,0,0),this._t2.set(1,1,1));}}
  _fitted(kind,object,o){
    const T=this.THREE,frame=this._frame(object,o),meshes=collectMeshes(object),box=this._boundsInFrame(meshes,frame,new T.Box3());this._requireSize(object,o,box);
    if(o.halfExtents!=null){const he=readVec(o.halfExtents,new T.Vector3()),c=o.offset!=null?readVec(o.offset,new T.Vector3()):new T.Vector3();box.set(c.clone().sub(he),c.clone().add(he));}
    if(o.radius!=null&&kind==='sphere'){const c=o.offset!=null?readVec(o.offset,new T.Vector3()):box.getCenter(new T.Vector3());box.setFromCenterAndSize(c,new T.Vector3(2,2,2).multiplyScalar(o.radius));}
    if(!meshes.length&&(kind==='capsule'||kind==='cylinder'||kind==='cone')&&o.radius!=null){const r=o.radius,hh=o.halfHeight||0,c=o.offset!=null?readVec(o.offset,new T.Vector3()):new T.Vector3(),ext=kind==='capsule'?hh+r:hh;box.set(new T.Vector3(c.x-r,c.y-ext,c.z-r),new T.Vector3(c.x+r,c.y+ext,c.z+r));}
    const desc=this._primitiveDesc(kind,box,o,null);
    return this._makeBody(object,{...this._shapeOpts(o,kind,box),_frame:frame},[{desc}]);}
  addBox(object,o={}){return this._fitted('box',object,o);}
  addSphere(object,o={}){return this._fitted('sphere',object,o);}
  addCapsule(object,o={}){return this._fitted('capsule',object,o);}
  addCylinder(object,o={}){return this._fitted('cylinder',object,o);}
  addCone(object,o={}){return this._fitted('cone',object,o);}
  /* Convex hull of every mesh vertex under the object, in the (scaled) body frame. compound:true gives one hull per mesh. */
  addConvex(object,o={}){
    const R=this.RAPIER,T=this.THREE,frame=this._frame(object,o),meshes=collectMeshes(object);if(!meshes.length&&!o.points)throw new TypeError('KE.Physics3D.addConvex: object has no mesh geometry');
    const box=new T.Box3(),shapes=[];const groups=o.compound&&meshes.length>1?meshes.map(m=>[m]):[meshes];
    for(const set of groups){const pts=o.points?Float32Array.from(o.points):this._pointsInFrame(set,frame);
      if(o.offset!=null){const off=readVec(o.offset,this._t1);for(let i=0;i<pts.length;i+=3){pts[i]+=off.x;pts[i+1]+=off.y;pts[i+2]+=off.z;}}
      const b=new T.Box3();for(let i=0;i<pts.length;i+=3)b.expandByPoint(this._t2.set(pts[i],pts[i+1],pts[i+2]));box.union(b);
      let desc=o.roundRadius>0?R.ColliderDesc.roundConvexHull(pts,o.roundRadius):R.ColliderDesc.convexHull(pts);
      if(!desc)desc=this._primitiveDesc('box',b,{},null);shapes.push({desc});}
    return this._makeBody(object,{...this._shapeOpts(o,'convex',box),_frame:frame},shapes);
  }
  /* Static triangle mesh of all meshes under the object (children and scale baked into the body frame). */
  addTrimesh(object,o={}){
    const R=this.RAPIER,T=this.THREE,type=o.type||'fixed';if(type==='dynamic')throw new RangeError('KE.Physics3D.addTrimesh: trimeshes are for fixed/kinematic bodies; use addConvex({compound:true}) for dynamic ones');
    const frame=this._frame(object,o),meshes=collectMeshes(object);if(!meshes.length)throw new TypeError('KE.Physics3D.addTrimesh: object has no mesh geometry');
    let nv=0,ni=0;for(const m of meshes){const g=m.geometry;nv+=g.attributes.position.count;ni+=g.index?g.index.count:g.attributes.position.count;}
    const verts=new Float32Array(nv*3),idx=new Uint32Array(ni),mat=new T.Matrix4(),v=new T.Vector3(),box=new T.Box3();let vo=0,io=0;
    for(const m of meshes){const g=m.geometry,pos=g.attributes.position,base=vo;this._rel(m,frame,mat);const flip=mat.determinant()<0;
      for(let i=0;i<pos.count;i++){v.fromBufferAttribute(pos,i).applyMatrix4(mat);verts[vo*3]=v.x;verts[vo*3+1]=v.y;verts[vo*3+2]=v.z;box.expandByPoint(v);vo++;}
      const cnt=g.index?g.index.count:pos.count;for(let i=0;i+2<cnt;i+=3){const a=g.index?g.index.getX(i):i,b=g.index?g.index.getX(i+1):i+1,c=g.index?g.index.getX(i+2):i+2;
        idx[io++]=base+a;idx[io++]=base+(flip?c:b);idx[io++]=base+(flip?b:c);}}
    // same workaround as heightfields: Rapier's triangle ray test is not watertight, so rays through exact vertex
    // coordinates (common for grid-built levels) can slip between triangles; shift the mesh by ~1e-4 units.
    if(o.gridOffset!==false&&vo){const k=Math.max(1,Math.max(Math.abs(box.min.x),Math.abs(box.max.x),Math.abs(box.min.z),Math.abs(box.max.z),Math.abs(box.min.y),Math.abs(box.max.y))/50)*1e-4;
      for(let i=0;i<vo*3;i+=3){verts[i]+=1.03*k;verts[i+1]+=.61*k;verts[i+2]+=.83*k;}}
    const flags=o.flags!=null?o.flags:(o.fixInternalEdges&&R.TriMeshFlags?R.TriMeshFlags.FIX_INTERNAL_EDGES:undefined);
    const desc=flags!=null?R.ColliderDesc.trimesh(verts,idx.subarray(0,io),flags):R.ColliderDesc.trimesh(verts,idx.subarray(0,io));
    return this._makeBody(object,{...this._shapeOpts({...o,type},'trimesh',box),_frame:frame},[{desc}]);
  }
  /* shape:'auto' fits spheres to round near-cubic meshes and boxes otherwise; groups with several meshes become compounds. */
  addFromObject(object,o={}){
    const shape=o.shape||'auto';if(shape==='trimesh')return this.addTrimesh(object,o);
    const meshes=collectMeshes(object);if(!meshes.length)throw new TypeError('KE.Physics3D.addFromObject: object has no mesh geometry');
    if(meshes.length===1&&meshes[0]===object){if(shape==='convex')return this.addConvex(object,o);
      if(shape==='auto'){const frame=this._frame(object,o);return this._fitted(this._isRound(object,frame)?'sphere':'box',object,o);}return this._fitted(shape,object,o);}
    if(o.compound===false){if(shape==='convex')return this.addConvex(object,o);return this._fitted(shape==='auto'?'box':shape,object,o);}
    if(shape==='convex')return this.addConvex(object,{...o,compound:true});
    const T=this.THREE,frame=this._frame(object,o),box=this._boundsInFrame(meshes,frame,new T.Box3()),shapes=[];
    for(const m of meshes){const kind=shape==='auto'?(this._isRound(m,frame)?'sphere':'box'):shape;shapes.push({desc:this._meshPrimitive(m,frame,kind,o)});}
    return this._makeBody(object,{...this._shapeOpts(o,'compound',box),_frame:frame},shapes);
  }
  /* Fixed heightfield sampled from heightAt(x,z) on a (resolutionX+1)x(resolutionZ+1) grid covering [minX,minX+sizeX]x[minZ,minZ+sizeZ]. */
  addHeightfield(o={}){
    const R=this.RAPIER,T=this.THREE;if(typeof o.heightAt!=='function')throw new TypeError('KE.Physics3D.addHeightfield: heightAt(x,z) required');
    const minX=o.minX||0,minZ=o.minZ||0,sizeX=o.sizeX,sizeZ=o.sizeZ;if(!(sizeX>0&&sizeZ>0))throw new RangeError('KE.Physics3D.addHeightfield: positive sizeX/sizeZ required');
    const res=o.resolution||128,nx=Math.max(1,Math.round(o.resolutionX||res)),nz=Math.max(1,Math.round(o.resolutionZ||res));
    const h=new Float32Array((nx+1)*(nz+1));let lo=Infinity,hi=-Infinity;
    // Rapier 0.19's heightfield raycast can miss rays running exactly along grid lines (non-watertight edge test),
    // and games often cast at exact grid coordinates. The grid is therefore shifted by ~1e-4 of a cell; heights
    // are sampled at the shifted positions, so the surface differs from heightAt by at most slope x offset.
    const ox=o.gridOffset===false?0:sizeX/nx*2.1e-4,oz=o.gridOffset===false?0:sizeZ/nz*1.3e-4,x0=minX+ox,z0=minZ+oz;
    // Rapier heightfield: rows run along Z, columns along X, column-major storage, centered on the body origin.
    for(let j=0;j<=nx;j++)for(let i=0;i<=nz;i++){const y=o.heightAt(x0+sizeX*j/nx,z0+sizeZ*i/nz);if(!Number.isFinite(y))throw new TypeError('KE.Physics3D.addHeightfield: non-finite height');h[i+j*(nz+1)]=y;lo=Math.min(lo,y);hi=Math.max(hi,y);}
    // optional placement (used by addTerrain for positioned/scaled terrain meshes): heights and grid live in the local frame
    const S=o._scale||new T.Vector3(1,1,1),Q=o._quaternion||new T.Quaternion(),P=new T.Vector3(x0+sizeX/2,0,z0+sizeZ/2).multiply(S).applyQuaternion(Q);if(o._position)P.add(o._position);
    const scale={x:sizeX*S.x,y:S.y,z:sizeZ*S.z},flags=o.fixInternalEdges!==false&&R.HeightFieldFlags?R.HeightFieldFlags.FIX_INTERNAL_EDGES:undefined;
    const desc=flags!=null?R.ColliderDesc.heightfield(nz,nx,h,scale,flags):R.ColliderDesc.heightfield(nz,nx,h,scale);
    const box=new T.Box3(new T.Vector3(-scale.x/2,lo*S.y,-scale.z/2),new T.Vector3(scale.x/2,hi*S.y,scale.z/2));
    const body=this._makeBody(null,{friction:.8,restitution:0,...o,type:'fixed',position:P,quaternion:Q,shape:'heightfield',bounds:box,userData:o.userData||{heightfield:true}},[{desc}]);
    body.heights=h;body.resolution={x:nx,z:nz};return body;
  }
  /* KE.terrain() meshes -> heightfield whose vertices coincide with the terrain grid (local x,z = .5 + i/sub).
     The meshes may be translated/rotated/scaled together (the first mesh's world transform is used).
     exact:true builds a trimesh from the rendered triangles instead (same diagonals, more memory). */
  addTerrain(terrain,o={}){
    if(!terrain||typeof terrain.heightAt!=='function'||!terrain.length)throw new TypeError('KE.Physics3D.addTerrain: pass the mesh array returned by KE.terrain()');
    const T=this.THREE;
    if(o.exact){const g=new T.Group();for(const m of terrain){m.updateWorldMatrix(true,false);const c=new T.Mesh(m.geometry,m.material);c.matrixAutoUpdate=false;c.matrix.copy(m.matrixWorld);g.add(c);}
      const body=this.addTrimesh(g,{friction:.8,restitution:0,...o});body.object=null;this._objectBody.delete(g);body.userData.terrain=true;return body;}
    const box=new T.Box3(),m0=terrain[0],P=new T.Vector3(),Q=new T.Quaternion(),S=new T.Vector3();
    for(const m of terrain){if(!m.geometry.boundingBox)m.geometry.computeBoundingBox();box.union(m.geometry.boundingBox);}
    m0.updateWorldMatrix(true,false);m0.matrixWorld.decompose(P,Q,S);
    const sub=terrain.sub||1,sx=box.max.x-box.min.x,sz=box.max.z-box.min.z;
    const body=this.addHeightfield({friction:.8,restitution:0,...o,heightAt:terrain.heightAt,minX:box.min.x,minZ:box.min.z,sizeX:sx,sizeZ:sz,
      resolutionX:Math.max(1,Math.round(sx*sub)),resolutionZ:Math.max(1,Math.round(sz*sub)),_position:P,_quaternion:Q,_scale:S});
    body.userData.terrain=true;return body;
  }
  /* Removes a body (and its colliders and joints). object:true also detaches the object; owned debris is always detached and its geometry disposed. */
  remove(body,{object=false}={}){
    if(!body||body.removed)return false;this._alive();body.removed=true;
    if(body._joints){for(const j of [...body._joints]){j.disposed=true;this.joints.delete(j);j.joint=null;}body._joints=null;}
    for(const v of [...this.vehicles])if(v.chassis===body)v.dispose();
    if(body.character&&!body.character.disposed){body.character.disposed=true;this.world.removeCharacterController(body.character.controller);this.characters.delete(body.character);}
    this._buoyancy.delete(body);this._followers.delete(body);this._forceBodies.delete(body);
    for(const c of body.colliders){this._colliderBody.delete(c.handle);this._sensors.delete(c.handle);}
    this.world.removeRigidBody(body.rigidBody);this.bodies.delete(body.id);
    if(body.object&&this._objectBody.get(body.object)===body)this._objectBody.delete(body.object);
    if(body.owned||object){const ob=body.object;if(ob){if(ob.parent)ob.parent.remove(ob);if(body.owned&&ob.geometry)ob.geometry.dispose();}}
    if(body.owned){const i=this._debris.indexOf(body);if(i>=0)this._debris.splice(i,1);}
    body.rigidBody=null;body.colliders=[];body.collider=null;
    this.events.emit('remove',body);return true;
  }

  /* ----- stepping ----- */
  step(dt){
    this._alive();
    if(this.paused||!(dt>0)){this._writeTransforms();return 0;}
    dt=Math.min(dt*this.timeScale,this.maxDelta);this.accumulator+=dt;let n=0;const h=this.fixedStep;
    while(this.accumulator>=h-1e-9&&n<this.maxSubSteps){this._substep();this.accumulator-=h;n++;}
    if(this.accumulator<0)this.accumulator=0;
    if(this.accumulator>=h){const keep=this.accumulator%h;this.droppedTime+=this.accumulator-keep;this.accumulator=keep;}
    this.alpha=this.interpolate?clamp(this.accumulator/h,0,1):1;
    this._writeTransforms();
    for(const v of this.vehicles)v._sync();
    if(n&&this._debug)this._updateDebug();
    this.lastSubSteps=n;return n;
  }
  _substep(){
    const h=this.fixedStep,prof=KE.profiler;
    if(this.events.listeners.has('beforeStep'))this.events.emit('beforeStep',h,this.time);
    for(const b of this._followers)this._follow(b);
    for(const rec of this._buoyancy.values())this._applyBuoyancy(rec,h);
    for(const v of this.vehicles)v._update(h);
    if(prof)prof.begin('physics.step');const t0=performance.now();
    this.world.step(this.eventQueue);
    const ms=performance.now()-t0;if(prof)prof.end('physics.step');this.lastStepMs=ms;this._stepMs+=(ms-this._stepMs)*(this.stepCount?.1:1);
    this.time+=h;this.stepCount++;
    for(const c of this.characters)c._pending=false;
    if(this._forceBodies.size){for(const b of this._forceBodies)if(!b.removed){b.rigidBody.resetForces(false);b.rigidBody.resetTorques(false);}this._forceBodies.clear();}
    this._collectActive();this._dispatchEvents();
    if(this.events.listeners.has('afterStep'))this.events.emit('afterStep',h,this.time);
  }
  _follow(b){const o=b.object;if(!o||b.removed)return;o.updateWorldMatrix(true,false);o.matrixWorld.decompose(this._tp,this._tq,this._ts);
    const rb=b.rigidBody;rb.setNextKinematicTranslation(setXYZ(this._a,this._tp));const q=this._q;q.x=this._tq.x;q.y=this._tq.y;q.z=this._tq.z;q.w=this._tq.w;rb.setNextKinematicRotation(q);
    b._prevP.copy(b._curP);b._prevQ.copy(b._curQ);b._curP.copy(this._tp);b._curQ.copy(this._tq);}
  /* Interpolation bookkeeping: only bodies Rapier reports active are read; bodies that just went to sleep are settled once. */
  _collectActive(){
    const next=this._liveNext;next.length=0;this._awake=0;
    this.world.forEachActiveRigidBody(this._activeCb);
    for(const b of this._live)if(b._stamp!==this.stepCount&&!b.removed){b._prevP.copy(b._curP);b._prevQ.copy(b._curQ);this._settle.push(b);}
    this._liveNext=this._live;this._live=next;
  }
  _writeTransforms(){const a=this.alpha;for(const b of this._live)if(!b.removed)this._writeBody(b,a);
    if(this._settle.length){for(const b of this._settle)if(!b.removed)this._writeBody(b,1);this._settle.length=0;}}
  _setWorldPose(o,p,q){const parent=o.parent;
    if(parent&&!isIdentity(parent.matrixWorld)){const inv=this._tm.copy(parent.matrixWorld).invert();p.applyMatrix4(inv);parent.matrixWorld.decompose(this._t4,this._tq3,this._ts);q.premultiply(this._tq3.invert());}
    o.position.copy(p);return q;}
  /* Interpolated world pose of a body for the given alpha (render state between the last two steps). */
  _pose(b,alpha,p,q){if(alpha>=1||!this.interpolate){p.copy(b._curP);q.copy(b._curQ);}else{p.lerpVectors(b._prevP,b._curP,alpha);q.copy(b._prevQ).slerp(b._curQ,alpha);}return p;}
  _writeBody(b,alpha,force){const o=b.object;if(!o||(!b._synced&&!force))return;
    const p=this._tp,q=this._tq;this._pose(b,alpha,p,q);
    if(b.objectOffset)p.add(this._t3.copy(b.objectOffset).applyQuaternion(b.syncRotation?q:this._tq2.set(0,0,0,1)));
    this._setWorldPose(o,p,q);if(b.syncRotation)o.quaternion.copy(q);}

  /* ----- events ----- */
  _dispatchEvents(){
    this._evN=0;this.eventQueue.drainCollisionEvents(this._collisionCb);
    const wantForces=this.events.listeners.has('contactForce')||this._hasForceBodies;
    if(wantForces){this._forceEvents.length=0;this.eventQueue.drainContactForceEvents(this._forceCb);}
    const L=this.events.listeners,wantContact=L.has('contact'),wantTrigger=L.has('trigger');
    for(let i=0;i<this._evN;i++){const h1=this._evH1[i],h2=this._evH2[i],started=this._evS[i]===1,s1=this._sensors.has(h1),s2=this._sensors.has(h2);
      if(!s1&&!s2)this._contacts=Math.max(0,this._contacts+(started?1:-1));
      const a=this._colliderBody.get(h1),b=this._colliderBody.get(h2);if(!a||!b||a.removed||b.removed)continue;
      if(s1||s2){const sensor=s1?a:b,other=s1?b:a;if(wantTrigger)this.events.emit('trigger',sensor,other,started);if(sensor.onTrigger&&!sensor.removed)sensor.onTrigger(other,started);
        if(other!==sensor&&other.onTrigger&&!other.removed)other.onTrigger(sensor,started);continue;}
      if(!wantContact&&!a.onContact&&!b.onContact)continue;
      const info={started,impulse:0,point:null,normal:null,colliderA:h1,colliderB:h2};
      if(started)this._contactInfo(h1,h2,info);
      if(wantContact)this.events.emit('contact',a,b,info);
      if(a.onContact&&!a.removed)a.onContact(b,info);if(b.onContact&&!b.removed&&!a.removed)b.onContact(a,info);}
    if(wantForces)for(const e of this._forceEvents){const a=this._colliderBody.get(e.h1),b=this._colliderBody.get(e.h2);if(!a||!b||a.removed||b.removed)continue;
      const info={magnitude:e.magnitude,force:new this.THREE.Vector3(e.force.x,e.force.y,e.force.z),direction:new this.THREE.Vector3(e.maxDirection.x,e.maxDirection.y,e.maxDirection.z)};
      this.events.emit('contactForce',a,b,info);if(a.onContactForce)a.onContactForce(b,info);if(b.onContactForce)b.onContactForce(a,info);}
  }
  _contactInfo(h1,h2,info){const c1=this.world.getCollider(h1),c2=this.world.getCollider(h2);if(!c1||!c2)return;let imp=0,px=0,py=0,pz=0,np=0,nx=0,ny=0,nz=0;
    this.world.contactPair(c1,c2,(m,flipped)=>{const nc=m.numContacts();for(let i=0;i<nc;i++)imp+=m.contactImpulse(i);const ns=m.numSolverContacts();
      for(let i=0;i<ns;i++){const p=m.solverContactPoint(i);px+=p.x;py+=p.y;pz+=p.z;np++;}const n=m.normal(),s=flipped?-1:1;nx+=n.x*s;ny+=n.y*s;nz+=n.z*s;});
    info.impulse=imp;if(np)info.point=new this.THREE.Vector3(px/np,py/np,pz/np);const l=Math.hypot(nx,ny,nz);if(l>0)info.normal=new this.THREE.Vector3(nx/l,ny/l,nz/l);}

  /* ----- scene queries ----- */
  _queryArgs(o){const R=this.RAPIER;let flags=o.solidOnly===false?undefined:R.QueryFilterFlags.EXCLUDE_SENSORS;
    if(o.dynamicOnly)flags=(flags||0)|R.QueryFilterFlags.EXCLUDE_FIXED|R.QueryFilterFlags.EXCLUDE_KINEMATIC;
    const groups=o.groups!=null?interactionGroups(o.groups):undefined;let exRb,pred;
    if(o.exclude){const ex=Array.isArray(o.exclude)?o.exclude:[o.exclude];if(ex.length===1&&ex[0]&&ex[0].rigidBody)exRb=ex[0].rigidBody;
      else{const set=new Set(ex);pred=c=>!set.has(this._colliderBody.get(c.handle));}}
    if(o.filter){const f=o.filter,prev=pred;pred=c=>{const b=this._colliderBody.get(c.handle);return (!prev||prev(c))&&!!b&&f(b);};}
    return {flags,groups,exRb,pred};}
  raycast(origin,direction,maxDistance=1000,o={}){
    this._alive();const R=this.RAPIER,T=this.THREE,org=readVec(origin,this._t1),dir=readVec(direction,this._t2).normalize(),q=this._queryArgs(o);
    const hit=this.world.castRayAndGetNormal(new R.Ray({x:org.x,y:org.y,z:org.z},{x:dir.x,y:dir.y,z:dir.z}),maxDistance,o.solid!==false,q.flags,q.groups,undefined,q.exRb,q.pred);
    if(!hit)return null;const d=hit.timeOfImpact;
    return {body:this._colliderBody.get(hit.collider.handle)||null,collider:hit.collider,distance:d,point:new T.Vector3(org.x+dir.x*d,org.y+dir.y*d,org.z+dir.z*d),normal:new T.Vector3(hit.normal.x,hit.normal.y,hit.normal.z)};
  }
  raycastAll(origin,direction,maxDistance=1000,o={}){
    this._alive();const R=this.RAPIER,T=this.THREE,org=readVec(origin,new T.Vector3()),dir=readVec(direction,new T.Vector3()).normalize(),q=this._queryArgs(o),out=[];
    this.world.intersectionsWithRay(new R.Ray({x:org.x,y:org.y,z:org.z},{x:dir.x,y:dir.y,z:dir.z}),maxDistance,o.solid!==false,hit=>{const d=hit.timeOfImpact;
      out.push({body:this._colliderBody.get(hit.collider.handle)||null,collider:hit.collider,distance:d,point:new T.Vector3().copy(dir).multiplyScalar(d).add(org),normal:new T.Vector3(hit.normal.x,hit.normal.y,hit.normal.z)});return true;},q.flags,q.groups,undefined,q.exRb,q.pred);
    return out.sort((a,b)=>a.distance-b.distance);
  }
  _shape(s){const R=this.RAPIER;if(!s)throw new TypeError('KE.Physics3D: shape required');if(typeof s.intoRaw==='function')return s;
    const t=s.type||'ball';if(t==='ball'||t==='sphere')return new R.Ball(s.radius||.5);if(t==='capsule')return new R.Capsule(s.halfHeight||.5,s.radius||.3);if(t==='cylinder')return new R.Cylinder(s.halfHeight||.5,s.radius||.3);
    const he=readVec(s.halfExtents||[.5,.5,.5],this._t3);return new R.Cuboid(he.x,he.y,he.z);}
  /* Sweeps a shape ({type:'ball'|'box'|'capsule'|'cylinder', radius, halfExtents, halfHeight} or a Rapier Shape) along direction. */
  shapeCast(shape,origin,rotation,direction,maxDistance=1000,o={}){
    this._alive();const T=this.THREE,org=readVec(origin,new T.Vector3()),dir=readVec(direction,new T.Vector3()).normalize(),rot=readQuat(rotation,new T.Quaternion(),T),q=this._queryArgs(o);
    const hit=this.world.castShape({x:org.x,y:org.y,z:org.z},{x:rot.x,y:rot.y,z:rot.z,w:rot.w},{x:dir.x,y:dir.y,z:dir.z},this._shape(shape),o.targetDistance||0,maxDistance,o.stopAtPenetration!==false,q.flags,q.groups,undefined,q.exRb,q.pred);
    if(!hit)return null;const d=hit.time_of_impact;
    return {body:this._colliderBody.get(hit.collider.handle)||null,collider:hit.collider,distance:d,position:dir.clone().multiplyScalar(d).add(org),point:new T.Vector3(hit.witness1.x,hit.witness1.y,hit.witness1.z),normal:new T.Vector3(hit.normal1.x,hit.normal1.y,hit.normal1.z)};
  }
  sphereCast(origin,radius,direction,maxDistance=1000,o={}){return this.shapeCast({type:'ball',radius},origin,null,direction,maxDistance,o);}
  overlapShape(shape,center,rotation,o={}){this._alive();const T=this.THREE,c=readVec(center,new T.Vector3()),rot=readQuat(rotation,new T.Quaternion(),T),q=this._queryArgs(o),set=new Set();
    this.world.intersectionsWithShape({x:c.x,y:c.y,z:c.z},{x:rot.x,y:rot.y,z:rot.z,w:rot.w},this._shape(shape),col=>{const b=this._colliderBody.get(col.handle);if(b)set.add(b);return true;},q.flags,q.groups,undefined,q.exRb,q.pred);
    return [...set];}
  overlapSphere(center,radius,o={}){return this.overlapShape({type:'ball',radius},center,null,o);}
  overlapBox(center,halfExtents,rotation,o={}){return this.overlapShape({type:'box',halfExtents},center,rotation,o);}

  /* ----- character, joints, vehicle ----- */
  character(object,o={}){this._alive();return new CharacterController(this,object,o);}
  _worldAnchor(){if(!this._ground||this._ground.removed)this._ground=this._makeBody(null,{type:'fixed',position:[0,0,0],userData:{worldAnchor:true},shape:'none',events:false},[]);return this._ground;}
  joint(bodyA,bodyB,o={}){
    this._alive();const R=this.RAPIER,T=this.THREE,type=o.type||'ball';
    if(!bodyA||bodyA.removed)throw new TypeError('KE.Physics3D.joint: bodyA required');const b=bodyB||this._worldAnchor();if(b.removed)throw new TypeError('KE.Physics3D.joint: bodyB removed');
    const pa=bodyA._curP,qa=bodyA._curQ,pb=b._curP,qb=b._curQ;
    // anchors: explicit local anchors, or a world-space anchor, or body A's origin; the missing side keeps the current relative placement
    const world=new T.Vector3();let aA,aB;
    if(o.anchor!=null){readVec(o.anchor,world);aA=world.clone().sub(pa).applyQuaternion(qa.clone().invert());aB=world.clone().sub(pb).applyQuaternion(qb.clone().invert());}
    else{aA=readVec(o.anchorA||[0,0,0],new T.Vector3());world.copy(aA).applyQuaternion(qa).add(pa);
      // distance joints default to B's origin; the others keep the current relative placement (anchor coincides with A's anchor)
      aB=o.anchorB!=null?readVec(o.anchorB,new T.Vector3()):(type==='rope'||type==='spring')?new T.Vector3():world.clone().sub(pb).applyQuaternion(qb.clone().invert());}
    const axis=readVec(o.axis||[0,1,0],new T.Vector3()).normalize(),A={x:aA.x,y:aA.y,z:aA.z},B={x:aB.x,y:aB.y,z:aB.z},X={x:axis.x,y:axis.y,z:axis.z};
    let data;const worldB=new T.Vector3().copy(aB).applyQuaternion(qb).add(pb),dist=world.distanceTo(worldB);
    switch(type){
      case 'fixed':{const f2=qb.clone().invert().multiply(qa);data=R.JointData.fixed(A,{x:0,y:0,z:0,w:1},B,{x:f2.x,y:f2.y,z:f2.z,w:f2.w});break;}
      case 'ball':case 'spherical':data=R.JointData.spherical(A,B);break;
      case 'hinge':case 'revolute':data=R.JointData.revolute(A,B,X);break;
      case 'prismatic':case 'slider':data=R.JointData.prismatic(A,B,X);break;
      case 'rope':data=R.JointData.rope(o.length!=null?o.length:Math.max(dist,1e-3),A,B);break;
      case 'spring':data=R.JointData.spring(o.length!=null?o.length:dist,o.stiffness==null?50:o.stiffness,o.damping==null?2:o.damping,A,B);break;
      default:throw new RangeError('KE.Physics3D.joint: unknown type '+type);}
    if(o.limits&&(type==='hinge'||type==='revolute'||type==='prismatic'||type==='slider')){data.limitsEnabled=true;data.limits=[o.limits[0],o.limits[1]];}
    const raw=this.world.createImpulseJoint(data,bodyA.rigidBody,b.rigidBody,true);
    if(o.limits&&typeof raw.setLimits==='function')raw.setLimits(o.limits[0],o.limits[1]);
    if(o.collide===false||o.contacts===false)raw.setContactsEnabled(false);
    const j=new Joint(this,raw,type==='revolute'?'hinge':type==='slider'?'prismatic':type==='spherical'?'ball':type,bodyA,b,axis);
    if(j.type==='hinge')j._angle0=j._rawAngle();
    if(o.motor)j.setMotor(o.motor);
    for(const body of [bodyA,b]){(body._joints||(body._joints=new Set())).add(j);}
    this.joints.add(j);return j;
  }
  vehicle(chassis,o={}){this._alive();if(!this.RAPIER.DynamicRayCastVehicleController||typeof this.world.createVehicleController!=='function')throw new Error('KE.Physics3D.vehicle: this Rapier build has no DynamicRayCastVehicleController');
    if(!chassis||chassis.removed||chassis.type!=='dynamic')throw new TypeError('KE.Physics3D.vehicle: a dynamic chassis body is required');return new Vehicle(this,chassis,o);}

  /* ----- destruction ----- */
  /* Splits a mesh body into convex Voronoi chunks (see fractureGeometry). Pieces inherit the body's collider
     material, velocity (including spin) and userData, share its render material(s) and are owned by the world. */
  fracture(body,o={}){
    this._alive();if(!body||body.removed)throw new TypeError('KE.Physics3D.fracture: live body required');
    const mesh=body.object,T=this.THREE;if(!mesh||!mesh.isMesh)throw new TypeError('KE.Physics3D.fracture: the body object must be a Mesh');
    const rb=body.rigidBody,P=body._curP.clone(),Q=body._curQ.clone(),S=new T.Vector3();
    mesh.updateWorldMatrix(true,false);mesh.matrixWorld.decompose(this._t4,this._tq3,S);
    const invQ=Q.clone().invert();const local=o.point?readVec(o.point,new T.Vector3()).sub(P).applyQuaternion(invQ):null;
    const baseMat=mesh.material,interior=o.interiorMaterial||null;let materials=baseMat,interiorIndex=null;
    if(interior){materials=Array.isArray(baseMat)?baseMat.slice():[baseMat];interiorIndex=materials.length;materials.push(interior);}
    const want=o.pieces==null?8:o.pieces,pieceCount=o.quality?Math.max(2,Math.round(want*clamp(KE.settings&&Number.isFinite(KE.settings.vfx)?KE.settings.vfx:1,.25,1))):want;
    const res=fractureGeometry(T,mesh.geometry,{scale:S,pieces:pieceCount,seed:o.seed==null?(this._fractureSeed++)*7919:o.seed,point:local,minSize:o.minSize,
      interiorMaterialIndex:interiorIndex,uvScale:o.uvScale,spread:o.spread,impactBias:o.impactBias,forceHull:o.forceHull});
    if(res.pieces.length<2)return [body];
    const c0=body.collider,friction=o.friction!=null?o.friction:c0?c0.friction():this.defaults.friction,restitution=o.restitution!=null?o.restitution:c0?c0.restitution():this.defaults.restitution;
    let density=o.density;if(density==null){const vol=body.colliders.reduce((s,c)=>s+Math.max(0,c.volume()||0),0);density=vol>0&&rb.mass()>0?rb.mass()/vol:c0?c0.density():this.defaults.density;}
    const lin=rb.linvel(),ang=rb.angvel(),com=rb.worldCom(),v0=new T.Vector3(lin.x,lin.y,lin.z),w0=new T.Vector3(ang.x,ang.y,ang.z),cm=new T.Vector3(com.x,com.y,com.z);
    const groups=c0?c0.collisionGroups():undefined,parent=mesh.parent||this.scene,pieces=[];
    const impulse=o.impulse?readVec(o.impulse,new T.Vector3()):null,point=o.point?readVec(o.point,new T.Vector3()):null;
    for(const piece of res.pieces){
      const m=new T.Mesh(piece.geometry,materials);m.castShadow=mesh.castShadow;m.receiveShadow=mesh.receiveShadow;m.name=(mesh.name||'body')+'-piece';
      const wp=piece.centroid.clone().applyQuaternion(Q).add(P);m.userData={...mesh.userData};
      if(parent){parent.add(m);parent.updateWorldMatrix(true,false);const q=Q.clone();this._setWorldPose(m,wp.clone(),q);m.quaternion.copy(q);parent.matrixWorld.decompose(this._t4,this._tq3,this._ts);m.scale.set(1/(this._ts.x||1),1/(this._ts.y||1),1/(this._ts.z||1));}else{m.position.copy(wp);m.quaternion.copy(Q);}
      m.updateWorldMatrix(false,false);
      const nb=this.addConvex(m,{type:'dynamic',friction,restitution,density,groups,ccd:o.ccd,linearDamping:o.linearDamping,angularDamping:o.angularDamping,position:wp,quaternion:Q,
        userData:{...body.userData,fractureOf:body.id},onContact:o.inheritCallbacks?body.onContact:null});
      nb.owned=true;nb.volume=piece.volume;
      const r=this._t1.copy(wp).sub(cm),vel=this._t2.copy(w0).cross(r).add(v0);nb.rigidBody.setLinvel(setXYZ(this._a,vel),true);nb.rigidBody.setAngvel(setXYZ(this._a,w0),true);
      pieces.push(nb);}
    // distribute the impulse: weighted by mass and proximity to the impact point, plus an outward scatter
    if(impulse&&impulse.lengthSq()>0){const size=body.radius*2,R=Math.max(size*.45,.05),center=point||P,ws=pieces.map(pb=>{const d=pb._curP.distanceTo(center);return pb.volume*density*Math.exp(-(d*d)/(R*R));});
      const sum=ws.reduce((a,b)=>a+b,0)||1,mag=impulse.length(),scatter=o.scatter==null?.35:o.scatter;
      pieces.forEach((pb,i)=>{const w=ws[i]/sum,out=this._t3.copy(pb._curP).sub(center);if(out.lengthSq()<1e-10)out.set(0,1,0);out.normalize();
        const imp=this._t4.copy(impulse).multiplyScalar(w).addScaledVector(out,mag*scatter*w);const at=this._t2.copy(pb._curP).lerp(center,.25);
        pb.rigidBody.applyImpulseAtPoint(setXYZ(this._a,imp),setXYZ(this._b,at),true);});}
    const wasOwned=body.owned;
    this.remove(body);if(!wasOwned&&o.keepObject!==true&&mesh.parent)mesh.parent.remove(mesh);
    for(const pb of pieces)this._debris.push(pb);
    while(this.maxDebris>=0&&this._debris.length>this.maxDebris){const old=this._debris.shift();if(!old.removed)this.remove(old);}
    this.events.emit('fracture',body,pieces);
    return pieces;
  }
  /* Radial impulse with linear falloff; mode:'velocity' treats strength as a velocity change (mass independent). */
  explode(center,radius,strength,o={}){
    this._alive();const T=this.THREE,c=readVec(center,new T.Vector3()),up=o.upward==null?.3:o.upward,list=this.overlapSphere(c,radius,{...o,dynamicOnly:true});let n=0;
    for(const b of list){if(b.removed||b.type!=='dynamic')continue;const rb=b.rigidBody,com=rb.worldCom(),d=this._t1.set(com.x-c.x,com.y-c.y,com.z-c.z),dist=d.length();
      const fall=o.falloff==='none'?1:clamp(1-dist/radius,0,1);if(fall<=0)continue;
      if(dist<1e-6)d.set(0,1,0);else d.divideScalar(dist);d.y+=up;d.normalize();
      let mag=strength*(o.falloff==='quadratic'?fall*fall:fall);if(o.mode==='velocity')mag*=rb.mass();
      const at=this._t2.set(com.x,com.y,com.z).addScaledVector(d,-Math.min(b.radius*.35,dist*.5));
      rb.applyImpulseAtPoint(setXYZ(this._a,d.multiplyScalar(mag)),setXYZ(this._b,at),true);n++;}
    return n;
  }

  /* ----- buoyancy ----- */
  /* Per-sample-point Archimedes force (fluid density x g x point volume x submerged fraction) plus linear drag
     proportional to the displaced fluid mass (drag x density x point volume x fraction x point velocity) and
     angular damping. Applied as one-step forces so Rapier integrates them per solver substep like gravity. Sample points default to a 2x2x2 grid over the
     body's local bounds, which is exact for axis-aligned boxes (the equilibrium draft is linear in depth). */
  addBuoyancy(body,o={}){
    this._alive();if(!body||body.removed||body.type!=='dynamic')throw new TypeError('KE.Physics3D.addBuoyancy: a dynamic body is required');
    const T=this.THREE,b=body.localBounds,size=b.getSize(new T.Vector3()),pts=[];
    let cellH;
    if(Array.isArray(o.samplePoints)){for(const p of o.samplePoints)pts.push(readVec(p,new T.Vector3()));cellH=o.pointHeight||size.y/2;}
    else{const n=Math.max(1,Math.round(o.samplePoints>0?o.samplePoints:2));cellH=size.y/n;
      for(let i=0;i<n;i++)for(let j=0;j<n;j++)for(let k=0;k<n;k++)pts.push(new T.Vector3(b.min.x+size.x*(i+.5)/n,b.min.y+size.y*(j+.5)/n,b.min.z+size.z*(k+.5)/n));}
    const volume=o.volume!=null?o.volume:body.colliders.reduce((s,c)=>s+Math.max(0,c.volume()||0),0);
    const rec={body,points:pts,cellH:Math.max(cellH,1e-3),volume,waterLevel:o.waterLevel==null?0:o.waterLevel,density:o.density==null?1:o.density,drag:o.drag==null?1.5:o.drag,angularDrag:o.angularDrag==null?1:o.angularDrag,submerged:0};
    this._buoyancy.set(body,rec);const self=this;
    return {record:rec,get submerged(){return rec.submerged;},set waterLevel(v){rec.waterLevel=v;},get waterLevel(){return rec.waterLevel;},dispose(){self._buoyancy.delete(body);}};
  }
  _applyBuoyancy(rec,h){
    const b=rec.body;if(b.removed){this._buoyancy.delete(b);return;}const rb=b.rigidBody,fn=typeof rec.waterLevel==='function';
    if(!fn&&rb.isSleeping())return;
    const t=rb.translation(),r=rb.rotation(),lv=rb.linvel(),av=rb.angvel(),com=rb.worldCom(),q=this._tq.set(r.x,r.y,r.z,r.w),p=this._t1,g=Math.abs(this.gravity.y);
    const n=rec.points.length,vi=rec.volume/n;let sub=0;
    for(let i=0;i<n;i++){p.copy(rec.points[i]).applyQuaternion(q);p.x+=t.x;p.y+=t.y;p.z+=t.z;
      const level=fn?rec.waterLevel(p.x,p.z,this.time):rec.waterLevel,frac=clamp((level-p.y)/rec.cellH+.5,0,1);if(frac<=0)continue;sub+=frac;
      const rx=p.x-com.x,ry=p.y-com.y,rz=p.z-com.z,vx=lv.x+av.y*rz-av.z*ry,vy=lv.y+av.z*rx-av.x*rz,vz=lv.z+av.x*ry-av.y*rx,k=rec.drag*rec.density*vi*frac;
      const a=this._a;a.x=-vx*k;a.y=rec.density*g*vi*frac-vy*k;a.z=-vz*k;rb.addForceAtPoint(a,setXYZ(this._b,p),true);}
    rec.submerged=sub/n;if(sub>0)this._forceBodies.add(b);
    if(sub>0&&rec.angularDrag>0){const f=Math.exp(-rec.angularDrag*rec.submerged*h),w=rb.angvel(),a=this._a;a.x=w.x*f;a.y=w.y*f;a.z=w.z*f;rb.setAngvel(a,true);}
  }

  /* ----- debug renderer ----- */
  /* Collider wireframes from world.debugRender(); options {fixed:true, sensors:true, filter(body)->bool, opacity:.9}.
     Lines show the latest simulated pose, up to one fixed step ahead of interpolated meshes. */
  debug(scene=this.scene,enabled=true,o={}){
    this._alive();
    if(enabled&&typeof enabled==='object'){o=enabled;enabled=true;}
    if(!enabled){if(this._debug){const d=this._debug;if(d.lines.parent)d.lines.parent.remove(d.lines);d.lines.geometry.dispose();d.lines.material.dispose();this._debug=null;}return this;}
    if(!scene)throw new TypeError('KE.Physics3D.debug: scene required');const T=this.THREE;
    if(!this._debug){const geo=new T.BufferGeometry(),mat=new T.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.9,depthTest:true,toneMapped:false});
      const lines=new T.LineSegments(geo,mat);lines.frustumCulled=false;lines.renderOrder=999;lines.name='physics-debug';this._debug={lines,capacity:0,flags:undefined,pred:undefined};}
    const d=this._debug,R=this.RAPIER;let flags=0;if(o.fixed===false)flags|=R.QueryFilterFlags.EXCLUDE_FIXED;if(o.sensors===false)flags|=R.QueryFilterFlags.EXCLUDE_SENSORS;
    d.flags=flags||undefined;d.pred=typeof o.filter==='function'?(c=>{const b=this._colliderBody.get(c.handle);return !!b&&o.filter(b);}):undefined;
    if(o.opacity!=null)d.lines.material.opacity=o.opacity;
    if(d.lines.parent!==scene)scene.add(d.lines);this._updateDebug();return this;
  }
  _updateDebug(){const d=this._debug,T=this.THREE,buf=this.world.debugRender(d.flags,d.pred),nv=buf.vertices.length/3;
    if(nv>d.capacity){let cap=Math.max(1024,d.capacity);while(cap<nv)cap*=2;const g=d.lines.geometry;
      g.setAttribute('position',new T.BufferAttribute(new Float32Array(cap*3),3).setUsage(T.DynamicDrawUsage));g.setAttribute('color',new T.BufferAttribute(new Float32Array(cap*4),4).setUsage(T.DynamicDrawUsage));d.capacity=cap;}
    const g=d.lines.geometry,pa=g.attributes.position,ca=g.attributes.color;pa.array.set(buf.vertices);ca.array.set(buf.colors);
    pa.updateRange.offset=0;pa.updateRange.count=nv*3;ca.updateRange.offset=0;ca.updateRange.count=nv*4;pa.needsUpdate=true;ca.needsUpdate=true;g.setDrawRange(0,nv);d.vertexCount=nv;}

  /* ----- stats & teardown ----- */
  stats(){this._alive();let sleeping=0,dynamic=0;for(const b of this.bodies.values()){if(b.type==='dynamic')dynamic++;if(b.type!=='fixed'&&b.rigidBody.isSleeping())sleeping++;}
    return {bodies:this.world.bodies.len(),colliders:this.world.colliders.len(),joints:this.joints.size,dynamic,sleeping,awake:this._awake,contacts:this._contacts,
      characters:this.characters.size,vehicles:this.vehicles.size,debris:this._debris.length,stepMs:this._stepMs,lastStepMs:this.lastStepMs,substeps:this.lastSubSteps,time:this.time,droppedTime:this.droppedTime};}
  /* Frees the Rapier world, event queue, controllers and debug lines; owned debris meshes are detached and their geometry disposed. */
  dispose(){
    if(this.disposed)return;
    if(this._debug)this.debug(null,false);
    for(const v of [...this.vehicles])v.dispose();
    for(const c of [...this.characters]){c.disposed=true;this.world.removeCharacterController(c.controller);c.controller=null;}this.characters.clear();
    for(const j of this.joints){j.disposed=true;j.joint=null;}this.joints.clear();
    for(const b of this.bodies.values()){if(b.owned&&b.object){if(b.object.parent)b.object.parent.remove(b.object);if(b.object.geometry)b.object.geometry.dispose();}
      b.removed=true;b.rigidBody=null;b.colliders=[];b.collider=null;b._joints=null;}
    this.bodies.clear();this._colliderBody.clear();this._sensors.clear();this._followers.clear();this._forceBodies.clear();this._buoyancy.clear();
    this._live.length=0;this._liveNext.length=0;this._settle.length=0;this._debris.length=0;
    this.eventQueue.free();this.world.free();this.eventQueue=null;this.world=null;this.disposed=true;
    this.events.emit('dispose',this);this.events.clear();
  }
}

/* ---------- public namespace ---------- */
KE.Physics3D={
  get available(){return typeof window!=='undefined'&&!!window.RAPIER;},
  init:loadRapier,
  async create(THREE,opts={}){if(!THREE||!THREE.Vector3)throw new TypeError('KE.Physics3D.create(THREE, options): THREE is required');const R=await loadRapier();return new PhysicsWorld(THREE,R,opts);},
  groups:(membership,filter)=>interactionGroups({membership,filter}),
  fractureGeometry,
  World:PhysicsWorld,Body,Joint,CharacterController,Vehicle
};
KE.registerModule('physics3d',{provides:['Physics3D']});
})();
