/* kitsune enginev3 gameplay framework.
   KE.GameWorld: actors made of schema-described components, world timers and tweens, tag/name indices.
   KE.Components / KE.ActorClasses / KE.Prefabs: registries that drive spawning and the editor UI.
   KE.Level: strict, versioned JSON levels. KE.Blueprint: data-driven event graphs run by a small
   interpreter over a whitelisted node set and a safe expression evaluator (no eval / Function).
   Optional systems (physics, VFX, audio, material graphs) are reached only through runtime guards. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=KE.clamp||((v,a,b)=>Math.min(b,Math.max(a,v)));
const DEG=Math.PI/180,RAD=180/Math.PI,EPS=1e-6;

/* ---------- limits and small data helpers ---------- */
const LIMITS={name:128,className:64,tag:64,tags:32,string:256,text:2000,components:32,actors:20000,jsonDepth:16,jsonNodes:20000,
  coord:1e7,levelChars:96*1024*1024,assetChars:64*1024*1024,actions:4000,actionDepth:16,exprDepth:32,exprChars:1000,steps:20000,variables:256};
const BAD_KEYS=new Set(['__proto__','constructor','prototype']);
const isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const has=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
const round6=v=>{const r=Math.round(v*1e6)/1e6;return r===0?0:r;};
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));
const NAME_RE=/^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/* Deep-copies plain JSON data: finite numbers, bounded strings, arrays and plain objects only.
   Drops prototype keys, functions, non-finite numbers and anything past the depth/node budget. */
function sanitizeJSON(value,warn,where='value',budget={nodes:LIMITS.jsonNodes},depth=0){
  if(--budget.nodes<0){if(budget.nodes===-1)warn(where+': data too large, truncated');return undefined;}
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(Number.isFinite(value))return value;warn(where+': non-finite number dropped');return undefined;}
  if(typeof value==='string'){if(value.length>LIMITS.text){warn(where+': string truncated');return value.slice(0,LIMITS.text);}return value;}
  if(typeof value!=='object'){warn(where+': unsupported '+typeof value+' dropped');return undefined;}
  if(depth>=LIMITS.jsonDepth){warn(where+': nested too deeply');return undefined;}
  if(Array.isArray(value)){const out=[];for(let i=0;i<value.length&&budget.nodes>=0;i++){const v=sanitizeJSON(value[i],warn,where,budget,depth+1);if(v!==undefined)out.push(v);}return out;}
  const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null){warn(where+': only plain objects are allowed');return undefined;}
  const out={};for(const k of Object.keys(value)){if(BAD_KEYS.has(k)||k.length>LIMITS.string){warn(where+': key "'+k.slice(0,32)+'" rejected');continue;}const v=sanitizeJSON(value[k],warn,where,budget,depth+1);if(v!==undefined)out[k]=v;if(budget.nodes<0)break;}return out;
}
function getPath(o,path){let v=o;for(const p of path.split('.')){if(v===null||typeof v!=='object'||!has(v,p))return undefined;v=v[p];}return v;}
function setPath(o,path,value){const parts=path.split('.');let t=o;for(let i=0;i<parts.length-1;i++){const p=parts[i];if(BAD_KEYS.has(p))throw new Error('Invalid property path');if(!isObj(t[p]))t[p]={};t=t[p];}const last=parts[parts.length-1];if(BAD_KEYS.has(last))throw new Error('Invalid property path');t[last]=value;}
function normColor(v){
  if(typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<=0xffffff)return '#'+v.toString(16).padStart(6,'0');
  if(typeof v==='string'){const s=v.trim().toLowerCase();if(/^#[0-9a-f]{6}$/.test(s))return s;if(/^#[0-9a-f]{3}$/.test(s))return '#'+s[1]+s[1]+s[2]+s[2]+s[3]+s[3];if(/^0x[0-9a-f]{6}$/.test(s))return '#'+s.slice(2);}
  if(v&&v.isColor)return '#'+v.getHexString();
  if(Array.isArray(v)&&v.length===3&&v.every(n=>Number.isFinite(n)))return '#'+v.map(n=>Math.round(clamp(n,0,1)*255).toString(16).padStart(2,'0')).join('');
  return null;
}
function vec3Of(v){if(Array.isArray(v)&&v.length===3&&v.every(n=>typeof n==='number'&&Number.isFinite(n)))return v.slice();if(v&&typeof v==='object'&&['x','y','z'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])))return [v.x,v.y,v.z];return null;}

/* ---------- schema fields ---------- */
/* Field types: number, vec3, color, bool, string, enum, asset, json. Keys may be dotted paths
   ('mesh.material.color') into nested props. `when(props)` hides a field that does not apply;
   hidden fields are not serialized. */
const FIELD_TYPES=new Set(['number','vec3','color','bool','string','enum','asset','json','text']);
function normalizeField(key,f){
  if(!isObj(f))throw new TypeError('Schema field '+key+' must be an object');
  const type=f.type||'string';if(!FIELD_TYPES.has(type))throw new TypeError('Unknown schema type '+type+' for '+key);
  for(const p of key.split('.'))if(!p||BAD_KEYS.has(p))throw new TypeError('Invalid schema key '+key);
  const out={...f,type,key};
  if(out.default===undefined)out.default={number:0,vec3:[0,0,0],color:'#ffffff',bool:false,string:'',text:'',enum:(f.options||[''])[0],asset:'',json:null}[type];
  if(type==='color')out.default=normColor(out.default)||'#ffffff';
  if(type==='enum'&&(!Array.isArray(out.options)||!out.options.length))throw new TypeError('Enum field '+key+' needs options');
  if(!out.label)out.label=key.split('.').pop().replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());
  return out;
}
function sanitizeField(f,v,warn,where){
  const def=()=>clone(f.default);
  if(v===undefined)return def();
  switch(f.type){
    case 'number':{const n=typeof v==='number'?v:(typeof v==='string'&&v.trim()!==''?Number(v):NaN);if(!Number.isFinite(n)){warn(where+' must be a finite number');return def();}
      let r=clamp(n,f.min!==undefined?f.min:-Infinity,f.max!==undefined?f.max:Infinity);if(f.integer)r=Math.round(r);return r;}
    case 'vec3':{const a=vec3Of(v);if(!a){warn(where+' must be [x,y,z] finite numbers');return def();}return a.map(n=>clamp(n,f.min!==undefined?f.min:-LIMITS.coord,f.max!==undefined?f.max:LIMITS.coord));}
    case 'color':{const c=normColor(v);if(!c){warn(where+' must be a color');return def();}return c;}
    case 'bool':if(typeof v==='boolean')return v;if(v===0||v===1)return !!v;warn(where+' must be true or false');return def();
    case 'enum':{const s=String(v);if(!f.options.includes(s)){warn(where+' must be one of '+f.options.join(', '));return def();}return s;}
    case 'string':case 'asset':case 'text':{if(typeof v!=='string'&&typeof v!=='number'){warn(where+' must be a string');return def();}let s=String(v);const max=f.maxLength||(f.type==='text'?LIMITS.text:LIMITS.string);if(s.length>max){warn(where+' truncated to '+max+' characters');s=s.slice(0,max);}return s;}
    case 'json':{const r=sanitizeJSON(v,warn,where);return r===undefined?def():r;}
  }
  return def();
}

/* ---------- component registry ---------- */
const registry=new Map(),aliases=new Map();
const resolveType=t=>aliases.get(t)||t;
KE.Components={
  /* def: {schema, create(actor,props,world)->instance, tick?(inst,dt,comp), beginPlay?(inst,comp), endPlay?(inst,comp),
     dispose?(inst,comp), serialize?(inst,props,comp)->props, update?(inst,props,key,comp)->true when applied in place,
     normalize?(props,warn)->props, onEvent?(inst,name,payload,comp), label, category, icon, unique=true, help} */
  register(type,def={}){
    if(typeof type!=='string'||!NAME_RE.test(type))throw new TypeError('Component type must be an identifier');
    if(!isObj(def))throw new TypeError('Component definition must be an object');
    const schema={};for(const [k,f] of Object.entries(def.schema||{}))schema[k]=normalizeField(k,f);
    for(const fn of ['create','tick','beginPlay','endPlay','dispose','serialize','update','normalize','onEvent'])if(def[fn]!==undefined&&typeof def[fn]!=='function')throw new TypeError(type+'.'+fn+' must be a function');
    const full={label:type.replace(/([a-z])([A-Z])/g,'$1 $2'),category:'Custom',icon:null,help:'',...def,type,schema,unique:def.unique!==false};
    registry.set(type,full);aliases.delete(type);return full;
  },
  alias(name,type){if(!NAME_RE.test(name))throw new TypeError('Alias must be an identifier');aliases.set(name,type);},
  get(type){return registry.get(resolveType(type))||null;},
  has(type){return registry.has(resolveType(type));},
  list(){return [...registry.values()].filter(d=>!d.hidden).map(d=>({type:d.type,label:d.label,category:d.category,icon:d.icon,help:d.help}));},
  defaults(type){const d=this.get(type);if(!d)throw new Error('Unknown component type: '+type);const out={};for(const f of Object.values(d.schema))setPath(out,f.key,clone(f.default));return out;},
  /* Validates props against the schema. Unknown keys are dropped with a warning. */
  sanitize(type,props={},warn=()=>{}){
    const d=this.get(type);if(!d)throw new Error('Unknown component type: '+type);
    const src=isObj(props)?props:{},out={};
    for(const f of Object.values(d.schema))setPath(out,f.key,sanitizeField(f,getPath(src,f.key),warn,d.type+'.'+f.key));
    const keys=Object.keys(d.schema),walk=(o,prefix)=>{for(const k of Object.keys(o)){if(!prefix&&k==='type')continue;const p=prefix?prefix+'.'+k:k;if(has(d.schema,p))continue;
      if(isObj(o[k])&&keys.some(s=>s.startsWith(p+'.')))walk(o[k],p);else warn(d.type+': unknown property "'+p.slice(0,64)+'" ignored');}};
    walk(src,'');
    return d.normalize?d.normalize(out,warn):out;
  },
  /* Editor helper: schema fields that apply to the given props, in declaration order. */
  fields(type,props){const d=this.get(type);if(!d)return [];return Object.values(d.schema).filter(f=>!f.hidden&&(!f.when||f.when(props)));}
};

/* ---------- actor classes and prefabs ---------- */
const classes=new Map(),prefabs=new Map();
KE.ActorClasses={
  register(name,{components=[],tags=[],label,category='Basic',icon=null,help=''}={}){
    if(typeof name!=='string'||!NAME_RE.test(name))throw new TypeError('Actor class name must be an identifier');
    classes.set(name,{name,components:clone(components),tags:[...tags],label:label||name.replace(/([a-z])([A-Z])/g,'$1 $2'),category,icon,help});return classes.get(name);},
  get(name){return classes.get(name)||null;},
  list(){return [...classes.values()].map(c=>({name:c.name,label:c.label,category:c.category,icon:c.icon,help:c.help}));}
};
KE.Prefabs={
  register(name,def,{category='Prefabs',icon=null,label}={}){
    if(typeof name!=='string'||!/^[A-Za-z0-9_ .-]{1,64}$/.test(name))throw new TypeError('Prefab name must be 1-64 plain characters');
    if(!isObj(def))throw new TypeError('Prefab definition must be an object');
    const warnings=[];const data=sanitizeJSON(def,m=>warnings.push(m),'prefab '+name);delete data.prefab;
    prefabs.set(name,{name,def:data,category,icon,label:label||name});return {name,warnings};},
  get(name){const p=prefabs.get(name);return p?clone(p.def):null;},
  info(name){return prefabs.get(name)||null;},
  list(){return [...prefabs.values()].map(p=>({name:p.name,label:p.label,category:p.category,icon:p.icon||(p.def.class&&classes.get(p.def.class)&&classes.get(p.def.class).icon)||null}));},
  unregister(name){return prefabs.delete(name);}
};
/* Merge component lists by type: explicit props override template props (deep for objects). */
function deepMerge(a,b){if(!isObj(a)||!isObj(b))return clone(b);const out=clone(a);for(const k of Object.keys(b)){if(BAD_KEYS.has(k))continue;out[k]=isObj(out[k])&&isObj(b[k])?deepMerge(out[k],b[k]):clone(b[k]);}return out;}
function mergeComponents(base,extra){const out=(base||[]).map(clone);for(const c of extra||[]){if(!isObj(c))continue;const d=KE.Components.get(c.type);const i=d&&d.unique?out.findIndex(o=>resolveType(o.type)===d.type):-1;if(i>=0)out[i]=deepMerge(out[i],c);else out.push(clone(c));}return out;}

/* ---------- tags ---------- */
/* A Set that keeps the world's tag index current, so actor.tags.add() works directly. */
class TagSet extends Set{
  constructor(actor){super();this._actor=actor;}
  add(t){t=String(t).slice(0,LIMITS.tag);if(!t||super.has(t))return this;super.add(t);const w=this._actor&&this._actor.world;if(w&&this._actor.alive)w._indexTag(this._actor,t,true);return this;}
  delete(t){const r=super.delete(t);const w=this._actor&&this._actor.world;if(r&&w)w._indexTag(this._actor,t,false);return r;}
  clear(){for(const t of [...this])this.delete(t);}
}

/* ---------- components and actors ---------- */
class Component{
  constructor(actor,def,props){this.actor=actor;this.def=def;this.type=def.type;this.props=props;this.instance=null;this.started=false;}
  get world(){return this.actor.world;}
  get(key){return getPath(this.props,key);}
  /* Validates one schema property, applies it in place when the component supports that, else rebuilds. */
  set(key,value){
    const f=this.def.schema[key];if(!f)throw new Error('Unknown property "'+key+'" on '+this.type);
    const w=this.world,v=sanitizeField(f,value,m=>w.warn(m),this.type+'.'+key);
    setPath(this.props,key,v);if(this.def.normalize)this.props=this.def.normalize(this.props,m=>w.warn(m));
    w._componentChanged(this,key);return getPath(this.props,key);
  }
  setProps(partial){const w=this.world;this.props=KE.Components.sanitize(this.type,deepMerge(this.props,partial||{}),m=>w.warn(m));w._componentChanged(this,'*');return this.props;}
  serialize(){
    const d=this.def;if(d.serialize){const r=d.serialize(this.instance,this.props,this);if(r)return {type:this.type,...clone(r)};}
    const out={type:this.type};for(const f of Object.values(d.schema)){if(f.when&&!f.when(this.props))continue;const v=getPath(this.props,f.key);if(v!==undefined)setPath(out,f.key,clone(v));}return out;
  }
}
class Actor{
  constructor(world,id,name,className){
    this.world=world;this.id=id;this.name=name;this.className=className;this.alive=true;this.pendingKill=false;this.prefab=null;
    this.object=new world.THREE.Group();this.object.name=name;this.object.userData.keActor=this;
    this.components=[];this.tags=new TagSet(this);this.parent=null;this.children=[];this._radius=-1;
  }
  get position(){return this.object.position;}
  get rotation(){return this.object.rotation;}
  get quaternion(){return this.object.quaternion;}
  get scale(){return this.object.scale;}
  get visible(){return this.object.visible;}
  set visible(v){this.object.visible=!!v;}
  getComponent(type){const t=resolveType(type);for(const c of this.components)if(c.type===t)return c;return null;}
  getComponents(type){const t=resolveType(type);return this.components.filter(c=>c.type===t);}
  addComponent(def){return this.world._addComponent(this,def);}
  removeComponent(c){return this.world._removeComponent(this,c);}
  destroy(){this.world.destroy(this);}
  hasTag(t){return this.tags.has(t);}
  addTag(t){this.tags.add(t);return this;}
  removeTag(t){this.tags.delete(t);return this;}
  setName(name){return this.world.rename(this,name);}
  emit(event,payload){return this.world.dispatch(this,event,payload);}
  /* setTransform({position,rotation(deg),scale}) or setTransform(position,rotation,scale); arrays or {x,y,z}. */
  setTransform(a,b,c){const t=isObj(a)&&!('x' in a)?a:{position:a,rotation:b,scale:c};
    const p=t.position!==undefined?vec3Of(t.position):null,r=t.rotation!==undefined?vec3Of(t.rotation):null,s=t.scale!==undefined?vec3Of(t.scale):null;
    if((t.position!==undefined&&!p)||(t.rotation!==undefined&&!r)||(t.scale!==undefined&&!s))throw new TypeError('Transform values must be [x,y,z] finite numbers');
    if(p)this.object.position.fromArray(p);if(r)this.object.rotation.set(r[0]*DEG,r[1]*DEG,r[2]*DEG);if(s)this.object.scale.fromArray(s);this._radius=-1;return this;}
  getTransform(){const o=this.object;return {position:o.position.toArray().map(round6),rotation:[o.rotation.x*RAD,o.rotation.y*RAD,o.rotation.z*RAD].map(round6),scale:o.scale.toArray().map(round6)};}
  getWorldPosition(out){this.object.updateWorldMatrix(true,false);return out.setFromMatrixPosition(this.object.matrixWorld);}
  serialize(){const d={id:this.id,name:this.name,class:this.className,transform:this.getTransform(),tags:[...this.tags],visible:this.object.visible,components:this.components.map(c=>c.serialize())};
    if(this.parent)d.parent=this.parent.id;if(this.prefab)d.prefab=this.prefab;return d;}
  /* Approximate world-space bounding radius from component geometry, cached until transform/components change. */
  boundsRadius(){if(this._radius>=0)return this._radius;const T=this.world.THREE,box=new T.Box3();this.object.updateWorldMatrix(true,true);box.setFromObject(this.object);
    const s=new T.Vector3();this._radius=box.isEmpty()?.25:box.getSize(s).length()*.5;return this._radius;}
}

