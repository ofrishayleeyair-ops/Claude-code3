/* kitsune enginev3 foliage (module 24): shared hierarchical wind with identical shadow-pass deformation,
   procedural trees (recursive growth, parallel-transport bark tubes, clustered leaf cards), canvas
   leaf/bark textures, world-anchored interactive grass, shell-texture fur and a deterministic
   instanced foliage spawner. All animation runs in vertex shaders; CPU work happens only when
   grass/spawner cells change. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=(v,a,b)=>v<a?a:v>b?b:v,lerp=(a,b,t)=>a+(b-a)*t,smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const TAU=Math.PI*2,GOLDEN=2.399963229728653,MAX_INTERACTORS=8;

/* ---------- shared wind state ---------- */
/* One set of uniform objects shared by reference by every foliage, grass and fur material. */
let shared=null;
function foliageUniforms(THREE){
  if(shared)return shared;THREE=THREE||window.THREE;if(!THREE)return null;
  const inter=[];for(let i=0;i<MAX_INTERACTORS;i++)inter.push(new THREE.Vector4(0,-1e4,0,0));
  shared={keTime:{value:0},keWindDir:{value:new THREE.Vector2(.8,.6)},keWindStrength:{value:1},keGustScale:{value:1},keInteractors:{value:inter},keInteractorCount:{value:0}};
  return shared;
}
Object.defineProperty(KE,'foliageUniforms',{configurable:true,enumerable:true,get(){return foliageUniforms(window.THREE);}});
function setWindDir(target,d){let x,z;
  if(typeof d==='number'){x=Math.cos(d);z=Math.sin(d);}else if(Array.isArray(d)){x=d[0];z=d.length>2?d[2]:d[1];}else if(d&&typeof d==='object'){x=d.x;z=d.z!==undefined?d.z:d.y;}
  if(!Number.isFinite(x)||!Number.isFinite(z))return;const l=Math.hypot(x,z);if(l>1e-6)target.set(x/l,z/l);}
const sharedRefs=U=>({keTime:U.keTime,keWindDir:U.keWindDir,keWindStrength:U.keWindStrength,keGustScale:U.keGustScale});
const srgb=(THREE,c,fallback)=>{const col=new THREE.Color(c===undefined||c===null?fallback:c);return col.convertSRGBToLinear();};

/* ---------- shared GLSL ---------- */
const NOISE_GLSL=()=>`#ifndef KF_NOISE
#define KF_NOISE
${KE.GLSL.hash}
${KE.GLSL.noise}
#endif
`;
const WIND_UNIFORMS='uniform float keTime;uniform vec2 keWindDir;uniform float keWindStrength;uniform float keGustScale;\n';
/* Gusts: two octaves of value noise scrolled along the wind direction, so bright/strong bands travel
   across grass and forests at roughly 7 m/s (scaled by keGustScale). Returns 0..1. */
const GUST_GLSL=`float kfGust(vec2 p){vec2 q=p*(.045*keGustScale)-keWindDir*(keTime*.32);
float g=keNoise2(q)*.65+keNoise2(q*2.9+vec2(17.3,5.1)-keWindDir*(keTime*.45))*.35;return smoothstep(.28,.82,g);}
`;
/* Hierarchical plant wind (after the GPU Gems 3 ch.16 / CryEngine scheme):
   1. main bend: the whole plant leans along the wind, quadratic in normalized height (windWeight.x),
      length-preserving about the root so the top dips instead of stretching;
   2. branch bend: vertical+along-wind oscillation weighted by windWeight.y (0 at trunk, 1 at twig tips),
      phase windWeight.w shared by a branch and everything attached to it so joints never separate;
   3. leaf flutter: fast motion along the vertex normal weighted by windWeight.z with a per-vertex phase.
   The same function is compiled into the colour, depth and distance materials, so shadows match. */
const TREE_WIND_GLSL=`uniform vec3 kfWindAmp;uniform float kfRefHeight;
#ifdef KF_WIND_ATTRIBUTE
attribute vec4 windWeight;
#endif
vec3 kfWind(vec3 pos,vec3 nrm,mat4 M){
#ifdef KF_WIND_ATTRIBUTE
 vec4 w=windWeight;
#else
 float hh=clamp(pos.y/kfRefHeight,0.,1.);vec4 w=vec4(hh,hh*hh,hh,0.);
#endif
 vec3 root=M[3].xyz;vec3 rel=(M*vec4(pos,1.)).xyz-root;
 float S=keWindStrength,t=keTime;
 vec3 wd=vec3(keWindDir.x,0.,keWindDir.y),sd=vec3(-wd.z,0.,wd.x);
 float ph=keHash12(floor(root.xz*4.)+.5)*6.2831853;
 float gust=kfGust(root.xz);
 float bend=kfWindAmp.x*S*(.4+1.6*gust+.3*sin(t*1.21+ph));
 float across=kfWindAmp.x*S*.35*sin(t*.87+ph*1.7);
 vec3 nrel=rel+(wd*bend+sd*across)*(max(rel.y,0.)*w.x);
 nrel*=length(rel)/max(length(nrel),1e-5);
 float bph=w.w*6.2831853+ph;
 float bo=sin(t*(1.65+.3*S)+bph)*(.5+gust)+sin(t*2.83+bph*1.37)*.22;
 nrel+=(vec3(0.,.75*bo,0.)+wd*(.25+.95*gust)+sd*(.35*cos(t*2.13+bph)))*(kfWindAmp.y*S*w.y);
 vec3 dw=nrel-rel;mat3 m=mat3(M);
 vec3 dl=vec3(dot(m[0],dw),dot(m[1],dw),dot(m[2],dw))/vec3(dot(m[0],m[0]),dot(m[1],m[1]),dot(m[2],m[2]));
 float vph=fract(w.w*7.13+dot(pos,vec3(1.37,2.11,1.73)))*6.2831853;
 float fl=sin(t*(6.3+1.8*S)+vph)*(.35+gust)+sin(t*10.7+vph*2.3)*.18;
 dl+=nrm*(fl*kfWindAmp.z*S*w.z);
 return pos+dl;
}
`;
const WIND_APPLY=`{mat4 kfM=modelMatrix;
#ifdef USE_INSTANCING
kfM=modelMatrix*instanceMatrix;
#endif
transformed=kfWind(transformed,normal,kfM);}
#include <project_vertex>`;
/* Cards seen edge-on smear their texture into streaks: fade their alpha by the true (derivative) face
   normal against the view direction so the alpha test removes them (colour pass only). */
const EDGE_FADE=`#if defined(ALPHATEST)&&defined(USE_MAP)
{vec3 kfFN=normalize(cross(dFdx(vViewPosition),dFdy(vViewPosition)));float kfNdv=abs(dot(kfFN,normalize(vViewPosition)));diffuseColor.a*=mix(1.,smoothstep(.06,.34,kfNdv),kfEdgeFade);}
#endif
`;
/* Alpha-tested cutouts lose coverage in small mips; scale alpha up with the mip level (Golus 2017). */
const ALPHA_MIP=`#if defined(ALPHATEST)&&defined(USE_MAP)
{vec2 kfT=vUv*kfMapSize;vec2 kfDx=dFdx(kfT),kfDy=dFdy(kfT);float kfLod=.5*log2(max(max(dot(kfDx,kfDx),dot(kfDy,kfDy)),1e-8));diffuseColor.a*=1.+max(kfLod,0.)*kfAlphaMip;}
#endif
#include <alphatest_fragment>`;
/* Thin-leaf transmission and wrap lighting, added for every direct light. It is injected by redefining
   the RE_Direct macro (not by rewriting lights_fragment_begin), so light loops patched by other systems
   (KE.CascadedShadows replaces that chunk) still call it, with their shadowing already applied. */
const TRANSLUCENT_GLSL=`
void kfTranslucent(const in IncidentLight L,const in GeometricContext g,const in PhysicalMaterial m,inout ReflectedLight r){
 float ndl=dot(g.normal,L.direction);
 float back=pow(saturate(dot(g.viewDir,-L.direction)),4.);
 float thru=saturate(.35-ndl*.65);
 vec3 t=kfTransColor*(kfTranslucency*(back*.9+thru*.45))+vec3((saturate((ndl+.45)/1.45)-saturate(ndl))*.55);
#ifdef PHYSICALLY_CORRECT_LIGHTS
 t*=RECIPROCAL_PI;
#endif
 r.directDiffuse+=L.color*m.diffuseColor*t;
}
void kfRE_Direct(const in IncidentLight L,const in GeometricContext g,const in PhysicalMaterial m,inout ReflectedLight r){RE_Direct_Physical(L,g,m,r);kfTranslucent(L,g,m,r);}
#undef RE_Direct
#define RE_Direct kfRE_Direct
`;
/* String patch with a clear failure: minified three.js strips chunk comments, so only #include lines are targeted. */
function inject(src,target,replacement,what){if(src.indexOf(target)<0)throw new Error('KE.foliage: shader patch target '+target+' missing in '+what+' (Three.js r128 required)');return src.replace(target,replacement);}
function patchFoliage(THREE,sh,cfg,kind){
  const U=foliageUniforms(THREE);Object.assign(sh.uniforms,sharedRefs(U),cfg.uniforms);const f=cfg.flags;
  const defs=(f.attr?'#define KF_WIND_ATTRIBUTE\n':'');
  let vs=inject(sh.vertexShader,'#include <project_vertex>',WIND_APPLY,kind+' vertex shader');
  if(kind==='main'&&cfg.uniforms.kfNormalsUp.value>0)vs=inject(vs,'#include <beginnormal_vertex>','#include <beginnormal_vertex>\nobjectNormal=normalize(mix(objectNormal,vec3(0.,1.,0.),kfNormalsUp*.5));',kind+' vertex shader');
  sh.vertexShader=defs+NOISE_GLSL()+WIND_UNIFORMS+GUST_GLSL+TREE_WIND_GLSL+'uniform float kfNormalsUp;\n'+vs;
  let fs='uniform float kfTranslucency;uniform vec3 kfTransColor;uniform float kfMapSize;uniform float kfAlphaMip;uniform float kfEdgeFade;\n'+sh.fragmentShader;
  if(f.alpha)fs=inject(fs,'#include <alphatest_fragment>',(kind==='main'?EDGE_FADE:'')+ALPHA_MIP,kind+' fragment shader');
  if(kind==='main'){
    /* Keep the (outward-bent) interpolated normal on back faces: canopy lighting stays volumetric. */
    if(f.unflip)fs=inject(fs,'#include <normal_fragment_begin>','#include <normal_fragment_begin>\n#if defined(DOUBLE_SIDED)&&!defined(FLAT_SHADED)\nnormal=normalize(vNormal);geometryNormal=normal;\n#endif',kind+' fragment shader');
    if(f.trans)fs=inject(fs,'#include <lights_physical_pars_fragment>','#include <lights_physical_pars_fragment>\n'+TRANSLUCENT_GLSL,kind+' fragment shader');
  }
  sh.fragmentShader=fs;
}
const flagKey=f=>(f.attr?'A':'a')+(f.trans?'T':'t')+(f.unflip?'U':'u')+(f.alpha?'P':'p')+(f.up?'N':'n');
/* Install the foliage hook on a material, chaining whatever onBeforeCompile / cache key it already had,
   so other systems (KE.surface, KE.CascadedShadows, KE.ProbeVolume) compose in either order. */
function installHook(THREE,mat,cfg,kind){
  const prev=Object.prototype.hasOwnProperty.call(mat,'onBeforeCompile')?mat.onBeforeCompile:null;
  const prevKey=Object.prototype.hasOwnProperty.call(mat,'customProgramCacheKey')?mat.customProgramCacheKey.bind(mat):null;
  mat.onBeforeCompile=function(sh,renderer){if(prev)prev.call(this,sh,renderer);patchFoliage(THREE,sh,cfg,kind);};
  const key='ke-foliage-2-'+kind+':'+flagKey(cfg.flags);
  mat.customProgramCacheKey=()=>prevKey?prevKey()+'|'+key:key;
}

/* ---------- foliage material ---------- */
KE.foliageMaterial=(THREE,o={})=>{
  foliageUniforms(THREE);
  const wind=Object.assign({trunk:.02,branch:.06,leaf:.12},o.wind||{}),map=o.map||null;
  const alphaTest=o.alphaTest!==undefined?o.alphaTest:(map?.4:0),translucency=o.translucency!==undefined?o.translucency:.6,doubleSided=o.doubleSided!==undefined?!!o.doubleSided:true;
  const mat=new THREE.MeshStandardMaterial({map,color:srgb(THREE,o.color,0xffffff),alphaTest,roughness:o.roughness!==undefined?o.roughness:.78,metalness:0,side:doubleSided?THREE.DoubleSide:THREE.FrontSide,vertexColors:!!o.vertexColors});
  if(o.bumpMap){mat.bumpMap=o.bumpMap;mat.bumpScale=o.bumpScale!==undefined?o.bumpScale:.03;}
  if(o.normalMap)mat.normalMap=o.normalMap;
  const normalsUp=o.normalsUp!==undefined?o.normalsUp:(doubleSided?.5:0);
  const uniforms={kfWindAmp:{value:new THREE.Vector3(wind.trunk,wind.branch,wind.leaf)},kfRefHeight:{value:Math.max(1e-3,o.height||1)},kfTranslucency:{value:translucency},
    kfTransColor:{value:srgb(THREE,o.translucencyColor,0xd2e67a)},kfNormalsUp:{value:normalsUp},
    kfMapSize:{value:map&&map.image?Math.max(map.image.width||256,map.image.height||256):256},kfAlphaMip:{value:o.alphaMip!==undefined?o.alphaMip:.25},
    kfEdgeFade:{value:o.edgeFade!==undefined?o.edgeFade:1}};
  const flags={attr:o.windAttribute!==undefined?!!o.windAttribute:true,trans:translucency>0,unflip:doubleSided&&o.keepNormals!==false,alpha:alphaTest>0,up:normalsUp>0};
  const cfg={THREE,uniforms,flags,wind,depth:null,distance:null};
  mat.userData.keFoliage=cfg;mat.userData.keTextures=[map,o.bumpMap].filter(Boolean);
  /* geometry without windWeight reads a constant zero weight (static) instead of failing */
  mat.defaultAttributeValues={windWeight:[0,0,0,0],color:[1,1,1],uv:[0,0]};
  installHook(THREE,mat,cfg,'main');
  return mat;
};
/* Depth/distance materials with the identical vertex deformation and alpha cutout, for shadow maps.
   Cached per source material; the uniforms are shared by reference, so changing wind amplitudes on the
   colour material also moves its shadow. */
KE.foliageDepthMaterial=(material,{distance=false}={})=>{
  const cfg=material&&material.userData&&material.userData.keFoliage;if(!cfg)throw new TypeError('foliageDepthMaterial expects a material made by KE.foliageMaterial, KE.barkMaterial or KE.foliage.applyWind');
  const key=distance?'distance':'depth';if(cfg[key])return cfg[key];const THREE=cfg.THREE;
  const opts={map:material.alphaTest>0?material.map:null,alphaTest:material.alphaTest};
  const d=distance?new THREE.MeshDistanceMaterial(opts):new THREE.MeshDepthMaterial(Object.assign({depthPacking:THREE.RGBADepthPacking},opts));
  d.extensions={derivatives:true};d.userData.keFoliageDepthOf=material;d.defaultAttributeValues=material.defaultAttributeValues;
  installHook(THREE,d,cfg,key);
  cfg[key]=d;return d;
};
/* Release a foliage material together with its cached shadow materials. */
function disposeFoliageMaterial(m){if(!m)return;const c=m.userData&&m.userData.keFoliage;if(c){if(c.depth)c.depth.dispose();if(c.distance)c.distance.dispose();c.depth=c.distance=null;}m.dispose();}

