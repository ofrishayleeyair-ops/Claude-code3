/* kitsune enginev3 AI: navigation mesh, crowds, behavior trees, perception, environment queries.
   KE.NavMesh    Recast-inspired tiled navmesh built from a heightfield: walkable-cell rasterization (slope, step,
                 water, blockers, obstacles), erosion by agent radius (exact Euclidean distance transform),
                 contour tracing, constrained Douglas-Peucker simplification, ear clipping + Delaunay edge flips,
                 convex merging. A* over portal points + funnel string pulling, raycasts, dynamic obstacles
                 (per-tile re-carve), JSON round trip, debug overlays.
   KE.Crowd      corridor following + ORCA (reciprocal velocity obstacles) avoidance with a spatial hash,
                 collision resolution and mesh clamping.
   KE.BT         behavior trees with UE-style observer aborts ('self' | 'lower' | 'both'); KE.Blackboard.
   KE.Perception sight (range, FOV, line of sight, detection time), hearing, memory.
   KE.EQS        environment queries (generators + weighted/filtering tests).
   KE.FSM, KE.steering  small state machine and Reynolds steering behaviours.
   Core's KE.findPath (grid A*) is untouched. Randomness is seeded through KE.random. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=KE.clamp||((v,a,b)=>v<a?a:v>b?b:v);
const DEG=Math.PI/180;
const SUCCESS='success',FAILURE='failure',RUNNING='running';
const hasOwn=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const isFn=f=>typeof f==='function';
const num=(v,d)=>Number.isFinite(v)?v:d;

/* ======================================================================
   Navigation mesh
   ====================================================================== */
/* Lattice direction vectors: 0:+u 1:+v 2:-u 3:-v. A cell side s is walked in direction s with the cell on
   its left (so outer contours are counter-clockwise in x/z), and its outward normal is DIRS[OUT[s]]. */
const DIRS=[[1,0],[0,1],[-1,0],[0,-1]],OUT=[3,0,1,2];

function normObstacle(o){
  if(!o||typeof o!=='object')throw new TypeError('Obstacle must be an object');
  if(o.r!==undefined){const x=+o.x,z=+o.z,r=+o.r;if(![x,z,r].every(Number.isFinite)||r<=0)throw new TypeError('Circle obstacle needs finite x, z and r>0');
    return {kind:'circle',x,z,r,minX:x-r,maxX:x+r,minZ:z-r,maxZ:z+r};}
  if(o.hx!==undefined||o.hz!==undefined){const x=+o.x,z=+o.z,hx=+o.hx,hz=+o.hz,rot=num(+o.rotation,0);if(![x,z,hx,hz].every(Number.isFinite)||hx<=0||hz<=0)throw new TypeError('Box obstacle needs finite x, z, hx>0, hz>0');
    const c=Math.cos(rot),s=Math.sin(rot),ex=Math.abs(c)*hx+Math.abs(s)*hz,ez=Math.abs(s)*hx+Math.abs(c)*hz;
    return {kind:'obb',x,z,hx,hz,rotation:rot,c,s,minX:x-ex,maxX:x+ex,minZ:z-ez,maxZ:z+ez};}
  const b=['minX','minZ','maxX','maxZ'].map(k=>+o[k]);
  if(b.every(Number.isFinite)&&b[2]>b[0]&&b[3]>b[1])return {kind:'box',minX:b[0],minZ:b[1],maxX:b[2],maxZ:b[3]};
  throw new TypeError('Obstacle needs {x,z,r}, {minX,minZ,maxX,maxZ} or {x,z,hx,hz,rotation}');
}
function obstacleContains(o,x,z){
  if(o.kind==='circle'){const dx=x-o.x,dz=z-o.z;return dx*dx+dz*dz<=o.r*o.r;}
  if(o.kind==='box')return x>=o.minX&&x<=o.maxX&&z>=o.minZ&&z<=o.maxZ;
  const dx=x-o.x,dz=z-o.z,lx=dx*o.c+dz*o.s,lz=-dx*o.s+dz*o.c;return Math.abs(lx)<=o.hx&&Math.abs(lz)<=o.hz;
}
function obstacleJSON(o){return o.kind==='circle'?{x:o.x,z:o.z,r:o.r}:o.kind==='box'?{minX:o.minX,minZ:o.minZ,maxX:o.maxX,maxZ:o.maxZ}:{x:o.x,z:o.z,hx:o.hx,hz:o.hz,rotation:o.rotation};}

/* Exact squared Euclidean distance transform (Felzenszwalb & Huttenlocher), 1D pass along a strided line. */
function edt1d(g,off,stride,len,f,v,z){
  v[0]=0;z[0]=-1e20;z[1]=1e20;f[0]=g[off];
  for(let q=1,k=0,s=0;q<len;q++){f[q]=g[off+q*stride];const q2=q*q;
    do{const r=v[k];s=(f[q]-f[r]+q2-r*r)/(q-r)/2;}while(s<=z[k]&&--k>-1);
    k++;v[k]=q;z[k]=s;z[k+1]=1e20;}
  for(let q=0,k=0;q<len;q++){while(z[k+1]<q)k++;const r=v[k],d=q-r;g[off+q*stride]=f[r]+d*d;}
}

/* Run-length encoding of 0/1 grids for JSON (alternating runs starting with 0). */
function rleEncode(a){const out=[];let cur=0,run=0;for(let i=0;i<a.length;i++){const v=a[i]?1:0;if(v===cur)run++;else{out.push(run);cur=v;run=1;}}out.push(run);return out;}
function rleDecode(runs,n){const a=new Uint8Array(n);if(!Array.isArray(runs))throw new TypeError('Invalid navmesh grid');let p=0,v=0;for(const r of runs){if(!Number.isInteger(r)||r<0||p+r>n)throw new RangeError('Invalid navmesh grid run');if(v)a.fill(1,p,p+r);p+=r;v^=1;}if(p!==n)throw new RangeError('Navmesh grid size mismatch');return a;}

/* ---------- contour tracing ---------- */
/* Traces every boundary loop of one 4-connected component (inC) of a tile. Each point records the direction
   of the edge leaving it, whether that edge lies on the tile border, and whether it is a saddle (two cells of
   the component touching diagonally). The left-hand rule keeps diagonal-only contacts separated. */
function traceLoops(tw,th,inC,cells){
  const visited=new Uint8Array(tw*th),loops=[];
  for(const k of cells){const i=k%tw,j=(k/tw)|0;
    for(let s=0;s<4;s++){
      if(visited[k]&(1<<s))continue;const o=DIRS[OUT[s]];if(inC(i+o[0],j+o[1]))continue;
      const loop=[];let ci=i,cj=j,cs=s,saddle=false,guard=0;
      do{
        visited[cj*tw+ci]|=1<<cs;
        const su=cs===0||cs===3?ci:ci+1,sv=cs===0||cs===1?cj:cj+1;
        const od=DIRS[OUT[cs]],ou=ci+od[0],ov=cj+od[1];
        let u=su,v=sv;if(saddle){u+=(ci+.5-su)*.2;v+=(cj+.5-sv)*.2;}
        loop.push({u,v,d:cs,border:ou<0||ov<0||ou>=tw||ov>=th,saddle});
        const D=DIRS[cs],ai=ci+D[0],aj=cj+D[1],di=ai+od[0],dj=aj+od[1];
        if(!inC(ai,aj)){saddle=inC(di,dj);cs=(cs+1)&3;}          // convex corner: turn left around the same cell
        else if(inC(di,dj)){ci=di;cj=dj;cs=(cs+3)&3;saddle=false;} // concave corner: turn right
        else{ci=ai;cj=aj;saddle=false;}                           // straight on
        if(++guard>4*tw*th+8)throw new Error('NavMesh contour trace failed');
      }while(!(ci===i&&cj===j&&cs===s));
      if(saddle){const p=loop[0];p.saddle=true;p.u+=(i+.5-p.u)*.2;p.v+=(j+.5-p.v)*.2;}
      loops.push(loop);
    }
  }
  return loops;
}
const segDist2=(p,a,b)=>{const dx=b.u-a.u,dv=b.v-a.v,l=dx*dx+dv*dv;let t=l>0?((p.u-a.u)*dx+(p.v-a.v)*dv)/l:0;t=t<0?0:t>1?1:t;const x=a.u+dx*t-p.u,y=a.v+dv*t-p.v;return x*x+y*y;};
/* A simplified edge is accepted only if it stays inside the component's cells (sampled every 0.2 cells), so
   polygons never extend past the eroded walkable area: simplification only ever cuts corners inward. */
function segInside(a,b,inC){const du=b.u-a.u,dv=b.v-a.v,n=Math.max(1,Math.ceil(Math.hypot(du,dv)/.2)),e=1e-4;
  for(let t=0;t<=n;t++){const u=a.u+du*t/n,v=a.v+dv*t/n,i0=Math.floor(u-e),i1=Math.floor(u+e),j0=Math.floor(v-e),j1=Math.floor(v+e);
    if(!(inC(i0,j0)||inC(i1,j0)||inC(i0,j1)||inC(i1,j1)))return false;}return true;}
/* Douglas-Peucker between fixed points (saddles and tile-border runs, which must stay exact for tile stitching). */
function simplifyLoop(loop,tol,inC){
  const n=loop.length,P=[];
  for(let k=0;k<n;k++)if(loop[k].d!==loop[(k+n-1)%n].d||loop[k].saddle)P.push(loop[k]);
  const m=P.length;if(m<3)return null;if(tol<=0)return P;
  const keep=new Uint8Array(m);let nf=0;
  for(let k=0;k<m;k++)if(P[k].saddle||P[k].border||P[(k+m-1)%m].border){keep[k]=1;nf++;}
  if(nf<2){let a=0;if(nf===1)a=keep.indexOf(1);else for(let k=1;k<m;k++)if(P[k].u<P[a].u||(P[k].u===P[a].u&&P[k].v<P[a].v))a=k;
    let b=a,bd=-1;for(let k=0;k<m;k++){const d=(P[k].u-P[a].u)**2+(P[k].v-P[a].v)**2;if(d>bd){bd=d;b=k;}}keep[a]=keep[b]=1;}
  const fixed=[];for(let k=0;k<m;k++)if(keep[k])fixed.push(k);
  const tol2=tol*tol,stack=[];
  for(let f=0;f<fixed.length;f++){const a=fixed[f];let b=fixed[(f+1)%fixed.length];if(b<=a)b+=m;if(P[a].border)continue;stack.push(a,b);
    while(stack.length){const e=stack.pop(),s=stack.pop();if(e-s<2)continue;const A=P[s%m],B=P[e%m];let md=-1,mi=-1;
      for(let k=s+1;k<e;k++){const d=segDist2(P[k%m],A,B);if(d>md){md=d;mi=k;}}
      if(md>tol2||!segInside(A,B,inC)){keep[mi%m]=1;stack.push(s,mi,mi,e);}}}
  const out=[];for(let k=0;k<m;k++)if(keep[k])out.push(P[k]);return out.length>=3?out:null;
}
const loopArea=L=>{let a=0;for(let i=0,n=L.length;i<n;i++){const p=L[i],q=L[(i+1)%n];a+=p.u*q.v-q.u*p.v;}return a/2;};
function segsCross(a,b,c,d){
  const o=(p,q,r)=>(q.u-p.u)*(r.v-p.v)-(q.v-p.v)*(r.u-p.u),e=1e-9;
  const d1=o(a,b,c),d2=o(a,b,d),d3=o(c,d,a),d4=o(c,d,b);
  if(((d1>e&&d2<-e)||(d1<-e&&d2>e))&&((d3>e&&d4<-e)||(d3<-e&&d4>e)))return true;
  const on=(p,q,r)=>Math.min(p.u,q.u)-e<=r.u&&r.u<=Math.max(p.u,q.u)+e&&Math.min(p.v,q.v)-e<=r.v&&r.v<=Math.max(p.v,q.v)+e;
  return (Math.abs(d1)<=e&&on(a,b,c))||(Math.abs(d2)<=e&&on(a,b,d))||(Math.abs(d3)<=e&&on(c,d,a))||(Math.abs(d4)<=e&&on(c,d,b));
}
/* Simplified loops must stay simple and mutually disjoint, with exactly one counter-clockwise outer loop. */
function validLoops(loops){
  let outer=0;for(const L of loops){const a=loopArea(L);if(Math.abs(a)<1e-9)return false;if(a>0)outer++;}
  if(outer!==1)return false;
  const segs=[];for(let l=0;l<loops.length;l++){const L=loops[l];for(let i=0;i<L.length;i++)segs.push([L[i],L[(i+1)%L.length],l,i,L.length]);}
  for(let i=0;i<segs.length;i++)for(let j=i+1;j<segs.length;j++){const A=segs[i],B=segs[j];
    if(A[2]===B[2]&&(Math.abs(A[3]-B[3])===1||Math.abs(A[3]-B[3])===A[4]-1))continue;
    if(segsCross(A[0],A[1],B[0],B[1]))return false;}
  return true;
}
function triangulateLoops(THREE,loops){
  const outer=loops.find(L=>loopArea(L)>0),holes=loops.filter(L=>L!==outer),pts=outer.concat(...holes);
  let faces;try{faces=THREE.ShapeUtils.triangulateShape(outer.map(p=>new THREE.Vector2(p.u,p.v)),holes.map(h=>h.map(p=>new THREE.Vector2(p.u,p.v))));}catch(e){return null;}
  let want=0,got=0;for(const L of loops)want+=loopArea(L);
  const tris=[];for(const f of faces){const [a,b,c]=f,A=pts[a],B=pts[b],C=pts[c];const ar=((B.u-A.u)*(C.v-A.v)-(B.v-A.v)*(C.u-A.u))/2;got+=Math.abs(ar);tris.push(ar>=0?[a,b,c]:[a,c,b]);}
  if(Math.abs(got-want)>1e-6+1e-5*Math.abs(want))return null;
  delaunayFlip(pts,tris);
  return {pts,tris};
}
/* Lawson edge flips: turns the ear-clipped triangulation into the constrained Delaunay triangulation of the
   contour (boundary edges never flip), removing slivers before convex merging. */
function delaunayFlip(pts,tris){
  const N=pts.length+1,key=(a,b)=>a*N+b,edge=new Map(),stack=[];
  const add=i=>{const t=tris[i];edge.set(key(t[0],t[1]),i);edge.set(key(t[1],t[2]),i);edge.set(key(t[2],t[0]),i);};
  const del=i=>{const t=tris[i];edge.delete(key(t[0],t[1]));edge.delete(key(t[1],t[2]));edge.delete(key(t[2],t[0]));};
  const orient=(a,b,c)=>(pts[b].u-pts[a].u)*(pts[c].v-pts[a].v)-(pts[b].v-pts[a].v)*(pts[c].u-pts[a].u);
  const inCircle=(a,b,c,d)=>{const A=pts[a],B=pts[b],C=pts[c],D=pts[d],ax=A.u-D.u,ay=A.v-D.v,bx=B.u-D.u,by=B.v-D.v,cx=C.u-D.u,cy=C.v-D.v;
    return (ax*ax+ay*ay)*(bx*cy-cx*by)-(bx*bx+by*by)*(ax*cy-cx*ay)+(cx*cx+cy*cy)*(ax*by-bx*ay);};
  tris.forEach((t,i)=>{add(i);for(let e=0;e<3;e++){const a=t[e],b=t[(e+1)%3];if(a<b)stack.push(a,b);}});
  for(let guard=tris.length*64;stack.length&&guard>0;guard--){
    const b=stack.pop(),a=stack.pop(),i1=edge.get(key(a,b)),i2=edge.get(key(b,a));if(i1===undefined||i2===undefined)continue;
    const t1=tris[i1],t2=tris[i2],c=t1[0]!==a&&t1[0]!==b?t1[0]:t1[1]!==a&&t1[1]!==b?t1[1]:t1[2],d=t2[0]!==a&&t2[0]!==b?t2[0]:t2[1]!==a&&t2[1]!==b?t2[1]:t2[2];
    if(inCircle(a,b,c,d)<=1e-9||orient(a,d,c)<=1e-9||orient(d,b,c)<=1e-9)continue;
    del(i1);del(i2);tris[i1]=[a,d,c];tris[i2]=[d,b,c];add(i1);add(i2);stack.push(a,d,d,b,b,c,c,a);
  }
}
/* Greedy convex merge (Hertel-Mehlhorn style, longest shared edge first, at most nvp vertices). Collinear
   vertices are kept so shared edges between neighbours stay exact (no T-junctions). */
