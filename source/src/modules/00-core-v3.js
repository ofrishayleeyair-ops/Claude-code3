/* kitsune enginev3 core extensions: versioning, module registry, GPU capability detection,
   v3 quality settings and panel, console variables, frame-budgeted jobs, profiling,
   shared scene uniforms, full-screen passes and shared GLSL. Loaded right after core.js. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=KE.clamp;
Object.assign(KE,{name:'kitsune enginev3',version:'3.0.0',edition:'Tenko',previousVersion:'2.1.0'});
KE.modules={};
KE.registerModule=(name,info={})=>(KE.modules[name]={name,version:KE.version,...info});
KE.registerModule('core-v3',{provides:['capabilities','settings','cvars','jobs','profiler','sceneUniforms','FullScreenQuad','GLSL']});

/* Render layers. Objects on TRANSLUCENT are drawn after the opaque scene has been copied, so their
   shaders may sample KE.sceneUniforms scene color/depth (water, soft particles, refraction). */
KE.LAYERS={DEFAULT:0,TRANSLUCENT:1,EDITOR:31};
KE.prepareCamera=camera=>{camera.layers.enable(KE.LAYERS.TRANSLUCENT);return camera;};

/* ---------- capability detection ---------- */
KE.capabilities=renderer=>{
  const has=n=>!!(renderer.extensions&&renderer.extensions.has&&renderer.extensions.has(n)),c=renderer.capabilities,gl=renderer.getContext();
  const webgl2=!!c.isWebGL2,floatRT=webgl2?has('EXT_color_buffer_float'):has('WEBGL_color_buffer_float')&&has('OES_texture_float');
  const halfRT=webgl2?(floatRT||has('EXT_color_buffer_half_float')):has('EXT_color_buffer_half_float')&&has('OES_texture_half_float');
  return {webgl2,floatRT,halfRT,floatLinear:has('OES_texture_float_linear'),halfLinear:webgl2||has('OES_texture_half_float_linear'),
    depthTexture:webgl2||has('WEBGL_depth_texture'),texture3D:webgl2,drawBuffers:webgl2||has('WEBGL_draw_buffers'),instancing:webgl2||has('ANGLE_instanced_arrays'),
    timerQuery:webgl2?has('EXT_disjoint_timer_query_webgl2'):has('EXT_disjoint_timer_query'),maxSamples:c.maxSamples||0,maxTextures:c.maxTextures,
    maxAnisotropy:c.getMaxAnisotropy?c.getMaxAnisotropy():1,maxTextureSize:c.maxTextureSize,precision:c.precision,
    renderer:(()=>{try{const d=gl.getExtension('WEBGL_debug_renderer_info');return d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);}catch(e){return 'unknown';}})()};
};

/* ---------- v3 quality settings ---------- */
const V3={
  low:      {pipeline:false,gi:false,taa:false,gtao:false,ssr:false,ssgi:false,volumetrics:false,clouds:0,dof:false,motionBlur:false,autoExposure:false,cascades:1,lod:.6, fur:false,vfx:.35,lights:2},
  medium:   {pipeline:true, gi:false,taa:true, gtao:false,ssr:false,ssgi:false,volumetrics:false,clouds:1,dof:false,motionBlur:false,autoExposure:true, cascades:2,lod:.8, fur:true, vfx:.6, lights:4},
  high:     {pipeline:true, gi:true, taa:true, gtao:true, ssr:true, ssgi:false,volumetrics:true, clouds:1,dof:false,motionBlur:false,autoExposure:true, cascades:3,lod:1,  fur:true, vfx:1,  lights:6},
  ultra:    {pipeline:true, gi:true, taa:true, gtao:true, ssr:true, ssgi:true, volumetrics:true, clouds:2,dof:false,motionBlur:false,autoExposure:true, cascades:4,lod:1.25,fur:true, vfx:1,  lights:8},
};
for(const [name,extra] of Object.entries(V3))Object.assign(KE.PRESETS[name],extra);
KE.PRESETS.cinematic={...KE.PRESETS.ultra,preset:'cinematic',scale:1.6,shadowRes:2048,tex:512,grass:20000,view:220,aniso:16,dof:true,motionBlur:true,lod:1.5,lights:12};
KE.PRESET_ORDER=['cinematic','ultra','high','medium','low'];
const BOOL_V3=['pipeline','gi','taa','gtao','ssr','ssgi','volumetrics','dof','motionBlur','autoExposure','fur'];
const NUM_V3=[['clouds',0,2,true],['cascades',1,4,true],['lod',.25,2,false],['vfx',0,1,false],['lights',0,16,true]];
const baseSanitize=KE.sanitizeSettings;
KE.sanitizeSettings=(raw={})=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))raw={};
  const s=baseSanitize(raw),preset=KE.PRESETS[s.preset];
  for(const key of BOOL_V3)s[key]=typeof raw[key]==='boolean'?raw[key]:preset[key];
  for(const [key,min,max,integer] of NUM_V3){const v=Number.isFinite(raw[key])?clamp(raw[key],min,max):preset[key];s[key]=integer?Math.round(v):v;}
  if(raw.preset==='cinematic'&&!Number.isFinite(raw.view))s.view=preset.view;
  return s;
};
{let raw=null;try{raw=JSON.parse(localStorage.getItem('ke_settings')||'null');}catch(e){}
  const valid=KE.sanitizeSettings(raw&&typeof raw==='object'?raw:{...KE.settings});for(const k of Object.keys(KE.settings))if(!(k in valid))delete KE.settings[k];Object.assign(KE.settings,valid);}
