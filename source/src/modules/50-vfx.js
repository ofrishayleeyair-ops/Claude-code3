/* kitsune enginev3 · KE.VFX — modular emitter-based particle system.
   GPU path (WebGL2 + renderable float textures): each emitter keeps its particle state in two RGBA32F
   ping-pong render-target pairs (position.xyz+age, velocity.xyz+life). Two full-screen passes per frame
   advance it: a velocity pass (spawn, forces, collision response) and a position pass (spawn, integrate,
   ground clamp). Spawning is a ring buffer: the CPU decides how many particles to emit and hands the
   shader up to 8 contiguous slot ranges ("batches") per frame; both passes regenerate identical spawn
   values from a per-slot PCG hash, so no CPU->GPU particle upload ever happens.
   CPU path: the same configuration simulated in JavaScript on typed arrays and uploaded as instance
   attributes (capacity capped lower). Chosen automatically when float render targets fail a probe,
   when gpu:false, or when per-particle events (events.onDeath) need CPU-visible state.
   Rendering: camera-facing (optionally velocity-stretched) instanced quads or ribbons, premultiplied
   blending (additive = alpha 0), curve LUTs, flipbooks, soft-particle depth fade, simple sun lighting. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');

const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const MAX_BATCHES=8,CURVE_RES=128,MAX_PENDING=32,HISTORY=64,TAU=Math.PI*2;
const SHAPES={point:0,sphere:1,hemisphere:2,box:3,cone:4,disc:5,ring:6,line:7,mesh:8};
const DIRMODES={vector:0,shape:1,random:2,tangent:3};
const BLENDS={additive:1,alpha:1,premultiplied:1};
const BUILTIN_TEXTURES=['soft','spark','smoke','flare','ring','star','leaf'];

/* ---------- small helpers ---------- */
const isPlain=v=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.getPrototypeOf(v)===Object.prototype;
function deepMerge(base,over){
  if(over===undefined)return base;if(!isPlain(over)||!isPlain(base))return over;
  const out={...base};for(const k of Object.keys(over))out[k]=deepMerge(base[k],over[k]);return out;
}
const range=(v,def)=>Array.isArray(v)?[+v[0],+(v.length>1?v[1]:v[0])]:Number.isFinite(v)?[v,v]:def.slice();
function vec3(THREE,v,def){const o=new THREE.Vector3();if(v&&v.isVector3)return o.copy(v);if(Array.isArray(v))return o.set(+v[0]||0,+v[1]||0,+v[2]||0);if(Number.isFinite(v))return o.setScalar(v);return def?o.fromArray(def):o;}
function toColor(THREE,c,linear){const col=new THREE.Color();if(c&&c.isColor){col.copy(c);return col;}col.set(c===undefined||c===null?0xffffff:c);if(linear)col.convertSRGBToLinear();return col;}
const nextPow2=n=>{let p=1;while(p<n)p*=2;return p;};

/* Piecewise-linear curves. Scalar: [[t,v],...]; colour: [[t,color,alpha],...]. */
function scalarCurve(keys,def){
  if(Number.isFinite(keys))return [[0,keys],[1,keys]];
  if(!Array.isArray(keys)||!keys.length)return def;
  const k=keys.map(p=>Array.isArray(p)?[clamp(+p[0],0,1),+p[1]]:[0,+p]).filter(p=>Number.isFinite(p[0])&&Number.isFinite(p[1])).sort((a,b)=>a[0]-b[0]);
  return k.length?k:def;
}
function colorCurve(THREE,keys,linear){
  const def=[[0,0xffffff,0],[.08,0xffffff,1],[.7,0xffffff,1],[1,0xffffff,0]];
  const src=Array.isArray(keys)&&keys.length?keys:def;
  return src.map(p=>{const c=toColor(THREE,p[1],linear);return [clamp(+p[0]||0,0,1),c.r,c.g,c.b,clamp(p[2]===undefined?1:+p[2],0,1)];}).sort((a,b)=>a[0]-b[0]);
}
function evalCurve(keys,t,ch=1){
  if(t<=keys[0][0])return keys[0][ch];
  for(let i=1;i<keys.length;i++)if(t<=keys[i][0]){const a=keys[i-1],b=keys[i],f=(t-a[0])/Math.max(1e-6,b[0]-a[0]);return a[ch]+(b[ch]-a[ch])*f;}
  return keys[keys.length-1][ch];
}

/* ---------- JS noise (CPU path) ---------- */
/* Same hash/value noise as KE.GLSL, plus an analytic gradient so the curl below is exact. */
const fract=x=>x-Math.floor(x);
function hash13(x,y,z){x=fract(x*.1031);y=fract(y*.1031);z=fract(z*.1031);const d=x*(z+31.32)+y*(y+31.32)+z*(x+31.32);x+=d;y+=d;z+=d;return fract((x+y)*z);}
function noise3(x,y,z){const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z);let fx=x-ix,fy=y-iy,fz=z-iz;fx=fx*fx*(3-2*fx);fy=fy*fy*(3-2*fy);fz=fz*fz*(3-2*fz);
  const L=(a,b,t)=>a+(b-a)*t;
  return L(L(L(hash13(ix,iy,iz),hash13(ix+1,iy,iz),fx),L(hash13(ix,iy+1,iz),hash13(ix+1,iy+1,iz),fx),fy),L(L(hash13(ix,iy,iz+1),hash13(ix+1,iy,iz+1),fx),L(hash13(ix,iy+1,iz+1),hash13(ix+1,iy+1,iz+1),fx),fy),fz);}
/* Value noise with analytic gradient: out=[value,dx,dy,dz]. */
function noised3(x,y,z,out){
  const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),fx=x-ix,fy=y-iy,fz=z-iz;
  const ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy),uz=fz*fz*(3-2*fz),dx=6*fx*(1-fx),dy=6*fy*(1-fy),dz=6*fz*(1-fz);
  const a=hash13(ix,iy,iz),b=hash13(ix+1,iy,iz),c=hash13(ix,iy+1,iz),d=hash13(ix+1,iy+1,iz),e=hash13(ix,iy,iz+1),f=hash13(ix+1,iy,iz+1),g=hash13(ix,iy+1,iz+1),h=hash13(ix+1,iy+1,iz+1);
  const k1=b-a,k2=c-a,k3=e-a,k4=a-b-c+d,k5=a-c-e+g,k6=a-b-e+f,k7=-a+b+c-d+e-f-g+h;
  out[0]=a+k1*ux+k2*uy+k3*uz+k4*ux*uy+k5*uy*uz+k6*uz*ux+k7*ux*uy*uz;
  out[1]=dx*(k1+k4*uy+k6*uz+k7*uy*uz);out[2]=dy*(k2+k5*uz+k4*ux+k7*uz*ux);out[3]=dz*(k3+k6*ux+k5*uy+k7*ux*uy);return out;
}
/* Curl of the vector potential psi=(N(p),N(p+o1),N(p+o2)); two octaves. Divergence-free by construction. */
const _n1=[0,0,0,0],_n2=[0,0,0,0],_n3=[0,0,0,0];
function curlNoise(x,y,z,out,octaves=2){
  out[0]=out[1]=out[2]=0;let amp=1,f=1;
  for(let o=0;o<octaves;o++){const px=x*f,py=y*f,pz=z*f;
    noised3(px,py,pz,_n1);noised3(px+31.416,py-47.853,pz+12.793,_n2);noised3(px-19.117,py+33.412,pz+71.337,_n3);
    out[0]+=amp*f*(_n3[2]-_n2[3]);out[1]+=amp*f*(_n1[3]-_n3[1]);out[2]+=amp*f*(_n2[1]-_n1[2]);amp*=.5;f*=2.03;}
  return out;
}

/* ---------- GLSL ---------- */
const GLSL_PCG=`uint kePcg(uint v){uint s=v*747796405u+2891336453u;uint w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
float keRnd(inout uint s){s=kePcg(s);return float(s>>8u)*(1./16777216.);}`;
const GLSL_CURL=`vec4 keNoised3(vec3 x){vec3 i=floor(x),f=fract(x);vec3 u=f*f*(3.-2.*f),du=6.*f*(1.-f);
float a=keHash13(i),b=keHash13(i+vec3(1,0,0)),c=keHash13(i+vec3(0,1,0)),d=keHash13(i+vec3(1,1,0)),e=keHash13(i+vec3(0,0,1)),f1=keHash13(i+vec3(1,0,1)),g=keHash13(i+vec3(0,1,1)),h=keHash13(i+vec3(1,1,1));
float k1=b-a,k2=c-a,k3=e-a,k4=a-b-c+d,k5=a-c-e+g,k6=a-b-e+f1,k7=-a+b+c-d+e-f1-g+h;
return vec4(a+k1*u.x+k2*u.y+k3*u.z+k4*u.x*u.y+k5*u.y*u.z+k6*u.z*u.x+k7*u.x*u.y*u.z,
 du*vec3(k1+k4*u.y+k6*u.z+k7*u.y*u.z,k2+k5*u.z+k4*u.x+k7*u.z*u.x,k3+k6*u.x+k5*u.y+k7*u.x*u.y));}
vec3 keVfxCurl(vec3 p,int octaves){vec3 r=vec3(0.);float amp=1.,f=1.;
for(int o=0;o<4;o++){if(o>=octaves)break;vec3 q=p*f;vec3 g1=keNoised3(q).yzw,g2=keNoised3(q+vec3(31.416,-47.853,12.793)).yzw,g3=keNoised3(q+vec3(-19.117,33.412,71.337)).yzw;
r+=amp*f*vec3(g3.y-g2.z,g1.z-g3.x,g2.x-g1.y);amp*=.5;f*=2.03;}return r;}`;

const SIM_COMMON=`uniform highp sampler2D tPos;uniform highp sampler2D tVel;uniform vec2 uSize;uniform int uCap;uniform float uDt;uniform float uTime;
uniform float uBatchCount;uniform vec4 uBatch[${MAX_BATCHES}];uniform vec3 uBatchFrom[${MAX_BATCHES}];uniform vec3 uBatchTo[${MAX_BATCHES}];
uniform mat3 uEmitRot;uniform vec3 uEmitVel;uniform vec4 uShape;uniform vec3 uShapeSize;uniform vec3 uLineA;uniform vec3 uLineB;
uniform highp sampler2D tMesh;uniform vec3 uMeshInfo;uniform mat4 uMeshMatrix;
uniform vec2 uLife;uniform vec2 uSpeed;uniform vec3 uDir;uniform float uSpread;uniform vec3 uInitVel;
uniform vec3 uGravity;uniform vec3 uWind;uniform float uDrag;uniform float uTurb;uniform float uMaxSpeed;
uniform vec4 uCurl;uniform vec3 uVortexAxis;uniform vec3 uVortexCenter;uniform vec2 uVortex;uniform vec3 uAttractPos;uniform vec2 uAttract;
uniform vec4 uCollide;uniform highp sampler2D tHeight;uniform vec4 uHeightRegion;uniform float uHeightRes;uniform mat4 uToWorld;uniform mat4 uToLocal;
${KE.GLSL.hash}
${KE.GLSL.noise}
${GLSL_PCG}
${GLSL_CURL}
vec3 keRandDir(inout uint s){float z=keRnd(s)*2.-1.,ph=keRnd(s)*6.2831853,r=sqrt(max(0.,1.-z*z));return vec3(r*cos(ph),z,r*sin(ph));}
vec3 keConeDir(inout uint s,vec3 axis,float ang){float ct=mix(1.,cos(ang),keRnd(s)),st=sqrt(max(0.,1.-ct*ct)),ph=keRnd(s)*6.2831853;
 vec3 t=normalize(abs(axis.y)<.99?cross(axis,vec3(0.,1.,0.)):cross(axis,vec3(1.,0.,0.)));vec3 b=cross(axis,t);return normalize(axis*ct+(t*cos(ph)+b*sin(ph))*st);}
/* Shape sample in the emitter frame (mesh: already in simulation space). */
void keShape(inout uint s,out vec3 p,out vec3 d){
 float R=uShape.x,inner=1.-uShape.y;
#if KE_SHAPE==0
 p=vec3(0.);d=keRandDir(s);
#elif KE_SHAPE==1||KE_SHAPE==2
 d=keRandDir(s);
 #if KE_SHAPE==2
 d.y=abs(d.y);
 #endif
 float u=keRnd(s);p=d*(uShape.w>.5?R:R*pow(mix(inner*inner*inner,1.,u),1./3.));
#elif KE_SHAPE==3
 vec3 hs=uShapeSize*.5;float r1=keRnd(s),r2=keRnd(s),r3=keRnd(s);vec3 q=vec3(r1,r2,r3)*2.-1.;
 if(uShape.w>.5){float ax=hs.y*hs.z,ay=hs.x*hs.z,az=hs.x*hs.y,u=keRnd(s)*(ax+ay+az),sg=keRnd(s)<.5?-1.:1.;
  if(u<ax){q.x=sg;d=vec3(sg,0.,0.);}else if(u<ax+ay){q.y=sg;d=vec3(0.,sg,0.);}else{q.z=sg;d=vec3(0.,0.,sg);}p=q*hs;}
 else{p=q*hs;d=length(p)>1e-5?normalize(p):vec3(0.,1.,0.);}
#elif KE_SHAPE==4
 float ph=keRnd(s)*6.2831853,u=keRnd(s),rr=uShape.w>.5?R:R*sqrt(mix(inner*inner,1.,u));p=vec3(cos(ph)*rr,0.,sin(ph)*rr);
 if(R>0.){float tilt=uShape.z*rr/R;d=keConeDir(s,vec3(cos(ph)*sin(tilt),cos(tilt),sin(ph)*sin(tilt)),uShape.z*.3);}else d=keConeDir(s,vec3(0.,1.,0.),uShape.z);
#elif KE_SHAPE==5
 float ph=keRnd(s)*6.2831853,u=keRnd(s),rr=uShape.w>.5?R:R*sqrt(mix(inner*inner,1.,u));p=vec3(cos(ph)*rr,0.,sin(ph)*rr);d=vec3(0.,1.,0.);
#elif KE_SHAPE==6
 float ph=keRnd(s)*6.2831853;vec3 radial=vec3(cos(ph),0.,sin(ph));vec3 j=keRandDir(s);float jr=pow(keRnd(s),1./3.);p=radial*R+j*uShapeSize.x*jr;d=radial;
#elif KE_SHAPE==7
 float u=keRnd(s);vec3 ax=uLineB-uLineA;float al=length(ax);ax=al>1e-6?ax/al:vec3(0.,1.,0.);vec3 rd=keRandDir(s);rd-=ax*dot(rd,ax);
 d=length(rd)>1e-5?normalize(rd):vec3(0.,1.,0.);float v=keRnd(s);p=mix(uLineA,uLineB,u)+d*(uShape.w>.5?R:R*sqrt(mix(inner*inner,1.,v)));
#else
 int n=int(uMeshInfo.x),tw=int(uMeshInfo.y);int idx=min(int(keRnd(s)*float(n)),n-1),j=idx+n;
 vec3 lp=texelFetch(tMesh,ivec2(idx%tw,idx/tw),0).xyz,ln=texelFetch(tMesh,ivec2(j%tw,j/tw),0).xyz;
 p=(uMeshMatrix*vec4(lp,1.)).xyz;d=normalize(mat3(uMeshMatrix)*ln);
#endif
}
bool keFindBatch(int slot,out vec4 B,out vec3 F,out vec3 T,out float k){
 bool hit=false;B=vec4(0.);F=vec3(0.);T=vec3(0.);k=0.;if(slot>=uCap)return false;
 for(int i=0;i<${MAX_BATCHES};i++){if(float(i)>=uBatchCount)break;vec4 b=uBatch[i];int kk=(slot-int(b.x)+uCap)%uCap;
  if(float(kk)<b.y){hit=true;B=b;F=uBatchFrom[i];T=uBatchTo[i];k=float(kk);}}
 return hit;
}
/* Deterministic spawn: both passes call this and get identical results for the same slot and batch seed. */
void keSpawn(int slot,vec4 B,vec3 F,vec3 T,float k,out vec3 pos,out vec3 vel,out float life,out float age){
 uint s=kePcg(uint(slot)*2654435769u^kePcg(uint(B.w)+1821957365u));
 float f=(k+.5)/max(B.y,1.);age=(1.-f)*B.z;vec3 origin=mix(F,T,f);
 vec3 sp,sd;keShape(s,sp,sd);
#if KE_SHAPE!=8
 sp=origin+uEmitRot*sp;sd=uEmitRot*sd;
#endif
 vec3 dir;
#if KE_DIRMODE==0
 dir=uEmitRot*uDir;
#elif KE_DIRMODE==1
 dir=sd;
#elif KE_DIRMODE==2
 dir=keRandDir(s);
#else
 vec3 tg=cross(uEmitRot*vec3(0.,1.,0.),sp-origin);dir=length(tg)>1e-6?normalize(tg):keRandDir(s);
#endif
 if(uSpread>0.)dir=keConeDir(s,dir,uSpread);
 float speed=mix(uSpeed.x,uSpeed.y,keRnd(s));life=max(mix(uLife.x,uLife.y,keRnd(s)),1e-3);
 vel=dir*speed+uEmitRot*uInitVel+uEmitVel;pos=sp+vel*age;
}
float keGround(vec2 xz){float h=-1e9;
#ifdef KE_PLANE
 h=uCollide.x;
#endif
#ifdef KE_HEIGHT
 float n=uHeightRes-1.;vec2 g=(xz-uHeightRegion.xy)/uHeightRegion.zw*n;
 if(g.x>=0.&&g.y>=0.&&g.x<=n&&g.y<=n){vec2 i=min(floor(g),vec2(n-1.)),f=g-i;ivec2 c=ivec2(i);
  float h00=texelFetch(tHeight,c,0).r,h10=texelFetch(tHeight,c+ivec2(1,0),0).r,h01=texelFetch(tHeight,c+ivec2(0,1),0).r,h11=texelFetch(tHeight,c+ivec2(1,1),0).r;
  h=max(h,mix(mix(h00,h10,f.x),mix(h01,h11,f.x),f.y));}
#endif
 return h;}
vec3 keGroundNormal(vec2 xz){
#ifdef KE_HEIGHT
 float e=max(uHeightRegion.z/(uHeightRes-1.),1e-3);
 return normalize(vec3(keGround(xz-vec2(e,0.))-keGround(xz+vec2(e,0.)),2.*e,keGround(xz-vec2(0.,e))-keGround(xz+vec2(0.,e))));
#else
 return vec3(0.,1.,0.);
#endif
}`;