/* ---------- procedural textures ---------- */
const canvas2d=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;},ctx2d=c=>c.getContext('2d',{willReadFrequently:true});
const hsl=(h,s,l,a=1)=>`hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a})`;
/* Half-width profiles (0..1) along a leaf from base (t=0) to tip (t=1). */
const LEAF_PROFILES={
  ovate:t=>Math.pow(Math.sin(Math.PI*Math.pow(t,.75)),.9),
  round:t=>Math.sqrt(Math.max(0,1-(2*t-1)*(2*t-1)))*(1-.12*t),
  birch:t=>Math.sin(Math.PI*Math.pow(t,.6))*(1-.1*t),
  lance:t=>Math.pow(Math.sin(Math.PI*t),.7)*(1-.35*t),
};
function drawLeaf(g,r,x,y,ang,len,wid,st,dark=1){
  const prof=LEAF_PROFILES[st.shape]||LEAF_PROFILES.ovate,N=26,up=[],dn=[],teeth=st.teeth||0,ser=st.serrate||0;
  for(let i=0;i<=N;i++){const t=i/N;let w=prof(t)*wid*.5;if(ser)w*=1-ser*(.5+.5*Math.sin(t*teeth*TAU));up.push([t*len,-w]);dn.push([t*len,w]);}
  const h=lerp(st.hue[0],st.hue[1],r()),s=lerp(st.sat[0],st.sat[1],r()),l=lerp(st.lig[0],st.lig[1],r())*dark;
  g.save();g.translate(x,y);g.rotate(ang);
  const pet=len*(st.petiole||.12);g.strokeStyle=hsl(h-12,s*.7,l*.8);g.lineWidth=Math.max(1,wid*.09);g.beginPath();g.moveTo(-pet,0);g.lineTo(0,0);g.stroke();
  const path=()=>{g.beginPath();g.moveTo(0,0);for(const p of up)g.lineTo(p[0],p[1]);for(let i=dn.length-1;i>=0;i--)g.lineTo(dn[i][0],dn[i][1]);g.closePath();};
  const gr=g.createLinearGradient(0,0,len,0);gr.addColorStop(0,hsl(h,s,l*.78));gr.addColorStop(.55,hsl(h+2,s,l*1.08));gr.addColorStop(1,hsl(h+(st.tipShift||-6),s*.95,l*1.18));
  path();g.fillStyle=gr;g.fill();
  g.save();path();g.clip();
  g.fillStyle=`rgba(0,18,0,${.24*dark})`;g.fillRect(0,0,len,wid);                       // fold shadow on the lower half
  const hl=g.createLinearGradient(0,-wid*.5,0,0);hl.addColorStop(0,'rgba(255,255,230,0)');hl.addColorStop(1,`rgba(255,255,220,${st.gloss?.2:.1})`);g.fillStyle=hl;g.fillRect(0,-wid*.5,len,wid*.5);
  g.strokeStyle=hsl(h+8,s*.6,Math.min(88,l*1.6),.55);g.lineWidth=Math.max(.6,wid*.05);g.beginPath();g.moveTo(0,0);g.lineTo(len*.96,0);g.stroke();
  g.lineWidth=Math.max(.5,wid*.025);g.strokeStyle=hsl(h+8,s*.5,Math.min(85,l*1.45),.32);
  for(let k=1;k<7;k++){const t=k/7.5,x0=len*t;for(const sg of [-1,1]){g.beginPath();g.moveTo(x0,0);g.quadraticCurveTo(x0+len*.07,sg*prof(t)*wid*.25,x0+len*.15,sg*prof(Math.min(1,t+.12))*wid*.42);g.stroke();}}
  g.restore();
  path();g.strokeStyle=`rgba(10,30,5,${.35*dark})`;g.lineWidth=Math.max(.6,wid*.03);g.stroke();
  g.restore();
}
function twigPoint(b,c,e,t){const u=1-t;return [u*u*b[0]+2*u*t*c[0]+t*t*e[0],u*u*b[1]+2*u*t*c[1]+t*t*e[1]];}
function twigAngle(b,c,e,t){const dx=2*(1-t)*(c[0]-b[0])+2*t*(e[0]-c[0]),dy=2*(1-t)*(c[1]-b[1])+2*t*(e[1]-c[1]);return Math.atan2(dy,dx);}
function drawTwig(g,b,c,e,w0,w1,color){const n=12;g.strokeStyle=color;g.lineCap='round';for(let i=0;i<n;i++){const a=twigPoint(b,c,e,i/n),z=twigPoint(b,c,e,(i+1)/n);g.lineWidth=lerp(w0,w1,i/n);g.beginPath();g.moveTo(a[0],a[1]);g.lineTo(z[0],z[1]);g.stroke();}}
/* A leaf spray: a curved main twig rooted at the bottom-centre of the cell (where cards attach) plus
   side shoots, leaves alternating along each; back leaves are drawn darker first for depth. */
function drawLeafCluster(g,r,W,H,st,f){
  const b=[W*.5,H*.985],e=[W*(.5+(r()-.5)*.16),H*(.1+r()*.06)],c=[W*(.5+(r()-.5)*.3),H*.55],twigs=[[b,c,e,1]],ns=st.side!==undefined?st.side:2;
  for(let k=0;k<ns;k++){const t=.26+.36*k/Math.max(1,ns-1)+(r()-.5)*.08,p=twigPoint(b,c,e,t),sg=(k%2?1:-1)*(r()<.5?1:-1),a=twigAngle(b,c,e,t)+sg*(.6+r()*.3),L=H*(.36-.14*t)*(.8+.3*r());
    const end=[clamp(p[0]+Math.cos(a)*L,W*.16,W*.84),clamp(p[1]+Math.sin(a)*L,H*.12,H*.9)],mid=[(p[0]+end[0])*.5-sg*W*.03,(p[1]+end[1])*.5-H*.03];twigs.push([p,mid,end,.62]);}
  const leaves=[];
  for(const [tb,tc,te,sc] of twigs){const n=Math.max(3,Math.round(lerp(st.count[0],st.count[1],r())*sc));
    for(let k=0;k<n;k++){const t=(sc<1?.2:.16)+.8*Math.pow(k/(n-1),.9),p=twigPoint(tb,tc,te,t),a=twigAngle(tb,tc,te,t),side=k%2?1:-1;
      const spread=(st.spread||62)*(1-.3*t)*Math.PI/180*(.8+.4*r()),len=W*lerp(st.len[0],st.len[1],r())*(.72+.4*Math.sin(Math.PI*(.25+.7*t)))*(sc<1?.9:1);leaves.push([p[0],p[1],a+side*spread,len,r()<.42]);}
    leaves.push([te[0],te[1],twigAngle(tb,tc,te,1)+(r()-.5)*.3,W*st.len[1]*(sc<1?.8:.95),false]);}
  if(st.droop)for(const L of leaves)L[2]+=.35*Math.cos(L[2]);
  for(const L of leaves)if(L[4])drawLeaf(g,r,L[0],L[1],L[2],L[3],L[3]*st.wid,st,.74);
  for(const [tb,tc,te,sc] of twigs)drawTwig(g,tb,tc,te,5*f*sc,1.2*f,st.twig);
  for(const L of leaves)if(!L[4])drawLeaf(g,r,L[0],L[1],L[2],L[3],L[3]*st.wid,st,1);
}
function drawBlossom(g,r,x,y,R,rot){
  for(let p=0;p<5;p++){const a=rot+p*TAU/5;g.save();g.translate(x,y);g.rotate(a);
    const gr=g.createLinearGradient(0,0,R,0);gr.addColorStop(0,'#b83f68');gr.addColorStop(.3,'#ec94b1');gr.addColorStop(1,r()<.5?'#f9c4d4':'#f4b0c6');g.fillStyle=gr;
    g.beginPath();g.moveTo(0,0);g.bezierCurveTo(R*.35,-R*.55,R*.95,-R*.55,R,-R*.12);g.lineTo(R*.86,0);g.lineTo(R,R*.12);g.bezierCurveTo(R*.95,R*.55,R*.35,R*.55,0,0);g.fill();
    g.strokeStyle='rgba(150,40,80,.25)';g.lineWidth=.8;g.stroke();g.restore();}
  g.fillStyle='#b83a64';g.beginPath();g.arc(x,y,R*.2,0,TAU);g.fill();
  g.strokeStyle='rgba(250,220,150,.9)';g.lineWidth=Math.max(.6,R*.03);for(let i=0;i<9;i++){const a=r()*TAU,l=R*(.3+r()*.2);g.beginPath();g.moveTo(x,y);g.lineTo(x+Math.cos(a)*l,y+Math.sin(a)*l);g.stroke();g.fillStyle='#f6cf6a';g.beginPath();g.arc(x+Math.cos(a)*l,y+Math.sin(a)*l,Math.max(.8,R*.045),0,TAU);g.fill();}
}
function drawSakuraCluster(g,r,W,H,f){
  const b=[W*.5,H*.985],e=[W*(.5+(r()-.5)*.3),H*.12],c=[W*(.5+(r()-.5)*.5),H*.55];
  const leafSt={shape:'ovate',hue:[70,95],sat:[30,45],lig:[28,38],serrate:.05,teeth:16,petiole:.1};
  for(let k=0;k<4;k++){const t=.25+.6*r(),p=twigPoint(b,c,e,t);drawLeaf(g,r,p[0],p[1],twigAngle(b,c,e,t)+(r()<.5?-1:1)*1.1,W*.17,W*.07,leafSt,.85);}
  drawTwig(g,b,c,e,5*f,1.4*f,'#4a2b26');
  const spurs=[];for(let k=0;k<7;k++){const t=.2+.8*k/6,p=twigPoint(b,c,e,t),a=twigAngle(b,c,e,t)+(k%2?1:-1)*(.6+r()*.5),l=W*(.07+r()*.06);spurs.push([p[0]+Math.cos(a)*l,p[1]+Math.sin(a)*l]);g.strokeStyle='#5a3530';g.lineWidth=1.6*f;g.beginPath();g.moveTo(p[0],p[1]);g.lineTo(p[0]+Math.cos(a)*l,p[1]+Math.sin(a)*l);g.stroke();}
  for(const s of spurs){const m=2+Math.floor(r()*3);for(let i=0;i<m;i++){const a=r()*TAU,d=W*.04*r();drawBlossom(g,r,s[0]+Math.cos(a)*d,s[1]+Math.sin(a)*d,W*(.07+r()*.035),r()*TAU);}}
  for(let i=0;i<5;i++){const p=twigPoint(b,c,e,.3+.7*r());g.fillStyle='#e58aa6';g.beginPath();g.ellipse(p[0]+(r()-.5)*W*.2,p[1]+(r()-.5)*W*.1,W*.018,W*.028,r()*3,0,TAU);g.fill();}
}
function drawNeedles(g,r,x0,y0,x1,y1,len,f,dark){
  const L=Math.hypot(x1-x0,y1-y0),a=Math.atan2(y1-y0,x1-x0),n=Math.floor(L/(2.6*f));g.lineCap='round';
  for(let i=0;i<n;i++){const t=i/n,x=lerp(x0,x1,t),y=lerp(y0,y1,t),l=len*(.55+.45*Math.sin(Math.PI*(.15+.85*t)))*(.85+.3*r());
    for(const s of [-1,1]){const na=a+s*(.9+r()*.35)-.25*s*t,ex=x+Math.cos(na)*l,ey=y+Math.sin(na)*l,h=130+r()*22,lg=(20+r()*12)*dark;
      g.strokeStyle=hsl(h,38+r()*14,lg);g.lineWidth=1.9*f;g.beginPath();g.moveTo(x,y);g.lineTo(ex,ey);g.stroke();
      g.strokeStyle=hsl(h-10,40,lg*1.55,.8);g.lineWidth=1.2*f;g.beginPath();g.moveTo(lerp(x,ex,.6),lerp(y,ey,.6));g.lineTo(ex,ey);g.stroke();}}
}
function drawConiferCluster(g,r,W,H,f){
  const bx=W*.5,by=H*.985,ex=W*(.5+(r()-.5)*.12),ey=H*.06;
  const twigs=[];for(let k=0;k<7;k++){const t=.18+.72*k/6,x=lerp(bx,ex,t),y=lerp(by,ey,t),s=k%2?1:-1,a=-Math.PI/2+s*(.75+r()*.25),l=W*(.3-.18*t)*(.8+.4*r());twigs.push([x,y,x+Math.cos(a)*l,y+Math.sin(a)*l]);}
  for(const t of twigs)drawNeedles(g,r,t[0],t[1],t[2],t[3],W*.07,f,.8);
  g.strokeStyle='#5b4030';g.lineWidth=3.2*f;g.beginPath();g.moveTo(bx,by);g.lineTo(ex,ey);g.stroke();
  for(const t of twigs){g.lineWidth=1.8*f;g.beginPath();g.moveTo(t[0],t[1]);g.lineTo(t[2],t[3]);g.stroke();}
  drawNeedles(g,r,bx,by-H*.05,ex,ey,W*.085,f,1);
}
function drawFrond(g,r,W,H,f){
  const cx=W*.5,by=H*.995,ty=H*.02,n=46;
  for(let side=-1;side<=1;side+=2)for(let i=0;i<n;i++){const t=.04+.94*i/n,y=lerp(by,ty,t),L=Math.min((W*.5-4*f)/.87,W*.62*Math.pow(Math.sin(Math.PI*(.08+.9*t)),.55))*(.85+.2*r());
    drawLeaf(g,r,cx,y,-Math.PI/2+side*(1.05-.25*t),L,Math.max(5*f,L*.13),{shape:'lance',hue:[88,108],sat:[40,58],lig:[24,36],petiole:0,tipShift:-10},i%2?.9:1);}
  g.strokeStyle='#8c7a3c';g.lineCap='round';for(let i=0;i<10;i++){g.lineWidth=lerp(7,1.5,i/10)*f;g.beginPath();g.moveTo(cx,lerp(by,ty,i/10));g.lineTo(cx,lerp(by,ty,(i+1)/10));g.stroke();}
}
const LEAF_STYLES={
  broadleaf:{shape:'ovate',count:[8,11],len:[.19,.26],wid:.52,hue:[84,106],sat:[38,56],lig:[24,38],serrate:.06,teeth:14,twig:'#5b4632',spread:66},
  bush:{shape:'round',count:[12,16],len:[.13,.18],wid:.62,hue:[96,122],sat:[34,52],lig:[18,30],gloss:true,twig:'#4a3a2a',spread:70,side:3},
  birch:{shape:'birch',count:[9,13],len:[.14,.2],wid:.72,hue:[66,86],sat:[48,68],lig:[32,46],serrate:.1,teeth:18,twig:'#6b5a4a',spread:68,droop:true},
};
/* Returns a mip-mapped sRGB atlas (DataTexture) of leaf clusters with straight (dilated) alpha edges.
   texture.userData.layout={cols,rows}; cards map one cell each, twig base at the cell's bottom-centre. */
KE.leafTexture=(THREE,o={})=>{
  const species=o.species||'broadleaf',S=clamp(Math.round(o.size||512),64,2048),f=S/512,r=KE.random((o.seed||1)*977+species.length*131);
  const layout=species==='palm'?{cols:2,rows:1}:{cols:2,rows:2},c=canvas2d(S,S),g=ctx2d(c),cw=S/layout.cols,ch=S/layout.rows,pad=Math.max(2,Math.round(4*f));
  g.clearRect(0,0,S,S);
  for(let cy=0;cy<layout.rows;cy++)for(let cx=0;cx<layout.cols;cx++){
    g.save();g.translate(cx*cw,cy*ch);g.beginPath();g.rect(pad,pad,cw-pad*2,ch-pad*2);g.clip();
    if(species==='sakura')drawSakuraCluster(g,r,cw,ch,f);else if(species==='conifer')drawConiferCluster(g,r,cw,ch,f);else if(species==='palm')drawFrond(g,r,cw,ch,f);else drawLeafCluster(g,r,cw,ch,LEAF_STYLES[species]||LEAF_STYLES.broadleaf,f);
    g.restore();}
  const tex=imageToTexture(THREE,g.getImageData(0,0,S,S),S,S,true);tex.wrapS=tex.wrapT=THREE.ClampToEdgeWrapping;tex.userData={layout,species,kind:'leafAtlas'};return tex;
};
/* Copy canvas pixels into a DataTexture: push opaque colours into transparent texels (so mips have no
   dark fringes), flip rows to the CanvasTexture convention (v=1 at the canvas top). */
