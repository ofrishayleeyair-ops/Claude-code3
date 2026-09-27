/* KE.LightPool — many dynamic point lights on a forward renderer.
   Games register any number of virtual lights (lanterns, torches, spells); each frame the pool scores them
   by visibility-weighted proximity to the camera and drives a fixed set of real PointLights. Keeping the
   real light count constant avoids shader recompiles; assignments are sticky and intensities crossfade, so
   lights do not pop as the ranking changes. Optional per-light flicker. The pool size follows
   KE.settings.lights (0 disables every real light). */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
KE.LightPool=class{
  constructor(THREE,scene,{max=KE.settings.lights??4,fade=6,shadows=0,shadowMapSize=256}={}){
    Object.assign(this,{THREE,scene,fade,shadows,shadowMapSize});this.virtual=new Map();this.real=[];this.nextId=1;this.intensity=1;this.time=0;
    this._frustum=new THREE.Frustum();this._pv=new THREE.Matrix4();this._sphere=new THREE.Sphere();this.resize(max);
    this.onSettings=KE.events.on('settings',s=>{if(s.lights!==this.real.length)this.resize(s.lights);});}
  resize(n){const T=this.THREE;n=Math.max(0,Math.min(16,Math.round(n||0)));
    while(this.real.length>n){const r=this.real.pop();r.light.parent&&r.light.parent.remove(r.light);if(r.light.shadow&&r.light.shadow.map)r.light.shadow.map.dispose();if(r.id!==null){const v=this.virtual.get(r.id);if(v)v.slot=null;}}
    while(this.real.length<n){const l=new T.PointLight(0xffffff,0,10,2);l.name='ke-pool-'+this.real.length;const i=this.real.length;if(i<this.shadows){l.castShadow=true;l.shadow.mapSize.set(this.shadowMapSize,this.shadowMapSize);l.shadow.bias=-.002;}this.scene.add(l);this.real.push({light:l,id:null,level:0});}
    return this;}
  /* Real lights stay visible (intensity 0 when idle): hiding them would change NUM_POINT_LIGHTS and recompile every lit material.
     {position:[x,y,z]|Vector3, color, intensity:2, distance:10, decay:2, flicker:0, priority:1, enabled:true} → id */
  add(o={}){const T=this.THREE,id=this.nextId++;const p=o.position&&o.position.isVector3?o.position.clone():new T.Vector3(...(o.position||[0,0,0]));
    this.virtual.set(id,{id,position:p,color:new T.Color(o.color===undefined?0xffc27a:o.color),intensity:o.intensity??2,distance:o.distance??10,decay:o.decay??2,flicker:o.flicker||0,priority:o.priority??1,enabled:o.enabled!==false,phase:Math.random()*100,slot:null,score:0});return id;}
  set(id,patch){const v=this.virtual.get(id);if(!v)return false;for(const [k,val] of Object.entries(patch)){if(k==='position')v.position.copy(val.isVector3?val:new this.THREE.Vector3(...val));else if(k==='color')v.color.set(val);else v[k]=val;}return true;}
  remove(id){const v=this.virtual.get(id);if(!v)return false;if(v.slot!==null)this.real[v.slot].id=null;this.virtual.delete(id);return true;}
  get count(){return this.virtual.size;}
  update(dt,camera){this.time+=dt;if(!this.real.length)return;const cam=camera.position;camera.updateMatrixWorld();this._pv.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);this._frustum.setFromProjectionMatrix(this._pv);
    const list=this._list||(this._list=[]);list.length=0;
    for(const v of this.virtual.values()){if(!v.enabled||v.intensity<=0){v.score=0;continue;}this._sphere.set(v.position,v.distance);const inView=this._frustum.intersectsSphere(this._sphere);const d=v.position.distanceTo(cam);
      v.score=v.priority*v.intensity*(inView?1:.25)/(1+Math.max(0,d-v.distance*.25)**2*.02)*(v.slot!==null?1.25:1);if(d>v.distance*6)v.score*=.1;list.push(v);}
    list.sort((a,b)=>b.score-a.score);const keep=new Set(list.slice(0,this.real.length).filter(v=>v.score>1e-4).map(v=>v.id));
    for(const r of this.real)if(r.id!==null&&!keep.has(r.id)){r.target=0;}
    for(const id of keep){const v=this.virtual.get(id);if(v.slot!==null)continue;const free=this.real.findIndex(r=>r.id===null||(!keep.has(r.id)&&r.level<.02));if(free<0)continue;const r=this.real[free];if(r.id!==null){const old=this.virtual.get(r.id);if(old)old.slot=null;}r.id=id;r.level=0;v.slot=free;}
    const k=1-Math.exp(-this.fade*dt);
    for(const r of this.real){const v=r.id!==null?this.virtual.get(r.id):null;const want=v&&keep.has(v.id)?1:0;r.level+=(want-r.level)*k;
      if(!v){r.light.intensity=0;continue;}if(r.level<.01&&!want){v.slot=null;r.id=null;r.light.intensity=0;continue;}
      const fl=v.flicker?1-v.flicker*(.5+.5*Math.sin(this.time*13+v.phase)*Math.sin(this.time*7.3+v.phase*1.7)):1;
      r.light.position.copy(v.position);r.light.color.copy(v.color);r.light.distance=v.distance;r.light.decay=v.decay;r.light.intensity=v.intensity*fl*r.level*this.intensity;}}
  dispose(){this.onSettings&&this.onSettings();this.resize(0);this.virtual.clear();}
};
KE.registerModule('lights',{provides:['LightPool']});
})();