const SIM_VEL=`
vec4 keIntegrate(vec3 p,vec4 V){
 vec3 v=V.xyz;float life=V.w,dt=uDt;vec3 a=uGravity;
#ifdef KE_CURL
 a+=keVfxCurl(p*uCurl.y+vec3(.31,1.,.73)*uTime*uCurl.z,KE_CURL)*uCurl.x;
#endif
#ifdef KE_TURB
 {vec3 q=p*1.37+vec3(1.3,.7,-1.)*uTime;a+=(vec3(keNoise3(q),keNoise3(q+vec3(17.1,3.3,5.7)),keNoise3(q+vec3(-7.9,11.3,23.1)))-.5)*2.*uTurb;}
#endif
#ifdef KE_VORTEX
 {vec3 r=p-uVortexCenter;vec3 rp=r-uVortexAxis*dot(r,uVortexAxis);float d=length(rp)+1e-4;a+=cross(uVortexAxis,rp)/d*uVortex.x-rp/d*uVortex.y;}
#endif
#ifdef KE_ATTRACT
 {vec3 d=uAttractPos-p;float dist=length(d)+1e-4;float fall=uAttract.y>0.?clamp(1.-dist/uAttract.y,0.,1.):1.;a+=d/dist*uAttract.x*fall*smoothstep(0.,.3,dist);}
#endif
 v+=a*dt;v=uWind+(v-uWind)*exp(-uDrag*dt);
#ifdef KE_MAXSPEED
 {float sp=length(v);if(sp>uMaxSpeed)v*=uMaxSpeed/sp;}
#endif
#ifdef KE_COLLIDE
 vec3 pw=(uToWorld*vec4(p+v*dt,1.)).xyz;float g=keGround(pw.xz)+uCollide.w;
 if(pw.y<g){
 #ifdef KE_DIE
  life=-1.;
 #else
  vec3 n=keGroundNormal(pw.xz),vw=mat3(uToWorld)*v;float vn=dot(vw,n);
  if(vn<0.){vec3 vt=vw-vn*n;vw=vt*(1.-uCollide.z)-n*vn*uCollide.y;}v=mat3(uToLocal)*vw;
 #endif
 }
#endif
 return vec4(v,life);
}
void main(){
 ivec2 tc=ivec2(gl_FragCoord.xy);int slot=tc.y*int(uSize.x)+tc.x;vec4 P=texelFetch(tPos,tc,0),V=texelFetch(tVel,tc,0);
 vec4 B;vec3 F,T;float k;
 if(keFindBatch(slot,B,F,T,k)){vec3 sp,sv;float life,age;keSpawn(slot,B,F,T,k,sp,sv,life,age);gl_FragColor=vec4(sv,life);return;}
 if(V.w<=0.||P.w>=V.w){gl_FragColor=V;return;}
 gl_FragColor=keIntegrate(P.xyz,V);
}`;

const SIM_POS=`
void main(){
 ivec2 tc=ivec2(gl_FragCoord.xy);int slot=tc.y*int(uSize.x)+tc.x;vec4 P=texelFetch(tPos,tc,0),V=texelFetch(tVel,tc,0);
 vec4 B;vec3 F,T;float k;
 if(keFindBatch(slot,B,F,T,k)){vec3 sp,sv;float life,age;keSpawn(slot,B,F,T,k,sp,sv,life,age);gl_FragColor=vec4(sp,age);return;}
 if(V.w<=0.||P.w>=V.w){gl_FragColor=P;return;}
 vec3 p=P.xyz+V.xyz*uDt;
#ifdef KE_COLLIDE
 vec3 pw=(uToWorld*vec4(p,1.)).xyz;float g=keGround(pw.xz)+uCollide.w;if(pw.y<g){pw.y=g;p=(uToLocal*vec4(pw,1.)).xyz;}
#endif
 gl_FragColor=vec4(p,P.w+uDt);
}`;

/* Bitonic sort (descending view depth) over (key, slot) pairs: one key pass + log2(n)(log2(n)+1)/2 merge passes. */
const SORT_KEY=`uniform highp sampler2D tPos;uniform highp sampler2D tVel;uniform int uStateW;uniform int uSortW;uniform int uBase;uniform int uCap;uniform int uCount;uniform mat4 uModelView;
void main(){ivec2 c=ivec2(gl_FragCoord.xy);int i=c.y*uSortW+c.x;int slot=(uBase+i)%uCap;float key=-1e30;
 if(i<uCount){ivec2 t=ivec2(slot%uStateW,slot/uStateW);vec4 P=texelFetch(tPos,t,0),V=texelFetch(tVel,t,0);if(V.w>0.&&P.w<V.w)key=-(uModelView*vec4(P.xyz,1.)).z;}
 gl_FragColor=vec4(key,float(slot),0.,1.);}`;
const SORT_MERGE=`uniform highp sampler2D tSortIn;uniform int uSortW;uniform int uK;uniform int uJ;
void main(){ivec2 c=ivec2(gl_FragCoord.xy);int i=c.y*uSortW+c.x;int p=i^uJ;vec4 a=texelFetch(tSortIn,c,0),b=texelFetch(tSortIn,ivec2(p%uSortW,p/uSortW),0);
 bool desc=(i&uK)==0,lower=i<p,keepMax=lower==desc;bool takeB=keepMax?b.x>a.x:b.x<a.x;gl_FragColor=takeB?b:a;}`;
const PROBE_FS='void main(){gl_FragColor=vec4(1.5,-2.25,65536.,.125);}';

/* Render shaders. The CPU (KE_CPU) variant uses only GLSL ES 1.0 features so it also runs on WebGL1. */
const RENDER_VS=`attribute float aIndex;
#ifdef KE_CPU
 #ifdef KE_RIBBON
 attribute vec4 aA;attribute vec4 aB;attribute vec4 aLS;attribute vec3 aP;attribute vec3 aN;
 #else
 attribute vec4 aPosAge;attribute vec4 aVelLife;attribute float aSlot;
 #endif
#else
 uniform highp sampler2D tPos;uniform highp sampler2D tVel;uniform highp sampler2D tSort;uniform int uBase;uniform int uCap;uniform int uStateW;uniform int uSortW;uniform int uCount;
 void keFetch(int slot,out vec4 P,out vec4 V){ivec2 t=ivec2(slot%uStateW,slot/uStateW);P=texelFetch(tPos,t,0);V=texelFetch(tVel,t,0);}
#endif
uniform sampler2D tCurves;uniform vec4 uSizeInfo;uniform vec3 uColorA;uniform vec3 uColorB;uniform vec4 uRotInfo;uniform vec4 uFlip;uniform float uFlipRandom;
uniform float uWorldSpace;uniform float uEmissive;uniform vec4 uRibbon;
varying vec2 vUv;varying vec4 vColor;varying float vViewZ;varying vec2 vCorner;varying float vAdd;
#ifdef KE_FLIP_BLEND
varying vec3 vUv2;
#endif
#include <fog_pars_vertex>
${KE.GLSL.hash}
float keR(float slot,float i){return keHash12(vec2(slot*.618034+i*17.13,slot*.0173+i*3.71));}
vec4 keCurveA(float t){return texture2D(tCurves,vec2((t*${CURVE_RES-1}.+.5)/${CURVE_RES}.,.25));}
vec4 keCurveB(float t){return texture2D(tCurves,vec2((t*${CURVE_RES-1}.+.5)/${CURVE_RES}.,.75));}
vec4 keView(vec3 p){return uWorldSpace>.5?viewMatrix*vec4(p,1.):modelViewMatrix*vec4(p,1.);}
vec3 keViewDir(vec3 v){return uWorldSpace>.5?(viewMatrix*vec4(v,0.)).xyz:(modelViewMatrix*vec4(v,0.)).xyz;}
void keCull(){gl_Position=vec4(0.,0.,2.,1.);vColor=vec4(0.);vUv=vec2(0.);vViewZ=0.;vCorner=vec2(0.);vAdd=0.;
#ifdef KE_FLIP_BLEND
 vUv2=vec3(0.);
#endif
}
vec2 keCell(float f,vec2 uv){float cx=mod(f,uFlip.x),cy=floor(f/uFlip.x);return vec2((cx+uv.x)/uFlip.x,1.-(cy+1.-uv.y)/uFlip.y);}
bool keStyle(float slot,float t,out float size){
 vec4 ca=keCurveA(t),cb=keCurveB(t);size=mix(uSizeInfo.x,uSizeInfo.y,keR(slot,1.))*cb.r*uSizeInfo.z;
 vColor=vec4(mix(uColorA,uColorB,keR(slot,2.))*ca.rgb*ca.rgb*uEmissive,ca.a);vAdd=cb.g;return size>1e-6&&ca.a>.002;
}
void main(){
#ifdef KE_RIBBON
 vec4 A,B,LS;vec3 PP,NN;
 #ifdef KE_CPU
 A=aA;B=aB;LS=aLS;PP=aP;NN=aN;
 #else
 int k=int(aIndex+.5),sa=(k+uBase)%uCap,sb=(sa+1)%uCap;vec4 VA,VB,Q,VQ;keFetch(sa,A,VA);keFetch(sb,B,VB);
 LS=vec4(VA.w,VB.w,float(sa),float(sb));PP=A.xyz;NN=B.xyz;
 if(k>0){keFetch((sa-1+uCap)%uCap,Q,VQ);if(VQ.w>0.&&Q.w<VQ.w&&A.w<=Q.w+1e-4&&Q.w-A.w<uRibbon.y&&distance(Q.xyz,A.xyz)<uRibbon.x)PP=Q.xyz;}
 if(k+2<uCount){keFetch((sb+1)%uCap,Q,VQ);if(VQ.w>0.&&Q.w<VQ.w&&Q.w<=B.w+1e-4&&B.w-Q.w<uRibbon.y&&distance(Q.xyz,B.xyz)<uRibbon.x)NN=Q.xyz;}
 #endif
 float seg=distance(A.xyz,B.xyz);
 if(!(LS.x>0.&&A.w<LS.x&&LS.y>0.&&B.w<LS.y&&B.w<=A.w+1e-4&&A.w-B.w<uRibbon.y&&seg<uRibbon.x&&seg>1e-5)){keCull();return;}
 float e=position.x;vec4 E=e<.5?A:B;float life=e<.5?LS.x:LS.y,slot=e<.5?LS.z:LS.w;vec3 tg=e<.5?B.xyz-PP:NN-A.xyz;
 float t=clamp(E.w/life,0.,1.),size;if(!keStyle(slot,t,size)){keCull();return;}
 vec4 mvPosition=keView(E.xyz);vec3 side=cross(keViewDir(tg),mvPosition.xyz);float sl=length(side);side=sl>1e-9?side/sl:vec3(1.,0.,0.);
 mvPosition.xyz+=side*position.y*size*.5;vCorner=vec2(0.,position.y);vUv=vec2(uRibbon.z>.5?t:.5,position.y*.5+.5);
#else
 vec4 P,V;float slot;
 #ifdef KE_CPU
 P=aPosAge;V=aVelLife;slot=aSlot;
 #else
 int i=int(aIndex+.5);
  #ifdef KE_SORT
 int si=int(texelFetch(tSort,ivec2(i%uSortW,i/uSortW),0).y+.5);
  #else
 int si=(i+uBase)%uCap;
  #endif
 keFetch(si,P,V);slot=float(si);
 #endif
 if(V.w<=0.||P.w>=V.w){keCull();return;}
 float t=clamp(P.w/V.w,0.,1.),size;if(!keStyle(slot,t,size)){keCull();return;}
 vec4 mvPosition=keView(P.xyz);vec2 c=position.xy,off;float hs=size*.5;
 #ifdef KE_STRETCH
 vec3 vv=keViewDir(V.xyz);float sl=length(vv.xy);
 if(sl>1e-4){vec2 ax=vv.xy/sl,pp=vec2(-ax.y,ax.x);float ext=uSizeInfo.w*sl;off=ax*(c.x*(hs+ext*.5)-ext*.5)+pp*(c.y*hs);}else off=c*hs;
 vCorner=c;
 #else
 float rot=mix(uRotInfo.x,uRotInfo.y,keR(slot,3.))+mix(uRotInfo.z,uRotInfo.w,keR(slot,4.))*P.w,cs=cos(rot),sn=sin(rot);
 vec2 rc=vec2(c.x*cs-c.y*sn,c.x*sn+c.y*cs);off=rc*hs;vCorner=rc;
 #endif
 mvPosition.xy+=off;vec2 uv=c*.5+.5;
 #ifdef KE_FLIP
 float frames=uFlip.w,rnd=floor(keR(slot,5.)*frames);
 float fr=uFlip.z>0.?P.w*uFlip.z+uFlipRandom*rnd:(uFlipRandom>.5?rnd:min(t*frames,frames-.001));
 float f0=mod(floor(fr),frames);vUv=keCell(f0,uv);
  #ifdef KE_FLIP_BLEND
 vUv2=vec3(keCell(mod(f0+1.,frames),uv),uFlipRandom>.5&&uFlip.z<=0.?0.:fract(fr));
  #endif
 #else
 vUv=uv;
 #endif
#endif
 vViewZ=-mvPosition.z;gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`;
