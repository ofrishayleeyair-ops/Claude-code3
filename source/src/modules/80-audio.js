/* kitsune enginev3 audio: KE.AudioEngine, KE.Synth, KE.SoundCue.
   A Web Audio mixer inspired by UE5's audio stack (submix buses, sound cues, MetaSounds-style procedural
   patches): spatial voices with HRTF panning that follow a camera/objects, a bus tree with sidechain-like
   ducking, procedural convolution reverb with listener-position-blended zones, occlusion filtering, voice
   limiting with priority stealing and loop virtualization, an offline procedural one-shot library rendered
   with OfflineAudioContext, live generative ambience beds and a generative music sequencer.
   Nothing is loaded from files: every sound comes from oscillators, seeded noise, filters and envelopes. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=KE.clamp;

/* ============================================================ helpers ============================================================ */
const LOOKAHEAD=.6;            // seconds of events the schedulers keep queued ahead of the audio clock
const NOISE_SECONDS=4;         // length of shared, seamlessly looping noise buffers
const NOISE_VARIANTS=2;
/* Quality tiers (keyed by KE.settings.preset). hrtf=false switches spatial voices to the cheap equal-power
   panner; irSeconds caps impulse-response length (convolution cost is proportional to it). */
const QUALITY={
  low:      {maxVoices:24,hrtf:false,irSeconds:1.6,reverbSlots:2,occlusionChecks:2, musicNotes:24},
  medium:   {maxVoices:32,hrtf:true, irSeconds:2.5,reverbSlots:2,occlusionChecks:4, musicNotes:40},
  high:     {maxVoices:48,hrtf:true, irSeconds:3.5,reverbSlots:3,occlusionChecks:8, musicNotes:64},
  ultra:    {maxVoices:64,hrtf:true, irSeconds:5,  reverbSlots:3,occlusionChecks:12,musicNotes:96},
  cinematic:{maxVoices:64,hrtf:true, irSeconds:6,  reverbSlots:3,occlusionChecks:16,musicNotes:128}
};
const quality=()=>QUALITY[KE.settings&&KE.settings.preset]||QUALITY.high;
const ACtor=()=>typeof window!=='undefined'&&(window.AudioContext||window.webkitAudioContext)||null;
const OACtor=()=>typeof window!=='undefined'&&(window.OfflineAudioContext||window.webkitOfflineAudioContext)||null;
const isOffline=ctx=>!!ctx&&typeof ctx.startRendering==='function';
const isBuffer=b=>!!b&&typeof b.getChannelData==='function'&&typeof b.numberOfChannels==='number';
const lerp=(a,b,t)=>a+(b-a)*t;
const smooth01=x=>x<=0?0:x>=1?1:x*x*(3-2*x);
const nowSec=()=>(typeof performance!=='undefined'?performance.now():Date.now())/1000;
function hashStr(s){let h=2166136261>>>0;s=String(s);for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return h;}
function stableKey(o){return Object.keys(o).sort().map(k=>k+'='+(typeof o[k]==='number'?+o[k].toFixed(5):String(o[k]))).join('&');}
/* Cancel automation after t and hold the value the param has at t. An explicit event is always written at t:
   a linear ramp with no preceding event would otherwise start from time 0 and jump (Chrome). */
function holdAt(p,t){const v=p.value;if(p.cancelAndHoldAtTime){try{p.cancelAndHoldAtTime(t);}catch(e){p.cancelScheduledValues(t);}}else p.cancelScheduledValues(t);p.setValueAtTime(v,t);}
/* Click-free linear move from the current value to v. */
function rampTo(p,v,t,dur){holdAt(p,t);if(dur>1e-4)p.linearRampToValueAtTime(v,t+dur);else p.setValueAtTime(v,t);}
function disconnect(n){if(n){try{n.disconnect();}catch(e){}}}
/* Per-frame parameter writes: snap (first write, or the audio clock is not running so events would pile up at
   one frozen time), otherwise glide with a first-order time constant. */
function glide(p,v,t,tau,snap){if(snap){p.cancelScheduledValues(t);p.value=v;}else p.setTargetAtTime(v,t,tau);}
function setP(p,v,t,snap){glide(p,v,t,SMOOTH_POS,snap);}
function makeBuffer(ctx,channels,length,sampleRate){
  if(ctx&&ctx.createBuffer)return ctx.createBuffer(channels,length,sampleRate);
  return new AudioBuffer({numberOfChannels:channels,length,sampleRate});
}
function putChannel(buf,data,c){if(buf.copyToChannel)buf.copyToChannel(data,c);else buf.getChannelData(c).set(data);}

/* ---------- notes, scales ---------- */
const NOTE_PC={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
function noteToMidi(n){
  if(typeof n==='number')return n;
  const m=/^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(n).trim());
  if(!m)throw new RangeError('Invalid note name: '+n);
  return 12*(+m[3]+1)+NOTE_PC[m[1].toUpperCase()]+(m[2]==='#'?1:m[2]==='b'?-1:0);
}
const midiToHz=m=>440*Math.pow(2,(m-69)/12);
/* Numbers are frequencies in Hz, strings are note names such as 'C5' or 'F#3'. */
const noteToHz=n=>typeof n==='number'?clamp(n,20,20000):midiToHz(noteToMidi(n));
const keyToPc=k=>{if(typeof k==='number')return ((k%12)+12)%12;const m=/^([A-Ga-g])([#b]?)$/.exec(String(k).trim());if(!m)throw new RangeError('Invalid key: '+k);return (NOTE_PC[m[1].toUpperCase()]+(m[2]==='#'?1:m[2]==='b'?-1:0)+12)%12;};
const SCALES={major:[0,2,4,5,7,9,11],minor:[0,2,3,5,7,8,10],dorian:[0,2,3,5,7,9,10],pentatonic:[0,2,4,7,9],minorPentatonic:[0,3,5,7,10],
  lydian:[0,2,4,6,7,9,11],mixolydian:[0,2,4,5,7,9,10],phrygian:[0,1,3,5,7,8,10],harmonicMinor:[0,2,3,5,7,8,11]};

/* ---------- seeded noise and texture buffers ---------- */
/* White, pink (Paul Kellet's filter) or brown (leaky integrator) noise with the mean removed, RMS normalised
   to .25 and the tail equal-power crossfaded into the head so the buffer loops without a seam. */
function noiseData(kind,n,rand){
  const extra=Math.min(n>>2,4096),d=new Float32Array(n+extra);
  if(kind==='pink'){let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for(let i=0;i<d.length;i++){const w=rand()*2-1;b0=.99886*b0+w*.0555179;b1=.99332*b1+w*.0750759;b2=.969*b2+w*.153852;b3=.8665*b3+w*.3104856;b4=.55*b4+w*.5329522;b5=-.7616*b5-w*.016898;d[i]=b0+b1+b2+b3+b4+b5+b6+w*.5362;b6=w*.115926;}}
  else if(kind==='brown'){let x=0;for(let i=0;i<d.length;i++){x=(x+.02*(rand()*2-1))/1.02;d[i]=x;}}
  else for(let i=0;i<d.length;i++)d[i]=rand()*2-1;
  let mean=0;for(let i=0;i<d.length;i++)mean+=d[i];mean/=d.length;
  for(let i=0;i<extra;i++){const a=i/extra*Math.PI/2;d[i]=(d[i]-mean)*Math.sin(a)+(d[n+i]-mean)*Math.cos(a);}
  for(let i=extra;i<n;i++)d[i]-=mean;
  const out=d.slice(0,n);let e=0;for(let i=0;i<n;i++)e+=out[i]*out[i];const s=.25/Math.sqrt(e/n||1);for(let i=0;i<n;i++)out[i]*=s;
  return out;
}
const noiseCache=new Map();
/* Stereo (decorrelated channels) noise, shared per sample rate. AudioBuffers are context independent. */
function noiseBuffer(ctx,kind,variant=0){
  const sr=ctx.sampleRate,key=kind+'|'+sr+'|'+variant;let b=noiseCache.get(key);if(b)return b;
  const n=Math.round(NOISE_SECONDS*sr);b=makeBuffer(ctx,2,n,sr);
  for(let c=0;c<2;c++)putChannel(b,noiseData(kind,n,KE.random(hashStr(key)+c*7919)),c);
  noiseCache.set(key,b);return b;
}
const textureCache=new Map();
/* Pre-computed looping texture (rain drops, crackles, bubbles, modulation signals). fill(L,R,sr,rand,n). */
function texture(ctx,name,seconds,variant,fill,channels=2){
  const sr=ctx.sampleRate,key=name+'|'+sr+'|'+variant;let b=textureCache.get(key);if(b)return b;
  const n=Math.round(seconds*sr),ch=[];for(let c=0;c<channels;c++)ch.push(new Float32Array(n));
  fill(ch[0],ch[1]||ch[0],sr,KE.random(hashStr(key)),n);
  b=makeBuffer(ctx,channels,n,sr);for(let c=0;c<channels;c++)putChannel(b,ch[c],c);
  textureCache.set(key,b);return b;
}
/* Write a decaying sine "ping" (drop, bubble, pop) into a looping stereo buffer; indices wrap for seamless loops. */
function writePing(L,R,n,sr,start,f0,f1,decay,amp,pan,click=0,rand=null){
  const len=Math.min(n-1,Math.ceil(decay*sr*7)),gl=Math.sqrt((1-pan)/2),gr=Math.sqrt((1+pan)/2);let ph=0;
  for(let j=0;j<len;j++){const u=j/len,f=f0*Math.pow(f1/f0,u);ph+=2*Math.PI*f/sr;
    const att=j<24?j/24:1;let s=Math.sin(ph)*Math.exp(-j/(decay*sr))*amp*att;
    if(click&&j<8&&rand)s+=(rand()*2-1)*click*amp*(1-j/8);
    const k=(start+j)%n;L[k]+=s*gl;R[k]+=s*gr;}
}
const curveCache=new Map();
function tanhCurve(drive){const k=drive.toFixed(2);let c=curveCache.get(k);if(c)return c;c=new Float32Array(2048);const n=Math.tanh(drive);
  for(let i=0;i<c.length;i++){const x=i/(c.length-1)*2-1;c[i]=Math.tanh(x*drive)/n;}curveCache.set(k,c);return c;}
/* Output safety limiter: exactly linear below `knee`, tanh-shaped above, reaching 1 as input approaches `headroom`. */
function softClipCurve(knee=.85,headroom=4){const c=new Float32Array(8193);
  for(let i=0;i<c.length;i++){const x=(i/(c.length-1)*2-1)*headroom,a=Math.abs(x);c[i]=a<=knee?x:Math.sign(x)*(knee+(1-knee)*Math.tanh((a-knee)/(1-knee)));}return c;}
const bellShape=(u,peak)=>u<peak?Math.pow(Math.sin(Math.PI/2*u/peak),2):Math.pow(Math.cos(Math.PI/2*(u-peak)/(1-peak)),2);

/* ============================================================ Patch ============================================================ */
/* MetaSounds-style patch builder: creates nodes on any BaseAudioContext, tracks them for disposal and offers
   envelope primitives. Every envelope starts and ends at exactly 0, so patches are click-free by design. */
class Patch{
  /* live=true for long-running patches (ambience, music): ephemeral node groups are released when they end. */
  constructor(ctx,out,seed=1,live=false){this.ctx=ctx;this.out=out;this.sr=ctx.sampleRate;this.rng=KE.random(seed>>>0||1);this.nodes=new Set();this.sources=new Set();this.end=0;this.live=live;}
  r(a=0,b=1){return a+(b-a)*this.rng();}
  ri(a,b){return Math.floor(this.r(a,b+1));}
  pick(a){return a[Math.floor(this.rng()*a.length)];}
  add(n){this.nodes.add(n);return n;}
  gain(v=1){const g=this.ctx.createGain();g.gain.value=v;return this.add(g);}
  filter(type='lowpass',freq=1000,Q=.7071,gainDb=0){const f=this.ctx.createBiquadFilter();f.type=type;f.frequency.value=Math.min(freq,this.sr*.45);f.Q.value=Q;if(gainDb)f.gain.value=gainDb;return this.add(f);}
  pan(p=0){if(!this.ctx.createStereoPanner)return this.gain(1);const s=this.ctx.createStereoPanner();s.pan.value=clamp(p,-1,1);return this.add(s);}
  delay(t=.1,max=2){const d=this.ctx.createDelay(max);d.delayTime.value=t;return this.add(d);}
  shaper(drive=2){const s=this.ctx.createWaveShaper();s.curve=tanhCurve(drive);s.oversample='2x';return this.add(s);}
  src(s,t,dur){this.add(s);this.sources.add(s);s.start(t);if(dur!=null&&isFinite(dur))s.stop(t+dur);this.end=Math.max(this.end,isFinite(dur)?t+dur:t);return s;}
  osc(type='sine',freq=440,t=0,dur=1,detune=0){const o=this.ctx.createOscillator();if(typeof type==='string')o.type=type;else o.setPeriodicWave(type);o.frequency.value=freq;if(detune)o.detune.value=detune;return this.src(o,t,dur);}
  /* Shared seeded noise, started at a random offset. dur=Infinity loops forever. */
  noise(kind='white',t=0,dur=1,{variant=null,loop=false,rate=1}={}){
    const s=this.ctx.createBufferSource(),buf=noiseBuffer(this.ctx,kind,variant==null?Math.floor(this.rng()*NOISE_VARIANTS):variant);
    s.buffer=buf;if(rate!==1)s.playbackRate.value=rate;const len=buf.duration;this.add(s);this.sources.add(s);
    if(loop||!isFinite(dur)||dur*rate>len-.05){s.loop=true;s.start(t,this.rng()*len);if(isFinite(dur))s.stop(t+dur);}
    else{s.start(t,this.rng()*(len-dur*rate-.02));s.stop(t+dur);}
    this.end=Math.max(this.end,isFinite(dur)?t+dur:t);return s;
  }
  buffer(buf,t=0,dur=Infinity,{loop=true,offset=0,rate=1}={}){const s=this.ctx.createBufferSource();s.buffer=buf;s.loop=loop;if(rate!==1)s.playbackRate.value=rate;this.add(s);this.sources.add(s);s.start(t,offset%buf.duration);if(isFinite(dur))s.stop(t+dur);return s;}
  constant(v=0){const c=this.ctx.createConstantSource?this.ctx.createConstantSource():null;if(!c)return null;c.offset.value=v;return c;}
  chain(...ns){for(let i=0;i<ns.length-1;i++)ns[i].connect(ns[i+1]);return ns[ns.length-1];}
  /* 0 -> peak in `attack`, exponential decay reaching -60 dB after t60, then a short linear tail to 0. */
  perc(p,t,peak,attack,t60){if(!(peak>0))return t;p.setValueAtTime(0,t);p.linearRampToValueAtTime(peak,t+attack);p.exponentialRampToValueAtTime(peak*1e-3,t+attack+t60);p.linearRampToValueAtTime(0,t+attack+t60+.008);return t+attack+t60+.008;}
  /* Attack, hold until t+hold, exponential release to -60 dB. */
  asr(p,t,peak,attack,hold,release){const h=t+Math.max(attack,hold);p.setValueAtTime(0,t);p.linearRampToValueAtTime(peak,t+attack);p.setValueAtTime(peak,h);p.exponentialRampToValueAtTime(peak*1e-3,h+release);p.linearRampToValueAtTime(0,h+release+.02);return h+release+.02;}
  curve(p,t,dur,fn,n=64){const c=new Float32Array(n);for(let i=0;i<n;i++)c[i]=fn(i/(n-1));c[0]=0;c[n-1]=0;p.setValueCurveAtTime(c,t,dur);return t+dur;}
  sweep(p,t,from,to,dur){p.setValueAtTime(from,t);if(from>0&&to>0)p.exponentialRampToValueAtTime(to,t+dur);else p.linearRampToValueAtTime(to,t+dur);}
  /* Micro-grains on one gain param: list of [time, amp, decay], made monotonic so ramps never overlap. */
  grains(p,list,attack=.0008){list.sort((a,b)=>a[0]-b[0]);let last=-1;
    for(const [t0,a,d] of list){const t=Math.max(t0,last+1e-4);p.setValueAtTime(0,t);p.linearRampToValueAtTime(a,t+attack);p.linearRampToValueAtTime(0,t+attack+d);last=t+attack+d;}}
  /* Ephemeral group: disconnect and forget `nodes` once `src` has ended. */
  once(src,nodes){src.onended=()=>{for(const n of nodes){disconnect(n);this.nodes.delete(n);this.sources.delete(n);}};}
  stop(t){for(const s of this.sources){try{s.stop(t);}catch(e){}}}
  dispose(){for(const s of this.sources){s.onended=null;try{s.stop();}catch(e){}}for(const n of this.nodes)disconnect(n);this.sources.clear();this.nodes.clear();}
  get size(){return this.nodes.size;}
}

/* ============================================================ KE.Synth: offline procedural one-shots ============================================================ */
const RECIPES=new Map();
const synthCache=new Map(),synthPending=new Map();
const CACHE_LIMIT={entries:192,seconds:360};
let cacheSeconds=0;
function cacheGet(key){const b=synthCache.get(key);if(!b)return null;synthCache.delete(key);synthCache.set(key,b);return b;}
function cachePut(key,b){if(synthCache.has(key))return;synthCache.set(key,b);cacheSeconds+=b.duration;
  for(const [k,v] of synthCache){if(synthCache.size<=CACHE_LIMIT.entries&&cacheSeconds<=CACHE_LIMIT.seconds)break;if(k===key)continue;synthCache.delete(k);cacheSeconds-=v.duration;}}
/* At most two offline renders run at once so a preload burst does not starve the page. */
const renderQueue={active:0,max:2,q:[]};
function enqueue(job){return new Promise((resolve,reject)=>{renderQueue.q.push({job,resolve,reject});pumpQueue();});}
function pumpQueue(){while(renderQueue.active<renderQueue.max&&renderQueue.q.length){const it=renderQueue.q.shift();renderQueue.active++;
  let p;try{p=Promise.resolve(it.job());}catch(e){p=Promise.reject(e);}
  p.then(it.resolve,it.reject).then(()=>{renderQueue.active--;pumpQueue();});}}
function normalizeParams(def,params={}){const p={};for(const k of Object.keys(def.defaults))p[k]=params[k]!==undefined?params[k]:def.defaults[k];
  if('seed' in p)p.seed=Math.max(0,Math.floor(Number(p.seed)||0));return p;}
function synthKey(name,p,sr){return name+'|'+sr+'|'+stableKey(p);}
function startRendering(ctx){return new Promise((resolve,reject)=>{const r=ctx.startRendering();if(r&&r.then)r.then(resolve,reject);else ctx.oncomplete=e=>resolve(e.renderedBuffer);});}
/* Post-process a rendered one-shot: trim trailing silence, normalise the peak to the recipe level and apply
   1.5 ms / 10 ms raised-cosine edge fades so the buffer starts and ends at exactly zero. */
function finishBuffer(buf,def,p){
  const chs=[];for(let c=0;c<buf.numberOfChannels;c++)chs.push(buf.getChannelData(c));
  let peak=0,last=0;for(const d of chs)for(let i=0;i<d.length;i++){const a=Math.abs(d[i]);if(a>peak)peak=a;}
  const floor=peak*2e-4;for(const d of chs)for(let i=d.length-1;i>last;i--)if(Math.abs(d[i])>floor){last=i;break;}
  const sr=buf.sampleRate,n=Math.min(buf.length,last+Math.round(sr*.012)+1),level=typeof def.level==='function'?def.level(p):def.level,g=peak>0?level/peak:0;
  const fi=Math.max(2,Math.round(sr*.0015)),fo=Math.max(4,Math.min(Math.round(sr*.01),n>>3));
  const out=makeBuffer(null,chs.length,n,sr);let e=0;
  chs.forEach((d,c)=>{const o=new Float32Array(n);for(let i=0;i<n;i++){let v=d[i]*g;if(i<fi)v*=Math.pow(Math.sin(Math.PI/2*i/fi),2);const k=n-1-i;if(k<fo)v*=Math.pow(Math.sin(Math.PI/2*k/fo),2);o[i]=v;e+=v*v;}putChannel(out,o,c);});
  try{out.keSynth={name:def.name,params:p,peak:level,rms:Math.sqrt(e/(n*chs.length))};}catch(err){}
  return out;
}
function renderRecipe(def,p,sr){
  const C=OACtor();if(!C)return Promise.reject(new Error('OfflineAudioContext is unavailable'));
  const dur=Math.max(.02,def.duration(p)),ctx=new C(def.channels,Math.ceil(dur*sr),sr);
  const out=ctx.createBiquadFilter();out.type='highpass';out.frequency.value=def.highpass;out.Q.value=.7071;out.connect(ctx.destination);
  const P=new Patch(ctx,out,hashStr(def.name)^(p.seed||0)*2654435761);def.build(P,p);
  /* Watchdog: a render that never completes must not block the queue for every later sound. */
  let timer=0;const limit=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('KE.Synth: offline render of "'+def.name+'" timed out')),Math.max(10,dur*20)*1000);});
  return Promise.race([startRendering(ctx),limit]).then(buf=>{clearTimeout(timer);return finishBuffer(buf,def,p);},e=>{clearTimeout(timer);throw e;});
}
/* A synth call such as KE.Synth.footstep({surface:'stone'}) returns a SynthSound: a lightweight descriptor that
   audio.play() accepts directly (rendering happens at the engine's sample rate, cached) and that is also
   thenable, so `await KE.Synth.chime({note:'E5'})` yields the rendered AudioBuffer. */
