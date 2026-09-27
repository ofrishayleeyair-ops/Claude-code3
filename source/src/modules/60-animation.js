/* kitsune enginev3 · animation
   Easing and tweens, analytic two-bone IK, FABRIK/CCD chains with joint limits, look-at with limits,
   spring chains (secondary motion), pose blending, an animation state machine with crossfades, 1D/2D
   blend spaces with phase sync, procedural multi-legged locomotion, a keyframe sequencer with camera
   cuts and events, Catmull-Rom camera rails, trauma camera shake, root-motion extraction and skinned
   tube meshes. Everything works on plain Object3D hierarchies (Groups as joints) and on THREE.Bone
   skeletons. CPU only; update paths reuse preallocated scratch objects and do not allocate per frame. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');

/* ---------- shared helpers ---------- */
const EPS=1e-9;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const damp=(a,b,lambda,dt)=>lambda===Infinity?b:a+(b-a)*(1-Math.exp(-lambda*Math.max(0,dt)));
const smooth01=t=>t<=0?0:t>=1?1:t*t*(3-2*t);
const wrapAngle=a=>{a%=Math.PI*2;if(a>Math.PI)a-=Math.PI*2;else if(a<-Math.PI)a+=Math.PI*2;return a;};
function toVec3(THREE,v,def){
  if(v==null){if(def==null)return null;v=def;}
  if(v.isVector3)return v.clone();
  if(Array.isArray(v)||ArrayBuffer.isView(v))return new THREE.Vector3(+v[0]||0,+v[1]||0,+v[2]||0);
  if(typeof v==='object')return new THREE.Vector3(+v.x||0,+v.y||0,+v.z||0);
  throw new TypeError('Expected a Vector3, [x,y,z] or {x,y,z}');
}
/* Per-THREE scratch objects for static functions (each caller key gets its own set, so nesting is safe). */
const scratchCache=new WeakMap();
function scratch(THREE,key,make){let m=scratchCache.get(THREE);if(!m)scratchCache.set(THREE,m=new Map());let s=m.get(key);if(!s)m.set(key,s=make(THREE));return s;}
function isDescendant(node,ancestor){for(let p=node.parent;p;p=p.parent)if(p===ancestor)return true;return false;}
function checkChain(joints,what){
  if(!Array.isArray(joints)||!joints.length)throw new TypeError(what+' needs an array of Object3D joints');
  for(let i=0;i<joints.length;i++){const j=joints[i];if(!j||!j.isObject3D)throw new TypeError(what+' joint '+i+' is not an Object3D');
    if(i&&!isDescendant(j,joints[i-1]))throw new Error(what+' joint '+i+' must be a descendant of joint '+(i-1));}
}
/* Rotation part of a (possibly scaled) world matrix; matrixWorld must be current. */
function worldQuat(obj,out,tp,ts){obj.matrixWorld.decompose(tp,out,ts);return out;}
function parentQuat(obj,out,tp,ts){return obj.parent?worldQuat(obj.parent,out,tp,ts):out.identity();}
function anyPerpendicular(v,out){if(Math.abs(v.x)<.9)out.set(0,-v.z,v.y);else out.set(v.z,0,-v.x);return out.normalize();}
/* Split q into swing (perpendicular to axis) and twist (about unit axis): q = swing * twist. */
function swingTwist(q,axis,swing,twist){
  const d=q.x*axis.x+q.y*axis.y+q.z*axis.z;twist.set(axis.x*d,axis.y*d,axis.z*d,q.w);
  if(twist.lengthSq()<1e-12)twist.identity();else twist.normalize();
  swing.copy(twist).invert().premultiply(q);return swing;
}
function slerpFlat(out,o,a,ao,b,bo,t){
  const x0=a[ao],y0=a[ao+1],z0=a[ao+2],w0=a[ao+3];let x1=b[bo],y1=b[bo+1],z1=b[bo+2],w1=b[bo+3];
  let cos=x0*x1+y0*y1+z0*z1+w0*w1;if(cos<0){cos=-cos;x1=-x1;y1=-y1;z1=-z1;w1=-w1;}
  let s0=1-t,s1=t;if(cos<.9995){const ang=Math.acos(Math.min(1,cos)),sin=Math.sin(ang);s0=Math.sin(s0*ang)/sin;s1=Math.sin(t*ang)/sin;}
  const x=s0*x0+s1*x1,y=s0*y0+s1*y1,z=s0*z0+s1*z1,w=s0*w0+s1*w1,l=Math.hypot(x,y,z,w)||1;
  out[o]=x/l;out[o+1]=y/l;out[o+2]=z/l;out[o+3]=w/l;
}

/* ---------- easing ---------- */
const PI=Math.PI;
const bounceOut=t=>{const n=7.5625,d=2.75;if(t<1/d)return n*t*t;if(t<2/d)return n*(t-=1.5/d)*t+.75;if(t<2.5/d)return n*(t-=2.25/d)*t+.9375;return n*(t-=2.625/d)*t+.984375;};
/* CSS-style cubic-bezier timing: Newton iterations with a bisection fallback. */
function cubicBezier(x1,y1,x2,y2){
  if(![x1,y1,x2,y2].every(Number.isFinite)||x1<0||x1>1||x2<0||x2>1)throw new RangeError('cubicBezier x control points must lie in [0,1]');
  const cx=3*x1,bx=3*(x2-x1)-cx,ax=1-cx-bx,cy=3*y1,by=3*(y2-y1)-cy,ay=1-cy-by;
  const sx=t=>((ax*t+bx)*t+cx)*t,sy=t=>((ay*t+by)*t+cy)*t,dx=t=>(3*ax*t+2*bx)*t+cx;
  return x=>{if(x<=0)return 0;if(x>=1)return 1;let t=x;
    for(let i=0;i<8;i++){const e=sx(t)-x;if(Math.abs(e)<1e-7)return sy(t);const d=dx(t);if(Math.abs(d)<1e-6)break;const n=t-e/d;if(n<0||n>1)break;t=n;}
    let lo=0,hi=1;t=x;for(let i=0;i<48;i++){const v=sx(t);if(Math.abs(v-x)<1e-7)break;if(v<x)lo=t;else hi=t;t=(lo+hi)/2;}return sy(t);};
}
const easing={
  linear:t=>t,
  inQuad:t=>t*t,outQuad:t=>t*(2-t),inOutQuad:t=>t<.5?2*t*t:1-(-2*t+2)**2/2,
  inCubic:t=>t*t*t,outCubic:t=>1-(1-t)**3,inOutCubic:t=>t<.5?4*t*t*t:1-(-2*t+2)**3/2,
  inQuart:t=>t**4,outQuart:t=>1-(1-t)**4,inOutQuart:t=>t<.5?8*t**4:1-(-2*t+2)**4/2,
  inQuint:t=>t**5,outQuint:t=>1-(1-t)**5,inOutQuint:t=>t<.5?16*t**5:1-(-2*t+2)**5/2,
  inSine:t=>1-Math.cos(t*PI/2),outSine:t=>Math.sin(t*PI/2),inOutSine:t=>-(Math.cos(PI*t)-1)/2,
  inExpo:t=>t<=0?0:2**(10*t-10),outExpo:t=>t>=1?1:1-2**(-10*t),inOutExpo:t=>t<=0?0:t>=1?1:t<.5?2**(20*t-10)/2:(2-2**(-20*t+10))/2,
  inCirc:t=>1-Math.sqrt(1-t*t),outCirc:t=>Math.sqrt(1-(t-1)**2),inOutCirc:t=>t<.5?(1-Math.sqrt(1-(2*t)**2))/2:(Math.sqrt(1-(-2*t+2)**2)+1)/2,
  inBack:t=>2.70158*t*t*t-1.70158*t*t,outBack:t=>1+2.70158*(t-1)**3+1.70158*(t-1)**2,
  inOutBack:t=>{const c=1.70158*1.525;return t<.5?((2*t)**2*((c+1)*2*t-c))/2:((2*t-2)**2*((c+1)*(t*2-2)+c)+2)/2;},
  inElastic:t=>t<=0?0:t>=1?1:-(2**(10*t-10))*Math.sin((t*10-10.75)*(2*PI/3)),
  outElastic:t=>t<=0?0:t>=1?1:2**(-10*t)*Math.sin((t*10-.75)*(2*PI/3))+1,
  inOutElastic:t=>{const c=2*PI/4.5;return t<=0?0:t>=1?1:t<.5?-(2**(20*t-10)*Math.sin((20*t-11.125)*c))/2:(2**(-20*t+10)*Math.sin((20*t-11.125)*c))/2+1;},
  inBounce:t=>1-bounceOut(1-t),outBounce:bounceOut,inOutBounce:t=>t<.5?(1-bounceOut(1-2*t))/2:(1+bounceOut(2*t-1))/2,
  smoothstep:t=>t<=0?0:t>=1?1:t*t*(3-2*t),smootherstep:t=>t<=0?0:t>=1?1:t*t*t*(t*(t*6-15)+10),
};
Object.assign(easing,{ease:cubicBezier(.25,.1,.25,1),easeIn:cubicBezier(.42,0,1,1),easeOut:cubicBezier(0,0,.58,1),easeInOut:cubicBezier(.42,0,.58,1)});
const EASE_NAMES=Object.keys(easing);
easing.cubicBezier=cubicBezier;
easing.steps=(n,jump='end')=>{n=Math.max(1,n|0);return jump==='start'?t=>t>=1?1:Math.min(1,Math.ceil(t*n)/n):t=>t>=1?1:Math.floor(t*n)/n;};
function getEase(e){
  if(e==null)return easing.linear;if(typeof e==='function')return e;
  if(typeof e==='string'&&EASE_NAMES.includes(e))return easing[e];
  throw new RangeError('Unknown easing "'+e+'"');
}
function easeName(fn){if(fn==null)return null;if(typeof fn==='string')return fn;for(const k of EASE_NAMES)if(easing[k]===fn)return k;return null;}

/* ---------- property paths and typed values (tweens and sequencer) ---------- */
/* A value is stored as a flat run of numbers: number/boolean 1, Vector2/3/4 2-4, Euler 3, Color 3,
   Quaternion 4 (slerped), arrays n. Writers mutate the existing property object in place. */
const PROJECTION_KEYS=new Set(['fov','zoom','near','far','aspect','filmOffset','filmGauge','focus','left','right','top','bottom']);
function resolvePath(target,path){
  if(target==null)throw new TypeError('Animation target is null');
  if(typeof path!=='string'||!path)throw new TypeError('Property path must be a non-empty string');
  const parts=path.split('.');let obj=target;
  for(let i=0;i<parts.length-1;i++){obj=obj[parts[i]];if(obj==null)throw new Error('Cannot resolve property path "'+path+'"');}
  const key=parts[parts.length-1];
  if(!(key in Object(obj)))throw new Error('Unknown property "'+path+'"');
  return {obj,key};
}
function kindOf(v){
  if(typeof v==='number')return 'number';if(typeof v==='boolean')return 'boolean';if(!v||typeof v!=='object')return null;
  if(v.isQuaternion)return 'quaternion';if(v.isColor)return 'color';if(v.isEuler)return 'euler';
  if(v.isVector2||v.isVector3||v.isVector4)return 'vector';if(Array.isArray(v)||ArrayBuffer.isView(v))return 'array';return null;
}
function sizeOf(kind,v){switch(kind){case 'number':case 'boolean':return 1;case 'quaternion':return 4;case 'color':case 'euler':return 3;case 'vector':return v.isVector2?2:v.isVector3?3:4;case 'array':return v.length;}return 0;}
const VKEYS=['x','y','z','w'];
function readValue(kind,v,out,o,size){
  switch(kind){
    case 'number':out[o]=v;break;case 'boolean':out[o]=v?1:0;break;
    case 'quaternion':out[o]=v.x;out[o+1]=v.y;out[o+2]=v.z;out[o+3]=v.w;break;
    case 'color':out[o]=v.r;out[o+1]=v.g;out[o+2]=v.b;break;
    case 'euler':out[o]=v.x;out[o+1]=v.y;out[o+2]=v.z;break;
    case 'vector':for(let i=0;i<size;i++)out[o+i]=v[VKEYS[i]];break;
    case 'array':for(let i=0;i<size;i++)out[o+i]=+v[i]||0;break;
  }
}
/* Parse a user value into the flat layout of the current property (setup time only). Numbers accept
   relative strings '+=n', '-=n', '*=n'. Colors accept hex, CSS strings, arrays and Color objects. */
function parseValue(kind,input,out,o,size,current){
  const fail=()=>{throw new TypeError('Cannot animate a '+kind+' property with value '+String(input));};
  switch(kind){
    case 'number':{let v=input;if(typeof input==='string'){const m=/^\s*([+\-*])=\s*(-?[\d.]+(?:e[+-]?\d+)?)\s*$/i.exec(input);
        if(m){const n=+m[2];v=m[1]==='+'?current+n:m[1]==='-'?current-n:current*n;}else v=+input;}
      if(!Number.isFinite(v))fail();out[o]=v;break;}
    case 'boolean':out[o]=input?1:0;break;
    case 'color':{if(input&&input.isColor){out[o]=input.r;out[o+1]=input.g;out[o+2]=input.b;break;}
      if(Array.isArray(input)){out[o]=+input[0];out[o+1]=+input[1];out[o+2]=+input[2];break;}
      if(input&&typeof input==='object'&&'r' in input){out[o]=+input.r;out[o+1]=+input.g;out[o+2]=+input.b;break;}
      if(typeof input==='number'||typeof input==='string'){const c=new current.constructor();c.set(input);out[o]=c.r;out[o+1]=c.g;out[o+2]=c.b;break;}
      fail();break;}
    case 'quaternion':{let q=input;if(input&&input.isEuler)q=new current.constructor().setFromEuler(input);
      else if((Array.isArray(input)||ArrayBuffer.isView(input))&&input.length===3){const e={x:+input[0],y:+input[1],z:+input[2],order:'XYZ',isEuler:true};q=new current.constructor().setFromEuler(e);}
      if(Array.isArray(q)||ArrayBuffer.isView(q)){out[o]=+q[0];out[o+1]=+q[1];out[o+2]=+q[2];out[o+3]=+q[3];}
      else if(q&&typeof q==='object'&&'w' in q){out[o]=+q.x;out[o+1]=+q.y;out[o+2]=+q.z;out[o+3]=+q.w;}else fail();
      const l=Math.hypot(out[o],out[o+1],out[o+2],out[o+3]);if(!(l>0))fail();for(let i=0;i<4;i++)out[o+i]/=l;break;}
    case 'euler':case 'vector':case 'array':{
      if(typeof input==='number'&&kind!=='array'){for(let i=0;i<size;i++)out[o+i]=input;break;}
      if(Array.isArray(input)||ArrayBuffer.isView(input)){if(input.length<size)fail();for(let i=0;i<size;i++)out[o+i]=+input[i];}
      else if(input&&typeof input==='object'&&kind!=='array'){for(let i=0;i<size;i++){const k=VKEYS[i];out[o+i]=k in input?+input[k]:readComp(current,k);}}
      else fail();break;}
    default:fail();
  }
  for(let i=0;i<size;i++)if(!Number.isFinite(out[o+i]))fail();
}
const readComp=(v,k)=>+v[k]||0;
function writeValue(kind,obj,key,flat,o,size){
  switch(kind){
    case 'number':obj[key]=flat[o];break;
    case 'boolean':obj[key]=flat[o]>=.5;break;
    case 'quaternion':obj[key].set(flat[o],flat[o+1],flat[o+2],flat[o+3]).normalize();break;
    case 'euler':obj[key].set(flat[o],flat[o+1],flat[o+2]);break;
    case 'color':obj[key].setRGB(flat[o],flat[o+1],flat[o+2]);break;
    case 'vector':{const v=obj[key];v.x=flat[o];v.y=flat[o+1];if(size>2)v.z=flat[o+2];if(size>3)v.w=flat[o+3];break;}
    case 'array':{const a=obj[key];for(let i=0;i<size;i++)a[i]=flat[o+i];break;}
  }
  if(obj.isCamera&&PROJECTION_KEYS.has(key))obj.updateProjectionMatrix();
}
function prepareMaterial(obj,key,values){if(obj&&obj.isMaterial&&key==='opacity'&&values.some(v=>v<1))obj.transparent=true;}