const RENDER_FS=`uniform sampler2D map;uniform float uSoftness;uniform vec2 uCameraFade;uniform vec4 uLitInfo;uniform vec3 uAmbient;
uniform sampler2D keSceneDepth;uniform float keHasScene;uniform vec2 keResolution;uniform vec3 keSunDirection;uniform vec3 keSunColor;
varying vec2 vUv;varying vec4 vColor;varying float vViewZ;varying vec2 vCorner;varying float vAdd;
#ifdef KE_FLIP_BLEND
varying vec3 vUv2;
#endif
#include <fog_pars_fragment>
void main(){
 vec4 tx=texture2D(map,vUv);
#ifdef KE_FLIP_BLEND
 tx=mix(tx,texture2D(map,vUv2.xy),vUv2.z);
#endif
#ifdef KE_STRAIGHT_MAP
 tx.rgb*=tx.a;
#endif
 vec3 rgb=tx.rgb*vColor.rgb;float a=tx.a*vColor.a;
#ifdef KE_LIT
 vec3 nV=normalize(vec3(vCorner*uLitInfo.x,1.)),nW=normalize((vec4(nV,0.)*viewMatrix).xyz),camZ=normalize((vec4(0.,0.,1.,0.)*viewMatrix).xyz);
 float ndl=dot(nW,keSunDirection),diff=mix(max(ndl,0.),ndl*.5+.5,uLitInfo.y),scatter=pow(max(dot(-camZ,keSunDirection),0.),6.)*uLitInfo.z;
 rgb*=uAmbient+keSunColor*(diff+scatter);
#endif
 float fade=clamp((vViewZ-uCameraFade.x)/max(uCameraFade.y,1e-4),0.,1.);
#ifdef KE_SOFT
 if(keHasScene>.5){float sz=texture2D(keSceneDepth,gl_FragCoord.xy/keResolution).r;fade*=clamp((sz-vViewZ)/uSoftness,0.,1.);}
#endif
 rgb*=vColor.a*fade;a*=fade;float oa=a*(1.-vAdd);
#ifdef USE_FOG
 #ifdef FOG_EXP2
 float ff=1.-exp(-fogDensity*fogDensity*fogDepth*fogDepth);
 #else
 float ff=smoothstep(fogNear,fogFar,fogDepth);
 #endif
 rgb=rgb*(1.-ff)+fogColor*oa*ff;
#endif
 gl_FragColor=vec4(rgb,oa);
#include <tonemapping_fragment>
#include <encodings_fragment>
}`;

/* ---------- procedural sprite textures (canvas, generated on first use) ---------- */
function hash2(x,y,seed){let h=Math.imul(x|0,374761393)+Math.imul(y|0,668265263)+Math.imul(seed|0,2147483647)|0;h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967296;}
function vnoise2(x,y,seed){const ix=Math.floor(x),iy=Math.floor(y);let fx=x-ix,fy=y-iy;fx=fx*fx*(3-2*fx);fy=fy*fy*(3-2*fy);
  const a=hash2(ix,iy,seed),b=hash2(ix+1,iy,seed),c=hash2(ix,iy+1,seed),d=hash2(ix+1,iy+1,seed);return a+(b-a)*fx+(c-a)*fy+(a-b-c+d)*fx*fy;}
function fbm2(x,y,seed,oct=5){let s=0,a=.5,n=0;for(let i=0;i<oct;i++){s+=a*vnoise2(x,y,seed+i*17);n+=a;x=x*2.03+1.7;y=y*2.03+9.2;a*=.5;}return s/n;}
function pixelCanvas(S,fn){
  const c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d'),img=g.createImageData(S,S),d=img.data,o=[1,1,1,0];
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){o[0]=o[1]=o[2]=1;o[3]=0;fn((x+.5)/S*2-1,(y+.5)/S*2-1,o,x,y);const k=(y*S+x)*4;
    d[k]=clamp(o[0],0,1)*255;d[k+1]=clamp(o[1],0,1)*255;d[k+2]=clamp(o[2],0,1)*255;d[k+3]=clamp(o[3],0,1)*255;}
  g.putImageData(img,0,0);return c;
}
const edge=r2=>clamp((1-r2)*4,0,1);
const TEXTURE_PAINTERS={
  soft:()=>pixelCanvas(128,(u,v,o)=>{const r2=u*u+v*v,k=3.2;o[3]=r2>=1?0:(Math.exp(-r2*k)-Math.exp(-k))/(1-Math.exp(-k));}),
  spark:()=>pixelCanvas(128,(u,v,o)=>{const core=Math.exp(-u*u*2.2)*Math.exp(-v*v*20)*(1-u*u),glow=Math.exp(-u*u*1.2)*Math.exp(-v*v*5)*.25*(1-u*u);o[3]=core+glow;}),
  flare:()=>pixelCanvas(128,(u,v,o)=>{const r2=u*u+v*v,au=Math.abs(u),av=Math.abs(v),d1=Math.abs(u+v)*.7071,d2=Math.abs(u-v)*.7071;
    const rays=Math.exp(-av*55)*Math.exp(-au*2.6)+Math.exp(-au*55)*Math.exp(-av*2.6)+.35*(Math.exp(-d1*70)*Math.exp(-d2*5)+Math.exp(-d2*70)*Math.exp(-d1*5));
    o[3]=(Math.exp(-r2*38)+Math.exp(-r2*6)*.4+rays*.6)*edge(r2);}),
  ring:()=>pixelCanvas(128,(u,v,o)=>{const r2=u*u+v*v,r=Math.sqrt(r2),d=r-.7;o[3]=(Math.exp(-d*d*220)+(r<.7?.18*Math.exp(-(.7-r)*5):0)+Math.exp(-d*d*25)*.15)*edge(r2);}),
  star:()=>pixelCanvas(128,(u,v,o)=>{const r2=u*u+v*v,au=Math.abs(u),av=Math.abs(v);const rays=Math.max(Math.exp(-au*30-av*3.4),Math.exp(-av*30-au*3.4));
    o[3]=(rays+Math.exp(-r2*22)*.9+Math.exp(-r2*4)*.18)*edge(r2);}),
  /* 2x2 atlas of noisy puffs (used with a random flipbook frame); RGB carries a little self-shading. */
  smoke:()=>{const S=256,C=128;return pixelCanvas(S,(u,v,o,x,y)=>{const cx=x>=C?1:0,cy=y>=C?1:0,seed=1+cx+cy*2;const lu=((x-cx*C)+.5)/C*2-1,lv=((y-cy*C)+.5)/C*2-1;
    const r=Math.sqrt(lu*lu+lv*lv),n=fbm2(lu*2.1+seed*7.3,lv*2.1-seed*3.1,seed*101),m=fbm2(lu*4.3-seed,lv*4.3+seed*2,seed*53+7,4);
    const e=r+(n-.5)*.7;const dens=clamp((1-e)/.55,0,1);o[3]=dens*dens*(3-2*dens)*(.45+.75*m)*clamp((1-r)*6,0,1);
    const shade=clamp(.78+.35*(m-.5)-.18*lv,0,1);o[0]=o[1]=o[2]=shade;});},
  leaf:()=>{const S=64,c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d');g.translate(S/2,S/2);g.rotate(-Math.PI/4);
    const grad=g.createLinearGradient(-14,0,14,0);grad.addColorStop(0,'#e8e8e8');grad.addColorStop(.5,'#ffffff');grad.addColorStop(1,'#c8c8c8');
    g.beginPath();g.moveTo(0,-28);g.bezierCurveTo(17,-15,16,13,0,27);g.bezierCurveTo(-16,13,-17,-15,0,-28);g.fillStyle=grad;g.fill();
    g.strokeStyle='rgba(150,150,150,0.9)';g.lineWidth=1.4;g.beginPath();g.moveTo(0,-26);g.lineTo(0,29);g.stroke();g.lineWidth=.8;
    for(let i=-2;i<=2;i++){const y=i*8;g.beginPath();g.moveTo(0,y+3);g.lineTo(10-Math.abs(i)*1.5,y-5);g.moveTo(0,y+3);g.lineTo(-10+Math.abs(i)*1.5,y-5);g.stroke();}return c;},
};

/* ---------- spawn history: alive estimate and live ring window (GPU path) ---------- */
/* Spawns are grouped into time buckets {t0,t1,count,start}. A bucket older than the maximum lifetime cannot
   hold live particles, so the ring range covered by the remaining buckets bounds every live slot. */
class SpawnHistory{
  constructor(){this.b=Array.from({length:HISTORY},()=>({t0:0,t1:0,count:0,start:0}));this.head=0;this.size=0;}
  reset(){this.head=0;this.size=0;}
  add(time,count,start,bucketDur){
    if(count<=0)return;let last=this.size?this.b[(this.head+this.size-1)%HISTORY]:null;
    if(last&&time-last.t0<bucketDur){last.t1=time;last.count+=count;return;}
    if(this.size===HISTORY){const o=this.b[this.head],n=this.b[(this.head+1)%HISTORY];n.t0=o.t0;n.count+=o.count;n.start=o.start;this.head=(this.head+1)%HISTORY;this.size--;}
    last=this.b[(this.head+this.size)%HISTORY];last.t0=last.t1=time;last.count=count;last.start=start;this.size++;
  }
  prune(time,maxLife){while(this.size&&time-this.b[this.head].t1>maxLife+.05){this.head=(this.head+1)%HISTORY;this.size--;}}
  window(cursor,cap,out){let total=0;for(let i=0;i<this.size;i++)total+=this.b[(this.head+i)%HISTORY].count;
    if(!this.size){out.base=cursor;out.count=0;}else if(total>=cap){out.base=cursor;out.count=cap;}else{out.base=this.b[this.head].start;out.count=total;}return out;}
  estimate(time,lmin,lmax,cap){let n=0;for(let i=0;i<this.size;i++){const b=this.b[(this.head+i)%HISTORY],age=time-(b.t0+b.t1)*.5;
      n+=b.count*(lmax<=lmin?(age<lmax?1:0):clamp((lmax-age)/(lmax-lmin),0,1));}return Math.min(cap,Math.round(n));}
}

/* ---------- configuration ---------- */
function normalizeConfig(THREE,cfg,linear){
  cfg=cfg||{};const sp=cfg.spawn||{},sh=sp.shape||{},init=cfg.init||{},fo=cfg.forces||{},co=cfg.collision,re=cfg.render||{},ev=cfg.events||{};
  const capacity=Math.floor(cfg.capacity===undefined?1024:+cfg.capacity);
  if(!(capacity>=1&&capacity<=1048576))throw new RangeError('KE.VFX: capacity must be an integer 1..1048576');
  const type=sh.type||'point';if(!(type in SHAPES))throw new RangeError('KE.VFX: unknown spawn shape "'+type+'"');
  if(type==='mesh'&&!(sh.mesh&&sh.mesh.isObject3D))throw new TypeError('KE.VFX: shape "mesh" needs shape.mesh (a THREE.Mesh)');
  const life=range(init.life,[1,2]);if(!(life[1]>0)||!(life[0]>=0))throw new RangeError('KE.VFX: init.life must be positive');life[0]=Math.min(life[0],life[1]);
  const blending=re.blending||'additive';if(!BLENDS[blending])throw new RangeError('KE.VFX: unknown blending "'+blending+'"');
  const bursts=(sp.bursts||[]).map(b=>{const cycle=Math.max(0,+b.cycle||0);return {time:Math.max(0,+b.time||0),count:range(b.count===undefined?10:b.count,[10,10]),cycle,
    repeat:b.repeat===undefined?(cycle>0?Infinity:1):Math.max(1,Math.floor(b.repeat)),probability:b.probability===undefined?1:clamp(+b.probability,0,1),next:0,left:0};});
  let dirMode=DIRMODES.shape,dir=new THREE.Vector3(0,1,0);
  if(typeof init.direction==='string'){if(!(init.direction in DIRMODES)||init.direction==='vector')throw new RangeError('KE.VFX: init.direction must be a vector or shape|random|tangent');dirMode=DIRMODES[init.direction];}
  else if(init.direction!==undefined){dirMode=DIRMODES.vector;dir=vec3(THREE,init.direction,[0,1,0]);if(dir.lengthSq()<1e-12)dir.set(0,1,0);dir.normalize();}
  const cols=Array.isArray(init.color)?init.color:[init.color,init.color];
  const pick=(v,def)=>v===undefined||v===null||v===false?null:(Number.isFinite(v)?{...def,strength:v}:{...def,...v});
  const curl=pick(fo.curl,{strength:1,scale:1,speed:.5,octaves:2}),vortex=pick(fo.vortex,{axis:[0,1,0],center:[0,0,0],strength:1,pull:0}),attractor=pick(fo.attractor,{position:[0,0,0],strength:1,radius:0});
  let collision=null;
  if(co&&(typeof co.heightAt==='function'||Number.isFinite(co.plane)))collision={heightAt:typeof co.heightAt==='function'?co.heightAt:null,plane:Number.isFinite(co.plane)?co.plane:null,
    bounce:co.bounce===undefined?.3:+co.bounce,friction:co.friction===undefined?.2:clamp(+co.friction,0,1),die:!!co.die,radius:+co.radius||0,
    resolution:clamp(Math.round(co.resolution||64),4,512),region:co.region||null};
  let tex=re.texture===undefined?'soft':re.texture;if(typeof tex==='string'&&!BUILTIN_TEXTURES.includes(tex))throw new RangeError('KE.VFX: unknown texture "'+tex+'"');
  let flip=re.flipbook;if(flip===undefined&&tex==='smoke')flip={cols:2,rows:2,fps:0,random:true};
  if(flip){const c=Math.max(1,Math.floor(flip.cols||1)),r=Math.max(1,Math.floor(flip.rows||1));flip={cols:c,rows:r,fps:+flip.fps||0,random:!!flip.random,frames:clamp(Math.floor(flip.frames||c*r),1,c*r),blend:!!flip.blend};}
  const orient=new THREE.Quaternion();if(cfg.orientation&&cfg.orientation.isQuaternion)orient.copy(cfg.orientation);else if(Array.isArray(cfg.orientation))orient.setFromEuler(new THREE.Euler(+cfg.orientation[0]||0,+cfg.orientation[1]||0,+cfg.orientation[2]||0));
  const wind=vec3(THREE,fo.wind,[0,0,0]);
  const hasBursts=bursts.length>0;
  return {
    name:cfg.name||'emitter',capacity,gpu:cfg.gpu!==false,space:cfg.space==='local'?'local':'world',attachTo:cfg.attachTo&&cfg.attachTo.isObject3D?cfg.attachTo:null,
    position:vec3(THREE,cfg.position,[0,0,0]),orientation:orient,autoplay:cfg.autoplay!==false,scaleWithBudget:cfg.scaleWithBudget!==false,seed:Number.isFinite(cfg.seed)?cfg.seed:(Math.random()*1e9)|0,
    spawn:{rate:Math.max(0,sp.rate===undefined?(hasBursts?0:50):+sp.rate||0),bursts,duration:sp.duration===undefined?Infinity:Math.max(1e-3,+sp.duration),loop:sp.loop!==false,
      rateOverDistance:Math.max(0,+sp.rateOverDistance||0),
      shape:{type,code:SHAPES[type],radius:sh.radius===undefined?(type==='box'||type==='point'?0:.5):Math.max(0,+sh.radius),thickness:sh.surfaceOnly?0:clamp(sh.thickness===undefined?1:+sh.thickness,0,1),
        surfaceOnly:!!sh.surfaceOnly,size:vec3(THREE,sh.size,[1,1,1]),angle:sh.angle===undefined?.4:clamp(+sh.angle,0,Math.PI),width:Math.max(0,+sh.width||0),
        mesh:type==='mesh'?sh.mesh:null,samples:clamp(Math.round(sh.samples||2048),16,65536),from:vec3(THREE,sh.from,[0,0,0]),to:vec3(THREE,sh.to,[0,1,0])}},
    init:{life,speed:range(init.speed,[1,2]),dirMode,direction:dir,spread:clamp(+init.spread||0,0,Math.PI),size:range(init.size,[.1,.2]).map(v=>Math.max(0,v)),
      color:[toColor(THREE,cols[0],linear),toColor(THREE,cols.length>1?cols[1]:cols[0],linear)],rotation:range(init.rotation,[0,0]),angularVelocity:range(init.angularVelocity,[0,0]),
      inheritVelocity:+init.inheritVelocity||0,velocity:vec3(THREE,init.velocity,[0,0,0])},
    forces:{gravity:vec3(THREE,fo.gravity,[0,0,0]),drag:Math.max(0,fo.drag===undefined?(wind.lengthSq()>0?.5:0):+fo.drag||0),wind,turbulence:Math.max(0,+fo.turbulence||0),maxSpeed:Math.max(0,+fo.maxSpeed||0),
      curl:curl&&{strength:+curl.strength||0,scale:+curl.scale||1,speed:+curl.speed||0,octaves:clamp(Math.round(curl.octaves||2),1,4)},
      vortex:vortex&&{axis:vec3(THREE,vortex.axis,[0,1,0]).normalize(),center:vec3(THREE,vortex.center,[0,0,0]),strength:+vortex.strength||0,pull:+vortex.pull||0},
      attractor:attractor&&{position:vec3(THREE,attractor.position,[0,0,0]),strength:+attractor.strength||0,radius:Math.max(0,+attractor.radius||0)}},
    collision,
    render:{blending,texture:tex,flipbook:flip||null,stretch:Math.max(0,+re.stretch||0),
      sizeOverLife:scalarCurve(re.sizeOverLife,[[0,1],[1,1]]),colorOverLife:colorCurve(THREE,re.colorOverLife,linear),
      blendOverLife:blending==='additive'?[[0,1],[1,1]]:blending==='alpha'?[[0,0],[1,0]]:scalarCurve(re.blendOverLife,[[0,0],[1,0]]),
      softness:Math.max(0,re.softness===undefined?.5:+re.softness||0),lit:!!re.lit,emissive:re.emissive===undefined?1:Math.max(0,+re.emissive),sortAlpha:!!re.sortAlpha,ribbons:!!re.ribbons,
      ambient:toColor(THREE,re.ambient===undefined?0x5a6070:re.ambient,linear),wrap:re.wrap===undefined?.6:clamp(+re.wrap,0,1),translucency:re.translucency===undefined?.4:Math.max(0,+re.translucency),
      curvature:re.curvature===undefined?.7:Math.max(0,+re.curvature),order:+re.order||0,cameraFade:range(re.cameraFade,[.05,.4]),layer:Number.isInteger(re.layer)?re.layer:null,
      ribbonMaxGap:re.ribbonMaxGap===undefined?4:Math.max(1e-3,+re.ribbonMaxGap),ribbonMaxAgeGap:re.ribbonMaxAgeGap===undefined?.5:Math.max(1e-3,+re.ribbonMaxAgeGap),ribbonUV:re.ribbonUV==='length'?'length':'profile',
      premultipliedTexture:re.premultipliedTexture},
    events:{onDeath:typeof ev.onDeath==='function'?ev.onDeath:null},
  };
}

