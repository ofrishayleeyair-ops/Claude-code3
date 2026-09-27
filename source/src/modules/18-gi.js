/* KE.ProbeVolume — dynamic diffuse global illumination from a grid of irradiance probes.
   Probes are refreshed a few per frame (nearest to the camera first): each renders a small cube map of the
   scene's GI layer (static geometry, sky background, direct light and — because lit materials themselves
   sample the volume — previously gathered bounce light, so bounces accumulate over refreshes), which a GPU
   pass projects onto order-1 spherical harmonics and blends into a probe atlas with hysteresis. Lit
   materials that are set up replace their sky-only diffuse image lighting with trilinearly interpolated,
   normal-weighted probe irradiance, and scale specular reflections by the probe/sky ratio so enclosed spaces
   stop reflecting the open sky. Inspired by probe-based dynamic GI; there is no per-probe visibility
   (depth) data, so thin walls can leak light, and probes cannot capture objects outside the GI layer. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
KE.LAYERS.GI=KE.LAYERS.GI||2;
const TEXELS=5;// 4 SH (L0, L1y, L1z, L1x) + position/validity

const PROJECT_FS=`uniform samplerCube tCube;uniform vec3 uPosition;uniform float uValid;uniform float uAlpha;uniform float uRow0;
void main(){int k=int(floor(gl_FragCoord.y-uRow0));if(k>=4){gl_FragColor=vec4(uPosition,uValid);return;}
 vec3 acc=vec3(0.);const int N=128;float ga=2.39996323;
 for(int i=0;i<N;i++){float y=1.-(float(i)+.5)/float(N)*2.;float r=sqrt(max(1.-y*y,0.));float a=float(i)*ga;vec3 d=vec3(cos(a)*r,y,sin(a)*r);vec3 L=textureCube(tCube,d).rgb;
  float Y=k==0?.282095:k==1?.488603*d.y:k==2?.488603*d.z:.488603*d.x;acc+=min(L,vec3(64.))*Y;}
 gl_FragColor=vec4(acc*12.566371/float(N),uAlpha);}`;

/* Irradiance lookup injected into lit materials. */
const GI_PARS=`uniform sampler2D keProbeAtlas;uniform vec2 keProbeAtlasSize;uniform vec3 keProbeMin;uniform vec3 keProbeStep;uniform vec3 keProbeCount;uniform float keGIStrength;uniform float keGIOn;varying vec3 vKeWorld;
vec4 keProbeTexel(vec3 c,float k){float col=c.x+c.z*keProbeCount.x;float row=c.y*${TEXELS}.+k;return texture2D(keProbeAtlas,(vec2(col,row)+.5)/keProbeAtlasSize);}
vec3 keProbeIrradiance(vec3 P,vec3 N,out float valid){vec3 g=clamp((P+N*.35-keProbeMin)/keProbeStep,vec3(0.),keProbeCount-1.001);vec3 b=floor(g),f=g-b;vec3 E=vec3(0.);float ws=0.;valid=0.;
 for(int i=0;i<8;i++){vec3 o=vec3(float(i-(i/2)*2),float((i/2)-(i/4)*2),float(i/4));vec3 c=b+o;vec3 tw=mix(1.-f,f,o);float w=tw.x*tw.y*tw.z;
  vec4 pv=keProbeTexel(c,4.);if(pv.a<.01||w<1e-5)continue;vec3 dir=normalize(pv.xyz-P+1e-4);float bw=(dot(dir,N)+1.)*.5;w*=bw*bw+.08;w*=pv.a;
  vec3 c0=keProbeTexel(c,0.).rgb,c1=keProbeTexel(c,1.).rgb,c2=keProbeTexel(c,2.).rgb,c3=keProbeTexel(c,3.).rgb;
  vec3 e=3.141593*.282095*c0+2.094395*.488603*(c1*N.y+c2*N.z+c3*N.x);E+=max(e,vec3(0.))*w;ws+=w;valid+=pv.a*tw.x*tw.y*tw.z;}
 return ws>1e-5?E/ws:vec3(0.);}`;
function buildMapsChunk(THREE){const src=THREE.ShaderChunk.lights_fragment_maps;
  const irr=/iblIrradiance \+= getLightProbeIndirectIrradiance\([^;]*\);/,rad=/radiance \+= (getLightProbeIndirectRadiance\([^;]*geometry\.normal[^;]*\);)/;
  if(!irr.test(src)||!rad.test(src))throw new Error('KE.ProbeVolume: unexpected lights_fragment_maps chunk (Three.js r128 required)');
  return 'float keSpecOcc=1.;\n'+src.replace(irr,`vec3 keSkyE=getLightProbeIndirectIrradiance( geometry, maxMipLevel );float keValid=0.;vec3 keWN=inverseTransformDirection(geometry.normal,viewMatrix);
		vec3 keProbeE=keGIOn>.5?keProbeIrradiance(vKeWorld,keWN,keValid)*envMapIntensity*keGIStrength:vec3(0.);float keW=clamp(keValid,0.,1.)*keGIOn;
		iblIrradiance+=mix(keSkyE,keProbeE,keW);float keLs=dot(keSkyE,vec3(.2126,.7152,.0722)),keLp=dot(keProbeE,vec3(.2126,.7152,.0722));keSpecOcc=mix(1.,clamp(keLp/max(keLs,1e-4),.08,1.),keW);`)
    .replace(rad,'radiance += keSpecOcc * $1');}