/* ---------- tweens ---------- */
class TweenManager{
  constructor(){this.list=[];this.timeScale=1;}
  get count(){let n=0;for(const t of this.list)if(t._active)n++;return n;}
  add(t){if(!t._queued){t._queued=true;this.list.push(t);}t.manager=this;return t;}
  /* Advance every running tween. Tweens started from callbacks during this call begin next update. */
  update(dt){
    if(!(dt>0))return this;dt*=this.timeScale;const list=this.list,n=list.length;
    for(let i=0;i<n;i++){const t=list[i];if(t._active)t._advance(dt);}
    let w=0;for(let r=0;r<list.length;r++){const t=list[r];if(t._active)list[w++]=t;else t._queued=false;}list.length=w;return this;
  }
  killTweensOf(target){for(const t of this.list)if(t.target===target)t.stop();return this;}
  stopAll(){for(const t of this.list)t.stop();return this;}
}
class Tween{
  constructor(target,props,opts={}){
    if(!target||typeof target!=='object')throw new TypeError('tween target must be an object');
    if(!props||typeof props!=='object')throw new TypeError('tween needs a property map');
    const {duration=1,ease='outCubic',delay=0,repeat=0,repeatDelay=0,yoyo=false,from=null,onStart=null,onUpdate=null,onComplete=null,onRepeat=null,onStop=null,manager=KE.tweens,autoStart=true}=opts;
    if(!(duration>=0)||!(delay>=0)||!(repeat>=0)||!(repeatDelay>=0))throw new RangeError('tween timing values must be non-negative');
    if(repeat===Infinity&&duration+repeatDelay<=0)throw new RangeError('an infinitely repeating tween needs a positive duration');
    Object.assign(this,{target,props,duration,delay,repeat,repeatDelay,yoyo,from,onStart,onUpdate,onComplete,onRepeat,onStop,manager});
    this.ease=getEase(ease);this.elapsed=0;this.iteration=0;this.progress=0;this.started=false;this.done=false;this.paused=false;
    this._active=false;this._queued=false;this._channels=null;this._next=null;this._promise=null;this._resolve=null;
    if(autoStart)this.start();
  }
  get playing(){return this._active&&!this.paused;}
  start(){this.elapsed=0;this.iteration=0;this.started=false;this.done=false;this.paused=false;this._active=true;(this.manager||KE.tweens).add(this);return this;}
  _build(){
    this._channels=[];
    for(const path of Object.keys(this.props)){
      const {obj,key}=resolvePath(this.target,path),cur=obj[key],kind=kindOf(cur);
      if(!kind)throw new TypeError('Cannot tween property "'+path+'" of this type');
      const size=sizeOf(kind,cur),from=new Float64Array(size),to=new Float64Array(size);
      if(this.from&&path in this.from)parseValue(kind,this.from[path],from,0,size,cur);else readValue(kind,cur,from,0,size);
      parseValue(kind,this.props[path],to,0,size,kind==='number'?from[0]:cur);
      if(kind==='quaternion'&&from[0]*to[0]+from[1]*to[1]+from[2]*to[2]+from[3]*to[3]<0)for(let i=0;i<4;i++)to[i]=-to[i];
      prepareMaterial(obj,key,[from[0],to[0]]);
      this._channels.push({obj,key,kind,size,from,to,out:new Float64Array(size)});
    }
  }
  _apply(p){
    this.progress=p;const e=this.ease(p);
    for(const c of this._channels){
      if(c.kind==='quaternion')slerpFlat(c.out,0,c.from,0,c.to,0,e);
      else if(c.kind==='boolean')c.out[0]=e>=1?c.to[0]:c.from[0];
      else for(let i=0;i<c.size;i++)c.out[i]=c.from[i]+(c.to[i]-c.from[i])*e;
      writeValue(c.kind,c.obj,c.key,c.out,0,c.size);
    }
    if(this.onUpdate)this.onUpdate(this.target,p,this);
  }
  _advance(dt){
    if(this.paused||!this._active)return;
    this.elapsed+=dt;const t=this.elapsed-this.delay;if(t<0)return;
    if(!this.started){this.started=true;this._build();if(this.onStart)this.onStart(this.target,this);}
    const d=this.duration,cycle=d+this.repeatDelay,total=this.repeat===Infinity?Infinity:(this.repeat+1)*d+this.repeat*this.repeatDelay;
    if(t>=total){this.iteration=this.repeat;this._apply(this.yoyo&&this.repeat%2===1?0:1);this._finish();return;}
    const it=cycle>0?Math.floor(t/cycle):0;
    if(it!==this.iteration){this.iteration=it;if(this.onRepeat)this.onRepeat(this.target,it,this);}
    let p=d>0?Math.min(1,(t-it*cycle)/d):1;if(this.yoyo&&it%2===1)p=1-p;this._apply(p);
  }
  _finish(){this._active=false;this.done=true;if(this.onComplete)this.onComplete(this.target,this);if(this._resolve)this._resolve(true);if(this._next)for(const n of this._next)n.start();}
  stop(){if(!this._active)return this;this._active=false;if(this.onStop)this.onStop(this.target,this);if(this._resolve)this._resolve(false);return this;}
  pause(){this.paused=true;return this;}
  resume(){this.paused=false;return this;}
  /* Jump to a time (seconds since start, delay included) and apply it. */
  seek(time){const p=this.paused;this.paused=false;this.elapsed=0;if(!this._active){this._active=true;(this.manager||KE.tweens).add(this);}this._advance(Math.max(0,time)+1e-12);this.paused=p;return this;}
  chain(...tweens){this._next=(this._next||[]).concat(tweens);return this;}
  get finished(){if(!this._promise)this._promise=this.done?Promise.resolve(true):new Promise(r=>{this._resolve=r;});return this._promise;}
}

/* ---------- analytic two-bone IK ---------- */
/* Law of cosines in the plane spanned by the target direction and the pole (or the current bend when no
   pole is given). New mid/end positions are built first; each joint then receives the shortest-arc world
   rotation that carries its old child direction onto the new one, converted back to local space. */
const stretchRest=new WeakMap();
function ikScratch(THREE){return scratch(THREE,'ik2',T=>{const V=()=>new T.Vector3(),Q=()=>new T.Quaternion();
  return {a:V(),b:V(),c:V(),dir:V(),bend:V(),b1:V(),c1:V(),u:V(),w:V(),tmp:V(),tp:V(),ts:V(),qr:Q(),qrp:Q(),qm:Q(),qmp:Q(),q0:Q(),q1:Q(),sr:Q(),sm:Q()};});}
function twoBone(THREE,root,mid,end,target,pole=null,opts={}){
  if(!root||!mid||!end||!target)throw new TypeError('IK.twoBone needs root, mid, end and a target Vector3');
  const weight=opts.weight===undefined?1:clamp(+opts.weight||0,0,1),stretch=!!opts.stretch,maxStretch=Math.max(1,opts.maxStretch===undefined?1.5:opts.maxStretch);
  const soft=clamp(opts.soft||0,0,.5),update=opts.updateMatrices!==false,s=ikScratch(THREE);
  let rest=stretchRest.get(mid);
  if(stretch&&!rest){rest={mid:mid.position.clone(),end:end.parent===mid?end.position.clone():null};stretchRest.set(mid,rest);}
  if(rest&&!stretch){mid.position.copy(rest.mid);if(rest.end)end.position.copy(rest.end);stretchRest.delete(mid);rest=null;}
  end.updateWorldMatrix(true,false);
  const a=s.a.setFromMatrixPosition(root.matrixWorld),b=s.b.setFromMatrixPosition(mid.matrixWorld),c=s.c.setFromMatrixPosition(end.matrixWorld);
  let lab=a.distanceTo(b),lcb=b.distanceTo(c);
  if(weight<=0||lab<EPS||lcb<EPS)return c.distanceTo(target);
  const dir=s.dir.subVectors(target,a);let dist=dir.length();
  if(dist<EPS){dir.subVectors(c,a);dist=0;if(dir.lengthSq()<EPS*EPS)return c.distanceTo(target);}
  dir.normalize();
  if(stretch){
    const kMid=mid.position.length()/Math.max(EPS,rest.mid.length()),kEnd=rest.end?end.position.length()/Math.max(EPS,rest.end.length()):1;
    const restAb=lab/kMid,restCb=lcb/kEnd,k=clamp(dist/(restAb+restCb),1,maxStretch);
    mid.position.copy(rest.mid).multiplyScalar(k);if(rest.end)end.position.copy(rest.end).multiplyScalar(k);
    const cb=s.tmp.subVectors(c,b).multiplyScalar(rest.end?k/kEnd:1);
    b.sub(a).multiplyScalar(k/kMid).add(a);c.copy(b).add(cb);lab=restAb*k;if(rest.end)lcb=restCb*k;
  }
  const L=lab+lcb;let d=dist;
  if(soft>0){const ds=soft*L,start=L-ds;if(d>start)d=start+ds*(1-Math.exp(-(d-start)/ds));}
  d=clamp(d,Math.max(Math.abs(lab-lcb),1e-6*L),L);
  const bend=s.bend,tmp=s.tmp;
  if(pole)bend.subVectors(pole,a);else bend.subVectors(b,a);
  bend.addScaledVector(dir,-bend.dot(dir));
  if(bend.lengthSq()<1e-12*L*L){tmp.subVectors(b,a);bend.copy(tmp).addScaledVector(dir,-tmp.dot(dir));if(bend.lengthSq()<1e-12*L*L)anyPerpendicular(dir,bend);}
  bend.normalize();
  const cosA=clamp((lab*lab+d*d-lcb*lcb)/(2*lab*d),-1,1),sinA=Math.sqrt(Math.max(0,1-cosA*cosA));
  const b1=s.b1.copy(a).addScaledVector(dir,cosA*lab).addScaledVector(bend,sinA*lab),c1=s.c1.copy(a).addScaledVector(dir,d);
  worldQuat(root,s.qr,s.tp,s.ts);parentQuat(root,s.qrp,s.tp,s.ts);worldQuat(mid,s.qm,s.tp,s.ts);parentQuat(mid,s.qmp,s.tp,s.ts);
  s.sr.copy(root.quaternion);s.sm.copy(mid.quaternion);
  const u=s.u.subVectors(b,a).normalize(),w=s.w.subVectors(b1,a).normalize(),q0=s.q0.setFromUnitVectors(u,w);
  s.qr.premultiply(q0);root.quaternion.copy(s.qrp).invert().multiply(s.qr);
  const cr=tmp.subVectors(c,a).applyQuaternion(q0).add(a);
  s.qm.premultiply(q0);s.qmp.premultiply(q0);
  u.subVectors(cr,b1).normalize();w.subVectors(c1,b1).normalize();
  s.qm.premultiply(s.q1.setFromUnitVectors(u,w));mid.quaternion.copy(s.qmp).invert().multiply(s.qm);
  if(weight<1){s.q0.copy(root.quaternion);root.quaternion.copy(s.sr).slerp(s.q0,weight);s.q0.copy(mid.quaternion);mid.quaternion.copy(s.sm).slerp(s.q0,weight);}
  if(update){root.updateMatrixWorld(true);return s.c.setFromMatrixPosition(end.matrixWorld).distanceTo(target);}
  return c1.distanceTo(target);
}