function mergeConvex(pts,polys,nvp){
  const cross=(a,b,c)=>(pts[b].u-pts[a].u)*(pts[c].v-pts[a].v)-(pts[b].v-pts[a].v)*(pts[c].u-pts[a].u);
  const convex=P=>{for(let i=0,n=P.length;i<n;i++)if(cross(P[(i+n-1)%n],P[i],P[(i+1)%n])<-1e-9)return false;return true;};
  const N=pts.length+1,key=(a,b)=>a*N+b;
  for(let round=0;round<64;round++){
    const edges=new Map();polys.forEach((P,pi)=>{for(let e=0;e<P.length;e++)edges.set(key(P[e],P[(e+1)%P.length]),pi*16+e);});
    const cand=[];
    polys.forEach((P,pi)=>{for(let e=0;e<P.length;e++){const a=P[e],b=P[(e+1)%P.length],r=edges.get(key(b,a));if(r===undefined)continue;const qi=r>>4;if(qi<=pi)continue;
      const Q=polys[qi];if(P.length+Q.length-2>nvp)continue;const eq=r&15,M=[];
      for(let k=1;k<=P.length;k++)M.push(P[(e+k)%P.length]);for(let k=2;k<Q.length;k++)M.push(Q[(eq+k)%Q.length]);
      if(!convex(M))continue;cand.push({pi,qi,M,len:(pts[a].u-pts[b].u)**2+(pts[a].v-pts[b].v)**2});}});
    if(!cand.length)break;cand.sort((x,y)=>y.len-x.len);
    const used=new Uint8Array(polys.length);let merged=0;
    for(const c of cand){if(used[c.pi]||used[c.qi])continue;used[c.pi]=used[c.qi]=1;polys[c.pi]=c.M;polys[c.qi]=null;merged++;}
    polys=polys.filter(Boolean);if(!merged)break;
  }
  return polys;
}

/* ---------- polygon helpers ---------- */
function makePoly(nav,tile,xs,zs){
  const n=xs.length,p={ref:nav._nextRef++,tile,n,x:new Float64Array(xs),z:new Float64Array(zs),y:new Float64Array(n),links:[],border:new Int8Array(n),
    area:0,cx:0,cz:0,minX:Infinity,maxX:-Infinity,minZ:Infinity,maxZ:-Infinity,island:-1,dead:false,
    _q:0,_isl:0};
  for(let i=0;i<n;i++){const x=p.x[i],z=p.z[i],j=(i+1)%n;p.area+=x*p.z[j]-p.x[j]*z;p.cx+=x;p.cz+=z;
    if(x<p.minX)p.minX=x;if(x>p.maxX)p.maxX=x;if(z<p.minZ)p.minZ=z;if(z>p.maxZ)p.maxZ=z;p.y[i]=nav._rawHeight(x,z);}
  p.area/=2;p.cx/=n;p.cz/=n;
  /* border edge codes: 1:-X 2:+X 3:-Z 4:+Z (edges lying on the tile boundary, used for tile stitching) */
  const tx0=tile.x0,tx1=tile.x1,tz0=tile.z0,tz1=tile.z1,e=1e-7;
  for(let i=0;i<n;i++){const j=(i+1)%n,ax=p.x[i],az=p.z[i],bx=p.x[j],bz=p.z[j];
    p.border[i]=Math.abs(ax-tx0)<e&&Math.abs(bx-tx0)<e?1:Math.abs(ax-tx1)<e&&Math.abs(bx-tx1)<e?2:Math.abs(az-tz0)<e&&Math.abs(bz-tz0)<e?3:Math.abs(az-tz1)<e&&Math.abs(bz-tz1)<e?4:0;}
  return p;
}
function pointInPoly(p,x,z,eps){const n=p.n,X=p.x,Z=p.z;for(let i=0;i<n;i++){const j=i+1===n?0:i+1,ex=X[j]-X[i],ez=Z[j]-Z[i];
  if(ex*(z-Z[i])-ez*(x-X[i])<-eps*Math.hypot(ex,ez))return false;}return true;}
/* Closest point on a convex polygon; writes out.x/out.z/out.d2. */
function closestOnPoly(p,x,z,out){
  if(pointInPoly(p,x,z,1e-9)){out.x=x;out.z=z;out.d2=0;return out;}
  let best=Infinity;const n=p.n,X=p.x,Z=p.z;
  for(let i=0;i<n;i++){const j=i+1===n?0:i+1,ax=X[i],az=Z[i],ex=X[j]-ax,ez=Z[j]-az,l=ex*ex+ez*ez;let t=l>0?((x-ax)*ex+(z-az)*ez)/l:0;t=t<0?0:t>1?1:t;
    const qx=ax+ex*t,qz=az+ez*t,d=(qx-x)**2+(qz-z)**2;if(d<best){best=d;out.x=qx;out.z=qz;}}
  out.d2=best;return out;
}
function polyHeight(p,x,z){ // barycentric over the vertex fan
  const X=p.x,Z=p.z,Y=p.y;
  for(let k=1;k<p.n-1;k++){const ax=X[0],az=Z[0],bx=X[k],bz=Z[k],cx=X[k+1],cz=Z[k+1];const d=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz);if(Math.abs(d)<1e-12)continue;
    const w1=((bz-cz)*(x-cx)+(cx-bx)*(z-cz))/d,w2=((cz-az)*(x-cx)+(ax-cx)*(z-cz))/d,w3=1-w1-w2;
    if(w1>=-1e-6&&w2>=-1e-6&&w3>=-1e-6)return w1*Y[0]+w2*Y[k]+w3*Y[k+1];}
  let s=0;for(let i=0;i<p.n;i++)s+=Y[i];return s/p.n;
}
const tri2=(ax,az,bx,bz,cx,cz)=>(cx-ax)*(bz-az)-(bx-ax)*(cz-az);
const hash01=n=>{let t=(n*0x9E3779B1+0x6D2B79F5)>>>0;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};

const NAV_DEFAULTS={cellSize:.5,maxSlope:40,stepHeight:.4,agentRadius:.4,agentHeight:1.8,maxError:1.3,maxVertsPerPoly:6,minRegionArea:2,tileSize:16,waterLevel:null,maxWaterDepth:0};

class NavMesh{
  constructor(THREE,o={}){
    if(!THREE||!THREE.Vector3)throw new TypeError('KE.NavMesh needs THREE as its first argument');
    if(!o||typeof o!=='object')throw new TypeError('KE.NavMesh options must be an object');
    this.THREE=THREE;const b=o.bounds;
    if(!b||![b.minX,b.minZ,b.maxX,b.maxZ].every(Number.isFinite)||b.maxX<=b.minX||b.maxZ<=b.minZ)throw new RangeError('NavMesh bounds need finite minX<maxX and minZ<maxZ');
    const P={...NAV_DEFAULTS};for(const k of Object.keys(NAV_DEFAULTS))if(o[k]!==undefined&&o[k]!==null)P[k]=+o[k];
    if(!(P.cellSize>0))throw new RangeError('cellSize must be > 0');
    P.maxSlope=clamp(P.maxSlope,0,89.9);P.stepHeight=Math.max(0,P.stepHeight);P.agentRadius=Math.max(0,P.agentRadius);P.maxError=Math.max(0,P.maxError);
    P.maxVertsPerPoly=clamp(Math.round(P.maxVertsPerPoly),3,12);P.minRegionArea=Math.max(0,P.minRegionArea);
    this.params=P;this.bounds={minX:+b.minX,minZ:+b.minZ,maxX:+b.maxX,maxZ:+b.maxZ};
    Object.assign(this,{cellSize:P.cellSize,agentRadius:P.agentRadius,agentHeight:P.agentHeight});
    const cs=P.cellSize;this.W=Math.max(1,Math.ceil((b.maxX-b.minX)/cs-1e-9));this.H=Math.max(1,Math.ceil((b.maxZ-b.minZ)/cs-1e-9));
    if(this.W*this.H>4e6)throw new RangeError('NavMesh grid too large ('+this.W+'x'+this.H+'); raise cellSize or shrink bounds');
    this.tileCells=Math.max(4,Math.round((P.tileSize>0?P.tileSize:16)/cs));
    this.tilesX=Math.ceil(this.W/this.tileCells);this.tilesZ=Math.ceil(this.H/this.tileCells);
    this.heightFn=isFn(o.heightAt)?o.heightAt:null;this.blockedFn=isFn(o.blocked)?o.blocked:null;
    this.staticObstacles=(o.obstacles||[]).map(normObstacle);this.obstacles=new Map();this._obsId=0;
    this.tiles=[];for(let tz=0;tz<this.tilesZ;tz++)for(let tx=0;tx<this.tilesX;tx++){const T=this.tileCells,i0=tx*T,j0=tz*T,tw=Math.min(T,this.W-i0),th=Math.min(T,this.H-j0);
      this.tiles.push({tx,tz,i0,j0,tw,th,x0:this.bounds.minX+i0*cs,x1:this.bounds.minX+(i0+tw)*cs,z0:this.bounds.minZ+j0*cs,z1:this.bounds.minZ+(j0+th)*cs,polys:[],buckets:null,bw:0,bh:0,version:0});}
    this.polys=[];this._nextRef=1;this.revision=0;this.islandCount=0;this._gen=0;this._agen=0;this._graphRev=-1;this._qgen=0;this._qbuf=[];
    this._na={x:0,z:0,d2:0,poly:null};this._nb={x:0,z:0,d2:0,poly:null};this._cp={x:0,z:0,d2:0};this._ray={hit:false,t:0,x:0,z:0,nx:0,nz:0,poly:null};
    this.rng=KE.random(num(o.seed,1));this._areaCache=null;this.buildMs=0;this.lastRebuild={tiles:0,ms:0};
    this.heights=null;this.open=null;this.walk=null;this.pruned=null;this.clearance=null;
  }
  static build(THREE,o){const nav=new NavMesh(THREE,o);const g=nav._buildSteps();while(!g.next().done);return nav;}
  /* Same build spread over frames through KE.jobs (call KE.jobs.run(ms) from your loop). Resolves to the NavMesh. */
  static buildAsync(THREE,o,{priority=0,jobs=KE.jobs}={}){const nav=new NavMesh(THREE,o);const g=nav._buildSteps();return jobs.add(function*(){while(!g.next().done)yield;return nav;}(),{priority,name:'navmesh'});}
  *_buildSteps(){
    const t0=now();this._rasterize();yield;this._computeWalk(true);yield;
    for(const t of this.tiles){this._buildTile(t);yield;}
    this._finishRebuild(this.tiles);this.buildMs=now()-t0;
  }
  _rawHeight(x,z){if(this.heightFn){const h=+this.heightFn(x,z);return Number.isFinite(h)?h:0;}
    if(this.heights){const cs=this.cellSize,i=clamp(Math.floor((x-this.bounds.minX)/cs),0,this.W-1),j=clamp(Math.floor((z-this.bounds.minZ)/cs),0,this.H-1),h=this.heights[j*this.W+i];return Number.isFinite(h)?h:0;}return 0;}

