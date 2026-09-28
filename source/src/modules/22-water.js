/* KE.Water — ocean/lake surface in the spirit of a single-layer water shading model.
   Geometry: a camera-following radial grid (dense near the viewer, geometric ring growth outward) displaced
   by a sum of Gerstner waves generated from wind parameters, with analytic normals and a folding (Jacobian)
   term for crest foam. Shading: Schlick Fresnel between reflection (screen-space reflections via
   KE.GLSL.ssr, falling back to the sky cube map) and refraction of the opaque scene copy published by
   KE.Pipeline, with Beer-Lambert absorption along the refracted path, in-scattering colour, animated
   caustics on the submerged ground, shoreline and crest foam, a GGX-like sun glint, subsurface glow through
   thin crests and optional rain ripples. The same Gerstner sum runs on the CPU (heightAt/normalAt) for
   buoyancy and swimming. Without a pipeline the surface alpha-blends and uses an optional baked depth map. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const MAXW=8,G=9.81;

/* Deterministic wave set from wind: wavelengths spread around a dominant length, directions within a cone. */
KE.waterWaves=({wind=[1,.35],wavelength=7,amplitude=.12,choppiness=.8,count=6,spread=.9,seed=3}={})=>{
  const r=KE.random(seed),wl=Math.hypot(wind[0],wind[1])||1,wx=wind[0]/wl,wz=wind[1]/wl,out=[];
  for(let i=0;i<count;i++){const L=wavelength*Math.pow(.62,i)*(1+(r()-.5)*.25),a=Math.atan2(wz,wx)+(r()-.5)*2*spread*(i===0?.35:1),k=2*Math.PI/L;
    const A=amplitude*Math.pow(.66,i)*(.8+r()*.4),Q=Math.min(choppiness/(k*A*count+1e-6),1);out.push({dir:[Math.cos(a),Math.sin(a)],k,amplitude:A,steepness:Q,omega:Math.sqrt(G*k),phase:r()*Math.PI*2});}
  return out;};

function radialGrid(THREE,rings,segs,r0,rMax){const g=Math.pow(rMax/r0,1/(rings-1)),pos=[0,0,0],idx=[];
  for(let i=0;i<rings;i++){const r=r0*Math.pow(g,i);for(let j=0;j<segs;j++){const a=j/segs*Math.PI*2;pos.push(Math.cos(a)*r,0,Math.sin(a)*r);}}
  for(let j=0;j<segs;j++)idx.push(0,1+(j+1)%segs,1+j);
  for(let i=0;i<rings-1;i++)for(let j=0;j<segs;j++){const a=1+i*segs+j,b=1+i*segs+(j+1)%segs,c=a+segs,d=b+segs;idx.push(a,b,c,b,d,c);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));geo.setIndex(idx);geo.boundingSphere=new THREE.Sphere(new THREE.Vector3(),rMax);return geo;}

function detailNormalTexture(THREE,S=256){const c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d'),d=g.createImageData(S,S),hf=(x,y)=>KE.tileNoise(x,y,S,8)*.6+KE.tileNoise(x+37,y+11,S,16)*.4;
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){const dx=hf(x+1,y)-hf(x-1,y),dy=hf(x,y+1)-hf(x,y-1),k=(y*S+x)*4;d.data[k]=128-dx*420;d.data[k+1]=128-dy*420;d.data[k+2]=255;d.data[k+3]=255;}
  g.putImageData(d,0,0);const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=4;return t;}

const VS=`uniform float uTime;uniform vec4 uWaveA[${MAXW}];uniform vec4 uWaveB[${MAXW}];uniform float uFadeStart;uniform float uFadeEnd;
varying vec3 vWorld;varying vec3 vNormalW;varying float vJac;varying float vCrest;varying float vViewZ;
void main(){vec4 wp=modelMatrix*vec4(position,1.);vec2 x0=wp.xz;vec3 disp=vec3(0.),n=vec3(0.,1.,0.);float jac=1.;
 float fade=1.-smoothstep(uFadeStart,uFadeEnd,distance(x0,cameraPosition.xz));
 for(int i=0;i<WAVES;i++){vec4 a=uWaveA[i],b=uWaveB[i];float th=a.z*dot(a.xy,x0)-b.y*uTime+b.z;float c=cos(th),s=sin(th);float A=a.w*fade;
  disp.x+=b.x*A*a.x*c;disp.z+=b.x*A*a.y*c;disp.y+=A*s;n.x-=a.x*a.z*A*c;n.z-=a.y*a.z*A*c;n.y-=b.x*a.z*A*s;jac-=b.x*a.z*A*s;}
 wp.xyz+=disp;vWorld=wp.xyz;vNormalW=normalize(n);vJac=jac;vCrest=disp.y;vec4 mv=viewMatrix*wp;vViewZ=-mv.z;gl_Position=projectionMatrix*mv;}`;

