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
KE.registerModule('water',{provides:['Water','waterWaves']});
})();