  /* ---------- rasterization: walkable cells before erosion ---------- */
  _rasterize(){
    const {W,H,cellSize:cs,bounds:B}=this,P=this.params,N=W*H,h=new Float32Array(N),open=new Uint8Array(N);
    for(let j=0;j<H;j++)for(let i=0;i<W;i++){const x=B.minX+(i+.5)*cs,z=B.minZ+(j+.5)*cs,y=this.heightFn?+this.heightFn(x,z):0;h[j*W+i]=Number.isFinite(y)?y:NaN;}
    const slopeMax=Math.tan(P.maxSlope*DEG),stepMax=Math.max(P.stepHeight,cs*slopeMax),water=Number.isFinite(P.waterLevel)?P.waterLevel-P.maxWaterDepth:-Infinity;
    for(let j=0;j<H;j++)for(let i=0;i<W;i++){const k=j*W+i,y=h[k];if(!Number.isFinite(y)||y<water)continue;
      const xl=i>0?h[k-1]:y,xr=i<W-1?h[k+1]:y,zd=j>0?h[k-W]:y,zu=j<H-1?h[k+W]:y;
      if(![xl,xr,zd,zu].every(Number.isFinite))continue;
      const gx=(xr-xl)/((i>0&&i<W-1?2:1)*cs),gz=(zu-zd)/((j>0&&j<H-1?2:1)*cs);if(Math.hypot(gx,gz)>slopeMax+1e-9)continue;
      if(Math.abs(xl-y)>stepMax||Math.abs(xr-y)>stepMax||Math.abs(zd-y)>stepMax||Math.abs(zu-y)>stepMax)continue;
      if(this.blockedFn&&this.blockedFn(B.minX+(i+.5)*cs,B.minZ+(j+.5)*cs))continue;
      open[k]=1;}
    for(const o of this.staticObstacles)this._stamp(open,o);
    this.heights=h;this.open=open;
  }
  _stamp(grid,o){const {W,H,cellSize:cs,bounds:B}=this;
    const i0=clamp(Math.floor((o.minX-B.minX)/cs),0,W-1),i1=clamp(Math.floor((o.maxX-B.minX)/cs),0,W-1),j0=clamp(Math.floor((o.minZ-B.minZ)/cs),0,H-1),j1=clamp(Math.floor((o.maxZ-B.minZ)/cs),0,H-1);
    if(o.maxX<B.minX||o.minX>B.maxX||o.maxZ<B.minZ||o.minZ>B.maxZ)return;
    for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++)if(obstacleContains(o,B.minX+(i+.5)*cs,B.minZ+(j+.5)*cs))grid[j*W+i]=0;}

  /* ---------- erosion by agent radius + small-island pruning ---------- */
  /* clearance = distance from the cell centre to the nearest blocked cell centre minus half a cell (the
     blocked cell's extent); cells with clearance < agentRadius are removed. The grid border counts as blocked. */
  _computeWalk(prune){
    const {W,H,cellSize:cs}=this,N=W*H,open=this.open;let src=open;
    if(this.obstacles.size){src=open.slice();for(const o of this.obstacles.values())this._stamp(src,o);}
    const PW=W+2,PH=H+2,g=new Float64Array(PW*PH),L=Math.max(PW,PH),f=new Float64Array(L),v=new Int32Array(L),zz=new Float64Array(L+1);
    for(let j=0;j<H;j++)for(let i=0;i<W;i++)if(src[j*W+i])g[(j+1)*PW+i+1]=1e20;
    for(let x=0;x<PW;x++)edt1d(g,x,PW,PH,f,v,zz);for(let y=0;y<PH;y++)edt1d(g,y*PW,1,PW,f,v,zz);
    const clr=new Float32Array(N),walk=new Uint8Array(N),r=this.agentRadius-1e-6;
    for(let j=0;j<H;j++)for(let i=0;i<W;i++){const k=j*W+i,c=Math.sqrt(g[(j+1)*PW+i+1])*cs-cs*.5;clr[k]=src[k]?c:0;if(src[k]&&c>=r)walk[k]=1;}
    if(prune){this.pruned=new Uint8Array(N);const minCells=this.params.minRegionArea/(cs*cs);
      if(minCells>1){const lab=new Int32Array(N),stack=[];let id=0;
        for(let s=0;s<N;s++){if(!walk[s]||lab[s])continue;id++;lab[s]=id;stack.push(s);const cells=[];
          while(stack.length){const c=stack.pop();cells.push(c);const ci=c%W,cj=(c/W)|0;
            if(ci>0&&walk[c-1]&&!lab[c-1]){lab[c-1]=id;stack.push(c-1);}if(ci<W-1&&walk[c+1]&&!lab[c+1]){lab[c+1]=id;stack.push(c+1);}
            if(cj>0&&walk[c-W]&&!lab[c-W]){lab[c-W]=id;stack.push(c-W);}if(cj<H-1&&walk[c+W]&&!lab[c+W]){lab[c+W]=id;stack.push(c+W);}}
          if(cells.length<minCells)for(const c of cells)this.pruned[c]=1;}}}
    if(this.pruned)for(let k=0;k<N;k++)if(this.pruned[k])walk[k]=0;
    this.clearance=clr;const old=this.walk;this.walk=walk;return old;
  }

  /* ---------- per-tile polygonization ---------- */
  _buildTile(tile){
    for(const p of tile.polys)p.dead=true;tile.polys=[];tile.version++;
    const {i0,j0,tw,th}=tile,W=this.W,walk=this.walk,cs=this.cellSize,B=this.bounds,P=this.params;
    const label=new Int32Array(tw*th),comps=[];
    for(let j=0;j<th;j++)for(let i=0;i<tw;i++){const k=j*tw+i;if(label[k]||!walk[(j0+j)*W+i0+i])continue;
      const id=comps.length+1,cells=[k],stack=[k];label[k]=id;
      while(stack.length){const c=stack.pop(),ci=c%tw,cj=(c/tw)|0;for(const [du,dv] of DIRS){const ni=ci+du,nj=cj+dv;if(ni<0||nj<0||ni>=tw||nj>=th)continue;const nk=nj*tw+ni;
        if(!label[nk]&&walk[(j0+nj)*W+i0+ni]){label[nk]=id;stack.push(nk);cells.push(nk);}}}
      comps.push(cells);}
    const tols=P.maxError>0?[P.maxError,P.maxError*.5,P.maxError*.25,0]:[0];
    comps.forEach((cells,ci)=>{
      const id=ci+1,inC=(i,j)=>i>=0&&j>=0&&i<tw&&j<th&&label[j*tw+i]===id;
      let result=null;const loops=traceLoops(tw,th,inC,cells);
      for(const tol of tols){const simp=[];let ok=true;for(const L of loops){const s=simplifyLoop(L,tol,inC);if(!s){ok=false;break;}simp.push(s);}
        if(!ok||!validLoops(simp))continue;const tri=triangulateLoops(this.THREE,simp);if(!tri)continue;
        result={pts:tri.pts,polys:mergeConvex(tri.pts,tri.tris,P.maxVertsPerPoly)};break;}
      if(!result){/* fallback: one quad per cell, merged (always valid) */
        const pts=[],idx=new Map(),vi=(u,v)=>{const k=v*(tw+1)+u;let r=idx.get(k);if(r===undefined){r=pts.length;pts.push({u,v});idx.set(k,r);}return r;};
        const quads=cells.map(k=>{const i=k%tw,j=(k/tw)|0;return [vi(i,j),vi(i+1,j),vi(i+1,j+1),vi(i,j+1)];});
        result={pts,polys:mergeConvex(pts,quads,P.maxVertsPerPoly)};}
      for(const poly of result.polys){const xs=[],zs=[];for(const vi of poly){const p=result.pts[vi];xs.push(B.minX+(i0+p.u)*cs);zs.push(B.minZ+(j0+p.v)*cs);}
        tile.polys.push(makePoly(this,tile,xs,zs));}
    });
    this._linkInternal(tile);this._bucketTile(tile);
  }
  _linkInternal(tile){
    const q=v=>Math.round(v*1e5),key=(ax,az,bx,bz)=>q(ax)+','+q(az)+'|'+q(bx)+','+q(bz),edges=new Map();
    for(const p of tile.polys){p.links.length=0;for(let e=0;e<p.n;e++){const f=(e+1)%p.n;edges.set(key(p.x[e],p.z[e],p.x[f],p.z[f]),[p,e]);}}
    for(const p of tile.polys)for(let e=0;e<p.n;e++){const f=(e+1)%p.n,r=edges.get(key(p.x[f],p.z[f],p.x[e],p.z[e]));
      if(r&&r[0]!==p)p.links.push({edge:e,to:r[0],ax:p.x[e],az:p.z[e],bx:p.x[f],bz:p.z[f]});}
  }
  /* Stitch tile A to its +X (axis 0) or +Z (axis 1) neighbour B by overlapping border edges on the shared line. */
  _linkTiles(A,B,axis){
    const ca=axis?4:2,cb=axis?3:1,ea=[],eb=[];
    for(const p of A.polys)for(let e=0;e<p.n;e++)if(p.border[e]===ca)ea.push([p,e]);
    for(const p of B.polys)for(let e=0;e<p.n;e++)if(p.border[e]===cb)eb.push([p,e]);
    const add=(p,e,lo,hi)=>{const f=(e+1)%p.n,ta=axis?p.x[e]:p.z[e],tb=axis?p.x[f]:p.z[f],fwd=tb>ta,s=fwd?lo:hi,t=fwd?hi:lo,c=axis?p.z[e]:p.x[e];
      return axis?{edge:e,ax:s,az:c,bx:t,bz:c}:{edge:e,ax:c,az:s,bx:c,bz:t};};
    for(const [p,e] of ea){const f=(e+1)%p.n,a0=axis?p.x[e]:p.z[e],a1=axis?p.x[f]:p.z[f],alo=Math.min(a0,a1),ahi=Math.max(a0,a1);
      for(const [q,g] of eb){const h=(g+1)%q.n,b0=axis?q.x[g]:q.z[g],b1=axis?q.x[h]:q.z[h],lo=Math.max(alo,Math.min(b0,b1)),hi=Math.min(ahi,Math.max(b0,b1));
        if(hi-lo<=1e-4)continue;const l1=add(p,e,lo,hi);l1.to=q;p.links.push(l1);const l2=add(q,g,lo,hi);l2.to=p;q.links.push(l2);}}
  }
  _tileAt(tx,tz){return tx>=0&&tz>=0&&tx<this.tilesX&&tz<this.tilesZ?this.tiles[tz*this.tilesX+tx]:null;}
  _bucketTile(tile){
    const S=4,cs=this.cellSize;tile.bw=Math.ceil(tile.tw/S);tile.bh=Math.ceil(tile.th/S);tile.buckets=Array.from({length:tile.bw*tile.bh},()=>[]);
    for(const p of tile.polys){const bi0=clamp(Math.floor((p.minX-tile.x0)/cs/S),0,tile.bw-1),bi1=clamp(Math.floor((p.maxX-tile.x0)/cs/S),0,tile.bw-1),
      bj0=clamp(Math.floor((p.minZ-tile.z0)/cs/S),0,tile.bh-1),bj1=clamp(Math.floor((p.maxZ-tile.z0)/cs/S),0,tile.bh-1);
      for(let j=bj0;j<=bj1;j++)for(let i=bi0;i<=bi1;i++)tile.buckets[j*tile.bw+i].push(p);}
  }
  /* Relink rebuilt tiles with their neighbours, refresh the flat polygon list and connectivity islands. */
  _finishRebuild(changed){
    const set=new Set(changed);
    for(const t of changed)for(const [dx,dz] of DIRS){const n=this._tileAt(t.tx+dx,t.tz+dz);if(!n)continue;
      if(!set.has(n))for(const p of n.polys)p.links=p.links.filter(l=>!l.to.dead);}
    for(const t of changed){const px=this._tileAt(t.tx+1,t.tz),pz=this._tileAt(t.tx,t.tz+1),mx=this._tileAt(t.tx-1,t.tz),mz=this._tileAt(t.tx,t.tz-1);
      if(px)this._linkTiles(t,px,0);if(pz)this._linkTiles(t,pz,1);if(mx&&!set.has(mx))this._linkTiles(mx,t,0);if(mz&&!set.has(mz))this._linkTiles(mz,t,1);}
    this.polys=[];for(const t of this.tiles)for(const p of t.polys)this.polys.push(p);
    const stamp=++this._gen;let id=0;const stack=[];
    for(const s of this.polys){if(s._isl===stamp)continue;s._isl=stamp;s.island=id;stack.push(s);
      while(stack.length){const p=stack.pop();for(const l of p.links){const q=l.to;if(q._isl!==stamp){q._isl=stamp;q.island=id;stack.push(q);}}}id++;}
    this.islandCount=id;this.revision++;this._areaCache=null;
  }

  /* ---------- dynamic obstacles ---------- */
  addObstacle(o,{rebuild=true}={}){if(!this.open)throw new Error('This NavMesh has no rasterization grid (saved without it)');const id=++this._obsId;this.obstacles.set(id,normObstacle(o));if(rebuild)this.rebuild();return id;}
  removeObstacle(id,{rebuild=true}={}){const had=this.obstacles.delete(id);if(had&&rebuild)this.rebuild();return had;}
  /* Recomputes erosion over the grid (linear time) and rebuilds only tiles whose walkable cells changed. */
  rebuild(){
    const t0=now(),old=this._computeWalk(false),W=this.W,changed=[];
    for(const t of this.tiles){let diff=false;for(let j=t.j0;j<t.j0+t.th&&!diff;j++)for(let i=t.i0,k=j*W+i;i<t.i0+t.tw;i++,k++)if(old[k]!==this.walk[k]){diff=true;break;}if(diff)changed.push(t);}
    for(const t of changed)this._buildTile(t);if(changed.length)this._finishRebuild(changed);
    this.lastRebuild={tiles:changed.length,ms:now()-t0};return this.lastRebuild;
  }

  /* ---------- spatial queries ---------- */
  _gather(x0,z0,x1,z1){
    const buf=this._qbuf;buf.length=0;const stamp=++this._qgen,cs=this.cellSize,B=this.bounds,T=this.tileCells*cs;
    const tx0=clamp(Math.floor((x0-B.minX)/T),0,this.tilesX-1),tx1=clamp(Math.floor((x1-B.minX)/T),0,this.tilesX-1),tz0=clamp(Math.floor((z0-B.minZ)/T),0,this.tilesZ-1),tz1=clamp(Math.floor((z1-B.minZ)/T),0,this.tilesZ-1);
    if(x1<B.minX||x0>B.maxX||z1<B.minZ||z0>B.maxZ)return buf;
    for(let tz=tz0;tz<=tz1;tz++)for(let tx=tx0;tx<=tx1;tx++){const t=this.tiles[tz*this.tilesX+tx];if(!t.buckets)continue;const S=4*cs;
      const bi0=clamp(Math.floor((x0-t.x0)/S),0,t.bw-1),bi1=clamp(Math.floor((x1-t.x0)/S),0,t.bw-1),bj0=clamp(Math.floor((z0-t.z0)/S),0,t.bh-1),bj1=clamp(Math.floor((z1-t.z0)/S),0,t.bh-1);
      for(let j=bj0;j<=bj1;j++)for(let i=bi0;i<=bi1;i++)for(const p of t.buckets[j*t.bw+i])if(p._q!==stamp){p._q=stamp;buf.push(p);}}
    return buf;
  }
  /* Polygon containing (x,z), or null. */
  findPoly(x,z,eps=1e-4){const c=this._gather(x-eps,z-eps,x+eps,z+eps);for(const p of c)if(pointInPoly(p,x,z,eps))return p;return null;}
  /* Nearest point on the mesh within radius; writes into out {x,z,d2,poly} and returns it, or null. */
  _nearest(x,z,radius,out,island=-1){
    let r=Math.min(radius,Math.max(this.cellSize*4,.5));const cp=this._cp;
    for(;;){const c=this._gather(x-r,z-r,x+r,z+r);let best=Infinity;out.poly=null;
      for(const p of c){if(island>=0&&p.island!==island)continue;if(p.minX-x>r||x-p.maxX>r||p.minZ-z>r||z-p.maxZ>r)continue;closestOnPoly(p,x,z,cp);
        if(cp.d2<best){best=cp.d2;out.x=cp.x;out.z=cp.z;out.d2=cp.d2;out.poly=p;if(best===0)return out;}}
      if(out.poly&&best<=r*r)return out;if(r>=radius)return out.poly?out:null;r=Math.min(radius,r*2);}
  }
  findNearest(x,z,radius=4){const r=this._nearest(x,z,radius,{x:0,z:0,d2:0,poly:null});return r;}
  nearestPoint(p,out,{radius=4}={}){const r=this._nearest(p.x,p.z,radius,this._na);if(!r)return null;out=out||new this.THREE.Vector3();out.set(r.x,this.heightAt(r.x,r.z),r.z);return out;}
  isWalkable(x,z,eps=1e-3){if(typeof x==='object'){z=x.z;x=x.x;}return !!this.findPoly(x,z,eps);}
  heightAt(x,z){if(this.heightFn){const h=+this.heightFn(x,z);if(Number.isFinite(h))return h;}const p=this.findPoly(x,z,1e-3)||(this._nearest(x,z,2,this._nb)||{}).poly;return p?polyHeight(p,x,z):0;}
  /* Distance (world units) from a cell centre to the nearest blocked cell, from the erosion distance field. */
  clearanceAt(x,z){if(!this.clearance)return 0;const cs=this.cellSize,i=Math.floor((x-this.bounds.minX)/cs),j=Math.floor((z-this.bounds.minZ)/cs);if(i<0||j<0||i>=this.W||j>=this.H)return 0;return this.clearance[j*this.W+i];}

  /* Uniform random point on the mesh (area weighted), or within radius of `near` on the same island. */
  randomPoint(rng=this.rng,near=null,radius=Infinity,out){
    const T=this.THREE;rng=isFn(rng)?rng:this.rng;out=out||new T.Vector3();if(!this.polys.length)return null;
    let cand=this.polys,cum;
    if(near){const s=this._nearest(near.x,near.z,Math.max(2,Math.min(radius,8)),this._na);if(!s)return null;const isl=s.poly.island,R=Number.isFinite(radius)?radius:1e9;
      cand=(Number.isFinite(radius)?this._gather(near.x-R,near.z-R,near.x+R,near.z+R):this.polys).filter(p=>p.island===isl);
      let acc=0;cum=cand.map(p=>acc+=Math.max(p.area,1e-9));}
    else{if(!this._areaCache){let acc=0;this._areaCache=this.polys.map(p=>acc+=Math.max(p.area,1e-9));}cum=this._areaCache;}
    if(!cand.length)return null;
    for(let tries=0;tries<24;tries++){
      const r=rng()*cum[cum.length-1];let lo=0,hi=cum.length-1;while(lo<hi){const m=(lo+hi)>>1;if(cum[m]<r)lo=m+1;else hi=m;}
      const p=cand[lo];let tot=0;for(let k=1;k<p.n-1;k++)tot+=Math.abs(tri2(p.x[0],p.z[0],p.x[k],p.z[k],p.x[k+1],p.z[k+1]));
      let pick=rng()*tot,k=1;for(;k<p.n-2;k++){const a=Math.abs(tri2(p.x[0],p.z[0],p.x[k],p.z[k],p.x[k+1],p.z[k+1]));if(pick<a)break;pick-=a;}
      let u=rng(),v=rng();if(u+v>1){u=1-u;v=1-v;}
      const x=p.x[0]+(p.x[k]-p.x[0])*u+(p.x[k+1]-p.x[0])*v,z=p.z[0]+(p.z[k]-p.z[0])*u+(p.z[k+1]-p.z[0])*v;
      if(near&&Number.isFinite(radius)&&(x-near.x)**2+(z-near.z)**2>radius*radius)continue;
      return out.set(x,this.heightAt(x,z),z);}
    return near?this.nearestPoint(near,out):null;
  }

  /* ---------- raycast along the mesh surface (2D, polygon walk) ---------- */
  _raycast(ax,az,bx,bz,res){
    res.hit=false;res.t=1;res.x=bx;res.z=bz;res.nx=0;res.nz=0;res.poly=null;
    let p=this.findPoly(ax,az,1e-4);if(!p){const n=this._nearest(ax,az,this.cellSize*.5,this._nb);p=n&&n.d2<1e-6?n.poly:null;}
    if(!p){res.hit=true;res.t=0;res.x=ax;res.z=az;return res;}
    const dx=bx-ax,dz=bz-az;let t=0;
    for(let iter=0;iter<2048;iter++){
      let tExit=Infinity,eExit=-1;const n=p.n;
      for(let e=0;e<n;e++){const f=e+1===n?0:e+1,ex=p.x[f]-p.x[e],ez=p.z[f]-p.z[e],nx=ez,nz=-ex,den=nx*dx+nz*dz;if(den<=1e-12)continue;
        const tt=(nx*(p.x[e]-ax)+nz*(p.z[e]-az))/den;if(tt<tExit){tExit=tt;eExit=e;}}
      res.poly=p;
      if(eExit<0||tExit>=1){res.t=1;res.x=bx;res.z=bz;return res;}
      if(tExit<t)tExit=t;
      const X=ax+dx*tExit,Z=az+dz*tExit;let next=null;
      for(let e=0;e<n&&!next;e++){const f=e+1===n?0:e+1,ex=p.x[f]-p.x[e],ez=p.z[f]-p.z[e],den=ez*dx-ex*dz;if(den<=1e-12)continue;
        const tt=(ez*(p.x[e]-ax)-ex*(p.z[e]-az))/den;if(Math.abs(tt-tExit)>1e-7)continue;
        for(const l of p.links){if(l.edge!==e||l.to.dead)continue;const lx=l.bx-l.ax,lz=l.bz-l.az,ll=lx*lx+lz*lz,s=ll>0?((X-l.ax)*lx+(Z-l.az)*lz)/ll:0;if(s>=-1e-6&&s<=1+1e-6){next=l.to;break;}}}
      if(!next){const f=eExit+1===n?0:eExit+1,ex=p.x[f]-p.x[eExit],ez=p.z[f]-p.z[eExit],l=Math.hypot(ex,ez)||1;
        res.hit=true;res.t=tExit;res.x=X;res.z=Z;res.nx=ez/l;res.nz=-ex/l;return res;}
      p=next;t=tExit;}
    res.hit=true;res.t=t;res.x=ax+dx*t;res.z=az+dz*t;return res;
  }
  raycast(a,b,out){const r=this._raycast(a.x,a.z,b.x,b.z,this._ray),T=this.THREE;out=out||{};out.hit=r.hit;out.t=r.t;
    out.point=(out.point||new T.Vector3()).set(r.x,this.heightAt(r.x,r.z),r.z);out.normal=(out.normal||new T.Vector3()).set(r.nx,0,r.nz);out.poly=r.poly;return out;}

  /* ---------- path finding: polygon A* + funnel ---------- */
  /* A* over portal sample points. A node is a point on a portal (both endpoints, interior samples about every
     2 m, plus one goal-directed crossing point); moving between two points on the boundary of one convex polygon
     is a straight segment inside it, so edge costs are exact and the Euclidean heuristic is consistent. This
     picks near-optimal corridors, which the funnel then straightens. */
  _prepareGraph(){
    let nid=0;const links=[];
    for(const p of this.polys)for(const l of p.links){l.from=p;const len=Math.hypot(l.bx-l.ax,l.bz-l.az);l.ns=Math.min(8,Math.max(1,Math.ceil(len/2)))+1;l.base=nid;nid+=l.ns+1;links.push(l);}
    if(!this._ng||this._ng.length<nid){const n=Math.max(nid,64)*2;this._ng=new Float64Array(n);this._nx=new Float64Array(n);this._nz=new Float64Array(n);this._npar=new Int32Array(n);this._ngen=new Int32Array(n);this._ncl=new Int32Array(n);this._nlink=new Int32Array(n);}
    links.forEach((l,li)=>{for(let k=0;k<=l.ns;k++)this._nlink[l.base+k]=li;});
    this._links=links;this._graphRev=this.revision;this._hn=[];this._hf=[];
  }
  _astar(sp,sx,sz,ep,ex,ez,maxNodes,partial){
    if(sp===ep)return {polys:[sp],links:[]};
    if(this._graphRev!==this.revision)this._prepareGraph();
    const gen=++this._agen||(this._agen=1),G=this._ng,X=this._nx,Z=this._nz,PAR=this._npar,GEN=this._ngen,CL=this._ncl,HN=this._hn,HF=this._hf;HN.length=HF.length=0;
    const push=(n,f)=>{let i=HN.length;HN.push(n);HF.push(f);while(i>0){const q=(i-1)>>1;if(HF[q]<=f)break;HN[i]=HN[q];HF[i]=HF[q];i=q;}HN[i]=n;HF[i]=f;};
    const pop=()=>{const top=HN[0],ln=HN.pop(),lf=HF.pop(),len=HN.length;if(len){let i=0;for(;;){let c=i*2+1;if(c>=len)break;if(c+1<len&&HF[c+1]<HF[c])c++;if(HF[c]>=lf)break;HN[i]=HN[c];HF[i]=HF[c];i=c;}HN[i]=ln;HF[i]=lf;}return top;};
    const relax=(n,x,z,g,par)=>{if(GEN[n]===gen){if(CL[n]===gen||g>=G[n]-1e-9)return;}else{GEN[n]=gen;CL[n]=0;}G[n]=g;X[n]=x;Z[n]=z;PAR[n]=par;push(n,g+Math.hypot(ex-x,ez-z));};
    let goalG=Infinity,goalPar=-1,bestNode=-1,bestH=Infinity,expanded=0,reached=false;
    const expand=(poly,x,z,g,par,from)=>{
      if(poly===ep){const gg=g+Math.hypot(ex-x,ez-z);if(gg<goalG){goalG=gg;goalPar=par;push(-1,gg);}return;}
      for(const l of poly.links){if(l.to.dead||l.to===from)continue;const ns=l.ns,lx=l.bx-l.ax,lz=l.bz-l.az;
        for(let k=0;k<ns;k++){const t=k/(ns-1),px=l.ax+lx*t,pz=l.az+lz*t;relax(l.base+k,px,pz,g+Math.hypot(px-x,pz-z),par);}
        const dx=ex-x,dz=ez-z,den=lx*dz-lz*dx;
        if(Math.abs(den)>1e-12){const s=((x-l.ax)*dz-(z-l.az)*dx)/den,u=((x-l.ax)*lz-(z-l.az)*lx)/den;
          if(s>1e-6&&s<1-1e-6&&u>0){const px=l.ax+lx*s,pz=l.az+lz*s;relax(l.base+ns,px,pz,g+Math.hypot(px-x,pz-z),par);}}}
    };
    expand(sp,sx,sz,0,-1,null);
    while(HN.length){const n=pop();if(n===-1){reached=true;break;}if(CL[n]===gen)continue;CL[n]=gen;
      const h=Math.hypot(ex-X[n],ez-Z[n]);if(h<bestH){bestH=h;bestNode=n;}if(++expanded>maxNodes)break;
      const l=this._links[this._nlink[n]];expand(l.to,X[n],Z[n],G[n],n,l.from);}
    if(!reached&&!partial)return null;
    let n=reached?goalPar:bestNode;const links=[];for(;n>=0;n=PAR[n])links.push(this._links[this._nlink[n]]);links.reverse();
    const polys=[sp];for(const l of links)polys.push(l.to);return {polys,links};
  }
  /* Simple Stupid Funnel Algorithm (Mononen) over the corridor portals. */
  _funnel(links,sx,sz,ex,ez){
    const pl=[sx,sz],pr=[sx,sz];
    for(const l of links){pl.push(l.bx,l.bz);pr.push(l.ax,l.az);}
    pl.push(ex,ez);pr.push(ex,ez);
    const np=pl.length/2,pts=[sx,sz],eq=(ax,az,bx,bz)=>(ax-bx)**2+(az-bz)**2<1e-10;
    let apx=sx,apz=sz,lx=pl[0],lz=pl[1],rx=pr[0],rz=pr[1],apexIndex=0,leftIndex=0,rightIndex=0;
    for(let i=1;i<np;i++){const nlx=pl[i*2],nlz=pl[i*2+1],nrx=pr[i*2],nrz=pr[i*2+1];
      if(tri2(apx,apz,rx,rz,nrx,nrz)<=0){
        if(eq(apx,apz,rx,rz)||tri2(apx,apz,lx,lz,nrx,nrz)>0){rx=nrx;rz=nrz;rightIndex=i;}
        else{apx=lx;apz=lz;apexIndex=leftIndex;if(!eq(pts[pts.length-2],pts[pts.length-1],apx,apz))pts.push(apx,apz);lx=rx=apx;lz=rz=apz;leftIndex=rightIndex=apexIndex;i=apexIndex;continue;}}
      if(tri2(apx,apz,lx,lz,nlx,nlz)>=0){
        if(eq(apx,apz,lx,lz)||tri2(apx,apz,rx,rz,nlx,nlz)<0){lx=nlx;lz=nlz;leftIndex=i;}
        else{apx=rx;apz=rz;apexIndex=rightIndex;if(!eq(pts[pts.length-2],pts[pts.length-1],apx,apz))pts.push(apx,apz);lx=rx=apx;lz=rz=apz;leftIndex=rightIndex=apexIndex;i=apexIndex;continue;}}
    }
    if(!eq(pts[pts.length-2],pts[pts.length-1],ex,ez))pts.push(ex,ez);else if(pts.length===2)pts.push(ex,ez);
    /* drop corners that are collinear with their neighbours (paths running exactly along a portal edge) */
    for(let i=2;i+2<pts.length;){const ax=pts[i-2],az=pts[i-1],bx=pts[i],bz=pts[i+1],cx=pts[i+2],cz=pts[i+3],ux=bx-ax,uz=bz-az,vx=cx-bx,vz=cz-bz;
      if(Math.abs(ux*vz-uz*vx)<=1e-9*Math.hypot(ux,uz)*Math.hypot(vx,vz)+1e-12&&ux*vx+uz*vz>=0)pts.splice(i,2);else i+=2;}
    return pts;
  }
  /* Returns Vector3 corners (y from heightAt) or [] when unreachable. opts: maxNodes, searchRadius, partial
     (walk to the reachable polygon closest to the goal), subdivide (max segment length for terrain-draped paths). */
  findPath(start,end,opts={}){
    const T=this.THREE,maxNodes=opts.maxNodes||16384,R=num(opts.searchRadius,Math.max(2,this.agentRadius*4));
    this.lastCorridor=null;this.lastPathPartial=false;
    const s=this._nearest(start.x,start.z,R,this._na);if(!s)return [];const sp=s.poly,sx=s.x,sz=s.z;
    const e=this._nearest(end.x,end.z,R,this._nb);
    if(!e&&!opts.partial)return [];
    let ep=e&&e.poly,ex=e?e.x:end.x,ez=e?e.z:end.z;
    if((!ep||ep.island!==sp.island)&&opts.partial){const e2=this._nearest(end.x,end.z,1e6,this._nb,sp.island);if(!e2)return [];ep=e2.poly;ex=e2.x;ez=e2.z;this.lastPathPartial=true;}
    if(ep.island!==sp.island)return [];
    const res=this._astar(sp,sx,sz,ep,ex,ez,maxNodes,!!opts.partial);if(!res)return [];
    const corridor=res.polys,last=corridor[corridor.length-1];if(last!==ep){closestOnPoly(last,ex,ez,this._cp);ex=this._cp.x;ez=this._cp.z;this.lastPathPartial=true;}
    this.lastCorridor=corridor;
    const flat=this._funnel(res.links,sx,sz,ex,ez),out=[],sub=opts.subdivide>0?opts.subdivide:0;
    for(let i=0;i<flat.length;i+=2){const x=flat[i],z=flat[i+1];
      if(sub&&i>0){const px=flat[i-2],pz=flat[i-1],d=Math.hypot(x-px,z-pz),m=Math.ceil(d/sub);for(let k=1;k<m;k++){const t=k/m,qx=px+(x-px)*t,qz=pz+(z-pz)*t;out.push(new T.Vector3(qx,this.heightAt(qx,qz),qz));}}
      out.push(new T.Vector3(x,this.heightAt(x,z),z));}
    return out;
  }
  static pathLength(path){let d=0;for(let i=1;i<path.length;i++)d+=Math.hypot(path[i].x-path[i-1].x,path[i].z-path[i-1].z);return d;}

  /* ---------- stats, serialization, debug ---------- */
  stats(){let verts=0,links=0,area=0;for(const p of this.polys){verts+=p.n;links+=p.links.length;area+=p.area;}
    let walkable=0;if(this.walk)for(let k=0;k<this.walk.length;k++)walkable+=this.walk[k];
    return {cells:this.W*this.H,walkableCells:walkable,polys:this.polys.length,verts,links,islands:this.islandCount,area,tiles:this.tiles.length,tileCells:this.tileCells,
      obstacles:this.obstacles.size,buildMs:this.buildMs,lastRebuild:{...this.lastRebuild},revision:this.revision};}
  toJSON({grid=true}={}){
    const r=v=>Math.round(v*1e4)/1e4,P=this.params;
    return {format:'kitsune-navmesh',version:1,params:{...P,bounds:{...this.bounds}},W:this.W,H:this.H,
      tiles:this.tiles.map(t=>({tx:t.tx,tz:t.tz,polys:t.polys.map(p=>{const a=[];for(let i=0;i<p.n;i++)a.push(r(p.x[i]),r(p.y[i]),r(p.z[i]));return a;})})),
      obstacles:this.staticObstacles.map(obstacleJSON),
      grid:grid&&this.open?{open:rleEncode(this.open),pruned:rleEncode(this.pruned||new Uint8Array(this.W*this.H))}:null};
  }
  static fromJSON(THREE,json,opts={}){
    if(THREE&&!THREE.Vector3&&json&&json.Vector3){const t=THREE;THREE=json;json=t;}
    if(typeof json==='string')json=JSON.parse(json);
    if(!json||json.format!=='kitsune-navmesh'||json.version!==1)throw new TypeError('Not a kitsune navmesh (format/version mismatch)');
    const p=json.params||{};const nav=new NavMesh(THREE,{...p,obstacles:json.obstacles||[],heightAt:opts.heightAt,blocked:opts.blocked,seed:opts.seed});
    if(nav.W!==json.W||nav.H!==json.H||!Array.isArray(json.tiles)||json.tiles.length!==nav.tiles.length)throw new RangeError('Navmesh JSON does not match its parameters');
    const t0=now();
    json.tiles.forEach((tj,ti)=>{const tile=nav.tiles[ti];if(tj.tx!==tile.tx||tj.tz!==tile.tz||!Array.isArray(tj.polys))throw new RangeError('Navmesh tile order mismatch');
      for(const a of tj.polys){if(!Array.isArray(a)||a.length<9||a.length%3||a.length>36||!a.every(Number.isFinite))throw new TypeError('Invalid navmesh polygon');
        const xs=[],zs=[],ys=[];for(let i=0;i<a.length;i+=3){xs.push(a[i]);ys.push(a[i+1]);zs.push(a[i+2]);}
        const poly=makePoly(nav,tile,xs,zs);if(!nav.heightFn)poly.y.set(ys);tile.polys.push(poly);}
      nav._linkInternal(tile);nav._bucketTile(tile);});
    nav._finishRebuild(nav.tiles);
    if(json.grid&&json.grid.open){const N=nav.W*nav.H;nav.open=rleDecode(json.grid.open,N);nav.pruned=rleDecode(json.grid.pruned||[N],N);
      if(!nav.heightFn){nav.heights=new Float32Array(N);const cs=nav.cellSize,B=nav.bounds;for(let j=0;j<nav.H;j++)for(let i=0;i<nav.W;i++)nav.heights[j*nav.W+i]=nav.heightAt(B.minX+(i+.5)*cs,B.minZ+(j+.5)*cs);}
      nav._computeWalk(false);}
    nav.buildMs=now()-t0;return nav;
  }
  /* Debug overlay: per-polygon tinted fill draped over heightAt plus polygon outlines (boundary edges darker). */
  debugMesh(THREE=this.THREE,{color=0x39b3ff,opacity=.42,edgeColor=0xe9fbff,borderColor=0x08314f,heightOffset=.06,colorize=true,resolution=null}={}){
    const T=THREE,pos=[],col=[],lp=[],lc=[],base=new T.Color(color),c=new T.Color(),hsl={h:0,s:0,l:0};base.getHSL(hsl);
    const H=(x,z)=>this.heightAt(x,z)+heightOffset,step=resolution||this.cellSize*2,ec=new T.Color(edgeColor),bc=new T.Color(borderColor);
    for(const p of this.polys){
      if(colorize){const a=hash01(p.ref),b=hash01(p.ref+7919),d=hash01(p.ref+104729);c.setHSL((hsl.h+(a-.5)*.1+1)%1,clamp(hsl.s*(.8+.4*b),0,1),clamp(hsl.l*(.78+.44*d),0,1));}else c.copy(base);
      for(let k=1;k<p.n-1;k++){const ax=p.x[0],az=p.z[0],bx=p.x[k],bz=p.z[k],cx=p.x[k+1],cz=p.z[k+1];
        const m=Math.max(1,Math.ceil(Math.max(Math.hypot(bx-ax,bz-az),Math.hypot(cx-ax,cz-az),Math.hypot(cx-bx,cz-bz))/step));
        const P=(i,j)=>{const x=ax+(bx-ax)*i/m+(cx-ax)*j/m,z=az+(bz-az)*i/m+(cz-az)*j/m;pos.push(x,H(x,z),z);col.push(c.r,c.g,c.b);};
        for(let j=0;j<m;j++)for(let i=0;i+j<m;i++){P(i,j);P(i,j+1);P(i+1,j);if(i+j<m-1){P(i+1,j);P(i,j+1);P(i+1,j+1);}}}
      for(let e=0;e<p.n;e++){const f=(e+1)%p.n,ax=p.x[e],az=p.z[e],bx=p.x[f],bz=p.z[f],linked=p.links.some(l=>l.edge===e),cc=linked?ec:bc;
        const m=Math.max(1,Math.ceil(Math.hypot(bx-ax,bz-az)/this.cellSize));
        for(let k=0;k<m;k++){const x0=ax+(bx-ax)*k/m,z0=az+(bz-az)*k/m,x1=ax+(bx-ax)*(k+1)/m,z1=az+(bz-az)*(k+1)/m;lp.push(x0,H(x0,z0)+.01,z0,x1,H(x1,z1)+.01,z1);lc.push(cc.r,cc.g,cc.b,cc.r,cc.g,cc.b);}}}
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('color',new T.Float32BufferAttribute(col,3));
    const fill=new T.Mesh(g,new T.MeshBasicMaterial({vertexColors:true,transparent:true,opacity,depthWrite:false,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2,toneMapped:false}));
    const lg=new T.BufferGeometry();lg.setAttribute('position',new T.Float32BufferAttribute(lp,3));lg.setAttribute('color',new T.Float32BufferAttribute(lc,3));
    const lines=new T.LineSegments(lg,new T.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.85,depthWrite:false,toneMapped:false}));
    fill.renderOrder=lines.renderOrder=2;fill.name='ke-navmesh-fill';lines.name='ke-navmesh-edges';
    const group=new T.Group();group.name='ke-navmesh-debug';group.add(fill,lines);
    group.dispose=()=>{g.dispose();lg.dispose();fill.material.dispose();lines.material.dispose();group.parent&&group.parent.remove(group);};
    return group;
  }
  /* Flat ribbon along a path, draped on the mesh height; returns a Mesh with dispose(). */
  debugPath(THREE=this.THREE,path,{color=0xffc21a,width=.2,heightOffset=.14}={}){
    const T=THREE,pos=[],idx=[],pts=[];
    for(let i=0;i<path.length;i++){if(i===0){pts.push([path[0].x,path[0].z]);continue;}const a=path[i-1],b=path[i],m=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.z-a.z)/(this.cellSize*.5)));
      for(let k=1;k<=m;k++)pts.push([a.x+(b.x-a.x)*k/m,a.z+(b.z-a.z)*k/m]);}
    for(let i=0;i<pts.length;i++){const p=pts[Math.max(0,i-1)],q=pts[Math.min(pts.length-1,i+1)];let dx=q[0]-p[0],dz=q[1]-p[1];const l=Math.hypot(dx,dz)||1;dx/=l;dz/=l;
      const [x,z]=pts[i],y=this.heightAt(x,z)+heightOffset;pos.push(x-dz*width/2,y,z+dx*width/2,x+dz*width/2,y,z-dx*width/2);
      if(i){const b=(i-1)*2;idx.push(b,b+1,b+2,b+1,b+3,b+2);}}
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setIndex(idx);
    const mesh=new T.Mesh(g,new T.MeshBasicMaterial({color,side:T.DoubleSide,depthWrite:false,transparent:true,opacity:.95,toneMapped:false}));mesh.renderOrder=3;mesh.name='ke-navmesh-path';
    mesh.dispose=()=>{g.dispose();mesh.material.dispose();mesh.parent&&mesh.parent.remove(mesh);};return mesh;
  }
  dispose(){for(const t of this.tiles){for(const p of t.polys)p.dead=true;t.polys=[];t.buckets=null;}this.polys=[];this.heights=this.open=this.walk=this.clearance=this.pruned=null;}
}
const now=()=>typeof performance!=='undefined'?performance.now():Date.now();
KE.NavMesh=NavMesh;