/* ---------- actor definition normalization (shared by spawn, prefabs and levels) ---------- */
function transformOf(t,errors,where){
  const out={position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]};if(t===undefined||t===null)return out;
  if(!isObj(t)){errors.push(where+': transform must be an object');return out;}
  for(const k of ['position','rotation','scale']){if(t[k]===undefined)continue;const v=vec3Of(t[k]);
    if(!v||v.some(n=>Math.abs(n)>LIMITS.coord)){errors.push(where+': transform.'+k+' must be [x,y,z] finite numbers within ±'+LIMITS.coord);continue;}out[k]=v;}
  return out;
}
function checkString(v,max,what,errors){if(typeof v!=='string'){errors.push(what+' must be a string');return null;}if(v.length>max){errors.push(what+' exceeds '+max+' characters');return null;}return v;}
/* Returns {def, errors}; errors are fatal in strict (level) mode, thrown otherwise. */
function normalizeActorDef(src,{warn,strict=false,where='actor'}={}){
  const errors=[];const def={};
  if(!isObj(src)){errors.push(where+' must be an object');return {def:null,errors};}
  if(src.id!==undefined){if(!Number.isInteger(src.id)||src.id<1||src.id>2147483647)errors.push(where+': id must be a positive integer');else def.id=src.id;}
  if(src.name!==undefined){const n=checkString(src.name,LIMITS.name,where+': name',errors);if(n!==null)def.name=n.trim()||undefined;}
  if(src.class!==undefined){const c=checkString(src.class,LIMITS.className,where+': class',errors);if(c!==null)def.class=c;}
  def.transform=transformOf(src.transform,errors,where);
  def.tags=[];if(src.tags!==undefined){if(!Array.isArray(src.tags)||src.tags.length>LIMITS.tags)errors.push(where+': tags must be an array of at most '+LIMITS.tags+' strings');else for(const t of src.tags){const s=checkString(t,LIMITS.tag,where+': tag',errors);if(s)def.tags.push(s);}}
  if(src.visible!==undefined){if(typeof src.visible!=='boolean')errors.push(where+': visible must be a boolean');else def.visible=src.visible;}
  if(src.parent!==undefined&&src.parent!==null){if(Number.isInteger(src.parent)||(typeof src.parent==='string'&&src.parent.length<=LIMITS.name))def.parent=src.parent;else errors.push(where+': parent must be an actor id or name');}
  if(src.prefab!==undefined){const p=checkString(src.prefab,64,where+': prefab',errors);if(p!==null)def.prefab=p;}
  def.components=[];
  if(src.components!==undefined){
    if(!Array.isArray(src.components))errors.push(where+': components must be an array');
    else{if(src.components.length>LIMITS.components)warn(where+': only the first '+LIMITS.components+' components are kept');
      for(const c of src.components.slice(0,LIMITS.components)){
        if(!isObj(c)||typeof c.type!=='string'){errors.push(where+': each component needs a string type');continue;}
        if(!KE.Components.has(c.type)){warn(where+': unknown component "'+c.type.slice(0,64)+'" skipped');continue;}
        def.components.push(c);}}
  }
  if(!strict&&errors.length)throw new TypeError(errors.join('; '));
  return {def,errors};
}

/* ---------- ease functions for tweens and Blueprint Move/Rotate ---------- */
const EASES={linear:t=>t,easeIn:t=>t*t,easeOut:t=>t*(2-t),easeInOut:t=>t<.5?2*t*t:-1+(4-2*t)*t,
  cubicIn:t=>t*t*t,cubicOut:t=>1-Math.pow(1-t,3),cubicInOut:t=>t<.5?4*t*t*t:1-Math.pow(-2*t+2,3)/2,sineInOut:t=>-(Math.cos(Math.PI*t)-1)/2,
  backOut:t=>{const c1=1.70158,c3=c1+1;return 1+c3*Math.pow(t-1,3)+c1*Math.pow(t-1,2);},
  elasticOut:t=>t===0||t===1?t:Math.pow(2,-10*t)*Math.sin((t*10-.75)*(2*Math.PI)/3)+1,
  bounceOut:t=>{const n=7.5625,d=2.75;if(t<1/d)return n*t*t;if(t<2/d)return n*(t-=1.5/d)*t+.75;if(t<2.5/d)return n*(t-=2.25/d)*t+.9375;return n*(t-=2.625/d)*t+.984375;}};
KE.Ease=EASES;

/* ---------- game world ---------- */
let worldCount=0;
KE.GameWorld=class{
  constructor(THREE,scene,opts={}){
    if(!THREE||!THREE.Object3D)throw new TypeError('GameWorld needs THREE');if(!scene||!scene.isObject3D)throw new TypeError('GameWorld needs a scene');
    const o={physics:null,audio:null,vfx:null,camera:null,renderer:null,stepPhysics:true,updateVFX:true,fixedStep:1/60,maxSteps:5,seed:1,logToConsole:false,consoleWarnings:true,...opts};
    this.THREE=THREE;this.scene=scene;this.options=o;this.id=++worldCount;
    this.physics=o.physics;this.audio=o.audio;this.vfx=o.vfx;this.camera=o.camera;this.renderer=o.renderer;
    this.actors=[];this._byId=new Map();this._byName=new Map();this._byTag=new Map();
    this.events=new KE.Events();this.playing=false;this.paused=false;this.time=0;this.frame=0;this.vars={};this.globalDefaults={};
    this.random=KE.random(o.seed);this.logs=[];this.name='Untitled';
    this._timers=[];this._tweens=[];this._tickers=[];this._tickDirty=true;this._pending=[];this._ticking=false;this._nextId=1;this._accum=0;
    this._exposed=new Map();this._assets=new Map();this._warned=new Set();this._triggers=new Set();this._bodyActor=new Map();this._geoCache=new Map();
    this._v1=new THREE.Vector3();this._v2=new THREE.Vector3();this._v3=new THREE.Vector3();this._m1=new THREE.Matrix4();
  }
  /* ----- logging ----- */
  log(text,level='info',actor=null){const e={text:String(text).slice(0,LIMITS.text),level,time:this.time,actor:actor?actor.name:null,stamp:Date.now()};this.logs.push(e);if(this.logs.length>500)this.logs.shift();
    this.events.emit('log',e);if(this.options.logToConsole)console.log('[world:'+level+']',e.text);return e;}
  print(text,actor=null){this.events.emit('print',String(text),actor);return this.log(text,'print',actor);}
  warn(text){const t=String(text);this.log(t,'warn');if(this.options.consoleWarnings&&!this._warned.has(t)&&this._warned.size<200){this._warned.add(t);console.warn('[kitsune gameplay] '+t);}}
  warnOnce(key,text){if(this._warned.has('once:'+key))return;this._warned.add('once:'+key);this.warn(text);}
  /* ----- lookup ----- */
  find(name){return this._byName.get(name)||null;}
  findById(id){return this._byId.get(id)||null;}
  findByTag(tag){const s=this._byTag.get(tag);return s?[...s]:[];}
  findByClass(cls){return this.actors.filter(a=>a.className===cls);}
  findByComponent(type){const t=resolveType(type);return this.actors.filter(a=>a.components.some(c=>c.type===t));}
  _indexTag(actor,tag,add){let s=this._byTag.get(tag);if(add){if(!s)this._byTag.set(tag,s=new Set());s.add(actor);}else if(s){s.delete(actor);if(!s.size)this._byTag.delete(tag);}this.events.emit('changed',actor,'tags');}
  uniqueName(base){base=String(base||'Actor').slice(0,LIMITS.name-6).trim()||'Actor';if(!this._byName.has(base))return base;const m=/^(.*?)(?:_(\d+))?$/.exec(base),stem=m[1]||'Actor';let n=m[2]?+m[2]:1;while(this._byName.has(stem+'_'+n))n++;return stem+'_'+n;}
  rename(actor,name){if(!actor||!actor.alive)return null;const n=String(name||'').trim().slice(0,LIMITS.name);if(!n||n===actor.name)return actor.name;
    this._byName.delete(actor.name);actor.name=this.uniqueName(n);actor.object.name=actor.name;this._byName.set(actor.name,actor);this.events.emit('changed',actor,'name');return actor.name;}
  /* ----- spawning ----- */
  spawn(def={},opts={}){
    if(typeof def==='string')def={class:def};if(!isObj(def))throw new TypeError('spawn expects an actor definition object');
    const warn=m=>this.warn(m);let src=def,prefabName=null;
    if(def.prefab!==undefined&&!opts.fromLevel){const p=KE.Prefabs.get(def.prefab);if(!p)warn('Unknown prefab "'+String(def.prefab).slice(0,64)+'"');else{prefabName=String(def.prefab);
      src={...p,...def,transform:{...(p.transform||{}),...(def.transform||{})},tags:[...new Set([...(p.tags||[]),...(def.tags||[])])],components:mergeComponents(p.components,def.components)};if(!def.name&&!p.name)src.name=prefabName;}}
    const {def:n}=normalizeActorDef(src,{warn,strict:false,where:'spawn'});
    let className=n.class||'Empty',cls=KE.ActorClasses.get(className);
    if(!cls){warn('Unknown actor class "'+className.slice(0,64)+'", using Empty');className='Empty';cls=KE.ActorClasses.get('Empty');}
    const comps=opts.fromLevel?n.components:mergeComponents(cls?cls.components:[],n.components);
    let id=n.id!==undefined&&!this._byId.has(n.id)?n.id:this._nextId;this._nextId=Math.max(this._nextId,id+1);
    const a=new Actor(this,id,this.uniqueName(n.name||(cls&&cls.label.replace(/\s+/g,''))||className),className);
    a.prefab=prefabName||(opts.fromLevel?n.prefab||null:null);
    a.setTransform(n.transform);if(n.visible===false)a.object.visible=false;
    this.actors.push(a);this._byId.set(a.id,a);this._byName.set(a.name,a);
    for(const t of [...(opts.fromLevel?[]:(cls?cls.tags:[])),...n.tags])a.tags.add(t);
    let parent=null;if(n.parent!==undefined){parent=typeof n.parent==='number'?this.findById(n.parent):this.find(n.parent);if(!parent&&!opts.deferParent)warn('Parent "'+n.parent+'" not found for '+a.name);}
    (parent||{object:this.scene}).object.add(a.object);if(parent){a.parent=parent;parent.children.push(a);}
    if(opts.deferParent&&n.parent!==undefined)a._pendingParent=n.parent;
    for(const c of comps)this._addComponent(a,c,{silent:true,noPlay:true});
    this.events.emit('spawn',a);
    if(this.playing)this._beginPlayActor(a);
    return a;
  }
  _addComponent(actor,cdef,{silent=false,noPlay=false,index=-1}={}){
    if(!actor.alive)throw new Error('Actor has been destroyed');
    if(typeof cdef==='string')cdef={type:cdef};if(!isObj(cdef)||typeof cdef.type!=='string')throw new TypeError('Component definition needs a type');
    const d=KE.Components.get(cdef.type);if(!d){this.warn('Unknown component "'+cdef.type.slice(0,64)+'" skipped on '+actor.name);return null;}
    if(d.unique&&actor.getComponent(d.type)){this.warn(actor.name+' already has a '+d.type+' component');return null;}
    if(actor.components.length>=LIMITS.components){this.warn(actor.name+' has too many components');return null;}
    const props=KE.Components.sanitize(d.type,cdef,m=>this.warn(actor.name+': '+m));
    const c=new Component(actor,d,props);
    if(index>=0&&index<actor.components.length)actor.components.splice(index,0,c);else actor.components.push(c);
    this._build(c);this._tickDirty=true;actor._radius=-1;
    if(!noPlay&&this.playing&&!actor.pendingKill)this._beginPlayComponent(c);
    if(!silent)this.events.emit('componentAdded',actor,c);
    return c;
  }
  _removeComponent(actor,c){const i=actor.components.indexOf(c);if(i<0)return false;this._teardown(c);actor.components.splice(i,1);this._tickDirty=true;actor._radius=-1;this.events.emit('componentRemoved',actor,c,i);return true;}
  _build(c){try{c.instance=c.def.create?c.def.create(c.actor,c.props,this,c):null;}catch(e){c.instance=null;this.warn(c.actor.name+': '+c.type+' failed to create: '+e.message);}}
  _teardown(c){if(c.started){c.started=false;if(c.def.endPlay)try{c.def.endPlay(c.instance,c);}catch(e){this.warn(c.type+' endPlay: '+e.message);}}
    if(c.def.dispose&&c.instance!==null)try{c.def.dispose(c.instance,c);}catch(e){this.warn(c.type+' dispose: '+e.message);}c.instance=null;}
  _componentChanged(c,key){if(!c.actor.alive)return;let done=false;
    if(key!=='*'&&c.def.update&&c.instance!==null){try{done=c.def.update(c.instance,c.props,key,c)===true;}catch(e){this.warn(c.type+' update: '+e.message);}}
    if(!done){const was=c.started;this._teardown(c);this._build(c);if(was||(this.playing&&!c.actor.pendingKill))this._beginPlayComponent(c);}
    c.actor._radius=-1;this.events.emit('componentChanged',c.actor,c,key);}
  _beginPlayComponent(c){if(c.started)return;c.started=true;if(c.def.beginPlay)try{c.def.beginPlay(c.instance,c);}catch(e){this.warn(c.actor.name+': '+c.type+' beginPlay: '+e.message);}}
  _beginPlayActor(a){for(const c of a.components.slice())if(a.alive&&!a.pendingKill)this._beginPlayComponent(c);}
  /* ----- destruction ----- */
  destroy(actor){if(!actor||!actor.alive||actor.world!==this||actor.pendingKill)return false;
    if(this._ticking){actor.pendingKill=true;actor.object.visible=false;this._pending.push(actor);return true;}this._destroyNow(actor);return true;}
  _destroyNow(actor){if(!actor.alive)return;
    for(const ch of actor.children.slice())this._destroyNow(ch);
    for(let i=actor.components.length-1;i>=0;i--)this._teardown(actor.components[i]);
    for(const t of this._timers)if(t.owner===actor)t.active=false;
    this._tweens=this._tweens.filter(t=>t.actor!==actor);
    if(actor.parent){const s=actor.parent.children,i=s.indexOf(actor);if(i>=0)s.splice(i,1);}
    if(actor.object.parent)actor.object.parent.remove(actor.object);
    for(const t of actor.tags)this._indexTag(actor,t,false);
    const i=this.actors.indexOf(actor);if(i>=0)this.actors.splice(i,1);this._byId.delete(actor.id);if(this._byName.get(actor.name)===actor)this._byName.delete(actor.name);
    actor.alive=false;actor.pendingKill=false;this._tickDirty=true;this.events.emit('destroy',actor);
  }
  clear(){for(const a of this.actors.slice())if(!a.parent)this.destroy(a);for(const a of this.actors.slice())this.destroy(a);}
  /* Reparent keeping the world transform (editor use). parent=null attaches to the scene. */
  attach(actor,parent){if(!actor||!actor.alive)return false;if(parent){for(let p=parent;p;p=p.parent)if(p===actor)return false;}
    if(actor.parent){const s=actor.parent.children;s.splice(s.indexOf(actor),1);}actor.parent=parent||null;if(parent)parent.children.push(actor);
    (parent?parent.object:this.scene).attach(actor.object);this.events.emit('changed',actor,'parent');return true;}
  /* Move an actor within world.actors (outliner/draw order). */
  reorder(actor,index){const i=this.actors.indexOf(actor);if(i<0)return false;this.actors.splice(i,1);this.actors.splice(clamp(index|0,0,this.actors.length),0,actor);this._tickDirty=true;this.events.emit('reorder',actor);return true;}
  /* ----- play lifecycle ----- */
  /* Destroys requested inside beginPlay/endPlay/tick are deferred to the end of that call. */
  beginPlay(){if(this.playing)return;this.playing=true;this.paused=false;this.time=0;this.frame=0;this._accum=0;this.vars=clone(this.globalDefaults)||{};
    this._subscribePhysics();const was=this._ticking;this._ticking=true;
    try{for(const a of this.actors.slice())if(a.alive&&!a.pendingKill)this._beginPlayActor(a);}finally{this._ticking=was;if(!was)this._flushPending();}this.events.emit('beginPlay',this);}
  endPlay(){if(!this.playing)return;const was=this._ticking;this._ticking=true;
    try{for(const a of this.actors.slice()){if(!a.alive)continue;for(const c of a.components.slice().reverse()){if(!c.started)continue;c.started=false;if(c.def.endPlay)try{c.def.endPlay(c.instance,c);}catch(e){this.warn(c.type+' endPlay: '+e.message);}}}}
    finally{this._ticking=was;}
    this._timers.length=0;this._tweens.length=0;if(this._physOff){try{this._physOff();}catch(e){}this._physOff=null;}this.playing=false;this.paused=false;if(!was)this._flushPending();this.events.emit('endPlay',this);}
  setPaused(v){this.paused=!!v;}
  /* Fixed-step helper: accumulates frame time and runs tick(fixedStep) up to maxSteps times. */
  update(frameDt){if(!this.playing||this.paused)return 0;this._accum+=clamp(Number.isFinite(frameDt)?frameDt:0,0,.25);const step=this.options.fixedStep;let n=0;
    while(this._accum+1e-9>=step&&n<this.options.maxSteps){this.tick(step);this._accum-=step;n++;}if(this._accum>step)this._accum%=step;return n;}
  tick(dt){
    if(!this.playing||this.paused||!(dt>=0))return;dt=Math.min(dt,.25);this._ticking=true;
    try{this.time+=dt;this.frame++;
      if(this.physics&&this.options.stepPhysics&&typeof this.physics.step==='function'){try{this.physics.step(dt);}catch(e){this.warnOnce('physstep','Physics step failed: '+e.message);}}
      this._updateTriggers();this._updateTimers();this._updateTweens(dt);
      if(this._tickDirty)this._rebuildTickers();const list=this._tickers;
      for(let i=0;i<list.length;i++){const c=list[i];if(!c.started||c.actor.pendingKill||!c.actor.alive)continue;try{c.def.tick(c.instance,dt,c);}catch(e){this.warnOnce('tick:'+c.actor.id+c.type,c.actor.name+': '+c.type+' tick failed: '+e.message);}}
      if(this.vfx&&this.options.updateVFX&&typeof this.vfx.update==='function'){try{this.vfx.update(dt,this.camera);}catch(e){this.warnOnce('vfxupdate','VFX update failed: '+e.message);}}
    }finally{this._ticking=false;this._flushPending();}
  }
  _flushPending(){if(!this._pending.length)return;const p=this._pending;this._pending=[];for(const a of p)this._destroyNow(a);}
  _rebuildTickers(){const out=[];for(const a of this.actors)for(const c of a.components)if(c.def.tick)out.push(c);this._tickers=out;this._tickDirty=false;}
  /* ----- timers ----- */
  setTimer(fn,seconds,{loop=false,owner=null}={}){
    if(typeof fn!=='function')throw new TypeError('setTimer needs a function');const s=Math.max(0,Number(seconds)||0);
    const t={fn,interval:loop?Math.max(1e-3,s):s,due:this.time+s,loop:!!loop,owner,active:true};this._timers.push(t);const world=this;
    return {clear(){t.active=false;},get active(){return t.active;},get remaining(){return t.active?Math.max(0,t.due-world.time):0;},get loop(){return t.loop;}};
  }
  _updateTimers(){const list=this._timers,n=list.length;if(!n)return;list.sort((a,b)=>a.due-b.due);const now=this.time+EPS;
    for(let i=0;i<n;i++){const t=list[i];let k=0;while(t.active&&t.due<=now&&k<16){k++;if(t.loop)t.due+=t.interval;else t.active=false;if(t.owner&&(!t.owner.alive||t.owner.pendingKill)){t.active=false;break;}try{t.fn(this);}catch(e){this.warn('Timer callback failed: '+e.message);}}}
    let w=0;for(let i=0;i<list.length;i++)if(list[i].active)list[w++]=list[i];list.length=w;}
  /* ----- tweens (world time, deterministic) ----- */
  tween(actor,kind,to,{duration=1,ease='easeInOut',from=null,onComplete=null}={}){
    if(!actor||!actor.alive)return null;const o=actor.object;
    const cur=kind==='rotation'?[o.rotation.x,o.rotation.y,o.rotation.z]:kind==='scale'?o.scale.toArray():o.position.toArray();
    this._tweens=this._tweens.filter(t=>!(t.actor===actor&&t.kind===kind));
    const tw={actor,kind,from:from||cur,to:to.slice(),t:0,duration:Math.max(0,duration),ease:EASES[ease]||EASES.linear,onComplete};
    if(tw.duration===0){this._applyTween(tw,1);if(onComplete)onComplete();return tw;}this._tweens.push(tw);return tw;}
  _applyTween(tw,k){const e=tw.ease(k),f=tw.from,t=tw.to,o=tw.actor.object;const x=f[0]+(t[0]-f[0])*e,y=f[1]+(t[1]-f[1])*e,z=f[2]+(t[2]-f[2])*e;
    if(tw.kind==='rotation')o.rotation.set(x,y,z);else if(tw.kind==='scale'){o.scale.set(x,y,z);tw.actor._radius=-1;}else o.position.set(x,y,z);}
  _updateTweens(dt){if(!this._tweens.length)return;const done=[];for(const tw of this._tweens){if(!tw.actor.alive||tw.actor.pendingKill){done.push(tw);continue;}tw.t+=dt;const k=tw.duration>0?Math.min(1,tw.t/tw.duration):1;this._applyTween(tw,k);if(k>=1)done.push(tw);}
    if(done.length){this._tweens=this._tweens.filter(t=>!done.includes(t));for(const tw of done)if(tw.onComplete&&tw.actor.alive&&!tw.actor.pendingKill)try{tw.onComplete();}catch(e){this.warn('Tween callback failed: '+e.message);}}}
  /* ----- events ----- */
  /* Sends an event to every component of the actor that handles events (Blueprints). */
  dispatch(actor,event,payload={}){if(!actor||!actor.alive||actor.pendingKill)return false;let handled=false;
    for(const c of actor.components.slice())if(c.def.onEvent&&c.started){try{handled=c.def.onEvent(c.instance,event,payload,c)||handled;}catch(e){this.warn(actor.name+': event '+event+' failed: '+e.message);}}return handled;}
  broadcast(event,payload={}){let n=0;for(const a of this.actors.slice())if(this.dispatch(a,event,payload))n++;return n;}
  _overlap(trigger,other,entered){this.events.emit('overlap',trigger,other,entered);const ev=entered?'Overlap':'EndOverlap';this.dispatch(trigger,ev,{other});this.dispatch(other,ev,{other:trigger});}
  /* ----- game-exposed functions for Blueprint CallGame ----- */
  expose(name,fn){if(typeof name!=='string'||!/^[A-Za-z_][\w.]{0,63}$/.test(name))throw new TypeError('Exposed name must be an identifier');if(typeof fn!=='function')throw new TypeError('expose needs a function');this._exposed.set(name,fn);return ()=>this._exposed.delete(name);}
  unexpose(name){return this._exposed.delete(name);}
  exposed(){return [...this._exposed.keys()];}
  /* ----- assets (glTF scenes referenced by StaticMesh primitive 'gltf') ----- */
  registerAsset(id,asset){if(typeof id!=='string'||!/^[\w.\- ]{1,128}$/.test(id))throw new TypeError('Asset id must be 1-128 plain characters');if(!isObj(asset)||!asset.object||!asset.object.isObject3D)throw new TypeError('Asset needs an Object3D in .object');
    this._assets.set(id,{type:'gltf',...asset,id});for(const a of this.actors)for(const c of a.components)if(c.type==='StaticMesh'&&c.props.mesh.primitive==='gltf'&&c.props.mesh.asset===id)this._componentChanged(c,'*');this.events.emit('asset',id);return id;}
  getAsset(id){return this._assets.get(id)||null;}
  assets(){return [...this._assets.keys()];}
  removeAsset(id,{dispose=true}={}){const a=this._assets.get(id);if(!a)return false;this._assets.delete(id);if(dispose&&KE.disposeObject)KE.disposeObject(a.object,{textures:true,remove:false});this.events.emit('asset',id);return true;}
  /* ----- queries ----- */
  getPlayerStart(){const a=this.actors.find(x=>x.getComponent('PlayerStart'));if(!a)return null;const T=this.THREE,p=new T.Vector3(),q=new T.Quaternion(),s=new T.Vector3();a.object.updateWorldMatrix(true,false);a.object.matrixWorld.decompose(p,q,s);return {actor:a,position:p,quaternion:q};}
  /* ----- physics bridge ----- */
  _subscribePhysics(){const ph=this.physics;if(!ph||typeof ph.on!=='function'||this._physOff)return;
    try{const off=ph.on('trigger',(sensor,other,entered)=>{const t=this._bodyActor.get(sensor),o=this._bodyActor.get(other);if(!t||!o)return;const trig=t.getComponent('TriggerVolume');if(trig&&trig.instance)trig.instance.setOverlap(o,!!entered);});
      this._physOff=typeof off==='function'?off:(typeof ph.off==='function'?()=>ph.off('trigger'):null)||(()=>{});}catch(e){this.warnOnce('physon','Physics trigger subscription failed: '+e.message);}}
  _trackBody(body,actor,add){if(!body)return;if(add){this._bodyActor.set(body,actor);actor._bodies=(actor._bodies||0)+1;}else if(this._bodyActor.delete(body))actor._bodies=Math.max(0,(actor._bodies||1)-1);}
  _updateTriggers(){if(!this._triggers.size)return;for(const t of this._triggers)if(t.comp.started&&!t.actor.pendingKill)t.poll();}
  /* ----- geometry cache (shared primitive geometry, reference counted) ----- */
  _acquireGeometry(key,make){let e=this._geoCache.get(key);if(!e){e={geometry:make(),refs:0};this._geoCache.set(key,e);}e.refs++;return e.geometry;}
  _releaseGeometry(key){const e=this._geoCache.get(key);if(!e)return;if(--e.refs<=0){e.geometry.dispose();this._geoCache.delete(key);}}
  dispose(){this.endPlay();this._ticking=false;for(const a of this.actors.slice())this._destroyNow(a);for(const e of this._geoCache.values())e.geometry.dispose();this._geoCache.clear();
    for(const id of [...this._assets.keys()])this.removeAsset(id);this._exposed.clear();this.events.clear();}
};
KE.GameWorld.Actor=Actor;KE.GameWorld.Component=Component;

