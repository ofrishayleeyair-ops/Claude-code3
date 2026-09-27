/* Real-browser test harness for engine modules (headless Chromium + SwiftShader WebGL2).
 *
 *   const {openPage}=require('./harness.cjs');
 *   const {page,errors,close}=await openPage({modules:['src/modules/40-physics.js'],libs:true,atlas:false,body:'<canvas id=c></canvas>'});
 *   const result=await page.evaluate(async()=>{ ... uses window.THREE and window.KitsuneEngine ... });
 *   await page.screenshot({path:'.test-output/physics.png'});
 *   await close();  // throws if uncaught page errors or console errors were recorded (unless allowErrors)
 *
 * The page loads three.min.js, three-addons.js, optionally kitsune-libs.js (Rapier + meshoptimizer),
 * src/core.js, optionally the embedded atlas, then the given module files, all from local file:// URLs.
 * Pass engine:'built' to load assets/kitsune-engine.js (all modules) instead of core + listed modules.
 */
const fs=require('fs'),path=require('path');
const ROOT=path.resolve(__dirname,'..');
function loadPlaywright(){for(const id of ['playwright','/opt/node22/lib/node_modules/playwright']){try{return require(id);}catch(e){}}throw new Error('Playwright is required: npm i -g playwright (Chromium must be installed)');}
const url=p=>'file://'+path.resolve(ROOT,p);
async function openPage({modules=[],libs=false,atlas=false,engine='core',body='',head='',viewport={width:960,height:600},allowErrors=false,name='harness'}={}){
  const {chromium}=loadPlaywright();const out=path.join(ROOT,'.test-output');fs.mkdirSync(out,{recursive:true});
  const scripts=['assets/three.min.js','assets/three-addons.js'];if(libs)scripts.push('assets/kitsune-libs.js');
  if(engine==='built')scripts.push('assets/kitsune-engine.js');else{scripts.push('src/core.js');if(atlas){const a=Buffer.from(fs.readFileSync(path.join(ROOT,'assets/surface-atlas.png'))).toString('base64');fs.writeFileSync(path.join(out,'atlas.js'),`window.KitsuneEngine.visualAtlasURL='data:image/png;base64,${a}';`);scripts.push('.test-output/atlas.js');}scripts.push(...modules);}
  const html=`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block}</style>${head}</head><body>${body}${scripts.map(s=>`<script src="${url(s)}"></script>`).join('\n')}</body></html>`;
  const file=path.join(out,name+'-'+process.pid+'-'+Date.now()+'.html');fs.writeFileSync(file,html);
  const browser=await chromium.launch({headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--enable-webgl']});
  const page=await browser.newPage({viewport});const errors=[],network=[];
  page.on('pageerror',e=>errors.push('pageerror: '+(e.stack||e.message)));page.on('console',m=>{if(m.type()==='error')errors.push('console.error: '+m.text());});
  page.on('request',r=>{if(/^https?:/.test(r.url()))network.push(r.url());});
  await page.goto('file://'+file);
  const close=async()=>{await browser.close();try{fs.unlinkSync(file);}catch(e){}if(!allowErrors&&errors.length)throw new Error('Browser errors:\n'+errors.join('\n'));if(network.length)throw new Error('Unexpected network requests: '+network.join(', '));};
  return {browser,page,errors,network,close,outDir:out};
}
module.exports={openPage,ROOT};
