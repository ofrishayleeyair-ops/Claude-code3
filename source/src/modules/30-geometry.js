/* kitsune enginev3 geometry (module 30): mesh simplification (meshoptimizer with a pure-JS
   vertex-clustering fallback), discrete LOD chains, distance/screen-error LOD meshes with hysteresis and
   dithered crossfade, O(n) instanced LOD with frustum culling, shadow LODs and impostors, octahedral /
   billboard impostor baking, and a Nanite-inspired virtualized-geometry path: meshlet clusters grouped and
   simplified with locked group borders over several levels (a cluster DAG), cut at runtime per cluster by
   projected error (meshoptimizer clusterlod rule), cluster frustum culling, drawn with one draw call from a
   merged index buffer that is rebuilt only when the cut changes. CPU-side selection; no GPU culling. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const BIG=3.4e38;

/* ---------- backend: vendored meshoptimizer (wasm) or pure JS ---------- */
const backend={simplifier:false,clusterizer:false};
const lib=name=>typeof window[name]!=='undefined'&&window[name]&&window[name].supported!==false?window[name]:null;
{const S=lib('MeshoptSimplifier'),C=lib('MeshoptClusterizer');
  if(S&&S.ready)S.ready.then(()=>{backend.simplifier=true;},()=>{});if(C&&C.ready)C.ready.then(()=>{backend.clusterizer=true;},()=>{});}
KE.geometryReady=async()=>{const S=lib('MeshoptSimplifier'),C=lib('MeshoptClusterizer');
  try{if(S&&S.ready){await S.ready;backend.simplifier=true;}}catch(e){backend.simplifier=false;}
  try{if(C&&C.ready){await C.ready;backend.clusterizer=true;}}catch(e){backend.clusterizer=false;}
  return {simplifier:backend.simplifier,clusterizer:backend.clusterizer,backend:backend.simplifier?'meshoptimizer':'js'};};
KE.geometryBackend=()=>({simplifier:backend.simplifier,clusterizer:backend.clusterizer});
const useMeshopt=(o,kind)=>o.backend!=='js'&&backend[kind];

/* ---------- small helpers ---------- */
const pow2=n=>{let p=1;while(p<n)p<<=1;return p;};
function hash3(a,b,c){let h=Math.imul(a^0x9e3779b9,0x85ebca6b)^Math.imul(b^0x7f4a7c15,0xc2b2ae35)^Math.imul(c^0x165667b1,0x27d4eb2f);h^=h>>>15;h=Math.imul(h,0x2c1b3c6d);h^=h>>>12;return h>>>0;}
function part1023(v){v&=1023;v=(v|(v<<16))&0x030000FF;v=(v|(v<<8))&0x0300F00F;v=(v|(v<<4))&0x030C30C3;v=(v|(v<<2))&0x09249249;return v;}
const morton=(x,y,z)=>(part1023(x)|(part1023(y)<<1)|(part1023(z)<<2))>>>0;
/* Canonical vertex per bit-identical position (open addressing on float bits). Used for connectivity and
   for locking all attribute-seam copies of a vertex consistently. */
function positionRemap(positions,vc){
  const u=new Uint32Array(positions.buffer,positions.byteOffset,vc*3),size=pow2(vc*2+2),mask=size-1,table=new Int32Array(size).fill(-1),remap=new Uint32Array(vc);
  for(let i=0;i<vc;i++){const a=u[i*3],b=u[i*3+1],c=u[i*3+2];let h=hash3(a,b,c)&mask;
    for(;;){const j=table[h];if(j<0){table[h]=i;remap[i]=i;break;}if(u[j*3]===a&&u[j*3+1]===b&&u[j*3+2]===c){remap[i]=j;break;}h=(h+1)&mask;}}
  return remap;
}
/* Plain typed copy of any (possibly interleaved) attribute, itemSize-strided. */
function plainArray(attr){
  if(!attr.isInterleavedBufferAttribute&&attr.array.length===attr.count*attr.itemSize)return attr.array;
  const n=attr.count,k=attr.itemSize,Ctor=attr.array.constructor,out=new Ctor(n*k),g=['getX','getY','getZ','getW'];
  for(let i=0;i<n;i++)for(let c=0;c<k;c++)out[i*k+c]=attr[g[c]](i);return out;
}
function floatPositions(attr){
  const src=plainArray(attr),n=attr.count,out=new Float32Array(n*3),k=attr.itemSize;let scale=1;
  if(attr.normalized){const C=src.constructor;scale=C===Int8Array?1/127:C===Uint8Array?1/255:C===Int16Array?1/32767:C===Uint16Array?1/65535:1;}
  for(let i=0;i<n;i++){out[i*3]=src[i*k]*scale;out[i*3+1]=(k>1?src[i*k+1]:0)*scale;out[i*3+2]=(k>2?src[i*k+2]:0)*scale;}return out;
}
/* Read a BufferGeometry into flat arrays. Non-indexed input is welded (vertices whose every attribute is
   bit-identical become one) so simplification sees connected triangles. */
function readSource(geometry){
  if(!geometry||!geometry.isBufferGeometry)throw new TypeError('KE geometry: expected a THREE.BufferGeometry');
  const pa=geometry.getAttribute('position');if(!pa)throw new Error('KE geometry: geometry has no position attribute');
  let vc=pa.count,positions=floatPositions(pa),attrs={};
  for(const name of Object.keys(geometry.attributes)){const a=geometry.attributes[name];attrs[name]={array:name==='position'?positions:plainArray(a),itemSize:name==='position'?3:a.itemSize,normalized:name==='position'?false:a.normalized};}
  let indices;
  if(geometry.index){const ia=geometry.index.array;indices=ia instanceof Uint32Array?ia.slice():Uint32Array.from(ia);}
  else{
    const names=Object.keys(attrs),words=[];for(const n of names){const a=attrs[n].array;words.push({u:a instanceof Float32Array?new Uint32Array(a.buffer,a.byteOffset,a.length):a,k:attrs[n].itemSize});}
    const size=pow2(vc*2+2),mask=size-1,table=new Int32Array(size).fill(-1),first=new Int32Array(vc),remap=new Uint32Array(vc);let unique=0;
    const eq=(i,j)=>{for(const w of words)for(let c=0;c<w.k;c++)if(w.u[i*w.k+c]!==w.u[j*w.k+c])return false;return true;};
    for(let i=0;i<vc;i++){let h=0x811c9dc5;for(const w of words)for(let c=0;c<w.k;c++){h^=w.u[i*w.k+c]|0;h=Math.imul(h,0x01000193);}h=(h^(h>>>15))&mask;
      for(;;){const s=table[h];if(s<0){table[h]=unique;first[unique]=i;remap[i]=unique++;break;}if(eq(first[s],i)){remap[i]=s;break;}h=(h+1)&mask;}}
    for(const n of names){const a=attrs[n],k=a.itemSize,out=new a.array.constructor(unique*k);for(let v=0;v<unique;v++)for(let c=0;c<k;c++)out[v*k+c]=a.array[first[v]*k+c];a.array=out;}
    positions=attrs.position.array;indices=remap.slice(0,vc-vc%3);vc=unique;
  }
  const groups=(geometry.groups||[]).filter(g=>g.count>0).map(g=>({start:g.start,count:Math.min(g.count,indices.length-g.start),materialIndex:g.materialIndex||0}));
  return {positions,indices,vertexCount:vc,attrs,groups,source:geometry};
}
function boundsOf(positions,indices){
  let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity;
  const each=v=>{const x=positions[v*3],y=positions[v*3+1],z=positions[v*3+2];if(x<x0)x0=x;if(y<y0)y0=y;if(z<z0)z0=z;if(x>x1)x1=x;if(y>y1)y1=y;if(z>z1)z1=z;};
  if(indices)for(let i=0;i<indices.length;i++)each(indices[i]);else for(let v=0;v<positions.length/3;v++)each(v);
  return {min:[x0,y0,z0],max:[x1,y1,z1],size:Math.max(x1-x0,y1-y0,z1-z0,1e-9)};
}
/* Sphere around the vertices referenced by an index list: AABB centre + max distance (tight enough). */
function sphereOf(positions,indices,out,o=0){
  const b=boundsOf(positions,indices),cx=(b.min[0]+b.max[0])/2,cy=(b.min[1]+b.max[1])/2,cz=(b.min[2]+b.max[2])/2;let r2=0;
  for(let i=0;i<indices.length;i++){const v=indices[i]*3,dx=positions[v]-cx,dy=positions[v+1]-cy,dz=positions[v+2]-cz,d=dx*dx+dy*dy+dz*dz;if(d>r2)r2=d;}
  out[o]=cx;out[o+1]=cy;out[o+2]=cz;out[o+3]=Math.sqrt(r2);return out;
}
/* Sphere enclosing spheres: start at the AABB centre of the child spheres, then a few Ritter-style passes
   pull the centre toward the farthest child. Always contains every child (parent >= child, monotonic). */
function mergeSpheres(spheres,list,out,o=0){
  let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity;
  for(const i of list){const r=spheres[i*4+3];x0=Math.min(x0,spheres[i*4]-r);y0=Math.min(y0,spheres[i*4+1]-r);z0=Math.min(z0,spheres[i*4+2]-r);x1=Math.max(x1,spheres[i*4]+r);y1=Math.max(y1,spheres[i*4+1]+r);z1=Math.max(z1,spheres[i*4+2]+r);}
  let cx=(x0+x1)/2,cy=(y0+y1)/2,cz=(z0+z1)/2;
  const reach=()=>{let R=0,f=-1;for(const i of list){const d=Math.hypot(spheres[i*4]-cx,spheres[i*4+1]-cy,spheres[i*4+2]-cz)+spheres[i*4+3];if(d>R){R=d;f=i;}}return [R,f];};
  let [R,f]=reach();
  for(let it=0;it<8&&f>=0;it++){const dx=spheres[f*4]-cx,dy=spheres[f*4+1]-cy,dz=spheres[f*4+2]-cz,d=Math.hypot(dx,dy,dz);if(d<1e-12)break;const step=R*.04/(it+1);
    const nx=cx+dx/d*step,ny=cy+dy/d*step,nz=cz+dz/d*step,ox=cx,oy=cy,oz=cz;cx=nx;cy=ny;cz=nz;const [R2,f2]=reach();if(R2<R){R=R2;f=f2;}else{cx=ox;cy=oy;cz=oz;break;}}
  out[o]=cx;out[o+1]=cy;out[o+2]=cz;out[o+3]=R*(1+1e-6);return out;
}
/* Compact an index list over a large vertex buffer into local arrays (so wasm copies stay small). */
function compact(indices,positions,extra,vc,scratch){
  const map=scratch.map&&scratch.map.length>=vc?scratch.map:(scratch.map=new Int32Array(vc).fill(-1));const verts=[];const local=new Uint32Array(indices.length);
  for(let i=0;i<indices.length;i++){const v=indices[i];let l=map[v];if(l<0){l=map[v]=verts.length;verts.push(v);}local[i]=l;}
  const n=verts.length,pos=new Float32Array(n*3);let ex=null;if(extra){ex=new Float32Array(n*extra.k);}
  for(let l=0;l<n;l++){const v=verts[l];pos[l*3]=positions[v*3];pos[l*3+1]=positions[v*3+1];pos[l*3+2]=positions[v*3+2];if(ex)for(let c=0;c<extra.k;c++)ex[l*extra.k+c]=extra.array[v*extra.k+c];map[v]=-1;}
  return {local,verts,pos,extra:ex,count:n};
}

/* ---------- pure-JS fallback simplifier: vertex clustering ---------- */
/* Rossignac-Borrel clustering on a uniform grid. Every cell collapses to the ORIGINAL vertex nearest the
   cell mean (so attributes stay exact and no vertices are created). Locked vertices never move. The grid
   resolution is binary-searched to meet the triangle target, then refined if the measured maximum vertex
   displacement exceeds the error limit. Coarser than meshopt's quadric collapse; seams are not preserved. */
