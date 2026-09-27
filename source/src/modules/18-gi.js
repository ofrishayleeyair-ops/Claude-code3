/* KE.ProbeVolume — dynamic diffuse global illumination from a grid of irradiance probes.
   Probes are refreshed a few per frame (nearest to the camera first): each renders a small cube map of the
   scene's GI layer (static geometry, sky background, direct light and — because lit materials themselves
   sample the volume — previously gathered bounce light, so bounces accumulate over refreshes), which a GPU
   pass projects onto order-1 spherical harmonics and blends into a probe atlas with hysteresis. Lit
   materials that are set up replace their sky-only diffuse image lighting with trilinearly interpolated,
   normal-weighted probe irradiance, and scale specular reflections by the probe/sky ratio so enclosed spaces
   stop reflecting the open sky. Each probe also stores distance moments (mean, mean²) per octahedral texel
   from a two-sided distance cube pass; shading applies a Chebyshev visibility test (as in DDGI) so probes behind
   walls stop leaking light, and probes that see mostly back faces (buried inside geometry) are switched off.
   Probes cannot capture objects outside the GI layer. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
KE.LAYERS.GI=KE.LAYERS.GI||2;
const TEXELS=5;// 4 SH (L0, L1y, L1z, L1x) + position/validity
const VT=8;// octahedral visibility tile size per probe (texels)

const PROJECT_FS=`uniform samplerCube tCube;uniform vec3 uPosition;uniform float uValid;uniform float uAlpha;uniform float uRow0;
void main(){int k=int(floor(gl_FragCoord.y-uRow0));if(k>=4){gl_FragColor=vec4(uPosition,uValid);return;}
 vec3 acc=vec3(0.);const int N=128;float ga=2.39996323;
 for(int i=0;i<N;i++){float y=1.-(float(i)+.5)/float(N)*2.;float r=sqrt(max(1.-y*y,0.));float a=float(i)*ga;vec3 d=vec3(cos(a)*r,y,sin(a)*r);vec3 L=textureCube(tCube,d).rgb;
  float Y=k==0?.282095:k==1?.488603*d.y:k==2?.488603*d.z:.488603*d.x;acc+=min(L,vec3(64.))*Y;}
 gl_FragColor=vec4(acc*12.566371/float(N),uAlpha);}`;

const OCT_GLSL=`vec2 keOctEncode(vec3 n){n/=abs(n.x)+abs(n.y)+abs(n.z);vec2 e=n.xz;if(n.y<0.)e=(1.-abs(e.yx))*vec2(e.x>=0.?1.:-1.,e.y>=0.?1.:-1.);return e;}
vec3 keOctDecode(vec2 e){vec3 n=vec3(e.x,1.-abs(e.x)-abs(e.y),e.y);if(n.y<0.){vec2 t=n.xz;n.xz=(1.-abs(t.yx))*vec2(t.x>=0.?1.:-1.,t.y>=0.?1.:-1.);}return normalize(n);}`;
/* Distance moments for one probe tile: each texel averages distance and distance² over a small cone.
   The blue channel holds the probe's back-face fraction over the whole sphere (same value in every texel). */
const VIS_FS=`uniform samplerCube tDist;uniform vec2 uTile0;uniform float uFar;uniform float uAlpha;
${OCT_GLSL}
void main(){vec2 t=gl_FragCoord.xy-uTile0;vec2 e=(t-.5)/${(VT-1).toFixed(1)}*2.-1.;vec3 dir=keOctDecode(e);vec3 up=abs(dir.y)<.99?vec3(0.,1.,0.):vec3(1.,0.,0.);vec3 tx=normalize(cross(up,dir)),ty=cross(dir,tx);
 float m1=0.,m2=0.;for(int i=0;i<16;i++){float a=float(i)*2.39996323;float r=sqrt((float(i)+.5)/16.)*.3;vec3 d=normalize(dir+(tx*cos(a)+ty*sin(a))*r);float dist=textureCube(tDist,d).r*uFar;m1+=dist;m2+=dist*dist;}
 float back=0.;for(int i=0;i<48;i++){float y=1.-(float(i)+.5)/48.*2.;float r=sqrt(max(1.-y*y,0.));float a=float(i)*2.39996323;back+=textureCube(tDist,vec3(cos(a)*r,y,sin(a)*r)).g;}
 gl_FragColor=vec4(m1/16.,m2/16.,back/48.,uAlpha);}`;
/* Two-sided distance pass: normalised distance to the probe and a back-face flag. */
const DIST_FS=`uniform vec3 uRef;uniform float uFar;varying vec3 vWorldPosition;
void main(){gl_FragColor=vec4(length(vWorldPosition-uRef)/uFar,gl_FrontFacing?0.:1.,0.,1.);}`;