/* FPS auto-quality steps down through all five presets. Pass a callback that rebuilds dependent resources. */
KE.FPS.tick=function(now,onDowngrade){this._f++;if(!this._t)this._t=now;const e=now-this._t;if(e>=1000){this.fps=Math.round(this._f*1000/e);this._f=0;this._t=now;
  if(KE.settings.auto&&this.fps<24){if(++this._low>=5){this._low=0;const i=KE.PRESET_ORDER.indexOf(KE.settings.preset);if(i>=0&&i<KE.PRESET_ORDER.length-1){const s=KE.applyPreset(KE.PRESET_ORDER[i+1],{auto:true});onDowngrade&&onDowngrade(s);}}}else this._low=0;}return this.fps;};

/* Grouped panel with every v3 option. Same signature and CSS classes as the 2.x panel. */
KE.settingsPanel=(onChange)=>{const el=document.createElement('div');el.className='ke-panel';const open=new Set(['Quality']);
  const S=()=>KE.settings,esc=v=>String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const row=(label,key,opts)=>`<div class="ke-row"><span>${label}</span><div class="ke-seg">${opts.map(([v,t])=>`<button type="button" data-k="${key}" data-v="${esc(v)}" aria-pressed="${String(S()[key])===String(v)}" class="${String(S()[key])===String(v)?'on':''}">${t}</button>`).join('')}</div></div>`;
  const onOff=(label,key)=>row(label,key,[[false,'Off'],[true,'On']]);
  const group=(title,html)=>`<details class="ke-group" data-g="${title}" ${open.has(title)?'open':''}><summary>${title}</summary>${html}</details>`;
  const draw=()=>{el.innerHTML=group('Quality',`<div class="ke-row"><span>Preset</span><div class="ke-seg">${KE.PRESET_ORDER.slice().reverse().map(p=>`<button type="button" data-p="${p}" class="${S().preset===p&&!S().custom?'on':''}">${p[0].toUpperCase()+p.slice(1)}</button>`).join('')}<button type="button" data-p="auto" class="${S().auto?'on':''}">Auto</button></div></div>
      ${onOff('Tenko render pipeline (HDR)','pipeline')}${row('Render resolution','scale',[[.75,'75%'],[1,'100%'],[1.25,'125%'],[1.6,'160%']])}${row('View distance','view',[[70,'Near'],[95,'Mid'],[120,'Far'],[160,'Max'],[220,'Epic']])}`)
    +group('Lighting and shadows',`${onOff('Shadows','shadows')}${row('Shadow resolution','shadowRes',[[1024,'Soft'],[1536,'Sharp'],[2048,'Ultra']])}${row('Shadow cascades','cascades',[[1,'1'],[2,'2'],[3,'3'],[4,'4']])}
      ${onOff('Probe global illumination','gi')}${onOff('Ambient occlusion (GTAO)','gtao')}${onOff('Screen-space global illumination','ssgi')}${row('Dynamic point lights','lights',[[0,'0'],[2,'2'],[4,'4'],[8,'8'],[12,'12']])}${onOff('Auto exposure','autoExposure')}`)
    +group('Effects',`${onOff('Temporal anti-aliasing','taa')}${onOff('Edge anti-aliasing (FXAA/MSAA)','aa')}${onOff('Bloom','bloom')}${onOff('Screen-space reflections','ssr')}${onOff('Volumetric light and fog','volumetrics')}
      ${row('Volumetric clouds','clouds',[[0,'Off'],[1,'Fast'],[2,'Rich']])}${onOff('Depth of field','dof')}${onOff('Motion blur','motionBlur')}${onOff('Weather effects','fx')}`)
    +group('World',`${row('Texture detail','tex',[[128,'Low'],[256,'High'],[512,'Ultra']])}${row('Terrain detail','terrain',[[1,'Normal'],[2,'Detailed'],[3,'Epic']])}${row('Grass','grass',[[0,'Off'],[3000,'Low'],[7000,'High'],[14000,'Ultra'],[20000,'Epic']])}
      ${row('Geometry detail (LOD)','lod',[[.6,'Low'],[1,'High'],[1.5,'Epic']])}${onOff('Fur','fur')}${row('Particle budget','vfx',[[.35,'Low'],[.6,'Mid'],[1,'Full']])}`)
    +group('Interface',`${row('Camera','cam',[['follow','3D behind'],['classic','Top view']])}${onOff('Show FPS','showFps')}`)
    +`<p class="ke-note">${KE.name} ${KE.version} · ${KE.edition}. Texture, terrain and edge anti-aliasing changes apply the next time 3D starts.</p>`;
    el.querySelectorAll('details').forEach(d=>d.addEventListener('toggle',()=>{d.open?open.add(d.dataset.g):open.delete(d.dataset.g);}));
    el.querySelectorAll('[data-p]').forEach(b=>b.onclick=()=>{if(b.dataset.p==='auto')KE.applyPreset(KE.detectPreset(),{auto:true});else KE.applyPreset(b.dataset.p);draw();onChange&&onChange(KE.settings);});
    el.querySelectorAll('[data-k]').forEach(b=>b.onclick=()=>{const k=b.dataset.k,raw=b.dataset.v,v=raw==='true'?true:raw==='false'?false:isNaN(+raw)?raw:+raw;KE.settings[k]=v;KE.settings.auto=false;KE.settings.custom=true;KE.saveSettings(KE.settings);draw();onChange&&onChange(KE.settings,k);KE.events.emit('settings',KE.settings,k);});};
  draw();return el;};
