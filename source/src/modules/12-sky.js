/* KE.SkyAtmosphere — physically based sky, volumetric clouds, sun/moon/stars and a real-time sky light.
   The sky (single-scattering Rayleigh + Mie + ozone atmosphere, Nishita-style) and raymarched volumetric
   clouds (tileable Perlin-Worley noise atlas generated on the GPU, multi-octave scattering approximation,
   dual-lobe phase, beer-powder) are rendered into a cube map one face per frame. The cube is the scene
   background, and every full refresh is prefiltered with PMREM into scene.environment so image-based
   lighting follows the time of day and weather. The directional light's colour and intensity come from the
   same atmosphere model's transmittance, and a matching horizon colour feeds height fog. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=KE.clamp,smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
/* Atmosphere constants in kilometres. */
const MAX_PATH=110,RG=6360,RT=6460,BETA_R=[5.802e-3,13.558e-3,33.1e-3],BETA_M=3.996e-3,BETA_MX=4.4e-3,HR=8,HM=1.2,BETA_O=[.650e-3,1.881e-3,.085e-3],G_M=.8;

const ATMOSPHERE_GLSL=`
const float MAX_PATH=${MAX_PATH.toFixed(1)};const float RG=${RG.toFixed(1)},RT=${RT.toFixed(1)},HR=${HR.toFixed(1)},HM=${HM.toFixed(1)},GM=${G_M};
const vec3 BR=vec3(${BETA_R.join(',')}),BO=vec3(${BETA_O.join(',')});const float BM=${BETA_M},BMX=${BETA_MX};
float kePlanetDist(float r,float mu,float R){float s=r*sqrt(max(1.-mu*mu,0.));float disc=(R-s)*(R+s);return disc<0.?-1.:-r*mu+sqrt(disc);}
float keGroundDisc(float r,float mu){float s=r*sqrt(max(1.-mu*mu,0.));return (RG-s)*(RG+s);}
bool keHitsGround(float r,float mu){return mu<0.&&keGroundDisc(r,mu)>=0.;}
vec3 keDensity(float h){return vec3(exp(-h/HR),exp(-h/HM),max(0.,1.-abs(h-25.)/15.));}
vec3 keExtinction(vec3 od){return BR*od.x+BMX*od.y+BO*od.z;}
vec3 keTransmittanceToTop(vec3 p,vec3 l){float r=length(p);float mu=dot(p,l)/r;if(keHitsGround(r,mu))return vec3(0.);float t=kePlanetDist(r,mu,RT);float ds=t/float(LIGHT_SAMPLES);vec3 od=vec3(0.);
 for(int i=0;i<LIGHT_SAMPLES;i++){vec3 q=p+l*(float(i)+.5)*ds;od+=keDensity(length(q)-RG)*ds;}return exp(-keExtinction(od));}
float kePhaseR(float mu){return .0596831*(1.+mu*mu);}
float kePhaseM(float mu){float g=GM,g2=g*g;return .1193662*(1.-g2)*(1.+mu*mu)/((2.+g2)*pow(max(1.+g2-2.*g*mu,1e-4),1.5));}
vec3 keScatter(vec3 ro,vec3 rd,vec3 l,float intensity,out vec3 viewT){float r=length(ro),mu=dot(ro,rd)/r;float tMax=kePlanetDist(r,mu,RT);if(keHitsGround(r,mu))tMax=min(tMax,-r*mu-sqrt(max(keGroundDisc(r,mu),0.)));tMax=min(tMax,MAX_PATH);
 float ds=tMax/float(VIEW_SAMPLES);vec3 od=vec3(0.),sr=vec3(0.),sm=vec3(0.);
 for(int i=0;i<VIEW_SAMPLES;i++){vec3 p=ro+rd*(float(i)+.5)*ds;vec3 d=keDensity(length(p)-RG)*ds;od+=d;vec3 T=exp(-keExtinction(od))*keTransmittanceToTop(p,l);sr+=d.x*T;sm+=d.y*T;}
 viewT=exp(-keExtinction(od));float c=dot(rd,l);return intensity*(sr*BR*kePhaseR(c)+sm*BM*kePhaseM(c));}`;

/* Tileable 3D noise: R = Perlin-Worley (cloud shape), GBA = Worley fBm at 2x/4x/8x (erosion detail).
   64³ voxels stored as an 8×8 grid of 64×64 slices in a 512² RGBA texture. */
