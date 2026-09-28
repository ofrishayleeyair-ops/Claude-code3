/* kitsune enginev3 · 32-world — open worlds.
   KE.Heightfield: seeded landscape generation (domain-warped, derivative-damped fbm + ridged multifractal),
   particle hydraulic erosion (Hans Beyer droplets), thermal erosion, image import, biome splat weights.
   KE.GPUTerrain: CDLOD terrain (Strugar 2010): CPU quadtree selection with min/max height boxes, vertex
   geomorphing between levels, every selected patch drawn by ONE instanced draw call that displaces a shared
   grid from a height texture. CPU heightAt/normalAt/raycast/sculpt agree with what the GPU draws.
   KE.WorldPartition: cell streaming with nearest-first time-sliced loads, hysteresis unloads, cancellation and
   HLOD proxies. KE.scatterCell: deterministic per-cell instanced scatter that follows a heightfield. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const isThree=v=>!!(v&&typeof v==='object'&&typeof v.REVISION==='string'&&v.Vector3);
const hashInts=(a,b,c)=>{let h=Math.imul((a|0)^0x9e3779b9,0x85ebca6b)^Math.imul((b|0)+0x632be5ab,0xc2b2ae35)^Math.imul((c|0)+0x27d4eb2f,0x165667b1);h^=h>>>15;h=Math.imul(h,0x2c1b3c6d);h^=h>>>12;h=Math.imul(h,0x297a2d39);h^=h>>>15;return h>>>0;};

/* ---------- seeded gradient noise with analytic derivatives ----------
   Classic 2D Perlin gradient noise with a quintic fade. Returns about [-1,1]; the gradient of the last
   evaluation is left in ND[0..1] (used by the derivative-damped "eroded" fbm). One shared, monomorphic
   function reads per-seed tables, which keeps the hot loop inlinable (a 1024^2 bake is ~30M evaluations). */
function makeNoise(seed){
  const rnd=KE.random((seed>>>0)||1),p=new Uint8Array(256),perm=new Uint16Array(512),gx=new Float64Array(256),gy=new Float64Array(256);
  for(let i=0;i<256;i++)p[i]=i;
  for(let i=255;i>0;i--){const j=Math.floor(rnd()*(i+1)),t=p[i];p[i]=p[j];p[j]=t;}
  for(let i=0;i<512;i++)perm[i]=p[i&255];
  for(let i=0;i<256;i++){const a=rnd()*Math.PI*2;gx[i]=Math.cos(a)*1.4142;gy[i]=Math.sin(a)*1.4142;}
  return {perm,gx,gy};
}
const ND=new Float64Array(2);
function noise2(N,x,y){
  const perm=N.perm,G=N.gx,H=N.gy,fx=Math.floor(x),fy=Math.floor(y),u=x-fx,v=y-fy,X=fx&255,Y=fy&255,A=perm[X]+Y,B=perm[X+1]+Y;
  const a=perm[A],c=perm[A+1],b=perm[B],d=perm[B+1];
  const gax=G[a],gay=H[a],gbx=G[b],gby=H[b],gcx=G[c],gcy=H[c],gdx=G[d],gdy=H[d];
  const va=gax*u+gay*v,vb=gbx*(u-1)+gby*v,vc=gcx*u+gcy*(v-1),vd=gdx*(u-1)+gdy*(v-1);
  const su=u*u*u*(u*(u*6-15)+10),sv=v*v*v*(v*(v*6-15)+10),dsu=30*u*u*(u*(u-2)+1),dsv=30*v*v*(v*(v-2)+1);
  const k1=vb-va,k2=vc-va,k3=va-vb-vc+vd;
  ND[0]=gax+(gbx-gax)*su+(gcx-gax)*sv+(gax-gbx-gcx+gdx)*su*sv+dsu*(k1+k3*sv);
  ND[1]=gay+(gby-gay)*su+(gcy-gay)*sv+(gay-gby-gcy+gdy)*su*sv+dsv*(k2+k3*su);
  return va+k1*su+k2*sv+k3*su*sv;
}
/* Octaves are rotated ~37 degrees and doubled (matrix [1.6 -1.2; 1.2 1.6]) so lattice axes never line up. */
function fbm(N,x,y,octaves){let s=0,a=1,n=0;for(let o=0;o<octaves;o++){s+=a*noise2(N,x,y);n+=a;a*=.5;const nx=1.6*x-1.2*y+17.3,ny=1.2*x+1.6*y-9.1;x=nx;y=ny;}return s/n;}
/* Derivative-damped fbm (after Inigo Quilez): octaves are suppressed where the accumulated slope is steep,
   which reads like eroded, flat-floored valleys with sharp detail only on gentle ground. */
function erodedFbm(N,x,y,octaves,damping){let s=0,a=1,n=0,dx=0,dy=0;
  for(let o=0;o<octaves;o++){const v=noise2(N,x,y);dx+=ND[0];dy+=ND[1];s+=a*v/(1+damping*(dx*dx+dy*dy));n+=a;a*=.5;const nx=1.6*x-1.2*y+31.7,ny=1.2*x+1.6*y+4.3;x=nx;y=ny;}
  return s/n;}
/* Ridged multifractal (Musgrave): sharp crest lines; each octave is weighted by the previous signal so
   detail concentrates on the ridges. Returns [0,1]. */
function ridgedFbm(N,x,y,octaves){let s=0,a=1,n=0,w=1;
  for(let o=0;o<octaves;o++){let v=1-Math.abs(noise2(N,x,y));v*=v;v*=w;w=clamp(v*1.8,0,1);s+=v*a;n+=a;a*=.5;const nx=1.6*x-1.2*y-7.9,ny=1.2*x+1.6*y+13.1;x=nx;y=ny;}
  return s/n*1.6;}

/* World-space landscape function. Everything is a function of world (x,z) so neighbouring streamed cells or
   differently sized bakes of the same seed line up. Components (normalised to about [-1,1] / [0,1]):
   a warped continental fbm decides lowland vs. mountain country and where the coast lies, derivative-damped
   fbm gives rolling eroded hills, ridged multifractal gives crest lines; `ridged` blends hills->ridges inside
   the mountain mask. Returns world height: baseHeight + amplitude * (shape - seaLevel). */
function terrainFunction(o={}){
  const seed=(o.seed===undefined?1:o.seed)>>>0,worldSize=o.worldSize||2048,octaves=clamp(Math.round(o.octaves||7),1,12);
  const amplitude=o.amplitude===undefined?180:o.amplitude,base=o.baseHeight||0,ridged=clamp(o.ridged===undefined?.5:o.ridged,0,1),warp=Math.max(0,o.warp===undefined?.35:o.warp);
  const scale=o.scale||worldSize*.5,inv=1/scale,cx=o.centerX||0,cz=o.centerZ||0,sea=o.seaLevel===undefined?.1:o.seaLevel,damp=o.damping===undefined?1.2:o.damping;
  const mountains=clamp(o.mountains===undefined?.5:o.mountains,0,1),islands=!!o.islands,falloff=o.falloff,hillsAmt=o.hills===undefined?.16:o.hills;
  const nW1=makeNoise(seed*7+1),nW2=makeNoise(seed*7+2),nC=makeNoise(seed*7+3),nH=makeNoise(seed*7+4),nR=makeNoise(seed*7+5),nD=makeNoise(seed*7+6);
  const ox=(hashInts(seed,1,0)%1000)*.37,oz=(hashInts(seed,2,0)%1000)*.37,half=worldSize/2,mlo=.55-mountains*.9;
  return (x,z)=>{
    let px=x*inv+ox,pz=z*inv+oz;
    if(warp>0){const wx=fbm(nW1,px*.8+3.1,pz*.8-1.7,4),wz=fbm(nW2,px*.8-5.3,pz*.8+2.9,4);px+=warp*wx;pz+=warp*wz;}
    const C=fbm(nC,px*.55+11.3,pz*.55-4.2,5)/.42;                  // continental shape, ~[-1,1]
    const mask=smooth(mlo,mlo+.75,C+fbm(nD,px*1.7-3,pz*1.7+8,3)*.35); // mountain country
    const H=erodedFbm(nH,px*1.6,pz*1.6,octaves,damp)/.24;         // eroded hills, ~[-1,1]
    const R=ridgedFbm(nR,px*1.35+2.2,pz*1.35-8.4,octaves)/1.4;    // ridges, ~[0,1]
    const rough=clamp((H*.5+.5)*(1-ridged)+R*ridged,0,1.2);
    let v=.13+.14*C+hillsAmt*H*(.35+.65*(1-mask))+mask*(Math.pow(rough,1.7)*.95+.04);
    if(islands||falloff){
      let m=1;
      if(typeof falloff==='function')m=clamp(+falloff(x,z)||0,0,1);
      else{const edge=typeof falloff==='number'?clamp(falloff,.02,.95):.42,r=Math.hypot(x-cx,z-cz)/half+fbm(nD,px*.8+40,pz*.8-40,3)*.22;m=1-smooth(1-edge,1.02,r);}
      v=v*m-(1-m)*.2;
    }
    return base+amplitude*(v-sea);
  };
}

/* ---------- Heightfield ----------
   size x size samples covering worldSize x worldSize world units, row-major with z rows: data[j*size+i] is
   the height at (originX+i*spacing, originZ+j*spacing), spacing = worldSize/(size-1). Default origin centres
   the field on (0,0). heightAt is bilinear and clamps outside the field (the GPU terrain samples identically). */
class Heightfield{
  constructor({data=null,size,worldSize,originX,originZ}={}){
    if(!Number.isInteger(size)||size<2||size>8192)throw new RangeError('Heightfield size must be an integer in [2,8192]');
    if(!(worldSize>0))throw new RangeError('Heightfield worldSize must be positive');
    this.size=size;this.worldSize=worldSize;this.originX=originX===undefined?-worldSize/2:originX;this.originZ=originZ===undefined?-worldSize/2:originZ;
    this.spacing=worldSize/(size-1);this.invSpacing=1/this.spacing;
    this.data=data||new Float32Array(size*size);if(this.data.length!==size*size)throw new RangeError('Heightfield data length must be size*size');
    this.masks=null;this.version=0;this.recomputeRange();
  }
  recomputeRange(){let lo=Infinity,hi=-Infinity;const d=this.data;for(let i=0;i<d.length;i++){const v=d[i];if(v<lo)lo=v;if(v>hi)hi=v;}this.minHeight=lo;this.maxHeight=hi;return this;}
  get maxX(){return this.originX+this.worldSize;}
  get maxZ(){return this.originZ+this.worldSize;}
  sample(i,j){const s=this.size;i=i<0?0:i>=s?s-1:i;j=j<0?0:j>=s?s-1:j;return this.data[j*s+i];}
  heightAt(x,z){
    const s=this.size,d=this.data,m=s-1;let tx=(x-this.originX)*this.invSpacing,tz=(z-this.originZ)*this.invSpacing;
    tx=tx<0?0:tx>m?m:tx;tz=tz<0?0:tz>m?m:tz;let i=Math.floor(tx),j=Math.floor(tz);if(i>s-2)i=s-2;if(j>s-2)j=s-2;
    const fx=tx-i,fz=tz-j,k=j*s+i,a=d[k],b=d[k+1],c=d[k+s],e=d[k+s+1];
    return (a+(b-a)*fx)+((c+(e-c)*fx)-(a+(b-a)*fx))*fz;
  }
  /* Gradient (dh/dx, dh/dz) from grid central differences, bilinearly interpolated between samples, so it
     varies smoothly and matches the linearly filtered GPU normal map. */
  gradientAt(x,z,out={x:0,z:0}){
    const s=this.size,m=s-1;let tx=(x-this.originX)*this.invSpacing,tz=(z-this.originZ)*this.invSpacing;
    tx=tx<0?0:tx>m?m:tx;tz=tz<0?0:tz>m?m:tz;let i=Math.floor(tx),j=Math.floor(tz);if(i>s-2)i=s-2;if(j>s-2)j=s-2;const fx=tx-i,fz=tz-j;
    let gx=0,gz=0;for(let q=0;q<4;q++){const ii=i+(q&1),jj=j+(q>>1),w=((q&1)?fx:1-fx)*((q>>1)?fz:1-fz);gx+=w*this._gx(ii,jj);gz+=w*this._gz(ii,jj);}
    out.x=gx;out.z=gz;return out;
  }
  _gx(i,j){const s=this.size,d=this.data,a=i>0?i-1:0,b=i<s-1?i+1:s-1;return (d[j*s+b]-d[j*s+a])/((b-a)*this.spacing);}
  _gz(i,j){const s=this.size,d=this.data,a=j>0?j-1:0,b=j<s-1?j+1:s-1;return (d[b*s+i]-d[a*s+i])/((b-a)*this.spacing);}
  normalAt(x,z,out){const g=this.gradientAt(x,z,_grad),l=Math.hypot(g.x,1,g.z);out=out||{x:0,y:0,z:0};out.x=-g.x/l;out.y=1/l;out.z=-g.z/l;return out;}
  /** Slope as rise over run, |grad h| (0 flat, 1 = 45 degrees). */
  slopeAt(x,z){const g=this.gradientAt(x,z,_grad);return Math.hypot(g.x,g.z);}
  contains(x,z){return x>=this.originX&&x<=this.maxX&&z>=this.originZ&&z<=this.maxZ;}
  clone(){const h=new Heightfield({data:new Float32Array(this.data),size:this.size,worldSize:this.worldSize,originX:this.originX,originZ:this.originZ});if(this.masks)h.masks={flow:this.masks.flow&&new Float32Array(this.masks.flow),delta:this.masks.delta&&new Float32Array(this.masks.delta)};return h;}
  /** Volume above minHeight reference (sum of heights * cell area); used for conservation checks. */
  volume(){let s=0;const d=this.data;for(let i=0;i<d.length;i++)s+=d[i];return s*this.spacing*this.spacing;}
  /* GPU texture of the raw samples. format: 'float' (R32F, exact), 'half' (R16F), 'rgba8' (24-bit fixed point
     packed in RGB between min/max; for WebGL1 without float textures) or 'auto'. Nearest filtered: the
     terrain shader does its own bilinear filtering with 4 texel fetches so results match heightAt(). */
  toTexture(THREE,{format='auto',renderer=null}={}){
    if(format==='auto')format=renderer&&!renderer.capabilities.isWebGL2&&!(renderer.extensions&&renderer.extensions.has('OES_texture_float'))?'rgba8':'float';
    const s=this.size;let tex;const info={format,min:this.minHeight,range:Math.max(1e-6,this.maxHeight-this.minHeight)};
    if(format==='float')tex=new THREE.DataTexture(this.data,s,s,THREE.RedFormat,THREE.FloatType);
    else if(format==='half'){const h=new Uint16Array(s*s);for(let i=0;i<h.length;i++)h[i]=toHalf(this.data[i]);tex=new THREE.DataTexture(h,s,s,THREE.RedFormat,THREE.HalfFloatType);}
    else if(format==='rgba8'){const b=new Uint8Array(s*s*4);packRGBA8(this.data,b,info,0,0,s,s,s);tex=new THREE.DataTexture(b,s,s,THREE.RGBAFormat,THREE.UnsignedByteType);}
    else throw new RangeError('Unknown heightfield texture format '+format);
    tex.minFilter=tex.magFilter=THREE.NearestFilter;tex.generateMipmaps=false;tex.flipY=false;tex.wrapS=tex.wrapT=THREE.ClampToEdgeWrapping;tex.unpackAlignment=1;tex.needsUpdate=true;
    tex.userData=tex.userData||{};tex.userData.keHeightfield=info;tex.name='ke-heightfield';return tex;
  }
}
const _grad={x:0,z:0};
const _f32=new Float32Array(1),_u32=new Uint32Array(_f32.buffer);
function toHalf(v){_f32[0]=v;const x=_u32[0],sign=(x>>>16)&0x8000,e=((x>>>23)&0xff)-112,m=x&0x7fffff;if(e<=0)return sign;if(e>=31)return sign|0x7c00;return sign|(e<<10)|((m+0x1000)>>>13);}
function packRGBA8(src,dst,info,i0,j0,i1,j1,s){for(let j=j0;j<j1;j++)for(let i=i0;i<i1;i++){const k=j*s+i,v=Math.round(clamp((src[k]-info.min)/info.range,0,1)*16777215);dst[k*4]=v>>>16;dst[k*4+1]=(v>>>8)&255;dst[k*4+2]=v&255;dst[k*4+3]=255;}}

