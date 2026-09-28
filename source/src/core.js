/*!
 * kitsune enginev2 — offline stylized rendering and gameplay systems for three.js r128 games.
 * Single file, no build step, works offline. MIT License. Made for Bobe's games.
 *
 * Modules (all take THREE as the first argument so the engine never hard-codes a version):
 *   KE.settings / KE.PRESETS / KE.applyPreset / KE.saveSettings / KE.detectPreset
 *   KE.materials(THREE)            generated/procedural ground color and packed relief: grass, sand, dirt, stone, rock, snow, ash, wood
 *   KE.splatMaterial(THREE,mats)   standard terrain: 8 diffuse textures, packed relief, height blend, triplanar cliffs
 *   KE.terrain(THREE,opts)         chunked terrain with smooth bicubic subdivision, extra detail and exact heightAt()
 *   KE.sky(THREE,scene,opts)       gradient sky dome + sun and moon glow sprites
 *   KE.dayCycle(THREE,ctx)         moves sun/moon, colors light, fog and sky for a day fraction 0..1
 *   KE.water(THREE,scene,opts)     terrain-aware foam water, with legacy scrolling-normal fallback
 *   KE.wind(THREE,material,opts)   makes instanced foliage sway (trees, bamboo)
 *   KE.grass(THREE,scene,opts)     thousands of wind-blown grass blades that follow the camera
 *   KE.glow(THREE,scene,points)    one-draw-call glowing light points (lanterns, windows)
 *   KE.Post(THREE,renderer,opts)   HDR-capable bloom, depth occlusion, FXAA, color grade and vignette
 *   KE.objectTextures/triplanar    painterly detail textures for buildings, roofs, wood, stone, leaves (toon, world-space)
 *   KE.spriteShadow                character-shaped shadows for flat sprites
 *   KE.Physics                     tiny physics: gravity, bounce, friction, wall collisions, body-body pushes
 *   KE.FPS                         frame-rate meter with auto quality downgrade
 *   KE.settingsPanel(onChange)     ready-made graphics settings UI (returns an HTMLElement)
 */
(function(){
'use strict';
const KE={name:'kitsune enginev2',version:'2.1.0',legacyVersion:'3.3'};
const clamp=(v,a,b)=>v<a?a:v>b?b:v;

/* ---------- settings and quality presets ---------- */
KE.PRESETS={
  low:   {preset:'low',cam:'follow',terrain:1,   scale:.75,shadows:false,shadowRes:1024,tex:128,grass:0,    bloom:false,aa:false,fx:false,view:70, aniso:1},
  medium:{preset:'medium',cam:'follow',terrain:1,scale:1,  shadows:true, shadowRes:1024,tex:256,grass:3000, bloom:false,aa:false,fx:true, view:95, aniso:2},
  high:  {preset:'high',cam:'follow',terrain:2,  scale:1.25,shadows:true,shadowRes:1536,tex:256,grass:7000, bloom:true, aa:true, fx:true, view:120,aniso:4},
  ultra: {preset:'ultra',cam:'follow',terrain:2, scale:1.6,shadows:true, shadowRes:2048,tex:512,grass:14000,bloom:true, aa:true, fx:true, view:160,aniso:8}
};
KE.detectPreset=()=>{const c=navigator.hardwareConcurrency||4,m=navigator.deviceMemory||4,d=window.devicePixelRatio||1;
  if(c<=4||m<=3)return 'low';if(c>=8&&m>=8)return 'high';return 'medium';};
KE.loadSettings=()=>{let s=null;try{s=JSON.parse(localStorage.getItem('ke_settings')||'null');}catch(e){}
  const base=KE.PRESETS[(s&&s.preset&&KE.PRESETS[s.preset])?s.preset:KE.detectPreset()];return Object.assign({},base,s||{},{auto:!s||s.auto!==false});};
KE.saveSettings=s=>{try{localStorage.setItem('ke_settings',JSON.stringify(s));}catch(e){}};
KE.settings=KE.loadSettings();
KE.applyPreset=(name,opts={})=>{if(!Object.prototype.hasOwnProperty.call(KE.PRESETS,name))throw new RangeError('Unknown quality preset: '+name);const keep={showFps:!!KE.settings.showFps,cam:KE.settings.cam};Object.assign(KE.settings,KE.PRESETS[name],keep,{auto:!!opts.auto,custom:false});KE.saveSettings(KE.settings);return KE.settings;};

/* ---------- noise ---------- */
const NOISE=(()=>{const a=new Float32Array(65536);let s=12345;for(let i=0;i<65536;i++){s=(s*1103515245+12345)&0x7fffffff;a[i]=s/0x7fffffff;}return a;})();
function pnz(x,y,P){const X=Math.floor(x),Y=Math.floor(y),fx=x-X,fy=y-Y,m=v=>((v%P)+P)%P,sx=fx*fx*(3-2*fx),sy=fy*fy*(3-2*fy);
  const a=NOISE[m(Y)*256+m(X)],b=NOISE[m(Y)*256+m(X+1)],c=NOISE[m(Y+1)*256+m(X)],d=NOISE[m(Y+1)*256+m(X+1)];return (a+(b-a)*sx)*(1-sy)+(c+(d-c)*sx)*sy;}
KE.tileNoise=(x,y,S,P)=>pnz(x*P/S,y*P/S,P)*.5+pnz(x*P*2/S+17,y*P*2/S,P*2)*.3+pnz(x*P*4/S+5,y*P*4/S+9,P*4)*.2;
KE.noise=pnz;

/* ---------- procedural materials ---------- */
function canvasTex(THREE,S,draw,rep,aniso){const c=document.createElement('canvas');c.width=c.height=S;draw(c.getContext('2d'),S);const t=new THREE.CanvasTexture(c);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;if(rep)t.repeat.set(rep,rep);t.anisotropy=aniso||KE.settings.aniso||1;return t;}
KE.canvasTex=canvasTex;
KE.MATERIAL_KINDS=['grass','sand','dirt','stone','rock','snow','ash','wood'];
/* ---------- Genshin-style painterly ground materials (v3.1) ---------- */
function tileCanvas(S){const c=document.createElement('canvas');c.width=c.height=S;return c;}
function blurTile(src,px){const S=src.width,big=tileCanvas(S*3),bg=big.getContext('2d');for(let y=0;y<3;y++)for(let x=0;x<3;x++)bg.drawImage(src,x*S,y*S);
  const out=tileCanvas(S),og=out.getContext('2d');og.filter=`blur(${px}px)`;og.drawImage(big,-S,-S);og.filter='none';return out;}
function painter(g,S){const wrap=(x,y,r,fn)=>{for(const ox of (x<r?[0,S]:x>S-r?[0,-S]:[0]))for(const oy of (y<r?[0,S]:y>S-r?[0,-S]:[0]))fn(x+ox,y+oy);};
  return {blob(x,y,rx,ry,rot,col){wrap(x,y,Math.max(rx,ry),(X,Y)=>{g.fillStyle=col;g.beginPath();g.ellipse(X,Y,rx,ry,rot,0,Math.PI*2);g.fill();});},
    stroke(x,y,x2,y2,w,col){wrap(x,y,Math.hypot(x2-x,y2-y)+w,(X,Y)=>{g.strokeStyle=col;g.lineWidth=w;g.lineCap='round';g.beginPath();g.moveTo(X,Y);g.lineTo(X+x2-x,Y+y2-y);g.stroke();});},
    poly(pts,col,line){const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]),cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2,r=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys));
      wrap(cx,cy,r,(X,Y)=>{g.beginPath();pts.forEach(([px,py],i)=>{const a=px-cx+X,b=py-cy+Y;i?g.lineTo(a,b):g.moveTo(a,b);});g.closePath();g.fillStyle=col;g.fill();if(line){g.strokeStyle=line;g.lineWidth=S/256*1.5;g.stroke();}});}};}
const hsl=(h,s,l,a=1)=>`hsla(${h},${s}%,${l}%,${a})`;
KE.materials=(THREE,size)=>{const S=size||KE.settings.tex||256,f=S/256,R=Math.random,rr=(a,b)=>a+R()*(b-a);
  const make=(kind)=>{let c=tileCanvas(S),g=c.getContext('2d'),P=painter(g,S);
    const layer=(n,rmin,rmax,cols,blur)=>{const l=tileCanvas(S),lg=l.getContext('2d'),LP=painter(lg,S);for(let i=0;i<n;i++){const r=rr(rmin,rmax)*S;LP.blob(R()*S,R()*S,r,r*rr(.5,1),R()*3,cols[i%cols.length]);}g.drawImage(blur?blurTile(l,blur*f):l,0,0);};
    if(kind==='grass'){g.fillStyle='#74b243';g.fillRect(0,0,S,S);layer(160,.04,.13,[hsl(96,48,38,.55),hsl(84,58,52,.5),hsl(78,62,58,.45),hsl(104,45,33,.5)],6);
      for(let i=0;i<2600*f*f;i++){const x=R()*S,y=R()*S,l=rr(4,10)*f,dark=R()<.45;for(let k=-1;k<=1;k++){const a=-Math.PI/2+k*.35+rr(-.15,.15);P.stroke(x,y,x+Math.cos(a)*l*.5,y+Math.sin(a)*l,1.3*f,dark?hsl(104,48,30,.45):hsl(82,65,66,.5));}}
      for(let i=0;i<14;i++){const cx=R()*S,cy=R()*S,col=[hsl(0,0,98),hsl(48,95,68),hsl(330,80,82)][i%3];for(let k=0;k<5;k++)P.blob(cx+rr(-8,8)*f,cy+rr(-8,8)*f,1.6*f,1.6*f,0,col);}}
    else if(kind==='sand'){g.fillStyle='#ead7a6';g.fillRect(0,0,S,S);layer(90,.05,.16,[hsl(42,55,72,.5),hsl(38,50,80,.5),hsl(35,40,66,.35)],7);
      for(let k=0;k<9;k++){const y0=k*S/9,amp=rr(3,7)*f,ph=R()*6;g.strokeStyle=k%2?hsl(40,45,64,.45):hsl(45,70,90,.55);g.lineWidth=2.2*f;g.beginPath();for(let x=0;x<=S;x+=4){const y=y0+Math.sin(x/S*Math.PI*2*2+ph)*amp;x?g.lineTo(x,y):g.moveTo(x,y);}g.stroke();}
      for(let i=0;i<260*f*f;i++)P.blob(R()*S,R()*S,.8*f,.8*f,0,R()<.5?hsl(45,60,92,.7):hsl(30,35,55,.5));}
    else if(kind==='dirt'){g.fillStyle='#c39a69';g.fillRect(0,0,S,S);layer(120,.04,.14,[hsl(30,40,50,.45),hsl(36,50,70,.45),hsl(26,35,42,.35)],6);
      for(let i=0;i<110*f*f;i++){const x=R()*S,y=R()*S,r=rr(2,5)*f;P.blob(x+r*.3,y+r*.35,r,r*.8,0,hsl(28,30,36,.35));P.blob(x,y,r,r*.8,0,hsl(32,22,rr(58,70)));P.blob(x-r*.3,y-r*.3,r*.45,r*.3,0,hsl(40,40,86,.6));}}
    else if(kind==='stone'){g.fillStyle='#5f564d';g.fillRect(0,0,S,S);const n=9,cs=S/n;
      for(let j=0;j<n;j++)for(let i=0;i<n;i++){const jx=(NOISE[(j*31+i*17)&65535]-.5)*cs*.35,jy=(NOISE[(j*13+i*29+7)&65535]-.5)*cs*.3,x=i*cs+cs/2+jx+(j%2)*cs*.5,y=j*cs+cs/2+jy,w=cs*rr(.72,.95),h=cs*rr(.62,.86),l=rr(54,68),hu=rr(26,40),rot=rr(-.5,.5),k=6+Math.floor(R()*3),pts=[];
        for(let a=0;a<k;a++){const an=a/k*Math.PI*2+rr(-.25,.25);pts.push([x+Math.cos(an+rot)*w/2*rr(.85,1.05),y+Math.sin(an+rot)*h/2*rr(.85,1.05)]);}
        P.poly(pts.map(([a,b])=>[a+1.5*f,b+2*f]),hsl(28,18,26,.55));P.poly(pts,hsl(hu,rr(10,18),l));P.blob(x-w*.12,y-h*.14,w*.26,h*.18,rot,hsl(hu,22,Math.min(86,l+9),.45));P.blob(x+w*.15,y+h*.18,w*.22,h*.14,rot,hsl(hu,14,l-10,.35));
        if(R()<.25)P.blob(x+rr(-.3,.3)*w,y+rr(-.3,.3)*h,w*.14,h*.1,0,hsl(95,35,42,.45));}
      g.drawImage(blurTile(c,.9*f),0,0);}
    else if(kind==='rock'){g.fillStyle='#857c70';g.fillRect(0,0,S,S);
      for(let i=0;i<50;i++){const x=R()*S,y=R()*S,r=rr(.06,.17)*S,k=5+Math.floor(R()*3),pts=[];for(let a=0;a<k;a++){const an=a/k*Math.PI*2+rr(-.2,.2);pts.push([x+Math.cos(an)*r*rr(.7,1.15),y+Math.sin(an)*r*rr(.45,.8)]);}
        P.poly(pts,hsl(rr(26,40),rr(8,16),rr(38,60)),hsl(25,18,28,.55));}
      c=blurTile(c,1.3*f);g=c.getContext('2d');P=painter(g,S);
      for(let k=0;k<7;k++){const y0=k*S/7+rr(-4,4)*f;g.strokeStyle=hsl(28,22,28,.35);g.lineWidth=2.5*f;g.beginPath();for(let x=0;x<=S;x+=8){const y=y0+Math.sin(x/S*Math.PI*2+k)*4*f;x?g.lineTo(x,y):g.moveTo(x,y);}g.stroke();
        g.strokeStyle=hsl(40,40,80,.28);g.lineWidth=1.6*f;g.beginPath();for(let x=0;x<=S;x+=8){const y=y0-3*f+Math.sin(x/S*Math.PI*2+k)*4*f;x?g.lineTo(x,y):g.moveTo(x,y);}g.stroke();}
      for(let i=0;i<70;i++){const x=R()*S,y=R()*S,a=rr(-2.6,-1.9);P.stroke(x,y,x+Math.cos(a)*rr(8,22)*f,y+Math.sin(a)*rr(8,22)*f,2.2*f,hsl(40,45,84,.35));}
      for(let i=0;i<40;i++){let x=R()*S,y=R()*S;for(let k=0;k<4;k++){const nx=x+rr(-10,10)*f,ny=y+rr(4,12)*f;P.stroke(x,y,nx,ny,1.4*f,hsl(25,25,20,.55));x=nx;y=ny;}}}
    else if(kind==='snow'){g.fillStyle='#eef4fc';g.fillRect(0,0,S,S);layer(110,.05,.16,[hsl(214,55,86,.55),hsl(210,40,97,.6),hsl(222,45,82,.35)],8);
      for(let i=0;i<180*f*f;i++)P.blob(R()*S,R()*S,.9*f,.9*f,0,'rgba(255,255,255,.95)');}
    else if(kind==='ash'){g.fillStyle='#4b4547';g.fillRect(0,0,S,S);layer(130,.04,.14,[hsl(350,6,24,.55),hsl(20,8,38,.45),hsl(0,4,30,.5)],6);
      for(let i=0;i<60*f*f;i++)P.blob(R()*S,R()*S,1.1*f,1.1*f,0,R()<.5?hsl(22,95,60,.8):hsl(40,95,70,.6));}
    else{const rows=6,rh=S/rows;for(let j=0;j<rows;j++){g.fillStyle=hsl(rr(24,32),rr(38,48),rr(38,48));g.fillRect(0,j*rh,S,rh);
        for(let k=0;k<14;k++){g.strokeStyle=hsl(26,40,rr(26,34),.35);g.lineWidth=1.2*f;g.beginPath();const y=j*rh+rr(4,rh-4);g.moveTo(0,y);for(let x=0;x<=S;x+=16)g.lineTo(x,y+Math.sin(x*.03+k)*2*f);g.stroke();}
        g.fillStyle=hsl(24,40,18,.8);g.fillRect(0,j*rh,S,2.5*f);g.fillStyle=hsl(36,50,70,.35);g.fillRect(0,j*rh+2.5*f,S,1.5*f);}}
    const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=KE.settings.aniso||4;
    const d=c.getContext('2d').getImageData(0,0,S,S).data;let r=0,gg=0,b=0,n=0;for(let i=0;i<d.length;i+=64){r+=d[i];gg+=d[i+1];b+=d[i+2];n++;}t.userData=t.userData||{};t.userData.avg=[r/n/255,gg/n/255,b/n/255];return t;};
  return KE.MATERIAL_KINDS.map(make);};
