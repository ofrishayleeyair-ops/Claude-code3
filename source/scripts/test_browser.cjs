/* Optional real browser test. Requires playwright and its Chromium browser.
   node scripts/test_browser.cjs path/to/spirit-isle.html path/to/screenshots */
const {chromium}=require('playwright');
const path=require('path'),fs=require('fs');
const source=path.resolve(process.argv[2]||'spirit-isle.html');const output=path.resolve(process.argv[3]||'browser-check');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1280,height:800}});const errors=[],network=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
 await page.goto('file://'+source);await page.waitForFunction(()=>window.demo,{timeout:60000});
 await page.click('#start');await page.waitForTimeout(1800);await page.screenshot({path:path.join(output,'desktop.png')});
 const initial=await page.evaluate(()=>demo.getState());await page.keyboard.down('KeyW');await page.waitForTimeout(1200);await page.keyboard.up('KeyW');const moved=await page.evaluate(()=>demo.getState());
 const terrain=await page.evaluate(()=>{const T=THREE,KE=KitsuneEngine,m=KE.terrain(T,{w:4,h:4,sub:1,chunk:1,height:(x,z)=>x*x+z*z+x*z,material:new T.MeshBasicMaterial()});const ray=new T.Raycaster(),origin=new T.Vector3(),dir=new T.Vector3(0,-1,0);let error=0;for(let x=.6;x<3.4;x+=.23)for(let z=.6;z<3.4;z+=.29){ray.set(origin.set(x,100,z),dir);for(const mesh of m)mesh.updateMatrixWorld();const hits=ray.intersectObjects(m);if(!hits.length)throw Error('Terrain ray miss');error=Math.max(error,Math.abs(hits[0].point.y-m.heightAt(x,z)));}m.dispose();return error;});
 await page.click('#gfx');await page.locator('[data-p="low"]').click();await page.click('#close-panel');await page.waitForTimeout(500);
 const preset=await page.evaluate(()=>({preset:demo.KE.settings.preset,shadows:demo.renderer.shadowMap.enabled,pr:demo.renderer.getPixelRatio()}));
 await page.click('#gfx');await page.locator('[data-p="high"]').click();await page.click('#close-panel');await page.waitForTimeout(700);
 await page.evaluate(()=>{demo.setDay(.81);demo.setRain(true);});await page.waitForTimeout(500);await page.screenshot({path:path.join(output,'night.png')});
 await page.evaluate(()=>{demo.setDay(.25);demo.setRain(false);});
 await page.click('#gfx');await page.click('#save');await page.click('#reset');await page.click('#load');await page.click('#close-panel');
 const save=await page.evaluate(()=>demo.getState());
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(500);await page.screenshot({path:path.join(output,'mobile.png')});
 const mobile=await page.evaluate(()=>({width:innerWidth,body:document.body.scrollWidth,canvasWidth:demo.renderer.domElement.clientWidth,aspect:demo.camera.aspect}));
 console.log(JSON.stringify({errors,network,initial,moved,terrainMaxError:terrain,preset,save,mobile},null,2));await browser.close();if(errors.length||network.length||terrain>1e-5||initial.z===moved.z)process.exit(1);
})().catch(e=>{console.error(e);process.exit(1)});