const FS=`${KE.GLSL_SCENE_DECL}
uniform float uTime;uniform samplerCube tSky;uniform float uHasSky;uniform sampler2D tNormal;uniform sampler2D tBaked;uniform float uHasBaked;uniform vec4 uBakedRect;uniform float uLevel;
uniform vec3 uHorizon;uniform vec3 uZenith;uniform vec3 uScatter;uniform vec3 uAbsorb;uniform vec3 uFoamColor;uniform float uFoamDepth;uniform float uRefract;uniform float uDetail;uniform float uRain;uniform float uCaustics;uniform float uSunGlint;uniform float uUnder;uniform vec3 uAmbient;uniform float uOpacity;
varying vec3 vWorld;varying vec3 vNormalW;varying float vJac;varying float vCrest;varying float vViewZ;
${KE.GLSL.hash}
${KE.GLSL.ssr}
float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}
float voronoiEdge(vec2 p,float t){vec2 i=floor(p),f=fract(p);float d1=8.,d2=8.;for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 o=vec2(float(x),float(y));vec2 h=keHash22(i+o);h=.5+.45*sin(t+6.2831*h);float d=length(o+h-f);if(d<d1){d2=d1;d1=d;}else if(d<d2)d2=d;}return d2-d1;}
float caustic(vec2 p,float t){float a=voronoiEdge(p*1.1,t),b=voronoiEdge(p*1.9+vec2(3.7,1.3),t*1.3);return pow(1.-smoothstep(0.,.18,a),2.)*.65+pow(1.-smoothstep(0.,.14,b),2.)*.45;}
vec3 ripple(vec2 p,float t){vec3 n=vec3(0.);for(int k=0;k<3;k++){vec2 q=p*(1.6+float(k)*.7)+float(k)*7.3;vec2 i=floor(q),f=fract(q);float h=keHash12(i+float(k));float ph=fract(t*.9+h);vec2 c=.25+.5*keHash22(i+3.1);vec2 d=f-c;float r=length(d);float ring=sin((r-ph*.5)*55.)*smoothstep(.5*ph+.02,.5*ph-.06,r)*smoothstep(0.,.25,r)*(1.-ph);n.xz+=d/max(r,1e-3)*ring;}return n*.25;}
vec3 skyAt(vec3 d){if(uHasSky>.5)return textureCube(tSky,d).rgb;return mix(uHorizon,uZenith,clamp(d.y,0.,1.));}
void main(){vec3 V=normalize(cameraPosition-vWorld);float dist=length(cameraPosition-vWorld);float detailFade=1.-smoothstep(25.,120.,dist);
 vec3 n1=texture2D(tNormal,vWorld.xz*.071+uTime*vec2(.021,.013)).xyz*2.-1.,n2=texture2D(tNormal,vWorld.xz*.19-uTime*vec2(.017,.031)).xyz*2.-1.;
 vec3 N=normalize(vNormalW+vec3(n1.x+n2.x,0.,n1.y+n2.y)*uDetail*detailFade);if(uRain>0.)N=normalize(N+ripple(vWorld.xz,uTime)*uRain*detailFade);
 bool below=!gl_FrontFacing;if(below)N=-N;float NdV=clamp(dot(N,V),0.,1.);float F=.02+.98*pow(1.-NdV,5.);vec3 sunI=keSunColor*max(keSunDirection.y,0.);
 if(below){vec3 Tr=refract(-V,N,1.333);vec3 above=dot(Tr,Tr)>0.?skyAt(Tr):uScatter*(uAmbient+sunI*.3)*1.5;vec3 tr=exp(-uAbsorb*dist*.35);vec3 col=above*tr+uScatter*(uAmbient+sunI*.35)*(1.-tr);
  gl_FragColor=vec4(col,1.);
  #include <tonemapping_fragment>
  #include <encodings_fragment>
  return;}
 vec3 R=reflect(-V,N);R.y=abs(R.y);vec3 refl=skyAt(R);
 vec2 suv=gl_FragCoord.xy/keResolution;float thick=4.;vec3 below3=uScatter;vec3 underPos=vWorld-vec3(0.,4.,0.);
 if(keHasScene>.5){float z0=texture2D(keSceneDepth,suv).r;vec2 ruv=suv+N.xz*uRefract*clamp((z0-vViewZ)*.35,0.,1.)/max(vViewZ*.15,1.);float z1=texture2D(keSceneDepth,ruv).r;if(z1<vViewZ){ruv=suv;z1=z0;}
  thick=max(z1-vViewZ,0.);below3=texture2D(keSceneColor,ruv).rgb;vec4 vr=keInvProjection*vec4(ruv*2.-1.,1.,1.);vec3 vray=vr.xyz/vr.w;vray/=-vray.z;underPos=(keInvView*vec4(vray*z1,1.)).xyz;
  vec3 vpos=(keViewMatrix*vec4(vWorld,1.)).xyz,vn=normalize((keViewMatrix*vec4(N,0.)).xyz);vec4 ssr=keTraceSSR(vpos,vn,.04,ign(gl_FragCoord.xy+keFrame));refl=mix(refl,ssr.rgb,ssr.a);}
 else if(uHasBaked>.5){vec2 buv=(vWorld.xz-uBakedRect.xy)/uBakedRect.zw;float g=texture2D(tBaked,vec2(buv.x,1.-buv.y)).r*48.-24.;float vd=max(uLevel-g,0.);thick=vd/max(V.y,.15);underPos=vec3(vWorld.x,g,vWorld.z);}
 float vdepth=max(vWorld.y-underPos.y,0.);
 vec3 transm=exp(-uAbsorb*thick);
 if(uCaustics>0.&&keHasScene>.5){float c=caustic(underPos.xz*.55,uTime*1.6)*exp(-vdepth*.45)*smoothstep(0.,.35,vdepth);below3+=below3*c*uCaustics*sunI*1.5;}
 vec3 inscatter=uScatter*(uAmbient+sunI*.35);vec3 refr=below3*transm+inscatter*(1.-transm);
 vec3 H=normalize(V+keSunDirection);float spec=pow(max(dot(N,H),0.),900.)*14.+pow(max(dot(N,H),0.),120.)*.35;vec3 glint=keSunColor*spec*uSunGlint;
 float sss=pow(max(dot(V,-keSunDirection),0.),4.)*clamp(vCrest*3.+.2,0.,1.)*.6;vec3 subsurface=uScatter*keSunColor*sss;
 float fn=texture2D(tNormal,vWorld.xz*.31+uTime*vec2(.011,.019)).r*.6+texture2D(tNormal,vWorld.xz*.83-uTime*vec2(.027,.013)).g*.4;fn=clamp((fn-.5)*2.5+.5,0.,1.);
 float hasDepth=keHasScene>.5||uHasBaked>.5?1.:0.;float band=hasDepth*(1.-smoothstep(0.,uFoamDepth,vdepth));float lines=hasDepth*smoothstep(.62,.95,sin(vdepth*16.-uTime*2.4+fn*2.5)*.5+.5)*(1.-smoothstep(0.,uFoamDepth*2.5,vdepth));
 float crest=smoothstep(.8,.4,vJac)*smoothstep(.45,.75,fn);float foam=clamp(band*smoothstep(.3,.7,fn+band*.45)+lines*smoothstep(.35,.6,fn)*.7+crest,0.,1.);
 vec3 col=mix(refr,refl,F)+glint+subsurface;col=mix(col,uFoamColor*(uAmbient+sunI*.8),foam*.85);
 float alpha=keHasScene>.5?1.:clamp(uOpacity*mix(1.,.8,exp(-thick*.8))+F*.3+foam,0.,1.);gl_FragColor=vec4(col,alpha);
 #include <tonemapping_fragment>
 #include <encodings_fragment>
}`;

