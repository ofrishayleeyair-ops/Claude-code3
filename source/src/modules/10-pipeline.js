/* KE.Pipeline — the Tenko HDR frame pipeline.
   Frame: jittered opaque pass → scene colour/depth copies (shared through KE.sceneUniforms) → translucent layer
   (water, soft particles, refraction) → GTAO + screen-space indirect light (half res, denoised) → lighting
   composite with exponential height fog and sun inscattering → light shafts → temporal anti-aliasing with
   depth reprojection and variance clipping → depth of field → motion blur → multi-mip bloom → eye adaptation
   → ACES tone mapping, white balance, colour grading and lens effects (→ FXAA when TAA is off).
   All targets are sized from the renderer's drawing buffer and rebuilt automatically when it changes. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=KE.clamp,halton=(i,b)=>{let f=1,r=0;while(i>0){f/=b;r+=f*(i%b);i=Math.floor(i/b);}return r;};
const TRANSLUCENT_BIT=1<<KE.LAYERS.TRANSLUCENT;

/* Shared GLSL for passes that reconstruct geometry from the hardware depth buffer. */
const DEPTH_GLSL=`uniform sampler2D tDepth;uniform mat4 uInvProj;uniform vec2 uTexel;uniform float uNear;uniform float uFar;
float rawDepth(vec2 uv){return texture2D(tDepth,uv).x;}
vec3 viewPosAt(vec2 uv,float d){vec4 p=uInvProj*vec4(vec3(uv,d)*2.-1.,1.);return p.xyz/p.w;}
vec2 snapUV(vec2 uv){return (floor(uv/uTexel)+.5)*uTexel;}
vec3 viewPosAt(vec2 uv){uv=snapUV(uv);return viewPosAt(uv,rawDepth(uv));}
vec3 viewNormalAt(vec2 uv,vec3 c){vec3 l=viewPosAt(uv-vec2(uTexel.x,0.)),r=viewPosAt(uv+vec2(uTexel.x,0.)),b=viewPosAt(uv-vec2(0.,uTexel.y)),t=viewPosAt(uv+vec2(0.,uTexel.y));
 vec3 dx=abs(r.z-c.z)<abs(c.z-l.z)?r-c:c-l;vec3 dy=abs(t.z-c.z)<abs(c.z-b.z)?t-c:c-b;return normalize(cross(dx,dy));}
float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}`;
const VS=KE.FULLSCREEN_VS;

/* Screen-space reflection helper for translucent-layer materials (water, glossy opt-in materials).
   Marches the reflected view ray against the opaque linear depth copy; returns rgb + confidence. */
KE.GLSL.ssr=`vec4 keTraceSSR(vec3 vpos,vec3 vnormal,float roughness,float jitter){
 if(keHasScene<.5||keSSR<.5)return vec4(0.);
 vec3 dir=normalize(reflect(normalize(vpos),vnormal));if(dir.z>.2)return vec4(0.);
 float maxDist=min(60.,keNearFar.y*.5);float stepLen=maxDist/40.;vec3 p=vpos+dir*stepLen*(.5+jitter);vec2 hitUV=vec2(-1.);float thickness=.8;
 for(int i=0;i<40;i++){vec4 clip=keProjection*vec4(p,1.);vec2 uv=clip.xy/clip.w*.5+.5;if(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)break;
  float sceneZ=texture2D(keSceneDepth,uv).r;float rayZ=-p.z;float diff=rayZ-sceneZ;
  if(diff>0.&&diff<thickness+stepLen*1.5){vec3 a=p-dir*stepLen,b=p;for(int j=0;j<5;j++){vec3 m=(a+b)*.5;vec4 cm=keProjection*vec4(m,1.);vec2 um=cm.xy/cm.w*.5+.5;if(-m.z>texture2D(keSceneDepth,um).r)b=m;else a=m;}
   vec4 cb=keProjection*vec4(b,1.);hitUV=cb.xy/cb.w*.5+.5;break;}
  p+=dir*stepLen;stepLen*=1.06;}
 if(hitUV.x<0.)return vec4(0.);
 vec2 e=smoothstep(0.,.12,hitUV)*smoothstep(1.,.88,hitUV);float conf=e.x*e.y*(1.-smoothstep(.3,.7,roughness))*smoothstep(.2,-.1,dir.z);
 return vec4(texture2D(keSceneColor,hitUV).rgb,conf);}`;

const GTAO_FS=`${DEPTH_GLSL}
uniform float uRadius;uniform float uProjScale;uniform float uFrame;uniform float uPower;varying vec2 vUv;
void main(){vec2 uv=snapUV(vUv);float d=rawDepth(uv);if(d>=1.){gl_FragColor=vec4(1.,uFar,0.,1.);return;}
 vec3 P=viewPosAt(uv,d),N=viewNormalAt(uv,P),V=normalize(-P);float radiusPx=min(uRadius*uProjScale/max(-P.z,1e-3),160.);
 if(radiusPx<1.5){gl_FragColor=vec4(1.,-P.z,0.,1.);return;}
 float ns=ign(gl_FragCoord.xy+uFrame*5.588238),nt=ign(gl_FragCoord.yx*1.37+uFrame*7.41),vis=0.;
 for(int s=0;s<SLICES;s++){float phi=(float(s)+ns)/float(SLICES)*3.14159265;vec2 om=vec2(cos(phi),sin(phi));vec3 dv=vec3(om,0.);vec3 od=dv-dot(dv,V)*V;vec3 ax=normalize(cross(od,V)+1e-6);
  vec3 pn=N-ax*dot(N,ax);float pl=length(pn)+1e-5;float cn=clamp(dot(pn,V)/pl,0.,1.);float n=sign(dot(od,pn))*acos(cn);float lo0=cos(n+1.5707963),lo1=cos(n-1.5707963),h0c=lo0,h1c=lo1;
  for(int j=0;j<STEPS;j++){float t=(float(j)+nt)/float(STEPS);t*=t;vec2 off=om*max(t*radiusPx,float(j)+1.)*uTexel;
   vec3 s0=viewPosAt(uv+off)-P,s1=viewPosAt(uv-off)-P;float l0=length(s0),l1=length(s1);
   float w0=clamp(1.-l0*l0/(uRadius*uRadius),0.,1.),w1=clamp(1.-l1*l1/(uRadius*uRadius),0.,1.);
   h0c=max(h0c,mix(lo0,dot(s0,V)/max(l0,1e-4),w0));h1c=max(h1c,mix(lo1,dot(s1,V)/max(l1,1e-4),w1));}
  float h0=-acos(clamp(h1c,-1.,1.)),h1=acos(clamp(h0c,-1.,1.));h0=n+clamp(h0-n,-1.5707963,1.5707963);h1=n+clamp(h1-n,-1.5707963,1.5707963);
  vis+=pl*((cn+2.*h0*sin(n)-cos(2.*h0-n))+(cn+2.*h1*sin(n)-cos(2.*h1-n)))*.25;}
 vis=pow(clamp(vis/float(SLICES),0.,1.),uPower);gl_FragColor=vec4(max(vis,.03),-P.z,0.,1.);}`;

/* Depth-aware separable blur for half-resolution AO/GI (value in rgb or r, linear depth in the last used channel). */
const BILATERAL_FS=`uniform sampler2D tSrc;uniform vec2 uDir;uniform float uDepthChannel;varying vec2 vUv;
vec4 fetch(vec2 uv){return texture2D(tSrc,uv);}float dz(vec4 v){return uDepthChannel>.5?v.a:v.g;}
void main(){vec4 c=fetch(vUv);float z=dz(c),ws=1.;vec4 acc=c;
 for(int i=1;i<=4;i++){for(int s=-1;s<=1;s+=2){vec4 v=fetch(vUv+uDir*float(i*s));float w=exp(-float(i*i)/8.)*exp(-abs(dz(v)-z)/(.02*z+.05));acc+=v*w;ws+=w;}}
 acc/=ws;if(uDepthChannel>.5)acc.a=z;else acc.g=z;gl_FragColor=acc;}`;

/* Screen-space indirect diffuse: cosine-distributed rays marched against depth, radiance from last frame's
   reprojected lit image, then temporally accumulated. No albedo buffer exists, so bounce colour is applied
   using the receiving pixel's chroma (see composite). */
const SSGI_FS=`${DEPTH_GLSL}
uniform sampler2D tPrevColor;uniform mat4 uProj;uniform mat4 uInvView;uniform mat4 uPrevViewProj;uniform float uFrame;uniform float uGIRadius;varying vec2 vUv;
vec2 reproject(vec3 vp){vec4 w=uInvView*vec4(vp,1.);vec4 c=uPrevViewProj*w;return c.xy/c.w*.5+.5;}
void main(){vec2 uv0=snapUV(vUv);float d=rawDepth(uv0);if(d>=1.){gl_FragColor=vec4(0.,0.,0.,uFar);return;}
 vec3 P=viewPosAt(uv0,d),N=viewNormalAt(uv0,P);vec3 T=normalize(abs(N.y)<.99?cross(N,vec3(0.,1.,0.)):cross(N,vec3(1.,0.,0.)));vec3 B=cross(N,T);vec3 acc=vec3(0.);
 for(int r=0;r<RAYS;r++){vec2 xi=vec2(ign(gl_FragCoord.xy+float(r)*17.31+uFrame*3.7),ign(gl_FragCoord.yx+float(r)*9.13+uFrame*5.3));
  float phi=6.2831853*xi.x,ct=sqrt(1.-xi.y),st=sqrt(xi.y);vec3 dir=normalize(T*cos(phi)*st+B*sin(phi)*st+N*ct);
  float stepLen=uGIRadius/float(STEPS);vec3 p=P+N*.05+dir*stepLen*xi.y;
  for(int i=0;i<STEPS;i++){vec4 c=uProj*vec4(p,1.);vec2 uv=snapUV(c.xy/c.w*.5+.5);if(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)break;float sd=rawDepth(uv);vec3 sp=viewPosAt(uv,sd);float diff=sp.z-p.z;
   if(diff>0.&&diff<uGIRadius*.5&&sd<1.){vec2 pu=reproject(sp);if(pu.x>0.&&pu.y>0.&&pu.x<1.&&pu.y<1.){float fall=1.-float(i)/float(STEPS);acc+=texture2D(tPrevColor,pu).rgb*fall;}break;}
   p+=dir*stepLen;}}
 gl_FragColor=vec4(acc/float(RAYS),-P.z);}`;