class SynthSound{
  constructor(synth,params={}){this.synth=synth;this.params=params&&typeof params==='object'?{...params}:{};}
  /* Promise<AudioBuffer> rendered with OfflineAudioContext (cached by name, params and sample rate). */
  render(opts){return Synth.render(this.synth,this.params,opts);}
  then(resolve,reject){return this.render().then(resolve,reject);}
  catch(reject){return this.render().catch(reject);}
  with(params){return new SynthSound(this.synth,{...this.params,...params});}
}
const Synth={sampleRate:44100};
/* Library utilities are non-enumerable so Object.keys(KE.Synth) lists only the sound recipes. */
const hidden=(name,value)=>Object.defineProperty(Synth,name,{value,enumerable:false,writable:true,configurable:true});
hidden('define',(name,def)=>{if(typeof def.build!=='function'||typeof def.duration!=='function')throw new TypeError('Synth.define needs build() and duration()');
  /* {defaults, duration(p), level (peak, number or fn), build(P,p), variants, channels, highpass} */
  if(Object.prototype.hasOwnProperty.call(Synth,name)&&!(Synth[name]&&Synth[name]._synth))throw new RangeError('Synth name "'+name+'" is reserved');
  RECIPES.set(name,{name,defaults:{},level:.7,channels:2,variants:1,highpass:25,...def});for(const [k,b] of [...synthCache])if(k.startsWith(name+'|')){synthCache.delete(k);cacheSeconds-=b.duration;}
  Synth[name]=Object.assign(params=>new SynthSound(name,params),{_synth:true});return Synth;});
hidden('has',name=>RECIPES.has(name));
hidden('names',()=>[...RECIPES.keys()]);
hidden('defaults',name=>{const def=RECIPES.get(name);if(!def)throw new RangeError('Unknown synth "'+name+'"');return {...def.defaults};});
hidden('params',(name,params)=>{const def=RECIPES.get(name);if(!def)throw new RangeError('Unknown synth "'+name+'"');return normalizeParams(def,params);});
hidden('key',(name,params,sampleRate=Synth.sampleRate)=>synthKey(name,Synth.params(name,params),sampleRate));
/* Cached buffer or null; never renders. */
hidden('get',(name,params,sampleRate=Synth.sampleRate)=>{const def=RECIPES.get(name);return def?cacheGet(synthKey(name,normalizeParams(def,params),sampleRate)):null;});
/* Promise<AudioBuffer>; renders with OfflineAudioContext on first use and caches by (name, params, sampleRate). */
hidden('render',(name,params={},{sampleRate=Synth.sampleRate}={})=>{
  const def=RECIPES.get(name);if(!def)return Promise.reject(new RangeError('Unknown synth "'+name+'"'));
  const p=normalizeParams(def,params),key=synthKey(name,p,sampleRate),hit=cacheGet(key);if(hit)return Promise.resolve(hit);
  let pending=synthPending.get(key);if(pending)return pending;
  pending=enqueue(()=>renderRecipe(def,p,sampleRate)).then(b=>{cachePut(key,b);synthPending.delete(key);return b;},e=>{synthPending.delete(key);throw e;});
  synthPending.set(key,pending);return pending;});
hidden('sound',(name,params)=>{if(!RECIPES.has(name))throw new RangeError('Unknown synth "'+name+'"');return new SynthSound(name,params);});
hidden('clearCache',()=>{synthCache.clear();cacheSeconds=0;});
hidden('cacheStats',()=>({entries:synthCache.size,seconds:cacheSeconds,pending:synthPending.size,limit:{...CACHE_LIMIT}}));
hidden('setCacheLimit',({entries,seconds}={})=>{if(entries>0)CACHE_LIMIT.entries=entries|0;if(seconds>0)CACHE_LIMIT.seconds=+seconds;});
/* Signal metrics used by tests and tooling. headPeak/tailPeak: max |x| in the first/last millisecond;
   maxStep: largest sample-to-sample jump (clicks show up as isolated large steps). */
hidden('analyze',buf=>{let peak=0,sum=0,sq=0,nan=0,head=0,tail=0,step=0;const n=buf.length,ms=Math.max(1,Math.round(buf.sampleRate/1000));
  for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);let prev=0;for(let i=0;i<n;i++){const v=d[i];if(v!==v){nan++;continue;}const a=Math.abs(v);if(a>peak)peak=a;sum+=v;sq+=v*v;
    const st=Math.abs(v-prev);if(st>step)step=st;prev=v;if(i<ms&&a>head)head=a;if(i>=n-ms&&a>tail)tail=a;}}
  const m=n*buf.numberOfChannels;return {peak,rms:Math.sqrt(sq/m),dc:sum/m,nan,headPeak:head,tailPeak:tail,maxStep:step,duration:buf.duration,channels:buf.numberOfChannels};});
for(const [k,v] of Object.entries({noteToHz,noteToMidi,midiToHz,Patch,noiseBuffer,SynthSound}))hidden(k,v);

/* ---------- shared recipe parts ---------- */
function thump(P,hits,f0,f1,amp,t60){for(const [t,a] of hits){const o=P.osc('sine',f0,t,t60+.06),g=P.gain(0);P.sweep(o.frequency,t,f0,f1,t60*.6);P.chain(o,g,P.out);P.perc(g.gain,t,amp*a,.003,t60);}}
function noiseHit(P,kind,t,{type='bandpass',freq=2000,Q=1,attack=.001,t60=.05,amp=1,to=null,sweep=0,pan=null,dur=null}={}){
  const n=P.noise(kind,t,dur||attack+t60+.03),f=P.filter(type,freq,Q),g=P.gain(0);if(sweep)P.sweep(f.frequency,t,freq,sweep,t60*.7);
  const nodes=[n,f,g];if(pan!=null){const pn=P.pan(pan);nodes.push(pn);P.chain(n,f,g,pn,to||P.out);}else P.chain(n,f,g,to||P.out);P.perc(g.gain,t,amp,attack,t60);
  if(P.live)P.once(n,nodes);return g;}
/* Rising sine bubble (Minnaert resonance whose pitch rises as the bubble surfaces). */
function bubble(P,t,f0,rise,d,amp,pan=0){const o=P.osc('sine',f0,t,d*2.2+.02),g=P.gain(0),pn=P.pan(pan);P.sweep(o.frequency,t,f0,f0*rise,d*1.6);P.chain(o,g,pn,P.out);P.perc(g.gain,t,amp,.0012,d);}
function modal(P,t,f,parts,{decay=1,amp=1,width=.45,detune=2,attack=.0015}={}){
  for(const [ratio,a,dScale] of parts){const fr=f*ratio;if(fr>P.sr*.42)continue;const t60=decay*dScale;
    for(const side of [-1,1]){const o=P.osc('sine',fr,t,attack+t60+.03,side*P.r(detune*.4,detune)),g=P.gain(0),pn=P.pan(side*width);P.chain(o,g,pn,P.out);P.perc(g.gain,t,a*amp*.5,attack,t60);}}}
const BELL=[[.5,.3,1.1],[1,1,.9],[1.183,.42,.6],[1.506,.3,.5],[2,.55,.42],[2.514,.2,.3],[2.662,.2,.27],[3.011,.14,.22],[4.166,.09,.15],[5.433,.05,.1]];
const BAR=[[1,1,1],[2.756,.32,.42],[5.404,.11,.2],[8.933,.035,.1]];
const PLATE=[[1,1],[1.593,.7],[2.136,.5],[2.296,.45],[2.653,.3],[3.156,.2]];

/* ---------- footsteps: heel + toe contacts with surface-specific excitation ---------- */
const STEP={
  grass(P,hits,I,b){
    const src=P.noise('pink',0,.42),hp=P.filter('highpass',650),bp=P.filter('bandpass',2300*b,.6);P.chain(src,hp,bp);
    for(const [t,a] of hits){const g=P.gain(0);P.chain(bp,g,P.out);P.perc(g.gain,t,a,.008,.12+.06*a);}
    const cr=P.noise('white',0,.42),chp=P.filter('highpass',3600),cg=P.gain(0);P.chain(cr,chp,cg,P.out);
    const list=[];for(let i=0,n=P.ri(6,12);i<n;i++)list.push([hits[0][0]+P.r(0,.2),P.r(.12,.6),P.r(.002,.007)]);P.grains(cg.gain,list);
    thump(P,hits,95,55,.35*I,.08);
  },
  stone(P,hits,I,b){const ring=P.r(1400,2300);
    for(const [t,a] of hits){noiseHit(P,'white',t,{type:'highpass',freq:1400*b,Q:.7,attack:.0008,t60:.035,amp:.9*a});
      noiseHit(P,'white',t,{type:'bandpass',freq:ring*P.r(.94,1.06),Q:9,attack:.001,t60:.07,amp:2.6*a});}
    const gr=P.noise('white',0,.3),ghp=P.filter('highpass',4200),gg=P.gain(0);P.chain(gr,ghp,gg,P.out);
    const list=[];for(let i=0,n=P.ri(5,9);i<n;i++)list.push([hits[P.ri(0,1)][0]+P.r(0,.05),P.r(.1,.35),P.r(.002,.005)]);P.grains(gg.gain,list);
    thump(P,hits,135,75,.8*I,.06);
  },
  wood(P,hits,I,b){const modes=[[P.r(170,200),1,.16],[P.r(390,440),.55,.1],[P.r(820,900),.3,.06],[P.r(1500,1700),.14,.04]];
    for(const [t,a] of hits){for(const [f,amp,t60] of modes){const o=P.osc('sine',f,t,t60+.05),g=P.gain(0);P.chain(o,g,P.out);P.perc(g.gain,t,amp*a*.7,.0015,t60*(.8+.4*I));}
      noiseHit(P,'white',t,{type:'bandpass',freq:2800*b,Q:1,attack:.0005,t60:.016,amp:.9*a});}
    thump(P,hits,90,60,.5*I,.08);
    if(P.rng()<.3){const t=hits[0][0]+.03,o=P.osc('sawtooth',P.r(130,170),t,.16),f=P.filter('bandpass',900,5),g=P.gain(0);
      for(let k=0;k<6;k++)o.frequency.linearRampToValueAtTime(P.r(120,180),t+k*.02+.01);P.chain(o,f,g,P.out);P.asr(g.gain,t,.05,.02,.06,.05);}
  },
  water(P,hits,I,b){
    for(const [t,a] of hits){noiseHit(P,'white',t,{type:'bandpass',freq:600,Q:1.1,sweep:2300*b,attack:.004,t60:.2,amp:a});
      noiseHit(P,'brown',t,{type:'lowpass',freq:450,Q:.7,attack:.01,t60:.17,amp:.9*a});}
    const t0=hits[0][0];for(let i=0,n=4+Math.floor(4*I);i<n;i++)bubble(P,t0+P.r(.01,.2),P.r(380,1100),P.r(1.5,2.4),P.r(.025,.06),P.r(.12,.3),P.r(-.4,.4));
    for(let i=0,n=P.ri(2,3);i<n;i++)bubble(P,t0+P.r(.2,.38),P.r(1600,2800),P.r(1.2,1.6),.018,P.r(.05,.1),P.r(-.6,.6));
  },
  sand(P,hits,I,b){
    const src=P.noise('white',0,.4),bp=P.filter('bandpass',3200*b,.9),hp=P.filter('highpass',1400),g=P.gain(0);P.chain(src,bp,hp,g,P.out);
    const list=[];for(const [t,a] of hits){const n=Math.round((22+14*I)*a);for(let i=0;i<n;i++){const u=Math.pow(P.rng(),1.4);list.push([t+u*.13,a*Math.pow(1-u,1.3)*P.r(.3,1),P.r(.002,.006)]);}}P.grains(g.gain,list);
    for(const [t,a] of hits){const h=P.noise('pink',t,.2),lp=P.filter('lowpass',3000),hg=P.gain(0);P.chain(h,lp,hg,P.out);P.perc(hg.gain,t,.25*a,.012,.12);}
    thump(P,hits,85,55,.3*I,.07);
  }
};
const STEP_LEN={grass:.38,stone:.28,wood:.36,water:.5,sand:.34};
Synth.define('footstep',{defaults:{surface:'grass',intensity:.7,seed:1},variants:6,
  duration:p=>STEP_LEN[p.surface]||.36,level:p=>.3+.35*clamp(+p.intensity||0,0,1),
  build(P,p){const I=clamp(+p.intensity||0,0,1),b=.7+.6*I,t0=.003,fn=STEP[p.surface]||STEP.grass;
    fn(P,[[t0,1],[t0+P.r(.045,.085),P.r(.45,.75)]],I,b);}});

Synth.define('chime',{defaults:{note:'C5',freq:0,bell:true,decay:2.4,brightness:.6,seed:1},
  duration:p=>clamp(+p.decay||2.4,.3,8)*1.05+.06,level:.5,
  build(P,p){const f=+p.freq>0?noteToHz(+p.freq):noteToHz(p.note),D=clamp(+p.decay||2.4,.3,8),br=clamp(+p.brightness,0,1),t=.002;
    const parts=(p.bell?BELL:BAR).map(([r,a,d])=>[r,r>1.2?a*(.4+.9*br):a,d]);
    modal(P,t,f,parts,{decay:D,amp:1,width:.45,detune:2.5});
    noiseHit(P,'white',t,{type:'bandpass',freq:Math.min(f*3,P.sr*.4),Q:1.5,attack:.0005,t60:.02,amp:.12*br});}});

Synth.define('impact',{defaults:{size:1,hardness:.5,seed:1},variants:4,
  duration:p=>{const s=clamp(+p.size||1,.1,5),h=clamp(+p.hardness,0,1);return .16+.35*Math.pow(s,.6)+(h>.55?.5*h*Math.pow(s,.3):0);},level:.85,
  build(P,p){const s=clamp(+p.size||1,.1,5),h=clamp(+p.hardness,0,1),t=.002,rs=1/Math.sqrt(s);
    const f0=140*rs,o=P.osc('sine',f0*1.8,t,.5+.3*s),og=P.gain(0);P.sweep(o.frequency,t,f0*1.8,f0,.05);P.chain(o,og,P.out);P.perc(og.gain,t,1-.4*h,.002,.12+.2*s);
    noiseHit(P,'white',t,{type:'lowpass',freq:(400+7000*Math.pow(h,1.5))*Math.sqrt(rs),Q:.9,attack:.0008+.004*(1-h),t60:(.06+.12*s)*(1.3-.7*h),amp:.9});
    noiseHit(P,'brown',t,{type:'lowpass',freq:250*rs,Q:.7,attack:.003,t60:.15*s,amp:.5*Math.pow(s,.3)});
    if(h>.25)noiseHit(P,'white',t,{type:'highpass',freq:3500,Q:.7,attack:.0003,t60:.008,amp:.5*h});
    if(h>.55){const fm=(420+1500*h)*Math.pow(rs,.7),a=.35*(h-.55)/.45;
      for(const [ratio,amp] of PLATE){const fr=fm*ratio*P.r(.98,1.02);if(fr>P.sr*.42)continue;const og2=P.gain(0),oo=P.osc('sine',fr,t,1.2*s+.5),pn=P.pan(P.r(-.4,.4));
        P.chain(oo,og2,pn,P.out);P.perc(og2.gain,t,a*amp,.0008,(.15+.5*h)*Math.pow(s,.3)/Math.sqrt(ratio));}}
    if(s>1.4){const d=P.noise('white',t,.4*s+.1),dh=P.filter('highpass',1800),dg=P.gain(0);P.chain(d,dh,dg,P.out);const list=[];
      for(let i=0,n=Math.floor(6*s);i<n;i++){const u=P.rng();list.push([t+.05+u*.3*s,.35*(1-u)*P.r(.3,1),P.r(.003,.012)]);}P.grains(dg.gain,list);}}});

Synth.define('whoosh',{defaults:{duration:.6,brightness:.5,seed:1},variants:3,duration:p=>clamp(+p.duration||.6,.15,3)+.06,level:.5,
  build(P,p){const d=clamp(+p.duration||.6,.15,3),b=clamp(+p.brightness,0,1),t=.002,peak=P.r(.5,.6);
    const n=P.noise('pink',t,d),bp=P.filter('bandpass',280,1.2),g=P.gain(0),pn=P.pan(0);
    bp.frequency.setValueAtTime(280,t);bp.frequency.exponentialRampToValueAtTime(1400+1800*b,t+d*peak);bp.frequency.exponentialRampToValueAtTime(420,t+d);
    P.curve(g.gain,t,d,u=>bellShape(u,peak));pn.pan.setValueAtTime(-.55,t);pn.pan.linearRampToValueAtTime(.55,t+d);P.chain(n,bp,g,pn,P.out);
    const a=P.noise('white',t,d),hp=P.filter('highpass',3200),ag=P.gain(0);P.curve(ag.gain,t,d,u=>bellShape(u,Math.min(.8,peak+.08))*.22*(.3+b));P.chain(a,hp,ag,pn);}});

Synth.define('click',{defaults:{tone:2400,seed:1},duration:()=>.06,level:.32,
  build(P,p){const f=clamp(+p.tone||2400,200,8000),t=.0015;
    const o=P.osc('sine',f,t,.05),g=P.gain(0);P.chain(o,g,P.out);P.perc(g.gain,t,.8,.0006,.02);
    const o2=P.osc('sine',f*.25,t,.05),g2=P.gain(0);P.chain(o2,g2,P.out);P.perc(g2.gain,t,.3,.0008,.012);
    noiseHit(P,'white',t,{type:'highpass',freq:5000,Q:.7,attack:.0003,t60:.004,amp:.5});}});