KE.splatMaterial=(THREE,mats,opts={})=>{
  const ramp=(()=>{const c=tileCanvas(4);c.height=1;const g=c.getContext('2d');[78,150,228,255].forEach((v,i)=>{g.fillStyle=`rgb(${v},${v},${v})`;g.fillRect(i,0,1,1);});const t=new THREE.CanvasTexture(c);
    t.minFilter=t.magFilter=THREE.LinearFilter;t.generateMipmaps=false;return t;})();
  const mat=opts.flat?new THREE.MeshPhongMaterial({vertexColors:true,shininess:4,specular:0x0a0a0a}):new THREE.MeshToonMaterial({vertexColors:true,gradientMap:ramp});
  const macro=canvasTex(THREE,256,(g,s)=>{const d=g.createImageData(s,s);for(let y=0;y<s;y++)for(let x=0;x<s;x++){const v=KE.tileNoise(x,y,s,4),w=KE.tileNoise(x+71,y+13,s,16);d.data.set([v*255,w*255,KE.tileNoise(x+9,y+40,s,32)*255,255],(y*s+x)*4);}g.putImageData(d,0,0);});
  const sc=(opts.scale||.4).toFixed(3),hq=(KE.settings.tex||256)>=256;
  mat.onBeforeCompile=sh=>{mats.forEach((t,k)=>sh.uniforms['tM'+k]={value:t});sh.uniforms.tMacro={value:macro};sh.uniforms.uAvg={value:mats.map(t=>new THREE.Vector3(...((t.userData&&t.userData.avg)||[.5,.5,.5])))};
    sh.vertexShader='attribute vec4 splatA;attribute vec4 splatB;varying vec4 vSA;varying vec4 vSB;varying vec3 vWP;varying vec3 vWN;\n'+sh.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nvSA=splatA;vSB=splatB;vWP=(modelMatrix*vec4(position,1.0)).xyz;vWN=normalize(mat3(modelMatrix)*objectNormal);');
    sh.fragmentShader=`uniform sampler2D tM0;uniform sampler2D tM1;uniform sampler2D tM2;uniform sampler2D tM3;uniform sampler2D tM4;uniform sampler2D tM5;uniform sampler2D tM6;uniform sampler2D tM7;uniform sampler2D tMacro;uniform vec3 uAvg[8];
varying vec4 vSA;varying vec4 vSB;varying vec3 vWP;varying vec3 vWN;
vec3 ke2(sampler2D t,vec2 a,vec2 b,float m){${hq?'return mix(texture2D(t,a).rgb,texture2D(t,b).rgb,m);':'return texture2D(t,a).rgb;'}}
`+sh.fragmentShader.replace('#include <map_fragment>',`
float kd=length(vWP-cameraPosition);vec2 u1=vWP.xz*${sc};vec2 u2=mat2(0.8,-0.6,0.6,0.8)*u1*0.63+vec2(0.37,0.19);
vec3 mc=texture2D(tMacro,vWP.xz*0.02).rgb;float am=smoothstep(0.3,0.7,mc.r);float hn=texture2D(tMacro,vWP.xz*0.11).g;
vec4 A=vSA*vec4(1.0+(hn-0.5)*1.4,1.0+(0.5-hn)*0.9,1.0+(mc.b-0.5)*1.2,1.0+(hn-0.5)*0.5);vec4 B=vSB*vec4(1.0+(0.5-hn)*1.0,1.0+(hn-0.5)*0.9,1.0,1.0);
A=pow(max(A,0.0),vec4(2.4));B=pow(max(B,0.0),vec4(2.4));float ws=dot(A,vec4(1.0))+dot(B,vec4(1.0))+1e-4;A/=ws;B/=ws;
vec3 an=abs(normalize(vWN));an=pow(an,vec3(4.0));an/=(an.x+an.y+an.z);
vec3 rk=texture2D(tM4,vWP.zy*0.22).rgb*an.x+ke2(tM4,u1*0.5,u2*0.5,am)*an.y+texture2D(tM4,vWP.xy*0.22).rgb*an.z;
vec3 kc=ke2(tM0,u1,u2,am)*A.x+ke2(tM1,u1*0.8,u2*0.8,am)*A.y+ke2(tM2,u1,u2,am)*A.z+texture2D(tM3,u1*0.8).rgb*A.w+rk*B.x+ke2(tM5,u1*0.7,u2*0.7,am)*B.y+texture2D(tM6,u1).rgb*B.z+texture2D(tM7,u1*vec2(0.5,1.0)).rgb*B.w;
vec3 fc=uAvg[0]*A.x+uAvg[1]*A.y+uAvg[2]*A.z+uAvg[3]*A.w+uAvg[4]*B.x+uAvg[5]*B.y+uAvg[6]*B.z+uAvg[7]*B.w;
kc=mix(kc,fc,smoothstep(22.0,75.0,kd)*0.75);
kc*=mix(vec3(0.9,0.97,1.04),vec3(1.07,1.03,0.93),mc.g)*(0.92+0.16*mc.r);
diffuseColor.rgb*=pow(max(kc,vec3(0.0)),vec3(1.12))*1.18;`);};
  mat.customProgramCacheKey=()=>`ke-splat-v2:${sc}:${hq}:${!!opts.flat}`;mat.userData.keTextures=[...mats,macro,ramp];
  return mat;};

/* ---------- object detail textures (grayscale, multiplied by each object's own color) ---------- */
KE.toonRamp=(THREE)=>{if(KE._ramp)return KE._ramp;const c=tileCanvas(4);c.height=1;const g=c.getContext('2d');[88,158,230,255].forEach((v,i)=>{g.fillStyle=`rgb(${v},${v},${v})`;g.fillRect(i,0,1,1);});
  const t=new THREE.CanvasTexture(c);t.minFilter=t.magFilter=THREE.LinearFilter;t.generateMipmaps=false;return KE._ramp=t;};
KE.objectTextures=(THREE)=>{if(KE._objTex)return KE._objTex;const S=256,R=Math.random,rr=(a,b)=>a+R()*(b-a),out={};
  const mk=(kind,draw)=>{const c=tileCanvas(S),g=c.getContext('2d'),P=painter(g,S);draw(g,P,c);const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=KE.settings.aniso||4;out[kind]=t;};
  const gray=(l,a=1)=>`hsla(0,0%,${l}%,${a})`;
  mk('plaster',(g,P,c)=>{g.fillStyle=gray(92);g.fillRect(0,0,S,S);for(let i=0;i<120;i++)P.blob(R()*S,R()*S,rr(8,30),rr(6,20),R()*3,gray(rr(82,100),.35));
    g.drawImage(blurTile(c,4),0,0);g.fillStyle=gray(62,.9);g.fillRect(0,0,S,8);g.fillRect(0,S/2-3,S,6);g.fillRect(0,0,8,S);g.fillRect(S/2-4,0,8,S);});
  mk('roof',(g)=>{g.fillStyle=gray(80);g.fillRect(0,0,S,S);const rows=8,rh=S/rows,cols=8,cw=S/cols;
    for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const x=i*cw+(j%2)*cw/2,y=j*rh;for(const ox of [0,-S]){const gr=g.createLinearGradient(0,y,0,y+rh);gr.addColorStop(0,gray(106));gr.addColorStop(.7,gray(88));gr.addColorStop(1,gray(58));
      g.fillStyle=gr;g.beginPath();g.moveTo(x+ox+2,y);g.lineTo(x+ox+cw-2,y);g.quadraticCurveTo(x+ox+cw,y+rh*.9,x+ox+cw/2,y+rh);g.quadraticCurveTo(x+ox,y+rh*.9,x+ox+2,y);g.fill();}}});
  mk('wood',(g)=>{const rows=4,rh=S/rows;for(let j=0;j<rows;j++){g.fillStyle=gray(rr(80,96));g.fillRect(0,j*rh,S,rh);for(let k=0;k<12;k++){g.strokeStyle=gray(rr(60,75),.45);g.lineWidth=1.5;g.beginPath();const y=j*rh+rr(3,rh-3);g.moveTo(0,y);
      for(let x=0;x<=S;x+=16)g.lineTo(x,y+Math.sin(x*.035+k*1.7)*2.5);g.stroke();}g.fillStyle=gray(45,.9);g.fillRect(0,j*rh,S,3);g.fillStyle=gray(108,.5);g.fillRect(0,j*rh+3,S,2);}});
  mk('bark',(g)=>{g.fillStyle=gray(85);g.fillRect(0,0,S,S);for(let i=0;i<60;i++){const x=R()*S,w=rr(3,9);g.fillStyle=gray(rr(60,78),.55);g.fillRect(x,0,w,S);g.fillRect(x-S,0,w,S);}
    for(let i=0;i<40;i++){g.fillStyle=gray(108,.35);g.fillRect(R()*S,R()*S,2,rr(10,30));}});
  mk('stone',(g,P,c)=>{g.fillStyle=gray(62);g.fillRect(0,0,S,S);const rows=5,rh=S/rows;for(let j=0;j<rows;j++){let x=(j%2)*rr(10,40);while(x<S+40){const w=rr(40,80);
      P.poly([[x+3,j*rh+3],[x+w-3,j*rh+3],[x+w-3,j*rh+rh-3],[x+3,j*rh+rh-3]],gray(rr(84,100)));P.blob(x+w*.35,j*rh+rh*.35,w*.25,rh*.2,0,gray(110,.4));x+=w;}}g.drawImage(blurTile(c,1.2),0,0);});
  mk('leaf',(g,P,c)=>{g.fillStyle=gray(78);g.fillRect(0,0,S,S);for(let i=0;i<260;i++){const x=R()*S,y=R()*S,r=rr(6,16),a=R()*6;P.blob(x+2,y+3,r,r*.55,a,gray(55,.5));P.blob(x,y,r,r*.55,a,gray(rr(88,112)));P.blob(x-r*.2,y-r*.15,r*.45,r*.22,a,gray(125,.5));}
    g.drawImage(blurTile(c,.8),0,0);});
  mk('lacquer',(g,P,c)=>{g.fillStyle=gray(94);g.fillRect(0,0,S,S);for(let i=0;i<80;i++)P.blob(R()*S,R()*S,rr(10,40),rr(3,8),0,gray(rr(86,104),.4));g.drawImage(blurTile(c,3),0,0);
    for(let i=0;i<30;i++){g.fillStyle=gray(115,.35);g.fillRect(R()*S,R()*S,rr(20,60),2);}});
  return KE._objTex=out;};