KE.Water=class{
  constructor(THREE,scene,o={}){
    this.THREE=THREE;this.scene=scene;this.time=0;this.rain=0;this.underwater=false;
    this.options=Object.assign({level:0,rings:null,segments:null,radius:1600,waves:null,wind:[1,.35],wavelength:7,amplitude:.12,choppiness:.8,waveCount:6,fadeStart:120,fadeEnd:420,
      scatter:[.02,.16,.17],absorb:[.45,.09,.06],foamColor:[.85,.9,.9],foamDepth:.3,refraction:.035,detail:.35,sunGlint:1,caustics:1,sky:null,heightAt:null,bakedSize:160,bakedCenter:null,opacity:.9,
      horizon:[.55,.7,.8],zenith:[.2,.4,.7],underwaterFog:{density:.18,falloff:0,color:[.02,.12,.14],maxOpacity:1,start:0,inscatter:.4}},o);
    const q=KE.settings.preset,lo=q==='low',o2=this.options;this.waves=o2.waves||KE.waterWaves({wind:o2.wind,wavelength:o2.wavelength,amplitude:o2.amplitude,choppiness:o2.choppiness,count:o2.waveCount});
    const U=KE.sceneUniforms(THREE);this.normalTex=detailNormalTexture(THREE);
    this.uniforms={...U,uTime:{value:0},uWaveA:{value:Array.from({length:MAXW},()=>new THREE.Vector4())},uWaveB:{value:Array.from({length:MAXW},()=>new THREE.Vector4())},uFadeStart:{value:o2.fadeStart},uFadeEnd:{value:o2.fadeEnd},
      tSky:{value:null},uHasSky:{value:0},tNormal:{value:this.normalTex},tBaked:{value:null},uHasBaked:{value:0},uBakedRect:{value:new THREE.Vector4()},uLevel:{value:o2.level},
      uHorizon:{value:new THREE.Color(...o2.horizon)},uZenith:{value:new THREE.Color(...o2.zenith)},uScatter:{value:new THREE.Color(...o2.scatter)},uAbsorb:{value:new THREE.Vector3(...o2.absorb)},uFoamColor:{value:new THREE.Color(...o2.foamColor)},
      uFoamDepth:{value:o2.foamDepth},uRefract:{value:o2.refraction},uDetail:{value:o2.detail},uRain:{value:0},uCaustics:{value:lo?0:o2.caustics},uSunGlint:{value:o2.sunGlint},uUnder:{value:0},uAmbient:{value:new THREE.Color(.25,.3,.35)},uOpacity:{value:o2.opacity}};
    this.setWaves(this.waves);
    if(o2.heightAt)this.bakeDepth(o2.heightAt,o2.bakedCenter||new THREE.Vector3(),o2.bakedSize);
    this.material=new THREE.ShaderMaterial({vertexShader:VS,fragmentShader:FS,uniforms:this.uniforms,defines:{WAVES:this.waves.length},transparent:true,depthWrite:true,side:THREE.DoubleSide,toneMapped:true});
    this.material.extensions={derivatives:true};
    const rings=o2.rings||(lo?48:88),segs=o2.segments||(lo?96:176);this.mesh=new THREE.Mesh(radialGrid(THREE,rings,segs,.12,o2.radius),this.material);this.mesh.frustumCulled=false;this.mesh.name='ke-water';this.mesh.layers.set(KE.LAYERS.TRANSLUCENT);
    this.mesh.position.y=o2.level;scene.add(this.mesh);this._v=new THREE.Vector3();this._n=new THREE.Vector3();this._fogSaved=null;
    if(o2.sky)this.setSky(o2.sky);}
  setWaves(list){this.waves=list.slice(0,MAXW);const A=this.uniforms.uWaveA.value,B=this.uniforms.uWaveB.value;for(let i=0;i<MAXW;i++){const w=this.waves[i];if(w){A[i].set(w.dir[0],w.dir[1],w.k,w.amplitude);B[i].set(w.steepness,w.omega,w.phase,0);}else{A[i].set(1,0,0,0);B[i].set(0,0,0,0);}}
    if(this.material&&this.material.defines.WAVES!==this.waves.length){this.material.defines.WAVES=this.waves.length;this.material.needsUpdate=true;}return this;}
  /* Use a KE.SkyAtmosphere (or any cube texture) for reflections. */
  setSky(sky){const tex=sky&&sky.cube?sky.cube.texture:sky;this.sky=sky&&sky.cube?sky:null;this.uniforms.tSky.value=tex||null;this.uniforms.uHasSky.value=tex?1:0;return this;}
  /* Fallback shoreline data for rendering without KE.Pipeline (same encoding as the 2.x water: -24..24 range). */
  bakeDepth(heightAt,center,size,res=128){const T=this.THREE,b=new Uint8Array(res*res*4);for(let z=0;z<res;z++)for(let x=0;x<res;x++){const h=heightAt(center.x-size/2+x/(res-1)*size,center.z-size/2+z/(res-1)*size),k=(z*res+x)*4;b[k]=b[k+1]=b[k+2]=KE.clamp((h+24)/48*255,0,255);b[k+3]=255;}
    if(this.uniforms.tBaked.value)this.uniforms.tBaked.value.dispose();const t=new T.DataTexture(b,res,res,T.RGBAFormat);t.minFilter=t.magFilter=T.LinearFilter;t.needsUpdate=true;this.uniforms.tBaked.value=t;this.uniforms.uHasBaked.value=1;this.uniforms.uBakedRect.value.set(center.x-size/2,center.z-size/2,size,size);return this;}
  /* CPU Gerstner displacement of the undisplaced point (x0,z0). */
  displacement(x0,z0,t=this.time,out=this._v){let dx=0,dy=0,dz=0;for(const w of this.waves){const th=w.k*(w.dir[0]*x0+w.dir[1]*z0)-w.omega*t+w.phase,c=Math.cos(th),s=Math.sin(th);dx+=w.steepness*w.amplitude*w.dir[0]*c;dz+=w.steepness*w.amplitude*w.dir[1]*c;dy+=w.amplitude*s;}return out.set(dx,dy,dz);}
  /* Water surface height at world (x,z): fixed-point inversion of the horizontal Gerstner displacement. */
  heightAt(x,z,t=this.time){let x0=x,z0=z;for(let i=0;i<4;i++){const d=this.displacement(x0,z0,t);x0=x-d.x;z0=z-d.z;}return this.options.level+this.displacement(x0,z0,t).y;}
  normalAt(x,z,t=this.time,out=this._n){let nx=0,ny=1,nz=0;for(const w of this.waves){const th=w.k*(w.dir[0]*x+w.dir[1]*z)-w.omega*t+w.phase,c=Math.cos(th),s=Math.sin(th);nx-=w.dir[0]*w.k*w.amplitude*c;nz-=w.dir[1]*w.k*w.amplitude*c;ny-=w.steepness*w.k*w.amplitude*s;}return out.set(nx,ny,nz).normalize();}
  isUnderwater(camera){return camera.position.y<this.heightAt(camera.position.x,camera.position.z)-.02;}
  /* Advance time, follow the camera, drive ambient/sky and, while the camera is submerged, hold a pipeline's fog at
     the underwater settings (call after the game updates fog each frame; the previous fog returns on surfacing). */
  update(dt,camera,{pipeline=null,ambient=null}={}){this.time+=dt;const U=this.uniforms;U.uTime.value=this.time;U.uRain.value=this.rain;
    if(camera){const s=.5;this.mesh.position.set(Math.round(camera.position.x/s)*s,this.options.level,Math.round(camera.position.z/s)*s);}
    if(ambient)U.uAmbient.value.copy(ambient);else if(this.sky)U.uAmbient.value.copy(this.sky.zenithColor).lerp(this.sky.fogColor,.5);
    U.uCaustics.value=KE.settings.preset==='low'?0:this.options.caustics;
    const under=camera?this.isUnderwater(camera):false;
    if(pipeline){const f=pipeline.options.fog;if(under){if(!this._fogSaved)this._fogSaved={...f,color:f.color.clone()};const u=this.options.underwaterFog;Object.assign(f,{enabled:true,density:u.density,falloff:u.falloff,maxOpacity:u.maxOpacity,start:u.start,inscatter:u.inscatter});f.color.setRGB(...u.color);}
      else if(this._fogSaved){const saved=this._fogSaved,c=f.color;Object.assign(f,saved);f.color=c.copy(saved.color);this._fogSaved=null;}}
    this.underwater=under;U.uUnder.value=under?1:0;return this;}
  dispose(){this.mesh.parent&&this.mesh.parent.remove(this.mesh);this.mesh.geometry.dispose();this.material.dispose();this.normalTex.dispose();if(this.uniforms.tBaked.value)this.uniforms.tBaked.value.dispose();}
};
/* ---------- KE.River ----------
   A river as a ribbon along a centre line. KE.River.profile resamples the control points (Catmull-Rom, every `step`
   metres) and gives each sample a water surface height that stays below the ground and falls monotonically
   downstream (never below the sea), a width, a depth, the flow direction and a speed from the local slope.
   KE.River.carve cuts a parabolic bed, a low bank lip and valley walls of a set slope into a KE.Heightfield (and
   marks the bed in masks.flow, so biome painting puts gravel/dirt there). The surface shades like KE.Water: sky or
   screen-space reflection, refraction of the opaque scene with absorption, sun glint, foam where the water thins
   against the banks, and white water on steep reaches; its detail normals scroll downstream in ribbon
   coordinates (metres across, metres along), so the water visibly flows around bends. CPU queries (nearest,
   heightAt, flowAt, pointAt) serve boats, swimming and placement filters. */