const SSGI_TEMPORAL_FS=`${DEPTH_GLSL}
uniform sampler2D tCurrent;uniform sampler2D tHistory;uniform mat4 uInvView;uniform mat4 uPrevViewProj;uniform float uValid;varying vec2 vUv;
void main(){vec4 cur=texture2D(tCurrent,vUv);float d=rawDepth(vUv);if(d>=1.||uValid<.5){gl_FragColor=cur;return;}vec3 vp=viewPosAt(vUv,d);vec4 w=uInvView*vec4(vp,1.);vec4 c=uPrevViewProj*w;vec2 pu=c.xy/c.w*.5+.5;
 if(pu.x<0.||pu.y<0.||pu.x>1.||pu.y>1.){gl_FragColor=cur;return;}vec4 h=texture2D(tHistory,pu);float valid=1.-smoothstep(.05,.2,abs(h.a-cur.a)/max(cur.a,.1));
 gl_FragColor=vec4(mix(cur.rgb,h.rgb,.9*valid),cur.a);}`;

const COPY_FS=`uniform sampler2D tSrc;varying vec2 vUv;void main(){gl_FragColor=texture2D(tSrc,vUv);}`;
const LINEAR_DEPTH_FS=`${DEPTH_GLSL}varying vec2 vUv;void main(){float d=rawDepth(vUv);gl_FragColor=vec4(d>=1.?uFar:-viewPosAt(vUv,d).z,0.,0.,1.);}`;

/* Lighting composite: AO, indirect bounce, exponential height fog with directional inscattering, light shafts. */
const COMPOSITE_FS=`${DEPTH_GLSL}
uniform sampler2D tColor;uniform sampler2D tAO;uniform sampler2D tGI;uniform sampler2D tShafts;uniform sampler2D tVol;uniform float uVol;uniform mat4 uInvView;uniform vec3 uCamPos;uniform vec2 uHalfTexel;
uniform float uAO;uniform float uGI;uniform float uShafts;uniform vec3 uShaftColor;
uniform float uFog;uniform float uFogDensity;uniform float uFogFalloff;uniform float uFogHeight;uniform float uFogStart;uniform float uFogMax;uniform vec3 uFogColor;uniform vec3 uSunDir;uniform vec3 uSunColor;uniform float uInscatterExp;uniform float uInscatter;uniform float uFogSky;
varying vec2 vUv;
float upsampleAO(float z){vec2 base=vUv/uHalfTexel-.5;vec2 f=fract(base);vec2 o=(floor(base)+.5)*uHalfTexel;float acc=0.,ws=0.;
 for(int i=0;i<4;i++){vec2 k=vec2(float(i-(i/2)*2),float(i/2));vec4 s=texture2D(tAO,o+k*uHalfTexel);float bw=(k.x>.5?f.x:1.-f.x)*(k.y>.5?f.y:1.-f.y);float w=bw*exp(-abs(s.g-z)/(.03*z+.05))+1e-4;acc+=s.r*w;ws+=w;}return acc/ws;}
void main(){vec3 c=texture2D(tColor,vUv).rgb;float d=rawDepth(vUv);
 if(d<1.){vec3 vp=viewPosAt(vUv,d);float z=-vp.z;
  if(uAO>0.)c*=mix(1.,upsampleAO(z),uAO);
  if(uGI>0.){vec3 gi=texture2D(tGI,vUv).rgb;float mx=max(c.r,max(c.g,c.b));vec3 alb=mx>1e-4?c/mx*.55:vec3(.3);c+=gi*alb*uGI;}
  if(uFog>0.){vec3 wp=(uInvView*vec4(vp,1.)).xyz;vec3 ray=wp-uCamPos;float dist=length(ray);vec3 rd=ray/max(dist,1e-4);float dist2=max(dist-uFogStart,0.);
   float h0=uCamPos.y-uFogHeight;float dh=ray.y*(dist2/max(dist,1e-4));float falloff=max(uFogFalloff,1e-4)*dh;float line=abs(falloff)>1e-3?(1.-exp(-falloff))/falloff:1.;
   float amount=uFogDensity*exp(-uFogFalloff*h0)*dist2*line;float T=max(exp(-amount),1.-uFogMax);
   vec3 inscatter=uFogColor+uSunColor*pow(max(dot(rd,uSunDir),0.),uInscatterExp)*uInscatter;c=c*T+inscatter*(1.-T);}
 }else if(uFog>0.&&uFogSky>0.){vec3 vp=viewPosAt(vUv,.9999);vec3 rd=normalize((uInvView*vec4(vp,0.)).xyz);float hz=1.-smoothstep(0.,.25,rd.y);vec3 inscatter=uFogColor+uSunColor*pow(max(dot(rd,uSunDir),0.),uInscatterExp)*uInscatter;c=mix(c,inscatter,hz*uFogSky*uFogMax);}
 if(uShafts>0.)c+=texture2D(tShafts,vUv).rgb*uShaftColor*uShafts;
 if(uVol>0.)c+=texture2D(tVol,vUv).rgb*uVol;
 gl_FragColor=vec4(c,1.);}`;

/* Light shafts: bright sky near the sun, radially blurred toward the sun's screen position (two chained passes). */
const SHAFT_MASK_FS=`uniform sampler2D tColor;uniform sampler2D tDepth;uniform vec2 uSunUV;uniform float uAspect;uniform float uThreshold;varying vec2 vUv;
void main(){float d=texture2D(tDepth,vUv).x;if(d<1.){gl_FragColor=vec4(0.);return;}vec3 c=min(texture2D(tColor,vUv).rgb,vec3(6.));vec2 v=(vUv-uSunUV)*vec2(uAspect,1.);float fall=exp(-dot(v,v)*10.);
 gl_FragColor=vec4(max(c-uThreshold,0.)*fall*.25+c*fall*.05,1.);}`;
const SHAFT_BLUR_FS=`uniform sampler2D tSrc;uniform vec2 uSunUV;uniform float uStep;uniform float uFrame;varying vec2 vUv;
float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}
void main(){vec2 delta=(vUv-uSunUV)*uStep/24.;vec2 uv=vUv-delta*ign(gl_FragCoord.xy+uFrame);vec3 acc=vec3(0.);float decay=1.;
 for(int i=0;i<24;i++){acc+=texture2D(tSrc,uv).rgb*decay;decay*=.96;uv-=delta;}gl_FragColor=vec4(acc/12.,1.);}`;

/* Shadowed volumetric fog: march the view ray through exponential height fog, testing sun visibility in the
   cascaded shadow maps at each step, with a Henyey-Greenstein phase. Half resolution, jittered per frame. */
const VOLUME_FS=`${DEPTH_GLSL}
#include <packing>
uniform sampler2D tShadow0;uniform sampler2D tShadow1;uniform sampler2D tShadow2;uniform sampler2D tShadow3;uniform mat4 uShadowM0;uniform mat4 uShadowM1;uniform mat4 uShadowM2;uniform mat4 uShadowM3;uniform vec4 uSplits;uniform float uCascades;
uniform mat4 uInvView;uniform vec3 uCamPos;uniform vec3 uSunDir;uniform vec3 uSunColor;uniform float uDensity;uniform float uFalloff;uniform float uHeight;uniform float uG;uniform float uMaxDist;uniform float uFrame;varying vec2 vUv;
float shadowAt(sampler2D m,mat4 M,vec3 p){vec4 c=M*vec4(p,1.);c.xyz/=c.w;if(c.x<0.||c.y<0.||c.x>1.||c.y>1.||c.z>1.)return 1.;return step(c.z,unpackRGBAToDepth(texture2D(m,c.xy))+.0015);}
float visibility(vec3 p,float z){if(uCascades<.5)return 1.;if(z<uSplits.x)return shadowAt(tShadow0,uShadowM0,p);if(uCascades>1.5&&z<uSplits.y)return shadowAt(tShadow1,uShadowM1,p);if(uCascades>2.5&&z<uSplits.z)return shadowAt(tShadow2,uShadowM2,p);if(uCascades>3.5&&z<uSplits.w)return shadowAt(tShadow3,uShadowM3,p);return 1.;}
void main(){vec2 uv=snapUV(vUv);float d=rawDepth(uv);vec3 vp=viewPosAt(uv,min(d,.99999));float dist=min(length(vp),uMaxDist);vec3 dirV=normalize(vp);vec3 dirW=normalize((uInvView*vec4(dirV,0.)).xyz);
 float cosT=dot(dirW,uSunDir),g2=uG*uG,phase=.0795775*(1.-g2)/pow(max(1.+g2-2.*uG*cosT,1e-4),1.5);float stepLen=dist/float(STEPS);float j=ign(gl_FragCoord.xy+uFrame*7.13);
 vec3 acc=vec3(0.);float T=1.;for(int i=0;i<STEPS;i++){float t=(float(i)+j)*stepLen;vec3 p=uCamPos+dirW*t;float dens=uDensity*exp(-uFalloff*max(p.y-uHeight,0.));float ext=dens*stepLen;
  float vis=visibility(p,t*-dirV.z);acc+=T*vis*dens*stepLen;T*=exp(-ext);}
 gl_FragColor=vec4(uSunColor*acc*phase,d>=1.?uFar:-vp.z);}`;

