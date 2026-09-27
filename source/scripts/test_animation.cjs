/* Tests for the animation module (src/modules/60-animation.js).
   The logic suite runs twice: in Node (vm context with three.min.js, core.js, 00-core-v3.js and the module)
   and in headless Chromium through harness.cjs. The browser part then renders a sphere-built quadruped
   walking over wavy terrain with a spring-chain tail and saves screenshots to .test-output/.
     node scripts/test_animation.cjs            # node + browser
     node scripts/test_animation.cjs --node     # node only (fast) */
const fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'..');
const MODULES=['src/modules/00-core-v3.js','src/modules/60-animation.js'];

/* ---------- logic suite (serialized into the browser; must be self-contained) ---------- */
function suite(T,KE){
  const results=[];
  const test=(name,fn)=>{try{const info=fn();results.push({name,ok:true,info:info===undefined?'':info});}catch(e){results.push({name,ok:false,error:String(e&&e.stack||e)});}};
  const assert=(c,msg)=>{if(!c)throw new Error('assertion failed: '+msg);};
  const near=(a,b,e,msg)=>{if(!(Math.abs(a-b)<=e))throw new Error((msg||'near')+': '+a+' vs '+b+' (tol '+e+')');};
  const V=(x,y,z)=>new T.Vector3(x,y,z),wp=o=>new T.Vector3().setFromMatrixPosition(o.matrixWorld);
  const wq=o=>o.getWorldQuaternion(new T.Quaternion());
  let seed=12345;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
  const finiteQ=objs=>objs.every(o=>[o.quaternion.x,o.quaternion.y,o.quaternion.z,o.quaternion.w,o.position.x,o.position.y,o.position.z].every(Number.isFinite));
  const r4=v=>Math.round(v*1e4)/1e4;

  test('module registered',()=>{assert(KE.modules.animation&&KE.modules.animation.provides.includes('ProceduralGait'),'registered');});

  test('easing: endpoints, monotone bezier, steps',()=>{
    for(const [k,f] of Object.entries(KE.easing)){if(k==='cubicBezier'||k==='steps')continue;near(f(0),0,1e-6,k+'(0)');near(f(1),1,1e-6,k+'(1)');}
    const e=KE.easing.cubicBezier(.42,0,.58,1);let prev=-1;for(let i=0;i<=100;i++){const v=e(i/100);assert(v>=prev-1e-9,'monotone');prev=v;}near(e(.5),.5,1e-4,'symmetric');
    const s=KE.easing.steps(4);near(s(.3),.25,1e-9,'steps');near(s(1),1,1e-9,'steps end');
  });

  test('tween: numbers, paths, vectors, colors, yoyo, relative, chain',()=>{
    const mgr=new KE.TweenManager(),o={a:0,obj:new T.Object3D(),col:new T.Color(0,0,0)};let done=0,upd=0;
    KE.tween(o,{a:10,'obj.position.y':2},{duration:1,ease:'linear',manager:mgr,onUpdate:()=>upd++,onComplete:()=>done++});
    mgr.update(.5);near(o.a,5,1e-9,'half');near(o.obj.position.y,1,1e-9,'path');mgr.update(.6);near(o.a,10,1e-9,'end');assert(done===1&&upd===2,'callbacks '+done+' '+upd);assert(mgr.count===0,'removed');
    const yo=KE.tween(o,{a:'+=4'},{duration:1,ease:'linear',repeat:1,yoyo:true,delay:.5,manager:mgr});mgr.update(.5);near(o.a,10,1e-9,'delay');mgr.update(1);near(o.a,14,1e-9,'rel');mgr.update(.5);near(o.a,12,1e-9,'yoyo');mgr.update(1);near(o.a,10,1e-9,'yoyo end');assert(yo.done,'done');
    KE.tween(o.obj,{position:[1,2,3],quaternion:new T.Quaternion().setFromAxisAngle(V(0,1,0),Math.PI/2)},{duration:1,ease:'linear',manager:mgr});mgr.update(.5);
    near(o.obj.position.x,.5,1e-9,'vec');near(2*Math.acos(o.obj.quaternion.w),Math.PI/4,1e-6,'slerp');mgr.update(1);
    KE.tween(o,{col:0xff0000},{duration:1,ease:'linear',manager:mgr});mgr.update(.5);near(o.col.r,.5,1e-6,'color');mgr.update(1);
    const x={v:0},t1=KE.tween(x,{v:1},{duration:.5,ease:'linear',manager:mgr}),t2=KE.tween(x,{v:3},{duration:.5,ease:'linear',manager:mgr});t1.chain(t2);
    mgr.update(.25);near(x.v,.5,1e-9,'chained tween held back');mgr.update(.3);mgr.update(.25);near(x.v,2,1e-9,'chain runs after');
    let threw=false;try{KE.tween(o,{nope:1},{manager:mgr});mgr.update(.1);}catch(e){threw=true;}assert(threw,'unknown property throws');
  });

  /* two-bone IK on plain Groups and on Bones under a rotated, uniformly scaled parent */
  const twoBoneRig=bone=>{const root=new T.Group();root.position.set(1,2,3);root.rotation.set(.3,.5,.1);root.scale.setScalar(1.5);
    const mk=()=>bone?new T.Bone():new T.Group(),a=mk(),b=mk(),c=mk();root.add(a);a.add(b);b.add(c);a.position.set(0,1,0);b.position.set(0,-.5,.05);c.position.set(0,-.6,-.02);a.rotation.set(.2,.1,0);root.updateMatrixWorld(true);return {root,a,b,c};};
  for(const bone of [false,true])test('IK.twoBone reaches, keeps bone lengths, no NaN ('+(bone?'Bones':'Groups')+')',()=>{
    const {a,b,c}=twoBoneRig(bone),A=wp(a),l1=A.distanceTo(wp(b)),l2=wp(b).distanceTo(wp(c));let maxErr=0,maxLen=0;
    for(let i=0;i<300;i++){const dir=V(rnd()-.5,rnd()-.5,rnd()-.5).normalize(),t=A.clone().addScaledVector(dir,(l1+l2)*(.12+.87*rnd()));
      const err=KE.IK.twoBone(T,a,b,c,t,i%2?A.clone().add(V(0,0,1)):null);maxErr=Math.max(maxErr,err);
      maxLen=Math.max(maxLen,Math.abs(wp(a).distanceTo(wp(b))-l1),Math.abs(wp(b).distanceTo(wp(c))-l2));assert(finiteQ([a,b,c]),'finite');}
    near(maxErr,0,1e-6,'reach error');near(maxLen,0,1e-6,'length drift');
    // pole: the mid joint bends toward the pole side
    const t=A.clone().add(V(0,-1.2,.2)),pole=A.clone().add(V(0,-.5,-3));KE.IK.twoBone(T,a,b,c,t,pole);
    const dir=t.clone().sub(A).normalize(),pb=wp(b).sub(A),pp=pole.clone().sub(A);pb.addScaledVector(dir,-pb.dot(dir));pp.addScaledVector(dir,-pp.dot(dir));assert(pb.normalize().dot(pp.normalize())>.999,'pole side');
    // unreachable: straight toward the target; stretch: reaches, then restores lengths when disabled
    const far=A.clone().add(V(4,0,0)),e1=KE.IK.twoBone(T,a,b,c,far,null);near(e1,far.distanceTo(A)-(l1+l2),1e-6,'unreachable straightens');
    const e2=KE.IK.twoBone(T,a,b,c,A.clone().add(V((l1+l2)*1.3,0,0)),null,{stretch:true});near(e2,0,1e-6,'stretch reaches');
    KE.IK.twoBone(T,a,b,c,A.clone().add(V(.5,-.5,0)),null,{});near(wp(a).distanceTo(wp(b)),l1,1e-9,'rest length restored');
    // degenerate targets and weight 0
    for(const tt of [A.clone(),wp(b),A.clone().add(V(0,1e-9,0)),V(1e9,0,0)]){const e=KE.IK.twoBone(T,a,b,c,tt,A.clone());assert(Number.isFinite(e)&&finiteQ([a,b,c]),'degenerate');}
    const q0=a.quaternion.clone();KE.IK.twoBone(T,a,b,c,V(5,5,5),null,{weight:0});assert(a.quaternion.equals(q0),'weight 0');
    return 'maxErr '+maxErr.toExponential(1);
  });

  const chainRig=()=>{const root=new T.Group();root.rotation.set(.2,.3,.1);root.position.set(.3,0,-.2);const js=[];let p=root;for(let i=0;i<5;i++){const g=new T.Group();g.position.set(0,i?.4:0,0);p.add(g);js.push(g);p=g;}root.updateMatrixWorld(true);return {root,js};};
  for(const method of ['fabrik','ccd'])test('IKChain '+method+' converges, keeps lengths, honors limits',()=>{
    const {js}=chainRig(),base=wp(js[0]),lens=[0,1,2,3].map(k=>wp(js[k]).distanceTo(wp(js[k+1])));
    const chain=new KE.IKChain(T,js,{method,iterations:method==='ccd'?200:20,tolerance:1e-3});let worst=0,its=0,lenErr=0;
    for(let i=0;i<120;i++){const t=V(rnd()-.5,rnd()-.2,rnd()-.5).normalize().multiplyScalar(.3+rnd()*1.2).add(base);worst=Math.max(worst,chain.solve(t));its+=chain.iterationsUsed;
      for(let k=0;k<4;k++)lenErr=Math.max(lenErr,Math.abs(wp(js[k]).distanceTo(wp(js[k+1]))-lens[k]));}
    assert(worst<=1.5e-3,'worst error '+worst);near(lenErr,0,1e-6,'lengths');
    const far=base.clone().add(V(0,0,5));const e=chain.solve(far);near(e,5-1.6,1e-4,'unreachable straightens');
    // limits: hinge about x in [-1,0], cone .4 rad, hinge [-1,1]
    const {js:j2}=chainRig(),c2=new KE.IKChain(T,j2,{method,iterations:40,constraints:[null,{axis:'x',minAngle:-1,maxAngle:0},{maxAngle:.4},{axis:'x',minAngle:-1,maxAngle:1}]});
    const sw=new T.Quaternion(),tw=new T.Quaternion();
    for(let i=0;i<30;i++){c2.solve(V(rnd()-.5,rnd(),rnd()-.5).normalize().multiplyScalar(.4+rnd()).add(base));
      for(const k of [1,3]){const r=c2.restQ[k].clone().invert().multiply(j2[k].quaternion),ang=2*Math.atan2(r.x,r.w),lim=c2.constraints[k];
        assert(Math.abs(r.y)<1e-6&&Math.abs(r.z)<1e-6,'hinge axis');assert(ang>=lim.min-1e-6&&ang<=lim.max+1e-6,'hinge range '+ang);}
      const r=c2.restQ[2].clone().invert().multiply(j2[2].quaternion);KE.IK.swingTwist(r,c2.boneAxis[2],sw,tw);assert(2*Math.acos(Math.min(1,Math.abs(sw.w)))<=.4+1e-5,'cone');}
    return 'worst '+worst.toExponential(2)+', avg iterations '+(its/120).toFixed(1);
  });

  test('LookAt aims inside limits, clamps yaw/pitch, damps and releases',()=>{
    const body=new T.Group();body.rotation.y=.7;const neck=new T.Group();neck.position.set(0,1,0);body.add(neck);const head=new T.Group();head.position.set(0,.3,-.1);neck.add(head);body.updateMatrixWorld(true);
    const la=new KE.LookAt(T,[neck,head],{forward:[0,0,-1],maxYaw:.8,maxPitch:.5,speed:Infinity}),fwd=()=>V(0,0,-1).applyQuaternion(wq(head));
    const bf=V(0,0,-1).applyQuaternion(body.quaternion),right=V(1,0,0).applyQuaternion(body.quaternion),eye=wp(head);
    let tgt=eye.clone().addScaledVector(bf,6).addScaledVector(right,1.5).add(V(0,1,0));la.update(tgt,1/60);assert(fwd().angleTo(tgt.clone().sub(wp(head)).normalize())<.01,'aims');
    la.update(eye.clone().addScaledVector(right,5),1/60);near(la.yaw,.8,1e-9,'yaw clamp');near(fwd().angleTo(bf),.8,1e-3,'yaw angle');assert(fwd().dot(right)>0,'turns right');
    la.update(eye.clone().add(V(0,10,0)),1/60);near(la.pitch,.5,1e-9,'pitch clamp');near(fwd().y,Math.sin(.5),1e-3,'pitch up');
    la.speed=5;la.update(null,.1);near(la.pitch,.5*Math.exp(-.5),1e-9,'damped release');for(let i=0;i<200;i++)la.update(null,1/30);assert(fwd().angleTo(bf)<1e-3,'back to rest');
    const single=new KE.LookAt(T,head,{maxYaw:2,maxPitch:1,speed:Infinity});single.update(wp(head).add(V(0,0,-3)),1/60);assert(finiteQ([head]),'single object');
  });

  test('SpringChain settles, damps a root jerk, keeps lengths and limits',()=>{
    const mk=()=>{const root=new T.Group(),js=[];let p=root;for(let i=0;i<5;i++){const g=new T.Group();g.position.set(0,0,i?.2:0);p.add(g);js.push(g);p=g;}root.updateMatrixWorld(true);return {root,js};};
    const {root,js}=mk(),sc=new KE.SpringChain(T,js,{stiffness:120,damping:12,gravity:[0,-2,0],maxAngle:.6});
    for(let i=0;i<180;i++)sc.update(1/60);assert(sc.energy<1e-3,'settled energy '+sc.energy);const sag=wp(js[4]).y;assert(sag<-.02&&sag>-.4,'gravity sag '+sag);
    const tip0=wp(js[4]).clone(),devs=[];for(let i=0;i<300;i++){root.position.x=Math.min(1,i/30)*.5;root.updateMatrixWorld(true);sc.update(1/60);devs.push(Math.abs(wp(js[4]).x-(tip0.x+root.position.x)));}
    assert(Math.max(...devs.slice(0,40))>.02,'lags behind the jerk');assert(devs[120]<.02&&devs[299]<1e-4,'decays '+devs[120]+' '+devs[299]);
    let lenErr=0;for(let k=0;k<4;k++)lenErr=Math.max(lenErr,Math.abs(wp(js[k]).distanceTo(wp(js[k+1]))-.2));near(lenErr,0,1e-6,'lengths');
    // violent motion: bones stay within maxAngle of their rest direction relative to the parent
    for(let i=0;i<60;i++){root.position.set(Math.sin(i*.9)*.8,Math.cos(i*1.3)*.8,0);root.rotation.y=i*.3;root.updateMatrixWorld(true);sc.update(1/60);
      for(let k=1;k<4;k++){const ang=2*Math.acos(Math.min(1,Math.abs(js[k].quaternion.w)));assert(ang<=.6+1e-3,'maxAngle '+ang);}assert(finiteQ(js),'finite');}
    // frame-rate independence: 30 Hz and 144 Hz end in the same settled pose
    const a=mk(),b=mk(),sa=new KE.SpringChain(T,a.js,{}),sb=new KE.SpringChain(T,b.js,{});
    for(let i=0;i<60;i++){a.root.position.x=Math.min(1,i/30)*.4;a.root.updateMatrixWorld(true);sa.update(1/30);}for(let i=0;i<288;i++){b.root.position.x=Math.min(1,i/144)*.4;b.root.updateMatrixWorld(true);sb.update(1/144);}
    near(wp(a.js[4]).distanceTo(wp(b.js[4])),0,.01,'frame rate independence');
    root.position.x=50;root.updateMatrixWorld(true);sc.update(1/60);assert(sc.energy===0,'teleport resets');
    return 'sag '+r4(sag)+' m, peak lag '+r4(Math.max(...devs))+' m';
  });

  test('AnimStateMachine crossfades keep weights summing to 1 (procedural + mixer actions)',()=>{
    const sm=new KE.AnimStateMachine({params:{speed:0}});let maxDev=0,entered=[];
    sm.addState('idle',{pose:()=>{}}).addState('walk',{pose:()=>{}}).addState('run',{pose:()=>{}}).addState('jump',{pose:()=>{},loop:false,duration:.5});
    sm.addTransition('idle','walk',{when:p=>p.speed>.1,duration:.3}).addTransition('walk','run',{when:p=>p.speed>3,duration:.2}).addTransition('*','idle',{when:p=>p.speed<.05,duration:.25})
      .addTransition('*','jump',{trigger:'jump',duration:.1,priority:5}).addTransition('jump','idle',{exitTime:1,duration:.2});
    sm.onEnter=n=>entered.push(n);
    for(let i=0;i<260;i++){sm.set('speed',i<40?0:i<80?1:i<86?4:i<120?1:0);if(i===150)sm.trigger('jump');sm.update(1/60);const s=Object.values(sm.weights).reduce((a,b)=>a+b,0);maxDev=Math.max(maxDev,Math.abs(s-1));}
    near(maxDev,0,1e-9,'weights sum');assert(entered.join()==='idle,walk,run,walk,idle,jump,idle'||entered.join()==='idle,walk,run,idle,jump,idle','sequence '+entered.join());
    // real AnimationMixer actions
    const obj=new T.Object3D(),mk=(n,v)=>new T.AnimationClip(n,1,[new T.NumberKeyframeTrack('.position[x]',[0,1],[v,v])]);
    const mixer=new T.AnimationMixer(obj),A=mixer.clipAction(mk('a',0)),B=mixer.clipAction(mk('b',2));
    const m2=new KE.AnimStateMachine(T,{mixer,params:{go:false}});m2.addState('a',{action:A}).addState('b',{action:B}).addTransition('a','b',{when:p=>p.go,duration:.5});
    m2.update(1/60);m2.set('go',true);let dev=0;for(let i=0;i<20;i++){m2.update(1/60);dev=Math.max(dev,Math.abs(A.getEffectiveWeight()+B.getEffectiveWeight()-1));}
    near(dev,0,1e-9,'action weights');near(obj.position.x,2*B.getEffectiveWeight(),1e-6,'mixer blends');
    return 'states '+entered.join('>');
  });

  test('BlendSpace1D/2D weights',()=>{
    const bs=new KE.BlendSpace1D([{value:2,pose:()=>{}},{value:0,pose:()=>{}},{value:5,pose:()=>{}}]);// sorted internally: 0,2,5
    const w=v=>Array.from(bs.update(v)).map(r4);
    assert(w(1).join()==='0.5,0.5,0','1D mid '+w(1));assert(w(3.5).join()==='0,0.5,0.5','1D upper');assert(w(-3).join()==='1,0,0','1D clamp low');assert(w(9).join()==='0,0,1','1D clamp high');
    const b2=new KE.BlendSpace2D([{x:0,y:0,pose:()=>{}},{x:1,y:0,pose:()=>{}},{x:-1,y:0,pose:()=>{}},{x:0,y:1,pose:()=>{}},{x:0,y:-1,pose:()=>{}}]);
    for(let i=0;i<50;i++){const ws=b2.update(rnd()*3-1.5,rnd()*3-1.5);near(ws.reduce((a,b)=>a+b,0),1,1e-9,'2D sum');assert(ws.every(v=>v>=0),'2D nonneg');}
    near(b2.update(1,0)[1],1,1e-9,'2D exact sample');const m=b2.update(.25,.25);near(m[0],.5,1e-9,'2D barycentric');
    // sync groups: phase-locked actions with different lengths
    const obj=new T.Object3D(),mixer=new T.AnimationMixer(obj),clip=(n,d)=>new T.AnimationClip(n,d,[new T.NumberKeyframeTrack('.position[x]',[0,d],[0,1])]);
    const a=mixer.clipAction(clip('w',1)),r=mixer.clipAction(clip('r',.5)),s=new KE.BlendSpace1D([{value:1,action:a},{value:3,action:r}],{sync:true});
    for(let i=0;i<30;i++){s.update(2,1/60);mixer.update(1/60);}near(a.time/1,r.time/.5,1e-6,'phase sync');
  });

  /* quadruped rig: body with four legs (optionally hip > knee > foot), diagonal gait groups */
  const quad=(knees)=>{const root=new T.Group(),body=new T.Group();root.add(body);body.position.set(0,.55,0);const legs=[];
    for(const x of [-.2,.2])for(const z of [-.3,.34]){const hip=new T.Group();hip.position.set(x,-.03,z);body.add(hip);let knee=null;const foot=new T.Group();
      if(knees){knee=new T.Group();knee.position.set(0,-.25,.04);hip.add(knee);foot.position.set(0,-.24,-.03);knee.add(foot);}else{foot.position.set(0,-.46,0);hip.add(foot);}
      legs.push({hip,knee,foot,group:(x<0)===(z<0)?0:1});}
    root.updateMatrixWorld(true);return {root,body,legs};};
  const wavy=(x,z)=>.25*Math.sin(x*.9)+.18*Math.cos(z*1.3)+.08*Math.sin((x+z)*2.1);
  const walk=(g,root,frames,speedAt,turnAt,dt,onFrame)=>{let yaw=root.rotation.y;const v=V();
    for(let f=0;f<frames;f++){const sp=speedAt(f);yaw+=turnAt(f)*dt;v.set(-Math.sin(yaw)*sp,0,-Math.cos(yaw)*sp);root.position.addScaledVector(v,dt);root.rotation.y=yaw;
      root.position.y=g.heightAt(root.position.x,root.position.z);root.updateMatrixWorld(true);g.update(dt,v);onFrame&&onFrame(f);}};
  const plantStats=(g,samples,k=1)=>{for(const l of g.legs){if(!l.planted)continue;const p=wp(l.foot);samples.push(Math.max(Math.abs(p.y-l.footOffset*k-g.heightAt(p.x,p.z)),Math.hypot(p.x-l.contact.x,p.z-l.contact.z)));}};

  test('ProceduralGait: planted feet within 1 cm on wavy terrain, alternating groups, pitch follows slope',()=>{
    const {root,body,legs}=quad(true),g=new KE.ProceduralGait(T,{body,legs,heightAt:wavy});const errs=[],pc=[];root.position.y=wavy(0,0);
    walk(g,root,1200,f=>f<60?0:f<700?1.2:f<900?2.2:.7,f=>f>300&&f<500?.5:0,1/60,f=>{plantStats(g,errs);
      if(f>90){const F=V(-Math.sin(root.rotation.y),0,-Math.cos(root.rotation.y)),p=root.position,e=.3,sl=(wavy(p.x+F.x*e,p.z+F.z*e)-wavy(p.x-F.x*e,p.z-F.z*e))/(2*e);pc.push([Math.atan(sl),g.pitch]);}
      assert(finiteQ([body,...legs.map(l=>l.hip),...legs.map(l=>l.knee)]),'finite');});
    const maxErr=Math.max(...errs);assert(maxErr<.01,'planted foot error '+maxErr);
    const h=g.history;let alt=0;for(let i=1;i<h.length;i++)if(h[i]!==h[i-1])alt++;assert(h.length>40&&alt/(h.length-1)>.95,'alternation '+h.join(''));
    const n=pc.length,ma=pc.reduce((a,b)=>a+b[0],0)/n,mb=pc.reduce((a,b)=>a+b[1],0)/n;let cov=0,va=0,vb=0;for(const [a,b] of pc){cov+=(a-ma)*(b-mb);va+=(a-ma)**2;vb+=(b-mb)**2;}
    const corr=cov/Math.sqrt(va*vb);assert(corr>.9,'pitch/slope correlation '+corr);
    // idle: every foot settles and plants, the body comes to rest
    walk(g,root,240,()=>0,()=>0,1/60);const y0=body.position.y;walk(g,root,30,()=>0,()=>0,1/60);
    assert(g.planted,'all planted at idle');assert(Math.abs(body.position.y-y0)<.01,'body at rest');
    for(const l of g.legs){const p=wp(l.foot),home=l.home;assert(Math.hypot(p.x-home.x,p.z-home.z)<g.stepLength*.2,'idle foot near home');}
    // turning in place steps too
    const s0=g.stepCount;walk(g,root,120,()=>0,()=>2,1/60,()=>plantStats(g,errs));assert(g.stepCount>s0+2,'turn in place steps');assert(Math.max(...errs)<.01,'turn plant error');
    return 'max planted error '+(maxErr*1000).toFixed(2)+' mm over '+errs.length+' samples, '+g.stepCount+' steps, pitch corr '+corr.toFixed(3);
  });

  test('ProceduralGait: knee-less legs (Spirit Isle style Groups) stay planted',()=>{
    const {root,body,legs}=quad(false),g=new KE.ProceduralGait(T,{body,legs,heightAt:wavy});const errs=[];root.position.y=wavy(0,0);
    walk(g,root,900,f=>f<60?0:1.1,f=>f>400&&f<600?.4:0,1/60,()=>plantStats(g,errs));
    const within=errs.filter(e=>e<.01).length/errs.length,maxErr=Math.max(...errs);assert(within>.99&&maxErr<.05,'within 1 cm '+within+' max '+maxErr);
    const h=g.history;let alt=0;for(let i=1;i<h.length;i++)if(h[i]!==h[i-1])alt++;assert(alt/(h.length-1)>.95,'alternation');
    return (within*100).toFixed(2)+'% of planted samples within 1 cm (max '+(maxErr*1000).toFixed(1)+' mm, flat ground: exact)';
  });

  test('ProceduralGait: teleport snaps, velocity is optional, root scale respected',()=>{
    const {root,body,legs}=quad(true);root.scale.setScalar(2);root.updateMatrixWorld(true);const g=new KE.ProceduralGait(T,{body,legs,heightAt:()=>0});const errs=[];
    walk(g,root,200,f=>f<30?0:2.2,()=>0,1/60,()=>plantStats(g,errs,2));assert(Math.max(...errs)<.01,'scaled planted error '+Math.max(...errs));
    root.position.set(40,0,40);root.updateMatrixWorld(true);g.update(1/60);assert(g.planted,'snapped');for(const l of g.legs)assert(l.contact.distanceTo(l.home)<1e-9,'feet at home');
    root.position.z-=.02;root.updateMatrixWorld(true);g.update(1/60);near(g.speed,1.2,1e-6,'derived velocity');
  });

  test('Sequencer: linear/cubic/step keys, eases, events, seek, cuts, JSON',()=>{
    const scene=new T.Scene(),box=new T.Object3D();box.name='box';scene.add(box);const camA=new T.PerspectiveCamera();camA.name='camA';const camB=new T.PerspectiveCamera();camB.name='camB';scene.add(camA,camB);
    const seq=new KE.Sequencer(T),fired=[],cuts=[];
    seq.addTrack({target:box,path:'position.x',keys:[{t:0,value:0},{t:1,value:10},{t:2,value:10,interp:'step'},{t:3,value:0}]});
    seq.addTrack({target:box,path:'position.y',keys:[{t:0,value:0,interp:'cubic'},{t:1,value:1,interp:'cubic'},{t:2,value:0}]});
    seq.addTrack({target:box,path:'scale',keys:[{t:0,value:[1,1,1],ease:'inOutQuad'},{t:2,value:[3,3,3]}]});
    seq.addTrack({target:box,path:'quaternion',keys:[{t:0,value:[0,0,0]},{t:2,value:[0,Math.PI,0]}]});
    seq.addCameraCut({t:0,camera:camA}).addCameraCut({t:1.5,camera:camB});seq.onCameraCut=c=>cuts.push(c.name);
    seq.addEvent({t:0,fn:()=>fired.push('start'),name:'start'}).addEvent({t:.5,fn:()=>fired.push('a'),name:'a'}).addEvent({t:2.5,fn:()=>fired.push('b'),name:'b'});
    seq.seek(.5);near(box.position.x,5,1e-9,'linear');near(box.scale.x,1.25,1e-9,'eased midpoint');seq.seek(1.5);near(box.position.x,10,1e-9,'step holds');
    seq.seek(.5);const cubic=box.position.y;assert(cubic>.5,'cubic ease-out shape '+cubic);seq.seek(1);near(box.position.y,1,1e-9,'cubic key');
    seq.seek(1);near(Math.abs(box.quaternion.y),Math.sin(Math.PI/4),1e-6,'quaternion slerp');
    assert(fired.length===0,'seek does not fire');seq.seek(0);seq.play();for(let i=0;i<40;i++)seq.update(.1);assert(fired.join()==='start,a,b','events '+fired.join());assert(!seq.playing,'finished');near(seq.time,3,1e-9,'clamped end');
    assert(cuts.join()==='camA,camB,camA,camB','cuts '+cuts.join());assert(seq.camera===camB,'active camera');
    seq.loop=true;seq.seek(0);fired.length=0;seq.play();for(let i=0;i<58;i++)seq.update(.1);assert(fired.join()==='start,a,b,start,a,b','loop events '+fired.join());
    const json=JSON.parse(JSON.stringify(seq.toJSON())),copy=KE.Sequencer.fromJSON(T,json,scene,{a:()=>fired.push('A')});
    for(const t of [0,.3,.77,1.2,1.9,2.4,3]){seq.seek(t);const p1=box.position.clone(),s1=box.scale.clone(),q1=box.quaternion.clone();copy.seek(t);
      near(box.position.distanceTo(p1),0,1e-9,'json pos @'+t);near(box.scale.distanceTo(s1),0,1e-9,'json scale');near(Math.abs(box.quaternion.dot(q1)),1,1e-9,'json quat');}
    assert(copy.cuts.length===2&&copy.events.length===1,'json cuts/events');
  });

  test('CameraRail is continuous (open and closed) and aims ahead',()=>{
    const pts=[[0,2,0],[4,3,-2],[8,2.5,1],[10,4,6],[5,3,9],[0,2,6]];
    for(const closed of [false,true]){const rail=new KE.CameraRail(T,pts,{closed}),cam=new T.PerspectiveCamera(),L=rail.length,N=2000;let maxStep=0,maxTurn=0,prev=null,prevDir=null;
      for(let i=0;i<=N;i++){rail.apply(cam,i/N);const p=cam.position.clone(),d=V(0,0,-1).applyQuaternion(cam.quaternion);if(prev){maxStep=Math.max(maxStep,p.distanceTo(prev));maxTurn=Math.max(maxTurn,d.angleTo(prevDir));}prev=p;prevDir=d;
        assert(Number.isFinite(p.x)&&Number.isFinite(cam.quaternion.w),'finite');}
      assert(maxStep<(L/N)*1.2,'arc-length uniform steps '+maxStep+' vs '+L/N);assert(maxTurn<.05,'smooth orientation '+maxTurn);
      if(closed){const a=rail.getPoint(0),b=rail.getPoint(1),c=rail.getPoint(1.25),d=rail.getPoint(.25);near(a.distanceTo(b),0,1e-6,'wrap');near(c.distanceTo(d),0,1e-6,'periodic');}
      const t=.3;rail.apply(cam,t);const look=V(0,0,-1).applyQuaternion(cam.quaternion),tan=rail.getTangent(t);assert(look.dot(tan)>.9,'looks ahead');}
    const tense=new KE.CameraRail(T,pts,{tension:.9});assert(tense.curve.curveType==='catmullrom','explicit tension uses uniform catmull-rom');
    const target=new T.Object3D();target.position.set(5,0,3);target.updateMatrixWorld(true);const r=new KE.CameraRail(T,pts,{lookAt:target}),cam=new T.PerspectiveCamera();r.apply(cam,.4);
    assert(V(0,0,-1).applyQuaternion(cam.quaternion).angleTo(target.position.clone().sub(cam.position).normalize())<1e-4,'fixed look target');
  });

  test('CameraShake adds bounded, decaying, removable offsets',()=>{
    const cam=new T.PerspectiveCamera(),shake=new KE.CameraShake(T,{seed:3});cam.position.set(1,2,3);cam.lookAt(0,0,0);const p0=cam.position.clone(),q0=cam.quaternion.clone();
    shake.add(.8);let maxOff=0,maxAng=0;for(let i=0;i<30;i++){shake.update(1/60,cam);maxOff=Math.max(maxOff,cam.position.distanceTo(p0));maxAng=Math.max(maxAng,2*Math.acos(Math.min(1,Math.abs(cam.quaternion.dot(q0)))));}
    assert(maxOff>.005&&maxOff<.25,'offset '+maxOff);assert(maxAng>.002&&maxAng<.3,'angle '+maxAng);
    for(let i=0;i<120;i++)shake.update(1/60,cam);near(shake.trauma,0,1e-12,'decays');near(cam.position.distanceTo(p0),0,1e-9,'position restored');near(Math.abs(cam.quaternion.dot(q0)),1,1e-9,'rotation restored');
  });

  test('RootMotion extracts loop-aware displacement; PoseBlender blends',()=>{
    const clip=new T.AnimationClip('walk',1,[new T.VectorKeyframeTrack('hips.position',[0,.5,1],[0,1,0, 0,1.1,-.5, 0,1,-1])]);
    const rig=new T.Object3D(),hips=new T.Object3D();hips.name='hips';rig.add(hips);const rm=new KE.RootMotion(T,clip),mixer=new T.AnimationMixer(rig),act=mixer.clipAction(clip).play();
    const out=V(),sum=V();rm.reset(act);for(let i=0;i<150;i++){mixer.update(1/60);sum.add(rm.update(act,out));}near(sum.z,-2.5,1e-3,'root motion total');near(hips.position.z,0,1e-9,'clip in place');near(sum.y,0,1e-9,'y masked');
    const a=new T.Object3D(),b=new T.Object3D(),pb=new KE.PoseBlender(T,[a,b]);
    pb.reset().add(a,{position:V(2,0,0),quaternion:new T.Quaternion().setFromAxisAngle(V(0,1,0),1)},.5).add(a,{position:V(0,0,0)},.5).apply();near(a.position.x,1,1e-9,'blend pos');near(2*Math.acos(a.quaternion.w),.5,.01,'blend rot');near(b.position.x,0,1e-9,'rest fill');
  });

  test('createBoneChain + buildSkinnedTube produce a valid skinned mesh',()=>{
    const holder=new T.Group(),bones=KE.createBoneChain(T,5,.15,{direction:[0,.3,1],parent:holder});
    const mesh=KE.buildSkinnedTube(T,bones,{radius:u=>.04+.06*Math.sin(Math.PI*u),segments:10,color:u=>new T.Color().setHSL(.07,.7,.3+.5*u)});
    assert(mesh.isSkinnedMesh&&mesh.parent===holder&&mesh.skeleton.bones.length===5,'skinned mesh');
    const g=mesh.geometry,si=g.attributes.skinIndex,sw=g.attributes.skinWeight,pos=g.attributes.position;let bad=0;
    for(let i=0;i<si.count;i++){const w=sw.getX(i)+sw.getY(i)+sw.getZ(i)+sw.getW(i);if(Math.abs(w-1)>1e-5||si.getX(i)>4||si.getY(i)>4)bad++;if(!Number.isFinite(pos.getX(i)))bad++;}
    assert(bad===0,'skin attributes');assert(mesh.material.skinning===true,'skinning flag');
    const sc=new KE.SpringChain(T,bones,{});holder.position.x=.3;holder.updateMatrixWorld(true);for(let i=0;i<10;i++)sc.update(1/60);assert(finiteQ(bones),'simulated bones');
    mesh.geometry.dispose();mesh.material.dispose();return pos.count+' vertices';
  });
  return results;
}