const NOISE_FS=`varying vec2 vUv;
vec3 h3(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yxz+33.33);return fract((p.xxy+p.yxx)*p.zyx);}
float perlin(vec3 x,float P){vec3 i=floor(x),f=fract(x),u=f*f*f*(f*(f*6.-15.)+10.);float r=0.;
 #define G(o) dot(normalize(h3(mod(i+o,P))*2.-1.),f-o)
 r=mix(mix(mix(G(vec3(0,0,0)),G(vec3(1,0,0)),u.x),mix(G(vec3(0,1,0)),G(vec3(1,1,0)),u.x),u.y),mix(mix(G(vec3(0,0,1)),G(vec3(1,0,1)),u.x),mix(G(vec3(0,1,1)),G(vec3(1,1,1)),u.x),u.y),u.z);return r*.5+.5;}
float worley(vec3 x,float P){vec3 i=floor(x),f=fract(x);float d=1.;for(int z=-1;z<=1;z++)for(int y=-1;y<=1;y++)for(int k=-1;k<=1;k++){vec3 o=vec3(float(k),float(y),float(z));vec3 r=o+h3(mod(i+o,P))-f;d=min(d,dot(r,r));}return 1.-sqrt(d);}
float wfbm(vec3 p,float P){return worley(p*P,P)*.625+worley(p*P*2.,P*2.)*.25+worley(p*P*4.,P*4.)*.125;}
void main(){vec2 px=floor(vUv*512.);vec2 tile=floor(px/64.);vec3 p=(vec3(mod(px,64.),tile.y*8.+tile.x)+.5)/64.;
 float pf=perlin(p*4.,4.)*.5+perlin(p*8.,8.)*.25+perlin(p*16.,16.)*.125+perlin(p*32.,32.)*.0625;pf=pf/.9375;float w=wfbm(p,4.);
 pf=clamp((pf-.5)*2.4+.5,0.,1.);float pw=clamp(pf*.7+w*.45-.12,0.,1.);
 gl_FragColor=vec4(pw,wfbm(p,8.),wfbm(p,16.),wfbm(p,32.));}`;

