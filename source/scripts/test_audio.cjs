/* Browser tests for src/modules/80-audio.js (KE.AudioEngine, KE.Synth, KE.SoundCue).
 *
 *   node source/scripts/test_audio.cjs
 *
 * Almost everything is verified by rendering the real Web Audio graph into OfflineAudioContexts that are
 * injected into KE.AudioEngine; ctx.suspend() callbacks move the camera/objects and call audio.update() at exact
 * audio times, and the rendered samples are measured (RMS windows, L/R balance, sample-to-sample steps, decay).
 * A second browser is launched with --autoplay-policy=no-user-gesture-required to check a real AudioContext.
 * Writes .test-output/audio-sheet.png (waveforms + spectrograms of synthesized sounds, ambiences and music).
 */
const path=require('path');
const {openPage,ROOT}=require('./harness.cjs');

let failed=0;
/* A stuck page.evaluate (e.g. an OfflineAudioContext that never completes) fails the stage instead of hanging the run. */
const stage=(name,promise,ms=300000)=>{let t;return Promise.race([promise,new Promise((_,rej)=>{t=setTimeout(()=>rej(new Error('stage "'+name+'" timed out after '+ms/1000+' s')),ms);})]).finally(()=>clearTimeout(t));};
const check=(name,cond,info)=>{if(cond)console.log('PASS '+name+(info!==undefined?'  '+fmt(info):''));else{failed++;console.log('FAIL '+name+(info!==undefined?'  '+fmt(info):''));}};
const fmt=v=>typeof v==='string'?v:JSON.stringify(v,(k,x)=>typeof x==='number'?+x.toPrecision(4):x);