/* ---------- GPU backend ---------- */
class GPUBackend{
  constructor(e){
    const THREE=e.THREE,vfx=e.vfx,c=e.config,cap=e.capacity;this.e=e;this.vfx=vfx;this.renderer=vfx.renderer;
    const W=Math.max(4,nextPow2(Math.ceil(Math.sqrt(cap)))),H=Math.max(1,Math.ceil(cap/W));this.W=W;this.H=H;
    const mk=()=>{const rt=new THREE.WebGLRenderTarget(W,H,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false});rt.texture.generateMipmaps=false;return rt;};
    this.targets=[{pos:mk(),vel:mk()},{pos:mk(),vel:mk()}];this.read=0;
    const f=c.forces,col=c.collision,defines={KE_SHAPE:c.spawn.shape.code,KE_DIRMODE:c.init.dirMode};
    if(f.curl)defines.KE_CURL=f.curl.octaves;if(f.turbulence>0)defines.KE_TURB=1;if(f.vortex)defines.KE_VORTEX=1;if(f.attractor)defines.KE_ATTRACT=1;if(f.maxSpeed>0)defines.KE_MAXSPEED=1;
    if(col){defines.KE_COLLIDE=1;if(col.plane!==null)defines.KE_PLANE=1;if(col.heightAt)defines.KE_HEIGHT=1;if(col.die)defines.KE_DIE=1;}
    const V3=()=>({value:new THREE.Vector3()});
    this.uniforms={tPos:{value:null},tVel:{value:null},uSize:{value:new THREE.Vector2(W,H)},uCap:{value:cap},uDt:{value:0},uTime:{value:0},
      uBatchCount:{value:0},uBatch:{value:Array.from({length:MAX_BATCHES},()=>new THREE.Vector4())},uBatchFrom:{value:Array.from({length:MAX_BATCHES},()=>new THREE.Vector3())},uBatchTo:{value:Array.from({length:MAX_BATCHES},()=>new THREE.Vector3())},
      uEmitRot:{value:new THREE.Matrix3()},uEmitVel:V3(),uShape:{value:new THREE.Vector4()},uShapeSize:V3(),uLineA:V3(),uLineB:V3(),
      tMesh:{value:e.meshTexture||null},uMeshInfo:V3(),uMeshMatrix:{value:new THREE.Matrix4()},uLife:{value:new THREE.Vector2()},uSpeed:{value:new THREE.Vector2()},uDir:V3(),uSpread:{value:0},uInitVel:V3(),
      uGravity:V3(),uWind:V3(),uDrag:{value:0},uTurb:{value:0},uMaxSpeed:{value:0},uCurl:{value:new THREE.Vector4()},uVortexAxis:V3(),uVortexCenter:V3(),uVortex:{value:new THREE.Vector2()},
      uAttractPos:V3(),uAttract:{value:new THREE.Vector2()},uCollide:{value:new THREE.Vector4()},tHeight:{value:e.heightTexture||null},uHeightRegion:{value:new THREE.Vector4(0,0,1,1)},uHeightRes:{value:2},
      uToWorld:{value:new THREE.Matrix4()},uToLocal:{value:new THREE.Matrix4()}};
    const mat=(fs)=>new THREE.ShaderMaterial({vertexShader:KE.FULLSCREEN_VS,fragmentShader:SIM_COMMON+fs,uniforms:this.uniforms,defines:{...defines},depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false});
    this.velMat=mat(SIM_VEL);this.posMat=mat(SIM_POS);
    for(const t of this.targets){vfx._clear(t.pos);vfx._clear(t.vel);}
    this.sort=null;this.passes=0;
  }
  get position(){return this.targets[this.read].pos;}
  get velocity(){return this.targets[this.read].vel;}
  simulate(dt,e){
    const u=this.uniforms,f=e.frame,b=e.batches,n=e.batchCount;
    u.uDt.value=dt;u.uTime.value=e.vfx.time;u.uBatchCount.value=n;
    for(let i=0;i<n;i++){const s=b[i];u.uBatch.value[i].set(s.start,s.count,s.span,s.seed);u.uBatchFrom.value[i].copy(s.from);u.uBatchTo.value[i].copy(s.to);}
    u.uEmitRot.value.copy(f.emitRot);u.uEmitVel.value.copy(f.emitVel);u.uShape.value.copy(f.shape);u.uShapeSize.value.copy(f.shapeSize);u.uLineA.value.copy(f.lineA);u.uLineB.value.copy(f.lineB);
    u.uMeshInfo.value.copy(f.meshInfo);u.uMeshMatrix.value.copy(f.meshMatrix);u.uLife.value.copy(f.life);u.uSpeed.value.copy(f.speed);u.uDir.value.copy(f.dir);u.uSpread.value=f.spread;u.uInitVel.value.copy(f.initVel);
    u.uGravity.value.copy(f.gravity);u.uWind.value.copy(f.wind);u.uDrag.value=f.drag;u.uTurb.value=f.turb;u.uMaxSpeed.value=f.maxSpeed;u.uCurl.value.copy(f.curl);
    u.uVortexAxis.value.copy(f.vortexAxis);u.uVortexCenter.value.copy(f.vortexCenter);u.uVortex.value.copy(f.vortex);u.uAttractPos.value.copy(f.attractPos);u.uAttract.value.copy(f.attract);
    u.uCollide.value.copy(f.collide);u.uHeightRegion.value.copy(f.heightRegion);u.uHeightRes.value=f.heightRes;u.uToWorld.value.copy(f.toWorld);u.uToLocal.value.copy(f.toLocal);
    const r=this.targets[this.read],w=this.targets[1-this.read],fsq=this.vfx.fsq;
    u.tPos.value=r.pos.texture;u.tVel.value=r.vel.texture;fsq.render(this.renderer,w.vel,this.velMat);
    u.tVel.value=w.vel.texture;fsq.render(this.renderer,w.pos,this.posMat);
    this.read=1-this.read;this.passes=2;
  }
  clear(){for(const t of this.targets){this.vfx._clear(t.pos);this.vfx._clear(t.vel);}}
  /* Bitonic sort of the live window by view depth; returns the sorted texture. */
  sortWindow(win,modelView){
    const THREE=this.e.THREE,cap=this.e.capacity;
    if(!this.sort){const N=nextPow2(cap),SW=Math.max(1,nextPow2(Math.ceil(Math.sqrt(N)))),SH=Math.max(1,N/SW);
      const mk=()=>new THREE.WebGLRenderTarget(SW,SH,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false});
      const ku={tPos:{value:null},tVel:{value:null},uStateW:{value:this.W},uSortW:{value:SW},uBase:{value:0},uCap:{value:cap},uCount:{value:0},uModelView:{value:new THREE.Matrix4()}};
      const mu={tSortIn:{value:null},uSortW:{value:SW},uK:{value:2},uJ:{value:1}};
      const opts={vertexShader:KE.FULLSCREEN_VS,depthTest:false,depthWrite:false,blending:THREE.NoBlending,toneMapped:false};
      this.sort={N,SW,SH,rt:[mk(),mk()],ku,mu,keyMat:new THREE.ShaderMaterial({...opts,fragmentShader:SORT_KEY,uniforms:ku}),mergeMat:new THREE.ShaderMaterial({...opts,fragmentShader:SORT_MERGE,uniforms:mu})};}
    const s=this.sort,fsq=this.vfx.fsq,n=Math.max(2,nextPow2(win.count));
    s.ku.tPos.value=this.position.texture;s.ku.tVel.value=this.velocity.texture;s.ku.uBase.value=win.base;s.ku.uCount.value=win.count;s.ku.uModelView.value.copy(modelView);
    let cur=0;fsq.render(this.renderer,s.rt[0],s.keyMat);let passes=1;
    for(let k=2;k<=n;k*=2)for(let j=k>>1;j>0;j>>=1){s.mu.tSortIn.value=s.rt[cur].texture;s.mu.uK.value=k;s.mu.uJ.value=j;fsq.render(this.renderer,s.rt[1-cur],s.mergeMat);cur=1-cur;passes++;}
    this.passes+=passes;return s.rt[cur];
  }
  readState(){
    const n=this.W*this.H*4,pos=new Float32Array(n),vel=new Float32Array(n);
    this.renderer.readRenderTargetPixels(this.position,0,0,this.W,this.H,pos);this.renderer.readRenderTargetPixels(this.velocity,0,0,this.W,this.H,vel);return {position:pos,velocity:vel,width:this.W,height:this.H};
  }
  dispose(){for(const t of this.targets){t.pos.dispose();t.vel.dispose();}this.velMat.dispose();this.posMat.dispose();
    if(this.sort){for(const rt of this.sort.rt)rt.dispose();this.sort.keyMat.dispose();this.sort.mergeMat.dispose();this.sort=null;}}
}