/* ---------- procedural primitives ---------- */
/* 3D value noise with integer hashing; deterministic per seed (rock displacement). */
function hash3(x,y,z,s){let h=Math.imul(x|0,374761393)^Math.imul(y|0,668265263)^Math.imul(z|0,2147483647)^Math.imul(s|0,1274126177);h=Math.imul(h^(h>>>13),1274126177);return ((h^(h>>>16))>>>0)/4294967296;}
function vnoise(x,y,z,s){const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z),fx=x-ix,fy=y-iy,fz=z-iz,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy),w=fz*fz*(3-2*fz),L=(a,b,t)=>a+(b-a)*t;
  return L(L(L(hash3(ix,iy,iz,s),hash3(ix+1,iy,iz,s),u),L(hash3(ix,iy+1,iz,s),hash3(ix+1,iy+1,iz,s),u),v),L(L(hash3(ix,iy,iz+1,s),hash3(ix+1,iy,iz+1,s),u),L(hash3(ix,iy+1,iz+1,s),hash3(ix+1,iy+1,iz+1,s),u),v),w);}
function rockGeometry(THREE,r,detail,seed,rough){
  const g=new THREE.IcosahedronGeometry(1,detail),p=g.attributes.position,v=new THREE.Vector3();
  for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).normalize();
    let n=0,a=.55,f=1.6;for(let o=0;o<4;o++){n+=a*(vnoise(v.x*f+seed*7.13,v.y*f+seed*3.71,v.z*f+seed*5.17,seed)-.5);a*=.5;f*=2.1;}
    const k=r*(1+rough*n*1.6);v.multiplyScalar(k);v.y*=.78;if(v.y<-r*.45)v.y=-r*.45+(v.y+r*.45)*.25;p.setXYZ(i,v.x,v.y,v.z);}
  g.computeVertexNormals();g.computeBoundingSphere();return g;
}
function capsuleGeometry(THREE,r,h,seg){const mid=Math.max(0,h-2*r)/2,cap=Math.max(3,Math.round(seg/4)),pts=[];
  for(let i=0;i<=cap;i++){const a=-Math.PI/2+i/cap*Math.PI/2;pts.push(new THREE.Vector2(Math.max(0,Math.cos(a)*r),Math.sin(a)*r-mid));}
  for(let i=0;i<=cap;i++){const a=i/cap*Math.PI/2;pts.push(new THREE.Vector2(Math.max(0,Math.cos(a)*r),Math.sin(a)*r+mid));}return new THREE.LatheGeometry(pts,seg);}
const PRIM_PARAMS={box:['width','height','depth','bevel'],sphere:['radius','segments'],cylinder:['radius','radiusTop','height','segments'],cone:['radius','height','segments'],
  torus:['radius','tube','segments'],plane:['width','depth'],capsule:['radius','height','segments'],rock:['radius','detail','seed','roughness'],gltf:[]};
function buildPrimitive(THREE,prim,p){
  const seg=p.segments;
  switch(prim){
    case 'box':if(p.bevel>0&&THREE.RoundedBoxGeometry)return new THREE.RoundedBoxGeometry(p.width,p.height,p.depth,3,Math.min(p.bevel,Math.min(p.width,p.height,p.depth)*.5));return new THREE.BoxGeometry(p.width,p.height,p.depth);
    case 'sphere':return new THREE.SphereGeometry(p.radius,seg,Math.max(3,Math.round(seg*.6)));
    case 'cylinder':return new THREE.CylinderGeometry(p.radiusTop,p.radius,p.height,seg);
    case 'cone':return new THREE.ConeGeometry(p.radius,p.height,seg);
    case 'torus':return new THREE.TorusGeometry(p.radius,p.tube,Math.max(3,Math.round(seg/2)),seg);
    case 'plane':{const g=new THREE.PlaneGeometry(p.width,p.depth);g.rotateX(-Math.PI/2);return g;}
    case 'capsule':return capsuleGeometry(THREE,p.radius,p.height,seg);
    case 'rock':return rockGeometry(THREE,p.radius,p.detail,p.seed,p.roughness);
  }
  return new THREE.BoxGeometry(1,1,1);
}
KE.buildPrimitive=(THREE,prim,params={})=>{const d=KE.Components.defaults('StaticMesh').mesh.params;return buildPrimitive(THREE,prim,{...d,...params});};

/* ---------- materials for StaticMesh ---------- */
const SIMPLE_MATS=new Set(['standard','physical','basic','toon']);
function createMaterial(THREE,m,world,owner){
  if(m.type==='graph'){
    if(KE.MaterialGraph&&typeof KE.MaterialGraph.compile==='function'&&m.graph){try{const r=KE.MaterialGraph.compile(THREE,m.graph,{model:'standard'});const mat=r&&r.isMaterial?r:(r&&r.material&&r.material.isMaterial?r.material:null);if(mat)return {material:mat,owned:true,handle:r};}catch(e){world.warn(owner+': material graph failed: '+e.message);}}
    else world.warnOnce('nograph','Material graphs need KE.MaterialGraph; using a standard material');
  }else if(m.type==='library'){
    if(typeof KE.materialLibrary==='function'){try{const lib=KE.materialLibrary(THREE);let e=lib&&(typeof lib.get==='function'?lib.get(m.library):(has(lib,m.library)?lib[m.library]:null));if(typeof e==='function')e=e();
      if(e&&e.isMaterial)return {material:e,owned:false};if(e&&e.material&&e.material.isMaterial)return {material:e.material,owned:false};
      if(e&&KE.MaterialGraph){const r=KE.MaterialGraph.compile(THREE,e,{model:'standard'});const mat=r&&r.isMaterial?r:r&&r.material;if(mat&&mat.isMaterial)return {material:mat,owned:true,handle:r};}
      world.warn(owner+': material "'+m.library+'" not found in library');}catch(e){world.warn(owner+': material library failed: '+e.message);}}
    else world.warnOnce('nolib','KE.materialLibrary is not available; using a standard material');
  }
  let mat;const common={color:m.color};
  if(m.type==='basic')mat=new THREE.MeshBasicMaterial(common);
  else if(m.type==='toon')mat=new THREE.MeshToonMaterial({...common,gradientMap:KE.toonRamp?KE.toonRamp(THREE):null});
  else if(m.type==='physical')mat=new THREE.MeshPhysicalMaterial(common);
  else mat=new THREE.MeshStandardMaterial(common);
  applyMaterialParams(mat,m);return {material:mat,owned:true,simple:true};
}
function applyMaterialParams(mat,m){
  if(mat.color)mat.color.set(m.color);if('roughness' in mat)mat.roughness=m.roughness;if('metalness' in mat)mat.metalness=m.metalness;
  if(mat.emissive){mat.emissive.set(m.emissive);mat.emissiveIntensity=m.emissiveIntensity;}
  const transparent=m.opacity<1;if(mat.transparent!==transparent){mat.transparent=transparent;mat.needsUpdate=true;}mat.opacity=m.opacity;mat.depthWrite=!transparent;
  if('flatShading' in mat&&mat.flatShading!==m.flatShading){mat.flatShading=m.flatShading;mat.needsUpdate=true;}mat.wireframe=m.wireframe;
  mat.side=m.doubleSided?2:0;
}