const SKY_VS=`varying vec3 vDir;void main(){vDir=normalize((modelMatrix*vec4(position,0.)).xyz);gl_Position=projectionMatrix*viewMatrix*vec4(position,1.);gl_Position.z=gl_Position.w;}`;
const SKY_FS=`uniform vec3 uSun;uniform vec3 uMoon;uniform float uSunI;uniform float uMoonI;uniform float uAltitude;uniform vec3 uGround;uniform float uSkyScale;uniform float uNightGlow;
uniform sampler2D tNoise;uniform float uClouds;uniform float uCoverage;uniform float uCloudDensity;uniform vec2 uCloudLayer;uniform vec3 uWindOffset;uniform vec3 uCloudSun;uniform vec3 uCloudAmbTop;uniform vec3 uCloudAmbBottom;uniform float uFrame;
varying vec3 vDir;
${ATMOSPHERE_GLSL}
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
vec4 noise3(vec3 p){p=fract(p);float z=p.z*64.-.5;float z0=floor(z),f=z-z0;float s0=mod(z0+64.,64.),s1=mod(z0+1.,64.);vec2 xy=clamp(p.xy*64.,.5,63.5)/512.;
 vec2 t0=vec2(mod(s0,8.),floor(s0/8.))/8.,t1=vec2(mod(s1,8.),floor(s1/8.))/8.;return mix(texture2D(tNoise,t0+xy),texture2D(tNoise,t1+xy),f);}
float remap(float v,float a,float b,float c,float d){return c+(v-a)/(b-a)*(d-c);}
float weather(vec2 xz){vec4 n=noise3(vec3(xz*.012+uWindOffset.xz*.2,.37));vec4 m=noise3(vec3(xz*.031+uWindOffset.xz*.4,.71));return clamp(uCoverage+(n.r-.5)*.9+(m.g-.5)*.35,0.,1.);}
float cloudDensity(vec3 p,float h,bool detail){if(h<0.||h>1.)return 0.;vec3 q=p*.21+uWindOffset;float cov=weather(p.xz);vec4 n=noise3(q);
 float shape=smoothstep(0.,.09,h)*smoothstep(1.,.35+cov*.2,h);float base=remap(n.r*shape,1.-cov*.95,1.,0.,1.);if(base<=0.)return 0.;
 if(detail){vec4 d=noise3(q*3.7+uWindOffset*1.7);float det=d.g*.625+d.b*.25+d.a*.125;base=remap(base,mix(det,1.-det,clamp(h*3.,0.,1.))*.38,1.,0.,1.);}return max(base,0.)*uCloudDensity;}
float hg(float c,float g){float g2=g*g;return .0795775*(1.-g2)/pow(max(1.+g2-2.*g*c,1e-4),1.5);}
vec4 clouds(vec3 ro,vec3 rd,vec3 l){float r=length(ro),mu=dot(ro,rd)/r;float bot=RG+uCloudLayer.x,top=RG+uCloudLayer.y;
 if(rd.y<-.02)return vec4(0.,0.,0.,1.);float t0=kePlanetDist(r,mu,bot),t1=kePlanetDist(r,mu,top);if(t0<0.||t1<0.)return vec4(0.,0.,0.,1.);
 float len=min(t1-t0,12.);float ds=len/float(CLOUD_STEPS);float t=t0+ds*hash12(gl_FragCoord.xy+uFrame*.37);float T=1.;vec3 S=vec3(0.);float c=dot(rd,l);float thick=uCloudLayer.y-uCloudLayer.x;
 float ph=mix(hg(c,.75),hg(c,-.25),.35);
 for(int i=0;i<CLOUD_STEPS;i++){vec3 p=ro+rd*t;float h=(length(p)-bot)/thick;float d=cloudDensity(p,h,true);
  if(d>.003){float od=0.;float ls=thick*.07;vec3 lp=p;for(int j=0;j<5;j++){lp+=l*ls;od+=cloudDensity(lp,(length(lp)-bot)/thick,j<2)*ls;ls*=1.5;}
   vec3 lit=vec3(0.);float a=1.,b=1.,cc=1.;for(int k=0;k<3;k++){lit+=uCloudSun*a*mix(hg(c*cc,.75),hg(c*cc,-.25),.35)*exp(-od*b*42.);a*=.5;b*=.4;cc*=.6;}
   float powder=1.-exp(-d*30.);vec3 amb=mix(uCloudAmbBottom,uCloudAmbTop,clamp(h,0.,1.));vec3 Ls=lit*mix(.55,1.,powder)+amb;
   float ext=max(d*42.,1e-4);float Ts=exp(-ext*ds);S+=T*Ls*(1.-Ts);T*=Ts;if(T<.02)break;}
  t+=ds;}
 float fade=exp(-t0*.012)*smoothstep(-.02,.06,rd.y);return vec4(S*fade,mix(1.,T,fade));}
void main(){vec3 rd=normalize(vDir);vec3 ro=vec3(0.,RG+uAltitude,0.);vec3 rs=normalize(vec3(rd.x,max(rd.y,.004),rd.z));vec3 vt;vec3 col=keScatter(ro,rs,uSun,uSunI,vt);
 if(uMoonI>0.){vec3 vt2;col+=keScatter(ro,rs,uMoon,uMoonI,vt2);}
 col+=uNightGlow*vec3(.015,.025,.055)*(1.-rd.y*.5);
 if(rd.y<0.){float k=smoothstep(0.,-.2,rd.y);col=mix(col,uGround,k*.8);}
 if(uClouds>0.){vec4 cl=clouds(ro,rd,uSun.y>-.1?uSun:uMoon);col=col*cl.a+cl.rgb;}
 gl_FragColor=vec4(col*uSkyScale,1.);}`;