/* ---------- iterative IK chains (FABRIK / CCD) with joint limits ---------- */
function normalizeConstraint(THREE,c){
  if(!c)return null;
  let axis=c.axis;if(typeof axis==='string')axis={x:[1,0,0],y:[0,1,0],z:[0,0,1]}[axis.toLowerCase()];
  const min=c.minAngle===undefined?-Math.PI:+c.minAngle,max=c.maxAngle===undefined?Math.PI:+c.maxAngle;
  if(!(min<=max))throw new RangeError('IK constraint minAngle must not exceed maxAngle');
  if(axis)return {type:'hinge',axis:toVec3(THREE,axis).normalize(),min,max};
  const tw=c.twist||null;return {type:'cone',max:Math.max(0,max),twistMin:tw?+tw[0]:-Math.PI,twistMax:tw?+tw[1]:Math.PI};
}
class IKChain{
  constructor(THREE,joints,opts={}){
    checkChain(joints,'IKChain');if(joints.length<2)throw new RangeError('IKChain needs at least two joints');
    const {iterations=12,tolerance=1e-3,method='fabrik',constraints=[],weight=1,maxStep=Infinity}=opts;
    if(method!=='fabrik'&&method!=='ccd')throw new RangeError('IKChain method must be "fabrik" or "ccd"');
    this.THREE=THREE;this.joints=joints.slice();this.iterations=Math.max(1,iterations|0);this.tolerance=tolerance;this.method=method;this.weight=weight;this.maxStep=maxStep;
    const n=joints.length,V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion(),arr=f=>Array.from({length:n},f);
    Object.assign(this,{wp:arr(V),P:arr(V),wq:arr(Q),pq:arr(Q),restQ:arr(Q),startQ:arr(Q),boneAxis:arr(V),len:new Float64Array(n-1),total:0});
    this.constraints=joints.map((_,i)=>normalizeConstraint(THREE,constraints[i]));this.hasConstraints=this.constraints.some(Boolean);
    this._v=Array.from({length:6},V);this._q=Array.from({length:6},Q);this._m=new THREE.Matrix4();this.error=Infinity;this.iterationsUsed=0;
    this.captureRest();
  }
  /* Rest pose = reference for joint limits (current local rotations). */
  captureRest(){
    const j=this.joints,n=j.length;j[n-1].updateWorldMatrix(true,false);
    for(let i=0;i<n;i++){this.restQ[i].copy(j[i].quaternion);
      if(i<n-1){const inv=this._m.copy(j[i].matrixWorld).invert();this.boneAxis[i].setFromMatrixPosition(j[i+1].matrixWorld).applyMatrix4(inv);
        if(this.boneAxis[i].lengthSq()<EPS)this.boneAxis[i].set(0,1,0);this.boneAxis[i].normalize();}
      else this.boneAxis[i].copy(i?this.boneAxis[i-1]:this.boneAxis[i].set(0,1,0));}
    return this;
  }
  _read(){
    const j=this.joints,n=j.length,tp=this._v[4],ts=this._v[5];j[n-1].updateWorldMatrix(true,false);
    for(let i=0;i<n;i++){this.wp[i].setFromMatrixPosition(j[i].matrixWorld);worldQuat(j[i],this.wq[i],tp,ts);parentQuat(j[i],this.pq[i],tp,ts);}
    let total=0;for(let i=0;i<n-1;i++){this.len[i]=this.wp[i].distanceTo(this.wp[i+1]);total+=this.len[i];}this.total=total;
  }
  _constrain(i,local){
    const c=this.constraints[i];if(!c)return local;
    const r=this._q[3].copy(this.restQ[i]).invert().multiply(local);
    if(c.type==='hinge'){const a=c.axis,dot=r.x*a.x+r.y*a.y+r.z*a.z;r.setFromAxisAngle(a,clamp(wrapAngle(2*Math.atan2(dot,r.w)),c.min,c.max));}
    else{const a=this.boneAxis[i],sw=this._q[4],tw=this._q[5];swingTwist(r,a,sw,tw);
      const ang=2*Math.acos(clamp(Math.abs(sw.w),0,1));if(ang>c.max){if(sw.w<0)sw.set(-sw.x,-sw.y,-sw.z,-sw.w);const k=c.max/ang;r.identity().slerp(sw,k);sw.copy(r);}
      if(c.twistMin>-Math.PI||c.twistMax<Math.PI){const t=wrapAngle(2*Math.atan2(tw.x*a.x+tw.y*a.y+tw.z*a.z,tw.w));tw.setFromAxisAngle(a,clamp(t,c.twistMin,c.twistMax));}
      r.copy(sw).multiply(tw);}
    return local.copy(this.restQ[i]).multiply(r);
  }
  /* Apply a world rotation at joint i (pivot = joint), honoring its limit, and propagate to descendants. */
  _rotate(i,delta){
    const n=this.joints.length,q=this._q[0].copy(delta).multiply(this.wq[i]),local=this._q[1].copy(this.pq[i]).invert().multiply(q);
    if(this.constraints[i]){this._constrain(i,local);q.copy(this.pq[i]).multiply(local);}
    const eff=this._q[2].copy(this.wq[i]).invert().premultiply(q);
    this.joints[i].quaternion.copy(local);this.wq[i].copy(q);
    for(let k=i+1;k<n;k++){this.wp[k].sub(this.wp[i]).applyQuaternion(eff).add(this.wp[i]);this.wq[k].premultiply(eff);this.pq[k].premultiply(eff);}
  }
  _applyPositions(){
    const n=this.joints.length,cur=this._v[0],des=this._v[1],dq=this._q[3];
    for(let i=0;i<n-1;i++){cur.subVectors(this.wp[i+1],this.wp[i]);des.subVectors(this.P[i+1],this.wp[i]);
      if(cur.lengthSq()<EPS*EPS||des.lengthSq()<EPS*EPS)continue;cur.normalize();des.normalize();this._rotate(i,dq.setFromUnitVectors(cur,des));}
  }
  _fabrik(target,pole){
    const n=this.joints.length,P=this.P,wp=this.wp,len=this.len,root=this._v[2].copy(wp[0]),dir=this._v[3];
    for(let i=0;i<n;i++)P[i].copy(wp[i]);
    if(root.distanceTo(target)>=this.total){dir.subVectors(target,root).normalize();for(let i=1;i<n;i++)P[i].copy(P[i-1]).addScaledVector(dir,len[i-1]);this._applyPositions();this.iterationsUsed=1;return;}
    this.iterationsUsed=0;
    for(let it=0;it<this.iterations;it++){
      if(P[n-1].distanceTo(target)<=this.tolerance)break;this.iterationsUsed=it+1;
      P[n-1].copy(target);
      for(let i=n-2;i>=0;i--){dir.subVectors(P[i],P[i+1]);let l=dir.length();if(l<EPS){dir.subVectors(wp[i],wp[i+1]);l=dir.length()||1;}P[i].copy(P[i+1]).addScaledVector(dir,len[i]/l);}
      P[0].copy(root);
      for(let i=1;i<n;i++){dir.subVectors(P[i],P[i-1]);let l=dir.length();if(l<EPS){dir.subVectors(wp[i],wp[i-1]);l=dir.length()||1;}P[i].copy(P[i-1]).addScaledVector(dir,len[i-1]/l);}
      if(pole)for(let i=1;i<n-1;i++)this._pole(i,pole);
      if(this.hasConstraints){this._applyPositions();for(let i=0;i<n;i++)P[i].copy(wp[i]);}
    }
    if(!this.hasConstraints)this._applyPositions();
  }
  /* Rotate interior joint i about the line through its neighbours so it bends toward the pole. */
  _pole(i,pole){
    const P=this.P,axis=this._v[0].subVectors(P[i+1],P[i-1]),l=axis.length();if(l<EPS)return;axis.divideScalar(l);
    const r=this._v[1].subVectors(P[i],P[i-1]),proj=r.dot(axis);r.addScaledVector(axis,-proj);const rl=r.length();if(rl<EPS)return;
    const pr=this._v[5].subVectors(pole,P[i-1]);pr.addScaledVector(axis,-pr.dot(axis));const pl=pr.length();if(pl<EPS)return;
    P[i].copy(P[i-1]).addScaledVector(axis,proj).addScaledVector(pr,rl/pl);
  }
  _ccd(target){
    const n=this.joints.length,wp=this.wp,e=this._v[2],t=this._v[3],dq=this._q[3],id=this._q[4];this.iterationsUsed=0;
    for(let it=0;it<this.iterations;it++){
      if(wp[n-1].distanceTo(target)<=this.tolerance)break;this.iterationsUsed=it+1;
      for(let i=n-2;i>=0;i--){e.subVectors(wp[n-1],wp[i]);t.subVectors(target,wp[i]);if(e.lengthSq()<1e-12||t.lengthSq()<1e-12)continue;
        dq.setFromUnitVectors(e.normalize(),t.normalize());
        if(this.maxStep<Math.PI){const ang=2*Math.acos(clamp(dq.w,-1,1));if(ang>this.maxStep){const k=this.maxStep/ang;dq.copy(id.identity().slerp(dq,k));}}
        this._rotate(i,dq);}
    }
  }
  /* Solve toward a world target; returns the remaining distance between the end joint and the target. */
  solve(target,pole=null){
    if(!target)throw new TypeError('IKChain.solve needs a target Vector3');
    const j=this.joints,n=j.length;for(let i=0;i<n;i++)this.startQ[i].copy(j[i].quaternion);
    this._read();
    if(this.total<EPS)return this.error=this.wp[n-1].distanceTo(target);
    if(this.method==='ccd')this._ccd(target);else this._fabrik(target,pole);
    if(this.weight<1){const w=clamp(this.weight,0,1),tmp=this._q[0];for(let i=0;i<n;i++){tmp.copy(j[i].quaternion);j[i].quaternion.copy(this.startQ[i]).slerp(tmp,w);}}
    j[0].updateMatrixWorld(true);
    return this.error=this._v[0].setFromMatrixPosition(j[n-1].matrixWorld).distanceTo(target);
  }
}

/* ---------- look-at with yaw/pitch limits ---------- */
/* Yaw and pitch are measured in the rest frame of the first object and distributed over the chain;
   each object receives its share as a world-space rotation about the shared up/right axes. */
class LookAt{
  constructor(THREE,objects,opts={}){
    const list=Array.isArray(objects)?objects.slice():[objects];checkChain(list,'LookAt');
    const {forward=[0,0,-1],up=[0,1,0],maxYaw=1.2,maxPitch=.7,minPitch=null,speed=10,weight=1,weights=null,releaseAngle=Infinity,base='rest',updateMatrices=true}=opts;
    this.THREE=THREE;this.objects=list;this.forward=toVec3(THREE,forward).normalize();
    this.up=toVec3(THREE,up);this.up.addScaledVector(this.forward,-this.up.dot(this.forward));if(this.up.lengthSq()<EPS)anyPerpendicular(this.forward,this.up);this.up.normalize();
    this.right=new THREE.Vector3().crossVectors(this.forward,this.up).normalize();
    const w=weights?weights.slice(0,list.length):list.map(()=>1),sum=w.reduce((a,b)=>a+Math.max(0,b),0)||1;this.shares=w.map(x=>Math.max(0,x)/sum);
    Object.assign(this,{maxYaw,maxPitch,minPitch:minPitch==null?-maxPitch:minPitch,speed,weight,releaseAngle,base,updateMatrices});
    this.yaw=0;this.pitch=0;this.targetYaw=0;this.targetPitch=0;this.engaged=false;
    this.restQ=list.map(o=>o.quaternion.clone());const V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion();
    this._s={d:V(),eye:V(),uw:V(),rw:V(),rk:V(),tp:V(),ts:V(),pw:Q(),b:Q(),qy:Q(),qp:Q(),dq:Q()};
  }
  captureRest(){this.objects.forEach((o,i)=>this.restQ[i].copy(o.quaternion));return this;}
  update(target,dt=1/60){
    const s=this._s,objs=this.objects,n=objs.length;
    if(this.base==='current')this.captureRest();
    for(let k=0;k<n;k++)objs[k].quaternion.copy(this.restQ[k]);
    objs[n-1].updateWorldMatrix(true,false);
    parentQuat(objs[0],s.pw,s.tp,s.ts);s.b.copy(s.pw).multiply(this.restQ[0]);
    let yawT=0,pitchT=0;this.engaged=false;
    if(target){s.eye.setFromMatrixPosition(objs[n-1].matrixWorld);s.d.subVectors(target,s.eye);
      if(s.d.lengthSq()>1e-12){s.d.applyQuaternion(s.dq.copy(s.b).invert());
        const x=s.d.dot(this.right),y=s.d.dot(this.up),z=s.d.dot(this.forward),yaw=Math.atan2(x,z),pitch=Math.atan2(y,Math.hypot(x,z));
        if(Math.abs(yaw)<=this.releaseAngle){this.engaged=true;yawT=clamp(yaw,-this.maxYaw,this.maxYaw);pitchT=clamp(pitch,this.minPitch,this.maxPitch);}}}
    this.targetYaw=yawT;this.targetPitch=pitchT;
    this.yaw=damp(this.yaw,yawT,this.speed,dt);this.pitch=damp(this.pitch,pitchT,this.speed,dt);
    const yawA=this.yaw*this.weight,pitchA=this.pitch*this.weight;
    s.uw.copy(this.up).applyQuaternion(s.b);s.rw.copy(this.right).applyQuaternion(s.b);
    let cum=0;
    for(let k=0;k<n;k++){const o=objs[k],share=this.shares[k];
      if(k>0){o.parent.updateWorldMatrix(true,false);parentQuat(o,s.pw,s.tp,s.ts);}
      s.rk.copy(s.rw).applyQuaternion(s.qy.setFromAxisAngle(s.uw,-cum));
      s.dq.setFromAxisAngle(s.uw,-yawA*share).multiply(s.qp.setFromAxisAngle(s.rk,pitchA*share));
      // local = inv(pw) * dq * pw * rest
      o.quaternion.copy(s.pw).invert().multiply(s.dq).multiply(s.pw).multiply(this.restQ[k]);
      cum+=yawA*share;}
    if(this.updateMatrices)objs[0].updateMatrixWorld(true);
    return this;
  }
}

/* ---------- spring chains (secondary motion) ---------- */
/* Each child joint is a particle pulled toward its rest-pose position relative to the already simulated
   parent (a Gauss-Seidel sweep from root to tip), with damping relative to that goal's velocity, gravity,
   wind and drag. Position-based constraints restore the bone length and cap the deflection angle; bone
   rotations are then written as shortest-arc deltas from the rest pose. Fixed substeps keep it stable. */