/* In-page helpers (installed with addScriptTag). */
function pageHelpers(){
  const KE=window.KitsuneEngine,THREE=window.THREE;
  KE.settings.preset='high';   // deterministic quality tier (HRTF, 3 reverb slots, 48 voices) whatever the machine detected
  const AT=window.AT={
    /* Render `seconds` of an engine on an OfflineAudioContext. steps: [[time, fn(env,t)]]; every: update period. */
    async render({seconds,sr=44100,channels=2,engine={},setup=null,steps=[],every=0}){
      const ctx=new OfflineAudioContext(channels,Math.ceil(seconds*sr),sr);
      const audio=new KE.AudioEngine(THREE,{context:ctx,...engine});const env={ctx,audio,sr,camera:null,log:[]};
      if(setup)await setup(env);
      const q=128/sr,times=new Map(),add=(t,fn)=>{const tq=Math.round(t/q)*q;if(tq<=0||tq>=seconds-q)return;if(!times.has(tq))times.set(tq,[]);if(fn)times.get(tq).push(fn);};
      for(const [t,fn] of steps)add(t,fn);if(every>0)for(let t=every;t<seconds;t+=every)add(t,null);
      let last=0;for(const tq of [...times.keys()].sort((a,b)=>a-b)){const fns=times.get(tq);
        ctx.suspend(tq).then(async()=>{try{const dt=tq-last;last=tq;audio.update(dt,env.camera);for(const fn of fns)await fn(env,tq);}catch(e){env.error=String(e&&e.stack||e);}ctx.resume();});}
      env.buffer=await ctx.startRendering();return env;
    },
    rms(buf,t0,t1,ch=-1){const sr=buf.sampleRate,a=Math.max(0,Math.floor(t0*sr)),b=Math.min(buf.length,Math.floor(t1*sr));let s=0,n=0;
      for(let c=0;c<buf.numberOfChannels;c++){if(ch>=0&&c!==ch)continue;const d=buf.getChannelData(c);for(let i=a;i<b;i++){s+=d[i]*d[i];n++;}}return Math.sqrt(s/Math.max(1,n));},
    peak(buf,t0=0,t1=Infinity){const sr=buf.sampleRate,a=Math.max(0,Math.floor(t0*sr)),b=Math.min(buf.length,Math.floor(t1*sr));let p=0;for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);for(let i=a;i<b;i++){const v=Math.abs(d[i]);if(v>p)p=v;}}return p;},
    maxStep(buf,t0=0,t1=Infinity){const sr=buf.sampleRate,a=Math.max(1,Math.floor(t0*sr)),b=Math.min(buf.length,Math.floor(t1*sr));let p=0;for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);for(let i=a;i<b;i++){const v=Math.abs(d[i]-d[i-1]);if(v>p)p=v;}}return p;},
    /* RMS of the first difference: a crude high-frequency energy measure. */
    hf(buf,t0,t1){const sr=buf.sampleRate,a=Math.max(1,Math.floor(t0*sr)),b=Math.min(buf.length,Math.floor(t1*sr));let s=0,n=0;for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);for(let i=a;i<b;i++){const v=d[i]-d[i-1];s+=v*v;n++;}}return Math.sqrt(s/Math.max(1,n));},
    nan(buf){let n=0;for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);for(let i=0;i<d.length;i++)if(!Number.isFinite(d[i]))n++;}return n;},
    sine(ctx,freq,seconds,amp=.5,channels=1){const n=Math.round(seconds*ctx.sampleRate),b=ctx.createBuffer(channels,n,ctx.sampleRate);for(let c=0;c<channels;c++){const d=b.getChannelData(c);for(let i=0;i<n;i++)d[i]=amp*Math.sin(2*Math.PI*freq*i/ctx.sampleRate);}return b;},
    silence(ctx,seconds){return ctx.createBuffer(1,Math.round(seconds*ctx.sampleRate),ctx.sampleRate);},
    /* Schroeder energy-decay RT60 estimate from the -5..-25 dB slope (T20 * 3). */
    rt60(ir){const d=ir.getChannelData(0),n=d.length,e=new Float64Array(n+1);for(let i=n-1;i>=0;i--)e[i]=e[i+1]+d[i]*d[i];const tot=e[0];
      let a=-1,b=-1;for(let i=0;i<n;i++){const db=10*Math.log10(e[i]/tot);if(a<0&&db<=-5)a=i;if(b<0&&db<=-25){b=i;break;}}return b>0?3*(b-a)/ir.sampleRate:NaN;},
    /* Zero-crossing frequency estimate over [t0,t1] of channel 0. */
    zcr(buf,t0,t1){const d=buf.getChannelData(0),sr=buf.sampleRate,a=Math.floor(t0*sr),b=Math.floor(t1*sr);let z=0;for(let i=a+1;i<b;i++)if((d[i-1]<0)!==(d[i]<0))z++;return z/2/((b-a)/sr);},
    checksum(buf){let h=0;const d=buf.getChannelData(0);for(let i=0;i<d.length;i+=7)h=(h*31+Math.round(d[i]*1e6))|0;return h;},
  };
  /* ---------- drawing: waveform + spectrogram sheet ---------- */
  function fft(re,im){const n=re.length;for(let i=1,j=0;i<n;i++){let bit=n>>1;for(;j&bit;bit>>=1)j^=bit;j^=bit;if(i<j){[re[i],re[j]]=[re[j],re[i]];[im[i],im[j]]=[im[j],im[i]];}}
    for(let len=2;len<=n;len<<=1){const ang=-2*Math.PI/len,wr=Math.cos(ang),wi=Math.sin(ang);for(let i=0;i<n;i+=len){let cr=1,ci=0;for(let j=0;j<len/2;j++){const a=i+j,b=a+len/2,tr=re[b]*cr-im[b]*ci,ti=re[b]*ci+im[b]*cr;re[b]=re[a]-tr;im[b]=im[a]-ti;re[a]+=tr;im[a]+=ti;const nr=cr*wr-ci*wi;ci=cr*wi+ci*wr;cr=nr;}}}}
  const cmap=v=>{v=Math.max(0,Math.min(1,v));const st=[[0,[8,8,24]],[.25,[48,18,110]],[.5,[170,40,110]],[.75,[245,130,40]],[1,[252,240,170]]];for(let i=1;i<st.length;i++)if(v<=st[i][0]){const [a,ca]=st[i-1],[b,cb]=st[i],u=(v-a)/(b-a);return ca.map((x,k)=>Math.round(x+(cb[k]-x)*u));}return st[st.length-1][1];};
  AT.drawSheet=(items,{cols=4,w=1200,h=780}={})=>{
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;cv.style.cssText='position:fixed;left:0;top:0';document.body.appendChild(cv);const g=cv.getContext('2d');
    g.fillStyle='#10131a';g.fillRect(0,0,w,h);g.fillStyle='#e8ecf2';g.font='bold 15px sans-serif';g.fillText('KE.AudioEngine - synthesized sounds (waveform, spectrogram 0-11 kHz log-magnitude)',12,20);
    const rows=Math.ceil(items.length/cols),cw=w/cols,ch=(h-30)/rows;
    items.forEach((it,k)=>{const x0=(k%cols)*cw+8,y0=30+Math.floor(k/cols)*ch+4,W=cw-16,H=ch-10,buf=it.buffer,sr=buf.sampleRate;
      const mono=new Float32Array(buf.length);for(let c=0;c<buf.numberOfChannels;c++){const d=buf.getChannelData(c);for(let i=0;i<d.length;i++)mono[i]+=d[i]/buf.numberOfChannels;}
      g.fillStyle='#1a1f2b';g.fillRect(x0,y0,W,H);g.fillStyle='#cfd6e2';g.font='12px sans-serif';g.fillText(it.label+'  ('+buf.duration.toFixed(2)+' s)',x0+4,y0+13);
      const wy=y0+18,wh=Math.round((H-20)*.34),sy=wy+wh+2,sh=H-20-wh-2;
      g.strokeStyle='#5fd1c6';g.beginPath();for(let px=0;px<W;px++){const a=Math.floor(px/W*mono.length),b=Math.max(a+1,Math.floor((px+1)/W*mono.length));let mn=1,mx=-1;for(let i=a;i<b;i++){const v=mono[i];if(v<mn)mn=v;if(v>mx)mx=v;}
        g.moveTo(x0+px+.5,wy+wh/2-mx*wh/2);g.lineTo(x0+px+.5,wy+wh/2-mn*wh/2+.5);}g.stroke();
      const N=512,img=g.createImageData(Math.floor(W),sh),re=new Float32Array(N),im=new Float32Array(N),bins=N/2,maxBin=Math.floor(11025/(sr/N));
      for(let px=0;px<img.width;px++){const c=Math.floor(px/img.width*(mono.length-N));for(let i=0;i<N;i++){re[i]=(mono[c+i]||0)*(.5-.5*Math.cos(2*Math.PI*i/(N-1)));im[i]=0;}fft(re,im);
        for(let py=0;py<sh;py++){const bin=Math.min(bins-1,Math.floor((1-py/sh)*maxBin)),m=Math.hypot(re[bin],im[bin]),db=20*Math.log10(m+1e-9),v=(db+70)/75,[r,gg,b]=cmap(v),o=(py*img.width+px)*4;img.data[o]=r;img.data[o+1]=gg;img.data[o+2]=b;img.data[o+3]=255;}}
      g.putImageData(img,Math.floor(x0),Math.floor(sy));});
    return true;};
}