Synth.define('pickup',{defaults:{note:'A5',seed:1},duration:()=>.8,level:.42,
  build(P,p){const f=noteToHz(p.note);
    [[0,0],[7,.055],[12,.11]].forEach(([semi,dt],i)=>{const t=.002+dt,fr=f*Math.pow(2,semi/12),v=1-.15*i;
      for(const side of [-1,1]){const o=P.osc('sine',fr,t,.6,side*4),g=P.gain(0),pn=P.pan(side*.35);P.chain(o,g,pn,P.out);P.perc(g.gain,t,.35*v,.002,.45);}
      const o2=P.osc('sine',fr*2.756,t,.25),g2=P.gain(0);P.chain(o2,g2,P.out);P.perc(g2.gain,t,.08*v,.001,.15);
      const o3=P.osc('triangle',fr*2,t,.2),g3=P.gain(0);P.chain(o3,g3,P.out);P.perc(g3.gain,t,.05*v,.001,.12);});
    noiseHit(P,'white',.05,{type:'highpass',freq:7000,Q:.7,attack:.004,t60:.3,amp:.06});}});

Synth.define('jump',{defaults:{seed:1},variants:3,duration:()=>.36,level:.4,
  build(P,p){const t=.002,f0=P.r(160,185),o=P.osc('triangle',f0,t,.32),lp=P.filter('lowpass',2200),g=P.gain(0);
    o.frequency.setValueAtTime(f0,t);o.frequency.exponentialRampToValueAtTime(f0*2.5,t+.11);o.frequency.exponentialRampToValueAtTime(f0*2.2,t+.22);
    P.chain(o,lp,g,P.out);P.perc(g.gain,t,.6,.006,.22);
    const n=P.noise('pink',t,.24),bp=P.filter('bandpass',900,1.1),ng=P.gain(0);P.sweep(bp.frequency,t,900,2600,.12);P.curve(ng.gain,t,.22,u=>bellShape(u,.3)*.5);P.chain(n,bp,ng,P.out);
    const c=P.noise('white',t,.1),cb=P.filter('bandpass',1800,.6),cg=P.gain(0);P.chain(c,cb,cg,P.out);const list=[];for(let i=0,k=P.ri(3,5);i<k;i++)list.push([t+P.r(0,.06),P.r(.1,.25),P.r(.004,.01)]);P.grains(cg.gain,list);}});

Synth.define('splash',{defaults:{size:1,seed:1},variants:4,duration:p=>.5+.6*Math.pow(clamp(+p.size||1,.2,4),.6),level:.6,
  build(P,p){const s=clamp(+p.size||1,.2,4),t=.003;
    noiseHit(P,'white',t,{type:'lowpass',freq:4000,Q:.7,attack:.002,t60:.12+.1*s,amp:.9});
    noiseHit(P,'brown',t,{type:'lowpass',freq:400,Q:.7,attack:.004,t60:.25*s,amp:.6*Math.sqrt(s)});
    noiseHit(P,'white',t,{type:'highpass',freq:2500,Q:.7,attack:.015,t60:.4*Math.sqrt(s),amp:.35,dur:.5*s+.2});
    const span=.35*Math.pow(s,.6);for(let i=0,n=Math.round(10+12*s);i<n;i++){const u=P.rng();bubble(P,t+.01+u*span,P.r(380,1400)/Math.pow(s,.3),P.r(1.4,2.6),P.r(.02,.07),.3*(1-.6*u)*P.r(.4,1),P.r(-.6,.6));}
    for(let i=0,n=Math.round(4+4*s);i<n;i++)bubble(P,t+P.r(.25,.8)*Math.sqrt(s),P.r(1500,3000),P.r(1.2,1.7),P.r(.012,.025),P.r(.04,.12),P.r(-.8,.8));}});

Synth.define('explosion',{defaults:{size:1,seed:1},variants:3,duration:p=>1.5*Math.sqrt(clamp(+p.size||1,.25,4))+.45,level:.95,
  build(P,p){const s=clamp(+p.size||1,.25,4),L=1.5*Math.sqrt(s),t=.003;
    noiseHit(P,'white',t,{type:'highpass',freq:900,Q:.7,attack:.0006,t60:.05,amp:.9});
    const b=P.noise('brown',t,L+.2),bg=P.gain(0),sh=P.shaper(2.2),lp=P.filter('lowpass',4000,.7);
    P.sweep(lp.frequency,t,4000/Math.pow(s,.3),160,L*.8);P.chain(b,bg,sh,lp,P.out);P.perc(bg.gain,t,2.4,.004,L);
    const f0=72/Math.pow(s,.25),o=P.osc('sine',f0,t,1.5*s+.2),og=P.gain(0);P.sweep(o.frequency,t,f0,30,.6*Math.sqrt(s));P.chain(o,og,P.out);P.perc(og.gain,t,.9,.004,.9*Math.sqrt(s));
    const r=P.noise('brown',t,L+.4),rlp=P.filter('lowpass',140),rg=P.gain(0);P.chain(r,rlp,rg,P.out);
    rg.gain.setValueAtTime(0,t);let tt=t;while(tt<t+L){tt+=P.r(.06,.2);rg.gain.linearRampToValueAtTime(Math.exp(-3*(tt-t)/L)*P.r(.4,1)*1.2,tt);}rg.gain.linearRampToValueAtTime(0,tt+.2);
    const d=P.noise('white',t,L+.2),dh=P.filter('highpass',2200),dg=P.gain(0),pn=P.pan(P.r(-.3,.3));P.chain(d,dh,dg,pn,P.out);const list=[];
    for(let i=0,n=Math.floor(10+14*s);i<n;i++){const u=P.r(.08,.85);list.push([t+u*L,.45*(1-u)*P.r(.25,1),P.r(.002,.012)]);}P.grains(dg.gain,list);}});

Synth.define('thunder',{defaults:{distance:.4,seed:1},variants:3,duration:p=>5.5+1.5*clamp(+p.distance,0,1),level:.9,
  build(P,p){const dist=clamp(+p.distance,0,1),D=5.2+1.5*dist,t=.004,near=1-dist;
    if(dist<.75){noiseHit(P,'white',t+.02,{type:'highpass',freq:1500,Q:.7,attack:.002,t60:.25,amp:near*near});
      noiseHit(P,'pink',t+.03,{type:'bandpass',freq:1200,Q:.8,attack:.01,t60:.6,amp:near*.6,dur:.8});}
    const n=P.noise('brown',t,D),lp=P.filter('lowpass',900,.7),env=P.gain(0),rolls=P.gain(0);
    P.sweep(lp.frequency,t,900*(1-.6*dist)+120,90,D*.9);P.chain(n,lp,env,rolls,P.out);
    env.gain.setValueAtTime(0,t);env.gain.linearRampToValueAtTime(1,t+.08+.3*dist);env.gain.exponentialRampToValueAtTime(.001,t+D-.05);env.gain.linearRampToValueAtTime(0,t+D);
    rolls.gain.setValueAtTime(.3,t);let tt=t;const swells=[];for(let i=0,k=P.ri(4,7);i<k;i++)swells.push(P.r(.1,D*.75));swells.sort((a,b)=>a-b);
    for(const sw of swells){const at=t+sw;if(at<=tt+.05)continue;rolls.gain.linearRampToValueAtTime(P.r(.25,.5),at);rolls.gain.linearRampToValueAtTime(P.r(.8,1.6),at+P.r(.08,.25));tt=at+.25;}
    const s2=P.noise('brown',t,D),l2=P.filter('lowpass',70),g2=P.gain(0);P.chain(s2,l2,g2,P.out);P.asr(g2.gain,t,.9,.3,D*.3,D*.5);}});

/* ============================================================ procedural reverb ============================================================ */
/* Impulse responses are synthesised in JS: two noise bands (split at 1.2 kHz with a one-pole filter) decay with
   separate RT60s (highs die faster = air/wall absorption), fade in over a build-up time, get a static damping
   lowpass and low cut, plus early-reflection taps after the pre-delay. Energy is normalised so different
   presets sit at comparable loudness (slightly louder for longer tails). */
const REVERB_PRESETS={
  none:null,
  room:      {decay:.6, preDelay:.004,erTime:.024,erCount:10,erLevel:.55,damping:6500,hfDecay:.55,lowCut:160,buildUp:.006,width:.8},
  hall:      {decay:2.3,preDelay:.022,erTime:.07, erCount:14,erLevel:.35,damping:7500,hfDecay:.6, lowCut:70, buildUp:.03, width:1},
  cave:      {decay:3.8,preDelay:.03, erTime:.12, erCount:18,erLevel:.6, damping:3800,hfDecay:.45,lowCut:90, buildUp:.05, width:1},
  forest:    {decay:1.2,preDelay:.015,erTime:.09, erCount:7, erLevel:.25,damping:4500,hfDecay:.5, lowCut:180,buildUp:.04, width:1,sparse:true},
  underwater:{decay:1.8,preDelay:0,   erTime:.03, erCount:6, erLevel:.3, damping:650, hfDecay:.3, lowCut:60, buildUp:.02, width:.6,wobble:true,dryLowpass:900,dryGain:.8}
};
const irCache=new Map();
function impulseResponse(ctx,name,maxSeconds){
  const P=REVERB_PRESETS[name];if(!P)return null;const sr=ctx.sampleRate,key=name+'|'+sr+'|'+maxSeconds;let b=irCache.get(key);if(b)return b;
  const len=Math.max(64,Math.round(Math.min(maxSeconds,P.preDelay+P.decay*1.15+.05)*sr)),ch=[new Float32Array(len),new Float32Array(len)];
  const aX=Math.exp(-2*Math.PI*1200/sr),aD=Math.exp(-2*Math.PI*P.damping/sr),aH=Math.exp(-2*Math.PI*P.lowCut/sr),k=6.9078;
  for(let c=0;c<2;c++){const d=ch[c],rand=KE.random(hashStr(key)+c*977);let low=0,dmp=0,hpIn=0,hpOut=0,clump=1,clumpT=0;
    for(let i=0;i<len;i++){const t=i/sr-P.preDelay;if(t<0)continue;const w=rand()*2-1;low=low*aX+w*(1-aX);const high=w-low;
      let v=(low*Math.exp(-k*t/P.decay)+high*Math.exp(-k*t/(P.decay*P.hfDecay)))*(1-Math.exp(-t/P.buildUp));
      if(P.sparse){if(i>=clumpT){clump=.25+.75*Math.pow(rand(),2);clumpT=i+Math.round(sr*(.004+.02*rand()));}v*=clump;}
      if(P.wobble)v*=1+.3*Math.sin(2*Math.PI*(2.7+c*.4)*t);
      dmp=dmp*aD+v*(1-aD);hpOut=aH*(hpOut+dmp-hpIn);hpIn=dmp;d[i]=hpOut;}
    // early reflections: sparse taps between preDelay and preDelay+erTime, alternating-sign, level falling with time
    let e=0;for(let i=0;i<len;i++)e+=d[i]*d[i];const late=Math.sqrt(e/len)||1e-6;
    for(let r=0;r<P.erCount;r++){const u=Math.pow((r+rand())/P.erCount,1.4),at=Math.round((P.preDelay+.001+u*P.erTime)*sr);if(at+3>=len)continue;
      const a=P.erLevel*(1-.6*u)*(rand()<.5?-1:1)*(.5+.5*rand())*late*40;d[at]+=a*.6;d[at+1]+=a;d[at+2]+=a*.4;}}
  for(let i=0;i<len;i++){const m=(ch[0][i]+ch[1][i])/2,s=(ch[0][i]-ch[1][i])/2*P.width;ch[0][i]=m+s;ch[1][i]=m-s;}
  let E=0;for(const d of ch)for(let i=0;i<len;i++)E+=d[i]*d[i];const target=(.25+.2*P.decay)*2,g=Math.sqrt(target/(E||1)),fo=Math.round(len*.05);
  for(const d of ch)for(let i=0;i<len;i++){let v=d[i]*g;const q=len-1-i;if(q<fo)v*=Math.pow(Math.sin(Math.PI/2*q/fo),2);d[i]=v;}
  b=makeBuffer(ctx,2,len,sr);putChannel(b,ch[0],0);putChannel(b,ch[1],1);irCache.set(key,b);return b;
}

/* Reverb with N convolver slots. The desired mix (base preset from setReverb blended with reverb zones by
   listener position) is a weight per preset; each weighted preset gets a slot and slot gains glide to
   weight*wet. A preset switch therefore crossfades two convolvers; zones blend continuously. Slot levels are
   evaluated analytically on the audio clock (setTargetAtTime is a first-order approach), so a slot is reused
   only once it is inaudible and a convolver buffer is never swapped under a sounding tail. Idle slots are
   disconnected from the send bus after their tail has died, which lets the browser skip the convolution. */
class ReverbSystem{
  constructor(engine,input,output){
    const ctx=engine.ctx;this.engine=engine;this.input=input;this.output=ctx.createGain();this.output.connect(output);
    this.pre=ctx.createBiquadFilter();this.pre.type='highpass';this.pre.frequency.value=90;input.connect(this.pre);
    this.slots=[];for(let i=0;i<Math.max(2,quality().reverbSlots);i++){const g=ctx.createGain();g.gain.value=0;g.connect(this.output);
      this.slots.push({conv:null,gain:g,preset:null,target:0,from:0,t0:0,tau:.5,next:0,silentSince:-1,connected:false});}
    this.base={preset:'none',wet:.3};this.transition=1.5;this.zones=[];this.zoneSmoothing=.25;this.dirty=false;
    this.want={};this.wet={};for(const k of Object.keys(REVERB_PRESETS)){this.want[k]=0;this.wet[k]=0;}
    this.names=Object.keys(REVERB_PRESETS).filter(k=>REVERB_PRESETS[k]);this.dryLowpass=20000;this.dryGain=1;this._lp=20000;this._dg=1;
  }
  set(preset,wet,transition){if(!(preset in REVERB_PRESETS))throw new RangeError('Unknown reverb preset "'+preset+'"');this.base.preset=preset;if(wet!=null)this.base.wet=clamp(+wet,0,2);
    if(transition!=null)this.transition=Math.max(0,+transition);this.evaluate(this.engine.listener);this.apply(Math.max(.005,this.transition/3));}
  /* 1 inside the zone, smoothstep falloff to 0 over z.fade metres outside it. */
  zoneWeight(z,L){let d;
    if(z.box){const dx=Math.max(z.min[0]-L.x,0,L.x-z.max[0]),dy=Math.max(z.min[1]-L.y,0,L.y-z.max[1]),dz=Math.max(z.min[2]-L.z,0,L.z-z.max[2]);d=Math.sqrt(dx*dx+dy*dy+dz*dz);}
    else{const dx=L.x-z.center[0],dy=L.y-z.center[1],dz=L.z-z.center[2];d=Math.sqrt(dx*dx+dy*dy+dz*dz)-z.radius;}
    return d<=0?1:d>=z.fade?0:1-smooth01(d/z.fade);}
  /* Zones are sorted by priority (smaller volume first); each takes its weight of what remains, the base preset gets the rest. */
  evaluate(L){const want=this.want,wet=this.wet;for(const k in want){want[k]=0;wet[k]=0;}let rem=1;
    for(let i=0;i<this.zones.length;i++){const z=this.zones[i];if(!z.enabled){z.weight=0;continue;}const w=this.zoneWeight(z,L);z.weight=w;if(w<=0||rem<=0)continue;const take=rem*w;want[z.preset]+=take;wet[z.preset]+=take*z.wet;rem-=take;}
    want[this.base.preset]+=rem;wet[this.base.preset]+=rem*this.base.wet;
    let lpw=0,gw=0;for(const k of this.names){const P=REVERB_PRESETS[k];if(P.dryLowpass){lpw+=want[k]*Math.log(P.dryLowpass/20000);gw+=want[k]*((P.dryGain||1)-1);}}
    this.dryLowpass=20000*Math.exp(lpw);this.dryGain=1+gw;}
  level(s,t){return s.target+(s.from-s.target)*Math.exp(-Math.max(0,t-s.t0)/Math.max(1e-3,s.tau));}
  /* Push desired levels into slots; only params whose target moved are rescheduled (idle frames touch nothing). */
  apply(tau){const ctx=this.engine.ctx,t=ctx.currentTime,slots=this.slots;this.dirty=false;
    for(const s of slots)s.next=s.preset&&this.want[s.preset]>1e-4?this.wet[s.preset]:0;
    for(const k of this.names){const lvl=this.wet[k];if(lvl<=1e-4)continue;let has=false;for(const s of slots)if(s.preset===k){has=true;break;}if(has)continue;
      let free=null,fl=Infinity;for(const s of slots){if(s.next!==0)continue;const l=s.preset?this.level(s,t):0;if(l<.004&&l<fl){free=s;fl=l;}}
      if(!free){this.dirty=true;continue;}this.load(free,k);free.next=lvl;}
    for(const s of slots){if(Math.abs(s.next-s.target)>2e-3||(s.next===0&&s.target!==0)){s.from=this.level(s,t);s.t0=t;s.target=s.next;s.tau=tau;
      s.gain.gain.setTargetAtTime(s.next,t,tau);if(s.next>0)this.connect(s);}}
    const E=this.engine.world;if(E&&E.filter){if(Math.abs(Math.log(this.dryLowpass/this._lp))>.02){this._lp=this.dryLowpass;E.filter.frequency.setTargetAtTime(Math.min(this.dryLowpass,ctx.sampleRate*.45),t,Math.max(.03,tau));}
      if(Math.abs(this.dryGain-this._dg)>.005){this._dg=this.dryGain;E.envGain.gain.setTargetAtTime(this.dryGain,t,Math.max(.03,tau));}}}
  load(s,preset){const ctx=this.engine.ctx;if(s.conv){if(s.connected)try{this.pre.disconnect(s.conv);}catch(e){}disconnect(s.conv);}
    const c=ctx.createConvolver();c.normalize=false;c.buffer=impulseResponse(ctx,preset,this.engine.irSeconds);c.connect(s.gain);s.conv=c;s.preset=preset;s.connected=false;s.silentSince=-1;}
  connect(s){if(s.conv&&!s.connected){this.pre.connect(s.conv);s.connected=true;}s.silentSince=-1;}
  update(dt,L){const t=this.engine.ctx.currentTime;
    if(this.zones.length){this.evaluate(L);this.apply(this.zoneSmoothing);}else if(this.dirty)this.apply(Math.max(.005,this.transition/3));
    for(const s of this.slots){if(!s.connected||s.target!==0)continue;if(this.level(s,t)>1e-3){s.silentSince=-1;continue;}if(s.silentSince<0){s.silentSince=t;continue;}
      if(t-s.silentSince>(s.conv&&s.conv.buffer?s.conv.buffer.duration:0)+.5){try{this.pre.disconnect(s.conv);}catch(e){}s.connected=false;}}}
  dispose(){for(const s of this.slots){disconnect(s.conv);disconnect(s.gain);}disconnect(this.pre);disconnect(this.output);}
}

/* ============================================================ buses ============================================================ */
const ANY={};
/* A bus has a dry chain (input -> [env filter] -> fader -> ducker -> parent) and a mirrored reverb-send chain
   (sendIn -> sendLevel -> sendFader -> sendDucker -> parent.sendIn) so volume, mute and ducking also scale the
   reverb a bus feeds. Ducking is scheduled sample-accurately on the audio clock from a list of holds. */
