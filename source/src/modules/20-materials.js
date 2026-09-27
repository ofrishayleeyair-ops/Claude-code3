/* KE.MaterialGraph — node-based materials compiled to GLSL, in the spirit of a material editor.
   A graph of typed nodes ({nodes:[{id,type,…,in:{…}}], params:{…}, outputs:{…}}) is type-checked and compiled
   into GLSL. Lit models ('standard', 'physical') inject the generated code into MeshStandardMaterial /
   MeshPhysicalMaterial through onBeforeCompile, so Three's lights, shadows, fog, image-based lighting,
   instancing and skinning keep working and later hooks (KE.CascadedShadows, KE.ProbeVolume) still compose.
   The 'unlit' model builds a ShaderMaterial from Three's shader chunks.
   Compilation: depth-first evaluation from the used outputs (so dead nodes cost nothing), one uniquely named
   temporary per node, helper functions deduplicated by name with dependency ordering, scalar broadcasting and
   explicit type errors. worldPositionOffset is compiled separately into the vertex stage. Params become
   uniforms, so the program cache key depends on graph structure only; material instances share one program
   and edit their own values without recompiling. Also: a fluent builder (KE.shaderGraph) and a library of
   ready materials with procedurally generated textures (KE.materialLibrary). */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');

/* ---------- types, literals, errors ---------- */
const DIM={float:1,vec2:2,vec3:3,vec4:4};
const VEC=['','float','vec2','vec3','vec4'];
class GraphError extends Error{
  constructor(message,node=null,code='graph'){super(node?`[${node}] ${message}`:message);this.name='GraphError';this.node=node;this.code=code;this.detail=message;}
}
const IDENT=/^[A-Za-z_][A-Za-z0-9_]*$/;
const fmt=v=>{v=+v;if(!Number.isFinite(v))throw new GraphError('non-finite number in graph: '+v,null,'value');let s=String(v);if(!/[.eE]/.test(s))s+='.0';return v<0?'('+s+')':s;};
const srgbToLinear=c=>c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4);
function hexToLinear(s){let h=String(s).replace('#','');if(h.length===3)h=h.split('').map(c=>c+c).join('');if(!/^[0-9a-fA-F]{6}$/.test(h))throw new GraphError('bad colour literal '+s,null,'value');
  const n=parseInt(h,16);return [(n>>16)&255,(n>>8)&255,n&255].map(c=>srgbToLinear(c/255));}
const vecLit=a=>({expr:`vec${a.length}(${a.map(x=>fmt(x)).join(', ')})`,type:'vec'+a.length});
/* Literal values accepted anywhere an input is expected. Hex strings are sRGB and converted to linear;
   arrays, numbers and THREE.Color/Vector objects are used as given (linear). */
function literal(v){
  if(typeof v==='number')return {expr:fmt(v),type:'float'};
  if(typeof v==='boolean')return {expr:v?'1.0':'0.0',type:'float'};
  if(typeof v==='string'&&v[0]==='#')return vecLit(hexToLinear(v));
  if(Array.isArray(v)&&v.length>=1&&v.length<=4&&v.every(x=>typeof x==='number'))return v.length===1?literal(v[0]):vecLit(v);
  if(v&&typeof v==='object'){if(v.isColor)return vecLit([v.r,v.g,v.b]);if(v.isVector4)return vecLit([v.x,v.y,v.z,v.w]);if(v.isVector3)return vecLit([v.x,v.y,v.z]);if(v.isVector2)return vecLit([v.x,v.y]);}
  return null;
}
const isRef=v=>(typeof v==='string'&&v[0]!=='#'&&v[0]!=='@')||(v&&typeof v==='object'&&!Array.isArray(v)&&typeof v.node==='string');
function parseRef(v){if(typeof v==='string'){const i=v.indexOf('.');return i<0?{id:v,port:null}:{id:v.slice(0,i),port:v.slice(i+1)};}return {id:v.node,port:v.out||v.port||null};}
function cast(expr,from,to,node,what){
  if(from===to)return expr;
  if(from==='sampler2D'||to==='sampler2D')throw new GraphError(`${what} expects ${to}, got ${from}`,node,'type');
  if(from==='float'&&DIM[to])return `${to}(${expr})`;
  if(from==='vec4'&&to==='vec3')return `(${expr}).xyz`;
  if(from==='vec3'&&to==='vec4')return `vec4(${expr}, 1.0)`;
  throw new GraphError(`${what} expects ${to}, got ${from}`,node,'type');
}
function unify(types,names,node){let n=1;
  for(const k of names){const t=types[k];if(t==null)continue;if(!DIM[t])throw new GraphError(`input '${k}' must be a scalar or vector, got ${t}`,node.id,'type');const d=DIM[t];if(d===1)continue;
    if(n===1)n=d;else if(n!==d)throw new GraphError(`cannot combine ${VEC[n]} and ${t} (input '${k}')`,node.id,'type');}
  return VEC[n];}
function hashString(s){let h1=0x811c9dc5,h2=0x01000193^s.length;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h1=Math.imul(h1^c,16777619);h2=Math.imul(h2^c,2246822519)+(h2>>>13)|0;}
  return (h1>>>0).toString(16).padStart(8,'0')+(h2>>>0).toString(16).padStart(8,'0');}

/* ---------- GLSL helper library (deduplicated per stage, dependencies first) ---------- */
const HELPERS={};
const helper=(name,deps,code,stage='any')=>{HELPERS[name]={name,deps,code,stage};};
helper('kmgHash12',[],`float kmgHash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}`);
helper('kmgHash22',[],`vec2 kmgHash22(vec2 p){vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));p3+=dot(p3,p3.yzx+33.33);return fract((p3.xx+p3.yz)*p3.zy);}`);
helper('kmgHash13',[],`float kmgHash13(vec3 p3){p3=fract(p3*.1031);p3+=dot(p3,p3.zyx+31.32);return fract((p3.x+p3.y)*p3.z);}`);
helper('kmgHash33',[],`vec3 kmgHash33(vec3 p3){p3=fract(p3*vec3(.1031,.1030,.0973));p3+=dot(p3,p3.yxz+33.33);return fract((p3.xxy+p3.yxx)*p3.zyx);}`);
helper('kmgValue2',['kmgHash12'],`float kmgValue2(vec2 x){vec2 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);return mix(mix(kmgHash12(i),kmgHash12(i+vec2(1.,0.)),f.x),mix(kmgHash12(i+vec2(0.,1.)),kmgHash12(i+vec2(1.,1.)),f.x),f.y);}`);
helper('kmgValue3',['kmgHash13'],`float kmgValue3(vec3 x){vec3 i=floor(x),f=fract(x);f=f*f*(3.-2.*f);
return mix(mix(mix(kmgHash13(i),kmgHash13(i+vec3(1.,0.,0.)),f.x),mix(kmgHash13(i+vec3(0.,1.,0.)),kmgHash13(i+vec3(1.,1.,0.)),f.x),f.y),mix(mix(kmgHash13(i+vec3(0.,0.,1.)),kmgHash13(i+vec3(1.,0.,1.)),f.x),mix(kmgHash13(i+vec3(0.,1.,1.)),kmgHash13(i+vec3(1.,1.,1.)),f.x),f.y),f.z);}`);
helper('kmgGrad2',['kmgHash22'],`vec2 kmgGrad2(vec2 p){vec2 h=kmgHash22(p)*2.-1.;return h*inversesqrt(max(dot(h,h),1e-4));}`);
helper('kmgGrad3',['kmgHash33'],`vec3 kmgGrad3(vec3 p){vec3 h=kmgHash33(p)*2.-1.;return h*inversesqrt(max(dot(h,h),1e-4));}`);
/* Gradient (Perlin) noise with quintic fade, remapped to [0,1]. */
helper('kmgPerlin2',['kmgGrad2'],`float kmgPerlin2(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*f*(f*(f*6.-15.)+10.);
float a=dot(kmgGrad2(i),f),b=dot(kmgGrad2(i+vec2(1.,0.)),f-vec2(1.,0.)),c=dot(kmgGrad2(i+vec2(0.,1.)),f-vec2(0.,1.)),d=dot(kmgGrad2(i+vec2(1.,1.)),f-vec2(1.,1.));
return clamp(mix(mix(a,b,u.x),mix(c,d,u.x),u.y)*.7071+.5,0.,1.);}`);
helper('kmgPerlin3',['kmgGrad3'],`float kmgPerlin3(vec3 p){vec3 i=floor(p),f=fract(p),u=f*f*f*(f*(f*6.-15.)+10.);
float n000=dot(kmgGrad3(i),f),n100=dot(kmgGrad3(i+vec3(1.,0.,0.)),f-vec3(1.,0.,0.)),n010=dot(kmgGrad3(i+vec3(0.,1.,0.)),f-vec3(0.,1.,0.)),n110=dot(kmgGrad3(i+vec3(1.,1.,0.)),f-vec3(1.,1.,0.));
float n001=dot(kmgGrad3(i+vec3(0.,0.,1.)),f-vec3(0.,0.,1.)),n101=dot(kmgGrad3(i+vec3(1.,0.,1.)),f-vec3(1.,0.,1.)),n011=dot(kmgGrad3(i+vec3(0.,1.,1.)),f-vec3(0.,1.,1.)),n111=dot(kmgGrad3(i+vec3(1.,1.,1.)),f-vec3(1.,1.,1.));
return clamp(mix(mix(mix(n000,n100,u.x),mix(n010,n110,u.x),u.y),mix(mix(n001,n101,u.x),mix(n011,n111,u.x),u.y),u.z)*.75+.5,0.,1.);}`);
/* Simplex noise on skewed triangular/tetrahedral lattices with hashed unit gradients. */
helper('kmgSimplex2',['kmgGrad2'],`float kmgSimplex2(vec2 p){const float K1=.366025404,K2=.211324865;vec2 i=floor(p+(p.x+p.y)*K1);vec2 a=p-i+(i.x+i.y)*K2;float m=step(a.y,a.x);vec2 o=vec2(m,1.-m);vec2 b=a-o+K2;vec2 c=a-1.+2.*K2;
vec3 h=max(.5-vec3(dot(a,a),dot(b,b),dot(c,c)),0.);vec3 n=h*h*h*h*vec3(dot(a,kmgGrad2(i)),dot(b,kmgGrad2(i+o)),dot(c,kmgGrad2(i+1.)));return clamp(.5+.5*dot(n,vec3(70.)),0.,1.);}`);
helper('kmgSimplex3',['kmgGrad3'],`float kmgSimplex3(vec3 p){const float F3=.33333333,G3=.16666667;vec3 s=floor(p+dot(p,vec3(F3)));vec3 x=p-s+dot(s,vec3(G3));vec3 e=step(vec3(0.),x-x.yzx);vec3 i1=e*(1.-e.zxy);vec3 i2=1.-e.zxy*(1.-e);
vec3 x1=x-i1+G3,x2=x-i2+2.*G3,x3=x-1.+3.*G3;vec4 w=max(.6-vec4(dot(x,x),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);
vec4 d=vec4(dot(x,kmgGrad3(s)),dot(x1,kmgGrad3(s+i1)),dot(x2,kmgGrad3(s+i2)),dot(x3,kmgGrad3(s+1.)));w*=w;w*=w;return clamp(.5+.5*dot(d*w,vec4(32.)),0.,1.);}`);
/* Cellular noise: returns (F1, F2, cell id[, angle of the sample around its feature point in 2D]). */
helper('kmgVoronoi2',['kmgHash12','kmgHash22'],`vec4 kmgVoronoi2(vec2 p){vec2 n=floor(p),f=fract(p),rn=vec2(1.,0.);float f1=8.,f2=8.,id=0.;
for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec2 g=vec2(float(i),float(j));vec2 r=g+kmgHash22(n+g)-f;float d=dot(r,r);if(d<f1){f2=f1;f1=d;rn=r;id=kmgHash12(n+g+vec2(17.3,9.1));}else if(d<f2){f2=d;}}
return vec4(sqrt(f1),sqrt(f2),id,atan(-rn.y,-rn.x+1e-9));}`);
helper('kmgVoronoi3',['kmgHash13','kmgHash33'],`vec3 kmgVoronoi3(vec3 p){vec3 n=floor(p),f=fract(p);float f1=8.,f2=8.,id=0.;
for(int k=-1;k<=1;k++)for(int j=-1;j<=1;j++)for(int i=-1;i<=1;i++){vec3 g=vec3(float(i),float(j),float(k));vec3 r=g+kmgHash33(n+g)-f;float d=dot(r,r);if(d<f1){f2=f1;f1=d;id=kmgHash13(n+g+vec3(17.3,9.1,4.7));}else if(d<f2){f2=d;}}
return vec3(sqrt(f1),sqrt(f2),id);}`);
helper('kmgSRGB',[],`vec4 kmgSRGB(vec4 c){return vec4(mix(c.rgb/12.92,pow((max(c.rgb,vec3(0.))+.055)/1.055,vec3(2.4)),step(vec3(.04045),c.rgb)),c.a);}`);
helper('kmgTriW',[],`vec3 kmgTriW(vec3 n,float k){vec3 w=pow(abs(n)+1e-5,vec3(k));return w/(w.x+w.y+w.z);}`);
helper('kmgTriplanar',['kmgTriW'],`vec4 kmgTriplanar(sampler2D t,vec3 p,vec3 n,float k){vec3 w=kmgTriW(n,k);return texture2D(t,p.zy)*w.x+texture2D(t,p.xz)*w.y+texture2D(t,p.xy)*w.z;}`);
/* Triplanar normal mapping with the whiteout blend: each projection's tangent normal is swizzled into world space. */
helper('kmgTriplanarNormal',['kmgTriW'],`vec3 kmgTriplanarNormal(sampler2D t,vec3 p,vec3 n,float k,float s){vec3 w=kmgTriW(n,k);
vec3 tx=texture2D(t,p.zy).xyz*2.-1.,ty=texture2D(t,p.xz).xyz*2.-1.,tz=texture2D(t,p.xy).xyz*2.-1.;tx.xy*=s;ty.xy*=s;tz.xy*=s;
tx=vec3(tx.xy+n.zy,abs(tx.z)*n.x);ty=vec3(ty.xy+n.xz,abs(ty.z)*n.y);tz=vec3(tz.xy+n.xy,abs(tz.z)*n.z);return normalize(tx.zyx*w.x+ty.xzy*w.y+tz.xyz*w.z);}`);
/* Orthonormal tangent frame from screen-space derivatives of world position and UV (no precomputed tangents). */
helper('kmgTangentFrame',[],`mat3 kmgTangentFrame(vec3 N,vec3 p,vec2 uv){vec3 dp1=dFdx(p),dp2=dFdy(p);vec2 duv1=dFdx(uv),duv2=dFdy(uv);vec3 dp2perp=cross(dp2,N),dp1perp=cross(N,dp1);
vec3 T=dp2perp*duv1.x+dp1perp*duv2.x,B=dp2perp*duv1.y+dp1perp*duv2.y;T-=N*dot(N,T);float tl=dot(T,T);
if(tl<1e-16)T=abs(N.y)<.999?normalize(cross(vec3(0.,1.,0.),N)):vec3(1.,0.,0.);else T*=inversesqrt(tl);vec3 Bo=cross(N,T);if(dot(Bo,B)<0.)Bo=-Bo;return mat3(T,Bo,N);}`,'fragment');
helper('kmgToTangent',[],`vec3 kmgToTangent(mat3 m,vec3 v){return vec3(dot(m[0],v),dot(m[1],v),dot(m[2],v));}`);
/* Height-to-normal with derivatives (surface gradient): h in world units. */
helper('kmgBumpWorld',[],`vec3 kmgBumpWorld(vec3 N,vec3 p,float h,float s){vec3 dpx=dFdx(p),dpy=dFdy(p);float hx=dFdx(h),hy=dFdy(h);vec3 r1=cross(dpy,N),r2=cross(N,dpx);float det=dot(dpx,r1);
vec3 g=(det<0.?-1.:1.)*(hx*r1+hy*r2);return normalize(max(abs(det),1e-12)*N-s*g);}`,'fragment');
helper('kmgUnpackNormal',[],`vec3 kmgUnpackNormal(vec4 t,float s,float flipY){vec3 n=t.xyz*2.-1.;n.y*=flipY;n.xy*=s;return normalize(n);}`);
helper('kmgHueShift',[],`vec3 kmgHueShift(vec3 c,float t){float a=t*6.2831853;vec3 k=vec3(.57735027);float cs=cos(a);return c*cs+cross(k,c)*sin(a)+k*dot(k,c)*(1.-cs);}`);
helper('kmgRotate2',[],`vec2 kmgRotate2(vec2 v,float a){float c=cos(a),s=sin(a);return vec2(c*v.x-s*v.y,s*v.x+c*v.y);}`);
helper('kmgRotateAboutAxis',[],`vec3 kmgRotateAboutAxis(vec3 axis,float angle,vec3 pivot,vec3 pos){vec3 a=normalize(axis);vec3 d=pos-pivot;float c=cos(angle),s=sin(angle);return d*c+cross(a,d)*s+a*dot(a,d)*(1.-c)-d;}`);
helper('kmgIGN',[],`float kmgIGN(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}`);
helper('kmgHeightAlpha',[],`float kmgHeightAlpha(float h,float t,float c){float a=clamp(h-1.+t*2.,0.,1.);return clamp(mix(-c,1.+c,a),0.,1.);}`);
helper('kmgInverse3',[],`mat3 kmgInverse3(mat3 m){vec3 a=m[0],b=m[1],c=m[2];vec3 r0=cross(b,c),r1=cross(c,a),r2=cross(a,b);float d=dot(a,r0);
return mat3(r0.x,r1.x,r2.x,r0.y,r1.y,r2.y,r0.z,r1.z,r2.z)/(abs(d)<1e-20?1e-20:d);}`,'vertex');
/* Parallax occlusion mapping: fixed-count linear search (no early exit, so implicit texture derivatives stay valid
   and it runs on WebGL1), first crossing recorded arithmetically, then linear refinement between the two layers. */