/* ---------- CPU mirror of the atmosphere model (fog colour, sun colour, ambient) ---------- */
function planetDist(r,mu,R){const s=r*Math.sqrt(Math.max(1-mu*mu,0)),disc=(R-s)*(R+s);return disc<0?-1:-r*mu+Math.sqrt(disc);}
function hitsGround(r,mu){return mu<0&&r*r*(mu*mu-1)+RG*RG>=0;}
function density(h,out){out[0]=Math.exp(-h/HR);out[1]=Math.exp(-h/HM);out[2]=Math.max(0,1-Math.abs(h-25)/15);return out;}
const _d=[0,0,0];
function transmittance(p,l,samples=12,out=[0,0,0]){const r=Math.hypot(p[0],p[1],p[2]),mu=(p[0]*l[0]+p[1]*l[1]+p[2]*l[2])/r;if(hitsGround(r,mu)){out[0]=out[1]=out[2]=0;return out;}
  const t=planetDist(r,mu,RT),ds=t/samples;let a=0,b=0,c=0;for(let i=0;i<samples;i++){const s=(i+.5)*ds,q0=p[0]+l[0]*s,q1=p[1]+l[1]*s,q2=p[2]+l[2]*s;density(Math.hypot(q0,q1,q2)-RG,_d);a+=_d[0]*ds;b+=_d[1]*ds;c+=_d[2]*ds;}
  for(let k=0;k<3;k++)out[k]=Math.exp(-(BETA_R[k]*a+BETA_MX*b+BETA_O[k]*c));return out;}
function scatter(rd,l,intensity,alt,out=[0,0,0]){const ro=[0,RG+alt,0],r=ro[1],mu=rd[1];let tMax=planetDist(r,mu,RT);if(hitsGround(r,mu))tMax=Math.min(tMax,-r*mu-Math.sqrt(Math.max(r*r*(mu*mu-1)+RG*RG,0)));tMax=Math.min(tMax,MAX_PATH);
  const N=12,ds=tMax/N;let od=[0,0,0],sr=[0,0,0],sm=[0,0,0];const T=[0,0,0],p=[0,0,0];
  for(let i=0;i<N;i++){const s=(i+.5)*ds;p[0]=rd[0]*s;p[1]=r+rd[1]*s;p[2]=rd[2]*s;density(Math.hypot(p[0],p[1],p[2])-RG,_d);const dr=_d[0]*ds,dm=_d[1]*ds;od[0]+=dr;od[1]+=dm;od[2]+=_d[2]*ds;transmittance(p,l,6,T);
    for(let k=0;k<3;k++){const e=Math.exp(-(BETA_R[k]*od[0]+BETA_MX*od[1]+BETA_O[k]*od[2]));sr[k]+=dr*e*T[k];sm[k]+=dm*e*T[k];}}
  const c=rd[0]*l[0]+rd[1]*l[1]+rd[2]*l[2],pr=.0596831*(1+c*c),g2=G_M*G_M,pm=.1193662*(1-g2)*(1+c*c)/((2+g2)*Math.pow(Math.max(1+g2-2*G_M*c,1e-4),1.5));
  for(let k=0;k<3;k++)out[k]=intensity*(sr[k]*BETA_R[k]*pr+sm[k]*BETA_M*pm);return out;}
KE.atmosphere={scatter,transmittance,RG,RT};

/* Procedural moon disc (craters, maria, limb darkening). */
function moonTexture(THREE){const S=256,c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d'),r=KE.random(77);g.clearRect(0,0,S,S);
  const grad=g.createRadialGradient(S*.45,S*.42,S*.05,S/2,S/2,S*.49);grad.addColorStop(0,'#f4f1e8');grad.addColorStop(.85,'#d6d2c6');grad.addColorStop(1,'#a8a499');g.fillStyle=grad;g.beginPath();g.arc(S/2,S/2,S*.49,0,Math.PI*2);g.fill();
  g.save();g.beginPath();g.arc(S/2,S/2,S*.49,0,Math.PI*2);g.clip();for(let i=0;i<7;i++){g.fillStyle=`rgba(120,118,112,${.18+r()*.14})`;g.beginPath();g.ellipse(S*(.25+r()*.5),S*(.25+r()*.5),S*(.06+r()*.12),S*(.05+r()*.09),r()*3,0,Math.PI*2);g.fill();}
  for(let i=0;i<60;i++){const x=r()*S,y=r()*S,cr=(1+r()*7)*S/256;g.strokeStyle='rgba(90,88,84,.35)';g.lineWidth=cr*.35;g.beginPath();g.arc(x,y,cr,0,Math.PI*2);g.stroke();g.fillStyle='rgba(255,255,250,.12)';g.beginPath();g.arc(x-cr*.2,y-cr*.2,cr*.6,0,Math.PI*2);g.fill();}g.restore();
  const t=new THREE.CanvasTexture(c);t.encoding=THREE.sRGBEncoding;return t;}