/* ---------- generation ---------- */
function* generateSteps(o,hf,fn){const s=hf.size,d=hf.data,sp=hf.spacing;
  for(let j=0;j<s;j++){const z=hf.originZ+j*sp,row=j*s;for(let i=0;i<s;i++)d[row+i]=fn(hf.originX+i*sp,z);if((j&7)===7)yield j/s;}
  hf.recomputeRange();hf.version++;return hf;}
Heightfield.terrainFunction=terrainFunction;
/* generate(opts) -> Heightfield (synchronous) or, with opts.jobs (a KE.Jobs queue), a promise resolved when
   the rows have been produced under that queue's frame budget. */
/* Options that can cross into a worker: numbers, booleans, strings and number arrays (functions such as a custom falloff
   keep the work on the main thread). */
const plainOptions=o=>{const out={};for(const [k,v] of Object.entries(o||{})){if(typeof v==='number'||typeof v==='boolean'||typeof v==='string'||(Array.isArray(v)&&v.every(x=>typeof x==='number')))out[k]=v;else if(typeof v==='function'&&k!=='jobs')return null;}return out;};
/* Rows split into bands, one task per band, spread over the pool; the result is identical to the single-threaded bake. */
async function generateParallel(o,hf,pool){const size=hf.size,worldSize=hf.worldSize,sp=hf.spacing,base=plainOptions(o),bands=Math.min(size,pool.size*4),tasks=[];
  const fo={...base,worldSize,centerX:hf.originX+worldSize/2,centerZ:hf.originZ+worldSize/2};
  for(let b=0;b<bands;b++){const j0=Math.floor(b*size/bands),j1=Math.floor((b+1)*size/bands);if(j1>j0)tasks.push(pool.run('rows',{o:fo,j0,j1,size,originX:hf.originX,originZ:hf.originZ,sp}).then(out=>hf.data.set(out,j0*size)));}
  await Promise.all(tasks);hf.recomputeRange();hf.version++;return hf;}
Heightfield.generate=(o={})=>{
  const size=o.size||1024,worldSize=o.worldSize||2048;
  const hf=new Heightfield({size,worldSize,originX:o.originX,originZ:o.originZ});
  if(o.workers&&o.workers.size>0&&plainOptions(o))return generateParallel(o,hf,o.workers);
  const fn=terrainFunction({...o,worldSize,centerX:hf.originX+worldSize/2,centerZ:hf.originZ+worldSize/2}),steps=generateSteps(o,hf,fn);
  if(o.jobs)return o.jobs.add(steps,{name:'heightfield.generate',priority:o.priority||0});
  let r;do r=steps.next();while(!r.done);return hf;
};

/* ---------- hydraulic erosion ----------
   Droplet simulation after Hans Theobald Beyer, "Implementation of a method for hydraulic erosion" (2015),
   in the widely used form popularised by Sebastian Lague. Each droplet follows the bilinear gradient with
   inertia, picks up sediment up to a capacity proportional to speed, water and downhill drop, erodes with a
   radial brush and deposits when over capacity or moving uphill. Heights are normalised by the field's
   height range while simulating so the parameters behave the same for any world scale. Sediment still
   carried when a droplet evaporates is dropped where it dies (only droplets leaving the map lose material).
   Channel networks need roughly one droplet per sample, which is unaffordable at 1024^2, so by default the
   droplets run on a coarser simulation grid (simSize, 385 samples): the resulting height change is
   upsampled bilinearly, corrected so its total volume matches the simulation exactly, and added to the full
   field, which keeps all of its fine detail. `detailIterations` optionally adds a full-resolution pass.
   The field keeps masks.flow (droplet visits per sample) and masks.delta (signed height change). */
function* dropletPass(map,S,o,rnd,flow,iterations,stats){
  const inertia=o.inertia===undefined?.05:o.inertia,capacityF=o.capacity===undefined?4:o.capacity,minCap=o.minCapacity===undefined?.001:o.minCapacity;
  const erodeS=o.erosion===undefined?.3:o.erosion,depositS=o.deposition===undefined?.3:o.deposition,evap=o.evaporation===undefined?.01:o.evaporation;
  const gravity=o.gravity===undefined?4:o.gravity,life=Math.round(o.lifetime||clamp(30*Math.sqrt(S/256),30,90)),radius=Math.max(1,o.radius===undefined?3:o.radius);
  const spawnMin=o._spawnMin;stats.lifetime=life;
  // radial brush: offsets and weights max(0, r - d) normalised; clipped at the borders and renormalised there
  const brush=r=>{const R=Math.ceil(r),bo=[],bw=[];let sum=0;for(let y=-R;y<=R;y++)for(let x=-R;x<=R;x++){const d=Math.hypot(x,y);if(d<r){bo.push(x,y);bw.push(r-d);sum+=r-d;}}return {R,n:bw.length,w:new Float32Array(bw.map(w=>w/sum)),o:new Int32Array(bo)};};
  const eb=brush(radius),db=o.depositRadius===0?null:brush(Math.max(1.01,o.depositRadius===undefined?Math.min(2,radius):o.depositRadius));
  const R=eb.R,BN=eb.n,BW=eb.w,BO=eb.o;
  // deposition: bilinear (as in the reference) or, by default, a small radial brush which avoids single-sample spikes
  const deposit=(nx,ny,cx,cy,amount)=>{if(amount<=0)return;const idx=ny*S+nx;
    if(!db||nx<db.R||ny<db.R||nx>=S-1-db.R||ny>=S-1-db.R){depositAt(map,S,idx,cx,cy,amount);return;}
    for(let b=0;b<db.n;b++)map[idx+db.o[b*2+1]*S+db.o[b*2]]+=amount*db.w[b];};
  const batch=o.batch||2000,dumpEnd=o.conserve!==false;let lost=0,eroded=0;
  for(let it=0;it<iterations;it++){
    let px=rnd()*(S-1),py=rnd()*(S-1),dx=0,dy=0,speed=1,water=1,sediment=0;
    if(spawnMin>-Infinity)for(let tries=0;tries<16&&map[Math.floor(py)*S+Math.floor(px)]<spawnMin;tries++){px=rnd()*(S-1);py=rnd()*(S-1);}
    for(let l=0;l<life;l++){
      const nx=Math.floor(px),ny=Math.floor(py),idx=ny*S+nx,cx=px-nx,cy=py-ny;
      const hNW=map[idx],hNE=map[idx+1],hSW=map[idx+S],hSE=map[idx+S+1];
      const gX=(hNE-hNW)*(1-cy)+(hSE-hSW)*cy,gY=(hSW-hNW)*(1-cx)+(hSE-hNE)*cx;
      const height=hNW*(1-cx)*(1-cy)+hNE*cx*(1-cy)+hSW*(1-cx)*cy+hSE*cx*cy;
      if(flow)flow[idx]+=1;
      dx=dx*inertia-gX*(1-inertia);dy=dy*inertia-gY*(1-inertia);const len=Math.hypot(dx,dy);
      if(len<1e-12){deposit(nx,ny,cx,cy,sediment);sediment=0;break;}
      dx/=len;dy/=len;px+=dx;py+=dy;
      if(px<0||px>=S-1||py<0||py>=S-1){lost+=sediment;sediment=0;break;}   // leaves the map with its load
      const qx=Math.floor(px),qy=Math.floor(py),qi=qy*S+qx,fx=px-qx,fy=py-qy;
      const newH=map[qi]*(1-fx)*(1-fy)+map[qi+1]*fx*(1-fy)+map[qi+S]*(1-fx)*fy+map[qi+S+1]*fx*fy,dh=newH-height;
      const cap=Math.max(-dh*speed*water*capacityF,minCap);
      if(sediment>cap||dh>0){
        const amount=dh>0?Math.min(dh,sediment):(sediment-cap)*depositS;sediment-=amount;deposit(nx,ny,cx,cy,amount);
      }else{
        const amount=Math.min((cap-sediment)*erodeS,-dh);
        // clipped brush near borders
        let wsum=1;const edge=nx<R||ny<R||nx>=S-R||ny>=S-R;
        if(edge){wsum=0;for(let b=0;b<BN;b++){const x=nx+BO[b*2],y=ny+BO[b*2+1];if(x>=0&&y>=0&&x<S&&y<S)wsum+=BW[b];}}
        for(let b=0;b<BN;b++){const x=nx+BO[b*2],y=ny+BO[b*2+1];if(edge&&(x<0||y<0||x>=S||y>=S))continue;const k=y*S+x,w=amount*BW[b]/wsum,take=map[k]<w?map[k]:w;map[k]-=take;sediment+=take;eroded+=take;}
      }
      speed=Math.sqrt(Math.max(0,speed*speed-dh*gravity));water*=1-evap;
      if(l===life-1&&sediment>0){if(dumpEnd)deposit(qx,qy,fx,fy,sediment);else lost+=sediment;sediment=0;}
    }
    if(it%batch===batch-1)yield it/iterations;
  }
  stats.eroded+=eroded;stats.lost+=lost;
}
function depositAt(map,S,idx,cx,cy,amount){if(amount<=0)return;map[idx]+=amount*(1-cx)*(1-cy);map[idx+1]+=amount*cx*(1-cy);map[idx+S]+=amount*(1-cx)*cy;map[idx+S+1]+=amount*cx*cy;}
/* Mass-conserving 3x3 blur of a change field (each sample spreads its value with renormalised weights at
   the borders): removes droplet-scale speckle and keeps channels. */
function blurChange(ch,S,passes){const tmp=new Float32Array(S*S);
  for(let p=0;p<passes;p++){tmp.fill(0);for(let y=0;y<S;y++)for(let x=0;x<S;x++){const v=ch[y*S+x];if(v===0)continue;
    let wsum=0;for(let b=-1;b<=1;b++)for(let a=-1;a<=1;a++){const xx=x+a,yy=y+b;if(xx>=0&&yy>=0&&xx<S&&yy<S)wsum+=(a?1:2)*(b?1:2);}
    for(let b=-1;b<=1;b++)for(let a=-1;a<=1;a++){const xx=x+a,yy=y+b;if(xx>=0&&yy>=0&&xx<S&&yy<S)tmp[yy*S+xx]+=v*(a?1:2)*(b?1:2)/wsum;}}ch.set(tmp);}}
function bilinearGrid(src,s,x,y){x=clamp(x,0,s-1);y=clamp(y,0,s-1);let i=Math.floor(x),j=Math.floor(y);if(i>s-2)i=s-2;if(j>s-2)j=s-2;const fx=x-i,fy=y-j,k=j*s+i;
  return (src[k]*(1-fx)+src[k+1]*fx)*(1-fy)+(src[k+s]*(1-fx)+src[k+s+1]*fx)*fy;}