/* ---------- built-in components ---------- */
const reg=(t,d)=>KE.Components.register(t,d);
const vecSet=(v,a)=>v.set(a[0],a[1],a[2]);
const onPrim=(...list)=>p=>list.includes(p.mesh.primitive);
const onMat=(...list)=>p=>list.includes(p.mesh.material.type)&&p.mesh.primitive!=='gltf';
const shadowsOn=()=>KE.settings.shadows!==false;
/* Looks up a named member without reaching Object/Function prototype methods (names come from level data). */
const safeMember=(o,name)=>{if(!o||typeof name!=='string'||!name||BAD_KEYS.has(name)||name in Object.prototype||name in Function.prototype)return undefined;try{return name in Object(o)?o[name]:undefined;}catch(e){return undefined;}};

reg('StaticMesh',{label:'Static Mesh',category:'Rendering',icon:'mesh',help:'Procedural primitive or imported glTF with a material.',
  schema:{
    'mesh.primitive':{type:'enum',options:['box','sphere','cylinder','cone','torus','plane','capsule','rock','gltf'],default:'box',label:'Shape'},
    'mesh.params.width':{type:'number',default:1,min:.001,max:10000,step:.1,when:onPrim('box','plane')},
    'mesh.params.height':{type:'number',default:1,min:.001,max:10000,step:.1,when:onPrim('box','cylinder','cone','capsule')},
    'mesh.params.depth':{type:'number',default:1,min:.001,max:10000,step:.1,when:onPrim('box','plane')},
    'mesh.params.bevel':{type:'number',default:0,min:0,max:5,step:.01,when:onPrim('box')},
    'mesh.params.radius':{type:'number',default:.5,min:.001,max:10000,step:.05,when:onPrim('sphere','cylinder','cone','torus','capsule','rock')},
    'mesh.params.radiusTop':{type:'number',default:.5,min:0,max:10000,step:.05,label:'Top Radius',when:onPrim('cylinder')},
    'mesh.params.tube':{type:'number',default:.15,min:.001,max:1000,step:.01,when:onPrim('torus')},
    'mesh.params.segments':{type:'number',default:24,min:3,max:128,integer:true,when:onPrim('sphere','cylinder','cone','torus','capsule')},
    'mesh.params.detail':{type:'number',default:2,min:0,max:5,integer:true,when:onPrim('rock')},
    'mesh.params.seed':{type:'number',default:1,min:0,max:100000,integer:true,when:onPrim('rock')},
    'mesh.params.roughness':{type:'number',default:.35,min:0,max:1,step:.01,label:'Jaggedness',when:onPrim('rock')},
    'mesh.asset':{type:'asset',default:'',label:'glTF Asset',when:onPrim('gltf')},
    'mesh.material.type':{type:'enum',options:['standard','physical','basic','toon','graph','library'],default:'standard',label:'Material',when:p=>p.mesh.primitive!=='gltf'},
    'mesh.material.color':{type:'color',default:'#a8adb5',label:'Base Color',when:onMat('standard','physical','basic','toon')},
    'mesh.material.roughness':{type:'number',default:.6,min:0,max:1,step:.01,when:onMat('standard','physical')},
    'mesh.material.metalness':{type:'number',default:0,min:0,max:1,step:.01,when:onMat('standard','physical')},
    'mesh.material.emissive':{type:'color',default:'#000000',when:onMat('standard','physical','toon')},
    'mesh.material.emissiveIntensity':{type:'number',default:1,min:0,max:100,step:.1,label:'Emissive Strength',when:onMat('standard','physical','toon')},
    'mesh.material.opacity':{type:'number',default:1,min:0,max:1,step:.01,when:onMat('standard','physical','basic','toon')},
    'mesh.material.flatShading':{type:'bool',default:false,when:onMat('standard','physical','toon')},
    'mesh.material.wireframe':{type:'bool',default:false,when:onMat('standard','physical','basic','toon')},
    'mesh.material.doubleSided':{type:'bool',default:false,when:onMat('standard','physical','basic','toon')},
    'mesh.material.graph':{type:'json',default:null,label:'Graph',when:onMat('graph')},
    'mesh.material.library':{type:'string',default:'',label:'Library Material',when:onMat('library')},
    castShadow:{type:'bool',default:true},receiveShadow:{type:'bool',default:true},
    offset:{type:'vec3',default:[0,0,0],label:'Relative Location'}},
  create(actor,props,world,comp){
    const T=world.THREE,m=props.mesh,inst={object:null,geoKey:null,material:null,owned:false,handle:null,simple:false};
    if(m.primitive==='gltf'){
      const asset=m.asset&&world.getAsset(m.asset);
      if(asset){const src=asset.object;inst.object=T.SkeletonUtils&&T.SkeletonUtils.clone?T.SkeletonUtils.clone(src):src.clone(true);inst.object.traverse(o=>{if(o.isMesh){o.castShadow=props.castShadow&&shadowsOn();o.receiveShadow=props.receiveShadow;o.userData.keComponent=comp;}});}
      else{if(m.asset)world.warnOnce('asset:'+m.asset,actor.name+': glTF asset "'+m.asset+'" is not loaded; showing a placeholder');
        inst.geoKey='placeholder';const g=world._acquireGeometry('placeholder',()=>new T.BoxGeometry(1,1,1));inst.material=new T.MeshStandardMaterial({color:0x8a6fbf,wireframe:true});inst.owned=true;inst.object=new T.Mesh(g,inst.material);}
    }else{
      const params={};for(const k of PRIM_PARAMS[m.primitive])params[k]=m.params[k];
      inst.geoKey=m.primitive+':'+JSON.stringify(params);const g=world._acquireGeometry(inst.geoKey,()=>buildPrimitive(T,m.primitive,params));
      const r=createMaterial(T,m.material,world,actor.name);inst.material=r.material;inst.owned=r.owned;inst.handle=r.handle||null;inst.simple=!!r.simple;
      inst.object=new T.Mesh(g,inst.material);inst.object.castShadow=props.castShadow&&shadowsOn();inst.object.receiveShadow=props.receiveShadow;
    }
    inst.object.userData.keComponent=comp;vecSet(inst.object.position,props.offset);actor.object.add(inst.object);return inst;},
  update(inst,props,key){
    if(key==='castShadow'||key==='receiveShadow'){inst.object.traverse(o=>{if(o.isMesh){o.castShadow=props.castShadow&&shadowsOn();o.receiveShadow=props.receiveShadow;}});return true;}
    if(key==='offset'){vecSet(inst.object.position,props.offset);return true;}
    if(inst.simple&&inst.owned&&key.startsWith('mesh.material.')&&!['mesh.material.type','mesh.material.graph','mesh.material.library'].includes(key)){applyMaterialParams(inst.material,props.mesh.material);return true;}
    return false;},
  dispose(inst,comp){if(inst.object&&inst.object.parent)inst.object.parent.remove(inst.object);if(inst.geoKey)comp.world._releaseGeometry(inst.geoKey);
    if(inst.owned&&inst.material){if(inst.handle&&typeof inst.handle.dispose==='function')inst.handle.dispose();else inst.material.dispose();}}
});

/* Lights: direction for Spot/Directional is the actor's local -Y (rotation [0,0,0] points straight down). */
const lightCommon={intensity:{type:'number',default:1.5,min:0,max:1000,step:.1},color:{type:'color',default:'#fff4e6'}};
function lightTargetChild(T,light,actor){light.target=new T.Object3D();light.target.position.set(0,-1,0);actor.object.add(light.target);}
function applyShadow(light,props,size){light.castShadow=!!props.castShadow&&shadowsOn();if(light.castShadow&&light.shadow){const s=size||512;if(light.shadow.mapSize.x!==s){light.shadow.mapSize.set(s,s);if(light.shadow.map){light.shadow.map.dispose();light.shadow.map=null;}}light.shadow.bias=props.shadowBias!==undefined?props.shadowBias:-.0005;}}
function removeLight(inst){const l=inst.light;if(l.target&&l.target.parent)l.target.parent.remove(l.target);if(l.parent)l.parent.remove(l);if(l.shadow&&l.shadow.map){l.shadow.map.dispose();l.shadow.map=null;}if(l.dispose)l.dispose();}
reg('PointLight',{label:'Point Light',category:'Lights',icon:'light',
  schema:{...lightCommon,range:{type:'number',default:10,min:0,max:10000,step:.5,label:'Attenuation Radius'},decay:{type:'number',default:2,min:0,max:4,step:.1},castShadow:{type:'bool',default:false},offset:{type:'vec3',default:[0,0,0],label:'Relative Location'}},
  create(actor,p,world){const l=new world.THREE.PointLight(p.color,p.intensity,p.range,p.decay);vecSet(l.position,p.offset);applyShadow(l,p,512);actor.object.add(l);return {light:l};},
  update(inst,p,key){const l=inst.light;if(key==='intensity')l.intensity=p.intensity;else if(key==='color')l.color.set(p.color);else if(key==='range')l.distance=p.range;else if(key==='decay')l.decay=p.decay;else if(key==='offset')vecSet(l.position,p.offset);else if(key==='castShadow')applyShadow(l,p,512);else return false;return true;},
  dispose:removeLight});
reg('SpotLight',{label:'Spot Light',category:'Lights',icon:'spot',
  schema:{...lightCommon,intensity:{type:'number',default:3,min:0,max:1000,step:.1},range:{type:'number',default:15,min:0,max:10000,step:.5,label:'Attenuation Radius'},angle:{type:'number',default:35,min:1,max:89,step:1,label:'Cone Angle'},
    penumbra:{type:'number',default:.35,min:0,max:1,step:.01},decay:{type:'number',default:2,min:0,max:4,step:.1},castShadow:{type:'bool',default:true},offset:{type:'vec3',default:[0,0,0],label:'Relative Location'}},
  create(actor,p,world){const T=world.THREE,l=new T.SpotLight(p.color,p.intensity,p.range,p.angle*DEG,p.penumbra,p.decay);vecSet(l.position,p.offset);lightTargetChild(T,l,actor);applyShadow(l,p,1024);actor.object.add(l);return {light:l};},
  update(inst,p,key){const l=inst.light;if(key==='intensity')l.intensity=p.intensity;else if(key==='color')l.color.set(p.color);else if(key==='range')l.distance=p.range;else if(key==='angle')l.angle=p.angle*DEG;else if(key==='penumbra')l.penumbra=p.penumbra;else if(key==='decay')l.decay=p.decay;else if(key==='castShadow')applyShadow(l,p,1024);else if(key==='offset'){vecSet(l.position,p.offset);l.target.position.set(p.offset[0],p.offset[1]-1,p.offset[2]);}else return false;return true;},
  dispose:removeLight});
reg('DirectionalLight',{label:'Directional Light',category:'Lights',icon:'sun',
  schema:{...lightCommon,intensity:{type:'number',default:2.2,min:0,max:100,step:.1},castShadow:{type:'bool',default:true},shadowArea:{type:'number',default:25,min:1,max:500,step:1,label:'Shadow Extent'},shadowMapSize:{type:'number',default:2048,min:256,max:4096,integer:true,label:'Shadow Resolution'},shadowBias:{type:'number',default:-.0005,min:-.01,max:.01,step:.0001}},
  create(actor,p,world){const T=world.THREE,l=new T.DirectionalLight(p.color,p.intensity);l.position.set(0,0,0);lightTargetChild(T,l,actor);
    const c=l.shadow.camera;c.left=c.bottom=-p.shadowArea;c.right=c.top=p.shadowArea;c.near=-p.shadowArea*4;c.far=p.shadowArea*4;c.updateProjectionMatrix();applyShadow(l,p,p.shadowMapSize);actor.object.add(l);return {light:l};},
  update(inst,p,key){const l=inst.light;if(key==='intensity')l.intensity=p.intensity;else if(key==='color')l.color.set(p.color);else if(key==='castShadow'||key==='shadowBias'||key==='shadowMapSize')applyShadow(l,p,p.shadowMapSize);else return false;return true;},
  dispose:removeLight});
reg('SkyLight',{label:'Sky Light',category:'Lights',icon:'sky',
  schema:{intensity:{type:'number',default:.6,min:0,max:20,step:.05},skyColor:{type:'color',default:'#bcd4ff'},groundColor:{type:'color',default:'#4b4036'}},
  create(actor,p,world){const l=new world.THREE.HemisphereLight(p.skyColor,p.groundColor,p.intensity);actor.object.add(l);return {light:l};},
  update(inst,p,key){const l=inst.light;if(key==='intensity')l.intensity=p.intensity;else if(key==='skyColor')l.color.set(p.skyColor);else if(key==='groundColor')l.groundColor.set(p.groundColor);else return false;return true;},
  dispose:removeLight});

/* RigidBody: thin adapter over KE.Physics3D. Bodies exist only while playing (created at beginPlay). */
reg('RigidBody',{label:'Rigid Body',category:'Physics',icon:'physics',
  schema:{bodyType:{type:'enum',options:['dynamic','fixed','kinematic'],default:'dynamic',label:'Mobility'},shape:{type:'enum',options:['auto','box','sphere','capsule','convex'],default:'auto'},
    mass:{type:'number',default:1,min:.001,max:100000,step:.1},friction:{type:'number',default:.6,min:0,max:4,step:.05},restitution:{type:'number',default:.1,min:0,max:1,step:.05},
    linearDamping:{type:'number',default:0,min:0,max:100,step:.05},angularDamping:{type:'number',default:.05,min:0,max:100,step:.05}},
  create(actor,props,world){return {actor,world,props,body:null};},
  beginPlay(inst){const w=inst.world,ph=w.physics,p=inst.props;
    if(!ph){w.warnOnce('nophys','RigidBody components are inert: the world has no physics system (pass {physics} to GameWorld)');return;}
    const fn={auto:'addFromObject',box:'addBox',sphere:'addSphere',capsule:'addCapsule',convex:'addConvex'}[p.shape];
    const add=typeof ph[fn]==='function'?ph[fn]:ph.addFromObject;if(typeof add!=='function'){w.warnOnce('nophysadd','Physics system has no '+fn+'()');return;}
    inst.actor.object.updateWorldMatrix(true,true);
    try{inst.body=add.call(ph,inst.actor.object,{type:p.bodyType,mass:p.mass,friction:p.friction,restitution:p.restitution,linearDamping:p.linearDamping,angularDamping:p.angularDamping,shape:p.shape==='auto'?undefined:p.shape});w._trackBody(inst.body,inst.actor,true);}
    catch(e){w.warn(inst.actor.name+': RigidBody creation failed: '+e.message);}},
  tick(inst){if(inst.body&&inst.props.bodyType==='kinematic'&&typeof inst.body.teleport==='function'){const o=inst.actor.object;inst.body.teleport(o.position,o.quaternion);}},
  endPlay(inst){if(!inst.body)return;const w=inst.world;w._trackBody(inst.body,inst.actor,false);try{if(w.physics&&typeof w.physics.remove==='function')w.physics.remove(inst.body);else if(inst.body.dispose)inst.body.dispose();}catch(e){w.warn('RigidBody removal failed: '+e.message);}inst.body=null;},
  applyImpulse(inst,v){if(inst.body&&typeof inst.body.applyImpulse==='function'){inst.body.applyImpulse(v);return true;}return false;}});

/* TriggerVolume: physics sensor when available, plus a cheap closest-point test against tagged actors
   that have no physics body (so game-moved players still trigger). Fires Overlap / EndOverlap. */