/* Temporal AA: 3x3 YCoCg variance clipping, depth-dilated camera reprojection, Catmull-Rom history, Karis weighting. */
const TAA_FS=`uniform sampler2D tCurrent;uniform sampler2D tHistory;uniform sampler2D tDepth;uniform mat4 uInvProjU;uniform mat4 uInvView;uniform mat4 uPrevViewProj;uniform vec2 uTexel;uniform vec2 uCurTexel;uniform float uBlend;uniform float uValid;varying vec2 vUv;
${KE.GLSL.color}
vec3 tm(vec3 c){return c/(1.+max(c.r,max(c.g,c.b)));}vec3 itm(vec3 c){return c/max(1.-max(c.r,max(c.g,c.b)),1e-4);}
vec3 catmull(sampler2D t,vec2 uv){vec2 sz=1./uTexel;vec2 sp=uv*sz;vec2 tp=floor(sp-.5)+.5;vec2 f=sp-tp;vec2 w0=f*(-.5+f*(1.-.5*f)),w1=1.+f*f*(-2.5+1.5*f),w2=f*(.5+f*(2.-1.5*f)),w3=f*f*(-.5+.5*f);vec2 w12=w1+w2;vec2 o12=w2/w12;
 vec2 t0=(tp-1.)*uTexel,t3=(tp+2.)*uTexel,t12=(tp+o12)*uTexel;vec3 r=texture2D(t,vec2(t12.x,t0.y)).rgb*w12.x*w0.y+texture2D(t,vec2(t0.x,t12.y)).rgb*w0.x*w12.y+texture2D(t,t12).rgb*w12.x*w12.y+texture2D(t,vec2(t3.x,t12.y)).rgb*w3.x*w12.y+texture2D(t,vec2(t12.x,t3.y)).rgb*w12.x*w3.y;
 float ws=w12.x*w0.y+w0.x*w12.y+w12.x*w12.y+w3.x*w12.y+w12.x*w3.y;return max(r/ws,0.);}
vec3 clipAABB(vec3 lo,vec3 hi,vec3 p,vec3 q){vec3 c=.5*(hi+lo),e=.5*(hi-lo)+1e-5;vec3 v=q-c;vec3 a=abs(v/e);float m=max(a.x,max(a.y,a.z));return m>1.?c+v/m:q;}
void main(){vec3 cur=keRGBToYCoCg(tm(texture2D(tCurrent,vUv).rgb)),m1=vec3(0.),m2=vec3(0.),mn=vec3(1e9),mx=vec3(-1e9);float cd=1.;vec2 cuv=vUv;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 o=vec2(float(x),float(y))*uCurTexel;vec3 s=keRGBToYCoCg(tm(texture2D(tCurrent,vUv+o).rgb));m1+=s;m2+=s*s;mn=min(mn,s);mx=max(mx,s);float d=texture2D(tDepth,vUv+o).x;if(d<cd){cd=d;cuv=vUv+o;}}
 vec3 mean=m1/9.,sig=sqrt(max(m2/9.-mean*mean,0.));vec3 lo=max(mean-1.25*sig,mn),hi=min(mean+1.25*sig,mx);
 vec4 p=uInvProjU*vec4(vec3(cuv,cd)*2.-1.,1.);p/=p.w;vec4 pc=uPrevViewProj*(uInvView*vec4(p.xyz,1.));vec2 prev=vUv+(pc.xy/pc.w*.5+.5-cuv);
 float blend=uBlend;if(uValid<.5||prev.x<0.||prev.y<0.||prev.x>1.||prev.y>1.)blend=1.;
 vec3 hist=clipAABB(lo,hi,mean,keRGBToYCoCg(tm(catmull(tHistory,prev))));float motion=length((prev-vUv)/uTexel);blend=clamp(blend+motion*.004,blend,.5);if(uValid<.5||prev.x<0.||prev.y<0.||prev.x>1.||prev.y>1.)blend=1.;
 float wc=blend/(1.+cur.x),wh=(1.-blend)/(1.+hist.x);vec3 res=(cur*wc+hist*wh)/(wc+wh);gl_FragColor=vec4(itm(keYCoCgToRGB(res)),1.);}`;

/* Depth of field: circle of confusion from linear depth, half-resolution golden-angle gather, then blend. */
const DOF_GATHER_FS=`${DEPTH_GLSL}uniform sampler2D tColor;uniform float uFocus;uniform float uAperture;uniform float uMaxBlur;uniform float uAutoFocus;uniform vec2 uFullTexel;varying vec2 vUv;
float coc(vec2 uv,float f){float d=rawDepth(uv);float z=d>=1.?uFar:-viewPosAt(uv,d).z;return clamp(uAperture*abs(z-f)/max(z,1e-3)*80.,0.,uMaxBlur);}
void main(){float f=uFocus;if(uAutoFocus>.5){float s=0.;for(int i=0;i<5;i++){vec2 o=vec2(float(i-2)*.02,0.);float d=rawDepth(vec2(.5)+o);s+=d>=1.?uFar:-viewPosAt(vec2(.5)+o,d).z;}f=s/5.;}
 float c0=coc(vUv,f);vec3 acc=texture2D(tColor,vUv).rgb;float ws=1.;
 for(int i=1;i<32;i++){float r=sqrt(float(i)/32.)*uMaxBlur;float a=float(i)*2.39996323;vec2 uv=vUv+vec2(cos(a),sin(a))*r*uFullTexel;float cs=coc(uv,f);float w=smoothstep(r-1.5,r+1.5,max(cs,min(c0,cs+2.)));acc+=texture2D(tColor,uv).rgb*w;ws+=w;}
 gl_FragColor=vec4(acc/ws,c0);}`;
const DOF_COMBINE_FS=`uniform sampler2D tColor;uniform sampler2D tBlur;varying vec2 vUv;void main(){vec4 b=texture2D(tBlur,vUv);vec3 c=texture2D(tColor,vUv).rgb;gl_FragColor=vec4(mix(c,b.rgb,smoothstep(.5,2.5,b.a)),1.);}`;
const MOTION_FS=`${DEPTH_GLSL}uniform sampler2D tColor;uniform mat4 uInvView;uniform mat4 uPrevViewProj;uniform float uStrength;uniform float uFrame;varying vec2 vUv;
void main(){float d=rawDepth(vUv);vec3 vp=viewPosAt(vUv,min(d,.99999));vec4 c=uPrevViewProj*(uInvView*vec4(vp,1.));vec2 vel=(vUv-(c.xy/c.w*.5+.5))*uStrength;float len=length(vel/uTexel);
 if(len<.75){gl_FragColor=texture2D(tColor,vUv);return;}vel*=min(1.,40./len);float j=ign(gl_FragCoord.xy+uFrame)-.5;vec3 acc=vec3(0.);for(int i=0;i<10;i++){float t=(float(i)+j)/9.-.5;acc+=texture2D(tColor,vUv+vel*t).rgb;}gl_FragColor=vec4(acc/10.,1.);}`;

/* Bloom: 13-tap downsample (Karis-weighted first level with soft threshold) and additive tent upsampling. */
const BLOOM_DOWN_FS=`uniform sampler2D tSrc;uniform vec2 uTexel;uniform float uFirst;uniform vec4 uCurve;varying vec2 vUv;
float lum(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}vec3 t(vec2 o){return texture2D(tSrc,vUv+o*uTexel).rgb;}
vec3 kw(vec3 a,vec3 b,vec3 c,vec3 d){if(uFirst<.5)return (a+b+c+d)*.25;float wa=1./(1.+lum(a)),wb=1./(1.+lum(b)),wc=1./(1.+lum(c)),wd=1./(1.+lum(d));return (a*wa+b*wb+c*wc+d*wd)/(wa+wb+wc+wd);}
void main(){vec3 A=t(vec2(-2,2)),B=t(vec2(0,2)),C=t(vec2(2,2)),D=t(vec2(-2,0)),E=t(vec2(0,0)),F=t(vec2(2,0)),G=t(vec2(-2,-2)),H=t(vec2(0,-2)),I=t(vec2(2,-2)),J=t(vec2(-1,1)),K=t(vec2(1,1)),L=t(vec2(-1,-1)),M=t(vec2(1,-1));
 vec3 r=kw(J,K,L,M)*.5+(kw(A,B,D,E)+kw(B,C,E,F)+kw(D,E,G,H)+kw(E,F,H,I))*.125;
 if(uFirst>.5){float br=max(r.r,max(r.g,r.b));float rq=clamp(br-uCurve.x,0.,uCurve.y);rq=uCurve.z*rq*rq;r*=max(rq,br-uCurve.w)/max(br,1e-4);}
 gl_FragColor=vec4(max(r,0.),1.);}`;