class SpringChain{
  constructor(THREE,joints,opts={}){
    checkChain(joints,'SpringChain');
    const {stiffness=120,damping=12,gravity=[0,-2,0],inertia=1,maxAngle=Math.PI*.6,drag=0,substep=1/120,maxSubsteps=8,tip='auto',colliders=[],groundAt=null,radius=.02,teleportDistance=2,wind=null,weight=1,base='rest'}=opts;
    const n=joints.length,hasTip=tip!==null&&tip!==false;
    if(n<2&&(!hasTip||tip==='auto'))throw new Error('A single-joint SpringChain needs an explicit tip offset');
    this.THREE=THREE;this.joints=joints.slice();this.count=n-1+(hasTip?1:0);this.tip=hasTip?tip:null;
    Object.assign(this,{stiffness,damping,inertia,maxAngle,drag,substep,maxSubsteps,groundAt,radius,teleportDistance,wind,weight,base});
    this.colliders=colliders.map(c=>({object:c.object||null,offset:toVec3(THREE,c.offset||c.center,[0,0,0]),radius:+c.radius||0,center:new THREE.Vector3()}));
    this.gravity=toVec3(THREE,gravity,[0,0,0]);
    const m=this.count,V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion(),arr=(k,f)=>Array.from({length:k},f);
    Object.assign(this,{x:arr(m,V),v:arr(m,V),goalPrev:arr(m,V),offset:arr(m,V),relQ:arr(m,Q),sim:arr(n,Q),restQ:arr(n,Q)});
    this.time=0;this.initialized=false;this.lastPos=V();this.lastPw=Q();
    this._s={pos0:V(),pw0:Q(),ap:V(),aq:Q(),bq:Q(),g:V(),gn:V(),goal:V(),gv:V(),acc:V(),xn:V(),d:V(),dn:V(),ax:V(),w:V(),c:V(),tp:V(),ts:V(),tq:Q(),dq:Q(),m:new THREE.Matrix4()};
    this.captureRest();
  }
  captureRest(){
    const j=this.joints,n=j.length,s=this._s;j[n-1].updateWorldMatrix(true,false);
    for(let i=0;i<n;i++)this.restQ[i].copy(j[i].quaternion);
    for(let k=0;k<n-1;k++){const inv=s.m.copy(j[k].matrixWorld).invert();this.offset[k].setFromMatrixPosition(j[k+1].matrixWorld).applyMatrix4(inv);
      worldQuat(j[k],s.tq,s.tp,s.ts);parentQuat(j[k+1],this.relQ[k],s.tp,s.ts);this.relQ[k].premultiply(s.tq.invert());}
    if(this.tip){const k=this.count-1;if(this.tip==='auto')this.offset[k].copy(this.offset[k-1]);else this.offset[k].copy(toVec3(this.THREE,this.tip));this.relQ[k].identity();}
    this.initialized=false;return this;
  }
  _stiff(k){const s=this.stiffness;return typeof s==='number'?s:s[Math.min(k,s.length-1)];}
  _damp(k){const s=this.damping;return typeof s==='number'?s:s[Math.min(k,s.length-1)];}
  /* One sweep root->tip. integrate=false snaps particles to their goals (reset). */
  _sweep(ap,aq,scale,h,integrate){
    const s=this._s,m=this.count,cols=this.colliders,inv=h>0?1/h:0;
    for(let k=0;k<m;k++){
      const bq=s.bq;if(k===0)bq.copy(aq).multiply(this.restQ[0]);else bq.copy(this.sim[k-1]).multiply(this.relQ[k-1]).multiply(this.restQ[k]);
      const base=k===0?ap:this.x[k-1],g=s.g.copy(this.offset[k]).multiplyScalar(scale).applyQuaternion(bq),L=g.length();
      if(L<EPS){this.sim[k].copy(bq);this.x[k].copy(base);continue;}
      const goal=s.goal.copy(base).add(g),x=this.x[k],v=this.v[k];
      if(integrate){
        const gv=s.gv.subVectors(goal,this.goalPrev[k]).multiplyScalar(inv);this.goalPrev[k].copy(goal);
        const acc=s.acc.subVectors(goal,x).multiplyScalar(this._stiff(k));
        acc.addScaledVector(s.d.subVectors(v,gv),-this._damp(k)).add(this.gravity).addScaledVector(v,-this.drag);
        if(this.wind){if(typeof this.wind==='function')acc.add(this.wind(this.time,s.w.set(0,0,0),k)||s.w.set(0,0,0));else acc.add(this.wind);}
        v.addScaledVector(acc,h);const xn=s.xn.copy(x).addScaledVector(v,h);
        for(const c of cols){s.d.subVectors(xn,c.center);const dl=s.d.length(),r=c.radius+this.radius;if(dl<r)xn.copy(c.center).addScaledVector(dl>EPS?s.d.divideScalar(dl):s.d.set(0,1,0),r);}
        if(this.groundAt){const gy=this.groundAt(xn.x,xn.z)+this.radius;if(xn.y<gy)xn.y=gy;}
        this._limit(base,g,L,xn);v.subVectors(xn,x).multiplyScalar(inv);x.copy(xn);
      }else{x.copy(goal);v.set(0,0,0);this.goalPrev[k].copy(goal);}
      s.gn.copy(g).divideScalar(L);s.dn.subVectors(x,base).normalize();
      this.sim[k].copy(s.dq.setFromUnitVectors(s.gn,s.dn)).multiply(bq);
    }
  }
  /* Restore bone length and cap the angle between the bone and its rest direction. */
  _limit(base,g,L,xn){
    const s=this._s,d=s.d.subVectors(xn,base);let l=d.length();if(l<EPS){d.copy(g);l=L;}d.divideScalar(l);
    const gn=s.gn.copy(g).divideScalar(L),cos=clamp(d.dot(gn),-1,1);
    if(Math.acos(cos)>this.maxAngle){const ax=s.ax.crossVectors(gn,d);if(ax.lengthSq()<1e-12)anyPerpendicular(gn,ax);else ax.normalize();d.copy(gn).applyAxisAngle(ax,this.maxAngle);}
    xn.copy(base).addScaledVector(d,L);
  }
  _anchor(){
    const j0=this.joints[0],s=this._s;j0.updateWorldMatrix(true,false);s.pos0.setFromMatrixPosition(j0.matrixWorld);parentQuat(j0,s.pw0,s.tp,s.ts);
    j0.matrixWorld.decompose(s.tp,s.tq,s.ts);return (Math.abs(s.ts.x)+Math.abs(s.ts.y)+Math.abs(s.ts.z))/3;
  }
  _write(){
    const j=this.joints,n=j.length,m=this.count,s=this._s,pq=s.tq;
    for(let k=0;k<m;k++){if(k===0)pq.copy(s.pw0);else pq.copy(this.sim[k-1]).multiply(this.relQ[k-1]);
      const q=j[k].quaternion;q.copy(pq).invert().multiply(this.sim[k]);if(this.weight<1){s.dq.copy(q);q.copy(this.restQ[k]).slerp(s.dq,clamp(this.weight,0,1));}}
    for(let k=m;k<n;k++)j[k].quaternion.copy(this.restQ[k]);
    j[0].updateMatrixWorld(true);
  }
  /* Sphere colliders: {object?, offset|center, radius}; offset is local to object, center is world. */
  _colliders(){for(const c of this.colliders){c.center.copy(c.offset);if(c.object){c.object.updateWorldMatrix(true,false);c.center.applyMatrix4(c.object.matrixWorld);}}}
  /* Snap to the rest pose relative to the current anchor (use after teleports). */
  reset(){
    if(this.base==='current')for(let i=0;i<this.joints.length;i++)this.restQ[i].copy(this.joints[i].quaternion);
    const scale=this._anchor(),s=this._s;this._sweep(s.pos0,s.pw0,scale,0,false);this.lastPos.copy(s.pos0);this.lastPw.copy(s.pw0);this.initialized=true;this._write();return this;
  }
  update(dt){
    if(!(dt>0))return this;
    if(!this.initialized)return this.reset();
    if(this.base==='current')for(let i=0;i<this.joints.length;i++)this.restQ[i].copy(this.joints[i].quaternion);
    const s=this._s,scale=this._anchor();
    if(s.pos0.distanceTo(this.lastPos)>this.teleportDistance)return this.reset();
    if(this.inertia<1){s.d.subVectors(s.pos0,this.lastPos).multiplyScalar(1-clamp(this.inertia,0,1));for(const x of this.x)x.add(s.d);}
    this._colliders();
    const steps=clamp(Math.ceil(dt/this.substep-1e-9),1,this.maxSubsteps),h=dt/steps;
    for(let i=0;i<steps;i++){const f=(i+1)/steps;s.ap.lerpVectors(this.lastPos,s.pos0,f);s.aq.copy(this.lastPw).slerp(s.pw0,f);this.time+=h;this._sweep(s.ap,s.aq,scale,h,true);}
    this.lastPos.copy(s.pos0);this.lastPw.copy(s.pw0);this._write();return this;
  }
  /* Largest particle speed (m/s): handy to detect a settled chain. */
  get energy(){let e=0;for(const v of this.v)e=Math.max(e,v.length());return e;}
  dispose(){}
}

/* ---------- procedural bone chains and skinned tubes ---------- */
function createBoneChain(THREE,count,length=.1,{direction=[0,1,0],parent=null,name='bone'}={}){
  if(!(count>=1))throw new RangeError('createBoneChain needs at least one bone');
  const dir=toVec3(THREE,direction).normalize(),bones=[];
  for(let i=0;i<count;i++){const b=new THREE.Bone();b.name=name+i;if(i>0){b.position.copy(dir).multiplyScalar(Array.isArray(length)?length[i-1]:length);bones[i-1].add(b);}bones.push(b);}
  if(parent)parent.add(bones[0]);return bones;
}
/* A SkinnedMesh tube around a bone chain: rings follow a centripetal Catmull-Rom spline through the bone
   origins with parallel-transport frames; each ring is skinned to its bone and blended half-way into the
   neighbour near joints. Rounded caps close both ends. The mesh is added next to the root bone. */
function buildSkinnedTube(THREE,bones,opts={}){
  checkChain(bones,'buildSkinnedTube');if(!bones.every(b=>b.isBone))throw new TypeError('buildSkinnedTube needs THREE.Bone joints (see KE.createBoneChain)');
  const {radius=.08,segments=12,rings=4,tip='auto',material=null,color=null,capRings=4,capStart=true,capEnd=true,up=[0,1,0]}=opts;
  const n=bones.length,parent=bones[0].parent;bones[0].updateWorldMatrix(true,true);
  const inv=parent?new THREE.Matrix4().copy(parent.matrixWorld).invert():new THREE.Matrix4();
  const pts=bones.map(b=>new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv));
  let tipPt;
  if(tip==='auto'){if(n<2)throw new Error('A single-bone tube needs an explicit tip offset');tipPt=pts[n-1].clone().add(pts[n-1].clone().sub(pts[n-2]));}
  else tipPt=toVec3(THREE,tip).applyMatrix4(bones[n-1].matrixWorld).applyMatrix4(inv);
  pts.push(tipPt);
  const curve=new THREE.CatmullRomCurve3(pts,false,'centripetal'),rf=typeof radius==='function'?radius:()=>radius;
  const total=pts.reduce((a,p,i)=>i?a+p.distanceTo(pts[i-1]):0,0);
  const seg=Math.max(3,segments|0),per=Math.max(1,rings|0),R=n*per+1;
  // parallel-transport frames along the body rings
  const frames=[],T0=curve.getTangent(0).normalize(),N=new THREE.Vector3().copy(toVec3(THREE,up));N.addScaledVector(T0,-N.dot(T0));if(N.lengthSq()<1e-8)anyPerpendicular(T0,N);N.normalize();
  for(let r=0;r<R;r++){const u=r/(R-1),p=curve.getPoint(u),t=curve.getTangent(u).normalize();N.addScaledVector(t,-N.dot(t));if(N.lengthSq()<1e-10)anyPerpendicular(t,N);N.normalize();
    const B=new THREE.Vector3().crossVectors(t,N).normalize(),i=Math.min(n-1,Math.floor(r/per)),f=r/per-i;
    const du=1/(R-1),dr=(rf(Math.min(1,u+du))-rf(Math.max(0,u-du)))/((Math.min(1,u+du)-Math.max(0,u-du))*total||1);
    frames.push({p,t,n:N.clone(),b:B,r:Math.max(0,rf(u)),u,slope:dr,i,f});}
  const ringList=[];// {p,t,n,b,r,normalT,u,skin:[i0,i1,w0,w1]}
  const skinFor=(i,f)=>{if(f<.5&&i>0){const w=.5*(1-smooth01(2*f));return [i,i-1,1-w,w];}if(f>=.5&&i<n-1){const w=.5*smooth01(2*f-1);return [i,i+1,1-w,w];}return [i,i,1,0];};
  const cap=(fr,sign,bone)=>{const out=[];for(let q=capRings;q>=1;q--){const phi=q/capRings*Math.PI/2;
    out.push({p:fr.p.clone().addScaledVector(fr.t,sign*fr.r*Math.sin(phi)*.85),t:fr.t,n:fr.n,b:fr.b,r:fr.r*Math.cos(phi),cosPhi:Math.cos(phi),sinPhi:sign*Math.sin(phi),u:fr.u,skin:[bone,bone,1,0]});}return out;};
  if(capStart&&frames[0].r>1e-4)ringList.push(...cap(frames[0],-1,0));
  for(const fr of frames)ringList.push({p:fr.p,t:fr.t,n:fr.n,b:fr.b,r:fr.r,slope:fr.slope,u:fr.u,skin:skinFor(Math.min(fr.i,n-1),fr.i>=n?1:fr.f)});
  if(capEnd&&frames[R-1].r>1e-4)ringList.push(...cap(frames[R-1],1,n-1).reverse());
  const V=ringList.length*(seg+1),pos=new Float32Array(V*3),nor=new Float32Array(V*3),uv=new Float32Array(V*2),si=new Uint16Array(V*4),sw=new Float32Array(V*4);
  const col=color?new Float32Array(V*3):null,cTmp=new THREE.Color(),dirv=new THREE.Vector3(),nv=new THREE.Vector3();
  let k=0;
  ringList.forEach((ring,ri)=>{
    let cc=null;if(color){if(typeof color==='function'){cc=color(ring.u,cTmp)||cTmp;}else cc=cTmp.set(color);}
    for(let j=0;j<=seg;j++){const a=j/seg*Math.PI*2,ca=Math.cos(a),sa=Math.sin(a);dirv.copy(ring.n).multiplyScalar(ca).addScaledVector(ring.b,sa);
      pos[k*3]=ring.p.x+dirv.x*ring.r;pos[k*3+1]=ring.p.y+dirv.y*ring.r;pos[k*3+2]=ring.p.z+dirv.z*ring.r;
      if(ring.cosPhi!==undefined)nv.copy(dirv).multiplyScalar(ring.cosPhi).addScaledVector(ring.t,ring.sinPhi);else nv.copy(dirv).addScaledVector(ring.t,-ring.slope);
      nv.normalize();nor[k*3]=nv.x;nor[k*3+1]=nv.y;nor[k*3+2]=nv.z;uv[k*2]=j/seg;uv[k*2+1]=ri/(ringList.length-1);
      si[k*4]=ring.skin[0];si[k*4+1]=ring.skin[1];sw[k*4]=ring.skin[2];sw[k*4+1]=ring.skin[3];
      if(col){col[k*3]=cc.r;col[k*3+1]=cc.g;col[k*3+2]=cc.b;}k++;}
  });
  const idx=[];for(let r=0;r<ringList.length-1;r++)for(let j=0;j<seg;j++){const a=r*(seg+1)+j,b=a+seg+1;idx.push(a,a+1,b,a+1,b+1,b);}
  const g=new THREE.BufferGeometry();g.setIndex(idx);g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('normal',new THREE.BufferAttribute(nor,3));
  g.setAttribute('uv',new THREE.BufferAttribute(uv,2));g.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(si,4));g.setAttribute('skinWeight',new THREE.Float32BufferAttribute(sw,4));
  if(col)g.setAttribute('color',new THREE.BufferAttribute(col,3));
  g.computeBoundingSphere();g.boundingSphere.radius+=total*.6;g.computeBoundingBox();
  const mat=material||new THREE.MeshStandardMaterial({color:col?0xffffff:0xcc793f,roughness:.88,vertexColors:!!col});
  if('skinning' in mat&&!mat.skinning){mat.skinning=true;mat.needsUpdate=true;}
  const mesh=new THREE.SkinnedMesh(g,mat);mesh.name='keSkinnedTube';mesh.castShadow=true;mesh.receiveShadow=true;
  if(parent)parent.add(mesh);mesh.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton(bones));
  mesh.userData.keTube={bones:n,rings:ringList.length,segments:seg,length:total,ownsMaterial:!material};
  return mesh;
}

/* ---------- pose blending ---------- */
/* Weighted accumulation of local transforms (nlerp for rotations, hemisphere-aligned to the rest pose).
   Missing weight (sum < 1) is filled with the captured rest pose. */