/* ======================================================================
   Crowd: corridor following + ORCA avoidance
   ====================================================================== */
/* ORCA linear programs (van den Berg et al., RVO2), on flat arrays: lines are points P[2i..] and unit
   directions D[2i..]; the permitted half-plane is to the left of each directed line. */
function lp1(P,D,no,radius,ox,oz,dirOpt,res){
  const px=P[no*2],pz=P[no*2+1],dx=D[no*2],dz=D[no*2+1],dot=px*dx+pz*dz,disc=dot*dot+radius*radius-(px*px+pz*pz);if(disc<0)return false;
  const sq=Math.sqrt(disc);let tL=-dot-sq,tR=-dot+sq;
  for(let i=0;i<no;i++){const ix=D[i*2],iz=D[i*2+1],den=dx*iz-dz*ix,nm=ix*(pz-P[i*2+1])-iz*(px-P[i*2]);
    if(Math.abs(den)<=1e-9){if(nm<0)return false;continue;}
    const t=nm/den;if(den>=0){if(t<tR)tR=t;}else if(t>tL)tL=t;if(tL>tR)return false;}
  let t;if(dirOpt)t=ox*dx+oz*dz>0?tR:tL;else{t=dx*(ox-px)+dz*(oz-pz);if(t<tL)t=tL;else if(t>tR)t=tR;}
  res[0]=px+t*dx;res[1]=pz+t*dz;return true;
}
function lp2(P,D,n,radius,ox,oz,dirOpt,res){
  if(dirOpt){res[0]=ox*radius;res[1]=oz*radius;}
  else if(ox*ox+oz*oz>radius*radius){const l=Math.hypot(ox,oz);res[0]=ox/l*radius;res[1]=oz/l*radius;}
  else{res[0]=ox;res[1]=oz;}
  for(let i=0;i<n;i++)if(D[i*2]*(P[i*2+1]-res[1])-D[i*2+1]*(P[i*2]-res[0])>0){const tx=res[0],tz=res[1];if(!lp1(P,D,i,radius,ox,oz,dirOpt,res)){res[0]=tx;res[1]=tz;return i;}}
  return n;
}
function lp3(P,D,n,begin,radius,res,PP,PD){
  let dist=0;
  for(let i=begin;i<n;i++){
    if(D[i*2]*(P[i*2+1]-res[1])-D[i*2+1]*(P[i*2]-res[0])<=dist)continue;
    let m=0;
    for(let j=0;j<i;j++){const det=D[i*2]*D[j*2+1]-D[i*2+1]*D[j*2];let px,pz;
      if(Math.abs(det)<=1e-9){if(D[i*2]*D[j*2]+D[i*2+1]*D[j*2+1]>0)continue;px=.5*(P[i*2]+P[j*2]);pz=.5*(P[i*2+1]+P[j*2+1]);}
      else{const t=(D[j*2]*(P[i*2+1]-P[j*2+1])-D[j*2+1]*(P[i*2]-P[j*2]))/det;px=P[i*2]+t*D[i*2];pz=P[i*2+1]+t*D[i*2+1];}
      const dx=D[j*2]-D[i*2],dz=D[j*2+1]-D[i*2+1],l=Math.hypot(dx,dz)||1;PP[m*2]=px;PP[m*2+1]=pz;PD[m*2]=dx/l;PD[m*2+1]=dz/l;m++;}
    const tx=res[0],tz=res[1];if(lp2(PP,PD,m,radius,-D[i*2+1],D[i*2],true,res)<m){res[0]=tx;res[1]=tz;}
    dist=D[i*2]*(P[i*2+1]-res[1])-D[i*2+1]*(P[i*2]-res[0]);
  }
}