function imageToTexture(THREE,img,W,H,dilate){
  const d=img.data,out=new Uint8Array(W*H*4);out.set(d);
  if(dilate){const filled=new Uint8Array(W*H);let sr=0,sg=0,sb=0,sn=0;
    for(let i=0;i<W*H;i++)if(d[i*4+3]>24){filled[i]=1;sr+=d[i*4];sg+=d[i*4+1];sb+=d[i*4+2];sn++;}
    const next=new Uint8Array(W*H);
    for(let pass=0;pass<8;pass++){next.set(filled);let changed=0;
      for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x;if(filled[i])continue;let r=0,gg=0,b=0,n=0;
        for(let k=0;k<4;k++){const nx=x+(k===0?1:k===1?-1:0),ny=y+(k===2?1:k===3?-1:0);if(nx<0||ny<0||nx>=W||ny>=H)continue;const j=ny*W+nx;if(!filled[j])continue;r+=out[j*4];gg+=out[j*4+1];b+=out[j*4+2];n++;}
        if(n){out[i*4]=r/n;out[i*4+1]=gg/n;out[i*4+2]=b/n;next[i]=1;changed++;}}
      filled.set(next);if(!changed)break;}
    const ar=sn?sr/sn:60,ag=sn?sg/sn:90,ab=sn?sb/sn:40;for(let i=0;i<W*H;i++)if(!filled[i]){out[i*4]=ar;out[i*4+1]=ag;out[i*4+2]=ab;}
    for(let i=0;i<W*H;i++)if(d[i*4+3]<=24)out[i*4+3]=d[i*4+3];}
  const flipped=new Uint8Array(W*H*4);for(let y=0;y<H;y++)flipped.set(out.subarray((H-1-y)*W*4,(H-y)*W*4),y*W*4);
  const t=new THREE.DataTexture(flipped,W,H,THREE.RGBAFormat);t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.generateMipmaps=true;
  t.encoding=THREE.sRGBEncoding;t.anisotropy=Math.min(8,KE.settings.aniso||4);t.needsUpdate=true;return t;
}
/* Tileable value noise with integer periods (for seamless bark). */
function periodicNoise(seed){
  const rnd=KE.random(seed),perm=new Uint8Array(512),vals=new Float32Array(256);for(let i=0;i<256;i++){perm[i]=i;vals[i]=rnd();}
  for(let i=255;i>0;i--){const j=Math.floor(rnd()*(i+1)),t=perm[i];perm[i]=perm[j];perm[j]=t;}for(let i=0;i<256;i++)perm[256+i]=perm[i];
  const h=(x,y)=>vals[perm[perm[x&255]+(y&255)]];
  const noise=(x,y,px,py)=>{const xi=Math.floor(x),yi=Math.floor(y),fx=x-xi,fy=y-yi,x0=((xi%px)+px)%px,y0=((yi%py)+py)%py,x1=(x0+1)%px,y1=(y0+1)%py,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy);
    return lerp(lerp(h(x0,y0),h(x1,y0),u),lerp(h(x0,y1),h(x1,y1),u),v);};
  noise.noise=noise;
  noise.fbm=(x,y,px,py,oct=4)=>{let s=0,a=.5,n=0;for(let i=0;i<oct;i++){s+=a*noise(x,y,px,py);n+=a;x*=2;y*=2;px*=2;py*=2;a*=.5;}return s/n;};
  noise.cell=(x,y,px,py,out)=>{/* periodic Worley F1/F2 with one jittered point per cell */let f1=9,f2=9,id=0;const xi=Math.floor(x),yi=Math.floor(y);
    for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++){const cx=((xi+i)%px+px)%px,cy=((yi+j)%py+py)%py,hx=h(cx*7+1,cy*13+3),hy=h(cx*11+5,cy*3+7),dx=xi+i+hx-x,dy=yi+j+hy-y,dd=Math.sqrt(dx*dx+dy*dy);
      if(dd<f1){f2=f1;f1=dd;id=h(cx*5+2,cy*17+1);}else if(dd<f2)f2=dd;}out[0]=f1;out[1]=f2;out[2]=id;return out;};
  return noise;
}
const BARK_KINDS={broadleaf:'oak',oak:'oak',bush:'oak',conifer:'pine',pine:'pine',birch:'birch',sakura:'cherry',cherry:'cherry',palm:'palm'};
/* Tileable procedural bark: returns a mip-mapped sRGB DataTexture (use with RepeatWrapping UVs). */
KE.barkTexture=(THREE,o={})=>{
  const kind=BARK_KINDS[o.species||o.kind||'broadleaf']||'oak',S=clamp(Math.round(o.size||256),32,1024),N=periodicNoise((o.seed||3)*31+kind.length*7),data=new Uint8Array(S*S*4),cell=[0,0,0];
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){const u=x/S,v=y/S;let r,g,b;
    if(kind==='oak'){const warp=(N.fbm(u*3,v*2,3,2)-.5)*2.4,f=u*10+warp+(N.noise(u*20,v*3,20,3)-.5)*.6,p=Math.abs((f-Math.floor(f))-.5)*2;
      const crack=smooth(.62,.95,p)*(.75+.25*N.noise(u*10,v*24,10,24)),cross=smooth(.78,.9,N.noise(u*10,v*18,10,18))*.5,fib=.86+.28*N.noise(u*64,v*8,64,8),tone=N.fbm(u*4,v*4,4,4);
      const k=clamp(1-Math.max(crack,cross*(1-p))*.8,0,1)*fib;r=(.36+.14*tone)*k;g=(.29+.11*tone)*k;b=(.23+.08*tone)*k;}
    else if(kind==='pine'){N.cell(u*6,v*4,6,4,cell);const edge=smooth(0,.12,cell[1]-cell[0]),id=cell[2],tone=N.fbm(u*8,v*8,8,8);
      const k=lerp(.18,1,edge)*(.85+.3*tone);r=(.46+.14*id)*k;g=(.27+.07*id)*k;b=(.19+.04*id)*k;}
    else if(kind==='birch'){const tone=N.fbm(u*4,v*4,4,4),dash=smooth(.66,.8,N.noise(u*7,v*56,7,56))*smooth(.35,.6,N.noise(u*24,v*56,24,56)),patch=smooth(.72,.8,N.fbm(u*3,v*5,3,5)),peel=smooth(.6,.75,N.noise(u*5,v*9,5,9))*.25;
      const k=1-Math.max(dash*.85,patch*.9);r=(.86-.12*tone+peel*.05)*k+.06;g=(.84-.12*tone-peel*.05)*k+.06;b=(.78-.1*tone-peel*.12)*k+.06;}
    else if(kind==='cherry'){const tone=N.fbm(u*4,v*6,4,6),len=smooth(.62,.74,N.noise(u*5,v*64,5,64))*smooth(.3,.55,N.noise(u*20,v*64,20,64)),sheen=.9+.2*N.noise(u*3,v*1,3,1);
      r=lerp((.3+.08*tone)*sheen,.62,len*.75);g=lerp((.18+.05*tone)*sheen,.55,len*.75);b=lerp((.16+.04*tone)*sheen,.48,len*.75);}
    else{const ringF=v*8+(N.noise(u*4,v*8,4,8)-.5)*.35,ring=smooth(.8,.97,ringF-Math.floor(ringF)),fib=.82+.3*N.noise(u*72,v*6,72,6),tone=N.fbm(u*4,v*4,4,4);
      const k=(1-ring*.55)*fib;r=(.47+.1*tone)*k;g=(.41+.08*tone)*k;b=(.33+.06*tone)*k;}
    const i=(y*S+x)*4;data[i]=clamp(r*255,0,255);data[i+1]=clamp(g*255,0,255);data[i+2]=clamp(b*255,0,255);data[i+3]=255;}
  const t=new THREE.DataTexture(data,S,S,THREE.RGBAFormat);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.generateMipmaps=true;
  t.encoding=THREE.sRGBEncoding;t.anisotropy=Math.min(8,KE.settings.aniso||4);t.needsUpdate=true;t.userData={kind:'bark',bark:kind};return t;
};
KE.barkMaterial=(THREE,o={})=>{
  const map=o.map||KE.barkTexture(THREE,{species:o.species,size:o.textureSize||256,seed:o.seed});
  const m=KE.foliageMaterial(THREE,{map,color:o.color!==undefined?o.color:0xffffff,alphaTest:0,translucency:0,doubleSided:false,roughness:o.roughness!==undefined?o.roughness:.93,
    wind:o.wind,normalsUp:0,vertexColors:!!o.vertexColors,bumpMap:o.bump===0?null:map,bumpScale:o.bump!==undefined?o.bump:.035,windAttribute:o.windAttribute});
  m.userData.keOwnsMap=!o.map;return m;
};

/* ---------- procedural trees ---------- */
/* Species presets. angle: [min,max] degrees from the parent axis per level; start: first child position
   along the parent; shape: crown silhouette controlling child length by attachment height. */
const SPECIES={
  broadleaf:{height:5,trunkRadius:.25,levels:3,branches:[6,4,3],lengthFalloff:.62,start:[.36,.28,.22],angle:[[38,68],[30,55],[25,50]],gravity:.035,phototropism:.07,wobble:.16,trunkTop:.74,tipRatio:.32,childRadius:.62,shape:'round',segs:[10,6,5,3],radial:[10,7,5,4],leafCount:190,cross:.55,leafSize:1.2,flare:.5,leafMinT:.35,lean:.06,normalBend:.72,barkColor:0xc9b09a,transColor:0xd8ec7a},
  conifer:{height:7.5,trunkRadius:.22,levels:2,branches:[30,5],lengthFalloff:.34,start:[.1,.2],angle:[[78,102],[40,62]],gravity:.07,phototropism:.05,wobble:.08,trunkTop:1,tipRatio:.12,childRadius:.3,shape:'cone',segs:[12,5,3],radial:[9,5,4],leafCount:300,leafSize:1.1,flare:.3,leafMinT:.1,lean:.02,normalBend:.55,flatCards:true,barkColor:0xc4a08a,transColor:0xb6d66a},
  sakura:{height:4.3,trunkRadius:.24,levels:3,branches:[5,4,3],lengthFalloff:.7,start:[.3,.25,.2],angle:[[45,75],[30,58],[25,50]],gravity:.02,phototropism:.05,wobble:.3,trunkTop:.55,tipRatio:.3,childRadius:.66,shape:'umbrella',segs:[10,7,5,3],radial:[10,7,5,4],leafCount:210,cross:.6,leafSize:1.05,flare:.45,leafMinT:.3,lean:.14,normalBend:.72,barkColor:0xd8c0b8,transColor:0xffc2d8},
  birch:{height:6.5,trunkRadius:.15,levels:3,branches:[10,4,3],lengthFalloff:.5,start:[.32,.25,.2],angle:[[26,44],[28,50],[35,65]],gravity:.07,phototropism:.07,wobble:.12,trunkTop:.94,tipRatio:.18,childRadius:.5,shape:'oval',segs:[12,6,4,3],radial:[9,6,4,3],leafCount:190,cross:.45,leafSize:.85,flare:.25,leafMinT:.3,lean:.05,normalBend:.7,barkColor:0xffffff,transColor:0xe4f07a},
  palm:{height:6,trunkRadius:.2,levels:0,branches:[11],lengthFalloff:.45,start:[1],angle:[[0,0]],gravity:.1,phototropism:.05,wobble:.02,trunkTop:.95,tipRatio:.72,childRadius:.3,shape:'palm',segs:[14],radial:[10],leafCount:0,leafSize:2.6,flare:.35,leafMinT:1,lean:.3,normalBend:.4,barkColor:0xffffff,transColor:0xd6e878},
  bush:{height:1.4,trunkRadius:.05,levels:2,branches:[5,4],stems:5,lengthFalloff:.55,start:[.25,.2],angle:[[30,60],[30,55]],gravity:.03,phototropism:.08,wobble:.2,trunkTop:.8,tipRatio:.3,childRadius:.6,shape:'round',segs:[6,4,3],radial:[5,4,3],leafCount:120,cross:.5,leafSize:.62,flare:0,leafMinT:.12,lean:.4,normalBend:.8,barkColor:0xb8a088,transColor:0xc8e070},
};
KE.TREE_SPECIES=Object.keys(SPECIES);
function crownShape(shape,t,level){
  if(level>1)return 1-.35*t;
  if(shape==='cone')return Math.max(.08,Math.pow(1-t,1.05)*1.15);
  if(shape==='umbrella')return .75+.35*Math.sin(Math.PI*Math.min(1,t*1.1));
  if(shape==='oval')return .45+.55*Math.sin(Math.PI*(.15+.85*t));
  return .6+.4*Math.sin(Math.PI*(.35+.65*t));
}
/* Minimal vector helpers on plain arrays keep generation independent of the Three revision. */
const v3={add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],mul:(a,s)=>[a[0]*s,a[1]*s,a[2]*s],dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],
  cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],len:a=>Math.hypot(a[0],a[1],a[2]),norm:a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return [a[0]/l,a[1]/l,a[2]/l];},
  lerp:(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]};
function perpBasis(t){const ref=Math.abs(t[1])<.95?[0,1,0]:[1,0,0],a=v3.norm(v3.cross(t,ref));return [a,v3.cross(t,a)];}
function randUnit(r){const z=r()*2-1,a=r()*TAU,s=Math.sqrt(1-z*z);return [Math.cos(a)*s,z,Math.sin(a)*s];}
function sampleBranch(br,t){const n=br.pts.length-1,f=clamp(t,0,1)*n,i=Math.min(n-1,Math.floor(f)),u=f-i;
  return {p:v3.lerp(br.pts[i],br.pts[i+1],u),r:lerp(br.radii[i],br.radii[i+1],u),w:lerp(br.weights[i],br.weights[i+1],u),d:v3.norm(v3.sub(br.pts[i+1],br.pts[i]))};}
const WEIGHT_STEP=[0,.45,.35,.25,.2];

/* Recursive growth: each branch is a polyline bent by gravity, phototropism and seeded wobble; children
   attach along it with a golden-angle spiral, length shaped by the species crown profile. */
