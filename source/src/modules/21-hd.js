/* KE.HD — the optional HD asset pack: photoscanned CC0 textures and models (Poly Haven) in a folder next to
   the page (default 'hd/', built by scripts/hd_pack.py). Browsers do not let a page opened from disk hand local
   image files to WebGL, so every file in the pack is a script that calls KitsuneHD.put(key, part, parts, mime,
   base64); loading one is adding a <script>. Without the folder everything here resolves to null and games keep
   their painted textures.
   - ready(base) → manifest or null; has(id); info(id)
   - blob(id, file) → Blob; bitmap(id, file, {size, flipY}) → ImageBitmap (decoded off the main thread)
   - texture(THREE, id, map, {size, srgb, repeat}) and material(THREE, id, {size, repeat, ...}) → MeshStandardMaterial
     with map, normalMap and the ARM map as roughnessMap + metalnessMap (G, B; aoMaterial adds R as aoMap)
   - layers(renderer, THREE, ids, map, size) → a TEXTURE_2D_ARRAY (one layer per id) uploaded straight from the
     decoded images, wrapped as a DataTexture2DArray that Three binds without re-uploading
   - gltf(THREE, id) → {scene, parts: [{geometry, material, name}], dispose}; prepare(THREE, id, opts) → instancing-ready pieces
   - hdri(renderer, THREE, id) → {texture, envMap} for sky HDRIs (RGBELoader, PMREM)
   - stats {files, bytes, textures, gpuBytes, ms}; dispose() frees what this module created. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');

const pending=new Map(),scripts=new Map();let manifestWait=null;
const hub=window.KitsuneHD=window.KitsuneHD||{};
hub.put=(key,part,parts,mime,b64)=>{const p=pending.get(key);if(!p)return;p.chunks[part]=b64;p.mime=mime;p.parts=parts;p.got++;if(p.got===parts)p.done();};
hub.manifest=m=>{if(manifestWait)manifestWait(m);};

const loadScript=src=>new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=src;s.async=true;
  s.onload=()=>{s.remove();resolve();};s.onerror=()=>{s.remove();reject(new Error('KE.HD: could not load '+src));};document.head.appendChild(s);});
/* base64 → bytes: fetch('data:') decodes natively; atob is the fallback */
const decode=async(b64,mime)=>{try{return await (await fetch('data:'+mime+';base64,'+b64)).arrayBuffer();}catch(e){const s=atob(b64),u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i);return u.buffer;}};

/* at most `limit` files in flight, so a 1 GB pack never sits in memory as strings all at once */
const queue=[];let active=0;const LIMIT=4;
const pump=()=>{while(active<LIMIT&&queue.length){const j=queue.shift();active++;j().finally(()=>{active--;pump();});}};
const limited=fn=>new Promise((resolve,reject)=>{queue.push(()=>fn().then(resolve,reject));pump();});