KE.ProbeVolume=class{
  constructor(THREE,renderer,scene,{bounds,spacing=8,counts=null,heightAt=null,lift=.8,faceSize=16,probesPerFrame=2,hysteresis=.8,strength=1,far=80}={}){
    if(!bounds||!bounds.isBox3)throw new TypeError('KE.ProbeVolume requires {bounds: THREE.Box3}');
    Object.assign(this,{THREE,renderer,scene,heightAt,lift,probesPerFrame,hysteresis,enabled:true});
    const size=bounds.getSize(new THREE.Vector3());this.count=counts?new THREE.Vector3(...counts):new THREE.Vector3(Math.max(2,Math.round(size.x/spacing)+1),Math.max(2,Math.round(size.y/spacing)+1),Math.max(2,Math.round(size.z/spacing)+1));
    this.min=bounds.min.clone();this.step=new THREE.Vector3(size.x/(this.count.x-1),size.y/(this.count.y-1),size.z/(this.count.z-1));
    const n=this.count.x*this.count.y*this.count.z;this.total=n;const W=this.count.x*this.count.z,H=this.count.y*TEXELS,caps=KE.capabilities(renderer);
    this.atlas=new THREE.WebGLRenderTarget(W,H,{type:caps.floatRT?THREE.FloatType:THREE.HalfFloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false,generateMipmaps:false});
    this.cube=new THREE.WebGLCubeRenderTarget(faceSize,{type:caps.halfRT?THREE.HalfFloatType:THREE.UnsignedByteType,format:THREE.RGBAFormat,generateMipmaps:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
    this.cubeCamera=new THREE.CubeCamera(.1,far,this.cube);this.cubeCamera.children.forEach(c=>c.layers.set(KE.LAYERS.GI));this.cubeCamera.updateMatrixWorld(true);
    this.projectMaterial=new THREE.ShaderMaterial({vertexShader:KE.FULLSCREEN_VS,fragmentShader:PROJECT_FS,uniforms:{tCube:{value:this.cube.texture},uPosition:{value:new THREE.Vector3()},uValid:{value:1},uAlpha:{value:1},uRow0:{value:0}},depthTest:false,depthWrite:false,transparent:true,blending:THREE.CustomBlending,blendSrc:THREE.SrcAlphaFactor,blendDst:THREE.OneMinusSrcAlphaFactor,blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.ZeroFactor});
    this.quad=new KE.FullScreenQuad(THREE,this.projectMaterial);
    this.uniforms={keProbeAtlas:{value:this.atlas.texture},keProbeAtlasSize:{value:new THREE.Vector2(W,H)},keProbeMin:{value:this.min},keProbeStep:{value:this.step},keProbeCount:{value:this.count.clone()},keGIStrength:{value:strength},keGIOn:{value:1}};
    this.mapsChunk=buildMapsChunk(THREE);this.materials=new Set();this.restore=new Map();this.probes=[];this.capturedCount=0;
    for(let iy=0;iy<this.count.y;iy++)for(let iz=0;iz<this.count.z;iz++)for(let ix=0;ix<this.count.x;ix++){const p=new THREE.Vector3(this.min.x+ix*this.step.x,this.min.y+iy*this.step.y,this.min.z+iz*this.step.z);let valid=1;
      if(heightAt){const g=heightAt(p.x,p.z);if(p.y<g+lift)p.y=g+lift;if(p.y>this.min.y+(iy+.999)*this.step.y&&iy<this.count.y-1)valid=0;}this.probes.push({ix,iy,iz,position:p,valid,col:ix+iz*this.count.x,row:iy*TEXELS});}
    // Clear the atlas (validity 0 → materials fall back to the sky light until probes arrive).
    const R=renderer,prev=R.getRenderTarget(),cc=R.getClearColor(new THREE.Color()),ca=R.getClearAlpha();R.setRenderTarget(this.atlas);R.setClearColor(0x000000,0);R.clear(true,false,false);R.setClearColor(cc,ca);R.setRenderTarget(prev);
    this._order=[];this._v=new THREE.Vector3();this.onSettings=KE.events.on('settings',s=>{this.uniforms.keGIOn.value=s.gi===false?0:1;this.enabled=s.gi!==false;});this.uniforms.keGIOn.value=KE.settings.gi===false?0:1;this.enabled=KE.settings.gi!==false;
  }
  /* Put objects on the GI capture layer. Default filter: every mesh except points/lines, translucent-layer and tiny objects. */
  tag(root=this.scene,{minRadius=.6,filter=null}={}){const T=this.THREE,s=new T.Sphere();root.updateMatrixWorld(true);
    root.traverse(o=>{if(!o.isMesh||o.userData.keNoGI||(o.parent&&o.parent.userData.keNoGI)||o.layers.test({mask:1<<KE.LAYERS.TRANSLUCENT})&&!o.layers.test({mask:1}))return;if(filter&&!filter(o))return;
      if(!o.isInstancedMesh){if(!o.geometry.boundingSphere)o.geometry.computeBoundingSphere();s.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);if(s.radius<minRadius)return;}o.layers.enable(KE.LAYERS.GI);});return this;}
  /* Patch lit Standard/Physical materials to use probe irradiance (composes with other onBeforeCompile hooks). */
  setupMaterial(m){if(!m||this.materials.has(m)||!m.isMeshStandardMaterial||m.userData.keNoGI)return m;const prev=m.onBeforeCompile,ownKey=Object.prototype.hasOwnProperty.call(m,'customProgramCacheKey')?m.customProgramCacheKey:null,prevKey=m.customProgramCacheKey.bind(m),U=this.uniforms,chunk=this.mapsChunk;this.restore.set(m,{prev,ownKey});
    m.onBeforeCompile=(sh,r)=>{if(prev)prev.call(m,sh,r);Object.assign(sh.uniforms,U);
      sh.vertexShader='varying vec3 vKeWorld;\n'+sh.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\n{vec4 keP=vec4(transformed,1.);\n#ifdef USE_INSTANCING\nkeP=instanceMatrix*keP;\n#endif\nvKeWorld=(modelMatrix*keP).xyz;}');
      sh.fragmentShader=GI_PARS+'\n'+sh.fragmentShader.replace('#include <lights_fragment_maps>',chunk);};
    m.customProgramCacheKey=()=>prevKey()+':ke-gi';m.needsUpdate=true;this.materials.add(m);return m;}
  setupScene(root=this.scene){root.traverse(o=>{if(o.material)for(const m of [o.material].flat())this.setupMaterial(m);});return this;}
  /* Refresh probesPerFrame probes, nearest to the camera first (a full sweep restarts when the list is exhausted). */
  update(camera,count=this.probesPerFrame){if(!this.enabled||!count)return 0;const R=this.renderer,T=this.THREE;
    if(!this._order.length){const c=camera?camera.position:this._v.set(0,0,0);this._order=this.probes.filter(p=>p.valid).sort((a,b)=>a.position.distanceToSquared(c)-b.position.distanceToSquared(c));}
    const prev=R.getRenderTarget(),tm=R.toneMapping,ac=R.autoClear,sm=R.shadowMap.autoUpdate,su=R.shadowMap.needsUpdate,fog=this.scene.fog;
    R.toneMapping=T.NoToneMapping;R.autoClear=true;R.shadowMap.autoUpdate=false;R.shadowMap.needsUpdate=false;let done=0;
    try{while(done<count&&this._order.length){const p=this._order.shift();this.cubeCamera.position.copy(p.position);this.cubeCamera.updateMatrixWorld(true);
        const cams=this.cubeCamera.children;for(let f=0;f<6;f++){R.setRenderTarget(this.cube,f);R.render(this.scene,cams[f]);}
        const u=this.projectMaterial.uniforms;u.uPosition.value.copy(p.position);u.uValid.value=1;u.uAlpha.value=p._seen?1-this.hysteresis:1;u.uRow0.value=p.row;
        this.atlas.viewport.set(p.col,p.row,1,TEXELS);this.atlas.scissor.set(p.col,p.row,1,TEXELS);this.atlas.scissorTest=true;this.quad.render(R,this.atlas);this.atlas.scissorTest=false;this.atlas.viewport.set(0,0,this.atlas.width,this.atlas.height);
        if(!p._seen){p._seen=true;this.capturedCount++;}done++;}}
    finally{R.setRenderTarget(prev);R.toneMapping=tm;R.autoClear=ac;R.shadowMap.autoUpdate=sm;R.shadowMap.needsUpdate=su;this.scene.fog=fog;}
    return done;}
  /* Capture every valid probe now (blocking); use at load time or after large lighting changes. */
  bake(camera){this._order.length=0;let n=0;do{n=this.update(camera,64);}while(n&&this._order.length);return this;}
  get progress(){return this.capturedCount/Math.max(1,this.probes.filter(p=>p.valid).length);}
  set strength(v){this.uniforms.keGIStrength.value=v;}get strength(){return this.uniforms.keGIStrength.value;}
  dispose(){this.onSettings&&this.onSettings();this.atlas.dispose();this.cube.dispose();this.projectMaterial.dispose();this.quad.dispose();
    for(const m of this.materials){const r=this.restore.get(m);m.onBeforeCompile=r.prev;if(r.ownKey)m.customProgramCacheKey=r.ownKey;else delete m.customProgramCacheKey;m.needsUpdate=true;}this.materials.clear();this.restore.clear();}
};
KE.registerModule('gi',{provides:['ProbeVolume','LAYERS.GI']});
})();