function growTree(sp,o,r){
  const levels=clamp(Math.round(o.levels!==undefined?o.levels:sp.levels),0,4),counts=o.branches||sp.branches,detail=o.detail,branches=[];
  const lengthFalloff=o.lengthFalloff!==undefined?o.lengthFalloff:sp.lengthFalloff,gravity=o.gravity!==undefined?o.gravity:sp.gravity,photo=o.phototropism!==undefined?o.phototropism:sp.phototropism;
  const H=o.height!==undefined?o.height:sp.height,R0=o.trunkRadius!==undefined?o.trunkRadius:sp.trunkRadius;
  const grow=(level,start,dir,length,radius,w0,phase,parentR)=>{
    const segs=Math.max(2,Math.round((sp.segs[Math.min(level,sp.segs.length-1)]||3)*clamp(detail,.5,1.5))),step=length/segs;
    let d=v3.norm(dir),p=level?v3.sub(start,v3.mul(d,parentR*.6)):start.slice();
    const pts=[p],radii=[radius],weights=[w0],tip=radius*sp.tipRatio,ws=WEIGHT_STEP[Math.min(level,4)];
    for(let i=1;i<=segs;i++){const t=i/segs;
      d=v3.add(d,[(r()-.5)*sp.wobble,(r()-.5)*sp.wobble*.5-gravity*(level?1+t:.15)+photo*(level?1-t*.3:.5),(r()-.5)*sp.wobble]);d=v3.norm(d);
      p=v3.add(p,v3.mul(d,step+(i===1&&level?parentR*.6/segs:0)));pts.push(p);radii.push(lerp(radius,tip,Math.pow(t,.9)));weights.push(Math.min(1,w0+ws*t));}
    const br={level,pts,radii,weights,phase,length,children:0};branches.push(br);
    if(level<levels){const n=Math.max(1,Math.round((counts[level]||3)*(.8+.4*r())*(level===0&&sp.shape==='cone'?1:1)));const st=o.start?o.start[level]:sp.start[Math.min(level,sp.start.length-1)];
      const ang=sp.angle[Math.min(level,sp.angle.length-1)];let az=r()*TAU;
      for(let k=0;k<n;k++){const t=st+(1-st)*((k+.25+r()*.5)/n);az+=GOLDEN+(r()-.5)*.35;
        const s=sampleBranch(br,t),[A,B]=perpBasis(s.d),angle=lerp(ang[1],ang[0],level===0?t:r())*Math.PI/180,radial=v3.add(v3.mul(A,Math.cos(az)),v3.mul(B,Math.sin(az)));
        const cdir=v3.add(v3.mul(s.d,Math.cos(angle)),v3.mul(radial,Math.sin(angle))),clen=length*lengthFalloff*crownShape(sp.shape,t,level+1)*(.8+.4*r())*(level===0?H/Math.max(1e-3,length)*.55:1);
        const cr=Math.max(.006,s.r*sp.childRadius*(.85+.3*r()));br.children++;
        grow(level+1,s.p,cdir,clen,cr,s.w,level===0?r():(phase+(r()-.5)*.16+1)%1,s.r);}}
    return br;};
  const stems=sp.stems||1;
  for(let s=0;s<stems;s++){const a=r()*TAU,lean=stems>1?sp.lean*(.6+.6*r()):sp.lean*r(),dir=v3.norm([Math.cos(a)*Math.sin(lean),Math.cos(lean),Math.sin(a)*Math.sin(lean)]);
    grow(0,stems>1?[Math.cos(a)*R0*1.5,0,Math.sin(a)*R0*1.5]:[0,0,0],dir,H*sp.trunkTop*(stems>1?.7+.3*r():1),R0,0,r(),0);}
  return branches;
}
function makeGeometry(THREE,a,idx){
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(a.p,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(a.n,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(a.uv,2));g.setAttribute('color',new THREE.Float32BufferAttribute(a.c,3));g.setAttribute('windWeight',new THREE.Float32BufferAttribute(a.w,4));
  g.setIndex(idx);g.computeBoundingBox();g.computeBoundingSphere();return g;}
const buffers=()=>({p:[],n:[],uv:[],c:[],w:[]});
/* Bark tubes with parallel-transport frames (no twisting), root flare lobes, tip caps and bark UVs
   (u around the circumference, v along the arc length at a matching texel density). */
function buildTubes(branches,sp,detail,H,canopy,r){
  const a=buffers(),idx=[],tile=1.1;
  for(const br of branches){const L=br.level,radial=Math.max(3,Math.round((sp.radial[Math.min(L,sp.radial.length-1)]||4)*clamp(detail,.5,1.5))),n=br.pts.length;
    const base=a.p.length/3,uRep=Math.max(1,Math.round(TAU*br.radii[0]/tile)),vScale=uRep/(TAU*Math.max(br.radii[0],.02));
    let T=v3.norm(v3.sub(br.pts[1],br.pts[0])),[N]=perpBasis(T),vAcc=0,lobe=r()*TAU;
    for(let i=0;i<n;i++){
      const Ti=v3.norm(v3.sub(br.pts[Math.min(n-1,i+1)],br.pts[Math.max(0,i-1)]));N=v3.norm(v3.sub(N,v3.mul(Ti,v3.dot(N,Ti))));const B=v3.cross(Ti,N);T=Ti;
      if(i>0)vAcc+=v3.len(v3.sub(br.pts[i],br.pts[i-1]));const t=i/(n-1),P=br.pts[i];
      const inCanopy=canopy?clamp(Math.hypot((P[0]-canopy.c[0])/canopy.R[0],(P[1]-canopy.c[1])/canopy.R[1],(P[2]-canopy.c[2])/canopy.R[2]),0,1.2):1.2;
      const ao=clamp((L===0?1-.28*Math.exp(-P[1]*3):1)*(inCanopy<1?.55+.45*smooth(.15,1,inCanopy):1),0,1);
      for(let j=0;j<=radial;j++){const th=j/radial*TAU,dir=v3.add(v3.mul(N,Math.cos(th)),v3.mul(B,Math.sin(th)));
        let rad=br.radii[i];if(L===0&&sp.flare&&t<.14)rad*=1+sp.flare*Math.pow(1-t/.14,2)*(.65+.35*Math.cos(5*th+lobe));if(L<2)rad*=1+.05*Math.sin(th*3+i*1.7+lobe);
        const q=v3.add(P,v3.mul(dir,rad));a.p.push(q[0],q[1],q[2]);a.n.push(dir[0],dir[1],dir[2]);a.uv.push(j/radial*uRep,vAcc*vScale);a.c.push(ao,ao,ao);
        a.w.push(clamp(q[1]/H,0,1),br.weights[i],0,br.phase);}}
    for(let i=0;i<n-1;i++)for(let j=0;j<radial;j++){const k=base+i*(radial+1)+j,k2=k+radial+1;idx.push(k,k2,k+1,k+1,k2,k2+1);}
    const P=br.pts[n-1],tipP=v3.add(P,v3.mul(T,br.radii[n-1]*1.2)),ti=a.p.length/3;a.p.push(tipP[0],tipP[1],tipP[2]);a.n.push(T[0],T[1],T[2]);a.uv.push(.5,(vAcc+br.radii[n-1])*vScale);a.c.push(1,1,1);a.w.push(clamp(tipP[1]/H,0,1),br.weights[n-1],0,br.phase);
    const last=base+(n-1)*(radial+1);for(let j=0;j<radial;j++)idx.push(last+j,ti,last+j+1);}
  return {a,idx};
}
/* Leaf cards: 2x3-vertex quads (so they can droop) attached to terminal twigs, oriented outward from
   the crown, normals bent toward the crown ellipsoid normal, AO darker toward the crown core. */
function buildLeaves(branches,sp,o,H,r,layout){
  const a=buffers(),idx=[],attach=[],levels=Math.max(...branches.map(b=>b.level));
  for(const br of branches){const terminal=br.level===levels,pre=br.level===levels-1&&levels>0&&!br.children;if(!terminal&&!pre&&!(sp.flatCards&&br.level>=1))continue;
    const k=Math.max(1,Math.round(br.length*(terminal?3:2)));for(let i=0;i<k;i++){const t=lerp(terminal?sp.leafMinT:.55,1,(i+r())/k);attach.push(sampleBranch(br,t).p.concat([t]),br);}}
  if(!attach.length)return null;
  const pts=[];for(let i=0;i<attach.length;i+=2)pts.push([attach[i],attach[i+1]]);
  let mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];for(const [p] of pts)for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],p[k]);mx[k]=Math.max(mx[k],p[k]);}
  const leafSize=(o.leafCards&&o.leafCards.size)||sp.leafSize,c=v3.mul(v3.add(mn,mx),.5),R=[0,1,2].map(k=>Math.max(.3,(mx[k]-mn[k])*.5+leafSize*.4));
  const detail=clamp(o.detail,.3,1.5),count=Math.max(8,Math.round(((o.leafCards&&o.leafCards.count)||sp.leafCount)*detail)),size=leafSize/Math.sqrt(clamp(detail,.3,1)),bend=sp.normalBend;
  const cols=layout.cols,rows=layout.rows,inset=.004;let cards=0;
  /* One 2x3-vertex card: rooted slightly behind p, extending along out, drooping with t^2; vertex
     normals bend toward the crown ellipsoid normal; AO darkens toward the crown core and underside. */
  const emitCard=(p,out,right,nrm,sz,ci,flip,tint,droop,bw,phase)=>{const cx=ci%cols,cy=Math.floor(ci/cols),base=a.p.length/3;
    for(let row=0;row<3;row++){const t=row/2;for(let col=0;col<2;col++){const x=col-.5;
      let v=v3.add(v3.add(v3.sub(p,v3.mul(out,sz*.06)),v3.mul(out,sz*t)),v3.mul(right,sz*x));v[1]-=sz*droop*t*t;
      const en=v3.norm([(v[0]-c[0])/(R[0]*R[0]),(v[1]-c[1])/(R[1]*R[1]),(v[2]-c[2])/(R[2]*R[2])]),vn=v3.norm(v3.add(v3.mul(nrm,1-bend),v3.mul(en,bend)));
      const rn=Math.hypot((v[0]-c[0])/R[0],(v[1]-c[1])/R[1],(v[2]-c[2])/R[2]),ao=(.42+.58*smooth(.05,1,rn))*(.78+.22*clamp((v[1]-(c[1]-R[1]))/(2*R[1]),0,1));
      a.p.push(v[0],v[1],v[2]);a.n.push(vn[0],vn[1],vn[2]);
      const uu=(cx+(flip?1-(x+.5):(x+.5))*(1-2*inset)+inset)/cols,vv=1-(cy+1)/rows+(inset+t*(1-2*inset))/rows;a.uv.push(uu,vv);
      a.c.push(ao*tint[0],ao*tint[1],ao*tint[2]);a.w.push(clamp(v[1]/H,0,1),bw,t,phase);}}
    for(let row=0;row<2;row++){const k=base+row*2;idx.push(k,k+1,k+2,k+1,k+3,k+2);}};
  for(let q=0;q<count;q++){const [ap,br]=pts[Math.floor(r()*pts.length)],p=[ap[0],ap[1],ap[2]],s=sampleBranch(br,ap[3]),radialDir=v3.norm(v3.sub(p,c));
    let out,right,nrm;
    if(sp.flatCards){out=v3.norm(v3.add(v3.mul(s.d,1),v3.mul(randUnit(r),.3)));out[1]*=.5;out=v3.norm(out);right=v3.norm(v3.cross(out,[0,1,0]));nrm=v3.cross(right,out);
      const roll=(r()-.5)*.7;nrm=v3.norm(v3.add(v3.mul(nrm,Math.cos(roll)),v3.mul(right,Math.sin(roll))));right=v3.norm(v3.cross(out,nrm));right=v3.mul(right,-1);}
    else{out=v3.norm(v3.add(v3.add(v3.mul(s.d,.65),v3.mul(radialDir,.8)),v3.mul(randUnit(r),.55)));out[1]-=.12;out=v3.norm(out);
      /* Face the card outward from the crown (shingle-like) with a random roll about its axis, so from
         outside most cards are seen face-on while silhouettes stay irregular. */
      let face=v3.sub(radialDir,v3.mul(out,v3.dot(radialDir,out)));face=v3.len(face)<.2?perpBasis(out)[0]:v3.norm(face);
      const side=v3.cross(out,face),roll=(r()-.5)*(sp.cardRoll!==undefined?sp.cardRoll:1.5);nrm=v3.norm(v3.add(v3.mul(face,Math.cos(roll)),v3.mul(side,Math.sin(roll))));right=v3.cross(out,nrm);}
    if(v3.dot(nrm,radialDir)<0){nrm=v3.mul(nrm,-1);right=v3.mul(right,-1);}
    const sz=size*(.72+.5*r()),tint=[1+(r()-.5)*.14,1+(r()-.5)*.12,1+(r()-.5)*.18],droop=sp.flatCards?.08:.16;
    emitCard(p,out,right,nrm,sz,Math.floor(r()*cols*rows),r()<.5,tint,droop,s.w,br.phase);
    /* optional crossed second card (rotated 90 degrees about the card axis): no gaps when the first is edge-on */
    if(!sp.flatCards&&r()<(sp.cross||0)){const n2=v3.dot(right,radialDir)>=0?right:v3.mul(right,-1);emitCard(p,out,v3.cross(out,n2),n2,sz*.9,Math.floor(r()*cols*rows),r()<.5,tint,droop,s.w,br.phase);cards++;}
    cards++;}
  return {a,idx,canopy:{c,R},cards};
}
/* Palm fronds: arching 3-wide strips (V-folded along the rachis) textured with one atlas cell each. */
function buildFronds(trunkTop,sp,o,H,r,layout){
  const a=buffers(),idx=[],n=Math.max(3,Math.round(((o.branches&&o.branches[0])||sp.branches[0])*clamp(o.detail,.5,1.3))),segs=Math.max(5,Math.round(9*clamp(o.detail,.5,1.5)));
  const top=trunkTop.p,c=[top[0],top[1]-.3,top[2]],cols=layout.cols;let az=r()*TAU;
  for(let f=0;f<n;f++){az+=GOLDEN+(r()-.5)*.3;const elev=lerp(.75,-.25,((f*7)%n)/n)+(r()-.5)*.15,L=((o.leafCards&&o.leafCards.size)||sp.leafSize)*(.85+.3*r()),phase=r(),cell=Math.floor(r()*cols);
    let d=v3.norm([Math.cos(az)*Math.cos(elev),Math.sin(elev),Math.sin(az)*Math.cos(elev)]),p=top.slice();const base=a.p.length/3;
    for(let i=0;i<=segs;i++){const t=i/segs;if(i>0){d=v3.norm(v3.add(d,[0,-(sp.gravity*2.2+.05)*(.6+t),0]));p=v3.add(p,v3.mul(d,L/segs));}
      const right=v3.norm(v3.cross(d,[0,1,0])),up=v3.norm(v3.cross(right,d)),w=L*.2*Math.pow(Math.sin(Math.PI*(.08+.92*t)),.55);
      for(let k=0;k<3;k++){const x=k-1,v=v3.add(v3.add(p,v3.mul(right,x*w)),v3.mul(up,-Math.abs(x)*w*.28)),en=v3.norm(v3.sub(v,c)),vn=v3.norm(v3.add(v3.mul(up,1-sp.normalBend),v3.mul(en,sp.normalBend)));
        a.p.push(v[0],v[1],v[2]);a.n.push(vn[0],vn[1],vn[2]);a.uv.push((cell+.02+.96*(k/2))/cols,.01+.98*t);const ao=.6+.4*t;a.c.push(ao,ao,ao);a.w.push(clamp(v[1]/H,0,1),t,t*Math.abs(x),phase);}}
    for(let i=0;i<segs;i++)for(let k=0;k<2;k++){const q=base+i*3+k;idx.push(q,q+3,q+1,q+1,q+3,q+4);}}
  return {a,idx,canopy:{c,R:[H*.35,H*.2,H*.35]},cards:n};
}
/* Deterministic procedural tree. Returns {trunk, leaves, bounds, stats}; both geometries carry
   position/normal/uv/color(AO)/windWeight(vec4: height, branch weight, flutter, phase). */