async function main(){
  const {page,close,errors}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/80-audio.js'],viewport:{width:1200,height:780},name:'audio'});
  page.setDefaultTimeout(600000);
  await page.addScriptTag({content:'('+pageHelpers.toString()+')();'});

  /* ---------- 1. synth library quality ---------- */
  const synth=await stage('synth',page.evaluate(async()=>{const KE=window.KitsuneEngine,AT=window.AT,S=KE.Synth,out={cases:[]};
    out.keys=Object.keys(S);out.names=S.names();
    const cases=[];for(const surface of ['grass','stone','wood','water','sand'])for(const intensity of [.3,1])cases.push(['footstep',{surface,intensity}]);
    cases.push(['chime',{note:'C5'}],['chime',{note:'G6',bell:false}],['chime',{freq:330,decay:4}],['impact',{size:.4,hardness:.9}],['impact',{size:3,hardness:.2}],['impact',{size:1.5,hardness:.7}],
      ['whoosh',{duration:.3}],['whoosh',{duration:1.5,brightness:1}],['click',{}],['click',{tone:800}],['pickup',{}],['jump',{}],['splash',{size:.4}],['splash',{size:3}],
      ['explosion',{size:.5}],['explosion',{size:3}],['thunder',{distance:0}],['thunder',{distance:1}]);
    for(const [name,p] of cases){const b=await S[name](p);const a=S.analyze(b);out.cases.push({name,p,...a,level:b.keSynth&&b.keSynth.peak});}
    // descriptor API and determinism
    const d=S.chime({note:'E5'});out.isSound=d instanceof S.SynthSound&&d.synth==='chime'&&d.params.note==='E5';
    const b1=await S.footstep({surface:'stone',seed:3}),b2=await S.render('footstep',{surface:'stone',seed:3}),b3=await S.footstep({surface:'stone',seed:4});
    out.cached=b1===b2;out.seedDiffers=AT.checksum(b1)!==AT.checksum(b3);S.clearCache();const b4=await S.footstep({surface:'stone',seed:3});
    let diff=b4.length===b1.length?0:1;for(let c=0;c<2&&!diff;c++){const x=b1.getChannelData(c),y=b4.getChannelData(c);for(let i=0;i<x.length;i++)diff=Math.max(diff,Math.abs(x[i]-y[i]));}out.rerenderDiff=diff;out.deterministic=diff<1e-4;
    const bar=await S.chime({freq:880,bell:false,decay:3});out.barFreq=AT.zcr(bar,.4,1.2);
    out.stats=S.cacheStats();return out;}));
  check('synth: Object.keys(KE.Synth) lists only recipes',synth.keys.filter(k=>k!=='sampleRate').join()===synth.names.join(),synth.keys.join(','));
  check('synth: all 10 spec recipes registered',['footstep','chime','impact','whoosh','click','pickup','jump','splash','explosion','thunder'].every(n=>synth.names.includes(n)));
  for(const c of synth.cases){const tag=c.name+' '+JSON.stringify(c.p);
    const good=c.nan===0&&c.peak>.05&&c.peak<=1&&c.rms>.003&&Math.abs(c.dc)<Math.max(.002,.05*c.rms)&&c.headPeak<.01&&c.tailPeak<.01;
    check('synth '+tag+': non-silent, finite, peak<=1, no DC, click-free edges',good,{peak:c.peak,rms:c.rms,dc:c.dc,head:c.headPeak,tail:c.tailPeak,dur:c.duration});}
  check('synth: KE.Synth.<name>() returns a playable/thenable SynthSound',synth.isSound);
  check('synth: renders are cached by params',synth.cached);
  check('synth: seeds vary, identical seeds reproduce (max diff < 1e-4 across renders)',synth.seedDiffers&&synth.deterministic,{maxDiff:synth.rerenderDiff});
  check('synth: chime({freq:880,bell:false}) sounds at 880 Hz',Math.abs(synth.barFreq/880-1)<.03,{hz:synth.barFreq});

  /* ---------- 2. spatial: listener follows a camera, panner follows an object ---------- */
  const spatial=await stage('spatial',page.evaluate(async()=>{const KE=window.KitsuneEngine,THREE=window.THREE,AT=window.AT;let v,obj;const probe={};
    const env=await AT.render({seconds:2.4,engine:{panningModel:'HRTF'},every:.1,setup(env){const {ctx,audio}=env;env.camera=new THREE.PerspectiveCamera(60,1,.1,100);
        obj=new THREE.Object3D();obj.position.set(4,0,0);audio.update(0,env.camera);
        v=audio.play(KE.Synth.noiseBuffer(ctx,'pink'),{loop:true,follow:obj,refDistance:2,maxDistance:40,volume:.6});probe.model=v.panner.panningModel;},
      steps:[[.6,()=>{obj.position.set(-4,0,0);}],[.7,env=>{probe.px=env.audio.voices[0].panner.positionX.value;}],
        [1.2,env=>{env.camera.rotation.y=Math.PI;}],[1.3,env=>{const l=env.ctx.listener;probe.fz=l.forwardZ.value;probe.lfz=env.audio.listener.fz;}],
        [1.8,()=>{obj.position.set(0,0,-100);}],[2.3,env=>{probe.virtual=v.virtual;probe.dist=v.distance;probe.stats=env.audio.stats();}]]});
    const b=env.buffer,seg=(a,c)=>({L:AT.rms(b,a,c,0),R:AT.rms(b,a,c,1)});
    return {model:probe.model,px:probe.px,fz:probe.fz,lfz:probe.lfz,virtual:probe.virtual,dist:probe.dist,s1:seg(.15,.6),s2:seg(.75,1.2),s3:seg(1.35,1.8),s4:seg(1.95,2.4),nan:AT.nan(b),error:env.error,stats:probe.stats};}));
  check('spatial: HRTF panner, no errors',spatial.model==='HRTF'&&!spatial.error&&spatial.nan===0,spatial.error||spatial.model);
  check('spatial: source on the right is louder in R',spatial.s1.R>spatial.s1.L*1.4,spatial.s1);
  check('spatial: object moved to the left follows (panner.positionX=-4, L louder)',Math.abs(spatial.px+4)<1e-3&&spatial.s2.L>spatial.s2.R*1.4,{px:spatial.px,...spatial.s2});
  check('spatial: camera turned 180 deg - listener forward +Z, source now on the right',spatial.fz>.99&&spatial.lfz>.99&&spatial.s3.R>spatial.s3.L*1.4,{fz:spatial.fz,...spatial.s3});
  check('spatial: beyond maxDistance the loop fades out and is virtualized',spatial.virtual&&spatial.s4.L+spatial.s4.R<.02*(spatial.s1.L+spatial.s1.R),{virtual:spatial.virtual,...spatial.s4,stats:{voices:spatial.stats.voices,virtual:spatial.stats.virtual}});

  /* ---------- 3. bus volume, mute and ducking over time ---------- */
  const bus=await stage('bus',page.evaluate(async()=>{const AT=window.AT;const probe={};let vox;
    const env=await AT.render({seconds:4.6,engine:{limiter:false},every:.25,setup({ctx,audio}){audio.play(AT.sine(ctx,441,1,.3),{bus:'music',loop:true});},
      steps:[[.5,({audio})=>audio.bus('music').duck(.75,.05,.3)],[1.2,({audio})=>audio.bus('music').duck(.5,.05,.2,.4)],[1.4,({audio})=>{probe.duck=audio.stats().buses.music.duck;}],
        [2.0,({audio})=>{audio.bus('music').volume=.5;}],[2.5,({audio})=>{audio.bus('music').mute=true;}],[2.8,({audio})=>{audio.bus('music').mute=false;}],
        [3.0,({ctx,audio})=>{vox=audio.play(AT.silence(ctx,1),{bus:'voice',loop:true});}],[3.6,()=>vox.stop()],[3.4,({audio})=>{probe.auto=audio.bus('music').duckLevel;}]]});
    const b=env.buffer,r=(a,c)=>AT.rms(b,a,c,0);let mn=1;for(let t=.5;t<.62;t+=.01)mn=Math.min(mn,r(t,t+.01));
    return {ref:r(.3,.45),duckMin:mn,rel1:r(.95,1.15),held:r(1.3,1.6),rel2:r(1.9,1.98),vol:r(2.15,2.45),muted:r(2.6,2.75),unmuted:r(2.9,2.98),auto:r(3.2,3.55),back:r(4.3,4.55),probe,step:AT.maxStep(b),error:env.error};}));
  const R=bus.ref;
  check('bus: duck(.75) reaches 25% within its attack',Math.abs(bus.duckMin/R-.25)<.06,{ratio:bus.duckMin/R});
  check('bus: duck releases back to full level',Math.abs(bus.rel1/R-1)<.03&&Math.abs(bus.rel2/R-1)<.03,{rel1:bus.rel1/R,rel2:bus.rel2/R});
  check('bus: duck with hold keeps 50% for the hold time',Math.abs(bus.held/R-.5)<.03&&Math.abs(bus.probe.duck-.5)<.02,{ratio:bus.held/R,duckLevel:bus.probe.duck});
  check('bus: volume=.5 halves the level',Math.abs(bus.vol/R-.5)<.03,{ratio:bus.vol/R});
  check('bus: mute silences, unmute restores volume',bus.muted/R<.01&&Math.abs(bus.unmuted/R-.5)<.03,{muted:bus.muted/R,unmuted:bus.unmuted/R});
  check('bus: a voice-bus loop auto-ducks music by 55% and releases on stop',Math.abs(bus.auto/R-.225)<.03&&Math.abs(bus.probe.auto-.45)<.02&&Math.abs(bus.back/R-.5)<.03,{during:bus.auto/R,after:bus.back/R});
  check('bus: every gain change is ramped (no sample steps above the sine slope)',bus.step<2*Math.PI*441*.3/44100*1.1,{maxStep:bus.step});

  /* ---------- 4. reverb presets ---------- */
  const verb=await stage('verb',page.evaluate(async()=>{const KE=window.KitsuneEngine,AT=window.AT,out={rt:{},tail:{}};const ctx=new OfflineAudioContext(2,44100,44100);
    for(const p of ['room','forest','hall','cave','underwater']){const ir=KE.AudioEngine.impulseResponse(ctx,p,8);out.rt[p]={rt:AT.rt60(ir),want:KE.AudioEngine.REVERB_PRESETS[p].decay,nan:AT.nan(ir)};}
    const click=await KE.Synth.click({},{sampleRate:44100});
    for(const p of ['none','room','hall','cave']){const env=await AT.render({seconds:3,every:.25,setup({audio}){audio.setReverb({preset:p,wet:.6,transition:0});audio.play(click);}});
      out.tail[p]={early:AT.rms(env.buffer,.05,.3),late:AT.rms(env.buffer,.8,1.3),peak:AT.peak(env.buffer),nan:AT.nan(env.buffer)};}
    // preset switch crossfades two convolver slots
    const env=await AT.render({seconds:1.5,every:.1,setup({audio}){audio.setReverb({preset:'hall',wet:.4,transition:0});},
      steps:[[.5,({audio})=>audio.setReverb({preset:'cave',wet:.5,transition:1})],[.6,(env)=>{env.slots=env.audio.stats().reverbSlots;}]]});
    out.slots=env.slots;return out;}));
  for(const [p,r] of Object.entries(verb.rt))check('reverb IR '+p+': RT60 matches the preset decay (+-35%)',r.nan===0&&Math.abs(r.rt/r.want-1)<.35,r);
  check('reverb: decay ordering room < hall < cave',verb.rt.room.rt<verb.rt.hall.rt&&verb.rt.hall.rt<verb.rt.cave.rt);
  check('reverb: none has no tail; room < hall < cave tails',verb.tail.none.late<1e-4&&verb.tail.room.late<verb.tail.hall.late&&verb.tail.hall.late<verb.tail.cave.late&&verb.tail.cave.peak<=1,
    Object.fromEntries(Object.entries(verb.tail).map(([k,v])=>[k,v.late])));
  check('reverb: preset switch crossfades two slots',verb.slots.filter(s=>s.preset==='hall'&&s.target===0).length===1&&verb.slots.filter(s=>s.preset==='cave'&&s.target===.5).length===1,verb.slots);

  /* ---------- 5. reverb zones, occlusion ---------- */
  const zones=await stage('zones',page.evaluate(async()=>{const KE=window.KitsuneEngine,THREE=window.THREE,AT=window.AT,out={};let occ=0,v;
    await AT.render({seconds:1.2,every:.1,setup(env){env.camera=new THREE.PerspectiveCamera();const a=env.audio;
        a.setReverb({preset:'forest',wet:.3,transition:.2});a.addReverbZone({center:[20,0,0],radius:5,fade:4,preset:'cave',wet:.6});a.addReverbZone({center:[0,0,40],size:[10,10,10],preset:'hall',wet:.5});
        a.addReverbZone({center:[-30,0,0],radius:4,preset:'underwater',wet:.5});},
      steps:[[.2,env=>{out.origin=env.audio.stats().reverbSlots;env.camera.position.set(27,0,0);}],[.3,env=>{out.edge=env.audio.stats().reverbSlots;env.camera.position.set(20,0,0);}],
        [.4,env=>{out.inside=env.audio.stats().reverbSlots;env.camera.position.set(0,0,40);}],[.7,env=>{out.box=env.audio.stats().reverbSlots;env.camera.position.set(-30,0,0);}],
        [.8,env=>{out.under=env.audio.reverb.dryLowpass;}]]});
    const pick=(slots,p)=>{const s=slots.find(x=>x.preset===p);return s?s.target:0;};
    out.r={origin:[pick(out.origin,'forest'),pick(out.origin,'cave')],edge:[pick(out.edge,'forest'),pick(out.edge,'cave')],inside:[pick(out.inside,'forest'),pick(out.inside,'cave')],box:pick(out.box,'hall'),under:out.under};
    const env=await AT.render({seconds:2,every:.05,setup(env){env.camera=new THREE.PerspectiveCamera();env.audio.setOcclusion(()=>occ);
        v=env.audio.play(KE.Synth.noiseBuffer(env.ctx,'pink'),{loop:true,position:[0,0,-5],maxDistance:50});},steps:[[1,()=>{occ=1;}],[1.95,()=>{out.occ=v.occ;}]]});
    out.clear=AT.rms(env.buffer,.4,.95);out.occluded=AT.rms(env.buffer,1.5,1.95);out.hfClear=AT.hf(env.buffer,.4,.95);out.hfOcc=AT.hf(env.buffer,1.5,1.95);return out;}));
  check('zones: outside all zones only the base preset (forest .3) sounds',Math.abs(zones.r.origin[0]-.3)<.01&&zones.r.origin[1]===0,zones.r.origin);
  check('zones: at the fade edge base and zone blend',zones.r.edge[0]>.02&&zones.r.edge[1]>.02,zones.r.edge);
  check('zones: inside a sphere zone its preset takes over',Math.abs(zones.r.inside[1]-.6)<.01&&zones.r.inside[0]===0,zones.r.inside);
  check('zones: box zones work',Math.abs(zones.r.box-.5)<.01,zones.r.box);
  check('zones: underwater zone lowpasses the dry world bus',zones.r.under<1000,zones.r.under);
  check('occlusion: smoothed toward the callback value',zones.occ>.95,zones.occ);
  check('occlusion: level drops and highs are filtered',zones.occluded/zones.clear<.45&&(zones.hfOcc/zones.occluded)<.5*(zones.hfClear/zones.clear),{level:zones.occluded/zones.clear,hfClear:zones.hfClear/zones.clear,hfOcc:zones.hfOcc/zones.occluded});

  /* ---------- 6. voices: stealing, click-free stop, cues ---------- */
  const voices=await stage('voices',page.evaluate(async()=>{const KE=window.KitsuneEngine,AT=window.AT,out={};
    const ctx=new OfflineAudioContext(2,44100,44100),a=new KE.AudioEngine(window.THREE,{context:ctx,maxVoices:4}),sil=AT.silence(ctx,1),vs=[];
    for(const p of [1,2,3,4])vs.push(a.play(sil,{loop:true,priority:p}));
    const v5=a.play(sil,{loop:true,priority:5});out.stolen1=vs[0].stolen;out.state1=vs[0].state;
    const v0=a.play(sil,{loop:true,priority:0});out.rejected=v0.inert&&v0.reason==='limit';
    const v3=a.play(sil,{loop:true,priority:3});out.stolen2=vs[1].stolen&&!vs[2].stolen;const st=a.stats();out.stats={voices:st.voices,total:st.total,stolen:st.stolen,rejected:st.rejected};
    out.inertApi=(()=>{try{v0.stop();v0.setVolume(.3);v0.setPitch(2);v0.dispose();return !v0.playing;}catch(e){return String(e);}})();
    a.dispose();
    // click-free stop, fade-in, tail fade of an arbitrary user buffer
    const env0={};const env=await AT.render({seconds:1.3,engine:{limiter:false},setup({ctx,audio}){env0.v=audio.play(AT.sine(ctx,441,1,.5),{loop:true});audio.play(AT.sine(ctx,441,.3013,.5),{startAt:0,delay:.7});},
      steps:[[.5,()=>env0.v.stop({fade:.05})],[.3,()=>env0.v.setVolume(.2,.05)],[.4,()=>env0.v.setVolume(1,.02)]]});
    const b=env.buffer;out.first=Math.abs(b.getChannelData(0)[0]);out.step=AT.maxStep(b);out.after=AT.rms(b,.58,.68);out.oneshot=AT.rms(b,.75,.95);out.end=AT.rms(b,1.02,1.3);
    // SoundCue
    const ctx2=new OfflineAudioContext(2,44100,44100),a2=new KE.AudioEngine(window.THREE,{context:ctx2});
    const cue=new KE.SoundCue({variations:['click',{synth:'chime',params:{note:'C6'}},KE.Synth.pickup({note:'E5'})],randomPitch:[.9,1.1],randomVolume:.2,maxInstances:2});
    await cue.preload(a2);const seq=[],pitches=[],vols=[];for(let i=0;i<9;i++){const v=a2.play(cue);seq.push(cue._last);pitches.push(v.pitch);vols.push(v.volume);}
    out.cue={repeats:seq.some((x,i)=>i&&x===seq[i-1]),all:new Set(seq).size,pitch:[Math.min(...pitches),Math.max(...pitches)],vol:[Math.min(...vols),Math.max(...vols)],instances:cue.instances};
    const cd=new KE.SoundCue({variations:['click'],cooldown:10});const c1=cd.play(a2),c2=cd.play(a2);out.cooldown=!c1.inert&&c2.inert&&c2.reason==='cooldown';
    const rj=new KE.SoundCue({variations:['click'],maxInstances:1,limit:'reject'});const r1=a2.play(rj),r2=a2.play(rj);out.reject=!r1.inert&&r2.inert&&r2.reason==='cue-limit';
    a2.dispose();
    KE.settings.preset='low';const lo=new KE.AudioEngine(window.THREE,{context:new OfflineAudioContext(2,4410,44100)});out.low={panning:lo.panningModel,maxVoices:lo.maxVoices,slots:lo.reverb.slots.length};lo.dispose();KE.settings.preset='high';
    return out;}));
  check('voices: lowest priority stolen at the limit',voices.stolen1&&voices.state1!=='playing'&&voices.stats.voices===4,{state:voices.state1,stats:voices.stats});
  check('voices: lower-priority request rejected when all voices outrank it',voices.rejected);
  check('voices: next steal takes the lowest remaining priority',voices.stolen2&&voices.stats.stolen===2&&voices.stats.rejected===1,voices.stats);
  check('voices: inert voices keep the full API',voices.inertApi===true,voices.inertApi);
  check('voices: fade-in, setVolume ramps, stop fade and user-buffer tail are click-free',voices.first<1e-3&&voices.step<2*Math.PI*441*.5/44100*1.1&&voices.after<1e-4&&voices.oneshot>.2&&voices.end<1e-4,
    {first:voices.first,maxStep:voices.step,afterStop:voices.after,oneshot:voices.oneshot,end:voices.end});
  check('cue: shuffle bag uses all variations without immediate repeats',!voices.cue.repeats&&voices.cue.all===3,voices.cue);
  check('cue: random pitch/volume within range, maxInstances enforced',voices.cue.pitch[0]>=.9&&voices.cue.pitch[1]<=1.1&&voices.cue.pitch[1]>voices.cue.pitch[0]&&voices.cue.vol[0]>=.8-1e-9&&voices.cue.vol[1]<=1.2+1e-9&&voices.cue.instances<=2,voices.cue);
  check('cue: cooldown and reject limits return inert voices',voices.cooldown&&voices.reject);
  check('quality: low preset uses equal-power panning, fewer voices and 2 reverb slots',voices.low.panning==='equalpower'&&voices.low.maxVoices===24&&voices.low.slots===2,voices.low);

  /* ---------- 7. ambience generators ---------- */
  const amb=await stage('amb',page.evaluate(async()=>{const AT=window.AT,out={};
    for(const name of ['wind','rain','water','fire','forest-day','night','stream']){let v;const env=await AT.render({seconds:4,every:.2,setup({audio}){v=audio.ambience(name,{intensity:.8,fadeIn:.3,seed:7});},
        steps:[[3.9,env=>{out[name+'_stats']=env.audio.stats().ambience;}]]});
      out[name]={rms:AT.rms(env.buffer,.5,4),peak:AT.peak(env.buffer),nan:AT.nan(env.buffer),step:AT.maxStep(env.buffer,0,.3),params:v.params,error:env.error};}
    let rv;const env=await AT.render({seconds:4,every:.2,setup({audio}){rv=audio.ambience('rain',{intensity:.1,fadeIn:.2});},steps:[[2,()=>{rv.intensity=1;}]]});
    out.mod={low:AT.rms(env.buffer,.8,1.9),high:AT.rms(env.buffer,3,3.9),value:rv.intensity};
    let wv;const env2=await AT.render({seconds:3,every:.2,setup({audio}){wv=audio.ambience('wind',{intensity:.9,fadeIn:.2});},steps:[[1.5,()=>wv.stop({fade:.5})]]});
    out.stop={before:AT.rms(env2.buffer,1,1.5),after:AT.rms(env2.buffer,2.2,3),state:wv.state,step:AT.maxStep(env2.buffer,1.45,2.2)};return out;}));
  for(const n of ['wind','rain','water','fire','forest-day','night','stream']){const r=amb[n];check('ambience '+n+': audible, finite, peak<=1, live params',r.rms>.004&&r.peak<=1&&r.nan===0&&!r.error&&r.params&&'intensity' in r.params,{rms:r.rms,peak:r.peak});}
  check('ambience: voice.intensity modulates live (rain .1 -> 1)',amb.mod.high>1.6*amb.mod.low&&amb.mod.value===1,amb.mod);
  check('ambience: stop({fade}) fades out and ends the voice',amb.stop.after<1e-4&&amb.stop.state==='ended'&&amb.stop.before>.01,amb.stop);

  /* ---------- 8. generative music ---------- */
  const mus=await stage('mus',page.evaluate(async()=>{const AT=window.AT,out={};
    for(const mood of ['calm','mysterious','triumphant','night']){let m;const env=await AT.render({seconds:8,every:.25,setup({audio}){m=audio.music({mood,intensity:.9,seed:3});}});
      out[mood]={rms:AT.rms(env.buffer,1,8),peak:AT.peak(env.buffer),nan:AT.nan(env.buffer),counts:{...m.counts},tempo:m.tempo,error:env.error};}
    let m;const env=await AT.render({seconds:9,every:.25,setup({audio}){m=audio.music({mood:'triumphant',intensity:0,seed:5});},
      steps:[[3,()=>{out.lowCounts={...m.counts};m.intensity=1;}],[6,()=>{out.highCounts={...m.counts};m.setMood('night',1.5);out.sections=m.sections.length;}],[8.9,()=>{out.mood=m.mood;out.after=m.sections.length;}]]});
    out.low=out.lowCounts;out.gain={perc:out.highCounts.perc-out.lowCounts.perc,pluck:out.highCounts.pluck-out.lowCounts.pluck};
    let m2;const env2=await AT.render({seconds:4,every:.25,setup({audio}){m2=audio.music({mood:'calm'});},steps:[[1.5,()=>m2.stop(1)]]});
    out.stop={after:AT.rms(env2.buffer,2.8,4),state:m2.state};return out;}));
  for(const mood of ['calm','mysterious','triumphant','night']){const r=mus[mood];check('music '+mood+': plays notes, audible, finite, peak<=1',r.rms>.005&&r.peak<=1&&r.nan===0&&!r.error&&r.counts.pad>0&&r.counts.bass>0&&r.counts.pluck>0,{rms:r.rms,peak:r.peak,counts:r.counts});}
  check('music: triumphant has percussion',mus.triumphant.counts.perc>0,mus.triumphant.counts);
  check('music: intensity 0 plays only the pad; raising it adds layers',mus.low.perc===0&&mus.low.pluck===0&&mus.low.pad>0&&mus.gain.perc>0&&mus.gain.pluck>0,{low:mus.low,added:mus.gain});
  check('music: setMood crossfades two sections, then keeps the new mood',mus.sections===2&&mus.mood==='night',{sections:mus.sections,mood:mus.mood,after:mus.after});
  check('music: stop(fade) silences and ends',mus.stop.after<1e-4&&mus.stop.state==='ended',mus.stop);

  /* ---------- 9. dispose, unavailable context ---------- */
  const life=await stage('life',page.evaluate(async()=>{const KE=window.KitsuneEngine,THREE=window.THREE,AT=window.AT,out={};
    const env=await AT.render({seconds:1.2,every:.1,setup({ctx,audio}){audio.setReverb({preset:'cave',wet:.8,transition:0});audio.play(AT.sine(ctx,300,1,.3),{loop:true});audio.ambience('rain',{fadeIn:.05});audio.music({mood:'calm',fadeIn:.1});},
      steps:[[.5,env=>{env.audio.dispose();out.state=env.audio.state;out.inert=env.audio.play('click').inert;}]]});
    out.before=AT.rms(env.buffer,.2,.5);out.after=AT.peak(env.buffer,.52,1.2);
    const saved=[window.AudioContext,window.webkitAudioContext];window.AudioContext=undefined;window.webkitAudioContext=undefined;let a;
    try{a=new KE.AudioEngine(THREE,{volume:.8});out.unavailable=a.state;const cam=new THREE.PerspectiveCamera();
      const v=a.play('chime',{position:[1,2,3]});v.setVolume(.2);v.setPitch(1.5);v.stop({fade:.2});v.dispose();a.bus('music').volume=.4;a.bus('sfx').duck(.5,.1,.3);a.bus('ui').mute=true;
      a.update(.016,cam);a.setReverb({preset:'cave'});a.addReverbZone({center:[0,0,0],radius:3,preset:'hall'});a.setOcclusion(()=>1);
      const m=a.music({mood:'night'});m.setMood('calm');m.intensity=.2;m.stop();const w=a.ambience('rain');w.set('intensity',.2);w.intensity=.4;
      const cue=new KE.SoundCue({variations:['click']});a.play(cue);out.unlock=await a.unlock();out.stats=a.stats().state;out.meter=a.meter().peak;await a.preload(['click']);a.stopAll();a.dispose();
      out.noThrow=v.inert&&!v.playing&&w.inert&&m.state==='inert';}catch(e){out.noThrow=String(e&&e.stack||e);}finally{window.AudioContext=saved[0];window.webkitAudioContext=saved[1];}
    return out;}));
  check('dispose: everything is disconnected (silence afterwards, even the reverb tail)',life.before>.01&&life.after<1e-6&&life.state==='unavailable'&&life.inert,life);
  check('unavailable AudioContext: state and inert API never throw',life.unavailable==='unavailable'&&life.noThrow===true&&life.unlock===false,life);

  /* ---------- 10. waveform / spectrogram sheet ---------- */
  await stage('sheet',page.evaluate(async()=>{const KE=window.KitsuneEngine,AT=window.AT,S=KE.Synth,items=[];
    for(const s of ['grass','stone','wood','water','sand'])items.push({label:'footstep '+s,buffer:await S.footstep({surface:s,intensity:.8})});
    items.push({label:'chime C5 bell',buffer:await S.chime({note:'C5'})},{label:'impact hard',buffer:await S.impact({size:1.2,hardness:.8})},{label:'whoosh',buffer:await S.whoosh({duration:.8})},
      {label:'pickup',buffer:await S.pickup()},{label:'splash',buffer:await S.splash({size:1.5})},{label:'explosion',buffer:await S.explosion({size:1.5})},{label:'thunder near',buffer:await S.thunder({distance:.2})});
    for(const name of ['rain','forest-day','night']){const env=await AT.render({seconds:5,every:.25,setup({audio}){audio.ambience(name,{intensity:.8,fadeIn:.3,seed:11});}});items.push({label:'ambience '+name,buffer:env.buffer});}
    const env=await AT.render({seconds:10,every:.25,setup({audio}){audio.music({mood:'calm',intensity:.8,seed:2});}});items.push({label:'music calm',buffer:env.buffer});
    AT.drawSheet(items);}));
  const shot=path.join(ROOT,'.test-output','audio-sheet.png');await page.screenshot({path:shot,timeout:120000});console.log('screenshot '+shot);
  await close();

  /* ---------- 11. real AudioContext with the autoplay policy flag ---------- */
  await realContext();
  console.log(failed?'\n'+failed+' FAILED':'\nALL PASS');process.exit(failed?1:0);
}