/* Irradiance lookup injected into lit materials. */
const GI_PARS=`uniform sampler2D keProbeAtlas;uniform vec2 keProbeAtlasSize;uniform sampler2D keProbeVis;uniform vec2 keProbeVisSize;uniform float keProbeVisOn;uniform vec3 keProbeMin;uniform vec3 keProbeStep;uniform vec3 keProbeCount;uniform float keGIStrength;uniform float keGIOn;varying vec3 vKeWorld;
${OCT_GLSL}
vec2 keProbeVisibility(vec3 c,vec3 probePos,vec3 P,vec3 N){if(keProbeVisOn<.5)return vec2(1.);vec3 dv=P+N*.2-probePos;float dist=length(dv);vec2 e=keOctEncode(dv/max(dist,1e-4));
 vec2 t=(e*.5+.5)*${(VT-1).toFixed(1)}+.5;vec2 uv=(vec2(c.x+c.z*keProbeCount.x,c.y)*${VT.toFixed(1)}+t)/keProbeVisSize;vec3 m=texture2D(keProbeVis,uv).rgb;
 float alive=1.-smoothstep(.2,.35,m.z);if(m.x<=0.||dist<=m.x)return vec2(1.,alive);
 float v=max(abs(m.y-m.x*m.x),.01);float d=dist-m.x;float ch=v/(v+d*d);return vec2(max(ch*ch*ch,.05),alive);}
vec4 keProbeTexel(vec3 c,float k){float col=c.x+c.z*keProbeCount.x;float row=c.y*${TEXELS}.+k;return texture2D(keProbeAtlas,(vec2(col,row)+.5)/keProbeAtlasSize);}
vec3 keProbeIrradiance(vec3 P,vec3 N,out float valid){vec3 g=clamp((P+N*.35-keProbeMin)/keProbeStep,vec3(0.),keProbeCount-1.001);vec3 b=floor(g),f=g-b;vec3 E=vec3(0.);float ws=0.,alive=0.;valid=0.;
 for(int i=0;i<8;i++){vec3 o=vec3(float(i-(i/2)*2),float((i/2)-(i/4)*2),float(i/4));vec3 c=b+o;vec3 tw=mix(1.-f,f,o);float w=tw.x*tw.y*tw.z;
  vec4 pv=keProbeTexel(c,4.);if(pv.a<.01||w<1e-5)continue;valid+=pv.a*w;vec3 dir=normalize(pv.xyz-P+1e-4);float bw=(dot(dir,N)+1.)*.5;w*=bw*bw+.08;vec2 vis=keProbeVisibility(c,pv.xyz,P,N);alive+=pv.a*vis.y*tw.x*tw.y*tw.z;w*=pv.a*vis.x*vis.y;if(w<1e-6)continue;
  vec3 c0=keProbeTexel(c,0.).rgb,c1=keProbeTexel(c,1.).rgb,c2=keProbeTexel(c,2.).rgb,c3=keProbeTexel(c,3.).rgb;
  vec3 e=3.141593*.282095*c0+2.094395*.488603*(c1*N.y+c2*N.z+c3*N.x);E+=max(e,vec3(0.))*w;ws+=w;}
 // Buried probes are dropped and the rest renormalised; with none left, fall back to the sky light.
 valid*=smoothstep(0.,.08,alive);return ws>1e-5?E/ws:vec3(0.);}`;
function buildMapsChunk(THREE){const src=THREE.ShaderChunk.lights_fragment_maps;
  const irr=/iblIrradiance \+= getLightProbeIndirectIrradiance\([^;]*\);/,rad=/radiance \+= (getLightProbeIndirectRadiance\([^;]*geometry\.normal[^;]*\);)/;
  if(!irr.test(src)||!rad.test(src))throw new Error('KE.ProbeVolume: unexpected lights_fragment_maps chunk (Three.js r128 required)');
  return 'float keSpecOcc=1.;\n'+src.replace(irr,`vec3 keSkyE=getLightProbeIndirectIrradiance( geometry, maxMipLevel );float keValid=0.;vec3 keWN=inverseTransformDirection(geometry.normal,viewMatrix);
		vec3 keProbeE=keGIOn>.5?keProbeIrradiance(vKeWorld,keWN,keValid)*envMapIntensity*keGIStrength:vec3(0.);float keW=clamp(keValid,0.,1.)*keGIOn;
		iblIrradiance+=mix(keSkyE,keProbeE,keW);float keLs=dot(keSkyE,vec3(.2126,.7152,.0722)),keLp=dot(keProbeE,vec3(.2126,.7152,.0722));keSpecOcc=mix(1.,clamp(keLp/max(keLs,1e-4),.08,1.),keW);`)
    .replace(rad,'radiance += keSpecOcc * $1');}