reg('TriggerVolume',{label:'Trigger Volume',category:'Volumes',icon:'trigger',
  schema:{shape:{type:'enum',options:['box','sphere'],default:'box'},size:{type:'vec3',default:[2,2,2],min:.01,max:10000},radius:{type:'number',default:1,min:.01,max:10000,step:.1,when:p=>p.shape==='sphere'},
    filterTag:{type:'string',default:'player',maxLength:LIMITS.tag,label:'Filter Tag'},once:{type:'bool',default:false,label:'Trigger Once'},visibleInGame:{type:'bool',default:false,label:'Visible In Game'}},
  create(actor,props,world,comp){
    const T=world.THREE,inst={actor,world,comp,props,overlaps:new Set(),done:false,sensor:null,debug:null,
      setOverlap(other,inside){if(other===actor||inst.done)return;if(props.filterTag&&!other.hasTag(props.filterTag))return;
        if(inside&&!inst.overlaps.has(other)){inst.overlaps.add(other);world._overlap(actor,other,true);if(props.once)inst.done=true;}
        else if(!inside&&inst.overlaps.has(other)){inst.overlaps.delete(other);world._overlap(actor,other,false);}},
      poll(){const w=world,p=props,local=w._v1,cp=w._v2,wp=w._v3;actor.object.updateWorldMatrix(true,false);const inv=w._m1.copy(actor.object.matrixWorld).invert();
        const list=p.filterTag?w._byTag.get(p.filterTag):w.actors;if(list)for(const o of list){if(o===actor||!o.alive||o.pendingKill||(inst.sensor&&o._bodies>0))continue;
          o.getWorldPosition(wp);const r=o.boundsRadius()*.5;let inside;
          if(p.shape==='sphere'){actor.getWorldPosition(cp);const s=actor.object.scale;inside=cp.distanceTo(wp)<=p.radius*Math.max(Math.abs(s.x),Math.abs(s.y),Math.abs(s.z))+r;}
          else{local.copy(wp).applyMatrix4(inv);cp.set(clamp(local.x,-p.size[0]/2,p.size[0]/2),clamp(local.y,-p.size[1]/2,p.size[1]/2),clamp(local.z,-p.size[2]/2,p.size[2]/2)).applyMatrix4(actor.object.matrixWorld);inside=cp.distanceTo(wp)<=r+1e-6;}
          inst.setOverlap(o,inside);}
        for(const o of inst.overlaps)if(!o.alive||o.pendingKill)inst.overlaps.delete(o);}};
    world._triggers.add(inst);
    if(props.visibleInGame){const g=props.shape==='sphere'?new T.SphereGeometry(props.radius,16,10):new T.BoxGeometry(...props.size);inst.debug=new T.Mesh(g,new T.MeshBasicMaterial({color:0x3fd67a,transparent:true,opacity:.18,depthWrite:false}));actor.object.add(inst.debug);}
    return inst;},
  beginPlay(inst){inst.overlaps.clear();inst.done=false;const w=inst.world,ph=w.physics,p=inst.props;if(!ph)return;
    const fn=p.shape==='sphere'?'addSphere':'addBox';if(typeof ph[fn]!=='function')return;
    try{inst.sensor=ph[fn](inst.actor.object,{type:'fixed',sensor:true,size:p.size.slice(),halfExtents:p.size.map(v=>v/2),radius:p.radius});w._trackBody(inst.sensor,inst.actor,true);}catch(e){w.warn(inst.actor.name+': trigger sensor failed, using overlap tests: '+e.message);inst.sensor=null;}},
  endPlay(inst){const w=inst.world;if(inst.sensor){w._trackBody(inst.sensor,inst.actor,false);try{w.physics&&w.physics.remove?w.physics.remove(inst.sensor):inst.sensor.dispose&&inst.sensor.dispose();}catch(e){}inst.sensor=null;}inst.overlaps.clear();},
  dispose(inst){inst.world._triggers.delete(inst);if(inst.debug){inst.debug.parent.remove(inst.debug);inst.debug.geometry.dispose();inst.debug.material.dispose();}}});

/* ParticleEmitter: KE.VFX adapter; without VFX a small KE.Particles fallback keeps it visible. */
const FALLBACK_FX={fire:[0xff7a2a,40,2.5],smoke:[0x9a9a9a,14,1.2],sparks:[0xffd27a,30,-9],magic:[0x9d7bff,26,.5],dust:[0xc9b48f,10,-.5],fireflies:[0xd9ff6a,6,.2],rain:[0x9fc4ff,60,-18],snow:[0xffffff,30,-1.5],embers:[0xff9540,16,1.5],fountain:[0x7ad0ff,50,-9]};
reg('ParticleEmitter',{label:'Particle Emitter',category:'Effects',icon:'fx',
  schema:{preset:{type:'string',default:'fire',maxLength:64,suggest:()=>{const s=new Set(Object.keys(FALLBACK_FX));return [...s];}},autoPlay:{type:'bool',default:true,label:'Auto Activate'},
    scale:{type:'number',default:1,min:.01,max:100,step:.1},overrides:{type:'json',default:{}},offset:{type:'vec3',default:[0,0,0],label:'Relative Location'}},
  create(actor,props,world){return {actor,world,props,emitter:null,fallback:null,acc:0,pos:new world.THREE.Vector3(),playing:false};},
  beginPlay(inst){if(inst.props.autoPlay)fxStart(inst);},
  tick(inst,dt){if(!inst.playing)return;const p=fxPos(inst);if(inst.emitter){if(typeof inst.emitter.setPosition==='function')inst.emitter.setPosition(p);}
    else if(inst.fallback){const f=FALLBACK_FX[inst.props.preset]||FALLBACK_FX.fire;inst.acc+=dt*f[1]*Math.min(1,inst.props.scale);const n=Math.floor(inst.acc);if(n>0){inst.acc-=n;inst.fallback.burst(p.x,p.y,p.z,n);}inst.fallback.update(dt);}},
  endPlay(inst){fxStop(inst);},dispose(inst){fxStop(inst);},
  play(inst){fxStart(inst);},stop(inst){fxStop(inst);}});
function fxPos(inst){const o=inst.props.offset;inst.actor.object.updateWorldMatrix(true,false);return inst.pos.set(o[0],o[1],o[2]).applyMatrix4(inst.actor.object.matrixWorld);}
function vfxConfig(vfx,preset,overrides,scale){let cfg=null;const pr=safeMember(vfx.presets,preset);
  if(typeof pr==='function')cfg=pr.call(vfx.presets,overrides||{});else if(isObj(pr))cfg=Object.assign({},pr);if(!isObj(cfg))return null;
  cfg=Object.assign({},cfg,overrides||{});if(scale!==1&&typeof cfg.scale!=='number')cfg.scale=scale;return cfg;}
function fxStart(inst){if(inst.playing)return;const w=inst.world,p=inst.props,pos=fxPos(inst);inst.playing=true;
  if(w.vfx&&typeof w.vfx.emitter==='function'){try{const cfg=vfxConfig(w.vfx,p.preset,p.overrides,p.scale);if(!cfg){w.warn(inst.actor.name+': unknown VFX preset "'+p.preset+'"');}else{inst.emitter=w.vfx.emitter(cfg);if(inst.emitter.setPosition)inst.emitter.setPosition(pos);if(inst.emitter.play)inst.emitter.play();return;}}catch(e){w.warn(inst.actor.name+': VFX emitter failed: '+e.message);}}
  if(!w.vfx)w.warnOnce('novfx','ParticleEmitter: no KE.VFX system in the world; using simple fallback particles');
  if(KE.Particles){const f=FALLBACK_FX[p.preset]||FALLBACK_FX.fire;inst.fallback=new KE.Particles(w.THREE,w.scene,{capacity:Math.round(96*clamp(p.scale,.25,4)),size:.14*p.scale,color:f[0],gravity:f[2],seed:inst.actor.id});}}
function fxStop(inst){inst.playing=false;if(inst.emitter){try{inst.emitter.stop&&inst.emitter.stop();inst.emitter.dispose&&inst.emitter.dispose();}catch(e){}inst.emitter=null;}if(inst.fallback){inst.fallback.dispose();inst.fallback=null;}}

/* AudioSource: KE.AudioEngine adapter (KE.Synth sources); legacy KE.Audio.tone() as a fallback. */
function playSound(world,synth,params,{position=null,follow=null,loop=false,bus='sfx',volume=1}={}){
  const a=world.audio;if(!a){world.warnOnce('noaudio','Sounds are silent: the world has no audio engine (pass {audio} to GameWorld)');return null;}
  try{if(typeof a.play==='function'){let src=synth;const fn=safeMember(KE.Synth,synth);if(typeof fn==='function')src=fn.call(KE.Synth,params||{});return a.play(src,{position:position||undefined,follow:follow||undefined,loop,bus,volume});}
    if(typeof a.tone==='function'){const n=params&&Number.isFinite(params.frequency)?params.frequency:660;a.tone(n,params&&params.duration||.15);return null;}}
  catch(e){world.warn('Sound "'+synth+'" failed: '+e.message);}return null;}
reg('AudioSource',{label:'Audio Source',category:'Audio',icon:'audio',
  schema:{synth:{type:'string',default:'chime',maxLength:64,label:'Sound',suggest:()=>KE.Synth?Object.keys(KE.Synth).filter(k=>typeof KE.Synth[k]==='function'):[]},params:{type:'json',default:{}},
    autoPlay:{type:'bool',default:true},loop:{type:'bool',default:false},spatial:{type:'bool',default:true},volume:{type:'number',default:1,min:0,max:4,step:.05},bus:{type:'string',default:'sfx',maxLength:32}},
  create(actor,props,world){return {actor,world,props,voice:null};},
  beginPlay(inst){if(inst.props.autoPlay)audioPlay(inst);},
  endPlay(inst){audioStop(inst);},dispose(inst){audioStop(inst);},play(inst){audioPlay(inst);},stop(inst){audioStop(inst);}});
function audioPlay(inst){audioStop(inst);const p=inst.props,pos=p.spatial?inst.actor.getWorldPosition(new inst.world.THREE.Vector3()):null;inst.voice=playSound(inst.world,p.synth,p.params,{position:pos,follow:p.spatial?inst.actor.object:null,loop:p.loop,bus:p.bus,volume:p.volume});}
function audioStop(inst){if(inst.voice){try{inst.voice.stop&&inst.voice.stop();inst.voice.dispose&&inst.voice.dispose();}catch(e){}inst.voice=null;}}

/* Simple movement components. */
reg('Rotator',{label:'Rotating Movement',category:'Movement',icon:null,schema:{speed:{type:'vec3',default:[0,90,0],label:'Rotation Rate (deg/s)'},space:{type:'enum',options:['local','world'],default:'local'}},
  create(actor,props){return {actor,props,axis:null};},
  tick(inst,dt){const o=inst.actor.object,s=inst.props.speed;if(inst.props.space==='world'){const T=inst.actor.world.THREE;const ax=inst.axis||(inst.axis=[new T.Vector3(1,0,0),new T.Vector3(0,1,0),new T.Vector3(0,0,1)]);if(s[0])o.rotateOnWorldAxis(ax[0],s[0]*DEG*dt);if(s[1])o.rotateOnWorldAxis(ax[1],s[1]*DEG*dt);if(s[2])o.rotateOnWorldAxis(ax[2],s[2]*DEG*dt);}
    else{if(s[0])o.rotateX(s[0]*DEG*dt);if(s[1])o.rotateY(s[1]*DEG*dt);if(s[2])o.rotateZ(s[2]*DEG*dt);}}});
reg('Oscillator',{label:'Oscillator (Bobbing)',category:'Movement',icon:null,schema:{amplitude:{type:'vec3',default:[0,.25,0]},frequency:{type:'number',default:.5,min:0,max:60,step:.05,label:'Frequency (Hz)'},phase:{type:'number',default:0,min:-360,max:360,step:1,label:'Phase (deg)'}},
  create(actor,props){return {actor,props,base:null,t:0};},
  beginPlay(inst){inst.base=inst.actor.object.position.clone();inst.t=0;},
  tick(inst,dt){if(!inst.base)return;inst.t+=dt;const p=inst.props,k=Math.sin(inst.t*p.frequency*Math.PI*2+p.phase*DEG),a=p.amplitude;inst.actor.object.position.set(inst.base.x+a[0]*k,inst.base.y+a[1]*k,inst.base.z+a[2]*k);}});
KE.Components.alias('Bobbing','Oscillator');
function targetActor(world,inst,name){if(!name)return null;if(inst._t&&inst._t.alive&&inst._tn===name)return inst._t;inst._tn=name;inst._t=name.startsWith('tag:')?world.findByTag(name.slice(4))[0]||null:world.find(name);return inst._t;}
reg('Follow',{label:'Follow',category:'Movement',icon:null,schema:{target:{type:'string',default:'',maxLength:LIMITS.name,label:'Target Actor'},offset:{type:'vec3',default:[0,2,4]},relative:{type:'bool',default:false,label:'Offset In Target Space'},smoothing:{type:'number',default:6,min:0,max:100,step:.5},lookAt:{type:'bool',default:false,label:'Look At Target'}},
  create(actor,props,world){const T=world.THREE;return {actor,world,props,v:new T.Vector3(),w:new T.Vector3()};},
  tick(inst,dt){const t=targetActor(inst.world,inst,inst.props.target);if(!t||t===inst.actor)return;const p=inst.props,goal=inst.v.fromArray(p.offset);
    if(p.relative){t.object.updateWorldMatrix(true,false);goal.applyMatrix4(t.object.matrixWorld);}else goal.add(t.getWorldPosition(inst.w));
    const o=inst.actor.object;if(o.parent&&o.parent!==inst.world.scene){o.parent.updateWorldMatrix(true,false);o.parent.worldToLocal(goal);}
    if(p.smoothing>0){const k=1-Math.exp(-p.smoothing*dt);o.position.lerp(goal,k);}else o.position.copy(goal);if(p.lookAt)o.lookAt(t.getWorldPosition(inst.w));}});
reg('LookAt',{label:'Look At',category:'Movement',icon:null,schema:{target:{type:'string',default:'',maxLength:LIMITS.name,label:'Target Actor'},yawOnly:{type:'bool',default:true,label:'Yaw Only'},smoothing:{type:'number',default:10,min:0,max:100,step:.5}},
  create(actor,props,world){const T=world.THREE;return {actor,world,props,v:new T.Vector3(),w:new T.Vector3(),q:new T.Quaternion(),m:new T.Matrix4(),up:new T.Vector3(0,1,0)};},
  tick(inst,dt){const t=targetActor(inst.world,inst,inst.props.target);if(!t||t===inst.actor)return;const o=inst.actor.object,me=inst.actor.getWorldPosition(inst.w),at=t.getWorldPosition(inst.v);if(inst.props.yawOnly)at.y=me.y;if(at.distanceToSquared(me)<1e-8)return;
    inst.m.lookAt(at,me,inst.up);inst.q.setFromRotationMatrix(inst.m);if(inst.props.smoothing>0)o.quaternion.slerp(inst.q,1-Math.exp(-inst.props.smoothing*dt));else o.quaternion.copy(inst.q);}});
reg('PlayerStart',{label:'Player Start',category:'Gameplay',icon:'player',schema:{playerTag:{type:'string',default:'player',maxLength:LIMITS.tag,label:'Player Tag'}},create(){return {};}});

/* TextLabel: camera-facing sprite with canvas-rendered text. */
function drawLabel(T,p,tex){const c=tex?tex.image:document.createElement('canvas'),g=c.getContext('2d'),px=64,font='600 '+px+'px system-ui,-apple-system,Segoe UI,sans-serif';g.font=font;
  const lines=p.text.split('\n').slice(0,8),w=Math.ceil(Math.max(8,...lines.map(l=>g.measureText(l).width)))+px*.7,h=Math.ceil(lines.length*px*1.2+px*.4);
  c.width=Math.min(2048,w);c.height=Math.min(1024,h);g.font=font;g.clearRect(0,0,c.width,c.height);
  if(p.backgroundOpacity>0){g.globalAlpha=p.backgroundOpacity;g.fillStyle=p.background;const r=px*.25;g.beginPath();g.moveTo(r,0);g.arcTo(c.width,0,c.width,c.height,r);g.arcTo(c.width,c.height,0,c.height,r);g.arcTo(0,c.height,0,0,r);g.arcTo(0,0,c.width,0,r);g.fill();g.globalAlpha=1;}
  g.fillStyle=p.color;g.textAlign='center';g.textBaseline='middle';lines.forEach((l,i)=>g.fillText(l,c.width/2,px*.2+px*1.2*(i+.5)));
  if(tex){tex.needsUpdate=true;return tex;}const t=new T.CanvasTexture(c);t.encoding=T.sRGBEncoding;t.anisotropy=4;return t;}
reg('TextLabel',{label:'Text Render',category:'Rendering',icon:'text',schema:{text:{type:'text',default:'Text',maxLength:200},color:{type:'color',default:'#ffffff'},background:{type:'color',default:'#101418'},backgroundOpacity:{type:'number',default:.55,min:0,max:1,step:.05},size:{type:'number',default:.5,min:.01,max:100,step:.05,label:'World Height'},offset:{type:'vec3',default:[0,1,0],label:'Relative Location'},depthTest:{type:'bool',default:true}},
  create(actor,p,world,comp){const T=world.THREE,tex=drawLabel(T,p),mat=new T.SpriteMaterial({map:tex,transparent:true,depthTest:p.depthTest,toneMapped:false}),s=new T.Sprite(mat);s.userData.keComponent=comp;
    const inst={sprite:s,tex,mat};sizeLabel(inst,p);vecSet(s.position,p.offset);actor.object.add(s);return inst;},
  update(inst,p,key){if(key==='offset'){vecSet(inst.sprite.position,p.offset);return true;}if(key==='size'){sizeLabel(inst,p);return true;}if(key==='depthTest'){inst.mat.depthTest=p.depthTest;return true;}drawLabel(null,p,inst.tex);sizeLabel(inst,p);return true;},
  dispose(inst){if(inst.sprite.parent)inst.sprite.parent.remove(inst.sprite);inst.tex.dispose();inst.mat.dispose();}});
function sizeLabel(inst,p){const c=inst.tex.image,lines=Math.max(1,p.text.split('\n').slice(0,8).length);inst.sprite.scale.set(p.size*c.width/c.height*lines,p.size*lines,1);}

/* ---------- Blueprint: expressions ---------- */
/* Expressions are JSON ASTs: literals, {var}, {global}, {prop,target}, {event}, {time:1}, {dt:1},
   {op,a,b,c}. Only the operators below exist; there is no property access outside the whitelist. */