KE.treeGeometry=(THREE,o={})=>{
  const species=SPECIES[o.species]?o.species:'broadleaf',sp=SPECIES[species],r=KE.random((o.seed===undefined?1:o.seed)*7919+species.length*101+13);
  const opts=Object.assign({},o,{detail:o.detail!==undefined?o.detail:clamp(KE.settings.lod||1,.5,1.25)}),H=o.height!==undefined?o.height:sp.height;
  const layout=(o.leafCards&&o.leafCards.texture&&o.leafCards.texture.userData&&o.leafCards.texture.userData.layout)||(species==='palm'?{cols:2,rows:1}:{cols:2,rows:2});
  const branches=growTree(sp,opts,r);
  /* Normalise the skeleton to the requested height (radii are kept) so every seed matches its size. */
  let top=0;for(const b of branches)for(const p of b.pts)top=Math.max(top,p[1]);const target=species==='palm'?H*sp.trunkTop:H-(sp.leafSize*.35*(species==='conifer'?.2:1));
  const k=clamp(target/Math.max(top,1e-3),.6,1.6);for(const b of branches){for(const p of b.pts){p[0]*=k;p[1]*=k;p[2]*=k;}b.length*=k;}
  const leaves=species==='palm'?buildFronds(sampleBranch(branches[0],1),sp,opts,H,r,layout):buildLeaves(branches,sp,opts,H,r,layout);
  const tubes=buildTubes(branches,sp,opts.detail,H,leaves&&leaves.canopy,r);
  /* Second pass: fit the finished tree (bark and leaf cards) to exactly the requested height, then
     re-derive the normalised-height wind weight so the main bend is 0 at the root and 1 at the top. */
  let maxY=0;for(const a of [tubes.a,leaves&&leaves.a])if(a)for(let i=1;i<a.p.length;i+=3)maxY=Math.max(maxY,a.p[i]);
  const fit=clamp(H/Math.max(maxY,1e-3),.5,2);
  for(const a of [tubes.a,leaves&&leaves.a]){if(!a)continue;for(let i=0;i<a.p.length;i++)a.p[i]*=fit;for(let i=0,j=0;i<a.p.length;i+=3,j+=4)a.w[j]=clamp(a.p[i+1]/H,0,1);}
  if(leaves){leaves.canopy.c=v3.mul(leaves.canopy.c,fit);leaves.canopy.R=v3.mul(leaves.canopy.R,fit);}
  const trunk=makeGeometry(THREE,tubes.a,tubes.idx),leafGeo=leaves?makeGeometry(THREE,leaves.a,leaves.idx):null;
  const box=trunk.boundingBox.clone();if(leafGeo)box.union(leafGeo.boundingBox);const sphere=box.getBoundingSphere(new THREE.Sphere());
  const stats={species,branches:branches.length,leafCards:leaves?leaves.cards:0,trunkTriangles:tubes.idx.length/3,leafTriangles:leaves?leaves.idx.length/3:0};
  trunk.userData.keTree=stats;if(leafGeo)leafGeo.userData.keTree=stats;
  return {trunk,leaves:leafGeo,bounds:{box,sphere,height:box.max.y,canopy:leaves?{center:new THREE.Vector3(...leaves.canopy.c),radius:new THREE.Vector3(...leaves.canopy.R)}:null},stats,species,layout};
};
/* Convenience: geometry + textures + materials + shadow materials in one Group. */
KE.tree=(THREE,o={})=>{
  const species=SPECIES[o.species]?o.species:'broadleaf',sp=SPECIES[species],leafTex=o.leafTexture||KE.leafTexture(THREE,{species,size:o.textureSize||(KE.settings.tex>=512?512:256),seed:o.textureSeed||1});
  const geo=KE.treeGeometry(THREE,Object.assign({},o,{species,leafCards:Object.assign({},o.leafCards||{},{texture:leafTex})}));
  const wind=Object.assign({trunk:.02,branch:.06,leaf:.12},o.wind||{});
  const leafMat=o.leafMaterial||KE.foliageMaterial(THREE,{map:leafTex,color:o.leafColor,vertexColors:true,wind,translucency:o.translucency,translucencyColor:o.translucencyColor!==undefined?o.translucencyColor:sp.transColor,alphaTest:o.alphaTest,roughness:.72});
  const barkMat=o.barkMaterial||KE.barkMaterial(THREE,{species,color:o.barkColor!==undefined?o.barkColor:sp.barkColor,vertexColors:true,wind});
  const group=new THREE.Group();group.name='ke-tree-'+species;
  const trunk=new THREE.Mesh(geo.trunk,barkMat);trunk.castShadow=trunk.receiveShadow=true;trunk.customDepthMaterial=KE.foliageDepthMaterial(barkMat);group.add(trunk);
  let leaves=null;if(geo.leaves){leaves=new THREE.Mesh(geo.leaves,leafMat);leaves.castShadow=leaves.receiveShadow=true;leaves.customDepthMaterial=KE.foliageDepthMaterial(leafMat);leaves.customDistanceMaterial=KE.foliageDepthMaterial(leafMat,{distance:true});group.add(leaves);}
  return {group,trunk,leaves,geometry:{trunk:geo.trunk,leaves:geo.leaves},material:{trunk:barkMat,leaves:leafMat},bounds:geo.bounds,stats:geo.stats,
    dispose(){if(group.parent)group.parent.remove(group);geo.trunk.dispose();if(geo.leaves)geo.leaves.dispose();
      if(!o.leafMaterial)disposeFoliageMaterial(leafMat);if(!o.barkMaterial)disposeFoliageMaterial(barkMat);
      if(!o.leafTexture&&!o.leafMaterial)leafTex.dispose();if(!o.barkMaterial&&barkMat.userData.keOwnsMap&&barkMat.map)barkMat.map.dispose();}};
};

/* ---------- shared light loop for the custom grass/fur shaders ---------- */
/* Directional lights with shadows. When a KE.CascadedShadows instance is bound (KF_CSM = cascade count)
   the cascade shadow terms are blended across overlap bands exactly like set-up standard materials,
   applied to the sun (light 0), and the zero-intensity cascade lights are skipped. */
const CSM_PARS=`#ifdef KF_CSM
uniform vec4 keCascades[4];
#endif
`;
const dirLightLoop=body=>`#if NUM_DIR_LIGHTS>0
 DirectionalLight dl;vec3 lc;
#if defined(USE_SHADOWMAP)&&NUM_DIR_LIGHT_SHADOWS>0
 DirectionalLightShadow ds;
#endif
#ifdef KF_CSM
 float kfSh=0.,kfSw=0.,kfWt;vec4 kfC;
#pragma unroll_loop_start
 for(int i=0;i<NUM_DIR_LIGHTS;i++){
#if defined(USE_SHADOWMAP)&&(UNROLLED_LOOP_INDEX<KF_CSM)&&(UNROLLED_LOOP_INDEX<NUM_DIR_LIGHT_SHADOWS)
  kfC=keCascades[i];kfWt=smoothstep(kfC.x,kfC.y,vViewPosition.z)*(1.-smoothstep(kfC.z,kfC.w,vViewPosition.z));
  if(kfWt>0.){ds=directionalLightShadows[i];kfSh+=kfWt*(receiveShadow?getShadow(directionalShadowMap[i],ds.shadowMapSize,ds.shadowBias,ds.shadowRadius,vDirectionalShadowCoord[i]):1.);kfSw+=kfWt;}
#endif
 }
#pragma unroll_loop_end
 kfSh+=1.-kfSw;
#endif
#pragma unroll_loop_start
 for(int i=0;i<NUM_DIR_LIGHTS;i++){
  dl=directionalLights[i];lc=dl.color;
#if defined(KF_CSM)&&(UNROLLED_LOOP_INDEX==0)
  lc*=kfSh;
#elif defined(KF_CSM)&&(UNROLLED_LOOP_INDEX<KF_CSM)
  lc*=0.;
#elif defined(USE_SHADOWMAP)&&(UNROLLED_LOOP_INDEX<NUM_DIR_LIGHT_SHADOWS)
  ds=directionalLightShadows[i];lc*=receiveShadow?getShadow(directionalShadowMap[i],ds.shadowMapSize,ds.shadowBias,ds.shadowRadius,vDirectionalShadowCoord[i]):1.;
#endif
  ${body}
 }
#pragma unroll_loop_end
#endif`;
/* Keep a custom ShaderMaterial in sync with a cascaded-shadow source (cheap; call every frame). */
function syncShadowSource(mat,csm){
  const want=csm&&csm.lights&&csm.lights.length&&csm.uniforms&&csm.uniforms.keCascades?Math.max(1,csm.count|0):0,cur=mat.defines.KF_CSM|0;
  if(want)mat.uniforms.keCascades=csm.uniforms.keCascades;
  if(want!==cur){if(want)mat.defines.KF_CSM=want;else delete mat.defines.KF_CSM;mat.needsUpdate=true;}
}
const liveSystems=new Set();