function clusterSimplify(positions,indices,vc,targetTris,errorLimit,isLocked,weld){
  const seen=new Uint8Array(vc);let U=0;const used=new Uint32Array(Math.min(vc,indices.length));for(let i=0;i<indices.length;i++){const v=indices[i];if(!seen[v]){seen[v]=1;used[U++]=v;}}
  const b=boundsOf(positions,indices),rep=new Int32Array(vc).fill(-1),size=pow2(U*2+2),mask=size-1,table=new Int32Array(size),tkey=new Float64Array(size);
  const cellOf=new Int32Array(U),sx=new Float64Array(U),sy=new Float64Array(U),sz=new Float64Array(U),cnt=new Int32Array(U),best=new Int32Array(U),bestD=new Float64Array(U);
  const primary=new Uint8Array(U);for(let k=0;k<U;k++){const v=used[k];primary[k]=isLocked&&isLocked(v)?2:(!weld||weld[v]===v||(isLocked&&isLocked(weld[v])))?1:0;}
  /* returns triangle count; fills rep[] and the max displacement */
  let lastErr=0;
  const run=g=>{const cs=b.size/g+1e-12,K=g+2;table.fill(-1);let cells=0;
    for(let k=0;k<U;k++){const v=used[k];if(primary[k]!==1){cellOf[k]=-1;continue;}
      const key=Math.floor((positions[v*3]-b.min[0])/cs)+K*(Math.floor((positions[v*3+1]-b.min[1])/cs)+K*Math.floor((positions[v*3+2]-b.min[2])/cs));
      let h=(Math.imul(key|0,0x9e3779b1)^((key/4294967296)|0))&mask,c;
      for(;;){c=table[h];if(c<0){c=table[h]=cells++;tkey[h]=key;sx[c]=sy[c]=sz[c]=0;cnt[c]=0;bestD[c]=Infinity;break;}if(tkey[h]===key)break;h=(h+1)&mask;}
      cellOf[k]=c;sx[c]+=positions[v*3];sy[c]+=positions[v*3+1];sz[c]+=positions[v*3+2];cnt[c]++;}
    for(let k=0;k<U;k++){const c=cellOf[k];if(c<0)continue;const v=used[k],d=(positions[v*3]-sx[c]/cnt[c])**2+(positions[v*3+1]-sy[c]/cnt[c])**2+(positions[v*3+2]-sz[c]/cnt[c])**2;if(d<bestD[c]){bestD[c]=d;best[c]=v;}}
    let err=0;for(let k=0;k<U;k++){const v=used[k],c=cellOf[k];if(c<0){if(primary[k]===2)rep[v]=v;continue;}const r=best[c];rep[v]=r;const e=(positions[v*3]-positions[r*3])**2+(positions[v*3+1]-positions[r*3+1])**2+(positions[v*3+2]-positions[r*3+2])**2;if(e>err)err=e;}
    for(let k=0;k<U;k++)if(primary[k]===0){const v=used[k];rep[v]=rep[weld[v]]>=0?rep[weld[v]]:v;}
    lastErr=Math.sqrt(err);let t=0;for(let i=0;i<indices.length;i+=3){const x=rep[indices[i]],y=rep[indices[i+1]],z=rep[indices[i+2]];if(x!==y&&y!==z&&x!==z)t++;}return t;};
  let lo=1,hi=4096,g=0;
  for(let it=0;it<16&&lo<=hi;it++){const m=(lo+hi)>>1;if(run(m)<=targetTris){g=m;lo=m+1;}else hi=m-1;}
  if(!g)g=1;run(g);
  if(lastErr>errorLimit){let l=g,h=1<<16,fine=0;for(let it=0;it<18&&l<=h;it++){const m=(l+h)>>1;run(m);if(lastErr<=errorLimit){fine=m;h=m-1;}else l=m+1;}
    if(!fine)return {indices:indices.slice(),error:0};g=fine;run(g);}
  const out=[];for(let i=0;i<indices.length;i+=3){const x=rep[indices[i]],y=rep[indices[i+1]],z=rep[indices[i+2]];if(x!==y&&y!==z&&x!==z)out.push(x,y,z);}
  if(!out.length&&indices.length)out.push(indices[0],indices[1],indices[2]);
  return {indices:Uint32Array.from(out),error:lastErr};
}

/* ---------- simplification core ---------- */
/* Returns {indices (same vertex numbering), error (absolute, mesh units)}. Attribute weights feed
   meshopt's attribute-aware quadrics; `locks` (per vertex, 1 = locked) needs the experimental entry point. */
function simplifyIndices(positions,indices,vc,targetIndexCount,errorLimitAbs,o){
  targetIndexCount=Math.max(3,Math.floor(targetIndexCount/3)*3);
  if(targetIndexCount>=indices.length)return {indices:indices.slice(),error:0};
  if(useMeshopt(o,'simplifier')){
    const S=window.MeshoptSimplifier,flags=['ErrorAbsolute'];if(o.lockBorder)flags.push('LockBorder');
    const lim=Number.isFinite(errorLimitAbs)?Math.max(0,errorLimitAbs):BIG;
    if(o.attr||o.locks){const prev=S.useExperimentalFeatures;S.useExperimentalFeatures=true;
      try{const attr=o.attr||new Float32Array(vc),stride=o.attr?o.attrStride:1,w=o.attr?o.weights:[0];
        const [res,err]=S.simplifyWithAttributes(indices,positions,3,attr,stride,w,o.locks||null,targetIndexCount,lim,flags);return {indices:res,error:err};}
      finally{S.useExperimentalFeatures=prev;}}
    const [res,err]=S.simplify(indices,positions,3,targetIndexCount,lim,flags);return {indices:res,error:err};
  }
  const locks=o.locks,weld=o.weld||null;
  return clusterSimplify(positions,indices,vc,targetIndexCount/3,Number.isFinite(errorLimitAbs)?errorLimitAbs:Infinity,locks?(v=>locks[v]!==0):null,weld);
}
function attributeStream(src,o){
  if(o.attributes===false)return null;const parts=[];
  const nrm=src.attrs.normal,col=src.attrs.color,uv=src.attrs.uv;
  if(nrm&&nrm.itemSize===3&&(o.normalWeight??.5)>0)parts.push({a:nrm,k:3,w:o.normalWeight??.5,scale:1});
  if(col&&col.itemSize>=3&&(o.colorWeight??.5)>0)parts.push({a:col,k:3,w:o.colorWeight??.5,scale:col.normalized?1/255:1});
  if(uv&&uv.itemSize===2&&(o.uvWeight??0)>0)parts.push({a:uv,k:2,w:o.uvWeight,scale:1});
  if(!parts.length)return null;const stride=parts.reduce((s,p)=>s+p.k,0),vc=src.vertexCount,out=new Float32Array(vc*stride),weights=[];
  let off=0;for(const p of parts){const ak=p.a.itemSize;for(let v=0;v<vc;v++)for(let c=0;c<p.k;c++)out[v*stride+off+c]=p.a.array[v*ak+c]*p.scale;for(let c=0;c<p.k;c++)weights.push(p.w);off+=p.k;}
  return {array:out,stride,weights};
}
/* Build a compact BufferGeometry from kept source vertices. */
function buildSubset(THREE,src,indexList,groups){
  const vc=src.vertexCount,map=new Int32Array(vc).fill(-1),verts=[];const idx=new Uint32Array(indexList.length);
  for(let i=0;i<indexList.length;i++){const v=indexList[i];let l=map[v];if(l<0){l=map[v]=verts.length;verts.push(v);}idx[i]=l;}
  const g=new THREE.BufferGeometry(),n=verts.length;
  for(const name of Object.keys(src.attrs)){const a=src.attrs[name],k=a.itemSize,out=new a.array.constructor(n*k);for(let l=0;l<n;l++){const v=verts[l];for(let c=0;c<k;c++)out[l*k+c]=a.array[v*k+c];}g.setAttribute(name,new THREE.BufferAttribute(out,k,a.normalized));}
  g.setIndex(new THREE.BufferAttribute(n<65535?Uint16Array.from(idx):idx,1));
  if(groups)for(const gr of groups)g.addGroup(gr.start,gr.count,gr.materialIndex);
  g.computeBoundingBox();g.computeBoundingSphere();return g;
}
function simplifySource(THREE,src,o){
  const ratio=clamp(o.ratio??.5,0,1),scale=boundsOf(src.positions,null).size;
  const limit=o.targetError===undefined||o.targetError===null||o.targetError===Infinity?Infinity:(o.errorAbsolute?o.targetError:o.targetError*scale);
  const attr=useMeshopt(o,'simplifier')?attributeStream(src,o):null;
  const ranges=src.groups.length?src.groups:[{start:0,count:src.indices.length,materialIndex:0}];
  const out=[],groups=[];let err=0;
  for(const r of ranges){const sub=src.indices.subarray(r.start,r.start+r.count-r.count%3);
    const res=simplifyIndices(src.positions,sub,src.vertexCount,Math.max(3,Math.round(sub.length/3*ratio)*3),limit,{...o,attr:attr&&attr.array,attrStride:attr&&attr.stride,weights:attr&&attr.weights});
    err=Math.max(err,res.error);groups.push({start:out.length,count:res.indices.length,materialIndex:r.materialIndex});for(let i=0;i<res.indices.length;i++)out.push(res.indices[i]);}
  const g=buildSubset(THREE,src,out,src.groups.length?groups:null),tris=out.length/3,orig=src.indices.length/3;
  g.userData.simplifyError=err;g.userData.simplifyErrorRelative=err/scale;g.userData.ratio=orig?tris/orig:1;g.userData.backend=useMeshopt(o,'simplifier')?'meshoptimizer':'js';
  return g;
}
KE.simplify=(THREE,geometry,o={})=>simplifySource(THREE,readSource(geometry),{ratio:.5,targetError:.01,lockBorder:false,attributes:true,...o});

/* ---------- discrete LOD chains ---------- */
/* Every level is simplified from the original (not chained) so errors are measured against the source;
   errors are then made monotonic and levels that fail to drop at least 10% of triangles are skipped. */
KE.buildLODs=(THREE,geometry,o={})=>{
  const levels=(o.levels||[1,.5,.25,.1,.04]).slice().sort((a,b)=>b-a),src=readSource(geometry),orig=src.indices.length/3,out=[];
  const opts={targetError:Infinity,lockBorder:false,attributes:true,...o};let prevErr=0,prevTris=Infinity;
  for(const ratio of levels){
    if(ratio>=1){out.push({geometry,ratio:1,error:0,triangles:orig,generated:false});prevErr=0;prevTris=orig;continue;}
    const g=simplifySource(THREE,src,{...opts,ratio}),tris=g.index.count/3;
    if(tris>prevTris*.9){g.dispose();continue;}
    const error=Math.max(prevErr,g.userData.simplifyError);out.push({geometry:g,ratio:tris/orig,error,triangles:tris,generated:true});prevErr=error;prevTris=tris;
  }
  out.backend=useMeshopt(o,'simplifier')?'meshoptimizer':'js';return out;
};
function resolveLods(THREE,src,o){
  if(Array.isArray(src)){if(!src.length||!src.every(l=>l&&l.geometry&&l.geometry.isBufferGeometry))throw new TypeError('KE LOD: expected [{geometry,error}]');
    const lods=src.map(l=>({geometry:l.geometry,error:Math.max(0,+l.error||0),triangles:l.triangles||triCount(l.geometry),ratio:l.ratio||1,generated:false}));
    for(let i=1;i<lods.length;i++)lods[i].error=Math.max(lods[i].error,lods[i-1].error);return {lods,own:false};}
  if(src&&src.isBufferGeometry)return {lods:KE.buildLODs(THREE,src,{levels:o.levels,targetError:o.targetError,backend:o.backend}),own:true};
  throw new TypeError('KE LOD: expected a BufferGeometry or a buildLODs() array');
}
function triCount(g){const n=g.index?g.index.count:g.getAttribute('position').count;const dr=g.drawRange;return Math.floor(Math.min(n,dr.count===Infinity?n:dr.count)/3);}

/* ---------- screen-space error ---------- */
/* Pixels per world unit at distance 1 (perspective) or absolute (orthographic), before LOD bias. */
function pixelScale(camera,viewportHeight){
  if(camera.isOrthographicCamera)return {ortho:true,k:viewportHeight*(camera.zoom||1)/Math.max(1e-9,camera.top-camera.bottom)};
  return {ortho:false,k:viewportHeight*(camera.zoom||1)/(2*Math.tan((camera.fov||60)*Math.PI/360))};
}
const lodBias=()=>clamp(Number.isFinite(KE.settings.lod)?KE.settings.lod:1,.25,2);
/* error_px = error_world * viewportHeight / (2 * distance * tan(fov/2)) * KE.settings.lod */
KE.screenError=(errorWorld,distance,camera,viewportHeight)=>{const p=pixelScale(camera,viewportHeight);return errorWorld*p.k*lodBias()/(p.ortho?1:Math.max(distance,camera.near||1e-3));};
KE.geometryViewportHeight=720;
const PALETTE=[0x3ecf6e,0xf2d13d,0xf28c28,0xe8453c,0xd13dc9,0x6b5cff,0x2fb5e8,0x8fe0c8,0xffffff];

/* Shadow-only proxy material: the main pass rasterizes nothing (vertices land outside clip space), while the
   shadow pass uses Three's depth materials, so proxies cast shadows with cheaper geometry. */
const shadowOnly=new WeakMap();
function shadowOnlyMaterial(THREE){let m=shadowOnly.get(THREE);if(m)return m;
  m=new THREE.ShaderMaterial({vertexShader:'void main(){gl_Position=vec4(2.,2.,2.,1.);}',fragmentShader:'void main(){discard;}',colorWrite:false,depthWrite:false,depthTest:false});m.name='ke-shadow-only';shadowOnly.set(THREE,m);return m;}