/* ---------- CPU backend ---------- */
class CPUBackend{
  constructor(e){const cap=e.capacity;this.e=e;this.pos=new Float32Array(cap*3);this.vel=new Float32Array(cap*3);this.age=new Float32Array(cap);this.life=new Float32Array(cap);
    this.alive=0;this.rng=KE.random(e.config.seed);this._v=[0,0,0];this._c=[0,0,0];this._p=[0,0,0];this._d=[0,0,0];this.order=new Uint32Array(cap);this.keys=new Float32Array(cap);this.passes=0;
    const THREE=e.THREE;this._dp=new THREE.Vector3();this._dv=new THREE.Vector3();this.deathInfo={position:new THREE.Vector3(),velocity:new THREE.Vector3(),index:0,emitter:e};}
  clear(){this.life.fill(0);this.age.fill(0);this.alive=0;}
  _randDir(o){const r=this.rng,z=r()*2-1,ph=r()*TAU,s=Math.sqrt(Math.max(0,1-z*z));o[0]=s*Math.cos(ph);o[1]=z;o[2]=s*Math.sin(ph);return o;}
  _cone(o,ax,ay,az,ang){const r=this.rng,ct=1+(Math.cos(ang)-1)*r(),st=Math.sqrt(Math.max(0,1-ct*ct)),ph=r()*TAU;
    let tx,ty,tz;if(Math.abs(ay)<.99){tx=-az;ty=0;tz=ax;}else{tx=0;ty=az;tz=-ay;}const tl=Math.hypot(tx,ty,tz)||1;tx/=tl;ty/=tl;tz/=tl;
    const bx=ay*tz-az*ty,by=az*tx-ax*tz,bz=ax*ty-ay*tx,c=Math.cos(ph)*st,s=Math.sin(ph)*st;
    o[0]=ax*ct+tx*c+bx*s;o[1]=ay*ct+ty*c+by*s;o[2]=az*ct+tz*c+bz*s;const l=Math.hypot(o[0],o[1],o[2])||1;o[0]/=l;o[1]/=l;o[2]/=l;return o;}
  /* Mirrors keShape/keSpawn in the GPU shader. */
  _spawn(i,b,k,f){
    const r=this.rng,sh=this.e.config.spawn.shape,R=sh.radius,inner=1-sh.thickness,p=this._p,d=this._d,R3=f.emitRot.elements;
    switch(sh.code){
      case 0:p[0]=p[1]=p[2]=0;this._randDir(d);break;
      case 1:case 2:{this._randDir(d);if(sh.code===2)d[1]=Math.abs(d[1]);const rr=sh.surfaceOnly?R:R*Math.cbrt(inner*inner*inner+(1-inner*inner*inner)*r());p[0]=d[0]*rr;p[1]=d[1]*rr;p[2]=d[2]*rr;break;}
      case 3:{const s=sh.size;for(let a=0;a<3;a++)p[a]=(r()*2-1)*s.getComponent(a)*.5;
        if(sh.surfaceOnly){const hx=s.x*.5,hy=s.y*.5,hz=s.z*.5,ax=hy*hz,ay=hx*hz,az=hx*hy,u=r()*(ax+ay+az),sg=r()<.5?-1:1;d[0]=d[1]=d[2]=0;
          if(u<ax){p[0]=sg*hx;d[0]=sg;}else if(u<ax+ay){p[1]=sg*hy;d[1]=sg;}else{p[2]=sg*hz;d[2]=sg;}}
        else{const l=Math.hypot(p[0],p[1],p[2]);if(l>1e-5){d[0]=p[0]/l;d[1]=p[1]/l;d[2]=p[2]/l;}else{d[0]=0;d[1]=1;d[2]=0;}}break;}
      case 4:{const ph=r()*TAU,rr=sh.surfaceOnly?R:R*Math.sqrt(inner*inner+(1-inner*inner)*r());p[0]=Math.cos(ph)*rr;p[1]=0;p[2]=Math.sin(ph)*rr;
        if(R>0){const tilt=sh.angle*rr/R;this._cone(d,Math.cos(ph)*Math.sin(tilt),Math.cos(tilt),Math.sin(ph)*Math.sin(tilt),sh.angle*.3);}else this._cone(d,0,1,0,sh.angle);break;}
      case 5:{const ph=r()*TAU,rr=sh.surfaceOnly?R:R*Math.sqrt(inner*inner+(1-inner*inner)*r());p[0]=Math.cos(ph)*rr;p[1]=0;p[2]=Math.sin(ph)*rr;d[0]=0;d[1]=1;d[2]=0;break;}
      case 6:{const ph=r()*TAU,cx=Math.cos(ph),cz=Math.sin(ph);this._randDir(this._c);const j=sh.width*Math.cbrt(r());p[0]=cx*R+this._c[0]*j;p[1]=this._c[1]*j;p[2]=cz*R+this._c[2]*j;d[0]=cx;d[1]=0;d[2]=cz;break;}
      case 7:{const u=r(),A=sh.from,B=sh.to;let ax=B.x-A.x,ay=B.y-A.y,az=B.z-A.z;const al=Math.hypot(ax,ay,az);if(al>1e-6){ax/=al;ay/=al;az/=al;}else{ax=0;ay=1;az=0;}
        this._randDir(d);const dp=d[0]*ax+d[1]*ay+d[2]*az;d[0]-=ax*dp;d[1]-=ay*dp;d[2]-=az*dp;const dl=Math.hypot(d[0],d[1],d[2]);if(dl>1e-5){d[0]/=dl;d[1]/=dl;d[2]/=dl;}else{d[0]=0;d[1]=1;d[2]=0;}
        const rr=sh.surfaceOnly?R:R*Math.sqrt(inner*inner+(1-inner*inner)*r());p[0]=A.x+(B.x-A.x)*u+d[0]*rr;p[1]=A.y+(B.y-A.y)*u+d[1]*rr;p[2]=A.z+(B.z-A.z)*u+d[2]*rr;break;}
      default:{const M=this.e.meshSamples,n=M.count,idx=Math.min(n-1,Math.floor(r()*n)),m=f.meshMatrix.elements,lp=M.positions,ln=M.normals,x=lp[idx*3],y=lp[idx*3+1],z=lp[idx*3+2];
        p[0]=m[0]*x+m[4]*y+m[8]*z+m[12];p[1]=m[1]*x+m[5]*y+m[9]*z+m[13];p[2]=m[2]*x+m[6]*y+m[10]*z+m[14];
        const nx=ln[idx*3],ny=ln[idx*3+1],nz=ln[idx*3+2];d[0]=m[0]*nx+m[4]*ny+m[8]*nz;d[1]=m[1]*nx+m[5]*ny+m[9]*nz;d[2]=m[2]*nx+m[6]*ny+m[10]*nz;const l=Math.hypot(d[0],d[1],d[2])||1;d[0]/=l;d[1]/=l;d[2]/=l;}
    }
    const fr=(k+.5)/Math.max(1,b.count),age=(1-fr)*b.span,ox=b.from.x+(b.to.x-b.from.x)*fr,oy=b.from.y+(b.to.y-b.from.y)*fr,oz=b.from.z+(b.to.z-b.from.z)*fr;
    if(sh.code!==8){const x=p[0],y=p[1],z=p[2];p[0]=ox+R3[0]*x+R3[3]*y+R3[6]*z;p[1]=oy+R3[1]*x+R3[4]*y+R3[7]*z;p[2]=oz+R3[2]*x+R3[5]*y+R3[8]*z;
      const dx=d[0],dy=d[1],dz=d[2];d[0]=R3[0]*dx+R3[3]*dy+R3[6]*dz;d[1]=R3[1]*dx+R3[4]*dy+R3[7]*dz;d[2]=R3[2]*dx+R3[5]*dy+R3[8]*dz;}
    const it=this.e.config.init,dir=this._v;
    switch(it.dirMode){
      case 0:{const v=f.dir;dir[0]=R3[0]*v.x+R3[3]*v.y+R3[6]*v.z;dir[1]=R3[1]*v.x+R3[4]*v.y+R3[7]*v.z;dir[2]=R3[2]*v.x+R3[5]*v.y+R3[8]*v.z;break;}
      case 1:dir[0]=d[0];dir[1]=d[1];dir[2]=d[2];break;
      case 2:this._randDir(dir);break;
      default:{const ux=R3[3],uy=R3[4],uz=R3[5],rx=p[0]-ox,ry=p[1]-oy,rz=p[2]-oz;dir[0]=uy*rz-uz*ry;dir[1]=uz*rx-ux*rz;dir[2]=ux*ry-uy*rx;const l=Math.hypot(dir[0],dir[1],dir[2]);
        if(l>1e-6){dir[0]/=l;dir[1]/=l;dir[2]/=l;}else this._randDir(dir);}
    }
    if(f.spread>0)this._cone(dir,dir[0],dir[1],dir[2],f.spread);
    const speed=f.speed.x+(f.speed.y-f.speed.x)*r(),life=Math.max(1e-3,f.life.x+(f.life.y-f.life.x)*r()),iv=f.initVel,ev=f.emitVel;
    const vx=dir[0]*speed+R3[0]*iv.x+R3[3]*iv.y+R3[6]*iv.z+ev.x,vy=dir[1]*speed+R3[1]*iv.x+R3[4]*iv.y+R3[7]*iv.z+ev.y,vz=dir[2]*speed+R3[2]*iv.x+R3[5]*iv.y+R3[8]*iv.z+ev.z;
    const P=this.pos,V=this.vel,j=i*3;P[j]=p[0]+vx*age;P[j+1]=p[1]+vy*age;P[j+2]=p[2]+vz*age;V[j]=vx;V[j+1]=vy;V[j+2]=vz;this.age[i]=age;this.life[i]=life;
  }
  _ground(x,z){const col=this.e.config.collision;let h=-1e9;if(col.plane!==null)h=col.plane;if(col.heightAt){const g=col.heightAt(x,z);if(Number.isFinite(g)&&g>h)h=g;}return h;}
  simulate(dt,e){
    const f=e.frame,c=e.config,fo=c.forces,col=c.collision,cap=e.capacity,P=this.pos,V=this.vel,A=this.age,L=this.life,onDeath=c.events.onDeath;
    const gx=f.gravity.x,gy=f.gravity.y,gz=f.gravity.z,wx=f.wind.x,wy=f.wind.y,wz=f.wind.z,damp=Math.exp(-f.drag*dt),t=e.vfx.time,cu=fo.curl,cv=this._c;
    const tw=f.toWorld.elements,tl=f.toLocal.elements,local=c.space==='local';let alive=0;
    for(let i=0;i<cap;i++){
      if(L[i]<=0||A[i]>=L[i])continue;const j=i*3;let px=P[j],py=P[j+1],pz=P[j+2],vx=V[j],vy=V[j+1],vz=V[j+2],ax=gx,ay=gy,az=gz;
      if(cu){const s=cu.scale,o=t*cu.speed;curlNoise(px*s+.31*o,py*s+o,pz*s+.73*o,cv,cu.octaves);ax+=cv[0]*cu.strength;ay+=cv[1]*cu.strength;az+=cv[2]*cu.strength;}
      if(f.turb>0){const qx=px*1.37+1.3*t,qy=py*1.37+.7*t,qz=pz*1.37-t,k=2*f.turb;ax+=(noise3(qx,qy,qz)-.5)*k;ay+=(noise3(qx+17.1,qy+3.3,qz+5.7)-.5)*k;az+=(noise3(qx-7.9,qy+11.3,qz+23.1)-.5)*k;}
      if(fo.vortex){const va=f.vortexAxis,vc=f.vortexCenter,rx=px-vc.x,ry=py-vc.y,rz=pz-vc.z,dp=rx*va.x+ry*va.y+rz*va.z,qx=rx-va.x*dp,qy=ry-va.y*dp,qz=rz-va.z*dp,d=Math.hypot(qx,qy,qz)+1e-4,s=f.vortex.x/d,pl=f.vortex.y/d;
        ax+=(va.y*qz-va.z*qy)*s-qx*pl;ay+=(va.z*qx-va.x*qz)*s-qy*pl;az+=(va.x*qy-va.y*qx)*s-qz*pl;}
      if(fo.attractor){const ap=f.attractPos,dx=ap.x-px,dy=ap.y-py,dz=ap.z-pz,dist=Math.hypot(dx,dy,dz)+1e-4,rad=f.attract.y,fall=rad>0?clamp(1-dist/rad,0,1):1,x=clamp(dist/.3,0,1),s=f.attract.x*fall*x*x*(3-2*x)/dist;ax+=dx*s;ay+=dy*s;az+=dz*s;}
      vx+=ax*dt;vy+=ay*dt;vz+=az*dt;vx=wx+(vx-wx)*damp;vy=wy+(vy-wy)*damp;vz=wz+(vz-wz)*damp;
      if(f.maxSpeed>0){const sp=Math.hypot(vx,vy,vz);if(sp>f.maxSpeed){const k=f.maxSpeed/sp;vx*=k;vy*=k;vz*=k;}}
      let dead=false;
      if(col){let nx=px+vx*dt,ny=py+vy*dt,nz=pz+vz*dt;if(local){const x=nx,y=ny,z=nz;nx=tw[0]*x+tw[4]*y+tw[8]*z+tw[12];ny=tw[1]*x+tw[5]*y+tw[9]*z+tw[13];nz=tw[2]*x+tw[6]*y+tw[10]*z+tw[14];}
        const g=this._ground(nx,nz)+col.radius;
        if(ny<g){if(col.die){dead=true;L[i]=-1;}else{let wvx=vx,wvy=vy,wvz=vz;if(local){wvx=tw[0]*vx+tw[4]*vy+tw[8]*vz;wvy=tw[1]*vx+tw[5]*vy+tw[9]*vz;wvz=tw[2]*vx+tw[6]*vy+tw[10]*vz;}
          let Nx=0,Ny=1,Nz=0;if(col.heightAt){const e2=.05;Nx=this._ground(nx-e2,nz)-this._ground(nx+e2,nz);Ny=2*e2;Nz=this._ground(nx,nz-e2)-this._ground(nx,nz+e2);const l=Math.hypot(Nx,Ny,Nz);Nx/=l;Ny/=l;Nz/=l;}
          const vn=wvx*Nx+wvy*Ny+wvz*Nz;if(vn<0){const fr=1-col.friction;wvx=(wvx-vn*Nx)*fr-Nx*vn*col.bounce;wvy=(wvy-vn*Ny)*fr-Ny*vn*col.bounce;wvz=(wvz-vn*Nz)*fr-Nz*vn*col.bounce;}
          if(local){vx=tl[0]*wvx+tl[4]*wvy+tl[8]*wvz;vy=tl[1]*wvx+tl[5]*wvy+tl[9]*wvz;vz=tl[2]*wvx+tl[6]*wvy+tl[10]*wvz;}else{vx=wvx;vy=wvy;vz=wvz;}}}}
      if(!dead){px+=vx*dt;py+=vy*dt;pz+=vz*dt;A[i]+=dt;
        if(col){let wx2=px,wy2=py,wz2=pz;if(local){wx2=tw[0]*px+tw[4]*py+tw[8]*pz+tw[12];wy2=tw[1]*px+tw[5]*py+tw[9]*pz+tw[13];wz2=tw[2]*px+tw[6]*py+tw[10]*pz+tw[14];}
          const g=this._ground(wx2,wz2)+col.radius;if(wy2<g){if(local){wy2=g;px=tl[0]*wx2+tl[4]*wy2+tl[8]*wz2+tl[12];py=tl[1]*wx2+tl[5]*wy2+tl[9]*wz2+tl[13];pz=tl[2]*wx2+tl[6]*wy2+tl[10]*wz2+tl[14];}else py=g;}}
        P[j]=px;P[j+1]=py;P[j+2]=pz;}
      V[j]=vx;V[j+1]=vy;V[j+2]=vz;
      if(dead||A[i]>=L[i]){if(onDeath){const info=this.deathInfo;info.index=i;info.position.set(px,py,pz);info.velocity.set(vx,vy,vz);if(local){info.position.applyMatrix4(f.toWorld);info.velocity.transformDirection(f.toWorld).multiplyScalar(Math.hypot(vx,vy,vz));}onDeath(info);}}
      else alive++;
    }
    const b=e.batches;for(let n=0;n<e.batchCount;n++){const s=b[n];for(let k=0;k<s.count;k++){const i=(s.start+k)%cap;if(!(L[i]>0&&A[i]<L[i]))alive++;this._spawn(i,s,k,f);}}
    this.alive=alive;this.passes=0;
  }
  /* Pack live particles into instance attributes (sorted back-to-front when requested). */
  pack(e,camera){
    const g=e.geometry,cap=e.capacity,P=this.pos,V=this.vel,A=this.age,L=this.life;
    if(e.config.render.ribbons){
      const aA=g.attributes.aA.array,aB=g.attributes.aB.array,aLS=g.attributes.aLS.array,aP=g.attributes.aP.array,aN=g.attributes.aN.array,win=e.window,gap=e.config.render.ribbonMaxGap,ag=e.config.render.ribbonMaxAgeGap;
      const ok=(a,b)=>L[a]>0&&A[a]<L[a]&&L[b]>0&&A[b]<L[b]&&A[b]<=A[a]+1e-4&&A[a]-A[b]<ag&&Math.hypot(P[a*3]-P[b*3],P[a*3+1]-P[b*3+1],P[a*3+2]-P[b*3+2])<gap;
      let n=0;for(let k=0;k+1<win.count;k++){const a=(win.base+k)%cap,b=(a+1)%cap;if(!ok(a,b))continue;const pa=(a-1+cap)%cap,nb=(b+1)%cap;
        for(let c=0;c<3;c++){aA[n*4+c]=P[a*3+c];aB[n*4+c]=P[b*3+c];aP[n*3+c]=k>0&&ok(pa,a)?P[pa*3+c]:P[a*3+c];aN[n*3+c]=k+2<win.count&&ok(b,nb)?P[nb*3+c]:P[b*3+c];}
        aA[n*4+3]=A[a];aB[n*4+3]=A[b];aLS[n*4]=L[a];aLS[n*4+1]=L[b];aLS[n*4+2]=a;aLS[n*4+3]=b;n++;}
      for(const k of ['aA','aB','aLS','aP','aN']){const at=g.attributes[k];at.updateRange.offset=0;at.updateRange.count=Math.max(1,n)*at.itemSize;at.needsUpdate=true;}
      return n;
    }
    const order=this.order;let n=0;for(let i=0;i<cap;i++)if(L[i]>0&&A[i]<L[i])order[n++]=i;
    if(e.config.render.sortAlpha&&camera&&n>1){const keys=this.keys,m=e._sortMatrix.elements;
      for(let k=0;k<n;k++){const i=order[k],x=P[i*3],y=P[i*3+1],z=P[i*3+2];keys[i]=m[2]*x+m[6]*y+m[10]*z+m[14];}
      const sub=order.subarray(0,n);sub.sort((a,b)=>keys[a]-keys[b]);}
    const pa=g.attributes.aPosAge.array,va=g.attributes.aVelLife.array,sa=g.attributes.aSlot.array;
    for(let k=0;k<n;k++){const i=order[k];pa[k*4]=P[i*3];pa[k*4+1]=P[i*3+1];pa[k*4+2]=P[i*3+2];pa[k*4+3]=A[i];va[k*4]=V[i*3];va[k*4+1]=V[i*3+1];va[k*4+2]=V[i*3+2];va[k*4+3]=L[i];sa[k]=i;}
    for(const k of ['aPosAge','aVelLife','aSlot']){const at=g.attributes[k];at.updateRange.offset=0;at.updateRange.count=Math.max(1,n)*at.itemSize;at.needsUpdate=true;}
    return n;
  }
  readState(){const cap=this.e.capacity,pos=new Float32Array(cap*4),vel=new Float32Array(cap*4);
    for(let i=0;i<cap;i++){for(let c=0;c<3;c++){pos[i*4+c]=this.pos[i*3+c];vel[i*4+c]=this.vel[i*3+c];}pos[i*4+3]=this.age[i];vel[i*4+3]=this.life[i];}return {position:pos,velocity:vel,width:cap,height:1};}
  dispose(){}
}