/* ---------- interactive grass ---------- */
const GRASS_VS=`
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
uniform vec4 keInteractors[${MAX_INTERACTORS}];uniform int keInteractorCount;
uniform vec2 uCenter;uniform float uRadius;uniform float uLodRadius;uniform float uFarFraction;uniform float uFarWiden;uniform float uInteract;
attribute vec4 aRoot;attribute vec4 aShape;attribute vec4 aColor;
varying vec3 vColor;varying vec2 vBlade;varying vec3 vNormal;varying vec3 vViewPosition;
void main(){
 vec3 root=aRoot.xyz;float rnd=aRoot.w,dist=length(root.xz-uCenter);
 /* aColor.w is the blade's rank in its cell (0..1): the ring beyond the LOD radius keeps only the first
    uFarFraction ranks (the same set outer cells are filled with), thinned smoothly over the band */
 float lodT=smoothstep(uLodRadius*.72,uLodRadius,dist),keep=mix(1.,uFarFraction,lodT)+.04;
 float fade=(1.-smoothstep(uRadius*.8,uRadius,dist))*(1.-smoothstep(keep-.04,keep,aColor.w));
 float h=aShape.y*fade,w=aShape.z*mix(1.,uFarWiden,lodT),yaw=aShape.x;
 vec2 face=vec2(cos(yaw),sin(yaw));vec3 side=vec3(-face.y,0.,face.x);
 float S=keWindStrength,gust=kfGust(root.xz);
 float sway=sin(keTime*(1.7+rnd*.9)+rnd*6.2831853+dot(root.xz,keWindDir)*.4);
 vec2 bend=keWindDir*(S*(.1+.8*gust+.14*sway))+vec2(-keWindDir.y,keWindDir.x)*(S*.1*sin(keTime*2.3+rnd*9.))+face*aShape.w;
 for(int i=0;i<${MAX_INTERACTORS};i++){if(i>=keInteractorCount)break;vec4 it=keInteractors[i];
  vec2 d=root.xz-it.xz;float dl=length(d),r=max(it.w,.05);
  float vert=1.-smoothstep(0.,r*.6+.3,(it.y-r)-(root.y+aShape.y));
  float inf=(1.-smoothstep(r*.35,r*1.6+.08,dl))*vert*uInteract;
  bend+=(dl>1e-4?d/dl:face)*(inf*2.6);}
 float a=length(bend);vec2 bd=a>1e-5?bend/a:face;a=clamp(a,1e-3,1.45);
 vec3 b3=vec3(bd.x,0.,bd.y);
 /* circular-arc blade approximated by a quadratic Bezier: tangent vertical at the root, length h */
 float R=h/a;vec3 p1=vec3(0.,R*tan(a*.5),0.),p2=b3*(R*(1.-cos(a)))+vec3(0.,R*sin(a),0.);
 float t=position.y,x=position.x;
 vec3 c=2.*(1.-t)*t*p1+t*t*p2,tg=normalize(2.*(1.-t)*p1+2.*t*(p2-p1)+vec3(0.,1e-4,0.));
 float wt=w*(1.-t*t*.85);
 vec3 pos=root+c+side*(x*wt);
 vec3 n=normalize(cross(tg,side));n=normalize(n+side*(x*1.6));n=normalize(n*.6+vec3(0.,.55,0.));
 vColor=pow(aColor.rgb,vec3(2.2));vBlade=vec2(t,rnd);
 vec4 mvPosition=viewMatrix*vec4(pos,1.);gl_Position=projectionMatrix*mvPosition;
#ifndef KF_DEPTH
 vViewPosition=-mvPosition.xyz;vNormal=normalize((viewMatrix*vec4(n,0.)).xyz);
 vec4 worldPosition=vec4(pos,1.);vec3 transformedNormal=vNormal;
#include <shadowmap_vertex>
#include <fog_vertex>
#endif
}`;
const GRASS_FS=`
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
${CSM_PARS}uniform vec3 uTipColor;uniform float uTipMix;uniform float uTranslucency;uniform float uAmbient;uniform float uRootShade;
varying vec3 vColor;varying vec2 vBlade;varying vec3 vNormal;varying vec3 vViewPosition;
void main(){
 float t=vBlade.x;vec3 base=vColor*(.92+.16*vBlade.y);
 vec3 tip=mix(base*1.2,uTipColor,uTipMix);
 vec3 albedo=mix(base*.6,base,smoothstep(0.,.45,t));albedo=mix(albedo,tip,smoothstep(.45,1.,t));
 vec3 v=normalize(vViewPosition),n=normalize(vNormal),upV=normalize((viewMatrix*vec4(0.,1.,0.,0.)).xyz);
 if(!gl_FrontFacing)n=normalize(2.*dot(n,upV)*upV-n);
 vec3 direct=vec3(0.),spec=vec3(0.);float ndl,trans;
${dirLightLoop('ndl=dot(n,dl.direction);trans=pow(saturate(dot(v,-dl.direction)),4.)*uTranslucency*(.2+.8*t);direct+=lc*(saturate((ndl+.6)/1.6)+trans);spec+=lc*(pow(saturate(dot(n,normalize(dl.direction+v))),28.)*.07*t);')}
#if NUM_POINT_LIGHTS>0
 PointLight pl;vec3 pv;float pd;
#pragma unroll_loop_start
 for(int i=0;i<NUM_POINT_LIGHTS;i++){
  pl=pointLights[i];pv=pl.position+vViewPosition;pd=length(pv);
  direct+=pl.color*punctualLightIntensityToIrradianceFactor(pd,pl.distance,pl.decay)*saturate((dot(n,pv/pd)+.6)/1.6);
 }
#pragma unroll_loop_end
#endif
 GeometricContext gc;gc.position=-vViewPosition;gc.normal=n;gc.viewDir=v;
 vec3 amb=ambientLightColor+getLightProbeIrradiance(lightProbe,gc)/PI;
#if NUM_HEMI_LIGHTS>0
#pragma unroll_loop_start
 for(int i=0;i<NUM_HEMI_LIGHTS;i++){
  amb+=mix(hemisphereLights[i].groundColor,hemisphereLights[i].skyColor,dot(n,hemisphereLights[i].direction)*.5+.5);
 }
#pragma unroll_loop_end
#endif
 /* dense grass self-occludes: both direct and ambient light fall off toward the root */
 float occ=mix(uRootShade,1.,smoothstep(0.,.8,t)),ao=mix(.35,1.,smoothstep(0.,.65,t));
 gl_FragColor=vec4(albedo*(direct*occ+amb*uAmbient*ao)+spec*occ,1.);
#include <tonemapping_fragment>
#include <encodings_fragment>
#include <fog_fragment>
}`;
const GRASS_DEPTH_FS=`
#include <packing>
void main(){gl_FragColor=packDepthToRGBA(gl_FragCoord.z);}`;
function hash3i(x,z,s){let h=Math.imul(x|0,0x27d4eb2d)^Math.imul(z|0,0x165667b1)^Math.imul(s|0,0x9e3779b1);h=Math.imul(h^(h>>>15),0x85ebca6b);h=Math.imul(h^(h>>>13),0xc2b2ae35);return (h^(h>>>16))>>>0;}
let rs=1;const rnext=()=>{rs=(rs+0x6D2B79F5)|0;let t=rs;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
/* World-anchored grass. The ground is divided into square cells; the cells near the viewer hold
   bladesNear each and outer cells hold a thinner set (same hashed positions, the first ranks). Each
   cell owns a fixed slot of the instance buffers, so moving the camera only regenerates cells that
   entered the window (or changed ring) and uploads that sub-range. Blades are procedural arcs bent by
   travelling gusts and pushed by up to 8 interactors in the vertex shader. */
KE.grassField=(THREE,scene,o={})=>{
  const U=foliageUniforms(THREE),count=Math.max(0,Math.floor(o.count!==undefined?o.count:(KE.settings.grass||7000)));
  const radius=Math.max(2,o.radius||25),cellSize=o.cellSize||clamp(radius/7,1.5,8),lodRadius=clamp(o.lodRadius!==undefined?o.lodRadius:radius*.4,cellSize,radius),farFraction=clamp(o.farFraction!==undefined?o.farFraction:.28,.05,1);
  const heightAt=o.heightAt||(()=>0),density=o.density||(()=>1),colorFn=o.color||null,bh=o.bladeHeight||[.35,.8],bw=o.bladeWidth!==undefined?o.bladeWidth:.05,segments=clamp(Math.round(o.segments||4),1,8),seed=o.seed||1;
  const stub={mesh:null,count:0,update(){return 0;},setVisible(){},dispose(){}};if(!count)return stub;
  /* window offsets: cells whose nearest point to the camera cell lies inside radius (conservative) */
  const Hc=Math.ceil(radius/cellSize)+1,W=2*Hc+1,ring=new Uint8Array(W*W),nearOff=[],farOff=[];
  for(let dz=-Hc;dz<=Hc;dz++)for(let dx=-Hc;dx<=Hc;dx++){const ex=Math.max(0,Math.abs(dx)-1)*cellSize,ez=Math.max(0,Math.abs(dz)-1)*cellSize,d=Math.hypot(ex,ez);
    if(d<lodRadius){ring[(dz+Hc)*W+dx+Hc]=1;nearOff.push(dx,dz);}else if(d<radius){ring[(dz+Hc)*W+dx+Hc]=2;farOff.push(dx,dz);}}
  const nearSlots=nearOff.length/2,farSlots=farOff.length/2,kNear=Math.max(1,Math.floor(count/(nearSlots+farSlots*farFraction))),kFar=Math.max(1,Math.round(kNear*farFraction));
  const capacity=nearSlots*kNear+farSlots*kFar,slots=nearSlots+farSlots;
  /* blade template: rows of two vertices plus a single tip vertex */
  const tp=[],ti=[];for(let s=0;s<segments;s++)tp.push(-.5,s/segments,0,.5,s/segments,0);tp.push(0,1,0);
  for(let s=0;s<segments-1;s++){const k=s*2;ti.push(k,k+1,k+2,k+1,k+3,k+2);}ti.push((segments-1)*2,(segments-1)*2+1,segments*2);
  const geo=new THREE.InstancedBufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(tp,3));geo.setIndex(ti);
  const root=new Float32Array(capacity*4),shape=new Float32Array(capacity*4),color=new Uint8Array(capacity*4);
  const aRoot=new THREE.InstancedBufferAttribute(root,4),aShape=new THREE.InstancedBufferAttribute(shape,4),aColor=new THREE.InstancedBufferAttribute(color,4,true);
  for(const a of [aRoot,aShape,aColor])a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aRoot',aRoot);geo.setAttribute('aShape',aShape);geo.setAttribute('aColor',aColor);geo.instanceCount=capacity;
  const own={uCenter:{value:new THREE.Vector2()},uRadius:{value:radius},uLodRadius:{value:lodRadius},uFarFraction:{value:kFar/kNear},uFarWiden:{value:o.farWiden!==undefined?o.farWiden:1.8},uInteract:{value:o.interact===false?0:1},
    uTipColor:{value:srgb(THREE,o.tipColor,0xc9cf7a)},uTipMix:{value:o.tipColor===null?0:(o.tipMix!==undefined?o.tipMix:.4)},uTranslucency:{value:o.translucency!==undefined?o.translucency:.6},uAmbient:{value:o.ambient!==undefined?o.ambient:1},
    uRootShade:{value:o.rootShade!==undefined?o.rootShade:.4}};
  const uniforms=THREE.UniformsUtils.merge([THREE.UniformsLib.lights,THREE.UniformsLib.fog]);Object.assign(uniforms,sharedRefs(U),{keInteractors:U.keInteractors,keInteractorCount:U.keInteractorCount},own);
  const vs=NOISE_GLSL()+WIND_UNIFORMS+GUST_GLSL+GRASS_VS;
  const mat=new THREE.ShaderMaterial({uniforms,vertexShader:vs,fragmentShader:GRASS_FS,lights:true,fog:true,side:THREE.DoubleSide});
  const mesh=new THREE.Mesh(geo,mat);mesh.frustumCulled=false;mesh.receiveShadow=o.receiveShadow!==false;mesh.castShadow=!!o.castShadow;mesh.name='ke-grass-field';
  mesh.raycast=()=>{};
  if(mesh.castShadow){const dm=new THREE.ShaderMaterial({uniforms,vertexShader:'#define KF_DEPTH\n'+vs,fragmentShader:GRASS_DEPTH_FS,side:THREE.DoubleSide});mesh.customDepthMaterial=dm;}
  if(scene)scene.add(mesh);
  const slotX=new Int32Array(slots),slotZ=new Int32Array(slots),slotUsed=new Uint8Array(slots),slotBase=new Int32Array(slots),slotK=new Int32Array(slots),keep=new Uint8Array(W*W);
  for(let s=0;s<slots;s++){slotBase[s]=s<nearSlots?s*kNear:nearSlots*kNear+(s-nearSlots)*kFar;slotK[s]=s<nearSlots?kNear:kFar;}
  const freeNear=new Int32Array(nearSlots),freeFar=new Int32Array(farSlots),col=[1,1,1];let nFreeNear=0,nFreeFar=0,ccx=1e9,ccz=1e9,dirtyMin=1e9,dirtyMax=-1;
  const stats={cellsFilled:0,lastFilled:0,bladesPerNearCell:kNear,bladesPerFarCell:kFar,capacity,slots};
  /* Tufts: each cell holds nClumps clump centres on a jittered low-discrepancy (R2) pattern; blade i
     belongs to clump i % nClumps, so any prefix of the blade list (the sparser outer rings) still covers
     every clump. Blades splay outward from their clump centre (yaw faces away, lean grows with offset)
     and share the clump's height, tint and lean bias, which reads as natural grass tussocks. */
  const clumpSize=clamp(o.clumpSize!==undefined?o.clumpSize:5,1,16),nClumps=Math.max(1,Math.round(kNear/clumpSize)),clumpR=o.clumpRadius!==undefined?o.clumpRadius:Math.min(.22,cellSize/Math.sqrt(nClumps)*.75);
  const clumps=new Float32Array(nClumps*6);
  const fillCell=(slot,gx,gz)=>{
    const base=slotBase[slot],k=slotK[slot];rs=hash3i(gx,gz,seed);const ou=rnext(),ov=rnext();
    for(let q=0;q<nClumps;q++){const u=(ou+q*.7548776662)%1,v=(ov+q*.5698402910)%1,jit=.35/Math.sqrt(nClumps);
      clumps[q*6]=(gx+clamp(u+(rnext()-.5)*jit,0,1))*cellSize;clumps[q*6+1]=(gz+clamp(v+(rnext()-.5)*jit,0,1))*cellSize;
      clumps[q*6+2]=.7+.45*rnext();clumps[q*6+3]=rnext()*TAU;clumps[q*6+4]=rnext()*.25;clumps[q*6+5]=rnext();}
    for(let i=0;i<k;i++){const j=base+i,q=i%nClumps,a=rnext()*TAU,rad=clumpR*Math.sqrt(rnext()),rr=rnext(),hr=rnext(),wr=rnext(),cr=rnext(),yr=rnext();
      const x=clumps[q*6]+Math.cos(a)*rad,z=clumps[q*6+1]+Math.sin(a)*rad,off=rad/Math.max(clumpR,1e-4);
      const d=clamp(density(x,z),0,1),ch=clumps[q*6+2];
      /* splay: face away from the clump centre (with some spread), plus the clump's shared lean direction */
      const lx=Math.cos(a)*(.12+.5*off)+Math.cos(clumps[q*6+3])*clumps[q*6+4],lz=Math.sin(a)*(.12+.5*off)+Math.sin(clumps[q*6+3])*clumps[q*6+4];
      root[j*4]=x;root[j*4+1]=heightAt(x,z);root[j*4+2]=z;root[j*4+3]=rr;
      shape[j*4]=Math.atan2(lz,lx)+(yr-.5)*.9;shape[j*4+1]=d>rr?lerp(bh[0],bh[1],hr)*ch*(1-.35*off)*(.55+.45*d):0;shape[j*4+2]=bw*(.75+.5*wr);shape[j*4+3]=Math.hypot(lx,lz)+.06;
      let c=null;if(colorFn){c=colorFn(x,z,col);if(!c)c=col;}else{const n=.5+.5*Math.sin(x*.21+Math.sin(z*.17)*2.)*Math.cos(z*.19-x*.07);col[0]=lerp(.26,.42,n*.6+cr*.4);col[1]=lerp(.44,.55,n);col[2]=lerp(.14,.2,cr);c=col;}
      const shade=(.9+.2*cr)*(.82+.3*clumps[q*6+5]);color[j*4]=clamp(c[0]*shade*255,0,255);color[j*4+1]=clamp(c[1]*shade*255,0,255);color[j*4+2]=clamp(c[2]*(.9+.2*clumps[q*6+5])*255,0,255);color[j*4+3]=Math.min(255,Math.floor(i/kNear*255));}
    slotX[slot]=gx;slotZ[slot]=gz;slotUsed[slot]=1;dirtyMin=Math.min(dirtyMin,base);dirtyMax=Math.max(dirtyMax,base+k);stats.cellsFilled++;stats.lastFilled++;};
  const upload=()=>{if(dirtyMax<0)return;for(const [attr,n] of [[aRoot,4],[aShape,4],[aColor,4]]){attr.updateRange.offset=dirtyMin*n;attr.updateRange.count=(dirtyMax-dirtyMin)*n;attr.needsUpdate=true;}dirtyMin=1e9;dirtyMax=-1;};
  let visible=true,shadowSource=o.shadows||KE.foliage.shadowSource||null;
  const api={mesh,material:mat,geometry:geo,cellSize,radius,lodRadius,stats,
    /* Bind a KE.CascadedShadows instance so blades receive every cascade (null unbinds). */
    setShadowSource(csm){shadowSource=csm||null;syncShadowSource(mat,shadowSource);return api;},
    /* Returns the number of cells regenerated this call (0 while the camera stays inside its cell). */
    update(camX,camZ){if(camX&&typeof camX==='object'){camZ=camX.z;camX=camX.x;}if(!Number.isFinite(camX)||!Number.isFinite(camZ))return 0;syncShadowSource(mat,shadowSource);own.uCenter.value.set(camX,camZ);const cx=Math.floor(camX/cellSize),cz=Math.floor(camZ/cellSize);
      stats.lastFilled=0;if(cx===ccx&&cz===ccz)return 0;ccx=cx;ccz=cz;keep.fill(0);nFreeNear=nFreeFar=0;
      for(let s=0;s<slots;s++){const want=s<nearSlots?1:2;let ok=false;if(slotUsed[s]){const dx=slotX[s]-cx,dz=slotZ[s]-cz;if(dx>=-Hc&&dx<=Hc&&dz>=-Hc&&dz<=Hc){const gi=(dz+Hc)*W+dx+Hc;if(ring[gi]===want&&!keep[gi]){keep[gi]=1;ok=true;}}}
        if(!ok){slotUsed[s]=0;if(s<nearSlots)freeNear[nFreeNear++]=s;else freeFar[nFreeFar++]=s;}}
      for(let q=0;q<nearOff.length;q+=2){const dx=nearOff[q],dz=nearOff[q+1],gi=(dz+Hc)*W+dx+Hc;if(!keep[gi])fillCell(freeNear[--nFreeNear],cx+dx,cz+dz);}
      for(let q=0;q<farOff.length;q+=2){const dx=farOff[q],dz=farOff[q+1],gi=(dz+Hc)*W+dx+Hc;if(!keep[gi])fillCell(freeFar[--nFreeFar],cx+dx,cz+dz);}
      upload();return stats.lastFilled;},
    /* Force regeneration (e.g. after terrain edits or a density change). */
    refresh(){ccx=ccz=1e9;slotUsed.fill(0);},
    setVisible(v){visible=!!v;mesh.visible=visible;},
    get visible(){return visible;},
    dispose(){liveSystems.delete(api);if(mesh.parent)mesh.parent.remove(mesh);geo.dispose();mat.dispose();if(mesh.customDepthMaterial)mesh.customDepthMaterial.dispose();}};
  syncShadowSource(mat,shadowSource);liveSystems.add(api);
  return api;
};

/* ---------- shell fur ---------- */
/* 3D tileable Worley (F1) strand field: R = strand profile (1 at a strand centre), G/B = per-strand
   random values (length and colour variation). Sampled at the unextruded surface point, so each strand
   is a continuous column through the shells regardless of mesh UVs. */
let strandTex=null,strandUsers=0;
function strandTexture(THREE){
  if(strandTex){strandUsers++;return strandTex;}
  const N=48,C=12,per=N/C,r=KE.random(4242),fp=new Float32Array(C*C*C*3),ids=new Float32Array(C*C*C*2);
  for(let i=0;i<C*C*C;i++){fp[i*3]=r();fp[i*3+1]=r();fp[i*3+2]=r();ids[i*2]=r();ids[i*2+1]=r();}
  const data=new Uint8Array(N*N*N*4);
  for(let z=0;z<N;z++)for(let y=0;y<N;y++)for(let x=0;x<N;x++){const px=(x+.5)/per,py=(y+.5)/per,pz=(z+.5)/per,cx=Math.floor(px),cy=Math.floor(py),cz=Math.floor(pz);let best=9,bi=0;
    for(let k=-1;k<=1;k++)for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++){const gx=cx+i,gy=cy+j,gz=cz+k,wx=((gx%C)+C)%C,wy=((gy%C)+C)%C,wz=((gz%C)+C)%C,ci=(wz*C+wy)*C+wx;
      const dx=gx+fp[ci*3]-px,dy=gy+fp[ci*3+1]-py,dz=gz+fp[ci*3+2]-pz,d=dx*dx+dy*dy+dz*dz;if(d<best){best=d;bi=ci;}}
    const o=((z*N+y)*N+x)*4,s=clamp(1-Math.sqrt(best)/.72,0,1);data[o]=s*255;data[o+1]=ids[bi*2]*255;data[o+2]=ids[bi*2+1]*255;data[o+3]=255;}
  const t=new THREE.DataTexture3D(data,N,N,N);t.format=THREE.RGBAFormat;t.type=THREE.UnsignedByteType;t.minFilter=t.magFilter=THREE.LinearFilter;t.wrapS=t.wrapT=t.wrapR=THREE.RepeatWrapping;t.unpackAlignment=1;t.needsUpdate=true;
  t.userData={cells:C};strandTex=t;strandUsers=1;return t;
}
function releaseStrands(){if(--strandUsers<=0&&strandTex){strandTex.dispose();strandTex=null;strandUsers=0;}}
const FUR_VS=`
#include <common>
#include <fog_pars_vertex>
#include <shadowmap_pars_vertex>
attribute vec2 aShell;// x: shell index, y: per-mesh length multiplier
uniform float uShells;uniform float uLength;uniform float uDensity;uniform float uDroop;uniform float uWindResponse;uniform float uCurl;
uniform vec3 uGravity;uniform vec3 uInertia;
varying vec3 vCoord;varying float vH;varying float vShell;varying vec3 vNormal;varying vec3 vViewPosition;varying vec3 vDirV;
#ifdef USE_FUR_MAP
varying vec2 vFurUv;
#endif
void main(){
 float h=(aShell.x+1.)/uShells;
 mat3 m=mat3(modelMatrix);vec3 sc=vec3(length(m[0]),length(m[1]),length(m[2]));
 vec3 wn=normalize(m*(normal/(sc*sc)));vec4 wp=modelMatrix*vec4(position,1.);
 vec3 wd=vec3(keWindDir.x,0.,keWindDir.y);float gust=kfGust(wp.xz);
 vec3 force=uGravity+uInertia+wd*(keWindStrength*uWindResponse*(.3+gust+.25*sin(keTime*4.3+dot(wp.xyz,vec3(3.1,1.7,2.3)))));
 force-=wn*(min(dot(force,wn),0.)*.6);
 vec3 dir=normalize(wn+force*(h*uDroop));
 vec3 p=wp.xyz+dir*(uLength*aShell.y*h);
 vec3 lp=position*sc;
 vCoord=lp*uDensity+vec3(sin(h*5.1+lp.y*37.),cos(h*4.3+lp.x*31.),sin(h*3.7+lp.z*29.))*(uCurl*h*.012);
 vH=h;vShell=aShell.x;
#ifdef USE_FUR_MAP
 vFurUv=uv;
#endif
 vec4 mvPosition=viewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mvPosition;
 vViewPosition=-mvPosition.xyz;vNormal=normalize((viewMatrix*vec4(wn,0.)).xyz);vDirV=normalize((viewMatrix*vec4(dir,0.)).xyz);
 vec4 worldPosition=vec4(p,1.);vec3 transformedNormal=vNormal;
#include <shadowmap_vertex>
#include <fog_vertex>
}`;
const FUR_FS=`
#if __VERSION__>=300
precision highp sampler3D;
uniform sampler3D uStrands;
#endif
#include <common>
#include <packing>
#include <fog_pars_fragment>
#include <bsdfs>
#include <lights_pars_begin>
#include <shadowmap_pars_fragment>
${CSM_PARS}uniform vec3 uColor;uniform vec3 uTipColor;uniform float uThickness;uniform float uColorVar;uniform float uRim;uniform float uLengthVar;uniform float uUnder;
#ifdef USE_FUR_MAP
uniform sampler2D uFurMap;varying vec2 vFurUv;
#endif
varying vec3 vCoord;varying float vH;varying float vShell;varying vec3 vNormal;varying vec3 vViewPosition;varying vec3 vDirV;
vec4 kfStrand(vec3 p){
#if __VERSION__>=300
 return texture(uStrands,p);
#else
 vec3 q=p*12.;vec3 i=floor(q),f=fract(q);float best=9.;vec2 id=vec2(0.);
 for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec3 g=vec3(float(x),float(y),float(z));vec3 o=keHash33(i+g);vec3 d=g+o-f;float dd=dot(d,d);if(dd<best){best=dd;id=o.xy;}}
 return vec4(clamp(1.-sqrt(best)/.72,0.,1.),id,1.);
#endif
}
void main(){
 vec4 s=kfStrand(vCoord);float h=vH,len=1.-uLengthVar*s.g;
 vec3 V=normalize(vViewPosition),N=normalize(vNormal);float ndv=abs(dot(N,V));
 if(vShell>.5){
  float under=0.;
  if(h<uUnder){vec4 s2=kfStrand(vCoord*2.63+vec3(.37,.11,.71));under=step(1.-uThickness*1.25*(1.-h/uUnder),s2.r);}
  if(h>len&&under<.5)discard;
  float rad=uThickness*(1.-h/max(len,1e-3))*mix(1.55,1.,ndv);
  if(s.r<1.-rad&&under<.5)discard;
 }
 vec3 base=uColor*(1.+(s.b-.5)*2.*uColorVar);
#ifdef USE_FUR_MAP
 base*=texture2D(uFurMap,vFurUv).rgb;
#endif
 vec3 albedo=mix(base,uTipColor*(1.+(s.b-.5)*uColorVar),smoothstep(.5,1.,h/len));
 float ao=mix(.3,1.,pow(clamp(h,0.,1.),.75));
 vec3 T=normalize(vDirV),direct=vec3(0.),spec=vec3(0.);float ndl;
${dirLightLoop('ndl=dot(N,dl.direction);direct+=lc*saturate((ndl+.5)/1.5);spec+=lc*(pow(sqrt(max(0.,1.-pow(dot(T,normalize(dl.direction+V)),2.))),70.)*.09*h*saturate(ndl+.3));')}
#if NUM_POINT_LIGHTS>0
 PointLight pl;vec3 pv;float pd;
#pragma unroll_loop_start
 for(int i=0;i<NUM_POINT_LIGHTS;i++){
  pl=pointLights[i];pv=pl.position+vViewPosition;pd=length(pv);
  direct+=pl.color*punctualLightIntensityToIrradianceFactor(pd,pl.distance,pl.decay)*saturate((dot(N,pv/pd)+.5)/1.5);
 }
#pragma unroll_loop_end
#endif
 GeometricContext gc;gc.position=-vViewPosition;gc.normal=N;gc.viewDir=V;
 vec3 amb=ambientLightColor+getLightProbeIrradiance(lightProbe,gc)/PI;
#if NUM_HEMI_LIGHTS>0
#pragma unroll_loop_start
 for(int i=0;i<NUM_HEMI_LIGHTS;i++){
  amb+=mix(hemisphereLights[i].groundColor,hemisphereLights[i].skyColor,dot(N,hemisphereLights[i].direction)*.5+.5);
 }
#pragma unroll_loop_end
#endif
 float rim=pow(1.-ndv,3.)*uRim*h;
 vec3 col=albedo*((direct+amb)*ao+(direct*.5+amb)*rim)+spec;
 gl_FragColor=vec4(col,1.);
#include <tonemapping_fragment>
#include <encodings_fragment>
#include <fog_fragment>
}`;
/* Shell-texture fur over every mesh of an object (a Group of spheres works). Each source mesh gets a
   child Mesh whose InstancedBufferGeometry shares the source vertex buffers and draws N shells in one
   instanced call; shell 0 is an opaque undercoat, the rest are alpha-tested strands. */