if(typeof document!=='undefined'&&document.head){const st=document.createElement('style');st.textContent='.ke-group{border-top:1px solid #0002;padding:6px 0}.ke-group>summary{cursor:pointer;font-weight:700;font-size:13px;padding:6px 0;list-style-position:inside}.ke-group[open]>summary{margin-bottom:6px}.ke-group .ke-row{margin-bottom:8px}';document.head.appendChild(st);}

/* ---------- console variables ---------- */
/* Named, typed engine variables in the spirit of r.* / stat console commands. Settings-bound
   cvars write through KE.setSettings, which emits the 'settings' event games already handle. */
KE.cvars={
  map:new Map(),
  register(name,{value,help='',type,min=-Infinity,max=Infinity,options=null,onChange=null,get=null,set=null}={}){
    const cv={name,help,type:type||typeof value,min,max,options,onChange,getter:get,setter:set,value};this.map.set(name.toLowerCase(),cv);return cv;},
  find(name){return this.map.get(String(name).toLowerCase())||null;},
  get(name){const cv=this.find(name);if(!cv)return undefined;return cv.getter?cv.getter():cv.value;},
  parse(cv,raw){if(cv.type==='boolean')return raw===true||raw===1||/^(1|true|on|yes)$/i.test(String(raw));if(cv.type==='number'){const n=Number(raw);if(!Number.isFinite(n))throw new TypeError(cv.name+' expects a number');return clamp(n,cv.min,cv.max);}
    const s=String(raw);if(cv.options&&!cv.options.includes(s))throw new RangeError(cv.name+' must be one of '+cv.options.join(', '));return s;},
  set(name,raw){const cv=this.find(name);if(!cv)throw new Error('Unknown console variable: '+name);const v=this.parse(cv,raw);if(cv.setter)cv.setter(v);else cv.value=v;if(cv.onChange)cv.onChange(v);return this.get(name);},
  list(prefix=''){return [...this.map.values()].filter(c=>c.name.toLowerCase().startsWith(prefix.toLowerCase())).map(c=>({name:c.name,value:this.get(c.name),help:c.help}));}
};
for(const [name,key,help,type,min,max,scale=1] of [
  ['r.TAA','taa','Temporal anti-aliasing','boolean'],['r.GTAO','gtao','Ground-truth ambient occlusion','boolean'],['r.SSR','ssr','Screen-space reflections','boolean'],
  ['r.SSGI','ssgi','Screen-space global illumination','boolean'],['r.GI','gi','Probe-volume dynamic diffuse GI','boolean'],['r.Bloom','bloom','Bloom','boolean'],['r.Shadows','shadows','Sun shadows','boolean'],
  ['r.Shadow.Cascades','cascades','Cascaded shadow map count','number',1,4],['r.Shadow.Resolution','shadowRes','Shadow map resolution','number',512,2048],
  ['r.Volumetrics','volumetrics','Light shafts and height fog','boolean'],['r.Clouds','clouds','Cloud quality 0-2','number',0,2],['r.DOF','dof','Depth of field','boolean'],
  ['r.MotionBlur','motionBlur','Camera motion blur','boolean'],['r.AutoExposure','autoExposure','Eye adaptation','boolean'],['r.Pipeline','pipeline','HDR post pipeline','boolean'],
  ['r.ScreenPercentage','scale','Render scale percent','number',50,200,100],['r.ViewDistance','view','Fog/view distance','number',30,300],['r.LODBias','lod','Geometry detail multiplier','number',.25,2],
  ['r.Lights','lights','Max dynamic point lights','number',0,16],['foliage.Grass','grass','Grass blade budget','number',0,20000],['fx.Budget','vfx','Particle budget 0-1','number',0,1],['r.Fur','fur','Shell fur','boolean']])
  KE.cvars.register(name,{help,type,min,max,get:()=>type==='number'?KE.settings[key]*scale:KE.settings[key],set:v=>{KE.settings.auto=false;KE.settings.custom=true;KE.setSettings({[key]:type==='number'?v/scale:v});}});
