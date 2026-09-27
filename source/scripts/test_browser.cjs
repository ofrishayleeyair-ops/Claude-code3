/* Real browser test of a built game (Spirit Isle by default). Requires Playwright and its Chromium browser.
   node scripts/test_browser.cjs path/to/spirit-isle.html path/to/screenshots
   Runs under SwiftShader when no GPU is present, which is slow: timeouts are generous and the viewport small. */
const path=require('path'),fs=require('fs');
let playwright;for(const id of ['playwright','/opt/node22/lib/node_modules/playwright']){try{playwright=require(id);break;}catch(e){}}
if(!playwright){console.error('Playwright is required');process.exit(1);}
const source=path.resolve(process.argv[2]||'spirit-isle.html');const output=path.resolve(process.argv[3]||'browser-check');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:960,height:600}});const errors=[],network=[];const shot=name=>page.screenshot({path:path.join(output,name+'.png'),timeout:300000});
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
 await page.goto('file://'+source);await page.waitForFunction(()=>window.demo||document.querySelector('.error'),null,{timeout:240000});
 if(!await page.evaluate(()=>!!window.demo))throw new Error('Game failed to start: '+await page.evaluate(()=>document.querySelector('.error').textContent));
 await page.evaluate(()=>{demo.KE.applyPreset('high');demo.KE.setSettings({scale:1});});
 await page.click('#start');await page.waitForTimeout(3000);await shot('desktop');
 const initial=await page.evaluate(()=>demo.getState());await page.keyboard.down('KeyW');await page.waitForTimeout(4000);await page.keyboard.up('KeyW');const moved=await page.evaluate(()=>demo.getState());
 const terrain=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine,m=KE.terrain(T,{w:4,h:4,sub:1,chunk:1,height:(x,z)=>x*x+z*z+x*z,material:new T.MeshBasicMaterial()});const ray=new T.Raycaster(),origin=new T.Vector3(),dir=new T.Vector3(0,-1,0);let error=0;for(let x=.6;x<3.4;x+=.23)for(let z=.6;z<3.4;z+=.29){ray.set(origin.set(x,100,z),dir);for(const mesh of m)mesh.updateMatrixWorld();const hits=ray.intersectObjects(m);if(!hits.length)throw Error('Terrain ray miss');error=Math.max(error,Math.abs(hits[0].point.y-m.heightAt(x,z)));}m.dispose();return error;});
 const systems=await page.evaluate(()=>{const p=demo.pipeline&&demo.pipeline();return {version:demo.KE.version,modules:Object.keys(demo.KE.modules),pipeline:!!(p&&p.enabled),passes:p?p.stats.passes:0,env:!!demo.scene.environment,background:!!demo.scene.background,cascades:demo.csm?demo.csm.lights.length:0,poolLights:demo.lights?demo.lights.real.length:0,water:!!demo.water};});
 await page.click('#gfx');await page.locator('[data-p="low"]').click();await page.click('#close-panel');await page.waitForTimeout(1500);
 const preset=await page.evaluate(()=>({preset:demo.KE.settings.preset,shadows:demo.renderer.shadowMap.enabled,pipeline:demo.pipeline().enabled,pr:demo.renderer.getPixelRatio()}));await shot('low');
 await page.click('#gfx');await page.locator('[data-p="ultra"]').click();await page.click('#close-panel');await page.evaluate(()=>demo.KE.setSettings({scale:1}));await page.waitForTimeout(2000);
 await page.evaluate(()=>{demo.setDay(.84);demo.setRain(true);});await page.waitForTimeout(4000);await shot('night');
 await page.evaluate(()=>{demo.setDay(.6);demo.setRain(false);});await page.waitForTimeout(4000);await shot('sunset');
 await page.evaluate(()=>{demo.setDay(.25);});
 const beforeSave=await page.evaluate(()=>demo.getState());await page.click('#gfx');await page.click('#save');await page.click('#reset');await page.click('#load');await page.click('#close-panel');
 const save=await page.evaluate(()=>demo.getState());
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(3000);await shot('mobile');
 const mobile=await page.evaluate(()=>({width:innerWidth,body:document.body.scrollWidth,canvasWidth:demo.renderer.domElement.clientWidth,aspect:demo.camera.aspect}));
 const disposed=await page.evaluate(()=>{demo.dispose();return {canvas:!!document.querySelector('canvas')};});
 console.log(JSON.stringify({errors,network,initial,moved,terrainMaxError:terrain,systems,preset,beforeSave,save,mobile,disposed},null,2));await browser.close();
 const failed=errors.length||network.length||terrain>1e-5||initial.z===moved.z||!systems.pipeline||!systems.env||preset.pipeline||preset.shadows||Math.abs(save.x-beforeSave.x)>.05||Math.abs(save.z-beforeSave.z)>.05||mobile.body>mobile.width||disposed.canvas;
 if(failed){console.error('Browser test failed');process.exit(1);}
})().catch(e=>{console.error(e);process.exit(1)});