/* ---------- Emitter ---------- */
class Emitter{
  constructor(vfx,cfg){
    const THREE=vfx.THREE;this.vfx=vfx;this.THREE=THREE;const c=this.config=normalizeConfig(THREE,cfg,vfx.linearColors);
    this.name=c.name;this.forces=c.forces;this.attachTo=c.attachTo;this.position=c.position;this.orientation=c.orientation;this.rate=c.spawn.rate;
    const wantGPU=c.gpu&&!c.events.onDeath&&vfx.gpuSupported();
    let cap=c.scaleWithBudget?Math.max(64,Math.round(c.capacity*vfx.budget)):c.capacity;if(!wantGPU)cap=Math.min(cap,vfx.cpuLimit);
    this.capacity=cap;this.spawnScale=Math.min(1,cap/c.capacity);this.gpu=wantGPU;
    this.fallbackReason=wantGPU?null:!c.gpu?'gpu:false requested':c.events.onDeath?'events.onDeath needs CPU-visible particles':'float render targets unavailable';
    /* transform and per-frame simulation parameters */
    this.matrix=new THREE.Matrix4();this.inverse=new THREE.Matrix4();this.worldPos=new THREE.Vector3();this.prevPos=new THREE.Vector3();this.worldQuat=new THREE.Quaternion();this.velocity=new THREE.Vector3();
    this._tp=new THREE.Vector3();this._tq=new THREE.Quaternion();this._ts=new THREE.Vector3();this._one=new THREE.Vector3(1,1,1);this._v=new THREE.Vector3();this._m=new THREE.Matrix4();this._q=new THREE.Quaternion();
    this._sortMatrix=new THREE.Matrix4();
    const V3=()=>new THREE.Vector3(),V2=()=>new THREE.Vector2(),V4=()=>new THREE.Vector4();
    this.frame={emitRot:new THREE.Matrix3(),emitVel:V3(),shape:V4(),shapeSize:V3(),lineA:V3(),lineB:V3(),meshInfo:V3(),meshMatrix:new THREE.Matrix4(),life:V2(),speed:V2(),dir:V3(),spread:0,initVel:V3(),
      gravity:V3(),wind:V3(),drag:0,turb:0,maxSpeed:0,curl:V4(),vortexAxis:V3(),vortexCenter:V3(),vortex:V2(),attractPos:V3(),attract:V2(),collide:V4(),heightRegion:new THREE.Vector4(0,0,1,1),heightRes:2,
      toWorld:new THREE.Matrix4(),toLocal:new THREE.Matrix4()};
    this.batches=Array.from({length:MAX_BATCHES},()=>({start:0,count:0,span:0,seed:0,from:V3(),to:V3()}));this.batchCount=0;
    this.pending=Array.from({length:MAX_PENDING},()=>({count:0,pos:V3(),hasPos:false}));this.pendingHead=0;this.pendingCount=0;
    this.history=new SpawnHistory();this.window={base:0,count:0};
    this.cursor=0;this.seedCounter=(c.seed>>>0)%65536;this.rateAcc=0;this.elapsed=0;this.time=0;this.playing=false;this.started=false;this.visible=true;this.disposed=false;this._drawn=0;
    /* optional resources */
    this.meshSamples=null;this.meshTexture=null;this.heightTexture=null;this.heightData=null;this._heightCenter=null;this._heightBakeTime=-1;
    if(c.spawn.shape.code===8)this._buildMeshSamples();
    if(c.collision&&c.collision.heightAt&&wantGPU)this._initHeight();
    this.backend=wantGPU?new GPUBackend(this):new CPUBackend(this);
    this._buildRender();
    this._computeTransform();this.prevPos.copy(this.worldPos);
    if(c.autoplay)this.play();
  }
  /* ----- public API ----- */
  play(){if(!this.playing){this.playing=true;this.elapsed=0;this._resetBursts();}return this;}
  restart(){this.playing=false;return this.play();}
  stop({clear=false}={}){this.playing=false;if(clear){this.backend.clear();this.history.reset();this.pendingCount=0;this.rateAcc=0;this._drawn=0;if(this.mesh)this.mesh.visible=false;}return this;}
  burst(count,position){
    count=Math.max(0,Math.floor(+count||0));if(!count)return this;
    if(this.pendingCount===MAX_PENDING){const last=this.pending[(this.pendingHead+MAX_PENDING-1)%MAX_PENDING];last.count+=count;return this;}
    const p=this.pending[(this.pendingHead+this.pendingCount)%MAX_PENDING];p.count=count;p.hasPos=!!position;if(position)this._toVec(position,p.pos);this.pendingCount++;return this;
  }
  setPosition(x,y,z){if(x&&(x.isVector3||Array.isArray(x)))this._toVec(x,this.position);else this.position.set(+x||0,+y||0,+z||0);return this;}
  setRate(r){this.rate=Math.max(0,+r||0);return this;}
  get alive(){return this.gpu?this.history.estimate(this.time,this.frame.life.x,this.frame.life.y,this.capacity):this.backend.alive;}
  get drawn(){return this._drawn;}
  /* Debug/test helpers: full state read-back (synchronous GPU stall on the GPU path). */
  readState(){return this.backend.readState();}
  countAlive(){const s=this.readState();let n=0;for(let i=0;i<this.capacity;i++){const life=s.velocity[i*4+3];if(life>0&&s.position[i*4+3]<life)n++;}return n;}
  get gpuState(){return this.gpu?{position:this.backend.position,velocity:this.backend.velocity,width:this.backend.W,height:this.backend.H}:null;}
  dispose(){
    if(this.disposed)return;this.disposed=true;const i=this.vfx.emitters.indexOf(this);if(i>=0)this.vfx.emitters.splice(i,1);
    if(this.mesh&&this.mesh.parent)this.mesh.parent.remove(this.mesh);this.geometry.dispose();this.material.dispose();this.curveTexture.dispose();
    if(this.heightTexture)this.heightTexture.dispose();if(this.meshTexture)this.meshTexture.dispose();this.backend.dispose();
  }
  /* ----- internals ----- */
  _toVec(v,out){if(v.isVector3)return out.copy(v);return out.set(+v[0]||0,+v[1]||0,+v[2]||0);}
  _resetBursts(){for(const b of this.config.spawn.bursts){b.next=b.time;b.left=b.repeat;}}
  _computeTransform(){
    if(this.attachTo){this.attachTo.updateWorldMatrix(true,false);this.attachTo.matrixWorld.decompose(this._tp,this._tq,this._ts);
      this.worldPos.copy(this.position).applyQuaternion(this._tq).add(this._tp);this.worldQuat.copy(this._tq).multiply(this.orientation);}
    else{this.worldPos.copy(this.position);this.worldQuat.copy(this.orientation);}
    this.matrix.compose(this.worldPos,this.worldQuat,this._one);this.inverse.copy(this.matrix).invert();
  }
  _buildMeshSamples(){
    const THREE=this.THREE,sh=this.config.spawn.shape,src=sh.mesh;let geo=src.geometry,tmp=null;
    if(!THREE.MeshSurfaceSampler)throw new Error('KE.VFX: shape "mesh" needs THREE.MeshSurfaceSampler (three-addons)');
    if(geo.index){tmp=geo.toNonIndexed();geo=tmp;}
    const sampler=new THREE.MeshSurfaceSampler(new THREE.Mesh(geo));if(sampler.setRandomGenerator)sampler.setRandomGenerator(KE.random(this.config.seed+7));sampler.build();
    const n=sh.samples,positions=new Float32Array(n*3),normals=new Float32Array(n*3),p=new THREE.Vector3(),nn=new THREE.Vector3();
    for(let i=0;i<n;i++){sampler.sample(p,nn);p.toArray(positions,i*3);nn.toArray(normals,i*3);}
    if(tmp)tmp.dispose();this.meshSamples={count:n,positions,normals};
    if(this.config.gpu&&!this.config.events.onDeath&&this.vfx.gpuSupported()){const tw=Math.min(1024,nextPow2(Math.ceil(Math.sqrt(2*n)))),th=Math.ceil(2*n/tw),data=new Float32Array(tw*th*4);
      for(let i=0;i<n;i++)for(let c=0;c<3;c++){data[i*4+c]=positions[i*3+c];data[(n+i)*4+c]=normals[i*3+c];}
      const t=new THREE.DataTexture(data,tw,th,THREE.RGBAFormat,THREE.FloatType);t.minFilter=t.magFilter=THREE.NearestFilter;t.generateMipmaps=false;t.needsUpdate=true;this.meshTexture=t;this._meshTexW=tw;}
  }
  _initHeight(){const THREE=this.THREE,res=this.config.collision.resolution;this.heightData=new Float32Array(res*res*4);
    const t=new THREE.DataTexture(this.heightData,res,res,THREE.RGBAFormat,THREE.FloatType);t.minFilter=t.magFilter=THREE.NearestFilter;t.generateMipmaps=false;this.heightTexture=t;}
  /* Bake heightAt over a square region into the float height texture (GPU collision). */
  _bakeHeight(){
    const col=this.config.collision,res=col.resolution,f=this.frame,rg=col.region;let cx,cz,size;
    if(rg){cx=rg.center?+rg.center[0]:0;cz=rg.center?+rg.center[1]:0;size=+rg.size||32;if(this._heightCenter)return;}
    else{const it=this.config.init,fo=this.config.forces,sh=this.config.spawn.shape;const reach=Math.max(sh.radius,sh.size.x*.5,sh.size.z*.5)+(it.speed[1]+fo.wind.length())*it.life[1];
      size=clamp(reach*2+2,8,256);cx=this.worldPos.x;cz=this.worldPos.z;
      if(this._heightCenter&&Math.abs(cx-this._heightCenter.x)<size*.25&&Math.abs(cz-this._heightCenter.y)<size*.25)return;
      if(this._heightCenter&&this.time-this._heightBakeTime<.25)return;}
    const d=this.heightData,x0=cx-size/2,z0=cz-size/2,st=size/(res-1);
    for(let iz=0;iz<res;iz++)for(let ix=0;ix<res;ix++){const h=col.heightAt(x0+ix*st,z0+iz*st);d[(iz*res+ix)*4]=Number.isFinite(h)?h:-1e9;}
    this.heightTexture.needsUpdate=true;this._heightCenter=new this.THREE.Vector2(cx,cz);this._heightBakeTime=this.time;f.heightRegion.set(x0,z0,size,size);f.heightRes=res;
  }
  _buildRender(){
    const THREE=this.THREE,c=this.config,r=c.render,vfx=this.vfx,cap=this.capacity,gpu=this.gpu,ribbon=r.ribbons;
    /* curves LUT: row 0 = colour (sqrt-encoded) + alpha; row 1 = size/sizeMax, additive share */
    const lut=new Uint8Array(CURVE_RES*2*4),sc=r.sizeOverLife;let smax=0;for(let i=0;i<CURVE_RES;i++)smax=Math.max(smax,evalCurve(sc,i/(CURVE_RES-1)));smax=Math.max(smax,1e-6);
    for(let i=0;i<CURVE_RES;i++){const t=i/(CURVE_RES-1),k=i*4,k2=(CURVE_RES+i)*4;
      for(let ch=0;ch<3;ch++)lut[k+ch]=Math.round(Math.sqrt(clamp(evalCurve(r.colorOverLife,t,ch+1),0,1))*255);lut[k+3]=Math.round(clamp(evalCurve(r.colorOverLife,t,4),0,1)*255);
      lut[k2]=Math.round(clamp(evalCurve(sc,t)/smax,0,1)*255);lut[k2+1]=Math.round(clamp(evalCurve(r.blendOverLife,t),0,1)*255);lut[k2+2]=0;lut[k2+3]=255;}
    const lt=new THREE.DataTexture(lut,CURVE_RES,2,THREE.RGBAFormat);lt.minFilter=lt.magFilter=THREE.LinearFilter;lt.generateMipmaps=false;lt.needsUpdate=true;this.curveTexture=lt;
    /* geometry */
    const g=new THREE.InstancedBufferGeometry();
    g.setAttribute('position',new THREE.Float32BufferAttribute(ribbon?[0,-1,0,1,-1,0,1,1,0,0,1,0]:[-1,-1,0,1,-1,0,1,1,0,-1,1,0],3));g.setIndex([0,1,2,0,2,3]);
    const inst=(n,size)=>{const a=new THREE.InstancedBufferAttribute(new Float32Array(n*size),size);a.setUsage(THREE.DynamicDrawUsage);return a;};
    if(gpu){const idx=new Float32Array(cap);for(let i=0;i<cap;i++)idx[i]=i;g.setAttribute('aIndex',new THREE.InstancedBufferAttribute(idx,1));}
    else if(ribbon){g.setAttribute('aA',inst(cap,4));g.setAttribute('aB',inst(cap,4));g.setAttribute('aLS',inst(cap,4));g.setAttribute('aP',inst(cap,3));g.setAttribute('aN',inst(cap,3));}
    else{g.setAttribute('aPosAge',inst(cap,4));g.setAttribute('aVelLife',inst(cap,4));g.setAttribute('aSlot',inst(cap,1));}
    g.instanceCount=0;this.geometry=g;
    /* material */
    const map=r.texture&&r.texture.isTexture?r.texture:vfx.texture(r.texture),straight=r.texture&&r.texture.isTexture?r.premultipliedTexture!==true:false;
    const defines={};if(!gpu)defines.KE_CPU=1;if(ribbon)defines.KE_RIBBON=1;else{if(r.stretch>0)defines.KE_STRETCH=1;if(r.flipbook){defines.KE_FLIP=1;if(r.flipbook.blend)defines.KE_FLIP_BLEND=1;}if(r.sortAlpha&&gpu)defines.KE_SORT=1;}
    if(r.softness>0)defines.KE_SOFT=1;if(r.lit&&!ribbon)defines.KE_LIT=1;if(straight)defines.KE_STRAIGHT_MAP=1;
    const su=KE.sceneUniforms(THREE),fb=r.flipbook||{cols:1,rows:1,fps:0,frames:1,random:false};
    const uniforms={...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      tPos:{value:null},tVel:{value:null},tSort:{value:null},uBase:{value:0},uCap:{value:cap},uStateW:{value:gpu?this.backend.W:1},uSortW:{value:1},uCount:{value:0},
      tCurves:{value:lt},map:{value:map},uSizeInfo:{value:new THREE.Vector4(c.init.size[0],c.init.size[1],smax,r.stretch)},uColorA:{value:new THREE.Vector3(c.init.color[0].r,c.init.color[0].g,c.init.color[0].b)},
      uColorB:{value:new THREE.Vector3(c.init.color[1].r,c.init.color[1].g,c.init.color[1].b)},uRotInfo:{value:new THREE.Vector4(c.init.rotation[0],c.init.rotation[1],c.init.angularVelocity[0],c.init.angularVelocity[1])},
      uFlip:{value:new THREE.Vector4(fb.cols,fb.rows,fb.fps,fb.frames)},uFlipRandom:{value:fb.random?1:0},uWorldSpace:{value:c.space==='world'?1:0},uEmissive:{value:r.emissive},
      uRibbon:{value:new THREE.Vector4(r.ribbonMaxGap,r.ribbonMaxAgeGap,r.ribbonUV==='length'?1:0,0)},uSoftness:{value:Math.max(r.softness,1e-3)},uCameraFade:{value:new THREE.Vector2(r.cameraFade[0],r.cameraFade[1])},
      uLitInfo:{value:new THREE.Vector4(r.curvature,r.wrap,r.translucency,0)},uAmbient:{value:new THREE.Vector3(r.ambient.r,r.ambient.g,r.ambient.b)},
      keSceneDepth:su.keSceneDepth,keHasScene:su.keHasScene,keResolution:su.keResolution,keSunDirection:su.keSunDirection,keSunColor:su.keSunColor};
    const m=new THREE.ShaderMaterial({vertexShader:RENDER_VS,fragmentShader:RENDER_FS,uniforms,defines,transparent:true,depthWrite:false,depthTest:true,fog:true,
      blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,blendSrc:THREE.OneFactor,blendDst:THREE.OneMinusSrcAlphaFactor,blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.OneMinusSrcAlphaFactor});
    m.userData.keTextures=[lt];this.material=m;
    const mesh=new THREE.Mesh(g,m);mesh.frustumCulled=false;mesh.matrixAutoUpdate=false;mesh.renderOrder=r.order;mesh.name='KE.VFX:'+c.name;mesh.userData.keVFX=this;mesh.visible=false;
    mesh.castShadow=mesh.receiveShadow=false;
    const translucent=r.softness>0||r.blending!=='additive';mesh.layers.set(r.layer!==null?r.layer:translucent?KE.LAYERS.TRANSLUCENT:KE.LAYERS.DEFAULT);
    this.mesh=mesh;vfx.scene.add(mesh);
  }
  _schedule(dt){
    const c=this.config,s=c.spawn,wp=this.worldPos,pp=this.prevPos,local=c.space==='local',scale=this.spawnScale;this.batchCount=0;let budget=this.capacity;
    const add=(count,span,from,to)=>{count=Math.min(count,budget);if(count<=0||this.batchCount>=MAX_BATCHES)return;const b=this.batches[this.batchCount++];
      b.start=this.cursor;b.count=count;b.span=span;b.seed=(this.seedCounter=(this.seedCounter+1)%16777216);b.from.copy(from);b.to.copy(to);this.cursor=(this.cursor+count)%this.capacity;budget-=count;};
    const origin=this._v;
    if(this.playing){
      const t0=this.elapsed,t1=t0+dt,emitting=t0<s.duration;
      if(emitting){const moved=pp.distanceTo(wp);this.rateAcc+=(this.rate*Math.min(dt,s.duration-t0)+(moved<50?moved*s.rateOverDistance:0))*scale;
        const n=Math.floor(this.rateAcc);this.rateAcc-=n;if(n>0){if(local){origin.set(0,0,0);add(n,dt,origin,origin);}else add(n,dt,pp,wp);}}
      if(local)origin.set(0,0,0);else origin.copy(wp);
      for(const b of s.bursts){while(b.left>0&&b.next<t1&&b.next<s.duration){b.left--;const n=b.count[0]+Math.floor(Math.random()*(b.count[1]-b.count[0]+1));
          if(Math.random()<=b.probability)add(Math.round(n*scale),0,origin,origin);if(b.cycle>0)b.next+=b.cycle;else b.left=0;}}
      this.elapsed=t1;
      if(t1>=s.duration){if(s.loop){this.elapsed=t1-s.duration*Math.floor(t1/s.duration);this._resetBursts();}else this.playing=false;}
    }
    while(this.pendingCount&&this.batchCount<MAX_BATCHES&&budget>0){const p=this.pending[this.pendingHead];this.pendingHead=(this.pendingHead+1)%MAX_PENDING;this.pendingCount--;
      if(p.hasPos){if(local)origin.copy(p.pos).applyMatrix4(this.inverse);else origin.copy(p.pos);}else if(local)origin.set(0,0,0);else origin.copy(wp);
      add(Math.max(1,Math.round(p.count*scale)),0,origin,origin);}
    let total=0;for(let i=0;i<this.batchCount;i++)total+=this.batches[i].count;return total;
  }
  /* Convert config into simulation-space parameters for this frame (shared by both backends). */
  _frameParams(dt){
    const c=this.config,f=this.frame,fo=c.forces,it=c.init,sh=c.spawn.shape,local=c.space==='local',q=this._q;
    if(local){f.emitRot.identity();f.toWorld.copy(this.matrix);f.toLocal.copy(this.inverse);}else{f.emitRot.setFromMatrix4(this._m.makeRotationFromQuaternion(this.worldQuat));f.toWorld.identity();f.toLocal.identity();}
    if(!local&&dt>0)f.emitVel.copy(this.worldPos).sub(this.prevPos).multiplyScalar(it.inheritVelocity/dt);else f.emitVel.set(0,0,0);
    if(f.emitVel.lengthSq()>1e6)f.emitVel.set(0,0,0);
    f.shape.set(sh.radius,sh.thickness,sh.angle,sh.surfaceOnly?1:0);if(sh.code===6)f.shapeSize.set(sh.width,0,0);else f.shapeSize.copy(sh.size);f.lineA.copy(sh.from);f.lineB.copy(sh.to);
    if(sh.code===8){sh.mesh.updateWorldMatrix(true,false);if(local)f.meshMatrix.multiplyMatrices(this.inverse,sh.mesh.matrixWorld);else f.meshMatrix.copy(sh.mesh.matrixWorld);f.meshInfo.set(this.meshSamples.count,this._meshTexW||1,0);}
    f.life.set(it.life[0],it.life[1]);f.speed.set(it.speed[0],it.speed[1]);f.dir.copy(it.direction);f.spread=it.spread;f.initVel.copy(it.velocity);
    q.copy(this.worldQuat).invert();
    if(local){f.gravity.copy(fo.gravity).applyQuaternion(q);f.wind.copy(fo.wind).applyQuaternion(q);}else{f.gravity.copy(fo.gravity);f.wind.copy(fo.wind);}
    f.drag=fo.drag;f.turb=fo.turbulence;f.maxSpeed=fo.maxSpeed;
    if(fo.curl)f.curl.set(fo.curl.strength,fo.curl.scale,fo.curl.speed,fo.curl.octaves);
    if(fo.vortex){f.vortexAxis.copy(fo.vortex.axis);f.vortexCenter.copy(fo.vortex.center);if(!local){f.vortexAxis.applyQuaternion(this.worldQuat);f.vortexCenter.applyMatrix4(this.matrix);}f.vortex.set(fo.vortex.strength,fo.vortex.pull);}
    if(fo.attractor){f.attractPos.copy(fo.attractor.position);if(!local)f.attractPos.applyMatrix4(this.matrix);f.attract.set(fo.attractor.strength,fo.attractor.radius);}
    const col=c.collision;if(col){f.collide.set(col.plane!==null?col.plane:-1e9,col.bounce,col.friction,col.radius);if(col.heightAt&&this.gpu)this._bakeHeight();}
  }
  _update(dt,camera){
    const c=this.config;this._computeTransform();
    if(!this.started){this.prevPos.copy(this.worldPos);this.started=true;}
    this._frameParams(dt);
    const spawned=this._schedule(dt),start=this.batchCount?this.batches[0].start:this.cursor;
    this.time+=dt;
    const lmax=c.init.life[1];this.history.prune(this.time,lmax);this.history.window(this.cursor,this.capacity,this.window);
    const busy=this.gpu?(this.batchCount>0||this.window.count>0):(this.batchCount>0||this.backend.alive>0);
    if(busy&&dt>0)this.backend.simulate(dt,this);else this.backend.passes=0;
    this.history.add(this.time,spawned,start,Math.max(lmax/24,1/30));this.history.window(this.cursor,this.capacity,this.window);
    this.prevPos.copy(this.worldPos);
    /* render state */
    const r=c.render,u=this.material.uniforms,mesh=this.mesh;
    if(c.space==='local')mesh.matrix.copy(this.matrix);else mesh.matrix.makeTranslation(this.worldPos.x,this.worldPos.y,this.worldPos.z);
    mesh.matrixWorldNeedsUpdate=true;
    if(camera){this._sortMatrix.copy(camera.matrixWorldInverse);if(c.space==='local')this._sortMatrix.multiply(this.matrix);}
    let count;
    if(this.gpu){const b=this.backend;u.tPos.value=b.position.texture;u.tVel.value=b.velocity.texture;u.uBase.value=this.window.base;u.uCount.value=this.window.count;
      count=r.ribbons?Math.max(0,this.window.count-1):this.window.count;
      if(r.sortAlpha&&!r.ribbons&&count>0){if(camera){const rt=b.sortWindow(this.window,this._sortMatrix);u.tSort.value=rt.texture;u.uSortW.value=b.sort.SW;}else if(!u.tSort.value)count=0;}}
    else count=this.window.count>0||this.backend.alive>0?this.backend.pack(this,camera):0;
    this.geometry.instanceCount=count;this._drawn=count;mesh.visible=this.visible&&count>0;
  }
}