const BLOOM_UP_FS=`uniform sampler2D tSrc;uniform vec2 uTexel;uniform float uRadius;varying vec2 vUv;vec3 t(vec2 o){return texture2D(tSrc,vUv+o*uTexel*uRadius).rgb;}
void main(){vec3 r=t(vec2(0))*4.+(t(vec2(-1,0))+t(vec2(1,0))+t(vec2(0,-1))+t(vec2(0,1)))*2.+t(vec2(-1,-1))+t(vec2(1,-1))+t(vec2(-1,1))+t(vec2(1,1));gl_FragColor=vec4(r/16.,1.);}`;

/* Eye adaptation: centre-weighted log luminance reduced 64² → 16² → 4² → 1², adapted over time. */
const LUM_FS=`uniform sampler2D tSrc;uniform vec2 uTexel;varying vec2 vUv;
void main(){float s=0.;for(int y=0;y<2;y++)for(int x=0;x<2;x++){vec3 c=texture2D(tSrc,vUv+(vec2(float(x),float(y))-.5)*uTexel*.5).rgb;s+=log2(max(dot(c,vec3(.2126,.7152,.0722)),1e-4));}
 vec2 d=vUv-.5;float w=mix(.25,1.,exp(-dot(d,d)*6.));gl_FragColor=vec4(s*.25*w,w,0.,1.);}`;
const REDUCE_FS=`uniform sampler2D tSrc;uniform vec2 uTexel;varying vec2 vUv;void main(){vec2 a=vec2(0.);for(int y=0;y<4;y++)for(int x=0;x<4;x++)a+=texture2D(tSrc,vUv+(vec2(float(x),float(y))-1.5)*uTexel).rg;gl_FragColor=vec4(a,0.,1.);}`;
const ADAPT_FS=`uniform sampler2D tCur;uniform sampler2D tPrev;uniform float uDt;uniform float uUp;uniform float uDown;uniform float uValid;varying vec2 vUv;
void main(){vec2 c=texture2D(tCur,vec2(.5)).rg;float cur=c.x/max(c.y,1e-5);float prev=texture2D(tPrev,vec2(.5)).r;float speed=cur>prev?uUp:uDown;gl_FragColor=vec4(uValid>.5?prev+(cur-prev)*(1.-exp(-uDt*speed)):cur,0.,0.,1.);}`;

/* Local exposure (after UE5's): a 64-wide log-luminance grid of the scene, a blurred copy, and a cross-bilateral
   lookup in the final pass. The local base luminance is pulled toward the adapted middle grey (separately for
   highlights and shadows) while per-pixel detail above the base is kept, so bright skies and dark interiors
   hold detail without flattening the image. */
const LOCAL_LUM_FS=`uniform sampler2D tSrc;uniform vec2 uTexel;varying vec2 vUv;
void main(){float s=0.;for(int y=0;y<4;y++)for(int x=0;x<4;x++){vec3 c=texture2D(tSrc,vUv+(vec2(float(x),float(y))-1.5)*uTexel*.25).rgb;s+=log2(max(dot(c,vec3(.2126,.7152,.0722)),1e-5));}gl_FragColor=vec4(s/16.,0.,0.,1.);}`;
const LOCAL_BLUR_FS=`uniform sampler2D tSrc;uniform vec2 uDir;varying vec2 vUv;
void main(){float s=texture2D(tSrc,vUv).r*.227;s+=(texture2D(tSrc,vUv+uDir).r+texture2D(tSrc,vUv-uDir).r)*.195;s+=(texture2D(tSrc,vUv+uDir*2.).r+texture2D(tSrc,vUv-uDir*2.).r)*.122;
 s+=(texture2D(tSrc,vUv+uDir*3.).r+texture2D(tSrc,vUv-uDir*3.).r)*.054;s+=(texture2D(tSrc,vUv+uDir*4.).r+texture2D(tSrc,vUv-uDir*4.).r)*.016;gl_FragColor=vec4(s,0.,0.,1.);}`;

/* Final: exposure, local exposure, bloom, white balance, saturation/contrast, ACES, lift/gamma/gain, lens effects, debug views. */
const FINAL_FS=`uniform sampler2D tInput;uniform sampler2D tBloom;uniform sampler2D tExposure;uniform sampler2D tAO;uniform sampler2D tGI;uniform sampler2D tDepth;uniform sampler2D tScene;
uniform float uAuto;uniform float uManual;uniform float uComp;uniform float uKey;uniform vec2 uExpRange;uniform float uBloom;uniform vec3 uWB;uniform float uSat;uniform float uContrast;uniform vec3 uLift;uniform vec3 uGamma;uniform vec3 uGain;
uniform sampler2D tLocal;uniform sampler2D tLocalBlur;uniform vec2 uLocalTexel;uniform vec4 uLocal;uniform float uLocalOn;
uniform float uVignette;uniform float uGrain;uniform float uCA;uniform float uFlare;uniform float uSharpen;uniform vec2 uTexel;uniform float uTime;uniform float uEncode;uniform int uDebug;uniform float uNear;uniform float uFar;varying vec2 vUv;
${KE.GLSL.color}
float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}
float linz(float d){return uNear*uFar/(uFar-d*(uFar-uNear));}
void main(){vec2 uv=vUv;vec3 c;
 if(uCA>0.){vec2 dir=(uv-.5)*uCA*.012;c=vec3(texture2D(tInput,uv+dir).r,texture2D(tInput,uv).g,texture2D(tInput,uv-dir).b);}else c=texture2D(tInput,uv).rgb;
 if(uSharpen>0.){vec3 n=texture2D(tInput,uv+vec2(0.,uTexel.y)).rgb+texture2D(tInput,uv-vec2(0.,uTexel.y)).rgb+texture2D(tInput,uv+vec2(uTexel.x,0.)).rgb+texture2D(tInput,uv-vec2(uTexel.x,0.)).rgb;c=max(c+(c*4.-n)*uSharpen*.25,c*.5);}
 c+=texture2D(tBloom,uv).rgb*uBloom;
 if(uFlare>0.){vec2 fuv=1.-uv,gv=(vec2(.5)-fuv)*.38;vec3 fl=vec3(0.);for(int i=1;i<5;i++){vec2 o=fract(fuv+gv*float(i));float w=pow(max(1.-length(vec2(.5)-o)/.7071,0.),5.);vec3 tint=mix(vec3(1.,.72,.45),vec3(.5,.75,1.),fract(float(i)*.37));fl+=texture2D(tBloom,o).rgb*w*tint;}
  vec2 hv=normalize(gv+1e-5)*.46;vec2 ho=fract(fuv+hv);float hw=pow(max(1.-length(vec2(.5)-ho)/.7071,0.),5.);fl+=texture2D(tBloom,ho).rgb*hw*vec3(.8,.9,1.)*.6;c+=fl*uFlare;}
 float ex=uAuto>.5?clamp(uKey/exp2(texture2D(tExposure,vec2(.5)).r),uExpRange.x,uExpRange.y):uManual;float lx=1.;
 if(uLocalOn>.5){float pl=log2(max(keLuma(c),1e-5));float ws=0.,bs=0.;for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){float L=texture2D(tLocal,uv+vec2(float(x),float(y))*uLocalTexel).r;float w=exp(-(L-pl)*(L-pl)*.5);ws+=w;bs+=L*w;}
  float base=mix(bs/max(ws,1e-4),texture2D(tLocalBlur,uv).r,uLocal.w);float mid=log2(uKey/ex);float nb=mid+(base-mid)*(base>mid?uLocal.x:uLocal.y);lx=exp2(clamp(nb+(pl-base)*uLocal.z-pl,-4.,4.));c*=lx;}
 c*=ex*exp2(uComp)*uWB;
 if(uDebug==1||uDebug==2){c=uDebug==1?vec3(texture2D(tAO,uv).r):vec3(fract(log2(linz(texture2D(tDepth,uv).x))*.5));gl_FragColor=vec4(uEncode>.5?keLinearToSRGB(c):c,1.);return;}
 if(uDebug==3)c=texture2D(tBloom,uv).rgb*uBloom*ex*4.;else if(uDebug==4)c=texture2D(tGI,uv).rgb*ex;else if(uDebug==5)c=texture2D(tScene,uv).rgb*ex;else if(uDebug==6)c=vec3(keLuma(c));else if(uDebug==7){c=vec3(clamp(.5+log2(lx)*.25,0.,1.));gl_FragColor=vec4(c,1.);return;}
 float l=keLuma(c);c=max(mix(vec3(l),c,uSat),0.);c=.18*pow(c/.18+1e-6,vec3(uContrast));
 c=keACES(c);c=pow(max(c*uGain+uLift*(1.-c),0.),1./uGamma);
 vec2 d=uv-.5;c*=1.-uVignette*smoothstep(.2,.9,length(d*vec2(1.25,1.)));
 c+=(ign(gl_FragCoord.xy+fract(uTime)*97.)-.5)*uGrain*(1.-c*.5);
 if(uEncode>.5)c=keLinearToSRGB(clamp(c,0.,1.));c+=(ign(gl_FragCoord.yx+uTime*3.)-.5)/255.;gl_FragColor=vec4(clamp(c,0.,1.),1.);}`;