/* Toon material with world-space triplanar detail texture; works on normal and instanced meshes. */
KE.triplanar=(THREE,o)=>{const m=new THREE.MeshToonMaterial({color:o.color!==undefined?o.color:0xffffff,gradientMap:KE.toonRamp(THREE),emissive:o.emissive||0,transparent:!!o.transparent,opacity:o.opacity!==undefined?o.opacity:1});
  const S=(o.scale||1).toFixed(3),mul=(o.mul||1.05).toFixed(3);m.userData.tri=o.map;
  m.onBeforeCompile=sh=>{sh.uniforms.tObj={value:o.map};
    sh.vertexShader='varying vec3 vObjWP;varying vec3 vObjWN;\n'+sh.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
vec4 kwp4=vec4(transformed,1.0);vec3 kno=objectNormal;
#ifdef USE_INSTANCING
kwp4=instanceMatrix*kwp4;kno=mat3(instanceMatrix)*kno;
#endif
vObjWP=(modelMatrix*kwp4).xyz;vObjWN=normalize(mat3(modelMatrix)*kno);`);
    sh.fragmentShader='uniform sampler2D tObj;varying vec3 vObjWP;varying vec3 vObjWN;\n'+sh.fragmentShader.replace('#include <map_fragment>',`vec3 kb=pow(abs(vObjWN),vec3(3.0));kb/=(kb.x+kb.y+kb.z);
vec3 ktx=texture2D(tObj,vObjWP.zy*${S}).rgb*kb.x+texture2D(tObj,vObjWP.xz*${S}).rgb*kb.y+texture2D(tObj,vObjWP.xy*${S}).rgb*kb.z;diffuseColor.rgb*=ktx*${mul};`);};
  m.customProgramCacheKey=()=>`ke-triplanar-v2:${S}:${mul}`;m.userData.keTextures=[o.map];return m;};
/* Invisible plane that casts a character-shaped shadow from a sprite texture. Call .face(sunDir) each frame. */
KE.spriteShadow=(THREE,scene,tex,w,h)=>{const g=new THREE.PlaneGeometry(w,h);g.translate(0,h/2,0);
  const m=new THREE.Mesh(g,new THREE.MeshBasicMaterial({colorWrite:false,depthWrite:false,transparent:true,opacity:0,side:THREE.DoubleSide}));
  m.customDepthMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,map:tex,alphaTest:.5,side:THREE.DoubleSide});m.castShadow=true;m.receiveShadow=false;m.userData.noShadowTraverse=true;scene.add(m);
  m.face=d=>{m.rotation.y=Math.atan2(d.x,d.z);};return m;};

/* opts: {w,h, height(i,j), weights(i,j)->8 numbers summing to 1, tint(i,j,a)->[r,g,b], material, sub:1|2, detail(x,z)->extra height, chunk, receiveShadow}
   Returns an array of meshes. meshes.heightAt(x,z) gives the exact rendered ground height (use it to place things). */
KE.terrain=(THREE,o)=>{const W=o.w,H=o.h;if(!Number.isInteger(W)||!Number.isInteger(H)||W<2||H<2||W*H>4194304)throw new RangeError('Terrain dimensions must be integers >=2 with at most 4194304 vertices');const sub=Math.max(1,Math.min(3,Math.floor(o.sub||KE.settings.terrain||1))),mat=o.material,FW=(W-1)*sub+1,FH=(H-1)*sub+1,st=1/sub;
  const HB=new Float32Array(W*H),WB=new Float32Array(W*H*8),TB=new Float32Array(W*H*3);
  for(let j=0;j<H;j++)for(let i=0;i<W;i++){const k=j*W+i;HB[k]=o.height(i,j);if(!Number.isFinite(HB[k]))throw new TypeError('Non-finite terrain height');const a=o.weights?Array.from(o.weights(i,j)): [1,0,0,0,0,0,0,0];if(a.length!==8||!a.every(v=>Number.isFinite(v)&&v>=0))throw new TypeError('Terrain weights require 8 nonnegative numbers');const sum=a.reduce((n,v)=>n+v,0);if(sum===0)a[0]=1;else for(let q=0;q<8;q++)a[q]/=sum;WB.set(a,k*8);TB.set(o.tint?o.tint(i,j,a):[1,1,1],k*3);}
  const hb=(i,j)=>HB[clamp(j,0,H-1)*W+clamp(i,0,W-1)],cr=(p0,p1,p2,p3,t)=>p1+.5*t*(p2-p0+t*(2*p0-5*p1+4*p2-p3+t*(3*(p1-p2)+p3-p0)));
  const F=new Float32Array(FW*FH);
  for(let fj=0;fj<FH;fj++)for(let fi=0;fi<FW;fi++){const x=fi*st,z=fj*st,i=Math.floor(x),j=Math.floor(z),tx=x-i,tz=z-j;let h;
    if(sub===1||(tx===0&&tz===0))h=hb(i,j);else{const r=[];for(let m=-1;m<=2;m++)r.push(cr(hb(i-1,j+m),hb(i,j+m),hb(i+1,j+m),hb(i+2,j+m),tx));h=cr(r[0],r[1],r[2],r[3],tz);
      const lo=Math.min(hb(i,j),hb(i+1,j),hb(i,j+1),hb(i+1,j+1)),hi=Math.max(hb(i,j),hb(i+1,j),hb(i,j+1),hb(i+1,j+1));h=clamp(h,lo-1.5,hi+1.5);}
    F[fj*FW+fi]=h+(o.detail?o.detail(x,z):0);if(!Number.isFinite(F[fj*FW+fi]))throw new TypeError('Non-finite terrain detail');}
  const fh=(fi,fj)=>F[clamp(fj,0,FH-1)*FW+clamp(fi,0,FW-1)];
  const lerpArr=(A,n,x,z,out)=>{const i=Math.min(W-2,Math.floor(x)),j=Math.min(H-2,Math.floor(z)),tx=x-i,tz=z-j,k00=(j*W+i)*n,k10=k00+n,k01=k00+W*n,k11=k01+n;
    for(let c=0;c<n;c++)out[c]=(A[k00+c]*(1-tx)+A[k10+c]*tx)*(1-tz)+(A[k01+c]*(1-tx)+A[k11+c]*tx)*tz;return out;};
  const C=Math.max(1,Math.min(Math.floor(o.chunk||48),254)),meshes=[],wv=new Float32Array(8),tv=new Float32Array(3);
  for(let j0=0;j0<FH-1;j0+=C)for(let i0=0;i0<FW-1;i0+=C){const i1=Math.min(FW-1,i0+C),j1=Math.min(FH-1,j0+C),nx=i1-i0+1,nz=j1-j0+1,cnt=nx*nz;
    const pos=new Float32Array(cnt*3),nor=new Float32Array(cnt*3),col=new Float32Array(cnt*3),sA=new Float32Array(cnt*4),sB=new Float32Array(cnt*4);let v=0;
    for(let fj=j0;fj<=j1;fj++)for(let fi=i0;fi<=i1;fi++){const x=fi*st,z=fj*st,h=fh(fi,fj),qx=-(fh(fi+1,fj)-fh(fi-1,fj))/(2*st),qz=-(fh(fi,fj+1)-fh(fi,fj-1))/(2*st),l=Math.hypot(qx,1,qz);
      lerpArr(WB,8,x,z,wv);lerpArr(TB,3,x,z,tv);pos[v*3]=x+.5;pos[v*3+1]=h;pos[v*3+2]=z+.5;nor[v*3]=qx/l;nor[v*3+1]=1/l;nor[v*3+2]=qz/l;col.set(tv,v*3);sA.set(wv.subarray(0,4),v*4);sB.set(wv.subarray(4,8),v*4);v++;}
    const idx=new (cnt>65535?Uint32Array:Uint16Array)((nx-1)*(nz-1)*6);let k=0;
    for(let j=0;j<nz-1;j++)for(let i=0;i<nx-1;i++){const a=j*nx+i,b=a+1,c=a+nx,d=c+1,flip=(i+i0+j+j0)%2;if(flip)idx.set([a,c,d,a,d,b],k);else idx.set([a,c,b,b,c,d],k);k+=6;}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('normal',new THREE.BufferAttribute(nor,3));g.setAttribute('color',new THREE.BufferAttribute(col,3));
    g.setAttribute('splatA',new THREE.BufferAttribute(sA,4));g.setAttribute('splatB',new THREE.BufferAttribute(sB,4));g.setIndex(new THREE.BufferAttribute(idx,1));g.computeBoundingSphere();
    const m=new THREE.Mesh(g,mat);m.receiveShadow=o.receiveShadow!==false;meshes.push(m);}
  meshes.heightAt=(x,z)=>{x=(x-.5)*sub;z=(z-.5)*sub;const i=clamp(Math.floor(x),0,FW-2),j=clamp(Math.floor(z),0,FH-2),tx=clamp(x-i,0,1),tz=clamp(z-j,0,1);
    const a=fh(i,j),b=fh(i+1,j),c=fh(i,j+1),d=fh(i+1,j+1);
    if((i+j)%2) return tz>=tx ? a*(1-tz)+c*(tz-tx)+d*tx : a*(1-tx)+d*tz+b*(tx-tz);
    return tx+tz<=1 ? a*(1-tx-tz)+b*tx+c*tz : b*(1-tz)+c*(1-tx)+d*(tx+tz-1);};
  meshes.sub=sub;
  meshes.normalAt=(x,z,out=new THREE.Vector3())=>{const e=.05;return out.set(meshes.heightAt(x-e,z)-meshes.heightAt(x+e,z),2*e,meshes.heightAt(x,z-e)-meshes.heightAt(x,z+e)).normalize();};
  meshes.dispose=()=>{for(const m of meshes){m.removeFromParent?m.removeFromParent():m.parent&&m.parent.remove(m);m.geometry.dispose();}};
  return meshes;};
/* Ridged fractal noise for mountains (0..1). Use with KE.noise-based detail callbacks. */
KE.ridged=(x,z,oct=4)=>{let a=.5,f=1,s=0,n=0;for(let i=0;i<oct;i++){const v=1-Math.abs(KE.noise(x*f+i*37.1,z*f+i*11.3,256)*2-1);s+=v*v*a;n+=a;a*=.5;f*=2.03;}return s/n;};

/* ---------- sky, sun, moon, day cycle ---------- */
KE.glowTexture=(THREE,inner,outer)=>canvasTex(THREE,128,(g,s)=>{const gr=g.createRadialGradient(s/2,s/2,0,s/2,s/2,s/2);gr.addColorStop(0,inner);gr.addColorStop(.25,outer);gr.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=gr;g.fillRect(0,0,s,s);});
KE.sky=(THREE,scene,o={})=>{const R=o.radius||600,g=new THREE.SphereGeometry(R,32,16),col=new Float32Array(g.attributes.position.count*3);
  for(let i=0;i<g.attributes.position.count;i++){const t=clamp(g.attributes.position.getY(i)/R,0,1),hz=Math.pow(1-t,6);col.set([.52-.3*t+.35*hz,.74-.28*t+.2*hz,.98-.08*t],i*3);}
  g.setAttribute('color',new THREE.BufferAttribute(col,3));const dome=new THREE.Mesh(g,new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.BackSide,fog:false,depthWrite:false,toneMapped:false}));
  if(o.center)dome.position.copy(o.center);scene.add(dome);
  const spr=(a,b,s)=>{const m=new THREE.Sprite(new THREE.SpriteMaterial({map:KE.glowTexture(THREE,a,b),blending:THREE.AdditiveBlending,depthWrite:false,fog:false,transparent:true,toneMapped:false}));m.scale.set(s,s,1);scene.add(m);return m;};
  return {dome,sun:spr('rgba(255,255,235,1)','rgba(255,205,120,.35)',120),moon:spr('rgba(235,240,255,1)','rgba(160,180,255,.25)',60),halo:spr('rgba(255,220,160,.35)','rgba(255,180,90,.08)',420)};};
/* ctx: {sky, sun(DirectionalLight), hemi, scene, fogColor(Color)}. day: 0..1 where 0..0.67 is daytime. */
KE.dayCycle=(THREE,ctx)=>{const dir=new THREE.Vector3(),tmp=new THREE.Vector3();
  return {dir,update(day,target,wet=0){const d=(day%1+1)%1,isDay=d<.67,a=isDay?d/.67*Math.PI:(d-.67)/.33*Math.PI,el=Math.sin(a),az=Math.cos(a);
    dir.set(az*.8,Math.max(.1,el),-.45+az*.2).normalize();const gold=isDay?clamp(1-el*2.2,0,1):0,S=ctx.sun,Hm=ctx.hemi;
    S.color.setRGB(isDay?1:.55,isDay?1-.4*gold:.62,isDay?.92-.58*gold:.95);S.intensity=isDay?(.35+1.0*Math.min(1,el*2.5))*(1-wet*.7):.25*(1-wet*.5);
    Hm.color.setRGB(isDay?.7+.3*(1-gold):.3,isDay?.84-.1*gold:.38,isDay?1-.2*gold:.7);Hm.groundColor.setRGB(.32,.3,.22);Hm.intensity=isDay?.55-.12*gold:.28;
    S.position.set(target.x+dir.x*120,target.y+dir.y*120,target.z+dir.z*120);S.target.position.copy(target);S.target.updateMatrixWorld();
    const k=isDay?0:1,sk=ctx.sky;tmp.copy(dir).multiplyScalar(480);sk.sun.position.set(target.x+tmp.x,target.y+tmp.y,target.z+tmp.z);sk.sun.visible=isDay;
    sk.halo.position.copy(sk.sun.position);sk.halo.visible=isDay;sk.halo.material.opacity=.4+.6*gold;sk.sun.material.color.setRGB(1,1-.3*gold,1-.55*gold);
    sk.moon.position.set(target.x-tmp.x*.9,target.y+Math.abs(tmp.y)*.9+60,target.z-tmp.z*.9);sk.moon.visible=!isDay;
    sk.dome.material.color.setRGB(isDay?1+.1*gold-wet*.4:.14,isDay?1-.28*gold-wet*.35:.16,isDay?1-.55*gold-wet*.2:.3);sk.dome.position.x=target.x;sk.dome.position.z=target.z;
    if(ctx.fogColor)ctx.fogColor.setRGB(isDay?.68+.25*gold-wet*.3:.07,isDay?.8-.1*gold-wet*.3:.08,isDay?.92-.45*gold-wet*.25:.18);
    return {isDay,el,gold,night:k};}};};

/* ---------- water ---------- */
KE.water=(THREE,scene,o={})=>{const size=o.size||1000,nrm=canvasTex(THREE,256,(g,s)=>{const d=g.createImageData(s,s),hf=(x,y)=>KE.tileNoise(x,y,s,16);
    for(let y=0;y<s;y++)for(let x=0;x<s;x++){const dx=hf(x+1,y)-hf(x-1,y),dy=hf(x,y+1)-hf(x,y-1);d.data.set([128-dx*600,128-dy*600,255,255],(y*s+x)*4);}g.putImageData(d,0,0);},size/6);
  const mat=new THREE.MeshPhongMaterial({color:o.color!==undefined?o.color:0x1a5f9e,transparent:true,opacity:o.opacity!==undefined?o.opacity:.86,shininess:80,specular:0x6f8fb0,normalMap:nrm,normalScale:new THREE.Vector2(.4,.4)});
  const m=new THREE.Mesh(new THREE.PlaneGeometry(size,size),mat);m.rotation.x=-Math.PI/2;if(o.center)m.position.copy(o.center);m.position.y=o.level||0;scene.add(m);
  return {mesh:m,update(t){nrm.offset.set(t*.01,t*.013);m.position.y=(o.level||0)+Math.sin(t*1.1)*.04;}};};

/* ---------- wind for instanced foliage ---------- */
KE.windUniforms={uTime:{value:0},uWind:{value:1}};
KE.wind=(THREE,mat,o={})=>{if(mat.userData.windy)return mat;const cache=mat.customProgramCacheKey.bind(mat);const baseKey=cache();mat.userData.windy=true;mat.customProgramCacheKey=()=>baseKey+':wind:'+String(o.amp); const amp=(o.amp!==undefined?o.amp:.1).toFixed(3),prev=mat.onBeforeCompile;
  mat.onBeforeCompile=(sh,r)=>{if(prev)prev(sh,r);sh.uniforms.uTime=KE.windUniforms.uTime;sh.uniforms.uWind=KE.windUniforms.uWind;
    sh.vertexShader='uniform float uTime;uniform float uWind;\n'+sh.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
#ifdef USE_INSTANCING
vec4 kwp=instanceMatrix*vec4(0.0,0.0,0.0,1.0);
#else
vec4 kwp=vec4(0.0);
#endif
float kw=sin(uTime*1.6+kwp.x*0.33+kwp.z*0.27)*0.6+sin(uTime*2.7+kwp.x*0.9)*0.25;float kh=max(position.y+0.5,0.0);
transformed.x+=kw*kh*${amp}*uWind;transformed.z+=kw*kh*${amp}*0.6*uWind;`);};mat.needsUpdate=true;return mat;};

/* ---------- grass blades ---------- */
/* opts: {count, radius, heightAt(x,z), density(x,z)->0..1, color(x,z)->[r,g,b]} */
KE.grass=(THREE,scene,o)=>{const count=o.count|0;if(!count)return null;const radius=o.radius||20;
  const g=new THREE.BufferGeometry(),w=.06,h=.55;g.setAttribute('position',new THREE.BufferAttribute(new Float32Array([-w,0,0, w,0,0, -w*.6,h*.5,0, w*.6,h*.5,0, 0,h,0]),3));
  g.setAttribute('color',new THREE.BufferAttribute(new Float32Array([.35,.45,.25, .35,.45,.25, .75,.85,.55, .75,.85,.55, 1.1,1.15,.8]),3));g.setIndex([0,1,2,2,1,3,2,3,4]);g.computeVertexNormals();
  const mat=new THREE.MeshLambertMaterial({vertexColors:true,side:THREE.DoubleSide});KE.wind(THREE,mat,{amp:.45});
  const im=new THREE.InstancedMesh(g,mat,count);im.frustumCulled=false;im.receiveShadow=true;scene.add(im);
  const off=[];for(let i=0;i<count;i++)off.push([(Math.random()*2-1)*radius,(Math.random()*2-1)*radius,Math.random()*Math.PI,.6+Math.random()*.8,Math.random()]);
  const dm=new THREE.Object3D(),col=new THREE.Color();let cx=1e9,cz=1e9;
  const layout=(x0,z0)=>{let n=0;for(let i=0;i<count;i++){const [ox,oz,rot,sc,r]=off[i],x=Math.round(x0/2)*2+ox,z=Math.round(z0/2)*2+oz;
      if(Math.hypot(ox,oz)>radius||o.density(x,z)<r){continue;}dm.position.set(x,o.heightAt(x,z),z);dm.rotation.set(0,rot,0);dm.scale.set(1,sc,1);dm.updateMatrix();im.setMatrixAt(n,dm.matrix);
      const c=o.color?o.color(x,z):[1,1,1];col.setRGB(c[0]*(.85+r*.3),c[1]*(.85+r*.3),c[2]);im.setColorAt(n,col);n++;}
    im.count=n;im.instanceMatrix.needsUpdate=true;if(im.instanceColor)im.instanceColor.needsUpdate=true;};
  return {mesh:im,update(x,z){if(Math.abs(x-cx)>2||Math.abs(z-cz)>2){cx=x;cz=z;layout(x,z);}},setVisible(v){im.visible=v;}};};