/* ---------- browser scene: a sphere-built fox walking over wavy terrain ---------- */
function sceneSetup(){
  const T=THREE,KE=KitsuneEngine,W=innerWidth,H=innerHeight;
  const renderer=new T.WebGLRenderer({antialias:true});renderer.setSize(W,H);renderer.outputEncoding=T.sRGBEncoding;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=.9;
  const lin=hex=>new T.Color(hex).convertSRGBToLinear();
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFSoftShadowMap;document.body.append(renderer.domElement);
  const scene=new T.Scene();scene.background=lin(0x9cc4e4);scene.fog=new T.Fog(scene.background.getHex(),9,30);
  const camera=new T.PerspectiveCamera(38,W/H,.05,100);
  const heightAt=(x,z)=>.32*Math.sin(x*.55+.4)+.22*Math.cos(z*.7)+.07*Math.sin((x+z)*1.9);
  // terrain
  const S=60,N=240,geo=new T.PlaneGeometry(S,S,N,N);geo.rotateX(-Math.PI/2);const p=geo.attributes.position,col=new Float32Array(p.count*3),c=new T.Color();
  for(let i=0;i<p.count;i++){const x=p.getX(i),z=p.getZ(i),y=heightAt(x,z);p.setY(i,y);const n=(Math.sin(x*3.1+Math.sin(z*1.7))*Math.cos(z*2.7-x*.4)+Math.sin(x*7.3+z*5.1)*.35)*.35+.5;c.setHSL(.23+.05*n,.42+.1*n,.22+.07*(y+.5)+.07*n).convertSRGBToLinear();col[i*3]=c.r;col[i*3+1]=c.g;col[i*3+2]=c.b;}
  geo.setAttribute('color',new T.BufferAttribute(col,3));geo.computeVertexNormals();
  const ground=new T.Mesh(geo,new T.MeshStandardMaterial({vertexColors:true,roughness:.95}));ground.receiveShadow=true;scene.add(ground);
  scene.add(new T.HemisphereLight(lin(0xcfe3ff),lin(0x4a5a2e),.9));const sun=new T.DirectionalLight(lin(0xfff0d8),2.2);sun.position.set(-4,8,3);sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);
  Object.assign(sun.shadow.camera,{left:-4,right:4,top:4,bottom:-4,near:.5,far:30});sun.shadow.bias=-.0005;sun.shadow.normalBias=.02;scene.add(sun,sun.target);
  // fox: root (moved by the game) > body > torso, head, legs (hip > knee > foot), tail bones
  const orange=new T.MeshStandardMaterial({color:lin(0xc8642a),roughness:.85}),cream=new T.MeshStandardMaterial({color:lin(0xefdcc0),roughness:.9}),ink=new T.MeshStandardMaterial({color:lin(0x2e2622),roughness:.7}),eyeM=new T.MeshStandardMaterial({color:0x050505,roughness:.2});
  const orb=(r,m,x,y,z,sx=1,sy=1,sz=1,parent)=>{const o=new T.Mesh(new T.SphereGeometry(r,20,14),m);o.position.set(x,y,z);o.scale.set(sx,sy,sz);o.castShadow=true;parent.add(o);return o;};
  const root=new T.Group(),body=new T.Group();root.add(body);body.position.set(0,.5,0);scene.add(root);
  orb(.24,orange,0,.03,.05,1,1.02,1.75,body);orb(.2,cream,0,-.05,-.18,.85,.9,1.1,body);orb(.21,orange,0,.08,-.3,1,1.05,1.05,body);
  const neck=new T.Group();neck.position.set(0,.18,-.38);body.add(neck);const head=new T.Group();head.position.set(0,.17,-.06);neck.add(head);
  orb(.13,orange,0,-.05,.02,1,1,1.1,neck);orb(.17,orange,0,0,0,1.1,.95,1,head);orb(.12,cream,0,-.07,-.12,.8,.6,1,head);orb(.1,cream,0,-.06,-.2,.62,.48,1.15,head);orb(.035,ink,0,-.03,-.315,1,.8,.9,head);
  for(const x of [-.075,.075]){orb(.028,eyeM,x,.03,-.145,1,1.1,.7,head);const ear=new T.Mesh(new T.ConeGeometry(.07,.2,4),orange);ear.position.set(x*1.4,.19,.01);ear.rotation.set(-.15,Math.PI/4,x<0?.28:-.28);ear.castShadow=true;head.add(ear);
    const inner=new T.Mesh(new T.ConeGeometry(.04,.13,4),ink);inner.position.set(x*1.4,.2,-.02);inner.rotation.copy(ear.rotation);head.add(inner);}
  const legs=[];
  for(const x of [-.14,.14])for(const z of [-.3,.3]){const front=z<0,hip=new T.Group();hip.position.set(x,-.02,z);body.add(hip);
    orb(.075,orange,0,-.1,0,1,1.8,1.05,hip);const knee=new T.Group();knee.position.set(0,-.21,front?.035:.05);hip.add(knee);orb(.05,front?orange:orange,0,-.1,front?-.005:-.02,1,2.2,1,knee);
    const foot=new T.Group();foot.position.set(0,-.2,front?-.02:-.035);knee.add(foot);orb(.058,ink,0,-.015,-.025,1,.6,1.35,foot);legs.push({hip,knee,foot,group:(x<0)===front?0:1});}
  // tail: a bone chain skinned with a tapered tube, simulated by a SpringChain
  const tailBase=new T.Group();tailBase.position.set(0,.06,.4);body.add(tailBase);
  const bones=KE.createBoneChain(T,6,.11,{direction:[0,.2,1],parent:tailBase});bones.forEach((b,i)=>{if(i>0)b.rotation.x=i<3?.12:-.06;});
  const tail=KE.buildSkinnedTube(T,bones,{radius:u=>.03+.075*Math.sin(Math.PI*Math.min(1,u*.8+.14)),segments:14,rings:4,color:u=>u>.8?lin(0xf2e6d0):lin(0xc8642a),material:new T.MeshStandardMaterial({vertexColors:true,roughness:.85})});
  const tailSpring=new KE.SpringChain(T,bones,{stiffness:110,damping:10,gravity:[0,-1.2,0],inertia:.9,maxAngle:.8});
  const gait=new KE.ProceduralGait(T,{body,legs,heightAt,stepLength:.4,stepHeight:.1,stepDuration:.2,lean:.12});
  const look=new KE.LookAt(T,[neck,head],{forward:[0,0,-1],maxYaw:.9,maxPitch:.4,speed:6});
  root.position.set(0,heightAt(0,0),0);root.updateMatrixWorld(true);
  // Spirit Isle's fox, rebuilt from assets/starter.html (knee-less leg Groups, rigid tail Group), with its
  // parts wrapped in a body Group as references/animation.md describes. It walks beside the first fox.
  const hero=new T.Group();scene.add(hero);const noseMat=new T.MeshStandardMaterial({color:lin(0x17171a),roughness:.3}),eyeMat=new T.MeshStandardMaterial({color:lin(0x8b5b26),roughness:.19});
  const orange2=new T.MeshStandardMaterial({color:lin(0xcc793f),roughness:.94}),cream2=new T.MeshStandardMaterial({color:lin(0xf2dfb6),roughness:.96});
  const orb2=(r,m,x,y,z,sx=1,sy=1,sz=1,parent=hero)=>orb(r,m,x,y,z,sx,sy,sz,parent);
  orb2(.34,orange2,0,.58,.03,1,1.06,1.62);orb2(.28,orange2,0,.78,-.3,1,1.25,1.1);orb2(.255,cream2,0,.65,-.38,.8,1.27,.6);orb2(.29,orange2,0,1.03,-.43,1.12,.97,1.03);
  orb2(.2,orange2,-.22,1.00,-.39,.82,.7,.9);orb2(.2,orange2,.22,1.00,-.39,.82,.7,.9);orb2(.23,cream2,0,.92,-.63,.82,.53,1.02);orb2(.17,cream2,0,.87,-.66,.87,.32,1);orb2(.07,noseMat,0,.96,-.84,1.05,.64,.7);
  for(const x of [-.19,.19]){const e=new T.Group();e.position.set(x,1.22,-.37);e.rotation.z=x<0?.16:-.16;hero.add(e);const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute([-.12,0,.04,.12,0,.04,0,.4,.025,-.12,0,.04,0,.4,.025,0,.06,.15,.12,0,.04,0,.06,.15,0,.4,.025],3));g.computeVertexNormals();
    const m=new T.Mesh(g,orange2);m.castShadow=true;e.add(m);}
  for(const x of [-.175,.175]){orb2(.062,ink,x,1.088,-.643,1.05,.68,.46);orb2(.043,eyeMat,x,1.092,-.663,.78,.9,.45);}
  const foxLegs=[];for(const x of [-.205,.205])for(const z of [-.27,.34]){const leg=new T.Group();leg.position.set(x,.52,z);hero.add(leg);orb2(.096,orange2,0,-.13,0,1,1.9,1,leg);orb2(.083,ink,0,-.32,-.01,.8,1.2,.85,leg);orb2(.10,ink,0,-.43,-.052,.94,.52,1.36,leg);foxLegs.push(leg);}
  const foxTail=new T.Group();foxTail.position.set(0,.55,.41);hero.add(foxTail);
  const tailCurve=new T.CatmullRomCurve3([new T.Vector3(0,0,0),new T.Vector3(.06,.08,.23),new T.Vector3(.13,.17,.48),new T.Vector3(.21,.29,.74),new T.Vector3(.21,.43,.9)]);
  const tailG=new T.TubeGeometry(tailCurve,24,.19,12,false),pa=tailG.attributes.position;for(let i=0;i<=24;i++){const c=tailCurve.getPointAt(i/24),radius=Math.sin((i/24*.86+.09)*Math.PI)*.94+.08;for(let j=0;j<=12;j++){const k=i*13+j;pa.setXYZ(k,c.x+(pa.getX(k)-c.x)*radius,c.y+(pa.getY(k)-c.y)*radius,c.z+(pa.getZ(k)-c.z)*radius);}}
  tailG.computeVertexNormals();const tm=new T.Mesh(tailG,orange2);tm.castShadow=true;foxTail.add(tm);orb2(.13,cream2,.21,.44,.89,.7,1.12,1.12,foxTail);
  const foxBody=new T.Group();while(hero.children.length)foxBody.add(hero.children[0]);hero.add(foxBody);
  const heroGait=new KE.ProceduralGait(T,{body:foxBody,heightAt,legs:foxLegs.map((leg,i)=>({hip:leg,foot:leg.children[2],group:i===0||i===3?0:1}))});
  const heroTail=new KE.SpringChain(T,[foxTail],{tip:[.21,.43,.9],stiffness:80,damping:8,gravity:[0,-1,0],maxAngle:.5});
  const heroOffset=new T.Vector3(-1.6,0,.6);
  // the camera follows at a fixed offset in the fox's frame; the fox glances at the camera (LookAt with limits)
  const lookTarget=new T.Vector3(),v=new T.Vector3(),camOffset=new T.Vector3(1.9,.7,-1.1);let yaw=0,time=0;
  const place=()=>{const q=root.position,off=camOffset.clone().applyAxisAngle(new T.Vector3(0,1,0),yaw);camera.position.copy(q).add(off);camera.position.y=Math.max(camera.position.y,heightAt(camera.position.x,camera.position.z)+.35);camera.lookAt(q.x,q.y+.36,q.z);lookTarget.copy(camera.position);};
  const step=(dt,speed,turn)=>{time+=dt;yaw+=turn*dt;v.set(-Math.sin(yaw)*speed,0,-Math.cos(yaw)*speed);root.position.addScaledVector(v,dt);root.rotation.y=yaw;root.position.y=heightAt(root.position.x,root.position.z);root.updateMatrixWorld(true);
    gait.update(dt,v);place();look.update(lookTarget,dt);tailSpring.update(dt);
    hero.position.copy(heroOffset).applyAxisAngle(new T.Vector3(0,1,0),yaw).add(root.position);hero.position.y=heightAt(hero.position.x,hero.position.z);hero.rotation.y=yaw;hero.updateMatrixWorld(true);
    heroGait.update(dt);heroTail.update(dt);};
  const frame=offset=>{if(offset){camOffset.set(...offset);place();}const q=root.position;
    sun.position.copy(q).add(new T.Vector3(-3,7,2.5));sun.target.position.copy(q);sun.target.updateMatrixWorld();renderer.render(scene,camera);};
  // 2x2 filmstrip of consecutive moments (left-to-right, top-to-bottom) for judging the gait
  const strip=(offset,dt,speed)=>{camOffset.set(...offset);renderer.setScissorTest(true);renderer.autoClear=false;renderer.clear();
    for(let k=0;k<4;k++){const x=(k%2)*W/2,y=(1-(k>>1))*H/2;if(k)for(let i=0;i<4;i++)step(dt/4,speed,0);place();camera.aspect=W/H;camera.updateProjectionMatrix();
      renderer.setViewport(x,y,W/2,H/2);renderer.setScissor(x,y,W/2,H/2);frame();}
    renderer.setScissorTest(false);renderer.setViewport(0,0,W,H);renderer.autoClear=true;};
  window.fox={T,KE,renderer,scene,camera,root,body,gait,look,tailSpring,tail,bones,heightAt,lookTarget,step,frame,strip,hero,heroGait,heroTail,camOffset,get yaw(){return yaw;}};
}