function* erodeSteps(hf,o){
  const S=hf.size,N=S*S,src=hf.data,lo=hf.minHeight,H=o.heightScale||Math.max(1e-6,hf.maxHeight-hf.minHeight);
  const iterations=Math.max(0,Math.round(o.iterations===undefined?80000:o.iterations)),rnd=KE.random((o.seed===undefined?1:o.seed)>>>0);
  const sim=clamp(Math.round(o.simSize===undefined?Math.min(S,385):o.simSize),16,S),stats={eroded:0,lost:0,lifetime:0};
  const po={...o,_spawnMin:o.spawnAbove===undefined?-Infinity:(o.spawnAbove-lo)/H},seed=(o.seed===undefined?1:o.seed)>>>0,pool=o._pool&&plainOptions(o)?o._pool:null;
  const flow=o.masks===false?null:(hf.masks&&hf.masks.flow&&hf.masks.flow.length===N?hf.masks.flow:new Float32Array(N));
  const change=new Float32Array(N),passes=o.smoothing===undefined?2:Math.max(0,o.smoothing|0);let simCell=1;
  if(sim<S){
    // coarse pass: resample, simulate, upsample the change with exact volume correction
    const M=sim*sim,map=new Float32Array(M),f=(S-1)/(sim-1),cflow=flow?new Float32Array(M):null;simCell=f*f;
    for(let j=0;j<sim;j++)for(let i=0;i<sim;i++)map[j*sim+i]=(bilinearGrid(src,S,i*f,j*f)-lo)/H;
    const before=new Float32Array(map);if(pool)yield dropletsParallel(pool,map,sim,po,cflow,iterations,stats,seed);else yield* dropletPass(map,sim,po,rnd,cflow,iterations,stats);
    const cch=new Float32Array(M);let target=0;for(let i=0;i<M;i++){cch[i]=map[i]-before[i];target+=cch[i];}
    if(passes)blurChange(cch,sim,passes);yield .9;
    let sum=0,abs=0;const inv=1/f;
    for(let j=0;j<S;j++)for(let i=0;i<S;i++){const v=bilinearGrid(cch,sim,i*inv,j*inv);change[j*S+i]=v;sum+=v;abs+=Math.abs(v);if(cflow)flow[j*S+i]+=bilinearGrid(cflow,sim,i*inv,j*inv)/simCell;}
    // the coarse field's integral in fine-sample units is target*simCell; spread the resampling error over changed samples
    const err=target*simCell-sum;if(abs>0)for(let i=0;i<N;i++)change[i]+=err*Math.abs(change[i])/abs;
    blurChange(change,S,Math.max(1,Math.round(f*.75)));yield .95; // hides the bilinear creases of the upsampled change (mass conserving)
    stats.eroded*=simCell;stats.lost*=simCell;
  }
  const detail=sim<S?Math.max(0,Math.round(o.detailIterations||0)):iterations;
  if(detail>0){const map=new Float32Array(N);for(let i=0;i<N;i++)map[i]=(src[i]-lo)/H+change[i];const before=new Float32Array(map);
    const dpo={...po,lifetime:o.detailLifetime||o.lifetime};if(pool)yield dropletsParallel(pool,map,S,dpo,flow,detail,stats,(seed^0x9e3779b9)>>>0);else yield* dropletPass(map,S,dpo,rnd,flow,detail,stats);const fch=new Float32Array(N);for(let i=0;i<N;i++)fch[i]=map[i]-before[i];
    if(passes)blurChange(fch,S,sim<S?1:passes);for(let i=0;i<N;i++)change[i]+=fch[i];}
  yield 1;
  const delta=o.masks===false?null:(hf.masks&&hf.masks.delta&&hf.masks.delta.length===N?hf.masks.delta:new Float32Array(N));
  for(let i=0;i<N;i++){const v=src[i]+change[i]*H;if(delta)delta[i]+=v-src[i];src[i]=v;}
  if(flow||delta)hf.masks={...(hf.masks||{}),flow,delta};
  const cell=hf.spacing*hf.spacing;hf.erosionStats={droplets:iterations,detailDroplets:sim<S?detail:0,simSize:sim,erodedVolume:stats.eroded*H*cell,lostVolume:stats.lost*H*cell,lifetime:stats.lifetime,parallel:stats.parallel||null};
  hf.recomputeRange();hf.version++;return hf;
}
/* Parallel droplets: `rounds` rounds; in each, every worker runs its share of droplets on a copy of the current map and
   returns its height change, and the changes are summed before the next round, so later droplets follow the channels
   earlier rounds cut. Droplets in the same round do not see each other, so the result is statistically like the serial
   simulation rather than identical to it. */
async function dropletsParallel(pool,map,S,po,flow,iterations,stats,seed){const W=pool.size,rounds=Math.max(4,Math.min(16,Math.round(iterations/6000))),per=Math.max(1,Math.floor(iterations/(rounds*W))),opts=plainOptions(po)||{};
  for(let r=0;r<rounds;r++){const res=await Promise.all(Array.from({length:W},(_,w)=>{const m=map.slice();return pool.run('erode',{map:m,S,o:opts,seed:hashInts(seed,r+1,w+1),iterations:per,flow:!!flow},[m.buffer]);}));
    for(const t of res){const d=t.delta;for(let i=0;i<d.length;i++)map[i]+=d[i];if(flow&&t.flow)for(let i=0;i<flow.length;i++)flow[i]+=t.flow[i];stats.eroded+=t.eroded;stats.lost+=t.lost;stats.lifetime=t.lifetime;}}
  stats.parallel={workers:W,rounds,dropletsPerTask:per};}
Heightfield.erode=(hf,o={})=>{
  if(o.workers&&o.workers.size>0){/* async path: run the steps, awaiting the parallel droplet rounds */
    return (async()=>{const steps=erodeSteps(hf,{...o,_pool:o.workers});let r;while(!(r=steps.next()).done)if(r.value&&typeof r.value.then==='function')await r.value;return hf;})();}
  const steps=erodeSteps(hf,o);if(o.jobs)return o.jobs.add(steps,{name:'heightfield.erode',priority:o.priority||0});let r;do r=steps.next();while(!r.done);return hf;};

/* ---------- thermal erosion ----------
   Talus relaxation: wherever the drop to an 8-neighbour exceeds talus * distance, a fraction of the largest
   excess slides to the lower neighbours in proportion to their excess. Mass conserving. talus is rise/run. */
function* thermalSteps(hf,o){
  const S=hf.size,N=S*S,h=hf.data,sp=hf.spacing,iterations=Math.max(0,Math.round(o.iterations===undefined?40:o.iterations));
  const talus=o.talus===undefined?.85:o.talus,rate=clamp(o.rate===undefined?.5:o.rate,0,1),delta=new Float32Array(N);
  const DX=[1,-1,0,0,1,1,-1,-1],DY=[0,0,1,-1,1,-1,1,-1],lim=DX.map((x,k)=>talus*sp*Math.hypot(x,DY[k])),ex=new Float64Array(8);
  for(let it=0;it<iterations;it++){
    delta.fill(0);
    for(let y=0;y<S;y++){for(let x=0;x<S;x++){const i=y*S+x,v=h[i];let sum=0,mx=0;
      for(let k=0;k<8;k++){const xx=x+DX[k],yy=y+DY[k];let e=0;if(xx>=0&&yy>=0&&xx<S&&yy<S){e=v-h[yy*S+xx]-lim[k];if(e<0)e=0;}ex[k]=e;sum+=e;if(e>mx)mx=e;}
      if(sum<=0)continue;const move=rate*mx*.5;
      for(let k=0;k<8;k++)if(ex[k]>0){const a=move*ex[k]/sum;delta[(y+DY[k])*S+x+DX[k]]+=a;delta[i]-=a;}}}
    for(let i=0;i<N;i++)h[i]+=delta[i];
    yield (it+1)/iterations;
  }
  hf.recomputeRange();hf.version++;return hf;
}
Heightfield.thermalErode=(hf,o={})=>{const steps=thermalSteps(hf,o);if(o.jobs)return o.jobs.add(steps,{name:'heightfield.thermal',priority:o.priority||0});let r;do r=steps.next();while(!r.done);return hf;};

/* ---------- import ----------
   image: HTMLImageElement / canvas / ImageBitmap / ImageData, or {data, width, height} with Uint8/Uint16/Float32
   samples (1 or 4 channels). encoding 'luma' (8-bit gray) or 'rg16' (R*256+G, 16-bit). Non-square input is
   resampled bilinearly to a square of `size` samples (default max(width,height)). */
Heightfield.fromImage=(image,o={})=>{
  let w,h,px,ch=4;
  if(image&&image.data&&image.width&&image.height){w=image.width;h=image.height;px=image.data;ch=image.channels||Math.round(px.length/(w*h));}
  else{if(typeof document==='undefined')throw new Error('fromImage needs a DOM for image sources');w=image.naturalWidth||image.width;h=image.naturalHeight||image.height;
    const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.drawImage(image,0,0);px=g.getImageData(0,0,w,h).data;}
  if(!(w>1&&h>1))throw new RangeError('fromImage needs an image at least 2x2');
  const enc=o.encoding||'luma',max=px instanceof Uint16Array?65535:px instanceof Float32Array||px instanceof Float64Array?1:255;
  const val=(x,y)=>{const k=(y*w+x)*ch;if(ch===1)return px[k]/max;if(enc==='rg16')return (px[k]*256+px[k+1])/65535;return (px[k]*.299+px[k+1]*.587+px[k+2]*.114)/max;};
  const size=o.size||Math.max(w,h),minH=o.minHeight||0,maxH=o.maxHeight===undefined?100:o.maxHeight;
  const hf=new Heightfield({size,worldSize:o.worldSize||size-1,originX:o.originX,originZ:o.originZ});
  for(let j=0;j<size;j++)for(let i=0;i<size;i++){const fx=i/(size-1)*(w-1),fy=j/(size-1)*(h-1),x0=Math.min(Math.floor(fx),w-2),y0=Math.min(Math.floor(fy),h-2),tx=fx-x0,ty=fy-y0;
    const v=(val(x0,y0)*(1-tx)+val(x0+1,y0)*tx)*(1-ty)+(val(x0,y0+1)*(1-tx)+val(x0+1,y0+1)*tx)*ty;hf.data[j*size+i]=minH+v*(maxH-minH);}
  if(o.smooth){for(let p=0;p<o.smooth;p++)boxSmooth(hf);}
  return hf.recomputeRange();
};
function boxSmooth(hf){const s=hf.size,d=hf.data,c=new Float32Array(d);for(let j=0;j<s;j++)for(let i=0;i<s;i++){let t=0,n=0;for(let y=-1;y<=1;y++)for(let x=-1;x<=1;x++){const a=i+x,b=j+y;if(a>=0&&b>=0&&a<s&&b<s){t+=c[b*s+a];n++;}}d[j*s+i]=t/n;}}

/* ---------- biomes ----------
   Splat weights per heightfield sample, packed RGBA8: R grass, G sand, B rock, A snow; dirt is the remainder
   (1 - r - g - b - a). Rules: sand on low flat ground near/below the water line; rock on steep or convex
   (ridge) ground; snow above a noisy snow line on ground flat enough to hold it; dirt in erosion channels and
   deposition fans (from masks), on dry mid slopes (moisture noise) and in the alpine band; grass elsewhere. */
function biomeContext(hf,o){
  const range=Math.max(1e-6,hf.maxHeight-hf.minHeight),water=o.waterLevel===undefined?0:o.waterLevel;
  const flow=hf.masks&&hf.masks.flow;let flowMean=1;if(flow){let s=0,n=0;for(let i=0;i<flow.length;i+=7){s+=flow[i];n++;}flowMean=Math.max(1e-3,n?s/n:1);}
  return {water,range,beach:o.beachHeight===undefined?Math.max(1.2,range*.012):o.beachHeight,snowLine:o.snowLine===undefined?hf.minHeight+range*.74:o.snowLine,
    alpine:o.alpineLine===undefined?hf.minHeight+range*.6:o.alpineLine,rock0:o.rockSlope?o.rockSlope[0]:.55,rock1:o.rockSlope?o.rockSlope[1]:.95,
    moisture:makeNoise(((o.seed===undefined?1:o.seed)>>>0)*13+5),mscale:1/(o.moistureScale||260),flow,flow0:Math.log(1+flowMean*2.5),flow1:Math.log(1+flowMean*14),delta:hf.masks&&hf.masks.delta,
    dirt:o.dirt===undefined?1:o.dirt,sand:o.sand===undefined?1:o.sand,snow:o.snow===undefined?1:o.snow,rock:o.rock===undefined?1:o.rock,snowSlope:o.snowSlope||[.55,1.1],snowOverRock:!!o.snowOverRock};
}
function computeBiomes(hf,ctx,out,i0,j0,i1,j1){
  const s=hf.size,d=hf.data,sp=hf.spacing,c2=2;
  for(let j=j0;j<j1;j++)for(let i=i0;i<i1;i++){
    const k=j*s+i,h=d[k],x=hf.originX+i*sp,z=hf.originZ+j*sp,gx=hf._gx(i,j),gz=hf._gz(i,j),slope=Math.hypot(gx,gz);
    const lap=(hf.sample(i-c2,j)+hf.sample(i+c2,j)+hf.sample(i,j-c2)+hf.sample(i,j+c2))*.25-h,curv=lap/(c2*sp); // + concave, - convex
    const mn=fbm(ctx.moisture,x*ctx.mscale,z*ctx.mscale,4),n2=fbm(ctx.moisture,x*ctx.mscale*7+50,z*ctx.mscale*7-20,2);
    const fl=ctx.flow?smooth(ctx.flow0,ctx.flow1,Math.log(1+ctx.flow[k])):0,dep=ctx.delta?smooth(ctx.range*.006,ctx.range*.03,ctx.delta[k]):0;
    let rock=smooth(ctx.rock0,ctx.rock1,slope+Math.max(0,-curv)*1.4+n2*.12)*ctx.rock;
    rock=Math.max(rock,smooth(ctx.snowLine,ctx.snowLine+ctx.range*.2,h)*smooth(.35,.7,slope)*ctx.rock);
    const snowH=h+(mn*.6+n2*.4)*ctx.range*.07;
    const snow=smooth(ctx.snowLine-ctx.range*.03,ctx.snowLine+ctx.range*.05,snowH)*(1-smooth(ctx.snowSlope[0],ctx.snowSlope[1],slope))*ctx.snow;
    const beach=ctx.water+ctx.beach*(1+n2*.8);
    const sand=(1-smooth(beach-ctx.beach*.4,beach+ctx.beach*.6,h))*(1-smooth(.35,.7,slope))*ctx.sand;
    const dry=clamp((-mn-.04)*3.2,0,1),alp=smooth(ctx.alpine-ctx.range*.04,ctx.alpine+ctx.range*.08,h+n2*ctx.range*.04);
    let dirt=clamp(fl*.8+dep*.35+dry*(.35+smooth(.15,.45,slope)*.4)+alp*(.25+smooth(.25,.55,slope)*.4)+smooth(.4,.62,slope)*.2+Math.max(0,curv)*.3,0,1)*ctx.dirt;
    let rem=1;const wr=rock*(ctx.snowOverRock?1-snow*.85:1)*rem;rem-=wr;const wsn=snow*rem;rem-=wsn;const ws=sand*rem;rem-=ws;const wd=dirt*rem;rem-=wd;const wg=Math.max(0,rem);
    let R=Math.round(wg*255),G=Math.round(ws*255),B=Math.round(wr*255),A=Math.round(wsn*255),sum=R+G+B+A;
    if(sum>255){const over=sum-255;if(R>=over)R-=over;else if(B>=over)B-=over;else{G=Math.max(0,G-over);}}
    void wd;out[k*4]=R;out[k*4+1]=G;out[k*4+2]=B;out[k*4+3]=A;
  }
}
/* biomes(THREE, hf, opts) or biomes(hf, opts [, opts.THREE]) -> RGBA8 DataTexture (linear, mipmapped).
   texture.userData.update(i0,j0,i1,j1) recomputes a sample rectangle (the terrain calls it after sculpting). */