/* ---------- glowing light points ---------- */
KE.glow=(THREE,scene,pts,o={})=>{const p=new Float32Array(pts.length*3);pts.forEach((v,i)=>p.set(v,i*3));const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(p,3));
  const m=new THREE.Points(g,new THREE.PointsMaterial({map:KE.glowTexture(THREE,o.inner||'rgba(255,230,160,1)',o.outer||'rgba(255,150,60,.45)'),size:o.size||3.2,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,opacity:0,toneMapped:false}));scene.add(m);return m;};

/* ---------- post-processing: bloom, vignette, grade, grain ---------- */
KE.Post=function(THREE,renderer,o={}){const has=n=>!!(renderer.extensions&&renderer.extensions.has(n)),hdr=!!(o.hdr&&((renderer.capabilities.isWebGL2&&has('EXT_color_buffer_float'))||(!renderer.capabilities.isWebGL2&&has('EXT_color_buffer_half_float')&&has('OES_texture_half_float_linear'))));const self=this,cam=new THREE.OrthographicCamera(-1,1,1,-1,0,1),scn=new THREE.Scene(),quad=new THREE.Mesh(new THREE.PlaneGeometry(2,2));quad.frustumCulled=false;scn.add(quad);
  const vs='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}';
  const sm=(fs,u)=>new THREE.ShaderMaterial({vertexShader:vs,fragmentShader:fs,uniforms:u,depthTest:false,depthWrite:false,toneMapped:false});
  const bright=sm('uniform sampler2D tD;uniform float th;varying vec2 vUv;void main(){vec3 c=texture2D(tD,vUv).rgb;float l=max(c.r,max(c.g,c.b));gl_FragColor=vec4(c*smoothstep(th,th+0.25,l),1.0);}',{tD:{value:null},th:{value:o.threshold!==undefined?o.threshold:.84}});
  const blur=sm('uniform sampler2D tD;uniform vec2 dir;varying vec2 vUv;void main(){vec3 s=texture2D(tD,vUv).rgb*0.227;s+=texture2D(tD,vUv+dir*1.384).rgb*0.316;s+=texture2D(tD,vUv-dir*1.384).rgb*0.316;s+=texture2D(tD,vUv+dir*3.23).rgb*0.07;s+=texture2D(tD,vUv-dir*3.23).rgb*0.07;gl_FragColor=vec4(s,1.0);}',{tD:{value:null},dir:{value:new THREE.Vector2()}});
  const comp=sm(`uniform sampler2D tD;uniform sampler2D tB;uniform float bs;uniform float vig;uniform float sat;uniform float con;uniform float time;uniform float grain;uniform float keEncode;uniform float keHDR;uniform float keExposure;uniform float keAA;uniform sampler2D keDepth;uniform vec2 keInvSize;uniform float keNear;uniform float keFar;uniform float keAO;uniform vec3 tint;varying vec2 vUv;
float keLinearDepth(vec2 uv){float d=texture2D(keDepth,clamp(uv,vec2(0.),vec2(1.))).r;return keNear*keFar/(keFar+(keNear-keFar)*d);}
float keOcclusion(vec2 direction,float center,vec2 slope){vec2 off=direction*4.;float expected=center+dot(slope,off);float neighbor=keLinearDepth(vUv+off*keInvSize);float delta=expected-neighbor;return smoothstep(.02,.22,delta)*(1.-smoothstep(.35,1.3,abs(delta)));}
vec3 keSceneColor(){vec3 center=texture2D(tD,vUv).rgb;if(keAA<.5)return center;vec3 nw=texture2D(tD,vUv+vec2(-1.,-1.)*keInvSize).rgb,ne=texture2D(tD,vUv+vec2(1.,-1.)*keInvSize).rgb,sw=texture2D(tD,vUv+vec2(-1.,1.)*keInvSize).rgb,se=texture2D(tD,vUv+vec2(1.,1.)*keInvSize).rgb;vec3 luma=vec3(.299,.587,.114);float lNW=dot(nw,luma),lNE=dot(ne,luma),lSW=dot(sw,luma),lSE=dot(se,luma),lM=dot(center,luma);float lo=min(lM,min(min(lNW,lNE),min(lSW,lSE))),hi=max(lM,max(max(lNW,lNE),max(lSW,lSE)));if(hi-lo<max(.025,hi*.125))return center;vec2 dir=vec2(-((lNW+lNE)-(lSW+lSE)),(lNW+lSW)-(lNE+lSE));float reduce=max((lNW+lNE+lSW+lSE)*.03125,.0078125);dir=clamp(dir/(min(abs(dir.x),abs(dir.y))+reduce),vec2(-8.),vec2(8.))*keInvSize;vec3 a=.5*(texture2D(tD,vUv+dir*(-1./6.)).rgb+texture2D(tD,vUv+dir*(1./6.)).rgb);vec3 b=a*.5+.25*(texture2D(tD,vUv-dir*.5).rgb+texture2D(tD,vUv+dir*.5).rgb);float lb=dot(b,luma);return lb<lo||lb>hi?a:b;}
vec3 keFilmic(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
void main(){vec3 c=keSceneColor()+texture2D(tB,vUv).rgb*bs;
if(keAO>0.){float kd=keLinearDepth(vUv);vec2 slope=vec2(keLinearDepth(vUv+vec2(keInvSize.x,0.))-keLinearDepth(vUv-vec2(keInvSize.x,0.)),keLinearDepth(vUv+vec2(0.,keInvSize.y))-keLinearDepth(vUv-vec2(0.,keInvSize.y)))*.5;float occ=keOcclusion(vec2(1.,0.),kd,slope)+keOcclusion(vec2(-1.,0.),kd,slope)+keOcclusion(vec2(0.,1.),kd,slope)+keOcclusion(vec2(0.,-1.),kd,slope)+keOcclusion(vec2(.7,.7),kd,slope)+keOcclusion(vec2(-.7,.7),kd,slope)+keOcclusion(vec2(.7,-.7),kd,slope)+keOcclusion(vec2(-.7,-.7),kd,slope);c*=1.-clamp(occ*.085*keAO,0.,.42);}
float l=dot(c,vec3(0.299,0.587,0.114));c=mix(vec3(l),c,sat);c=(c-0.5)*con+0.5;c*=tint;vec2 d=vUv-0.5;c*=1.0-dot(d,d)*vig;
float n=fract(sin(dot(vUv*vec2(12.9898,78.233)+time,vec2(1.0,1.0)))*43758.5453);c+=(n-0.5)*grain;if(keHDR>.5)c=keFilmic(max(c,vec3(0.))*keExposure);if(keEncode>0.5)c=mix(c*12.92,1.055*pow(max(c,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),c));gl_FragColor=vec4(clamp(c,0.0,1.0),1.0);}`,
    {tD:{value:null},tB:{value:null},keHDR:{value:hdr?1:0},keExposure:{value:renderer.toneMappingExposure||1},keAA:{value:o.aa&&o.ao?1:0},keDepth:{value:null},keInvSize:{value:new THREE.Vector2(1,1)},keNear:{value:.1},keFar:{value:1500},keAO:{value:0},keEncode:{value:renderer.outputEncoding===THREE.sRGBEncoding?1:0},bs:{value:o.bloom!==undefined?o.bloom:.6},vig:{value:o.vignette!==undefined?o.vignette:.9},sat:{value:o.saturation!==undefined?o.saturation:1.12},con:{value:o.contrast!==undefined?o.contrast:1.06},time:{value:0},grain:{value:o.grain!==undefined?o.grain:.025},tint:{value:new THREE.Vector3(1,1,1)}});
  const mk=(w,h,ms)=>{const p={minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,format:THREE.RGBAFormat,type:hdr?THREE.HalfFloatType:THREE.UnsignedByteType};return ms&&renderer.capabilities.isWebGL2&&THREE.WebGLMultisampleRenderTarget?new THREE.WebGLMultisampleRenderTarget(w,h,p):new THREE.WebGLRenderTarget(w,h,p);};
  let main,a,b;this.enabled=true;this.hdr=hdr;this.uniforms=comp.uniforms;
  this.setSize=(w,h)=>{const pr=renderer.getPixelRatio(),W=Math.max(1,Math.floor(w*pr)),H=Math.max(1,Math.floor(h*pr));[main,a,b].forEach(t=>t&&t.dispose());
    main=mk(W,H,o.aa&&!o.ao);if(o.ao&&(renderer.capabilities.isWebGL2||(renderer.extensions&&renderer.extensions.has('WEBGL_depth_texture')))){main.depthTexture=new THREE.DepthTexture(W,H,THREE.UnsignedShortType);comp.uniforms.keAO.value=o.ao===true?1:Number(o.ao);comp.uniforms.keDepth.value=main.depthTexture;comp.uniforms.keInvSize.value.set(1/W,1/H);}a=mk(W>>2||1,H>>2||1);b=mk(W>>2||1,H>>2||1);self.size=[W,H];};
  this.render=(scene,camera)=>{if(!this.enabled){renderer.render(scene,camera);return;}const previous=renderer.getRenderTarget();if(!main){const s=renderer.getSize(new THREE.Vector2());self.setSize(s.x,s.y);}
    comp.uniforms.keNear.value=camera.near;comp.uniforms.keFar.value=camera.far;comp.uniforms.keInvSize.value.set(1/main.width,1/main.height);comp.uniforms.keExposure.value=renderer.toneMappingExposure||1;const mapping=renderer.toneMapping;try{if(hdr)renderer.toneMapping=THREE.NoToneMapping;renderer.setRenderTarget(main);renderer.render(scene,camera);renderer.toneMapping=mapping;
    quad.material=bright;bright.uniforms.tD.value=main.texture;renderer.setRenderTarget(a);renderer.render(scn,cam);
    quad.material=blur;for(let i=0;i<2;i++){blur.uniforms.tD.value=a.texture;blur.uniforms.dir.value.set((i+1)/a.width,0);renderer.setRenderTarget(b);renderer.render(scn,cam);
      blur.uniforms.tD.value=b.texture;blur.uniforms.dir.value.set(0,(i+1)/a.height);renderer.setRenderTarget(a);renderer.render(scn,cam);}
    quad.material=comp;comp.uniforms.tD.value=main.texture;comp.uniforms.tB.value=a.texture;comp.uniforms.time.value=(performance.now()/1000)%100;renderer.setRenderTarget(previous);renderer.render(scn,cam);}finally{renderer.toneMapping=mapping;renderer.setRenderTarget(previous);}};
  this.dispose=()=>{[main,a,b].forEach(t=>t&&t.dispose());main=a=b=null;[bright,blur,comp].forEach(m=>m.dispose());quad.geometry.dispose();this.enabled=false;};};

/* ---------- tiny physics ---------- */
KE.Physics={gravity:-26,
  body(o){return Object.assign({x:0,y:0,z:0,vx:0,vy:0,vz:0,r:.3,bounce:.5,friction:3,ground:0},o);},
  /* solid(x,z)->bool blocks movement; groundAt(x,z)->height */
  step(bodies,dt,solid,groundAt){for(const b of bodies){b.vy+=this.gravity*dt;b.y+=b.vy*dt;const gy=groundAt?groundAt(b.x,b.z):0;
      if(b.y<gy+b.r){b.y=gy+b.r;b.vy=b.vy<-1.5?-b.vy*b.bounce:0;}const onG=b.y<=gy+b.r+.01,f=Math.exp(-(onG?b.friction:.3)*dt);b.vx*=f;b.vz*=f;
      const nx=b.x+b.vx*dt;if(!solid||!solid(nx+Math.sign(b.vx)*b.r,b.z))b.x=nx;else b.vx=-b.vx*b.bounce;
      const nz=b.z+b.vz*dt;if(!solid||!solid(b.x,nz+Math.sign(b.vz)*b.r))b.z=nz;else b.vz=-b.vz*b.bounce;}
    for(let i=0;i<bodies.length;i++)for(let j=i+1;j<bodies.length;j++){const A=bodies[i],B=bodies[j],dx=B.x-A.x,dz=B.z-A.z,d=Math.hypot(dx,dz),m=A.r+B.r;
      if(d>0&&d<m){const ux=dx/d,uz=dz/d,rv=(A.vx-B.vx)*ux+(A.vz-B.vz)*uz;if(rv>0){A.vx-=rv*ux;A.vz-=rv*uz;B.vx+=rv*ux;B.vz+=rv*uz;}const p=(m-d)/2;A.x-=ux*p;A.z-=uz*p;B.x+=ux*p;B.z+=uz*p;}}}};

/* ---------- FPS meter with auto downgrade ---------- */
KE.FPS={fps:60,_f:0,_t:0,_low:0,tick(now,onDowngrade){this._f++;if(!this._t)this._t=now;const e=now-this._t;if(e>=1000){this.fps=Math.round(this._f*1000/e);this._f=0;this._t=now;
    if(KE.settings.auto&&this.fps<24){if(++this._low>=5){this._low=0;const order=['ultra','high','medium','low'],i=order.indexOf(KE.settings.preset);
      if(i>=0&&i<3){const s=KE.applyPreset(order[i+1]);s.auto=true;KE.saveSettings(s);onDowngrade&&onDowngrade(s);}}}else this._low=0;}return this.fps;}};

/* ---------- settings panel UI ---------- */
KE.settingsPanel=(onChange)=>{const el=document.createElement('div');el.className='ke-panel';
  const S=()=>KE.settings,row=(label,key,opts)=>`<div class="ke-row"><span>${label}</span><div class="ke-seg">${opts.map(([v,t])=>`<button data-k="${key}" data-v="${v}" class="${String(S()[key])===String(v)?'on':''}">${t}</button>`).join('')}</div></div>`;
  const draw=()=>{el.innerHTML=`<div class="ke-row"><span>Quality preset</span><div class="ke-seg">${['low','medium','high','ultra'].map(p=>`<button data-p="${p}" class="${S().preset===p&&!S().custom?'on':''}">${p[0].toUpperCase()+p.slice(1)}</button>`).join('')}<button data-p="auto" class="${S().auto?'on':''}">Auto</button></div></div>
    ${row('Render resolution','scale',[[.75,'75%'],[1,'100%'],[1.25,'125%'],[1.6,'160%']])}
    ${row('Texture detail','tex',[[128,'Low'],[256,'High'],[512,'Ultra']])}
    ${row('Shadows','shadows',[[false,'Off'],[true,'On']])}
    ${row('Shadow quality','shadowRes',[[1024,'Soft'],[1536,'Sharp'],[2048,'Ultra']])}
    ${row('Mountain and ground detail','terrain',[[1,'Normal'],[2,'Detailed']])}
    ${row('Grass','grass',[[0,'Off'],[3000,'Low'],[7000,'High'],[14000,'Ultra']])}
    ${row('Glow (bloom)','bloom',[[false,'Off'],[true,'On']])}
    ${row('Anti-aliasing','aa',[[false,'Off'],[true,'On']])}
    ${row('View distance','view',[[70,'Near'],[95,'Mid'],[120,'Far'],[160,'Max']])}
    ${row('Sky and weather effects','fx',[[false,'Off'],[true,'On']])}
    ${row('Camera','cam',[['follow','3D behind'],['classic','Top view']])}
    ${row('Show FPS','showFps',[[false,'Off'],[true,'On']])}
    <p class="ke-note">${KE.name} ${KE.version}. Texture detail, ground detail and anti-aliasing apply the next time 3D starts.</p>`;
    el.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>{if(b.dataset.p==='auto'){const s=KE.applyPreset(KE.detectPreset());s.auto=true;KE.saveSettings(s);}else KE.applyPreset(b.dataset.p);draw();onChange&&onChange(KE.settings);});
    el.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>{const k=b.dataset.k,raw=b.dataset.v,v=raw==='true'?true:raw==='false'?false:isNaN(+raw)?raw:+raw;KE.settings[k]=v;KE.settings.auto=false;KE.settings.custom=true;KE.saveSettings(KE.settings);draw();onChange&&onChange(KE.settings,k);});};
  draw();return el;};