/* A set of emitters driven together (e.g. layered presets such as explosion). */
class EmitterGroup{
  constructor(emitters){this.emitters=emitters;}
  play(){for(const e of this.emitters)e.play();return this;}
  restart(){for(const e of this.emitters)e.restart();return this;}
  stop(o){for(const e of this.emitters)e.stop(o);return this;}
  /* Distributes count over the members in proportion to their configured burst sizes (equally if none). */
  burst(count,position){const w=this.emitters.map(e=>e.config.spawn.bursts.reduce((s,b)=>s+(b.count[0]+b.count[1])/2,0)),tot=w.reduce((a,b)=>a+b,0);
    this.emitters.forEach((e,i)=>e.burst(Math.round(count*(tot>0?w[i]/tot:1/this.emitters.length)),position));return this;}
  setPosition(x,y,z){for(const e of this.emitters)e.setPosition(x,y,z);return this;}
  setRate(r){for(const e of this.emitters)e.setRate(r);return this;}
  get alive(){return this.emitters.reduce((s,e)=>s+e.alive,0);}
  get playing(){return this.emitters.some(e=>e.playing);}
  get capacity(){return this.emitters.reduce((s,e)=>s+e.capacity,0);}
  set visible(v){for(const e of this.emitters)e.visible=v;}
  get visible(){return this.emitters.some(e=>e.visible);}
  dispose(){for(const e of this.emitters)e.dispose();this.emitters.length=0;}
}

/* ---------- presets ---------- */
/* Each preset is (opts) => config (or an array of configs for layered effects). Common opts:
   position, attachTo, scale (world size multiplier), intensity (emissive/rate multiplier), color,
   ground (collision plane height or heightAt function); anything else is deep-merged into the config. */