KE.SkyAtmosphere=class{
  constructor(THREE,renderer,scene,o={}){
    this.THREE=THREE;this.renderer=renderer;this.scene=scene;const caps=KE.capabilities(renderer);this.caps=caps;
    this.options=Object.assign({sun:null,moonLight:true,hemi:null,cubeSize:null,clouds:KE.settings.clouds,coverage:.42,cloudDensity:1,cloudLayer:[1.4,3.4],wind:[.012,.004],environment:true,background:true,
      sunIntensity:22,skyScale:1,sunLightIntensity:4.2,moonLightIntensity:.32,altitude:.05,stars:true,sunDisc:true,moonDisc:true,envInterval:1.25,groundColor:[.035,.045,.03],time:.22,lightDistance:120,
      envIntensityDay:1,envIntensityNight:.35},o);
    this.time=this.options.time;this.sunDirection=new THREE.Vector3(0,1,0);this.moonDirection=new THREE.Vector3(0,-1,0);this.lightDirection=new THREE.Vector3(0,1,0);this.manualSun=null;
    this.sunColor=new THREE.Color(1,1,1);this.fogColor=new THREE.Color(.6,.7,.8);this.zenithColor=new THREE.Color(.3,.45,.8);this.ambientSky=new THREE.Color();this.ambientGround=new THREE.Color();this.night=0;this.isNight=false;this.cloudTime=0;this.windOffset=new THREE.Vector3();
    this.face=0;this.envAge=1e9;this.envDirty=true;this.fullRefresh=true;this.frame=0;
    const half=caps.halfRT?THREE.HalfFloatType:THREE.UnsignedByteType;
    this.cubeSize=this.options.cubeSize||(this.options.clouds>=2?512:256);
    this.cube=new THREE.WebGLCubeRenderTarget(this.cubeSize,{type:half,format:THREE.RGBAFormat,generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter});
    this.cubeCamera=new THREE.CubeCamera(.1,10,this.cube);this.cubeCamera.updateMatrixWorld(true);
    // noise atlas generated once on the GPU
    this.noise=new THREE.WebGLRenderTarget(512,512,{type:THREE.UnsignedByteType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,wrapS:THREE.ClampToEdgeWrapping,wrapT:THREE.ClampToEdgeWrapping,depthBuffer:false});
    const nq=new KE.FullScreenQuad(THREE,new THREE.ShaderMaterial({vertexShader:KE.FULLSCREEN_VS,fragmentShader:NOISE_FS,depthTest:false,depthWrite:false}));nq.render(renderer,this.noise);nq.material.dispose();nq.dispose();
    this.uniforms={uSun:{value:new THREE.Vector3(0,1,0)},uMoon:{value:new THREE.Vector3(0,-1,0)},uSunI:{value:this.options.sunIntensity},uMoonI:{value:0},uAltitude:{value:this.options.altitude},uGround:{value:new THREE.Vector3()},uSkyScale:{value:this.options.skyScale},uNightGlow:{value:0},
      tNoise:{value:this.noise.texture},uClouds:{value:0},uCoverage:{value:this.options.coverage},uCloudDensity:{value:this.options.cloudDensity},uCloudLayer:{value:new THREE.Vector2(...this.options.cloudLayer)},uWindOffset:{value:this.windOffset},uCloudSun:{value:new THREE.Vector3()},
      uCloudAmbTop:{value:new THREE.Vector3()},uCloudAmbBottom:{value:new THREE.Vector3()},uFrame:{value:0}};
    this.skyMaterial=new THREE.ShaderMaterial({vertexShader:SKY_VS,fragmentShader:SKY_FS,uniforms:this.uniforms,side:THREE.BackSide,depthTest:false,depthWrite:false,toneMapped:false});this.setCloudQuality(this.options.clouds);
    this.skyScene=new THREE.Scene();this.skyMesh=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),this.skyMaterial);this.skyMesh.frustumCulled=false;this.skyScene.add(this.skyMesh);
    this.pmrem=new THREE.PMREMGenerator(renderer);this.pmrem.compileCubemapShader();this.envTarget=null;
    if(this.options.background)scene.background=this.cube.texture;
    // Sun and moon discs, stars: drawn in the main scene far away so they receive bloom and light shafts.
    this.group=new THREE.Group();this.group.name='ke-sky';scene.add(this.group);
    const disc=(size,fs,uniforms)=>{const m=new THREE.Mesh(new THREE.PlaneGeometry(size,size),new THREE.ShaderMaterial({uniforms,vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',fragmentShader:fs,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,fog:false,toneMapped:false}));m.frustumCulled=false;m.renderOrder=-10;this.group.add(m);return m;};
    this.sunMesh=disc(1,'uniform vec3 uColor;uniform float uGlow;varying vec2 vUv;void main(){vec2 d=vUv-.5;float r=length(d)*2.;float core=smoothstep(.2,.17,r);float limb=mix(.75,1.,sqrt(max(1.-r*r*25.,0.)));float glow=exp(-r*6.)*uGlow+exp(-r*18.)*uGlow*2.;gl_FragColor=vec4(uColor*(core*limb*40.+glow),1.);}',{uColor:{value:new THREE.Color(1,1,1)},uGlow:{value:.6}});
    this.moonTex=moonTexture(THREE);
    this.moonMesh=disc(1,'uniform sampler2D map;uniform float uI;uniform vec3 uLit;varying vec2 vUv;void main(){vec4 t=texture2D(map,vUv);vec2 d=vUv-.5;float r=length(d)*2.;float glow=exp(-r*4.)*.08;vec3 n=vec3(d*2.,sqrt(max(1.-dot(d*2.,d*2.),0.)));float lit=clamp(dot(n,uLit)*1.4+.15,0.,1.);gl_FragColor=vec4((t.rgb*t.a*lit*2.2+vec3(.55,.62,.8)*glow)*uI,1.);}',{map:{value:this.moonTex},uI:{value:1},uLit:{value:new THREE.Vector3(.4,.2,1).normalize()}});
    this.moonMesh.material.blending=THREE.NormalBlending;this.moonMesh.material.transparent=true;
    if(this.options.stars){const n=2400,r=KE.random(4242),pos=new Float32Array(n*3),col=new Float32Array(n*3);for(let i=0;i<n;i++){const u=r()*2-1,a=r()*Math.PI*2,s=Math.sqrt(1-u*u);pos.set([s*Math.cos(a),Math.abs(u)*.98+.02,s*Math.sin(a)],i*3);const m=Math.pow(r(),6)*3+.25,t=r();col.set([m*(t<.2?.8:1),m*(t<.2?.85:t>.9?.85:1),m*(t>.9?.7:1)],i*3);}
      const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('color',new THREE.BufferAttribute(col,3));
      this.stars=new THREE.Points(g,new THREE.ShaderMaterial({uniforms:{uOpacity:{value:0},uScale:{value:1},uTime:{value:0}},vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,fog:false,toneMapped:false,
        vertexShader:'uniform float uScale;uniform float uTime;varying vec3 vC;void main(){vC=color*(.75+.25*sin(uTime*2.3+position.x*91.+position.z*37.));vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;gl_PointSize=max(1.2,2.2*uScale*length(color));}',
        fragmentShader:'uniform float uOpacity;varying vec3 vC;void main(){vec2 d=gl_PointCoord-.5;float a=smoothstep(.5,.1,length(d));gl_FragColor=vec4(vC*a*uOpacity,1.);}'}));
      this.stars.frustumCulled=false;this.stars.renderOrder=-11;this.group.add(this.stars);}
    this._v=new THREE.Vector3();this._c=[0,0,0];this._t=[0,0,0];this.onSettings=KE.events.on('settings',s=>{if(s.clouds!==this.options.clouds)this.setCloudQuality(s.clouds);});
    this.update(0,null);this.fullRefresh=true;
  }
  /* 0 = no clouds, 1 = fast (24 steps), 2 = rich (48 steps, 512² faces recommended). */
  setCloudQuality(q){q=clamp(Math.round(q||0),0,2);this.options.clouds=q;const d=this.skyMaterial.defines;Object.assign(d,{VIEW_SAMPLES:q>=2?16:12,LIGHT_SAMPLES:q>=2?8:6,CLOUD_STEPS:q>=2?48:q===1?24:1});this.uniforms.uClouds.value=q>0?1:0;this.skyMaterial.needsUpdate=true;this.refresh();return this;}
  refresh(){this.fullRefresh=true;this.envDirty=true;this.envAge=1e9;return this;}
  /* Day fraction with the same convention as KE.dayCycle: 0 sunrise → .335 noon → .67 sunset, .67–1 night. */
  setTime(t){this.time=((t%1)+1)%1;this.manualSun=null;return this;}
  setSunDirection(v){this.manualSun=(this.manualSun||new this.THREE.Vector3()).copy(v).normalize();return this;}
  setWeather({coverage,density,wind}={}){if(coverage!==undefined)this.options.coverage=coverage;if(density!==undefined)this.options.cloudDensity=density;if(wind)this.options.wind=wind;this.envDirty=true;return this;}
  computeSun(){const d=this.time;let a;if(d<.67)a=d/.67*Math.PI;else a=Math.PI+(d-.67)/.33*Math.PI;
    const s=this.sunDirection;if(this.manualSun)s.copy(this.manualSun);else s.set(Math.cos(a)*.78,Math.sin(a)*.82,-.42+Math.cos(a)*.18).normalize();
    this.moonDirection.set(-s.x*.9+.15,Math.max(.12,-s.y*.85+.1),-s.z*.9-.2).normalize();}
  update(dt=0,camera=null){const T=this.THREE,o=this.options,U=this.uniforms;this.frame++;
    const prevSun=this._prevSun||(this._prevSun=new T.Vector3(0,-2,0));this.computeSun();const sun=this.sunDirection,elev=sun.y;
    this.night=1-smooth(-.12,.04,elev);this.isNight=elev<-.04;
    // Light: the sun by day, the moon by night, crossfading through twilight.
    const sp=[0,RG+o.altitude,0];transmittance(sp,[sun.x,sun.y,sun.z],12,this._t);const dayK=smooth(-.06,.03,elev);
    this.sunColor.setRGB(this._t[0],this._t[1],this._t[2]);const light=o.sun;
    if(light){const moonK=o.moonLight?smooth(-.02,-.12,elev):0;if(dayK>=moonK){this.lightDirection.copy(sun);light.color.copy(this.sunColor);light.intensity=o.sunLightIntensity*dayK;}else{this.lightDirection.copy(this.moonDirection);light.color.setRGB(.62,.72,1);light.intensity=o.moonLightIntensity*moonK;}
      const tgt=camera?camera.position:light.target.position;if(!light.target.parent)this.scene.add(light.target);light.target.position.set(tgt.x,0,tgt.z);light.position.copy(light.target.position).addScaledVector(this.lightDirection,o.lightDistance);light.target.updateMatrixWorld();}
    // Fog, zenith and ambient colours from the CPU atmosphere model (throttled).
    if(prevSun.distanceToSquared(sun)>1e-6||this.frame<3){const s=[sun.x,sun.y,sun.z],c=this._c;let fr=0,fg=0,fb=0;for(let k=0;k<4;k++){const a=k*Math.PI/2+.4,dir=[Math.cos(a)*.998,.05,Math.sin(a)*.998];scatter(dir,s,o.sunIntensity,o.altitude,c);fr+=c[0];fg+=c[1];fb+=c[2];}
      const nightFog=[.012,.018,.035];this.fogColor.setRGB(fr/4*o.skyScale+nightFog[0]*this.night,fg/4*o.skyScale+nightFog[1]*this.night,fb/4*o.skyScale+nightFog[2]*this.night);
      scatter([0,1,0],s,o.sunIntensity,o.altitude,c);this.zenithColor.setRGB(c[0]+.01*this.night,c[1]+.016*this.night,c[2]+.035*this.night);prevSun.copy(sun);}
    this.ambientSky.copy(this.zenithColor).lerp(this.fogColor,.5);this.ambientGround.setRGB(o.groundColor[0],o.groundColor[1],o.groundColor[2]).multiplyScalar(4*Math.max(elev,0)+.15);
    if(o.hemi){o.hemi.color.copy(this.ambientSky);o.hemi.groundColor.copy(this.ambientGround);}
    // Shader uniforms.
    this.cloudTime+=dt;this.windOffset.set(o.wind[0]*this.cloudTime,0,o.wind[1]*this.cloudTime);
    U.uSun.value.copy(sun);U.uMoon.value.copy(this.moonDirection);U.uSunI.value=o.sunIntensity;U.uMoonI.value=o.sunIntensity*.0035*this.night;U.uNightGlow.value=this.night;U.uSkyScale.value=o.skyScale;U.uCoverage.value=o.coverage;U.uCloudDensity.value=o.cloudDensity;
    U.uGround.value.set(o.groundColor[0],o.groundColor[1],o.groundColor[2]).multiplyScalar(Math.max(elev,0)*3+.08+.02*this.night);
    const cl=elev>-.1?this.sunColor:null,li=elev>-.1?o.sunIntensity*Math.max(dayK,.02):o.sunIntensity*.0035;if(cl)U.uCloudSun.value.set(cl.r*li,cl.g*li,cl.b*li);else U.uCloudSun.value.set(.62*li,.72*li,li);
    U.uCloudAmbTop.value.set(this.zenithColor.r,this.zenithColor.g,this.zenithColor.b).multiplyScalar(1.6);U.uCloudAmbBottom.value.copy(U.uCloudAmbTop.value).multiplyScalar(.62).add(this._v.set(this.ambientGround.r,this.ambientGround.g,this.ambientGround.b).multiplyScalar(.3));U.uFrame.value=this.frame%64;
    // Discs and stars follow the camera.
    if(camera){const far=camera.far*.8,p=camera.position;this.sunMesh.position.copy(p).addScaledVector(sun,far);this.sunMesh.scale.setScalar(far*.075);this.sunMesh.lookAt(p);this.sunMesh.visible=o.sunDisc&&elev>-.08;this.sunMesh.material.uniforms.uColor.value.copy(this.sunColor).multiplyScalar(dayK*1.4+.05);
      this.moonMesh.position.copy(p).addScaledVector(this.moonDirection,far*.97);this.moonMesh.scale.setScalar(far*.045);this.moonMesh.lookAt(p);this.moonMesh.visible=o.moonDisc&&this.night>.01;this.moonMesh.material.uniforms.uI.value=.25+this.night*1.2;
      if(this.stars){this.stars.position.copy(p);this.stars.scale.setScalar(far*.99);this.stars.material.uniforms.uOpacity.value=this.night*this.night*(1-o.coverage*.6);this.stars.material.uniforms.uTime.value+=dt;this.stars.visible=this.night>.02;}}
    // Time-sliced cube capture: one face per frame (all six on a full refresh), then PMREM when a cycle completes.
    const R=this.renderer,prev=R.getRenderTarget(),tm=R.toneMapping,ac=R.autoClear;R.toneMapping=T.NoToneMapping;R.autoClear=true;
    const faces=this.fullRefresh?6:1;const cams=this.cubeCamera.children;
    for(let i=0;i<faces;i++){R.setRenderTarget(this.cube,this.face);R.render(this.skyScene,cams[this.face]);this.face=(this.face+1)%6;}
    R.setRenderTarget(prev);R.toneMapping=tm;R.autoClear=ac;
    this.envAge+=dt;if(this.face===0||this.fullRefresh){if(o.environment&&(this.fullRefresh||this.envAge>=o.envInterval)){this.updateEnvironment();this.envAge=0;}}
    this.fullRefresh=false;return this;}
  updateEnvironment(){const R=this.renderer,prev=R.getRenderTarget();const rt=this.pmrem.fromCubemap(this.cube.texture);R.setRenderTarget(prev);
    if(this.envTarget)this.envTarget.dispose();this.envTarget=rt;this.scene.environment=rt.texture;this.environment=rt.texture;return rt.texture;}
  /* Recommended envMapIntensity for standard materials at the current time (dimmer at night). */
  get envIntensity(){return this.options.envIntensityDay+(this.options.envIntensityNight-this.options.envIntensityDay)*this.night;}
  dispose(){this.onSettings&&this.onSettings();if(this.scene.background===this.cube.texture)this.scene.background=null;if(this.envTarget&&this.scene.environment===this.envTarget.texture)this.scene.environment=null;
    this.cube.dispose();this.noise.dispose();this.skyMaterial.dispose();this.skyMesh.geometry.dispose();if(this.envTarget)this.envTarget.dispose();this.pmrem.dispose();this.moonTex.dispose();KE.disposeObject(this.group);}
};
KE.registerModule('sky',{provides:['SkyAtmosphere','atmosphere']});
})();