KE.css=`.ke-panel{display:grid;gap:10px}.ke-row{display:grid;gap:6px}.ke-row>span{font-weight:800;font-size:14px}.ke-seg{display:flex;flex-wrap:wrap;gap:6px}
.ke-seg button{flex:1;min-width:56px;border:2.5px solid #2a1a2e;background:#fffaf1;color:#2a1a2e;border-radius:12px;padding:7px 8px;font-weight:800;font-size:13px;cursor:pointer;box-shadow:0 3px 0 #2a1a2e}
.ke-seg button.on{background:#ffc21a}.ke-note{margin:4px 0 0;font-size:12.5px;font-weight:800;opacity:.7}`;
if(typeof document!=='undefined'){const st=document.createElement('style');st.textContent=KE.css;(document.head||document.documentElement).appendChild(st);}
/* ---------- v2 reusable systems ---------- */
KE.clamp=clamp;
KE.damp=(a,b,lambda,dt)=>a+(b-a)*(1-Math.exp(-lambda*Math.max(0,dt)));
KE.random=(seed=1)=>{let s=Number(seed)>>>0;return ()=>{s+=0x6D2B79F5;let t=s;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};};
KE.Events=class {
  constructor(){this.listeners=new Map();}
  on(name,fn){if(typeof fn!=='function')throw new TypeError('Event listener must be a function');if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);return ()=>this.off(name,fn);}
  once(name,fn){const off=this.on(name,(...args)=>{off();fn(...args);});return off;}
  off(name,fn){const s=this.listeners.get(name);if(s){s.delete(fn);if(!s.size)this.listeners.delete(name);}}
  emit(name,...args){const s=this.listeners.get(name);if(s)for(const fn of [...s])fn(...args);}
  clear(){this.listeners.clear();}
};
KE.events=new KE.Events();
/* Keep settings object identity stable for existing games that retain KE.settings. */
KE.sanitizeSettings=(raw={})=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))raw={};
  const name=Object.prototype.hasOwnProperty.call(KE.PRESETS,raw.preset)?raw.preset:KE.detectPreset();
  const s={...KE.PRESETS[name],auto:true,showFps:false,custom:false};
  for(const key of ['auto','showFps','shadows','bloom','aa','fx','custom'])if(typeof raw[key]==='boolean')s[key]=raw[key];
  for(const [key,min,max] of [['scale',.5,2],['grass',0,40000],['view',30,300],['aniso',1,16]])if(Number.isFinite(raw[key]))s[key]=clamp(raw[key],min,max);
  s.grass=Math.round(s.grass);
  for(const [key,allowed] of [['tex',[128,256,512,1024]],['shadowRes',[512,1024,1536,2048,3072,4096]],['terrain',[1,2,3]],['cam',['follow','classic']]])if(allowed.includes(raw[key]))s[key]=raw[key];
  return s;
};
{const valid=KE.sanitizeSettings(KE.settings);for(const key of Object.keys(KE.settings))if(!Object.prototype.hasOwnProperty.call(valid,key))delete KE.settings[key];Object.assign(KE.settings,valid);}
const rawLoad=KE.loadSettings;
KE.loadSettings=()=>KE.sanitizeSettings(rawLoad());
KE.setSettings=patch=>{Object.assign(KE.settings,KE.sanitizeSettings({...KE.settings,...patch}));KE.saveSettings(KE.settings);KE.events.emit('settings',KE.settings);return KE.settings;};
const rawPreset=KE.applyPreset;
KE.applyPreset=(name,opts)=>{const s=rawPreset(name,opts);KE.events.emit('settings',s);return s;};

/* One owner per render loop. Time is measured in seconds. Hidden tabs do not catch up. */
KE.Loop=class {
  constructor({update=()=>{},render=()=>{},step=1/60,maxSteps=6,maxDelta=.1,onError=null}={}){
    if(!Number.isFinite(step)||step<=0||!Number.isInteger(maxSteps)||maxSteps<1||!Number.isFinite(maxDelta)||maxDelta<=0)throw new RangeError('Invalid loop timing');
    Object.assign(this,{update,render,step,maxSteps,maxDelta,onError});this.time=0;this.accumulator=0;this.running=false;this.paused=false;this.last=null;this.droppedTime=0;this.id=0;this.disposed=false;
    this.frame=now=>{if(!this.running)return;const dt=this.last===null?0:(now-this.last)/1000;this.last=now;try{if(!this.paused&&!document.hidden)this.advance(dt);}catch(e){this.stop();if(this.onError)this.onError(e);else setTimeout(()=>{throw e;},0);return;}this.id=requestAnimationFrame(this.frame);};
    this.visibility=()=>{this.last=null;this.accumulator=0;};document.addEventListener('visibilitychange',this.visibility);
  }
  advance(delta){const dt=clamp(Number.isFinite(delta)?delta:0,0,this.maxDelta);this.accumulator+=dt;let steps=0;while(this.accumulator+1e-10>=this.step&&steps<this.maxSteps){this.update(this.step,this.time);this.time+=this.step;this.accumulator-=this.step;steps++;}if(this.accumulator>=this.step){const keep=this.accumulator%this.step;this.droppedTime+=this.accumulator-keep;this.accumulator=keep;}this.render(Math.max(0,this.accumulator/this.step),dt,this.time);return steps;}
  start(){if(this.disposed)throw new Error('Loop has been disposed');if(!this.running){this.running=true;this.last=null;this.id=requestAnimationFrame(this.frame);}return this;}
  stop(){this.running=false;cancelAnimationFrame(this.id);this.last=null;return this;}
  pause(value=true){this.paused=value;this.last=null;this.accumulator=0;return this;}
  dispose(){this.stop();document.removeEventListener('visibilitychange',this.visibility);this.disposed=true;}
};

/* Spatial hash for local queries; bodies live in one center cell. */
KE.SpatialHash=class {
  constructor(cellSize=2){if(!Number.isFinite(cellSize)||cellSize<=0)throw new RangeError('Positive cell size required');this.cellSize=cellSize;this.cells=new Map();}
  clear(){this.cells.clear();}
  insert(item){const key=Math.floor(item.x/this.cellSize)+','+Math.floor(item.z/this.cellSize);let bucket=this.cells.get(key);if(!bucket)this.cells.set(key,bucket=[]);bucket.push(item);}
  query(x,z,r,out=[]){out.length=0;const s=this.cellSize;for(let iz=Math.floor((z-r)/s);iz<=Math.floor((z+r)/s);iz++)for(let ix=Math.floor((x-r)/s);ix<=Math.floor((x+r)/s);ix++){const a=this.cells.get(ix+','+iz);if(a)for(const b of a)out.push(b);}return out;}
};
let bodyID=0;
KE.Physics={gravity:-26,
  body(o={}){const b=Object.assign({x:0,y:0,z:0,vx:0,vy:0,vz:0,r:.3,height:0,bounce:0,friction:3,airDrag:.3,mass:1,static:false,sensor:false,ground:0,grounded:false,layer:1,mask:0xffffffff},o);for(const k of ['x','y','z','vx','vy','vz','r','mass'])if(!Number.isFinite(b[k]))throw new TypeError('Body '+k+' must be finite');if(b.r<=0||b.mass<=0)throw new RangeError('Positive body radius and mass required');b.height=Math.max(2*b.r,b.height);b.bounce=clamp(b.bounce,0,1);b.id=++bodyID;return b;},
  step(bodies,delta,solid,groundAt){
    if(!Number.isFinite(delta)||delta<=0||!bodies.length)return;
    const dt=Math.min(delta,.1),maxSpeed=Math.max(...bodies.map(b=>Math.hypot(b.vx,b.vz))),minRadius=Math.min(...bodies.map(b=>b.r));
    const count=Math.min(64,Math.max(1,Math.ceil(dt/(1/120)),Math.ceil(maxSpeed*dt/(minRadius*.5)))),h=dt/count;
    const hash=new KE.SpatialHash(Math.max(1,2*Math.max(...bodies.map(b=>b.r)))),maxR=Math.max(...bodies.map(b=>b.r)),near=[];
    const blocked=(b,x,z)=>solid&&(solid(x,z,b)||solid(x+b.r,z,b)||solid(x-b.r,z,b)||solid(x,z+b.r,b)||solid(x,z-b.r,b));
    const floor=(b)=>{const g=groundAt?groundAt(b.x,b.z):0;b.ground=g;b.grounded=false;if(Number.isFinite(g)&&b.y<=g+b.r+.001){b.y=g+b.r;if(b.vy<0)b.vy=b.vy<-1.5?-b.vy*b.bounce:0;b.grounded=b.vy<.05;}};
    for(let sub=0;sub<count;sub++){
      for(const b of bodies){if(b.static)continue;const f=Math.exp(-(b.grounded?Math.max(0,b.friction):Math.max(0,b.airDrag))*h);b.vx*=f;b.vz*=f;b.vy+=this.gravity*h;
        const nx=b.x+b.vx*h;if(!blocked(b,nx,b.z))b.x=nx;else b.vx=-b.vx*b.bounce;
        const nz=b.z+b.vz*h;if(!blocked(b,b.x,nz))b.z=nz;else b.vz=-b.vz*b.bounce;
        b.y+=b.vy*h;floor(b);
      }
      hash.clear();for(const b of bodies)hash.insert(b);
      for(const a of bodies){hash.query(a.x,a.z,a.r+maxR,near);for(const b of near){if(a.id>=b.id||(a.static&&b.static)||!(a.mask&b.layer)||!(b.mask&a.layer))continue;
        if(a.y-a.r+a.height<=b.y-b.r||b.y-b.r+b.height<=a.y-a.r)continue;
        let dx=b.x-a.x,dz=b.z-a.z,d=Math.hypot(dx,dz),sum=a.r+b.r;if(d>=sum)continue;
        if(a.sensor||b.sensor){if(sub===0)KE.events.emit('overlap',a,b);continue;}
        if(d<1e-8){dx=1;dz=0;d=1;}else{dx/=d;dz/=d;}const depth=sum-Math.hypot(b.x-a.x,b.z-a.z),ia=a.static?0:1/a.mass,ib=b.static?0:1/b.mass,total=ia+ib;if(!total)continue;
        const ax=a.x-dx*depth*ia/total,az=a.z-dz*depth*ia/total,bx=b.x+dx*depth*ib/total,bz=b.z+dz*depth*ib/total;
        if(ia&&!blocked(a,ax,az)){a.x=ax;a.z=az;}if(ib&&!blocked(b,bx,bz)){b.x=bx;b.z=bz;}
        const rv=(b.vx-a.vx)*dx+(b.vz-a.vz)*dz;if(rv<0){const impulse=-(1+Math.min(a.bounce,b.bounce))*rv/total;a.vx-=impulse*ia*dx;a.vz-=impulse*ia*dz;b.vx+=impulse*ib*dx;b.vz+=impulse*ib*dz;}
      }}for(const b of bodies)if(!b.static)floor(b);
    }
  }
};

/* Explicit ownership prevents disposing shared textures during one object's removal. */
KE.disposeObject=(root,{textures=false,remove=true}={})=>{
  const geometries=new Set(),materials=new Set(),maps=new Set();root.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of [o.material,o.customDepthMaterial,o.customDistanceMaterial].flat().filter(Boolean))materials.add(m);});
  for(const g of geometries)g.dispose();for(const m of materials){if(textures){for(const v of Object.values(m))if(v&&v.isTexture)maps.add(v);for(const v of m.userData.keTextures||[])if(v&&v.isTexture)maps.add(v);}m.dispose();}for(const t of maps)t.dispose();if(remove&&root.parent)root.parent.remove(root);
};
KE.Resources=class {constructor(){this.items=new Set();}track(value){this.items.add(value);return value;}release(value){this.items.delete(value);return value;}dispose(){for(const v of this.items)if(typeof v==='function')v();else if(v&&v.dispose)v.dispose();this.items.clear();}};
for(const key of ['grass','water']){const create=KE[key];KE[key]=(...args)=>{const result=create(...args);if(result)result.dispose=()=>KE.disposeObject(result.mesh,{textures:true});return result;};}
/* Preserve old callable API while giving each compiled variation its own shader key. */
KE.rendererStats=renderer=>({calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:renderer.info.memory.geometries,textures:renderer.info.memory.textures,programs:renderer.info.programs?renderer.info.programs.length:0});
KE.applyRendererSettings=(THREE,renderer,camera,sun,scene)=>{
  const s=KE.settings;renderer.setPixelRatio(clamp(Math.min(window.devicePixelRatio||1,2)*s.scale*.7,.5,2));
  renderer.shadowMap.enabled=s.shadows;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  if(sun){sun.castShadow=s.shadows;if(sun.shadow.mapSize.x!==s.shadowRes){sun.shadow.mapSize.set(s.shadowRes,s.shadowRes);if(sun.shadow.map){sun.shadow.map.dispose();sun.shadow.map=null;}}}
  if(scene&&scene.fog){scene.fog.near=s.view*.4;scene.fog.far=s.view;}
  if(camera){camera.aspect=renderer.domElement.clientWidth/Math.max(1,renderer.domElement.clientHeight);camera.updateProjectionMatrix();}
};