KE.ProbeVolume=class{
  constructor(THREE,renderer,scene,{bounds,spacing=8,counts=null,heightAt=null,lift=.8,faceSize=16,probesPerFrame=2,hysteresis=.8,strength=1,far=80,visibility=true}={}){
    if(!bounds||!bounds.isBox3)throw new TypeError('KE.ProbeVolume requires {bounds: THREE.Box3}');
    Object.assign(this,{THREE,renderer,scene,heightAt,lift,probesPerFrame,hysteresis,enabled:true});
    const size=bounds.getSize(new THREE.Vector3());this.count=counts?new THREE.Vector3(...counts):new THREE.Vector3(Math.max(2,Math.round(size.x/spacing)+1),Math.max(2,Math.round(size.y/spacing)+1),Math.max(2,Math.round(size.z/spacing)+1));
    this.min=bounds.min.clone();this.step=new THREE.Vector3(size.x/(this.count.x-1),size.y/(this.count.y-1),size.z/(this.count.z-1));
    const n=this.count.x*this.count.y*this.count.z;this.total=n;const W=this.count.x*this.count.z,H=this.count.y*TEXELS,caps=KE.capabilities(renderer);
    // The atlas is blended into (hysteresis): float32 only where EXT_float_blend allows it (about half of iOS devices lack it), else half float.
    this.atlas=new THREE.WebGLRenderTarget(W,H,{type:caps.floatRT&&caps.floatBlend?THREE.FloatType:THREE.HalfFloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:false,stencilBuffer:false,generateMipmaps:false});
    this.cube=new THREE.WebGLCubeRenderTarget(faceSize,{type:caps.halfRT?THREE.HalfFloatType:THREE.UnsignedByteType,format:THREE.RGBAFormat,generateMipmaps:false,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
    this.cubeCamera=new THREE.CubeCamera(.1,far,this.cube);this.cubeCamera.children.forEach(c=>c.layers.set(KE.LAYERS.GI));this.cubeCamera.updateMatrixWorld(true);
    this.projectMaterial=new THREE.ShaderMaterial({vertexShader:KE.FULLSCREEN_VS,fragmentShader:PROJECT_FS,uniforms:{tCube:{value:this.cube.texture},uPosition:{value:new THREE.Vector3()},uValid:{value:1},uAlpha:{value:1},uRow0:{value:0}},depthTest:false,depthWrite:false,transparent:true,blending:THREE.CustomBlending,blendSrc:THREE.SrcAlphaFactor,blendDst:THREE.OneMinusSrcAlphaFactor,blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.ZeroFactor});
    this.quad=new KE.FullScreenQuad(THREE,this.projectMaterial);this.far=far;
    // Visibility: packed distance cube (MeshDistanceMaterial override) → per-probe octahedral moment tiles.
    // Needs a half-float (or float) colour target; without one visibility is switched off.
    if(visibility&&!caps.halfRT&&!caps.floatRT)visibility=false;
    this.visibility=visibility;
    this.distCube=new THREE.WebGLCubeRenderTarget(faceSize,{type:caps.halfRT?THREE.HalfFloatType:THREE.FloatType,format:THREE.RGBAFormat,generateMipmaps:false,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
    const dvs=THREE.ShaderLib.distanceRGBA.vertexShader;
    this.distMaterial=new THREE.ShaderMaterial({vertexShader:(/#define DISTANCE/.test(dvs)?'':'#define DISTANCE\n')+dvs,fragmentShader:DIST_FS,uniforms:{uRef:{value:new THREE.Vector3()},uFar:{value:far}},side:THREE.DoubleSide});
    this.vis=new THREE.WebGLRenderTarget(W*VT,this.count.y*VT,{type:caps.halfRT?THREE.HalfFloatType:THREE.FloatType,format:THREE.RGBAFormat,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false,stencilBuffer:false,generateMipmaps:false});
    this.visMaterial=new THREE.ShaderMaterial({vertexShader:KE.FULLSCREEN_VS,fragmentShader:VIS_FS,uniforms:{tDist:{value:this.distCube.texture},uTile0:{value:new THREE.Vector2()},uFar:{value:far},uAlpha:{value:1}},depthTest:false,depthWrite:false,transparent:true,blending:THREE.CustomBlending,blendSrc:THREE.SrcAlphaFactor,blendDst:THREE.OneMinusSrcAlphaFactor,blendSrcAlpha:THREE.OneFactor,blendDstAlpha:THREE.ZeroFactor});
    this.uniforms={keProbeAtlas:{value:this.atlas.texture},keProbeAtlasSize:{value:new THREE.Vector2(W,H)},keProbeVis:{value:this.vis.texture},keProbeVisSize:{value:new THREE.Vector2(W*VT,this.count.y*VT)},keProbeVisOn:{value:visibility?1:0},keProbeMin:{value:this.min},keProbeStep:{value:this.step},keProbeCount:{value:this.count.clone()},keGIStrength:{value:strength},keGIOn:{value:1}};
    this.mapsChunk=buildMapsChunk(THREE);this.materials=new Set();this.restore=new Map();this.probes=[];this.capturedCount=0;
    for(let iy=0;iy<this.count.y;iy++)for(let iz=0;iz<this.count.z;iz++)for(let ix=0;ix<this.count.x;ix++){const p=new THREE.Vector3(this.min.x+ix*this.step.x,this.min.y+iy*this.step.y,this.min.z+iz*this.step.z);let valid=1;
      if(heightAt){const g=heightAt(p.x,p.z);if(p.y<g+lift)p.y=g+lift;if(p.y>this.min.y+(iy+.999)*this.step.y&&iy<this.count.y-1)valid=0;}this.probes.push({ix,iy,iz,position:p,valid,col:ix+iz*this.count.x,row:iy*TEXELS});}
    // Clear the atlas (validity 0 → materials fall back to the sky light until probes arrive).
    const R=renderer,prev=R.getRenderTarget(),cc=R.getClearColor(new THREE.Color()),ca=R.getClearAlpha();R.setClearColor(0x000000,0);for(const t of [this.atlas,this.vis]){R.setRenderTarget(t);R.clear(true,false,false);}R.setClearColor(cc,ca);R.setRenderTarget(prev);
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
        if(this.visibility){const bg=this.scene.background,ov=this.scene.overrideMaterial,cc=R.getClearColor(this._c||(this._c=new T.Color())),ca=R.getClearAlpha();this.scene.background=null;this.scene.overrideMaterial=this.distMaterial;this.distMaterial.uniforms.uRef.value.copy(p.position);R.setClearColor(0xff0000,1);
          try{for(let f=0;f<6;f++){R.setRenderTarget(this.distCube,f);R.render(this.scene,cams[f]);}}finally{this.scene.background=bg;this.scene.overrideMaterial=ov;R.setClearColor(cc,ca);}
          const vu=this.visMaterial.uniforms;vu.uTile0.value.set(p.col*VT,p.iy*VT);vu.uAlpha.value=p._seen?1-this.hysteresis:1;
          this.vis.viewport.set(p.col*VT,p.iy*VT,VT,VT);this.vis.scissor.copy(this.vis.viewport);this.vis.scissorTest=true;this.quad.render(R,this.vis,this.visMaterial);this.vis.scissorTest=false;this.vis.viewport.set(0,0,this.vis.width,this.vis.height);this.quad.material=this.projectMaterial;}
        const u=this.projectMaterial.uniforms;u.uPosition.value.copy(p.position);u.uValid.value=1;u.uAlpha.value=p._seen?1-this.hysteresis:1;u.uRow0.value=p.row;
        this.atlas.viewport.set(p.col,p.row,1,TEXELS);this.atlas.scissor.set(p.col,p.row,1,TEXELS);this.atlas.scissorTest=true;this.quad.render(R,this.atlas);this.atlas.scissorTest=false;this.atlas.viewport.set(0,0,this.atlas.width,this.atlas.height);
        if(!p._seen){p._seen=true;this.capturedCount++;}done++;}}
    finally{R.setRenderTarget(prev);R.toneMapping=tm;R.autoClear=ac;R.shadowMap.autoUpdate=sm;R.shadowMap.needsUpdate=su;this.scene.fog=fog;}
    return done;}
  /* Capture every valid probe now (blocking); use at load time or after large lighting changes. */
  bake(camera){this._order.length=0;let n=0;do{n=this.update(camera,64);}while(n&&this._order.length);return this;}
  get progress(){return this.capturedCount/Math.max(1,this.probes.filter(p=>p.valid).length);}
  set strength(v){this.uniforms.keGIStrength.value=v;}get strength(){return this.uniforms.keGIStrength.value;}
  dispose(){this.onSettings&&this.onSettings();this.atlas.dispose();this.cube.dispose();this.projectMaterial.dispose();this.quad.dispose();this.vis.dispose();this.distCube.dispose();this.distMaterial.dispose();this.visMaterial.dispose();
    for(const m of this.materials){const r=this.restore.get(m);m.onBeforeCompile=r.prev;if(r.ownKey)m.customProgramCacheKey=r.ownKey;else delete m.customProgramCacheKey;m.needsUpdate=true;}this.materials.clear();this.restore.clear();}
};
KE.registerModule('gi',{provides:['ProbeVolume','LAYERS.GI']});
})();