const pomHelper=steps=>({name:'kmgPOM'+steps,deps:[],stage:'fragment',code:`vec2 kmgPOM${steps}(sampler2D t,vec2 uv,vec3 v,float scale,vec4 ch){const float N=${fmt(steps)};vec2 duv=v.xy/max(v.z,.2)*scale/N;
float layer=0.,lastD=1.-dot(texture2D(t,uv),ch),found=0.;vec2 cuv=uv,hit=uv;
for(int i=0;i<${steps};i++){vec2 nuv=cuv-duv;float nl=layer+1./N;float nd=1.-dot(texture2D(t,nuv),ch);float h=(1.-found)*step(nd,nl);
float after=nd-nl,before=lastD-layer;float w=clamp(after/(after-before-1e-5),0.,1.);hit=mix(hit,mix(nuv,cuv,w),h);found=max(found,h);cuv=nuv;layer=nl;lastD=nd;}
return mix(cuv,hit,found);}`});
const fbmHelper=(base,dim,oct,mode)=>{const name=`kmgFbm_${mode}_${base}${dim}_${oct}`,T=dim===2?'vec2':'vec3',fn={value:'kmgValue',perlin:'kmgPerlin',simplex:'kmgSimplex'}[base]+dim;
  const sample=mode==='ridged'?'(1.-abs(n*2.-1.))*(1.-abs(n*2.-1.))':mode==='turbulence'?'abs(n*2.-1.)':'n';
  const adv=dim===2?'p=mat2(.8,.6,-.6,.8)*p*lac+vec2(1.7,9.2);':'p=p*lac+vec3(1.7,9.2,3.1);';
  return {name,deps:[fn],stage:'any',code:`float ${name}(${T} p,float lac,float gain){float a=1.,s=0.,w=0.;for(int i=0;i<${oct};i++){float n=${fn}(p);s+=a*${sample};w+=a;${adv}a*=gain;}return s/w;}`};};

/* ---------- node registry ---------- */
const NODES={};
function registerNode(type,spec){
  if(!IDENT.test(type))throw new Error('KE.MaterialGraph.registerNode: invalid type name '+type);
  if(typeof spec.glsl!=='function'&&!spec.virtual)throw new Error('KE.MaterialGraph.registerNode: '+type+' needs glsl(ctx, inputs, node, types, outType)');
  const d={category:'custom',inputs:[],stage:'any',...spec,nodeType:type};
  if(d.type!==undefined&&typeof d.type!=='function')throw new Error('KE.MaterialGraph.registerNode: '+type+'.type must be a function (use out for a fixed type)');
  d.inputs=typeof d.inputs==='function'?d.inputs:d.inputs.map(i=>Array.isArray(i)?{name:i[0],type:i[1],default:i[2]}:i);
  NODES[type]=d;if(KE.MaterialGraph)KE.MaterialGraph._builderDirty=true;return d;}
const def=registerNode;
const texProps=['texture','param'];
/* Texture inputs resolve from a connected texture param, the node's `param` name, or a `texture` object
   (the latter becomes a hidden param during normalisation). */
function texInput(c,n,a){if(a.tex)return a.tex;if(typeof n.param==='string')return c.paramExpr(n.param,n.id,'sampler2D');throw new GraphError(`${n.type} needs a texture (connect a texture Param to 'tex', or set 'texture'/'param')`,n.id,'input');}
const decode=(c,n,expr,space='srgb')=>{if(space==='srgb'){c.helper('kmgSRGB');return `kmgSRGB(${expr})`;}return expr;};

// Constants and parameters
def('Constant',{category:'constant',inputs:[],type:(t,n)=>{const l=literal(n.value===undefined?0:n.value);if(!l)throw new GraphError('Constant.value must be a number, array or colour',n.id,'value');return l.type;},glsl:(c,a,n)=>literal(n.value===undefined?0:n.value).expr});
for(const [T,k] of [['Float',1],['Vec2',2],['Vec3',3],['Vec4',4]])def(T,{category:'constant',inputs:[],out:VEC[k],glsl:(c,a,n)=>{const v=n.value===undefined?0:n.value;const arr=typeof v==='number'?new Array(k).fill(v):v;if(!Array.isArray(arr)||arr.length!==k)throw new GraphError(`${T}.value needs ${k} numbers`,n.id,'value');return k===1?fmt(arr[0]):vecLit(arr).expr;}});
def('Color',{category:'constant',inputs:[],out:'vec3',glsl:(c,a,n)=>{const l=literal(n.value===undefined?'#ffffff':n.value);if(!l||l.type!=='vec3')throw new GraphError('Color.value must be "#rrggbb", [r,g,b] or THREE.Color',n.id,'value');return l.expr;}});
def('Param',{category:'constant',inputs:[],type:(t,n,c)=>c.paramType(n.name,n.id),glsl:(c,a,n)=>c.paramExpr(n.name,n.id)});
def('Time',{category:'input',inputs:[['scale','float',1]],out:'float',glsl:(c,a)=>a.scale==='1.0'?c.builtin('time').expr:`(${c.builtin('time').expr} * ${a.scale})`});
// Geometry and view inputs
def('UV',{category:'input',inputs:[['tiling','vec2',[1,1]],['offset','vec2',[0,0]]],out:'vec2',glsl:(c,a,n)=>{const uv=c.builtin(n.channel===1?'uv2':'uv').expr;return (a.tiling==='vec2(1.0, 1.0)'&&a.offset==='vec2(0.0, 0.0)')?uv:`(${uv} * ${a.tiling} + ${a.offset})`;}});
def('WorldPosition',{category:'input',out:'vec3',glsl:c=>c.builtin('worldPos').expr});
def('WorldNormal',{category:'input',out:'vec3',glsl:c=>c.builtin('worldNormal').expr});
def('ViewDirection',{category:'input',out:'vec3',glsl:c=>c.builtin('viewDir').expr});
def('CameraPosition',{category:'input',out:'vec3',glsl:()=>'cameraPosition'});
def('ObjectPosition',{category:'input',out:'vec3',glsl:c=>c.builtin('objectPos').expr});
def('VertexColor',{category:'input',out:'vec3',glsl:c=>c.builtin('vertexColor').expr});
def('ScreenUV',{category:'input',stage:'fragment',out:'vec2',glsl:c=>c.builtin('screenUV').expr});
def('PixelDepth',{category:'input',out:'float',glsl:c=>c.builtin('pixelDepth').expr});
def('SceneDepth',{category:'input',stage:'fragment',inputs:[['uv','vec2','@screenUV']],out:'float',glsl:(c,a)=>{const h=c.global('kmgHasScene','float'),d=c.global('kmgSceneDepth','sampler2D'),nf=c.global('kmgNearFar','vec2');return `(${h} > .5 ? texture2D(${d}, ${a.uv}).r : ${nf}.y)`;}});
def('SceneColor',{category:'input',stage:'fragment',inputs:[['uv','vec2','@screenUV'],['fallback','vec3',[0,0,0]]],out:'vec3',glsl:(c,a)=>{const h=c.global('kmgHasScene','float'),s=c.global('kmgSceneColor','sampler2D');return `(${h} > .5 ? texture2D(${s}, ${a.uv}).rgb : ${a.fallback})`;}});
def('DepthFade',{category:'input',stage:'fragment',inputs:[['fadeDistance','float',1]],out:'float',glsl:(c,a)=>{const h=c.global('kmgHasScene','float'),d=c.global('kmgSceneDepth','sampler2D');
  return `(${h} > .5 ? clamp((texture2D(${d}, ${c.builtin('screenUV').expr}).r - ${c.builtin('pixelDepth').expr}) / max(${a.fadeDistance}, 1e-4), 0.0, 1.0) : 1.0)`;}});
def('SunDirection',{category:'input',out:'vec3',glsl:c=>`normalize(${c.global('kmgSunDir','vec3')})`});
def('SunColor',{category:'input',out:'vec3',glsl:c=>c.global('kmgSunColor','vec3')});
def('Fresnel',{category:'shading',inputs:[['exponent','float',5],['baseReflectFraction','float',.04],['normal','vec3','@worldNormal']],out:'float',
  glsl:(c,a)=>`(${a.baseReflectFraction} + (1.0 - ${a.baseReflectFraction}) * pow(1.0 - clamp(dot(normalize(${a.normal}), ${c.builtin('viewDir').expr}), 0.0, 1.0), ${a.exponent}))`});
// Textures
def('Texture2D',{category:'texture',props:texProps,inputs:[['tex','sampler2D',null],['uv','vec2','@uv']],out:'vec4',glsl:(c,a,n)=>decode(c,n,`texture2D(${texInput(c,n,a)}, ${a.uv})`,n.space||'srgb')});
def('TriplanarSample',{category:'texture',props:texProps,inputs:[['tex','sampler2D',null],['position','vec3','@worldPos'],['normal','vec3','@worldNormal'],['scale','float',1],['sharpness','float',4]],out:'vec4',
  glsl:(c,a,n)=>{c.helper('kmgTriplanar');return decode(c,n,`kmgTriplanar(${texInput(c,n,a)}, ${a.position} * ${a.scale}, normalize(${a.normal}), ${a.sharpness})`,n.space||'srgb');}});
def('TriplanarNormal',{category:'texture',props:texProps,inputs:[['tex','sampler2D',null],['position','vec3','@worldPos'],['normal','vec3','@worldNormal'],['scale','float',1],['sharpness','float',4],['strength','float',1]],out:'vec3',
  glsl:(c,a,n)=>{c.helper('kmgTriplanarNormal');return `kmgTriplanarNormal(${texInput(c,n,a)}, ${a.position} * ${a.scale}, normalize(${a.normal}), ${a.sharpness}, ${a.strength})`;}});
def('NormalMap',{category:'texture',props:texProps,inputs:[['tex','sampler2D',null],['uv','vec2','@uv'],['strength','float',1]],out:'vec3',
  glsl:(c,a,n)=>{c.helper('kmgUnpackNormal');return `kmgUnpackNormal(texture2D(${texInput(c,n,a)}, ${a.uv}), ${a.strength}, ${n.flipY?'-1.0':'1.0'})`;}});
def('ParallaxOcclusion',{category:'texture',stage:'fragment',props:texProps,inputs:[['tex','sampler2D',null],['uv','vec2','@uv'],['heightScale','float',.05]],out:'vec2',
  glsl:(c,a,n)=>{const steps=Math.max(4,Math.min(64,Math.round(n.steps||16))),ch={r:'vec4(1.,0.,0.,0.)',g:'vec4(0.,1.,0.,0.)',b:'vec4(0.,0.,1.,0.)',a:'vec4(0.,0.,0.,1.)'}[n.channel||'r'];
    if(!ch)throw new GraphError("ParallaxOcclusion.channel must be 'r','g','b' or 'a'",n.id,'value');const h=pomHelper(steps);c.helper(h.name,h.code,h.deps,h.stage);c.helper('kmgToTangent');
    return `kmgPOM${steps}(${texInput(c,n,a)}, ${a.uv}, kmgToTangent(${c.builtin('tbn').expr}, ${c.builtin('viewDir').expr}), ${a.heightScale}, ${ch})`;}});
// Noise
const NOISE_KINDS=['value','perlin','simplex','voronoi','fbm','ridged','turbulence'];
def('Noise',{category:'procedural',inputs:[['p','any','@uv'],['scale','float',1]],
  type:(t,n)=>{if(!NOISE_KINDS.includes(n.kind||'perlin'))throw new GraphError(`Noise.kind must be one of ${NOISE_KINDS.join(', ')}`,n.id,'value');if(t.p==='vec4')throw new GraphError('Noise.p must be float, vec2 or vec3',n.id,'type');return 'float';},
  raw:(t,n)=>(n.kind==='voronoi'?(t.p==='vec3'?'vec3':'vec4'):'float'),
  glsl:(c,a,n,t)=>{const kind=n.kind||'perlin',dim=t.p==='vec3'?3:2,p=t.p==='float'?`vec2(${a.p}, 0.0)`:a.p,arg=a.scale==='1.0'?p:`${p} * ${a.scale}`;
    if(kind==='voronoi'){c.helper('kmgVoronoi'+dim);return `kmgVoronoi${dim}(${arg})`;}
    if(kind==='value'||kind==='perlin'||kind==='simplex'){const f={value:'kmgValue',perlin:'kmgPerlin',simplex:'kmgSimplex'}[kind]+dim;c.helper(f);return `${f}(${arg})`;}
    const oct=Math.max(1,Math.min(8,Math.round(n.octaves||5))),base=['value','perlin','simplex'].includes(n.base)?n.base:'perlin',h=fbmHelper(base,dim,oct,kind);c.helper(h.name,h.code,h.deps,h.stage);
    return `${h.name}(${arg}, ${fmt(n.lacunarity||2)}, ${fmt(n.gain===undefined?.5:n.gain)})`;},
  main:(v,n)=>n.kind==='voronoi'?{expr:v+'.x',type:'float'}:{expr:v,type:'float'},
  ports:(v,n,t)=>n.kind==='voronoi'?{f1:{expr:v+'.x',type:'float'},f2:{expr:v+'.y',type:'float'},edge:{expr:`(${v}.y - ${v}.x)`,type:'float'},cell:{expr:v+'.z',type:'float'},signed:{expr:`(${v}.x * 2.0 - 1.0)`,type:'float'},...(t.p==='vec3'?{}:{angle:{expr:v+'.w',type:'float'}})}:{signed:{expr:`(${v} * 2.0 - 1.0)`,type:'float'}}});