const BIN_OPS=new Set(['+','-','*','/','%','pow','min','max','==','!=','<','<=','>','>=','&&','||','random','atan2']);
const UN_OPS=new Set(['!','neg','abs','floor','ceil','round','sqrt','sin','cos','sign','str','num','len']);
const TRI_OPS=new Set(['clamp','lerp','?']);
const PROPS=new Set(['position.x','position.y','position.z','rotation.x','rotation.y','rotation.z','scale.x','scale.y','scale.z','visible','name','alive','distance','id']);
const exprErr=m=>{throw new Error(m);};
function normExpr(e,depth=0,warnings=null){
  if(depth>LIMITS.exprDepth)exprErr('expression nested too deeply');
  if(e===null||typeof e==='boolean')return e;
  if(typeof e==='number'){if(!Number.isFinite(e))exprErr('non-finite number');return e;}
  if(typeof e==='string'){if(e.length>LIMITS.text)exprErr('string too long');return e;}
  if(Array.isArray(e)){if(e.length>16)exprErr('array literal too long');return e.map(x=>normExpr(x,depth+1));}
  if(!isObj(e))exprErr('invalid expression');
  if(has(e,'var')){if(typeof e.var!=='string'||!NAME_RE.test(e.var))exprErr('invalid variable name');return {var:e.var};}
  if(has(e,'global')){if(typeof e.global!=='string'||!NAME_RE.test(e.global))exprErr('invalid global name');return {global:e.global};}
  if(has(e,'event')){if(typeof e.event!=='string'||!NAME_RE.test(e.event))exprErr('invalid event field');return {event:e.event};}
  if(has(e,'time'))return {time:1};if(has(e,'dt'))return {dt:1};
  if(has(e,'prop')){const p=String(e.prop);if(!PROPS.has(p)&&!/^var\.[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(p))exprErr('property "'+p.slice(0,40)+'" is not readable');
    const out={prop:p,target:typeof e.target==='string'?e.target.slice(0,LIMITS.name):'self'};if(p==='distance')out.to=typeof e.to==='string'?e.to.slice(0,LIMITS.name):'other';return out;}
  if(has(e,'hasTag'))return {hasTag:String(e.hasTag).slice(0,LIMITS.tag),target:typeof e.target==='string'?e.target.slice(0,LIMITS.name):'self'};
  if(has(e,'op')){const op=e.op;
    if(BIN_OPS.has(op))return {op,a:normExpr(e.a,depth+1),b:normExpr(e.b,depth+1)};
    if(UN_OPS.has(op))return {op,a:normExpr(e.a,depth+1)};
    if(TRI_OPS.has(op))return {op,a:normExpr(e.a,depth+1),b:normExpr(e.b,depth+1),c:normExpr(e.c,depth+1)};
    exprErr('unknown operator "'+String(op).slice(0,16)+'"');}
  exprErr('invalid expression object');
}
const num=v=>typeof v==='number'?v:typeof v==='boolean'?+v:typeof v==='string'&&v.trim()!==''&&Number.isFinite(+v)?+v:0;
const fin=v=>Number.isFinite(v)?v:0;
function eq(a,b){if(typeof a==='string'||typeof b==='string')return a===b;if(Array.isArray(a)||Array.isArray(b))return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((x,i)=>eq(x,b[i]));if(a===null||b===null)return a===b;return num(a)===num(b);}
function evalExpr(e,ctx,depth=0){
  if(e===null||typeof e!=='object')return e;
  if(depth>LIMITS.exprDepth)throw new Error('expression too deep');
  if(Array.isArray(e))return e.map(x=>evalExpr(x,ctx,depth+1));
  if(e.var!==undefined)return has(ctx.vars,e.var)?ctx.vars[e.var]:0;
  if(e.global!==undefined)return has(ctx.world.vars,e.global)?ctx.world.vars[e.global]:0;
  if(e.event!==undefined){const v=ctx.event&&has(ctx.event,e.event)?ctx.event[e.event]:undefined;return v&&v.alive!==undefined?v.name:v===undefined?null:v;}
  if(e.time!==undefined)return ctx.world.time;if(e.dt!==undefined)return ctx.dt||0;
  if(e.hasTag!==undefined){const a=resolveTargets(ctx,e.target)[0];return !!(a&&a.hasTag(e.hasTag));}
  if(e.prop!==undefined){const a=resolveTargets(ctx,e.target)[0];if(!a)return e.prop==='alive'?false:0;const o=a.object;
    switch(e.prop){case 'name':return a.name;case 'id':return a.id;case 'alive':return a.alive&&!a.pendingKill;case 'visible':return o.visible;
      case 'distance':{const b=resolveTargets(ctx,e.to)[0];if(!b)return 0;return a.getWorldPosition(ctx.world._v1).distanceTo(b.getWorldPosition(ctx.world._v2));}}
    if(e.prop.startsWith('var.')){const bp=a.getComponent('Blueprint'),k=e.prop.slice(4);return bp&&bp.instance&&has(bp.instance.vars,k)?bp.instance.vars[k]:0;}
    const [grp,ax]=e.prop.split('.');const v=o[grp][ax];return grp==='rotation'?v*RAD:v;}
  const op=e.op;
  if(op==='&&'){const a=evalExpr(e.a,ctx,depth+1);return a?evalExpr(e.b,ctx,depth+1):a;}
  if(op==='||'){const a=evalExpr(e.a,ctx,depth+1);return a?a:evalExpr(e.b,ctx,depth+1);}
  if(op==='?')return evalExpr(e.a,ctx,depth+1)?evalExpr(e.b,ctx,depth+1):evalExpr(e.c,ctx,depth+1);
  const a=evalExpr(e.a,ctx,depth+1);
  if(UN_OPS.has(op))switch(op){case '!':return !a;case 'neg':return -num(a);case 'abs':return Math.abs(num(a));case 'floor':return Math.floor(num(a));case 'ceil':return Math.ceil(num(a));case 'round':return Math.round(num(a));
    case 'sqrt':return fin(Math.sqrt(num(a)));case 'sin':return Math.sin(num(a));case 'cos':return Math.cos(num(a));case 'sign':return Math.sign(num(a));case 'str':return String(a===null?'':a).slice(0,LIMITS.text);case 'num':return num(a);case 'len':return typeof a==='string'||Array.isArray(a)?a.length:0;}
  const b=evalExpr(e.b,ctx,depth+1);
  switch(op){
    case '+':if(typeof a==='string'||typeof b==='string')return (String(a)+String(b)).slice(0,LIMITS.text);if(Array.isArray(a)&&Array.isArray(b))return a.map((x,i)=>num(x)+num(b[i]));return fin(num(a)+num(b));
    case '-':if(Array.isArray(a)&&Array.isArray(b))return a.map((x,i)=>num(x)-num(b[i]));return fin(num(a)-num(b));
    case '*':if(Array.isArray(a))return a.map(x=>num(x)*num(b));return fin(num(a)*num(b));
    case '/':{const d=num(b);return d===0?0:fin(num(a)/d);}case '%':{const d=num(b);return d===0?0:fin(num(a)%d);}
    case 'pow':return fin(Math.pow(num(a),num(b)));case 'min':return Math.min(num(a),num(b));case 'max':return Math.max(num(a),num(b));case 'atan2':return Math.atan2(num(a),num(b));
    case '==':return eq(a,b);case '!=':return !eq(a,b);
    case '<':return num(a)<num(b);case '<=':return num(a)<=num(b);case '>':return num(a)>num(b);case '>=':return num(a)>=num(b);
    case 'random':{const lo=num(a),hi=num(b);return lo+(hi-lo)*ctx.world.random();}
  }
  const c=evalExpr(e.c,ctx,depth+1);
  if(op==='clamp')return clamp(num(a),num(b),num(c));if(op==='lerp')return num(a)+(num(b)-num(a))*num(c);
  return 0;
}
/* Expression text parser (recursive descent, no eval): `score + 1`, `global.coins >= 3 && !self.visible`,
   `distance("Player") < 2`, `actor("Door").position.y`, `min(a, 4)`, `random(0, 1)`, `"text" + score`. */
const PREC=[['||'],['&&'],['==','!='],['<','<=','>','>='],['+','-'],['*','/','%']];
const FUNCS={min:2,max:2,pow:2,atan2:2,random:2,abs:1,floor:1,ceil:1,round:1,sqrt:1,sin:1,cos:1,sign:1,str:1,num:1,len:1,clamp:3,lerp:3};
function parseExpr(text){
  if(typeof text!=='string')throw new TypeError('Expression text must be a string');if(text.length>LIMITS.exprChars)throw new Error('Expression too long');
  const toks=[],re=/\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|([A-Za-z_][A-Za-z0-9_]*)|(&&|\|\||==|!=|<=|>=|[-+*/%<>!(),.?:\[\]]))/gy;
  let m,pos=0;while(pos<text.length){re.lastIndex=pos;m=re.exec(text);if(!m){if(/^\s*$/.test(text.slice(pos)))break;throw new Error('Unexpected "'+text.slice(pos).trim()[0]+'" at '+pos);}pos=re.lastIndex;
    if(m[1]!==undefined)toks.push({t:'num',v:parseFloat(m[1])});else if(m[2]!==undefined)toks.push({t:'str',v:m[2].slice(1,-1).replace(/\\(.)/g,'$1')});else if(m[3]!==undefined)toks.push({t:'id',v:m[3]});else if(m[4]!==undefined)toks.push({t:'op',v:m[4]});}
  let i=0,depth=0;const peek=()=>toks[i],next=()=>toks[i++],isOp=v=>toks[i]&&toks[i].t==='op'&&toks[i].v===v,expect=v=>{if(!isOp(v))throw new Error('Expected "'+v+'"');i++;};
  const ternary=()=>{const c=binary(0);if(isOp('?')){i++;const a=ternary();expect(':');const b=ternary();return {op:'?',a:c,b:a,c:b};}return c;};
  const binary=l=>{if(l>=PREC.length)return unary();let a=binary(l+1);while(peek()&&peek().t==='op'&&PREC[l].includes(peek().v)){const op=next().v;a={op,a,b:binary(l+1)};}return a;};
  const unary=()=>{if(++depth>LIMITS.exprDepth)throw new Error('Expression nested too deeply');let r;if(isOp('!')){i++;r={op:'!',a:unary()};}else if(isOp('-')){i++;const a=unary();r=typeof a==='number'?-a:{op:'neg',a};}else r=postfix(primary());depth--;return r;};
  const postfix=node=>node;
  const argList=()=>{expect('(');const args=[];if(!isOp(')')){do{args.push(ternary());}while(isOp(',')&&++i);}expect(')');return args;};
  const path=()=>{const parts=[];while(isOp('.')){i++;const t=next();if(!t||t.t!=='id')throw new Error('Expected a name after "."');parts.push(t.v);}return parts.join('.');};
  const actorProp=(target)=>{const p=path();if(!p)throw new Error('Expected a property after '+target);return {prop:p,target};};
  const primary=()=>{const t=next();if(!t)throw new Error('Unexpected end of expression');
    if(t.t==='num')return t.v;if(t.t==='str')return t.v;
    if(t.t==='op'&&t.v==='('){const e=ternary();expect(')');return e;}
    if(t.t==='op'&&t.v==='['){const items=[];if(!isOp(']')){do{items.push(ternary());}while(isOp(',')&&++i);}expect(']');return items;}
    if(t.t!=='id')throw new Error('Unexpected "'+t.v+'"');
    const id=t.v;
    if(id==='true')return true;if(id==='false')return false;if(id==='null')return null;if(id==='time')return {time:1};if(id==='dt')return {dt:1};
    if(id==='global'){const p=path();if(!p)throw new Error('Expected global.name');return {global:p};}
    if(id==='event'){const p=path();if(!p)throw new Error('Expected event.field');return {event:p};}
    if(id==='self'||id==='other')return actorProp(id);
    if(id==='actor'){const a=argList();if(a.length!==1||typeof a[0]!=='string')throw new Error('actor() takes one name string');return actorProp(a[0]);}
    if(id==='hasTag'){const a=argList();if(typeof a[0]!=='string')throw new Error('hasTag() takes a tag string');return {hasTag:a[0],target:typeof a[1]==='string'?a[1]:'self'};}
    if(id==='distance'){const a=argList();if(typeof a[0]!=='string')throw new Error('distance() takes an actor name');return {prop:'distance',target:typeof a[1]==='string'?a[1]:'self',to:a[0]};}
    if(has(FUNCS,id)&&isOp('(')){const a=argList();if(a.length!==FUNCS[id])throw new Error(id+'() takes '+FUNCS[id]+' argument(s)');return FUNCS[id]===1?{op:id,a:a[0]}:FUNCS[id]===2?{op:id,a:a[0],b:a[1]}:{op:id,a:a[0],b:a[1],c:a[2]};}
    return {var:id};};
  const e=ternary();if(i<toks.length)throw new Error('Unexpected "'+toks[i].v+'"');return normExpr(e);
}
function formatExpr(e,parent=-1){
  if(e===null)return 'null';if(typeof e==='number')return String(e);if(typeof e==='boolean')return String(e);if(typeof e==='string')return JSON.stringify(e);
  if(Array.isArray(e))return '['+e.map(x=>formatExpr(x)).join(', ')+']';if(!isObj(e))return '';
  if(e.var!==undefined)return e.var;if(e.global!==undefined)return 'global.'+e.global;if(e.event!==undefined)return 'event.'+e.event;if(e.time!==undefined)return 'time';if(e.dt!==undefined)return 'dt';
  const tgt=t=>t==='self'||t==='other'?t:'actor('+JSON.stringify(t)+')';
  if(e.hasTag!==undefined)return 'hasTag('+JSON.stringify(e.hasTag)+(e.target&&e.target!=='self'?', '+JSON.stringify(e.target):'')+')';
  if(e.prop!==undefined){if(e.prop==='distance')return 'distance('+JSON.stringify(e.to)+(e.target!=='self'?', '+JSON.stringify(e.target):'')+')';return tgt(e.target)+'.'+e.prop;}
  const op=e.op;
  if(op==='str'&&typeof e.a==='string')return JSON.stringify(e.a);if(op==='!')return '!'+formatExpr(e.a,9);if(op==='neg')return '-'+formatExpr(e.a,9);
  if(op==='?'){const s=formatExpr(e.a,0)+' ? '+formatExpr(e.b)+' : '+formatExpr(e.c);return parent>=0?'('+s+')':s;}
  if(has(FUNCS,op))return op+'('+[e.a,e.b,e.c].slice(0,FUNCS[op]).map(x=>formatExpr(x)).join(', ')+')';
  const lvl=PREC.findIndex(g=>g.includes(op));if(lvl<0)return '';
  const s=formatExpr(e.a,lvl)+' '+op+' '+formatExpr(e.b,lvl+.5);return lvl<parent?'('+s+')':s;
}

/* ---------- Blueprint: node registry and validation ---------- */
/* Field types: string, text, number (literal or expression), bool, vec3, expr, target ('self'|'other'|name|'tag:x'|'all'),
   location (target name or [x,y,z]), actions (nested list), event, var, ease, json, prefab, preset, synth, color, exprs. */
const nodeTypes={};
const BP_EVENTS=['BeginPlay','Tick','Overlap','EndOverlap','EndPlay'];
const DEFER={};
function registerNode(op,def){if(!NAME_RE.test(op))throw new TypeError('Node op must be an identifier');if(typeof def.exec!=='function')throw new TypeError('Node '+op+' needs exec(ctx,node)');
  nodeTypes[op]={op,category:def.category||'Custom',help:def.help||'',fields:def.fields||{},exec:def.exec,color:def.color||null};return nodeTypes[op];}
/* Strings in expression fields are expression text; a bare string literal result is wrapped as str("...")
   so that normalizing an already-normalized graph is a no-op. */
function fieldExpr(v){if(typeof v==='string'){const r=parseExpr(v);return typeof r==='string'?{op:'str',a:r}:r;}return normExpr(v);}
function normAction(n,warn,budget,depth,where){
  if(!isObj(n)||typeof n.op!=='string'){warn(where+': action without op skipped');return null;}
  const t=nodeTypes[n.op];if(!t){warn(where+': unknown action "'+String(n.op).slice(0,32)+'" skipped');return null;}
  if(--budget.n<0){if(budget.n===-1)warn(where+': too many actions, graph truncated');return null;}
  const out={op:n.op};
  for(const [k,f] of Object.entries(t.fields)){
    let v=n[k];if(v===undefined){if(f.optional)continue;v=clone(f.default);if(v===undefined)continue;}
    const w=m=>warn(where+' '+n.op+'.'+k+': '+m);
    try{switch(f.type){
      case 'actions':out[k]=normActions(v,warn,budget,depth+1,where+' '+n.op+'.'+k);break;
      case 'expr':out[k]=fieldExpr(v);break;
      case 'exprs':if(!Array.isArray(v)||v.length>16)throw new Error('must be an array of up to 16 expressions');out[k]=v.map(fieldExpr);break;
      case 'number':if(typeof v==='number'){if(!Number.isFinite(v))throw new Error('must be finite');out[k]=clamp(v,f.min!==undefined?f.min:-1e9,f.max!==undefined?f.max:1e9);}else out[k]=fieldExpr(v);break;
      case 'bool':if(typeof v==='boolean')out[k]=v;else out[k]=fieldExpr(v);break;
      case 'vec3':{const a=vec3Of(v);if(!a)throw new Error('must be [x,y,z]');out[k]=a;break;}
      case 'location':{if(typeof v==='string'){out[k]=v.slice(0,LIMITS.name);break;}const a=vec3Of(v);if(!a)throw new Error('must be an actor name or [x,y,z]');out[k]=a;break;}
      case 'color':{const c=normColor(v);if(!c)throw new Error('must be a color');out[k]=c;break;}
      case 'json':{const r=sanitizeJSON(v,w,'json');out[k]=r===undefined?clone(f.default):r;break;}
      case 'var':case 'event':if(typeof v!=='string'||!NAME_RE.test(v))throw new Error('must be an identifier');out[k]=v;break;
      case 'ease':out[k]=has(EASES,v)?v:'linear';if(!has(EASES,v))w('unknown ease, using linear');break;
      case 'enum':out[k]=f.options.includes(v)?v:f.default;break;
      default:if(typeof v!=='string'&&typeof v!=='number')throw new Error('must be a string');out[k]=String(v).slice(0,f.maxLength||(f.type==='text'?LIMITS.text:LIMITS.string));
    }}catch(e){w(e.message);if(f.optional)continue;if(f.default!==undefined)out[k]=clone(f.default);}
  }
  return out;
}
function normActions(list,warn,budget,depth,where){if(list===undefined||list===null)return [];if(!Array.isArray(list)){warn(where+': actions must be an array');return [];}
  if(depth>LIMITS.actionDepth){warn(where+': actions nested too deeply');return [];}const out=[];for(const n of list){const a=normAction(n,warn,budget,depth,where);if(a)out.push(a);}return out;}