/* ---------- runners ---------- */
function report(results,label){let failed=0;for(const r of results){if(r.ok)console.log('PASS '+label+' '+r.name+(r.info?' ('+r.info+')':''));else{failed++;console.log('FAIL '+label+' '+r.name+'\n  '+r.error);}}return failed;}
function runNode(){
  const storage=new Map(),element=()=>({style:{},appendChild(){},remove(){},addEventListener(){},removeEventListener(){}});
  const THREE=require(path.join(ROOT,'assets/three.min.js'));
  const context={console,THREE,navigator:{hardwareConcurrency:4,deviceMemory:8},document:{createElement:element,head:element(),addEventListener(){},removeEventListener(){},hidden:false},
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},performance:{now:()=>Date.now()},requestAnimationFrame:()=>1,cancelAnimationFrame(){},setTimeout};
  context.window=context;vm.createContext(context);
  for(const f of ['src/core.js',...MODULES])vm.runInContext(fs.readFileSync(path.join(ROOT,f),'utf8'),context,{filename:f});
  return report(suite(THREE,context.KitsuneEngine),'[node]');
}
async function runBrowser(){
  const {openPage}=require('./harness.cjs');let failed=0;
  const {page,close,outDir}=await openPage({modules:MODULES,viewport:{width:640,height:400},name:'animation'});
  try{
    failed+=report(await page.evaluate(`(${suite})(THREE,KitsuneEngine)`),'[browser]');
    await page.evaluate(`(${sceneSetup})()`);
    // walk ~5 s along a gentle curve (logic only), then stop mid-stride and render
    const r=await page.evaluate(()=>{const f=fox,errs=[],heroErrs=[];
      for(let i=0;i<300;i++){f.step(1/60,1.05,i>60&&i<200?.35:0);
        for(const l of f.gait.legs)if(l.planted){const p=new f.T.Vector3().setFromMatrixPosition(l.foot.matrixWorld);errs.push(Math.abs(p.y-l.footOffset-f.heightAt(p.x,p.z)));}
        if(i>=30)for(const l of f.heroGait.legs)if(l.planted){const p=new f.T.Vector3().setFromMatrixPosition(l.foot.matrixWorld);heroErrs.push(Math.abs(p.y-l.footOffset-f.heightAt(p.x,p.z)));}}
      // advance until one diagonal pair is at mid-swing
      for(let i=0;i<60;i++){const s=f.gait.legs.find(l=>!l.planted);if(s&&s.swingT>.45&&s.swingT<.6)break;f.step(1/60,1.05,0);}
      f.frame();const sw=f.gait.legs.filter(l=>!l.planted).map(l=>l.index);
      return {maxErr:Math.max(...errs),steps:f.gait.stepCount,swinging:sw,pitch:f.gait.pitch,heroWithin:heroErrs.filter(e=>e<.01).length/heroErrs.length,heroMax:Math.max(...heroErrs),heroSteps:f.heroGait.stepCount};});
    console.log('   scene',JSON.stringify({maxErrMM:(r.maxErr*1000).toFixed(2),steps:r.steps,swinging:r.swinging,pitch:r.pitch.toFixed(3),spiritFoxWithin1cm:(r.heroWithin*100).toFixed(1)+'%',spiritFoxMaxMM:(r.heroMax*1000).toFixed(1),spiritFoxSteps:r.heroSteps}));
    if(!(r.maxErr<.01&&r.swinging.length===2&&r.steps>10)){failed++;console.log('FAIL [browser] fox scene walk');}else console.log('PASS [browser] fox walks mid-stride over wavy terrain');
    if(!(r.heroWithin>.97&&r.heroMax<.05&&r.heroSteps>10)){failed++;console.log('FAIL [browser] Spirit Isle fox walk');}else console.log('PASS [browser] Spirit Isle fox (knee-less Groups, velocity derived) walks beside it');
    await page.screenshot({path:path.join(outDir,'animation-fox-stride.png'),timeout:120000});
    // side view of the same moment, then a turn with the tail swinging out
    await page.evaluate(()=>fox.frame([2.3,.45,-.1]));await page.screenshot({path:path.join(outDir,'animation-fox-side.png'),timeout:120000});
    await page.evaluate(()=>fox.frame([-4.6,1.6,-3.4]));await page.screenshot({path:path.join(outDir,'animation-foxes-pair.png'),timeout:120000});
    await page.evaluate(()=>fox.strip([2.6,.5,-.2],1/15,1.05));await page.screenshot({path:path.join(outDir,'animation-fox-strip.png'),timeout:120000});
    await page.evaluate(()=>{fox.frame([-1.5,1.0,1.7]);for(let i=0;i<50;i++)fox.step(1/60,1.3,1.6);fox.frame();});await page.screenshot({path:path.join(outDir,'animation-fox-turn.png'),timeout:120000});
    console.log('   screenshots: .test-output/animation-fox-{stride,side,strip,turn}.png, animation-foxes-pair.png');
    await page.evaluate(()=>{fox.KE.disposeObject(fox.scene);fox.renderer.dispose();});
  }finally{await close();}
  return failed;
}
(async()=>{
  let failed=runNode();
  if(!process.argv.includes('--node'))failed+=await runBrowser();
  if(failed){console.log(failed+' animation test(s) failed');process.exit(1);}
  console.log('all animation tests passed');
})().catch(e=>{console.error(e);process.exit(1);});