KE.cvars.register('t.MaxFPS',{value:0,type:'number',min:0,max:240,help:'Frame cap for KE.Loop users that honor it (0 = uncapped)'});
KE.cvars.register('r.ViewMode',{value:'lit',type:'string',options:['lit','unlit','ao','normals','depth','lighting','bloom','velocity','ssr','ssgi'],help:'Pipeline debug visualization'});

/* ---------- frame-budgeted jobs ---------- */
/* A task is a function (called until it returns true) or an iterator/generator (resumed until done).
   run(ms) spends at most that much wall time per frame; add() returns a promise with cancel(). */
KE.Jobs=class{
  constructor(){this.queue=[];this.spent=0;}
  add(task,{priority=0,name='job'}={}){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});const job={task:typeof task==='function'&&task.constructor.name==='GeneratorFunction'?task():task,priority,name,resolve,reject,cancelled:false};
    this.queue.push(job);this.queue.sort((a,b)=>b.priority-a.priority);promise.cancel=()=>{job.cancelled=true;};return promise;}
  get pending(){return this.queue.length;}
  run(budgetMs=2){const now=()=>performance.now(),end=now()+budgetMs;let steps=0;
    while(this.queue.length&&(now()<end||steps===0)){const job=this.queue[0];steps++;if(job.cancelled){this.queue.shift();job.reject(new Error('cancelled'));continue;}
      try{let done,value;if(typeof job.task==='function'){value=job.task();done=value===true||value===undefined;}else{const r=job.task.next();done=r.done;value=r.value;}
        if(done){this.queue.shift();job.resolve(value===true?undefined:value);}}catch(e){this.queue.shift();job.reject(e);}}
    this.spent=now()-(end-budgetMs);return steps;}
  clear(){for(const j of this.queue)j.reject(new Error('cleared'));this.queue.length=0;}
};
KE.jobs=new KE.Jobs();