function validateGraph(g,warn=()=>{}){
  const out={events:{},variables:{}};if(g===null||g===undefined)g={};if(!isObj(g)){warn('Blueprint graph must be an object');g={};}
  const budget={n:LIMITS.actions},ev=isObj(g.events)?g.events:{};
  for(const k of Object.keys(ev)){if(k==='Custom')continue;if(!BP_EVENTS.includes(k)){warn('Unknown Blueprint event "'+k.slice(0,32)+'" skipped (use events.Custom for custom events)');continue;}out.events[k]=normActions(ev[k],warn,budget,0,k);}
  if(ev.Custom!==undefined){if(!isObj(ev.Custom))warn('events.Custom must be an object');else{out.events.Custom={};for(const k of Object.keys(ev.Custom)){if(!NAME_RE.test(k)){warn('Invalid custom event name skipped');continue;}out.events.Custom[k]=normActions(ev.Custom[k],warn,budget,0,'Custom.'+k);}}}
  if(g.variables!==undefined){if(!isObj(g.variables))warn('variables must be an object');else{let n=0;for(const [k,v] of Object.entries(g.variables)){if(!NAME_RE.test(k)){warn('Invalid variable name "'+k.slice(0,32)+'"');continue;}if(++n>LIMITS.variables){warn('Too many variables');break;}
    const s=sanitizeJSON(v,warn,'variable '+k);if(s===undefined||(s!==null&&typeof s==='object'&&!(Array.isArray(s)&&s.length<=16&&s.every(x=>typeof x==='number')))){warn('Variable '+k+' must be a number, string, boolean, null or number array');out.variables[k]=0;}else out.variables[k]=s;}}}
  return out;
}

/* ---------- Blueprint: interpreter ---------- */
function resolveTargets(ctx,target){
  const w=ctx.world,ok=a=>a&&a.alive&&!a.pendingKill;
  if(target===undefined||target===null||target===''||target==='self')return ok(ctx.actor)?[ctx.actor]:[];
  if(target==='other')return ok(ctx.other)?[ctx.other]:[];
  if(target==='all')return w.actors.filter(ok);
  if(typeof target==='string'&&target.startsWith('tag:'))return w.findByTag(target.slice(4)).filter(ok);
  const a=w.find(String(target));return ok(a)?[a]:[];
}
function resolveLocation(ctx,at,out){if(Array.isArray(at))return out.fromArray(at);const a=resolveTargets(ctx,at||'self')[0];if(a)return a.getWorldPosition(out);return null;}
function val(ctx,v){return v!==null&&typeof v==='object'?evalExpr(v,ctx):v;}
function numVal(ctx,v,lo=-1e9,hi=1e9){return clamp(fin(num(val(ctx,v))),lo,hi);}
function interpolate(ctx,text){return text.indexOf('{')<0?text:text.replace(/\{(global\.)?([A-Za-z_][A-Za-z0-9_]{0,63})\}/g,(m,g,k)=>{const src=g?ctx.world.vars:ctx.vars;if(!has(src,k))return m;const v=src[k];return typeof v==='number'?String(Math.round(v*1000)/1000):String(v);});}
function execList(list,ctx,start=0){
  for(let i=start;i<list.length;i++){
    if(ctx.stop.v||!ctx.actor.alive||ctx.actor.pendingKill)return;
    if(++ctx.budget.n>LIMITS.steps){if(!ctx.budget.warned){ctx.budget.warned=true;ctx.world.warn(ctx.actor.name+': Blueprint step budget exceeded (possible infinite loop); event aborted');}ctx.stop.v=true;return;}
    const node=list[i],t=nodeTypes[node.op];if(!t)continue;
    try{if(t.exec(ctx,node,list,i)===DEFER)return;}catch(e){ctx.world.warn(ctx.actor.name+': '+node.op+' failed: '+e.message);}
  }
}
function subCtx(ctx,extra){return {...ctx,budget:{n:0},stop:{v:false},...extra};}
function later(ctx,seconds,fn){return ctx.world.setTimer(()=>{if(ctx.actor.alive&&!ctx.actor.pendingKill)fn();},seconds,{owner:ctx.actor});}
function runEvent(inst,name,payload={}){
  const g=inst.graph;let list=BP_EVENTS.includes(name)?g.events[name]:(g.events.Custom&&has(g.events.Custom,name)?g.events.Custom[name]:null);
  if(!list||!list.length)return false;
  if(inst.depth>32){inst.world.warn(inst.actor.name+': event recursion limit reached at '+name);return false;}
  let ctx;const other=payload&&payload.other&&payload.other.alive!==undefined?payload.other:null;
  if(name==='Tick'&&inst.depth===0){ctx=inst._tickCtx||(inst._tickCtx={inst,world:inst.world,actor:inst.actor,budget:{n:0},stop:{v:false}});ctx.vars=inst.vars;ctx.event=payload;ctx.other=null;ctx.dt=payload.dt||0;ctx.budget.n=0;ctx.budget.warned=false;ctx.stop.v=false;ctx.depth=inst.depth;}
  else ctx={inst,world:inst.world,actor:inst.actor,vars:inst.vars,event:payload,other,dt:payload&&payload.dt||0,budget:{n:0},stop:{v:false},depth:inst.depth};
  inst.depth++;try{execList(list,ctx,0);}finally{inst.depth--;}return true;
}
const T_SELF={type:'target',default:'self'};
const N=(op,category,help,fields,exec)=>registerNode(op,{category,help,fields,exec});
N('Print','Utility','Print text to the output log; {var} and {global.var} are replaced.',{text:{type:'text',default:'Hello'},value:{type:'expr',optional:true}},(c,n)=>{let s=interpolate(c,n.text);if(n.value!==undefined){const v=evalExpr(n.value,c);s+=(s?' ':'')+(typeof v==='number'?Math.round(v*1000)/1000:Array.isArray(v)?'['+v.join(', ')+']':String(v));}c.world.print(s,c.actor);});
N('SetVisible','Actor','Show or hide target actors.',{target:T_SELF,value:{type:'bool',default:true}},(c,n)=>{const v=!!val(c,n.value);for(const a of resolveTargets(c,n.target))a.object.visible=v;});
N('Move','Transform','Move to an absolute position (to) or by an offset (by) over duration seconds.',{target:T_SELF,to:{type:'vec3',optional:true},by:{type:'vec3',optional:true,default:[0,1,0]},duration:{type:'number',default:1,min:0,max:3600},ease:{type:'ease',default:'easeInOut'},then:{type:'actions',optional:true}},
  (c,n)=>{const d=numVal(c,n.duration,0,3600),targets=resolveTargets(c,n.target);targets.forEach((a,idx)=>{const p=a.object.position,to=n.to?n.to.slice():[p.x+(n.by?n.by[0]:0),p.y+(n.by?n.by[1]:0),p.z+(n.by?n.by[2]:0)];
    c.world.tween(a,'position',to,{duration:d,ease:n.ease,onComplete:idx===0&&n.then&&n.then.length?()=>execList(n.then,subCtx(c)):null});});});
N('Rotate','Transform','Rotate by euler degrees over duration seconds.',{target:T_SELF,by:{type:'vec3',default:[0,90,0]},duration:{type:'number',default:1,min:0,max:3600},ease:{type:'ease',default:'easeInOut'},then:{type:'actions',optional:true}},
  (c,n)=>{const d=numVal(c,n.duration,0,3600);resolveTargets(c,n.target).forEach((a,idx)=>{const r=a.object.rotation;c.world.tween(a,'rotation',[r.x+n.by[0]*DEG,r.y+n.by[1]*DEG,r.z+n.by[2]*DEG],{duration:d,ease:n.ease,onComplete:idx===0&&n.then&&n.then.length?()=>execList(n.then,subCtx(c)):null});});});
N('Scale','Transform','Scale to the given size over duration seconds.',{target:T_SELF,to:{type:'vec3',default:[1,1,1]},duration:{type:'number',default:.5,min:0,max:3600},ease:{type:'ease',default:'easeOut'}},
  (c,n)=>{const d=numVal(c,n.duration,0,3600);for(const a of resolveTargets(c,n.target))c.world.tween(a,'scale',n.to,{duration:d,ease:n.ease});});
N('PlaySound','Audio','Play a synthesized sound (KE.Synth) through the world audio engine.',{synth:{type:'synth',default:'chime'},params:{type:'json',default:{}},at:{type:'location',default:'self'},volume:{type:'number',default:1,min:0,max:4}},
  (c,n)=>{const p=resolveLocation(c,n.at,new c.world.THREE.Vector3());playSound(c.world,n.synth,n.params,{position:p,volume:numVal(c,n.volume,0,4)});});
N('SpawnEmitter','Effects','Spawn a one-shot particle effect at a location.',{preset:{type:'preset',default:'sparks'},at:{type:'location',default:'self'},duration:{type:'number',default:1,min:0,max:60},burst:{type:'number',default:0,min:0,max:5000},overrides:{type:'json',default:{}}},
  (c,n)=>spawnEmitter(c,n));
N('ApplyImpulse','Physics','Apply an impulse to target rigid bodies (needs a physics world).',{target:T_SELF,vector:{type:'vec3',default:[0,5,0]}},
  (c,n)=>{const v=new c.world.THREE.Vector3().fromArray(n.vector);for(const a of resolveTargets(c,n.target)){const rb=a.getComponent('RigidBody');if(!rb||!rb.instance||!KE.Components.get('RigidBody').applyImpulse(rb.instance,v))c.world.warnOnce('impulse:'+a.id,a.name+': ApplyImpulse ignored (no active physics body)');}});
N('Destroy','Actor','Destroy target actors.',{target:T_SELF},(c,n)=>{for(const a of resolveTargets(c,n.target))c.world.destroy(a);});
N('SetVar','Variables','Set a local (or global) variable from a literal value or an expression.',{name:{type:'var',default:'value'},value:{type:'json',optional:true},expr:{type:'expr',optional:true},scope:{type:'enum',options:['local','global'],default:'local'}},
  (c,n)=>{let v=n.expr!==undefined?evalExpr(n.expr,c):n.value!==undefined?clone(n.value):null;if(typeof v==='number'&&!Number.isFinite(v))v=0;(n.scope==='global'?c.world.vars:c.vars)[n.name]=v;});
N('Branch','Flow','Run then or else depending on a condition expression.',{if:{type:'expr',default:true},then:{type:'actions',default:[]},else:{type:'actions',default:[]}},
  (c,n)=>{const r=evalExpr(n.if,c);const list=r?n.then:n.else;if(list&&list.length){execList(list,c,0);}});
N('Delay','Flow','Wait, then run the then list (or, without then, the rest of this list).',{seconds:{type:'number',default:1,min:0,max:86400},then:{type:'actions',optional:true}},
  (c,n,list,i)=>{const s=numVal(c,n.seconds,0,86400);if(n.then){if(n.then.length)later(c,s,()=>execList(n.then,subCtx(c)));return;}const rest=i+1;if(rest<list.length)later(c,s,()=>execList(list,subCtx(c),rest));return DEFER;});
N('ForLoop','Flow','Run do count times with the loop index in a local variable (max 1000).',{count:{type:'number',default:3,min:0,max:1000},index:{type:'var',default:'i'},do:{type:'actions',default:[]}},
  (c,n)=>{const k=Math.floor(numVal(c,n.count,0,1000));for(let j=0;j<k&&!c.stop.v;j++){c.vars[n.index]=j;execList(n.do,c,0);}});
N('Return','Flow','Stop running the current event.',{},(c)=>{c.stop.v=true;});
N('Emit','Events','Send a custom event to target actors (all = broadcast).',{event:{type:'event',default:'MyEvent'},target:T_SELF},
  (c,n)=>{for(const a of resolveTargets(c,n.target))c.world.dispatch(a,n.event,{other:c.actor,sender:c.actor});});
N('SetTimer','Events','Emit a custom event after seconds, optionally repeating.',{seconds:{type:'number',default:1,min:.001,max:86400},loop:{type:'bool',default:true},event:{type:'event',default:'MyEvent'},target:T_SELF},
  (c,n)=>{const s=numVal(c,n.seconds,.001,86400),inst=c.inst,prev=inst.timers.get(n.event);if(prev)prev.clear();const tgt=n.target,self=c.actor;
    const h=c.world.setTimer(()=>{for(const a of resolveTargets({...c,actor:self},tgt))c.world.dispatch(a,n.event,{other:self,sender:self});},s,{loop:!!val(c,n.loop),owner:self});inst.timers.set(n.event,h);});
N('ClearTimer','Events','Stop a timer started by SetTimer for the given event.',{event:{type:'event',default:'MyEvent'}},(c,n)=>{const h=c.inst.timers.get(n.event);if(h){h.clear();c.inst.timers.delete(n.event);}});
N('SpawnActor','Actor','Spawn a prefab (or actor class) at a location.',{prefab:{type:'prefab',default:'Crate'},at:{type:'location',default:'self'},offset:{type:'vec3',default:[0,0,0]},name:{type:'string',optional:true}},
  (c,n)=>{const p=resolveLocation(c,n.at,new c.world.THREE.Vector3());if(!p)return;p.x+=n.offset[0];p.y+=n.offset[1];p.z+=n.offset[2];const def={transform:{position:p.toArray()}};
    if(n.name)def.name=n.name;if(KE.Prefabs.info(n.prefab))def.prefab=n.prefab;else if(KE.ActorClasses.get(n.prefab))def.class=n.prefab;else{c.world.warn('SpawnActor: unknown prefab or class "'+n.prefab+'"');return;}c.world.spawn(def);});
N('SetLight','Rendering','Change intensity and/or color of target lights.',{target:T_SELF,intensity:{type:'number',optional:true,min:0,max:1000},color:{type:'color',optional:true}},
  (c,n)=>{for(const a of resolveTargets(c,n.target))for(const comp of a.components){if(!/Light$/.test(comp.type))continue;if(n.intensity!==undefined)comp.set('intensity',numVal(c,n.intensity,0,1000));if(n.color!==undefined&&comp.def.schema.color)comp.set('color',n.color);}});
N('SetText','Rendering','Change the text of target TextLabel components.',{target:T_SELF,text:{type:'text',default:'Text'}},(c,n)=>{for(const a of resolveTargets(c,n.target)){const t=a.getComponent('TextLabel');if(t)t.set('text',interpolate(c,n.text));}});
N('AddTag','Actor','Add a tag to target actors.',{target:T_SELF,tag:{type:'string',default:'tag',maxLength:LIMITS.tag}},(c,n)=>{for(const a of resolveTargets(c,n.target))a.tags.add(n.tag);});
N('RemoveTag','Actor','Remove a tag from target actors.',{target:T_SELF,tag:{type:'string',default:'tag',maxLength:LIMITS.tag}},(c,n)=>{for(const a of resolveTargets(c,n.target))a.tags.delete(n.tag);});
N('CallGame','Game','Call a function the game registered with world.expose(name, fn).',{name:{type:'string',default:'myFunction',maxLength:64},args:{type:'exprs',default:[]},store:{type:'var',optional:true}},
  (c,n)=>{const fn=c.world._exposed.get(n.name);if(!fn){c.world.warnOnce('call:'+n.name,'CallGame: "'+n.name+'" is not exposed by the game');return;}const args=(n.args||[]).map(e=>evalExpr(e,c));
    const r=fn(...args,{actor:c.actor,world:c.world,other:c.other});if(n.store){const s=sanitizeJSON(r,()=>{},'result');c.vars[n.store]=s===undefined?null:s;}});