const tierOf=f=>{const m=/_(\d+)k\.\w+$/.exec(f);return m?+m[1]*1024:0;};
const pickTier=(files,size)=>{if(!files.length)return null;const s=files.slice().sort((a,b)=>tierOf(a)-tierOf(b));if(!size)return s[s.length-1];return s.find(f=>tierOf(f)>=size)||s[s.length-1];};
const HD={base:'hd/',manifest:null,enabled:true,stats:{files:0,bytes:0,textures:0,gpuBytes:0,ms:0},_ready:null,_owned:new Set(),_gl:new Set(),
  /* Load hd/manifest.js once; null when the folder is missing (or KE.HD.enabled is false). */
  ready(base){if(base&&base!==this.base){this.base=base.endsWith('/')?base:base+'/';this._ready=null;}
    if(!this.enabled)return Promise.resolve(null);if(this._ready)return this._ready;
    this._ready=new Promise(resolve=>{let done=false;const finish=m=>{if(done)return;done=true;manifestWait=null;this.manifest=m&&m.assets?m:null;resolve(this.manifest);};
      manifestWait=finish;loadScript(this.base+'manifest.js').then(()=>setTimeout(()=>finish(null),0),()=>finish(null));});
    return this._ready;},
  has(id){return !!(this.manifest&&this.manifest.assets[id]);},
  info(id){return this.manifest?this.manifest.assets[id]||null:null;},
  /* all ids of a kind ('texture'/'model') whose role contains `role` */
  find(kind,role){if(!this.manifest)return [];return Object.entries(this.manifest.assets).filter(([,e])=>(!kind||e.kind===kind)&&(!role||String(e.role).split(' ').includes(role))).map(([id])=>id);},
  /* The file of a texture map ('diff', 'nor', 'arm', 'disp') at a resolution tier: the smallest tier at least `size`
     pixels wide (1k = 1024 … 8k = 8192), or the largest there is; no size = the largest. The pack ships 1k/2k/4k tiers
     (8k with hd_pack.py --ultra), so a quality setting never decodes more than it shows. */
  mapFile(id,map,size=0){const e=this.info(id);if(!e)return null;return pickTier(Object.keys(e.files).filter(k=>k.startsWith(map+'_')&&/_\d+k\.\w+$/.test(k)),size);},
  /* largest tier present for a map (pixels) */
  maxTier(id,map){const f=this.mapFile(id,map);return f?tierOf(f):0;},
  blob(id,file){const e=this.info(id);if(!e||!e.files[file])return Promise.reject(new Error('KE.HD: no '+id+'/'+file));const key=id+'/'+file;
    if(scripts.has(key))return scripts.get(key);
    const f=e.files[file],t0=performance.now();
    const pr=limited(()=>new Promise((resolve,reject)=>{const rec={chunks:new Array(f.parts),got:0,parts:f.parts,mime:f.mime,done:null};
        rec.done=()=>{pending.delete(key);Promise.all(rec.chunks.map(c=>decode(c,rec.mime))).then(bufs=>{rec.chunks=null;const b=new Blob(bufs,{type:rec.mime});this.stats.files++;this.stats.bytes+=b.size;this.stats.ms+=performance.now()-t0;resolve(b);},reject);};
        pending.set(key,rec);
        const names=f.parts>1?Array.from({length:f.parts},(_,p)=>f.script+'.'+p+'.js'):[f.script+'.js'];
        Promise.all(names.map(n=>loadScript(this.base+id+'/'+n))).catch(err=>{pending.delete(key);reject(err);});}));
    scripts.set(key,pr);pr.then(()=>scripts.delete(key),()=>scripts.delete(key));return pr;},
  /* decoded image; size resamples (square), flipY flips rows for Three's usual UV convention */
  async bitmap(id,file,{size=0,flipY=false}={}){const b=await this.blob(id,file),o={imageOrientation:flipY?'flipY':'none',premultiplyAlpha:'none',colorSpaceConversion:'none'};
    if(size)Object.assign(o,{resizeWidth:size,resizeHeight:size,resizeQuality:'high'});
    try{return await createImageBitmap(b,o);}catch(e){return await createImageBitmap(b);}},
  async texture(THREE,id,map,{size=0,srgb=false,repeat=1,anisotropy=null}={}){const file=this.mapFile(id,map,size);if(!file)return null;
    const bmp=await this.bitmap(id,file,{size,flipY:true}),t=new THREE.Texture(bmp);t.flipY=false;t.wrapS=t.wrapT=THREE.RepeatWrapping;t.repeat.set(repeat,repeat);
    t.anisotropy=anisotropy||KE.settings.aniso||4;if(srgb)t.encoding=THREE.sRGBEncoding;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;t.needsUpdate=true;t.name='hd:'+id+':'+map;
    const onDispose=()=>{if(bmp.close)bmp.close();t.removeEventListener('dispose',onDispose);};t.addEventListener('dispose',onDispose);
    this._owned.add(t);this.stats.textures++;this.stats.gpuBytes+=bmp.width*bmp.height*4*4/3;return t;},
  /* MeshStandardMaterial from a texture set; repeat is in tiles per UV unit (or per metre with {metres}) */
  async material(THREE,id,{size=0,repeat=1,color=null,roughness=1,normalScale=1,side=null,name=null}={}){if(!this.has(id))return null;
    const [map,nor,arm]=await Promise.all([this.texture(THREE,id,'diff',{size,srgb:true,repeat}),this.texture(THREE,id,'nor',{size,repeat}),this.texture(THREE,id,'arm',{size:size?Math.max(256,size/2):0,repeat})]);
    /* ARM: roughness (G) and metalness (B); AO (R) needs a second UV set in Three r128, so it is only attached by aoMaterial() */
    const m=new THREE.MeshStandardMaterial({map,normalMap:nor,roughnessMap:arm,metalnessMap:arm,roughness,metalness:1});
    if(nor)m.normalScale.set(normalScale,normalScale);/* OpenGL normal maps, rows flipped at decode = Three's flipY convention */
    if(color)m.color.set(color);if(side!=null)m.side=side;m.name=name||'hd:'+id;m.userData.hd=id;this._owned.add(m);return m;},
  /* Use the ARM map's red channel as ambient occlusion on geometries that get a uv2 copy of their uv. */
  aoMaterial(m,geometries=[]){if(!m||!m.roughnessMap)return m;for(const g of geometries)if(g.attributes.uv&&!g.attributes.uv2)g.setAttribute('uv2',g.attributes.uv);m.aoMap=m.roughnessMap;m.needsUpdate=true;return m;},
  /* One TEXTURE_2D_ARRAY from a map of several texture sets, uploaded from the decoded images (no CPU pixel copies). */
  async layers(renderer,THREE,ids,map,size){const bmps=await Promise.all(ids.map(id=>{const f=this.mapFile(id,map,size);if(!f)throw new Error('KE.HD: '+id+' has no '+map);return this.bitmap(id,f,{size});}));
    const gl=renderer.getContext();if(!gl.texStorage3D)throw new Error('KE.HD.layers needs WebGL2');
    const prevUnit=gl.getParameter(gl.ACTIVE_TEXTURE),prev=gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY),tex=gl.createTexture(),levels=Math.floor(Math.log2(size))+1;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,tex);gl.texStorage3D(gl.TEXTURE_2D_ARRAY,levels,gl.RGBA8,size,size,bmps.length);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);gl.pixelStorei(gl.UNPACK_ALIGNMENT,4);
    bmps.forEach((b,i)=>{gl.texSubImage3D(gl.TEXTURE_2D_ARRAY,0,0,0,i,size,size,1,gl.RGBA,gl.UNSIGNED_BYTE,b);if(b.close)b.close();});
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_S,gl.REPEAT);gl.texParameteri(gl.TEXTURE_2D_ARRAY,gl.TEXTURE_WRAP_T,gl.REPEAT);
    const an=gl.getExtension('EXT_texture_filter_anisotropic');if(an)gl.texParameterf(gl.TEXTURE_2D_ARRAY,an.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(KE.settings.aniso||8,gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    gl.bindTexture(gl.TEXTURE_2D_ARRAY,prev);gl.activeTexture(prevUnit);
    /* a DataTexture2DArray at version 0 is bound as-is: Three uses the handle we give it and never uploads */
    const t=new THREE.DataTexture2DArray(null,size,size,bmps.length);t.version=0;/* the constructor sets needsUpdate: undo it, or Three would replace our texture with an empty upload */t.name='hd-layers:'+map;renderer.properties.get(t).__webglTexture=tex;
    const bytes=size*size*4*bmps.length*4/3;this.stats.gpuBytes+=bytes;this.stats.textures++;
    const free=()=>{if(!this._gl.has(tex))return;this._gl.delete(tex);gl.deleteTexture(tex);this.stats.gpuBytes-=bytes;t.removeEventListener('dispose',free);};t.addEventListener('dispose',free);
    this._gl.add(tex);this._owned.add(t);return t;},
  /* A glTF model from the pack: every mesh's world-transformed geometry and material, ready for instancing. */
  async gltf(THREE,id,{tier=0}={}){const e=this.info(id);if(!e)return null;if(!THREE.GLTFLoader)throw new Error('KE.HD.gltf needs THREE.GLTFLoader');
    /* scans may come at several texture tiers (x_2k.gltf, x_4k.gltf with their own textures): take one and its files */
    const main=pickTier(Object.keys(e.files).filter(f=>f.endsWith('.gltf')),tier),t=main.match(/_(\d+k)\.gltf$/),res=t?t[1]:null;
    const own=f=>f!==main&&(!res||!/_\d+k\.\w+$/.test(f)||f.includes('_'+res+'.')||f.endsWith('.bin'));const urls={};
    await Promise.all(Object.keys(e.files).filter(own).map(async f=>{urls[f]=URL.createObjectURL(await this.blob(id,f));}));
    const json=await (await this.blob(id,main)).text();
    const manager=new THREE.LoadingManager();manager.setURLModifier(u=>{const k=Object.keys(urls).find(f=>u.endsWith(f));return k?urls[k]:u;});
    const loader=new THREE.GLTFLoader(manager);
    const gltf=await new Promise((resolve,reject)=>loader.parse(json,'',resolve,reject));
    for(const u of Object.values(urls))URL.revokeObjectURL(u);
    const scene=gltf.scene;scene.updateMatrixWorld(true);const parts=[];
    scene.traverse(o=>{if(!o.isMesh)return;const g=o.geometry.clone().applyMatrix4(o.matrixWorld);g.computeBoundingSphere();g.computeBoundingBox();
      for(const m of [o.material].flat()){for(const k of ['map','emissiveMap'])if(m[k])m[k].encoding=THREE.sRGBEncoding;if(m.map)m.map.anisotropy=KE.settings.aniso||4;this._owned.add(m);}
      parts.push({geometry:g,material:o.material,name:o.name});this._owned.add(g);});
    const dispose=()=>{for(const p of parts){p.geometry.dispose();for(const m of [p.material].flat()){for(const k in m)if(m[k]&&m[k].isTexture)m[k].dispose();m.dispose();}}};
    return {scene,parts,info:e,dispose};},
  /* A sky HDRI from the pack: {texture (equirectangular, half float), envMap (PMREM, for scene.environment)}. */
  async hdri(renderer,THREE,id,{pmrem=true,tier=4096}={}){const e=this.info(id);if(!e||e.kind!=='hdri')return null;if(!THREE.RGBELoader)throw new Error('KE.HD.hdri needs THREE.RGBELoader');
    const file=pickTier(Object.keys(e.files).filter(f=>f.endsWith('.hdr')),tier),buf=await (await this.blob(id,file)).arrayBuffer();
    const L=new THREE.RGBELoader();L.setDataType(THREE.HalfFloatType);const d=L.parse(buf);
    const t=new THREE.DataTexture(d.data,d.width,d.height,d.format||THREE.RGBAFormat,d.type||THREE.HalfFloatType);t.encoding=THREE.LinearEncoding;t.minFilter=THREE.LinearFilter;t.magFilter=THREE.LinearFilter;
    t.generateMipmaps=false;t.flipY=true;t.mapping=THREE.EquirectangularReflectionMapping;t.needsUpdate=true;t.name='hd-sky:'+id;this._owned.add(t);this.stats.textures++;this.stats.gpuBytes+=d.width*d.height*8;
    let envMap=null;if(pmrem&&THREE.PMREMGenerator){const g=new THREE.PMREMGenerator(renderer);envMap=g.fromEquirectangular(t).texture;g.dispose();this._owned.add(envMap);}
    return {texture:t,envMap,width:d.width,height:d.height};},
  /* Game-ready pieces of a scanned model, for instancing (KE.scatterCell types) or placing:
     split: each mesh on its own, recentred on its footprint (x/z centre, base at y = 0); otherwise one merged piece
     per material, recentred the same way. Pieces above maxTriangles are simplified (KE.simplify: meshoptimizer; the
     photoscanned normal map keeps the surface detail). Textures are resampled to textureSize (VRAM budget).
     Blended (BLEND) foliage becomes alpha-tested and double-sided, so instances need no sorting; wind adds
     height-based sway (KE.foliage). Returns [{geometry, material, triangles, sourceTriangles, size:[x,y,z], name}]
     sorted largest first. */
  async prepare(THREE,id,{maxTriangles=5000,split=true,wind=null,textureSize=0,keep=0}={}){const m=await this.gltf(THREE,id,{tier:textureSize});if(!m)return [];
    const mats=new Set();for(const p of m.parts)for(const x of [p.material].flat())mats.add(x);
    if(textureSize)await Promise.all([...mats].flatMap(mt=>['map','normalMap','roughnessMap','metalnessMap','aoMap','alphaMap'].map(async k=>{const t=mt[k],im=t&&t.image;
      if(!im||!(im.width>textureSize))return;if(t._keResized)return;t._keResized=true;const b=await createImageBitmap(im,{resizeWidth:textureSize,resizeHeight:Math.max(1,Math.round(im.height*textureSize/im.width)),resizeQuality:'high'});if(im.close)im.close();t.image=b;t.needsUpdate=true;})));
    for(const mt of mats){if(mt.transparent&&(mt.map||mt.alphaMap)){mt.transparent=false;mt.alphaTest=.5;mt.depthWrite=true;}if(mt.alphaTest>0)mt.side=THREE.DoubleSide;
      if(wind&&KE.foliage)KE.foliage.applyWind(THREE,mt,{wind:typeof wind==='object'?wind:{trunk:.01,branch:.035,leaf:.07}});}
    let parts=m.parts;
    if(!split&&parts.length>1&&THREE.BufferGeometryUtils){const byMat=new Map();for(const p of parts){const k=[p.material].flat()[0];if(!byMat.has(k))byMat.set(k,[]);byMat.get(k).push(p);}
      parts=[...byMat.entries()].map(([mt,list])=>{const gs=list.map(p=>{const g=p.geometry.index?p.geometry.toNonIndexed():p.geometry;for(const n of Object.keys(g.attributes))if(!['position','normal','uv','tangent'].includes(n))g.deleteAttribute(n);return g;});
        const g=THREE.BufferGeometryUtils.mergeBufferGeometries(gs,false)||list[0].geometry;return {geometry:g,material:mt,name:list.map(p=>p.name).join('+')};});}
    const out=[];
    for(const p of parts){let g=p.geometry;g.computeBoundingBox();const bb=g.boundingBox;g.translate(-(bb.min.x+bb.max.x)/2,-bb.min.y,-(bb.min.z+bb.max.z)/2);
      const src=(g.index?g.index.count:g.attributes.position.count)/3;let tris=src;
      if(src>maxTriangles&&KE.simplify){try{const lo=KE.simplify(THREE,g,{ratio:maxTriangles/src,targetError:Infinity});tris=(lo.index?lo.index.count:lo.attributes.position.count)/3;g.dispose();g=lo;}catch(e){console.warn('KE.HD.prepare: simplify failed for',id,e);}}
      if(wind&&KE.foliage)KE.foliage.addWindWeights(THREE,g);
      g.computeBoundingBox();g.computeBoundingSphere();const sz=g.boundingBox.getSize(new THREE.Vector3());this._owned.add(g);
      out.push({geometry:g,material:p.material,triangles:Math.round(tris),sourceTriangles:Math.round(src),size:[sz.x,sz.y,sz.z],name:p.name||id});}
    out.sort((a,b)=>b.size[0]*b.size[1]*b.size[2]-a.size[0]*a.size[1]*a.size[2]);return keep?out.slice(0,keep):out;},
  dispose(){for(const o of this._owned)if(o.dispose)o.dispose();this._owned.clear();}
};
KE.HD=HD;
KE.registerModule('hd',{provides:['HD']});
})();