class AudioBus{
  constructor(engine,name,parent,{volume=1,reverbSend=1,priority=0,envFilter=false}={}){
    this.engine=engine;this.name=name;this.parent=parent;this._volume=Math.max(0,volume);this._mute=false;this._send=reverbSend;this.priority=priority;this._holds=[];
    const ctx=engine&&engine.ctx;this.inert=!ctx;if(!ctx)return;
    const G=v=>{const g=ctx.createGain();g.gain.value=v;return g;};
    this.input=G(1);this.fader=G(this._volume);this.ducker=G(1);this.filter=null;this.envGain=null;let head=this.input;
    if(envFilter){this.filter=ctx.createBiquadFilter();this.filter.type='lowpass';this.filter.frequency.value=Math.min(20000,ctx.sampleRate*.45);this.filter.Q.value=.5;this.envGain=G(1);head.connect(this.filter);this.filter.connect(this.envGain);head=this.envGain;}
    head.connect(this.fader);this.fader.connect(this.ducker);this.ducker.connect(parent?parent.input:engine._out);
    if(parent){this.sendIn=G(1);this.sendLevel=G(reverbSend);this.sendFader=G(this._volume);this.sendDucker=G(1);
      this.sendIn.connect(this.sendLevel);this.sendLevel.connect(this.sendFader);this.sendFader.connect(this.sendDucker);this.sendDucker.connect(parent.sendIn);}
    else{this.sendIn=engine._reverbIn;this.sendLevel=this.sendFader=this.sendDucker=null;}
  }
  get volume(){return this._volume;}
  set volume(v){this.fadeTo(v,this.engine?this.engine.options.busSmoothing:.05);}
  get mute(){return this._mute;}
  set mute(m){this._mute=!!m;this.fadeTo(this._volume,.03);}
  get reverbSend(){return this._send;}
  set reverbSend(v){this._send=Math.max(0,+v||0);if(!this.inert&&this.sendLevel)rampTo(this.sendLevel.gain,this._send,this.engine.ctx.currentTime,.05);}
  fadeTo(v,seconds=.05){this._volume=Math.max(0,+v||0);if(this.inert)return this;const t=this.engine.ctx.currentTime,g=this._mute?0:this._volume;
    rampTo(this.fader.gain,g,t,seconds);if(this.sendFader)rampTo(this.sendFader.gain,g,t,seconds);return this;}
  /* Duck by `amount` (0..1 reduction) over `attack`, hold `hold` seconds (Infinity = until released by its holder,
     e.g. a looping dialogue voice), then release over `release`. Overlapping ducks combine by maximum. */
  duck(amount=.5,attack=.05,release=.5,hold=0,holder=null){if(this.inert)return this;const t=this.engine.ctx.currentTime,a=Math.max(.005,+attack||0);
    this._holds.push({amount:clamp(+amount||0,0,1),start:t,attack:a,until:hold===Infinity?Infinity:t+a+Math.max(0,+hold||0),release:Math.max(.005,+release||0),holder});
    this._schedule(t);return this;}
  /* Release every duck held by `holder` (or all ducks when holder is omitted) with their release times. */
  release(holder){this._unhold(holder===undefined?ANY:holder);return this;}
  _unhold(holder){if(this.inert||!this._holds.length)return;const t=this.engine.ctx.currentTime;let hit=false;
    for(const h of this._holds)if((holder===ANY||h.holder===holder)&&h.until>t){h.until=t;hit=true;}if(hit)this._schedule(t);}
  /* Each hold contributes a(t)=min(attack ramp, release ramp) - continuous and piecewise linear. The ducker gain is
     1-max(a) sampled at every breakpoint and scheduled as linear ramps from the value it holds now. */
  _level(t){let a=0;for(const h of this._holds){const up=h.amount*clamp((t-h.start)/h.attack,0,1),down=h.until===Infinity?h.amount:h.amount*clamp(1-(t-h.until)/h.release,0,1),v=up<down?up:down;if(v>a)a=v;}return 1-a;}
  _schedule(t){
    this._holds=this._holds.filter(h=>h.until+h.release>t);const pts=[];
    for(const h of this._holds)for(const x of [h.start+h.attack,h.until,h.until+h.release])if(x>t+1e-4&&isFinite(x))pts.push(x);
    pts.sort((x,y)=>x-y);const params=[this.ducker.gain];if(this.sendDucker)params.push(this.sendDucker.gain);
    for(const p of params){holdAt(p,t);let last=t;for(const x of pts){if(x-last<1e-4)continue;p.linearRampToValueAtTime(this._level(x),x);last=x;}
      if(!pts.length)p.linearRampToValueAtTime(this._level(t),t+.005);}
  }
  /* Duck multiplier right now (1 = not ducked). */
  get duckLevel(){return this.inert?1:this._level(this.engine.ctx.currentTime);}
  dispose(){for(const n of [this.input,this.filter,this.envGain,this.fader,this.ducker])disconnect(n);if(this.parent)for(const n of [this.sendIn,this.sendLevel,this.sendFader,this.sendDucker])disconnect(n);this._holds.length=0;}
}

/* ============================================================ voices ============================================================ */
let voiceSeq=0;
const Vec=THREE_=>THREE_&&THREE_.Vector3?new THREE_.Vector3():{x:0,y:0,z:0,set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}};
function readVec(v,out){if(!v)return false;if(Array.isArray(v)){out.x=+v[0]||0;out.y=+v[1]||0;out.z=+v[2]||0;}else{out.x=+v.x||0;out.y=+v.y||0;out.z=+v.z||0;}return true;}
/* A playing sound. Chain: source -> amp (volume/fades) -> [spatial: occlusion lowpass -> mod (distance fade *
   occlusion gain, mono downmix) -> panner] -> bus; plus a per-voice reverb send tapped before `mod` (its gain
   carries distance/occlusion so distant or occluded sources keep relatively more reverb). Inert voices (no
   context, locked, rejected by limits or cooldowns) keep the same API and do nothing. */
class AudioVoice{
  constructor(engine,o={}){
    this.engine=engine;this.id=++voiceSeq;this.seq=this.id;this.reason=o.reason||null;this.state=engine?'pending':'inert';this.name=o.name||'';
    this.bus=o.bus||null;this.priority=o.priority||0;this.loop=!!o.loop;this.volume=o.volume!=null?Math.max(0,+o.volume||0):1;this.pitch=o.pitch>0?+o.pitch:1;
    this.spatial=!!o.spatial;this.position=o.position||{x:0,y:0,z:0};this.velocity={x:0,y:0,z:0};this.follow=o.follow||null;this.offset=o.offset||null;
    this.refDistance=o.refDistance||2;this.maxDistance=o.maxDistance||60;this.rolloff=o.rolloff!=null?o.rolloff:1;this.distanceModel=o.distanceModel||'inverse';
    this.occlusion=o.occlusion!==false;this.occ=0;this.occTarget=0;this.fadeIn=Math.max(0,+o.fadeIn||0);this.startAt=Math.max(0,+o.startAt||0);this.delay=Math.max(0,+o.delay||0);
    this.reverbSend=o.reverbSend!=null?Math.max(0,+o.reverbSend||0):1;this.duck=o.duck;this.cue=null;this.stolen=false;this.virtual=false;this.buffer=null;this.source=null;this.live=null;this.patch=null;this.sentinel=null;
    this.startTime=0;this.endTime=Infinity;this.duration=0;this.onended=null;this._index=-1;this._pos=0;this._posT=0;this._rate=this.pitch;this._doppler=1;this._requested=0;
    this._px=NaN;this._py=NaN;this._pz=NaN;this._modSet=-1;this._cutSet=-1;this._sendSet=-1;this._rateSet=this.pitch;this._dx=0;this._dy=0;this._dz=-1;this.cone=false;
    this.amp=this.filter=this.mod=this.panner=this.send=this.stereo=null;this.distance=0;
    this.ready=engine?new Promise(r=>{this._ready=r;}):Promise.resolve(false);
  }
  get playing(){return this.state==='playing'||this.state==='pending';}
  get inert(){return this.state==='inert';}
  /* Seconds since the voice started (0 while pending). */
  get time(){return this.engine&&this.engine.ctx&&this.state==='playing'?Math.max(0,this.engine.ctx.currentTime-this.startTime):0;}
  /* Live generator parameters (ambience), e.g. {intensity:.5}; null for buffer voices. */
  get params(){return this.live&&this.live.params?this.live.params:null;}
  get intensity(){const p=this.params;return p&&'intensity' in p?p.intensity:undefined;}
  set intensity(v){this.set('intensity',v);}
  /* Modulate a live generator parameter (ambience intensity etc.) over `ramp` seconds. */
  set(name,value,ramp=.5){if(this.live&&this.live.set&&this.state!=='inert'&&this.state!=='ended')this.live.set(name,value,ramp);return this;}
  setVolume(v,ramp=.05){this.volume=Math.max(0,+v||0);if(this.amp&&this.state==='playing'){const t=this.engine.ctx.currentTime;rampTo(this.amp.gain,this.volume,t,ramp);this._tail(t+ramp);}return this;}
  setPitch(p,ramp=.05){this.pitch=p>0?+p:1;if(this.source&&this.state==='playing'){const r=this.pitch*this._doppler,t=this.engine.ctx.currentTime;rampTo(this.source.playbackRate,r,t,ramp);this._rateSet=r;this._retime(t,r,true);}return this;}
  setPosition(x,y,z){if(typeof x==='object'&&x)readVec(x,this.position);else{this.position.x=+x||0;this.position.y=+y||0;this.position.z=+z||0;}return this;}
  /* Fade out and stop. stop(), stop({fade:.5}) or stop(.5). */
  stop(opts){const e=this.engine;if(!e||!e.ctx||this.state==='inert'||this.state==='ended'||this.state==='stopping')return this;
    if(this.state==='pending'){this._release();return this;}
    const fade=typeof opts==='number'?opts:opts&&opts.fade!=null?+opts.fade:.04;
    const t=e.ctx.currentTime,f=Math.max(.004,fade||0);rampTo(this.amp.gain,0,t,f);this.state='stopping';e._releaseDucks(this);
    const end=t+f+.01;if(this.source)try{this.source.stop(end);}catch(err){}if(this.patch)this.patch.stop(end);if(this.sentinel)try{this.sentinel.stop(end);}catch(err){}
    if(!this.source&&!this.sentinel)this._release();return this;}
  dispose(){if(this.state!=='inert')this._release();return this;}
  /* Buffer seconds played at audio time t (tracks pitch/doppler changes). */
  _played(t){return this._pos+Math.max(0,t-this._posT)*this._rate;}
  _retime(t,r,tail){if(!this.buffer){this._rate=r;return;}this._pos=this._played(t);this._posT=t;this._rate=r;
    if(!this.loop){this.endTime=t+Math.max(0,this.buffer.duration-this._pos)/r;if(tail&&this._needsTail){rampTo(this.amp.gain,this.volume,t,.01);this._tail(t+.01);}}}
  /* User buffers may not end at zero: fade the last 5 ms (synth buffers are already edge-faded). */
  _tail(from){if(!this._needsTail||this.loop||!isFinite(this.endTime))return;const ts=this.endTime-.005;if(ts<=from)return;const g=this.amp.gain;g.setValueAtTime(this.volume,ts);g.linearRampToValueAtTime(0,this.endTime);}
  _startBuffer(buffer){const e=this.engine,ctx=e.ctx;if(this.state!=='pending')return;
    const s=ctx.createBufferSource();s.buffer=buffer;s.loop=this.loop;this._rate=this.pitch*this._doppler;s.playbackRate.value=this._rate;this._rateSet=this._rate;s.connect(this.amp);
    const off=this.loop?this.startAt%buffer.duration:Math.min(this.startAt,Math.max(0,buffer.duration-.001)),when=Math.max(ctx.currentTime,this._requested+this.delay);
    s.onended=()=>{if(this.source===s&&!this.virtual)this._release();};s.start(when,off);this.source=s;this.buffer=buffer;this._pos=off;this._posT=when;this._needsTail=!buffer.keSynth;
    this.startTime=when;this.duration=this.loop?Infinity:(buffer.duration-off)/this._rate;this.endTime=when+this.duration;
    this._attack(when,off>0||!buffer.keSynth);this._tail(when+Math.max(this.fadeIn,.004));
    this.state='playing';e._voiceStarted(this);this._ready(true);}
  _attack(when,needsFade){const f=Math.max(this.fadeIn,needsFade?.004:0),g=this.amp.gain;if(f>0){g.setValueAtTime(0,when);g.linearRampToValueAtTime(this.volume,when+f);}else g.setValueAtTime(this.volume,when);}
  /* Loop virtualisation: out-of-range buffer loops stop their source (inaudible: the distance fade is 0 there) and remember the phase. */
  _virtualize(t){if(this.virtual||!this.source)return;this.virtual=true;this._pos=this._played(t)%this.buffer.duration;this._posT=t;
    const s=this.source;s.onended=null;try{s.stop(t+.05);}catch(e){}setTimeout(()=>disconnect(s),200);this.source=null;}
  _devirtualize(t){if(!this.virtual)return;this.virtual=false;const s=this.engine.ctx.createBufferSource();s.buffer=this.buffer;s.loop=true;s.playbackRate.value=this._rate;s.connect(this.amp);
    s.onended=()=>{if(this.source===s&&!this.virtual)this._release();};s.start(t,this._pos%this.buffer.duration);this._posT=t;this.source=s;}
  _release(){if(this.state==='ended'||this.state==='inert')return;const e=this.engine,was=this.state;this.state='ended';
    if(this.source){this.source.onended=null;if(was==='playing'){try{this.source.stop();}catch(err){}}}
    if(this.sentinel){this.sentinel.onended=null;try{this.sentinel.stop();}catch(err){}}
    for(const n of [this.source,this.sentinel,this.amp,this.filter,this.mod,this.panner,this.send,this.stereo])disconnect(n);
    if(this.patch)this.patch.dispose();this.source=this.sentinel=null;this.live=null;e._removeVoice(this);e._releaseDucks(this);
    if(this.cue){const a=this.cue._instances,i=a.indexOf(this);if(i>=0)a.splice(i,1);}
    if(this._ready)this._ready(was!=='pending');if(typeof this.onended==='function'){try{this.onended(this);}catch(err){console.error(err);}}}
}
const inertVoice=reason=>new AudioVoice(null,{reason});

/* ============================================================ SoundCue ============================================================ */
/* Randomised container in the spirit of UE sound cues: variations (buffers, synth names, {synth,params}),
   pitch/volume randomisation, shuffle-bag selection without immediate repeats, cooldown and instance limits. */
/* [min,max] multipliers; a single number x means [1-x, 1+x]. */
const cueRange=(r,min)=>{if(typeof r==='number'&&isFinite(r))return [Math.max(min,1-Math.abs(r)),1+Math.abs(r)];if(Array.isArray(r)&&r.length){const a=+r[0],b=r[1]!=null?+r[1]:a;
  return [Math.max(min,isFinite(a)?a:1),Math.max(min,isFinite(b)?b:1)];}return [1,1];};
class SoundCue{
  constructor({variations=[],randomPitch=[1,1],randomVolume=[1,1],cooldown=0,maxInstances=Infinity,order='shuffle',limit='steal',volume=1,pitch=1,seed=null,name='',...defaults}={}){
    if(!Array.isArray(variations)||!variations.length)throw new RangeError('SoundCue needs at least one variation');
    this.variations=variations.slice();this.randomPitch=cueRange(randomPitch,.01);this.randomVolume=cueRange(randomVolume,0);this.cooldown=Math.max(0,+cooldown||0);
    this.maxInstances=maxInstances>0?maxInstances:Infinity;this.order=order;this.limit=limit;this.volume=volume;this.pitch=pitch;this.name=name;this.defaults=defaults;
    this._rng=KE.random(seed!=null?seed:hashStr(JSON.stringify(variations.map(v=>typeof v==='string'?v:v&&v.synth||'buffer')))+variations.length);
    this._bag=[];this._last=-1;this._seq=0;this._lastPlay=-Infinity;this._instances=[];
  }
  get instances(){this._instances=this._instances.filter(v=>v.playing);return this._instances.length;}
  /* cue.play(audio, options) is the same as audio.play(cue, options). */
  play(engine,o={}){return engine&&engine.play?engine.play(this,o):inertVoice('unavailable');}
  next(){const n=this.variations.length;if(n===1)return 0;if(this.order==='sequential')return this._last=(this._last+1)%n;
    if(this.order==='random'){let i;do{i=Math.floor(this._rng()*n);}while(i===this._last);return this._last=i;}
    if(!this._bag.length){for(let i=0;i<n;i++)this._bag.push(i);for(let i=n-1;i>0;i--){const j=Math.floor(this._rng()*(i+1));[this._bag[i],this._bag[j]]=[this._bag[j],this._bag[i]];}
      if(this._bag[this._bag.length-1]===this._last){const k=Math.floor(this._rng()*(n-1));[this._bag[this._bag.length-1],this._bag[k]]=[this._bag[k],this._bag[this._bag.length-1]];}}
    return this._last=this._bag.pop();}
  preload(engine){return engine&&engine.preload?engine.preload(this.variations):Promise.all(this.variations.map(v=>isBuffer(v)?v:typeof v==='string'?Synth.render(v):Synth.render(v.synth,v.params)));}
  /* Stop every playing instance of this cue. */
  stopAll(fade=.05){for(const v of this._instances.slice())v.stop({fade});return this;}
  _play(engine,o){o=o||{};
    const t=nowSec();if(t-this._lastPlay<this.cooldown)return inertVoice('cooldown');
    this._instances=this._instances.filter(v=>v.playing);
    if(this._instances.length>=this.maxInstances){if(this.limit==='reject')return inertVoice('cue-limit');this._instances.shift().stop({fade:.03});}
    const src=this.variations[this.next()],r=this._rng;
    const opts=Object.assign({},this.defaults,o);
    opts.pitch=(o.pitch!=null?o.pitch:this.pitch)*lerp(this.randomPitch[0],this.randomPitch[1],r());
    opts.volume=(o.volume!=null?o.volume:1)*this.volume*lerp(this.randomVolume[0],this.randomVolume[1],r());
    if(src&&src.params)opts.params=Object.assign({},src.params,o.params);
    const v=engine.play(src&&src.synth?src.synth:src,opts);
    if(!v.inert){v.cue=this;this._instances.push(v);this._lastPlay=t;}return v;}
}

/* ============================================================ ambience generators ============================================================ */
/* Each builder wires a live graph into the voice (P.out = voice amp) and returns {params, set(k,v,ramp),
   schedule(horizon)}. schedule() queues randomised events (gusts, birds, waves...) up to `horizon` on the
   audio clock; it is driven by AudioEngine.update() and an internal timer. */
const AMBIENCE={};
/* Output trims so every bed sits near -22 dBFS RMS at intensity .8 before the voice volume and bus faders. */
const AMBIENCE_LEVEL={wind:.5,rain:.55,water:.75,fire:.8,'forest-day':.9,night:2.2,stream:.55};
const ambParams=(o,defs)=>{const p={};for(const k in defs)p[k]=o[k]!=null?clamp(+o[k],0,defs[k][1]):defs[k][0];return p;};
function levelGain(P,v){const g=P.gain(v);g.connect(P.out);return g;}

