/* Browser checks for the built open-world showcase (examples/src/open-world.html → ../open-world.html).
   node scripts/test_open_world.cjs [path/to/open-world.html] [--shots]
   Headless Chromium with SwiftShader; the page generates and erodes a 2 km island while loading (~20 s here). */
const path=require('path'),fs=require('fs');
let playwright=null;for(const id of ['playwright','/opt/node22/lib/node_modules/playwright']){try{playwright=require(id);break;}catch(e){}}
if(!playwright){console.error('Playwright is required');process.exit(1);}
const file=path.resolve(process.argv.slice(2).find(a=>!a.startsWith('--'))||path.join(__dirname,'../../open-world.html'));
const shots=process.argv.includes('--shots'),out=path.join(__dirname,'../.test-output');fs.mkdirSync(out,{recursive:true});
if(!fs.existsSync(file)){console.error('Build it first: python3 scripts/build.py examples/src/open-world.html ../open-world.html');process.exit(1);}
(async()=>{
  const browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--autoplay-policy=no-user-gesture-required']});
  const page=await browser.newPage({viewport:{width:640,height:400}});const errors=[],network=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
  let failed=0;const test=async(name,fn)=>{try{const r=await fn();console.log('PASS '+name+(r?'  '+JSON.stringify(r):''));}catch(e){failed++;console.log('FAIL '+name+'  '+e.message);}};
  const t0=Date.now();await page.goto('file://'+file);
  await page.waitForFunction(()=>window.demo||document.querySelector('.error'),null,{timeout:300000});
  await test('page loads, generates the island and exposes its handle',async()=>{const r=await page.evaluate(()=>({demo:!!window.demo,error:document.querySelector('.error')&&document.querySelector('.error').innerText}));if(!r.demo)throw Error(r.error||'no demo');return {seconds:+((Date.now()-t0)/1000).toFixed(1)};});
  await page.click('#start');await page.evaluate(()=>{KitsuneEngine.applyPreset('high');KitsuneEngine.setSettings({scale:1});});
  await page.waitForTimeout(6000);
  await test('terrain is drawn in one instanced call and cells stream around the player',async()=>{const r=await page.evaluate(()=>{const s=demo.terrain.stats(),w=demo.partition.stats();return {patches:s.patches,drawCalls:s.drawCalls,levels:s.levels,loaded:w.loaded,hlod:w.hlod,doubleLoads:w.doubleLoads};});
    if(r.drawCalls!==1||r.patches<4)throw Error(JSON.stringify(r));if(!(r.loaded>=4))throw Error('too few cells '+JSON.stringify(r));if(r.doubleLoads)throw Error('double loads');return r;});
  await test('the fox stands on the terrain surface',async()=>{const r=await page.evaluate(()=>{const s=demo.getState();return {y:s.y,ground:demo.terrain.heightAt(s.x,s.z)};});if(!(Math.abs(r.y-.35-r.ground)<.3))throw Error(JSON.stringify(r));return r;});
  await test('Japanese landscape: snow-capped volcano, a river in its valley, boats afloat, bamboo, the daisugi and a torii',async()=>{const r=await page.evaluate(()=>{const hf=demo.heightfield,v=demo.volcano,top=demo.terrain.heightAt(v.x,v.z),rv=demo.river;
      let above=0,samples=0;for(let s=rv.length*.3;s<rv.length*.95;s+=20){const p=rv.pointAt(s);if(p.y<2)continue;/* the mouth, where the land is at sea level */const banks=[1,-1].map(k=>demo.terrain.heightAt(p.x+p.nx*k*(p.w*.5+6),p.z+p.nz*k*(p.w*.5+6)));samples++;if(Math.min(...banks)>=p.y-.3)above++;}
      const bed=rv.pointAt(rv.length*.6),bedH=demo.terrain.heightAt(bed.x,bed.z);
      const sea=demo.boats.filter(b=>b.mode==='sea').map(b=>Math.abs(b.group.position.y+b.draft-demo.water.heightAt(b.group.position.x,b.group.position.z))),onRiver=demo.boats.filter(b=>b.mode==='river').map(b=>{const q=rv.nearest(b.group.position.x,b.group.position.z);return q.d<q.w*.5;});
      const bi=demo.terrain.biomeTexture.image.data,S=hf.size,sp=hf.spacing,k=(Math.round((v.z-hf.originZ)/sp)*S+Math.round((v.x-hf.originX)/sp))*4;
      return {top:+top.toFixed(0),summitSnow:bi[k+3],banks:above+'/'+samples,bedBelow:+(bed.y-bedH).toFixed(2),boats:demo.boats.length,seaErr:+Math.max(0,...sea).toFixed(3),onRiver:onRiver.every(Boolean),
        bamboo:demo.bambooPartition?demo.bambooPartition.stats().loaded:0,daisugi:!!(demo.daisugi&&demo.daisugi.parent),torii:!!demo.torii.parent};});
    if(!(r.top>300&&r.summitSnow>100&&r.bedBelow>.5&&r.boats>=6&&r.seaErr<.05&&r.onRiver&&r.daisugi&&r.torii))throw Error(JSON.stringify(r));const [a,n]=r.banks.split('/').map(Number);if(a<n*.9)throw Error('river above its banks '+JSON.stringify(r));return r;});
  await test('hiking trails climb to the crater rim and the highest peak and run down to the beach; snow lies above the snow line',async()=>{const r=await page.evaluate(()=>{const H=(x,z)=>demo.terrain.heightAt(x,z),hf=demo.heightfield,bi=demo.terrain.biomeTexture.image.data;
      const snowAt=(x,z)=>bi[(Math.round((z-hf.originZ)/hf.spacing)*hf.size+Math.round((x-hf.originX)/hf.spacing))*4+3];
      const trails=demo.trails.map(t=>{const P=t.points,e=P[P.length-1],m=P[P.length>>1],gr=[];for(let i=0;i+10<P.length;i+=5)gr.push(Math.abs(H(P[i+10].x,P[i+10].z)-H(P[i].x,P[i].z))/10);gr.sort((a,b)=>a-b);
        return {name:t.name,m:P.length,endGap:+Math.hypot(e.x-t.to.x,e.z-t.to.z).toFixed(1),top:+H(e.x,e.z).toFixed(0),mask:+demo.trailAt(m.x,m.z).toFixed(2),p90:+gr[Math.floor(gr.length*.9)].toFixed(2),grade:+gr[gr.length-1].toFixed(2)};});
      /* summit snow on ground flat enough to hold it (steeper faces are bare rock) and off the trodden path, which ends on the summit */
      let ps=0,pn=0;for(let dz=-40;dz<=40;dz+=2)for(let dx=-40;dx<=40;dx+=2){const x=demo.peak.x+dx,z=demo.peak.z+dz;if(dx*dx+dz*dz>1600||demo.trailAt(x,z)>.05||hf.slopeAt(x,z)>1.1||hf.heightAt(x,z)<demo.snowLine+10)continue;ps+=snowAt(x,z);pn++;}
      return {trails,snowLine:+demo.snowLine.toFixed(0),peak:+demo.peak.h.toFixed(0),peakSnow:Math.round(ps/Math.max(1,pn)),peakSamples:pn,spawnSnow:snowAt(demo.spawn.x,demo.spawn.z)};});
    const by=Object.fromEntries(r.trails.map(t=>[t.name,t]));
    if(!(by.volcano&&by.peak&&by.beach))throw Error('missing trails '+JSON.stringify(r));
    /* grade over 10 m of trail: switchbacks keep most of it moderate; hairpin corners on the upper cone are steeper */
    for(const t of r.trails)if(!(t.endGap<8&&t.mask>.9&&t.p90<.5&&t.grade<.85))throw Error(JSON.stringify(t));
    if(!(by.volcano.top>r.snowLine&&by.beach.top<3&&r.peakSamples>3&&r.peakSnow>100&&r.spawnSnow<20))throw Error(JSON.stringify(r));return r;});
  await test('CPU threads take load off the GPU: terrain occlusion on the workers, near-cascade shadow culling, cached far cascades',async()=>{
    const r=await page.evaluate(async()=>{for(let i=0;i<50&&!demo.culler.stats.valid;i++)await new Promise(r=>setTimeout(r,200));const c=demo.culler.stats,s=demo.csm.stats;
      return {workers:c.workers,valid:c.valid,hidden:c.hidden,instances:c.instances,nearShadowSkipped:c.shadowSkipped,cascades:demo.csm.count,shadowMapsDrawn:s.drawn,reused:s.reused};});
    if(!(r.workers>0&&r.valid&&r.hidden>0&&r.hidden<r.instances&&r.nearShadowSkipped>0&&(r.cascades<2||r.reused>0)))throw Error(JSON.stringify(r));return r;});
  /* movement checks run on Low: at High the forest makes software-rendered frames so slow that the fixed-step loop's catch-up cap limits how far anything moves */
  await page.evaluate(()=>KitsuneEngine.applyPreset('low'));await page.waitForTimeout(4000);
  await test('boats can be boarded, driven on the water only, and left at the shore',async()=>{
    const r0=await page.evaluate(()=>{const b=demo.boats.find(b=>b.mode==='moored'),p=b.group.position;demo.teleport(p.x+1,p.z+1);const on=demo.board(b);return {on,boating:!!demo.boating(),x:demo.boatState().x,z:demo.boatState().z};});
    if(!r0.on||!r0.boating)throw Error('could not board '+JSON.stringify(r0));
    /* step the simulation directly (5 s at 60 Hz) so the check does not depend on how fast software rendering is */
    await page.keyboard.down('KeyW');await page.evaluate(()=>{for(let i=0;i<300;i++)demo.loop.update(1/60,i/60);});await page.keyboard.up('KeyW');
    const r1=await page.evaluate(()=>{const s=demo.boatState(),b=demo.boating(),w=demo.waterUnder(s.x,s.z,b.draft);return {x:s.x,z:s.z,speed:+s.speed.toFixed(2),onWater:!!w,heroOnBoat:Math.hypot(demo.getState().x-s.x,demo.getState().z-s.z)<b.length};});
    const moved=Math.hypot(r1.x-r0.x,r1.z-r0.z);if(!(moved>1&&r1.onWater&&r1.heroOnBoat))throw Error('drive '+JSON.stringify({r0,r1,moved}));
    const r2=await page.evaluate(()=>{let off=demo.ashore();for(let i=0;i<40&&!off;i++){const s=demo.boatState(),q=demo.river.nearest(s.x,s.z);demo.setBoatState({x:q.x-q.dz*(q.w*.5-1.2),z:q.z+q.dx*(q.w*.5-1.2),speed:0});off=demo.ashore();}const st=demo.getState();return {off,boating:!!demo.boating(),y:st.y,ground:demo.terrain.heightAt(st.x,st.z)};});
    if(!r2.off||r2.boating||Math.abs(r2.y-.35-r2.ground)>.6)throw Error('ashore '+JSON.stringify(r2));return {moved:+moved.toFixed(1),...r1,ashore:r2.off};});
  await test('walking moves the player',async()=>{const a=await page.evaluate(()=>demo.getState());await page.keyboard.down('KeyW');await page.evaluate(()=>{for(let i=0;i<240;i++)demo.loop.update(1/60,i/60);});await page.keyboard.up('KeyW');const b=await page.evaluate(()=>demo.getState());const d=Math.hypot(b.x-a.x,b.z-a.z);if(!(d>.5))throw Error('moved '+d);return {moved:+d.toFixed(2)};});
  if(shots)await page.screenshot({path:path.join(out,'open-world-ground.png'),timeout:300000});
  await test('fly mode lifts the camera and streams around it',async()=>{const r=await page.evaluate(()=>{const s=demo.getState();demo.flyTo(s.x*1.2,240,s.z*1.2,Math.atan2(s.x,s.z),-.45);return 1;});await page.waitForTimeout(6000);const r2=await page.evaluate(()=>({y:demo.camera.position.y,flying:demo.getState().flying}));if(!(r2.flying&&r2.y>200))throw Error(JSON.stringify(r2));return r2;});
  if(shots)await page.screenshot({path:path.join(out,'open-world-aerial.png'),timeout:300000});
  await test('time of day and rain respond',async()=>{const r=await page.evaluate(()=>{demo.setDay(.85);demo.setRain(true);return demo.getState();});await page.waitForTimeout(3000);if(!(r.raining&&Math.abs(r.day-.85)<1e-6))throw Error(JSON.stringify(r));return {day:r.day,raining:r.raining};});
  await test('no page errors and no network requests',async()=>{if(errors.length)throw Error(errors.join(' | '));if(network.length)throw Error('network: '+network.join(', '));});
  await test('dispose releases the world',async()=>{const r=await page.evaluate(()=>{demo.dispose();return {canvas:!!document.querySelector('canvas')};});if(r.canvas)throw Error('canvas left');});
  await browser.close();console.log(failed?failed+' open-world check(s) failed':'all open-world checks passed');process.exit(failed?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