const RIVER_VS=`attribute vec3 flow;varying vec3 vWorld;varying vec2 vRib;varying vec3 vFlow;varying float vViewZ;
void main(){vec4 wp=modelMatrix*vec4(position,1.);vWorld=wp.xyz;vRib=uv;vFlow=flow;vec4 mv=viewMatrix*wp;vViewZ=-mv.z;gl_Position=projectionMatrix*mv;}`;
const RIVER_FS=`${KE.GLSL_SCENE_DECL}
uniform float uTime;uniform samplerCube tSky;uniform float uHasSky;uniform sampler2D tNormal;uniform vec3 uScatter;uniform vec3 uAbsorb;uniform vec3 uFoamColor;uniform float uFoamDepth;uniform float uRefract;uniform float uDetail;uniform float uRain;uniform float uSunGlint;uniform vec3 uAmbient;uniform vec3 uHorizon;uniform vec3 uZenith;uniform float uOpacity;
varying vec3 vWorld;varying vec2 vRib;varying vec3 vFlow;varying float vViewZ;
${KE.GLSL.hash}
${KE.GLSL.ssr}
float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}
vec3 skyAt(vec3 d){if(uHasSky>.5)return textureCube(tSky,d).rgb;return mix(uHorizon,uZenith,clamp(d.y,0.,1.));}
void main(){vec3 V=normalize(cameraPosition-vWorld);float dist=length(cameraPosition-vWorld),fade=1.-smoothstep(30.,180.,dist);
 vec2 fd=normalize(vFlow.xy+vec2(1e-5,0.)),fs=vec2(-fd.y,fd.x);float sp=vFlow.z;
 vec3 a=texture2D(tNormal,vec2(vRib.x,vRib.y-uTime*sp)*.16).xyz*2.-1.,b=texture2D(tNormal,vec2(vRib.x*1.3+5.,vRib.y*.8-uTime*sp*1.35)*.37).xyz*2.-1.;
 vec2 d=(a.xy+b.xy)*uDetail*(1.+sp*.35)*fade;vec3 N=normalize(vec3(0.,1.,0.)+vec3(fs.x,0.,fs.y)*d.x+vec3(fd.x,0.,fd.y)*d.y);
 if(uRain>0.){vec2 c=texture2D(tNormal,vWorld.xz*.9+vec2(uTime*.7,-uTime*.5)).xy*2.-1.;N=normalize(N+vec3(c.x,0.,c.y)*uRain*.35*fade);}
 float NdV=clamp(dot(N,V),0.,1.),F=.02+.98*pow(1.-NdV,5.);vec3 sunI=keSunColor*max(keSunDirection.y,0.);
 vec3 R=reflect(-V,N);R.y=abs(R.y);vec3 refl=skyAt(R);vec2 suv=gl_FragCoord.xy/keResolution;float thick=2.;vec3 below=uScatter;
 if(keHasScene>.5){float z0=texture2D(keSceneDepth,suv).r;vec2 ruv=suv+N.xz*uRefract*clamp((z0-vViewZ)*.5,0.,1.)/max(vViewZ*.15,1.);float z1=texture2D(keSceneDepth,ruv).r;if(z1<vViewZ){ruv=suv;z1=z0;}
  thick=max(z1-vViewZ,0.);below=texture2D(keSceneColor,ruv).rgb;vec3 vpos=(keViewMatrix*vec4(vWorld,1.)).xyz,vn=normalize((keViewMatrix*vec4(N,0.)).xyz);vec4 ssr=keTraceSSR(vpos,vn,.05,ign(gl_FragCoord.xy+keFrame));refl=mix(refl,ssr.rgb,ssr.a);}
 vec3 transm=exp(-uAbsorb*thick),refr=below*transm+uScatter*(uAmbient+sunI*.35)*(1.-transm);
 vec3 H=normalize(V+keSunDirection);float spec=pow(max(dot(N,H),0.),700.)*10.+pow(max(dot(N,H),0.),90.)*.25;
 float fn=texture2D(tNormal,vec2(vRib.x*.45,vRib.y*.12-uTime*sp*.12)).r*.6+texture2D(tNormal,vec2(vRib.x*.9+.3,vRib.y*.3-uTime*sp*.3)).g*.4;fn=clamp((fn-.5)*2.6+.5,0.,1.);
 float bank=keHasScene*(1.-smoothstep(0.,uFoamDepth,thick*max(V.y,.2))),white=smoothstep(2.2,4.5,sp);
 float foam=clamp(bank*smoothstep(.55,.9,fn)*(.25+.55*white)+white*smoothstep(.5,.85,fn)*.8,0.,1.);
 vec3 col=mix(refr,refl,F)+keSunColor*spec*uSunGlint;col=mix(col,uFoamColor*(uAmbient+sunI*.8),foam*.85);
 gl_FragColor=vec4(col,keHasScene>.5?1.:clamp(uOpacity+F*.3+foam,0.,1.));
 #include <tonemapping_fragment>
 #include <encodings_fragment>
}`;
const rsmooth=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);};
KE.River=class{
  /* points: [[x,z],…] from source to mouth; heightAt: the terrain height before carving (or pass a ready profile). */
  constructor(THREE,scene,o={}){
    this.THREE=THREE;this.scene=scene;this.time=0;this.rain=0;
    const opt=this.options=Object.assign({points:null,heightAt:null,profile:null,width:[8,24],depth:[1.6,3],step:4,minSlope:.002,seaLevel:0,speed:[.8,3.2],overlap:3,segmentsAcross:4,sky:null,
      scatter:[.03,.1,.08],absorb:[.38,.13,.1],foamColor:[.86,.9,.88],foamDepth:.18,refraction:.03,detail:.3,sunGlint:1,opacity:.85,horizon:[.55,.7,.8],zenith:[.2,.4,.7]},o);
    this.path=opt.profile||KE.River.profile(opt.points,opt.heightAt,opt);this.pts=this.path.pts;this.length=this.path.length;
    this._index(64);
    const U=KE.sceneUniforms(THREE);this.normalTex=detailNormalTexture(THREE);
    this.uniforms={...U,uTime:{value:0},tSky:{value:null},uHasSky:{value:0},tNormal:{value:this.normalTex},uScatter:{value:new THREE.Color(...opt.scatter)},uAbsorb:{value:new THREE.Vector3(...opt.absorb)},
      uFoamColor:{value:new THREE.Color(...opt.foamColor)},uFoamDepth:{value:opt.foamDepth},uRefract:{value:opt.refraction},uDetail:{value:opt.detail},uRain:{value:0},uSunGlint:{value:opt.sunGlint},
      uAmbient:{value:new THREE.Color(.25,.3,.35)},uHorizon:{value:new THREE.Color(...opt.horizon)},uZenith:{value:new THREE.Color(...opt.zenith)},uOpacity:{value:opt.opacity}};
    this.material=new THREE.ShaderMaterial({vertexShader:RIVER_VS,fragmentShader:RIVER_FS,uniforms:this.uniforms,transparent:true,depthWrite:true,side:THREE.DoubleSide,toneMapped:true});
    this.material.extensions={derivatives:true};
    this.mesh=new THREE.Mesh(this._geometry(),this.material);this.mesh.name='ke-river';this.mesh.layers.set(KE.LAYERS.TRANSLUCENT);if(scene)scene.add(this.mesh);
    if(opt.sky)this.setSky(opt.sky);}
  static profile(points,heightAt,o={}){
    if(!points||points.length<2||typeof heightAt!=='function')throw new TypeError('KE.River.profile needs points [[x,z],…] and heightAt(x,z)');
    const step=o.step||4,wA=o.width||[8,24],dA=o.depth||[1.6,3],sea=o.seaLevel===undefined?0:o.seaLevel,minSlope=o.minSlope===undefined?.002:o.minSlope,spA=o.speed||[.8,3.2],lateral=o.lateral||0;
    const P=points.map(p=>Array.isArray(p)?[p[0],p[1]]:[p.x,p.z]),dense=[];
    for(let i=0;i<P.length-1;i++){const p0=P[Math.max(0,i-1)],p1=P[i],p2=P[i+1],p3=P[Math.min(P.length-1,i+2)],n=Math.max(4,Math.ceil(Math.hypot(p2[0]-p1[0],p2[1]-p1[1])/step*2));
      for(let k=0;k<n;k++){const t=k/n,t2=t*t,t3=t2*t;dense.push([0,1].map(j=>.5*(2*p1[j]+(-p0[j]+p2[j])*t+(2*p0[j]-5*p1[j]+4*p2[j]-p3[j])*t2+(-p0[j]+3*p1[j]-3*p2[j]+p3[j])*t3)));}}
    dense.push(P[P.length-1]);const L=[0];for(let i=1;i<dense.length;i++)L.push(L[i-1]+Math.hypot(dense[i][0]-dense[i-1][0],dense[i][1]-dense[i-1][1]));
    const total=L[L.length-1],n=Math.max(2,Math.round(total/step)),pts=[];let j=0;
    for(let i=0;i<=n;i++){const s=i/n*total;while(j<dense.length-2&&L[j+1]<s)j++;const f=(s-L[j])/Math.max(1e-6,L[j+1]-L[j]),x=dense[j][0]+(dense[j+1][0]-dense[j][0])*f,z=dense[j][1]+(dense[j+1][1]-dense[j][1])*f,t=s/total;
      pts.push({x,z,s,t,ground:heightAt(x,z),w:wA[0]+(wA[1]-wA[0])*t,depth:dA[0]+(dA[1]-dA[0])*t,y:0,dx:0,dz:1,nx:1,nz:0,speed:spA[0]});}
    /* surface: below the ground by a third of the depth, falling at least minSlope per metre, not below the sea; smoothed without breaking either rule.
       With `lateral`, the ground is the lowest sample across the channel ± lateral metres, so a path drawn along a hillside
       still puts the water at the foot of the slope (the carve then cuts the uphill side) instead of on an embankment. */
    if(lateral>0)for(let i=0;i<pts.length;i++){const a=pts[Math.max(0,i-1)],b=pts[Math.min(pts.length-1,i+1)],dx=b.x-a.x,dz=b.z-a.z,l=Math.hypot(dx,dz)||1,nx=-dz/l,nz=dx/l,p=pts[i],reach=p.w*.5+lateral;
      for(let k=1;k<=6;k++){const d=reach*k/6;p.ground=Math.min(p.ground,heightAt(p.x+nx*d,p.z+nz*d),heightAt(p.x-nx*d,p.z-nz*d));}}
    const cap=pts.map(p=>p.ground-p.depth*.35);let prev=Infinity;
    for(let i=0;i<pts.length;i++){const d=i?pts[i].s-pts[i-1].s:0;prev=Math.max(sea+.05,Math.min(cap[i],prev-minSlope*d));pts[i].y=prev;}
    for(let pass=0;pass<6;pass++){for(let i=1;i<pts.length-1;i++){const v=(pts[i-1].y+pts[i].y*2+pts[i+1].y)/4;pts[i].y=Math.max(sea+.05,Math.min(v,cap[i],pts[i-1].y-minSlope*(pts[i].s-pts[i-1].s)));}}
    for(let i=0;i<pts.length;i++){const a=pts[Math.max(0,i-1)],b=pts[Math.min(pts.length-1,i+1)],dx=b.x-a.x,dz=b.z-a.z,l=Math.hypot(dx,dz)||1,p=pts[i];p.dx=dx/l;p.dz=dz/l;p.nx=-p.dz;p.nz=p.dx;
      const slope=Math.max(0,(a.y-b.y)/Math.max(1e-3,b.s-a.s));p.speed=Math.min(spA[1],spA[0]+slope*260);}
    return {pts,length:total};}
  /* Cut the channel and its valley into a heightfield (call before building terrain from it). */
  static carve(hf,path,o={}){
    /* Every segment proposes a surface (bed inside the channel, bank lip, valley walls rising at `slope` that steepen
       toward the edge of the carve region); the lowest proposal wins. Taking the minimum over all nearby segments keeps
       the result continuous where two reaches at different water levels are about equally near (a nearest-segment
       choice would leave a step there). A soft minimum rounds the crease where the walls meet the land. */
    const bank=o.bank===undefined?5:o.bank,valley=o.valley===undefined?150:o.valley,slope=o.valleySlope===undefined?.45:o.valleySlope,lip=o.lip===undefined?.5:o.lip;
    const S=hf.size,sp=hf.spacing,D=hf.data,tgt=new Float32Array(S*S).fill(Infinity),best=new Float32Array(S*S).fill(Infinity),lev=new Float32Array(S*S),P=path.pts;
    for(let i=0;i<P.length-1;i++){const a=P[i],b=P[i+1],R=valley+Math.max(a.w,b.w)*.5+bank,ex=b.x-a.x,ez=b.z-a.z,el=ex*ex+ez*ez||1;
      const i0=Math.max(0,Math.floor((Math.min(a.x,b.x)-R-hf.originX)/sp)),i1=Math.min(S-1,Math.ceil((Math.max(a.x,b.x)+R-hf.originX)/sp)),j0=Math.max(0,Math.floor((Math.min(a.z,b.z)-R-hf.originZ)/sp)),j1=Math.min(S-1,Math.ceil((Math.max(a.z,b.z)+R-hf.originZ)/sp));
      for(let jj=j0;jj<=j1;jj++){const z=hf.originZ+jj*sp;for(let ii=i0;ii<=i1;ii++){const x=hf.originX+ii*sp,t=Math.min(1,Math.max(0,((x-a.x)*ex+(z-a.z)*ez)/el)),dx=x-a.x-ex*t,dz=z-a.z-ez*t,dist=Math.sqrt(dx*dx+dz*dz);
        const hw=(a.w+(b.w-a.w)*t)*.5;if(dist>hw+bank+valley)continue;const y=a.y+(b.y-a.y)*t,dep=a.depth+(b.depth-a.depth)*t,k=jj*S+ii,q=Math.min(1,dist/hw),u=Math.max(0,dist-hw-bank),edge=Math.max(0,(u-valley*.7)/(valley*.3));
        const target=dist<hw?y-dep*(1-q*q)-.1:y+lip*rsmooth(hw,hw+bank,dist)+u*slope+edge*edge*valley*1.5;if(target<tgt[k])tgt[k]=target;
        if(dist-hw<best[k]){best[k]=dist-hw;lev[k]=dist>hw*.9&&dist<hw+bank?y+lip*rsmooth(hw*.9,hw+bank*.6,dist)-.05:-Infinity;}}}}
    const flow=hf.masks&&hf.masks.flow,sk=6;let carved=0;
    for(let k=0;k<S*S;k++){const target=tgt[k];if(target===Infinity)continue;const h=D[k];
      let nh=Math.min(h,target)-Math.max(sk-Math.abs(h-target),0)**2/(4*sk);if(nh>h)nh=h;nh=Math.max(nh,lev[k]);   // a low levee where the land beside the river lies below the water
      if(nh!==h){D[k]=nh;carved++;}if(flow&&best[k]<bank)flow[k]=Math.max(flow[k],4000*Math.min(1,1-best[k]/(bank*2)));}
    hf.recomputeRange();hf.version++;return {carved};}
  _index(cell){this._cell=cell;const m=this._grid=new Map(),P=this.pts,reach=cell;
    for(let i=0;i<P.length-1;i++){const a=P[i],b=P[i+1],r=Math.max(a.w,b.w)*.5+reach,x0=Math.floor((Math.min(a.x,b.x)-r)/cell),x1=Math.floor((Math.max(a.x,b.x)+r)/cell),z0=Math.floor((Math.min(a.z,b.z)-r)/cell),z1=Math.floor((Math.max(a.z,b.z)+r)/cell);
      for(let gz=z0;gz<=z1;gz++)for(let gx=x0;gx<=x1;gx++){const key=gx+','+gz;let l=m.get(key);if(!l)m.set(key,l=[]);l.push(i);}}}
  _geometry(){const T=this.THREE,P=this.pts,A=Math.max(1,this.options.segmentsAcross|0),ov=this.options.overlap,pos=[],uv=[],flow=[],idx=[];
    for(const p of P){const hw=p.w*.5+ov;for(let k=0;k<=A;k++){const u=k/A*2-1;pos.push(p.x+p.nx*u*hw,p.y,p.z+p.nz*u*hw);uv.push(u*hw,p.s);flow.push(p.dx,p.dz,p.speed);}}
    for(let i=0;i<P.length-1;i++)for(let k=0;k<A;k++){const a=i*(A+1)+k,b=a+1,c=a+A+1,d=c+1;idx.push(a,b,c,b,d,c);}
    const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pos,3));g.setAttribute('uv',new T.Float32BufferAttribute(uv,2));g.setAttribute('flow',new T.Float32BufferAttribute(flow,3));g.setIndex(idx);g.computeBoundingSphere();g.computeBoundingBox();return g;}
  /* Nearest point on the centre line within reach (64 m beyond the banks): {d, i, t, s, x, z, y (surface), w, dx, dz, speed}; d is Infinity when farther. */
  nearest(x,z,out={}){out.d=Infinity;const l=this._grid.get(Math.floor(x/this._cell)+','+Math.floor(z/this._cell));if(!l)return out;const P=this.pts;
    for(const i of l){const a=P[i],b=P[i+1],ex=b.x-a.x,ez=b.z-a.z,el=ex*ex+ez*ez||1,t=Math.min(1,Math.max(0,((x-a.x)*ex+(z-a.z)*ez)/el)),px=a.x+ex*t,pz=a.z+ez*t,d=Math.hypot(x-px,z-pz);
      if(d<out.d){out.d=d;out.i=i;out.t=t;out.x=px;out.z=pz;out.s=a.s+(b.s-a.s)*t;out.y=a.y+(b.y-a.y)*t;out.w=a.w+(b.w-a.w)*t;out.dx=a.dx+(b.dx-a.dx)*t;out.dz=a.dz+(b.dz-a.dz)*t;out.speed=a.speed+(b.speed-a.speed)*t;}}
    return out;}
  /* Distance from the water's edge (negative inside the channel); Infinity when out of reach. */
  edgeDistance(x,z){const n=this.nearest(x,z,this._q||(this._q={}));return n.d===Infinity?Infinity:n.d-n.w*.5;}
  heightAt(x,z){const n=this.nearest(x,z,this._q||(this._q={}));return n.d<=n.w*.5+this.options.overlap?n.y:-Infinity;}
  flowAt(x,z,out={x:0,z:0}){const n=this.nearest(x,z,this._q||(this._q={}));if(n.d>n.w*.5+this.options.overlap){out.x=out.z=0;return out;}const k=n.speed*(1-Math.pow(Math.min(1,n.d/(n.w*.5)),2)*.7);out.x=n.dx*k;out.z=n.dz*k;return out;}
  /* Point at arc length s from the source: {x, z, y, w, dx, dz, nx, nz, speed}. */
  pointAt(s,out={}){const P=this.pts;s=Math.min(this.length,Math.max(0,s));let lo=0,hi=P.length-1;while(hi-lo>1){const m=(lo+hi)>>1;if(P[m].s<=s)lo=m;else hi=m;}
    const a=P[lo],b=P[hi],t=(s-a.s)/Math.max(1e-6,b.s-a.s);for(const k of ['x','z','y','w','dx','dz','nx','nz','speed'])out[k]=a[k]+(b[k]-a[k])*t;out.s=s;return out;}
  setSky(sky){const tex=sky&&sky.cube?sky.cube.texture:sky;this.sky=sky&&sky.cube?sky:null;this.uniforms.tSky.value=tex||null;this.uniforms.uHasSky.value=tex?1:0;return this;}
  update(dt,{ambient=null}={}){this.time+=dt;const U=this.uniforms;U.uTime.value=this.time;U.uRain.value=this.rain;if(ambient)U.uAmbient.value.copy(ambient);else if(this.sky)U.uAmbient.value.copy(this.sky.zenithColor).lerp(this.sky.fogColor,.5);return this;}
  dispose(){this.mesh.parent&&this.mesh.parent.remove(this.mesh);this.mesh.geometry.dispose();this.material.dispose();this.normalTex.dispose();}
};