class PoseBlender{
  constructor(THREE,objects,{position=true,rotation=true,scale=false}={}){
    if(!Array.isArray(objects)||!objects.length)throw new TypeError('PoseBlender needs an array of objects');
    this.THREE=THREE;this.objects=objects.slice();this.position=position;this.rotation=rotation;this.scale=scale;
    const n=objects.length;this.index=new Map(objects.map((o,i)=>[o,i]));this.acc=new Float64Array(n*10);this.wsum=new Float64Array(n);this.rest=this.capture();
  }
  capture(out=new Float32Array(this.objects.length*10)){
    this.objects.forEach((o,i)=>{const b=i*10;out[b]=o.position.x;out[b+1]=o.position.y;out[b+2]=o.position.z;out[b+3]=o.quaternion.x;out[b+4]=o.quaternion.y;out[b+5]=o.quaternion.z;out[b+6]=o.quaternion.w;out[b+7]=o.scale.x;out[b+8]=o.scale.y;out[b+9]=o.scale.z;});return out;
  }
  captureRest(){this.capture(this.rest);return this;}
  reset(){this.acc.fill(0);this.wsum.fill(0);return this;}
  _acc(i,src,o,w){
    if(!(w>0))return;const a=this.acc,b=i*10,r=this.rest;
    a[b]+=src[o]*w;a[b+1]+=src[o+1]*w;a[b+2]+=src[o+2]*w;
    const sgn=src[o+3]*r[b+3]+src[o+4]*r[b+4]+src[o+5]*r[b+5]+src[o+6]*r[b+6]<0?-w:w;
    a[b+3]+=src[o+3]*sgn;a[b+4]+=src[o+4]*sgn;a[b+5]+=src[o+5]*sgn;a[b+6]+=src[o+6]*sgn;
    a[b+7]+=src[o+7]*w;a[b+8]+=src[o+8]*w;a[b+9]+=src[o+9]*w;this.wsum[i]+=w;
  }
  addPose(snapshot,weight){for(let i=0;i<this.objects.length;i++)this._acc(i,snapshot,i*10,weight);return this;}
  /* Add one object's transform: {position?, quaternion?, scale?}; missing parts use the rest pose. */
  add(object,t,weight){
    const i=typeof object==='number'?object:this.index.get(object);if(i===undefined)throw new Error('Object is not part of this PoseBlender');
    const tmp=this._tmp||(this._tmp=new Float64Array(10)),r=this.rest,b=i*10;for(let k=0;k<10;k++)tmp[k]=r[b+k];
    if(t.position){tmp[0]=t.position.x;tmp[1]=t.position.y;tmp[2]=t.position.z;}if(t.quaternion){tmp[3]=t.quaternion.x;tmp[4]=t.quaternion.y;tmp[5]=t.quaternion.z;tmp[6]=t.quaternion.w;}
    if(t.scale){tmp[7]=t.scale.x;tmp[8]=t.scale.y;tmp[9]=t.scale.z;}this._acc(i,tmp,0,weight);return this;
  }
  apply(){
    const a=this.acc,r=this.rest;
    this.objects.forEach((o,i)=>{const b=i*10,W=this.wsum[i],fill=Math.max(0,1-W),tot=W+fill;
      if(W<=0){if(this.position)o.position.set(r[b],r[b+1],r[b+2]);if(this.rotation)o.quaternion.set(r[b+3],r[b+4],r[b+5],r[b+6]);if(this.scale)o.scale.set(r[b+7],r[b+8],r[b+9]);return;}
      if(this.position)o.position.set((a[b]+r[b]*fill)/tot,(a[b+1]+r[b+1]*fill)/tot,(a[b+2]+r[b+2]*fill)/tot);
      if(this.rotation)o.quaternion.set(a[b+3]+r[b+3]*fill,a[b+4]+r[b+4]*fill,a[b+5]+r[b+5]*fill,a[b+6]+r[b+6]*fill).normalize();
      if(this.scale)o.scale.set((a[b+7]+r[b+7]*fill)/tot,(a[b+8]+r[b+8]*fill)/tot,(a[b+9]+r[b+9]*fill)/tot);});
    return this;
  }
}

/* ---------- blend spaces ---------- */
/* Entries hold an AnimationAction or a pose(weight,dt,time,phase) function. With sync:true all actions
   share one normalized phase whose speed follows the weighted cycle length (like UE sync groups). */
class BlendSpaceBase{
  constructor(entries,{sync=false,smoothing=0}={}){
    if(!Array.isArray(entries)||!entries.length)throw new TypeError('A blend space needs at least one entry');
    for(const e of entries)if(!e||(!e.action&&typeof e.pose!=='function'))throw new TypeError('Blend space entries need an action or a pose function');
    this.entries=entries.map(e=>({...e}));const n=entries.length;this.weights=new Float64Array(n);this._target=new Float64Array(n);
    this.sync=sync;this.smoothing=smoothing;this.weight=1;this.phase=0;this.time=0;this._init=false;
  }
  _commit(dt){
    const n=this.entries.length,w=this.weights,t=this._target;
    if(this.smoothing>0&&this._init&&dt>0){const k=1-Math.exp(-this.smoothing*dt);let s=0;for(let i=0;i<n;i++){w[i]+=(t[i]-w[i])*k;s+=w[i];}if(s>0)for(let i=0;i<n;i++)w[i]/=s;}
    else for(let i=0;i<n;i++)w[i]=t[i];
    this._init=true;this._apply(dt);return w;
  }
  _cycle(e){return e.action?e.action.getClip().duration:(e.duration||1);}
  _apply(dt){
    const n=this.entries.length,W=this.weight;let D=0;
    if(this.sync)for(let i=0;i<n;i++)D+=this.weights[i]*this._cycle(this.entries[i]);
    for(let i=0;i<n;i++){const e=this.entries[i],w=this.weights[i]*W;
      if(e.action){const a=e.action;a.enabled=true;if(w>0&&!a.isRunning())a.play();a.setEffectiveWeight(w);
        if(this.sync&&D>0){const c=this._cycle(e);a.time=this.phase*c;a.setEffectiveTimeScale(c/D);}}
      if(e.pose)e.pose(w,dt,this.sync&&D>0?this.phase*this._cycle(e):this.time,this.phase);}
    if(this.sync&&D>0&&dt>0)this.phase=(this.phase+dt/D)%1;this.time+=Math.max(0,dt);
  }
  weightOf(i){return this.weights[i];}
}
class BlendSpace1D extends BlendSpaceBase{
  constructor(entries,opts={}){
    super(entries,opts);for(const e of this.entries)if(!Number.isFinite(e.value))throw new TypeError('BlendSpace1D entries need a numeric value');
    this.entries.sort((a,b)=>a.value-b.value);this.value=this.entries[0].value;this.isBlendSpace1D=true;
  }
  update(value,dt=0){
    const e=this.entries,n=e.length,t=this._target;t.fill(0);value=+value;if(!Number.isFinite(value))value=this.value;this.value=value;
    if(n===1||value<=e[0].value)t[0]=1;else if(value>=e[n-1].value)t[n-1]=1;
    else for(let i=0;i<n-1;i++){const a=e[i].value,b=e[i+1].value;if(value>=a&&value<=b){if(b-a<EPS)t[i]=1;else{const f=(value-a)/(b-a);t[i]=1-f;t[i+1]=f;}break;}}
    return this._commit(dt);
  }
}
/* Bowyer-Watson Delaunay triangulation of a small point set (coordinates normalized to ~[0,1]). */
function delaunay(pts){
  const n=pts.length;if(n<3)return [];
  const P=pts.map(p=>[p[0],p[1]]);P.push([-10,-10],[30,-10],[-10,30]);
  const circ=(a,b,c)=>{const [ax,ay]=P[a],[bx,by]=P[b],[cx,cy]=P[c],d=2*(ax*(by-cy)+bx*(cy-ay)+cx*(ay-by));if(Math.abs(d)<1e-14)return {x:0,y:0,r2:Infinity};
    const a2=ax*ax+ay*ay,b2=bx*bx+by*by,c2=cx*cx+cy*cy,x=(a2*(by-cy)+b2*(cy-ay)+c2*(ay-by))/d,y=(a2*(cx-bx)+b2*(ax-cx)+c2*(bx-ax))/d;return {x,y,r2:(ax-x)**2+(ay-y)**2};};
  let tris=[{v:[n,n+1,n+2],c:circ(n,n+1,n+2)}];
  for(let i=0;i<n;i++){const [px,py]=P[i],bad=[],keep=[];
    for(const t of tris)((px-t.c.x)**2+(py-t.c.y)**2<t.c.r2-1e-12?bad:keep).push(t);
    const edges=[];for(const t of bad)for(let e=0;e<3;e++){const a=t.v[e],b=t.v[(e+1)%3];const j=edges.findIndex(x=>x[0]===b&&x[1]===a);if(j>=0)edges.splice(j,1);else edges.push([a,b]);}
    tris=keep;for(const [a,b] of edges)tris.push({v:[a,b,i],c:circ(a,b,i)});}
  const area=(a,b,c)=>((P[b][0]-P[a][0])*(P[c][1]-P[a][1])-(P[c][0]-P[a][0])*(P[b][1]-P[a][1]))/2;
  return tris.filter(t=>t.v.every(v=>v<n)&&Math.abs(area(...t.v))>1e-10).map(t=>t.v);
}
class BlendSpace2D extends BlendSpaceBase{
  constructor(entries,opts={}){
    super(entries,opts);const {method='triangulate',power=2}=opts;
    for(const e of this.entries)if(!Number.isFinite(e.x)||!Number.isFinite(e.y))throw new TypeError('BlendSpace2D entries need numeric x and y');
    const xs=this.entries.map(e=>e.x),ys=this.entries.map(e=>e.y);this.minX=Math.min(...xs);this.minY=Math.min(...ys);
    this.sx=(Math.max(...xs)-this.minX)||1;this.sy=(Math.max(...ys)-this.minY)||1;this.power=power;this.isBlendSpace2D=true;
    this.pts=this.entries.map(e=>[(e.x-this.minX)/this.sx,(e.y-this.minY)/this.sy]);
    this.triangles=method==='triangulate'?delaunay(this.pts):[];this.method=this.triangles.length?'triangulate':'idw';
    const count=new Map(),key=(a,b)=>a<b?a+','+b:b+','+a;
    for(const t of this.triangles)for(let e=0;e<3;e++){const k=key(t[e],t[(e+1)%3]);count.set(k,(count.get(k)||0)+1);}
    this.hull=[...count].filter(([,c])=>c===1).map(([k])=>k.split(',').map(Number));this.x=this.entries[0].x;this.y=this.entries[0].y;
  }
  update(x,y,dt=0){
    const t=this._target,P=this.pts,n=P.length;t.fill(0);if(Number.isFinite(x))this.x=x;if(Number.isFinite(y))this.y=y;
    const qx=(this.x-this.minX)/this.sx,qy=(this.y-this.minY)/this.sy;
    if(this.method==='triangulate'){let done=false;
      for(const [a,b,c] of this.triangles){const [ax,ay]=P[a],[bx,by]=P[b],[cx,cy]=P[c],d=(by-cy)*(ax-cx)+(cx-bx)*(ay-cy);
        const l1=((by-cy)*(qx-cx)+(cx-bx)*(qy-cy))/d,l2=((cy-ay)*(qx-cx)+(ax-cx)*(qy-cy))/d,l3=1-l1-l2;
        if(l1>=-1e-9&&l2>=-1e-9&&l3>=-1e-9){t[a]=Math.max(0,l1);t[b]=Math.max(0,l2);t[c]=Math.max(0,l3);done=true;break;}}
      if(!done){let best=Infinity,ba=0,bb=0,bf=0;
        for(const [a,b] of this.hull){const [ax,ay]=P[a],[bx,by]=P[b],ex=bx-ax,ey=by-ay,l2=ex*ex+ey*ey,f=l2>0?clamp(((qx-ax)*ex+(qy-ay)*ey)/l2,0,1):0,dx=ax+ex*f-qx,dy=ay+ey*f-qy,d=dx*dx+dy*dy;
          if(d<best){best=d;ba=a;bb=b;bf=f;}}
        t[ba]+=1-bf;t[bb]+=bf;}
      const s=t.reduce((a,b)=>a+b,0)||1;for(let i=0;i<n;i++)t[i]/=s;
    }else{let s=0,hit=-1;for(let i=0;i<n;i++){const d=Math.hypot(P[i][0]-qx,P[i][1]-qy);if(d<1e-6){hit=i;break;}t[i]=1/d**this.power;s+=t[i];}
      if(hit>=0){t.fill(0);t[hit]=1;}else for(let i=0;i<n;i++)t[i]/=s;}
    return this._commit(dt);
  }
}

/* ---------- animation state machine ---------- */
/* States play an AnimationAction, a procedural pose function or a blend space. Transitions run in
   priority order; a crossfade blends from the current weights of every active state, so interrupted
   fades stay continuous and the weights always sum to 1. */
class AnimStateMachine{
  constructor(a,b){
    let THREE=null,opts=a||{};if(a&&(a.REVISION||a.AnimationMixer)){THREE=a;opts=b||{};}
    this.THREE=THREE||(typeof window!=='undefined'&&window.THREE)||null;
    const {params={},mixer=null,blender=null,defaultDuration=.2,initial=null}=opts;
    Object.assign(this,{params:Object.assign({},params),mixer,blender,defaultDuration,_initial:initial});
    this.states=new Map();this.transitions=[];this.active=[];this.current=null;this.previous=null;this.fade=null;
    this.onEnter=null;this.onExit=null;this.onTransition=null;
  }
  addState(name,def={}){
    if(typeof name!=='string'||!name||name==='*')throw new TypeError('State names must be non-empty strings other than "*"');
    if(this.states.has(name))throw new Error('Duplicate animation state "'+name+'"');
    const {action=null,pose=null,blend=null,param=null,speed=1,loop=true,duration=null,onEnter=null,onExit=null,onUpdate=null,notifies=[]}=def;
    if(pose&&typeof pose!=='function')throw new TypeError('pose must be a function(weight,dt,time)');
    const st={name,action,pose,blend,param,speed,loop,onEnter,onExit,onUpdate,time:0,weight:0,w0:0,
      notifies:notifies.map(x=>({t:+x.t,fn:x.fn})).sort((p,q)=>p.t-q.t),length:Math.max(1e-6,duration||(action?action.getClip().duration:blend&&blend.entries[0].action?blend.entries[0].action.getClip().duration:1)),_out:[0,0]};
    if(action){const T=this.THREE;action.setLoop(loop?(T?T.LoopRepeat:2201):(T?T.LoopOnce:2200),Infinity);action.clampWhenFinished=!loop;action.enabled=true;action.setEffectiveWeight(0);}
    this.states.set(name,st);return this;
  }
  addTransition(from,to,def={}){
    const {when=null,duration=this.defaultDuration,exitTime=null,ease='linear',priority=0,trigger=null,allowSelf=false}=def;
    if(when&&typeof when!=='function')throw new TypeError('Transition "when" must be a function(params)');
    const froms=from==='*'?null:Array.isArray(from)?from.slice():[from];
    this.transitions.push({from:froms,to,when,duration:Math.max(0,duration),exitTime:when||trigger||exitTime!=null?exitTime:1,ease:getEase(ease),priority,trigger,allowSelf,order:this.transitions.length});
    this.transitions.sort((p,q)=>q.priority-p.priority||p.order-q.order);return this;
  }
  set(name,value){this.params[name]=value;return this;}
  get(name){return this.params[name];}
  trigger(name){this.params[name]=true;return this;}
  get state(){return this.current?this.current.name:null;}
  get normalizedTime(){const c=this.current;return c?c.time/c.length:0;}
  get blending(){return !!this.fade;}
  weightOf(name){const s=this.states.get(name);return s?s.weight:0;}
  get weights(){const o={};for(const e of this.active)o[e.name]=e.weight;return o;}
  /* Force a state change (crossfade when duration > 0). */
  play(name,duration=0,ease='linear'){this._enter(name,duration,getEase(ease),null);return this;}
  _speed(st){const s=st.speed;return typeof s==='function'?s(this.params,this):typeof s==='string'?(+this.params[s]||0):s;}
  _enter(name,duration,ease,tr){
    const to=this.states.get(name);if(!to)throw new Error('Unknown animation state "'+name+'"');
    const from=this.current,fromName=from?from.name:null;
    if(from){if(from.onExit)from.onExit(fromName,name,this);if(this.onExit)this.onExit(fromName,name,this);}
    if(!this.active.includes(to)){to.time=0;to.weight=0;if(to.action){to.action.reset();to.action.setEffectiveWeight(0);to.action.play();}if(to.blend){to.blend.phase=0;to.blend.time=0;}this.active.push(to);}
    else if(to===from){to.time=0;if(to.action)to.action.reset().play();}
    for(const e of this.active)e.w0=e.weight;
    this.previous=from;this.current=to;this.fade=duration>0&&this.active.length>1?{duration,elapsed:0,ease:ease||easing.linear}:null;
    if(!this.fade)for(const e of this.active)e.weight=e===to?1:0;
    if(to.onEnter)to.onEnter(name,fromName,this);if(this.onEnter)this.onEnter(name,fromName,this);if(this.onTransition)this.onTransition(fromName,name,tr,this);
  }
  _find(){
    const cur=this.current;
    for(const tr of this.transitions){
      if(tr.from&&!tr.from.includes(cur.name))continue;if(tr.to===cur.name&&!tr.allowSelf)continue;
      if(tr.exitTime!=null&&cur.time<tr.exitTime*cur.length-1e-9)continue;if(tr.trigger&&!this.params[tr.trigger])continue;
      if(tr.when&&!tr.when(this.params,this))continue;return tr;}
    return null;
  }
  _paramValue(st,i){
    const p=st.param;if(typeof p==='function'){const v=p(this.params,st._out,this);return Array.isArray(v)?v[i]:i?st._out[1]:v;}
    if(Array.isArray(p))return +this.params[p[i]]||0;return p?+this.params[p]||0:0;
  }
  update(dt){
    dt=dt>0?dt:0;
    if(!this.current){const first=this._initial||this.states.keys().next().value;if(first===undefined)return this;this._enter(first,0,null,null);}
    const tr=this._find();if(tr){if(tr.trigger)this.params[tr.trigger]=false;this._enter(tr.to,tr.duration,tr.ease,tr);}
    if(this.fade){const f=this.fade,cur=this.current;f.elapsed+=dt;const a=clamp(f.ease(clamp(f.elapsed/f.duration,0,1)),0,1);
      for(const e of this.active)e.weight=e===cur?e.w0+(1-e.w0)*a:e.w0*(1-a);
      if(f.elapsed>=f.duration){this.fade=null;for(const e of this.active)e.weight=e===cur?1:0;}}
    for(let i=this.active.length-1;i>=0;i--){const e=this.active[i];if(e!==this.current&&e.weight<=1e-6){e.weight=0;
      if(e.action){e.action.setEffectiveWeight(0);e.action.stop();}if(e.blend){e.blend.weight=0;e.blend._apply(0);}if(e.pose)e.pose(0,dt,e.time,e);this.active.splice(i,1);}}
    if(this.blender)this.blender.reset();
    for(const e of this.active){
      const sp=this._speed(e),prev=e.time;e.time+=dt*sp;if(!e.loop&&e.time>e.length)e.time=e.length;
      if(e===this.current&&e.notifies.length&&e.time>prev){const L=e.length;
        for(const nt of e.notifies){const at=nt.t*L;if(e.loop){const c0=Math.floor((prev-at)/L),c1=Math.floor((e.time-at)/L);for(let c=c0;c<c1;c++)nt.fn(this,e.name);}else if(prev<at&&e.time>=at)nt.fn(this,e.name);}}
      if(e.action){e.action.enabled=true;e.action.setEffectiveWeight(e.weight);e.action.setEffectiveTimeScale(sp);}
      if(e.blend){e.blend.weight=e.weight;if(e.blend.isBlendSpace2D)e.blend.update(this._paramValue(e,0),this._paramValue(e,1),dt*sp);else e.blend.update(this._paramValue(e,0),dt*sp);}
      if(e.pose)e.pose(e.weight,dt,e.time,e);
      if(e.onUpdate)e.onUpdate(e.weight,dt,e.time,this);
    }
    if(this.mixer)this.mixer.update(dt);
    if(this.blender)this.blender.apply();
    return this;
  }
}