/* Dithered crossfade: complementary screen-door masks (interleaved gradient noise) on two LOD levels. */
function fadeMaterial(THREE,material){
  const m=material.clone(),u={value:new THREE.Vector2(-1,1)},prev=m.onBeforeCompile;m.userData.keLodFade=u;
  m.onBeforeCompile=(shader,r)=>{if(prev&&prev!==material.onBeforeCompile)prev.call(m,shader,r);else if(material.onBeforeCompile)material.onBeforeCompile.call(m,shader,r);shader.uniforms.keLodFade=u;
    const re=/void\s+main\s*\(\s*\)\s*\{/;if(!re.test(shader.fragmentShader))throw new Error('KE.LODMesh: cannot patch fragment shader for crossfade');
    shader.fragmentShader='uniform vec2 keLodFade;\n'+shader.fragmentShader.replace(re,s=>s+'\nif(keLodFade.x>=0.){float keN=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715))));if((keLodFade.y>0.)==(keN>=keLodFade.x))discard;}\n');};
  const key=material.customProgramCacheKey?material.customProgramCacheKey.bind(material):()=>'';m.customProgramCacheKey=()=>key()+'|keLodFade';return m;
}

/* ---------- class factory (classes extend the caller's THREE.Object3D) ---------- */
const classCache=new WeakMap();
function classesFor(THREE){let c=classCache.get(THREE);if(c)return c;c=makeClasses(THREE);classCache.set(THREE,c);return c;}
function publicClass(name){
  const F=function(THREE,...args){if(!new.target)throw new TypeError('KE.'+name+' must be called with new');if(!THREE||!THREE.Object3D)throw new TypeError('KE.'+name+': pass THREE as the first argument');return new (classesFor(THREE)[name])(THREE,...args);};
  Object.defineProperty(F,'name',{value:name});Object.defineProperty(F,Symbol.hasInstance,{value:o=>!!(o&&o['isKE'+name])});return F;
}

function makeClasses(THREE){
  const _v=new THREE.Vector3(),_c=new THREE.Vector3(),_m=new THREE.Matrix4(),_inv=new THREE.Matrix4(),_fr=new THREE.Frustum();

  /* ===== LODMesh: one child mesh per level, one visible (two while crossfading) ===== */
  class LODMesh extends THREE.Object3D{
    constructor(T,src,material,o={}){
      super();this.isKELODMesh=true;this.isLOD=true;this.autoUpdate=o.autoUpdate!==false;this.type='KELODMesh';this.THREE=T;
      const {lods,own}=resolveLods(T,src,o);this.lods=lods;this._ownLods=own;this.material=material;
      Object.assign(this,{pixelError:o.pixelError??1.5,hysteresis:o.hysteresis??.1,crossfade:o.crossfade??0,shadowLodBias:o.shadowLodBias??1,viewportHeight:o.viewportHeight||KE.geometryViewportHeight});
      this.castShadow=!!o.castShadow;this.receiveShadow=!!o.receiveShadow;this.level=-1;this._fade=null;this._clock=0;this.forcedLevel=-1;
      lods[0].geometry.boundingSphere||lods[0].geometry.computeBoundingSphere();this.boundingSphere=lods[0].geometry.boundingSphere.clone();
      this._materials=this.crossfade>0&&!o.debugColors&&!Array.isArray(material)?lods.map(()=>fadeMaterial(T,material)):null;
      if(o.debugColors&&!Array.isArray(material)&&material.color){this._debugMaterials=lods.map((l,i)=>{const m=material.clone();m.color=new T.Color(PALETTE[i%PALETTE.length]);return m;});}
      this.meshes=lods.map((l,i)=>{const m=new T.Mesh(l.geometry,this._debugMaterials?this._debugMaterials[i]:this._materials?this._materials[i]:material);m.visible=false;m.receiveShadow=this.receiveShadow;m.castShadow=false;m.name='ke-lod'+i;this.add(m);return m;});
      this.shadowProxy=null;if(this.castShadow&&this.shadowLodBias>0&&lods.length>1){this.shadowProxy=new T.Mesh(lods[1].geometry,shadowOnlyMaterial(T));this.shadowProxy.castShadow=true;this.shadowProxy.visible=false;this.shadowProxy.name='ke-lod-shadow';
        if(o.customDepthMaterial)this.shadowProxy.customDepthMaterial=o.customDepthMaterial;if(o.customDistanceMaterial)this.shadowProxy.customDistanceMaterial=o.customDistanceMaterial;this.add(this.shadowProxy);}
      this._setLevel(lods.length-1,false);
    }
    /* Level whose error projects at or below pixelError; hysteresis keeps the current level inside a band. */
    selectLevel(camera,viewportHeight){
      const vh=viewportHeight||this.viewportHeight;camera.getWorldPosition(_v);_c.copy(this.boundingSphere.center).applyMatrix4(this.matrixWorld);
      const s=this.matrixWorld.getMaxScaleOnAxis(),r=this.boundingSphere.radius*s,p=pixelScale(camera,vh),k=p.k*lodBias()/Math.max(1e-6,this.pixelError);
      const d=p.ortho?1:Math.max(_v.distanceTo(_c)-r,camera.near||1e-3),L=this.lods.length,cur=this.level;
      let fine=0,coarse=0;for(let l=L-1;l>=0;l--){if(this.lods[l].error*s*k<=d){coarse=l;break;}}
      for(let l=L-1;l>=0;l--){if(this.lods[l].error*s*k*(1+this.hysteresis)<=d){fine=l;break;}}
      if(cur>=fine&&cur<=coarse)return cur;return cur>coarse?coarse:fine;
    }
    update(camera,viewportHeight){
      if(viewportHeight)this.viewportHeight=viewportHeight;if(camera.parent===null&&camera.matrixWorldAutoUpdate!==false)camera.updateMatrixWorld();
      const now=performance.now()/1000,lvl=this.forcedLevel>=0?Math.min(this.forcedLevel,this.lods.length-1):this.selectLevel(camera,this.viewportHeight);
      if(lvl!==this.level)this._setLevel(lvl,this.crossfade>0&&this.level>=0&&!!this._materials,now);
      if(this._fade){const t=(now-this._fade.t0)/this.crossfade;if(t>=1){this._endFade();}else{this._fade.to.value.set(t,1);this._fade.from.value.set(t,-1);}}
      return this.level;
    }
    _setLevel(l,fade,now){
      const prev=this.level;if(this._fade)this._endFade();this.level=l;
      this.meshes.forEach((m,i)=>{m.visible=i===l;m.castShadow=false;});
      if(fade&&prev>=0&&prev!==l&&this._materials){this.meshes[prev].visible=true;this._fade={t0:now,from:this._materials[prev].userData.keLodFade,to:this._materials[l].userData.keLodFade,prev};this._fade.to.value.set(0,1);this._fade.from.value.set(0,-1);}
      if(this.castShadow){const sl=Math.min(l+(this.shadowProxy?this.shadowLodBias:0),this.lods.length-1);
        if(this.shadowProxy&&sl!==l){this.shadowProxy.geometry=this.lods[sl].geometry;this.shadowProxy.visible=true;}else{if(this.shadowProxy)this.shadowProxy.visible=false;this.meshes[l].castShadow=true;}}
    }
    _endFade(){const f=this._fade;this._fade=null;if(!f)return;f.from.value.set(-1,1);f.to.value.set(-1,1);if(f.prev!==this.level)this.meshes[f.prev].visible=false;}
    get triangles(){return this.level>=0?this.lods[this.level].triangles:0;}
    stats(){return {level:this.level,levels:this.lods.length,triangles:this.triangles,fullTriangles:this.lods[0].triangles,error:this.level>=0?this.lods[this.level].error:0,fading:!!this._fade};}
    clone(){return new LODMesh(this.THREE,this.lods,this.material,{pixelError:this.pixelError,hysteresis:this.hysteresis,crossfade:this.crossfade,castShadow:this.castShadow,receiveShadow:this.receiveShadow,shadowLodBias:this.shadowLodBias}).copy(this,false);}
    copy(src,recursive){THREE.Object3D.prototype.copy.call(this,src,false);return this;}
    dispose(){this.parent&&this.parent.remove(this);if(this._ownLods)for(const l of this.lods)if(l.generated)l.geometry.dispose();(this._materials||[]).forEach(m=>m.dispose());(this._debugMaterials||[]).forEach(m=>m.dispose());}
  }

  /* ===== InstancedLOD: per-level InstancedMeshes refilled in one O(n) pass ===== */
  class InstancedLOD{
    constructor(T,src,material,o={}){
      this.isKEInstancedLOD=true;this.THREE=T;const {lods,own}=resolveLods(T,src,o);this.lods=lods;this._ownLods=own;this.material=material;
      const cap=Math.max(1,Math.floor(o.count||o.capacity||1));this.capacity=cap;this._count=cap;
      Object.assign(this,{pixelError:o.pixelError??1.5,hysteresis:o.hysteresis??.1,maxDistance:o.maxDistance??Infinity,frustumCull:o.frustumCull!==false,shadowDistance:o.shadowDistance??80,shadowLodBias:o.shadowLodBias??1,
        castShadow:!!o.castShadow,receiveShadow:!!o.receiveShadow,viewportHeight:o.viewportHeight||KE.geometryViewportHeight,debugColors:!!o.debugColors});
      const g0=lods[0].geometry;g0.boundingSphere||g0.computeBoundingSphere();this.localCenter=g0.boundingSphere.center.clone();this.localRadius=g0.boundingSphere.radius;
      this._mat=new Float32Array(cap*16);for(let i=0;i<cap;i++){const b=i*16;this._mat[b]=this._mat[b+5]=this._mat[b+10]=this._mat[b+15]=1;}
      this._sph=new Float32Array(cap*4);for(let i=0;i<cap;i++){this._sph[i*4]=this.localCenter.x;this._sph[i*4+1]=this.localCenter.y;this._sph[i*4+2]=this.localCenter.z;this._sph[i*4+3]=this.localRadius;}
      this._vis=new Uint8Array(cap).fill(1);this._level=new Int8Array(cap).fill(-1);this._col=null;
      const obj=new T.Object3D();obj.isLOD=true;obj.autoUpdate=o.autoUpdate!==false;obj.name='ke-instanced-lod';obj.update=cam=>this.update(cam);obj.userData.keInstancedLOD=this;this.object=obj;
      this._levelMats=this.debugColors&&material.color?lods.map((l,i)=>{const m=material.clone();m.color=new T.Color(PALETTE[i%PALETTE.length]);return m;}):null;
      const mk=(geo,mat,name,shadow)=>{const m=new T.InstancedMesh(geo,mat,cap);m.count=0;m.frustumCulled=false;m.castShadow=shadow;m.receiveShadow=shadow?false:this.receiveShadow;m.instanceMatrix.setUsage(T.DynamicDrawUsage);m.name=name;m.visible=false;obj.add(m);return m;};
      this.meshes=lods.map((l,i)=>mk(l.geometry,this._levelMats?this._levelMats[i]:material,'ke-ilod'+i,false));
      this.shadowMeshes=this.castShadow?lods.map((l,i)=>mk(l.geometry,shadowOnlyMaterial(T),'ke-ilod-shadow'+i,true)):[];
      this.impostor=null;this.impostorMesh=null;this.impostorPixels=o.impostorPixels??null;if(o.impostor&&o.impostor.material)this.setImpostor(o.impostor,{pixels:o.impostorPixels});
      this._counts=new Int32Array(lods.length+1);this._scounts=new Int32Array(lods.length);this._state=new Float64Array(56).fill(NaN);this._dirty=true;this._stats={visible:0,culled:0,shadow:0};
    }
    get count(){return this._count;}
    set count(n){n=clamp(Math.floor(n),0,this.capacity);if(n!==this._count){this._count=n;this._dirty=true;}}
    setMatrixAt(i,m){const e=m.elements,b=i*16,a=this._mat;for(let k=0;k<16;k++)a[b+k]=e[k];
      const c=this.localCenter,x=c.x,y=c.y,z=c.z,sx=e[0]*e[0]+e[1]*e[1]+e[2]*e[2],sy=e[4]*e[4]+e[5]*e[5]+e[6]*e[6],sz=e[8]*e[8]+e[9]*e[9]+e[10]*e[10];
      this._sph[i*4]=e[0]*x+e[4]*y+e[8]*z+e[12];this._sph[i*4+1]=e[1]*x+e[5]*y+e[9]*z+e[13];this._sph[i*4+2]=e[2]*x+e[6]*y+e[10]*z+e[14];this._sph[i*4+3]=this.localRadius*Math.sqrt(Math.max(sx,sy,sz));this._dirty=true;}
    getMatrixAt(i,m){return m.fromArray(this._mat,i*16);}
    setColorAt(i,color){if(!this._col){this._col=new Float32Array(this.capacity*3).fill(1);for(const m of this._colored())m.instanceColor=new this.THREE.InstancedBufferAttribute(new Float32Array(this.capacity*3),3).setUsage(this.THREE.DynamicDrawUsage);}
      this._col[i*3]=color.r;this._col[i*3+1]=color.g;this._col[i*3+2]=color.b;this._dirty=true;}
    setVisibleAt(i,v){v=v?1:0;if(this._vis[i]!==v){this._vis[i]=v;this._dirty=true;}}
    getVisibleAt(i){return !!this._vis[i];}
    _colored(){return this.impostorMesh?[...this.meshes,this.impostorMesh]:this.meshes;}
    /* Attach a baked impostor (KE.Impostor.bake). Used when the instance projects below `pixels` (default half a frame). */
    setImpostor(imp,{pixels}={}){
      if(this.impostorMesh){this.impostorMesh.parent&&this.impostorMesh.parent.remove(this.impostorMesh);this.impostorMesh.dispose();}
      this.impostor=imp;const m=new this.THREE.InstancedMesh(imp.geometry,imp.material,this.capacity);m.count=0;m.frustumCulled=false;m.castShadow=false;m.receiveShadow=this.receiveShadow;m.instanceMatrix.setUsage(this.THREE.DynamicDrawUsage);m.name='ke-ilod-impostor';m.visible=false;
      if(this._col)m.instanceColor=new this.THREE.InstancedBufferAttribute(new Float32Array(this.capacity*3),3).setUsage(this.THREE.DynamicDrawUsage);
      this.impostorMesh=m;this.object.add(m);this.impostorPixels=pixels??this.impostorPixels??Math.max(24,imp.frameResolution*.5);this._dirty=true;return this;}
    bakeImpostor(renderer,opts={}){const T=this.THREE,mesh=new T.Mesh(this.lods[0].geometry,this.material);const imp=KE.Impostor.bake(T,renderer,mesh,opts);this._ownImpostor=imp;this.setImpostor(imp,{pixels:opts.pixels});return imp;}
    /* One pass over instances: visibility, frustum cull (object space), distance cull, level choice with a
       hysteresis band, then direct copy of the 16 matrix floats into the chosen level's buffer. */
    update(camera,viewportHeight){
      if(viewportHeight)this.viewportHeight=viewportHeight;if(camera.parent===null&&camera.matrixWorldAutoUpdate!==false)camera.updateMatrixWorld();
      const obj=this.object,st=this._state,vh=this.viewportHeight,bias=lodBias(),cw=camera.matrixWorld.elements,ow=obj.matrixWorld.elements,pw=camera.projectionMatrix.elements;
      /* skip the pass when nothing that affects the result changed */
      let same=!this._dirty&&st[0]===vh&&st[1]===bias&&st[2]===this.pixelError&&st[3]===this.hysteresis&&st[4]===this.maxDistance&&st[5]===this.shadowDistance&&st[6]===this.impostorPixels;
      for(let k=0;k<16&&same;k++)if(st[8+k]!==cw[k]||st[24+k]!==ow[k]||st[40+k]!==pw[k])same=false;
      if(same)return false;
      st[0]=vh;st[1]=bias;st[2]=this.pixelError;st[3]=this.hysteresis;st[4]=this.maxDistance;st[5]=this.shadowDistance;st[6]=this.impostorPixels;for(let k=0;k<16;k++){st[8+k]=cw[k];st[24+k]=ow[k];st[40+k]=pw[k];}this._dirty=false;
      _m.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(obj.matrixWorld);_fr.setFromProjectionMatrix(_m);
      const P=_fr.planes,p0=P[0].normal,p1=P[1].normal,p2=P[2].normal,p3=P[3].normal,p4=P[4].normal,p5=P[5].normal,d0=P[0].constant,d1=P[1].constant,d2=P[2].constant,d3=P[3].constant,d4=P[4].constant,d5=P[5].constant;
      camera.getWorldPosition(_v);_inv.copy(obj.matrixWorld).invert();_v.applyMatrix4(_inv);const cx=_v.x,cy=_v.y,cz=_v.z,os=obj.matrixWorld.getMaxScaleOnAxis()||1;
      const ps=pixelScale(camera,vh),K=ps.k*bias/Math.max(1e-6,this.pixelError),near=(camera.near||1e-3)/os,L=this.lods.length,thr=this._thr||(this._thr=new Float64Array(L+1));
      for(let l=0;l<L;l++)thr[l]=this.lods[l].error*K;
      const imp=this.impostorMesh?1:0,impK=imp?ps.k*bias*2/Math.max(1,this.impostorPixels):0;/* impostor when diameter*ps.k/d < pixels */
      const maxD=this.maxDistance/os,shD=this.castShadow?this.shadowDistance/os:-1,h=1+this.hysteresis,sb=this.shadowLodBias;
      const counts=this._counts.fill(0),scounts=this._scounts.fill(0),sph=this._sph,vis=this._vis,lev=this._level,mat=this._mat,col=this._col,n=this._count;
      const bufs=this._bufs||(this._bufs=[]);for(let l=0;l<L;l++)bufs[l]=this.meshes[l].instanceMatrix.array;if(imp)bufs[L]=this.impostorMesh.instanceMatrix.array;
      const sbufs=this.shadowMeshes.map(m=>m.instanceMatrix.array),cbufs=col?this._colored().map(m=>m.instanceColor.array):null;
      let visible=0,culled=0,shadow=0;
      for(let i=0;i<n;i++){
        if(!vis[i]){lev[i]=-1;continue;}
        const x=sph[i*4],y=sph[i*4+1],z=sph[i*4+2],r=sph[i*4+3];
        const dist=Math.sqrt((x-cx)*(x-cx)+(y-cy)*(y-cy)+(z-cz)*(z-cz));
        if(dist-r>maxD){lev[i]=-1;culled++;continue;}
        const inView=!this.frustumCull||(p0.x*x+p0.y*y+p0.z*z+d0>=-r&&p1.x*x+p1.y*y+p1.z*z+d1>=-r&&p2.x*x+p2.y*y+p2.z*z+d2>=-r&&p3.x*x+p3.y*y+p3.z*z+d3>=-r&&p4.x*x+p4.y*y+p4.z*z+d4>=-r&&p5.x*x+p5.y*y+p5.z*z+d5>=-r);
        const de=ps.ortho?1:Math.max(dist-r,near),s=r/this.localRadius;
        /* coarsest acceptable (coarse) and coarsest acceptable with hysteresis margin (fine) */
        let coarse=0,fine=0;for(let l=L-1;l>0;l--)if(thr[l]*s<=de){coarse=l;break;}for(let l=coarse;l>0;l--)if(thr[l]*s*h<=de){fine=l;break;}
        if(imp){if(r*impK<=de&&coarse===L-1)coarse=L;if(r*impK*h<=de&&fine===L-1)fine=L;}
        const cur=lev[i];let l=cur>=fine&&cur<=coarse?cur:(cur>coarse?coarse:fine);lev[i]=l;
        if(inView){const dst=bufs[l],o=counts[l]*16,b=i*16;for(let k=0;k<16;k++)dst[o+k]=mat[b+k];if(cbufs){const cd=cbufs[l],co=counts[l]*3;cd[co]=col[i*3];cd[co+1]=col[i*3+1];cd[co+2]=col[i*3+2];}counts[l]++;visible++;}else culled++;
        if(shD>=0&&dist-r<=shD){const sl=Math.min(Math.min(l,L-1)+sb,L-1),dst=sbufs[sl],o=scounts[sl]*16,b=i*16;for(let k=0;k<16;k++)dst[o+k]=mat[b+k];scounts[sl]++;shadow++;}
      }
      const flush=(m,c,ce)=>{m.count=c;m.visible=c>0;if(c>0){const a=m.instanceMatrix;a.updateRange.offset=0;a.updateRange.count=c*16;a.needsUpdate=true;if(ce&&m.instanceColor){const ic=m.instanceColor;ic.updateRange.offset=0;ic.updateRange.count=c*3;ic.needsUpdate=true;}}};
      for(let l=0;l<L;l++)flush(this.meshes[l],counts[l],!!cbufs);if(imp)flush(this.impostorMesh,counts[L],!!cbufs);
      for(let l=0;l<this.shadowMeshes.length;l++)flush(this.shadowMeshes[l],scounts[l],false);
      this._stats.visible=visible;this._stats.culled=culled;this._stats.shadow=shadow;return true;
    }
    stats(){const L=this.lods.length,levels=Array.from(this._counts.subarray(0,L));let tris=0,draws=0;for(let l=0;l<L;l++){tris+=levels[l]*this.lods[l].triangles;if(levels[l])draws++;}
      const imp=this.impostorMesh?this._counts[L]:0;if(imp){tris+=imp*2;draws++;}let stris=0;this._scounts.forEach((c,l)=>{stris+=c*this.lods[l].triangles;});
      return {capacity:this.capacity,count:this._count,visible:this._stats.visible,culled:this._stats.culled,levels,impostors:imp,triangles:tris,fullDetailTriangles:this._stats.visible*this.lods[0].triangles,drawCalls:draws,shadowCasters:this._stats.shadow,shadowTriangles:stris};}
    dispose(){const o=this.object;o.parent&&o.parent.remove(o);for(const m of [...this.meshes,...this.shadowMeshes])m.dispose();if(this.impostorMesh)this.impostorMesh.dispose();
      if(this._ownLods)for(const l of this.lods)if(l.generated)l.geometry.dispose();(this._levelMats||[]).forEach(m=>m.dispose());if(this._ownImpostor)this._ownImpostor.dispose();}
  }

  /* ===== VirtualGeometry: cluster DAG + per-cluster cut + one draw ===== */
  class VirtualGeometry extends THREE.Object3D{
    constructor(T,src,material,o={}){
      if(Array.isArray(material))throw new TypeError('KE.VirtualGeometry supports a single material');
      super();this.isKEVirtualGeometry=true;this.isLOD=true;this.autoUpdate=o.autoUpdate!==false;this.type='KEVirtualGeometry';this.THREE=T;
      const data=src&&src.isKEClusterDAG?src:src&&src.data&&src.data.isKEClusterDAG?src.data:buildDAG(T,src,o);this.data=data;data.refs++;
      const pe=o.pixelError??(KE.cvars&&KE.cvars.get('r.Geometry.PixelError'))??1;
      Object.assign(this,{pixelError:pe,shadowPixelError:o.shadowPixelError??pe*4,frustumCull:o.frustumCull!==false,viewportHeight:o.viewportHeight||KE.geometryViewportHeight,freeze:false});
      this.material=material;this.castShadow=!!o.castShadow;this.receiveShadow=!!o.receiveShadow;
      const mkGeo=()=>{const g=new T.BufferGeometry();for(const [n,a] of Object.entries(data.attributes))g.setAttribute(n,a);const idx=new T.BufferAttribute(new Uint32Array(data.maxIndices),1);idx.setUsage(T.DynamicDrawUsage);g.setIndex(idx);g.setDrawRange(0,0);g.boundingSphere=data.boundingSphere.clone();g.boundingBox=data.boundingBox.clone();return g;};
      this.geometry=mkGeo();this.mesh=new T.Mesh(this.geometry,material);this.mesh.name='ke-virtual-geometry';this.mesh.receiveShadow=this.receiveShadow;this.mesh.castShadow=false;this.add(this.mesh);
      this.shadowGeometry=null;this.shadowMesh=null;
      if(this.castShadow){this.shadowGeometry=mkGeo();this.shadowMesh=new T.Mesh(this.shadowGeometry,shadowOnlyMaterial(T));this.shadowMesh.castShadow=true;this.shadowMesh.name='ke-virtual-geometry-shadow';this.add(this.shadowMesh);}
      const C=data.clusterCount,G=data.groupCount;this._gp=new Float32Array(G);this._sel=new Int32Array(C);this._prev=new Int32Array(C);this._prevN=-1;this._ssel=new Int32Array(C);this._sprev=new Int32Array(C);this._sprevN=-1;
      this._state=new Float64Array(24).fill(NaN);this._sstate=new Float64Array(8).fill(NaN);this._stats={clusters:0,triangles:0,culled:0,levels:new Int32Array(data.levelCount),rebuilds:0,shadowTriangles:0,shadowClusters:0};
      this.debugMaterial=null;this.debugMode=false;if(o.debugColors)this.setDebugColors(o.debugColors===true?'cluster':o.debugColors);
    }
    /* Projected error of every group, then the clusterlod rule per cluster:
       draw c  <=>  err(group(c)) > t  and  (c is original  or  err(refined(c)) <= t). */
    update(camera,viewportHeight){
      if(viewportHeight)this.viewportHeight=viewportHeight;if(this.freeze)return false;if(camera.parent===null&&camera.matrixWorldAutoUpdate!==false)camera.updateMatrixWorld();
      const D=this.data,vh=this.viewportHeight,bias=lodBias(),ps=pixelScale(camera,vh);
      _m.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(this.matrixWorld);
      camera.getWorldPosition(_v);_inv.copy(this.matrixWorld).invert();_v.applyMatrix4(_inv);
      const st=this._state,me=_m.elements;let same=st[0]===vh&&st[1]===bias&&st[2]===this.pixelError&&st[3]===_v.x&&st[4]===_v.y&&st[5]===_v.z&&st[22]===this.shadowPixelError;
      for(let k=0;k<16&&same;k++)if(st[6+k]!==me[k])same=false;if(same)return false;
      st[0]=vh;st[1]=bias;st[2]=this.pixelError;st[3]=_v.x;st[4]=_v.y;st[5]=_v.z;for(let k=0;k<16;k++)st[6+k]=me[k];st[22]=this.shadowPixelError;
      if(this.frustumCull)_fr.setFromProjectionMatrix(_m);
      const os=this.matrixWorld.getMaxScaleOnAxis()||1,near=(camera.near||1e-3)/os;
      this._project(ps,near,_v);
      const t=this.pixelError/(ps.k*bias);/* compare error/d against t (both sides divided by k) */
      const n=this._cut(t,this.frustumCull?_fr:null,this._sel);
      if(this._differs(this._sel,n,this._prev,this._prevN)){this._write(this.geometry,this._sel,n);this._prev.set(this._sel.subarray(0,n));this._prevN=n;this._stats.rebuilds++;}
      this._stats.clusters=n;
      if(this.shadowMesh){const ss=this._sstate,ts=this.shadowPixelError/(ps.k*bias);if(!(ss[0]===_v.x&&ss[1]===_v.y&&ss[2]===_v.z&&ss[3]===ts)){ss[0]=_v.x;ss[1]=_v.y;ss[2]=_v.z;ss[3]=ts;
        const sn=this._cut(ts,null,this._ssel);if(this._differs(this._ssel,sn,this._sprev,this._sprevN)){this._write(this.shadowGeometry,this._ssel,sn);this._sprev.set(this._ssel.subarray(0,sn));this._sprevN=sn;}this._stats.shadowClusters=sn;this._stats.shadowTriangles=this.shadowGeometry.drawRange.count/3;}}
      return true;
    }
    _project(ps,near,cam){const D=this.data,gs=D.groupSphere,ge=D.groupError,gp=this._gp;
      for(let g=0;g<D.groupCount;g++){const e=ge[g];if(e===Infinity){gp[g]=Infinity;continue;}
        const d=ps.ortho?1:Math.max(Math.sqrt((gs[g*4]-cam.x)**2+(gs[g*4+1]-cam.y)**2+(gs[g*4+2]-cam.z)**2)-gs[g*4+3],near);gp[g]=e/d;}}
    _cut(t,frustum,out){const D=this.data,gp=this._gp,cg=D.clusterGroup,cr=D.clusterRefined,cs=D.clusterSphere,lv=D.clusterLevel,lvls=frustum?this._stats.levels.fill(0):null;let n=0,tris=0,culled=0;
      const P=frustum?frustum.planes:null;
      for(let c=0;c<D.clusterCount;c++){
        if(!(gp[cg[c]]>t))continue;const r=cr[c];if(r>=0&&!(gp[r]<=t))continue;
        if(P){const x=cs[c*4],y=cs[c*4+1],z=cs[c*4+2],rad=cs[c*4+3];let inside=true;for(let k=0;k<6;k++){const p=P[k];if(p.normal.x*x+p.normal.y*y+p.normal.z*z+p.constant<-rad){inside=false;break;}}if(!inside){culled++;continue;}}
        out[n++]=c;tris+=D.clusterCountIdx[c]/3;if(lvls)lvls[lv[c]]++;}
      if(frustum){this._stats.triangles=tris;this._stats.culled=culled;}else if(out===this._sel){this._stats.triangles=tris;this._stats.culled=0;this._stats.levels.fill(0);for(let i=0;i<n;i++)this._stats.levels[lv[out[i]]]++;}
      return n;}
    _differs(a,n,b,m){if(n!==m)return true;for(let i=0;i<n;i++)if(a[i]!==b[i])return true;return false;}
    _write(geo,sel,n){const D=this.data,idx=geo.index,dst=idx.array,all=D.clusterIndices,first=D.clusterFirst,cnt=D.clusterCountIdx;let o=0;
      for(let i=0;i<n;i++){const c=sel[i],f=first[c],k=cnt[c];if(o+k>dst.length)break;dst.set(all.subarray(f,f+k),o);o+=k;}
      idx.updateRange.offset=0;idx.updateRange.count=o;idx.needsUpdate=true;geo.setDrawRange(0,o);}
    /* Debug colours: 'cluster' | 'group' | 'level' | false. Swaps in a vertex-coloured standard material. */
    setDebugColors(mode){const T=this.THREE;if(mode===true)mode='cluster';
      if(!mode){if(this.debugMode){this.geometry.deleteAttribute('color');this.mesh.material=this.material;this.debugMode=false;}return this;}
      const attr=this.data.debugColors(T,mode);this.geometry.setAttribute('color',attr);
      if(!this.debugMaterial)this.debugMaterial=new T.MeshStandardMaterial({vertexColors:true,roughness:.75,metalness:0,side:this.material&&this.material.side!==undefined?this.material.side:T.FrontSide});
      this.mesh.material=this.debugMaterial;this.debugMode=mode;return this;}
    /* Debug: force an arbitrary cut (predicate over cluster ids). Used by tests to prove the crack check detects cracks. */
    debugCut(pred){const D=this.data;let n=0;for(let c=0;c<D.clusterCount;c++)if(pred(c,D))this._sel[n++]=c;this._write(this.geometry,this._sel,n);this._prevN=-1;this._state.fill(NaN);this.freeze=true;return n;}
    stats(){const D=this.data;return {clusters:D.clusterCount,groups:D.groupCount,levels:D.levelCount,sourceTriangles:D.sourceTriangles,selectedClusters:this._stats.clusters,triangles:this._stats.triangles,
      culledClusters:this._stats.culled,clustersPerLevel:Array.from(this._stats.levels),rebuilds:this._stats.rebuilds,shadowTriangles:this._stats.shadowTriangles,buildMs:D.buildMs,backend:D.backend,
      renderVertices:D.renderVertices,levelTriangles:D.levelTriangles.slice()};}
    clone(){return new VirtualGeometry(this.THREE,this.data,this.material,{pixelError:this.pixelError,shadowPixelError:this.shadowPixelError,frustumCull:this.frustumCull,castShadow:this.castShadow,receiveShadow:this.receiveShadow,viewportHeight:this.viewportHeight}).copy(this,false);}
    copy(src){THREE.Object3D.prototype.copy.call(this,src,false);return this;}
    dispose(){this.parent&&this.parent.remove(this);const D=this.data;D.refs--;
      const drop=g=>{if(!g)return;if(D.refs>0){for(const n of Object.keys(D.attributes))g.deleteAttribute(n);if(g.getAttribute('color'))g.deleteAttribute('color');}g.dispose();};
      drop(this.geometry);drop(this.shadowGeometry);if(D.refs<=0)D.dispose();if(this.debugMaterial)this.debugMaterial.dispose();}
  }
  return {LODMesh,InstancedLOD,VirtualGeometry};
}
KE.LODMesh=publicClass('LODMesh');
KE.InstancedLOD=publicClass('InstancedLOD');
KE.VirtualGeometry=publicClass('VirtualGeometry');

/* ---------- cluster DAG construction ---------- */
/* Clusterize one index list (global vertex ids) into clusters of <= maxTris triangles. */
function clusterize(positions,indices,vc,weld,maxTris,maxVerts,o,scratch){
  const out=[];if(!indices.length)return out;
  if(useMeshopt(o,'clusterizer')){
    const cp=compact(indices,positions,null,vc,scratch),M=window.MeshoptClusterizer.buildMeshlets(cp.local,cp.pos,3,maxVerts,maxTris,0);
    for(let i=0;i<M.meshletCount;i++){const vo=M.meshlets[i*4],to=M.meshlets[i*4+1],tc=M.meshlets[i*4+3],ci=new Uint32Array(tc*3);
      for(let j=0;j<tc*3;j++)ci[j]=cp.verts[M.vertices[vo+M.triangles[to+j]]];out.push(ci);}
    return out;
  }
  /* JS: breadth-first growth over vertex-adjacent triangles, seeded in Morton order of centroids */
  const T=indices.length/3,b=boundsOf(positions,indices),inv=1023/b.size,keys=new Float64Array(T),order=new Uint32Array(T);
  for(let t=0;t<T;t++){let x=0,y=0,z=0;for(let k=0;k<3;k++){const v=indices[t*3+k];x+=positions[v*3];y+=positions[v*3+1];z+=positions[v*3+2];}
    keys[t]=morton(((x/3-b.min[0])*inv)|0,((y/3-b.min[1])*inv)|0,((z/3-b.min[2])*inv)|0);order[t]=t;}
  order.sort((a,c)=>keys[a]-keys[c]);
  const vmap=new Map();let nv=0;const vid=new Int32Array(T*3);for(let i=0;i<T*3;i++){const w=weld[indices[i]];let l=vmap.get(w);if(l===undefined){l=nv++;vmap.set(w,l);}vid[i]=l;}
  const start=new Int32Array(nv+1);for(let i=0;i<T*3;i++)start[vid[i]+1]++;for(let v=0;v<nv;v++)start[v+1]+=start[v];const fill=start.slice(0,nv),vt=new Int32Array(T*3);for(let i=0;i<T*3;i++)vt[fill[vid[i]]++]=(i/3)|0;
  const done=new Uint8Array(T),inCl=new Int32Array(nv).fill(-1),queue=new Int32Array(T),queued=new Int32Array(T).fill(-1);let cid=0;
  for(const seed of order){if(done[seed])continue;const tris=[];let verts=0,qh=0,qt=0;queue[qt++]=seed;queued[seed]=cid;
    while(qh<qt&&tris.length<maxTris){const t=queue[qh++];if(done[t])continue;let add=0;for(let k=0;k<3;k++)if(inCl[vid[t*3+k]]!==cid)add++;if(verts+add>maxVerts)continue;
      done[t]=1;tris.push(t);for(let k=0;k<3;k++){const v=vid[t*3+k];if(inCl[v]!==cid){inCl[v]=cid;verts++;}for(let e=start[v];e<start[v+1];e++){const u=vt[e];if(!done[u]&&queued[u]!==cid){queued[u]=cid;queue[qt++]=u;}}}}
    const ci=new Uint32Array(tris.length*3);tris.forEach((t,j)=>{ci[j*3]=indices[t*3];ci[j*3+1]=indices[t*3+1];ci[j*3+2]=indices[t*3+2];});out.push(ci);cid++;}
  return out;
}
/* Group clusters (~groupSize each) by shared-vertex adjacency: seeds in Morton order, greedy growth toward the
   most-connected unassigned neighbour; tiny leftovers merge into their best-connected neighbour group. */
function partition(ids,C,weld,groupSize,bounds){
  const n=ids.length;if(n<=groupSize)return [ids.slice()];
  const vmap=new Map(),pairs=[];
  for(let k=0;k<n;k++){const ci=C.indices[ids[k]],seen=new Set();for(let j=0;j<ci.length;j++){const w=weld[ci[j]];if(seen.has(w))continue;seen.add(w);let l=vmap.get(w);if(!l){l=[];vmap.set(w,l);}l.push(k);}}
  const adj=Array.from({length:n},()=>new Map());
  for(const l of vmap.values())if(l.length>1)for(let a=0;a<l.length;a++)for(let b=a+1;b<l.length;b++){const x=l[a],y=l[b];adj[x].set(y,(adj[x].get(y)||0)+1);adj[y].set(x,(adj[y].get(x)||0)+1);}
  const S=C.lodSphere,inv=1023/bounds.size,key=new Float64Array(n),order=Array.from({length:n},(_,k)=>k);
  for(let k=0;k<n;k++){const c=ids[k];key[k]=morton(clamp(((S[c*4]-bounds.min[0])*inv)|0,0,1023),clamp(((S[c*4+1]-bounds.min[1])*inv)|0,0,1023),clamp(((S[c*4+2]-bounds.min[2])*inv)|0,0,1023));}
  order.sort((a,b)=>key[a]-key[b]);
  const gid=new Int32Array(n).fill(-1),groups=[];
  for(const seed of order){if(gid[seed]>=0)continue;const g=groups.length,mem=[seed];gid[seed]=g;const cand=new Map();
    const addN=k=>{for(const [u,w] of adj[k])if(gid[u]<0)cand.set(u,(cand.get(u)||0)+w);};addN(seed);
    const sx=S[ids[seed]*4],sy=S[ids[seed]*4+1],sz=S[ids[seed]*4+2];
    while(mem.length<groupSize&&cand.size){let best=-1,bw=-1,bd=Infinity;for(const [u,w] of cand){if(gid[u]>=0)continue;const c=ids[u],d=(S[c*4]-sx)**2+(S[c*4+1]-sy)**2+(S[c*4+2]-sz)**2;if(w>bw||(w===bw&&d<bd)){best=u;bw=w;bd=d;}}
      if(best<0)break;cand.delete(best);gid[best]=g;mem.push(best);addN(best);}
    groups.push(mem);}
  const minSize=Math.max(1,groupSize>>2);
  for(let g=0;g<groups.length;g++){const mem=groups[g];if(!mem.length||mem.length>minSize)continue;const w=new Map();
    for(const k of mem)for(const [u,x] of adj[k]){const h=gid[u];if(h!==g&&groups[h].length)w.set(h,(w.get(h)||0)+x);}
    let best=-1,bw=0;for(const [h,x] of w)if(x>bw&&groups[h].length+mem.length<=groupSize*2){best=h;bw=x;}
    if(best>=0){for(const k of mem){gid[k]=best;groups[best].push(k);}groups[g]=[];}}
  /* groups still tiny (disconnected pieces) join the spatially nearest group so they can simplify too */
  for(let g=0;g<groups.length;g++){const mem=groups[g];if(!mem.length||mem.length>minSize)continue;const c=ids[mem[0]];let best=-1,bd=Infinity;
    for(let h=0;h<groups.length;h++){if(h===g||!groups[h].length||groups[h].length+mem.length>groupSize*2)continue;const o=ids[groups[h][0]],d=(S[c*4]-S[o*4])**2+(S[c*4+1]-S[o*4+1])**2+(S[c*4+2]-S[o*4+2])**2;if(d<bd){bd=d;best=h;}}
    if(best>=0){for(const k of mem){gid[k]=best;groups[best].push(k);}groups[g]=[];}}
  return groups.filter(m=>m.length).map(m=>m.map(k=>ids[k]));
}
function buildDAG(THREE,geometry,o){
  const t0=performance.now(),src=readSource(geometry),{positions,indices,vertexCount:vc}=src,weld=positionRemap(positions,vc);
  if(indices.length<3)throw new Error('KE.VirtualGeometry: geometry has no triangles');
  const maxTris=clamp(Math.round((o.clusterTriangles||128)/4)*4,16,256),maxVerts=Math.min(255,Math.max(maxTris,64)),groupSize=clamp(o.groupSize||8,2,32),maxLevels=o.levels==='auto'||!o.levels?24:clamp(o.levels|0,1,24);
  const opts={backend:o.backend},scratch={},bounds=boundsOf(positions,indices);
  const nrm=o.attributes!==false&&src.attrs.normal&&src.attrs.normal.itemSize===3&&(o.normalWeight??.1)>0?{array:src.attrs.normal.array,k:3}:null,nw=o.normalWeight??.1;
  /* growable cluster store */
  const C={indices:[],level:[],group:[],refined:[],lodSphere:new Float64Array(1024),lodError:[],cull:[]};
  const grow=()=>{if(C.lodSphere.length<C.indices.length*4+4){const a=new Float64Array(C.lodSphere.length*2);a.set(C.lodSphere);C.lodSphere=a;}};
  const addCluster=(ci,level,refined,sphere,err)=>{const id=C.indices.length;C.indices.push(ci);C.level.push(level);C.group.push(-1);C.refined.push(refined);grow();
    if(sphere)C.lodSphere.set(sphere,id*4);else sphereOf(positions,ci,C.lodSphere,id*4);C.lodError.push(err);return id;};
  const groupSphere=[],groupError=[],groupLevel=[],tmp=new Float64Array(4);
  let current=clusterize(positions,indices,vc,weld,maxTris,maxVerts,opts,scratch).map(ci=>addCluster(ci,0,-1,null,0));
  const levelTris=[indices.length/3],locked=new Uint8Array(vc),owner=new Int32Array(vc);let depth=0;
  /* optional: lock open mesh borders (welded edges used once) so tiles sharing an edge never crack */
  let border=null;if(o.lockBorder){border=new Uint8Array(vc);const E=new Map();for(let i=0;i<indices.length;i+=3)for(let k=0;k<3;k++){const a=weld[indices[i+k]],b=weld[indices[i+(k+1)%3]],key=a<b?a*vc+b:b*vc+a;E.set(key,(E.get(key)||0)+1);}
    for(const [key,n] of E)if(n===1){border[Math.floor(key/vc)]=1;border[key%vc]=1;}}
  while(current.length>1&&depth<maxLevels-1){
    const parts=partition(current,C,weld,groupSize,bounds);
    /* lock every (welded) vertex shared by two groups of this level */
    owner.fill(-1);if(border)locked.set(border);else locked.fill(0);
    parts.forEach((p,g)=>{for(const c of p){const ci=C.indices[c];for(let j=0;j<ci.length;j++){const w=weld[ci[j]];if(owner[w]<0)owner[w]=g;else if(owner[w]!==g)locked[w]=1;}}});
    const next=[];let progressed=false;
    for(const p of parts){
      let total=0;for(const c of p)total+=C.indices[c].length;const merged=new Uint32Array(total);let off=0;for(const c of p){merged.set(C.indices[c],off);off+=C.indices[c].length;}
      mergeSpheres(C.lodSphere,p,tmp);let err0=0;for(const c of p)err0=Math.max(err0,C.lodError[c]);
      const g=groupError.length;groupSphere.push(tmp[0],tmp[1],tmp[2],tmp[3]);groupLevel.push(depth);groupError.push(Infinity);for(const c of p)C.group[c]=g;
      const cp=compact(merged,positions,nrm,vc,scratch),lock=new Uint8Array(cp.count);for(let l=0;l<cp.count;l++)lock[l]=locked[weld[cp.verts[l]]];
      let res;
      if(useMeshopt(opts,'simplifier'))res=simplifyIndices(cp.pos,cp.local,cp.count,Math.floor(total/3*.5)*3,Infinity,{locks:lock,attr:cp.extra,attrStride:3,weights:nrm?[nw,nw,nw]:null});
      else{const lw=new Uint32Array(cp.count);for(let l=0;l<cp.count;l++)lw[l]=l;/* local weld via global weld of the copies */
        const wm=new Map();for(let l=0;l<cp.count;l++){const w=weld[cp.verts[l]];if(wm.has(w))lw[l]=wm.get(w);else wm.set(w,l);}
        res=simplifyIndices(cp.pos,cp.local,cp.count,Math.floor(total/3*.5)*3,Infinity,{backend:'js',locks:lock,weld:lw});}
      if(res.indices.length>total*.85||res.indices.length<3)continue;/* stuck: terminal group */
      const e=Math.max(err0,res.error);groupError[g]=e;progressed=true;
      const simp=new Uint32Array(res.indices.length);for(let i=0;i<simp.length;i++)simp[i]=cp.verts[res.indices[i]];
      for(const ci of clusterize(positions,simp,vc,weld,maxTris,maxVerts,opts,scratch))next.push(addCluster(ci,depth+1,g,tmp,e));
    }
    if(!progressed||!next.length)break;
    let lt=0;for(const c of next)lt+=C.indices[c].length/3;levelTris.push(lt);current=next;depth++;
  }
  /* whatever is left without a group becomes one terminal group */
  const rest=[];for(let c=0;c<C.indices.length;c++)if(C.group[c]<0)rest.push(c);
  if(rest.length){mergeSpheres(C.lodSphere,rest,tmp);const g=groupError.length;groupSphere.push(tmp[0],tmp[1],tmp[2],tmp[3]);groupError.push(Infinity);groupLevel.push(depth);for(const c of rest)C.group[c]=g;}
  return packDAG(THREE,src,C,groupSphere,groupError,groupLevel,levelTris,weld,t0,useMeshopt(opts,'simplifier')?'meshoptimizer':'js');
}
/* Flatten clusters into render buffers: each cluster owns a private vertex range (duplicated border
   vertices keep bit-identical positions, so any valid cut is watertight) and a static index slice. */
function packDAG(THREE,src,C,gs,ge,gl,levelTris,weld,t0,backendName){
  const N=C.indices.length,vc=src.vertexCount,stamp=new Int32Array(vc).fill(-1),local=new Int32Array(vc);
  let totalV=0,totalI=0;for(let c=0;c<N;c++){const ci=C.indices[c];totalI+=ci.length;for(let j=0;j<ci.length;j++){const v=ci[j];if(stamp[v]!==c){stamp[v]=c;totalV++;}}}
  stamp.fill(-1);const vertOf=new Uint32Array(totalV),clusterIndices=new Uint32Array(totalI),first=new Uint32Array(N),count=new Uint32Array(N),vfirst=new Uint32Array(N+1),cull=new Float32Array(N*4);
  let vo=0,io=0;for(let c=0;c<N;c++){const ci=C.indices[c];first[c]=io;count[c]=ci.length;vfirst[c]=vo;
    for(let j=0;j<ci.length;j++){const v=ci[j];if(stamp[v]!==c){stamp[v]=c;local[v]=vo;vertOf[vo++]=v;}clusterIndices[io++]=local[v];}sphereOf(src.positions,ci,cull,c*4);}
  vfirst[N]=vo;
  const attributes={};for(const name of Object.keys(src.attrs)){const a=src.attrs[name],k=a.itemSize,out=new a.array.constructor(totalV*k);for(let i=0;i<totalV;i++){const v=vertOf[i];for(let q=0;q<k;q++)out[i*k+q]=a.array[v*k+q];}attributes[name]=new THREE.BufferAttribute(out,k,a.normalized);}
  const level=Uint8Array.from(C.level),levelCount=Math.max(...C.level)+1,gsph=Float32Array.from(gs),gerr=Float32Array.from(ge);
  let maxIndices=0;for(let c=0;c<N;c++)if(C.level[c]===0)maxIndices+=count[c];
  const box=new THREE.Box3();box.min.fromArray(boundsOf(src.positions,src.indices).min);box.max.fromArray(boundsOf(src.positions,src.indices).max);const sphere=new THREE.Sphere();box.getBoundingSphere(sphere);
  {let r2=0;const p=src.positions;for(let i=0;i<src.indices.length;i++){const v=src.indices[i]*3,d=(p[v]-sphere.center.x)**2+(p[v+1]-sphere.center.y)**2+(p[v+2]-sphere.center.z)**2;if(d>r2)r2=d;}sphere.radius=Math.sqrt(r2);}
  const debugCache={};
  const data={isKEClusterDAG:true,refs:0,clusterCount:N,groupCount:gerr.length,levelCount,clusterIndices,clusterFirst:first,clusterCountIdx:count,clusterVertexFirst:vfirst,clusterSphere:cull,
    clusterGroup:Int32Array.from(C.group),clusterRefined:Int32Array.from(C.refined),clusterLevel:level,groupSphere:gsph,groupError:gerr,groupLevel:Uint8Array.from(gl),
    attributes,renderVertices:totalV,maxIndices,sourceTriangles:src.indices.length/3,levelTriangles:levelTris,boundingBox:box,boundingSphere:sphere,buildMs:performance.now()-t0,backend:backendName,
    debugColors(T,mode){if(debugCache[mode])return debugCache[mode];const col=new Float32Array(totalV*3),c3=new T.Color();
      for(let c=0;c<N;c++){const id=mode==='level'?level[c]:mode==='group'?this.clusterGroup[c]:c;
        if(mode==='level')c3.setHex(PALETTE[id%PALETTE.length]);else{const h=hash3(id,77,mode==='group'?5:3);c3.setHSL((h&1023)/1023,.55+((h>>10)&255)/255*.35,.42+((h>>18)&255)/255*.22);}
        c3.convertSRGBToLinear();for(let v=vfirst[c];v<vfirst[c+1];v++){col[v*3]=c3.r;col[v*3+1]=c3.g;col[v*3+2]=c3.b;}}
      return debugCache[mode]=new T.BufferAttribute(col,3);},
    dispose(){const g=new THREE.BufferGeometry();for(const [n,a] of Object.entries(attributes))g.setAttribute(n,a);for(const k of Object.keys(debugCache))g.setAttribute('ke_dbg_'+k,debugCache[k]);g.dispose();}};
  return data;
}
/* Build the cluster DAG once and share it between many VirtualGeometry objects. */
KE.VirtualGeometry.build=(THREE,geometry,o={})=>buildDAG(THREE,geometry,o);

/* ---------- impostors ---------- */
/* Octahedral (full sphere or upper hemisphere) or horizontal-ring billboard atlases. Albedo+alpha and
   object-space normals are baked per frame with an orthographic camera; at runtime a camera-facing quad
   picks the 3 frames around the view direction (2 for billboard), reprojects the quad onto each frame's
   image plane and blends them. lit:true shades the baked normals with the scene's lights (standard
   material); lit:false shows colours baked under a neutral light rig. */
const IMP_GLSL=`
uniform sampler2D keImpAlbedo;uniform sampler2D keImpNormal;uniform vec4 keImpInfo;uniform vec4 keImpSphere;
varying vec2 vImpUv0;varying vec2 vImpUv1;varying vec2 vImpUv2;varying vec3 vImpW;`;
const IMP_VS_FUN=`
vec2 keImpEncode(vec3 d){
  if(keImpInfo.w>1.5){float a=atan(d.x,d.z);return vec2(fract(a/6.28318530718+1.),0.);}
  if(keImpInfo.w>.5){d.y=max(d.y,0.);vec3 q=d/(abs(d.x)+abs(d.y)+abs(d.z));return vec2(q.x+q.z,q.x-q.z)*.5+.5;}
  vec3 q=d/(abs(d.x)+abs(d.y)+abs(d.z));vec2 p=q.xz;if(q.y<0.){p=(1.-abs(p.yx))*vec2(p.x>=0.?1.:-1.,p.y>=0.?1.:-1.);}return p*.5+.5;}
vec3 keImpDecode(vec2 uv){
  if(keImpInfo.w>1.5){float a=uv.x*6.28318530718;return vec3(sin(a),0.,cos(a));}
  vec2 p=uv*2.-1.;
  if(keImpInfo.w>.5){vec2 q=vec2(p.x+p.y,p.x-p.y)*.5;return normalize(vec3(q.x,1.-abs(q.x)-abs(q.y),q.y));}
  vec3 d=vec3(p.x,1.-abs(p.x)-abs(p.y),p.y);if(d.y<0.){vec2 s=vec2(d.x>=0.?1.:-1.,d.z>=0.?1.:-1.);d.xz=(1.-abs(d.zx))*s;}return normalize(d);}
void keImpBasis(vec3 d,out vec3 r,out vec3 u){vec3 up=abs(d.y)>.999?vec3(0.,0.,1.):vec3(0.,1.,0.);r=normalize(cross(up,d));u=cross(d,r);}
vec3 keImpViewDir(){
  mat4 m=modelMatrix;
  #ifdef USE_INSTANCING
  m=modelMatrix*instanceMatrix;
  #endif
  vec3 cw=(m*vec4(keImpSphere.xyz,1.)).xyz;vec3 vw=isOrthographic?vec3(viewMatrix[0][2],viewMatrix[1][2],viewMatrix[2][2]):cameraPosition-cw;
  vec3 v=transpose(mat3(m))*vw;if(keImpInfo.w>1.5)v.y=0.;return normalize(v+vec3(0.,0.,1e-6));}
vec2 keImpFrameUv(vec2 cell,vec3 p){
  vec3 d,r,u;float N=keImpInfo.x;
  if(keImpInfo.w>1.5){float k=cell.x;d=keImpDecode(vec2(k/N,0.));cell=vec2(mod(k,keImpInfo.y),floor(k/keImpInfo.y));}
  else d=keImpDecode(cell/(N-1.));
  keImpBasis(d,r,u);vec2 f=clamp(vec2(dot(p,r),dot(p,u))/(2.*keImpSphere.w)+.5,0.,1.);
  vec2 grid=keImpInfo.w>1.5?vec2(keImpInfo.y,keImpInfo.z):vec2(N);return (cell+f)/grid;}
`;
const IMP_VS_MAIN=`
vec3 keV=keImpViewDir();vec3 keR,keU;keImpBasis(keV,keR,keU);
if(keImpInfo.w>1.5){keU=vec3(0.,1.,0.);keR=normalize(cross(keU,keV));}
vec3 keP=(position.x*keR+position.y*keU)*keImpSphere.w;
vec3 transformed=keImpSphere.xyz+keP;
if(keImpInfo.w>1.5){float t=keImpEncode(keV).x*keImpInfo.x;float k0=floor(t);float f=t-k0;
  vImpUv0=keImpFrameUv(vec2(mod(k0,keImpInfo.x),0.),keP);vImpUv1=keImpFrameUv(vec2(mod(k0+1.,keImpInfo.x),0.),keP);vImpUv2=vImpUv0;vImpW=vec3(1.-f,f,0.);}
else{vec2 g=keImpEncode(keV)*(keImpInfo.x-1.);vec2 c=clamp(floor(g),vec2(0.),vec2(keImpInfo.x-2.));vec2 f=clamp(g-c,0.,1.);
  vImpUv0=keImpFrameUv(c,keP);vImpUv2=keImpFrameUv(c+1.,keP);
  if(f.x>=f.y){vImpUv1=keImpFrameUv(c+vec2(1.,0.),keP);vImpW=vec3(1.-f.x,f.x-f.y,f.y);}else{vImpUv1=keImpFrameUv(c+vec2(0.,1.),keP);vImpW=vec3(1.-f.y,f.y-f.x,f.x);}}
`;
const IMP_FS_ALBEDO=`
vec4 keA0=texture2D(keImpAlbedo,vImpUv0),keA1=texture2D(keImpAlbedo,vImpUv1),keA2=texture2D(keImpAlbedo,vImpUv2);
float keAlpha=keA0.a*vImpW.x+keA1.a*vImpW.y+keA2.a*vImpW.z;if(keAlpha<.5)discard;
vec3 keRgb=(keA0.rgb*vImpW.x+keA1.rgb*vImpW.y+keA2.rgb*vImpW.z)/max(keAlpha,1e-4);
diffuseColor.rgb*=keImpSRGB>.5?mix(keRgb*.0773993808,pow(keRgb*.9478672986+.0521327014,vec3(2.4)),vec3(greaterThan(keRgb,vec3(.04045)))):keRgb;
`;
const IMP_FS_NORMAL=`
{vec4 keN0=texture2D(keImpNormal,vImpUv0),keN1=texture2D(keImpNormal,vImpUv1),keN2=texture2D(keImpNormal,vImpUv2);
vec3 keN=(keN0.xyz*2.-1.)*keN0.a*vImpW.x+(keN1.xyz*2.-1.)*keN1.a*vImpW.y+(keN2.xyz*2.-1.)*keN2.a*vImpW.z;
normal=normalize(mat3(vImpM0,vImpM1,vImpM2)*normalize(keN+vec3(0.,1e-5,0.)));}
`;
function impostorBasis(THREE,d){const up=Math.abs(d.y)>.999?new THREE.Vector3(0,0,1):new THREE.Vector3(0,1,0);const r=new THREE.Vector3().crossVectors(up,d).normalize();const u=new THREE.Vector3().crossVectors(d,r);return {r,u};}
function impostorDecode(THREE,mode,uv){
  if(mode===2){const a=uv[0]*Math.PI*2;return new THREE.Vector3(Math.sin(a),0,Math.cos(a));}
  const px=uv[0]*2-1,py=uv[1]*2-1;
  if(mode===1){const qx=(px+py)*.5,qz=(px-py)*.5;return new THREE.Vector3(qx,1-Math.abs(qx)-Math.abs(qz),qz).normalize();}
  const d=new THREE.Vector3(px,1-Math.abs(px)-Math.abs(py),py);if(d.y<0){const sx=d.x>=0?1:-1,sz=d.z>=0?1:-1,ox=d.x,oz=d.z;d.x=(1-Math.abs(oz))*sx;d.z=(1-Math.abs(ox))*sz;}return d.normalize();
}
function patchImpostorMaterial(THREE,mat,uniforms,{normals,key}){
  mat.onBeforeCompile=shader=>{Object.assign(shader.uniforms,uniforms);
    let vs=shader.vertexShader,fs=shader.fragmentShader;
    const need=(src,chunk,what)=>{if(!src.includes(chunk))throw new Error('KE.Impostor: shader chunk '+chunk+' not found in '+what);};
    need(vs,'#include <common>','vertex');need(vs,'#include <begin_vertex>','vertex');need(fs,'#include <map_fragment>','fragment');
    vs=vs.replace('#include <common>','#include <common>\n'+IMP_GLSL+(normals?'varying vec3 vImpM0;varying vec3 vImpM1;varying vec3 vImpM2;':'')+IMP_VS_FUN);
    vs=vs.replace('#include <begin_vertex>',IMP_VS_MAIN+(normals?`{mat3 keNm=normalMatrix;
      #ifdef USE_INSTANCING
      keNm=normalMatrix*mat3(instanceMatrix);
      #endif
      vImpM0=keNm[0];vImpM1=keNm[1];vImpM2=keNm[2];}`:''));
    if(normals&&vs.includes('#include <beginnormal_vertex>'))vs=vs.replace('#include <beginnormal_vertex>','vec3 objectNormal=keImpViewDir();\n#ifdef USE_TANGENT\nvec3 objectTangent=vec3(1.,0.,0.);\n#endif');
    fs=fs.replace('#include <common>','#include <common>\n'+IMP_GLSL+'uniform float keImpSRGB;'+(normals?'varying vec3 vImpM0;varying vec3 vImpM1;varying vec3 vImpM2;':''));
    fs=fs.replace('#include <map_fragment>',IMP_FS_ALBEDO);
    if(normals){need(fs,'#include <normal_fragment_maps>','fragment');fs=fs.replace('#include <normal_fragment_maps>',IMP_FS_NORMAL);}
    shader.vertexShader=vs;shader.fragmentShader=fs;};
  mat.customProgramCacheKey=()=>'keImpostor|'+key;return mat;
}
KE.Impostor={
  /* Bake an impostor of object3D (baked in its local space; its transform is restored afterwards). */
  bake(THREE,renderer,object3D,o={}){
    if(!renderer||!renderer.capabilities||!renderer.capabilities.isWebGL2)throw new Error('KE.Impostor.bake needs a WebGL2 renderer');
    const modeName=o.mode==='billboard'?'billboard':'octahedral',mode=modeName==='billboard'?2:(o.hemisphere===false?0:1);
    const size=pow2(clamp(o.size||1024,64,4096)),N=modeName==='billboard'?clamp(o.frames||8,2,64)|0:clamp(o.frames||8,2,32)|0,lit=o.lit!==false;
    const cols=mode===2?Math.ceil(Math.sqrt(N)):N,rows=mode===2?Math.ceil(N/cols):N,pad=o.padding??1.06;
    /* detach and bake in local space */
    const parent=object3D.parent,index=parent?parent.children.indexOf(object3D):-1,pos=object3D.position.clone(),quat=object3D.quaternion.clone(),scl=object3D.scale.clone();
    if(parent)parent.remove(object3D);object3D.position.set(0,0,0);object3D.quaternion.identity();object3D.scale.set(1,1,1);object3D.updateMatrixWorld(true);
    const scene=new THREE.Scene();scene.add(object3D);
    /* exact bounds from transformed vertices (instances included) */
    const box=new THREE.Box3(),v=new THREE.Vector3(),im=new THREE.Matrix4(),wm=new THREE.Matrix4(),pts=[];
    object3D.traverse(m=>{if(!m.isMesh||!m.geometry||!m.geometry.getAttribute('position'))return;const p=m.geometry.getAttribute('position'),n=m.isInstancedMesh?m.count:1;
      for(let k=0;k<n;k++){wm.copy(m.matrixWorld);if(m.isInstancedMesh){m.getMatrixAt(k,im);wm.multiply(im);}const step=Math.max(1,Math.floor(p.count/20000));for(let i=0;i<p.count;i+=step){v.fromBufferAttribute(p,i).applyMatrix4(wm);box.expandByPoint(v);pts.push(v.x,v.y,v.z);}}});
    if(box.isEmpty())throw new Error('KE.Impostor.bake: object has no mesh geometry');
    const center=box.getCenter(new THREE.Vector3());let r2=0;for(let i=0;i<pts.length;i+=3){const d=(pts[i]-center.x)**2+(pts[i+1]-center.y)**2+(pts[i+2]-center.z)**2;if(d>r2)r2=d;}
    const radius=Math.sqrt(r2)*1.001||1,R=radius*pad;
    /* render targets */
    const rtOpts={minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter,format:THREE.RGBAFormat,type:THREE.UnsignedByteType,depthBuffer:true,generateMipmaps:false};
    const W=mode===2?size:size,H=mode===2?Math.max(64,pow2(Math.ceil(size*rows/cols))):size;
    const albedoRT=new THREE.WebGLRenderTarget(W,H,{...rtOpts,encoding:THREE.sRGBEncoding}),normalRT=lit?new THREE.WebGLRenderTarget(W,H,{...rtOpts}):null;
    albedoRT.texture.generateMipmaps=false;if(normalRT)normalRT.texture.generateMipmaps=false;
    /* bake materials */
    const origMats=new Map(),albedoMats=new Map(),normalMats=new Map();const disposeLater=[];
    const normalMat=src=>{const m=new THREE.ShaderMaterial({uniforms:{map:{value:src&&src.map||null},alphaTest:{value:src&&src.alphaTest||0},useMap:{value:src&&src.map&&src.alphaTest>0?1:0}},side:src?src.side:THREE.FrontSide,
      vertexShader:`varying vec3 vN;varying vec2 vUv;
#include <common>
#include <skinning_pars_vertex>
void main(){
#include <beginnormal_vertex>
#include <skinbase_vertex>
#include <skinnormal_vertex>
vec3 n=objectNormal;
#ifdef USE_INSTANCING
n=mat3(instanceMatrix)*n;
#endif
vN=normalize(mat3(modelMatrix)*n);vUv=uv;
#include <begin_vertex>
#include <skinning_vertex>
#include <project_vertex>
}`,fragmentShader:`varying vec3 vN;varying vec2 vUv;uniform sampler2D map;uniform float alphaTest;uniform float useMap;
void main(){if(useMap>.5&&texture2D(map,vUv).a<alphaTest)discard;vec3 n=normalize(vN)*(gl_FrontFacing?1.:-1.);gl_FragColor=vec4(n*.5+.5,1.);}`});
      if(src&&src.skinning)m.skinning=true;disposeLater.push(m);return m;};
    const albedoMat=src=>{if(!lit)return src;const m=new THREE.MeshBasicMaterial({color:src&&src.color?src.color.clone():0xffffff,map:src&&src.map||null,vertexColors:!!(src&&src.vertexColors),alphaTest:src&&src.alphaTest||0,side:src?src.side:THREE.FrontSide,skinning:!!(src&&src.skinning),toneMapped:false});disposeLater.push(m);return m;};
    object3D.traverse(m=>{if(!m.isMesh)return;origMats.set(m,m.material);const one=x=>x;const map=(f,cache)=>Array.isArray(m.material)?m.material.map(x=>cache.get(x)||cache.set(x,f(x)).get(x)):(cache.get(m.material)||cache.set(m.material,f(m.material)).get(m.material));
      albedoMats.set(m,map(albedoMat,new Map()));if(lit)normalMats.set(m,map(normalMat,new Map()));one();});
    const rig=[];if(!lit){const h=new THREE.HemisphereLight(0xffffff,0x6b6258,.9),d=new THREE.DirectionalLight(0xffffff,1.6);d.position.set(.4,1,.3);rig.push(h,d);scene.add(h,d);}
    /* renderer state */
    const prev={target:renderer.getRenderTarget(),autoClear:renderer.autoClear,tone:renderer.toneMapping,clear:renderer.getClearColor(new THREE.Color()),alpha:renderer.getClearAlpha(),smAuto:renderer.shadowMap.autoUpdate,xr:renderer.xr&&renderer.xr.enabled};
    const cam=new THREE.OrthographicCamera(-R,R,R,-R,R*.01,R*4);cam.matrixAutoUpdate=false;
    const fw=W/cols,fh=H/rows,frameDir=(i,j)=>mode===2?impostorDecode(THREE,2,[(j*cols+i)/N,0]):impostorDecode(THREE,mode,[i/(N-1),j/(N-1)]);
    const renderAll=(rt,mats,clearColor,clearAlpha)=>{
      object3D.traverse(m=>{if(mats.has(m))m.material=mats.get(m);});
      rt.scissorTest=false;rt.viewport.set(0,0,W,H);renderer.setRenderTarget(rt);renderer.setClearColor(clearColor,clearAlpha);renderer.clear(true,true,true);
      for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){if(mode===2&&j*cols+i>=N)continue;const d=frameDir(i,j),{r,u}=impostorBasis(THREE,d);
        cam.matrix.makeBasis(r,u,d).setPosition(center.x+d.x*R*2,center.y+d.y*R*2,center.z+d.z*R*2);cam.updateMatrixWorld(true);
        rt.viewport.set(i*fw,j*fh,fw,fh);rt.scissor.set(i*fw,j*fh,fw,fh);rt.scissorTest=true;renderer.setRenderTarget(rt);renderer.clear(true,true,true);renderer.render(scene,cam);}
      rt.scissorTest=false;rt.viewport.set(0,0,W,H);rt.texture.generateMipmaps=true;renderer.setRenderTarget(rt);renderer.render(new THREE.Scene(),cam);/* triggers mip generation */};
    try{
      renderer.autoClear=false;renderer.toneMapping=THREE.NoToneMapping;renderer.shadowMap.autoUpdate=false;if(renderer.xr)renderer.xr.enabled=false;
      renderAll(albedoRT,albedoMats,0x000000,0);
      if(lit)renderAll(normalRT,normalMats,0x8080ff,0);
    }finally{
      object3D.traverse(m=>{if(origMats.has(m))m.material=origMats.get(m);});for(const l of rig)scene.remove(l);scene.remove(object3D);
      object3D.position.copy(pos);object3D.quaternion.copy(quat);object3D.scale.copy(scl);if(parent){parent.add(object3D);parent.children.splice(parent.children.length-1,1);parent.children.splice(index,0,object3D);}object3D.updateMatrixWorld(true);
      renderer.setRenderTarget(prev.target);renderer.autoClear=prev.autoClear;renderer.toneMapping=prev.tone;renderer.setClearColor(prev.clear,prev.alpha);renderer.shadowMap.autoUpdate=prev.smAuto;if(renderer.xr)renderer.xr.enabled=prev.xr;
      for(const m of disposeLater)m.dispose();
    }
    /* runtime material, depth material and quad */
    const uniforms={keImpAlbedo:{value:albedoRT.texture},keImpNormal:{value:normalRT?normalRT.texture:albedoRT.texture},keImpInfo:{value:new THREE.Vector4(N,cols,rows,mode)},keImpSphere:{value:new THREE.Vector4(center.x,center.y,center.z,R)},keImpSRGB:{value:1}};
    const material=patchImpostorMaterial(THREE,lit?new THREE.MeshStandardMaterial({roughness:o.roughness??.85,metalness:o.metalness??0,side:THREE.DoubleSide}):new THREE.MeshBasicMaterial({side:THREE.DoubleSide}),uniforms,{normals:lit,key:(lit?'lit':'unlit')});
    material.name='ke-impostor';
    const depthMaterial=patchImpostorMaterial(THREE,new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,side:THREE.DoubleSide}),uniforms,{normals:false,key:'depth'});
    const geometry=new THREE.PlaneGeometry(2,2);geometry.boundingSphere=new THREE.Sphere(center.clone(),R*1.5);geometry.boundingBox=new THREE.Box3().setFromCenterAndSize(center,new THREE.Vector3(R*3,R*3,R*3));
    const imp={isKEImpostor:true,texture:albedoRT.texture,normalTexture:normalRT?normalRT.texture:null,albedoTarget:albedoRT,normalTarget:normalRT,material,depthMaterial,geometry,radius,center,frames:N,mode:modeName,hemisphere:mode===1,size,frameResolution:Math.floor(Math.min(fw,fh)),
      createMesh(){const m=new THREE.Mesh(geometry,material);m.customDepthMaterial=depthMaterial;m.name='ke-impostor';return m;},
      createInstancedMesh(count){const m=new THREE.InstancedMesh(geometry,material,count);m.customDepthMaterial=depthMaterial;m.frustumCulled=false;m.name='ke-impostor-instances';return m;},
      /* Fraction of atlas texels with alpha > 0 (reads back the albedo atlas; slow, for tests/tools). */
      coverage(r){const buf=new Uint8Array(W*H*4);r.readRenderTargetPixels(albedoRT,0,0,W,H,buf);let c=0;for(let i=3;i<buf.length;i+=4)if(buf[i]>0)c++;return c/(W*H);},
      dispose(){albedoRT.dispose();if(normalRT)normalRT.dispose();material.dispose();depthMaterial.dispose();geometry.dispose();}};
    return imp;
  }
};