/* ---------- KE.boatModel ----------
   Procedural Japanese wooden boats. 'wasen': a small flat-bottomed plank boat with a transom stern and a tall raked
   bow, thwarts and an optional boatman in a sedge hat with a pole. 'yakatabune': a longer pleasure boat with a
   roofed cabin and paper lanterns (emissive) along the eaves. The hull is lofted from cross-sections (outer and
   inner skins, gunwale rim, transom); planks come from the wood tile running along the hull. Local frame: +x bow,
   y up, waterline at y = draft. Returns {group, length, width, draft, materials, dispose}. */
KE.boatModel=(THREE,o={})=>{
  const style=o.style||'wasen',yak=style==='yakatabune',L=o.length||(yak?9.5:5.6),W=o.width||(yak?2.3:1.35),D=o.depth||(yak?.75:.55),r=KE.random((o.seed||1)*977+17),th=.035,N=18;
  const woodTex=KE.paintTile(THREE,'wood',o.textureSize||256,(o.seed||1)*13+5);woodTex.encoding=THREE.sRGBEncoding;woodTex.wrapS=woodTex.wrapT=THREE.RepeatWrapping;
  const tone=new THREE.Color(o.color||(yak?0x9a7650:0x8b6b4a)),outer=new THREE.MeshStandardMaterial({map:woodTex,color:tone,roughness:.82}),inner=new THREE.MeshStandardMaterial({map:woodTex,color:tone.clone().multiplyScalar(.78),roughness:.88,side:THREE.DoubleSide});
  const group=new THREE.Group();group.name='ke-boat-'+style;const mats=[outer,inner],geos=[];
  const hw=t=>W/2*Math.min(1,.8+.4*t)*(1-.97*Math.pow(rsmooth(.6,1,t),1.5)),top=t=>D+D*.8*Math.pow(rsmooth(.55,1,t),2)+(yak?0:D*.12*Math.pow(1-t,3)),bot=t=>D*.55*Math.pow(rsmooth(.68,1,t),2)+.04*Math.pow(1-t,6);
  const prof=(t,inset)=>{const h=Math.max(.001,hw(t)-inset),fb=h*.62,b=bot(t)+inset,tp=top(t);return [[-h,tp],[-fb,b+D*.12],[0,b],[fb,b+D*.12],[h,tp]];};
  const skin=(inset,flip)=>{const pos=[],uv=[],idx=[];for(let i=0;i<=N;i++){const t=i/N,x=-L/2+t*L,p=prof(t,inset);let arc=0;for(let k=0;k<p.length;k++){if(k)arc+=Math.hypot(p[k][0]-p[k-1][0],p[k][1]-p[k-1][1]);pos.push(x,p[k][1],p[k][0]);uv.push(arc/.9,x/2.5);}}
    for(let i=0;i<N;i++)for(let k=0;k<4;k++){const a=i*5+k,b=a+1,c=a+5,d=c+1;if(flip)idx.push(a,b,c,b,d,c);else idx.push(a,c,b,b,c,d);}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));g.setIndex(idx);g.computeVertexNormals();return g;};
  const add=(g,m,cast=true)=>{geos.push(g);const mesh=new THREE.Mesh(g,m);mesh.castShadow=cast;mesh.receiveShadow=true;group.add(mesh);return mesh;};
  add(skin(0,false),outer);add(skin(th,true),inner);
  /* gunwale rim and transom */
  {const pos=[],idx=[];for(let i=0;i<=N;i++){const t=i/N,x=-L/2+t*L,h=hw(t),tp=top(t);pos.push(x,tp,-h,x,tp,-Math.max(0,h-th*2),x,tp,h,x,tp,Math.max(0,h-th*2));}
    for(let i=0;i<N;i++){const a=i*4,c=a+4;idx.push(a,c,a+1,a+1,c,c+1,a+2,a+3,c+2,a+3,c+3,c+2);}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);g.computeVertexNormals();add(g,inner,false);
    const p=prof(0,0),tr=new THREE.Shape();tr.moveTo(p[0][0],p[0][1]);for(const q of p.slice(1))tr.lineTo(q[0],q[1]);const tg=new THREE.ShapeGeometry(tr);tg.rotateY(-Math.PI/2);tg.translate(-L/2,0,0);add(tg,outer);}
  const box=(sx,sy,sz,x,y,z,m=inner)=>{const g=new THREE.BoxGeometry(sx,sy,sz);g.translate(x,y,z);return add(g,m);};
  for(const t of yak?[.2,.45,.7]:[.3,.62])box(.16,.04,hw(t)*2-.08,-L/2+t*L,top(t)-.12,0);
  if(yak){/* cabin: posts, a gently arched roof with overhanging eaves, and paper lanterns */
    const roofTex=KE.paintTile(THREE,'roof',256,(o.seed||1)*7+3);roofTex.encoding=THREE.sRGBEncoding;const roofMat=new THREE.MeshStandardMaterial({map:roofTex,color:0x5b5750,roughness:.75,side:THREE.DoubleSide}),lamp=new THREE.MeshStandardMaterial({color:0xf6dcc0,emissive:0xff6a2a,emissiveIntensity:o.lanterns===false?0:1.6,roughness:.9});mats.push(roofMat,lamp);
    const x0=-L*.3,x1=L*.28,cw=W*.46,ph=1.45,base=top(.5)-.1;
    for(const x of [x0,(x0+x1)/2,x1])for(const z of [-cw,cw])box(.09,ph,.09,x,base+ph/2,z);
    const rg=new THREE.PlaneGeometry(x1-x0+1.1,cw*2+.9,10,6),rp=rg.attributes.position;for(let i=0;i<rp.count;i++){const y=rp.getY(i);rp.setZ(i,-(y*y)*.28);}rg.computeVertexNormals();rg.rotateX(-Math.PI/2);rg.translate((x0+x1)/2,base+ph+.18,0);add(rg,roofMat);
    for(let k=0;k<4;k++){const lg=new THREE.CylinderGeometry(.13,.13,.3,10);lg.translate(x0+(k+.5)*(x1-x0)/4,base+ph-.12,cw+.36);const m=add(lg,lamp,false);m.userData.lantern=true;}}
  else if(o.boatman!==false){/* boatman with a sedge hat and pole at the stern */
    const cloth=new THREE.MeshStandardMaterial({color:0x2e3d5c,roughness:.9}),skinM=new THREE.MeshStandardMaterial({color:0xd8a888,roughness:.7}),straw=new THREE.MeshStandardMaterial({color:0xcfb77a,roughness:.95,side:THREE.DoubleSide});mats.push(cloth,skinM,straw);
    const bx=-L*.3,by=bot(.2)+.05,body=new THREE.CylinderGeometry(.17,.22,1.05,10);body.translate(bx,by+.55,0);add(body,cloth);
    const head=new THREE.SphereGeometry(.12,12,10);head.translate(bx,by+1.2,0);add(head,skinM);const hat=new THREE.ConeGeometry(.36,.2,16,1,true);hat.translate(bx,by+1.35,0);add(hat,straw);
    const pole=new THREE.CylinderGeometry(.025,.025,3.6,6);pole.rotateZ(.5);pole.translate(bx-.55,by+1.,.18);add(pole,inner);}
  const draft=o.draft||D*.38;
  return {group,style,length:L,width:W,draft,materials:mats,
    dispose(){for(const g of geos)g.dispose();for(const m of mats)m.dispose();woodTex.dispose();group.parent&&group.parent.remove(group);}};
};

KE.registerModule('water',{provides:['Water','waterWaves','River','boatModel']});
})();
