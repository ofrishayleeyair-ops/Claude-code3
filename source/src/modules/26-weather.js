/* KE.SurfaceWeather — weather-driven material layering for lit Standard/Physical materials.
   Rain darkens porous albedo and lowers roughness (after Lagarde, "Water drop 2b – Dynamic rain and its
   effects"); flat, upward-facing areas collect puddles from a world-space noise mask, with animated
   rain-drop ripples perturbing the puddle normal; snow covers upward faces with a noisy slope threshold,
   flattening normal detail and raising roughness. All of it is one block injected after the material's
   normal is final, so it composes with other onBeforeCompile hooks (terrain splatting, GI, shadows).
   update(dt, {raining, snowing}) ramps the wetness, puddle and snow levels over time like a real surface
   that wets, drains and melts. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));

const VERT_PARS='varying vec3 vKeWxPos;varying vec3 vKeWxN;';
const VERT_MAIN=`{vec4 keWp=vec4(transformed,1.);vec3 keWn=objectNormal;
#ifdef USE_INSTANCING
keWp=instanceMatrix*keWp;keWn=mat3(instanceMatrix)*keWn;
#endif
vKeWxPos=(modelMatrix*keWp).xyz;vKeWxN=normalize(mat3(modelMatrix)*keWn);}`;

const FRAG_PARS=`varying vec3 vKeWxPos;varying vec3 vKeWxN;
uniform float keWxWet;uniform float keWxPuddles;uniform float keWxSnow;uniform float keWxRain;uniform float keWxTime;uniform float keWxPuddleScale;uniform float keWxRipples;uniform float keWxPorosity;uniform float keWxCoverage;uniform vec3 keWxSnowColor;
float keWxHash(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
float keWxNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(keWxHash(i),keWxHash(i+vec2(1,0)),f.x),mix(keWxHash(i+vec2(0,1)),keWxHash(i+vec2(1,1)),f.x),f.y);}
float keWxFbm(vec2 p){return keWxNoise(p)*.5+keWxNoise(p*2.03+17.1)*.3+keWxNoise(p*4.11+3.7)*.2;}
/* Rain-drop ripples: each cell of two offset grids spawns one expanding ring per cycle; returns an xz slope. */
vec2 keWxRipple(vec2 p,float t){vec2 g=vec2(0.);
 for(int l=0;l<3;l++){float fl=float(l);vec2 q=p*(1.+fl*.31)+fl*vec2(.37,.71);vec2 cell=floor(q),f=fract(q)-.5;float h=keWxHash(cell+fl*13.1);
  vec2 c=(vec2(keWxHash(cell+3.3),keWxHash(cell+7.7))-.5)*.5;float ph=fract(t*(.7+h*.5)+h);float r=ph*.42;vec2 d=f-c;float dist=length(d);
  float x=(dist-r)*28.;float ring=x*exp(-x*x)*(1.-ph)*(1.-ph);g+=d/max(dist,1e-3)*ring;}
 return g*.55;}`;

/* Injected before emissive: diffuseColor, roughnessFactor, metalnessFactor and the view-space normal are final. */
const FRAG_MAIN=`float keWxPudOut=0.;{float keUp=vKeWxN.y;vec3 keNv=normalize((viewMatrix*vec4(vKeWxN,0.)).xyz);
 float keExposed=smoothstep(-.35,.45,keUp);
 float keWet=keWxWet*keExposed*keWxPorosityScale;
 /* puddles: flat ground, low-frequency noise mask whose threshold drops as the puddle level rises */
 float keFlat=smoothstep(.86,.97,keUp);float kePn=keWxFbm(vKeWxPos.xz*keWxPuddleScale);
 float kePl=keWxPuddles*keWxCoverage*.45;float kePud=keFlat*smoothstep(1.-kePl,1.06-kePl,kePn)*step(.001,keWxPuddles);
 /* snow: upward faces with a noisy slope threshold; snow sits on top of puddles and wet ground */
 float keSn=keWxNoise(vKeWxPos.xz*1.7)*.6+keWxNoise(vKeWxPos.xz*7.3)*.4;
 float keTh=mix(1.25,.36,keWxSnow);float keSnow=smoothstep(keTh,keTh+.18,keUp*.85+keSn*.3)*step(.001,keWxSnow);
 kePud*=1.-keSnow;keWet*=1.-keSnow;keWxPudOut=kePud;
 float keFm=metalnessFactor;
 diffuseColor.rgb*=mix(1.,mix(.42,1.,1.-keWxPorosity),keWet*(1.-keFm));
 roughnessFactor=mix(roughnessFactor,max(.2,roughnessFactor*.5),keWet);
 if(kePud>.001){diffuseColor.rgb*=mix(1.,.62,kePud);roughnessFactor=mix(roughnessFactor,.03,kePud);metalnessFactor=mix(metalnessFactor,0.,kePud);
  vec3 keFlatN=keNv;if(keWxRipples>.5&&keWxRain>.01){vec2 s=keWxRipple(vKeWxPos.xz*2.4,keWxTime)*keWxRain;keFlatN=normalize((viewMatrix*vec4(normalize(vec3(-s.x,1.,-s.y)),0.)).xyz);}
  normal=normalize(mix(normal,keFlatN,kePud));}
 if(keSnow>.001){float keSp=keWxHash(floor(vKeWxPos.xz*40.)+floor(vKeWxPos.y*40.));
  diffuseColor.rgb=mix(diffuseColor.rgb,keWxSnowColor*(.94+.06*keSn),keSnow);roughnessFactor=mix(roughnessFactor,mix(.62,.35,step(.985,keSp)),keSnow);metalnessFactor=mix(metalnessFactor,0.,keSnow);
  /* soft drifts: low-frequency slope from a finite-difference noise gradient */
  vec2 keQ=vKeWxPos.xz*.9;float keN0=keWxFbm(keQ);vec2 keDg=vec2(keWxFbm(keQ+vec2(.07,0.))-keN0,keWxFbm(keQ+vec2(0.,.07))-keN0)*6.;
  vec3 keSnowN=normalize((viewMatrix*vec4(normalize(vKeWxN+vec3(-keDg.x,0.,-keDg.y)*.35),0.)).xyz);
  normal=normalize(mix(normal,keSnowN,keSnow*.8));}
}`;

/* Puddle reflections: after lighting, the puddle's indirect specular is replaced (by Fresnel and puddle weight) with a
   screen-space reflection traced against the previous frame (KE.GLSL.ssrPrev from the pipeline module). */
const FRAG_LATE=`if(keWxPudOut>.01){vec3 keWn=inverseTransformDirection(normal,viewMatrix);vec4 keR=keTraceSSRPrev(vKeWxPos,keWn,.04,fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(.06711056,.00583715)))));
 float keF=.02+.98*pow(1.-clamp(dot(normal,normalize(vViewPosition)),0.,1.),5.);reflectedLight.indirectSpecular=mix(reflectedLight.indirectSpecular,keR.rgb*keF,keR.a*keWxPudOut);}`;
const SSR_UNIFORMS=[['sampler2D','keSceneColor'],['sampler2D','keSceneDepth'],['mat4','keInvView'],['float','keSSR'],['mat4','kePrevViewProj'],['mat4','kePrevView'],['float','kePrevScene']];

KE.SurfaceWeather=class{
  constructor(THREE,{wetness=0,puddles=0,snow=0,rain=0,puddleScale=.18,puddleCoverage=1,porosity=.6,reflections=true,snowColor=0xf2f5fa,wetRate=.08,dryRate=.012,puddleRate=.025,drainRate=.008,snowRate=.02,meltRate=.01,ripples=null}={}){
    this.THREE=THREE;this.reflections=reflections;Object.assign(this,{wetRate,dryRate,puddleRate,drainRate,snowRate,meltRate});
    this.uniforms={keWxWet:{value:clamp(wetness,0,1)},keWxPuddles:{value:clamp(puddles,0,1)},keWxSnow:{value:clamp(snow,0,1)},keWxRain:{value:clamp(rain,0,1)},keWxTime:{value:0},
      keWxPuddleScale:{value:puddleScale},keWxRipples:{value:1},keWxPorosity:{value:clamp(porosity,0,1)},keWxCoverage:{value:clamp(puddleCoverage,0,2)},keWxSnowColor:{value:new THREE.Color(snowColor).convertSRGBToLinear()}};
    this._ripplesOverride=ripples;this.materials=new Set();this.restore=new Map();
    const apply=s=>{this.uniforms.keWxRipples.value=this._ripplesOverride!==null?(this._ripplesOverride?1:0):((s&&s.vfx!==undefined?s.vfx:1)>=.5?1:0);};
    this.offSettings=KE.events&&KE.events.on?KE.events.on('settings',apply):null;apply(KE.settings);
  }
  /* Patch one lit material. Per-material porosity: material.userData.kePorosity (0 = sealed, e.g. glazed or metal; 1 = very porous). */
  setupMaterial(m){
    if(!m||this.materials.has(m)||!m.isMeshStandardMaterial||m.userData.keNoWeather||m.transparent)return m;
    const prev=m.onBeforeCompile,ownKey=Object.prototype.hasOwnProperty.call(m,'customProgramCacheKey')?m.customProgramCacheKey:null,prevKey=m.customProgramCacheKey.bind(m),U=this.uniforms;
    const porosity=Number.isFinite(m.userData.kePorosity)?clamp(m.userData.kePorosity,0,1):1,ssr=this.reflections&&!!(KE.GLSL&&KE.GLSL.ssrPrev&&KE.sceneUniforms);
    this.restore.set(m,{prev,ownKey});
    m.onBeforeCompile=(sh,r)=>{if(prev)prev.call(m,sh,r);Object.assign(sh.uniforms,U);
      if(!/#include <defaultnormal_vertex>/.test(sh.vertexShader)||!/#include <project_vertex>/.test(sh.vertexShader)||!/#include <emissivemap_fragment>/.test(sh.fragmentShader))throw new Error('KE.SurfaceWeather: unexpected Standard material shader (Three.js r128 required)');
      sh.vertexShader=VERT_PARS+'\n'+sh.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\n'+VERT_MAIN);
      sh.fragmentShader=FRAG_PARS+'\n#define keWxPorosityScale '+porosity.toFixed(3)+'\n'+sh.fragmentShader.replace('#include <emissivemap_fragment>',FRAG_MAIN+'\n#include <emissivemap_fragment>');
      if(ssr&&/#include <lights_fragment_end>/.test(sh.fragmentShader)){const SU=KE.sceneUniforms(this.THREE);let decl='';
        for(const [type,name] of SSR_UNIFORMS){if(!sh.uniforms[name])sh.uniforms[name]=SU[name];if(!new RegExp('uniform\\s+'+type+'\\s+'+name+'\\b').test(sh.fragmentShader))decl+='uniform '+type+' '+name+';';}
        sh.fragmentShader=decl+'\n'+(/keTraceSSRPrev/.test(sh.fragmentShader)?'':KE.GLSL.ssrPrev+'\n')+sh.fragmentShader.replace('#include <lights_fragment_end>','#include <lights_fragment_end>\n'+FRAG_LATE);}};
    m.customProgramCacheKey=()=>prevKey()+':ke-wx'+porosity.toFixed(3)+(ssr?':ssr':'');m.needsUpdate=true;this.materials.add(m);return m;}
  setupScene(root){root.traverse(o=>{if(o.material&&!o.userData.keNoWeather)for(const m of [o.material].flat())this.setupMaterial(m);});return this;}
  /* Direct control, all 0..1. */
  set({wetness,puddles,snow,rain}={}){const U=this.uniforms;if(wetness!==undefined)U.keWxWet.value=clamp(+wetness||0,0,1);if(puddles!==undefined)U.keWxPuddles.value=clamp(+puddles||0,0,1);
    if(snow!==undefined)U.keWxSnow.value=clamp(+snow||0,0,1);if(rain!==undefined)U.keWxRain.value=clamp(+rain||0,0,1);return this;}
  get wetness(){return this.uniforms.keWxWet.value;}get puddles(){return this.uniforms.keWxPuddles.value;}get snow(){return this.uniforms.keWxSnow.value;}get rain(){return this.uniforms.keWxRain.value;}
  set ripples(v){this._ripplesOverride=v===null?null:!!v;this.uniforms.keWxRipples.value=v===null?((KE.settings&&KE.settings.vfx)>=.5?1:0):(v?1:0);}
  /* Advance the simulation: wetness rises quickly in rain and dries slowly; puddles fill after the ground is wet and drain slower still;
     snow accumulates while snowing (and it is not raining) and melts otherwise. rain (0..1) is the rain intensity for ripples. */
  update(dt=0,{raining=null,snowing=null,rain=null}={}){dt=Number.isFinite(dt)?clamp(dt,0,.5):0;const U=this.uniforms;U.keWxTime.value+=dt;
    if(raining!==null){const r=raining?(rain===null?1:clamp(rain,0,1)):0;U.keWxRain.value=KE.damp?KE.damp(U.keWxRain.value,r,4,dt):r;
      U.keWxWet.value=clamp(U.keWxWet.value+(raining?this.wetRate*Math.max(.25,r):-this.dryRate)*dt,0,1);
      U.keWxPuddles.value=clamp(U.keWxPuddles.value+(raining&&U.keWxWet.value>.6?this.puddleRate*Math.max(.25,r):-this.drainRate)*dt,0,1);}
    else if(rain!==null)U.keWxRain.value=clamp(rain,0,1);
    if(snowing!==null)U.keWxSnow.value=clamp(U.keWxSnow.value+(snowing&&!raining?this.snowRate:-this.meltRate)*dt,0,1);
    return this;}
  dispose(){if(this.offSettings)this.offSettings();for(const m of this.materials){const r=this.restore.get(m);m.onBeforeCompile=r.prev;if(r.ownKey)m.customProgramCacheKey=r.ownKey;else delete m.customProgramCacheKey;m.needsUpdate=true;}this.materials.clear();this.restore.clear();}
};
KE.registerModule('weather',{provides:['SurfaceWeather']});
})();