const FXAA_FS=`uniform sampler2D tSrc;uniform vec2 uTexel;varying vec2 vUv;
void main(){vec3 luma=vec3(.299,.587,.114);vec3 rgbM=texture2D(tSrc,vUv).rgb;float lNW=dot(texture2D(tSrc,vUv+vec2(-1.,-1.)*uTexel).rgb,luma),lNE=dot(texture2D(tSrc,vUv+vec2(1.,-1.)*uTexel).rgb,luma),lSW=dot(texture2D(tSrc,vUv+vec2(-1.,1.)*uTexel).rgb,luma),lSE=dot(texture2D(tSrc,vUv+vec2(1.,1.)*uTexel).rgb,luma),lM=dot(rgbM,luma);
 float lo=min(lM,min(min(lNW,lNE),min(lSW,lSE))),hi=max(lM,max(max(lNW,lNE),max(lSW,lSE)));if(hi-lo<max(.0312,hi*.125)){gl_FragColor=vec4(rgbM,1.);return;}
 vec2 dir=vec2(-((lNW+lNE)-(lSW+lSE)),(lNW+lSW)-(lNE+lSE));float rd=max((lNW+lNE+lSW+lSE)*.03125,.0078125);dir=clamp(dir/(min(abs(dir.x),abs(dir.y))+rd),vec2(-8.),vec2(8.))*uTexel;
 vec3 a=.5*(texture2D(tSrc,vUv+dir*(-1./6.)).rgb+texture2D(tSrc,vUv+dir*(1./6.)).rgb);vec3 b=a*.5+.25*(texture2D(tSrc,vUv-dir*.5).rgb+texture2D(tSrc,vUv+dir*.5).rgb);float lb=dot(b,luma);gl_FragColor=vec4(lb<lo||lb>hi?a:b,1.);}`;

const DEBUG_VIEWS={lit:0,ao:1,depth:2,bloom:3,ssgi:4,unlit:5,raw:5,lighting:6,localexposure:7};