class CrowdAgent{
  constructor(crowd,o){
    const T=crowd.nav.THREE;this.crowd=crowd;this.id=++crowd._ids;this.index=-1;
    this.position=new T.Vector3();this.velocity=new T.Vector3();this.desiredVelocity=new T.Vector3();
    this.radius=Math.max(.01,num(+o.radius,crowd.nav.agentRadius||.4));this.height=num(+o.height,1.8);this.maxSpeed=Math.max(0,num(+o.maxSpeed,3.5));this.maxAccel=Math.max(.01,num(+o.maxAccel,8));
    this.arriveDistance=num(+o.arriveDistance,Math.max(.15,this.radius*.5));this.slowDistance=num(+o.slowDistance,Math.max(this.radius*2,this.maxSpeed*this.maxSpeed/(2*this.maxAccel)+.3));
    this.separationWeight=num(+o.separationWeight,.5);this.avoidance=o.avoidance!==false;this.userData=o.userData||{};
    this.onArrive=isFn(o.onArrive)?o.onArrive:null;
    this.target=null;this.state='idle';this.path=[];this.pathIndex=0;this.corridor=null;this.partial=false;this.poly=null;
    this._needsPath=false;this._queued=false;this._arrived=false;this._checkT=0;this._stuck=0;this._nd=0;this._nvx=0;this._nvz=0;this._dx=0;this._dz=0;this._prefx=0;this._prefz=0;this._yaw=0;
  }
  /* Move to a point (Vector3-like) or stop with null. Paths are planned by the crowd within its per-update budget. */
  setTarget(v){
    if(!v){this.target=null;this.state='idle';this.path=[];this.corridor=null;this._needsPath=false;return this;}
    if(!Number.isFinite(v.x)||!Number.isFinite(v.z))throw new TypeError('Agent target needs finite x and z');
    (this.target||(this.target=new this.crowd.nav.THREE.Vector3())).set(v.x,num(v.y,0),v.z);this._arrived=false;
    if(!this.path.length)this.state='waiting';if(this.crowd)this.crowd._request(this);return this;
  }
  stop(){return this.setTarget(null);}
  teleport(v){this.position.set(v.x,num(v.y,0),v.z);this.velocity.set(0,0,0);this.poly=null;if(this.crowd){this.crowd._constrain(this);if(this.target)this.crowd._request(this);}return this;}
  get speed(){return Math.hypot(this.velocity.x,this.velocity.z);}
  /* Remaining distance along the planned path (2D). */
  remainingDistance(){if(!this.path.length)return this.target?Infinity:0;let d=0,x=this.position.x,z=this.position.z;
    for(let i=this.pathIndex;i<this.path.length;i++){const p=this.path[i];d+=Math.hypot(p.x-x,p.z-z);x=p.x;z=p.z;}return d;}
}

class Crowd{
  constructor(nav,o={}){
    if(!(nav instanceof NavMesh))throw new TypeError('KE.Crowd needs a KE.NavMesh');
    this.nav=nav;this.maxAgents=clamp(Math.round(num(+o.maxAgents,128)),1,4096);this.separation=Math.max(0,num(+o.separation,1.2));
    this.timeHorizon=Math.max(.1,num(+o.timeHorizon,1.5));this.maxNeighbors=clamp(Math.round(num(+o.maxNeighbors,10)),1,32);
    this.neighborDist=Number.isFinite(o.neighborDist)?o.neighborDist:null;this.collisionIterations=clamp(Math.round(num(+o.collisionIterations,4)),0,16);
    this.maxPathsPerUpdate=Math.max(1,Math.round(num(+o.maxPathsPerUpdate,16)));this.cornerCheckInterval=Math.max(0,num(+o.cornerCheckInterval,.25));
    this.stuckTime=num(+o.stuckTime,2);this.laneBias=Math.max(0,num(+o.laneBias,.35));this.agents=[];this.events=new KE.Events();this.onArrive=isFn(o.onArrive)?o.onArrive:null;this.time=0;this._ids=0;
    const M=this.maxAgents,K=this.maxNeighbors;
    this._nbr=new Int32Array(M*K);this._nbrD=new Float64Array(M*K);this._nbrN=new Int32Array(M);
    let hs=64;while(hs<M*2)hs<<=1;this._hsize=hs;this._hstart=new Int32Array(hs+1);this._hcur=new Int32Array(hs);this._hitems=new Int32Array(M);this._hkey=new Int32Array(M);this._stamp=new Int32Array(M);this._sgen=0;this._hc=1;
    this._lp=new Float64Array((K+1)*2);this._ld=new Float64Array((K+1)*2);this._pp=new Float64Array((K+1)*2);this._pd=new Float64Array((K+1)*2);this._res=new Float64Array(2);
    this._queue=[];this._rev=nav.revision;this._ray={hit:false,t:0,x:0,z:0,nx:0,nz:0,poly:null};this._near={x:0,z:0,d2:0,poly:null};
  }
  addAgent(o={}){
    if(this.agents.length>=this.maxAgents)throw new RangeError('Crowd is full ('+this.maxAgents+' agents)');
    const a=new CrowdAgent(this,o);a.index=this.agents.length;this.agents.push(a);
    if(o.position){a.position.set(o.position.x,num(o.position.y,0),o.position.z);this._constrain(a);}
    if(o.target)a.setTarget(o.target);return a;
  }
  removeAgent(a){const i=this.agents.indexOf(a);if(i<0)return false;this.agents.splice(i,1);for(let k=i;k<this.agents.length;k++)this.agents[k].index=k;
    a.crowd=null;a.state='removed';a._needsPath=false;return true;}
  _request(a){a._needsPath=true;if(!a._queued){a._queued=true;this._queue.push(a);}}
  _plan(a){
    a._needsPath=false;const nav=this.nav,path=nav.findPath(a.position,a.target,{partial:true});
    a.corridor=nav.lastCorridor;a.partial=nav.lastPathPartial;a._stuck=0;
    if(!path.length){a.path=[];a.state='unreachable';this._emit('unreachable',a);return;}
    a.path=path;a.pathIndex=Math.min(1,path.length-1);a.state='moving';a._checkT=0;
  }
  _emit(name,a){if(name==='arrive'){if(a.onArrive)a.onArrive(a);if(this.onArrive)this.onArrive(a);}this.events.emit(name,a);}
  _hk(ix,iz){return (Math.imul(ix,73856093)^Math.imul(iz,19349663))&(this._hsize-1);}
  _buildHash(){
    const A=this.agents,n=A.length,hs=this._hsize,st=this._hstart,cur=this._hcur,items=this._hitems,key=this._hkey;let maxR=0,hc=.5;
    for(let i=0;i<n;i++)if(A[i].radius>maxR)maxR=A[i].radius;
    for(let i=0;i<n;i++){const a=A[i];a._nd=this.neighborDist!==null?this.neighborDist:a.maxSpeed*this.timeHorizon+a.radius+maxR;if(a._nd>hc)hc=a._nd;}
    this._hc=hc;st.fill(0);
    for(let i=0;i<n;i++){const k=this._hk(Math.floor(A[i].position.x/hc),Math.floor(A[i].position.z/hc));key[i]=k;st[k+1]++;}
    for(let k=0;k<hs;k++){st[k+1]+=st[k];cur[k]=st[k];}
    for(let i=0;i<n;i++)items[cur[key[i]]++]=i;
  }
  _neighbors(i){
    const A=this.agents,a=A[i],K=this.maxNeighbors,base=i*K,nb=this._nbr,nd=this._nbrD,hc=this._hc,r=a._nd,x=a.position.x,z=a.position.z,st=this._hstart,items=this._hitems,stamp=this._stamp;
    if(++this._sgen>1e9){this._sgen=1;stamp.fill(0);}const sg=this._sgen;let cnt=0;
    const ix0=Math.floor((x-r)/hc),ix1=Math.floor((x+r)/hc),iz0=Math.floor((z-r)/hc),iz1=Math.floor((z+r)/hc);
    for(let ix=ix0;ix<=ix1;ix++)for(let iz=iz0;iz<=iz1;iz++){const k=this._hk(ix,iz);
      for(let s=st[k];s<st[k+1];s++){const j=items[s];if(j===i||stamp[j]===sg)continue;stamp[j]=sg;const b=A[j],dx=b.position.x-x,dz=b.position.z-z,d2=dx*dx+dz*dz;if(d2>r*r)continue;
        let p;if(cnt<K)p=cnt++;else if(d2<nd[base+K-1])p=K-1;else continue;
        while(p>0&&nd[base+p-1]>d2){nb[base+p]=nb[base+p-1];nd[base+p]=nd[base+p-1];p--;}nb[base+p]=j;nd[base+p]=d2;}}
    this._nbrN[i]=cnt;
  }
  /* Preferred velocity: steer to the current path corner (with visibility shortcuts and lost-corridor
     replanning), slow down on the final approach, plus a soft separation term. */
  _preferred(a,dt){
    a._prefx=a._prefz=0;const path=a.path,x=a.position.x,z=a.position.z;
    if(a.target&&path.length&&(a.state==='moving'||a.state==='arrived'||a.state==='waiting')){
      const last=path.length-1,cr=Math.max(.3,a.radius);
      while(a.pathIndex<last){const c=path[a.pathIndex];if((c.x-x)**2+(c.z-z)**2<cr*cr)a.pathIndex++;else break;}
      a._checkT-=dt;
      if(a._checkT<=0&&a.state==='moving'){a._checkT=this.cornerCheckInterval*(.75+.5*hash01(a.id*7+Math.floor(this.time*10)));
        for(let s=0;s<2&&a.pathIndex<last;s++){const c=path[a.pathIndex+1];if(!this.nav._raycast(x,z,c.x,c.z,this._ray).hit)a.pathIndex++;else break;}
        const c=path[a.pathIndex];if(this.nav._raycast(x,z,c.x,c.z,this._ray).hit)this._request(a);}
      const c=path[a.pathIndex],dx=c.x-x,dz=c.z-z,d=Math.hypot(dx,dz);let speed=a.maxSpeed;
      if(a.pathIndex===last){if(d<a.slowDistance)speed*=d/a.slowDistance;if(d<a.arriveDistance*.35)speed=0;}
      if(d>1e-6){a._prefx=dx/d*speed;a._prefz=dz/d*speed;}
      /* counter-flow lane bias: everyone sidesteps to the same side of oncoming agents ahead, which forms lanes
         instead of head-on ORCA deadlocks in doorways and corridors */
      if(this.laneBias>0&&speed>1e-3&&d>a.radius){const ux=dx/d,uz=dz/d,K=this.maxNeighbors,base=a.index*K,cnt=this._nbrN[a.index],range=a.radius*8;let s=0;
        for(let k=0;k<cnt;k++){const b=this.agents[this._nbr[base+k]],rx=b.position.x-x,rz=b.position.z-z,ahead=rx*ux+rz*uz,dd=Math.sqrt(this._nbrD[base+k]);
          if(ahead<=0||dd>range)continue;const bv=b.velocity.x*ux+b.velocity.z*uz;if(bv>-.25*b.maxSpeed)continue;
          const lat=rx*uz-rz*ux;/* >0: neighbour is on our right */s+=(1-dd/range)*(lat>a.radius*2?.3:1);}
        if(s>0){const k=Math.min(1,s)*this.laneBias*speed;a._prefx+=-uz*k;a._prefz+=ux*k;}}
    }
    if(a.separationWeight>0&&this.separation>0){const K=this.maxNeighbors,base=a.index*K,cnt=this._nbrN[a.index];let sx=0,sz=0;
      for(let k=0;k<cnt;k++){const b=this.agents[this._nbr[base+k]],sep=(a.radius+b.radius)*this.separation,d=Math.sqrt(this._nbrD[base+k]);
        if(d>=sep||d<1e-6)continue;const w=1-d/sep;sx+=(x-b.position.x)/d*w;sz+=(z-b.position.z)/d*w;}
      a._prefx+=sx*a.separationWeight*a.maxSpeed;a._prefz+=sz*a.separationWeight*a.maxSpeed;}
    const l=Math.hypot(a._prefx,a._prefz);if(l>a.maxSpeed){a._prefx*=a.maxSpeed/l;a._prefz*=a.maxSpeed/l;}
    a.desiredVelocity.set(a._prefx,0,a._prefz);
  }
  /* ORCA: one half-plane per neighbour, then the velocity closest to the preferred one (lp2, lp3 fallback). */
  _orca(i,dt){
    const A=this.agents,a=A[i];if(!a.avoidance){a._nvx=a._prefx;a._nvz=a._prefz;return;}
    const K=this.maxNeighbors,base=i*K,cnt=this._nbrN[i],P=this._lp,D=this._ld,invTH=1/this.timeHorizon,vx=a.velocity.x,vz=a.velocity.z;let nl=0;
    for(let k=0;k<cnt;k++){const b=A[this._nbr[base+k]],rpx=b.position.x-a.position.x,rpz=b.position.z-a.position.z,rvx=vx-b.velocity.x,rvz=vz-b.velocity.z,d2=rpx*rpx+rpz*rpz,R=a.radius+b.radius,R2=R*R;
      let dx,dz,ux,uz;
      if(d2>R2){const wx=rvx-invTH*rpx,wz=rvz-invTH*rpz,wl2=wx*wx+wz*wz,dp1=wx*rpx+wz*rpz;
        if(dp1<0&&dp1*dp1>R2*wl2){const wl=Math.sqrt(wl2),nx=wx/wl,nz=wz/wl;dx=nz;dz=-nx;const m=R*invTH-wl;ux=m*nx;uz=m*nz;}
        else{const leg=Math.sqrt(d2-R2);
          if(rpx*wz-rpz*wx>0){dx=(rpx*leg-rpz*R)/d2;dz=(rpx*R+rpz*leg)/d2;}else{dx=-(rpx*leg+rpz*R)/d2;dz=-(-rpx*R+rpz*leg)/d2;}
          const dp2=rvx*dx+rvz*dz;ux=dp2*dx-rvx;uz=dp2*dz-rvz;}}
      else{const inv=1/dt,wx=rvx-inv*rpx,wz=rvz-inv*rpz,wl=Math.hypot(wx,wz)||1e-9,nx=wx/wl,nz=wz/wl;dx=nz;dz=-nx;const m=R*inv-wl;ux=m*nx;uz=m*nz;}
      const share=b.avoidance?.5:1;P[nl*2]=vx+share*ux;P[nl*2+1]=vz+share*uz;D[nl*2]=dx;D[nl*2+1]=dz;nl++;}
    const res=this._res,fail=lp2(P,D,nl,a.maxSpeed,a._prefx,a._prefz,false,res);if(fail<nl)lp3(P,D,nl,fail,a.maxSpeed,res,this._pp,this._pd);
    a._nvx=res[0];a._nvz=res[1];
  }
  /* Keep the agent on the mesh: track its polygon through links, else clamp to the nearest mesh point and
     remove the velocity component pushing off the mesh (wall sliding). */
  _constrain(a){
    const nav=this.nav,x=a.position.x,z=a.position.z;let p=a.poly;
    if(p&&(p.dead||!pointInPoly(p,x,z,1e-6))){let q=null;if(!p.dead)for(const l of p.links)if(!l.to.dead&&pointInPoly(l.to,x,z,1e-6)){q=l.to;break;}p=q||nav.findPoly(x,z,1e-6);}
    else if(!p)p=nav.findPoly(x,z,1e-6);
    if(!p){const r=nav._nearest(x,z,Math.max(4,a.radius*8),this._near);if(r){const dx=r.x-x,dz=r.z-z,l=Math.hypot(dx,dz);a.position.x=r.x;a.position.z=r.z;p=r.poly;
      if(l>1e-9){const nx=dx/l,nz=dz/l,vn=a.velocity.x*nx+a.velocity.z*nz;if(vn<0){a.velocity.x-=vn*nx;a.velocity.z-=vn*nz;}}}}
    a.poly=p;a.position.y=nav.heightFn?nav.heightAt(a.position.x,a.position.z):p?polyHeight(p,a.position.x,a.position.z):a.position.y;
  }
  _updateState(a,dt){
    if(!a.target||!a.path.length)return;const last=a.path[a.path.length-1],d=Math.hypot(last.x-a.position.x,last.z-a.position.z);
    if(a.state==='moving'){
      if(a.pathIndex>=a.path.length-1&&d<=a.arriveDistance){if(a.partial){a.state='unreachable';this._emit('unreachable',a);}else{a.state='arrived';if(!a._arrived){a._arrived=true;this._emit('arrive',a);}}return;}
      if(a.speed<a.maxSpeed*.08){a._stuck+=dt;if(a._stuck>this.stuckTime){a._stuck=0;this._request(a);}}else a._stuck=Math.max(0,a._stuck-dt);}
    else if(a.state==='arrived'&&d>a.arriveDistance*3+a.radius){a.state='moving';a.pathIndex=a.path.length-1;a._checkT=0;}
  }
  update(dt){
    dt=+dt;if(!(dt>0))return this;dt=Math.min(dt,.1);this.time+=dt;
    const A=this.agents,n=A.length,nav=this.nav;if(!n)return this;
    if(nav.revision!==this._rev){this._rev=nav.revision;for(const a of A){if(a.poly&&a.poly.dead)a.poly=null;if(a.target&&a.corridor&&a.corridor.some(p=>p.dead))this._request(a);}}
    for(let budget=this.maxPathsPerUpdate;budget>0&&this._queue.length;){const a=this._queue.shift();a._queued=false;if(a.crowd!==this||!a._needsPath||!a.target)continue;this._plan(a);budget--;}
    this._buildHash();for(let i=0;i<n;i++)this._neighbors(i);
    for(let i=0;i<n;i++)this._preferred(A[i],dt);
    for(let i=0;i<n;i++)this._orca(i,dt);
    for(let i=0;i<n;i++){const a=A[i];let dvx=a._nvx-a.velocity.x,dvz=a._nvz-a.velocity.z;const dv=Math.hypot(dvx,dvz),mx=a.maxAccel*dt;
      if(dv>mx){dvx*=mx/dv;dvz*=mx/dv;}a.velocity.x+=dvx;a.velocity.z+=dvz;a.velocity.y=0;a.position.x+=a.velocity.x*dt;a.position.z+=a.velocity.z*dt;}
    /* positional collision resolution (Detour style: averaged half-penetration pushes) */
    const K=this.maxNeighbors,nb=this._nbr;
    for(let it=0;it<this.collisionIterations;it++){
      for(let i=0;i<n;i++){const a=A[i],base=i*K,cnt=this._nbrN[i];let dx=0,dz=0,w=0;
        for(let k=0;k<cnt;k++){const b=A[nb[base+k]];let ex=a.position.x-b.position.x,ez=a.position.z-b.position.z;const R=a.radius+b.radius,d2=ex*ex+ez*ez;if(d2>=R*R)continue;
          let d=Math.sqrt(d2),pen=R-d;if(d<1e-4){const ang=hash01(Math.min(a.id,b.id)*65537+Math.max(a.id,b.id))*Math.PI*2,s=a.id<b.id?1:-1;ex=Math.cos(ang)*s;ez=Math.sin(ang)*s;d=1;pen=Math.max(pen,.01);}
          const f=pen*.5*.7/d;dx+=ex*f;dz+=ez*f;w++;}
        if(w){a._dx=dx/w;a._dz=dz/w;}else a._dx=a._dz=0;}
      for(let i=0;i<n;i++){A[i].position.x+=A[i]._dx;A[i].position.z+=A[i]._dz;}}
    for(let i=0;i<n;i++){this._constrain(A[i]);this._updateState(A[i],dt);}
    return this;
  }
  /* Agents within radius of (x,z); fills and returns out. */
  query(x,z,radius,out=[]){out.length=0;for(const a of this.agents)if((a.position.x-x)**2+(a.position.z-z)**2<=radius*radius)out.push(a);return out;}
  /* Instanced debug view: one cylinder per agent coloured by state plus a heading marker. */
  debugView(THREE=this.nav.THREE,{colors={}}={}){
    const T=THREE,M=this.maxAgents,C={moving:0xff8a3d,arrived:0x3ccf6e,waiting:0xd9d9d9,unreachable:0xe23d3d,idle:0x8fa3bf,...colors};
    const bg=new T.CylinderGeometry(1,1,1,20,1),ng=new T.ConeGeometry(.5,1,3);ng.rotateX(Math.PI/2);
    const body=new T.InstancedMesh(bg,new T.MeshLambertMaterial({color:0xffffff}),M),nose=new T.InstancedMesh(ng,new T.MeshLambertMaterial({color:0x1d2330}),M);
    body.frustumCulled=nose.frustumCulled=false;body.instanceMatrix.setUsage(T.DynamicDrawUsage);nose.instanceMatrix.setUsage(T.DynamicDrawUsage);
    const m=new T.Matrix4(),q=new T.Quaternion(),s=new T.Vector3(),p=new T.Vector3(),c=new T.Color(),up=new T.Vector3(0,1,0),group=new T.Group();group.name='ke-crowd-debug';group.add(body,nose);
    const view={object:group,update:()=>{const A=this.agents;body.count=nose.count=A.length;
      for(let i=0;i<A.length;i++){const a=A[i],h=a.height;if(a.speed>.05)a._yaw=Math.atan2(a.velocity.x,a.velocity.z);
        q.identity();p.set(a.position.x,a.position.y+h/2,a.position.z);s.set(a.radius,h,a.radius);m.compose(p,q,s);body.setMatrixAt(i,m);c.set(C[a.state]!==undefined?C[a.state]:C.idle);body.setColorAt(i,c);
        q.setFromAxisAngle(up,a._yaw);p.set(a.position.x+Math.sin(a._yaw)*a.radius*.3,a.position.y+h+.02,a.position.z+Math.cos(a._yaw)*a.radius*.3);s.set(a.radius*1.1,a.radius*.12,a.radius*1.2);m.compose(p,q,s);nose.setMatrixAt(i,m);}
      body.instanceMatrix.needsUpdate=nose.instanceMatrix.needsUpdate=true;if(body.instanceColor)body.instanceColor.needsUpdate=true;},
      dispose:()=>{bg.dispose();ng.dispose();body.material.dispose();nose.material.dispose();group.parent&&group.parent.remove(group);}};
    view.update();return view;
  }
  dispose(){for(const a of this.agents){a.crowd=null;a.state='removed';}this.agents=[];this._queue=[];this.events.clear();}
}
KE.Crowd=Crowd;KE.CrowdAgent=CrowdAgent;