/* ---------- profiling ---------- */
/* CPU scopes with smoothed averages; optional GPU timing where EXT_disjoint_timer_query is exposed. */
KE.Profiler=class{
  constructor(){this.scopes=new Map();this.open=new Map();}
  begin(name){this.open.set(name,performance.now());}
  end(name){const t=this.open.get(name);if(t===undefined)return 0;const ms=performance.now()-t;this.open.delete(name);const s=this.scopes.get(name)||{avg:ms,max:ms,last:ms};s.avg+= (ms-s.avg)*.1;s.last=ms;s.max=Math.max(s.max*.995,ms);this.scopes.set(name,s);return ms;}
  measure(name,fn){this.begin(name);try{return fn();}finally{this.end(name);}}
  report(){return [...this.scopes.entries()].map(([name,s])=>({name,avg:s.avg,last:s.last,max:s.max}));}
};
KE.profiler=new KE.Profiler();
KE.GPUTimer=class{
  constructor(renderer){const gl=renderer.getContext();this.gl=gl;this.webgl2=!!renderer.capabilities.isWebGL2;this.ext=this.webgl2?gl.getExtension('EXT_disjoint_timer_query_webgl2'):gl.getExtension('EXT_disjoint_timer_query');this.pending=[];this.ms=0;this.available=!!this.ext;}
  begin(){if(!this.available||this.active)return;const gl=this.gl,e=this.ext;this.active=this.webgl2?gl.createQuery():e.createQueryEXT();this.webgl2?gl.beginQuery(e.TIME_ELAPSED_EXT,this.active):e.beginQueryEXT(e.TIME_ELAPSED_EXT,this.active);}
  end(){if(!this.active)return;const gl=this.gl,e=this.ext;this.webgl2?gl.endQuery(e.TIME_ELAPSED_EXT):e.endQueryEXT(e.TIME_ELAPSED_EXT);this.pending.push(this.active);this.active=null;this.poll();}
  poll(){const gl=this.gl,e=this.ext;while(this.pending.length){const q=this.pending[0];const ready=this.webgl2?gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE):e.getQueryObjectEXT(q,e.QUERY_RESULT_AVAILABLE_EXT);if(!ready)break;const disjoint=gl.getParameter(e.GPU_DISJOINT_EXT);
    const ns=this.webgl2?gl.getQueryParameter(q,gl.QUERY_RESULT):e.getQueryObjectEXT(q,e.QUERY_RESULT_EXT);if(!disjoint)this.ms+=(ns/1e6-this.ms)*.1;this.webgl2?gl.deleteQuery(q):e.deleteQueryEXT(q);this.pending.shift();}}
  dispose(){const gl=this.gl,e=this.ext;for(const q of this.pending)this.webgl2?gl.deleteQuery(q):e.deleteQueryEXT(q);this.pending.length=0;}
};

/* ---------- shared scene uniforms ---------- */
/* One set of uniform objects shared by reference across materials. KE.Pipeline fills them each frame;
   without a pipeline keHasScene stays 0 and shaders must fall back (e.g. water uses its baked depth). */
KE.sceneUniforms=THREE=>{if(KE._sceneUniforms)return KE._sceneUniforms;return KE._sceneUniforms={
  keSceneColor:{value:null},keSceneDepth:{value:null},keHasScene:{value:0},keResolution:{value:new THREE.Vector2(1,1)},keNearFar:{value:new THREE.Vector2(.1,1000)},
  keInvProjection:{value:new THREE.Matrix4()},keProjection:{value:new THREE.Matrix4()},keViewMatrix:{value:new THREE.Matrix4()},keInvView:{value:new THREE.Matrix4()},
  keTime:{value:0},keFrame:{value:0},keSSR:{value:1},keSunDirection:{value:new THREE.Vector3(.3,.8,.2).normalize()},keSunColor:{value:new THREE.Color(1,1,1)},keExposure:{value:1}};};
/* GLSL declarations matching KE.sceneUniforms; merge the uniform objects into a material with Object.assign(material.uniforms, KE.sceneUniforms(THREE)). */
KE.GLSL_SCENE_DECL='uniform sampler2D keSceneColor;uniform sampler2D keSceneDepth;uniform float keHasScene;uniform vec2 keResolution;uniform vec2 keNearFar;uniform mat4 keInvProjection;uniform mat4 keProjection;uniform mat4 keViewMatrix;uniform mat4 keInvView;uniform float keTime;uniform float keFrame;uniform float keSSR;uniform vec3 keSunDirection;uniform vec3 keSunColor;uniform float keExposure;';

/* ---------- full-screen pass helper ---------- */
KE.FullScreenQuad=class{
  constructor(THREE,material=null){this.camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([-1,3,0,-1,-1,0,3,-1,0],3));g.setAttribute('uv',new THREE.Float32BufferAttribute([0,2,0,0,2,0],2));
    this.mesh=new THREE.Mesh(g,material);this.mesh.frustumCulled=false;this.scene=new THREE.Scene();this.scene.add(this.mesh);}
  get material(){return this.mesh.material;}set material(m){this.mesh.material=m;}
  render(renderer,target=null,material=null){if(material)this.mesh.material=material;const prev=renderer.getRenderTarget(),auto=renderer.autoClear;renderer.setRenderTarget(target);renderer.autoClear=false;renderer.render(this.scene,this.camera);renderer.autoClear=auto;renderer.setRenderTarget(prev);}
  dispose(){this.mesh.geometry.dispose();}
};
/* Vertex shader for full-screen passes: position is already in clip space. */
KE.FULLSCREEN_VS='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';