KE.Pipeline=class{
  constructor(THREE,renderer,o={}){
    this.THREE=THREE;this.renderer=renderer;this.caps=KE.capabilities(renderer);const caps=this.caps;
    this.hdr=caps.halfRT&&o.hdr!==false;this.hdrType=this.hdr?THREE.HalfFloatType:THREE.UnsignedByteType;this.depthOK=caps.depthTexture;
    this.enabled=true;this.frame=0;this.historyValid=false;this.size=[0,0];this.internal=[0,0];this.targets=[];this.stats={passes:0,ms:0};
    this.options={taa:true,taaBlend:.1,upscale:1,gtao:true,aoRadius:1.1,aoStrength:.85,aoPower:1.4,ssgi:false,giStrength:.55,giRadius:3,bloom:true,bloomStrength:.045,bloomRadius:1,bloomThreshold:1.2,bloomKnee:.6,lensFlare:.035,
      autoExposure:true,exposure:1,exposureCompensation:0,exposureKey:.2,minExposure:.25,maxExposure:4,adaptUp:2.5,adaptDown:1.2,localExposure:{enabled:true,highlightContrast:.75,shadowContrast:.9,detail:1,blurredBlend:.4},fxaa:true,sharpen:.18,
      fog:{enabled:true,density:.012,falloff:.12,height:0,start:4,maxOpacity:.9,color:new THREE.Color(.55,.66,.78),inscatter:1.2,inscatterExponent:12,sky:.35,replaceSceneFog:true},
      volumetrics:true,shaftStrength:.25,volumetricFog:{enabled:true,density:.012,falloff:.22,height:0,anisotropy:.45,intensity:1,maxDistance:50,steps:20},dof:{enabled:false,focusDistance:8,aperture:.035,maxBlur:10,autoFocus:false},motionBlur:{enabled:false,strength:.6},
      grading:{saturation:1.05,contrast:1.04,temperature:0,tint:0,lift:[0,0,0],gamma:[1,1,1],gain:[1,1,1],vignette:.22,grain:.012,chromaticAberration:.15},sun:null,debugView:'lit'};
    this.set(o);
    this.uniforms=KE.sceneUniforms(THREE);this.quad=new KE.FullScreenQuad(THREE);this.gpu=new KE.GPUTimer(renderer,{name:'pipeline'});
    this.proj=new THREE.Matrix4();this.invProj=new THREE.Matrix4();this.invProjU=new THREE.Matrix4();this.viewProj=new THREE.Matrix4();this.prevViewProj=new THREE.Matrix4();
    this._v2=new THREE.Vector2();this._v3=new THREE.Vector3();this._fwd=new THREE.Vector3();this._sunWorld=new THREE.Vector3();this._fogColor=new THREE.Color();
    const M=(fs,u,defines={})=>new THREE.ShaderMaterial({vertexShader:VS,fragmentShader:fs,uniforms:u,defines,depthTest:false,depthWrite:false,toneMapped:false});
    const depthU=()=>({tDepth:{value:null},uInvProj:{value:this.invProj},uTexel:{value:new THREE.Vector2()},uNear:{value:.1},uFar:{value:1000}});
    this.m={
      copy:M(COPY_FS,{tSrc:{value:null}}),
      linearDepth:M(LINEAR_DEPTH_FS,depthU()),
      gtao:M(GTAO_FS,{...depthU(),uRadius:{value:1},uProjScale:{value:1},uFrame:{value:0},uPower:{value:1}},{SLICES:2,STEPS:6}),
      blur:M(BILATERAL_FS,{tSrc:{value:null},uDir:{value:new THREE.Vector2()},uDepthChannel:{value:0}}),
      ssgi:M(SSGI_FS,{...depthU(),tPrevColor:{value:null},uProj:{value:new THREE.Matrix4()},uInvView:{value:new THREE.Matrix4()},uPrevViewProj:{value:this.prevViewProj},uFrame:{value:0},uGIRadius:{value:4}},{RAYS:2,STEPS:10}),
      ssgiTemporal:M(SSGI_TEMPORAL_FS,{...depthU(),tCurrent:{value:null},tHistory:{value:null},uInvView:{value:new THREE.Matrix4()},uPrevViewProj:{value:this.prevViewProj},uValid:{value:0}}),
      composite:M(COMPOSITE_FS,{...depthU(),tColor:{value:null},tAO:{value:null},tGI:{value:null},tShafts:{value:null},tVol:{value:null},uVol:{value:0},uInvView:{value:new THREE.Matrix4()},uCamPos:{value:new THREE.Vector3()},uHalfTexel:{value:new THREE.Vector2()},
        uAO:{value:0},uGI:{value:0},uShafts:{value:0},uShaftColor:{value:new THREE.Color(1,.9,.7)},uFog:{value:0},uFogDensity:{value:.01},uFogFalloff:{value:.1},uFogHeight:{value:0},uFogStart:{value:0},uFogMax:{value:1},
        uFogColor:{value:new THREE.Color()},uSunDir:{value:new THREE.Vector3(0,1,0)},uSunColor:{value:new THREE.Color()},uInscatterExp:{value:8},uInscatter:{value:1},uFogSky:{value:0}}),
      shaftMask:M(SHAFT_MASK_FS,{tColor:{value:null},tDepth:{value:null},uSunUV:{value:new THREE.Vector2()},uAspect:{value:1},uThreshold:{value:1}}),
      shaftBlur:M(SHAFT_BLUR_FS,{tSrc:{value:null},uSunUV:{value:new THREE.Vector2()},uStep:{value:.5},uFrame:{value:0}}),
      taa:M(TAA_FS,{tCurrent:{value:null},tHistory:{value:null},tDepth:{value:null},uInvProjU:{value:this.invProjU},uInvView:{value:new THREE.Matrix4()},uPrevViewProj:{value:this.prevViewProj},uTexel:{value:new THREE.Vector2()},uCurTexel:{value:new THREE.Vector2()},uBlend:{value:.1},uValid:{value:0}}),
      dofGather:M(DOF_GATHER_FS,{...depthU(),tColor:{value:null},uFocus:{value:8},uAperture:{value:.03},uMaxBlur:{value:8},uAutoFocus:{value:0},uFullTexel:{value:new THREE.Vector2()}}),
      dofCombine:M(DOF_COMBINE_FS,{tColor:{value:null},tBlur:{value:null}}),
      motion:M(MOTION_FS,{...depthU(),tColor:{value:null},uInvView:{value:new THREE.Matrix4()},uPrevViewProj:{value:this.prevViewProj},uStrength:{value:.5},uFrame:{value:0}}),
      bloomDown:M(BLOOM_DOWN_FS,{tSrc:{value:null},uTexel:{value:new THREE.Vector2()},uFirst:{value:0},uCurve:{value:new THREE.Vector4()}}),
      bloomUp:M(BLOOM_UP_FS,{tSrc:{value:null},uTexel:{value:new THREE.Vector2()},uRadius:{value:1}}),
      lum:M(LUM_FS,{tSrc:{value:null},uTexel:{value:new THREE.Vector2()}}),
      reduce:M(REDUCE_FS,{tSrc:{value:null},uTexel:{value:new THREE.Vector2()}}),
      localLum:M(LOCAL_LUM_FS,{tSrc:{value:null},uTexel:{value:new THREE.Vector2()}}),
      localBlur:M(LOCAL_BLUR_FS,{tSrc:{value:null},uDir:{value:new THREE.Vector2()}}),
      adapt:M(ADAPT_FS,{tCur:{value:null},tPrev:{value:null},uDt:{value:.016},uUp:{value:2},uDown:{value:1},uValid:{value:0}}),
      volume:M(VOLUME_FS,{...depthU(),tShadow0:{value:null},tShadow1:{value:null},tShadow2:{value:null},tShadow3:{value:null},uShadowM0:{value:new THREE.Matrix4()},uShadowM1:{value:new THREE.Matrix4()},uShadowM2:{value:new THREE.Matrix4()},uShadowM3:{value:new THREE.Matrix4()},uSplits:{value:new THREE.Vector4()},uCascades:{value:0},
        uInvView:{value:new THREE.Matrix4()},uCamPos:{value:new THREE.Vector3()},uSunDir:{value:new THREE.Vector3(0,1,0)},uSunColor:{value:new THREE.Color()},uDensity:{value:.02},uFalloff:{value:.15},uHeight:{value:0},uG:{value:.6},uMaxDist:{value:60},uFrame:{value:0}},{STEPS:20}),
      final:M(FINAL_FS,{tInput:{value:null},tBloom:{value:null},tExposure:{value:null},tAO:{value:null},tGI:{value:null},tDepth:{value:null},tScene:{value:null},uAuto:{value:1},uManual:{value:1},uComp:{value:0},uKey:{value:.2},uExpRange:{value:new THREE.Vector2(.25,4)},
        uBloom:{value:.05},uFlare:{value:0},uWB:{value:new THREE.Vector3(1,1,1)},uSat:{value:1},uContrast:{value:1},uLift:{value:new THREE.Vector3()},uGamma:{value:new THREE.Vector3(1,1,1)},uGain:{value:new THREE.Vector3(1,1,1)},uVignette:{value:.2},uGrain:{value:.01},uCA:{value:0},uSharpen:{value:0},
        uTexel:{value:new THREE.Vector2()},uTime:{value:0},uEncode:{value:1},uDebug:{value:0},uNear:{value:.1},uFar:{value:1000},
        tLocal:{value:null},tLocalBlur:{value:null},uLocalTexel:{value:new THREE.Vector2()},uLocal:{value:new THREE.Vector4(1,1,1,0)},uLocalOn:{value:0}}),
      fxaa:M(FXAA_FS,{tSrc:{value:null},uTexel:{value:new THREE.Vector2()}}),
    };
    this.m.bloomUp.blending=THREE.AdditiveBlending;this.m.bloomUp.transparent=true;
    this._black=new THREE.DataTexture(new Uint8Array([0,0,0,255]),1,1,THREE.RGBAFormat);this._black.needsUpdate=true;
    this._white=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1,THREE.RGBAFormat);this._white.needsUpdate=true;
    this.onSettings=KE.events.on('settings',s=>this.applySettings(s));
    if(!KE.cvars.find('r.LocalExposure'))KE.cvars.register('r.LocalExposure',{value:true,type:'boolean',help:'Local exposure: compress highlight/shadow contrast around middle grey'});
    const lcv=KE.cvars.find('r.LocalExposure');lcv.onChange=v=>{this.options.localExposure.enabled=!!v;};
    const cv=KE.cvars.find('r.ViewMode');if(cv){cv.options=[...new Set([...(cv.options||[]),...Object.keys(DEBUG_VIEWS)])];cv.onChange=v=>{this.options.debugView=v;};}
    if(o.applySettings!==false)this.applySettings(KE.settings);
  }
  /* Deep-merge options. Nested groups (fog, dof, motionBlur, grading) merge key by key. */
  set(o={}){for(const [k,v] of Object.entries(o)){const cur=this.options[k];if(cur&&typeof cur==='object'&&!cur.isColor&&!Array.isArray(cur)&&v&&typeof v==='object'&&!v.isColor&&!Array.isArray(v)){for(const [kk,vv] of Object.entries(v)){if(cur[kk]&&cur[kk].isColor&&vv!==undefined&&!(vv&&vv.isColor))cur[kk].set(vv);else if(cur[kk]&&cur[kk].isColor&&vv&&vv.isColor)cur[kk].copy(vv);else cur[kk]=vv;}}else this.options[k]=v;}return this;}
  /* Map KE.settings quality keys onto pipeline passes. */
  applySettings(s=KE.settings){const o=this.options;o.taa=!!s.taa&&this.depthOK;o.gtao=!!s.gtao&&this.depthOK;o.ssgi=!!s.ssgi&&this.depthOK&&this.hdr;o.bloom=s.bloom!==false;o.volumetrics=!!s.volumetrics;o.autoExposure=!!s.autoExposure&&this.hdr;
    o.fxaa=!!s.aa&&!o.taa;o.upscale=Number.isFinite(s.upscale)?s.upscale:1;o.dof.enabled=!!s.dof&&this.depthOK;o.motionBlur.enabled=!!s.motionBlur&&this.depthOK;this.uniforms.keSSR.value=s.ssr?1:0;this.enabled=s.pipeline!==false;
    const q=s.preset==='ultra'||s.preset==='cinematic';this.m.gtao.defines.SLICES=q?3:2;this.m.gtao.defines.STEPS=q?8:6;this.m.gtao.needsUpdate=true;this.historyValid=false;return this;}
  target(w,h,{type=this.hdrType,format=this.THREE.RGBAFormat,filter=this.THREE.LinearFilter,depth=false}={}){const T=this.THREE,t=new T.WebGLRenderTarget(Math.max(1,w),Math.max(1,h),{type,format,minFilter:filter,magFilter:filter,depthBuffer:depth,stencilBuffer:false,generateMipmaps:false});t.texture.generateMipmaps=false;this.targets.push(t);return t;}
  setSize(){const s=this.renderer.getDrawingBufferSize(this._v2);this._resize(s.x,s.y);return this;}
  /* Display targets (TAA history onward) use the drawing-buffer size; scene and lighting targets use the internal
     size (display × upscale when TAA is on), which TAA reconstructs back to display resolution. */
  _resize(W,H){W=Math.max(1,Math.floor(W));H=Math.max(1,Math.floor(H));const u=this.options.taa?clamp(this.options.upscale||1,.5,1):1,IW=Math.max(1,Math.round(W*u)),IH=Math.max(1,Math.round(H*u));
    if(W===this.size[0]&&H===this.size[1]&&IW===this.internal[0]&&IH===this.internal[1])return;const T=this.THREE;this.disposeTargets();this.size=[W,H];this.internal=[IW,IH];
    const w2=Math.max(1,IW>>1),h2=Math.max(1,IH>>1),dw2=Math.max(1,W>>1),dh2=Math.max(1,H>>1);
    this.scene=this.target(IW,IH,{depth:true});if(this.depthOK){this.scene.depthTexture=new T.DepthTexture(IW,IH,T.UnsignedIntType);this.scene.depthTexture.format=T.DepthFormat;}
    this.colorCopy=this.target(IW,IH);this.linearDepth=this.target(IW,IH,{type:this.caps.floatRT?T.FloatType:this.hdrType,format:this.caps.webgl2?T.RedFormat:T.RGBAFormat,filter:T.NearestFilter});
    this.lit=this.target(IW,IH);this.taa=[this.target(W,H),this.target(W,H)];this.post=[this.target(W,H),this.target(W,H)];this.ldr=this.target(W,H,{type:T.UnsignedByteType});
    this.ao=[this.target(w2,h2),this.target(w2,h2)];this.gi=[this.target(w2,h2),this.target(w2,h2)];this.giHist=[this.target(w2,h2),this.target(w2,h2)];
    this.shafts=[this.target(w2,h2),this.target(w2,h2)];this.vol=[this.target(w2,h2),this.target(w2,h2)];this.dofBlur=this.target(dw2,dh2);
    this.bloomMips=[];let bw=dw2,bh=dh2;for(let i=0;i<6&&bw>=4&&bh>=4;i++){this.bloomMips.push(this.target(bw,bh));bw>>=1;bh>>=1;}
    this.lumTargets=[64,16,4,1].map(n=>this.target(n,n,{type:this.caps.floatRT?T.FloatType:this.hdrType,filter:T.NearestFilter}));this.adapt=[0,1].map(()=>this.target(1,1,{type:this.caps.floatRT?T.FloatType:this.hdrType,filter:T.NearestFilter}));
    const lh=clamp(Math.round(64*IH/IW),8,128);this.localLum=[0,1,2].map(()=>this.target(64,lh));
    this.historyValid=false;this.adaptValid=false;this.giValid=false;}
  /* Use a KE.CascadedShadows (or any object with lights[] and splits[]) for shadowed volumetric fog. */
  setShadowSource(csm){this.shadowSource=csm||null;return this;}
  resetHistory(){this.historyValid=false;this.giValid=false;return this;}
  get textures(){return {sceneColor:this.colorCopy&&this.colorCopy.texture,sceneDepth:this.linearDepth&&this.linearDepth.texture,depth:this.scene&&this.scene.depthTexture,output:this.taa&&this.taa[this.frame&1].texture};}
  pass(material,target){this.quad.render(this.renderer,target,material);this.stats.passes++;}
  render(scene,camera,dt=1/60){
    const R=this.renderer,T=this.THREE,o=this.options,U=this.uniforms;
    const G=this.gpu;G.frame();
    if(!this.enabled){KE.prepareCamera(camera);G.begin('Scene (direct)');R.render(scene,camera);G.end();return;}
    const t0=performance.now();this.setSize();const [W,H]=this.size,[IW,IH]=this.internal;this.frame++;this.stats.passes=0;
    const prevTarget=R.getRenderTarget(),prevTone=R.toneMapping,prevAutoClear=R.autoClear,prevInfo=R.info.autoReset,prevFog=scene.fog,prevBg=scene.background,prevMask=camera.layers.mask;
    R.info.autoReset=false;R.info.reset();
    camera.updateMatrixWorld();if(camera.isPerspectiveCamera||camera.isOrthographicCamera)camera.updateProjectionMatrix();
    this.invProjU.copy(camera.projectionMatrix).invert();this.viewProj.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    const jitter=o.taa&&!(camera.view&&camera.view.enabled);
    if(jitter){const n=IW<W?16:8,i=(this.frame%n)+1;camera.setViewOffset(IW,IH,halton(i,2)-.5,halton(i,3)-.5,IW,IH);}
    this.proj.copy(camera.projectionMatrix);this.invProj.copy(this.proj).invert();
    const near=camera.near,far=camera.far,texel=this._v2.set(1/IW,1/IH),dtexel=(this._dt||(this._dt=new T.Vector2())).set(1/W,1/H),frameValid=this.historyValid;
    Object.assign(U.keNearFar.value,{x:near,y:far});U.keResolution.value.set(IW,IH);U.keProjection.value.copy(this.proj);U.keInvProjection.value.copy(this.invProj);U.keViewMatrix.value.copy(camera.matrixWorldInverse);U.keInvView.value.copy(camera.matrixWorld);U.keTime.value+=dt;U.keFrame.value=this.frame;
    const sun=o.sun;if(sun){this._sunWorld.copy(sun.position).sub(sun.target.position).normalize();U.keSunDirection.value.copy(this._sunWorld);U.keSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);}
    try{
      // 1. Opaque scene into the HDR target (linear, no tone mapping), without the translucent layer.
      G.begin('Scene (opaque)');
      if(o.fog.enabled&&o.fog.replaceSceneFog&&this.depthOK)scene.fog=null;R.toneMapping=T.NoToneMapping;
      camera.layers.mask=prevMask&~TRANSLUCENT_BIT;R.autoClear=true;R.setRenderTarget(this.scene);R.render(scene,camera);
      // 2. Copies that translucent materials may sample.
      G.begin('Scene copies');
      this.m.copy.uniforms.tSrc.value=this.scene.texture;this.pass(this.m.copy,this.colorCopy);
      if(this.depthOK){this.bindDepth(this.m.linearDepth,near,far,texel);this.pass(this.m.linearDepth,this.linearDepth);}
      U.keSceneColor.value=this.colorCopy.texture;U.keSceneDepth.value=this.depthOK?this.linearDepth.texture:null;U.keHasScene.value=this.depthOK?1:0;
      // 3. Translucent layer drawn over the opaque result with depth testing.
      G.begin('Translucent');
      camera.layers.mask=TRANSLUCENT_BIT;scene.background=null;const sm=R.shadowMap,au=sm.autoUpdate,nu=sm.needsUpdate;sm.autoUpdate=false;sm.needsUpdate=false;R.autoClear=false;R.setRenderTarget(this.scene);R.render(scene,camera);sm.autoUpdate=au;sm.needsUpdate=nu;
      camera.layers.mask=prevMask;scene.background=prevBg;scene.fog=prevFog;
      // 4. Half-resolution ambient occlusion and indirect light.
      G.begin('GTAO + SSGI');
      const halfTexel=(this._half||(this._half=new T.Vector2())).set(1/this.ao[0].width,1/this.ao[0].height);
      if(o.gtao){const g=this.m.gtao;this.bindDepth(g,near,far,texel);g.uniforms.uRadius.value=o.aoRadius;g.uniforms.uProjScale.value=IH/(2*Math.tan((camera.fov||50)*Math.PI/360));g.uniforms.uFrame.value=this.frame%64;g.uniforms.uPower.value=o.aoPower;this.pass(g,this.ao[0]);this.blur(this.ao,halfTexel,0);}
      let giTex=this._black;
      if(o.ssgi){const g=this.m.ssgi;this.bindDepth(g,near,far,texel);g.uniforms.tPrevColor.value=this.historyValid?this.taa[(this.frame+1)&1].texture:this.colorCopy.texture;g.uniforms.uProj.value.copy(this.proj);g.uniforms.uInvView.value.copy(camera.matrixWorld);g.uniforms.uFrame.value=this.frame%64;g.uniforms.uGIRadius.value=o.giRadius;this.pass(g,this.gi[0]);
        const tt=this.m.ssgiTemporal,hi=this.frame&1;this.bindDepth(tt,near,far,texel);tt.uniforms.tCurrent.value=this.gi[0].texture;tt.uniforms.tHistory.value=this.giHist[hi^1].texture;tt.uniforms.uInvView.value.copy(camera.matrixWorld);tt.uniforms.uValid.value=this.giValid?1:0;this.pass(tt,this.giHist[hi]);
        this.m.copy.uniforms.tSrc.value=this.giHist[hi].texture;this.pass(this.m.copy,this.gi[0]);this.blur(this.gi,halfTexel,1);giTex=this.gi[0].texture;this.giValid=true;}
      // 5. Light shafts from the sun's screen position.
      G.begin('Light shafts');
      let shaftsOn=0;if(o.volumetrics&&sun&&this.depthOK){const s=this._v3.copy(this._sunWorld).multiplyScalar(far*.5).add(camera.position).project(camera);camera.getWorldDirection(this._fwd);
        const facing=this._fwd.dot(this._sunWorld),vis=clamp((facing-.1)*2.5,0,1)*clamp(1-Math.max(Math.abs(s.x),Math.abs(s.y))*.45,0,1)*clamp(this._sunWorld.y*6,0,1);
        if(vis>.01){const sx=s.x*.5+.5,sy=s.y*.5+.5,mk=this.m.shaftMask;mk.uniforms.tColor.value=this.scene.texture;mk.uniforms.tDepth.value=this.scene.depthTexture;mk.uniforms.uSunUV.value.set(sx,sy);mk.uniforms.uAspect.value=IW/IH;mk.uniforms.uThreshold.value=this.hdr?1.5:.8;this.pass(mk,this.shafts[0]);
          const b=this.m.shaftBlur;b.uniforms.uSunUV.value.set(sx,sy);b.uniforms.uFrame.value=this.frame%64;b.uniforms.tSrc.value=this.shafts[0].texture;b.uniforms.uStep.value=.55;this.pass(b,this.shafts[1]);b.uniforms.tSrc.value=this.shafts[1].texture;b.uniforms.uStep.value=.22;this.pass(b,this.shafts[0]);shaftsOn=vis;}}
      // 5b. Shadowed volumetric fog from the cascaded shadow maps.
      G.begin('Volumetric fog');
      let volOn=0;const vf=o.volumetricFog;if(o.volumetrics&&vf.enabled&&sun&&this.depthOK){const v=this.m.volume,vu=v.uniforms;this.bindDepth(v,near,far,texel);let nc=0;
        const cs=this.shadowSource,lightsC=cs?cs.lights:[sun];for(let i=0;i<Math.min(4,lightsC.length);i++){const l=lightsC[i];if(!l.castShadow||!l.shadow||!l.shadow.map)break;vu['tShadow'+i].value=l.shadow.map.texture;vu['uShadowM'+i].value.copy(l.shadow.matrix);nc++;}
        const sp=cs&&cs.splits&&cs.splits.length>1?cs.splits:[0,vf.maxDistance];vu.uSplits.value.set(sp[1]||1e9,sp[2]||1e9,sp[3]||1e9,sp[4]||1e9);if(!cs&&nc)vu.uSplits.value.x=1e9;vu.uCascades.value=R.shadowMap.enabled?nc:0;
        vu.uInvView.value.copy(camera.matrixWorld);vu.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);vu.uSunDir.value.copy(this._sunWorld);vu.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity*vf.intensity);
        vu.uDensity.value=vf.density;vu.uFalloff.value=vf.falloff;vu.uHeight.value=vf.height;vu.uG.value=vf.anisotropy;vu.uMaxDist.value=vf.maxDistance;vu.uFrame.value=this.frame%64;if(v.defines.STEPS!==vf.steps){v.defines.STEPS=vf.steps;v.needsUpdate=true;}
        if(vu.uSunColor.value.r+vu.uSunColor.value.g+vu.uSunColor.value.b>.01){this.pass(v,this.vol[0]);this.blur(this.vol,halfTexel,1);volOn=1;}}
      // 6. Lighting composite with height fog.
      G.begin('Composite + fog');
      const c=this.m.composite,cu=c.uniforms,f=o.fog;this.bindDepth(c,near,far,texel);cu.tColor.value=this.scene.texture;cu.tAO.value=o.gtao?this.ao[0].texture:this._white;cu.tGI.value=giTex;cu.tShafts.value=this.shafts[0].texture;cu.uInvView.value.copy(camera.matrixWorld);cu.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);cu.uHalfTexel.value.copy(halfTexel);
      cu.uAO.value=o.gtao?o.aoStrength:0;cu.uGI.value=o.ssgi?o.giStrength:0;cu.uShafts.value=shaftsOn*o.shaftStrength*(volOn?.5:1);cu.tVol.value=this.vol[0].texture;cu.uVol.value=volOn;cu.uFog.value=f.enabled&&this.depthOK?1:0;Object.assign(cu.uFogDensity,{value:f.density});cu.uFogFalloff.value=f.falloff;cu.uFogHeight.value=f.height;cu.uFogStart.value=f.start;cu.uFogMax.value=f.maxOpacity;cu.uFogColor.value.copy(f.color);
      cu.uSunDir.value.copy(this._sunWorld.lengthSq()?this._sunWorld:this._v3.set(0,1,0));if(sun){cu.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity*(volOn?.25:o.volumetrics?1:.35));cu.uShaftColor.value.copy(sun.color).multiplyScalar(sun.intensity);}else cu.uSunColor.value.setRGB(0,0,0);cu.uInscatter.value=f.inscatter;cu.uInscatterExp.value=f.inscatterExponent;cu.uFogSky.value=f.sky;
      this.pass(c,this.lit);let current=this.lit;
      // 7. Temporal anti-aliasing.
      G.begin('TAA / upscale');
      if(o.taa){const a=this.m.taa,u=a.uniforms,wi=this.frame&1;u.tCurrent.value=this.lit.texture;u.tHistory.value=this.taa[wi^1].texture;u.tDepth.value=this.scene.depthTexture;u.uInvView.value.copy(camera.matrixWorld);u.uTexel.value.copy(dtexel);u.uCurTexel.value.copy(texel);u.uBlend.value=o.taaBlend*(IW<W?.8:1);u.uValid.value=frameValid?1:0;this.pass(a,this.taa[wi]);current=this.taa[wi];this.historyValid=true;}
      else{this.historyValid=false;}
      // 8. Depth of field and motion blur.
      G.begin('DOF + motion blur');
      let pi=0;if(o.dof.enabled){const g=this.m.dofGather,u=g.uniforms,d=o.dof;this.bindDepth(g,near,far,texel);u.tColor.value=current.texture;u.uFocus.value=d.focusDistance;u.uAperture.value=d.aperture;u.uMaxBlur.value=d.maxBlur;u.uAutoFocus.value=d.autoFocus?1:0;u.uFullTexel.value.copy(dtexel);this.pass(g,this.dofBlur);
        const cb=this.m.dofCombine;cb.uniforms.tColor.value=current.texture;cb.uniforms.tBlur.value=this.dofBlur.texture;this.pass(cb,this.post[pi]);current=this.post[pi];pi^=1;}
      if(o.motionBlur.enabled&&frameValid){const mb=this.m.motion;this.bindDepth(mb,near,far,dtexel);mb.uniforms.tColor.value=current.texture;mb.uniforms.uInvView.value.copy(camera.matrixWorld);mb.uniforms.uStrength.value=o.motionBlur.strength*clamp(1/(60*Math.max(dt,1e-3)),.25,2);mb.uniforms.uFrame.value=this.frame%64;this.pass(mb,this.post[pi]);current=this.post[pi];pi^=1;}
      // 9. Bloom.
      G.begin('Bloom');
      let bloomTex=this._black;if(o.bloom&&this.bloomMips.length){const d=this.m.bloomDown,u=this.m.bloomUp;let src=current;
        const th=this.hdr?o.bloomThreshold:.8,knee=Math.max(1e-4,th*o.bloomKnee);d.uniforms.uCurve.value.set(th-knee,knee*2,.25/knee,th);
        this.bloomMips.forEach((t,i)=>{d.uniforms.tSrc.value=src.texture;d.uniforms.uTexel.value.set(1/src.width,1/src.height);d.uniforms.uFirst.value=i===0?1:0;this.pass(d,t);src=t;});
        for(let i=this.bloomMips.length-2;i>=0;i--){const s=this.bloomMips[i+1];u.uniforms.tSrc.value=s.texture;u.uniforms.uTexel.value.set(1/s.width,1/s.height);u.uniforms.uRadius.value=o.bloomRadius;this.pass(u,this.bloomMips[i]);}
        bloomTex=this.bloomMips[0].texture;}
      // 10. Eye adaptation.
      G.begin('Eye adaptation');
      let expTex=this._white;if(o.autoExposure){const l=this.m.lum,r=this.m.reduce;l.uniforms.tSrc.value=current.texture;l.uniforms.uTexel.value.set(1/64,1/64);this.pass(l,this.lumTargets[0]);
        for(let i=1;i<4;i++){const s=this.lumTargets[i-1];r.uniforms.tSrc.value=s.texture;r.uniforms.uTexel.value.set(1/s.width,1/s.height);this.pass(r,this.lumTargets[i]);}
        const ad=this.m.adapt,ai=this.frame&1;ad.uniforms.tCur.value=this.lumTargets[3].texture;ad.uniforms.tPrev.value=this.adapt[ai^1].texture;ad.uniforms.uDt.value=clamp(dt,0,.25);ad.uniforms.uUp.value=o.adaptUp;ad.uniforms.uDown.value=o.adaptDown;ad.uniforms.uValid.value=this.adaptValid?1:0;this.pass(ad,this.adapt[ai]);this.adaptValid=true;expTex=this.adapt[ai].texture;}
      // 10b. Local exposure grid: log luminance at 64×N, then a separable blur.
      G.begin('Local exposure');
      const le=o.localExposure,localOn=!!(le&&le.enabled&&this.hdr&&this.localLum);
      if(localOn){const [la,lb,lc]=this.localLum,ll=this.m.localLum,bl=this.m.localBlur;ll.uniforms.tSrc.value=current.texture;ll.uniforms.uTexel.value.set(1/la.width,1/la.height);this.pass(ll,la);
        bl.uniforms.tSrc.value=la.texture;bl.uniforms.uDir.value.set(1.5/la.width,0);this.pass(bl,lb);bl.uniforms.tSrc.value=lb.texture;bl.uniforms.uDir.value.set(0,1.5/la.height);this.pass(bl,lc);}
      // 11. Final grade to the screen (or through FXAA).
      G.begin('Final + FXAA');
      const fm=this.m.final,fu=fm.uniforms,g=o.grading;fu.tInput.value=current.texture;fu.tBloom.value=bloomTex;fu.tExposure.value=expTex;fu.tAO.value=o.gtao?this.ao[0].texture:this._white;fu.tGI.value=giTex;fu.tDepth.value=this.scene.depthTexture;fu.tScene.value=this.colorCopy.texture;
      fu.uAuto.value=o.autoExposure?1:0;fu.uManual.value=o.exposure*(R.toneMappingExposure||1);fu.uComp.value=o.exposureCompensation;fu.uKey.value=o.exposureKey;fu.uExpRange.value.set(o.minExposure,o.maxExposure);fu.uBloom.value=o.bloom?o.bloomStrength:0;fu.uFlare.value=o.bloom?o.lensFlare:0;
      fu.uWB.value.copy(this.whiteBalance(g.temperature,g.tint));fu.uSat.value=g.saturation;fu.uContrast.value=g.contrast;fu.uLift.value.fromArray(g.lift);fu.uGamma.value.fromArray(g.gamma);fu.uGain.value.fromArray(g.gain);fu.uVignette.value=g.vignette;fu.uGrain.value=g.grain;fu.uCA.value=g.chromaticAberration;
      fu.uSharpen.value=o.taa?o.sharpen*(IW<W?1.6:1):0;fu.uTexel.value.copy(dtexel);fu.uTime.value=(fu.uTime.value+dt)%1000;fu.uEncode.value=R.outputEncoding===T.sRGBEncoding?1:0;fu.uDebug.value=DEBUG_VIEWS[o.debugView]||0;fu.uNear.value=near;fu.uFar.value=far;
      fu.uLocalOn.value=localOn?1:0;if(localOn){fu.tLocal.value=this.localLum[0].texture;fu.tLocalBlur.value=this.localLum[2].texture;fu.uLocalTexel.value.set(1/this.localLum[0].width,1/this.localLum[0].height);fu.uLocal.value.set(le.highlightContrast,le.shadowContrast,le.detail,le.blurredBlend);}else{fu.tLocal.value=fu.tLocalBlur.value=this._black;}
      if(o.fxaa){this.pass(fm,this.ldr);this.m.fxaa.uniforms.tSrc.value=this.ldr.texture;this.m.fxaa.uniforms.uTexel.value.copy(dtexel);this.pass(this.m.fxaa,prevTarget);}else this.pass(fm,prevTarget);
    }finally{
      camera.layers.mask=prevMask;scene.background=prevBg;scene.fog=prevFog;R.toneMapping=prevTone;R.autoClear=prevAutoClear;G.end();R.setRenderTarget(prevTarget);R.info.autoReset=prevInfo;R.info.render.frame++;/* a following direct render must not share this frame id, or r128 skips its buffer uploads */
      if(jitter)camera.clearViewOffset();
    }
    this.prevViewProj.copy(this.viewProj);this.stats.ms=performance.now()-t0;
  }
  bindDepth(m,near,far,texel){const u=m.uniforms;u.tDepth.value=this.scene.depthTexture;u.uNear.value=near;u.uFar.value=far;u.uTexel.value.copy(texel);}
  blur(pair,halfTexel,channel){const b=this.m.blur;b.uniforms.uDepthChannel.value=channel;b.uniforms.tSrc.value=pair[0].texture;b.uniforms.uDir.value.set(halfTexel.x,0);this.pass(b,pair[1]);b.uniforms.tSrc.value=pair[1].texture;b.uniforms.uDir.value.set(0,halfTexel.y);this.pass(b,pair[0]);}
  /* Approximate white balance multiplier from temperature (-1 cool .. +1 warm) and tint (-1 green .. +1 magenta). */
  whiteBalance(t,tint){const v=this._wb||(this._wb=new this.THREE.Vector3());v.set(1+t*.18-tint*.04,1-Math.abs(t)*.02+tint*.12*-1,1-t*.22-tint*.04);const l=v.x*.2126+v.y*.7152+v.z*.0722;return v.multiplyScalar(1/l);}
  disposeTargets(){for(const t of this.targets){if(t.depthTexture)t.depthTexture.dispose();t.dispose();}this.targets.length=0;this.size=[0,0];this.internal=[0,0];}
  dispose(){this.gpu.dispose();this.disposeTargets();for(const m of Object.values(this.m))m.dispose();this.quad.dispose();this._black.dispose();this._white.dispose();if(this.onSettings)this.onSettings();const U=this.uniforms;U.keSceneColor.value=null;U.keSceneDepth.value=null;U.keHasScene.value=0;this.enabled=false;}
};
KE.registerModule('pipeline',{provides:['Pipeline','GLSL.ssr']});
})();