/* ---------- procedural locomotion ---------- */
/* Reactive stepping with gait groups. Each foot has a home point (its rest point under the moving root,
   projected onto heightAt). While moving, the next group in the cycle lifts once its feet have drifted a
   full stepLength from "home + lead" (lead = half a step along the velocity), so each paw sweeps about
   stepLength relative to the hips; the landing point is predicted from velocity and yaw rate. Swing
   duration shortens with speed (cadence rises). Idle: groups settle feet back under the hips. The body
   follows a least-squares plane through the home ground heights (pitch/roll), leans with acceleration,
   bobs with the swing and is lowered whenever a planted foot would be out of reach (pelvis adjust). */
class ProceduralGait{
  constructor(THREE,opts={}){
    const {body,legs,heightAt,root=body&&body.parent,stepLength=.45,stepHeight=.12,stepDuration=.18,bodyHeight=null,lean=.15,leanAccel=8,pelvisAdjust=true,
      forward=[0,0,-1],slopeAlign=.85,maxTilt=.6,bob=null,sway=null,breathe=.004,idleSpeed=.05,settleDistance=null,smoothing=10,footAlign=.7,toeCurl=.5,
      reach=.985,trigger=.95,legStretch=.12,onFootPlant=null,onFootLift=null,pivot=null}=opts;
    if(!body||!body.isObject3D)throw new TypeError('ProceduralGait needs a body Object3D');
    if(!root||!root.isObject3D||!isDescendant(body,root))throw new Error('ProceduralGait needs a root ancestor of the body (the object your game moves)');
    if(typeof heightAt!=='function')throw new TypeError('ProceduralGait needs heightAt(x,z)');
    if(!Array.isArray(legs)||!legs.length)throw new TypeError('ProceduralGait needs at least one leg');
    if(!(stepLength>0)||!(stepDuration>0)||!(stepHeight>=0))throw new RangeError('stepLength and stepDuration must be positive');
    Object.assign(this,{THREE,body,root,heightAt,stepLength,stepHeight,stepDuration,lean,leanAccel,pelvisAdjust,slopeAlign,maxTilt,breathe,idleSpeed,smoothing,footAlign,toeCurl,reach,trigger,legStretch,onFootPlant,onFootLift});
    this.bob=bob==null?stepHeight*.18:bob;this.sway=sway==null?stepLength*.03:sway;this.settleDistance=settleDistance==null?stepLength*.14:settleDistance;
    const V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion(),M=()=>new THREE.Matrix4();
    this.forward=toVec3(THREE,forward);this.forward.y=0;if(this.forward.lengthSq()<EPS)this.forward.set(0,0,-1);this.forward.normalize();
    this.pitchAxis=new THREE.Vector3().crossVectors(this.forward,new THREE.Vector3(0,1,0)).normalize();
    root.updateMatrixWorld(true);
    const rootInv=M().copy(root.matrixWorld).invert(),bodyInv=M().copy(body.matrixWorld).invert();
    this.bodyRootMat=M().multiplyMatrices(rootInv,body.matrixWorld);this.bodyRootPos=V();this.bodyRootQ=Q();this.bodyRootScale=V();
    this.bodyRootMat.decompose(this.bodyRootPos,this.bodyRootQ,this.bodyRootScale);
    const rootQ=Q(),tp=V(),ts=V();root.matrixWorld.decompose(tp,rootQ,ts);const rootQInv=rootQ.clone().invert();
    this.legs=legs.map((L,i)=>{
      if(!L||!L.hip||!L.foot||!L.hip.isObject3D||!L.foot.isObject3D)throw new TypeError('Leg '+i+' needs hip and foot Object3Ds');
      if(!isDescendant(L.foot,L.hip)||(L.knee&&(!isDescendant(L.knee,L.hip)||!isDescendant(L.foot,L.knee))))throw new Error('Leg '+i+' joints must be nested hip > knee > foot');
      if(!isDescendant(L.hip,body))throw new Error('Leg '+i+' hip must be a descendant of the body');
      const fw=V().setFromMatrixPosition(L.foot.matrixWorld),hw=V().setFromMatrixPosition(L.hip.matrixWorld),kw=L.knee?V().setFromMatrixPosition(L.knee.matrixWorld):null;
      const rest=L.rest?toVec3(THREE,L.rest):fw.clone().applyMatrix4(bodyInv),restRoot=rest.clone().applyMatrix4(this.bodyRootMat);
      const hipBody=hw.clone().applyMatrix4(bodyInv),kneeBody=kw?kw.clone().applyMatrix4(bodyInv):null,footBody=fw.clone().applyMatrix4(bodyInv);
      const len=kneeBody?hipBody.distanceTo(kneeBody)+kneeBody.distanceTo(footBody):hipBody.distanceTo(footBody);
      let pole=L.pole?toVec3(THREE,L.pole):null;
      if(!pole){const mid=hipBody.clone().add(footBody).multiplyScalar(.5),out=kneeBody?kneeBody.clone().sub(mid):V();out.y=0;
        if(out.lengthSq()<1e-8)out.copy(this.forward).applyQuaternion(this.bodyRootQ.clone().invert());out.normalize();pole=(kneeBody||mid).clone().addScaledVector(out,len);}
      const footQW=Q();L.foot.matrixWorld.decompose(tp,footQW,ts);
      const fh=V().copy(fw).applyMatrix4(M().copy(L.hip.matrixWorld).invert()),ax=Math.abs(fh.x)>Math.abs(fh.y)?(Math.abs(fh.x)>Math.abs(fh.z)?'x':'z'):(Math.abs(fh.y)>Math.abs(fh.z)?'y':'z');
      return {index:i,hip:L.hip,knee:L.knee||null,foot:L.foot,rest,restRoot,hipBody,len,pole,group:L.group==null?i%2:L.group|0,
        footOffset:L.footOffset==null?Math.max(0,restRoot.y):+L.footOffset,
        hipRestQ:L.hip.quaternion.clone(),kneeRestQ:L.knee?L.knee.quaternion.clone():null,footRestQ:L.foot.quaternion.clone(),hipRestScale:L.hip.scale.clone(),
        footRootQ:rootQInv.clone().multiply(footQW),stretchAxis:ax,
        planted:true,contact:V(),from:V(),to:V(),pos:V(),home:V(),swingT:0,swingDur:stepDuration,swingHeight:0,err:0,plantTime:0,liftTime:0,ground:0};
    });
    this.groupCount=Math.max(...this.legs.map(l=>l.group))+1;this.nextGroup=0;this.stepCount=0;this.history=[];
    this.pivot=pivot?toVec3(THREE,pivot):this.legs.reduce((a,l)=>a.add(l.hipBody),V()).divideScalar(this.legs.length);
    this.pivotRestRoot=this.pivot.clone().applyMatrix4(this.bodyRootMat);
    this.bodyHeight=bodyHeight==null?this.pivotRestRoot.y:bodyHeight;
    this.homeCenter=this.legs.reduce((a,l)=>a.add(l.restRoot),V()).divideScalar(this.legs.length);
    Object.assign(this,{pitch:0,roll:0,height:0,speed:0,yawRate:0,time:0,moveBlend:0,initialized:false,velocity:V(),accel:V(),lastRootPos:V(),lastYaw:0,_bob:0,_sway:0});
    this._s={rootPos:V(),rootQ:Q(),rootScale:V(),F:V(),R:V(),vel:V(),lead:V(),tmp:V(),tmp2:V(),ft:V(),pole:V(),hip:V(),n:V(),up:new THREE.Vector3(0,1,0),
      tilt:Q(),q1:Q(),q2:Q(),q3:Q(),pw:Q(),bq:Q(),bp:V(),piv:V(),m:M(),m2:M(),tp:V(),ts:V(),pa:V(),ra:V()};
  }
  get legCount(){return this.legs.length;}
  get planted(){return this.legs.every(l=>l.planted);}
  /* Snap all feet to their homes and the body to its target pose (call after teleporting the root). */
  reset(){this.initialized=false;return this;}
  _frame(){
    const s=this._s,root=this.root;root.updateWorldMatrix(true,false);root.matrixWorld.decompose(s.rootPos,s.rootQ,s.rootScale);
    const F=s.F.copy(this.forward).applyQuaternion(s.rootQ);F.y=0;if(F.lengthSq()<1e-10)F.set(0,0,-1);F.normalize();s.R.set(-F.z,0,F.x);
    return (Math.abs(s.rootScale.x)+Math.abs(s.rootScale.y)+Math.abs(s.rootScale.z))/3;
  }
  _homes(){for(const l of this.legs){l.home.copy(l.restRoot).applyMatrix4(this.root.matrixWorld);l.home.y=this.heightAt(l.home.x,l.home.z);}}
  /* Where the foot should land `ahead` seconds from now: home extrapolated by velocity and yaw rate, plus lead. */
  _predict(l,ahead,out){
    const s=this._s,a=this.yawRate*ahead,c=Math.cos(a),sn=Math.sin(a),rx=l.home.x-s.rootPos.x,rz=l.home.z-s.rootPos.z;
    out.set(s.rootPos.x+rx*c+rz*sn+s.vel.x*ahead+s.lead.x,0,s.rootPos.z-rx*sn+rz*c+s.vel.z*ahead+s.lead.z);out.y=this.heightAt(out.x,out.z);return out;
  }
  _snap(){
    for(const l of this.legs){l.contact.copy(l.home);l.pos.copy(l.home);l.to.copy(l.home);l.from.copy(l.home);l.planted=true;l.swingT=0;l.err=0;}
    this.initialized=true;this._snapBody=true;
  }
  update(dt,velocity=null){
    if(!(dt>0))return this;
    const s=this._s,rs=this._frame(),F=s.F;
    const yaw=Math.atan2(F.x,F.z);
    if(!this.initialized){this.lastRootPos.copy(s.rootPos);this.lastYaw=yaw;this.velocity.set(0,0,0);this.accel.set(0,0,0);this.yawRate=0;s.vel.set(0,0,0);s.lead.set(0,0,0);this._homes();this._snap();}
    if(s.rootPos.distanceTo(this.lastRootPos)>Math.max(2,this.stepLength*8)*rs){this.initialized=false;return this.update(dt,velocity);}
    if(velocity)s.vel.set(velocity.x,0,velocity.z);else s.vel.subVectors(s.rootPos,this.lastRootPos).divideScalar(dt).setY(0);
    s.tmp.subVectors(s.vel,this.velocity).divideScalar(dt);this.accel.lerp(s.tmp,1-Math.exp(-8*dt));this.velocity.copy(s.vel);
    this.yawRate=damp(this.yawRate,wrapAngle(yaw-this.lastYaw)/dt,14,dt);this.lastYaw=yaw;this.lastRootPos.copy(s.rootPos);
    this.time+=dt;const speed=this.speed=Math.hypot(s.vel.x,s.vel.z),L=this.stepLength*rs,vRef=L/(2*this.stepDuration);
    const moving=speed>this.idleSpeed*rs||Math.abs(this.yawRate)>.35;this.moveBlend=damp(this.moveBlend,moving?1:0,5,dt);
    const leadLen=speed>1e-6?L*.5*smooth01((speed-this.idleSpeed*rs)/(vRef*.35)):0;
    if(leadLen>0)s.lead.copy(s.vel).multiplyScalar(leadLen/speed);else s.lead.set(0,0,0);
    const swingDur=moving?this.stepDuration*clamp(Math.sqrt(vRef/Math.max(speed,1e-4)),.55,1):this.stepDuration*1.25;
    this._homes();
    // advance swings and land
    let swinging=false;
    for(const l of this.legs){
      if(l.planted){l.pos.copy(l.contact);continue;}
      l.swingT=Math.min(1,l.swingT+dt/l.swingDur);
      if(l.swingT<.85)this._predict(l,(1-l.swingT)*l.swingDur,l.to);
      if(l.swingT>=1){l.contact.copy(l.to);l.contact.y=this.heightAt(l.to.x,l.to.z);l.planted=true;l.plantTime=this.time;l.pos.copy(l.contact);if(this.onFootPlant)this.onFootPlant(l,l.index,l.contact,this);continue;}
      swinging=true;const t=l.swingT,e=.5-.5*Math.cos(Math.PI*t),arc=l.swingHeight*Math.sin(Math.PI*Math.pow(t,.8));
      l.pos.set(l.from.x+(l.to.x-l.from.x)*e,0,l.from.z+(l.to.z-l.from.z)*e);
      const g=this.heightAt(l.pos.x,l.pos.z);l.pos.y=Math.max(l.from.y+(l.to.y-l.from.y)*e+arc,g+arc*.6);
    }
    // step scheduling
    const gErr=this._gErr||(this._gErr=new Float64Array(this.groupCount));gErr.fill(0);
    for(const l of this.legs){s.tmp.copy(l.home).add(s.lead);l.err=l.planted?Math.hypot(l.contact.x-s.tmp.x,l.contact.z-s.tmp.z):0;if(l.err>gErr[l.group])gErr[l.group]=l.err;}
    if(!swinging){let g=-1;
      if(moving){if(gErr[this.nextGroup]>L*this.trigger)g=this.nextGroup;else for(let k=0;k<this.groupCount;k++)if(gErr[k]>L*1.8){g=k;break;}}
      else{let best=this.settleDistance*rs;for(let k=0;k<this.groupCount;k++){const kk=(this.nextGroup+k)%this.groupCount;if(gErr[kk]>best+1e-9){best=gErr[kk];g=kk;}}}
      if(g>=0)this._lift(g,moving,swingDur,L);}
    this._body(dt,rs,L,vRef);
    this._legs(rs);
    return this;
  }
  _lift(g,moving,swingDur,L){
    const minErr=moving?-1:this.settleDistance*.4;
    for(const l of this.legs){if(l.group!==g||!l.planted||l.err<=minErr)continue;
      l.planted=false;l.from.copy(l.contact);l.swingT=0;l.swingDur=swingDur;l.liftTime=this.time;this._predict(l,swingDur,l.to);
      const dist=Math.hypot(l.to.x-l.from.x,l.to.z-l.from.z);l.swingHeight=this.stepHeight*(L/this.stepLength)*clamp(dist/L,moving?.35:.25,1.25);
      if(this.onFootLift)this.onFootLift(l,l.index,l.from,this);}
    this.nextGroup=(g+1)%this.groupCount;this.stepCount++;this.history.push(g);if(this.history.length>64)this.history.shift();
  }
  _body(dt,rs,L,vRef){
    const s=this._s,F=s.F,R=s.R;
    // least-squares plane y = a*u + b*w + c through home ground heights (u along right, w along forward)
    let n=0,su=0,sw=0,sy=0,suu=0,sww=0,suw=0,suy=0,swy=0;
    for(const l of this.legs){const dx=l.home.x-s.rootPos.x,dz=l.home.z-s.rootPos.z,u=dx*R.x+dz*R.z,w=dx*F.x+dz*F.z,y=l.home.y;n++;su+=u;sw+=w;sy+=y;suu+=u*u;sww+=w*w;suw+=u*w;suy+=u*y;swy+=w*y;}
    const cu=suu-su*su/n,cw=sww-sw*sw/n,cuw=suw-su*sw/n,cuy=suy-su*sy/n,cwy=swy-sw*sy/n,det=cu*cw-cuw*cuw;
    let a=0,b=0;if(Math.abs(det)>1e-10*(cu*cw+1e-12)&&det>1e-12){a=(cuy*cw-cwy*cuw)/det;b=(cwy*cu-cuy*cuw)/det;}else if(cw>cu&&cw>1e-9)b=cwy/cw;else if(cu>1e-9)a=cuy/cu;
    const pitchT=clamp(Math.atan(b)*this.slopeAlign,-this.maxTilt,this.maxTilt),rollT=clamp(Math.atan(a)*this.slopeAlign,-this.maxTilt,this.maxTilt);
    const aF=this.accel.x*F.x+this.accel.z*F.z,aR=this.accel.x*R.x+this.accel.z*R.z,mb=this.moveBlend;
    const leanP=-this.lean*Math.tanh(aF/this.leanAccel)*mb,leanR=-this.lean*Math.tanh(aR/this.leanAccel)*mb;
    // swing bob (body dips at mid-swing, i.e. mid-stance of the supporting group) and lateral sway
    let bob=0,sway=0,cnt=0;for(const l of this.legs){if(l.planted)continue;const k=Math.sin(Math.PI*l.swingT);bob+=k;sway-=Math.sign(l.restRoot.x-this.homeCenter.x)*k;cnt++;}
    const amp=smooth01(this.speed/(vRef*.6));if(cnt){bob/=cnt;sway/=cnt;}
    this._bob=damp(this._bob,-bob*this.bob*rs*amp,30,dt);this._sway=damp(this._sway,sway*this.sway*amp,12,dt);
    // support height: average ground under the feet (swinging feet interpolate toward their landing height)
    let sup=0;for(const l of this.legs){if(l.planted)l.ground=l.contact.y;else{const e=smooth01(l.swingT);l.ground=l.from.y+(l.to.y-l.from.y)*e;}sup+=l.ground;}sup/=this.legs.length;
    const breath=this.breathe*rs*Math.sin(this.time*Math.PI*2*.3)*(1-mb);
    let target=sup+this.bodyHeight*rs+this._bob+breath;
    const snap=this._snapBody;this._snapBody=false;
    if(snap){this.pitch=pitchT;this.roll=rollT;this.height=target;}
    else{this.pitch=damp(this.pitch,pitchT+leanP,this.smoothing,dt);this.roll=damp(this.roll,rollT+leanR,this.smoothing,dt);this.height=damp(this.height,target,this.smoothing*1.6,dt);}
    const tilt=s.tilt.setFromAxisAngle(this.pitchAxis,this.pitch).multiply(s.q1.setFromAxisAngle(this.forward,-this.roll));
    // pelvis adjust: lower the pivot until every planted (or landing) foot is within reach
    const pivR=this.pivotRestRoot;
    if(this.pelvisAdjust){let limit=Infinity;
      for(const l of this.legs){if(!l.planted&&l.swingT<.7)continue;
        const hr=s.hip.subVectors(l.hipBody,this.pivot).multiply(this.bodyRootScale).applyQuaternion(this.bodyRootQ).applyQuaternion(tilt);// hip offset from pivot, root space
        const off=hr.y*rs;hr.add(pivR).applyMatrix4(this.root.matrixWorld);// approx world hip (height corrected below)
        const fx=l.planted?l.contact.x:l.to.x,fz=l.planted?l.contact.z:l.to.z,fy=(l.planted?l.contact.y:l.to.y)+l.footOffset*rs;
        const hd2=(hr.x-fx)**2+(hr.z-fz)**2,reach=l.len*rs*this.reach*Math.max(this.bodyRootScale.x,1e-6),lim=fy+Math.sqrt(Math.max(0,reach*reach-hd2))-off;
        if(lim<limit)limit=lim;}
      if(this.height>limit)this.height=limit;}
    // compose body transform in root space: rotate about the pivot, then place the pivot at the target height
    const dyRoot=(this.height-(s.rootPos.y+pivR.y*rs))/rs;
    const bq=s.bq.copy(tilt).multiply(this.bodyRootQ),piv=s.piv.copy(pivR);piv.y+=dyRoot;piv.addScaledVector(this.pitchAxis,this._sway);
    const bp=s.bp.copy(this.pivot).multiply(this.bodyRootScale).applyQuaternion(bq);bp.subVectors(piv,bp);
    const body=this.body;
    if(body.parent===this.root){body.position.copy(bp);body.quaternion.copy(bq);}
    else{s.m.compose(bp,bq,this.bodyRootScale).premultiply(this.root.matrixWorld);s.m2.copy(body.parent.matrixWorld).invert().multiply(s.m);s.m2.decompose(body.position,body.quaternion,body.scale);}
    body.updateMatrixWorld(true);
  }
  _legs(rs){
    const s=this._s,T=this.THREE,R=s.R;
    for(const l of this.legs){
      const ft=s.ft.copy(l.planted?l.contact:l.pos);ft.y+=l.footOffset*rs;
      if(l.knee){l.hip.quaternion.copy(l.hipRestQ);l.knee.quaternion.copy(l.kneeRestQ);s.pole.copy(l.pole).applyMatrix4(this.body.matrixWorld);twoBone(T,l.hip,l.knee,l.foot,ft,s.pole);}
      else{const hip=l.hip;hip.quaternion.copy(l.hipRestQ);hip.scale.copy(l.hipRestScale);l.foot.updateWorldMatrix(true,false);
        const hw=s.hip.setFromMatrixPosition(hip.matrixWorld),u=s.tmp.setFromMatrixPosition(l.foot.matrixWorld).sub(hw),w=s.tmp2.subVectors(ft,hw),lu=u.length(),lw=w.length();
        if(lu>EPS&&lw>EPS){parentQuat(hip,s.pw,s.tp,s.ts);worldQuat(hip,s.q2,s.tp,s.ts);s.q2.premultiply(s.q3.setFromUnitVectors(u.divideScalar(lu),w.divideScalar(lw)));
          hip.quaternion.copy(s.pw).invert().multiply(s.q2);if(this.legStretch>0)hip.scale[l.stretchAxis]=l.hipRestScale[l.stretchAxis]*clamp(lw/lu,1-this.legStretch,1+this.legStretch);}
        hip.updateMatrixWorld(true);}
      // foot orientation: keep the paw's rest heading, align it to the ground normal, curl it during the swing
      if(this.footAlign>0||this.toeCurl>0){const e=.04*rs,x=ft.x,z=ft.z,h=this.heightAt;
        const nrm=s.n.set(h(x-e,z)-h(x+e,z),2*e,h(x,z-e)-h(x,z+e)).normalize(),align=l.planted?this.footAlign:this.footAlign*(1-Math.sin(Math.PI*l.swingT));
        s.q1.setFromUnitVectors(s.up,nrm);s.q2.identity().slerp(s.q1,align);
        const curl=l.planted?0:-this.toeCurl*Math.sin(Math.PI*Math.min(1,l.swingT*1.15));s.ra.copy(R);
        s.q3.setFromAxisAngle(s.ra,curl).multiply(s.q2).multiply(s.rootQ).multiply(l.footRootQ);
        parentQuat(l.foot,s.pw,s.tp,s.ts);l.foot.quaternion.copy(s.pw).invert().multiply(s.q3);l.foot.updateMatrixWorld(true);}
    }
  }
  dispose(){}
}

