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
   evaluation is left in noise.d[0..1] (used by the derivative-damped "eroded" fbm). */
function makeNoise(seed){
  const rnd=KE.random((seed>>>0)||1),p=new Uint8Array(256),perm=new Uint8Array(512),gx=new Float64Array(256),gy=new Float64Array(256);
  for(let i=0;i<256;i++)p[i]=i;
  for(let i=255;i>0;i--){const j=Math.floor(rnd()*(i+1)),t=p[i];p[i]=p[j];p[j]=t;}
  for(let i=0;i<512;i++)perm[i]=p[i&255];
  for(let i=0;i<256;i++){const a=rnd()*Math.PI*2;gx[i]=Math.cos(a)*1.4142;gy[i]=Math.sin(a)*1.4142;}
  const D=new Float64Array(2);
  const noise=(x,y)=>{
    const fx=Math.floor(x),fy=Math.floor(y),u=x-fx,v=y-fy,X=fx&255,Y=fy&255,A=perm[X]+Y,B=perm[X+1]+Y;
    const a=perm[A],c=perm[A+1],b=perm[B],d=perm[B+1];
    const gax=gx[a],gay=gy[a],gbx=gx[b],gby=gy[b],gcx=gx[c],gcy=gy[c],gdx=gx[d],gdy=gy[d];
    const va=gax*u+gay*v,vb=gbx*(u-1)+gby*v,vc=gcx*u+gcy*(v-1),vd=gdx*(u-1)+gdy*(v-1);
    const su=u*u*u*(u*(u*6-15)+10),sv=v*v*v*(v*(v*6-15)+10),dsu=30*u*u*(u*(u-2)+1),dsv=30*v*v*(v*(v-2)+1);
    const k1=vb-va,k2=vc-va,k3=va-vb-vc+vd;
    D[0]=gax+(gbx-gax)*su+(gcx-gax)*sv+(gax-gbx-gcx+gdx)*su*sv+dsu*(k1+k3*sv);
    D[1]=gay+(gby-gay)*su+(gcy-gay)*sv+(gay-gby-gcy+gdy)*su*sv+dsv*(k2+k3*su);
    return va+k1*su+k2*sv+k3*su*sv;
  };
  noise.d=D;return noise;
}
/* Octaves are rotated ~37 degrees and doubled (matrix [1.6 -1.2; 1.2 1.6]) so lattice axes never line up. */
function fbm(noise,x,y,octaves){let s=0,a=1,n=0;for(let o=0;o<octaves;o++){s+=a*noise(x,y);n+=a;a*=.5;const nx=1.6*x-1.2*y+17.3,ny=1.2*x+1.6*y-9.1;x=nx;y=ny;}return s/n;}
/* Derivative-damped fbm (after Inigo Quilez): octaves are suppressed where the accumulated slope is steep,
   which reads like eroded, flat-floored valleys with sharp detail only on gentle ground. */
function erodedFbm(noise,x,y,octaves,damping){let s=0,a=1,n=0,dx=0,dy=0;const D=noise.d;
  for(let o=0;o<octaves;o++){const v=noise(x,y);dx+=D[0];dy+=D[1];s+=a*v/(1+damping*(dx*dx+dy*dy));n+=a;a*=.5;const nx=1.6*x-1.2*y+31.7,ny=1.2*x+1.6*y+4.3;x=nx;y=ny;}
  return s/n;}
/* Ridged multifractal (Musgrave): sharp crest lines; each octave is weighted by the previous signal so
   detail concentrates on the ridges. Returns [0,1]. */