/* Pointer identifiers keep the left stick and right look gesture independent. */
KE.Input=class {
  constructor(canvas,{parent=document.body,touch=true}={}){
    this.canvas=canvas;this.keys=new Set();this.pressed=new Set();this.pointers=new Map();this.stick={x:0,y:0};this.look={x:0,y:0,zoom:0};this.cleanups=[];this.enabled=true;this.stickID=null;this.jumpQueued=false;
    const on=(target,event,fn,options)=>{target.addEventListener(event,fn,options);this.cleanups.push(()=>target.removeEventListener(event,fn,options));};
    const editing=e=>e.target&&e.target.closest&&e.target.closest('input,textarea,select,[contenteditable=true]');
    on(window,'keydown',e=>{if(!this.enabled||editing(e))return;if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();if(!this.keys.has(e.code))this.pressed.add(e.code);this.keys.add(e.code);});
    on(window,'keyup',e=>this.keys.delete(e.code));on(window,'blur',()=>this.reset());on(document,'visibilitychange',()=>this.reset());
    on(canvas,'pointerdown',e=>{if(!this.enabled)return;canvas.setPointerCapture(e.pointerId);this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});});
    on(canvas,'pointermove',e=>{const p=this.pointers.get(e.pointerId);if(!p)return;if(this.pointers.size>1){const other=[...this.pointers.entries()].find(([id])=>id!==e.pointerId)[1];this.look.zoom+=(Math.hypot(p.x-other.x,p.y-other.y)-Math.hypot(e.clientX-other.x,e.clientY-other.y))*.025;}else{this.look.x+=(e.clientX-p.x)*.006;this.look.y+=(e.clientY-p.y)*.005;}p.x=e.clientX;p.y=e.clientY;});
    for(const ev of ['pointerup','pointercancel','lostpointercapture'])on(canvas,ev,e=>this.pointers.delete(e.pointerId));
    on(canvas,'wheel',e=>{if(!this.enabled)return;e.preventDefault();this.look.zoom+=Math.sign(e.deltaY);},{passive:false});
    if(touch){this.ui=document.createElement('div');this.ui.className='ke-controls';this.ui.innerHTML='<div class="ke-stick" role="group" aria-label="Movement joystick"><i></i></div><button class="ke-jump" aria-label="Jump">↑<small>JUMP</small></button>';parent.appendChild(this.ui);const base=this.ui.querySelector('.ke-stick'),knob=base.firstChild,jump=this.ui.querySelector('.ke-jump');this.knob=knob;
      const move=e=>{if(e.pointerId!==this.stickID)return;const r=base.getBoundingClientRect(),x=(e.clientX-r.left-r.width/2)/42,y=(e.clientY-r.top-r.height/2)/42,m=Math.max(1,Math.hypot(x,y));this.stick={x:x/m,y:y/m};knob.style.transform=`translate(${this.stick.x*35}px,${this.stick.y*35}px)`;};
      on(base,'pointerdown',e=>{if(!this.enabled||this.stickID!==null)return;e.preventDefault();this.stickID=e.pointerId;base.setPointerCapture(e.pointerId);move(e);});on(base,'pointermove',move);
      for(const ev of ['pointerup','pointercancel','lostpointercapture'])on(base,ev,e=>{if(e.pointerId===this.stickID){this.stickID=null;this.stick={x:0,y:0};knob.style.transform='';}});
      on(jump,'pointerdown',e=>{e.preventDefault();if(this.enabled)this.jumpQueued=true;});on(jump,'click',e=>{if(e.detail===0&&this.enabled)this.jumpQueued=true;});
    }
  }
  movement(){if(!this.enabled)return{x:0,z:0};let x=Number(this.keys.has('KeyD')||this.keys.has('ArrowRight'))-Number(this.keys.has('KeyA')||this.keys.has('ArrowLeft'))+this.stick.x,z=Number(this.keys.has('KeyS')||this.keys.has('ArrowDown'))-Number(this.keys.has('KeyW')||this.keys.has('ArrowUp'))+this.stick.y;const m=Math.max(1,Math.hypot(x,z));return{x:x/m,z:z/m};}
  consume(code){const value=this.pressed.has(code)||(code==='Space'&&this.jumpQueued);this.pressed.delete(code);if(code==='Space')this.jumpQueued=false;return value;}
  consumeLook(){const value={...this.look};this.look.x=this.look.y=this.look.zoom=0;return value;}
  setEnabled(value){this.enabled=value;this.reset();if(this.ui)this.ui.style.display=value?'':'none';}
  reset(){this.keys.clear();this.pressed.clear();this.pointers.clear();this.stick={x:0,y:0};this.stickID=null;this.jumpQueued=false;this.look={x:0,y:0,zoom:0};if(this.knob)this.knob.style.transform='';}
  dispose(){for(const fn of this.cleanups)fn();if(this.ui)this.ui.remove();this.reset();}
};
KE.controlsCSS='.ke-controls{position:fixed;inset:0;pointer-events:none;z-index:5}.ke-stick{position:absolute;left:max(22px,env(safe-area-inset-left));bottom:max(32px,env(safe-area-inset-bottom));width:116px;height:116px;border:1px solid #ffffff55;border-radius:50%;background:#0b172033;pointer-events:auto;touch-action:none;display:grid;place-items:center;backdrop-filter:blur(3px)}.ke-stick i{width:46px;height:46px;border-radius:50%;background:#fff8;border:1px solid #fffc;box-shadow:0 6px 24px #0003}.ke-jump{position:absolute;right:max(25px,env(safe-area-inset-right));bottom:max(50px,env(safe-area-inset-bottom));width:74px;height:74px;border-radius:50%;border:1px solid #ffffff80;background:#10232b66;color:white;pointer-events:auto;touch-action:none;font:28px system-ui}.ke-jump small{display:block;font-size:9px;letter-spacing:2px}.ke-controls button:focus-visible{outline:3px solid #f9d18a}';
{const style=document.createElement('style');style.textContent=KE.controlsCSS;document.head.appendChild(style);}

KE.FollowCamera=class {
  constructor(THREE,camera,{distance=10,yaw=0,pitch=.42,height=1.2,smooth=9,minDistance=3,maxDistance=22}={}){Object.assign(this,{THREE,camera,distance,yaw,pitch,height,smooth,minDistance,maxDistance});this.target=new THREE.Vector3();this.desired=new THREE.Vector3();this.offset=new THREE.Vector3();this.ray=new THREE.Raycaster();this.initialized=false;}
  rotate(x,y){this.yaw-=x;this.pitch=clamp(this.pitch+y,.12,1.3);}
  zoom(amount){this.distance=clamp(this.distance+amount,this.minDistance,this.maxDistance);}
  movement(x,z){const c=Math.cos(this.yaw),s=Math.sin(this.yaw);return {x:x*c+z*s,z:-x*s+z*c};}
  update(position,dt,groundAt,obstacles=[]){const {camera,THREE}=this;this.target.set(position.x,position.y+this.height,position.z);const pitch=KE.settings.cam==='classic'?1.18:this.pitch;
    this.offset.set(Math.sin(this.yaw)*Math.cos(pitch),Math.sin(pitch),Math.cos(this.yaw)*Math.cos(pitch)).multiplyScalar(this.distance);
    this.desired.copy(this.target).add(this.offset);
    if(obstacles.length){this.ray.set(this.target,this.offset.clone().normalize());this.ray.far=this.distance;const hit=this.ray.intersectObjects(obstacles,true)[0];if(hit)this.desired.copy(this.target).addScaledVector(this.offset.clone().normalize(),Math.max(.6,hit.distance-.4));}
    if(groundAt)this.desired.y=Math.max(this.desired.y,groundAt(this.desired.x,this.desired.z)+.6);
    camera.position.lerp(this.desired,this.initialized?1-Math.exp(-this.smooth*dt):1);if(groundAt)camera.position.y=Math.max(camera.position.y,groundAt(camera.position.x,camera.position.z)+.4);camera.lookAt(this.target);this.initialized=true;
  }
};

/* Versioned JSON saves. Return results so storage failure is visible to the game. */
KE.SaveStore=class {
  constructor(namespace='kitsune-game',version=1){this.prefix=namespace+':';this.version=version;}
  save(slot,data){try{localStorage.setItem(this.prefix+slot,JSON.stringify({version:this.version,savedAt:Date.now(),data}));return {ok:true};}catch(error){return{ok:false,error:String(error.message||error)};}}
  load(slot,{fallback=null,migrate=null,validate=()=>true}={}){try{const raw=localStorage.getItem(this.prefix+slot);if(raw===null)return{ok:true,data:fallback,found:false};const item=JSON.parse(raw);if(!item||typeof item!=='object'||!Number.isInteger(item.version))throw new Error('Invalid save envelope');let data=item.data;if(item.version!==this.version){if(!migrate)throw new Error('Unsupported save version');data=migrate(data,item.version,this.version);}if(!validate(data))throw new Error('Save validation failed');return{ok:true,data,found:true};}catch(error){return{ok:false,data:fallback,error:String(error.message||error)};}}
  remove(slot){try{localStorage.removeItem(this.prefix+slot);return{ok:true};}catch(error){return{ok:false,error:String(error.message||error)};}}
};

/* A* on an integer grid, binary heap open set, optional diagonal motion without corner cutting. */
KE.findPath=({width,height,start,goal,walkable=()=>true,diagonal=false,maxNodes=100000})=>{
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>4000000)throw new RangeError('Invalid navigation grid');
  const inside=([x,z])=>Number.isInteger(x)&&Number.isInteger(z)&&x>=0&&z>=0&&x<width&&z<height;
  if(!inside(start)||!inside(goal)||!walkable(...start)||!walkable(...goal))return [];
  const id=(x,z)=>z*width+x,target=id(...goal),first=id(...start),scores=new Float64Array(width*height).fill(Infinity),parent=new Int32Array(width*height).fill(-1),closed=new Uint8Array(width*height),heap=[];
  const push=n=>{heap.push(n);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].f<=n.f)break;heap[i]=heap[p];i=p;}heap[i]=n;};
  const pop=()=>{const root=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].f<heap[c].f)c++;if(heap[c].f>=last.f)break;heap[i]=heap[c];i=c;}heap[i]=last;}return root;};
  const heuristic=(x,z)=>{const dx=Math.abs(goal[0]-x),dz=Math.abs(goal[1]-z);return diagonal?Math.max(dx,dz)+(Math.SQRT2-1)*Math.min(dx,dz):dx+dz;};
  const dirs=diagonal?[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]:[[1,0],[-1,0],[0,1],[0,-1]];scores[first]=0;push({id:first,f:heuristic(...start)});let explored=0;
  while(heap.length&&explored<maxNodes){const n=pop();if(closed[n.id])continue;if(n.id===target){const path=[];for(let k=target;k!==-1;k=parent[k])path.push([k%width,Math.floor(k/width)]);return path.reverse();}closed[n.id]=1;explored++;const x=n.id%width,z=Math.floor(n.id/width);
    for(const [dx,dz]of dirs){const nx=x+dx,nz=z+dz;if(!inside([nx,nz])||!walkable(nx,nz)||(dx&&dz&&(!walkable(nx,z)||!walkable(x,nz))))continue;const k=id(nx,nz),g=scores[n.id]+(dx&&dz?Math.SQRT2:1);if(!closed[k]&&g<scores[k]){scores[k]=g;parent[k]=n.id;push({id:k,f:g+heuristic(nx,nz)});}}
  }return [];
};

/* One draw call and preallocated arrays; overwrite oldest particles at capacity. */
KE.Particles=class {
  constructor(THREE,scene,{capacity=256,size=.15,color=0xffd78a,gravity=-2,seed=1}={}){if(!Number.isInteger(capacity)||capacity<1||capacity>100000)throw new RangeError('Invalid particle capacity');Object.assign(this,{THREE,capacity,gravity});this.random=KE.random(seed);this.cursor=0;this.positions=new Float32Array(capacity*3);this.velocities=new Float32Array(capacity*3);this.life=new Float32Array(capacity);this.colors=new Float32Array(capacity*3);this.baseColor=new THREE.Color(color);const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(this.positions,3).setUsage(THREE.DynamicDrawUsage));g.setAttribute('color',new THREE.BufferAttribute(this.colors,3).setUsage(THREE.DynamicDrawUsage));const m=new THREE.PointsMaterial({size,vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false});this.mesh=new THREE.Points(g,m);this.mesh.frustumCulled=false;scene.add(this.mesh);}
  burst(x,y,z,count=24){for(let n=0;n<Math.min(count,this.capacity);n++){const i=this.cursor++%this.capacity,k=i*3;this.positions.set([x,y,z],k);this.velocities.set([(this.random()-.5)*4,1+this.random()*3,(this.random()-.5)*4],k);this.life[i]=.6+this.random()*.7;}return this;}
  update(dt){for(let i=0;i<this.capacity;i++){const k=i*3;this.life[i]=Math.max(0,this.life[i]-dt);if(this.life[i]>0){this.velocities[k+1]+=this.gravity*dt;for(let j=0;j<3;j++)this.positions[k+j]+=this.velocities[k+j]*dt;}const a=clamp(this.life[i]*2,0,1);this.colors[k]=this.baseColor.r*a;this.colors[k+1]=this.baseColor.g*a;this.colors[k+2]=this.baseColor.b*a;}this.mesh.geometry.attributes.position.needsUpdate=true;this.mesh.geometry.attributes.color.needsUpdate=true;}
  dispose(){KE.disposeObject(this.mesh);}
};
KE.Audio=class {
  constructor(){this.context=null;this.volume=.12;this.muted=false;}
  async unlock(){try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return false;this.context=this.context||new C();if(this.context.state==='suspended')await this.context.resume();return this.context.state==='running';}catch{return false;}}
  tone(frequency=660,duration=.12,type='sine'){if(this.muted||!this.context||this.context.state!=='running')return false;const c=this.context,o=c.createOscillator(),g=c.createGain();o.type=type;o.frequency.value=frequency;g.gain.setValueAtTime(0,c.currentTime);g.gain.linearRampToValueAtTime(clamp(this.volume,0,1),c.currentTime+.008);g.gain.exponentialRampToValueAtTime(.0001,c.currentTime+Math.max(.02,duration));o.connect(g);g.connect(c.destination);o.start();o.stop(c.currentTime+Math.max(.02,duration));o.onended=()=>{o.disconnect();g.disconnect();};return true;}
  dispose(){if(this.context){this.context.close();this.context=null;}}
};

/* ---------- 2.1: detailed surface and environment rendering ---------- */
KE.visualEdition='Verdant';

KE.loadVisualAssets=()=>{if(KE._visualReady)return KE._visualReady;KE._visualReady=new Promise(resolve=>{const img=new Image();img.onload=()=>{KE._atlasImage=img;resolve(true);};img.onerror=()=>resolve(false);img.src=KE.visualAtlasURL;});return KE._visualReady;};