/* ---------- sequencer (cinematics) ---------- */
const INTERP={linear:0,cubic:1,step:2};const INTERP_NAMES=['linear','cubic','step'];
class SequencerTrack{
  constructor(spec){
    const {target,path,keys,name=null,interp='linear',ease=null,enabled=true}=spec||{};
    if(!target)throw new TypeError('Sequencer track needs a target');if(!Array.isArray(keys)||!keys.length)throw new TypeError('Sequencer track needs keys');
    const {obj,key}=resolvePath(target,path),cur=obj[key],kind=kindOf(cur);if(!kind)throw new TypeError('Cannot animate property "'+path+'" of this type');
    const size=sizeOf(kind,cur),sorted=keys.map((k,i)=>({k,i})).sort((p,q)=>p.k.t-q.k.t||p.i-q.i).map(o=>o.k),n=sorted.length;
    Object.assign(this,{target,path,obj,key,kind,size,name,enabled});
    this.times=new Float64Array(n);this.values=new Float64Array(n*size);this.modes=new Uint8Array(n);this.eases=new Array(n);this.easeNames=new Array(n);
    sorted.forEach((k,i)=>{if(!Number.isFinite(k.t)||k.t<0)throw new RangeError('Key times must be finite and non-negative');this.times[i]=k.t;
      parseValue(kind,k.value,this.values,i*size,size,kind==='number'?(typeof cur==='number'?cur:0):cur);
      const m=INTERP[k.interp||interp];if(m===undefined)throw new RangeError('Unknown interpolation "'+(k.interp||interp)+'"');this.modes[i]=kind==='boolean'?2:m;
      const e=k.ease||ease;this.eases[i]=e?getEase(e):null;this.easeNames[i]=easeName(e);});
    if(kind==='quaternion')for(let i=1;i<n;i++){const a=(i-1)*4,b=i*4,V=this.values;if(V[a]*V[b]+V[a+1]*V[b+1]+V[a+2]*V[b+2]+V[a+3]*V[b+3]<0)for(let c=0;c<4;c++)V[b+c]=-V[b+c];}
    // Catmull-Rom style finite-difference tangents for non-uniform key times
    this.tangents=new Float64Array(n*size);
    for(let i=0;i<n;i++){const i0=Math.max(0,i-1),i1=Math.min(n-1,i+1),dt=this.times[i1]-this.times[i0];for(let c=0;c<size;c++)this.tangents[i*size+c]=dt>0?(this.values[i1*size+c]-this.values[i0*size+c])/dt:0;}
    this.out=new Float64Array(size);this._cursor=0;
    if(kind==='number')prepareMaterial(obj,key,Array.from(this.values));
  }
  get start(){return this.times[0];}
  get end(){return this.times[this.times.length-1];}
  /* Evaluate at time t into this.out and write the property. Key i's interp/ease control segment i -> i+1. */
  evaluate(t){
    const T=this.times,n=T.length,S=this.size,V=this.values,out=this.out;
    if(n===1||t<=T[0]){for(let c=0;c<S;c++)out[c]=V[c];}
    else if(t>=T[n-1]){const o=(n-1)*S;for(let c=0;c<S;c++)out[c]=V[o+c];}
    else{let i=this._cursor;if(i>=n-1||T[i]>t||T[i+1]<=t){let lo=0,hi=n-1;while(hi-lo>1){const m=(lo+hi)>>1;if(T[m]<=t)lo=m;else hi=m;}i=lo;}this._cursor=i;
      const h=T[i+1]-T[i],mode=this.modes[i];let u=h>0?(t-T[i])/h:1;const a=i*S,b=a+S;
      if(mode===2){for(let c=0;c<S;c++)out[c]=V[a+c];}
      else{if(this.eases[i])u=this.eases[i](u);
        if(mode===1){const u2=u*u,u3=u2*u,h00=2*u3-3*u2+1,h10=u3-2*u2+u,h01=-2*u3+3*u2,h11=u3-u2,M=this.tangents;
          for(let c=0;c<S;c++)out[c]=h00*V[a+c]+h10*h*M[a+c]+h01*V[b+c]+h11*h*M[b+c];
          if(this.kind==='quaternion'){const l=Math.hypot(out[0],out[1],out[2],out[3])||1;for(let c=0;c<4;c++)out[c]/=l;}}
        else if(this.kind==='quaternion')slerpFlat(out,0,V,a,V,b,u);
        else for(let c=0;c<S;c++)out[c]=V[a+c]+(V[b+c]-V[a+c])*u;}}
    writeValue(this.kind,this.obj,this.key,out,0,S);return out;
  }
  toJSON(idOf){
    const S=this.size,keys=[];for(let i=0;i<this.times.length;i++){const v=S===1?(this.kind==='boolean'?this.values[i]>=.5:this.values[i]):Array.from(this.values.subarray(i*S,i*S+S));
      const k={t:this.times[i],value:v};if(this.modes[i])k.interp=INTERP_NAMES[this.modes[i]];if(this.easeNames[i])k.ease=this.easeNames[i];keys.push(k);}
    const j={target:idOf(this.target),path:this.path,keys};if(this.name)j.name=this.name;return j;
  }
}
class Sequencer{
  constructor(THREE,opts={}){
    const {loop=false,speed=1,duration=null,reverseEvents=false}=opts;
    Object.assign(this,{THREE,loop,speed,reverseEvents});this._duration=duration;
    this.tracks=[];this.cuts=[];this.events=[];this.time=0;this.playing=false;this._last=0;this.camera=null;
    this.onFinish=null;this.onCameraCut=null;this.onUpdate=null;
  }
  get duration(){if(this._duration!=null)return this._duration;let d=0;for(const t of this.tracks)d=Math.max(d,t.end);for(const c of this.cuts)d=Math.max(d,c.t);for(const e of this.events)d=Math.max(d,e.t);return d;}
  set duration(v){this._duration=v==null?null:Math.max(0,+v);}
  addTrack(spec){const t=spec instanceof SequencerTrack?spec:new SequencerTrack(spec);this.tracks.push(t);return t;}
  removeTrack(t){const i=this.tracks.indexOf(t);if(i>=0)this.tracks.splice(i,1);return this;}
  addCameraCut({t,camera}){if(!Number.isFinite(t)||t<0||!camera||!camera.isCamera)throw new TypeError('Camera cut needs {t, camera}');this.cuts.push({t,camera});this.cuts.sort((a,b)=>a.t-b.t);return this;}
  addEvent({t,fn,name=null}){if(!Number.isFinite(t)||t<0||typeof fn!=='function')throw new TypeError('Event needs {t, fn}');this.events.push({t,fn,name});this.events.sort((a,b)=>a.t-b.t);return this;}
  play(){if(!this.loop&&this.time>=this.duration&&this.duration>0)this.seek(0);if(this.time<=0)this._last=-1;this.playing=true;return this;}
  pause(){this.playing=false;return this;}
  stop(){this.playing=false;return this.seek(0);}
  _fire(a,b){for(const e of this.events)if(e.t>a&&e.t<=b)e.fn(this,e);}
  _fireReverse(a,b){for(let i=this.events.length-1;i>=0;i--){const e=this.events[i];if(e.t>=b&&e.t<a)e.fn(this,e);}}
  /* Jump without firing events (unless fireEvents and moving forward). */
  seek(t,{fireEvents=false}={}){const D=this.duration;t=clamp(+t||0,0,D);if(fireEvents&&t>this.time)this._fire(this._last,t);this.time=t;this._last=t;this._evaluate();return this;}
  update(dt){
    if(!this.playing||!(dt>0))return this;
    const D=this.duration;let t=this.time+dt*this.speed,finished=false;
    if(this.speed>=0){
      if(t>=D){if(this.loop&&D>0){this._fire(this._last,D);t%=D;this._last=-1;}else{t=D;finished=true;}}
      this._fire(this._last,t);
    }else{
      if(t<=0){if(this.loop&&D>0){if(this.reverseEvents)this._fireReverse(this._last,0);t=D+(t%D);this._last=D+1e-9;}else{t=0;finished=true;}}
      if(this.reverseEvents)this._fireReverse(this._last,t);
    }
    this.time=t;this._last=t;this._evaluate();
    if(finished){this.playing=false;if(this.onFinish)this.onFinish(this);}
    return this;
  }
  _evaluate(){
    const t=this.time;for(const tr of this.tracks)if(tr.enabled)tr.evaluate(t);
    let cam=null;for(const c of this.cuts){if(c.t<=t)cam=c.camera;else break;}
    if(cam!==this.camera){const prev=this.camera;this.camera=cam;if(this.onCameraCut)this.onCameraCut(cam,prev,this);}
    if(this.onUpdate)this.onUpdate(t,this);
  }
  /* Tracks/cuts/events as JSON. Targets and cameras are referenced by name (or uuid when unnamed). */
  toJSON(){
    const idOf=o=>o&&(o.name||o.uuid);
    return {version:1,duration:this._duration,loop:this.loop,speed:this.speed,tracks:this.tracks.map(t=>t.toJSON(idOf)),cuts:this.cuts.map(c=>({t:c.t,camera:idOf(c.camera)})),events:this.events.filter(e=>e.name).map(e=>({t:e.t,name:e.name}))};
  }
  /* resolve: an Object3D to search by name/uuid, or a function(id) -> target. handlers: {eventName: fn}. */
  fromJSON(json,resolve,handlers={}){
    if(!json||!Array.isArray(json.tracks))throw new TypeError('Invalid sequencer JSON');
    const find=typeof resolve==='function'?resolve:id=>{let hit=null;resolve.traverse(o=>{if(!hit&&(o.name===id||o.uuid===id))hit=o;});return hit;};
    const lookup=id=>{const o=find(id);if(!o)throw new Error('Sequencer target "'+id+'" not found');return o;};
    this.tracks=[];this.cuts=[];this.events=[];
    for(const t of json.tracks)this.addTrack({target:lookup(t.target),path:t.path,keys:t.keys,name:t.name||null});
    for(const c of json.cuts||[])this.addCameraCut({t:c.t,camera:lookup(c.camera)});
    for(const e of json.events||[]){const fn=handlers[e.name];if(typeof fn==='function')this.addEvent({t:e.t,fn,name:e.name});}
    if(json.duration!=null)this._duration=json.duration;if(typeof json.loop==='boolean')this.loop=json.loop;if(Number.isFinite(json.speed))this.speed=json.speed;
    this.time=0;this._last=0;this.camera=null;return this;
  }
  static fromJSON(THREE,json,resolve,handlers){return new Sequencer(THREE).fromJSON(json,resolve,handlers);}
}

