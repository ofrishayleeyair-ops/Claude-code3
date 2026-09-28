/* Browser checks for KE.HD (21-hd.js), KE.GPUTerrain.setLayers and KE.rockCell / KE.instanceGroup (32-world.js).
   node scripts/test_hd.cjs
   Builds a tiny pack in .test-output/hdtest in the same format as scripts/hd_pack.py (script-wrapped files, one of them
   split into two parts): four 8×8 PNG texture sets, a one-triangle glTF with a texture and a 4×2 Radiance HDR. */
const fs=require('fs'),path=require('path'),zlib=require('zlib');const {openPage}=require('./harness.cjs');
const ROOT=path.resolve(__dirname,'..'),OUT=path.join(ROOT,'.test-output','hdtest');
let failed=0;const check=(name,ok,info)=>{console.log((ok?'PASS ':'FAIL ')+name+(info!==undefined?'  '+JSON.stringify(info):''));if(!ok)failed++;};

/* ---------- a minimal pack ---------- */
const crc=(()=>{const t=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;}return b=>{let c=0xffffffff;for(const x of b)c=t[(c^x)&255]^(c>>>8);return (c^0xffffffff)>>>0;};})();
const png=(w,h,px)=>{const chunk=(type,data)=>{const l=Buffer.alloc(4);l.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]),c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const c=px(x,y);raw.set(c,y*(w*4+1)+1+x*4);}
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);};
fs.rmSync(OUT,{recursive:true,force:true});fs.mkdirSync(OUT,{recursive:true});
const manifest={version:1,name:'test pack',license:'CC0',assets:{}};
const put=(id,rel,buf,mime,parts=1)=>{const key=id+'/'+rel,size=Math.ceil(buf.length/parts),script=rel.replace(/\//g,'__');fs.mkdirSync(path.join(OUT,id),{recursive:true});
  for(let p=0;p<parts;p++)fs.writeFileSync(path.join(OUT,id,script+(parts>1?'.'+p:'')+'.js'),`KitsuneHD.put(${JSON.stringify(key)},${p},${parts},${JSON.stringify(mime)},'${buf.subarray(p*size,(p+1)*size).toString('base64')}');\n`);
  return {mime,bytes:buf.length,parts,script};};
/* texture sets: albedo in a distinct colour per set, flat normal, ARM (AO 1, rough .5, metal 0), height .5 */
const cols=[[200,40,40],[40,200,40],[40,40,200],[200,200,40]];
cols.forEach((c,i)=>{const id='set'+i,files={};files['diff_1k.png']=put(id,'diff_1k.png',png(8,8,()=>[...c,255]),'image/png',i===0?2:1);
  files['nor_1k.png']=put(id,'nor_1k.png',png(8,8,()=>[128,128,255,255]),'image/png');files['arm_1k.png']=put(id,'arm_1k.png',png(8,8,()=>[255,128,0,255]),'image/png');files['disp_1k.png']=put(id,'disp_1k.png',png(8,8,()=>[128,128,128,255]),'image/png');
  manifest.assets[id]={kind:'texture',role:['grass','sand','rock','snow'][i],res:'1k',name:'Set '+i,authors:['test'],size_m:[2,2],files};});
/* resolution tiers: the loader takes the smallest tier that meets the requested size */
manifest.assets.tiers={kind:'texture',role:'tiers',res:'2k',name:'Tiers',authors:['test'],files:{'diff_1k.png':put('tiers','diff_1k.png',png(4,4,()=>[10,10,10,255]),'image/png'),'diff_2k.png':put('tiers','diff_2k.png',png(8,8,()=>[20,20,20,255]),'image/png')}};
{/* one textured triangle: base 1 m wide, 0.5 m up, placed off-centre so prepare() has something to recentre */
  const pos=new Float32Array([2,.5,3, 3,.5,3, 2.5,1,3]),uv=new Float32Array([0,0,1,0,.5,1]),idx=new Uint16Array([0,1,2,0]),bin=Buffer.concat([Buffer.from(pos.buffer),Buffer.from(uv.buffer),Buffer.from(idx.buffer)]);
  const gltf={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},indices:2,material:0}]}],
    materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0}}],textures:[{source:0}],images:[{uri:'textures/tri_diff.png'}],
    buffers:[{uri:'tri.bin',byteLength:bin.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:24},{buffer:0,byteOffset:60,byteLength:6}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3',min:[2,.5,3],max:[3,1,3]},{bufferView:1,componentType:5126,count:3,type:'VEC2'},{bufferView:2,componentType:5123,count:3,type:'SCALAR'}]};
  manifest.assets.tri={kind:'model',role:'rock',res:'1k',name:'Triangle',authors:['test'],files:{'tri.gltf':put('tri','tri.gltf',Buffer.from(JSON.stringify(gltf)),'model/gltf+json'),'tri.bin':put('tri','tri.bin',bin,'application/octet-stream'),
    'textures/tri_diff.png':put('tri','textures/tri_diff.png',png(4,4,()=>[90,90,90,255]),'image/png')}};}
{/* flat (uncompressed) Radiance RGBE, 4×2 */const head=Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n'),px=Buffer.alloc(32);for(let i=0;i<8;i++)px.set([128,128,128,129],i*4);
  manifest.assets.sky={kind:'hdri',role:'sky',res:'1k',name:'Sky',authors:['test'],files:{'sky_1k.hdr':put('sky','sky_1k.hdr',Buffer.concat([head,px]),'image/vnd.radiance')}};}