/* ---------- procedural rock ---------- */
/* Geodesic sphere (icosahedron faces subdivided at frequency n = round(1.125 * 2^detail), 20 n^2 triangles,
   shared vertices via canonical edge points), displaced by seeded ridged fbm, cut by random planes for
   faceted cliffs, flattened at the base. Adds smooth normals, a seamless planar uv and cavity-tinted colours. */
function makeNoise(seed){
  const rnd=KE.random(seed),perm=new Uint8Array(512),p=Array.from({length:256},(_,i)=>i);for(let i=255;i>0;i--){const j=Math.floor(rnd()*(i+1));[p[i],p[j]]=[p[j],p[i]];}for(let i=0;i<512;i++)perm[i]=p[i&255];
  const G=[[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
  const fade=t=>t*t*t*(t*(t*6-15)+10),grad=(h,x,y,z)=>{const g=G[h%12];return g[0]*x+g[1]*y+g[2]*z;};
  return (x,y,z)=>{const X=Math.floor(x),Y=Math.floor(y),Z=Math.floor(z);x-=X;y-=Y;z-=Z;const xi=X&255,yi=Y&255,zi=Z&255,u=fade(x),v=fade(y),w=fade(z);
    const A=perm[xi]+yi,AA=perm[A]+zi,AB=perm[A+1]+zi,B=perm[xi+1]+yi,BA=perm[B]+zi,BB=perm[B+1]+zi,L=(a,b,t)=>a+(b-a)*t;
    return L(L(L(grad(perm[AA],x,y,z),grad(perm[BA],x-1,y,z),u),L(grad(perm[AB],x,y-1,z),grad(perm[BB],x-1,y-1,z),u),v),L(L(grad(perm[AA+1],x,y,z-1),grad(perm[BA+1],x-1,y,z-1),u),L(grad(perm[AB+1],x,y-1,z-1),grad(perm[BB+1],x-1,y-1,z-1),u),v),w);};
}
KE.proceduralRock=(THREE,o={})=>{
  const detail=clamp(o.detail??6,0,8),seed=o.seed??1,radius=o.radius??1,rough=o.roughness??.35,n=o.frequency?Math.max(1,o.frequency|0):Math.max(1,Math.round(1.125*Math.pow(2,detail)));
  const t=(1+Math.sqrt(5))/2,IV=[[-1,t,0],[1,t,0],[-1,-t,0],[1,-t,0],[0,-1,t],[0,1,t],[0,-1,-t],[0,1,-t],[t,0,-1],[t,0,1],[-t,0,-1],[-t,0,1]].map(v=>{const l=Math.hypot(...v);return v.map(x=>x/l);});
  const IF=[0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1];
  const V=20*n*n/2+2+64,pos=new Float32Array(Math.ceil(V)*3+n*120);let nv=0;const put=(x,y,z)=>{const l=Math.hypot(x,y,z);pos[nv*3]=x/l;pos[nv*3+1]=y/l;pos[nv*3+2]=z/l;return nv++;};
  for(const v of IV)put(...v);
  const edges=new Map(),edge=(a,b,k)=>{/* k-th point from a to b, 1..n-1 */const lo=Math.min(a,b),hi=Math.max(a,b),key=lo*12+hi;let base=edges.get(key);
    if(base===undefined){base=nv;edges.set(key,base);for(let s=1;s<n;s++){const f=s/n;put(IV[lo][0]+(IV[hi][0]-IV[lo][0])*f,IV[lo][1]+(IV[hi][1]-IV[lo][1])*f,IV[lo][2]+(IV[hi][2]-IV[lo][2])*f);}}
    return base+(a===lo?k:n-k)-1;};
  const idx=new Uint32Array(20*n*n*3);let io=0;
  for(let f=0;f<20;f++){const a=IF[f*3],b=IF[f*3+1],c=IF[f*3+2],grid=[];
    for(let j=0;j<=n;j++){grid[j]=[];for(let i=0;i<=n-j;i++){let id;
      if(i===0&&j===0)id=a;else if(i===n)id=b;else if(j===n)id=c;else if(j===0)id=edge(a,b,i);else if(i===0)id=edge(a,c,j);else if(i+j===n)id=edge(b,c,j);
      else{const w=n-i-j;id=put((IV[a][0]*w+IV[b][0]*i+IV[c][0]*j)/n,(IV[a][1]*w+IV[b][1]*i+IV[c][1]*j)/n,(IV[a][2]*w+IV[b][2]*i+IV[c][2]*j)/n);}grid[j][i]=id;}}
    for(let j=0;j<n;j++)for(let i=0;i<n-j;i++){idx[io++]=grid[j][i];idx[io++]=grid[j][i+1];idx[io++]=grid[j+1][i];
      if(i+j<n-1){idx[io++]=grid[j][i+1];idx[io++]=grid[j+1][i+1];idx[io++]=grid[j+1][i];}}}
  /* displacement */
  const noise=makeNoise(seed),rnd=KE.random(seed*7919+13),planes=[],np=o.facets??7;
  for(let k=0;k<np;k++){const u=rnd()*2-1,a=rnd()*Math.PI*2,s=Math.sqrt(1-u*u);planes.push([s*Math.cos(a),u*.75,s*Math.sin(a),.62+rnd()*.25]);}
  const flat=o.flatten??.3,stretch=[.85+rnd()*.35,.7+rnd()*.2,.85+rnd()*.35],cav=new Float32Array(nv),P=new Float32Array(nv*3);
  for(let v=0;v<nv;v++){let x=pos[v*3],y=pos[v*3+1],z=pos[v*3+2];
    let f=0,amp=1,fr=1.3,sum=0;for(let oc=0;oc<7;oc++){const r=1-Math.abs(noise(x*fr+11.3*oc,y*fr+3.1,z*fr-7.7*oc));f+=r*r*amp;sum+=amp;amp*=.5;fr*=2.07;}f=f/sum;
    const blob=noise(x*.9+5,y*.9,z*.9-2)*.35,d=1+rough*(f-.5)*1.6+blob*rough;x*=d*stretch[0];y*=d*stretch[1];z*=d*stretch[2];
    for(const p of planes){const s=x*p[0]+y*p[1]+z*p[2]-p[3];if(s>0){x-=p[0]*s*.9;y-=p[1]*s*.9;z-=p[2]*s*.9;}}
    const fl=-(1-flat);if(y<fl){y=fl+(y-fl)*.15;}
    const det=noise(x*9.1,y*9.1,z*9.1)*.012*rough/.35;const l=Math.hypot(x,y,z)||1;x+=x/l*det;y+=y/l*det;z+=z/l*det;
    P[v*3]=x*radius;P[v*3+1]=y*radius;P[v*3+2]=z*radius;cav[v]=f;}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(P,3));g.setIndex(new THREE.BufferAttribute(nv<65535?Uint16Array.from(idx.subarray(0,io)):idx.subarray(0,io),1));g.computeVertexNormals();
  if(o.uv!==false){const uv=new Float32Array(nv*2);for(let v=0;v<nv;v++){uv[v*2]=(P[v*3]+P[v*3+2]*.6)/radius*.5;uv[v*2+1]=(P[v*3+1]+P[v*3+2]*.3)/radius*.5;}g.setAttribute('uv',new THREE.BufferAttribute(uv,2));}
  if(o.colors!==false){const base=new THREE.Color(o.color??0x8b8378).convertSRGBToLinear(),moss=new THREE.Color(o.moss??0x5f6b3a).convertSRGBToLinear(),col=new Float32Array(nv*3),nrm=g.getAttribute('normal').array;
    for(let v=0;v<nv;v++){const tint=.78+.3*cav[v]+.08*noise(P[v*3]*3/radius,P[v*3+1]*3/radius,P[v*3+2]*3/radius),m=clamp((nrm[v*3+1]-.55)*2.2,0,1)*(o.moss===false?0:.55);
      col[v*3]=(base.r+(moss.r-base.r)*m)*tint;col[v*3+1]=(base.g+(moss.g-base.g)*m)*tint;col[v*3+2]=(base.b+(moss.b-base.b)*m)*tint;}g.setAttribute('color',new THREE.BufferAttribute(col,3));}
  g.computeBoundingBox();g.computeBoundingSphere();g.userData.rock={detail,frequency:n,seed,triangles:io/3};return g;
};

/* ---------- stats ---------- */
KE.meshStats=root=>{const s={objects:0,meshes:0,instancedMeshes:0,instances:0,drawCalls:0,triangles:0,vertices:0,shadowProxyDraws:0};
  if(!root)return s;root.traverseVisible(o=>{s.objects++;if(!(o.isMesh||o.isPoints||o.isLine))return;const g=o.geometry;if(!g)return;
    if(o.material&&o.material.name==='ke-shadow-only'){if(!o.isInstancedMesh||o.count>0)s.shadowProxyDraws++;return;}
    const inst=o.isInstancedMesh?o.count:1;if(o.isInstancedMesh){s.instancedMeshes++;s.instances+=inst;}else s.meshes++;if(!inst)return;
    const groups=Array.isArray(o.material)?Math.max(1,g.groups.length):1;s.drawCalls+=groups;const tri=o.isMesh?triCount(g):0;s.triangles+=tri*inst;s.vertices+=(g.getAttribute('position')?g.getAttribute('position').count:0);});
  return s;};

KE.cvars&&KE.cvars.register('r.Geometry.PixelError',{value:1,type:'number',min:.25,max:16,help:'Default pixel error for new VirtualGeometry objects'});
KE.registerModule('geometry',{provides:['geometryReady','simplify','buildLODs','screenError','LODMesh','InstancedLOD','Impostor','VirtualGeometry','proceduralRock','meshStats']});
})();