KE.fur=(THREE,target,o={})=>{
  const U=foliageUniforms(THREE),MAX=64,maxShells=clamp(Math.round(o.shells||16),2,MAX),lod=Object.assign({maxDistance:12},o.lod||{});
  if(o.renderer&&!o.renderer.capabilities.isWebGL2)return {available:false,object:target,meshes:[],update(){},setShells(){},dispose(){}};
  const tex=strandTexture(THREE),cells=tex.userData.cells,density=o.density!==undefined?o.density:900;
  /* per-mesh instanced attribute: (shell index, length multiplier) */
  const shellAttr=scale=>{const a=new Float32Array(MAX*2);for(let i=0;i<MAX;i++){a[i*2]=i;a[i*2+1]=scale;}return new THREE.InstancedBufferAttribute(a,2);};
  const g=o.gravity||[0,-1,0],gravity=Array.isArray(g)?new THREE.Vector3(g[0],g[1],g[2]):new THREE.Vector3(g.x,g.y,g.z);
  const inertia=new THREE.Vector3(),inertiaVel=new THREE.Vector3(),tmp=new THREE.Vector3();
  const common={uShells:{value:maxShells},uLength:{value:o.length!==undefined?o.length:.06},uDensity:{value:Math.sqrt(density)/cells},uDroop:{value:o.droop!==undefined?o.droop:.45},
    uWindResponse:{value:o.windResponse!==undefined?o.windResponse:.3},uCurl:{value:o.curl!==undefined?o.curl:.5},uGravity:{value:gravity},uInertia:{value:inertia},
    uThickness:{value:o.thickness!==undefined?o.thickness:.6},uColorVar:{value:o.colorVariation!==undefined?o.colorVariation:.2},uRim:{value:o.rim!==undefined?o.rim:.6},
    uLengthVar:{value:o.lengthVariation!==undefined?o.lengthVariation:.35},uUnder:{value:o.undercoat!==undefined?o.undercoat:.45},uStrands:{value:tex}};
  const include=o.include||(m=>true),materials=new Map(),meshes=[];let shells=maxShells,current=maxShells;
  const makeMaterial=src=>{
    const base=o.color!=null?srgb(THREE,o.color,0xffffff):(src&&src.color?src.color.clone():new THREE.Color(1,1,1));
    const tip=o.tipColor!=null?srgb(THREE,o.tipColor,0xffffff):base.clone().lerp(new THREE.Color(1,.95,.86).multiplyScalar(base.r*.3+base.g*.59+base.b*.11),.35).multiplyScalar(1.3);
    const uniforms=THREE.UniformsUtils.merge([THREE.UniformsLib.lights,THREE.UniformsLib.fog]);Object.assign(uniforms,sharedRefs(U),common,{uColor:{value:base},uTipColor:{value:tip}});
    const defines={};if(o.map){defines.USE_FUR_MAP='';uniforms.uFurMap={value:o.map};}
    return new THREE.ShaderMaterial({uniforms,defines,vertexShader:NOISE_GLSL()+WIND_UNIFORMS+GUST_GLSL+FUR_VS,fragmentShader:NOISE_GLSL()+FUR_FS,lights:true,fog:true});};
  const rootPos=new THREE.Vector3();
  const lodBeforeRender=(renderer,scene,camera,geometry,material)=>{
    rootPos.setFromMatrixPosition(target.matrixWorld);const d=rootPos.distanceTo(camera.position),md=lod.maxDistance;
    const n=d>=md?0:d<md*.35?shells:Math.max(Math.min(4,shells),Math.round(shells*(1-.75*(d-md*.35)/(md*.65))));
    geometry.instanceCount=n;if(n>0&&material.uniforms.uShells.value!==n){material.uniforms.uShells.value=n;material.uniformsNeedUpdate=true;}current=n;};
  target.updateMatrixWorld(true);
  target.traverse(m=>{if(!m.isMesh||m.isInstancedMesh||m.userData.keFurShell||!m.geometry||!m.geometry.attributes.position||!m.geometry.attributes.normal)return;
    /* include(mesh): false skips the mesh, true furs it, a number furs it with that length multiplier */
    const inc=include(m),lenScale=typeof inc==='number'?inc:(inc?1:0);if(!(lenScale>0))return;
    const src=m.geometry,mat0=Array.isArray(m.material)?m.material[0]:m.material;let mat=materials.get(mat0);if(!mat){mat=makeMaterial(mat0);mat.uniforms.uShells=Object.assign({},common.uShells);materials.set(mat0,mat);}
    const geo=new THREE.InstancedBufferGeometry();geo.index=src.index;for(const k of ['position','normal','uv'])if(src.attributes[k])geo.setAttribute(k,src.attributes[k]);geo.setAttribute('aShell',shellAttr(lenScale));geo.instanceCount=shells;
    if(!src.boundingSphere)src.computeBoundingSphere();const e=m.matrixWorld.elements,minScale=Math.max(1e-3,Math.min(Math.hypot(e[0],e[1],e[2]),Math.hypot(e[4],e[5],e[6]),Math.hypot(e[8],e[9],e[10])));
    geo.boundingSphere=src.boundingSphere.clone();geo.boundingSphere.radius+=common.uLength.value*lenScale*2/minScale;
    const shell=new THREE.Mesh(geo,mat);shell.userData.keFurShell=true;shell.castShadow=false;shell.receiveShadow=true;shell.raycast=()=>{};shell.onBeforeRender=lodBeforeRender;shell.name='ke-fur-shells';
    m.add(shell);meshes.push(shell);});
  const apply=()=>{const on=KE.settings.fur!==false;for(const s of meshes)s.visible=on;};apply();
  const off=KE.events&&KE.events.on?KE.events.on('settings',apply):null;
  let shadowSource=o.shadows||KE.foliage.shadowSource||null;const syncShadows=()=>{for(const m of materials.values())syncShadowSource(m,shadowSource);};syncShadows();
  const api={available:true,object:target,meshes,materials:[...materials.values()],
    /* Bind a KE.CascadedShadows instance so fur receives every cascade (null unbinds). */
    setShadowSource(csm){shadowSource=csm||null;syncShadows();return api;},
    get shells(){return shells;},get renderedShells(){return KE.settings.fur===false?0:current;},
    /* velocity: world-space velocity of the furry object (fur trails behind it with a damped spring) */
    update(dt=0,velocity=null){apply();syncShadows();dt=clamp(dt,0,.1);if(!dt)return;
      if(velocity)tmp.set(velocity.x||0,velocity.y||0,velocity.z||0).multiplyScalar(-.18*(o.inertia!==undefined?o.inertia:1));else tmp.set(0,0,0);
      if(tmp.lengthSq()>1.44)tmp.setLength(1.2);
      inertiaVel.x+=((tmp.x-inertia.x)*60-inertiaVel.x*9)*dt;inertiaVel.y+=((tmp.y-inertia.y)*60-inertiaVel.y*9)*dt;inertiaVel.z+=((tmp.z-inertia.z)*60-inertiaVel.z*9)*dt;inertia.addScaledVector(inertiaVel,dt);},
    setShells(n){shells=clamp(Math.round(n),0,MAX);for(const s of meshes)s.geometry.instanceCount=shells;for(const m of materials.values())m.uniforms.uShells.value=Math.max(1,shells);current=shells;return shells;},
    dispose(){liveSystems.delete(api);if(off)off();for(const s of meshes){if(s.parent)s.parent.remove(s);const g=s.geometry;/* detach shared source buffers so disposing frees only our own */for(const k of ['position','normal','uv'])g.deleteAttribute(k);g.index=null;g.dispose();}
      for(const m of materials.values())m.dispose();materials.clear();meshes.length=0;releaseStrands();}};
  liveSystems.add(api);return api;
};

/* ---------- foliage spawner ---------- */
/* Bridson Poisson-disc sampling in a rectangle; deterministic for a given random generator. */
function poissonDisc(r,minX,minZ,w,d,rad,limit){
  const cs=rad/Math.SQRT2,gw=Math.max(1,Math.ceil(w/cs)),gd=Math.max(1,Math.ceil(d/cs)),grid=new Int32Array(gw*gd).fill(-1),pts=[],active=[];
  const put=(x,z)=>{const i=pts.length/2;pts.push(x,z);active.push(i);grid[Math.min(gd-1,Math.floor((z-minZ)/cs))*gw+Math.min(gw-1,Math.floor((x-minX)/cs))]=i;};
  put(minX+r()*w,minZ+r()*d);
  while(active.length&&pts.length/2<limit){const ai=Math.floor(r()*active.length),i=active[ai],px=pts[i*2],pz=pts[i*2+1];let found=false;
    for(let k=0;k<20;k++){const a=r()*TAU,rr=rad*(1+r()),x=px+Math.cos(a)*rr,z=pz+Math.sin(a)*rr;if(x<minX||z<minZ||x>=minX+w||z>=minZ+d)continue;
      const gx=Math.floor((x-minX)/cs),gz=Math.floor((z-minZ)/cs);let ok=true;
      for(let dz=-2;dz<=2&&ok;dz++)for(let dx=-2;dx<=2;dx++){const nx=gx+dx,nz=gz+dz;if(nx<0||nz<0||nx>=gw||nz>=gd)continue;const j=grid[nz*gw+nx];if(j<0)continue;const ex=pts[j*2]-x,ez=pts[j*2+1]-z;if(ex*ex+ez*ez<rad*rad){ok=false;break;}}
      if(ok){put(x,z);found=true;break;}}
    if(!found){active[ai]=active[active.length-1];active.pop();}}
  return pts;
}
function normBounds(b){if(!b)return {minX:-50,minZ:-50,maxX:50,maxZ:50};if(b.min&&b.max)return {minX:b.min.x,minZ:b.min.z!==undefined?b.min.z:b.min.y,maxX:b.max.x,maxZ:b.max.z!==undefined?b.max.z:b.max.y};
  if(b.minX!==undefined)return {minX:b.minX,minZ:b.minZ,maxX:b.maxX,maxZ:b.maxZ};const c=b.center||[0,0],cx=Array.isArray(c)?c[0]:c.x,cz=Array.isArray(c)?c[1]:(c.z!==undefined?c.z:c.y),s=b.size||100,sx=Array.isArray(s)?s[0]:s,sz=Array.isArray(s)?s[1]:s;
  return {minX:cx-sx/2,minZ:cz-sz/2,maxX:cx+sx/2,maxZ:cz+sz/2};}
function typeParts(geometry,material){
  if(geometry&&geometry.isBufferGeometry)return [{geometry,material:material&&!material.isMaterial&&!Array.isArray(material)?Object.values(material)[0]:material,name:'main'}];
  /* {trunk, leaves} (or a whole KE.treeGeometry result): every BufferGeometry-valued key is one part */
  const parts=[];for(const k of Object.keys(geometry||{})){if(!geometry[k]||!geometry[k].isBufferGeometry)continue;parts.push({name:k,geometry:geometry[k],material:material&&material.isMaterial?material:material&&material[k]});}return parts;}
/* Deterministic Poisson-disc placement of instanced plants, bucketed into square cells. Each frame
   update(camera) classifies cells by distance (and optionally frustum); instance buffers are rebuilt
   only when that classification changes. Uses KE.InstancedLOD when present and opts.useInstancedLOD. */