function ridgedFbm(noise,x,y,octaves){let s=0,a=1,n=0,w=1;
  for(let o=0;o<octaves;o++){let v=1-Math.abs(noise(x,y));v*=v;v*=w;w=clamp(v*1.8,0,1);s+=v*a;n+=a;a*=.5;const nx=1.6*x-1.2*y-7.9,ny=1.2*x+1.6*y+13.1;x=nx;y=ny;}
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
    if(warp>0){const wx=fbm(nW1,px*.8+3.1,pz*.8-1.7,4),wz=fbm(nW2,px*.8-5.3,pz*.8+2.9,4);px+=warp*wx*1.5;pz+=warp*wz*1.5;}
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
    tex.userData.keHeightfield=info;tex.name='ke-heightfield';return tex;
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
Heightfield.generate=(o={})=>{
  const size=o.size||1024,worldSize=o.worldSize||2048;
  const hf=new Heightfield({size,worldSize,originX:o.originX,originZ:o.originZ});
  const fn=terrainFunction({...o,worldSize,centerX:hf.originX+worldSize/2,centerZ:hf.originZ+worldSize/2}),steps=generateSteps(o,hf,fn);
  if(o.jobs)return o.jobs.add(steps,{name:'heightfield.generate',priority:o.priority||0});
  let r;do r=steps.next();while(!r.done);return hf;
};

/* ---------- hydraulic erosion ----------
   Droplet simulation after Hans Theobald Beyer, "Implementation of a method for hydraulic erosion" (2015),
   in the widely used form popularised by Sebastian Lague. Each droplet follows the bilinear gradient with
   inertia, picks up sediment up to a capacity proportional to speed, water and downhill drop, erodes with a
   radial brush and deposits bilinearly when over capacity or moving uphill. Heights are normalised by the
   field's height range while simulating so the parameters behave the same for any world scale. Sediment still
   carried when a droplet evaporates is dropped where it dies (only droplets leaving the map lose material),
   and the field keeps masks.flow (droplet visits per sample) and masks.delta (signed height change). */
function* erodeSteps(hf,o){
  const S=hf.size,N=S*S,src=hf.data,lo=hf.minHeight,H=o.heightScale||Math.max(1e-6,hf.maxHeight-hf.minHeight);
  const iterations=Math.max(0,Math.round(o.iterations===undefined?80000:o.iterations)),rnd=KE.random((o.seed===undefined?1:o.seed)>>>0);
  const inertia=o.inertia===undefined?.05:o.inertia,capacityF=o.capacity===undefined?4:o.capacity,minCap=o.minCapacity===undefined?.001:o.minCapacity;
  const erodeS=o.erosion===undefined?.3:o.erosion,depositS=o.deposition===undefined?.3:o.deposition,evap=o.evaporation===undefined?.01:o.evaporation;
  const gravity=o.gravity===undefined?4:o.gravity,life=Math.round(o.lifetime||clamp(30*Math.sqrt(S/256),30,90)),radius=Math.max(1,o.radius===undefined?3:o.radius);
  const map=new Float32Array(N);for(let i=0;i<N;i++)map[i]=(src[i]-lo)/H;
  const flow=o.masks===false?null:(hf.masks&&hf.masks.flow&&hf.masks.flow.length===N?hf.masks.flow:new Float32Array(N));
  // radial brush: offsets and weights max(0, r - d) normalised; clipped at the borders and renormalised there
  const brush=r=>{const R=Math.ceil(r),bo=[],bw=[];let sum=0;for(let y=-R;y<=R;y++)for(let x=-R;x<=R;x++){const d=Math.hypot(x,y);if(d<r){bo.push(x,y);bw.push(r-d);sum+=r-d;}}return {R,n:bw.length,w:new Float32Array(bw.map(w=>w/sum)),o:new Int32Array(bo)};};
  const eb=brush(radius),db=o.depositRadius===0?null:brush(Math.max(1.01,o.depositRadius===undefined?radius:o.depositRadius));
  const R=eb.R,BN=eb.n,BW=eb.w,BO=eb.o;
  // deposition: bilinear (as in the reference) or, by default, a small radial brush which avoids single-sample spikes
  const deposit=(nx,ny,cx,cy,amount)=>{if(amount<=0)return;const idx=ny*S+nx;
    if(!db||nx<db.R||ny<db.R||nx>=S-1-db.R||ny>=S-1-db.R){depositAt(map,S,idx,cx,cy,amount);return;}
    for(let b=0;b<db.n;b++)map[idx+db.o[b*2+1]*S+db.o[b*2]]+=amount*db.w[b];};
  const batch=o.batch||2000,dumpEnd=o.conserve!==false;let lost=0,eroded=0;
  for(let it=0;it<iterations;it++){
    let px=rnd()*(S-1),py=rnd()*(S-1),dx=0,dy=0,speed=1,water=1,sediment=0;
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
  // optional mass-conserving 3x3 blur of the height change: removes droplet-scale speckle, keeps channels
  const passes=o.smoothing===undefined?2:Math.max(0,o.smoothing|0);
  if(passes){const ch=new Float32Array(N),tmp=new Float32Array(N);for(let i=0;i<N;i++)ch[i]=map[i]-(src[i]-lo)/H;
    for(let p=0;p<passes;p++){tmp.fill(0);for(let y=0;y<S;y++)for(let x=0;x<S;x++){const v=ch[y*S+x];if(v===0)continue;
      let wsum=0;for(let b=-1;b<=1;b++)for(let a=-1;a<=1;a++){const xx=x+a,yy=y+b;if(xx>=0&&yy>=0&&xx<S&&yy<S)wsum+=(a?1:2)*(b?1:2);}
      for(let b=-1;b<=1;b++)for(let a=-1;a<=1;a++){const xx=x+a,yy=y+b;if(xx>=0&&yy>=0&&xx<S&&yy<S)tmp[yy*S+xx]+=v*(a?1:2)*(b?1:2)/wsum;}}ch.set(tmp);}
    for(let i=0;i<N;i++)map[i]=(src[i]-lo)/H+ch[i];yield 1;}
  const delta=o.masks===false?null:(hf.masks&&hf.masks.delta&&hf.masks.delta.length===N?hf.masks.delta:new Float32Array(N));
  for(let i=0;i<N;i++){const v=map[i]*H+lo;if(delta)delta[i]+=v-src[i];src[i]=v;}
  if(flow||delta)hf.masks={...(hf.masks||{}),flow,delta};
  const cell=hf.spacing*hf.spacing;hf.erosionStats={droplets:iterations,erodedVolume:eroded*H*cell,lostVolume:lost*H*cell,lifetime:life};
  hf.recomputeRange();hf.version++;return hf;
}
function depositAt(map,S,idx,cx,cy,amount){if(amount<=0)return;map[idx]+=amount*(1-cx)*(1-cy);map[idx+1]+=amount*cx*(1-cy);map[idx+S]+=amount*(1-cx)*cy;map[idx+S+1]+=amount*cx*cy;}
Heightfield.erode=(hf,o={})=>{const steps=erodeSteps(hf,o);if(o.jobs)return o.jobs.add(steps,{name:'heightfield.erode',priority:o.priority||0});let r;do r=steps.next();while(!r.done);return hf;};

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
    dirt:o.dirt===undefined?1:o.dirt,sand:o.sand===undefined?1:o.sand,snow:o.snow===undefined?1:o.snow,rock:o.rock===undefined?1:o.rock};
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
    const snow=smooth(ctx.snowLine-ctx.range*.03,ctx.snowLine+ctx.range*.05,snowH)*(1-smooth(.55,1.1,slope))*ctx.snow;
    const beach=ctx.water+ctx.beach*(1+n2*.8);
    const sand=(1-smooth(beach-ctx.beach*.4,beach+ctx.beach*.6,h))*(1-smooth(.35,.7,slope))*ctx.sand;
    const dry=clamp((-mn-.04)*3.2,0,1),alp=smooth(ctx.alpine-ctx.range*.04,ctx.alpine+ctx.range*.08,h+n2*ctx.range*.04);
    let dirt=clamp(fl*.8+dep*.35+dry*(.35+smooth(.15,.45,slope)*.4)+alp*(.25+smooth(.25,.55,slope)*.4)+smooth(.4,.62,slope)*.2+Math.max(0,curv)*.3,0,1)*ctx.dirt;
    let rem=1;const wr=rock*rem;rem-=wr;const wsn=snow*rem;rem-=wsn;const ws=sand*rem;rem-=ws;const wd=dirt*rem;rem-=wd;const wg=Math.max(0,rem);
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
  t.userData={kind:'ke-biomes',layers:['grass','sand','rock','snow','dirt'],size:s,update:(i0=0,j0=0,i1=s,j1=s)=>{computeBiomes(hf,biomeContext(hf,o),data,Math.max(0,i0),Math.max(0,j0),Math.min(s,i1),Math.min(s,j1));}};
  return t;
};
KE.Heightfield=Heightfield;
KE.noise2D=(seed=1)=>{const n=makeNoise(seed);return (x,y)=>n(x,y);};

/*__GPU_TERRAIN__*/

KE.registerModule('world',{provides:['Heightfield','GPUTerrain','WorldPartition','scatterCell','noise2D']});
})();