AMBIENCE.wind=(P,o)=>{
  const params=ambParams(o,{intensity:[.5,1],gustiness:[.6,1]}),t=P.ctx.currentTime;
  const body=P.noise('brown',t,Infinity),bLP=P.filter('lowpass',400,.5),bG=P.gain(0);P.chain(body,bLP,bG,P.out);
  const wsrc=P.noise('pink',t,Infinity,{rate:.97}),wBP=P.filter('bandpass',900,6),wG=P.gain(0);P.chain(wsrc,wBP,wG,P.out);
  const hiss=P.noise('white',t,Infinity),hHP=P.filter('highpass',2500),hLP=P.filter('lowpass',7000),hG=P.gain(0);P.chain(hiss,hHP,hLP,hG,P.out);
  let next=t,gust=.4;
  const apply=(g,time,tau)=>{const I=params.intensity;bLP.frequency.setTargetAtTime((180+520*I)*(.55+.9*g),time,tau);bG.gain.setTargetAtTime((.3+.9*I)*(.35+.65*g),time,tau);
    wBP.frequency.setTargetAtTime((450+700*I)*(.7+.8*g),time,tau*.8);wG.gain.setTargetAtTime(1.6*I*g*g,time,tau);hG.gain.setTargetAtTime(.25*I*I*(.3+.7*g),time,tau);};
  apply(gust,t,.05);
  return {params,set(k,v,ramp=.5){if(!(k in params))return;params[k]=clamp(+v,0,1);const n=P.ctx.currentTime;
      for(const q of [bLP.frequency,bG.gain,wBP.frequency,wG.gain,hG.gain])holdAt(q,n);apply(gust,n,Math.max(.02,ramp/3));next=n+Math.max(.05,ramp*.6);},
    schedule(h,now){if(next<now)next=now;while(next<h){const G=params.gustiness,dur=P.r(.7,2.6)*(1.2-.5*G);gust=clamp((1-G)*.45+G*Math.pow(P.rng(),1.5)*1.1,0,1);apply(gust,next,dur*.4);next+=dur;}}};
};

function rainTexture(ctx,dense,variant){return texture(ctx,dense?'rain-heavy':'rain-light',dense?3.7:5.3,variant,(L,R,sr,rand,n)=>{
  const count=Math.round((dense?420:70)*n/sr);for(let i=0;i<count;i++){const r=rand(),f=1800+4200*rand();
    writePing(L,R,n,sr,Math.floor(rand()*n),f,f*(.85+.1*rand()),(.0015+.006*rand()),dense?.08+.2*r*r:.12+.8*r*r*r,rand()*1.8-.9,.6,rand);}});}
AMBIENCE.rain=(P,o)=>{
  const params=ambParams(o,{intensity:[.5,1]}),t=P.ctx.currentTime;
  const light=P.buffer(rainTexture(P.ctx,false,0),t),lHP=P.filter('highpass',300),lG=P.gain(0);P.chain(light,lHP,lG,P.out);
  const heavy=P.buffer(rainTexture(P.ctx,true,0),t),hLP=P.filter('lowpass',9000),hG=P.gain(0);P.chain(heavy,hLP,hG,P.out);
  const hiss=P.noise('white',t,Infinity),sHP=P.filter('highpass',400),sLP=P.filter('lowpass',6000),sG=P.gain(0);P.chain(hiss,sHP,sLP,sG,P.out);
  const rum=P.noise('brown',t,Infinity),rLP=P.filter('lowpass',220),rG=P.gain(0);P.chain(rum,rLP,rG,P.out);
  const apply=tau=>{const I=params.intensity,now=P.ctx.currentTime;lG.gain.setTargetAtTime(.9*Math.sqrt(I)*(1-.35*I),now,tau);hG.gain.setTargetAtTime(.8*Math.pow(I,1.4),now,tau);
    sG.gain.setTargetAtTime(.45*Math.pow(I,1.3),now,tau);sLP.frequency.setTargetAtTime(3500+5000*I,now,tau);rG.gain.setTargetAtTime(.7*I*I,now,tau);};
  apply(.05);let next=t+P.r(.1,.5);
  return {params,set(k,v,ramp=.5){if(k in params){params[k]=clamp(+v,0,1);apply(Math.max(.02,ramp/3));}},
    schedule(h,now){if(next<now)next=now+P.r(0,.3);while(next<h){const I=params.intensity;if(I>.02){const f=P.r(900,2600),d=P.r(.03,.08),o=P.osc('sine',f,next,d*2+.02),g=P.gain(0),pn=P.pan(P.r(-.8,.8));
        P.sweep(o.frequency,next,f,f*.72,d);P.chain(o,g,pn,P.out);P.perc(g.gain,next,P.r(.05,.18),.001,d);P.once(o,[o,g,pn]);}
      next+=P.r(.2,1.4)/(.5+3*I);}}};
};

AMBIENCE.water=(P,o)=>{
  const params=ambParams(o,{intensity:[.5,1],period:[6,20]}),t=P.ctx.currentTime,lvl=levelGain(P,.4+.6*params.intensity);
  const wash=P.noise('brown',t,Infinity),wLP=P.filter('lowpass',300,.6),wG=P.gain(.12);P.chain(wash,wLP,wG,lvl);
  const foam=P.noise('white',t,Infinity),fHP=P.filter('highpass',1200),fLP=P.filter('lowpass',6500),fG=P.gain(0);P.chain(foam,fHP,fLP,fG,lvl);
  const under=P.noise('brown',t,Infinity,{rate:.9}),uLP=P.filter('lowpass',150);P.chain(under,uLP,P.gain(.35),lvl);
  let next=t+.1;
  return {params,set(k,v,ramp=.5){if(!(k in params))return;params[k]=clamp(+v,0,k==='period'?20:1);if(k==='intensity')lvl.gain.setTargetAtTime(.4+.6*params.intensity,P.ctx.currentTime,Math.max(.02,ramp/3));},
    schedule(h,now){if(next<now)next=now;while(next<h){const T=Math.max(1.5,params.period)*P.r(.7,1.3),A=(.45+.55*P.rng())*(.35+.65*params.intensity),tb=next+.42*T;
      wLP.frequency.setTargetAtTime(260+1000*A,next,.2*T);wG.gain.setTargetAtTime(.9*A,next,.18*T);
      fG.gain.setTargetAtTime(.55*A,tb,.05*T);wG.gain.setTargetAtTime(.12*A,tb,.3*T);wLP.frequency.setTargetAtTime(220,tb,.3*T);fG.gain.setTargetAtTime(0,tb+.12*T,.3*T);
      next+=T;}}};
};

function crackleTexture(ctx,variant){return texture(ctx,'crackle',6.3,variant,(L,R,sr,rand,n)=>{
  const count=Math.round(14*n/sr);for(let i=0;i<count;i++){let at=Math.floor(rand()*n);const burst=rand()<.25?2+Math.floor(rand()*4):1;
    for(let b=0;b<burst;b++){const amp=Math.pow(rand(),2.5)*.9+.05,pan=rand()*1.6-.8,gl=Math.sqrt((1-pan)/2),gr=Math.sqrt((1+pan)/2);
      if(rand()<.7){const len=Math.round(sr*(.0003+.003*rand()));for(let j=0;j<len;j++){const s=(rand()*2-1)*amp*Math.exp(-4*j/len),k=(at+j)%n;L[k]+=s*gl;R[k]+=s*gr;}}
      else writePing(L,R,n,sr,at,800+1700*rand(),700+1500*rand(),.004+.015*rand(),amp*.6,pan,1,rand);
      at+=Math.round(sr*(.004+.03*rand()));}}});}
AMBIENCE.fire=(P,o)=>{
  const params=ambParams(o,{intensity:[.5,1]}),t=P.ctx.currentTime,lvl=levelGain(P,.5+.5*params.intensity);
  const roar=P.noise('brown',t,Infinity),rLP=P.filter('lowpass',380,.6),rG=P.gain(.4);P.chain(roar,rLP,rG,lvl);
  const hiss=P.noise('white',t,Infinity),hHP=P.filter('highpass',3000),hG=P.gain(.04);P.chain(hiss,hHP,hG,lvl);
  const cr=P.buffer(crackleTexture(P.ctx,0),t),cHP=P.filter('highpass',500),cG=P.gain(.8*params.intensity+.2);P.chain(cr,cHP,cG,lvl);
  let next=t,pop=t+P.r(.3,1.5);
  return {params,set(k,v,ramp=.5){if(!(k in params))return;params[k]=clamp(+v,0,1);const n=P.ctx.currentTime,tau=Math.max(.02,ramp/3);lvl.gain.setTargetAtTime(.5+.5*params.intensity,n,tau);cG.gain.setTargetAtTime(.8*params.intensity+.2,n,tau);},
    schedule(h,now){if(next<now)next=now;if(pop<now)pop=now+P.r(.1,.8);while(next<h){const d=P.r(.12,.35);rG.gain.setTargetAtTime(.25+.3*P.rng(),next,d*.4);rLP.frequency.setTargetAtTime(250+300*P.rng(),next,d*.5);hG.gain.setTargetAtTime(.02+.05*P.rng(),next,d*.3);next+=d;}
      while(pop<h){noiseHit(P,'white',pop,{type:'bandpass',freq:P.r(1200,3500),Q:3,attack:.0005,t60:P.r(.01,.04),amp:P.r(.3,1),to:lvl,pan:P.r(-.6,.6)});pop+=P.r(.4,2.5)/(.5+params.intensity);}}};
};

/* Birds: a few individual singers, each with a species, a position and a repeated song (seeded, with small
   variations) sung every few seconds; notes are FM-modulated sine whistles with pitch sweeps. */
const BIRDS={
  whistler:r=>{const n=3+Math.floor(r()*4),notes=[];let t=0,f=2200+1200*r();for(let i=0;i<n;i++){const d=.12+.13*r();notes.push([t,d,f,f*(.8+.45*r()),0,0,.7+.3*r()]);t+=d+.05+.07*r();f=clamp(f*(.85+.3*r()),1900,3600);}return notes;},
  trill:r=>{const n=8+Math.floor(r()*9),notes=[];let t=0;const f0=5200+600*r(),f1=3400+500*r();for(let i=0;i<n;i++){const u=i/(n-1),f=lerp(f0,f1,u),d=.035+.025*r();notes.push([t,d,f,f*.8,0,0,.5+.5*u]);t+=d+.015+.012*r();}return notes;},
  warble:r=>{const d=.6+.6*r(),f=2800+1400*r();return [[0,d,f,f*(.85+.3*r()),25+20*r(),300+300*r(),.8]];},
  chickadee:r=>{const a=3700+300*r();return [[0,.28,a,a*.95,0,0,.8],[.38,.32,a*.84,a*.8,0,0,.7],...(r()<.4?[[.8,.3,a*.84,a*.8,0,0,.6]]:[])];},
  dove:r=>{const f=480+140*r(),notes=[];let t=0;for(let i=0,n=3+Math.floor(r()*2);i<n;i++){const d=i===0?.45:.25+.25*r();notes.push([t,d,f*(i===1?1.08:1),f*.97,6,8,i===0?.6:.8]);t+=d+.12;}return notes;},
  chip:r=>{const n=3+Math.floor(r()*5),notes=[];let t=0;for(let i=0;i<n;i++){const f=4500+1500*r();notes.push([t,.022+.01*r(),f,f*.7,400,800,.6+.4*r()]);t+=.08+.12*r();}return notes;}
};
function singPhrase(P,out,t0,notes,{pan=0,dist=0,level=1}={}){
  const end=notes.reduce((m,n)=>Math.max(m,n[0]+n[1]),0)+.1,car=P.osc('sine',notes[0][2],t0,end),mod=P.osc('sine',Math.max(1,notes[0][4]||1),t0,end),mg=P.gain(0),g=P.gain(0),
    lp=P.filter('lowpass',12000-8000*dist,.7),pn=P.pan(pan);
  mod.connect(mg);mg.connect(car.frequency);P.chain(car,g,lp,pn,out);
  for(const [dt,d,f0,f1,mf,idx,a] of notes){const t=t0+dt,att=Math.min(.012,d*.25),rel=Math.min(.03,d*.3),amp=a*level*(1-.6*dist);
    car.frequency.setValueAtTime(f0,t);car.frequency.exponentialRampToValueAtTime(f1,t+d);if(mf)mod.frequency.setValueAtTime(mf,t);mg.gain.setValueAtTime(idx||0,t);
    g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(amp,t+att);g.gain.setValueAtTime(amp,t+d-rel);g.gain.linearRampToValueAtTime(0,t+d);}
  P.once(car,[car,mod,mg,g,lp,pn]);return t0+end;
}
AMBIENCE['forest-day']=(P,o)=>{
  const params=ambParams(o,{intensity:[.5,1],wind:[.25,1]}),t=P.ctx.currentTime;
  const leaves=P.noise('pink',t,Infinity),lBP=P.filter('bandpass',1400,.5),lG=P.gain(.05);P.chain(leaves,lBP,lG,P.out);
  const air=P.noise('brown',t,Infinity),aLP=P.filter('lowpass',260);P.chain(air,aLP,P.gain(.1),P.out);
  const species=Object.keys(BIRDS),birds=[];
  for(let i=0;i<5;i++){const sp=species[(i*3+Math.floor(P.rng()*species.length))%species.length];birds.push({sp,pan:P.r(-.9,.9),dist:P.r(0,.9),song:P.ri(1,1e6),rest:sp==='dove'?P.r(6,12):P.r(2.5,7),next:t+P.r(.3,5)});}
  let rustle=t;
  return {params,set(k,v){if(k in params)params[k]=clamp(+v,0,1);},
    schedule(h,now){if(rustle<now)rustle=now;for(const b of birds)if(b.next<now)b.next=now+P.r(.2,3);while(rustle<h){const d=P.r(1,3);lG.gain.setTargetAtTime(.02+.12*params.wind*P.rng(),rustle,d*.4);rustle+=d;}
      const I=params.intensity,active=Math.max(1,Math.round(1+4*I));
      for(let i=0;i<birds.length;i++){const b=birds[i];while(b.next<h){if(i<active&&I>.01){const r=KE.random(b.song+(P.rng()<.3?P.ri(1,3):0)),notes=BIRDS[b.sp](r);
            b.next=singPhrase(P,P.out,b.next,notes,{pan:b.pan,dist:b.dist,level:b.sp==='dove'?.5:.35});}
          b.next+=b.rest*P.r(.6,1.5)*(1.6-I);}}}};
};

AMBIENCE.night=(P,o)=>{
  const params=ambParams(o,{intensity:[.5,1]}),t=P.ctx.currentTime;
  const bed=P.noise('white',t,Infinity),bBP=P.filter('bandpass',6800,2.5),am=P.gain(.5),lvl=P.gain(.12*params.intensity+.02),lfo=P.osc('triangle',38,t,Infinity),lfoG=P.gain(.45);
  P.chain(bed,bBP,am,lvl,P.out);P.chain(lfo,lfoG,am.gain);
  const air=P.noise('brown',t,Infinity),aLP=P.filter('lowpass',180);P.chain(air,aLP,P.gain(.08),P.out);
  const crickets=[];for(let i=0;i<5;i++){const f=P.r(4300,5200),o=P.osc('sine',f,t,Infinity),g=P.gain(0),pn=P.pan(P.r(-.85,.85));P.chain(o,g,pn,P.out);
    crickets.push({g,period:P.r(.4,.9),pulses:P.ri(3,5),len:P.r(.012,.018),gap:P.r(.012,.018),amp:P.r(.05,.14),next:t+P.r(0,1)});}
  let frog=t+P.r(1,4),owl=t+P.r(8,20);
  return {params,set(k,v,ramp=.5){if(!(k in params))return;params[k]=clamp(+v,0,1);lvl.gain.setTargetAtTime(.12*params.intensity+.02,P.ctx.currentTime,Math.max(.02,ramp/3));},
    schedule(h,now){for(const c of crickets)if(c.next<now)c.next=now+P.r(0,.5);if(frog<now)frog=now+P.r(.5,3);if(owl<now)owl=now+P.r(4,15);const I=params.intensity,active=Math.round(1+4*I);
      for(let i=0;i<crickets.length;i++){const c=crickets[i];while(c.next<h){if(i<active){let tp=c.next;for(let k=0;k<c.pulses;k++){const g=c.g.gain;g.setValueAtTime(0,tp);g.linearRampToValueAtTime(c.amp,tp+.003);g.setValueAtTime(c.amp,tp+c.len-.004);g.linearRampToValueAtTime(0,tp+c.len);tp+=c.len+c.gap;}}
          c.next+=c.period*P.r(.96,1.04)+(P.rng()<.06?P.r(2,6):0);}}
      while(frog<h){if(I>.25){const d=P.r(.25,.45),f=P.r(110,170),o=P.osc('sawtooth',f,frog,d+.05),bp=P.filter('bandpass',700,2.5),g=P.gain(0),lp=P.filter('lowpass',2500),pn=P.pan(P.r(-.9,.9));
          P.chain(o,bp,g,lp,pn,P.out);const rate=P.r(18,25),a=P.r(.1,.25);let tp=frog;g.gain.setValueAtTime(0,tp);while(tp+1/rate<frog+d){g.gain.linearRampToValueAtTime(a,tp+.4/rate);g.gain.linearRampToValueAtTime(0,tp+1/rate);tp+=1/rate;}P.once(o,[o,bp,g,lp,pn]);}
        frog+=P.r(2,7)/(.3+I);}
      while(owl<h){const f=P.r(360,420),notes=[[0,.35,f,f*.94,5,6,.8],[.55,.18,f*1.02,f,5,6,.6],[.8,.42,f,f*.9,5,6,.8]];singPhrase(P,P.out,owl,notes,{pan:P.r(-.8,.8),dist:P.r(.4,.9),level:.4});owl+=P.r(14,35);}}};
};

function modTexture(ctx,variant){return texture(ctx,'stream-mod',3.1+variant*.53,variant,(L,R,sr,rand,n)=>{
  const pts=[];let k=0;while(k<n){pts.push([k,rand()*2-1]);k+=Math.round(sr/(8+16*rand()));}const m=pts.length;
  for(let i=0;i<m;i++){const [a,va]=pts[i],b=i+1<m?pts[i+1][0]:n,vb=i+1<m?pts[i+1][1]:pts[0][1];for(let j=a;j<b;j++){const u=(j-a)/(b-a),w=(1-Math.cos(Math.PI*u))/2;L[j]=va+(vb-va)*w;}}},1);}
function bubbleTexture(ctx,variant){return texture(ctx,'bubbles',4.9,variant,(L,R,sr,rand,n)=>{
  const count=Math.round(7*n/sr);for(let i=0;i<count;i++){const f=500+1100*rand();writePing(L,R,n,sr,Math.floor(rand()*n),f,f*(1.3+.7*rand()),.006+.02*rand(),.15+.6*Math.pow(rand(),2),rand()*1.6-.8);}});}
AMBIENCE.stream=(P,o)=>{
  const params=ambParams(o,{intensity:[.5,1]}),t=P.ctx.currentTime,lvl=levelGain(P,.5+.5*params.intensity);
  for(let k=0;k<4;k++){const base=P.r(450,1400),n=P.noise(k%2?'white':'pink',t,Infinity),bp=P.filter('bandpass',base,P.r(7,12)),g=P.gain(2.4),pn=P.pan(lerp(-.7,.7,k/3)+P.r(-.1,.1));
    const m=P.buffer(modTexture(P.ctx,k),t,Infinity,{rate:P.r(.8,1.25)}),mg=P.gain(base*P.r(.35,.55));P.chain(m,mg,bp.frequency);P.chain(n,bp,g,pn,lvl);}
  const flow=P.noise('pink',t,Infinity),fLP=P.filter('lowpass',900);P.chain(flow,fLP,P.gain(.22),lvl);
  const bub=P.buffer(bubbleTexture(P.ctx,0),t),bG=P.gain(.3+.4*params.intensity);P.chain(bub,bG,lvl);
  return {params,set(k,v,ramp=.5){if(!(k in params))return;params[k]=clamp(+v,0,1);const n=P.ctx.currentTime,tau=Math.max(.02,ramp/3);lvl.gain.setTargetAtTime(.5+.5*params.intensity,n,tau);bG.gain.setTargetAtTime(.3+.4*params.intensity,n,tau);},schedule(){}};
};