Heightfield.biomes=(a,b,c)=>{
  let THREE,hf,o;if(isThree(a)){THREE=a;hf=b;o=c||{};}else{hf=a;o=b||{};THREE=o.THREE||(typeof window!=='undefined'&&window.THREE);}
  if(!hf||!hf.data)throw new TypeError('biomes needs a Heightfield');
  const s=hf.size,data=new Uint8Array(s*s*4),ctx=biomeContext(hf,o);computeBiomes(hf,ctx,data,0,0,s,s);
  if(!THREE)return {data,size:s,layers:['grass','sand','rock','snow','dirt']};
  const t=new THREE.DataTexture(data,s,s,THREE.RGBAFormat,THREE.UnsignedByteType);
  t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.generateMipmaps=true;t.flipY=false;t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;t.anisotropy=KE.settings.aniso||4;t.needsUpdate=true;t.name='ke-biomes';
  // update() reuses the context captured at creation (snow line, beach band, flow statistics), so sculpted
  // regions are classified with the same thresholds as the rest of the map.
  t.userData={kind:'ke-biomes',layers:['grass','sand','rock','snow','dirt'],size:s,update:(i0=0,j0=0,i1=s,j1=s)=>{computeBiomes(hf,ctx,data,Math.max(0,i0),Math.max(0,j0),Math.min(s,i1),Math.min(s,j1));}};
  return t;
};
KE.Heightfield=Heightfield;
/* A worker pool whose kernel is this module's own noise, landscape function and droplet simulation (their source
   text), sized to the CPU (up to 64 threads). Pass it as {workers} to generate() and erode(); dispose it when done. */
Heightfield.workers=(o={})=>new KE.WorkerPool(`'use strict';const clamp=${clamp};const smooth=${smooth};const hashInts=${hashInts};const KE={random:${KE.random}};
${makeNoise}
const ND=new Float64Array(2);
${noise2}
${fbm}
${erodedFbm}
${ridgedFbm}
${terrainFunction}
${dropletPass}
${depositAt}
const TASKS={
  rows(a){const fn=terrainFunction(a.o),out=new Float32Array((a.j1-a.j0)*a.size);for(let j=a.j0;j<a.j1;j++){const z=a.originZ+j*a.sp,row=(j-a.j0)*a.size;for(let i=0;i<a.size;i++)out[row+i]=fn(a.originX+i*a.sp,z);}return {out,transfer:[out.buffer]};},
  erode(a){const map=a.map,before=map.slice(),flow=a.flow?new Float32Array(map.length):null,stats={eroded:0,lost:0,lifetime:0},it=dropletPass(map,a.S,a.o,KE.random(a.seed),flow,a.iterations,stats);while(!it.next().done);
    for(let i=0;i<map.length;i++)map[i]-=before[i];return {out:{delta:map,flow,...stats},transfer:flow?[map.buffer,flow.buffer]:[map.buffer]};}
};
${KE.WorkerPool.dispatcher}`,o);
KE.noise2D=(seed=1)=>{const n=makeNoise(seed);return (x,y)=>noise2(n,x,y);};

/* ---------- GPU CDLOD terrain ----------
   Continuous distance-dependent LOD after F. Strugar, "Continuous Distance-Dependent Level of Detail for
   Rendering Heightmaps" (2010). A quadtree of square nodes spans the heightfield; level 0 nodes (leaves) are
   gridResolution x gridResolution quads, each level up doubles the node size. Selection walks the tree from
   the root: a node is drawn at its own level when it lies outside the next finer LOD sphere, otherwise its
   children are visited; a child that is out of reach of the finer sphere is drawn as a quadrant of the parent
   at the parent's density (patch step 2). Every selected node or quadrant becomes one instance of a single
   shared grid mesh, so the terrain is ONE instanced draw call. The vertex shader samples the height texture
   (four nearest texels, manual bilinear: identical to Heightfield.heightAt) and geomorphs odd grid vertices
   onto their even neighbours as the distance approaches the level's range, so levels meet without cracks or
   popping. Skirts hide the rare residual T-junction gaps. Morph distances use a dedicated uniform camera
   position, so shadow passes rendered from a light share the main camera's geometry exactly. */
const TERRAIN_VERT=`
uniform sampler2D keHeightMap;
uniform sampler2D keNormalMap;
uniform vec4 keHF;
uniform vec3 keLodCamera;
uniform vec2 keMorph[KE_TERRAIN_LEVELS];
uniform float keGridDim;
uniform float keSkirtDepth;
attribute vec4 kePatch;
attribute float kePatchStep;
varying vec3 keTWorld;
varying vec2 keTUV;
varying float keTLod;
varying vec2 keTGrid;
vec3 keTerrainPos;
vec3 keTerrainNrm;
float keTerrainHeight(vec2 p){
  float s=keHF.w;vec2 t=clamp((p-keHF.xy)*keHF.z,vec2(0.),vec2(s-1.));vec2 i=min(floor(t),vec2(s-2.));vec2 f=t-i;float inv=1./s;vec2 uv=(i+.5)*inv;
  float a=texture2D(keHeightMap,uv).r,b=texture2D(keHeightMap,uv+vec2(inv,0.)).r,c=texture2D(keHeightMap,uv+vec2(0.,inv)).r,d=texture2D(keHeightMap,uv+vec2(inv)).r;
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
vec2 keTerrainUV(vec2 p){return ((p-keHF.xy)*keHF.z+.5)/keHF.w;}
vec3 keTerrainNormal(vec2 uv){vec2 e=texture2D(keNormalMap,uv).xy*2.-1.;return normalize(vec3(e.x,sqrt(max(0.,1.-dot(e,e))),e.y));}
void keTerrainVertex(){
  float st=kePatchStep,cell=kePatch.z/keGridDim;
  vec2 g=position.xz;
  vec2 g1=g-mod(g,vec2(st));
  vec2 p1=kePatch.xy+g1*cell;
  float h1=keTerrainHeight(p1);
  vec2 mc=keMorph[int(kePatch.w+.5)];
  float k=1.-clamp(mc.x-distance(keLodCamera,vec3(p1.x,h1,p1.y))*mc.y,0.,1.);
  vec2 g2=g1-mod(g1,vec2(2.*st))*k;
  vec2 p=kePatch.xy+g2*cell;
  float h=keTerrainHeight(p);
  keTUV=keTerrainUV(p);
  keTerrainNrm=keTerrainNormal(keTUV);
  h-=position.y*keSkirtDepth*cell*st;
  keTerrainPos=vec3(p.x,h,p.y);
  keTWorld=(modelMatrix*vec4(keTerrainPos,1.)).xyz;
  keTLod=kePatch.w+k;
  keTGrid=g;
}
`;
const TERRAIN_RELIEF=`vec3 keTReliefNormal(vec3 pos,vec3 n,float h,float strength){vec3 sx=dFdx(pos),sy=dFdy(pos);vec3 r1=cross(sy,n),r2=cross(n,sx);float det=dot(sx,r1);vec3 grad=sign(det)*(dFdx(h)*r1+dFdy(h)*r2);return normalize(abs(det)*n-strength*grad);}`;
/* Default landscape shading, injected into a MeshStandardMaterial:
   - five layers from the biome weights (grass, sand, dirt, rock, snow) using KE.materials tiles;
   - height blending: each layer's weight is raised by its tile's height map and only layers within a narrow
     band of the tallest survive, so sand fills the gaps between grass tufts instead of cross-fading;
   - rock is projected triplanar (no stretching on cliffs) and forced on steep per-pixel normals;
   - every layer is also sampled at a 1/5 scale that takes over with distance (kills visible tiling);
   - low-frequency macro noise varies grass hue and overall brightness across hundreds of metres;
   - per-pixel normals from the terrain normal map (LOD independent), plus relief from the blended height;
   - wet darkening and lower roughness in a band above the water level. */
const TERRAIN_FRAG_DECL=`
uniform sampler2D keNormalMap;uniform sampler2D keBiome;uniform sampler2D keHA;uniform sampler2D keHB;
uniform sampler2D keTGrass;uniform sampler2D keTSand;uniform sampler2D keTDirt;uniform sampler2D keTRock;uniform sampler2D keTSnow;
uniform float keTexScale;uniform float keRelief;uniform float keTHTexel;uniform float keWaterLevel;uniform float keMacro;uniform vec3 keGrassTint;uniform float keFarScale;
varying vec3 keTWorld;varying vec2 keTUV;varying float keTLod;
${TERRAIN_RELIEF}
vec3 keTNormalAt(vec2 uv){vec2 e=texture2D(keNormalMap,uv).xy*2.-1.;return normalize(vec3(e.x,sqrt(max(0.,1.-dot(e,e))),e.y));}
`;
const TERRAIN_MAP=`
vec3 kN=keTNormalAt(keTUV);
float kDist=length(vViewPosition);
vec4 kB=texture2D(keBiome,keTUV);
vec4 kWA=vec4(kB.r,kB.g,max(0.,1.-kB.r-kB.g-kB.b-kB.a),kB.b);float kWS=kB.a;
float kSteep=smoothstep(.74,.6,kN.y);kWA=kWA*(1.-kSteep)+vec4(0.,0.,0.,kSteep);kWS*=1.-kSteep;
vec2 kuv=keTWorld.xz*keTexScale,kuvF=keTWorld.xz*keTexScale*keFarScale+vec2(.37,.71);
float kFar=smoothstep(12.,70.,kDist);
vec4 kHA=mix(texture2D(keHA,kuv),texture2D(keHA,kuvF),kFar);
vec4 kHB=mix(texture2D(keHB,kuv),texture2D(keHB,kuvF),kFar);
vec3 kBl=pow(abs(kN),vec3(4.));kBl/=dot(kBl,vec3(1.));float kRS=keTexScale*.45;
vec3 kRock=texture2D(keTRock,keTWorld.zy*kRS).rgb*kBl.x+texture2D(keTRock,keTWorld.xz*kRS).rgb*kBl.y+texture2D(keTRock,keTWorld.xy*kRS).rgb*kBl.z;
vec3 kRockF=texture2D(keTRock,keTWorld.xz*kRS*keFarScale).rgb;kRock=mix(kRock,mix(kRock,kRockF,.5),kFar);
float kRockH=dot(kRock,vec3(.299,.587,.114))*1.25;
vec4 kLive=step(vec4(.003),kWA);float kLiveS=step(.003,kWS);
vec4 kTA=kWA+vec4(kHA.r,kHA.g,kHA.b,kRockH)*.55*kLive;float kTS=kWS+kHB.g*.55*kLiveS;
float kTop=max(max(max(kTA.x,kTA.y),max(kTA.z,kTA.w)),kTS)-.2;
vec4 kBA=max(kTA-kTop,0.)*kLive;float kBS=max(kTS-kTop,0.)*kLiveS;float kSum=dot(kBA,vec4(1.))+kBS+1e-5;kBA/=kSum;kBS/=kSum;
float kM1=keFbm2(keTWorld.xz*.0042+3.7),kM2=keNoise2(keTWorld.xz*.027-1.3),kM3=keNoise2(keTWorld.xz*.11+7.1);
vec3 kGrass=mix(texture2D(keTGrass,kuv).rgb,texture2D(keTGrass,kuvF).rgb,kFar)*mix(vec3(.8,.97,.66),vec3(1.2,1.08,.76),smoothstep(.3,.7,kM1)*keMacro+.5*(1.-keMacro));
kGrass*=keGrassTint;
vec3 kSand=mix(texture2D(keTSand,kuv).rgb,texture2D(keTSand,kuvF).rgb,kFar);
vec3 kDirt=mix(texture2D(keTDirt,kuv).rgb,texture2D(keTDirt,kuvF).rgb,kFar);
vec3 kSnow=mix(texture2D(keTSnow,kuv).rgb,texture2D(keTSnow,kuvF).rgb,kFar);
vec3 kCol=kGrass*kBA.x+kSand*kBA.y+kDirt*kBA.z+kRock*kBA.w+kSnow*kBS;
kCol*=1.+keMacro*((kM2-.5)*.22+(kM3-.5)*.1);
float kWet=1.-smoothstep(keWaterLevel+.05,keWaterLevel+1.1,keTWorld.y);
diffuseColor.rgb*=pow(max(kCol,vec3(0.)),vec3(2.2))*mix(1.,.62,kWet*(1.-kBS));
float kHeight=dot(kBA,vec4(kHA.r,kHA.g,kHA.b,kRockH))+kBS*kHB.g;
/* relief slope from texture-space differences of the near-scale layer heights two texels apart (smooth, mip-aware) */
vec2 kte=vec2(keTHTexel,0.);vec4 kHA0=texture2D(keHA,kuv),kHAx=texture2D(keHA,kuv+kte),kHAz=texture2D(keHA,kuv+kte.yx);float kHB0=texture2D(keHB,kuv).g;
float kh0=dot(kBA,vec4(kHA0.r,kHA0.g,kHA0.b,kRockH))+kBS*kHB0;
vec3 kGrad=vec3(dot(kBA,vec4(kHAx.r,kHAx.g,kHAx.b,kRockH))+kBS*texture2D(keHB,kuv+kte).g-kh0,0.,dot(kBA,vec4(kHAz.r,kHAz.g,kHAz.b,kRockH))+kBS*texture2D(keHB,kuv+kte.yx).g-kh0);
`;
const TERRAIN_ROUGH=`roughnessFactor=mix(dot(kBA,vec4(.95,.9,.96,.82))+kBS*.55,.28,kWet*.85);`;
const TERRAIN_NORMAL=`normal=normalize((viewMatrix*vec4(kN,0.)).xyz);{vec3 kg=(viewMatrix*vec4(kGrad,0.)).xyz;normal=normalize(normal-keRelief*30.*(1.-kFar*.8)*(kg-normal*dot(kg,normal)));}`;

