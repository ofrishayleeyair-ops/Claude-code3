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
  await test('walking moves the player',async()=>{const a=await page.evaluate(()=>demo.getState());await page.keyboard.down('KeyW');await page.waitForTimeout(4000);await page.keyboard.up('KeyW');const b=await page.evaluate(()=>demo.getState());const d=Math.hypot(b.x-a.x,b.z-a.z);if(!(d>.5))throw Error('moved '+d);return {moved:+d.toFixed(2)};});
  if(shots)await page.screenshot({path:path.join(out,'open-world-ground.png'),timeout:300000});
  await test('fly mode lifts the camera and streams around it',async()=>{const r=await page.evaluate(()=>{const s=demo.getState();demo.flyTo(s.x*1.2,240,s.z*1.2,Math.atan2(s.x,s.z),-.45);return 1;});await page.waitForTimeout(6000);const r2=await page.evaluate(()=>({y:demo.camera.position.y,flying:demo.getState().flying}));if(!(r2.flying&&r2.y>200))throw Error(JSON.stringify(r2));return r2;});
  if(shots)await page.screenshot({path:path.join(out,'open-world-aerial.png'),timeout:300000});
  await test('time of day and rain respond',async()=>{const r=await page.evaluate(()=>{demo.setDay(.85);demo.setRain(true);return demo.getState();});await page.waitForTimeout(3000);if(!(r.raining&&Math.abs(r.day-.85)<1e-6))throw Error(JSON.stringify(r));return {day:r.day,raining:r.raining};});
  await test('no page errors and no network requests',async()=>{if(errors.length)throw Error(errors.join(' | '));if(network.length)throw Error('network: '+network.join(', '));});
  await test('dispose releases the world',async()=>{const r=await page.evaluate(()=>{demo.dispose();return {canvas:!!document.querySelector('canvas')};});if(r.canvas)throw Error('canvas left');});
  await browser.close();console.log(failed?failed+' open-world check(s) failed':'all open-world checks passed');process.exit(failed?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