/* ======================================================================
   Blackboard
   ====================================================================== */
class Blackboard{
  constructor(initial={},parent=null){this._data=new Map();this.parent=parent instanceof Blackboard?parent:null;this._ls=new Map();
    if(initial&&typeof initial==='object')for(const k of Object.keys(initial))this._data.set(k,initial[k]);}
  get(k,fallback){if(this._data.has(k))return this._data.get(k);return this.parent?this.parent.get(k,fallback):fallback;}
  has(k){return this._data.has(k)||(!!this.parent&&this.parent.has(k));}
  set(k,v){const had=this.has(k),old=this.get(k);this._data.set(k,v);if(!had||!Object.is(old,v))this._emit(k,v,old);return this;}
  delete(k){if(!this._data.has(k))return false;const old=this._data.get(k);this._data.delete(k);this._emit(k,this.get(k),old);return true;}
  /* onChange(key, fn) or onChange(fn) for every key; fn(value, oldValue, key, blackboard). Returns an unsubscribe function. */
  onChange(key,fn){if(isFn(key)){fn=key;key='*';}if(!isFn(fn))throw new TypeError('Blackboard listener must be a function');let s=this._ls.get(key);if(!s)this._ls.set(key,s=new Set());s.add(fn);return ()=>{s.delete(fn);};}
  _emit(k,v,old){const a=this._ls.get(k),b=this._ls.get('*');if(a)for(const f of [...a])f(v,old,k,this);if(b)for(const f of [...b])f(v,old,k,this);}
  keys(){return [...this._data.keys()];}
  clear(){for(const k of [...this._data.keys()])this.delete(k);}
  toJSON(){const o={};for(const [k,v] of this._data)o[k]=v;return o;}
}
KE.Blackboard=Blackboard;

/* ======================================================================
   Behavior trees
   ====================================================================== */
/* Node definitions are plain immutable objects; a tree instance flattens them into arrays with per-instance
   memory, so one definition can drive many AIs. Composites keep the running child between ticks ("memory");
   pass {memory:false} for reactive composites that re-evaluate from the first child every tick.
   Condition decorators support UE-style observer aborts, polled every tick:
     'self'  - while the decorated subtree runs, abort it (failure) as soon as the condition turns false;
     'lower' - while a lower-priority sibling runs, abort it when this condition's result changes (for a
               selector: becomes true; for a sequence: becomes false) and resume from this child;
     'both'  - both of the above. */
const BB_OPS={'==':(a,b)=>a===b,'!=':(a,b)=>a!==b,'<':(a,b)=>a<b,'<=':(a,b)=>a<=b,'>':(a,b)=>a>b,'>=':(a,b)=>a>=b,
  set:a=>a!==undefined&&a!==null,unset:a=>a===undefined||a===null,truthy:a=>!!a,falsy:a=>!a,in:(a,b)=>Array.isArray(b)&&b.includes(a)};
const BT_TYPES={selector:1,sequence:1,parallel:1,inverter:1,succeeder:1,failer:1,repeat:1,retry:1,cooldown:1,timeout:1,condition:1,action:1,wait:1,subtree:1};
const DECORATORS=new Set(['inverter','succeeder','failer','repeat','retry','cooldown','timeout','condition','subtree']);
const BT_NODES=new WeakSet(),isNode=n=>!!n&&typeof n==='object'&&BT_NODES.has(n);
const abortMode=a=>{if(a===undefined||a===null||a===false)return 'none';if(['none','self','lower','both'].includes(a))return a;throw new RangeError('BT abort mode must be none, self, lower or both');};
const btNode=(type,o,extra)=>{if(!hasOwn(BT_TYPES,type))throw new TypeError('Unknown BT node type '+type);const n=Object.freeze({type,name:typeof o.name==='string'?o.name:type,...extra});BT_NODES.add(n);return n;};
const btKids=c=>{if(!Array.isArray(c)||!c.length)throw new TypeError('BT composite needs a non-empty child array');c.forEach(x=>{if(!isNode(x))throw new TypeError('BT child is not a node');});return Object.freeze(c.slice());};
const btOne=c=>{if(!isNode(c))throw new TypeError('BT decorator needs a child node');return c;};
const secs=(o,d)=>{const O=typeof o==='number'?{duration:o}:(o||{});const v=num(+O.duration,d);if(!(v>=0))throw new RangeError('BT duration must be >= 0');return [v,O];};