KE.FoliageSpawner=class{
  constructor(THREE,scene,o={}){
    this.THREE=THREE;this.scene=scene;const B=normBounds(o.bounds),cell=this.cellSize=Math.max(1,o.cellSize||16),seed=o.seed===undefined?1:o.seed;this.bounds=B;
    const heightAt=o.heightAt||(()=>0),normalAt=o.normalAt||null,lodScale=clamp(KE.settings.lod||1,.25,2),view=(KE.settings.view||120);
    this.cols=Math.max(1,Math.ceil((B.maxX-B.minX)/cell));this.rows=Math.max(1,Math.ceil((B.maxZ-B.minZ)/cell));const nCells=this.cols*this.rows;this.frustumCull=o.frustumCull!==false;
    const occ=new Map(),occCell=4,occKey=(x,z)=>Math.floor(x/occCell)*73856093^Math.floor(z/occCell)*19349663,occupied=(x,z,rad,maxR)=>{const reach=rad+maxR,c0=Math.floor((x-reach)/occCell),c1=Math.floor((x+reach)/occCell),r0=Math.floor((z-reach)/occCell),r1=Math.floor((z+reach)/occCell);
      for(let cz=r0;cz<=r1;cz++)for(let cx=c0;cx<=c1;cx++){const list=occ.get(cx*73856093^cz*19349663);if(!list)continue;for(let i=0;i<list.length;i+=3){const dx=list[i]-x,dz=list[i+1]-z,rr=list[i+2]+rad;if(dx*dx+dz*dz<rr*rr)return true;}}return false;};
    let maxR=0;const nrm=[0,1,0],q=new THREE.Quaternion(),qa=new THREE.Quaternion(),qy=new THREE.Quaternion(),up=new THREE.Vector3(0,1,0),nv=new THREE.Vector3(),pos=new THREE.Vector3(),scl=new THREE.Vector3(),mtx=new THREE.Matrix4(),col=new THREE.Color();
    this.groups=[];this.count=0;this.cellState=new Uint8Array(nCells);this.cellBoxes=[];
    for(let c=0;c<nCells;c++)this.cellBoxes.push(new THREE.Box3(new THREE.Vector3(B.minX+(c%this.cols)*cell,1e9,B.minZ+Math.floor(c/this.cols)*cell),new THREE.Vector3(B.minX+(c%this.cols+1)*cell,-1e9,B.minZ+(Math.floor(c/this.cols)+1)*cell)));
    (o.types||[]).forEach((type,ti)=>{
      const r=KE.random((seed*131+ti*7919)>>>0),spacing=Math.max(.2,type.spacing||3),excl=type.exclusion!==undefined?type.exclusion:spacing*.5,sc=type.scale||[1,1],maxSlope=(type.maxSlope!==undefined?type.maxSlope:40)*Math.PI/180,align=clamp(type.alignToNormal||0,0,1);
      const parts=typeParts(type.geometry,type.material);if(!parts.length)return;
      let hgt=0;for(const p of parts){if(!p.geometry.boundingBox)p.geometry.computeBoundingBox();hgt=Math.max(hgt,p.geometry.boundingBox.max.y);}
      const pts=poissonDisc(r,B.minX,B.minZ,B.maxX-B.minX,B.maxZ-B.minZ,spacing,type.maxCount||200000),acc=[];
      for(let i=0;i<pts.length;i+=2){const x=pts[i],z=pts[i+1],dens=type.density?clamp(type.density(x,z),0,1):1;if(r()>=dens)continue;
        if(normalAt){const n=normalAt(x,z);nrm[0]=n.x!==undefined?n.x:n[0];nrm[1]=n.y!==undefined?n.y:n[1];nrm[2]=n.z!==undefined?n.z:n[2];}
        else{const e=.5,hx=heightAt(x+e,z)-heightAt(x-e,z),hz=heightAt(x,z+e)-heightAt(x,z-e),l=Math.hypot(hx,2*e,hz);nrm[0]=-hx/l;nrm[1]=2*e/l;nrm[2]=-hz/l;}
        if(Math.acos(clamp(nrm[1],-1,1))>maxSlope)continue;if(type.avoidOthers!==false&&occupied(x,z,excl,maxR))continue;
        const s=lerp(sc[0],sc[1],r()),yaw=r()*TAU,y=heightAt(x,z)-(type.sink!==undefined?type.sink:.05)*s;
        nv.set(nrm[0],nrm[1],nrm[2]).normalize();qa.setFromUnitVectors(up,nv);q.identity().slerp(qa,align);qy.setFromAxisAngle(up,yaw);q.multiply(qy);
        pos.set(x,y,z);scl.set(s,s,s);mtx.compose(pos,q,scl);const tint=type.tint!==undefined?type.tint:.1;
        acc.push({cell:clamp(Math.floor((z-B.minZ)/cell),0,this.rows-1)*this.cols+clamp(Math.floor((x-B.minX)/cell),0,this.cols-1),m:mtx.toArray(),c:[1+(r()-.5)*tint*2,1+(r()-.5)*tint*2,1+(r()-.5)*tint*1.6]});
        const k=occKey(x,z);let list=occ.get(k);if(!list)occ.set(k,list=[]);list.push(x,z,excl);}
      maxR=Math.max(maxR,excl);acc.sort((a,b)=>a.cell-b.cell);
      const n=acc.length,mats=new Float32Array(n*16),cols=new Float32Array(n*3),start=new Int32Array(nCells),cnt=new Int32Array(nCells);
      acc.forEach((it,i)=>{mats.set(it.m,i*16);cols.set(it.c,i*3);cnt[it.cell]++;const b=this.cellBoxes[it.cell];b.min.y=Math.min(b.min.y,it.m[13]);b.max.y=Math.max(b.max.y,it.m[13]+hgt*Math.hypot(it.m[4],it.m[5],it.m[6]));});
      for(let c=1;c<nCells;c++)start[c]=start[c-1]+cnt[c-1];
      const dists=(type.lodDistances&&type.lodDistances.length?type.lodDistances:[Math.min(view,(o.maxDistance||view))*.9*lodScale]).map(d=>d*(type.lodDistances?lodScale:1));
      const levelParts=[parts];for(const l of type.lods||[])levelParts.push(typeParts(l.geometry,l.material));
      /* Optional hand-off to a shared instanced-LOD system (KE.InstancedLOD, when a later module provides
         one and opts.instancedLOD !== false). Contract: new KE.InstancedLOD(THREE, scene, {name, matrices,
         colors, count, levels:[{distance, parts:[{geometry, material, customDepthMaterial}]}], castShadow})
         returning an object with update(camera) and dispose(). Any failure falls back to the built-in path. */
      if(o.instancedLOD!==false&&typeof KE.InstancedLOD==='function'&&n>0){
        try{const lod=new KE.InstancedLOD(THREE,scene,{name:type.name||'type'+ti,matrices:mats,colors:cols,count:n,castShadow:type.castShadow!==false,
            levels:dists.map((distance,li)=>({distance,parts:levelParts[Math.min(li,levelParts.length-1)].map(p=>({geometry:p.geometry,material:p.material,customDepthMaterial:p.material&&p.material.userData&&p.material.userData.keFoliage?KE.foliageDepthMaterial(p.material):null}))}))});
          if(lod&&typeof lod.update==='function'){this.groups.push({name:type.name||'type'+ti,count:n,height:hgt,matrices:mats,colors:cols,start,cnt,levels:[{distance:dists[dists.length-1],meshes:[]}],meshes:[],external:lod});this.count+=n;return;}}
        catch(e){/* fall through to the built-in cell LOD */}}
      const levels=dists.map((dist,li)=>{const lp=levelParts[Math.min(li,levelParts.length-1)];
        return {distance:dist,meshes:lp.map(p=>{const im=new THREE.InstancedMesh(p.geometry,p.material,Math.max(1,n));im.count=0;im.frustumCulled=false;im.castShadow=type.castShadow!==false;im.receiveShadow=true;
          im.instanceColor=new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1,n)*3),3);im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);im.name='ke-foliage-'+(type.name||ti)+'-'+p.name+'-lod'+li;
          if(p.material&&p.material.userData&&p.material.userData.keFoliage){im.customDepthMaterial=KE.foliageDepthMaterial(p.material);}
          if(scene)scene.add(im);return im;})};});
      this.groups.push({name:type.name||'type'+ti,count:n,height:hgt,matrices:mats,colors:cols,start,cnt,levels,meshes:levels.flatMap(l=>l.meshes)});this.count+=n;});
    this.maxDistance=Math.max(0,...this.groups.map(g=>g.levels[g.levels.length-1].distance));
    /* cells are frustum-tested with a margin so trees just outside the view still cast their shadows in */
    this.cullMargin=o.cullMargin!==undefined?o.cullMargin:Math.max(6,...this.groups.map(g=>g.height*1.5));this._box=new THREE.Box3();
    this.backend=this.groups.some(g=>g.external)?'InstancedLOD':'cells';
    this._frustum=new THREE.Frustum();this._proj=new THREE.Matrix4();this._prev=new Uint8Array(nCells*Math.max(1,this.groups.length));this._cur=new Uint8Array(this._prev.length);this._first=true;this.rebuilds=0;
  }
  /* Returns true when instance buffers were rebuilt this call. */
  update(camera){
    if(!camera)return false;const e=camera.matrixWorld.elements,cx=e[12],cz=e[14],B=this.bounds,cs=this.cellSize,nC=this.cols*this.rows;
    if(this.frustumCull){this._proj.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this._frustum.setFromProjectionMatrix(this._proj);}
    let changed=this._first;
    for(let gi=0;gi<this.groups.length;gi++){const g=this.groups[gi],L=g.levels;if(g.external){g.external.update(camera);continue;}
      for(let c=0;c<nC;c++){let st=0;if(g.cnt[c]){const x0=B.minX+(c%this.cols)*cs,z0=B.minZ+Math.floor(c/this.cols)*cs,dx=Math.max(0,x0-cx,cx-(x0+cs)),dz=Math.max(0,z0-cz,cz-(z0+cs)),d=Math.sqrt(dx*dx+dz*dz);
          for(let li=0;li<L.length;li++)if(d<L[li].distance){st=li+1;break;}
          if(st&&this.frustumCull){const b=this.cellBoxes[c];if(b.max.y>=b.min.y&&!this._frustum.intersectsBox(this._box.copy(b).expandByScalar(this.cullMargin)))st=0;}}
        const k=gi*nC+c;this._cur[k]=st;if(st!==this._prev[k])changed=true;}}
    if(!changed)return false;this._first=false;this._prev.set(this._cur);this.rebuilds++;
    for(let gi=0;gi<this.groups.length;gi++){const g=this.groups[gi];if(g.external)continue;
      for(let li=0;li<g.levels.length;li++){let n=0;const meshes=g.levels[li].meshes,ma=meshes.length?meshes[0].instanceMatrix.array:null;if(!ma)continue;const ca=meshes[0].instanceColor.array;
        for(let c=0;c<nC;c++){if(this._cur[gi*nC+c]!==li+1)continue;const s=g.start[c],k=g.cnt[c];
          for(let i=0;i<k*16;i++)ma[n*16+i]=g.matrices[s*16+i];for(let i=0;i<k*3;i++)ca[n*3+i]=g.colors[s*3+i];n+=k;}
        for(let m=0;m<meshes.length;m++){const im=meshes[m];if(m>0){im.instanceMatrix.array.set(ma.subarray(0,n*16));im.instanceColor.array.set(ca.subarray(0,n*3));}
          im.count=n;im.instanceMatrix.updateRange.offset=0;im.instanceMatrix.updateRange.count=n*16;im.instanceMatrix.needsUpdate=true;im.instanceColor.updateRange.offset=0;im.instanceColor.updateRange.count=n*3;im.instanceColor.needsUpdate=true;im.visible=n>0;}}}
    return true;}
  /* Instances visible after the last update (sum over types and LOD levels). */
  get visibleCount(){let n=0;for(const g of this.groups)for(const l of g.levels)n+=l.meshes.length?l.meshes[0].count:0;return n;}
  /* Removes and frees the instanced meshes (instance buffers). Geometries and materials belong to the caller. */
  dispose(){for(const g of this.groups){if(g.external&&g.external.dispose)g.external.dispose();for(const m of g.meshes){if(m.parent)m.parent.remove(m);m.dispose();}}this.groups.length=0;this.count=0;}
};

/* ---------- per-frame driver ---------- */
KE.foliage={
  MAX_INTERACTORS,
  get uniforms(){return foliageUniforms(window.THREE);},
  species:SPECIES,
  /* Advance wind time (also KE.windUniforms.uTime for core KE.wind users) and set wind/interactors.
     interactors: up to 8 of Vector3 (radius .5) or {position, radius}. No allocations. */
  update(dt=0,o={}){const U=foliageUniforms(window.THREE);if(!U)return;dt=Number.isFinite(dt)?clamp(dt,0,.25):0;U.keTime.value+=dt;
    if(KE.windUniforms&&KE.windUniforms.uTime)KE.windUniforms.uTime.value+=dt;
    if(o){if(Number.isFinite(o.wind)){U.keWindStrength.value=Math.max(0,o.wind);if(KE.windUniforms&&KE.windUniforms.uWind)KE.windUniforms.uWind.value=U.keWindStrength.value;}
      if(o.windDir!==undefined)setWindDir(U.keWindDir.value,o.windDir);if(Number.isFinite(o.gustScale))U.keGustScale.value=Math.max(0,o.gustScale);
      const list=o.interactors;if(list){let n=0;for(let i=0;i<list.length&&n<MAX_INTERACTORS;i++){const it=list[i];if(!it)continue;const p=it.position||it;if(!Number.isFinite(p.x)||!Number.isFinite(p.y)||!Number.isFinite(p.z))continue;
        U.keInteractors.value[n].set(p.x,p.y,p.z,it.radius!==undefined?it.radius:.5);n++;}U.keInteractorCount.value=n;}}},
  /* Default KE.CascadedShadows for grass and fur created later; also rebinds every live grass/fur system. */
  shadowSource:null,
  setShadowSource(csm){this.shadowSource=csm||null;for(const s of liveSystems)s.setShadowSource(this.shadowSource);return this;},
  /* Add hierarchical wind (and matching shadow materials via attach/foliageDepthMaterial) to an existing
     lit material, chaining its current onBeforeCompile. Geometry should carry windWeight
     (see addWindWeights); pass {windAttribute:false, height} to derive weights from object-space height. */
  applyWind(THREE,material,o={}){
    if(!material||!material.isMaterial)throw new TypeError('KE.foliage.applyWind expects a material');if(material.userData.keFoliage)return material;foliageUniforms(THREE);
    const wind=Object.assign({trunk:.02,branch:.06,leaf:.12},o.wind||{}),physical=!!material.isMeshStandardMaterial,translucency=physical&&o.translucency?o.translucency:0;
    const uniforms={kfWindAmp:{value:new THREE.Vector3(wind.trunk,wind.branch,wind.leaf)},kfRefHeight:{value:Math.max(1e-3,o.height||1)},kfTranslucency:{value:translucency},
      kfTransColor:{value:srgb(THREE,o.translucencyColor,0xd2e67a)},kfNormalsUp:{value:0},kfMapSize:{value:material.map&&material.map.image?Math.max(material.map.image.width||256,material.map.image.height||256):256},kfAlphaMip:{value:o.alphaMip!==undefined?o.alphaMip:.25},kfEdgeFade:{value:o.edgeFade!==undefined?o.edgeFade:0}};
    const cfg={THREE,uniforms,wind,depth:null,distance:null,flags:{attr:o.windAttribute!==false,trans:translucency>0,unflip:false,alpha:material.alphaTest>0&&!!material.map,up:false}};
    material.userData.keFoliage=cfg;material.defaultAttributeValues=Object.assign({windWeight:[0,0,0,0],color:[1,1,1],uv:[0,0]},material.defaultAttributeValues||{});
    installHook(THREE,material,cfg,'main');material.needsUpdate=true;return material;},
  /* Give a mesh using a foliage/bark material matching shadow materials. */
  attach(mesh){const m=Array.isArray(mesh.material)?mesh.material[0]:mesh.material;if(m&&m.userData.keFoliage){mesh.customDepthMaterial=KE.foliageDepthMaterial(m);mesh.customDistanceMaterial=KE.foliageDepthMaterial(m,{distance:true});}return mesh;},
  /* Add a windWeight attribute to any geometry (height-based), so KE.foliageMaterial sways it. */
  addWindWeights(THREE,geometry,{height=null,flutter=1,phase=0}={}){const p=geometry.attributes.position;if(!geometry.boundingBox)geometry.computeBoundingBox();const bb=geometry.boundingBox,H=height||Math.max(1e-3,bb.max.y-Math.min(0,bb.min.y));
    const w=new Float32Array(p.count*4);for(let i=0;i<p.count;i++){const y=clamp(p.getY(i)/H,0,1),rad=Math.hypot(p.getX(i),p.getZ(i))/H;w[i*4]=y;w[i*4+1]=clamp(y*.6+rad,0,1);w[i*4+2]=y*flutter;w[i*4+3]=phase;}
    geometry.setAttribute('windWeight',new THREE.BufferAttribute(w,4));return geometry;},
  glsl:{gust:GUST_GLSL,treeWind:TREE_WIND_GLSL}
};

KE.registerModule('foliage',{provides:['foliageUniforms','foliage','foliageMaterial','foliageDepthMaterial','treeGeometry','tree','TREE_SPECIES','leafTexture','barkTexture','barkMaterial','grassField','fur','FoliageSpawner']});
})();