function spawnEmitter(c,n){const w=c.world,p=resolveLocation(c,n.at,new w.THREE.Vector3());if(!p)return;const d=numVal(c,n.duration,0,60),burst=Math.floor(numVal(c,n.burst,0,5000));
  if(w.vfx&&typeof w.vfx.emitter==='function'){try{const cfg=vfxConfig(w.vfx,n.preset,n.overrides,1);if(!cfg){w.warn('SpawnEmitter: unknown VFX preset "'+n.preset+'"');return;}const em=w.vfx.emitter(cfg);if(em.setPosition)em.setPosition(p);
    if(burst>0&&em.burst)em.burst(burst);else if(em.play)em.play();w.setTimer(()=>{try{em.stop&&em.stop();}catch(e){}w.setTimer(()=>{try{em.dispose&&em.dispose();}catch(e){}},3);},d);return;}catch(e){w.warn('SpawnEmitter failed: '+e.message);return;}}
  if(!KE.Particles)return;w.warnOnce('novfx','ParticleEmitter: no KE.VFX system in the world; using simple fallback particles');
  const f=FALLBACK_FX[n.preset]||FALLBACK_FX.sparks,ps=new KE.Particles(w.THREE,w.scene,{capacity:Math.max(16,burst||48),size:.14,color:f[0],gravity:f[2],seed:w.frame+1});ps.burst(p.x,p.y,p.z,burst||48);
  const fx={actor:c.actor,t:0};const h=w.setTimer(()=>{ps.update(w.options.fixedStep);fx.t+=w.options.fixedStep;if(fx.t>d+1.4){h.clear();ps.dispose();}},w.options.fixedStep,{loop:true});
  const off=w.events.on('endPlay',()=>{off();if(h.active){h.clear();ps.dispose();}});}

reg('Blueprint',{label:'Blueprint',category:'Scripting',icon:'script',help:'Data-driven event graph (BeginPlay, Tick, Overlap, EndOverlap, EndPlay, Custom events).',
  schema:{graph:{type:'json',default:{events:{BeginPlay:[]},variables:{}},label:'Graph'}},
  normalize(props,warn){props.graph=validateGraph(props.graph,warn);return props;},
  create(actor,props,world){return {actor,world,graph:props.graph,vars:clone(props.graph.variables),timers:new Map(),depth:0};},
  beginPlay(inst){inst.vars=clone(inst.graph.variables);runEvent(inst,'BeginPlay',{});},
  tick(inst,dt){const t=inst.graph.events.Tick;if(t&&t.length){const p=inst._tickPayload||(inst._tickPayload={dt:0});p.dt=dt;runEvent(inst,'Tick',p);}},
  endPlay(inst){runEvent(inst,'EndPlay',{});for(const h of inst.timers.values())h.clear();inst.timers.clear();},
  onEvent(inst,name,payload){return runEvent(inst,name,payload);},
  dispose(inst){for(const h of inst.timers.values())h.clear();inst.timers.clear();}});

KE.Blueprint={
  nodeTypes,events:BP_EVENTS.slice(),registerNode,
  validate(graph){const warnings=[];const g=validateGraph(graph,m=>warnings.push(m));return {graph:g,warnings};},
  parseExpr,formatExpr,
  normalizeExpr:e=>typeof e==='string'?parseExpr(e):normExpr(e),
  /* Evaluate an expression outside a graph, e.g. for tests or tools. */
  evaluate(expr,{world,actor=null,vars={},event={},dt=0}={}){if(!world)throw new TypeError('evaluate needs a world');return evalExpr(typeof expr==='string'?parseExpr(expr):normExpr(expr),{world,actor,vars,event,other:event.other||null,dt,inst:null});},
  run(actor,event,payload){return actor.world.dispatch(actor,event,payload);},
  eases:Object.keys(EASES)
};

/* ---------- actor classes and a few starter prefabs ---------- */
const C=(name,components,o={})=>KE.ActorClasses.register(name,{components,...o});
C('Empty',[],{category:'Basic',icon:'empty',help:'Transform-only actor'});
C('StaticMeshActor',[{type:'StaticMesh'}],{category:'Basic',icon:'mesh',label:'Static Mesh'});
C('PhysicsProp',[{type:'StaticMesh',mesh:{primitive:'box',material:{color:'#b07a45',roughness:.8}}},{type:'RigidBody'}],{category:'Basic',icon:'physics',label:'Physics Prop'});
C('PointLight',[{type:'PointLight'}],{category:'Lights',icon:'light',label:'Point Light'});
C('SpotLight',[{type:'SpotLight'}],{category:'Lights',icon:'spot',label:'Spot Light'});
C('DirectionalLight',[{type:'DirectionalLight'}],{category:'Lights',icon:'sun',label:'Directional Light'});
C('SkyLight',[{type:'SkyLight'}],{category:'Lights',icon:'sky',label:'Sky Light'});
C('TriggerVolume',[{type:'TriggerVolume'}],{category:'Volumes',icon:'trigger',label:'Trigger Volume'});
C('ParticleEmitter',[{type:'ParticleEmitter'}],{category:'Effects',icon:'fx',label:'Particle Emitter'});
C('AudioSource',[{type:'AudioSource'}],{category:'Audio',icon:'audio',label:'Audio Source'});
C('PlayerStart',[{type:'PlayerStart'}],{category:'Basic',icon:'player',label:'Player Start'});
C('TextRender',[{type:'TextLabel'}],{category:'Basic',icon:'text',label:'Text Render'});
C('BlueprintActor',[{type:'Blueprint'}],{category:'Basic',icon:'script',label:'Blueprint Actor'});
for(const [prim,label] of [['box','Cube'],['sphere','Sphere'],['cylinder','Cylinder'],['cone','Cone'],['torus','Torus'],['plane','Plane'],['capsule','Capsule'],['rock','Rock']])
  KE.Prefabs.register(label,{class:'StaticMeshActor',name:label,components:[{type:'StaticMesh',mesh:{primitive:prim,params:prim==='plane'?{width:4,depth:4}:{}}}]},{category:'Shapes',icon:'shape:'+prim});
KE.Prefabs.register('Crate',{class:'PhysicsProp',name:'Crate',components:[{type:'StaticMesh',mesh:{primitive:'box',params:{bevel:.04},material:{color:'#a8763e',roughness:.85}}},{type:'RigidBody',mass:4}]},{icon:'physics'});
KE.Prefabs.register('Coin',{class:'StaticMeshActor',name:'Coin',tags:['pickup'],components:[{type:'StaticMesh',mesh:{primitive:'torus',params:{radius:.32,tube:.09,segments:32},material:{color:'#f2c14e',metalness:1,roughness:.25,emissive:'#6b4a00',emissiveIntensity:.6}},castShadow:true},
  {type:'Rotator',speed:[0,120,0]},{type:'TriggerVolume',shape:'sphere',radius:.7,filterTag:'player'},
  {type:'Blueprint',graph:{events:{Overlap:[{op:'SetVar',name:'coins',scope:'global',expr:'global.coins + 1'},{op:'PlaySound',synth:'chime',params:{note:'E6'}},{op:'SpawnEmitter',preset:'sparks',burst:24},{op:'Print',text:'Coins: {global.coins}'},{op:'Destroy',target:'self'}]},variables:{}}}]},{icon:'coin'});
KE.Prefabs.register('Lamp',{class:'StaticMeshActor',name:'Lamp',components:[{type:'StaticMesh',mesh:{primitive:'cylinder',params:{radius:.07,radiusTop:.05,height:2.4,segments:12},material:{color:'#2b2d31',metalness:.6,roughness:.4}},offset:[0,1.2,0]},
  {type:'PointLight',intensity:2,color:'#ffcf8a',range:9,offset:[0,2.55,0]}]},{icon:'light'});
KE.Prefabs.register('Boulder',{class:'StaticMeshActor',name:'Boulder',components:[{type:'StaticMesh',mesh:{primitive:'rock',params:{radius:.9,detail:3,seed:7,roughness:.4},material:{color:'#7d7a74',roughness:.95,flatShading:true}}}]},{icon:'shape:rock'});

/* ---------- levels ---------- */
KE.LevelError=class extends Error{constructor(message,errors=[]){super(message);this.name='LevelError';this.errors=errors;}};
function bufferToBase64(buf){const b=new Uint8Array(buf);let s='';for(let i=0;i<b.length;i+=0x8000)s+=String.fromCharCode.apply(null,b.subarray(i,i+0x8000));return btoa(s);}
function base64ToBuffer(str){const s=atob(str),b=new Uint8Array(s.length);for(let i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return b.buffer;}
KE.Level={
  FORMAT:'kitsune-level',VERSION:1,
  /* Snapshot of all actors (in world order), globals and optionally embedded glTF asset buffers. */
  serialize(world,{name,embedAssets=false}={}){
    const out={format:this.FORMAT,version:this.VERSION,engine:(KE.name||'kitsune')+' '+(KE.version||''),name:String(name||world.name||'Untitled').slice(0,LIMITS.name),
      globals:clone(world.globalDefaults)||{},actors:world.actors.filter(a=>a.alive&&!a.pendingKill&&!a.transient).map(a=>a.serialize())};
    if(embedAssets){const assets={};for(const id of world.assets()){const a=world.getAsset(id);if(a.buffer)assets[id]={type:'gltf',data:bufferToBase64(a.buffer)};}if(Object.keys(assets).length)out.assets=assets;}
    return out;},
  stringify(world,opts={}){return JSON.stringify(this.serialize(world,opts),null,opts.pretty?2:0);},
  /* Strict validation: returns {ok, errors, warnings, level}. Never throws for bad input. */
  validate(json){
    const errors=[],warnings=[],warn=m=>warnings.push(m);let data=json;
    if(typeof data==='string'){if(data.length>LIMITS.levelChars)return {ok:false,errors:['Level text is too large'],warnings};try{data=JSON.parse(data);}catch(e){return {ok:false,errors:['Invalid JSON: '+e.message],warnings};}}
    if(!isObj(data))return {ok:false,errors:['Level must be a JSON object'],warnings};
    if(data.format!==this.FORMAT)errors.push('Not a kitsune level (format must be "'+this.FORMAT+'")');
    if(!Number.isInteger(data.version)||data.version<1)errors.push('Level version must be a positive integer');else if(data.version>this.VERSION)errors.push('Level version '+data.version+' is newer than supported version '+this.VERSION);
    if(!Array.isArray(data.actors))errors.push('actors must be an array');else if(data.actors.length>LIMITS.actors)errors.push('Too many actors ('+data.actors.length+' > '+LIMITS.actors+')');
    if(data.name!==undefined&&(typeof data.name!=='string'||data.name.length>LIMITS.name))errors.push('name must be a string of at most '+LIMITS.name+' characters');
    let globals={};if(data.globals!==undefined){if(!isObj(data.globals))errors.push('globals must be an object');else globals=sanitizeJSON(data.globals,warn,'globals')||{};}
    const assets={};if(data.assets!==undefined){if(!isObj(data.assets))errors.push('assets must be an object');else for(const [id,a] of Object.entries(data.assets)){
      if(!/^[\w.\- ]{1,128}$/.test(id)||!isObj(a)||a.type!=='gltf'||typeof a.data!=='string'||a.data.length>LIMITS.assetChars||!/^[A-Za-z0-9+/=]*$/.test(a.data.slice(0,4096))){errors.push('Invalid embedded asset "'+id.slice(0,32)+'"');continue;}assets[id]=a.data;}}
    if(errors.length)return {ok:false,errors,warnings};
    const actors=[],ids=new Set();
    data.actors.forEach((src,i)=>{const where='actors['+i+']'+(isObj(src)&&typeof src.name==='string'?' "'+src.name.slice(0,32)+'"':'');
      const {def,errors:e}=normalizeActorDef(src,{warn,strict:true,where});errors.push(...e);if(!def||e.length)return;
      if(def.id!==undefined){if(ids.has(def.id))errors.push(where+': duplicate id '+def.id);ids.add(def.id);}
      if(def.class&&!KE.ActorClasses.get(def.class))warn(where+': unknown class "'+def.class+'" (loaded as Empty)');
      def.components=def.components.map(c=>{try{return {type:KE.Components.get(c.type).type,props:KE.Components.sanitize(c.type,c,m=>warn(where+': '+m))};}catch(err){warn(where+': '+err.message);return null;}}).filter(Boolean);
      actors.push(def);});
    const byId=new Map(actors.filter(a=>a.id!==undefined).map(a=>[a.id,a]));
    for(const a of actors){if(a.parent===undefined)continue;if(typeof a.parent!=='number'||!byId.has(a.parent)){warn('Actor "'+(a.name||'?')+'": parent '+a.parent+' not found, attached to the scene');delete a.parent;continue;}
      const seen=new Set([a]);for(let p=byId.get(a.parent);p;p=p.parent!==undefined?byId.get(p.parent):null){if(seen.has(p)){errors.push('Parent cycle involving "'+(a.name||a.id)+'"');break;}seen.add(p);}}
    if(errors.length)return {ok:false,errors,warnings};
    return {ok:true,errors,warnings,level:{name:data.name||'Untitled',globals,actors,assets}};
  },
  /* Validates fully before touching the world; throws KE.LevelError on malformed input. Returns the spawned actors. */
  load(world,json,{clear=true}={}){
    if(world._ticking)throw new Error('Cannot load a level during world.tick');
    const v=this.validate(json);if(!v.ok)throw new KE.LevelError('Invalid level: '+v.errors.slice(0,5).join('; ')+(v.errors.length>5?' (+'+(v.errors.length-5)+' more)':''),v.errors);
    for(const w of v.warnings)world.warn(w);
    const L=v.level;if(clear){world.clear();world.globalDefaults=L.globals;world.name=L.name;}else Object.assign(world.globalDefaults,L.globals);
    this._decodeAssets(world,L.assets);
    const spawned=[],idMap=new Map();
    for(const a of L.actors){const def={id:a.id,name:a.name,class:a.class,transform:a.transform,tags:a.tags,visible:a.visible,prefab:a.prefab,components:a.components.map(c=>({type:c.type,...c.props}))};
      const actor=world.spawn(def,{fromLevel:true});if(a.id!==undefined)idMap.set(a.id,actor);spawned.push([actor,a]);}
    for(const [actor,a] of spawned)if(a.parent!==undefined){const p=idMap.get(a.parent);if(p){p.object.add(actor.object);actor.parent=p;p.children.push(actor);}}
    world.events.emit('levelLoaded',world,spawned.map(s=>s[0]));
    return spawned.map(s=>s[0]);
  },
  /* Like load(), but first decodes embedded glTF assets so meshes are present immediately. */
  async loadAsync(world,json,opts={}){const v=this.validate(json);if(!v.ok)throw new KE.LevelError('Invalid level: '+v.errors.slice(0,5).join('; '),v.errors);
    await Promise.all(Object.entries(v.level.assets).filter(([id])=>!world.getAsset(id)).map(([id,data])=>KE.Level.decodeGLTF(world,id,base64ToBuffer(data)).catch(e=>world.warn('Asset '+id+': '+e.message))));
    return this.load(world,json,opts);},
  _decodeAssets(world,assets){for(const [id,data] of Object.entries(assets||{}))if(!world.getAsset(id))this.decodeGLTF(world,id,base64ToBuffer(data)).catch(e=>world.warn('Asset '+id+': '+e.message));},
  /* Parses a .glb/.gltf ArrayBuffer offline (no external URIs) and registers it as a world asset. */
  decodeGLTF(world,id,buffer){const T=world.THREE;return new Promise((resolve,reject)=>{
    if(!T.GLTFLoader)return reject(new Error('THREE.GLTFLoader is not available'));
    const ext=externalURIs(buffer);if(ext)return reject(new Error('glTF references external files ('+ext+'); embed resources or use .glb'));
    try{new T.GLTFLoader().parse(buffer,'',g=>{const obj=g.scene||(g.scenes&&g.scenes[0]);if(!obj)return reject(new Error('glTF has no scene'));world.registerAsset(id,{type:'gltf',object:obj,animations:g.animations||[],buffer});resolve(world.getAsset(id));},e=>reject(e instanceof Error?e:new Error(String(e&&e.message||e))));}catch(e){reject(e);}});}
};
/* Finds non-data URIs in a glTF JSON (or GLB JSON chunk) so offline loads never hit the network. */
function externalURIs(buffer){try{const u8=new Uint8Array(buffer);let json;
  if(u8.length>=20&&u8[0]===0x67&&u8[1]===0x6c&&u8[2]===0x54&&u8[3]===0x46){const dv=new DataView(buffer),len=dv.getUint32(12,true);json=new TextDecoder().decode(u8.subarray(20,20+len));}else json=new TextDecoder().decode(u8);
  const d=JSON.parse(json),bad=[...(d.buffers||[]),...(d.images||[])].map(x=>x&&x.uri).filter(u=>typeof u==='string'&&!/^data:/i.test(u));return bad.length?bad.slice(0,3).join(', '):null;}catch(e){return null;}}
KE.Level._base64=bufferToBase64;KE.Level._fromBase64=base64ToBuffer;

KE.registerModule('gameplay',{provides:['GameWorld','Components','ActorClasses','Prefabs','Level','LevelError','Blueprint','Ease','buildPrimitive']});
})();