function replaceOrThrow(src,target,repl,what){if(src.indexOf(target)<0)throw new Error('KE.GPUTerrain: shader chunk '+target+' not found in '+what+' (Three.js r128 expected)');return src.replace(target,repl);}

/* Grid of (N+1)^2 vertices whose position attribute holds integer grid coordinates (x, skirt flag, z), plus
   one skirt strip per edge. Quads split along the (i+1,j)-(i,j+1) diagonal, the convention heightAt() uses. */
function buildPatchGeometry(THREE,N,skirts){
  const V=N+1,pos=[],idx=[];
  for(let j=0;j<=N;j++)for(let i=0;i<=N;i++)pos.push(i,0,j);
  for(let j=0;j<N;j++)for(let i=0;i<N;i++){const a=j*V+i,b=a+1,c=a+V,d=c+1;idx.push(a,c,b,b,c,d);}
  if(skirts){
    // perimeter walked (0,0)->(N,0)->(N,N)->(0,N)->(0,0); winding (e0,e1,s0),(e1,s1,s0) faces outward
    const edges=[[i=>[i,0]],[i=>[N,i]],[i=>[N-i,N]],[i=>[0,N-i]]];
    for(const [f] of edges){const base=pos.length/3;for(let i=0;i<=N;i++){const [x,z]=f(i);pos.push(x,1,z);}
      for(let i=0;i<N;i++){const [x0,z0]=f(i),[x1,z1]=f(i+1),e0=z0*V+x0,e1=z1*V+x1,s0=base+i,s1=base+i+1;idx.push(e0,e1,s0,e1,s1,s0);}}
  }
  const g=new THREE.InstancedBufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);
  g.userData.trianglesPerPatch=idx.length/3;return g;
}

function sampleNormalRGBA(hf,out,i0,j0,i1,j1){const s=hf.size;
  for(let j=j0;j<j1;j++)for(let i=i0;i<i1;i++){const gx=hf._gx(i,j),gz=hf._gz(i,j),l=Math.hypot(gx,1,gz),k=(j*s+i)*4;
    out[k]=Math.round((-gx/l*.5+.5)*255);out[k+1]=Math.round((-gz/l*.5+.5)*255);out[k+2]=Math.round(255/l);out[k+3]=255;}}