const BT_ENTER={
  selector:(t,i,n,m)=>{m.i=0;},sequence:(t,i,n,m)=>{m.i=0;},
  parallel:(t,i,n,m)=>{const k=t.kids[i].length;if(!m.cs||m.cs.length!==k)m.cs=new Array(k);m.cs.fill(null);},
  repeat:(t,i,n,m)=>{m.n=0;},retry:(t,i,n,m)=>{m.n=0;},timeout:(t,i,n,m)=>{m.t0=t.time;},
  wait:(t,i,n,m)=>{m.until=t.time+(n.max>n.min?n.min+t.rng()*(n.max-n.min):n.min);},
  action:(t,i,n,m)=>{m.data={};if(n.onEnter)n.onEnter(t.ctx,t.blackboard,m.data,t);}
};
const BT_EXIT={
  action:(t,i,n,m,s)=>{if(n.onExit)n.onExit(t.ctx,s,t.blackboard,m.data,t);},
  cooldown:(t,i,n,m,s)=>{if(s==='aborted')m.readyAt=t.time+n.duration;}
};
function btComposite(t,i,n,m,stopOn){ // stopOn: FAILURE for sequence, SUCCESS for selector
  const k=t.kids[i],prev=m.running?m.i:-1;let start=0;
  if(n.memory&&m.running){start=m.i;const j=t._lowerAbort(i,start);if(j>=0){t._halt(k[start]);start=j;}}
  for(let c=start;c<k.length;c++){const s=t._exec(k[c]);
    if(s===RUNNING){if(prev>=0&&prev!==c)t._halt(k[prev]);m.i=c;return RUNNING;}
    if(s===stopOn){if(prev>c)t._halt(k[prev]);m.i=0;return stopOn;}}
  m.i=0;return stopOn===FAILURE?SUCCESS:FAILURE;
}
const BT_TICK={
  sequence:(t,i,n,m)=>btComposite(t,i,n,m,FAILURE),
  selector:(t,i,n,m)=>btComposite(t,i,n,m,SUCCESS),
  parallel:(t,i,n,m)=>{const k=t.kids[i],N=k.length;let ok=0,bad=0;
    for(let c=0;c<N;c++){let s=m.cs[c];if(s===null){s=t._exec(k[c]);if(s!==RUNNING)m.cs[c]=s;}if(s===SUCCESS)ok++;else if(s===FAILURE)bad++;}
    const done=r=>{for(const c of k)t._halt(c);return r;};
    if(n.success==='one'?ok>0:ok===N)return done(SUCCESS);if(n.failure==='one'?bad>0:bad===N)return done(FAILURE);
    if(ok+bad===N)return FAILURE;return RUNNING;},
  inverter:(t,i)=>{const s=t._exec(t.kids[i][0]);return s===SUCCESS?FAILURE:s===FAILURE?SUCCESS:s;},
  succeeder:(t,i)=>{const s=t._exec(t.kids[i][0]);return s===RUNNING?s:SUCCESS;},
  failer:(t,i)=>{const s=t._exec(t.kids[i][0]);return s===RUNNING?s:FAILURE;},
  repeat:(t,i,n,m)=>{const s=t._exec(t.kids[i][0]);if(s===RUNNING)return s;if(s===FAILURE&&!n.ignoreFailure)return FAILURE;return ++m.n>=n.count?SUCCESS:RUNNING;},
  retry:(t,i,n,m)=>{const s=t._exec(t.kids[i][0]);if(s!==FAILURE)return s;return ++m.n>=n.count?FAILURE:RUNNING;},
  cooldown:(t,i,n,m)=>{if(!m.running&&t.time<m.readyAt-1e-9)return FAILURE;const s=t._exec(t.kids[i][0]);if(s!==RUNNING)m.readyAt=t.time+n.duration;return s;},
  timeout:(t,i,n,m)=>{if(t.time-m.t0>=n.duration){t._halt(t.kids[i][0]);return FAILURE;}return t._exec(t.kids[i][0]);},
  condition:(t,i,n,m)=>{
    if(!n.child){m.cond=t._cond(i);return m.cond?SUCCESS:FAILURE;}
    if(!m.running){m.cond=t._cond(i);if(!m.cond)return FAILURE;}
    else if(n.abort==='self'||n.abort==='both'){m.cond=t._cond(i);if(!m.cond){t._halt(t.kids[i][0]);return FAILURE;}}
    return t._exec(t.kids[i][0]);},
  action:(t,i,n,m)=>{const r=n.fn(t.ctx,t.blackboard,t.dt,m.data,t);
    if(r===SUCCESS||r===FAILURE||r===RUNNING)return r;if(r===true||r===undefined||r===null)return SUCCESS;if(r===false)return FAILURE;
    throw new TypeError('BT action "'+n.name+'" returned an invalid status: '+String(r));},
  wait:(t,i,n,m)=>t.time>=m.until-1e-9?SUCCESS:RUNNING,
  subtree:(t,i)=>t._exec(t.kids[i][0])
};
class BehaviorTree{
  constructor(root,{blackboard=null,seed=1,name='tree'}={}){
    if(!isNode(root))throw new TypeError('KE.BT.tree needs a root node');
    this.nodes=[];this.kids=[];this.mem=[];this.name=name;
    const walk=(n,depth)=>{if(depth>128)throw new RangeError('Behavior tree nested too deeply (recursive subtree?)');if(this.nodes.length>=20000)throw new RangeError('Behavior tree too large');
      const i=this.nodes.length;this.nodes.push(n);this.kids.push(null);this.mem.push({status:null,running:false,i:0,n:0,t0:0,until:0,readyAt:-Infinity,cond:undefined,cs:null,data:null,tick:-1});
      const ch=n.children||(n.child?[n.child]:[]);this.kids[i]=ch.map(c=>walk(c,depth+1));return i;};
    walk(root,0);
    this.blackboard=blackboard instanceof Blackboard?blackboard:new Blackboard(blackboard||{});
    this.rng=KE.random(seed);this.time=0;this.dt=0;this.ticks=0;this.ctx=undefined;this.status=null;
  }
  /* One evaluation from the root. ctx is passed to every action/condition. */
  tick(dt=0,ctx){dt=+dt;this.dt=Number.isFinite(dt)&&dt>0?dt:0;this.time+=this.dt;this.ctx=ctx;this.ticks++;return this.status=this._exec(0);}
  _exec(i){const n=this.nodes[i],m=this.mem[i];if(!m.running&&BT_ENTER[n.type])BT_ENTER[n.type](this,i,n,m);
    const s=BT_TICK[n.type](this,i,n,m);m.status=s;m.tick=this.ticks;m.running=s===RUNNING;if(!m.running&&BT_EXIT[n.type])BT_EXIT[n.type](this,i,n,m,s);return s;}
  _halt(i){const m=this.mem[i];if(!m.running)return;for(const c of this.kids[i])this._halt(c);m.running=false;m.status='aborted';const n=this.nodes[i];if(BT_EXIT[n.type])BT_EXIT[n.type](this,i,n,m,'aborted');}
  _cond(i){return !!this.nodes[i].fn(this.ctx,this.blackboard,this);}
  _lowerAbort(i,upto){const k=this.kids[i];
    for(let c=0;c<upto;c++){let j=k[c];
      for(let d=0;d<16&&j!==undefined;d++){const n=this.nodes[j];
        if(n.type==='condition'&&n.child&&(n.abort==='lower'||n.abort==='both')&&this._cond(j)!==this.mem[j].cond)return c;
        if(!DECORATORS.has(n.type))break;j=this.kids[j][0];}}
    return -1;}
  /* Abort everything that is running (actions get onExit(ctx,'aborted')). */
  halt(){this._halt(0);return this;}
  /* halt() and forget all node memory, including cooldowns. */
  reset(){this._halt(0);for(const m of this.mem)Object.assign(m,{status:null,running:false,i:0,n:0,t0:0,until:0,readyAt:-Infinity,cond:undefined,cs:null,data:null,tick:-1});this.status=null;return this;}
  debugState(i=0){const n=this.nodes[i],m=this.mem[i],o={type:n.type,name:n.name,status:m.status,running:m.running,lastTick:m.tick};
    if(n.type==='condition'){o.abort=n.abort;o.value=m.cond;if(n.key!==undefined){o.key=n.key;o.op=n.op;o.compare=n.value;}}
    if(n.type==='cooldown')o.readyIn=Math.max(0,m.readyAt-this.time);if(n.type==='wait'&&m.running)o.remaining=Math.max(0,m.until-this.time);
    if(n.type==='repeat'||n.type==='retry')o.count=m.n;
    const k=this.kids[i];if(k.length)o.children=k.map(c=>this.debugState(c));return o;}
  debugString(){const lines=[],rec=(o,d)=>{lines.push('  '.repeat(d)+(o.running?'> ':'  ')+o.name+(o.name!==o.type?' ('+o.type+')':'')+(o.status?' ['+o.status+']':''));(o.children||[]).forEach(c=>rec(c,d+1));};rec(this.debugState(),0);return lines.join('\n');}
}
const BT={SUCCESS,FAILURE,RUNNING,ops:Object.keys(BB_OPS),
  selector:(children,o={})=>btNode('selector',o,{children:btKids(children),memory:o.memory!==false}),
  sequence:(children,o={})=>btNode('sequence',o,{children:btKids(children),memory:o.memory!==false}),
  parallel:(children,o={})=>{const success=o.success==='one'?'one':'all',failure=o.failure==='one'||o.failure==='all'?o.failure:success==='all'?'one':'all';
    return btNode('parallel',o,{children:btKids(children),success,failure});},
  inverter:(child,o={})=>btNode('inverter',o,{child:btOne(child)}),
  succeeder:(child,o={})=>btNode('succeeder',o,{child:btOne(child)}),
  failer:(child,o={})=>btNode('failer',o,{child:btOne(child)}),
  repeat:(child,o={})=>{const O=typeof o==='number'?{count:o}:o;const count=O.count===undefined?Infinity:Math.max(1,Math.floor(+O.count));if(!(count>=1))throw new RangeError('BT repeat count must be >= 1');
    return btNode('repeat',O,{child:btOne(child),count,ignoreFailure:!!O.ignoreFailure});},
  retry:(child,o={})=>{const O=typeof o==='number'?{count:o}:o;const count=Math.max(1,Math.floor(num(+O.count,3)));return btNode('retry',O,{child:btOne(child),count});},
  cooldown:(child,o)=>{const [duration,O]=secs(o,1);return btNode('cooldown',O,{child:btOne(child),duration});},
  timeout:(child,o)=>{const [duration,O]=secs(o,1);return btNode('timeout',O,{child:btOne(child),duration});},
  /* condition(fn[, child][, {abort,name}]): fn(ctx, blackboard, tree) -> truthy. Without a child it is a leaf. */
  condition:(fn,a,b)=>{if(!isFn(fn))throw new TypeError('BT.condition needs a function');const child=isNode(a)?a:null,O=(child?b:a)||{};
    return btNode('condition',O,{fn,child,abort:child?abortMode(O.abort):'none'});},
  /* blackboardCondition(key, op[, value][, child][, opts]); ops: == != < <= > >= set unset truthy falsy in (value may be omitted for unary ops) */
  blackboardCondition:(key,op,value,a,b)=>{if(isNode(value)){b=a;a=value;value=undefined;}/* unary ops may omit the value */
    if(typeof key!=='string')throw new TypeError('blackboardCondition key must be a string');if(!hasOwn(BB_OPS,op))throw new RangeError('Unknown blackboard op: '+op);
    const cmp=BB_OPS[op],child=isNode(a)?a:null,O=(child?b:a)||{};
    return btNode('condition',{name:O.name||'bb:'+key+' '+op+(value===undefined?'':' '+String(value))},{fn:(ctx,bb)=>cmp(bb.get(key),value),key,op,value,child,abort:child?abortMode(O.abort):'none'});},
  /* action(fn, {onEnter, onExit, name}): fn(ctx, blackboard, dt, memory, tree) -> 'success'|'failure'|'running'|boolean|undefined(=success). */
  action:(fn,o={})=>{if(!isFn(fn))throw new TypeError('BT.action needs a function');return btNode('action',o,{fn,onEnter:isFn(o.onEnter)?o.onEnter:null,onExit:isFn(o.onExit)?o.onExit:null});},
  /* wait(seconds | [min,max] | {min,max}) */
  wait:(d,o={})=>{let min,max;if(Array.isArray(d)){min=+d[0];max=+d[1];}else if(d&&typeof d==='object'){min=+d.min;max=+d.max;o=d;}else{min=max=+d;}
    if(!Number.isFinite(max))max=min;if(!(min>=0)||!(max>=min))throw new RangeError('BT.wait needs 0 <= min <= max');return btNode('wait',o,{min,max});},
  subtree:(root,o={})=>btNode('subtree',o,{child:btOne(root)}),
  tree:(root,o)=>new BehaviorTree(root,o),
  /* Build from JSON: {type, name?, children|child, ...}; actions/conditions/subtrees resolve by name from the registry
     {actions:{name:fn|{fn,onEnter,onExit}}, conditions:{name:fn}, subtrees:{name:json|node}}. No code is evaluated. */
  fromJSON(json,registry={}){
    let count=0;const reg=k=>registry&&registry[k]&&typeof registry[k]==='object'?registry[k]:{},stack=[];
    const lookup=(table,name,path)=>{if(typeof name!=='string'||!hasOwn(reg(table),name))throw new Error(path+': unknown '+table.replace(/s$/,'')+' "'+name+'"');return reg(table)[name];};
    const build=(j,path,depth)=>{
      if(depth>64)throw new RangeError(path+': nested too deeply');if(++count>10000)throw new RangeError('Behavior tree JSON too large');
      if(!j||typeof j!=='object'||Array.isArray(j))throw new TypeError(path+': node must be an object');
      const o=typeof j.name==='string'?{name:j.name.slice(0,64)}:{},kids=()=>{if(!Array.isArray(j.children)||!j.children.length)throw new TypeError(path+': children required');return j.children.map((c,k)=>build(c,path+'.children['+k+']',depth+1));};
      const kid=()=>{const c=j.child!==undefined?j.child:Array.isArray(j.children)&&j.children.length===1?j.children[0]:undefined;if(c===undefined)throw new TypeError(path+': child required');return build(c,path+'.child',depth+1);};
      const hasKid=j.child!==undefined||(Array.isArray(j.children)&&j.children.length===1);
      switch(j.type){
        case 'selector':case 'sequence':return BT[j.type](kids(),{...o,memory:j.memory!==false});
        case 'parallel':return BT.parallel(kids(),{...o,success:j.success,failure:j.failure});
        case 'inverter':case 'succeeder':case 'failer':return BT[j.type](kid(),o);
        case 'repeat':return BT.repeat(kid(),{...o,count:j.count===undefined||j.count===null?undefined:j.count,ignoreFailure:!!j.ignoreFailure});
        case 'retry':return BT.retry(kid(),{...o,count:j.count});
        case 'cooldown':case 'timeout':return BT[j.type](kid(),{...o,duration:j.duration});
        case 'wait':return BT.wait(j.min!==undefined?[j.min,j.max]:j.duration,o);
        case 'action':{const a=lookup('actions',j.action!==undefined?j.action:j.name,path);if(isFn(a))return BT.action(a,{name:j.action||j.name,...o});
          if(a&&isFn(a.fn))return BT.action(a.fn,{name:j.action||j.name,...o,onEnter:a.onEnter,onExit:a.onExit});throw new TypeError(path+': invalid action entry');}
        case 'condition':{const f=lookup('conditions',j.condition!==undefined?j.condition:j.name,path);const O={name:j.condition||j.name,...o,abort:j.abort};return hasKid?BT.condition(f,kid(),O):BT.condition(f,O);}
        case 'blackboardCondition':{const O={...o,abort:j.abort};return hasKid?BT.blackboardCondition(j.key,j.op,j.value,kid(),O):BT.blackboardCondition(j.key,j.op,j.value,O);}
        case 'subtree':{const ref=j.ref;if(stack.includes(ref))throw new Error(path+': recursive subtree "'+ref+'"');const s=lookup('subtrees',ref,path);
          if(isNode(s))return BT.subtree(s,{name:ref,...o});stack.push(ref);try{return BT.subtree(build(s,path+'<'+ref+'>',depth+1),{name:ref,...o});}finally{stack.pop();}}
        default:throw new TypeError(path+': unknown node type "'+String(j.type)+'"');}
    };
    return build(json,'root',0);
  }
};
KE.BT=BT;KE.BehaviorTree=BehaviorTree;

/* ======================================================================
   Perception
   ====================================================================== */
/* Sight: 3D range, horizontal FOV cone, optional line-of-sight test (function, NavMesh raycast or an array
   of Object3D occluders with THREE), optional detection time (awareness builds faster when close).
   Hearing: hear(position, loudness) or KE.events 'noise'; heard if distance <= hearing.range * loudness.
   Memory: a target stays in `known` for memory seconds after it was last sensed. */