/* Minimal launcher mirroring harness.cjs, plus --autoplay-policy=no-user-gesture-required. */
async function realContext(){
  const fs=require('fs');let pw;for(const id of ['playwright','/opt/node22/lib/node_modules/playwright']){try{pw=require(id);break;}catch(e){}}
  const out=path.join(ROOT,'.test-output');fs.mkdirSync(out,{recursive:true});const url=p=>'file://'+path.resolve(ROOT,p);
  const scripts=['assets/three.min.js','assets/three-addons.js','src/core.js','src/modules/00-core-v3.js','src/modules/80-audio.js'];
  const file=path.join(out,'audio-realtime-'+process.pid+'.html');fs.writeFileSync(file,`<!doctype html><html><head><meta charset="utf-8"></head><body>${scripts.map(s=>`<script src="${url(s)}"></script>`).join('')}</body></html>`);
  const browser=await pw.chromium.launch({headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']});const errors=[];
  try{const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});await page.goto('file://'+file);
    const r=await stage('realtime',page.evaluate(async()=>{const KE=window.KitsuneEngine,THREE=window.THREE,a=new KE.AudioEngine(THREE,{volume:.8}),out={initial:a.state};out.unlock=await a.unlock();out.state=a.state;
      const t0=a.currentTime;await a.preload(['chime']);const v=a.play('chime',{note:'E5'});const w=a.ambience('wind',{intensity:.6,fadeIn:.1});const m=a.music({mood:'calm',fadeIn:.2});
      const cam=new THREE.PerspectiveCamera();let peak=0;const start=performance.now();
      while(performance.now()-start<1600){a.update(1/30,cam);peak=Math.max(peak,a.meter().peak);await new Promise(r=>setTimeout(r,33));}
      out.advanced=a.currentTime-t0;out.peak=peak;out.voice=v.state;out.pads=m.counts.pad;out.sampleRate=a.sampleRate;out.panning=a.panningModel;out.hrtf=a.voices.length;
      w.stop({fade:.1});m.stop(.1);await new Promise(r=>setTimeout(r,300));a.dispose();out.after=a.state;return out;}),120000);
    check('real AudioContext: running without a gesture under --autoplay-policy=no-user-gesture-required',r.state==='running'&&r.unlock===true,r);
    check('real AudioContext: clock advances, output is audible, music timer schedules notes',r.advanced>1&&r.peak>.005&&r.pads>0,{advanced:r.advanced,peak:r.peak,pads:r.pads});
    check('real AudioContext: no page errors',errors.length===0,errors.join('\n'));
  }finally{await browser.close();try{fs.unlinkSync(file);}catch(e){}}
}

main().catch(e=>{console.error(e);process.exit(1);});