/* ============================================================ generative music ============================================================ */
/* Chord progressions are weighted Markov chains over degrees of a 7-note chord scale (pentatonic moods take
   chords from the parent major/minor scale and melodies from the pentatonic). Layers: pad (voice-led detuned
   chords), bass, pluck (Euclidean-rhythm arpeggio or random-walk melody), bells (modal), perc. Intensity fades
   layers in by threshold and raises density/brightness. setMood crossfades two independent sections. */
const MOODS={
  calm:{tempo:72,key:'D',scale:'pentatonic',layers:['pad','pluck','bass','bells'],barsPerChord:2,swing:.06,sevenths:.3,
    chords:{0:[[3,3],[4,2],[5,3]],3:[[0,3],[4,2],[1,1]],4:[[0,3],[5,2]],5:[[3,3],[1,1],[4,1]],1:[[4,3],[3,1]]},
    pad:{wave:'warm',cutoff:1500,attack:2.2,release:3,detune:8,level:.5},pluck:{mode:'arp',density:.55,octave:66,decay:1.1,cutoff:3200,level:.3,min:2,max:6},
    bass:{pattern:[1,0,0,0,.5,0,0,0],len:3.5,level:.55},bells:{prob:.16,decay:3,level:.22},perc:null},
  mysterious:{tempo:64,key:'A',scale:'dorian',layers:['pad','pluck','bass','bells'],barsPerChord:2,swing:0,sevenths:.5,
    chords:{0:[[6,2],[3,2],[2,1]],6:[[0,3],[3,1]],3:[[0,2],[6,1],[4,1]],2:[[3,2],[6,1]],4:[[0,2]]},
    pad:{wave:'warm',cutoff:900,attack:3,release:4,detune:12,level:.55},pluck:{mode:'melody',density:.35,octave:64,decay:1.6,cutoff:2200,level:.26,min:1,max:4},
    bass:{pattern:[1,0,0,0,0,0,0,0],len:7.5,level:.5},bells:{prob:.24,decay:4,level:.2},perc:null},
  triumphant:{tempo:96,key:'C',scale:'major',layers:['pad','pluck','bass','bells','perc'],barsPerChord:1,swing:0,sevenths:.1,
    chords:{0:[[4,3],[3,2],[5,1]],4:[[5,3],[0,2]],5:[[3,3],[1,1]],3:[[4,2],[0,2]],1:[[4,3]]},
    pad:{wave:'sawtooth',cutoff:2600,attack:.35,release:1.2,detune:10,level:.42},pluck:{mode:'arp',density:.8,octave:67,decay:.7,cutoff:4200,level:.28,min:3,max:8},
    bass:{pattern:[1,0,.6,0,1,0,.6,0],len:1.7,level:.6},bells:{prob:.12,decay:2.2,level:.18},
    perc:{kick:[1,0,0,0,1,0,0,.3],snare:[0,0,1,0,0,0,1,0],hat:[.6,.35,.6,.35,.6,.35,.6,.5],level:.5}},
  night:{tempo:56,key:'E',scale:'minor',layers:['pad','pluck','bass','bells'],barsPerChord:2,swing:0,sevenths:.4,
    chords:{0:[[5,2],[3,2],[2,1]],5:[[3,2],[6,1],[0,1]],3:[[4,2],[0,2]],4:[[0,3]],2:[[5,1],[3,1]],6:[[0,2],[2,1]]},
    pad:{wave:'soft',cutoff:800,attack:3,release:4,detune:6,level:.55},pluck:{mode:'melody',density:.22,octave:62,decay:1.8,cutoff:1800,level:.22,min:1,max:3},
    bass:{pattern:[1,0,0,0,0,0,0,0],len:7.5,level:.45},bells:{prob:.22,decay:4.5,level:.2},perc:null}
};
const LAYER_THRESHOLD={pad:0,bass:.18,pluck:.35,bells:.5,perc:.68};
/* Layer trims so the full mix sits around -20 dBFS RMS on the music bus (sustained pads/bass carry far more
   energy per note than plucks and bells). */
const MIX={pad:.25,bass:.15,pluck:1,bells:1,perc:.7};
const SENDS={pad:[.5,0],bass:[.08,0],pluck:[.35,.3],bells:[.6,.35],perc:[.15,0]};
const euclid=(k,n,i,rot=0)=>k>0&&(((i+rot)*k)%n)<k;
function periodicWave(ctx,cache,kind){let w=cache.get(kind);if(w)return w;const N=24,re=new Float32Array(N),im=new Float32Array(N);
  for(let n=1;n<N;n++){im[n]=kind==='warm'?1/Math.pow(n,1.6):kind==='pluck'?Math.abs(Math.sin(n*Math.PI/5))/Math.pow(n,1.15):kind==='soft'?(n%2?1/(n*n):0):1/n;}
  w=ctx.createPeriodicWave(re,im);cache.set(kind,w);return w;}

class MusicSection{
  constructor(music,cfg,fadeIn){
    const ctx=music.engine.ctx,P=music.patch;this.music=music;this.cfg=cfg;this.mood=cfg.mood;this.tempo=cfg.tempo;this.rng=KE.random(cfg.seed);
    this.keyPc=keyToPc(cfg.key);const sc=SCALES[cfg.scale]||SCALES.major;this.melodyScale=sc;this.chordScale=sc.length>=7?sc:cfg.scale==='minorPentatonic'?SCALES.minor:SCALES.major;
    this.melodyNotes=this._notes(sc,55,88);this.layers={};this.done=false;this.endAt=null;this.disposeAt=Infinity;this.step=0;this.baseTime=ctx.currentTime+.08;
    for(const name of cfg.layers){if(!LAYER_THRESHOLD.hasOwnProperty(name)||(name==='perc'&&!cfg.perc))continue;const g=P.gain(0),[vs,es]=SENDS[name];g.connect(music.input);
      const v=vs?P.gain(vs):null,e=es?P.gain(es):null;if(v){g.connect(v);v.connect(music.verbIn);}if(e){g.connect(e);e.connect(music.echoIn);}this.layers[name]={gain:g,verb:v,echo:e,level:0};}
    this.degree=0;this.voicing=null;this.chordPcs=null;this.arp=[];this.arpIndex=0;this.arpDir=1;this.last=this.melodyNotes[Math.floor(this.melodyNotes.length/2)];this.rot=Math.floor(this.rng()*8);
    this.fade=1;this.applyLevels(Math.max(.05,fadeIn),true);
  }
  _notes(scale,lo,hi){const out=[];for(let m=lo;m<=hi;m++){const pc=((m-this.keyPc)%12+12)%12;if(scale.includes(pc))out.push(m);}return out;}
  levelOf(name){const I=this.music._intensity;if(name==='pad')return .6+.4*I;const th=LAYER_THRESHOLD[name];return smooth01((I-th+.12)/.24);}
  applyLevels(time,linear=false){if(this.endAt!=null)return;const t=this.music.engine.ctx.currentTime;
    for(const name in this.layers){const L=this.layers[name],lv=this.levelOf(name)*this.fade;L.level=lv;if(linear)rampTo(L.gain.gain,lv,t,time);else{holdAt(L.gain.gain,t);L.gain.gain.setTargetAtTime(lv,t,time/3);}}}
  fadeOut(cf){const t=this.music.engine.ctx.currentTime;for(const name in this.layers){const L=this.layers[name];rampTo(L.gain.gain,0,t,cf);L.level=0;}this.endAt=t+cf;this.disposeAt=t+cf+6;}
  on(name){const L=this.layers[name];return !!L&&this.levelOf(name)>.02;}
  pickWeighted(list){let s=0;for(const [,w] of list)s+=w;let r=this.rng()*s;for(const [d,w] of list){r-=w;if(r<=0)return d;}return list[0][0];}
  nextChord(){const opts=this.cfg.chords[this.degree];this.degree=this.voicing?(opts?this.pickWeighted(opts):0):0;const cs=this.chordScale,n=cs.length,pcs=[];
    const k=this.rng()<this.cfg.sevenths?4:3;for(let i=0;i<k;i++)pcs.push((cs[(this.degree+2*i)%n]+this.keyPc)%12);this.chordPcs=pcs;this.voicing=this.voiceLead(pcs);
    const lo=this.cfg.pluck?this.cfg.pluck.octave-3:60,arp=[];for(let m=lo;m<=lo+19;m++)if(pcs.includes(m%12))arp.push(m);this.arp=arp;if(this.arpIndex>=arp.length)this.arpIndex=0;}
  /* Choose the inversion/register of the chord that moves the pad voices the least. */
  voiceLead(pcs){const prev=this.voicing;let best=null,bestCost=Infinity;
    for(let inv=0;inv<pcs.length;inv++)for(let base=50;base<=62;base++){const notes=[];let m=base-1;
      for(let k=0;k<pcs.length;k++){const pc=pcs[(inv+k)%pcs.length];m++;while(((m%12)+12)%12!==pc)m++;notes.push(m);}
      if(notes[notes.length-1]>79)continue;const mean=notes.reduce((a,b)=>a+b,0)/notes.length;
      let cost=Math.abs(mean-63)*.35;if(prev){for(let i=0;i<Math.min(prev.length,notes.length);i++)cost+=Math.abs(notes[i]-prev[i]);}if(cost<bestCost){bestCost=cost;best=notes;}}
    return best;}
  melodyNext(strong){const tones=this.chordPcs,last=this.last;let tot=0;const W=this.music._w;W.length=0;
    for(const m of this.melodyNotes){if(Math.abs(m-last)>7){W.push(0);continue;}let w=Math.exp(-Math.abs(m-last)/2.5);if(tones.includes(m%12))w*=strong?3:1.6;if(m===last)w*=.25;if(m<60||m>84)w*=.3;W.push(w);tot+=w;}
    let r=this.rng()*tot;for(let i=0;i<W.length;i++){r-=W[i];if(r<=0){this.last=this.melodyNotes[i];return this.last;}}return last;}
  arpNext(){const a=this.arp;if(!a.length)return this.last;let i=this.arpIndex+this.arpDir;if(i>=a.length||i<0){this.arpDir*=-1;i=clamp(this.arpIndex+this.arpDir,0,a.length-1);}this.arpIndex=i;return this.last=a[i];}
  schedule(h,now=-Infinity){const cfg=this.cfg;while(true){const stepDur=30/this.tempo,t=this.baseTime+(this.step%2?cfg.swing*stepDur:0);if(t>=h)break;
      if(this.endAt!=null&&t>=this.endAt){this.done=true;break;}
      if(t<now-.03){if(this.step%8===0&&Math.floor(this.step/8)%cfg.barsPerChord===0)this.nextChord();}   // late (stalled timer): skip, keep harmony moving
      else this.playStep(this.step,t,stepDur);this.step++;this.baseTime+=stepDur;}}
  playStep(s,t,sd){const cfg=this.cfg,m=this.music,bs=s%8,bar=Math.floor(s/8),I=m._intensity,r=this.rng;
    if(bs===0&&bar%cfg.barsPerChord===0){this.nextChord();if(this.on('pad'))m._pad(this,t,sd*8*cfg.barsPerChord,this.voicing);}
    if(bs%2===0&&m.onBeat){try{m.onBeat(s/2,t,this.mood);}catch(e){console.error(e);}}
    const root=this.chordPcs[0];
    if(cfg.bass&&this.on('bass')){const pv=cfg.bass.pattern[bs];if(pv&&r()<Math.min(1,pv+.25*I)){let n=36+((root-36)%12+12)%12;if(n>47)n-=12;if(bs===4&&r()<.35)n+=7;m._bass(this,t,n,sd*cfg.bass.len,.8+.2*(bs===0?1:r()));}}
    if(cfg.pluck&&this.on('pluck')){const k=Math.round(lerp(cfg.pluck.min,cfg.pluck.max,cfg.pluck.density*(.35+.65*I)));if(euclid(k,8,bs,this.rot)&&r()<.93){const note=cfg.pluck.mode==='arp'?this.arpNext():this.melodyNext(bs%2===0);m._pluck(this,t,note,bs%4===0?.95:.65+.25*r());}}
    if(cfg.bells&&this.on('bells')&&bs%2===0&&r()<cfg.bells.prob*(.5+I)){const hi=[];for(let q=76;q<=91;q++)if(this.chordPcs.includes(q%12)||(r()<.15&&this.melodyScale.includes(((q-this.keyPc)%12+12)%12)))hi.push(q);
      if(hi.length)m._bell(this,t+(r()<.3?sd:0),hi[Math.floor(r()*hi.length)],.6+.4*r());}
    if(cfg.perc&&this.on('perc')){const p=cfg.perc;if(p.kick[bs]&&r()<p.kick[bs]+.2)m._kick(this,t,.9);if(p.snare[bs]&&r()<p.snare[bs])m._snare(this,t,.7);if(p.hat[bs]&&r()<p.hat[bs]+.2*I)m._hat(this,t,.35+.3*r(),bs===7&&r()<.3);}}
  dispose(){for(const name in this.layers){const L=this.layers[name];disconnect(L.gain);disconnect(L.verb);disconnect(L.echo);for(const n of [L.gain,L.verb,L.echo])if(n)this.music.patch.nodes.delete(n);}this.layers={};}
}

class Music{
  constructor(engine,o={}){
    this.engine=engine;this._intensity=clamp(o.intensity!=null?+o.intensity:.5,0,1);this._volume=o.volume!=null?Math.max(0,+o.volume):1;this.sections=[];this.onBeat=null;this.notes=0;this.counts={pad:0,bass:0,pluck:0,bells:0,perc:0};this._w=[];
    const ctx=engine&&engine.ctx;this.state=ctx?'playing':'inert';this._mood=MOODS[o.mood]?o.mood:'calm';if(!ctx)return;
    const P=this.patch=new Patch(ctx,null,o.seed!=null?o.seed:hashStr(this._mood)+voiceSeq,true);this._waves=new Map();
    this.input=P.gain(this._volume);this.input.connect(engine._bus(o.bus||'music').input);
    this.verbIn=P.gain(1);const conv=P.add(ctx.createConvolver());conv.normalize=false;conv.buffer=impulseResponse(ctx,'hall',Math.min(3,engine.irSeconds));P.chain(this.verbIn,conv,P.gain(.6),this.input);
    this.echoIn=P.gain(1);this.echo=P.delay(.5,2);const fl=P.filter('lowpass',2800,.5),fb=P.gain(.36),ret=P.gain(.55);P.chain(this.echoIn,this.echo,fl,fb,this.echo);this.echo.connect(ret);ret.connect(this.input);
    this._start(this._mood,o,o.fadeIn!=null?+o.fadeIn:2);engine._musics.push(this);engine._ensureTimer();
  }
  get playing(){return this.state==='playing';}
  get mood(){return this._mood;}
  get intensity(){return this._intensity;}
  set intensity(v){this._intensity=clamp(+v||0,0,1);for(const s of this.sections)s.applyLevels(2.4);}
  get volume(){return this._volume;}
  set volume(v){this._volume=Math.max(0,+v||0);if(this.input&&this.state==='playing')rampTo(this.input.gain,this._volume,this.engine.ctx.currentTime,.2);}
  get tempo(){const s=this.current;return s?s.tempo:0;}
  set tempo(v){const s=this.current;if(s&&v>0){s.tempo=clamp(+v,30,220);this._echoTime(s.tempo);}}
  get current(){for(let i=this.sections.length-1;i>=0;i--)if(this.sections[i].endAt==null)return this.sections[i];return null;}
  _start(mood,o,fadeIn){const base=MOODS[mood];const cfg={...base,...o,mood,pad:{...base.pad,...(o.pad||{})},pluck:base.pluck&&{...base.pluck,...(o.pluck||{})},
      layers:(o.layers||base.layers).slice(),tempo:clamp(+(o.tempo||base.tempo),30,220),key:o.key!=null?o.key:base.key,scale:o.scale||base.scale,seed:(o.seed!=null?o.seed:hashStr(mood))+this.sections.length*7919+voiceSeq};
    const s=new MusicSection(this,cfg,fadeIn);this.sections.push(s);this._echoTime(cfg.tempo);return s;}
  _echoTime(tempo){if(this.echo)this.echo.delayTime.setTargetAtTime(.75*60/tempo,this.engine.ctx.currentTime,.3);}
  /* Crossfade to a new mood (a fresh section with that mood's defaults plus overrides). */
  setMood(mood,crossfade=4,overrides={}){if(this.state!=='playing')return this;if(!MOODS[mood])throw new RangeError('Unknown music mood "'+mood+'"');
    const cf=Math.max(.05,+crossfade||0);for(const s of this.sections)if(s.endAt==null)s.fadeOut(cf);this._mood=mood;this._start(mood,overrides,cf);return this;}
  stop(fade=2){if(this.state!=='playing')return this;const t=this.engine.ctx.currentTime,f=Math.max(.02,+fade||0);rampTo(this.input.gain,0,t,f);for(const s of this.sections)if(s.endAt==null){s.endAt=t+f;s.disposeAt=t+f+.2;}
    this.state='stopping';this._stopAt=t+f+.25;return this;}
  _schedule(h,t){if(this.state==='inert'||this.state==='ended')return;
    for(let i=this.sections.length-1;i>=0;i--){const s=this.sections[i];if(!s.done)s.schedule(h,t);if(t>s.disposeAt){s.dispose();this.sections.splice(i,1);}}
    if(this.state==='stopping'&&t>=this._stopAt)this.dispose();}
  _wave(kind){return kind==='sawtooth'||kind==='triangle'||kind==='sine'||kind==='square'?kind:periodicWave(this.engine.ctx,this._waves,kind);}
  _budget(){return this.patch.sources.size<this.engine.quality.musicNotes*3;}
  _pad(sec,t,dur,notes){if(!this._budget())return;const P=this.patch,cfg=sec.cfg.pad,L=sec.layers.pad,I=this._intensity,f=P.filter('lowpass',cfg.cutoff*.35,.8),env=P.gain(0),pl=P.pan(-.6),pr=P.pan(.6),nodes=[f,env,pl,pr];
    const stop=t+dur+cfg.release+.05,w=this._wave(cfg.wave);let first=null;
    for(const m of notes){const hz=midiToHz(m);for(const side of [-1,1]){const o=P.osc(w,hz,t,stop-t,side*cfg.detune*(.7+.3*sec.rng()));o.connect(side<0?pl:pr);nodes.push(o);first=first||o;}}
    pl.connect(f);pr.connect(f);P.chain(f,env,L.gain);f.frequency.setValueAtTime(cfg.cutoff*.35,t);f.frequency.setTargetAtTime(cfg.cutoff*(.7+.6*I),t,cfg.attack*.6);
    P.asr(env.gain,t,MIX.pad*cfg.level/Math.sqrt(notes.length*2),cfg.attack,dur,cfg.release);P.once(first,nodes);this.notes++;this.counts.pad++;}
  _pluck(sec,t,m,vel){if(!this._budget())return;const P=this.patch,cfg=sec.cfg.pluck,L=sec.layers.pluck,hz=midiToHz(m),o=P.osc(this._wave('pluck'),hz,t,cfg.decay+.1),f=P.filter('lowpass',cfg.cutoff,1.2),g=P.gain(0),pn=P.pan(sec.rng()*.9-.45);
    f.frequency.setValueAtTime(cfg.cutoff*(.7+.5*vel)*(.8+.4*this._intensity),t);f.frequency.exponentialRampToValueAtTime(Math.max(hz*1.5,300),t+.35);P.chain(o,f,g,pn,L.gain);P.perc(g.gain,t,cfg.level*vel,.004,cfg.decay);P.once(o,[o,f,g,pn]);this.notes++;this.counts.pluck++;}
  _bass(sec,t,m,dur,vel){if(!this._budget())return;const P=this.patch,cfg=sec.cfg.bass,L=sec.layers.bass,hz=midiToHz(m),o=P.osc('sine',hz,t,dur+.4),o2=P.osc('triangle',hz,t,dur+.4),g2=P.gain(.35),f=P.filter('lowpass',520,.8),g=P.gain(0);
    o.connect(f);P.chain(o2,g2,f);P.chain(f,g,L.gain);P.asr(g.gain,t,MIX.bass*cfg.level*vel,.015,dur*.85,.25);P.once(o,[o,o2,g2,f,g]);this.notes++;this.counts.bass++;}
  _bell(sec,t,m,vel){if(!this._budget())return;const P=this.patch,cfg=sec.cfg.bells,L=sec.layers.bells,hz=midiToHz(m),pn=P.pan(sec.rng()*1.2-.6),nodes=[pn];let first=null;
    for(const [r,a,d] of [[1,1,1],[2,.3,.6],[2.756,.22,.45],[5.404,.07,.25]]){const fr=hz*r;if(fr>P.sr*.42)continue;const o=P.osc('sine',fr,t,cfg.decay*d+.1),g=P.gain(0);P.chain(o,g,pn);P.perc(g.gain,t,cfg.level*vel*a,.002,cfg.decay*d);nodes.push(o,g);first=first||o;}
    pn.connect(L.gain);P.once(first,nodes);this.notes++;this.counts.bells++;}
  _kick(sec,t,vel){const P=this.patch,L=sec.layers.perc,o=P.osc('sine',150,t,.45),g=P.gain(0);P.sweep(o.frequency,t,150,46,.09);P.chain(o,g,L.gain);P.perc(g.gain,t,MIX.perc*sec.cfg.perc.level*vel,.002,.32);P.once(o,[o,g]);this.counts.perc++;}
  _snare(sec,t,vel){const P=this.patch,L=sec.layers.perc,n=P.noise('white',t,.25),f=P.filter('bandpass',1900,.8),g=P.gain(0),o=P.osc('sine',190,t,.15),og=P.gain(0);
    P.chain(n,f,g,L.gain);P.chain(o,og,L.gain);P.perc(g.gain,t,MIX.perc*sec.cfg.perc.level*vel*.6,.001,.16);P.perc(og.gain,t,MIX.perc*sec.cfg.perc.level*vel*.3,.001,.08);P.once(n,[n,f,g]);P.once(o,[o,og]);this.counts.perc++;}
  _hat(sec,t,vel,open){const P=this.patch,L=sec.layers.perc,n=P.noise('white',t,open?.3:.08),f=P.filter('highpass',7500),g=P.gain(0),pn=P.pan(.25);P.chain(n,f,g,pn,L.gain);P.perc(g.gain,t,MIX.perc*sec.cfg.perc.level*vel*.35,.001,open?.25:.05);P.once(n,[n,f,g,pn]);this.counts.perc++;}
  dispose(){if(this.state==='inert'||this.state==='ended')return;this.state='ended';for(const s of this.sections)s.dispose();this.sections.length=0;if(this.patch)this.patch.dispose();
    const a=this.engine._musics,i=a.indexOf(this);if(i>=0)a.splice(i,1);}
}