fs.writeFileSync(path.join(OUT,'manifest.js'),'KitsuneHD.manifest('+JSON.stringify(manifest)+');\n');

(async()=>{
  const {page,close,errors}=await openPage({modules:['src/modules/00-core-v3.js','src/modules/20-materials.js','src/modules/21-hd.js','src/modules/30-geometry.js','src/modules/32-world.js'],libs:true,name:'hd',allowErrors:true});
  const r=await page.evaluate(async()=>{const KE=window.KitsuneEngine,T=window.THREE,out={};
    out.missing=await KE.HD.ready('no-such-folder/');
    const m=await KE.HD.ready('hdtest/');out.assets=Object.keys(m.assets).length;out.find=KE.HD.find('texture','rock');
    out.tiers=[KE.HD.mapFile('tiers','diff',1000),KE.HD.mapFile('tiers','diff',1500),KE.HD.mapFile('tiers','diff',9000),KE.HD.mapFile('tiers','diff')].join();
    const b=await KE.HD.blob('set0','diff_1k.png');out.multipartPng=new Uint8Array(await b.slice(0,4).arrayBuffer()).join(',');
    const tex=await KE.HD.texture(T,'set1','diff',{srgb:true});out.tex={w:tex.image.width,srgb:tex.encoding===T.sRGBEncoding};
    const renderer=new T.WebGLRenderer();renderer.setSize(64,64);document.body.append(renderer.domElement);
    const mat=await KE.HD.material(T,'set2');out.material={map:!!mat.map,normal:!!mat.normalMap,rough:mat.roughnessMap===mat.metalnessMap};
    {const sc=new T.Scene(),cam=new T.PerspectiveCamera(50,1,.1,10);cam.position.z=3;sc.add(new T.Mesh(new T.SphereGeometry(1,16,12),mat),new T.AmbientLight(0xffffff,1));renderer.render(sc,cam);}
    /* texture arrays feeding the HD terrain: look straight down on flat ground with only grass (layer 0 = set0, red) */
    const ids=['set0','set0','set2','set3','set1','set2','set3','set1','set3','set2','set1','set2'];/* both grass layers (moss, leaf litter) red; ash (8) yellow */
    const arr=await KE.HD.layers(renderer,T,ids,'diff',8);out.array={version:arr.version,depth:arr.image.depth,bound:!!renderer.properties.get(arr).__webglTexture};
    const [nor,arm,hgt]=await Promise.all([KE.HD.layers(renderer,T,ids,'nor',8),KE.HD.layers(renderer,T,ids,'arm',8),KE.HD.layers(renderer,T,ids,'disp',8)]);
    const hf=new KE.Heightfield({size:65,worldSize:64});hf.recomputeRange();const biomes=new T.DataTexture(new Uint8Array(65*65*4).map((v,i)=>i%4===0?255:0),65,65,T.RGBAFormat);biomes.needsUpdate=true;
    const terrain=new KE.GPUTerrain(T,{heightfield:hf,biomes,macro:0});terrain.setLayers({albedo:arr,normal:nor,arm,height:hgt,scales:Array(8).fill(.5),rockHigh:[1e4,1e4+1]});
    const sc=new T.Scene();sc.add(terrain.object,new T.AmbientLight(0xffffff,1.5));const cam=new T.OrthographicCamera(-20,20,20,-20,.1,100);cam.position.set(0,50,0);cam.lookAt(0,0,0);cam.updateMatrixWorld();
    terrain.update(cam,renderer);renderer.render(sc,cam);const gl=renderer.getContext(),px=new Uint8Array(4);gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);out.terrainPixel=Array.from(px);
    /* the volcanic mask turns grass into ash (layer 8) */
    terrain.setLayers({...terrain.layers,masks:()=>[1,0,0]});renderer.render(sc,cam);gl.readPixels(32,32,1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);out.ashPixel=Array.from(px);
    const tri=await KE.HD.gltf(T,'tri');out.gltf={parts:tri.parts.length,verts:tri.parts[0].geometry.attributes.position.count,map:!!tri.parts[0].material.map};
    const prep=await KE.HD.prepare(T,'tri');const bb=prep[0].geometry.boundingBox;out.prepare={minY:+bb.min.y.toFixed(3),cx:+((bb.min.x+bb.max.x)/2).toFixed(3),size:prep[0].size.map(v=>+v.toFixed(2))};
    const sky=await KE.HD.hdri(renderer,T,'sky',{pmrem:false});out.hdri={w:sky.width,h:sky.height};
    /* rock clusters on a slope with a flat shelf: deterministic, sunk, cliff pieces on the steep part */
    const H=new KE.Heightfield({size:129,worldSize:256});for(let j=0;j<129;j++)for(let i=0;i<129;i++){const x=H.originX+i*H.spacing;H.data[j*129+i]=x>0?x*1.6:0;}H.recomputeRange();
    const g=new T.DodecahedronGeometry(1,1);g.translate(0,1,0);const mt=new T.MeshStandardMaterial();
    const types=[{name:'hero',geometry:g,material:mt,role:'hero',size:[2,3]},{name:'small',geometry:g,material:mt,role:'small',size:[.3,.6]},{name:'cliff',geometry:g,material:mt,role:'cliff',size:[8,10]}];
    const opts={cell:{ix:-1,iz:0},cellSize:128,terrain:H,types,seed:3,spacing:16,density:1,originX:0,originZ:-64},a=KE.rockCell(T,opts),b2=KE.rockCell(T,opts);
    const inst=grp=>{const o={};grp.children.forEach(m=>{o[m.name]=Array.from(m.instanceMatrix.array.slice(0,m.count*16));});return o;};const A=inst(a),B=inst(b2);
    out.rocks={same:JSON.stringify(A)===JSON.stringify(B),counts:Object.fromEntries(a.children.map(m=>[m.name,m.count]))};
    const c2=KE.rockCell(T,{...opts,cell:{ix:0,iz:0}});out.rocks.steep=Object.fromEntries(c2.children.map(m=>[m.name,m.count]));
    let sunk=0,total=0;for(const m of a.children){const e=m.instanceMatrix.array;for(let i=0;i<m.count;i++){total++;if(e[i*16+13]<H.heightAt(e[i*16+12],e[i*16+14])-1e-4)sunk++;}}out.rocks.sunk=sunk+'/'+total;
    a.userData.dispose();b2.userData.dispose();c2.userData.dispose();out.disposed=a.parent===null&&a.children.length===0;
    KE.HD.dispose();return out;});
  check('resolution tiers: smallest tier that meets the size, else the largest',r.tiers==='diff_1k.png,diff_2k.png,diff_2k.png,diff_2k.png',r.tiers);
  check('missing pack resolves to null; manifest loads; find by kind and role',r.missing===null&&r.assets===7&&r.find.join()==='set2',{assets:r.assets,find:r.find});
  check('a file split into two script parts reassembles (PNG signature)',r.multipartPng==='137,80,78,71',r.multipartPng);
  check('texture(): decoded image, sRGB when asked',r.tex.w===8&&r.tex.srgb,r.tex);
  check('material(): map, normal map, ARM as roughness+metalness; renders',r.material.map&&r.material.normal&&r.material.rough,r.material);
  check('layers(): texture array uploaded once and bound as-is (version 0)',r.array.version===0&&r.array.depth===12&&r.array.bound,r.array);
  const [pr,pg,pb]=r.terrainPixel;check('GPUTerrain.setLayers: HD ground shows the grass layers\' colour (red set), not black or sky',pr>60&&pr>pg*2&&pr>pb*2,r.terrainPixel);
  {const [ar,ag,ab]=r.ashPixel;check('volcanic mask lays the ash layer (yellow set) over grass',ar>60&&ag>60&&ab<ar*.5,r.ashPixel);}
  check('gltf(): textured triangle from blob URLs',r.gltf.parts===1&&r.gltf.verts===3&&r.gltf.map,r.gltf);
  check('prepare(): recentred on its footprint with the base at y = 0',r.prepare.minY===0&&Math.abs(r.prepare.cx)<1e-3&&Math.abs(r.prepare.size[0]-1)<.01,r.prepare);
  check('hdri(): Radiance file decoded',r.hdri.w===4&&r.hdri.h===2,r.hdri);
  check('rockCell: deterministic hero+small clusters on flat ground, cliff pieces on the slope, rocks sunk into the ground',r.rocks.same&&r.rocks.counts.hero>0&&r.rocks.counts.small>0&&!(r.rocks.counts.cliff>0)&&r.rocks.steep.cliff>0&&r.rocks.sunk.split('/')[0]===r.rocks.sunk.split('/')[1]&&r.disposed,r.rocks);
  /* the only expected browser error is the deliberately missing folder's manifest */
  const unexpected=errors.filter(e=>!/ERR_FILE_NOT_FOUND/.test(e));check('no unexpected browser errors',unexpected.length===0&&errors.length<=1,errors);
  await close();console.log(failed?failed+' hd check(s) failed':'all hd checks passed');process.exit(failed?1:0);
})().catch(e=>{console.error(e);process.exit(1);});