/* ---------- camera rail ---------- */
class CameraRail{
  constructor(THREE,points,opts={}){
    if(!Array.isArray(points)||points.length<2)throw new TypeError('CameraRail needs at least two points');
    const {closed=false,tension=.5,curveType='centripetal',lookAt=null,lookAhead=.02,up=[0,1,0],roll=0,divisions=null}=opts;
    this.THREE=THREE;this.curve=new THREE.CatmullRomCurve3(points.map(p=>toVec3(THREE,p)),closed,curveType,tension);
    this.curve.arcLengthDivisions=divisions||Math.max(200,points.length*60);this.curve.updateArcLengths();
    Object.assign(this,{closed,lookAt,lookAhead,roll});this.up=toVec3(THREE,up).normalize();
    this._p=new THREE.Vector3();this._q=new THREE.Vector3();this._t=new THREE.Vector3();this._look=new THREE.Vector3();
  }
  get length(){return this.curve.getLength();}
  _u(t){if(this.closed){t%=1;if(t<0)t+=1;return t;}return clamp(t,0,1);}
  getPoint(t,out=new this.THREE.Vector3()){return this.curve.getPointAt(this._u(t),out);}
  getTangent(t,out=new this.THREE.Vector3()){return this.curve.getTangentAt(this._u(t),out);}
  /* Look target: fixed point/object, or the rail point lookAhead further on (tangent at the open end). */
  getLookTarget(t,out=new this.THREE.Vector3()){
    const L=this.lookAt;if(L){if(L.isObject3D){L.updateWorldMatrix(true,false);return out.setFromMatrixPosition(L.matrixWorld);}return out.copy(L);}
    const u=this._u(t),p=this.curve.getPointAt(u,this._q);let u2=u+this.lookAhead;
    if(this.closed)u2%=1;else if(u2>1)u2=1;
    this.curve.getPointAt(u2,out);if(out.distanceToSquared(p)<1e-10){this.curve.getTangentAt(u,this._t);out.copy(p).add(this._t);}return out;
  }
  apply(camera,t){
    const p=this.getPoint(t,this._p),look=this.getLookTarget(t,this._look);camera.position.copy(p);
    camera.up.copy(this.up);if(look.distanceToSquared(p)>1e-12)camera.lookAt(look);
    const r=typeof this.roll==='function'?this.roll(this._u(t)):this.roll;if(r)camera.rotateZ(r);
    camera.updateMatrixWorld();return camera;
  }
  createHelper(divisions=200,color=0xffcc66){const T=this.THREE,g=new T.BufferGeometry().setFromPoints(this.curve.getSpacedPoints(divisions));return new T.Line(g,new T.LineBasicMaterial({color}));}
  dispose(){}
}

/* ---------- camera shake ---------- */
/* Trauma model: shake = trauma^exponent drives seeded 1D gradient (Perlin) noise per channel. The offset
   from the previous frame is removed first unless something else already rewrote the camera transform. */
class Perlin1D{
  constructor(seed=1){const r=KE.random(seed);this.g=new Float32Array(256);this.p=new Uint8Array(512);const perm=[];for(let i=0;i<256;i++){this.g[i]=r()*2-1;perm.push(i);}
    for(let i=255;i>0;i--){const j=Math.floor(r()*(i+1));[perm[i],perm[j]]=[perm[j],perm[i]];}for(let i=0;i<512;i++)this.p[i]=perm[i&255];}
  noise(x){const i=Math.floor(x),f=x-i,a=i&255,g0=this.g[this.p[a]],g1=this.g[this.p[a+1]],u=f*f*f*(f*(f*6-15)+10);return 2*(g0*f+u*(g1*(f-1)-g0*f));}
}
class CameraShake{
  constructor(THREE,opts={}){
    const {maxYaw=.06,maxPitch=.06,maxRoll=.09,maxOffset=[.12,.12,.06],frequency=16,decay=1.1,exponent=2,seed=7,octaves=2}=opts;
    Object.assign(this,{THREE,maxYaw,maxPitch,maxRoll,frequency,decay,exponent,octaves});this.maxOffset=toVec3(THREE,maxOffset);
    this.trauma=0;this.time=0;this.noise=[0,1,2,3,4,5].map(i=>new Perlin1D(seed*31+i*1013));
    const V=()=>new THREE.Vector3(),Q=()=>new THREE.Quaternion();this._off=V();this._rot=Q();this._pos=V();this._q=Q();this._applied=false;this._e=new THREE.Euler();this._tmp=V();
  }
  get shake(){return Math.pow(this.trauma,this.exponent);}
  add(amount){this.trauma=clamp(this.trauma+(+amount||0),0,1);return this;}
  set(amount){this.trauma=clamp(+amount||0,0,1);return this;}
  _n(i){let s=0,a=1,f=1,norm=0;for(let o=0;o<this.octaves;o++){s+=a*this.noise[i].noise(this.time*this.frequency*f+o*17.3);norm+=a;a*=.5;f*=2.1;}return s/norm;}
  /* Remove the offset applied last frame (only if the camera was not moved since). */
  restore(camera){if(!this._applied)return this;this._applied=false;
    if(camera.position.distanceToSquared(this._pos)<1e-12&&Math.abs(camera.quaternion.dot(this._q))>1-1e-10){camera.position.sub(this._off);camera.quaternion.multiply(this._tmpInv||(this._tmpInv=new this.THREE.Quaternion()).copy(this._rot).invert());}
    return this;}
  update(dt,camera){
    this.restore(camera);this.time+=Math.max(0,dt);this.trauma=Math.max(0,this.trauma-this.decay*Math.max(0,dt));
    const k=this.shake;if(k<=1e-5||!camera)return this;
    this._e.set(this.maxPitch*k*this._n(0),this.maxYaw*k*this._n(1),this.maxRoll*k*this._n(2),'YXZ');this._rot.setFromEuler(this._e);
    this._off.set(this.maxOffset.x*k*this._n(3),this.maxOffset.y*k*this._n(4),this.maxOffset.z*k*this._n(5)).applyQuaternion(camera.quaternion);
    camera.quaternion.multiply(this._rot);camera.position.add(this._off);camera.updateMatrixWorld();
    this._pos.copy(camera.position);this._q.copy(camera.quaternion);this._applied=true;return this;
  }
}

/* ---------- root motion ---------- */
/* Extracts the horizontal (by default) translation of a root position track so the character controller
   can move the actor while the clip plays in place. update(action,out) returns the displacement since
   the previous call in the clip's local space, including loop wrap-around. */
class RootMotion{
  constructor(THREE,clip,opts={}){
    const {track=null,axes='xz',inPlace=true}=opts;
    const tr=track?clip.tracks.find(t=>t.name===track):clip.tracks.find(t=>/\.position$/.test(t.name));
    if(!tr||tr.getValueSize()!==3)throw new Error('RootMotion needs a 3-component position track'+(track?' named '+track:''));
    this.THREE=THREE;this.clip=clip;this.track=tr;this.times=Float64Array.from(tr.times);this.values=Float64Array.from(tr.values);
    this.mask=[axes.includes('x'),axes.includes('y'),axes.includes('z')];const n=this.times.length;
    this.start=new THREE.Vector3(this.values[0],this.values[1],this.values[2]);this.end=new THREE.Vector3(this.values[(n-1)*3],this.values[(n-1)*3+1],this.values[(n-1)*3+2]);
    this.loopDelta=this.end.clone().sub(this.start);for(let a=0;a<3;a++)if(!this.mask[a])this.loopDelta.setComponent(a,0);
    if(inPlace)for(let i=0;i<n;i++)for(let a=0;a<3;a++)if(this.mask[a])tr.values[i*3+a]=this.values[a];
    this._last=null;this._a=new THREE.Vector3();this._b=new THREE.Vector3();
  }
  sample(time,out){
    const T=this.times,V=this.values,n=T.length;time=clamp(time,T[0],T[n-1]);let lo=0,hi=n-1;while(hi-lo>1){const m=(lo+hi)>>1;if(T[m]<=time)lo=m;else hi=m;}
    const f=T[hi]>T[lo]?(time-T[lo])/(T[hi]-T[lo]):0;out.set(V[lo*3]+(V[hi*3]-V[lo*3])*f,V[lo*3+1]+(V[hi*3+1]-V[lo*3+1])*f,V[lo*3+2]+(V[hi*3+2]-V[lo*3+2])*f);
    for(let a=0;a<3;a++)if(!this.mask[a])out.setComponent(a,0);return out;
  }
  reset(action=null){this._last=action?action.time:null;return this;}
  update(action,out){
    const t=action.time;out.set(0,0,0);if(this._last===null){this._last=t;return out;}
    const a=this.sample(this._last,this._a),b=this.sample(t,this._b);out.subVectors(b,a);
    const forward=action.timeScale>=0;if(forward&&t<this._last-1e-9)out.add(this.loopDelta);else if(!forward&&t>this._last+1e-9)out.sub(this.loopDelta);
    this._last=t;return out;
  }
}

/* ---------- exports ---------- */
const tweens=new TweenManager();
Object.assign(KE,{easing,Tween,TweenManager,tweens,tween:(target,props,opts)=>new Tween(target,props,opts),
  IK:{twoBone,swingTwist},IKChain,LookAt,SpringChain,PoseBlender,AnimStateMachine,BlendSpace1D,BlendSpace2D,ProceduralGait,
  Sequencer,SequencerTrack,CameraRail,CameraShake,RootMotion,createBoneChain,buildSkinnedTube,
  animation:{resolvePath,delaunay}});
KE.registerModule('animation',{provides:['easing','tween','tweens','IK','IKChain','LookAt','SpringChain','PoseBlender','AnimStateMachine','BlendSpace1D','BlendSpace2D',
  'ProceduralGait','Sequencer','CameraRail','CameraShake','RootMotion','createBoneChain','buildSkinnedTube']});
})();