function presetFactory(build){
  return (opts={})=>{const {position,attachTo,scale=1,intensity=1,color,ground,...rest}=opts||{};
    /* a preset's own position is an offset (e.g. rain starts above the given point) */
    const apply=cfg=>{if(position!==undefined){const p=position.isVector3?position.toArray():position,o=cfg.position||[0,0,0];cfg.position=[+p[0]+o[0],+p[1]+o[1],+p[2]+o[2]];}
      if(attachTo)cfg.attachTo=attachTo;return deepMerge(cfg,rest);};
    const out=build({s:scale,k:intensity,color,ground});return Array.isArray(out)?out.map(apply):apply(out);};
}
const groundCollision=(ground,extra)=>ground===undefined||ground===null?undefined:{...(typeof ground==='function'?{heightAt:ground}:{plane:+ground}),...extra};
const PRESETS={
  fire:presetFactory(({s,k,color})=>({name:'fire',capacity:320,spawn:{rate:95*k,shape:{type:'disc',radius:.3*s}},
    init:{life:[.55,1.05],speed:[.8*s,1.5*s],direction:[0,1,0],spread:.18,size:[.5*s,.75*s],color:color||[0xffffff,0xffe2b8],rotation:[0,TAU],angularVelocity:[-1.6,1.6]},
    forces:{gravity:[0,2.3*s,0],drag:1.6,curl:{strength:2.2*s,scale:1.1/s,speed:1.4}},
    render:{blending:'premultiplied',texture:'smoke',flipbook:{cols:2,rows:2,fps:0,random:true},emissive:1.9*k,softness:.35,
      sizeOverLife:[[0,.55],[.15,1],[.6,.72],[1,.15]],blendOverLife:[[0,1],[.75,1],[1,.7]],
      colorOverLife:[[0,0xfff4d0,0],[.06,0xffe49a,.9],[.25,0xffae3a,.85],[.5,0xff6414,.6],[.75,0xa82408,.3],[1,0x300804,0]]}})),
  smoke:presetFactory(({s,k,color})=>({name:'smoke',capacity:160,spawn:{rate:11*k,shape:{type:'disc',radius:.3*s}},
    init:{life:[3.8,5.6],speed:[.45*s,.8*s],direction:[0,1,0],spread:.28,size:[1.3*s,2.1*s],color:color||[0x8e8e92,0x6c6c70],rotation:[0,TAU],angularVelocity:[-.35,.35]},
    forces:{gravity:[0,.22*s,0],drag:.55,wind:[.3*s,0,.08*s],curl:{strength:.45*s,scale:.35/s,speed:.35}},
    render:{blending:'alpha',texture:'smoke',lit:true,sortAlpha:true,softness:1.2*s,sizeOverLife:[[0,.3],[1,1]],
      colorOverLife:[[0,0xffffff,0],[.12,0xffffff,.5],[.55,0xf0f0f0,.32],[1,0xe8e8e8,0]]}})),
  sparks:presetFactory(({s,k,color,ground})=>({name:'sparks',capacity:600,spawn:{rate:34*k,bursts:[{time:0,count:[26,40],cycle:1.1}],shape:{type:'cone',radius:.06*s,angle:.5}},
    init:{life:[.55,1.35],speed:[3.2*s,6.5*s],direction:'shape',size:[.03*s,.055*s],color:color||[0xfff3c0,0xffc060]},
    forces:{gravity:[0,-9.8*s,0],drag:.35},collision:groundCollision(ground,{bounce:.35,friction:.25}),
    render:{blending:'additive',texture:'spark',stretch:.055,emissive:5*k,softness:0,
      colorOverLife:[[0,0xffffff,1],[.25,0xffd070,1],[.65,0xff6a18,.85],[1,0x901000,0]],sizeOverLife:[[0,1],[.7,.85],[1,.4]]}})),
  embers:presetFactory(({s,k,color})=>({name:'embers',capacity:160,spawn:{rate:14*k,shape:{type:'disc',radius:.5*s}},
    init:{life:[2.4,4.4],speed:[.4*s,.9*s],direction:[0,1,0],spread:.4,size:[.045*s,.085*s],color:color||[0xffb050,0xff6a1a]},
    forces:{gravity:[0,.45*s,0],drag:.8,curl:{strength:1.9*s,scale:.7/s,speed:.8}},
    render:{blending:'additive',texture:'soft',emissive:4*k,softness:.2,sizeOverLife:[[0,0],[.08,1],[.75,.8],[1,0]],
      colorOverLife:[[0,0xffffff,0],[.08,0xffffff,1],[.45,0xffc080,.9],[.7,0xff9050,.5],[.8,0xffc090,.9],[1,0xff4010,0]]}})),
  fireflies:presetFactory(({s,k,color})=>{const c=color||0xe0ff80;return {name:'fireflies',capacity:96,spawn:{rate:7*k,shape:{type:'box',size:[5*s,1.6*s,5*s]}},position:[0,1,0],
    init:{life:[4.5,8],speed:[.05*s,.2*s],direction:'random',size:[.16*s,.24*s],color:[c,0xa8ff60]},
    forces:{drag:.7,curl:{strength:.55*s,scale:.45/s,speed:.3}},
    render:{blending:'additive',texture:'soft',emissive:2.2*k,softness:.3,sizeOverLife:[[0,.6],[.5,1],[1,.6]],
      colorOverLife:[[0,0xffffff,0],[.12,0xffffff,1],[.24,0xffffff,.12],[.38,0xffffff,1],[.52,0xffffff,.2],[.66,0xffffff,1],[.8,0xffffff,.15],[.9,0xffffff,.9],[1,0xffffff,0]]}};}),
  magic:presetFactory(({s,k,color})=>({name:'magic',capacity:384,spawn:{rate:80*k,shape:{type:'sphere',radius:.55*s,thickness:.5}},position:[0,1.1*s,0],
    init:{life:[1.6,2.8],speed:[.15*s,.4*s],direction:'tangent',spread:.5,size:[.05*s,.12*s],color:color||[0x60e4ff,0xb47cff]},
    forces:{gravity:[0,.35*s,0],drag:1.2,curl:{strength:2.2*s,scale:1.2/s,speed:1},vortex:{axis:[0,1,0],strength:1.4*s,pull:.35*s},attractor:{position:[0,0,0],strength:.9*s,radius:3*s}},
    render:{blending:'additive',texture:'soft',stretch:.05,emissive:2.8*k,softness:.3,sizeOverLife:[[0,.2],[.15,1],[.7,.7],[1,0]],
      colorOverLife:[[0,0xffffff,0],[.1,0xffffff,1],[.5,0xc8e4ff,.8],[1,0x7050ff,0]]}})),
  rain:presetFactory(({s,k,color,ground})=>({name:'rain',capacity:3000,spawn:{rate:1800*k,shape:{type:'box',size:[30*s,0,30*s]}},position:[0,14*s,0],
    init:{life:[1.1,1.25],speed:[13*s,16*s],direction:[.08,-1,.03],spread:.02,size:[.018*s,.028*s],color:color||0xb8d0f0},
    forces:{gravity:[0,-3*s,0]},collision:groundCollision(ground===undefined?0:ground,{die:true}),
    render:{blending:'premultiplied',texture:'spark',stretch:.05,softness:0,emissive:1.2*k,blendOverLife:[[0,.4],[1,.4]],colorOverLife:[[0,0xffffff,0],[.05,0xffffff,.55],[1,0xffffff,.55]]}})),
  snow:presetFactory(({s,k,color,ground})=>({name:'snow',capacity:3000,spawn:{rate:170*k,shape:{type:'box',size:[30*s,0,30*s]}},position:[0,12*s,0],
    init:{life:[12,16],speed:[.6*s,1.1*s],direction:[0,-1,0],spread:.3,size:[.05*s,.1*s],color:color||0xffffff,rotation:[0,TAU]},
    forces:{gravity:[0,-.5*s,0],drag:.6,curl:{strength:.5*s,scale:.35/s,speed:.3}},collision:groundCollision(ground===undefined?0:ground,{bounce:0,friction:1,radius:.02*s}),
    render:{blending:'alpha',texture:'soft',softness:.2,colorOverLife:[[0,0xffffff,0],[.05,0xffffff,.95],[.9,0xffffff,.9],[1,0xffffff,0]]}})),
  dust:presetFactory(({s,k,color})=>({name:'dust',capacity:96,spawn:{rate:6*k,shape:{type:'disc',radius:3*s}},position:[0,.9*s,0],
    init:{life:[5,8],speed:[.05*s,.2*s],direction:'random',size:[1.6*s,2.8*s],color:color||0xb8a888,rotation:[0,TAU],angularVelocity:[-.2,.2]},
    forces:{drag:.4,wind:[.3*s,0,0],curl:{strength:.3*s,scale:.3/s,speed:.25}},
    render:{blending:'alpha',texture:'smoke',lit:true,softness:1*s,sizeOverLife:[[0,.6],[1,1]],colorOverLife:[[0,0xffffff,0],[.3,0xffffff,.09],[.7,0xffffff,.07],[1,0xffffff,0]]}})),
  leaves:presetFactory(({s,k,color,ground})=>({name:'leaves',capacity:128,spawn:{rate:6*k,shape:{type:'box',size:[10*s,0,10*s]}},position:[0,7*s,0],
    init:{life:[8,11],speed:[.1*s,.4*s],direction:'random',size:[.18*s,.28*s],color:color||[0xe0a030,0xb8401a],rotation:[0,TAU],angularVelocity:[-2.6,2.6]},
    forces:{gravity:[0,-1.2*s,0],drag:1.4,wind:[.5*s,0,.2*s],curl:{strength:1.6*s,scale:.5/s,speed:.6}},collision:groundCollision(ground===undefined?0:ground,{bounce:0,friction:.9,radius:.02*s}),
    render:{blending:'alpha',texture:'leaf',lit:true,translucency:.8,curvature:.35,softness:.1,colorOverLife:[[0,0xffffff,0],[.03,0xffffff,1],[.9,0xffffff,1],[1,0xffffff,0]]}})),
  waterSplash:presetFactory(({s,k,color,ground})=>({name:'waterSplash',capacity:256,spawn:{bursts:[{time:0,count:[70,90]}],duration:.2,loop:false,shape:{type:'cone',radius:.15*s,angle:.55}},
    init:{life:[.6,1.1],speed:[2.4*s,5*s],direction:'shape',size:[.04*s,.09*s],color:color||[0xe8f6ff,0xa8d4ff]},
    forces:{gravity:[0,-9.8*s,0],drag:.3},collision:groundCollision(ground===undefined?0:ground,{die:true}),
    render:{blending:'premultiplied',texture:'soft',stretch:.03,emissive:1.4*k,softness:.2,blendOverLife:[[0,.5],[1,.5]],colorOverLife:[[0,0xffffff,.9],[.7,0xffffff,.7],[1,0xffffff,0]]}})),
  explosion:presetFactory(({s,k,color})=>[
    {name:'explosion.fireball',capacity:128,spawn:{bursts:[{time:0,count:[55,65]}],duration:.3,loop:false,shape:{type:'sphere',radius:.35*s}},
      init:{life:[.9,1.9],speed:[1.2*s,4*s],direction:'shape',size:[1*s,1.7*s],color:color||[0xffc070,0xff9040],rotation:[0,TAU],angularVelocity:[-1,1]},
      forces:{gravity:[0,1.1*s,0],drag:2.6,curl:{strength:1.2*s,scale:.5/s,speed:.6}},
      render:{blending:'premultiplied',texture:'smoke',emissive:3*k,softness:.6*s,sizeOverLife:[[0,.35],[.15,1],[1,1.6]],blendOverLife:[[0,1],[.25,.9],[.45,0],[1,0]],
        colorOverLife:[[0,0xfff4d0,1],[.1,0xffb040,1],[.28,0xd04010,.9],[.45,0x3a2418,.75],[1,0x1a1818,0]]}},
    {name:'explosion.sparks',capacity:256,spawn:{bursts:[{time:0,count:[140,170]}],duration:.3,loop:false,shape:{type:'sphere',radius:.2*s}},
      init:{life:[.6,1.6],speed:[5*s,13*s],direction:'shape',size:[.03*s,.06*s],color:[0xfff0c0,0xffb050]},forces:{gravity:[0,-9.8*s,0],drag:.9},
      render:{blending:'additive',texture:'spark',stretch:.05,emissive:6*k,softness:0,colorOverLife:[[0,0xffffff,1],[.4,0xffc060,1],[1,0xff4010,0]]}},
    {name:'explosion.smoke',capacity:64,spawn:{bursts:[{time:.12,count:[18,24]}],duration:.3,loop:false,shape:{type:'sphere',radius:.6*s}},
      init:{life:[2.6,4.2],speed:[.5*s,1.6*s],direction:'shape',size:[1.6*s,2.6*s],color:[0x5a5654,0x3e3a38],rotation:[0,TAU],angularVelocity:[-.4,.4]},
      forces:{gravity:[0,.7*s,0],drag:1.2,curl:{strength:.5*s,scale:.35/s,speed:.3}},
      render:{blending:'alpha',texture:'smoke',lit:true,sortAlpha:true,softness:1*s,sizeOverLife:[[0,.5],[1,1.3]],colorOverLife:[[0,0xffffff,0],[.12,0xffffff,.75],[.6,0xffffff,.45],[1,0xffffff,0]]}}]),
  portal:presetFactory(({s,k,color})=>({name:'portal',capacity:600,space:'local',orientation:[Math.PI/2,0,0],position:[0,1.4*s,0],spawn:{rate:200*k,shape:{type:'ring',radius:1.15*s,width:.06*s}},
    init:{life:[1.1,2],speed:[.5*s,1*s],direction:'tangent',spread:.15,size:[.04*s,.1*s],color:color||[0x9a70ff,0x50d8ff]},
    forces:{drag:.9,vortex:{axis:[0,1,0],strength:1.8*s,pull:.9*s},curl:{strength:.6*s,scale:1.2/s,speed:.8}},
    render:{blending:'additive',texture:'soft',stretch:.05,emissive:2.4*k,softness:.2,sizeOverLife:[[0,0],[.15,1],[1,.2]],colorOverLife:[[0,0xffffff,0],[.15,0xffffff,.9],[.7,0xe0d8ff,.6],[1,0x8060ff,0]]}})),
  trail:presetFactory(({s,k,color})=>({name:'trail',capacity:256,spawn:{rate:0,rateOverDistance:14/s,shape:{type:'point'}},
    init:{life:[.7,.7],speed:[0,0],size:[.28*s,.28*s],color:color||0x80e8ff},
    render:{blending:'additive',texture:'soft',ribbons:true,emissive:3*k,softness:.2,sizeOverLife:[[0,1],[1,0]],colorOverLife:[[0,0xffffff,1],[.5,0xc0d8ff,.7],[1,0x6070ff,0]]}})),
};

/* ---------- VFX system ---------- */
KE.VFX=class{
  constructor(THREE,renderer,scene,{budget,cpuLimit=2048,maxDt=.1,prepareCamera=true,linearColors}={}){
    if(!THREE||!renderer||!scene)throw new TypeError('new KE.VFX(THREE, renderer, scene, options)');
    this.THREE=THREE;this.renderer=renderer;this.scene=scene;this.budget=clamp(Number.isFinite(budget)?budget:(Number.isFinite(KE.settings.vfx)?KE.settings.vfx:1),0,1);
    this.cpuLimit=Math.max(64,Math.floor(cpuLimit));this.maxDt=maxDt;this.prepareCamera=prepareCamera;
    this.linearColors=linearColors===undefined?renderer.outputEncoding===THREE.sRGBEncoding:!!linearColors;
    this.emitters=[];this.time=0;this.frameCount=0;this.fsq=new KE.FullScreenQuad(THREE);this._textures={};this._gpuOK=undefined;this._iter=[];this._cc=new THREE.Color();this.disposed=false;
    this.presets=PRESETS;
  }
  /* One-time probe: WebGL2, float colour attachments that really render and read back, vertex texture fetch. */
  gpuSupported(){
    if(this._gpuOK!==undefined)return this._gpuOK;const THREE=this.THREE,r=this.renderer,caps=KE.capabilities(r);
    if(!caps.webgl2||!caps.floatRT||(r.capabilities.maxVertexTextures||0)<4)return this._gpuOK=false;
    const rt=new THREE.WebGLRenderTarget(1,1,{type:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false});
    const m=new THREE.ShaderMaterial({vertexShader:KE.FULLSCREEN_VS,fragmentShader:PROBE_FS,depthTest:false,depthWrite:false,blending:THREE.NoBlending});let ok=false;
    try{this.fsq.render(r,rt,m);const px=new Float32Array(4);r.readRenderTargetPixels(rt,0,0,1,1,px);ok=px[0]===1.5&&px[1]===-2.25&&px[2]===65536&&px[3]===.125;}catch(e){ok=false;}
    rt.dispose();m.dispose();return this._gpuOK=ok;
  }
  get gpu(){return this.gpuSupported();}
  texture(name){
    if(name&&name.isTexture)return name;if(!TEXTURE_PAINTERS[name])throw new RangeError('KE.VFX: unknown texture "'+name+'"');
    if(!this._textures[name]){const t=new this.THREE.CanvasTexture(TEXTURE_PAINTERS[name]());t.premultiplyAlpha=true;t.anisotropy=1;t.userData={keVFX:name};this._textures[name]=t;}
    return this._textures[name];
  }
  emitter(cfg){
    if(this.disposed)throw new Error('KE.VFX: disposed');
    if(Array.isArray(cfg)){const list=[];try{for(const c of cfg)list.push(this.emitter(c));}catch(err){for(const e of list)e.dispose();throw err;}return new EmitterGroup(list);}
    const e=new Emitter(this,cfg);this.emitters.push(e);return e;
  }
  update(dt,camera){
    if(this.disposed)return;dt=clamp(Number(dt)||0,0,this.maxDt);
    if(camera){if(this.prepareCamera&&KE.prepareCamera)KE.prepareCamera(camera);camera.updateMatrixWorld();}
    this.time+=dt;this.frameCount++;const list=this._iter;list.length=0;for(const e of this.emitters)list.push(e);
    for(const e of list)if(!e.disposed)e._update(dt,camera);list.length=0;
  }
  stats(){let capacity=0,alive=0,drawn=0,gpuEmitters=0,passes=0;
    for(const e of this.emitters){capacity+=e.capacity;alive+=e.alive;drawn+=e.drawn;if(e.gpu)gpuEmitters++;passes+=e.backend.passes;}
    return {emitters:this.emitters.length,capacity,alive,drawn,gpu:this.gpuSupported(),gpuEmitters,cpuEmitters:this.emitters.length-gpuEmitters,simPasses:passes,budget:this.budget};}
  _clear(rt){const r=this.renderer,prev=r.getRenderTarget(),a=r.getClearAlpha();r.getClearColor(this._cc);r.setRenderTarget(rt);r.setClearColor(0x000000,0);r.clear(true,false,false);r.setClearColor(this._cc,a);r.setRenderTarget(prev);}
  dispose(){if(this.disposed)return;for(const e of this.emitters.slice())e.dispose();for(const k of Object.keys(this._textures))this._textures[k].dispose();this._textures={};this.fsq.dispose();this.disposed=true;}
};
KE.VFX.presets=PRESETS;
KE.VFX.Emitter=Emitter;
KE.VFX.EmitterGroup=EmitterGroup;
/* Exposed for tests and tooling. */
KE.VFX.internals={normalizeConfig,SpawnHistory,evalCurve,noise3,noised3,curlNoise,deepMerge,TEXTURE_PAINTERS,MAX_BATCHES};
KE.registerModule('vfx',{provides:['VFX']});
})();