const _box=[0,0,0,0,0,0];
class GPUTerrain{
  constructor(THREE,o={}){
    const hf=o.heightfield;if(!hf||!hf.data||!hf.size)throw new TypeError('KE.GPUTerrain needs {heightfield: KE.Heightfield}');
    this.THREE=THREE;this.heightfield=hf;this.options=o;
    const N=o.gridResolution||32;if(!Number.isInteger(N)||N<4||N>256||N%4)throw new RangeError('gridResolution must be a multiple of 4 in [4,256]');
    this.gridResolution=N;
    const auto=Math.round(Math.log2(hf.worldSize/(N*hf.spacing*(o.detail||1))))+1;
    this.levels=clamp(Math.round(o.levels||auto),1,14);
    this.leafSize=hf.worldSize/Math.pow(2,this.levels-1);this.vertexSpacing=this.leafSize/N;this.leavesPerSide=1<<(this.levels-1);
    this.originX=hf.originX;this.originZ=hf.originZ;this.morph=o.morph!==false;this.morphRatio=clamp(o.morphRatio===undefined?.68:o.morphRatio,.05,.95);
    this.lodDistance=o.lodDistance||this.leafSize*3;this.skirts=o.skirts!==false;
    this.ranges=new Float64Array(this.levels);this._lodScale=-1;
    this._stats={patches:0,visited:0,culled:0,levelCounts:new Array(this.levels).fill(0),selectionMs:0,triangles:0};
    // min/max height pyramid: level l has (leavesPerSide>>l)^2 nodes, two floats each
    this._mm=[];for(let l=0;l<this.levels;l++){const n=this.leavesPerSide>>l;this._mm.push(new Float32Array(n*n*2));}
    this._buildMinMax(0,0,this.leavesPerSide-1,this.leavesPerSide-1);
    // textures
    const s=hf.size;this.heightTexture=hf.toTexture(THREE,{format:'float'});
    this._normalData=new Uint8Array(s*s*4);sampleNormalRGBA(hf,this._normalData,0,0,s,s);
    const nt=new THREE.DataTexture(this._normalData,s,s,THREE.RGBAFormat,THREE.UnsignedByteType);nt.minFilter=THREE.LinearMipmapLinearFilter;nt.magFilter=THREE.LinearFilter;nt.generateMipmaps=true;nt.flipY=false;nt.wrapS=nt.wrapT=THREE.ClampToEdgeWrapping;nt.needsUpdate=true;nt.name='ke-terrain-normals';
    this.normalTexture=nt;
    this.waterLevel=o.waterLevel===undefined?0:o.waterLevel;
    this._ownBiomes=!o.biomes;this.biomeTexture=o.biomes||Heightfield.biomes(THREE,hf,{waterLevel:this.waterLevel,seed:o.seed,...(o.biomeOptions||{})});
    // shared uniforms (by reference) for every material that draws the terrain
    this.uniforms={keHeightMap:{value:this.heightTexture},keNormalMap:{value:this.normalTexture},keHF:{value:new THREE.Vector4(hf.originX,hf.originZ,hf.invSpacing,s)},
      keLodCamera:{value:new THREE.Vector3()},keMorph:{value:Array.from({length:this.levels},()=>new THREE.Vector2(2,0))},keGridDim:{value:N},keSkirtDepth:{value:this.skirts?(o.skirtDepth||2):0}};
    // geometry + per-instance patch attributes
    this.geometry=buildPatchGeometry(THREE,N,this.skirts);this._capacity=0;this._ensureCapacity(Math.min(4096,((1<<(2*Math.min(this.levels,7)))-1)/3|0||1));
    this.geometry.instanceCount=0;
    // materials
    this._ownMaterial=!o.material;this.material=o.material?this.patchMaterial(o.material):this._defaultMaterial(o);
    const mesh=new THREE.Mesh(this.geometry,this.material);mesh.name='ke-gpu-terrain';mesh.frustumCulled=false;mesh.matrixAutoUpdate=false;
    mesh.castShadow=!!o.castShadow;mesh.receiveShadow=o.receiveShadow!==false;mesh.userData.terrain=this;
    mesh.customDepthMaterial=this.patchMaterial(new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking}),'depth');
    mesh.customDistanceMaterial=this.patchMaterial(new THREE.MeshDistanceMaterial(),'depth');
    mesh.onBeforeRender=renderer=>{this._renderer=renderer;this._flush(renderer);};
    mesh.raycast=(raycaster,intersects)=>{const r=raycaster.ray,hit=this.raycast(r.origin,r.direction,raycaster.far);
      if(hit&&hit.distance>=raycaster.near)intersects.push({distance:hit.distance,point:new THREE.Vector3(hit.point.x,hit.point.y,hit.point.z),face:{a:0,b:0,c:0,normal:new THREE.Vector3(hit.normal.x,hit.normal.y,hit.normal.z),materialIndex:0},object:mesh});};
    this.object=this.mesh=mesh;
    this._frustum=new THREE.Frustum();this._pv=new THREE.Matrix4();this._box3=new THREE.Box3();this._cam=new THREE.Vector3();
    this._sweep=new THREE.Vector3();this.shadowSweep=o.shadowSweep===undefined?(mesh.castShadow?Math.max(200,hf.maxHeight-hf.minHeight)*2:0):o.shadowSweep;
    this._dirty=null;this._debugMaterial=null;this.debug=null;
    this._updateRanges();
  }
  /* ----- CPU mirror of what the GPU draws ----- */
  /* Height of the finest LOD surface: bilinear heightfield samples at the level-0 vertex grid, interpolated
     over the same two triangles per quad the patch mesh uses. Equals Heightfield.heightAt at grid vertices. */
  heightAt(x,z){
    const s=this.vertexSpacing,n=this.leavesPerSide*this.gridResolution,hf=this.heightfield;
    let gx=(x-this.originX)/s,gz=(z-this.originZ)/s;gx=gx<0?0:gx>n?n:gx;gz=gz<0?0:gz>n?n:gz;
    let i=Math.floor(gx),j=Math.floor(gz);if(i>n-1)i=n-1;if(j>n-1)j=n-1;const fx=gx-i,fz=gz-j,x0=this.originX+i*s,z0=this.originZ+j*s;
    if(fx+fz<=1){const a=hf.heightAt(x0,z0),b=hf.heightAt(x0+s,z0),c=hf.heightAt(x0,z0+s);return a+(b-a)*fx+(c-a)*fz;}
    const b=hf.heightAt(x0+s,z0),c=hf.heightAt(x0,z0+s),d=hf.heightAt(x0+s,z0+s);return d+(c-d)*(1-fx)+(b-d)*(1-fz);
  }
  normalAt(x,z,out){return this.heightfield.normalAt(x,z,out);}
  slopeAt(x,z){return this.heightfield.slopeAt(x,z);}
  /* Ray against the finest surface. A 2D DDA walks level-0 nodes along the ray and skips every node whose
     max height lies below the ray segment; inside candidate nodes the ray is marched at half the vertex
     spacing and the first downward crossing is refined by bisection. Returns {point, normal, distance} or null. */
  raycast(origin,dir,maxDist=Infinity,out){
    let dx=dir.x,dy=dir.y,dz=dir.z;const len=Math.hypot(dx,dy,dz);if(!(len>0))return null;dx/=len;dy/=len;dz/=len;
    const root=this._mm[this.levels-1],lo=[this.originX,root[0]-1,this.originZ],hi=[this.originX+this.heightfield.worldSize,root[1]+1,this.originZ+this.heightfield.worldSize],o=[origin.x,origin.y,origin.z],d=[dx,dy,dz];
    let t0=0,t1=Math.min(maxDist,1e9);
    for(let a=0;a<3;a++){if(Math.abs(d[a])<1e-12){if(o[a]<lo[a]||o[a]>hi[a])return null;continue;}let ta=(lo[a]-o[a])/d[a],tb=(hi[a]-o[a])/d[a];if(ta>tb){const t=ta;ta=tb;tb=t;}if(ta>t0)t0=ta;if(tb<t1)t1=tb;if(t0>t1)return null;}
    const f=t=>o[1]+dy*t-this.heightAt(o[0]+dx*t,o[2]+dz*t);
    const hit=t=>{const p={x:o[0]+dx*t,y:0,z:o[2]+dz*t};p.y=this.heightAt(p.x,p.z);const r=out||{};r.point=p;r.distance=t;r.normal=this.normalAt(p.x,p.z);return r;};
    if(f(t0)<0)return hit(t0);// starts below the surface (or enters through a side wall)
    const L=this.leafSize,n=this.leavesPerSide,mm=this._mm[0],step=this.vertexSpacing*.5;
    let x=o[0]+dx*t0,z=o[2]+dz*t0,ix=clamp(Math.floor((x-this.originX)/L),0,n-1),iz=clamp(Math.floor((z-this.originZ)/L),0,n-1);
    const sx=dx>0?1:-1,sz=dz>0?1:-1,tdx=Math.abs(dx)>1e-12?L/Math.abs(dx):Infinity,tdz=Math.abs(dz)>1e-12?L/Math.abs(dz):Infinity;
    let tmx=Math.abs(dx)>1e-12?(this.originX+(ix+(dx>0?1:0))*L-o[0])/dx:Infinity,tmz=Math.abs(dz)>1e-12?(this.originZ+(iz+(dz>0?1:0))*L-o[2])/dz:Infinity;
    let t=t0;
    for(let guard=0;guard<4*n+8;guard++){
      const te=Math.min(tmx,tmz,t1),k=(iz*n+ix)*2,top=mm[k+1];
      if(Math.min(o[1]+dy*t,o[1]+dy*te)<=top+1e-3){let ta=t,fa=f(ta);
        while(ta<te){const tb=Math.min(ta+step,te),fb=f(tb);if(fa>=0&&fb<0){let a=ta,b=tb;for(let q=0;q<24;q++){const m=(a+b)*.5;if(f(m)>=0)a=m;else b=m;}return hit((a+b)*.5);}ta=tb;fa=fb;}}
      if(te>=t1)break;
      if(tmx<tmz){ix+=sx;t=tmx;tmx+=tdx;}else{iz+=sz;t=tmz;tmz+=tdz;}
      if(ix<0||iz<0||ix>=n||iz>=n)break;
    }
    return null;
  }
  /* ----- LOD selection ----- */
  _updateRanges(){
    const scale=KE.settings.lod||1,L=this.levels,U=this.uniforms.keMorph.value;this._lodScale=scale;
    const r0=Math.max(this.lodDistance*scale,this.leafSize*2.2);
    for(let l=0;l<L;l++)this.ranges[l]=l===L-1?Infinity:r0*Math.pow(2,l);
    for(let l=0;l<L;l++){const end=this.ranges[l],prev=l?this.ranges[l-1]:0,start=prev+(end-prev)*this.morphRatio;
      if(!this.morph||!isFinite(end))U[l].set(2,0);else U[l].set(end/(end-start),1/(end-start));}
  }
  _node(level,ix,iz){const n=this.leavesPerSide>>level,k=(iz*n+ix)*2,size=this.leafSize*(1<<level),mm=this._mm[level];
    _box[0]=this.originX+ix*size;_box[1]=mm[k];_box[2]=this.originZ+iz*size;_box[3]=_box[0]+size;_box[4]=mm[k+1];_box[5]=_box[2]+size;return size;}
  _dist(){const c=this._cam;const dx=Math.max(_box[0]-c.x,0,c.x-_box[3]),dy=Math.max(_box[1]-c.y,0,c.y-_box[4]),dz=Math.max(_box[2]-c.z,0,c.z-_box[5]);return Math.sqrt(dx*dx+dy*dy+dz*dz);}
  _visible(){const b=this._box3;b.min.set(_box[0],_box[1],_box[2]);b.max.set(_box[3],_box[4],_box[5]);if(this._frustum.intersectsBox(b))return true;
    if(!this._sweepOn)return false;const w=this._sweep;b.expandByPoint(this._v1.set(_box[0]+w.x,_box[1]+w.y,_box[2]+w.z));b.expandByPoint(this._v1.set(_box[3]+w.x,_box[4]+w.y,_box[5]+w.z));return this._frustum.intersectsBox(b);}
  _add(x,z,size,level,step){
    if(this._count>=this._capacity)this._ensureCapacity(this._capacity*2);
    const i=this._count++,a=this._patch.array;a[i*4]=x;a[i*4+1]=z;a[i*4+2]=size;a[i*4+3]=level;this._step.array[i]=step;this._stats.levelCounts[level]++;
  }
  _select(level,ix,iz){
    this._stats.visited++;const size=this._node(level,ix,iz),d=this._dist();
    if(level<this.levels-1&&d>this.ranges[level])return false;
    if(!this._visible()){this._stats.culled++;return true;}
    if(level===0){this._add(_box[0],_box[2],size,0,1);return true;}
    if(d>this.ranges[level-1]){this._add(_box[0],_box[2],size,level,1);return true;}
    for(let c=0;c<4;c++){const cx=ix*2+(c&1),cz=iz*2+(c>>1);
      if(!this._select(level-1,cx,cz)){const cs=this._node(level-1,cx,cz);if(this._visible())this._add(_box[0],_box[2],cs,level,2);else this._stats.culled++;}}
    return true;
  }
  /* Select patches for this camera: call once per frame before rendering (also before shadow updates). */
  update(camera,renderer){
    const t0=performance.now(),st=this._stats;if((KE.settings.lod||1)!==this._lodScale)this._updateRanges();
    camera.updateMatrixWorld();this._cam.setFromMatrixPosition(camera.matrixWorld);this.uniforms.keLodCamera.value.copy(this._cam);
    this._pv.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this._frustum.setFromProjectionMatrix(this._pv);
    this._sweepOn=false;if(this.mesh.castShadow&&this.shadowSweep>0){const sd=this.sunDirection||(KE._sceneUniforms&&KE._sceneUniforms.keSunDirection.value);
      if(sd&&sd.y>.02){this._sweep.set(sd.x,sd.y,sd.z).normalize().multiplyScalar(-this.shadowSweep);this._sweepOn=true;this._v1=this._v1||new this.THREE.Vector3();}}
    this._count=0;st.visited=0;st.culled=0;st.levelCounts.fill(0);
    this._select(this.levels-1,0,0);
    this.geometry.instanceCount=this._count;
    const P=this._patch,S=this._step;P.updateRange.offset=0;P.updateRange.count=this._count*4;P.needsUpdate=true;S.updateRange.offset=0;S.updateRange.count=this._count;S.needsUpdate=true;
    st.patches=this._count;st.triangles=this._count*this.geometry.userData.trianglesPerPatch;st.selectionMs=performance.now()-t0;
    if(renderer)this._renderer=renderer;if(this._renderer)this._flush(this._renderer);
    return this;
  }
  _ensureCapacity(n){
    n=Math.max(16,n|0);if(n<=this._capacity)return;const T=this.THREE,oldP=this._patch,oldS=this._step;
    const P=new T.InstancedBufferAttribute(new Float32Array(n*4),4).setUsage(T.DynamicDrawUsage),S=new T.InstancedBufferAttribute(new Float32Array(n),1).setUsage(T.DynamicDrawUsage);
    if(oldP){P.array.set(oldP.array);S.array.set(oldS.array);}
    this.geometry.setAttribute('kePatch',P);this.geometry.setAttribute('kePatchStep',S);this._patch=P;this._step=S;this._capacity=n;
    // r128 caches the instance limit on the geometry the first time it is drawn; forget it so the new
    // attribute size applies (the renderer recomputes it on the next draw).
    delete this.geometry._maxInstanceCount;
  }
  _buildMinMax(ix0,iz0,ix1,iz1){
    const hf=this.heightfield,S=hf.size,d=hf.data,inv=hf.invSpacing,L=this.leafSize,n=this.leavesPerSide,m0=this._mm[0];
    for(let iz=iz0;iz<=iz1;iz++)for(let ix=ix0;ix<=ix1;ix++){
      const i0=clamp(Math.floor(ix*L*inv),0,S-1),i1=clamp(Math.ceil((ix+1)*L*inv),0,S-1),j0=clamp(Math.floor(iz*L*inv),0,S-1),j1=clamp(Math.ceil((iz+1)*L*inv),0,S-1);
      let lo=Infinity,hi=-Infinity;for(let j=j0;j<=j1;j++){const r=j*S;for(let i=i0;i<=i1;i++){const v=d[r+i];if(v<lo)lo=v;if(v>hi)hi=v;}}
      m0[(iz*n+ix)*2]=lo;m0[(iz*n+ix)*2+1]=hi;}
    for(let l=1;l<this.levels;l++){const nl=n>>l,nc=nl*2,c=this._mm[l-1],m=this._mm[l],a0=ix0>>l,b0=iz0>>l,a1=ix1>>l,b1=iz1>>l;
      for(let iz=b0;iz<=b1;iz++)for(let ix=a0;ix<=a1;ix++){let lo=Infinity,hi=-Infinity;
        for(let q=0;q<4;q++){const k=((iz*2+(q>>1))*nc+ix*2+(q&1))*2;if(c[k]<lo)lo=c[k];if(c[k+1]>hi)hi=c[k+1];}m[(iz*nl+ix)*2]=lo;m[(iz*nl+ix)*2+1]=hi;}}
  }
  /* ----- editing ----- */
  /* Brush edit in world units. raise/lower add strength*falloff metres per call; smooth blends toward the
     3x3 mean and flatten toward `height` (default: the height under the brush centre) by strength*falloff
     (0..1). Updates the heightfield, normals, min/max tree and biome weights on the CPU and queues GPU
     sub-rectangle uploads. Returns the touched sample rectangle or null. */
  sculpt({x=0,z=0,radius=8,strength=1,mode='raise',height,falloff=1}={}){
    const hf=this.heightfield,S=hf.size,d=hf.data,inv=hf.invSpacing;
    const i0=clamp(Math.floor((x-radius-hf.originX)*inv),0,S-1),i1=clamp(Math.ceil((x+radius-hf.originX)*inv),0,S-1),j0=clamp(Math.floor((z-radius-hf.originZ)*inv),0,S-1),j1=clamp(Math.ceil((z+radius-hf.originZ)*inv),0,S-1);
    if(i1<i0||j1<j0||!(radius>0))return null;
    const w=(i,j)=>{const px=hf.originX+i*hf.spacing,pz=hf.originZ+j*hf.spacing,t=Math.hypot(px-x,pz-z)/radius;if(t>=1)return 0;const q=1-t*t;return falloff>=1?q*q:Math.pow(q,2*falloff);};
    if(mode==='raise'||mode==='lower'){const sg=mode==='lower'?-strength:strength;for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++)d[j*S+i]+=sg*w(i,j);}
    else if(mode==='smooth'||mode==='flatten'){
      const target=height===undefined?hf.heightAt(x,z):height,W=i1-i0+1,copy=new Float32Array(W*(j1-j0+1));
      for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++)copy[(j-j0)*W+i-i0]=d[j*S+i];
      for(let j=j0;j<=j1;j++)for(let i=i0;i<=i1;i++){const a=clamp(strength*w(i,j),0,1);if(!a)continue;let t=target;
        if(mode==='smooth'){let s=0,n=0;for(let b=-1;b<=1;b++)for(let c=-1;c<=1;c++){const ii=i+c,jj=j+b;if(ii<0||jj<0||ii>=S||jj>=S)continue;s+=(ii>=i0&&ii<=i1&&jj>=j0&&jj<=j1)?copy[(jj-j0)*W+ii-i0]:d[jj*S+ii];n++;}t=s/n;}
        const v=copy[(j-j0)*W+i-i0];d[j*S+i]=v+(t-v)*a;}
    }else throw new RangeError('sculpt mode must be raise, lower, smooth or flatten');
    this._heightsChanged(i0,j0,i1,j1);return {i0,j0,i1,j1};
  }
  /* Replace a sample rectangle: values is a Float32Array of width*height heights (row-major, z rows). */
  setHeightRegion(i0,j0,width,height,values){
    const hf=this.heightfield,S=hf.size;if(i0<0||j0<0||i0+width>S||j0+height>S||values.length<width*height)throw new RangeError('setHeightRegion outside the heightfield');
    for(let j=0;j<height;j++)hf.data.set(values.subarray?values.subarray(j*width,j*width+width):Array.prototype.slice.call(values,j*width,j*width+width),(j0+j)*S+i0);
    this._heightsChanged(i0,j0,i0+width-1,j0+height-1);return this;
  }
  _heightsChanged(i0,j0,i1,j1){
    const hf=this.heightfield,S=hf.size,L=this.leafSize,sp=hf.spacing,n=this.leavesPerSide;hf.version++;
    const a0=Math.max(0,i0-1),b0=Math.max(0,j0-1),a1=Math.min(S-1,i1+1),b1=Math.min(S-1,j1+1);
    sampleNormalRGBA(hf,this._normalData,a0,b0,a1+1,b1+1);
    this._buildMinMax(clamp(Math.floor((i0-1)*sp/L),0,n-1),clamp(Math.floor((j0-1)*sp/L),0,n-1),clamp(Math.floor((i1+1)*sp/L),0,n-1),clamp(Math.floor((j1+1)*sp/L),0,n-1));
    const root=this._mm[this.levels-1];hf.minHeight=root[0];hf.maxHeight=root[1];
    const bu=this.biomeTexture&&this.biomeTexture.userData&&this.biomeTexture.userData.update,c0=Math.max(0,i0-3),e0=Math.max(0,j0-3),c1=Math.min(S-1,i1+3),e1=Math.min(S-1,j1+3);
    if(bu)bu(c0,e0,c1+1,e1+1);
    const add=(key,x0,y0,x1,y1)=>{const r=this._dirty||(this._dirty={});const q=r[key];if(!q)r[key]=[x0,y0,x1,y1];else{q[0]=Math.min(q[0],x0);q[1]=Math.min(q[1],y0);q[2]=Math.max(q[2],x1);q[3]=Math.max(q[3],y1);}};
    add('height',i0,j0,i1,j1);add('normal',a0,b0,a1,b1);if(bu)add('biome',c0,e0,c1,e1);
    if(this._renderer)this._flush(this._renderer);
  }
  /* Push queued sub-rectangles with texSubImage2D (renderer.copyTextureToTexture). Without a renderer yet,
     textures are re-uploaded whole on first use. */
  _flush(renderer){
    const dirty=this._dirty;if(!dirty)return;this._dirty=null;const T=this.THREE,S=this.heightfield.size;
    const jobs=[['height',this.heightTexture,this.heightfield.data,1,Float32Array,T.RedFormat,T.FloatType],['normal',this.normalTexture,this._normalData,4,Uint8Array,T.RGBAFormat,T.UnsignedByteType],
      ['biome',this.biomeTexture,this.biomeTexture&&this.biomeTexture.image&&this.biomeTexture.image.data,4,Uint8Array,T.RGBAFormat,T.UnsignedByteType]];
    for(const [key,tex,src,ch,Arr,format,type] of jobs){const r=dirty[key];if(!r||!tex||!src)continue;
      const w=r[2]-r[0]+1,h=r[3]-r[1]+1;
      if(!renderer||!renderer.copyTextureToTexture||w*h>S*S*.5){tex.needsUpdate=true;continue;}
      const buf=new Arr(w*h*ch);for(let j=0;j<h;j++){const o=((r[1]+j)*S+r[0])*ch;buf.set(src.subarray(o,o+w*ch),j*w*ch);}
      const sub=new T.DataTexture(buf,w,h,format,type);sub.flipY=false;renderer.copyTextureToTexture({x:r[0],y:r[1]},sub,tex);}
  }
  /* Rebuild everything after the heightfield was changed outside the terrain (erode, generate, ...). */
  refresh(){const hf=this.heightfield,S=hf.size;hf.recomputeRange();this._buildMinMax(0,0,this.leavesPerSide-1,this.leavesPerSide-1);sampleNormalRGBA(hf,this._normalData,0,0,S,S);
    const bu=this.biomeTexture&&this.biomeTexture.userData&&this.biomeTexture.userData.update;if(bu){bu(0,0,S,S);this.biomeTexture.needsUpdate=true;}
    this.heightTexture.needsUpdate=true;this.normalTexture.needsUpdate=true;this._dirty=null;return this;}
  /* ----- materials ----- */
  /* Makes any Three material draw the terrain patches: injects the CDLOD vertex code and shares the terrain
     uniforms. Chains an existing onBeforeCompile and cache key (so KE.CascadedShadows can patch it later). */
  patchMaterial(m,kind){
    const U=this.uniforms,prev=m.onBeforeCompile,prevKey=m.customProgramCacheKey.bind(m),L=this.levels,decl=TERRAIN_VERT.replace('KE_TERRAIN_LEVELS',String(L));
    const depth=kind==='depth'||m.isMeshDepthMaterial||m.isMeshDistanceMaterial;
    m.onBeforeCompile=(sh,r)=>{if(prev)prev.call(m,sh,r);for(const k in U)sh.uniforms[k]=U[k];
      let v=decl+sh.vertexShader;
      if(!depth&&v.indexOf('#include <beginnormal_vertex>')>=0){v=v.replace('#include <beginnormal_vertex>','keTerrainVertex();\nvec3 objectNormal=keTerrainNrm;\n#ifdef USE_TANGENT\nvec3 objectTangent=vec3(1.,0.,0.);\n#endif');v=replaceOrThrow(v,'#include <begin_vertex>','vec3 transformed=keTerrainPos;','vertex shader');}
      else v=replaceOrThrow(v,'#include <begin_vertex>','keTerrainVertex();\nvec3 transformed=keTerrainPos;','vertex shader');
      sh.vertexShader=v;};
    m.customProgramCacheKey=()=>prevKey()+':ke-cdlod-'+L;m.needsUpdate=true;return m;
  }
  _defaultMaterial(o){
    const T=this.THREE;let tex=o.textures,own=false;if(!tex){tex=KE.materials(T,o.textureSize||Math.min(512,KE.settings.tex||256));own=true;}
    const kinds=KE.MATERIAL_KINDS||['grass','sand','dirt','stone','rock','snow','ash','wood'],pick=k=>Array.isArray(tex)?tex[kinds.indexOf(k)]:tex[k];
    let ha=tex.heightMaps&&tex.heightMaps[0],hb=tex.heightMaps&&tex.heightMaps[1];const gray=[];
    if(!ha||!hb){const g=new T.DataTexture(new Uint8Array([128,128,128,128]),1,1,T.RGBAFormat);g.needsUpdate=true;gray.push(g);ha=ha||g;hb=hb||g;}
    const m=new T.MeshStandardMaterial({roughness:.92,metalness:0});m.name='ke-terrain';m.extensions={derivatives:true};
    m.userData.keTextures=own?[...tex,...tex.heightMaps]:gray;this._materialTextures=own?[...tex,...tex.heightMaps,...gray]:gray;
    const F=this.materialUniforms={keBiome:{value:this.biomeTexture},keHA:{value:ha},keTHTexel:{value:2/((ha.image&&ha.image.width>1)?ha.image.width:512)},keHB:{value:hb},keTGrass:{value:pick('grass')},keTSand:{value:pick('sand')},keTDirt:{value:pick('dirt')},keTRock:{value:pick('rock')},keTSnow:{value:pick('snow')},
      keTexScale:{value:o.textureScale||.3},keFarScale:{value:o.farScale||.2},keRelief:{value:o.relief===undefined?.32:o.relief},keWaterLevel:{value:this.waterLevel},keMacro:{value:o.macro===undefined?1:o.macro},keGrassTint:{value:new THREE.Vector3(...(Array.isArray(o.grassTint)?o.grassTint:[1,1,1]))}};
    for(const k of ['keTGrass','keTSand','keTDirt','keTRock','keTSnow'])if(!F[k].value)throw new Error('KE.GPUTerrain: textures missing '+k.slice(3).toLowerCase());
    m.onBeforeCompile=sh=>{for(const k in F)sh.uniforms[k]=F[k];
      let f=TERRAIN_FRAG_DECL+KE.GLSL.hash+'\n'+KE.GLSL.noise+'\n'+sh.fragmentShader;
      f=replaceOrThrow(f,'#include <map_fragment>',TERRAIN_MAP,'fragment shader');
      f=replaceOrThrow(f,'#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\n'+TERRAIN_ROUGH,'fragment shader');
      f=replaceOrThrow(f,'#include <normal_fragment_maps>','#include <normal_fragment_maps>\n'+TERRAIN_NORMAL,'fragment shader');
      sh.fragmentShader=f;};
    m.customProgramCacheKey=()=>'ke-terrain-default-1';
    return this.patchMaterial(m);
  }
  /* Debug views: 'lod' (colour per LOD level, morph shown as a blend), 'wireframe' (the same plus triangle
     edges), 'height' (unlit world height in the red channel, for float render targets), or null. */
  setDebug(mode){
    if(!mode){this.mesh.material=this.material;this.debug=null;return this;}
    const T=this.THREE,M={lod:0,wireframe:1,height:2}[mode];if(M===undefined)throw new RangeError('debug mode must be lod, wireframe, height or null');
    if(!this._debugMaterial){const U=this.uniforms;this._debugMaterial=new T.ShaderMaterial({uniforms:{...U,keDebugMode:{value:0}},extensions:{derivatives:true},
      vertexShader:TERRAIN_VERT.replace('KE_TERRAIN_LEVELS',String(this.levels))+'varying vec3 keTN;varying float keTSk;void main(){keTerrainVertex();keTN=keTerrainNrm;keTSk=position.y;gl_Position=projectionMatrix*viewMatrix*vec4(keTWorld,1.);}',
      fragmentShader:`uniform float keDebugMode;varying vec3 keTWorld;varying float keTLod;varying vec2 keTGrid;varying vec3 keTN;varying float keTSk;
vec3 keLodColor(float l){l=mod(l,8.);return l<1.?vec3(.95,.3,.25):l<2.?vec3(.98,.65,.2):l<3.?vec3(.95,.9,.3):l<4.?vec3(.35,.85,.35):l<5.?vec3(.25,.8,.85):l<6.?vec3(.3,.45,.95):l<7.?vec3(.65,.4,.95):vec3(.9,.45,.8);}
void main(){if(keDebugMode>1.5){gl_FragColor=vec4(keTWorld.y,0.,0.,1.);return;}
float l=floor(keTLod);vec3 c=mix(keLodColor(l),keLodColor(l+1.),smoothstep(.0,1.,keTLod-l));
float sh=.35+.65*max(dot(normalize(keTN),normalize(vec3(.45,.8,.35))),0.);c*=sh;
if(keDebugMode>.5){vec3 g=vec3(keTGrid,keTGrid.x+keTGrid.y);vec3 dd=abs(fract(g+.5)-.5);vec3 fw=max(fwidth(g),vec3(1e-4));vec3 a=smoothstep(fw*.5,fw*1.5,dd);
  float dense=max(smoothstep(.25,.6,max(fw.x,fw.y)),step(.001,keTSk));c*=mix(mix(.22,1.,min(a.x,min(a.y,a.z))),.8,dense);}
gl_FragColor=vec4(c,1.);
#include <encodings_fragment>
}`});}
    this._debugMaterial.uniforms.keDebugMode.value=M;this.mesh.material=this._debugMaterial;this.debug=mode;return this;
  }
  stats(){const s=this._stats;return {patches:s.patches,drawCalls:s.patches?1:0,triangles:s.triangles,nodesVisited:s.visited,culled:s.culled,levels:this.levels,levelCounts:s.levelCounts.slice(),
    leafSize:this.leafSize,vertexSpacing:this.vertexSpacing,gridResolution:this.gridResolution,ranges:Array.from(this.ranges),selectionMs:s.selectionMs,capacity:this._capacity};}
  dispose(){
    const m=this.mesh;m.parent&&m.parent.remove(m);this.geometry.dispose();this.heightTexture.dispose();this.normalTexture.dispose();if(this._ownBiomes&&this.biomeTexture)this.biomeTexture.dispose();
    if(this._ownMaterial)this.material.dispose();m.customDepthMaterial.dispose();m.customDistanceMaterial.dispose();if(this._debugMaterial)this._debugMaterial.dispose();
    for(const t of this._materialTextures||[])t.dispose();this._materialTextures=null;this._dirty=null;
  }
}
GPUTerrain.GLSL={vertex:TERRAIN_VERT,relief:TERRAIN_RELIEF};
KE.GPUTerrain=GPUTerrain;