/* ============================================================ AudioEngine ============================================================ */
/* Auto-ducking rules keyed by the bus a voice plays on (inherited by sub-buses): dialogue ducks music, ambience
   and effects while it plays. Per-voice `duck` options add ad-hoc ducking (see play()). */
const DEFAULT_DUCKING={
  voice:{targets:{music:.55,ambience:.35,sfx:.15},attack:.08,release:.6,threshold:0}
};
const SMOOTH_POS=.015;   // time constant for panner/listener motion (removes zipper noise from per-frame steps)
const BUS_DEFAULTS={master:{},world:{},music:{reverbSend:0,priority:10},ui:{reverbSend:0,priority:3},sfx:{reverbSend:.5,priority:1},ambience:{reverbSend:.2,priority:8},voice:{reverbSend:.35,priority:6}};

class AudioEngine{
  constructor(a,b){
    const THREE_=a&&a.Vector3?a:(typeof window!=='undefined'&&window.THREE)||null,o=(a&&a.Vector3?b:a)||{};
    this.THREE=THREE_;this.options={volume:1,context:null,maxVoices:null,panningModel:null,distanceModel:'inverse',refDistance:2,maxDistance:60,rolloff:1,
      doppler:0,speedOfSound:343,autoUnlock:true,busSmoothing:.05,ducking:DEFAULT_DUCKING,latencyHint:'interactive',sampleRate:undefined,limiter:'softclip',suspendWhenHidden:false,...o};
    this.ctx=null;this._disposed=false;this._unlocked=false;this.voices=[];this._dying=new Set();this._musics=[];this._live=[];this.buses={};this._timer=0;this._lastTick=0;
    this._stolen=0;this._rejected=0;this._variant={};this._warnedBus={};this._occluder=null;this._occCursor=0;this.occlusionCutoff=650;this.occlusionAttenuation=.65;this.occlusionRate=8;
    this.listener={x:0,y:0,z:0,fx:0,fy:0,fz:-1,ux:0,uy:1,uz:0,vx:0,vy:0,vz:0,_init:false};this._from=Vec(THREE_);this._to=Vec(THREE_);this.ducking={};this.setDucking(this.options.ducking);
    this._applyQuality();
    try{
      if(this.options.context){this.ctx=this.options.context;this._ownsContext=false;}
      else{const C=ACtor();if(C){const opts={latencyHint:this.options.latencyHint};if(this.options.sampleRate)opts.sampleRate=this.options.sampleRate;this.ctx=new C(opts);this._ownsContext=true;}}
    }catch(e){this.ctx=null;}
    if(!this.ctx)return;
    this.offline=isOffline(this.ctx);if(this.ctx.state==='running'||this.offline)this._unlocked=true;
    try{this._build();}catch(e){console.warn('KE.AudioEngine: audio graph construction failed; audio disabled',e);try{this._teardown();}catch(err){}
      if(this._ownsContext&&this.ctx.close)this.ctx.close().catch(()=>{});this.ctx=null;return;}
    if(!this.offline&&this.options.autoUnlock&&!this._unlocked&&typeof window!=='undefined')this._installUnlock();
    if(!this.offline&&this.options.suspendWhenHidden&&typeof document!=='undefined'){this._onVis=()=>{if(document.hidden)this.ctx.suspend();else if(this._unlocked)this.ctx.resume();};document.addEventListener('visibilitychange',this._onVis);}
    if(KE.events&&KE.events.on)this._offSettings=KE.events.on('settings',()=>this._applyQuality());
  }
  _build(){const ctx=this.ctx;
    // output: master -> soft-clip safety limiter (or compressor) -> destination
    this._out=ctx.createGain();this._limiter=null;
    if(this.options.limiter==='compressor'){const c=ctx.createDynamicsCompressor();c.threshold.value=-6;c.knee.value=4;c.ratio.value=12;c.attack.value=.003;c.release.value=.2;this._limiter=c;this._out.connect(c);c.connect(ctx.destination);}
    // no oversampling: the curve output is strictly within +-1 (oversampling filters can overshoot); the mix rarely reaches the knee
    else if(this.options.limiter){const H=4,pre=this._out,sh=ctx.createWaveShaper();pre.gain.value=1/H;sh.curve=softClipCurve(.85,H);sh.oversample='none';pre.connect(sh);sh.connect(ctx.destination);this._limiter=sh;}
    else this._out.connect(ctx.destination);
    this._reverbIn=ctx.createGain();
    const mk=(name,parent,extra)=>this.buses[name]=new AudioBus(this,name,parent,{...BUS_DEFAULTS[name],...extra});
    const master=mk('master',null,{volume:this.options.volume});
    this.reverb=new ReverbSystem(this,this._reverbIn,master.input);
    const world=mk('world',master,{envFilter:true});mk('music',master);mk('ui',master);mk('sfx',world);mk('ambience',world);mk('voice',world);
  }
  get world(){return this.buses.world;}
  /* True while the audio clock advances (automation scheduled now will actually play out). */
  _clock(){return !!this.ctx&&this.ctx.state==='running';}
  _applyQuality(){const q=this.quality=quality();this.maxVoices=this.options.maxVoices>0?this.options.maxVoices|0:q.maxVoices;this.panningModel=this.options.panningModel||(q.hrtf?'HRTF':'equalpower');
    this.occlusionChecks=q.occlusionChecks;this.irSeconds=q.irSeconds;}
  _installUnlock(){const h=()=>{this.unlock();};this._unlockHandler=h;for(const ev of ['pointerdown','keydown','touchend','mousedown'])window.addEventListener(ev,h,{capture:true,passive:true});}
  _removeUnlock(){if(!this._unlockHandler)return;for(const ev of ['pointerdown','keydown','touchend','mousedown'])window.removeEventListener(ev,this._unlockHandler,{capture:true});this._unlockHandler=null;}
  get state(){if(!this.ctx||this._disposed)return 'unavailable';if(this.offline)return 'running';const s=this.ctx.state;if(s==='running'){this._unlocked=true;return 'running';}if(s==='closed')return 'unavailable';return this._unlocked?'suspended':'locked';}
  get context(){return this.ctx;}
  get currentTime(){return this.ctx?this.ctx.currentTime:0;}
  get sampleRate(){return this.ctx?this.ctx.sampleRate:0;}
  /* Resume the context from a user gesture. Resolves true when running; never hangs (resume() may stay pending without activation). */
  async unlock(){if(!this.ctx||this._disposed)return false;if(this.offline)return true;const ctx=this.ctx;
    try{if(ctx.state!=='running')await Promise.race([ctx.resume(),new Promise(r=>setTimeout(r,400))]);}catch(e){}
    if(ctx.state==='running'){if(!this._primed){this._primed=true;try{const s=ctx.createBufferSource();s.buffer=ctx.createBuffer(1,1,ctx.sampleRate);s.connect(ctx.destination);s.onended=()=>disconnect(s);s.start();}catch(e){}}
      this._unlocked=true;this._removeUnlock();return true;}return false;}
  suspend(){return this.ctx&&!this.offline&&this.ctx.state==='running'?this.ctx.suspend().then(()=>true,()=>false):Promise.resolve(false);}
  resume(){return this.unlock();}
  bus(name){const b=this.buses[name];if(b)return b;if(!this.ctx)return new AudioBus(null,name,null);throw new RangeError('Unknown audio bus "'+name+'"');}
  _bus(name){const b=this.buses[name];if(b)return b;if(!this._warnedBus[name]){this._warnedBus[name]=true;console.warn('KE.AudioEngine: unknown bus "'+name+'", using "sfx"');}return this.buses.sfx;}
  /* Add a custom sub-bus, e.g. createBus('footsteps',{parent:'sfx',volume:.8}). */
  createBus(name,{parent='sfx',volume=1,reverbSend=1,priority}={}){if(!this.ctx)return new AudioBus(null,name,null);if(this.buses[name])throw new Error('Audio bus "'+name+'" exists');
    const p=this.bus(parent);return this.buses[name]=new AudioBus(this,name,p,{volume,reverbSend,priority:priority!=null?priority:p.priority});}
  /* Rules: {triggerBus:{targets:{bus:amount},attack,release,threshold}}; false/{} disables auto-ducking. */
  setDucking(rules){this.ducking={};if(rules)for(const k of Object.keys(rules)){const r=rules[k];if(r&&r.targets)this.ducking[k]={attack:.05,release:.5,threshold:0,...r,targets:{...r.targets}};}return this;}

  /* ---------- listener ---------- */
  /* Manual listener placement (when there is no camera): position, forward and up as vectors or [x,y,z]. */
  setListener(position,forward,up,dt=0){const L=this.listener,p=this._from,f=this._lf||(this._lf={x:0,y:0,z:-1}),u=this._lu||(this._lu={x:0,y:1,z:0});readVec(position,p);
    if(forward)readVec(forward,f);else{f.x=0;f.y=0;f.z=-1;}if(up)readVec(up,u);else{u.x=0;u.y=1;u.z=0;}
    this._setListener(p.x,p.y,p.z,f.x,f.y,f.z,u.x,u.y,u.z,dt);return L;}
  _setListener(px,py,pz,fx,fy,fz,ux,uy,uz,dt){const L=this.listener;
    if(dt>0&&L._init){const ivx=(px-L.x)/dt,ivy=(py-L.y)/dt,ivz=(pz-L.z)/dt,sp=Math.sqrt(ivx*ivx+ivy*ivy+ivz*ivz),k=1-Math.exp(-12*dt);
      if(sp<this.options.speedOfSound*.5){L.vx+=(ivx-L.vx)*k;L.vy+=(ivy-L.vy)*k;L.vz+=(ivz-L.vz)*k;}else{L.vx=L.vy=L.vz=0;}}
    const moved=!L._init||Math.abs(px-L.x)+Math.abs(py-L.y)+Math.abs(pz-L.z)>1e-5,turned=!L._init||Math.abs(fx-L.fx)+Math.abs(fy-L.fy)+Math.abs(fz-L.fz)+Math.abs(ux-L.ux)+Math.abs(uy-L.uy)+Math.abs(uz-L.uz)>1e-5;
    const first=!L._init;L.x=px;L.y=py;L.z=pz;L.fx=fx;L.fy=fy;L.fz=fz;L.ux=ux;L.uy=uy;L.uz=uz;L._init=true;if(!this.ctx)return;const l=this.ctx.listener,t=this.ctx.currentTime,snap=first||dt<=0||!this._clock();
    if(moved){if(l.positionX){setP(l.positionX,px,t,snap);setP(l.positionY,py,t,snap);setP(l.positionZ,pz,t,snap);}else if(l.setPosition)l.setPosition(px,py,pz);}
    if(turned){if(l.forwardX){setP(l.forwardX,fx,t,snap);setP(l.forwardY,fy,t,snap);setP(l.forwardZ,fz,t,snap);setP(l.upX,ux,t,snap);setP(l.upY,uy,t,snap);setP(l.upZ,uz,t,snap);}else if(l.setOrientation)l.setOrientation(fx,fy,fz,ux,uy,uz);}}
  _updateListener(camera,dt){if(camera.updateWorldMatrix)camera.updateWorldMatrix(true,false);const e=camera.matrixWorld.elements;
    let fx=-e[8],fy=-e[9],fz=-e[10],ux=e[4],uy=e[5],uz=e[6];const fl=Math.sqrt(fx*fx+fy*fy+fz*fz)||1,ul=Math.sqrt(ux*ux+uy*uy+uz*uz)||1;
    this._setListener(e[12],e[13],e[14],fx/fl,fy/fl,fz/fl,ux/ul,uy/ul,uz/ul,dt);}

  /* ---------- per-frame update ---------- */
  /* Listener follows the camera; spatial voices follow objects, get distance fades, smoothed occlusion,
     distance-scaled reverb sends and optional doppler; reverb zones blend; generators schedule ahead.
     Idle frames (nothing moved) allocate nothing and schedule no automation. */
  update(dt=0,camera=null){if(!this.ctx||this._disposed)return;dt=dt>0&&dt<1?dt:dt>=1?1:0;const t=this.ctx.currentTime;
    if(camera&&camera.matrixWorld)this._updateListener(camera,dt);
    const V=this.voices;
    if(this._occluder&&V.length){let budget=this.occlusionChecks,k=0;const n=V.length,L=this.listener;
      for(;k<n&&budget>0;k++){const v=V[(this._occCursor+k)%n];if(!v.spatial||!v.occlusion||v.virtual||v.state!=='playing')continue;budget--;
        this._from.x=L.x;this._from.y=L.y;this._from.z=L.z;this._to.x=v.position.x;this._to.y=v.position.y;this._to.z=v.position.z;
        let o=0;try{o=+this._occluder(this._from,this._to,v);}catch(err){o=0;}v.occTarget=o>0?(o<1?o:1):0;}
      this._occCursor=(this._occCursor+k)%Math.max(1,n);}
    for(let i=V.length-1;i>=0;i--){const v=V[i];if(v.spatial&&v.state!=='pending')this._spatial(v,dt,t,false);
      if(!v.loop&&v.state==='playing'&&v.source&&t>v.endTime+1)v._release();}   // safety net if onended never fired
    this.reverb.update(dt,this.listener);this._tick();}
  _distanceGain(v,d){const ref=v.refDistance,r=v.rolloff;if(v.distanceModel==='linear')return 1-r*(clamp(d,ref,v.maxDistance)-ref)/Math.max(1e-3,v.maxDistance-ref);
    if(v.distanceModel==='exponential')return Math.pow(Math.max(d,ref)/ref,-r);return ref/(ref+r*(Math.max(d,ref)-ref));}
  _spatial(v,dt,t,init){const L=this.listener,p=v.position;let nx=p.x,ny=p.y,nz=p.z;
    if(v.follow){const o=v.follow;if(o.updateWorldMatrix)o.updateWorldMatrix(true,false);const e=o.matrixWorld&&o.matrixWorld.elements;
      if(e){nx=e[12];ny=e[13];nz=e[14];if(v.offset){nx+=v.offset.x;ny+=v.offset.y;nz+=v.offset.z;}if(v.panner&&v.cone){const l=Math.sqrt(e[8]*e[8]+e[9]*e[9]+e[10]*e[10])||1;v._dx=e[8]/l;v._dy=e[9]/l;v._dz=e[10]/l;}}}
    if(dt>0&&this.options.doppler>0){const ivx=(nx-p.x)/dt,ivy=(ny-p.y)/dt,ivz=(nz-p.z)/dt,sp=Math.sqrt(ivx*ivx+ivy*ivy+ivz*ivz),k=1-Math.exp(-10*dt);
      if(sp<this.options.speedOfSound*.5){v.velocity.x+=(ivx-v.velocity.x)*k;v.velocity.y+=(ivy-v.velocity.y)*k;v.velocity.z+=(ivz-v.velocity.z)*k;}}
    p.x=nx;p.y=ny;p.z=nz;const snap=init||!this._clock();
    const pn=v.panner;if(pn&&(init||Math.abs(nx-v._px)+Math.abs(ny-v._py)+Math.abs(nz-v._pz)>1e-5)){v._px=nx;v._py=ny;v._pz=nz;const ps=snap||dt<=0;
      if(pn.positionX){setP(pn.positionX,nx,t,ps);setP(pn.positionY,ny,t,ps);setP(pn.positionZ,nz,t,ps);}else pn.setPosition(nx,ny,nz);
      if(v.cone){if(pn.orientationX){setP(pn.orientationX,v._dx,t,ps);setP(pn.orientationY,v._dy,t,ps);setP(pn.orientationZ,v._dz,t,ps);}else pn.setOrientation(v._dx,v._dy,v._dz);}}
    const dx=nx-L.x,dy=ny-L.y,dz=nz-L.z,d=Math.sqrt(dx*dx+dy*dy+dz*dz),max=v.maxDistance,fs=max*.85;v.distance=d;
    const fade=d<=fs?1:d>=max?0:1-smooth01((d-fs)/(max-fs));
    if(v.occlusion){if(init)v.occ=v.occTarget;else if(dt>0)v.occ+=(v.occTarget-v.occ)*(1-Math.exp(-this.occlusionRate*dt));}
    const occ=v.occ,mod=fade*(1-this.occlusionAttenuation*occ);
    if(init||Math.abs(mod-v._modSet)>.004||(mod===0&&v._modSet!==0)){glide(v.mod.gain,mod,t,.04,snap);v._modSet=mod;}
    if(v.filter){const nyq=this.ctx.sampleRate*.45,cut=Math.min(nyq,20000*Math.pow(this.occlusionCutoff/20000,occ));
      if(init||Math.abs(cut/v._cutSet-1)>.03){glide(v.filter.frequency,cut,t,.04,snap);v._cutSet=cut;}}
    if(v.send){const s=v.reverbSend*fade*Math.sqrt(Math.max(0,this._distanceGain(v,d)))*(1-.5*this.occlusionAttenuation*occ);if(init||Math.abs(s-v._sendSet)>.004){glide(v.send.gain,s,t,.05,snap);v._sendSet=s;}}
    if(this.options.doppler>0&&v.source&&d>1e-3){const ux=-dx/d,uy=-dy/d,uz=-dz/d,c=this.options.speedOfSound,vs=v.velocity.x*ux+v.velocity.y*uy+v.velocity.z*uz,vl=L.vx*ux+L.vy*uy+L.vz*uz;
      const ratio=clamp((c-vl)/Math.max(1,c-vs),.5,2);v._doppler=1+(ratio-1)*this.options.doppler;const r=v.pitch*v._doppler;
      if(Math.abs(r/v._rateSet-1)>.002){v.source.playbackRate.setTargetAtTime(r,t,.06);v._rateSet=r;v._retime(t,r,false);}}
    if(v.loop&&v.buffer&&!v.live&&v.state==='playing'){if(!v.virtual&&d>max*1.05)v._virtualize(t);else if(v.virtual&&d<max)v._devirtualize(t);}else v.virtual=d>max;}
  _tick(){if(!this.ctx||this._disposed)return;const t=this.ctx.currentTime,now=nowSec(),gap=this._lastTick?now-this._lastTick:0;this._lastTick=now;
    const h=t+Math.min(3,Math.max(LOOKAHEAD,gap*1.6));const A=this._live;
    for(let i=0;i<A.length;i++){const v=A[i];if(v.live&&v.live.schedule&&v.state==='playing')v.live.schedule(h,t);}
    const M=this._musics;for(let i=M.length-1;i>=0;i--)M[i]._schedule(h,t);
    if(this._timer&&!A.length&&!M.length){clearInterval(this._timer);this._timer=0;}}
  _ensureTimer(){if(this.offline||this._timer||!this.ctx||typeof setInterval==='undefined')return;this._timer=setInterval(()=>this._tick(),100);}