// Math
const U2=['a','b'];
for(const [T,op] of [['Add','+'],['Subtract','-'],['Multiply','*'],['Divide','/']])def(T,{category:'math',inputs:[['a','any',op==='*'||op==='/'?1:0],['b','any',op==='*'||op==='/'?1:0]],unify:U2,glsl:(c,a)=>`(${a.a} ${op} ${a.b})`});
for(const [T,f,d0,d1,names] of [['Min','min',0,0,U2],['Max','max',0,0,U2],['Power','pow',1,1,['base','exp']],['Modulo','mod',0,1,U2],['Atan2','atan',0,1,['y','x']],['Step','step',.5,0,['edge','x']]])
  def(T,{category:'math',inputs:[[names[0],'any',d0],[names[1],'any',d1]],unify:names,glsl:(c,a)=>`${f}(${a[names[0]]}, ${a[names[1]]})`});
for(const [T,f] of [['Abs','abs'],['Floor','floor'],['Ceil','ceil'],['Frac','fract'],['Sqrt','sqrt'],['Sin','sin'],['Cos','cos'],['Tan','tan'],['Exp','exp'],['Log','log'],['Sign','sign'],['Normalize','normalize']])
  def(T,{category:'math',inputs:[['x','any',0]],unify:['x'],glsl:(c,a)=>`${f}(${a.x})`});
def('Saturate',{category:'math',inputs:[['x','any',0]],unify:['x'],glsl:(c,a)=>`clamp(${a.x}, 0.0, 1.0)`});
def('OneMinus',{category:'math',inputs:[['x','any',0]],unify:['x'],glsl:(c,a)=>`(1.0 - ${a.x})`});
def('Negate',{category:'math',inputs:[['x','any',0]],unify:['x'],glsl:(c,a)=>`(-${a.x})`});
def('Length',{category:'math',inputs:[['x','any',0]],out:'float',glsl:(c,a)=>`length(${a.x})`});
def('Clamp',{category:'math',inputs:[['x','any',0],['min','any',0],['max','any',1]],unify:['x','min','max'],glsl:(c,a)=>`clamp(${a.x}, ${a.min}, ${a.max})`});
def('Lerp',{category:'math',inputs:[['a','any',0],['b','any',1],['alpha','any',.5]],unify:['a','b','alpha'],glsl:(c,a)=>`mix(${a.a}, ${a.b}, ${a.alpha})`});
def('Smoothstep',{category:'math',inputs:[['edge0','any',0],['edge1','any',1],['x','any',.5]],unify:['edge0','edge1','x'],glsl:(c,a)=>`smoothstep(${a.edge0}, ${a.edge1}, ${a.x})`});
def('Remap',{category:'math',inputs:[['x','any',0],['inMin','any',0],['inMax','any',1],['outMin','any',0],['outMax','any',1]],unify:['x','inMin','inMax','outMin','outMax'],
  glsl:(c,a,n)=>{const t=`(${a.x} - ${a.inMin}) / (${a.inMax} - ${a.inMin})`;return `mix(${a.outMin}, ${a.outMax}, ${n.clamp?`clamp(${t}, 0.0, 1.0)`:t})`;}});
def('Dot',{category:'math',inputs:[['a','any',0],['b','any',0]],type:(t,n)=>{unify(t,U2,n);return 'float';},unify:U2,unifyType:t=>VEC[Math.max(DIM[t.a],DIM[t.b])],glsl:(c,a)=>`dot(${a.a}, ${a.b})`});
def('Distance',{category:'math',inputs:[['a','any',0],['b','any',0]],type:(t,n)=>{unify(t,U2,n);return 'float';},unify:U2,unifyType:t=>VEC[Math.max(DIM[t.a],DIM[t.b])],glsl:(c,a)=>`distance(${a.a}, ${a.b})`});
def('Cross',{category:'math',inputs:[['a','vec3',[1,0,0]],['b','vec3',[0,1,0]]],out:'vec3',glsl:(c,a)=>`cross(${a.a}, ${a.b})`});
def('Reflect',{category:'math',inputs:[['incident','vec3',[0,0,-1]],['normal','vec3','@worldNormal']],out:'vec3',glsl:(c,a)=>`reflect(${a.incident}, ${a.normal})`});
def('Append',{category:'math',inputs:[['a','any',0],['b','any',0]],type:(t,n)=>{const d=DIM[t.a]+DIM[t.b];if(!(d<=4))throw new GraphError(`Append result would have ${d} components`,n.id,'type');return VEC[d];},glsl:(c,a,n,t,o)=>`${o}(${a.a}, ${a.b})`});
def('Split',{category:'math',inputs:[['x','any',0]],unify:['x'],glsl:(c,a)=>a.x});
const SWZ=/^([xyzw]{1,4}|[rgba]{1,4})$/;
def('ComponentMask',{category:'math',inputs:[['x','any',0]],type:(t,n)=>{const m=String(n.mask||'x');if(!SWZ.test(m))throw new GraphError(`bad mask '${m}'`,n.id,'value');const d=DIM[t.x];
    for(const ch of m)if('xyzwrgba'.indexOf(ch)%4>=d)throw new GraphError(`mask '${m}' reads past ${t.x}`,n.id,'type');return VEC[m.length];},
  glsl:(c,a,n,t,o)=>t.x==='float'?(o==='float'?a.x:`${o}(${a.x})`):`${a.x}.${n.mask||'x'}`});
def('If',{category:'math',inputs:[['a','float',0],['b','float',0],['aGreater','any',1],['equal','any',.5],['aLess','any',0],['threshold','float',1e-5]],unify:['aGreater','equal','aLess'],
  glsl:(c,a)=>`(${a.a} > ${a.b} + ${a.threshold} ? ${a.aGreater} : (${a.a} < ${a.b} - ${a.threshold} ? ${a.aLess} : ${a.equal}))`});
const CMP={'>':(a,b)=>`(1.0 - step(${a}, ${b}))`,'>=':(a,b)=>`step(${b}, ${a})`,'<':(a,b)=>`(1.0 - step(${b}, ${a}))`,'<=':(a,b)=>`step(${a}, ${b})`,'==':(a,b)=>`(1.0 - step(1e-5, abs(${a} - ${b})))`,'!=':(a,b)=>`step(1e-5, abs(${a} - ${b}))`};
def('Compare',{category:'math',inputs:[['a','any',0],['b','any',0]],unify:U2,type:(t,n)=>{if(!CMP[n.op||'>'])throw new GraphError(`Compare.op must be one of ${Object.keys(CMP).join(' ')}`,n.id,'value');return unify(t,U2,n);},glsl:(c,a,n)=>CMP[n.op||'>'](a.a,a.b)});
def('CheapContrast',{category:'math',inputs:[['x','any',.5],['contrast','float',.5]],unify:['x'],glsl:(c,a)=>`clamp(mix(-${a.contrast}, 1.0 + ${a.contrast}, ${a.x}), 0.0, 1.0)`});
// UV and vector utilities
def('Panner',{category:'utility',inputs:[['uv','any','@uv'],['time','float','@time'],['speed','any',[.1,0]]],unify:['uv','speed'],glsl:(c,a)=>`(${a.uv} + ${a.speed} * ${a.time})`});
def('Rotator',{category:'utility',inputs:[['uv','vec2','@uv'],['center','vec2',[.5,.5]],['time','float','@time'],['speed','float',.25],['angle','float',0]],out:'vec2',
  glsl:(c,a)=>{c.helper('kmgRotate2');return `(kmgRotate2(${a.uv} - ${a.center}, ${a.time} * ${a.speed} + ${a.angle}) + ${a.center})`;}});
def('RotateAboutAxis',{category:'utility',inputs:[['axis','vec3',[0,1,0]],['angle','float',0],['pivot','vec3','@objectPos'],['position','vec3','@worldPos']],out:'vec3',
  glsl:(c,a)=>{c.helper('kmgRotateAboutAxis');return `kmgRotateAboutAxis(${a.axis}, ${a.angle}, ${a.pivot}, ${a.position})`;}});
def('TangentToWorld',{category:'utility',stage:'fragment',inputs:[['v','vec3',[0,0,1]]],out:'vec3',glsl:(c,a)=>`(${c.builtin('tbn').expr} * ${a.v})`});
def('WorldToTangent',{category:'utility',stage:'fragment',inputs:[['v','vec3','@worldNormal']],out:'vec3',glsl:(c,a)=>{c.helper('kmgToTangent');return `kmgToTangent(${c.builtin('tbn').expr}, ${a.v})`;}});
def('BlendNormals',{category:'utility',inputs:[['a','vec3',[0,0,1]],['b','vec3',[0,0,1]]],out:'vec3',glsl:(c,a)=>`normalize(vec3(${a.a}.xy + ${a.b}.xy, ${a.a}.z * ${a.b}.z))`});
// Colour and blending
def('HeightLerp',{category:'blend',inputs:[['a','any',0],['b','any',1],['height','float',.5],['transition','float',.5],['contrast','float',.5]],unify:U2,
  glsl:(c,a)=>{c.helper('kmgHeightAlpha');return `mix(${a.a}, ${a.b}, kmgHeightAlpha(${a.height}, ${a.transition}, ${a.contrast}))`;}});
def('Posterize',{category:'color',inputs:[['x','any',0],['steps','float',4]],unify:['x'],glsl:(c,a)=>`(floor(${a.x} * ${a.steps}) / ${a.steps})`});
def('Desaturation',{category:'color',inputs:[['color','vec3',[1,1,1]],['fraction','float',1],['luminance','vec3',[.2126,.7152,.0722]]],out:'vec3',glsl:(c,a)=>`mix(${a.color}, vec3(dot(${a.color}, ${a.luminance})), ${a.fraction})`});
def('HueShift',{category:'color',inputs:[['color','vec3',[1,0,0]],['shift','float',0]],out:'vec3',glsl:(c,a)=>{c.helper('kmgHueShift');return `kmgHueShift(${a.color}, ${a.shift})`;}});
def('Bump',{category:'shading',stage:'fragment',inputs:[['height','float',0],['strength','float',1]],out:'vec3',
  glsl:(c,a,n)=>{c.helper('kmgBumpWorld');const w=`kmgBumpWorld(${c.builtin('worldNormal').expr}, ${c.builtin('worldPos').expr}, ${a.height}, ${a.strength})`;if(n.space==='world')return w;c.helper('kmgToTangent');return `kmgToTangent(${c.builtin('tbn').expr}, ${w})`;}});
def('WorldAlignedBlend',{category:'blend',inputs:[['sharpness','float',4],['bias','float',0],['normal','vec3','@worldNormal'],['direction','vec3',[0,1,0]]],out:'float',
  glsl:(c,a)=>`clamp(dot(normalize(${a.normal}), normalize(${a.direction})) * ${a.sharpness} + ${a.bias}, 0.0, 1.0)`});
def('Dither',{category:'shading',stage:'fragment',inputs:[],out:'float',glsl:c=>{c.helper('kmgIGN');return `kmgIGN(gl_FragCoord.xy + vec2(47.0, 17.0) * mod(${c.global('kmgFrame','float')}, 64.0))`;}});
def('DitherOpacity',{category:'shading',stage:'fragment',inputs:[['opacity','float',1]],out:'float',glsl:(c,a)=>{c.helper('kmgIGN');return `step(kmgIGN(gl_FragCoord.xy + vec2(47.0, 17.0) * mod(${c.global('kmgFrame','float')}, 64.0)), ${a.opacity})`;}});
def('AlphaClip',{category:'shading',inputs:[['value','float',1],['threshold','float',.5]],out:'float',glsl:(c,a)=>`step(${a.threshold}, ${a.value})`});
/* CustomGLSL: a single expression over declared inputs. Identifiers are checked against the inputs and a
   whitelist of GLSL built-ins; statements, assignments, preprocessor directives and blocks are rejected. */