/* ---------- World partition ----------
   The world is a grid of square cells. Every update(): cells whose nearest point lies within loadRadius are
   wanted; loaded cells beyond unloadRadius (hysteresis) are unloaded; in-flight loads beyond it are
   cancelled. New loads start nearest-first (distance measured from the position extrapolated by velocity *
   prefetch) while the frame budget lasts and at most maxConcurrent asynchronous loads are in flight.
   load(cell, ctx) may return a value (synchronous), a Promise, or an iterator/generator that is stepped
   under the budget (through `jobs`, a KE.Jobs queue, when given). A cell never has two loads at once and a
   loaded cell is never loaded again. Cells out of load range but within hlodRadius show a proxy from
   hlod(cell) (e.g. a merged low-poly mesh); a proxy stays until its cell has finished loading, so no holes
   appear while streaming. */
const cellKey=(ix,iz)=>((ix+32768)&0xffff)*65536+((iz+32768)&0xffff);
const isIterator=v=>!!v&&typeof v.next==='function'&&typeof v[Symbol.iterator]==='function';
class WorldPartition{
  constructor(o={}){
    this.cellSize=o.cellSize||128;this.loadRadius=o.loadRadius===undefined?this.cellSize*3:o.loadRadius;this.unloadRadius=Math.max(this.loadRadius,o.unloadRadius===undefined?this.loadRadius+this.cellSize*.5:o.unloadRadius);
    this.load=o.load||null;this.unload=o.unload||null;this.hlod=o.hlod||null;this.hlodUnload=o.hlodUnload||null;
    this.hlodRadius=this.hlod?Math.max(this.loadRadius,o.hlodRadius===undefined?this.loadRadius*3:o.hlodRadius):0;
    this.hlodUnloadRadius=this.hlod?Math.max(this.hlodRadius,o.hlodUnloadRadius===undefined?this.hlodRadius+(this.unloadRadius-this.loadRadius):o.hlodUnloadRadius):0;
    this.budgetMs=o.budgetMs===undefined?2:o.budgetMs;this.maxConcurrent=o.maxConcurrent||4;this.jobs=o.jobs||null;this.runJobs=o.runJobs!==false;
    this.originX=o.originX||0;this.originZ=o.originZ||0;this.bounds=o.bounds||null;this.filter=o.filter||null;this.prefetch=o.prefetch===undefined?.5:o.prefetch;
    this.retryDelay=o.retryDelay===undefined?2:o.retryDelay;this.onError=o.onError||(e=>console.warn('KE.WorldPartition: cell load failed',e));
    this.cells=new Map();this.position={x:0,y:0,z:0};this.velocity={x:0,z:0};this._last=null;this._time=0;
    this._active=[];this._cand=[];this._inflight=0;this.disposed=false;
    this.counters={started:0,completed:0,cancelled:0,unloaded:0,failed:0,discarded:0,hlodCreated:0,hlodRemoved:0,doubleLoads:0};this._ms=0;this._maxMs=0;
    this._byPriority=(a,b)=>a._prio-b._prio||a.key-b.key;
  }
  cellAt(x,z){return this.cells.get(cellKey(Math.floor((x-this.originX)/this.cellSize),Math.floor((z-this.originZ)/this.cellSize)))||null;}
  _record(ix,iz){const key=cellKey(ix,iz);let c=this.cells.get(key);if(c)return c;const s=this.cellSize,x=this.originX+ix*s,z=this.originZ+iz*s;
    c={key,ix,iz,x,z,size:s,cx:x+s/2,cz:z+s/2,state:'unloaded',data:undefined,proxy:undefined,distance:0,loads:0,error:null,retryAt:0,task:null,_prio:0};this.cells.set(key,c);return c;}
  _allowed(ix,iz){const s=this.cellSize,x=this.originX+ix*s,z=this.originZ+iz*s,b=this.bounds;
    if(b&&(x+s<=b.minX||x>=b.maxX||z+s<=b.minZ||z>=b.maxZ))return false;return !this.filter||!!this.filter(ix,iz);}
  _distance(c,px,pz){const dx=Math.max(c.x-px,0,px-(c.x+c.size)),dz=Math.max(c.z-pz,0,pz-(c.z+c.size));return Math.sqrt(dx*dx+dz*dz);}
  /* position: {x,z} (Vector3 fine). dt: seconds since the last update (used for prefetch ordering).
     budgetMs overrides the configured budget for this call (Infinity loads everything synchronous now). */
  update(position,dt=0,budgetMs=this.budgetMs){
    if(this.disposed)return this;const t0=performance.now(),end=t0+budgetMs,px=position.x,pz=position.z;this._time+=dt;
    if(this._last&&dt>0){const k=1-Math.exp(-dt*4);this.velocity.x+=((px-this._last.x)/dt-this.velocity.x)*k;this.velocity.z+=((pz-this._last.z)/dt-this.velocity.z)*k;}
    this._last=this._last||{x:0,z:0};this._last.x=px;this._last.z=pz;this.position.x=px;this.position.y=position.y||0;this.position.z=pz;
    const qx=px+this.velocity.x*this.prefetch,qz=pz+this.velocity.z*this.prefetch;
    // 1. retire: unload / cancel / drop proxies beyond hysteresis radii
    for(const c of this.cells.values()){const d=c.distance=this._distance(c,px,pz);
      if(d>this.unloadRadius){
        if(c.state==='loaded'){if(this.hlod&&d<=this.hlodRadius&&c.proxy===undefined)this._makeProxy(c);this._unloadCell(c);}
        else if(c.state==='loading')this._cancel(c);
      }
      if(c.proxy!==undefined&&(d>this.hlodUnloadRadius||c.state==='loaded'))this._dropProxy(c);
      if(c.state==='unloaded'||c.state==='failed'){if(c.proxy===undefined&&d>Math.max(this.unloadRadius,this.hlodUnloadRadius))this.cells.delete(c.key);}
    }
    // 2. candidates: wanted cells not loaded or in flight, nearest (extrapolated) first
    const R=Math.max(this.loadRadius,this.hlodRadius),s=this.cellSize,cand=this._cand;cand.length=0;
    const ix0=Math.floor((px-R-this.originX)/s),ix1=Math.floor((px+R-this.originX)/s),iz0=Math.floor((pz-R-this.originZ)/s),iz1=Math.floor((pz+R-this.originZ)/s);
    for(let iz=iz0;iz<=iz1;iz++)for(let ix=ix0;ix<=ix1;ix++){
      const x=this.originX+ix*s,z=this.originZ+iz*s,dx=Math.max(x-px,0,px-(x+s)),dz=Math.max(z-pz,0,pz-(z+s)),d=Math.sqrt(dx*dx+dz*dz);
      if(d>R||!this._allowed(ix,iz))continue;
      const existing=this.cells.get(cellKey(ix,iz)),st=existing?existing.state:'unloaded';
      const needLoad=!!this.load&&d<=this.loadRadius&&(st==='unloaded'||(st==='failed'&&this._time>=existing.retryAt));
      const needProxy=!!this.hlod&&st!=='loaded'&&(!existing||existing.proxy===undefined);
      if(!needLoad&&!needProxy)continue;
      const c=existing||this._record(ix,iz);c.distance=d;c._prio=Math.hypot(c.cx-qx,c.cz-qz);c._needLoad=needLoad;cand.push(c);
    }
    cand.sort(this._byPriority);
    // 3. start loads nearest-first within budget and concurrency; then HLOD proxies with what is left
    let started=0;
    for(const c of cand){if(!c._needLoad)continue;if(started>0&&performance.now()>=end)break;if(this._inflight>=this.maxConcurrent)break;this._start(c);started++;}
    // proxies also cover wanted cells whose load is still queued or in flight, so streaming leaves no holes
    if(this.hlod)for(const c of cand){if(c.proxy!==undefined||c.state==='loaded')continue;if(started>0&&performance.now()>=end)break;this._makeProxy(c);started++;}
    // 4. step iterator loads within the remaining budget
    if(this.jobs){if(this.runJobs)this.jobs.run(Math.max(0,end-performance.now()));}
    else this._pump(end);
    this._ms=performance.now()-t0;this._maxMs=Math.max(this._maxMs*.99,this._ms);return this;
  }
  _start(c){
    if(c.state==='loaded'||c.state==='loading'||c.state==='cancelling'){this.counters.doubleLoads++;return;}
    const ctx={signal:{aborted:false},partition:this,cellSize:this.cellSize};c.state='loading';c.loads++;c.error=null;this.counters.started++;
    let r;try{r=this.load(c,ctx);}catch(e){this._fail(c,e);return;}
    if(isIterator(r)){this._inflight++;const task={iter:r,ctx,cell:c,promise:null};c.task=task;
      if(this.jobs){task.promise=this.jobs.add(r,{priority:-c.distance,name:'world.cell'});task.promise.then(v=>{if(c.task===task)this._finish(c,v);},e=>{if(c.task===task)this._fail(c,e);});}
      else this._active.push(task);return;}
    if(r&&typeof r.then==='function'){this._inflight++;const task={promise:r,ctx,cell:c};c.task=task;
      r.then(v=>{if(c.task!==task)return;if(c.state==='cancelling'){this._inflight--;c.task=null;c.state='unloaded';this.counters.discarded++;if(this.unload)this.unload(c,v);return;}this._finish(c,v);},
        e=>{if(c.task!==task)return;if(c.state==='cancelling'){this._inflight--;c.task=null;c.state='unloaded';return;}this._fail(c,e);});return;}
    this._finish(c,r,true);
  }
  _finish(c,v,sync){if(!sync){this._inflight--;}c.task=null;
    if(this.disposed){if(this.unload)this.unload(c,v);return;}
    c.state='loaded';c.data=v;this.counters.completed++;if(c.proxy!==undefined)this._dropProxy(c);}
  _fail(c,e){if(c.task)this._inflight--;c.task=null;c.state='failed';c.error=e;c.retryAt=this._time+this.retryDelay;this.counters.failed++;this.onError(e,c);}
  _cancel(c){const t=c.task;if(!t)return;this.counters.cancelled++;t.ctx.signal.aborted=true;
    if(t.iter){c.task=null;this._inflight--;c.state='unloaded';if(t.promise&&t.promise.cancel){t.promise.cancel();t.promise.catch(()=>{});}
      const i=this._active.indexOf(t);if(i>=0)this._active.splice(i,1);try{t.iter.return&&t.iter.return();}catch(e){}}
    else c.state='cancelling';// a promise cannot be stopped: its result is unloaded when it settles
  }
  _unloadCell(c){const v=c.data;c.data=undefined;c.state='unloaded';this.counters.unloaded++;if(this.unload)this.unload(c,v);}
  _makeProxy(c){let p;try{p=this.hlod(c);}catch(e){this.onError(e,c);p=null;}c.proxy=p===undefined?null:p;this.counters.hlodCreated++;}
  _dropProxy(c){const p=c.proxy;c.proxy=undefined;this.counters.hlodRemoved++;if(this.hlodUnload)this.hlodUnload(c,p);else if(p){if(typeof p.dispose==='function')p.dispose();else if(p.isObject3D&&p.parent)p.parent.remove(p);}}
  /* Round-robin by priority: the nearest active iterator is stepped until the budget ends or it finishes. */
  _pump(end){const a=this._active;if(!a.length)return;a.sort((x,y)=>x.cell._prio-y.cell._prio);
    while(a.length&&performance.now()<end){const t=a[0];let r;try{r=t.iter.next();}catch(e){a.shift();this._fail(t.cell,e);continue;}if(r.done){a.shift();this._finish(t.cell,r.value);}}}
  /* True when every wanted cell around position has finished loading. */
  isReady(position){const px=position.x,pz=position.z,s=this.cellSize,R=this.loadRadius;
    for(let iz=Math.floor((pz-R-this.originZ)/s);iz<=Math.floor((pz+R-this.originZ)/s);iz++)for(let ix=Math.floor((px-R-this.originX)/s);ix<=Math.floor((px+R-this.originX)/s);ix++){
      const x=this.originX+ix*s,z=this.originZ+iz*s,d=Math.hypot(Math.max(x-px,0,px-(x+s)),Math.max(z-pz,0,pz-(z+s)));if(d>R||!this._allowed(ix,iz))continue;const c=this.cells.get(cellKey(ix,iz));if(!c||c.state!=='loaded')return false;}
    return true;}
  /* Load everything around position (e.g. after a teleport) ignoring the budget; resolves when ready. */
  async preload(position,{timeoutMs=30000}={}){const t0=performance.now();for(;;){this.update(position,0,Infinity);if(this.isReady(position))return this;if(performance.now()-t0>timeoutMs)throw new Error('KE.WorldPartition.preload timed out');await new Promise(r=>setTimeout(r,0));}}
  stats(){let loaded=0,loading=0,cancelling=0,hlod=0,failedCells=0;for(const c of this.cells.values()){if(c.state==='loaded')loaded++;else if(c.state==='loading')loading++;else if(c.state==='cancelling')cancelling++;else if(c.state==='failed')failedCells++;if(c.proxy!==undefined)hlod++;}
    return {cells:this.cells.size,loaded,loading,cancelling,failedCells,hlod,pending:this._cand.length,inflight:this._inflight,...this.counters,ms:this._ms,maxMs:this._maxMs};}
  dispose(){if(this.disposed)return;for(const c of this.cells.values()){if(c.state==='loading')this._cancel(c);if(c.state==='loaded')this._unloadCell(c);if(c.proxy!==undefined)this._dropProxy(c);}
    this.disposed=true;this._active.length=0;this.cells.clear();}
}
KE.WorldPartition=WorldPartition;