KE.legacyRendering={materials:KE.materials,splatMaterial:KE.splatMaterial,water:KE.water};
// Each tile wraps every brush mark across its edges. Identical seeds repeat exactly.
KE.paintTile=(THREE,kind,size=512,seed=7241)=>{
 const S=Math.max(64,Math.min(1024,Math.round(size))),c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d'),r=KE.random(seed+Array.from(kind).reduce((s,v)=>s+v.charCodeAt(0)*31,0)),f=S/512;
 const mix=(a,b,t)=>a+(b-a)*t,colors={grass:[85,113,45],sand:[194,172,121],dirt:[116,89,59],stone:[123,134,124],rock:[111,120,113],snow:[208,223,231],ash:[62,62,62],wood:[132,95,56],bark:[127,127,127],roof:[136,136,136],leaf:[183,183,183],plaster:[199,199,199],lacquer:[198,198,198]};
 const atlasIndex={grass:0,sand:1,rock:2,stone:3}[kind];
 if(KE._atlasImage&&atlasIndex!==undefined){const img=KE._atlasImage,w=img.width/2,h=img.height/2;g.drawImage(img,(atlasIndex%2)*w,Math.floor(atlasIndex/2)*h,w,h,0,0,S,S);const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.MirroredRepeatWrapping;t.anisotropy=KE.settings.aniso||4;const d=g.getImageData(0,0,S,S).data,a=[0,0,0];let n=0;for(let k=0;k<d.length;k+=64){for(let j=0;j<3;j++)a[j]+=d[k+j]/255;n++;}t.userData={avg:a.map(x=>x/n),kind,detailEdition:2,generated:true};return t;}
 const base=colors[kind]||colors.stone,gray=['bark','roof','leaf','plaster','lacquer'].includes(kind),image=g.createImageData(S,S);
 for(let y=0;y<S;y++)for(let x=0;x<S;x++){const n=KE.tileNoise(x,y,S,4)-.5,m=KE.tileNoise(x+19,y+71,S,16)-.5,grain=(r()-.5)*13,v=n*45+m*25+grain,k=(y*S+x)*4;for(let j=0;j<3;j++)image.data[k+j]=clamp(base[j]+v,0,255);image.data[k+3]=255;}g.putImageData(image,0,0);
 const wrap=(x,y,pad,fn)=>{for(const dx of [0,...(x<pad?[S]:[]),...(x>S-pad?[-S]:[])])for(const dy of [0,...(y<pad?[S]:[]),...(y>S-pad?[-S]:[])])fn(x+dx,y+dy);};
 const dot=(x,y,rx,ry,color,rotation=0)=>wrap(x,y,Math.max(rx,ry)+2,(X,Y)=>{g.fillStyle=color;g.beginPath();g.ellipse(X,Y,rx,ry,rotation,0,Math.PI*2);g.fill();});
 const line=(x,y,dx,dy,width,color)=>wrap(x,y,Math.hypot(dx,dy)+width,(X,Y)=>{g.strokeStyle=color;g.lineWidth=width;g.lineCap='round';g.beginPath();g.moveTo(X,Y);g.quadraticCurveTo(X+dx*.2-dy*.12,Y+dy*.3,X+dx,Y+dy);g.stroke();});
 const specks=(n,palette,scale=1)=>{for(let i=0;i<n;i++){const x=r()*S,y=r()*S,w=(.4+r()*1.5)*f*scale;dot(x,y,w,w*(.4+r()*.6),palette[i%palette.length],r()*6.28);}};
 if(kind==='grass'){
  for(let i=0;i<350;i++){const x=r()*S,y=r()*S,q=(5+r()*20)*f;dot(x,y,q,q*.5,`rgba(${r()<.5?'48,74,36':'141,144,62'},.22)`,r()*6);}
  for(let i=0;i<4300;i++){const x=r()*S,y=r()*S,a=r()*6.283,len=(3+r()*14)*f;line(x,y,Math.cos(a)*len,Math.sin(a)*len,(.6+r()*.8)*f,['#384c27aa','#bec075aa','#8b9e47','#c3b77766','#5b7133'][i%5]);}
  specks(1200,['#d7d2a477','#303e2544','#aab26366']);for(let i=0;i<90;i++){const x=r()*S,y=r()*S;dot(x,y,2.3*f,1.5*f,'#537039',r()*6);line(x-2*f,y,4*f,0,.6*f,'#a7bd71');}
 }else if(kind==='sand'){
  for(let j=0;j<19;j++){const y=j*S/19;for(let x=0;x<S;x+=6*f){const yy=y+Math.sin(x/S*12.566)*3*f;line(x,yy,7*f,Math.cos(x/S*12.566)*.4*f,1.4*f,'#fff0c130');line(x,yy+2*f,7*f,0,1*f,'#6e674023');}}
  specks(15500,['#fff4d050','#82715155','#dfcf9455'],.55);specks(150,['#95887588','#eee5cc','#807257'],2);
 }else if(kind==='dirt'){
  specks(12500,['#372f2580','#c4ac7866','#d6be8055','#75604599'],.8);
  for(let i=0;i<140;i++){const x=r()*S,y=r()*S,q=(1+r()*4)*f;dot(x+f,y+f,q,q*.65,'#372f2366');dot(x,y,q,q*.65,'#a3977988',r()*6);}
  for(let i=0;i<65;i++)line(r()*S,r()*S,(r()-.5)*22*f,(r()-.5)*12*f,.7*f,'#d6bb7755');
 }else if(kind==='stone'){
  // Offset hand-cut pavers with recessed grout, beveled rims, chips and moss.
  g.fillStyle='#444d3a';g.fillRect(0,0,S,S);const rowH=S/5,cw=S/5;
  for(let row=0;row<5;row++)for(let col=-1;col<6;col++){const x=col*cw+(row%2)*cw*.5,y=row*rowH,w=cw-5*f,h=rowH-6*f,j=r()*5*f,v=Math.floor(105+r()*35);g.fillStyle=`rgb(${v},${v+9},${v+1})`;g.beginPath();g.moveTo(x+7*f,y+4*f);g.lineTo(x+w-6*f,y+3*f+j);g.lineTo(x+w,y+h-5*f);g.lineTo(x+w-6*f,y+h);g.lineTo(x+4*f,y+h-3*f);g.closePath();g.fill();line(x+8*f,y+6*f,w-18*f,0,2*f,'#d7dac170');line(x+w-4*f,y+9*f,0,h-17*f,2*f,'#2e382d80');line(x+9*f,y+h-4*f,w-18*f,0,2.5*f,'#273a2b77');
   for(let k=0;k<34;k++){const xx=x+8*f+r()*(w-16*f),yy=y+8*f+r()*(h-16*f);dot(xx,yy,(1+r()*2)*f,(.4+r())*f,k%2?'#e2dfbf44':'#34463b44');}
   if(r()<.7){let xx=x+cw*r(),yy=y+h;for(let k=0;k<12;k++){dot(xx+(r()-.5)*15*f,yy+(r()-.5)*9*f,(2+r()*4)*f,(1+r()*2)*f,['#596633','#76854c','#2e4930'][k%3]);}}
   if(r()<.4)line(x+cw*.2,y+rowH*.2,cw*.23,rowH*.31,.8*f,'#38413780');
  }
 }else if(kind==='rock'){
  for(let j=0;j<15;j++){const y=j*S/15;for(let x=0;x<S;x+=8*f){const yy=y+Math.sin(x/S*6.283+j)*8*f+Math.sin(x/S*25.13)*2*f;line(x,yy,10*f,1*f,(1+r()*2)*f,'#25363288');line(x,yy-3*f,10*f,0,1.7*f,'#d8d9b855');}}
  for(let i=0;i<95;i++){const x=r()*S,y=r()*S;line(x,y,(r()-.5)*25*f,(12+r()*48)*f,(.5+r())*f,'#26352e88');}
  specks(9500,['#dee0c744','#37403a55','#8e967c55']);for(let i=0;i<70;i++)dot(r()*S,r()*S,(2+r()*8)*f,(2+r()*5)*f,'#64734d55');
 }else if(kind==='wood'||kind==='bark'||kind==='lacquer'){
  const isGray=kind!=='wood';for(let x=0;x<S;x+=2*f){const shade=Math.floor((isGray?90:60)+r()*80);g.strokeStyle=isGray?`rgba(${shade},${shade},${shade},.45)`:`rgba(${shade},${Math.floor(shade*.69)},${Math.floor(shade*.39)},.42)`;g.lineWidth=(.5+r()*2)*f;g.beginPath();for(let y=0;y<=S;y+=4*f){const xx=x+Math.sin(y/S*6.283+x*.02)*4*f+Math.sin(y/S*18.85)*f;y?g.lineTo(xx,y):g.moveTo(xx,y);}g.stroke();}
  if(kind==='wood'){for(let x=0;x<S;x+=S/4){line(x,0,0,S-1,3*f,'#332d21');line(x+4*f,0,0,S-1,1*f,'#dbb37799');}for(let i=0;i<5;i++){const x=r()*S,y=r()*S;for(let j=9;j>0;j--)dot(x,y,(j*1.2+1)*f,j*3*f,j%2?'#66452977':'#c09c6855');}}
  specks(4000,isGray?['#fff2','#0002']:['#fde1b222','#34231622'],.5);
 }else if(kind==='roof'){
  g.fillStyle='#747474';g.fillRect(0,0,S,S);const rows=7,cols=8,w=S/cols,h=S/rows;for(let j=0;j<rows;j++)for(let i=-1;i<=cols;i++){const x=i*w+(j%2)*w/2,y=j*h;const gr=g.createLinearGradient(x,y,x+w,y);gr.addColorStop(0,'#464646');gr.addColorStop(.25,'#b9b9b9');gr.addColorStop(.62,'#989898');gr.addColorStop(1,'#424242');g.fillStyle=gr;g.fillRect(x+f,y,w-2*f,h-3*f);line(x+4*f,y+h-4*f,w-9*f,0,2*f,'#d0d0d099');}specks(6500,['#fff2','#0003']);
 }else if(kind==='leaf'){
  g.fillStyle='#7e7e7e';g.fillRect(0,0,S,S);for(let i=0;i<390;i++){const x=r()*S,y=r()*S,a=r()*6.283,l=(5+r()*13)*f;dot(x+2*f,y+2*f,l,l*.5,'#34343499',a);dot(x,y,l,l*.5,i%2?'#c7c7c7':'#a4a4a4',a);line(x-Math.cos(a)*l*.7,y-Math.sin(a)*l*.7,Math.cos(a)*l*1.4,Math.sin(a)*l*1.4,.8*f,'#eeeeee88');}
 }else if(kind==='fur'){g.fillStyle='#aaa69b';g.fillRect(0,0,S,S);for(let i=0;i<14000;i++){const x=r()*S,y=r()*S,l=(3+r()*10)*f;line(x,y,(r()-.5)*2*f,l,(.35+r()*.5)*f,i%3?'#efe8d755':'#3e393333');}
 }else if(kind==='snow'){specks(17500,['#ffffff70','#9baec144','#eaf6ff99'],.5);for(let i=0;i<100;i++)dot(r()*S,r()*S,(3+r()*14)*f,(2+r()*6)*f,'#f8fcff44');}
 else if(kind==='ash'){specks(15000,['#11151d88','#88847b44','#9c685722']);for(let i=0;i<65;i++)line(r()*S,r()*S,(r()-.5)*15*f,r()*8*f,.8*f,'#f49d4055');}
 else{specks(11000,['#ffffff33','#55555533','#aaaaaa33'],.55);}
 const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=KE.settings.aniso||4;const pixels=g.getImageData(0,0,S,S).data;let avg=[0,0,0],n=0;for(let i=0;i<pixels.length;i+=64){for(let j=0;j<3;j++)avg[j]+=pixels[i+j]/255;n++;}t.userData={avg:avg.map(v=>v/n),kind,detailEdition:2};return t;
};
KE.materials=(THREE,size)=>{const S=Math.max(64,Math.min(1024,Math.round(size||KE.settings.tex||512))),mats=KE.MATERIAL_KINDS.map(kind=>KE.paintTile(THREE,kind,S));
 // Raw RGBA bytes preserve all eight independent heights, including the alpha channel.
 for(const t of mats)t.wrapS=t.wrapT=THREE.MirroredRepeatWrapping;
 const packs=[];for(let group=0;group<2;group++){const bytes=new Uint8Array(S*S*4),data=mats.slice(group*4,group*4+4).map(t=>t.image.getContext('2d').getImageData(0,0,S,S).data);for(let i=0;i<S*S;i++)for(let ch=0;ch<4;ch++){const a=data[ch],k=i*4;const target=((S-1-Math.floor(i/S))*S+i%S)*4+ch;bytes[target]=Math.round(a[k]*.299+a[k+1]*.587+a[k+2]*.114);}const t=new THREE.DataTexture(bytes,S,S,THREE.RGBAFormat);t.minFilter=THREE.LinearMipmapLinearFilter;t.magFilter=THREE.LinearFilter;t.generateMipmaps=true;t.flipY=false;t.anisotropy=KE.settings.aniso||4;t.wrapS=t.wrapT=THREE.MirroredRepeatWrapping;t.needsUpdate=true;packs.push(t);}mats.heightMaps=packs;for(const t of mats)t.userData.heightMaps=packs;return mats;
};
const keReliefGLSL=`vec3 keReliefNormal(vec3 pos,vec3 n,float h,float strength){vec3 sx=dFdx(pos),sy=dFdy(pos);vec3 r1=cross(sy,n),r2=cross(n,sx);float det=dot(sx,r1);vec3 grad=sign(det)*(dFdx(h)*r1+dFdy(h)*r2);return normalize(abs(det)*n-strength*grad);}`;
KE.splatMaterial=(THREE,mats,o={})=>{
 if(!mats.heightMaps)return KE.legacyRendering.splatMaterial(THREE,mats,o);
 const m=new THREE.MeshStandardMaterial({vertexColors:true,roughness:.92,metalness:0});m.extensions={derivatives:true};m.userData.keTextures=[...mats,...mats.heightMaps];
 m.onBeforeCompile=sh=>{mats.forEach((t,i)=>sh.uniforms['keTile'+i]={value:t});sh.uniforms.keHA={value:mats.heightMaps[0]};sh.uniforms.keHB={value:mats.heightMaps[1]};sh.uniforms.keHTexel={value:2/mats.heightMaps[0].image.width};sh.uniforms.keScale={value:o.scale||.38};sh.uniforms.keRelief={value:o.relief===undefined?.34:o.relief};
 sh.vertexShader='attribute vec4 splatA;attribute vec4 splatB;varying vec4 kA;varying vec4 kB;varying vec3 kWorld;varying vec3 kNormal;\n'+sh.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nkA=splatA;kB=splatB;kWorld=(modelMatrix*vec4(position,1.)).xyz;kNormal=normalize(mat3(modelMatrix)*objectNormal);');
 sh.fragmentShader=`${Array.from({length:8},(_,i)=>'uniform sampler2D keTile'+i+';').join('\n')}\nuniform sampler2D keHA;uniform sampler2D keHB;uniform float keHTexel;uniform float keScale;uniform float keRelief;varying vec4 kA;varying vec4 kB;varying vec3 kWorld;varying vec3 kNormal;\n${keReliefGLSL}\n`+sh.fragmentShader;
 sh.fragmentShader=sh.fragmentShader.replace('#include <map_fragment>',`
 vec2 kuv=kWorld.xz*keScale;vec4 khA=texture2D(keHA,kuv),khB=texture2D(keHB,kuv);
 vec4 ka=pow(max(kA,vec4(0.))*mix(vec4(.62),vec4(1.45),khA),vec4(1.5));vec4 kb=pow(max(kB,vec4(0.))*mix(vec4(.62),vec4(1.45),khB),vec4(1.5));float ksum=dot(ka,vec4(1.))+dot(kb,vec4(1.))+1e-6;ka/=ksum;kb/=ksum;
 vec3 kn=pow(abs(normalize(kNormal)),vec3(4.));kn/=kn.x+kn.y+kn.z;
 vec3 cliff=texture2D(keTile4,kWorld.zy*keScale*.65).rgb*kn.x+texture2D(keTile4,kuv).rgb*kn.y+texture2D(keTile4,kWorld.xy*keScale*.65).rgb*kn.z;
 vec3 kcol=texture2D(keTile0,kuv).rgb*ka.x+texture2D(keTile1,kuv).rgb*ka.y+texture2D(keTile2,kuv).rgb*ka.z+texture2D(keTile3,kuv).rgb*ka.w+cliff*kb.x+texture2D(keTile5,kuv).rgb*kb.y+texture2D(keTile6,kuv).rgb*kb.z+texture2D(keTile7,kuv).rgb*kb.w;
 /* macro variation: the tiles' own luma sampled at 1/14 and 1/53 scale, centred on its mean (the 1x1 mip), breaks up tiling over tens of metres */
 vec4 kmA=texture2D(keHA,kWorld.xz*keScale*.071+vec2(.31,.17)),kmB=texture2D(keHA,kWorld.xz*keScale*.019+vec2(.63,.41)),kmM=texture2D(keHA,vec2(.5),16.);
 float kmacro=clamp((kmA.x-kmM.x)*1.6+(kmB.z-kmM.z)*1.3,-.3,.3);
 diffuseColor.rgb*=pow(max(kcol,vec3(0.)),vec3(2.2))*(1.0+kmacro);
 float kHeight=dot(khA,ka)+dot(khB,kb);
 /* relief from texture-space differences two texels apart: smooth, and it fades by itself where coarser mips are sampled */
 vec2 kte=vec2(keHTexel,0.);vec3 kGrad=vec3(dot(texture2D(keHA,kuv+kte),ka)+dot(texture2D(keHB,kuv+kte),kb)-kHeight,0.,dot(texture2D(keHA,kuv+kte.yx),ka)+dot(texture2D(keHB,kuv+kte.yx),kb)-kHeight);
 `).replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\n{vec3 kgv=(viewMatrix*vec4(kGrad,0.)).xyz;normal=normalize(normal-keRelief*30.*(kgv-normal*dot(kgv,normal)));}');
 };
 m.customProgramCacheKey=()=> 'ke-terrain-detail-3.0';return m;
};
KE.detailTextures=(THREE,size=512)=>{if(KE._detailTex&&KE._detailTex.size===size)return KE._detailTex.maps;const maps={};for(const kind of ['bark','roof','leaf','plaster','lacquer','stone','wood','rock','fur'])maps[kind]=KE.paintTile(THREE,kind,size);KE._detailTex={size,maps};return maps;};
KE.surface=(THREE,kind,o={})=>{
 const maps=KE.detailTextures(THREE,o.textureSize||KE.settings.tex||512),map=maps[kind]||maps.stone,m=new THREE.MeshStandardMaterial({color:o.color===undefined?0xffffff:o.color,roughness:o.roughness===undefined?.87:o.roughness,metalness:o.metalness||0,emissive:o.emissive||0,side:o.side||THREE.FrontSide});m.extensions={derivatives:true};m.userData.keTextures=[map];
 m.onBeforeCompile=sh=>{sh.uniforms.keDetail={value:map};sh.uniforms.keDetailTexel={value:2/((map.image&&map.image.width)||512)};sh.uniforms.keSurfaceScale={value:o.scale||.75};sh.uniforms.keSurfaceBump={value:o.bump===undefined?.16:o.bump};
 sh.vertexShader='varying vec3 ksWorld;varying vec3 ksNormal;\n'+sh.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
 vec4 ksp=vec4(transformed,1.);vec3 ksn=objectNormal;
 #ifdef USE_INSTANCING
 ksp=instanceMatrix*ksp;ksn=mat3(instanceMatrix)*ksn;
 #endif
 ksWorld=(modelMatrix*ksp).xyz;ksNormal=normalize(mat3(modelMatrix)*ksn);`);
 sh.fragmentShader=`uniform sampler2D keDetail;uniform float keDetailTexel;uniform float keSurfaceScale;uniform float keSurfaceBump;varying vec3 ksWorld;varying vec3 ksNormal;${keReliefGLSL}\n`+sh.fragmentShader;
 /* triplanar detail; relief from texture-space luma differences two texels apart on each plane (smooth and mip-aware) */
 sh.fragmentShader=sh.fragmentShader.replace('#include <map_fragment>',`vec3 ksBlend=pow(abs(normalize(ksNormal)),vec3(4.));ksBlend/=ksBlend.x+ksBlend.y+ksBlend.z;const vec3 ksY=vec3(.299,.587,.114);vec2 kse=vec2(keDetailTexel,0.);
 vec2 ksu=ksWorld.zy*keSurfaceScale,ksv=ksWorld.xz*keSurfaceScale,ksw=ksWorld.xy*keSurfaceScale;vec3 ksa=texture2D(keDetail,ksu).rgb,ksb=texture2D(keDetail,ksv).rgb,ksc=texture2D(keDetail,ksw).rgb;
 vec3 ksSample=ksa*ksBlend.x+ksb*ksBlend.y+ksc*ksBlend.z;diffuseColor.rgb*=pow(max(ksSample,vec3(0.)),vec3(2.2))*1.8;
 float ha=dot(ksa,ksY),hb=dot(ksb,ksY),hc=dot(ksc,ksY);
 vec3 ksGrad=ksBlend.x*vec3(0.,dot(texture2D(keDetail,ksu+kse.yx).rgb,ksY)-ha,dot(texture2D(keDetail,ksu+kse).rgb,ksY)-ha)+ksBlend.y*vec3(dot(texture2D(keDetail,ksv+kse).rgb,ksY)-hb,0.,dot(texture2D(keDetail,ksv+kse.yx).rgb,ksY)-hb)+ksBlend.z*vec3(dot(texture2D(keDetail,ksw+kse).rgb,ksY)-hc,dot(texture2D(keDetail,ksw+kse.yx).rgb,ksY)-hc,0.);`).replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\n{vec3 ksg=(viewMatrix*vec4(ksGrad,0.)).xyz;normal=normalize(normal-keSurfaceBump*30.*(ksg-normal*dot(ksg,normal)));}');};
 m.color.convertSRGBToLinear();m.customProgramCacheKey=()=> 'ke-surface-detail-3.0';return m;
};
// Alpha-tested leaf sprays produce irregular silhouettes rather than solid green balls.
KE.leafSprayTexture=(THREE)=>{
 const S=256,c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d'),r=KE.random(312);g.clearRect(0,0,S,S);
 for(let branch=0;branch<7;branch++){const angle=branch/7*Math.PI*2,dx=Math.cos(angle),dy=Math.sin(angle),len=60+r()*49;g.strokeStyle='#667147';g.lineWidth=2;g.beginPath();g.moveTo(128,128);g.lineTo(128+dx*len,128+dy*len);g.stroke();for(let i=1;i<6;i++){const t=i/6,x=128+dx*len*t,y=128+dy*len*t;for(const side of [-1,1]){const a=angle+side*.9,l=12+r()*9;g.save();g.translate(x,y);g.rotate(a);const gr=g.createLinearGradient(0,-5,l,7);gr.addColorStop(0,'#e2e6b8');gr.addColorStop(.5,'#b2c184');gr.addColorStop(1,'#768953');g.fillStyle=gr;g.beginPath();g.moveTo(0,0);g.quadraticCurveTo(l*.45,-l*.46,l,0);g.quadraticCurveTo(l*.5,l*.36,0,0);g.fill();g.strokeStyle='#edf1c177';g.lineWidth=.7;g.beginPath();g.moveTo(1,0);g.lineTo(l-2,0);g.stroke();g.restore();}}}
 return new THREE.CanvasTexture(c);
};
KE.fernGeometry=(THREE)=>{const p=[],n=[],col=[];const tri=(a,b,c,color)=>{const cross=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]);if(cross<0)[b,c]=[c,b];p.push(...a,...b,...c);for(let i=0;i<3;i++){n.push(0,1,0);col.push(...color);}};for(let f=0;f<7;f++){const a=f/7*Math.PI*2,dx=Math.cos(a),dz=Math.sin(a),perp=[-dz,dx];for(let j=1;j<9;j++){const t=j/9,r=t*.65,y=Math.sin(t*Math.PI*.78)*.5,x=dx*r,z=dz*r,len=Math.sin(t*Math.PI)*.22;for(const side of [-1,1])tri([x-dx*.06,y-.045,z-dz*.06],[x+perp[0]*len*side+dx*.07,y+.015,z+perp[1]*len*side+dz*.07],[x+dx*.08,y+.028,z+dz*.08],[.32+t*.2,.52+t*.2,.16+t*.1]);}}const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(n,3));g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));g.computeVertexNormals();return g;};
KE.water=(THREE,scene,o={})=>{
 if(!o.heightAt)return KE.legacyRendering.water(THREE,scene,o);
 const size=o.size||160,center=o.center||new THREE.Vector3(),level=o.level||0,res=128,hbytes=new Uint8Array(res*res*4),range=24;
 for(let z=0;z<res;z++)for(let x=0;x<res;x++){const h=o.heightAt(center.x-size/2+x/(res-1)*size,center.z-size/2+z/(res-1)*size),k=(z*res+x)*4;hbytes[k]=clamp((h+range)/(range*2)*255,0,255);hbytes[k+1]=hbytes[k+2]=hbytes[k];hbytes[k+3]=255;}
 const heightTex=new THREE.DataTexture(hbytes,res,res,THREE.RGBAFormat);heightTex.minFilter=heightTex.magFilter=THREE.LinearFilter;heightTex.needsUpdate=true;
 const uniforms={uTime:{value:0},uLevel:{value:level},uHeight:{value:heightTex},uColor:{value:new THREE.Color(o.color===undefined?0x176472:o.color)},uOpacity:{value:o.opacity===undefined?.95:o.opacity},uLight:{value:1}};
 const mat=new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,side:THREE.DoubleSide,
 vertexShader:`uniform float uTime;varying vec2 vUV;varying vec3 vWP;void main(){vUV=uv;vec3 p=position;float wave=sin(p.x*.7+uTime*1.2)*cos(p.y*.63+uTime*.8)*.055+sin(p.x*1.4-p.y*.8+uTime*1.6)*.022;p.z+=wave;vec4 world=modelMatrix*vec4(p,1.);vWP=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}`,
 fragmentShader:`uniform float uTime;uniform float uLevel;uniform sampler2D uHeight;uniform vec3 uColor;uniform float uOpacity;uniform float uLight;varying vec2 vUV;varying vec3 vWP;void main(){float ground=texture2D(uHeight,vec2(vUV.x,1.-vUV.y)).r*48.-24.;float depth=max(0.,uLevel-ground);float shallow=exp(-depth*.7);vec3 view=normalize(cameraPosition-vWP);float wave=sin(vWP.x*1.1+uTime)*sin(vWP.z*.8-uTime*.7);float ridge=pow(max(0.,sin(vWP.x*1.8+vWP.z*1.25+uTime*.6)*sin(vWP.z*1.35-vWP.x*.55-uTime*.4)),14.);float fresnel=pow(1.-max(0.,view.y),3.);vec3 water=mix(uColor,vec3(.22,.66,.59),shallow*.78);water=mix(water,vec3(.57,.75,.78),fresnel*.55);water+=vec3(.5,.65,.54)*ridge*.11*shallow;water+=wave*.018;float shore=(1.-smoothstep(.12,1.1,depth));float foam=shore*smoothstep(.62,.85,sin(depth*12.-uTime*1.8+wave*.8)*.5+.5);water=mix(water,vec3(.83,.92,.79),foam*.75);float sparkle=pow(max(0.,sin(vWP.x*4.+uTime*2.)*cos(vWP.z*4.6-uTime)),32.)*pow(1.-abs(view.y-.35),9.);water+=vec3(1.,.86,.59)*sparkle*.5;gl_FragColor=vec4(water*uLight,uOpacity*mix(1.,.72,shallow));
#include <tonemapping_fragment>
#include <encodings_fragment>
}`});
 const mesh=new THREE.Mesh(new THREE.PlaneGeometry(size,size,96,96),mat);mesh.rotation.x=-Math.PI/2;mesh.position.set(center.x,level,center.z);scene.add(mesh);return{mesh,uniforms,update(t,light=1){uniforms.uTime.value=t;uniforms.uLight.value=light;},dispose(){mesh.parent&&mesh.parent.remove(mesh);mesh.geometry.dispose();mat.dispose();heightTex.dispose();}};
};

// Small procedural sky cubemap supplies real image-based reflections to standard materials.
KE.environment=(THREE)=>{
 const faces=[];for(let face=0;face<6;face++){const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d'),d=g.createImageData(128,128);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const u=x/127*2-1,v=y/127*2-1;let dir;if(face===0)dir=[1,-v,-u];else if(face===1)dir=[-1,-v,u];else if(face===2)dir=[u,1,v];else if(face===3)dir=[u,-1,-v];else if(face===4)dir=[u,-v,1];else dir=[-u,-v,-1];const len=Math.hypot(...dir),h=dir[1]/len,sun=Math.pow(Math.max(0,(dir[0]*.62+dir[1]*.55-dir[2]*.56)/len),180);let rgb;if(h>0){const t=Math.pow(h,.5);rgb=[.65-.29*t,.72-.18*t,.73-.08*t];}else rgb=[.12,.16,.095];for(let k=0;k<3;k++)d.data[(y*128+x)*4+k]=clamp((rgb[k]+sun*.6)*255,0,255);d.data[(y*128+x)*4+3]=255;}g.putImageData(d,0,0);faces.push(c);}const t=new THREE.CubeTexture(faces);t.needsUpdate=true;t.encoding=THREE.sRGBEncoding;return t;
};

// Merge static, opaque leaf meshes by material and spatial cell. Dynamic objects stay separate.
KE.batchStatic=(THREE,root,o={})=>{
 const groups=new Map(),sources=[],cell=o.cellSize||16;root.updateMatrixWorld(true);
 const inverse=new THREE.Matrix4().copy(root.matrixWorld).invert();
 root.traverse(m=>{if(!m.isMesh||m.isInstancedMesh||m.isSkinnedMesh||m.children.length||!m.visible||Array.isArray(m.material)||m.material.transparent||m.userData.keepSeparate||(o.filter&&!o.filter(m)))return;
  if(Object.keys(m.geometry.morphAttributes).length||Object.values(m.geometry.attributes).some(a=>a.isInterleavedBufferAttribute)||m.geometry.drawRange.start!==0||Number.isFinite(m.geometry.drawRange.count))return;
  const transform=new THREE.Matrix4().multiplyMatrices(inverse,m.matrixWorld),pos=new THREE.Vector3().setFromMatrixPosition(transform);
  if(transform.determinant()<0)return;const sig=Object.entries(m.geometry.attributes).map(([k,v])=>k+':'+v.itemSize+':'+v.normalized).sort().join('|');
  const key=[m.material.uuid,m.castShadow,m.receiveShadow,m.renderOrder,m.layers.mask,Math.floor(pos.x/cell),Math.floor(pos.z/cell),sig].join(':');
  if(!groups.has(key))groups.set(key,[]);groups.get(key).push({mesh:m,transform});
 });
 let merged=0;const oldGeometries=new Set();
 for(const entries of groups.values()){if(entries.length<2)continue;
  const template=entries[0].mesh,parts=entries.map(({mesh,transform})=>{const g=mesh.geometry.index?mesh.geometry.toNonIndexed():mesh.geometry.clone();g.applyMatrix4(transform);return g;}),g=new THREE.BufferGeometry();
  for(const name of Object.keys(parts[0].attributes)){const first=parts[0].attributes[name],count=parts.reduce((sum,p)=>sum+p.attributes[name].array.length,0),data=new first.array.constructor(count);let offset=0;for(const p of parts){data.set(p.attributes[name].array,offset);offset+=p.attributes[name].array.length;}g.setAttribute(name,new THREE.BufferAttribute(data,first.itemSize,first.normalized));}
  g.computeBoundingSphere();g.computeBoundingBox();const m=new THREE.Mesh(g,template.material);m.castShadow=template.castShadow;m.receiveShadow=template.receiveShadow;m.renderOrder=template.renderOrder;m.name='kitsune-static-batch';m.layers.mask=template.layers.mask;root.add(m);
  for(const {mesh}of entries){mesh.parent.remove(mesh);sources.push(mesh);oldGeometries.add(mesh.geometry);}parts.forEach(p=>p.dispose());merged++;
 }
 if(o.disposeSource)oldGeometries.forEach(g=>g.dispose());return{sourceMeshes:sources.length,batches:merged,drawCallsSaved:sources.length-merged};
};

window.KitsuneEngine=KE;
})();