const GLSL_BUILTINS=new Set('sin cos tan asin acos atan pow exp log exp2 log2 sqrt inversesqrt abs sign floor ceil fract mod min max clamp mix step smoothstep length distance dot cross normalize reflect refract faceforward radians degrees float vec2 vec3 vec4 mat2 mat3 mat4 bool true false PI'.split(' '));
const GLSL_RESERVED=new Set('attribute const uniform varying break continue do for while if else in out inout float int void bool true false lowp mediump highp precision invariant discard return mat2 mat3 mat4 vec2 vec3 vec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 sampler2D samplerCube struct asm class union enum typedef template this packed goto switch default inline noinline volatile public static extern external interface long short double half fixed unsigned input output sizeof cast namespace using main texture'.split(' '));
function checkCustom(n){const code=String(n.code||'');if(!code.trim())throw new GraphError('CustomGLSL.code is empty',n.id,'custom');if(code.length>4000)throw new GraphError('CustomGLSL.code is too long',n.id,'custom');
  if(/[#;{}\\"'`$@]/.test(code))throw new GraphError('CustomGLSL.code must be a single expression (no # ; { } quotes)',n.id,'custom');
  if(/(^|[^=!<>])=(?!=)|\+\+|--|[+\-*/%]=/.test(code.replace(/[=!<>]=/g,'  ')))throw new GraphError('CustomGLSL.code may not assign',n.id,'custom');
  const ins=Object.keys(n.inputs||{});for(const k of ins){if(!IDENT.test(k)||GLSL_RESERVED.has(k)||GLSL_BUILTINS.has(k)||/^(gl_|kmg|ke)/.test(k))throw new GraphError(`CustomGLSL input name '${k}' is not allowed`,n.id,'custom');if(!DIM[n.inputs[k]])throw new GraphError(`CustomGLSL input '${k}' type must be float/vec2/vec3/vec4`,n.id,'custom');}
  const stripped=code.replace(/(^|[^A-Za-z0-9_.])(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/g,'$1 0 ');
  const re=/(\.?)\s*([A-Za-z_][A-Za-z0-9_]*)/g;let m;while((m=re.exec(stripped))){const id=m[2];if(m[1]){if(!/^([xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/.test(id))throw new GraphError(`CustomGLSL: bad swizzle '.${id}'`,n.id,'custom');continue;}
    if(/^\d/.test(id))continue;if(!ins.includes(id)&&!GLSL_BUILTINS.has(id))throw new GraphError(`CustomGLSL: identifier '${id}' is not an input or allowed built-in`,n.id,'custom');}
  if(!DIM[n.out||'float'])throw new GraphError('CustomGLSL.out must be float, vec2, vec3 or vec4',n.id,'custom');return ins;}
def('CustomGLSL',{category:'custom',inputs:n=>Object.keys(n.inputs||{}).map(k=>({name:k,type:n.inputs[k],default:0})),type:(t,n)=>{checkCustom(n);return n.out||'float';},
  glsl:(c,a,n,t,o)=>{const ins=checkCustom(n),name='kmgCustom'+c.c.uid();c.helper(name,`${o} ${name}(${ins.map(k=>n.inputs[k]+' '+k).join(', ')}){return ${n.code.replace(/\s+/g,' ')};}`,[],c.stage);return `${name}(${ins.map(k=>a[k]).join(', ')})`;}});
def('Output',{category:'output',virtual:true,inputs:[],out:'float',glsl:()=>'0.0'});
NODES.MaterialOutput=NODES.Output;

/* ---------- material outputs ---------- */
const OUTPUTS={baseColor:{type:'vec3'},metallic:{type:'float'},roughness:{type:'float'},normal:{type:'vec3'},emissive:{type:'vec3'},opacity:{type:'float'},alphaClip:{type:'float'},ao:{type:'float'},
  worldPositionOffset:{type:'vec3',stage:'vertex'},subsurface:{type:'vec3'},clearcoat:{type:'float',physical:true},clearcoatRoughness:{type:'float',physical:true},sheen:{type:'vec3',physical:true},refraction:{type:'float'}};
const OUT_ALIAS={color:'baseColor',albedo:'baseColor',metalness:'metallic',emissiveColor:'emissive',opacityMask:'alphaClip',wpo:'worldPositionOffset',ambientOcclusion:'ao'};
const UNLIT_OUTS=['baseColor','emissive','opacity','alphaClip','refraction'];

/* ---------- graph normalisation ---------- */
const PARAM_TYPES={float:'float',scalar:'float',color:'vec3',vec2:'vec2',vec3:'vec3',vec4:'vec4',texture:'sampler2D'};
function normalizeParam(name,p){if(!IDENT.test(name))throw new GraphError(`param name '${name}' must be an identifier`,null,'param');
  if(p===null||typeof p!=='object'||p.isTexture||p.isColor||Array.isArray(p))p={value:p};
  let type=p.type;if(!type){const v=p.value;type=typeof v==='number'?'float':(typeof v==='string'||(v&&v.isColor))?'color':v&&v.isTexture?'texture':Array.isArray(v)?'vec'+v.length:'float';}
  type=type==='scalar'?'float':type;if(!PARAM_TYPES[type])throw new GraphError(`param '${name}' has unknown type '${type}'`,null,'param');
  const dflt={float:0,color:'#ffffff',vec2:[0,0],vec3:[0,0,0],vec4:[0,0,0,0],texture:null}[type];
  return {...p,name,type,glslType:PARAM_TYPES[type],value:p.value===undefined?dflt:p.value};}
function normalizeGraph(src){
  if(!src||typeof src!=='object')throw new GraphError('graph must be an object',null,'graph');
  if(src.__kmgNormalized)return src;
  const nodes=new Map(),params={};let auto=0;
  for(const [k,v] of Object.entries(src.params||{}))params[k]=normalizeParam(k,v);
  const normVal=v=>(v&&typeof v==='object'&&!Array.isArray(v)&&typeof v.type==='string'&&!v.isTexture&&!v.isColor&&!v.isVector2&&!v.isVector3&&!v.isVector4)?addNode(v):v;
  function addNode(n){if(!n||typeof n!=='object'||typeof n.type!=='string')throw new GraphError('every node needs a string type',n&&n.id,'graph');
    const id=n.id!=null?String(n.id):'_n'+(auto++);if(!/^[A-Za-z0-9_-]+$/.test(id))throw new GraphError(`node id '${id}' may only contain letters, digits, _ and -`,id,'graph');
    if(nodes.has(id))throw new GraphError(`duplicate node id '${id}'`,id,'graph');const node={...n,id,in:{}};nodes.set(id,node);
    for(const [k,v] of Object.entries(n.in||{}))node.in[k]=normVal(v);
    const d=NODES[n.type];if(d&&!d.virtual){const ins=typeof d.inputs==='function'?d.inputs(n):d.inputs;for(const i of ins)if(node.in[i.name]===undefined&&n[i.name]!==undefined&&i.name!=='type'&&i.name!=='id')node.in[i.name]=normVal(n[i.name]);}
    if(n.texture&&n.texture.isTexture){const pn='tex_'+id.replace(/-/g,'_');params[pn]={name:pn,type:'texture',glslType:'sampler2D',value:n.texture,hidden:true};node.param=pn;delete node.texture;}
    if(n.type==='Param'&&n.name&&!params[n.name]&&n.paramType)params[n.name]=normalizeParam(n.name,{type:n.paramType,value:n.value});
    return id;}
  for(const n of src.nodes||[])addNode(n);
  const outputs={},take=(k,v)=>{const name=OUT_ALIAS[k]||k;if(!OUTPUTS[name])throw new GraphError(`unknown material output '${k}'`,null,'output');if(v!==undefined&&v!==null)outputs[name]=normVal(v);};
  for(const [k,v] of Object.entries(src.outputs||src.output||{}))take(k,v);
  for(const n of nodes.values())if(n.type==='Output'||n.type==='MaterialOutput')for(const [k,v] of Object.entries(n.in))if(outputs[OUT_ALIAS[k]||k]===undefined)take(k,v);
  return {__kmgNormalized:true,nodes,params,outputs,source:src};
}
/* Cycle detection over the whole graph (not only reachable nodes) with a DFS colouring. */
function findCycle(g){const state=new Map(),stack=[];
  const refsOf=n=>Object.values(n.in).filter(isRef).map(v=>parseRef(v).id);
  const visit=id=>{const s=state.get(id);if(s===2)return null;if(s===1)return stack.slice(stack.indexOf(id)).concat(id);const n=g.nodes.get(id);if(!n)return null;state.set(id,1);stack.push(id);
    for(const r of refsOf(n)){const c=visit(r);if(c)return c;}stack.pop();state.set(id,2);return null;};
  for(const id of g.nodes.keys()){const c=visit(id);if(c)return c;}return null;}

/* ---------- code generation ---------- */
class Compiler{
  constructor(g,opts){this.g=g;this.opts=opts;this.uniforms=new Map();this.varyings=new Set();this.counter=0;this.warnings=[];}
  uid(){return this.counter++;}
  paramGlsl(name){const keys=Object.keys(this.g.params).sort();return `kmgP${keys.indexOf(name)}_${name}`;}
}
class Ctx{
  constructor(c,stage){this.c=c;this.stage=stage;this.lines=[];this.done=new Map();this.visiting=[];this.helpers=new Map();this.pre=new Set();this.uniforms=new Map();this.attrs=new Set();}
  emit(line){this.lines.push(line);}
  tmp(type,expr){if(IDENT.test(expr)||/^\(?-?[\d.]+(e[-+]?\d+)?\)?$/.test(expr))return expr;const n=`kmg${this.stage[0]}${this.c.uid()}`;this.emit(`${type} ${n} = ${expr};`);return n;}
  helper(name,code,deps=[],stage){if(this.helpers.has(name))return name;let h=HELPERS[name];if(!h){if(!code)throw new Error('KE.MaterialGraph: unknown helper '+name);h={name,code,deps,stage:stage||'any'};}
    if(h.stage!=='any'&&h.stage!==this.stage)throw new GraphError(`helper ${name} is ${h.stage}-only`,null,'stage');for(const d of h.deps)this.helper(d);this.helpers.set(name,h.code);return name;}
  uniform(name,type,source){this.uniforms.set(name,type);this.c.uniforms.set(name,{type,source});return name;}
  global(name,type){return this.uniform(name,type,{global:name});}
  paramType(name,node){const p=this.c.g.params[name];if(!p)throw new GraphError(`unknown param '${name}'`,node,'param');return p.glslType;}
  paramExpr(name,node,want){const t=this.paramType(name,node);if(want&&t!==want)throw new GraphError(`param '${name}' is ${t}, expected ${want}`,node,'type');return this.uniform(this.c.paramGlsl(name),t,{param:name});}
  varying(name){this.c.varyings.add(name);}
  once(key,type,expr){if(!this.pre.has(key)){this.pre.add(key);this.emit(`${type} ${key} = ${expr};`);}return key;}
  /* Built-in inputs per stage. Fragment values come from varyings written by the injected vertex code. */
  builtin(name){const F=this.stage==='fragment';
    switch(name){
      case 'uv':if(F){this.varying('uv');return {expr:'vKmgUv',type:'vec2'};}return {expr:'uv',type:'vec2'};
      case 'uv2':if(F){this.varying('uv2');return {expr:'vKmgUv2',type:'vec2'};}this.attrs.add('uv2');return {expr:'uv2',type:'vec2'};
      case 'worldPos':if(F){this.varying('worldPos');return {expr:'vKmgWorldPos',type:'vec3'};}return {expr:'kmgWP',type:'vec3'};
      case 'worldNormal':if(F){this.varying('worldNormal');if(!this.pre.has('kmgN')){this.pre.add('kmgN');this.emit('vec3 kmgN = normalize(vKmgWorldNormal);\n#ifdef DOUBLE_SIDED\nkmgN *= gl_FrontFacing ? 1.0 : -1.0;\n#endif');}return {expr:'kmgN',type:'vec3'};}return {expr:'kmgWN',type:'vec3'};
      case 'viewDir':{const p=this.builtin('worldPos').expr;return {expr:this.once(F?'kmgV':'kmgVV','vec3',`isOrthographic ? normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2])) : normalize(cameraPosition - ${p})`),type:'vec3'};}
      case 'time':return {expr:this.global('kmgTime','float'),type:'float'};
      case 'objectPos':if(F){this.varying('objectPos');return {expr:'vKmgObjPos',type:'vec3'};}return {expr:'kmgModel[3].xyz',type:'vec3'};
      case 'vertexColor':if(F){this.varying('color');return {expr:'vKmgColor',type:'vec3'};}this.attrs.add('color');return {expr:'kmgVC',type:'vec3'};
      case 'screenUV':if(!F)throw new GraphError('screen UV is fragment-only',null,'stage');this.varying('clip');return {expr:this.once('kmgScreenUV','vec2','vKmgClip.xy / vKmgClip.w * 0.5 + 0.5'),type:'vec2'};
      case 'pixelDepth':{const p=this.builtin('worldPos').expr;return {expr:this.once(F?'kmgPixelDepth':'kmgPixelDepthV','float',`-(viewMatrix * vec4(${p}, 1.0)).z`),type:'float'};}
      case 'tbn':{if(!F)throw new GraphError('tangent frame is fragment-only',null,'stage');const n=this.builtin('worldNormal').expr,p=this.builtin('worldPos').expr,uv=this.builtin('uv').expr;this.helper('kmgTangentFrame');
        return {expr:this.once('kmgTBN','mat3',`kmgTangentFrame(${n}, ${p}, ${uv})`),type:'mat3'};}
    }
    throw new GraphError(`unknown built-in '@${name}'`,null,'input');}
  value(v,node,what){
    if(v===undefined||v===null)return null;
    if(typeof v==='string'&&v[0]==='@')return this.builtin(v.slice(1));
    const l=literal(v);if(l)return l;
    if(isRef(v))return this.ref(v,node);
    if(v&&v.isTexture)throw new GraphError(`${what}: put textures in a texture param or the node's 'texture' property`,node,'input');
    throw new GraphError(`${what}: invalid value ${JSON.stringify(v)}`,node,'input');}
  ref(v,from){const {id,port}=parseRef(v);const n=this.c.g.nodes.get(id);if(!n)throw new GraphError(`unknown node '${id}'`,from,'ref');return this.port(this.node(n),port,id);}
  port(r,port,id){if(!port)return r.main;if(r.ports&&r.ports[port])return r.ports[port];
    if(SWZ.test(port)){const t=r.main.type;if(t==='sampler2D')throw new GraphError('cannot swizzle a texture',id,'type');const d=DIM[t];
      for(const ch of port)if('xyzwrgba'.indexOf(ch)%4>=d)throw new GraphError(`swizzle '.${port}' reads past ${t}`,id,'type');
      if(t==='float')return port.length===1?r.main:{expr:`${VEC[port.length]}(${r.main.expr})`,type:VEC[port.length]};
      return {expr:`${r.main.expr}.${port}`,type:VEC[port.length]};}
    throw new GraphError(`node has no output '${port}'`,id,'ref');}
  node(n){
    if(this.done.has(n.id))return this.done.get(n.id);
    if(this.visiting.includes(n.id))throw new GraphError('cycle: '+this.visiting.slice(this.visiting.indexOf(n.id)).concat(n.id).join(' -> '),n.id,'cycle');
    const d=NODES[n.type];if(!d)throw new GraphError(`unknown node type '${n.type}'`,n.id,'type');
    if(d.virtual)throw new GraphError(`${n.type} nodes cannot be connected as inputs`,n.id,'ref');
    if(d.stage==='fragment'&&this.stage==='vertex')throw new GraphError(`${n.type} is fragment-only and cannot feed worldPositionOffset`,n.id,'stage');
    this.visiting.push(n.id);
    try{
      const a={},t={},ins=typeof d.inputs==='function'?d.inputs(n):d.inputs;
      for(const i of ins){let r=this.value(n.in[i.name],n.id,`input '${i.name}'`);if(!r&&i.default!=null)r=this.value(i.default,n.id,`default of '${i.name}'`);
        if(!r){if(i.type==='sampler2D'){a[i.name]=null;t[i.name]=null;continue;}throw new GraphError(`missing input '${i.name}'`,n.id,'input');}
        if(i.type==='sampler2D'&&r.type!=='sampler2D')throw new GraphError(`input '${i.name}' expects a texture, got ${r.type}`,n.id,'type');
        if(i.type!=='any'&&i.type!=='sampler2D'&&r.type!==i.type)r={expr:cast(r.expr,r.type,i.type,n.id,`input '${i.name}'`),type:i.type};
        a[i.name]=r.expr;t[i.name]=r.type;}
      const out=d.type?d.type(t,n,this):d.out?d.out:unify(t,d.unify||ins.map(i=>i.name),n);
      if(d.unify){const ut=d.unifyType?d.unifyType(t):out;for(const k of d.unify)if(a[k]!=null&&t[k]!==ut)a[k]=cast(a[k],t[k],ut,n.id,`input '${k}'`);}
      const raw=d.raw?d.raw(t,n):out,expr=d.glsl(this,a,n,t,out);
      const v=raw==='sampler2D'?expr:this.tmp(raw,expr);
      const r={main:d.main?d.main(v,n,t):{expr:v,type:out},ports:d.ports?d.ports(v,n,t):null};
      this.done.set(n.id,r);return r;
    }finally{this.visiting.pop();}
  }
  helperCode(){return [...this.helpers.values()].join('\n');}
  uniformDecl(){return [...this.uniforms].map(([n,t])=>`uniform ${t} ${n};`).join('\n');}
}
const VARYINGS={uv:'vec2 vKmgUv',uv2:'vec2 vKmgUv2',worldPos:'vec3 vKmgWorldPos',worldNormal:'vec3 vKmgWorldNormal',objectPos:'vec3 vKmgObjPos',color:'vec3 vKmgColor',clip:'vec4 vKmgClip'};
const VARY_SET={uv:'vKmgUv = uv;',uv2:'vKmgUv2 = uv2;',worldPos:'vKmgWorldPos = kmgWP;',worldNormal:'vKmgWorldNormal = kmgWN;',objectPos:'vKmgObjPos = kmgModel[3].xyz;',color:'vKmgColor = kmgVC;'};

/* Compile a graph for one material model. mode 'depth' evaluates only alphaClip (+ WPO) for shadow passes. */
function compileGraph(src,opts={},mode='full'){
  const g=normalizeGraph(src),model=opts.model||'standard';
  if(!['standard','physical','unlit'].includes(model))throw new GraphError(`unknown model '${model}'`,null,'model');
  const cyc=findCycle(g);if(cyc)throw new GraphError('cycle: '+cyc.join(' -> '),cyc[0],'cycle');
  const c=new Compiler(g,opts),F=new Ctx(c,'fragment'),V=new Ctx(c,'vertex'),outs={};
  const names=Object.keys(OUTPUTS).filter(k=>OUTPUTS[k].stage!=='vertex'&&g.outputs[k]!==undefined);
  for(const k of names){
    if(OUTPUTS[k].physical&&model!=='physical')throw new GraphError(`output '${k}' requires model 'physical'`,null,'output');
    if(model==='unlit'&&!UNLIT_OUTS.includes(k)){c.warnings.push(`output '${k}' is ignored by the unlit model`);continue;}
    if(mode==='depth'&&k!=='alphaClip')continue;
    const r=F.value(g.outputs[k],null,`output '${k}'`),want=OUTPUTS[k].type;
    let expr=r.expr;if(r.type!==want){if(r.type==='sampler2D'||(DIM[r.type]>1&&want==='float')||(r.type==='vec2'))throw new GraphError(`output '${k}' expects ${want}, got ${r.type}`,null,'type');expr=cast(expr,r.type,want,null,`output '${k}'`);}
    F.emit(`${want} kmgO_${k} = ${expr};`);outs[k]=`kmgO_${k}`;}
  if(mode!=='depth'){
    if(outs.normal&&(opts.normalSpace||'tangent')==='tangent')F.builtin('tbn');
    if(outs.refraction){F.builtin('screenUV');F.builtin('pixelDepth');if(model==='unlit')F.builtin('worldNormal');F.global('kmgHasScene','float');F.global('kmgSceneColor','sampler2D');F.global('kmgSceneDepth','sampler2D');}
  }
  let wpo=null;if(g.outputs.worldPositionOffset!==undefined){const r=V.value(g.outputs.worldPositionOffset,null,"output 'worldPositionOffset'");wpo=cast(r.expr,r.type,'vec3',null,"output 'worldPositionOffset'");V.helper('kmgInverse3');}
  const vary=[...c.varyings];if(vary.includes('color'))V.attrs.add('color');if(vary.includes('uv2'))V.attrs.add('uv2');
  // vertex code
  const vDecl=[V.uniformDecl(),vary.map(v=>`varying ${VARYINGS[v]};`).join('\n'),
    V.attrs.has('color')?'#if !defined( USE_COLOR ) && !defined( USE_COLOR_ALPHA )\nattribute vec3 color;\n#endif':'',
    V.attrs.has('uv2')?'#if !defined( USE_LIGHTMAP ) && !defined( USE_AOMAP )\nattribute vec2 uv2;\n#endif':'',V.helperCode()].filter(Boolean).join('\n');
  const normalExpr=mode==='depth'?'normalize(mat3(kmgModel) * normal)':'normalize((vec4(transformedNormal, 0.0) * viewMatrix).xyz)';
  const vMain=['#ifdef USE_INSTANCING','mat4 kmgModel = modelMatrix * instanceMatrix;','#else','mat4 kmgModel = modelMatrix;','#endif',
    'vec3 kmgWP = (kmgModel * vec4(transformed, 1.0)).xyz;',`vec3 kmgWN = ${normalExpr};`,
    V.attrs.has('color')?'#ifdef USE_COLOR_ALPHA\nvec3 kmgVC = color.rgb;\n#else\nvec3 kmgVC = color;\n#endif\n#ifdef USE_INSTANCING_COLOR\nkmgVC *= instanceColor;\n#endif':'',
    ...V.lines,wpo?`vec3 kmgWPO = ${wpo};\ntransformed += kmgInverse3(mat3(kmgModel)) * kmgWPO;\nkmgWP += kmgWPO;`:'',
    ...vary.filter(v=>VARY_SET[v]).map(v=>VARY_SET[v])].filter(Boolean).join('\n');
  const vPost=vary.includes('clip')?'vKmgClip = gl_Position;':'';
  // fragment code
  const fDecl=[F.uniformDecl(),vary.map(v=>`varying ${VARYINGS[v]};`).join('\n'),outs.subsurface?'vec3 kmgSSSColor = vec3(0.0);':'',F.helperCode()].filter(Boolean).join('\n');
  const fBody=F.lines.join('\n')+(outs.subsurface?'\nkmgSSSColor = kmgO_subsurface;':'');
  const toon=model!=='unlit'&&opts.toon?{steps:Math.max(1,Math.round(opts.toon.steps||3)),smooth:opts.toon.smoothness===undefined?.06:opts.toon.smoothness}:null;
  const sss=outs.subsurface?{wrap:.5,distortion:.25,power:4,scale:1,...(opts.subsurface||{})}:null;
  const res={model,mode,outputs:outs,wpo:!!wpo,vDecl,vMain,vPost,fDecl,fBody,toon,sss,normalSpace:opts.normalSpace||'tangent',clip:opts.alphaClipThreshold===undefined?.5:opts.alphaClipThreshold,
    uniforms:c.uniforms,warnings:c.warnings,graph:g,varyings:vary};
  res.key=hashString([model,mode,res.normalSpace,res.clip,JSON.stringify(toon),JSON.stringify(sss),vDecl,vMain,vPost,fDecl,fBody,Object.keys(outs).join()].join('|'));
  return res;
}

/* ---------- shader patching ---------- */
const need=(src,anchor,label)=>{if(src.indexOf(anchor)<0)throw new Error(`KE.MaterialGraph: shader patch target '${anchor}' not found (${label})`);};
const after=(src,anchor,code,label='')=>{need(src,anchor,label);return src.replace(anchor,()=>anchor+'\n'+code);};
const before=(src,anchor,code,label='')=>{need(src,anchor,label);return src.replace(anchor,()=>code+'\n'+anchor);};
function patchVertex(vs,cp){
  vs=after(vs,'#include <common>',cp.vDecl,'vertex declarations');
  need(vs,'#include <project_vertex>','vertex main');
  return vs.replace('#include <project_vertex>',()=>cp.vMain+'\n#include <project_vertex>'+(cp.vPost?'\n'+cp.vPost:''));
}
/* Toon ramp and subsurface/translucency go into RE_Direct_Physical, so every punctual light (directional,
   point, spot; shadowed colour included) gets them, whichever lights_fragment_begin variant runs. */
function patchedLightsChunk(THREE,cp){
  const src=THREE.ShaderChunk.lights_physical_pars_fragment,m=/void\s+RE_Direct_Physical\s*\(/.exec(src);
  if(!m)throw new Error('KE.MaterialGraph: RE_Direct_Physical not found in lights_physical_pars_fragment');
  let head=src.slice(0,m.index),body=src.slice(m.index),fns='';
  const reNL=/float\s+dotNL\s*=\s*saturate\(\s*dot\(\s*geometry\.normal\s*,\s*directLight\.direction\s*\)\s*\)\s*;/;
  const reDiff=/reflectedLight\.directDiffuse\s*\+=[^;]*BRDF_Diffuse_Lambert\(\s*material\.diffuseColor\s*\)\s*;/;
  if(cp.toon){if(!reNL.test(body))throw new Error('KE.MaterialGraph: toon patch target (dotNL) not found');const s=fmt(cp.toon.steps),w=fmt(Math.max(cp.toon.smooth,1e-3));
    fns+=`float kmgToonRamp(float x){float b=floor(x*${s}+.5);float f=x*${s}+.5-b;return clamp((b-1.+smoothstep(.5-${w},.5+${w},f))/${s}+.5/${s},0.,1.);}\n`;
    body=body.replace(reNL,x=>x+'\ndotNL = kmgToonRamp(dotNL);');}
  if(cp.sss){if(!reDiff.test(body))throw new Error('KE.MaterialGraph: subsurface patch target (directDiffuse) not found');const S=cp.sss;
    fns+=`vec3 kmgSubsurface(const in IncidentLight L,const in GeometricContext g){float nl=dot(g.normal,L.direction);float wrap=max((nl+${fmt(S.wrap)})/(1.+${fmt(S.wrap)}),0.)-max(nl,0.);
vec3 h=normalize(L.direction+g.normal*${fmt(S.distortion)});float back=pow(clamp(dot(g.viewDir,-h),0.,1.),${fmt(S.power)})*${fmt(S.scale)};vec3 r=L.color*kmgSSSColor*(max(wrap,0.)+back);
#ifdef PHYSICALLY_CORRECT_LIGHTS
r*=RECIPROCAL_PI;
#endif
return r;}\n`;
    body=body.replace(reDiff,x=>x+'\nreflectedLight.directDiffuse += kmgSubsurface(directLight, geometry);');}
  return head+fns+body;
}
const REFRACT_TARGET=/gl_FragColor\s*=\s*vec4\(\s*outgoingLight\s*,\s*diffuseColor\.a\s*\)\s*;/;
function patchFragment(THREE,fs,cp){
  const o=cp.outputs;
  fs=after(fs,'#include <common>',cp.fDecl,'fragment declarations');
  fs=before(fs,'#include <map_fragment>',cp.fBody,'graph body');
  let post='';if(o.baseColor)post+=`diffuseColor.rgb = ${o.baseColor};\n`;if(o.opacity)post+=`diffuseColor.a = ${o.opacity};\n`;if(o.alphaClip)post+=`if (${o.alphaClip} < ${fmt(cp.clip)}) discard;\n`;
  if(post)fs=after(fs,'#include <color_fragment>',post,'base colour');
  if(o.metallic)fs=after(fs,'#include <metalnessmap_fragment>',`metalnessFactor = ${o.metallic};`,'metallic');
  if(o.roughness)fs=after(fs,'#include <roughnessmap_fragment>',`roughnessFactor = ${o.roughness};`,'roughness');
  if(o.normal)fs=after(fs,'#include <normal_fragment_maps>',cp.normalSpace==='world'?`normal = normalize((viewMatrix * vec4(${o.normal}, 0.0)).xyz);`:`normal = normalize((viewMatrix * vec4(kmgTBN * ${o.normal}, 0.0)).xyz);`,'normal');
  if(o.emissive)fs=after(fs,'#include <emissivemap_fragment>',`totalEmissiveRadiance = ${o.emissive};`,'emissive');
  if(o.clearcoat||o.clearcoatRoughness||o.sheen)fs=after(fs,'#include <lights_physical_fragment>',
    (o.clearcoat?`#ifdef CLEARCOAT\nmaterial.clearcoat = clamp(${o.clearcoat}, 0.0, 1.0);\n#endif\n`:'')+(o.clearcoatRoughness?`#ifdef CLEARCOAT\nmaterial.clearcoatRoughness = min(max(${o.clearcoatRoughness}, 0.0525) + geometryRoughness, 1.0);\n#endif\n`:'')+(o.sheen?`#ifdef USE_SHEEN\nmaterial.sheenColor = ${o.sheen};\n#endif\n`:''),'physical');
  if(o.ao)fs=after(fs,'#include <aomap_fragment>',`reflectedLight.indirectDiffuse *= ${o.ao};\n#if defined( USE_ENVMAP ) && defined( STANDARD )\nreflectedLight.indirectSpecular *= computeSpecularOcclusion(saturate(dot(geometry.normal, geometry.viewDir)), ${o.ao}, material.specularRoughness);\n#endif`,'ao');
  if(o.refraction){if(!REFRACT_TARGET.test(fs))throw new Error('KE.MaterialGraph: refraction patch target (gl_FragColor = vec4( outgoingLight, diffuseColor.a )) not found');
    fs=fs.replace(REFRACT_TARGET,x=>x+`\n{float kmgA = diffuseColor.a;vec3 kmgSpec = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
if (kmgHasScene > 0.5) {vec2 kmgRUV = kmgScreenUV - normal.xy * ${o.refraction} * 0.05;if (texture2D(kmgSceneDepth, kmgRUV).r < kmgPixelDepth) kmgRUV = kmgScreenUV;
gl_FragColor = vec4((outgoingLight - kmgSpec) * kmgA + kmgSpec + texture2D(kmgSceneColor, kmgRUV).rgb * diffuseColor.rgb * (1.0 - kmgA), 1.0);}
else {float kmgA2 = clamp(kmgA + dot(kmgSpec, vec3(0.2126, 0.7152, 0.0722)), 1e-4, 1.0);gl_FragColor = vec4(((outgoingLight - kmgSpec) * kmgA + kmgSpec) / kmgA2, kmgA2);}}`);}
  if(cp.sss||cp.toon){need(fs,'#include <lights_physical_pars_fragment>','lighting');fs=fs.replace('#include <lights_physical_pars_fragment>',()=>patchedLightsChunk(THREE,cp));}
  return fs;
}
function patchDepthFragment(fs,cp){
  fs=after(fs,'#include <common>',cp.fDecl,'depth declarations');
  fs=before(fs,'#include <map_fragment>',cp.fBody+(cp.outputs.alphaClip?`\nif (${cp.outputs.alphaClip} < ${fmt(cp.clip)}) discard;`:''),'depth body');
  return fs;
}
function unlitShaders(cp){
  const o=cp.outputs,vs=`#include <common>
#include <fog_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
#include <beginnormal_vertex>
#include <morphnormal_vertex>
#include <skinbase_vertex>
#include <skinnormal_vertex>
#include <defaultnormal_vertex>
#include <begin_vertex>
#include <morphtarget_vertex>
#include <skinning_vertex>
#include <project_vertex>
#include <logdepthbuf_vertex>
#include <clipping_planes_vertex>
#include <fog_vertex>
}`;
  const refr=o.refraction?`if (kmgHasScene > 0.5) {vec3 kmgVN = normalize((viewMatrix * vec4(kmgN, 0.0)).xyz);vec2 kmgRUV = kmgScreenUV - kmgVN.xy * ${o.refraction} * 0.05;if (texture2D(kmgSceneDepth, kmgRUV).r < kmgPixelDepth) kmgRUV = kmgScreenUV;
gl_FragColor = vec4(kmgColor * kmgAlpha + texture2D(kmgSceneColor, kmgRUV).rgb * ${o.baseColor||'vec3(1.0)'} * (1.0 - kmgAlpha), 1.0);}`:'';
  const fs=`#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
#include <clipping_planes_pars_fragment>
${cp.fDecl}
void main() {
#include <clipping_planes_fragment>
#include <logdepthbuf_fragment>
${cp.fBody}
vec3 kmgColor = ${o.emissive||o.baseColor||'vec3(1.0)'};
float kmgAlpha = ${o.opacity||'1.0'};
${o.alphaClip?`if (${o.alphaClip} < ${fmt(cp.clip)}) discard;`:''}
gl_FragColor = vec4(kmgColor, kmgAlpha);
${refr}
#include <tonemapping_fragment>
#include <encodings_fragment>
#include <fog_fragment>
#include <premultiplied_alpha_fragment>
}`;
  return {vertexShader:patchVertex(vs,cp),fragmentShader:fs};
}

/* ---------- params, uniforms and material state ---------- */
const STATE=new WeakMap(),SHARED=new Map();
const clock={t:0,manual:false,start:typeof performance!=='undefined'?performance.now():Date.now()};
const timeUniform={get value(){return clock.manual?clock.t:((typeof performance!=='undefined'?performance.now():Date.now())-clock.start)/1000;}};
function sharedTextures(THREE){let s=SHARED.get(THREE);if(s)return s;const mk=rgba=>{const t=new THREE.DataTexture(new Uint8Array(rgba),1,1,THREE.RGBAFormat);t.needsUpdate=true;return t;};
  s={white:mk([255,255,255,255]),black:mk([0,0,0,255]),normal:mk([128,128,255,255]),gray:mk([128,128,128,255])};SHARED.set(THREE,s);return s;}
function globalUniform(THREE,name){const S=KE.sceneUniforms(THREE);
  const map={kmgTime:timeUniform,kmgHasScene:S.keHasScene,kmgSceneDepth:S.keSceneDepth,kmgSceneColor:S.keSceneColor,kmgNearFar:S.keNearFar,kmgFrame:S.keFrame,kmgSunDir:S.keSunDirection,kmgSunColor:S.keSunColor};
  if(!map[name])throw new Error('KE.MaterialGraph: unknown global uniform '+name);return map[name];}
/* A param's uniform. Instance uniforms read through to the parent until overridden, so parent edits propagate. */
class ParamUniform{constructor(parent,value){this.parent=parent||null;this.own=!parent;this.v=value;}
  get value(){return this.own?this.v:this.parent.value;}set value(x){this.v=x;this.own=true;}
  reset(){if(this.parent){this.own=false;this.v=undefined;}}}
function toParamValue(THREE,p,v,cur){
  switch(p.type){
    case 'float':{const n=+v;if(!Number.isFinite(n))throw new TypeError(`param '${p.name}' expects a number`);return n;}
    case 'color':{const c=cur&&cur.isColor?cur:new THREE.Color();if(v&&v.isColor)return c.copy(v);if(typeof v==='string'||typeof v==='number'){c.set(v);return c.convertSRGBToLinear();}
      if(Array.isArray(v)&&v.length>=3)return c.setRGB(v[0],v[1],v[2]);throw new TypeError(`param '${p.name}' expects a colour`);}
    case 'vec2':case 'vec3':case 'vec4':{const n=+p.type[3],C={2:THREE.Vector2,3:THREE.Vector3,4:THREE.Vector4}[n],o=cur&&cur instanceof C?cur:new C();
      if(Array.isArray(v)&&v.length===n)return o.fromArray(v);if(v&&typeof v.x==='number')return o.copy(v);if(typeof v==='number')return o.setScalar(v);throw new TypeError(`param '${p.name}' expects ${p.type}`);}
    case 'texture':if(v==null)return sharedTextures(THREE)[p.fallback||'white']||sharedTextures(THREE).white;if(v.isTexture)return v;throw new TypeError(`param '${p.name}' expects a THREE.Texture`);
  }
  throw new TypeError('unknown param type '+p.type);
}
function paramUniforms(THREE,cp,parentState){const pu={};
  for(const [name,p] of Object.entries(cp.graph.params))pu[name]=parentState?new ParamUniform(parentState.pu[name]):new ParamUniform(null,toParamValue(THREE,p,p.value,null));return pu;}
function uniformMap(THREE,cp,pu){const map={};for(const [glsl,u] of cp.uniforms)map[glsl]=u.source.param?pu[u.source.param]:globalUniform(THREE,u.source.global);return map;}
const SIDES=THREE=>({front:THREE.FrontSide,back:THREE.BackSide,double:THREE.DoubleSide});
const BLENDS=THREE=>({normal:THREE.NormalBlending,additive:THREE.AdditiveBlending,multiply:THREE.MultiplyBlending,subtractive:THREE.SubtractiveBlending,none:THREE.NoBlending});
function makeMaterial(THREE,cp,opts){
  let m;
  if(cp.model==='unlit'){const sh=unlitShaders(cp);m=new THREE.ShaderMaterial({vertexShader:sh.vertexShader,fragmentShader:sh.fragmentShader,uniforms:{},fog:opts.fog!==false,lights:false});m.extensions.derivatives=true;}
  else{m=cp.model==='physical'?new THREE.MeshPhysicalMaterial():new THREE.MeshStandardMaterial();if(cp.outputs.sheen)m.sheen=new THREE.Color(0,0,0);}
  const o=cp.outputs,transparent=opts.transparent!==undefined?!!opts.transparent:!!(o.opacity||o.refraction);
  m.name=opts.name||'ke-material-graph';m.transparent=transparent;
  if(opts.side!==undefined)m.side=typeof opts.side==='string'?SIDES(THREE)[opts.side]:opts.side;
  if(opts.blending!==undefined)m.blending=typeof opts.blending==='string'?BLENDS(THREE)[opts.blending]:opts.blending;
  m.depthWrite=opts.depthWrite!==undefined?!!opts.depthWrite:!transparent;
  if(opts.depthTest!==undefined)m.depthTest=!!opts.depthTest;
  if(opts.flatShading)m.flatShading=true;
  if(opts.material)for(const [k,v] of Object.entries(opts.material)){if(m[k]&&m[k].isColor)m[k].set(v);else m[k]=v;}
  return m;
}
function install(THREE,m,st){
  STATE.set(m,st);const cp=st.shared.cp;
  if(cp.model==='unlit'){m.uniforms=Object.assign(THREE.UniformsUtils.clone(THREE.UniformsLib.fog),uniformMap(THREE,cp,st.pu));}
  else{const prev=st.prevHook||null,prevKey=st.prevKey||null;
    m.onBeforeCompile=function(shader,renderer){if(prev)prev.call(this,shader,renderer);Object.assign(shader.uniforms,uniformMap(THREE,cp,st.pu));
      shader.vertexShader=patchVertex(shader.vertexShader,cp);shader.fragmentShader=patchFragment(THREE,shader.fragmentShader,cp);MG.stats.patches++;};
    m.customProgramCacheKey=()=>(prevKey?prevKey()+'|':'')+'kmg-'+cp.key;
    m.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv2:[0,0]};}
  const params={};
  for(const name of Object.keys(cp.graph.params))Object.defineProperty(params,name,{enumerable:!cp.graph.params[name].hidden,get:()=>st.pu[name].value,set:v=>setParam(m,name,v)});
  Object.preventExtensions(params);
  Object.defineProperties(m,{params:{value:params,configurable:true},graph:{value:cp.graph.source,configurable:true},
    glsl:{value:{vertex:cp.vDecl+'\n/* main */\n'+cp.vMain,fragment:cp.fDecl+'\n/* main */\n'+cp.fBody,key:cp.key,outputs:Object.keys(cp.outputs).concat(cp.wpo?['worldPositionOffset']:[])},configurable:true},
    paramInfo:{value:Object.values(cp.graph.params).filter(p=>!p.hidden).map(p=>({name:p.name,type:p.type,min:p.min,max:p.max,label:p.label||p.name,group:p.group||null,default:p.value})),configurable:true},
    setParam:{value:(n,v)=>{setParam(m,n,v);return m;},configurable:true},getParam:{value:n=>{if(!st.pu[n])throw new Error(`unknown param '${n}'`);return st.pu[n].value;},configurable:true},
    resetParam:{value:n=>{if(!st.pu[n])throw new Error(`unknown param '${n}'`);st.pu[n].reset();return m;},configurable:true},
    isMaterialGraph:{value:true,configurable:true},
    /* clone() returns an instance with every parameter copied: independent values, same program. */
    clone:{value:function(){const c=MG.instance(m);for(const n of Object.keys(st.pu)){const v=st.pu[n].value;setParam(c,n,v&&v.isTexture?v:v&&v.clone?v.clone():v);}return c;},configurable:true,writable:true}});
  if(!st.disposeHooked){st.disposeHooked=true;m.addEventListener('dispose',()=>{if(st.shadow){st.shadow.depth.dispose();st.shadow.distance.dispose();st.shadow=null;}});}
  return m;
}
function setParam(m,name,v){const st=STATE.get(m);if(!st)throw new Error('not a material graph material');const p=st.shared.cp.graph.params[name];if(!p)throw new Error(`unknown param '${name}'`);
  const u=st.pu[name];u.value=toParamValue(st.THREE,p,v,u.own?u.v:null);}
/* Depth/distance materials carrying the same WPO and alpha clip, for shadow maps (see bind()). */
function shadowMaterials(m){const st=STATE.get(m);if(!st)return null;const sh=st.shared,THREE=st.THREE;if(!sh.cp.wpo&&!sh.cp.outputs.alphaClip)return null;if(st.shadow)return st.shadow;
  if(!sh.depthCp)sh.depthCp=compileGraph(sh.cp.graph,sh.opts,'depth');const dcp=sh.depthCp;
  const setup=mat=>{mat.onBeforeCompile=shader=>{Object.assign(shader.uniforms,uniformMap(THREE,dcp,st.pu));shader.vertexShader=patchVertex(shader.vertexShader,dcp);shader.fragmentShader=patchDepthFragment(shader.fragmentShader,dcp);};
    mat.customProgramCacheKey=()=>'kmg-depth-'+dcp.key;mat.extensions={derivatives:true};mat.defaultAttributeValues={color:[1,1,1],uv:[0,0],uv2:[0,0]};return mat;};
  st.shadow={depth:setup(new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking})),distance:setup(new THREE.MeshDistanceMaterial())};return st.shadow;}

/* ---------- public API ---------- */
const MG={
  GraphError,nodeTypes:NODES,outputs:OUTPUTS,helpers:HELPERS,stats:{compiles:0,patches:0},time:timeUniform,
  registerNode,
  registerHelper(name,code,deps=[],stage='any'){if(!/^kmg/.test(name))throw new Error('helper names must start with kmg');helper(name,deps,code,stage);},
  /* Compile a graph into a material. */
  compile(THREE,graph,opts={}){const cp=compileGraph(graph,opts);MG.stats.compiles++;const m=makeMaterial(THREE,cp,opts);
    install(THREE,m,{THREE,shared:{cp,opts},pu:paramUniforms(THREE,cp,null),parent:null,shadow:null});
    if(cp.warnings.length&&opts.warn)console.warn('KE.MaterialGraph: '+cp.warnings.join('; '));return m;},
  /* Apply a graph to an existing Standard/Physical material, chaining any onBeforeCompile hook it already has. */
  apply(THREE,material,graph,opts={}){if(!material||!material.isMeshStandardMaterial)throw new Error('KE.MaterialGraph.apply needs a MeshStandardMaterial or MeshPhysicalMaterial');
    const o={...opts,model:material.isMeshPhysicalMaterial?'physical':'standard'},cp=compileGraph(graph,o);MG.stats.compiles++;
    const own=Object.prototype.hasOwnProperty.call(material,'onBeforeCompile')?material.onBeforeCompile:null,ownKey=Object.prototype.hasOwnProperty.call(material,'customProgramCacheKey')?material.customProgramCacheKey.bind(material):null;
    if(cp.outputs.sheen&&!material.sheen)material.sheen=new THREE.Color(0,0,0);
    install(THREE,material,{THREE,shared:{cp,opts:o},pu:paramUniforms(THREE,cp,null),parent:null,shadow:null,prevHook:own,prevKey:ownKey});material.needsUpdate=true;return material;},
  /* A material instance: same program (same cache key), its own parameter values; unset values follow the parent. */
  instance(mat,overrides={},opts={}){const ps=STATE.get(mat);if(!ps)throw new Error('KE.MaterialGraph.instance: not a material graph material');const THREE=ps.THREE,cp=ps.shared.cp;
    let m;if(cp.model==='unlit'){m=makeMaterial(THREE,cp,ps.shared.opts);THREE.Material.prototype.copy.call(m,mat);m.fog=mat.fog;m.extensions.derivatives=true;}else{m=new mat.constructor().copy(mat);if(mat.sheen)m.sheen=mat.sheen.clone();}
    install(THREE,m,{THREE,shared:ps.shared,pu:paramUniforms(THREE,cp,ps),parent:mat,shadow:null,prevHook:ps.prevHook,prevKey:ps.prevKey});
    m.name=opts.name||mat.name+'-instance';for(const [k,v] of Object.entries(overrides))setParam(m,k,v);return m;},
  isGraphMaterial:m=>STATE.has(m),
  parentOf:m=>{const s=STATE.get(m);return s?s.parent:null;},
  /* Assign the material to a mesh plus matching shadow depth/distance materials when it has WPO or alpha clip,
     and move meshes whose material reads scene colour/depth to KE.LAYERS.TRANSLUCENT. */
  bind(mesh,material=mesh.material,{translucentLayer=true}={}){if(material)mesh.material=material;const st=STATE.get(mesh.material);if(!st)return mesh;
    const sh=shadowMaterials(mesh.material);if(sh){for(const d of [sh.depth,sh.distance]){d.skinning=!!mesh.material.skinning;d.morphTargets=!!mesh.material.morphTargets;}mesh.customDepthMaterial=sh.depth;mesh.customDistanceMaterial=sh.distance;}
    if(translucentLayer&&MG.readsScene(mesh.material))mesh.layers.set(KE.LAYERS.TRANSLUCENT);return mesh;},
  shadowMaterials,
  readsScene(m){const st=STATE.get(m);if(!st)return false;const u=st.shared.cp.uniforms;return u.has('kmgSceneColor')||u.has('kmgSceneDepth');},
  /* Type-check without creating a material. Reports every error it can find (per output), plus inferred node types. */
  validate(graph,opts={}){const errors=[],warnings=[],types={},seen=new Set();
    const push=(e,list=errors)=>{if(!(e instanceof GraphError)){list.push({node:null,code:'internal',message:String(e&&e.message||e)});return;}const k=e.message;if(seen.has(k))return;seen.add(k);list.push({node:e.node,code:e.code,message:e.detail});};
    let g;try{g=normalizeGraph(graph);}catch(e){push(e);return {ok:false,errors,warnings,types};}
    for(const n of g.nodes.values()){if(!NODES[n.type])push(new GraphError(`unknown node type '${n.type}'`,n.id,'type'));
      for(const [k,v] of Object.entries(n.in))if(isRef(v)&&!g.nodes.has(parseRef(v).id))push(new GraphError(`input '${k}' references unknown node '${parseRef(v).id}'`,n.id,'ref'));
      if(n.type==='Param'&&!g.params[n.name])push(new GraphError(`unknown param '${n.name}'`,n.id,'param'));}
    const cyc=findCycle(g);if(cyc)push(new GraphError('cycle: '+cyc.join(' -> '),cyc[0],'cycle'));
    if(!cyc){const model=opts.model||'standard';
      for(const k of Object.keys(g.outputs)){try{compileGraph({__kmgNormalized:true,nodes:g.nodes,params:g.params,outputs:{[k]:g.outputs[k]},source:g.source},{...opts,model});}catch(e){push(e);}}
      const c=new Compiler(g,opts),F=new Ctx(c,'fragment');
      for(const n of g.nodes.values()){if(!NODES[n.type]||NODES[n.type].virtual)continue;try{types[n.id]=F.ref(n.id,null).type;}catch(e){push(e,warnings);}}}
    return {ok:errors.length===0,errors,warnings,types};},
  /* Generated GLSL chunks for inspection (no material is created). */
  generate(graph,opts={}){const cp=compileGraph(graph,opts);return {vertexDeclarations:cp.vDecl,vertexMain:cp.vMain,fragmentDeclarations:cp.fDecl,fragmentMain:cp.fBody,key:cp.key,outputs:Object.keys(cp.outputs),worldPositionOffset:cp.wpo,warnings:cp.warnings};},
  cacheKey(graph,opts={}){return compileGraph(graph,opts).key;},
  /* Shader time: wall clock by default; setTime/update switch to a manual clock (pause, time scale, tests). */
  setTime(t){clock.manual=true;clock.t=+t||0;},update(dt){clock.manual=true;clock.t+=+dt||0;},useWallClock(){clock.manual=false;},
  textures:THREE=>sharedTextures(THREE),
  disposeShared(THREE){const s=SHARED.get(THREE);if(s){for(const t of Object.values(s))t.dispose();SHARED.delete(THREE);}}
};
KE.MaterialGraph=MG;

/* ---------- fluent builder: KE.shaderGraph(THREE, g => ({baseColor: …}), options) ---------- */
class Handle{constructor(b,ref){this._b=b;this._ref=ref;}
  toString(){return this._ref;}
  out(port){if(this._ref.includes('.'))throw new Error('out() on a swizzled handle');return new Handle(this._b,this._ref+'.'+port);}
  _swz(s){return this._ref.includes('.')?this._b.node('ComponentMask',{x:this},{mask:s}):new Handle(this._b,this._ref+'.'+s);}
  mask(s){return this._swz(s);}
}
const HANDLE_METHODS={add:['Add','a','b'],sub:['Subtract','a','b'],mul:['Multiply','a','b'],div:['Divide','a','b'],pow:['Power','base','exp'],min:['Min','a','b'],max:['Max','a','b'],mod:['Modulo','a','b'],
  dot:['Dot','a','b'],cross:['Cross','a','b'],distance:['Distance','a','b'],append:['Append','a','b'],step:['Step','x','edge'],lerp:['Lerp','a','b','alpha'],mix:['Lerp','a','b','alpha'],
  clamp:['Clamp','x','min','max'],smoothstep:['Smoothstep','x','edge0','edge1'],remap:['Remap','x','inMin','inMax','outMin','outMax'],posterize:['Posterize','x','steps'],
  saturate:['Saturate','x'],oneMinus:['OneMinus','x'],abs:['Abs','x'],floor:['Floor','x'],ceil:['Ceil','x'],fract:['Frac','x'],sqrt:['Sqrt','x'],sin:['Sin','x'],cos:['Cos','x'],tan:['Tan','x'],
  exp:['Exp','x'],log:['Log','x'],sign:['Sign','x'],normalize:['Normalize','x'],length:['Length','x'],negate:['Negate','x'],desaturate:['Desaturation','color','fraction'],hueShift:['HueShift','color','shift'],contrast:['CheapContrast','x','contrast']};
for(const [name,[type,self,...rest]] of Object.entries(HANDLE_METHODS))Handle.prototype[name]=function(...args){const inp={[self]:this};rest.forEach((k,i)=>{if(args[i]!==undefined)inp[k]=args[i];});return this._b.node(type,inp);};
(function swizzles(){const make=(set,len,pre='')=>{if(pre.length===len){if(!(pre in Handle.prototype))Object.defineProperty(Handle.prototype,pre,{get(){return this._swz(pre);}});return;}for(const c of set)make(set,len,pre+c);};
  for(const set of ['xyzw','rgba'])for(let l=1;l<=4;l++)make(set,l);})();
const unwrap=v=>v instanceof Handle?v._ref:v;
/* realm-agnostic plain-object test (objects may come from another frame or vm context) */
const isPlain=v=>{if(!v||typeof v!=='object'||v instanceof Handle||Array.isArray(v)||v.isTexture||v.isColor||v.isVector2||v.isVector3||v.isVector4)return false;const p=Object.getPrototypeOf(v);return p===null||Object.getPrototypeOf(p)===null;};
class GraphBuilder{
  constructor(){this.nodes=[];this.params={};this.n=0;this.paramNodes={};}
  node(type,inputs={},props={}){const id='n'+(this.n++),node={id,type,...props,in:{}};for(const [k,v] of Object.entries(inputs))if(v!==undefined)node.in[k]=unwrap(v);this.nodes.push(node);return new Handle(this,id);}
  param(name,type='float',value,opts={}){if(!this.params[name])this.params[name]={type,value,...opts};return this.paramNodes[name]||(this.paramNodes[name]=this.node('Param',{},{name}));}
  color(v){return this.node('Color',{},{value:v});}
  float(v){return this.node('Constant',{},{value:v});}
  vec(...c){if(c.every(x=>typeof x==='number'))return this.node('Constant',{},{value:c});let h=c[0];for(let i=1;i<c.length;i++)h=this.node('Append',{a:h,b:c[i]});return h;}
  vec2(...c){return this.vec(...c);}vec3(...c){return this.vec(...c);}vec4(...c){return this.vec(...c);}
  /* custom(code, outType, {name:[type, value]}) */
  custom(code,out='float',inputs={}){const types={},ins={};for(const [k,[t,v]] of Object.entries(inputs)){types[k]=t;ins[k]=v;}return this.node('CustomGLSL',ins,{code,out,inputs:types});}
  build(outputs){const o={};for(const [k,v] of Object.entries(outputs||{}))if(v!==undefined&&v!==null)o[k]=unwrap(v);return {nodes:this.nodes,params:this.params,outputs:o};}
}
const BUILDER_ALIAS={worldPos:'WorldPosition',worldNormal:'WorldNormal',viewDir:'ViewDirection',cameraPos:'CameraPosition',objectPos:'ObjectPosition',vertexColor:'VertexColor',screenUV:'ScreenUV',
  uv:'UV',time:'Time',texture:'Texture2D',triplanar:'TriplanarSample',pom:'ParallaxOcclusion',lerp:'Lerp',mix:'Lerp',add:'Add',sub:'Subtract',mul:'Multiply',div:'Divide',pow:'Power',fract:'Frac'};
function refreshBuilder(){const lc=t=>/^[A-Z0-9]+$/.test(t)?t.toLowerCase():t[0].toLowerCase()+t.slice(1);
  const bind=(name,type)=>{GraphBuilder.prototype[name]=function(...args){const d=NODES[type];if(!d)throw new Error('unknown node type '+type);
    let props={};if(args.length&&isPlain(args[args.length-1]))props={...args.pop()};const ins=typeof d.inputs==='function'?[]:d.inputs,inputs={},nodeProps={};
    ins.forEach((i,k)=>{const a=args[k];if(a===undefined)return;if(i.type==='sampler2D'&&a&&a.isTexture)nodeProps.texture=a;else inputs[i.name]=a;});
    for(const [k,v] of Object.entries(props)){if(ins.some(i=>i.name===k)&&!(v&&v.isTexture))inputs[k]=v;else nodeProps[k]=v;}
    return this.node(type,inputs,nodeProps);};};
  for(const type of Object.keys(NODES))if(!NODES[type].virtual&&!['param','color','float','vec2','vec3','vec4','node','build','custom'].includes(lc(type)))bind(lc(type),type);
  for(const [a,t] of Object.entries(BUILDER_ALIAS))if(NODES[t])bind(a,t);MG._builderDirty=false;}
KE.shaderGraph=(THREE,fn,opts={})=>KE.MaterialGraph.compile(THREE,KE.shaderGraph.build(fn),opts);
KE.shaderGraph.build=fn=>{if(MG._builderDirty!==false)refreshBuilder();const g=new GraphBuilder();return g.build(fn(g));};
KE.shaderGraph.Builder=GraphBuilder;

/* ---------- procedural texture sets (tileable, generated once per library) ---------- */
/* Periodic value noise and Worley noise on an integer lattice wrapped by the period P, so every texture tiles.
   Each set packs albedo (sRGB bytes), a tangent-space normal map and ORM-H (R=occlusion, G=roughness, B=height). */
function textureSets(THREE,S){
  const hash=(i,j,s)=>{let h=(Math.imul(i|0,374761393)+Math.imul(j|0,668265263)+Math.imul(s|0,1274126177))|0;h=Math.imul(h^(h>>>13),1274126177);h^=h>>>16;return (h>>>0)/4294967296;};
  const wrap=(i,P)=>((i%P)+P)%P;
  const vnoise=(x,y,P,s)=>{const xi=Math.floor(x),yi=Math.floor(y),fx=x-xi,fy=y-yi,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy),x0=wrap(xi,P),x1=wrap(xi+1,P),y0=wrap(yi,P),y1=wrap(yi+1,P);
    const a=hash(x0,y0,s),b=hash(x1,y0,s),c=hash(x0,y1,s),d=hash(x1,y1,s);return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;};
  const fbm=(x,y,P,oct,s)=>{let a=1,t=0,n=0;for(let o=0;o<oct;o++){t+=a*vnoise(x,y,P,s+o*31);n+=a;x*=2;y*=2;P*=2;a*=.5;}return t/n;};
  const worley=(x,y,P,s,jit=1)=>{const xi=Math.floor(x),yi=Math.floor(y);let f1=9,f2=9,id=0;
    for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++){const cx=xi+i,cy=yi+j,wx=wrap(cx,P),wy=wrap(cy,P),px=cx+.5+(hash(wx,wy,s)-.5)*jit,py=cy+.5+(hash(wx,wy,s+7)-.5)*jit,d=Math.hypot(px-x,py-y);
      if(d<f1){f2=f1;f1=d;id=hash(wx,wy,s+13);}else if(d<f2)f2=d;}return [f1,f2,id];};
  const ss=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t);},mix=(a,b,t)=>a+(b-a)*t,cl=x=>Math.max(0,Math.min(255,Math.round(x)));
  const toSRGB=c=>c<=.0031308?c*12.92:1.055*Math.pow(c,1/2.4)-.055;
  const tex=(data,srgb)=>{const t=new THREE.DataTexture(data,S,S,THREE.RGBAFormat);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearMipmapLinearFilter;
    t.generateMipmaps=true;t.anisotropy=4;t.encoding=srgb?THREE.sRGBEncoding:THREE.LinearEncoding;t.needsUpdate=true;return t;};
  function build(heightFn,shadeFn,normalStrength){
    const H=new Float32Array(S*S),aux=new Array(S*S);let lo=1e9,hi=-1e9;
    for(let y=0;y<S;y++)for(let x=0;x<S;x++){const r=heightFn(x/S,y/S);H[y*S+x]=r.h;aux[y*S+x]=r;lo=Math.min(lo,r.h);hi=Math.max(hi,r.h);}
    const alb=new Uint8Array(S*S*4),nrm=new Uint8Array(S*S*4),orm=new Uint8Array(S*S*4),h=i=>(H[i]-lo)/(hi-lo||1),k=normalStrength*S/256;
    for(let y=0;y<S;y++)for(let x=0;x<S;x++){const i=y*S+x,o=i*4,hx=h(y*S+(x+1)%S)-h(y*S+(x+S-1)%S),hy=h(((y+1)%S)*S+x)-h(((y+S-1)%S)*S+x);
      let nx=-hx*k,ny=-hy*k,nz=1;const l=Math.hypot(nx,ny,nz);nx/=l;ny/=l;nz/=l;nrm[o]=cl((nx*.5+.5)*255);nrm[o+1]=cl((ny*.5+.5)*255);nrm[o+2]=cl((nz*.5+.5)*255);nrm[o+3]=255;
      const s=shadeFn(aux[i],h(i),x/S,y/S);for(let c=0;c<3;c++)alb[o+c]=cl(toSRGB(Math.max(0,s.color[c]))*255);alb[o+3]=255;
      orm[o]=cl(s.ao*255);orm[o+1]=cl(s.roughness*255);orm[o+2]=cl(h(i)*255);orm[o+3]=255;}
    return {albedo:tex(alb,true),normal:tex(nrm,false),orm:tex(orm,false)};}
  // Layered rock: warped fBm, bedding strata and fine cracks.
  const rock=build((u,v)=>{const wx=fbm(u*4,v*4,4,3,11)-.5,wy=fbm(u*4+5.2,v*4+1.3,4,3,12)-.5,n=fbm(u*4+wx*1.3,v*4+wy*1.3,4,6,1),[f1,f2]=worley(u*6+wx,v*6+wy,6,5),crack=1-ss(0,.07,f2-f1);
      const strata=Math.sin((v*6+n*1.6)*Math.PI*2)*.5+.5,fine=fbm(u*16,v*16,16,3,3),tint=fbm(u*3,v*3,3,4,7);
      return {h:n*.8+strata*.14+fine*.12-crack*.22,crack,tint,fine};},
    (r,h)=>{const base=[mix(.045,.17,h),mix(.042,.155,h),mix(.038,.135,h)],w=(r.tint-.5)*.5,dark=1-r.crack*.6;
      return {color:[base[0]*(1+w)*dark*(.9+r.fine*.2),base[1]*dark*(.9+r.fine*.2),base[2]*(1-w)*dark*(.9+r.fine*.2)],ao:Math.min(1,.42+.62*ss(.05,.65,h))*(1-r.crack*.35),roughness:.66+.26*(1-h)};},5);
  // Cobblestones: jittered Worley cells as rounded stones, sand and grit in the joints.
  const cobble=build((u,v)=>{const wx=fbm(u*8,v*8,8,3,21)-.5,wy=fbm(u*8+3.1,v*8+7.7,8,3,22)-.5,[f1,f2,id]=worley(u*4+wx*.25,v*4+wy*.25,4,9,.85),e=f2-f1,stone=ss(.03,.3,e),grit=fbm(u*32,v*32,32,3,4);
      return {h:Math.sqrt(stone)*(.8+id*.2)+grit*.05+fbm(u*8,v*8,8,4,5)*.1*stone,stone,id,grit};},
    (r,h)=>{const pal=[[.16,.15,.13],[.11,.105,.1],[.19,.16,.12],[.13,.125,.135],[.21,.19,.16]],p=pal[Math.floor(r.id*5)%5],g=.8+r.grit*.4,mortar=[.085*g,.075*g,.055*g];
      const c=[0,1,2].map(i=>mix(mortar[i],p[i]*g*(.85+.3*h),r.stone));return {color:c,ao:mix(.5,1,Math.pow(r.stone,.6)),roughness:mix(.95,.58+r.grit*.2,r.stone)};},7);
  return {rock,cobble,dispose(){for(const set of [rock,cobble])for(const t of Object.values(set))t.dispose();}};
}