/* ---------- shared GLSL ---------- */
KE.GLSL={
  hash:`float keHash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
vec2 keHash22(vec2 p){vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));p3+=dot(p3,p3.yzx+33.33);return fract((p3.xx+p3.yz)*p3.zy);}
float keHash13(vec3 p3){p3=fract(p3*.1031);p3+=dot(p3,p3.zyx+31.32);return fract((p3.x+p3.y)*p3.z);}
vec3 keHash33(vec3 p3){p3=fract(p3*vec3(.1031,.1030,.0973));p3+=dot(p3,p3.yxz+33.33);return fract((p3.xxy+p3.yxx)*p3.zyx);}`,
  noise:`float keNoise3(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
return mix(mix(mix(keHash13(i),keHash13(i+vec3(1,0,0)),f.x),mix(keHash13(i+vec3(0,1,0)),keHash13(i+vec3(1,1,0)),f.x),f.y),mix(mix(keHash13(i+vec3(0,0,1)),keHash13(i+vec3(1,0,1)),f.x),mix(keHash13(i+vec3(0,1,1)),keHash13(i+vec3(1,1,1)),f.x),f.y),f.z);}
float keNoise2(vec2 x){vec2 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);return mix(mix(keHash12(i),keHash12(i+vec2(1,0)),f.x),mix(keHash12(i+vec2(0,1)),keHash12(i+vec2(1,1)),f.x),f.y);}
float keFbm3(vec3 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*keNoise3(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s;}
float keFbm2(vec2 p){float a=.5,s=0.;for(int i=0;i<5;i++){s+=a*keNoise2(p);p=mat2(1.6,1.2,-1.2,1.6)*p+vec2(1.7,9.2);a*=.5;}return s;}
vec3 keCurl3(vec3 p){const float e=.1;vec3 dx=vec3(e,0,0),dy=vec3(0,e,0),dz=vec3(0,0,e);
float n1=keNoise3(p+dy+vec3(31.4))-keNoise3(p-dy+vec3(31.4)),n2=keNoise3(p+dz+vec3(31.4))-keNoise3(p-dz+vec3(31.4)),n3=keNoise3(p+dz)-keNoise3(p-dz),n4=keNoise3(p+dx)-keNoise3(p-dx),n5=keNoise3(p+dx+vec3(71.3))-keNoise3(p-dx+vec3(71.3)),n6=keNoise3(p+dy+vec3(71.3))-keNoise3(p-dy+vec3(71.3));
return vec3(n1-n2,n3-n4,n5-n6)/(2.*e);}`,
  color:`float keLuma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec3 keACES(vec3 x){const mat3 i=mat3(.59719,.07600,.02840,.35458,.90834,.13383,.04823,.01566,.83777);const mat3 o=mat3(1.60475,-.10208,-.00327,-.53108,1.10813,-.07276,-.07367,-.00605,1.07602);
x=i*x;vec3 a=x*(x+.0245786)-.000090537;vec3 b=x*(.983729*x+.4329510)+.238081;return clamp(o*(a/b),0.,1.);}
vec3 keLinearToSRGB(vec3 c){return mix(c*12.92,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(vec3(.0031308),c));}
vec3 keRGBToYCoCg(vec3 c){return vec3(dot(c,vec3(.25,.5,.25)),dot(c,vec3(.5,0.,-.5)),dot(c,vec3(-.25,.5,-.25)));}
vec3 keYCoCgToRGB(vec3 c){return vec3(c.x+c.y-c.z,c.x+c.z,c.x-c.y-c.z);}`,
  depth:`float keViewZFromDepth(float d,float n,float f){return n*f/((f-n)*d-f);}
vec3 keViewPosFromDepth(vec2 uv,float d,mat4 invProj){vec4 p=invProj*vec4(vec3(uv,d)*2.-1.,1.);return p.xyz/p.w;}`
};
KE.GLSL.all=KE.GLSL.hash+'\n'+KE.GLSL.noise+'\n'+KE.GLSL.color+'\n'+KE.GLSL.depth;
})();