class Perception{
  constructor(a,b){
    let THREE=null,o=a;if(a&&a.Vector3){THREE=a;o=b;}o=o||{};this.THREE=THREE;
    this.sight=o.sight===false?null:{range:15,fov:110,height:1.6,targetHeight:1,lineOfSight:null,detectTime:0,proximity:0,...(o.sight||{})};
    this.hearing=o.hearing===false?null:{range:12,...(o.hearing||{})};
    const mem=o.memory;this.memory=typeof mem==='number'?mem:mem&&Number.isFinite(mem.duration)?mem.duration:5;
    this.known=new Map();this.time=0;this.events=new KE.Events();
    for(const k of ['onSee','onLose','onHear','onForget'])this[k]=isFn(o[k])?o[k]:null;
    this.origin=this._vec(0,0,0);this.forward={x:0,z:1};this._eye=this._vec(0,0,0);this._tp=this._vec(0,0,0);this._seen=new Set();this._offs=[];this._ray=null;this._hits=[];this._seq=0;
  }
  _vec(x,y,z){return this.THREE?new this.THREE.Vector3(x,y,z):{x,y,z,set(a,b,c){this.x=a;this.y=b;this.z=c;return this;}};}
  _fire(kind,target,rec){const cb=this['on'+kind[0].toUpperCase()+kind.slice(1)];if(cb)cb(target,rec,this);this.events.emit(kind,target,rec,this);}
  _record(target){let r=this.known.get(target);if(!r){r={target,visible:false,awareness:0,lastSeen:-Infinity,lastHeard:-Infinity,lastSensed:-Infinity,sense:null,
    lastKnown:this._vec(0,0,0),velocity:this._vec(0,0,0),distance:Infinity,loudness:0,seq:0};this.known.set(target,r);}return r;}
  _los(eye,tp,target){const L=this.sight.lineOfSight;if(!L)return true;if(isFn(L))return !!L(eye,tp,target,this);
    if(L instanceof NavMesh)return !L._raycast(eye.x,eye.z,tp.x,tp.z,L._ray).hit;
    if(Array.isArray(L)&&this.THREE){const T=this.THREE;if(!this._ray){this._ray=new T.Raycaster();this._dir=new T.Vector3();}const dir=this._dir.set(tp.x-eye.x,tp.y-eye.y,tp.z-eye.z),d=dir.length();if(d<1e-6)return true;
      this._ray.set(eye,dir.divideScalar(d));this._ray.far=d-.05;this._hits.length=0;return this._ray.intersectObjects(L,true,this._hits).length===0;}
    return true;}
  _forwardOf(self){const f=this.forward;
    if(self.forward){f.x=self.forward.x;f.z=self.forward.z;}
    else if(Number.isFinite(self.heading)){f.x=Math.sin(self.heading);f.z=Math.cos(self.heading);}
    else if(self.quaternion){const q=self.quaternion;f.x=2*(q.x*q.z+q.w*q.y);f.z=1-2*(q.x*q.x+q.y*q.y);}
    else if(self.rotation&&Number.isFinite(self.rotation.y)){f.x=Math.sin(self.rotation.y);f.z=Math.cos(self.rotation.y);}
    else if(self.velocity&&Math.hypot(self.velocity.x,self.velocity.z)>1e-3){f.x=self.velocity.x;f.z=self.velocity.z;} // e.g. crowd agents; keeps the last facing when stopped
    const l=Math.hypot(f.x,f.z);if(l>1e-9){f.x/=l;f.z/=l;}else{f.x=0;f.z=1;}return f;}
  /* self: {position, forward|heading|quaternion}; candidates: objects with .position (or x/y/z), optional .height. */
  update(dt,self,candidates=[]){
    dt=Math.max(0,+dt||0);this.time+=dt;const pos=self.position||self;this.origin.set(pos.x,num(pos.y,0),pos.z);const f=this._forwardOf(self),S=this.sight,seen=this._seen;seen.clear();
    if(S){const eye=this._eye.set(this.origin.x,this.origin.y+S.height,this.origin.z),cosHalf=Math.cos(clamp(S.fov,0,360)*DEG/2);
      for(const c of candidates){if(!c||c===self)continue;const p=c.position||c;if(!Number.isFinite(p.x)||!Number.isFinite(p.z))continue;
        const th=Number.isFinite(c.height)?c.height*.75:S.targetHeight,tp=this._tp.set(p.x,num(p.y,0)+th,p.z);
        const dx=tp.x-eye.x,dy=tp.y-eye.y,dz=tp.z-eye.z,d=Math.sqrt(dx*dx+dy*dy+dz*dz);if(d>S.range)continue;
        const hd=Math.hypot(dx,dz);const inFov=d<=S.proximity||hd<1e-6||S.fov>=360||(dx*f.x+dz*f.z)/hd>=cosHalf;if(!inFov)continue;
        if(!this._los(eye,tp,c))continue;
        const r=this._record(c);seen.add(c);
        if(S.detectTime>0)r.awareness=Math.min(1,r.awareness+dt/S.detectTime*(1+Math.max(0,1-d/S.range)));else r.awareness=1;
        if(r.awareness>=1){if(r.lastSeen>-Infinity&&this.time>r.lastSeen){const k=1/Math.max(1e-3,this.time-r.lastSeen);r.velocity.set((p.x-r.lastKnown.x)*k,0,(p.z-r.lastKnown.z)*k);}
          r.lastKnown.set(p.x,num(p.y,0),p.z);r.lastSeen=r.lastSensed=this.time;r.seq=++this._seq;r.sense='sight';r.distance=d;
          if(!r.visible){r.visible=true;this._fire('see',c,r);}}}}
    for(const [t,r] of this.known){
      if(!seen.has(t)){if(r.visible){r.visible=false;this._fire('lose',t,r);}if(S&&S.detectTime>0&&r.awareness<1)r.awareness=Math.max(0,r.awareness-dt/(S.detectTime*2));}
      if(r.visible)continue;
      if(r.lastSensed===-Infinity){if(r.awareness<=0)this.known.delete(t);}           // partial awareness that faded: drop silently
      else if(this.time-r.lastSensed>this.memory){this.known.delete(t);this._fire('forget',t,r);}}
    return this;
  }
  /* Register a sound at position; returns the memory record or null when out of range. */
  hear(position,loudness=1,source=null){
    if(!this.hearing||!position)return null;const d=Math.hypot(position.x-this.origin.x,num(position.y,0)-this.origin.y,position.z-this.origin.z);
    if(!(loudness>0)||d>this.hearing.range*loudness)return null;
    const key=source||'noise',r=this._record(key);r.lastHeard=r.lastSensed=this.time;r.seq=++this._seq;r.loudness=loudness;
    if(!r.visible){r.lastKnown.set(position.x,num(position.y,0),position.z);r.sense='hearing';r.distance=d;}
    this._fire('hear',key,r);return r;
  }
  /* Subscribe to 'noise' events: emit('noise', {position, loudness, source}) or emit('noise', position, loudness, source). */
  listen(bus=KE.events,event='noise'){const off=bus.on(event,(a,b,c)=>{if(a&&a.position)this.hear(a.position,num(a.loudness,1),a.source||null);else this.hear(a,num(b,1),c||null);});this._offs.push(off);return off;}
  canSee(target){const r=this.known.get(target);return !!(r&&r.visible);}
  get(target){return this.known.get(target)||null;}
  /* Most relevant record: visible and nearest first, otherwise the most recently sensed. */
  best(){let b=null;for(const r of this.known.values()){if(r.lastSensed===-Infinity)continue;if(!b||(r.visible&&!b.visible)||(r.visible===b.visible&&(r.visible?r.distance<b.distance:r.lastSensed>b.lastSensed||(r.lastSensed===b.lastSensed&&r.seq>b.seq))))b=r;}return b;}
  forget(target){const r=this.known.get(target);if(r){this.known.delete(target);this._fire('forget',target,r);}return !!r;}
  clear(){this.known.clear();return this;}
  dispose(){for(const off of this._offs)off();this._offs=[];this.known.clear();this.events.clear();}
}
KE.Perception=Perception;

/* ======================================================================
   Environment queries
   ====================================================================== */
/* generator -> candidate points (projected onto the navmesh when nav is given) -> tests in order. A test
   returns a number (booleans count 1/0; non-finite drops the item). filter: true (keep > 0), {min,max} or
   fn(value,item). Scores are min-max normalized per test across surviving items and summed with weight
   (negative weight prefers low values). Returns items sorted best first. */
const EQS={
  query(o={}){
    const gen=o.generator||{},nav=o.nav||null,T=o.THREE||(nav&&nav.THREE)||null,rng=isFn(o.rng)?o.rng:KE.random(num(o.seed,1)),maxItems=clamp(Math.round(num(o.maxItems,4096)),1,65536);
    const V=(x,y,z)=>T?new T.Vector3(x,y,z):{x,y,z};const c=gen.center||{x:0,y:0,z:0},cy=num(c.y,0),pts=[];
    switch(gen.type){
      case 'grid':{const half=gen.size!==undefined?gen.size/2:num(gen.radius,5),sp=Math.max(1e-3,num(gen.spacing,1)),n=Math.floor(half/sp+1e-9),circle=gen.circle!==false&&gen.size===undefined;
        for(let j=-n;j<=n;j++)for(let i=-n;i<=n;i++){const x=i*sp,z=j*sp;if(circle&&x*x+z*z>half*half+1e-9)continue;pts.push(V(c.x+x,cy,c.z+z));}break;}
      case 'ring':{const rings=Math.max(1,Math.round(num(gen.rings,1))),count=Math.max(1,Math.round(num(gen.count,12))),R=num(gen.radius,5),r0=num(gen.innerRadius,rings>1?R/rings:R),off=num(gen.angle,0);
        for(let k=0;k<rings;k++){const r=rings>1?r0+(R-r0)*k/(rings-1):R;for(let i=0;i<count;i++){const a=off+i/count*Math.PI*2+(k%2)*Math.PI/count;pts.push(V(c.x+Math.sin(a)*r,cy,c.z+Math.cos(a)*r));}}break;}
      case 'points':for(const p of gen.points||[])if(p&&Number.isFinite(p.x)&&Number.isFinite(p.z))pts.push(V(p.x,num(p.y,cy),p.z));break;
      case 'navRandom':{if(!nav)throw new Error('EQS navRandom generator needs nav');const count=Math.max(1,Math.round(num(gen.count,24)));
        for(let i=0;i<count;i++){const p=nav.randomPoint(rng,gen.center||null,num(gen.radius,Infinity));if(p)pts.push(p);}break;}
      default:throw new TypeError('EQS generator type must be grid, ring, points or navRandom');}
    if(pts.length>maxItems)pts.length=maxItems;
    let items=[];
    if(nav&&gen.project!==false&&gen.type!=='navRandom'){const pr=num(gen.projectRadius,nav.cellSize*2),seen=new Set();
      for(const p of pts){const q=nav.nearestPoint(p,null,{radius:pr});if(!q)continue;const k=Math.round(q.x*100)+','+Math.round(q.z*100);if(seen.has(k))continue;seen.add(k);items.push({position:q,score:0,values:[],valid:true});}}
    else items=pts.map(p=>({position:p,score:0,values:[],valid:true}));
    const tests=o.tests||[];
    tests.forEach((t,ti)=>{if(!t||!isFn(t.fn))throw new TypeError('EQS test '+ti+' needs fn');
      for(const it of items){if(!it.valid)continue;let v=t.fn(it.position,it,o.context);if(typeof v==='boolean')v=v?1:0;if(!Number.isFinite(v)){it.valid=false;continue;}it.values[ti]=v;
        const f=t.filter;if(f===true?v<=0:isFn(f)?!f(v,it):f&&typeof f==='object'?(Number.isFinite(f.min)&&v<f.min)||(Number.isFinite(f.max)&&v>f.max):false)it.valid=false;}
      const w=t.weight===undefined?(t.filter!==undefined&&t.filter!==null?0:1):+t.weight;if(!w)return;
      let lo=Infinity,hi=-Infinity;for(const it of items)if(it.valid){const v=it.values[ti];if(v<lo)lo=v;if(v>hi)hi=v;}
      for(const it of items)if(it.valid){const nv=hi>lo&&t.normalize!==false?(it.values[ti]-lo)/(hi-lo):t.normalize===false?it.values[ti]:1;it.score+=w>=0?w*nv:-w*(1-nv);}});
    items.sort((a,b)=>a.valid!==b.valid?(a.valid?-1:1):b.score-a.score);
    const best=items.length&&items[0].valid?items[0]:null;
    return {best:best?best.position:null,bestScore:best?best.score:-Infinity,bestItem:best,items,valid:items.filter(i=>i.valid).length};
  },
  tests:{
    /* distance to a point (or fn returning one); prefer 'near' or 'far'; optional min/max filter */
    distance(to,{prefer='near',weight=1,min,max}={}){const get=isFn(to)?to:()=>to;return {name:'distance',fn:p=>{const t=get();return Math.hypot(p.x-t.x,p.z-t.z);},weight:prefer==='far'?Math.abs(weight):-Math.abs(weight),filter:min!==undefined||max!==undefined?{min,max}:undefined};},
    /* navmesh path length from a point; unreachable items are dropped */
    pathLength(nav,from,{prefer='near',weight=1,max}={}){return {name:'pathLength',fn:p=>{const path=nav.findPath(from,p);return path.length?NavMesh.pathLength(path):NaN;},weight:prefer==='far'?Math.abs(weight):-Math.abs(weight),filter:max!==undefined?{max}:undefined};},
    /* line of sight from a point (fn(from,to)->clear or NavMesh); want:false keeps hidden points (cover) */
    visibility(from,los,{want=true,height=1.5}={}){const get=isFn(from)?from:()=>from;return {name:'visibility',fn:p=>{const f=get(),a={x:f.x,y:num(f.y,0)+height,z:f.z},b={x:p.x,y:num(p.y,0)+height,z:p.z};
      const clear=los instanceof NavMesh?!los._raycast(a.x,a.z,b.x,b.z,los._ray).hit:!!los(a,b);return clear===want;},filter:true,weight:0};},
    /* distance to the nearest navmesh blocker (from the erosion field) */
    clearance(nav,{min=0,weight=1}={}){return {name:'clearance',fn:p=>nav.clearanceAt(p.x,p.z),weight,filter:min>0?{min}:undefined};}
  }
};
EQS.run=EQS.query;
KE.EQS=EQS;

/* ======================================================================
   Finite state machine
   ====================================================================== */
/* states: {name:{enter(ctx,fsm,from,...args), update(ctx,dt,fsm) -> optional next state name, exit(ctx,fsm,to),
   transitions:[{to, when(ctx,fsm)}]}}; `any` holds global transitions checked after the state's own. */
class FSM{
  constructor({initial,states,context=null,any=[],onChange=null}={}){
    if(!states||typeof states!=='object')throw new TypeError('KE.FSM needs a states object');
    this.states=states;this.context=context;this.any=Array.isArray(any)?any:[];this.onChange=isFn(onChange)?onChange:null;
    this.state=null;this.previous=null;this.time=0;this._changing=false;this._pending=null;this.events=new KE.Events();
    if(initial!==undefined)this.change(initial);
  }
  change(name,...args){
    if(!hasOwn(this.states,name))throw new Error('Unknown FSM state: '+name);
    if(this._changing){this._pending=[name,args];return this;}
    for(let guard=0;;guard++){if(guard>32)throw new Error('FSM transition loop');
      this._changing=true;try{const from=this.state,cur=from!==null?this.states[from]:null;if(cur&&isFn(cur.exit))cur.exit(this.context,this,name);
        this.previous=from;this.state=name;this.time=0;const nx=this.states[name];if(nx&&isFn(nx.enter))nx.enter(this.context,this,from,...args);
        if(this.onChange)this.onChange(name,from,this);this.events.emit('change',name,from);}finally{this._changing=false;}
      if(!this._pending)return this;[name,args]=this._pending;this._pending=null;}
  }
  update(dt=0){
    if(this.state===null)return this;const st=this.states[this.state];
    for(let k=0;k<2;k++){const list=k?this.any:st.transitions;if(list)for(const tr of list)if(tr.to!==this.state&&tr.when(this.context,this)){this.change(tr.to);return this;}}
    this.time+=Math.max(0,+dt||0);if(isFn(st.update)){const r=st.update(this.context,dt,this);if(typeof r==='string'&&r!==this.state)this.change(r);}return this;
  }
  is(name){return this.state===name;}
}
KE.FSM=FSM;

/* ======================================================================
   Steering behaviours (planar XZ). agent: {position, velocity, maxSpeed}. Each returns a desired
   velocity written into out (y = 0); steering.force converts it to a clamped steering force.
   ====================================================================== */
const setXZ=(out,x,z)=>{out.x=x;out.y=0;out.z=z;return out;};
const steering={
  seek(agent,target,out){const dx=target.x-agent.position.x,dz=target.z-agent.position.z,d=Math.hypot(dx,dz);return d<1e-9?setXZ(out,0,0):setXZ(out,dx/d*agent.maxSpeed,dz/d*agent.maxSpeed);},
  flee(agent,threat,out,panicDistance=Infinity){const dx=agent.position.x-threat.x,dz=agent.position.z-threat.z,d=Math.hypot(dx,dz);if(d>panicDistance)return setXZ(out,0,0);
    if(d<1e-9)return setXZ(out,agent.maxSpeed,0);return setXZ(out,dx/d*agent.maxSpeed,dz/d*agent.maxSpeed);},
  arrive(agent,target,out,slowRadius=2,stopRadius=.05){const dx=target.x-agent.position.x,dz=target.z-agent.position.z,d=Math.hypot(dx,dz);if(d<=stopRadius)return setXZ(out,0,0);
    const s=agent.maxSpeed*Math.min(1,d/Math.max(1e-6,slowRadius));return setXZ(out,dx/d*s,dz/d*s);},
  pursue(agent,quarry,out,maxPrediction=1.5){const q=quarry.position||quarry,v=quarry.velocity||{x:0,z:0},d=Math.hypot(q.x-agent.position.x,q.z-agent.position.z),s=agent.maxSpeed||1,t=Math.min(maxPrediction,d/s);
    return steering.seek(agent,{x:q.x+v.x*t,z:q.z+v.z*t},out);},
  evade(agent,pursuer,out,maxPrediction=1.5,panicDistance=Infinity){const q=pursuer.position||pursuer,v=pursuer.velocity||{x:0,z:0},d=Math.hypot(q.x-agent.position.x,q.z-agent.position.z),s=agent.maxSpeed||1,t=Math.min(maxPrediction,d/s);
    return steering.flee(agent,{x:q.x+v.x*t,z:q.z+v.z*t},out,panicDistance);},
  /* Reynolds wander: a target on a circle ahead, jittered by rng (seeded; defaults to KE.random(1)). State lives in agent.wanderAngle. */
  wander(agent,out,{radius=1,distance=2,jitter=2,dt=1/60,rng=null}={}){const r=rng||(steering._rng||(steering._rng=KE.random(1)));
    agent.wanderAngle=num(agent.wanderAngle,0)+(r()*2-1)*jitter*Math.sqrt(Math.max(dt,0));
    const v=agent.velocity||{x:0,z:0};let hx=v.x,hz=v.z,l=Math.hypot(hx,hz);if(l<1e-6){const h=num(agent.heading,0);hx=Math.sin(h);hz=Math.cos(h);l=1;}hx/=l;hz/=l;
    const tx=hx*distance+Math.sin(agent.wanderAngle)*radius,tz=hz*distance+Math.cos(agent.wanderAngle)*radius,tl=Math.hypot(tx,tz)||1;return setXZ(out,tx/tl*agent.maxSpeed,tz/tl*agent.maxSpeed);},
  /* Push away from neighbours closer than radius (weighted by proximity). */
  separate(agent,neighbors,out,radius=1){let x=0,z=0;for(const n of neighbors){const p=n.position||n;if(p===agent.position)continue;const dx=agent.position.x-p.x,dz=agent.position.z-p.z,d=Math.hypot(dx,dz);
    if(d<1e-9||d>=radius)continue;const w=1-d/radius;x+=dx/d*w;z+=dz/d*w;}const l=Math.hypot(x,z);return l>1?setXZ(out,x/l*agent.maxSpeed,z/l*agent.maxSpeed):setXZ(out,x*agent.maxSpeed,z*agent.maxSpeed);},
  force(desired,agent,maxForce,out){const v=agent.velocity||{x:0,z:0};let x=desired.x-v.x,z=desired.z-v.z;const l=Math.hypot(x,z);if(l>maxForce&&l>0){x*=maxForce/l;z*=maxForce/l;}return setXZ(out,x,z);}
};
KE.steering=steering;

KE.registerModule('ai',{provides:['NavMesh','Crowd','BT','Blackboard','Perception','EQS','FSM','steering']});
})();