/* ---------- material library ---------- */
const LIBS=new Map(),POM_STEPS={low:8,medium:12,high:16,ultra:24,cinematic:32};
KE.materialLibrary=(THREE,{size}={})=>{
  if(LIBS.has(THREE))return LIBS.get(THREE);
  let sets=null;const S=size||Math.max(128,Math.min(512,KE.settings.tex||256)),T=()=>sets||(sets=textureSets(THREE,S));
  const rockLayers=g=>{const t=T().rock,p=g.worldPos(),n=g.worldNormal(),s=g.param('scale','float',.55,{min:.05,max:4}),k=g.param('sharpness','float',6,{min:1,max:16});
    return {p,n,alb:g.triplanarSample(g.param('albedoMap','texture',t.albedo),p,n,s,k,{space:'srgb'}).rgb.mul(g.param('tint','color','#ffffff')),
      orm:g.triplanarSample(g.param('ormMap','texture',t.orm),p,n,s,k,{space:'linear'}),nrm:g.triplanarNormal(g.param('normalMap','texture',t.normal,{fallback:'normal'}),p,n,s,k,g.param('normalStrength','float',1,{min:0,max:3}))};};
  const defs={
    pbrTriplanar:[g=>{const r=rockLayers(g);return {baseColor:r.alb,roughness:r.orm.g.mul(g.param('roughness','float',1,{min:0,max:2})).saturate(),metallic:g.param('metallic','float',0,{min:0,max:1}),ao:r.orm.r,normal:r.nrm};},{normalSpace:'world'}],
    parallaxStone:[g=>{const t=T().cobble,hm=g.param('heightMap','texture',t.orm),uv=g.uv().mul(g.param('tiling','float',1,{min:.25,max:8}));
      const puv=g.parallaxOcclusion(hm,uv,g.param('heightScale','float',.06,{min:0,max:.2}),{steps:POM_STEPS[KE.settings.preset]||16,channel:'b'}),orm=g.texture2D(hm,puv,{space:'linear'});
      return {baseColor:g.texture2D(g.param('albedoMap','texture',t.albedo),puv).rgb.mul(g.param('tint','color','#ffffff')),roughness:orm.g,ao:orm.r,
        normal:g.normalMap(g.param('normalMap','texture',t.normal,{fallback:'normal'}),puv,g.param('normalStrength','float',1.2,{min:0,max:3}))};}],
    mossyRock:[g=>{const r=rockLayers(g),amount=g.param('mossAmount','float',.55,{min:0,max:1});
      const up=g.worldAlignedBlend(3,amount.mul(2.4).sub(2.2)),cover=up.mul(g.noise(r.p,{kind:'fbm',scale:1.3,octaves:4}).mul(1.7)).saturate();
      const mask=g.heightLerp(0,1,r.orm.b.oneMinus(),cover,.7),tone=g.noise(r.p,{kind:'fbm',scale:5,octaves:3}).smoothstep(.3,.7),fuzz=g.noise(r.p,{kind:'value',scale:45}).mul(.35).add(.78);
      const moss=g.lerp(g.param('mossColor','color','#1f3510'),g.param('mossTipColor','color','#4f6e1c'),tone).mul(fuzz);
      const mossN=g.bump(g.noise(r.p,{kind:'value',scale:60}).mul(.004),1,{space:'world'});
      return {baseColor:g.lerp(r.alb,moss,mask),roughness:g.lerp(r.orm.g,.95,mask),ao:g.lerp(r.orm.r,g.lerp(.75,1,tone),mask),normal:g.lerp(r.nrm,mossN,mask.mul(.85)).normalize(),subsurface:moss.mul(mask.mul(.12))};},{normalSpace:'world',subsurface:{wrap:.6,scale:.3}}],
    snowCovered:[g=>{const r=rockLayers(g),cov=g.param('coverage','float',.5,{min:0,max:1}),d=g.dot(r.n,[0,1,0]).add(g.noise(r.p,{kind:'fbm',scale:2.2,octaves:4}).sub(.5).mul(.6));
      const m0=d.sub(cov.mul(-2).add(1)).mul(4).add(.5).saturate(),mask=g.heightLerp(0,1,r.orm.b.oneMinus(),m0,.8);
      const sparkle=g.noise(r.p.mul(26).add(g.viewDir().mul(1.2)),{kind:'value'}).smoothstep(.9,.975).mul(mask);
      const snowN=g.bump(g.noise(r.p,{kind:'fbm',scale:9,octaves:3}).mul(.012),1,{space:'world'});
      return {baseColor:g.lerp(r.alb,g.param('snowColor','color','#dde5ef'),mask),roughness:g.lerp(r.orm.g,.62,mask),ao:g.lerp(r.orm.r,1,mask),normal:g.lerp(r.nrm,snowN,mask.mul(.9)).normalize(),
        subsurface:g.color('#7fa6e0').mul(mask.mul(.3)),emissive:g.color('#ffffff').mul(sparkle.mul(2.5))};},{normalSpace:'world',subsurface:{wrap:.7,distortion:.3,power:3,scale:.5}}],
    carPaint:[g=>{const lp=g.worldPos().sub(g.objectPos()),v=g.noise(lp,{kind:'voronoi',scale:g.param('flakeScale','float',95,{min:10,max:300})}),cell=v.out('cell');
      const fr=g.fresnel({exponent:2.5,baseReflectFraction:0}),sparkle=cell.smoothstep(.72,.97);
      const flake=g.custom('normalize(vec3((fract(vec2(c * 91.7, c * 47.3)) - 0.5) * s, 1.0))','vec3',{c:['float',cell],s:['float',g.param('flakeStrength','float',.5,{min:0,max:2})]});
      return {baseColor:g.lerp(g.param('paintColor','color','#9a0b1a'),g.param('flipColor','color','#24020a'),fr).mul(sparkle.mul(.4).add(.85)),metallic:g.param('metallic','float',.6,{min:0,max:1}),
        roughness:g.param('roughness','float',.34,{min:0,max:1}),normal:flake,clearcoat:g.param('clearcoat','float',1,{min:0,max:1}),clearcoatRoughness:g.param('clearcoatRoughness','float',.03,{min:0,max:1})};},{model:'physical'}],
    glass:[g=>{const fr=g.fresnel({exponent:5,baseReflectFraction:.04});
      return {baseColor:g.param('tint','color','#e3f4f0'),metallic:0,roughness:g.param('roughness','float',.03,{min:0,max:1}),opacity:g.lerp(g.param('opacity','float',.12,{min:0,max:1}),1,fr.mul(.6)),refraction:g.param('refraction','float',.6,{min:0,max:2})};},
      {model:'physical',transparent:true,material:{envMapIntensity:1.3}}],
    hologram:[g=>{const p=g.worldPos(),y=p.y,t=g.time(),col=g.param('color','color','#27d3ff'),fr=g.fresnel({exponent:2.2,baseReflectFraction:0});
      const bands=y.mul(g.param('scanDensity','float',9,{min:1,max:40})).sub(t.mul(1.2)).fract().smoothstep(.8,1),fine=y.mul(140).sin().mul(.5).add(.5),flick=g.noise(t.mul(9),{kind:'value'}).mul(.3).add(.8);
      const glitch=g.noise(g.vec2(y.mul(10).floor(),t.mul(7).floor()),{kind:'value'}).step(.9);
      return {emissive:col.mul(g.param('intensity','float',2.2,{min:0,max:10})).mul(fr.mul(1.6).add(.12).add(bands.mul(.7)).add(fine.mul(.1))).mul(flick),
        opacity:fr.add(.2).add(bands.mul(.35)).add(fine.mul(.08)).saturate(),worldPositionOffset:g.vec3(glitch.mul(t.mul(53).sin()).mul(.04),0,0)};},
      {model:'unlit',transparent:true,blending:'additive',depthWrite:false,side:'double'}],
    dissolve:[g=>{const n=g.noise(g.worldPos().sub(g.objectPos()),{kind:'fbm',scale:3.5,octaves:4}),d=n.sub(g.param('amount','float',.45,{min:0,max:1}));
      const edge=d.smoothstep(0,g.param('edgeWidth','float',.06,{min:.001,max:.3})).oneMinus().pow(2);
      const w=g.param('edgeWidth','float',.06,{min:.001,max:.3}),char=d.smoothstep(0,w.mul(2.5));
      return {baseColor:g.param('baseColor','color','#8d949c').mul(char.mul(.8).add(.2)),metallic:.85,roughness:g.noise(g.worldPos(),{kind:'fbm',scale:9,octaves:3}).mul(.2).add(.25),alphaClip:d.add(.5),
        emissive:g.param('edgeColor','color','#ff6a14').mul(edge.mul(g.param('edgeIntensity','float',12,{min:0,max:40})))};}],
    forceField:[g=>{const p=g.worldPos(),col=g.param('color','color','#3a9dff'),fr=g.fresnel({exponent:2.5,baseReflectFraction:0});
      const v=g.noise(p.sub(g.objectPos()),{kind:'voronoi',scale:g.param('cellScale','float',7,{min:1,max:30})}),lines=v.out('edge').smoothstep(0,.07).oneMinus();
      const pulse=g.time().mul(2).sub(p.y.mul(5)).sin().mul(.5).add(.5),inter=g.depthFade(g.param('intersection','float',.35,{min:.01,max:3})).oneMinus();
      return {emissive:col.mul(g.param('intensity','float',1.8,{min:0,max:10})).mul(fr.mul(1.4).add(lines.mul(pulse.mul(.6).add(.2))).add(inter.mul(3)).add(.03)),
        opacity:fr.mul(.9).add(lines.mul(.35)).add(inter).add(.04).saturate()};},{model:'unlit',transparent:true,blending:'additive',depthWrite:false,side:'double'}],
    lava:[g=>{const lp=g.worldPos().sub(g.objectPos()),t=g.time(),drift=g.vec3(0,t.mul(-.08),t.mul(.03));
      const flow=g.noise(lp.mul(2.2).add(drift),{kind:'fbm',octaves:5}),v=g.noise(lp.add(flow.mul(.18)).add(drift.mul(.3)),{kind:'voronoi',scale:g.param('cellScale','float',5.5,{min:1,max:20})});
      const crack=v.out('edge').add(flow.sub(.5).mul(.08)).smoothstep(.01,.09).oneMinus(),pool=flow.smoothstep(.6,.78),heat=crack.max(pool).mul(flow.mul(.5).add(.75)).saturate();
      const crust=g.lerp('#0d0a09','#2e241f',g.noise(lp,{kind:'fbm',scale:9,octaves:3})).mul(v.out('cell').mul(.5).add(.75));
      const hot=g.lerp(g.lerp('#7a0a00','#ff3a00',heat.smoothstep(0,.55)),'#ffd05a',heat.smoothstep(.75,1));
      return {baseColor:g.lerp(crust,'#140400',heat),roughness:g.lerp(.9,.5,heat),metallic:0,normal:g.bump(crack.max(pool).oneMinus().mul(.03),1),
        emissive:hot.mul(heat.mul(heat).mul(g.param('glow','float',5,{min:0,max:40}))),
        worldPositionOffset:g.worldNormal().mul(g.noise(g.worldPos().mul(1.4).add(drift),{kind:'perlin'}).sub(.5).mul(g.param('bubble','float',.04,{min:0,max:.3})))};}],
    waterPuddle:[g=>{const p=g.worldPos(),xz=p.xz,gn=g.noise(p,{kind:'fbm',scale:3,octaves:5}),grit=g.noise(p,{kind:'value',scale:60}).mul(.4).add(.8);
      const ground=g.lerp('#3b342d','#8a7d6e',gn).mul(grit),pz=g.noise(xz,{kind:'fbm',scale:2.2,octaves:4}).add(g.param('wetness','float',.5,{min:0,max:1}).mul(.5).sub(.25));
      const flat=g.worldAlignedBlend(10,-8.2),puddle=pz.smoothstep(.5,.54).mul(flat),wet=pz.smoothstep(.3,.5).max(puddle);
      const rv=g.noise(xz,{kind:'voronoi',scale:g.param('rippleScale','float',5,{min:1,max:20})}),phase=g.time().mul(.7).add(rv.out('cell')).fract();
      const ring=rv.sub(phase.mul(.8)).mul(45).sin().mul(phase.oneMinus()).mul(rv.smoothstep(.15,.8).oneMinus());
      return {baseColor:g.lerp(ground,ground.mul(.42),wet).mul(puddle.mul(-.25).add(1)),roughness:g.lerp(g.lerp(.9,.42,wet),.03,puddle),metallic:0,
        normal:g.bump(gn.mul(.02).mul(puddle.oneMinus()).add(ring.mul(.0025).mul(puddle)),1)};}],
    toon:[g=>{const fr=g.fresnel({exponent:3,baseReflectFraction:0}),ink=fr.smoothstep(.8,.84),rim=fr.smoothstep(.5,.56).mul(ink.oneMinus());
      return {baseColor:g.param('color','color','#ff8a3d').mul(ink.mul(-.85).add(1)),roughness:.55,metallic:0,emissive:g.param('rimColor','color','#fff0cc').mul(rim.mul(.5))};},
      {toon:{steps:3,smoothness:.02},material:{envMapIntensity:.35}}],
    foliageSSS:[g=>{const uv=g.uv().mul(g.param('leafTiling','vec2',[12,6])),v1=g.noise(uv,{kind:'voronoi'}),v2=g.noise(uv.add([.5,.37]),{kind:'voronoi'}),p=g.worldPos(),t=g.time();
      /* elliptical leaf per cell: distance to the feature point stretched across a random per-cell axis */
      const shape=v=>g.custom('f * sqrt(pow(cos(a - c * 6.2831853), 2.0) + pow(sin(a - c * 6.2831853) * 2.1, 2.0))','float',{f:['float',v],a:['float',v.out('angle')],c:['float',v.out('cell')]});
      const s1=shape(v1),s2=shape(v2),l1=s1.smoothstep(.4,.47).oneMinus(),l2=s2.smoothstep(.4,.47).oneMinus(),top=l1.step(.5);
      const A=g.param('colorA','color','#1c4212'),B=g.param('colorB','color','#5f8f28'),c1=g.lerp(A,B,v1.out('cell')).mul(s1.mul(-1.2).add(1.2)),c2=g.lerp(A,B,v2.out('cell')).mul(s2.mul(-1.2).add(1.05));
      const hgt=p.y.sub(g.objectPos().y).add(.6).saturate(),sway=t.mul(2.1).add(p.x.mul(.9)).add(p.z.mul(.7)).sin().mul(.5).add(g.noise(p.mul(.8).add(t.mul(.3)),{kind:'perlin'}).sub(.5));
      return {baseColor:g.lerp(c2,c1,top),roughness:.55,metallic:0,alphaClip:l1.max(l2),normal:g.bump(g.lerp(s2,s1,top).mul(.015),1),
        subsurface:g.param('translucency','color','#8cc238').mul(.6),worldPositionOffset:g.vec3(sway.mul(hgt).mul(.05),0,sway.mul(hgt).mul(.035)).mul(g.param('wind','float',1,{min:0,max:4}))};},
      {side:'double',subsurface:{wrap:.5,distortion:.35,power:3,scale:1.1}}],
    stylizedGrass:[g=>{const y=g.uv().y,root=g.param('rootColor','color','#1f4a1c'),tip=g.param('tipColor','color','#8fc03c'),p=g.worldPos(),t=g.time();
      const vari=g.noise(p.xz.mul(.35),{kind:'fbm',octaves:3}),col=g.lerp(root,tip,y.pow(1.3)).mul(vari.mul(.35).add(.82));
      const gust=g.noise(p.xz.mul(.15).sub(g.vec2(t.mul(.25),t.mul(.1))),{kind:'perlin'}),sway=t.mul(2.3).add(p.x.mul(.6)).add(p.z.mul(.4)).sin().mul(.35).add(gust.sub(.5).mul(1.8));
      const amt=y.mul(y).mul(g.param('wind','float',.22,{min:0,max:1}));
      return {baseColor:col,roughness:.65,metallic:0,ao:g.lerp(.45,1,y),subsurface:tip.mul(y.mul(.3)),normal:g.lerp(g.worldNormal(),[0,1,0],.65).normalize(),
        worldPositionOffset:g.vec3(sway.mul(amt),amt.mul(sway.abs()).mul(-.15),sway.mul(amt).mul(.4))};},{side:'double',normalSpace:'world',subsurface:{wrap:.6,distortion:.2,power:3,scale:.8}}]
  };
  const lib={names:Object.keys(defs),size:S,
    get textures(){return T();},
    graph(name){const d=defs[name];if(!d)throw new Error('unknown library material '+name);return KE.shaderGraph.build(d[0]);},
    create(name,params={},opts={}){const d=defs[name];if(!d)throw new Error(`unknown library material '${name}' (have ${Object.keys(defs).join(', ')})`);
      const m=KE.shaderGraph(THREE,d[0],{name:'ke-'+name,...(d[1]||{}),...opts});for(const [k,v] of Object.entries(params))m.setParam(k,v);return m;},
    dispose(){if(sets){sets.dispose();sets=null;}LIBS.delete(THREE);}};
  for(const name of lib.names)lib[name]=(params,opts)=>lib.create(name,params,opts);
  LIBS.set(THREE,lib);return lib;
};

KE.registerModule('materials',{provides:['MaterialGraph','shaderGraph','materialLibrary']});
})();