/* ---------- deterministic per-cell scatter ----------
   Candidate points sit on a global jittered lattice (one point per spacing x spacing square, jitter from a
   hash of the square's integer coordinates and the seed), and a cell keeps the points inside its bounds.
   The result therefore depends only on (seed, cell) and neighbouring cells tile without seams or overlap,
   whatever order they stream in. Each point draws acceptance, type, yaw, tilt and scale from its own hash. */
function scatterCell(THREE,o={}){
  const cs=o.cellSize||(o.cell&&o.cell.size)||128,cell=o.cell||{ix:0,iz:0};
  const x0=cell.x!==undefined?cell.x:(o.originX||0)+cell.ix*cs,z0=cell.z!==undefined?cell.z:(o.originZ||0)+cell.iz*cs;
  const src=o.heightfield||o.terrain;if(!src||typeof src.heightAt!=='function')throw new TypeError('scatterCell needs {heightfield} (or anything with heightAt)');
  const types=o.types||[];if(!types.length)throw new TypeError('scatterCell needs at least one type {geometry, material}');
  const spacing=Math.max(.05,o.spacing||4),seed=(o.seed===undefined?1:o.seed)>>>0,density=o.density===undefined?1:o.density,water=o.waterLevel;
  const gi0=Math.floor(x0/spacing),gi1=Math.ceil((x0+cs)/spacing),gj0=Math.floor(z0/spacing),gj1=Math.ceil((z0+cs)/spacing);
  const buckets=types.map(()=>[]),nrm={x:0,y:1,z:0};let wsum=0;for(const t of types)wsum+=t.weight===undefined?1:t.weight;
  const m=new THREE.Matrix4(),q=new THREE.Quaternion(),qy=new THREE.Quaternion(),qa=new THREE.Quaternion(),up=new THREE.Vector3(0,1,0),n=new THREE.Vector3(),p=new THREE.Vector3(),sc=new THREE.Vector3();
  for(let gj=gj0;gj<gj1;gj++)for(let gi=gi0;gi<gi1;gi++){
    let st=hashInts(seed,gi,gj);const rnd=()=>{st=(st+0x6D2B79F5)>>>0;let t=st;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
    const x=(gi+rnd())*spacing,z=(gj+rnd())*spacing;if(x<x0||x>=x0+cs||z<z0||z>=z0+cs)continue;
    const dens=typeof density==='function'?density(x,z):density,u=rnd();if(!(u<dens))continue;
    const y=src.heightAt(x,z);if(water!==undefined&&y<water)continue;
    const slope=src.slopeAt?src.slopeAt(x,z):0;
    let pick=rnd()*wsum,ti=-1;for(let k=0;k<types.length;k++){pick-=types[k].weight===undefined?1:types[k].weight;if(pick<=0){ti=k;break;}}if(ti<0)ti=types.length-1;
    const t=types[ti],sl=t.slope||[0,Infinity],hr=t.height||[-Infinity,Infinity];
    const r1=rnd(),r2=rnd(),r3=rnd();
    if(slope<sl[0]||slope>sl[1]||y<hr[0]||y>hr[1])continue;
    if(t.density!==undefined&&!(r3<t.density))continue;
    if(o.filter&&!o.filter(x,y,z,ti,slope))continue;
    const sr=t.scale||[.8,1.2],s=sr[0]+(sr[1]-sr[0])*r1;
    qy.setFromAxisAngle(up,r2*Math.PI*2);
    if(t.align&&src.normalAt){src.normalAt(x,z,nrm);n.set(nrm.x,nrm.y,nrm.z);qa.setFromUnitVectors(up,n);q.identity().slerp(qa,clamp(t.align,0,1)).multiply(qy);}else q.copy(qy);
    p.set(x,y-(t.sink||0)*s,z);sc.set(s,s,s);if(t.scaleY)sc.y*=t.scaleY;m.compose(p,q,sc);buckets[ti].push(...m.elements);
  }
  const group=new THREE.Group();group.name='ke-scatter-'+(cell.ix!==undefined?cell.ix+'_'+cell.iz:x0+'_'+z0);let total=0;
  types.forEach((t,k)=>{const arr=buckets[k],count=arr.length/16;if(!count)return;const base=t.geometry;if(!base.boundingSphere)base.computeBoundingSphere();
    // A per-cell view of the shared geometry (same attribute objects, no copies) that carries the cell's
    // bounding sphere, so Three's frustum culling works per cell.
    const g=new THREE.BufferGeometry();g.setIndex(base.index);for(const a in base.attributes)g.setAttribute(a,base.attributes[a]);g.groups=base.groups;
    let mnx=Infinity,mny=Infinity,mnz=Infinity,mxx=-Infinity,mxy=-Infinity,mxz=-Infinity,ms=0;
    for(let i=0;i<count;i++){const e=i*16,px=arr[e+12],py=arr[e+13],pz=arr[e+14],s=Math.hypot(arr[e],arr[e+1],arr[e+2]),sy=Math.hypot(arr[e+4],arr[e+5],arr[e+6]);ms=Math.max(ms,s,sy);
      if(px<mnx)mnx=px;if(py<mny)mny=py;if(pz<mnz)mnz=pz;if(px>mxx)mxx=px;if(py>mxy)mxy=py;if(pz>mxz)mxz=pz;}
    const bs=base.boundingSphere;g.boundingSphere=new THREE.Sphere(new THREE.Vector3((mnx+mxx)/2,(mny+mxy)/2,(mnz+mxz)/2),Math.hypot(mxx-mnx,mxy-mny,mxz-mnz)/2+(bs.center.length()+bs.radius)*ms);
    const mesh=new THREE.InstancedMesh(g,t.material,count);mesh.instanceMatrix.array.set(arr);mesh.instanceMatrix.needsUpdate=true;
    mesh.castShadow=t.castShadow!==undefined?t.castShadow:!!o.castShadow;mesh.receiveShadow=t.receiveShadow!==undefined?t.receiveShadow:o.receiveShadow!==false;mesh.name=t.name||('type'+k);mesh.userData.typeIndex=k;
    group.add(mesh);total+=count;});
  group.userData.count=total;group.userData.cell={x:x0,z:z0,size:cs};
  /* Releases this cell's instance buffers and VAOs without touching the shared geometry buffers: the view's
     attribute table is emptied before dispose() so Three frees only what belongs to the cell. */
  group.userData.dispose=()=>{for(const mesh of group.children.slice()){const g=mesh.geometry;g.index=null;g.attributes={};g.dispose();mesh.dispose&&mesh.dispose();group.remove(mesh);}group.parent&&group.parent.remove(group);};
  return group;
}
KE.scatterCell=scatterCell;


KE.registerModule('world',{provides:['Heightfield','GPUTerrain','WorldPartition','scatterCell','noise2D']});
})();