  /* ---------- voices ---------- */
  _admit(priority){if(this.voices.length<this.maxVoices)return true;let victim=null;
    for(const v of this.voices){if(v.priority>priority)continue;if(!victim||(v.virtual!==victim.virtual?v.virtual:v.priority!==victim.priority?v.priority<victim.priority:v.seq<victim.seq))victim=v;}
    if(!victim){this._rejected++;return false;}this._steal(victim);return true;}
  _steal(v){this._stolen++;v.stolen=true;this._removeVoice(v);if(v.state==='pending'){v._release();return;}this._dying.add(v);const done=v.onended;v.onended=x=>{this._dying.delete(x);if(typeof done==='function')done(x);};v.stop({fade:.025});}
  _removeVoice(v){const i=v._index,V=this.voices;if(i>=0&&V[i]===v){const last=V.pop();if(last!==v){V[i]=last;last._index=i;}}v._index=-1;
    const j=this._live.indexOf(v);if(j>=0)this._live.splice(j,1);this._dying.delete(v);}
  /* Ducking for a starting voice: its bus rule, or the voice's own `duck` option (number = amount on the rule's
     targets or on 'music'; object = {targets, attack, release}; false = never). Held for the voice's lifetime. */
  _voiceStarted(v){const d=v.duck;if(d===false)return;let rule=this._duckRule(v.bus);
    if(d&&typeof d==='object')rule={attack:.05,release:.5,threshold:0,...d,targets:d.targets||{music:.5}};else if(typeof d==='number'&&!rule)rule={targets:{music:d},attack:.05,release:.5,threshold:0};
    if(!rule||v.volume<rule.threshold)return;const hold=v.loop||v.live?Infinity:Math.max(0,v.endTime-this.ctx.currentTime-rule.attack);
    for(const name in rule.targets){const b=this.buses[name];if(!b)continue;let up=false;for(let p=v.bus;p;p=p.parent)if(p===b){up=true;break;}if(up)continue;
      const amount=typeof d==='number'?d:rule.targets[name];if(amount>0)b.duck(amount,rule.attack,rule.release,hold,v);}}
  _releaseDucks(v){for(const k in this.buses)this.buses[k]._unhold(v);}
  _duckRule(bus){for(let b=bus;b;b=b.parent)if(this.ducking[b.name])return this.ducking[b.name];return null;}
  /* Build the node chain for a new voice and register it. */
  _voice(o,busName){const ctx=this.ctx,bus=this._bus(busName),priority=o.priority!=null?+o.priority:bus.priority;
    if(!this._admit(priority))return inertVoice('limit');
    const pos=Vec(this.THREE),spatial=o.spatial!=null?!!o.spatial:!!(o.position||o.follow);if(o.position)readVec(o.position,pos);let offset=null;if(o.offset){offset={x:0,y:0,z:0};readVec(o.offset,offset);}
    const v=new AudioVoice(this,{...o,bus,priority,spatial,position:pos,offset,refDistance:o.refDistance||this.options.refDistance,maxDistance:o.maxDistance||this.options.maxDistance,
      rolloff:o.rolloff!=null?o.rolloff:this.options.rolloff,distanceModel:o.distanceModel||this.options.distanceModel});
    v._requested=ctx.currentTime;v.amp=ctx.createGain();v.amp.gain.value=0;let tail=v.amp;
    if(spatial){if(v.occlusion){v.filter=ctx.createBiquadFilter();v.filter.type='lowpass';v.filter.Q.value=.5;v.filter.frequency.value=Math.min(20000,ctx.sampleRate*.45);tail.connect(v.filter);tail=v.filter;}
      v.mod=ctx.createGain();v.mod.channelCount=1;v.mod.channelCountMode='explicit';v.mod.channelInterpretation='speakers';tail.connect(v.mod);tail=v.mod;
      const pn=v.panner=ctx.createPanner();pn.panningModel=o.panningModel||this.panningModel;pn.distanceModel=v.distanceModel;pn.refDistance=v.refDistance;pn.maxDistance=v.maxDistance;pn.rolloffFactor=v.rolloff;
      if(o.cone){v.cone=true;pn.coneInnerAngle=o.cone.inner!=null?o.cone.inner:90;pn.coneOuterAngle=o.cone.outer!=null?o.cone.outer:220;pn.coneOuterGain=o.cone.outerGain!=null?o.cone.outerGain:.3;
        if(o.direction){const q={x:0,y:0,z:-1};readVec(o.direction,q);const l=Math.hypot(q.x,q.y,q.z)||1;v._dx=q.x/l;v._dy=q.y/l;v._dz=q.z/l;}}
      tail.connect(pn);pn.connect(bus.input);
      if(bus.sendIn){v.send=ctx.createGain();v.send.gain.value=0;(v.filter||v.amp).connect(v.send);v.send.connect(bus.sendIn);}
      this._spatial(v,0,ctx.currentTime,true);
      if(this._occluder&&v.occlusion){this._from.x=this.listener.x;this._from.y=this.listener.y;this._from.z=this.listener.z;this._to.x=pos.x;this._to.y=pos.y;this._to.z=pos.z;
        let oc=0;try{oc=+this._occluder(this._from,this._to,v);}catch(e){}v.occTarget=v.occ=clamp(oc||0,0,1);this._spatial(v,0,ctx.currentTime,true);}}
    else{if(o.pan!=null&&ctx.createStereoPanner){v.stereo=ctx.createStereoPanner();v.stereo.pan.value=clamp(+o.pan,-1,1);tail.connect(v.stereo);tail=v.stereo;}
      tail.connect(bus.input);if(bus.sendIn&&bus.reverbSend>0&&v.reverbSend>0){v.send=ctx.createGain();v.send.gain.value=v.reverbSend;tail.connect(v.send);v.send.connect(bus.sendIn);}}
    v._index=this.voices.length;this.voices.push(v);return v;}
  _synthParams(name,a,b){const def=RECIPES.get(name),p={};for(const k of Object.keys(def.defaults)){if(b&&b[k]!==undefined)p[k]=b[k];else if(a&&a[k]!==undefined)p[k]=a[k];}
    if(p.seed===undefined&&def.variants>1){const c=this._variant[name]=(this._variant[name]||0)+1;p.seed=1+(c-1)%def.variants;}return p;}
  /* play(source, options) -> AudioVoice. source: AudioBuffer | synth name | KE.Synth.<name>(params) / {synth,params} |
     Promise<AudioBuffer> | KE.SoundCue. Synth sources render once per (params, sample rate) and are cached; while a
     render is pending the voice is 'pending' and starts as soon as the buffer exists. */
  play(source,o={}){if(!this.ctx||this._disposed)return inertVoice('unavailable');o=o||{};
    if(source instanceof SoundCue)return source._play(this,o);
    let buffer=null,name=null,params=null,promise=null;
    if(isBuffer(source))buffer=source;
    else if(typeof source==='string'){if(!RECIPES.has(source))throw new RangeError('Unknown synth "'+source+'"');name=source;params=this._synthParams(name,o,o.params);}
    else if(source&&typeof source==='object'&&typeof source.synth==='string'){if(!RECIPES.has(source.synth))throw new RangeError('Unknown synth "'+source.synth+'"');name=source.synth;params=this._synthParams(name,source.params,o.params);}
    else if(source&&typeof source.then==='function')promise=source;
    else throw new TypeError('AudioEngine.play: source must be an AudioBuffer, a synth name, KE.Synth.<name>(params) / {synth,params}, a Promise<AudioBuffer> or a KE.SoundCue');
    if(this.state==='locked'&&!o.loop&&!o.force)return inertVoice('locked');   // one-shots requested before unlock are dropped, not queued
    const v=this._voice({...o,name:name||(promise?'promise':'buffer')},o.bus||'sfx');if(v.inert)return v;
    if(buffer){v._startBuffer(buffer);return v;}
    const sr=this.ctx.sampleRate,hit=name&&Synth.get(name,params,sr);if(hit){v._startBuffer(hit);return v;}
    (promise||Synth.render(name,params,{sampleRate:sr})).then(b=>{if(v.state==='pending'&&!this._disposed&&isBuffer(b))v._startBuffer(b);else v._release();},
      err=>{console.warn('KE.AudioEngine: sound failed to render',err);v._release();});
    return v;}
  /* Render synth buffers ahead of time at this context's rate: names, KE.Synth.<name>(params), {synth,params},
     SoundCues or buffers. Without an explicit seed every variation of the recipe is rendered (play() cycles them). */
  preload(items=[]){if(!this.ctx)return Promise.resolve([]);const sr=this.ctx.sampleRate,jobs=[];
    const add=(name,params={})=>{const def=RECIPES.get(name);if(!def){jobs.push(Promise.reject(new RangeError('Unknown synth "'+name+'"')));return;}
      if(params.seed===undefined&&def.variants>1)for(let k=1;k<=def.variants;k++)jobs.push(Synth.render(name,{...params,seed:k},{sampleRate:sr}));else jobs.push(Synth.render(name,params,{sampleRate:sr}));};
    for(const it of [].concat(items)){if(it instanceof SoundCue)jobs.push(this.preload(it.variations));else if(typeof it==='string')add(it);
      else if(it&&typeof it.synth==='string')add(it.synth,it.params||{});else if(isBuffer(it))jobs.push(Promise.resolve(it));}
    return Promise.all(jobs);}
  /* Live generative ambience loop returned as a voice; voice.set('intensity', v) modulates it in real time. */
  ambience(name,o={}){if(!this.ctx||this._disposed)return inertVoice('unavailable');const build=AMBIENCE[name];if(!build)throw new RangeError('Unknown ambience "'+name+'"');
    const v=this._voice({priority:8,...o,loop:true,name},o.bus||'ambience');if(v.inert)return v;const ctx=this.ctx;
    const trim=ctx.createGain();trim.gain.value=AMBIENCE_LEVEL[name]||1;trim.connect(v.amp);
    v.patch=new Patch(ctx,trim,o.seed!=null?o.seed:hashStr(name)+v.id*101,true);v.patch.add(trim);v.live=build(v.patch,o);
    const s=ctx.createConstantSource?ctx.createConstantSource():ctx.createBufferSource();if(s.offset)s.offset.value=0;s.connect(v.amp);s.onended=()=>v._release();s.start();v.sentinel=s;
    v.fadeIn=o.fadeIn!=null?Math.max(0,+o.fadeIn):1.5;v._attack(ctx.currentTime,true);v.startTime=ctx.currentTime;v.duration=Infinity;v.state='playing';this._live.push(v);this._voiceStarted(v);v._ready(true);
    v.live.schedule(ctx.currentTime+LOOKAHEAD,ctx.currentTime);this._ensureTimer();return v;}
  /* Generative music player (see Music). */
  music(o={}){if(!this.ctx||this._disposed)return new Music(null,o);if(o.mood&&!MOODS[o.mood])throw new RangeError('Unknown music mood "'+o.mood+'"');const m=new Music(this,o);m._schedule(this.ctx.currentTime+LOOKAHEAD,this.ctx.currentTime);return m;}
  /* Occlusion callback (from, to, voice) -> 0..1 (e.g. a physics raycast). Evaluated round-robin for a
     quality-dependent number of voices per update and smoothed; applies a lowpass and gain reduction. */
  setOcclusion(fn,{cutoff=650,attenuation=.65,rate=8}={}){this._occluder=typeof fn==='function'?fn:null;this.occlusionCutoff=clamp(+cutoff,80,20000);this.occlusionAttenuation=clamp(+attenuation,0,1);this.occlusionRate=Math.max(.1,+rate);
    if(!this._occluder)for(const v of this.voices)v.occTarget=0;return this;}
  setReverb({preset='none',wet,transition}={}){if(!this.ctx||this._disposed)return this;this.reverb.set(preset,wet,transition);return this;}
  /* Reverb zone: {center, radius} sphere or {box:{min,max}} / {center,size} box; blends in over `fade` metres. */
  addReverbZone({center=[0,0,0],radius=null,box=null,size=null,preset='cave',wet=.35,fade=null,priority=null,enabled=true}={}){
    if(!(preset in REVERB_PRESETS))throw new RangeError('Unknown reverb preset "'+preset+'"');const c={x:0,y:0,z:0};readVec(center,c);
    const z={id:++voiceSeq,preset,wet:clamp(+wet,0,2),enabled,weight:0,center:[c.x,c.y,c.z],radius:0,box:false,min:null,max:null,fade:0,priority:0,remove:()=>this.removeReverbZone(z)};
    if(box||size){const mn={x:0,y:0,z:0},mx={x:0,y:0,z:0};if(box){readVec(box.min,mn);readVec(box.max,mx);}else{const s={x:0,y:0,z:0};readVec(size,s);mn.x=c.x-s.x/2;mn.y=c.y-s.y/2;mn.z=c.z-s.z/2;mx.x=c.x+s.x/2;mx.y=c.y+s.y/2;mx.z=c.z+s.z/2;}
      z.box=true;z.min=[mn.x,mn.y,mn.z];z.max=[mx.x,mx.y,mx.z];const ext=Math.max(mx.x-mn.x,mx.y-mn.y,mx.z-mn.z);z.fade=fade!=null?Math.max(.01,+fade):Math.max(1,ext*.15);z.priority=priority!=null?priority:-(mx.x-mn.x)*(mx.y-mn.y)*(mx.z-mn.z);}
    else{z.radius=Math.max(0,+radius||5);z.fade=fade!=null?Math.max(.01,+fade):Math.max(1,z.radius*.3);z.priority=priority!=null?priority:-z.radius*z.radius*z.radius*4.19;}
    if(this.ctx){this.reverb.zones.push(z);this.reverb.zones.sort((a,b)=>b.priority-a.priority);}return z;}
  removeReverbZone(z){if(!this.ctx)return false;const a=this.reverb.zones,i=a.indexOf(z);if(i<0)return false;a.splice(i,1);this.reverb.evaluate(this.listener);this.reverb.apply(this.reverb.zoneSmoothing);return true;}
  stopAll({fade=.2,buses=null}={}){for(const v of this.voices.slice())if(!buses||buses.includes(v.bus.name))v.stop({fade});if(!buses||buses.includes('music'))for(const m of this._musics.slice())m.stop(fade);return this;}
  /* Output level of the final mix: {peak, rms} (linear, 0..1) over the last ~46 ms. The analyser is created on first use. */
  meter(){if(!this.ctx||this._disposed)return {peak:0,rms:0};if(!this._analyser){const a=this._analyser=this.ctx.createAnalyser();a.fftSize=2048;(this._limiter||this._out).connect(a);this._meterBuf=new Float32Array(a.fftSize);}
    const d=this._meterBuf;this._analyser.getFloatTimeDomainData(d);let pk=0,sq=0;for(let i=0;i<d.length;i++){const v=d[i],a=v<0?-v:v;if(a>pk)pk=a;sq+=v*v;}return {peak:pk,rms:Math.sqrt(sq/d.length)};}
  stats(){const s={state:this.state,voices:0,virtual:0,pending:0,total:this.voices.length,maxVoices:this.maxVoices,stolen:this._stolen,rejected:this._rejected,cachedBuffers:synthCache.size,cachedSeconds:+cacheSeconds.toFixed(2),
      ambience:this._live.length,music:this._musics.length,musicNotes:0,reverb:this.ctx?this.reverb.base.preset:'none',reverbSlots:[],zones:this.ctx?this.reverb.zones.length:0,sampleRate:this.sampleRate,currentTime:this.currentTime,panningModel:this.panningModel};
    for(const v of this.voices){if(v.state==='pending')s.pending++;else if(v.virtual)s.virtual++;else s.voices++;}
    for(const m of this._musics)s.musicNotes+=m.patch?m.patch.sources.size:0;
    if(this.ctx){for(const sl of this.reverb.slots)s.reverbSlots.push({preset:sl.preset,target:+sl.target.toFixed(3),active:sl.connected});
      s.buses={};for(const k in this.buses){const b=this.buses[k];s.buses[k]={volume:b.volume,mute:b.mute,duck:+b.duckLevel.toFixed(3)};}}return s;}
  _teardown(){for(const v of this.voices.slice())v._release();for(const v of [...this._dying])v._release();this._dying.clear();for(const m of this._musics.slice())m.dispose();
    if(this.reverb)this.reverb.dispose();for(const k in this.buses)this.buses[k].dispose();disconnect(this._reverbIn);disconnect(this._out);disconnect(this._limiter);disconnect(this._analyser);this._analyser=null;}
  dispose(){if(this._disposed)return;this._disposed=true;if(this._timer){clearInterval(this._timer);this._timer=0;}this._removeUnlock();
    if(this._onVis)document.removeEventListener('visibilitychange',this._onVis);if(this._offSettings)this._offSettings();
    if(this.ctx){this._teardown();if(this._ownsContext&&this.ctx.close)this.ctx.close().catch(()=>{});}this.voices.length=0;this._live.length=0;this._musics.length=0;this.ctx=null;}
}
AudioEngine.QUALITY=QUALITY;AudioEngine.REVERB_PRESETS=REVERB_PRESETS;AudioEngine.MOODS=MOODS;AudioEngine.SCALES=SCALES;AudioEngine.AMBIENCES=AMBIENCE;AudioEngine.DUCKING=DEFAULT_DUCKING;
AudioEngine.impulseResponse=impulseResponse;

Object.assign(KE,{AudioEngine,AudioVoice,AudioBus,SoundCue,Synth,AudioMusic:Music});
KE.registerModule('audio',{provides:['AudioEngine','AudioVoice','AudioBus','SoundCue','Synth','AudioMusic']});
})();
