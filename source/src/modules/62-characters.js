/* KE.foxModel — the Spirit Isle fox as a reusable character: rounded anatomy from scaled spheres, fibre-textured
   fur materials, layered ears, eyes with highlights, whiskers, four knee-less leg groups (hip pivot, paw as the
   third child, matching KE.ProceduralGait's knee-less leg layout) and a curved brush tail on its own pivot group
   (ready for KE.SpringChain). Faces -Z, stands on y = 0, about 1.35 units tall. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');

KE.foxModel=(THREE,{textureSize=512,castShadow=true,receiveShadow=true,coat=0xcc793f,belly=0xf2dfb6}={})=>{
  const T=THREE,owned=[],group=new T.Group();group.name='ke-fox';
  const std=(o)=>{const m=new T.MeshStandardMaterial(o);owned.push(m);return m;};
  const surface=(kind,o)=>{const m=KE.surface?KE.surface(T,kind,o):std({color:new T.Color(o.color).convertSRGBToLinear(),roughness:o.roughness});owned.push(m);return m;};
  const orange=surface('fur',{color:coat,roughness:.94,scale:8,bump:.012,textureSize}),cream=surface('fur',{color:belly,roughness:.96,scale:9,bump:.01,textureSize});
  const ink=std({color:new T.Color(0x302925).convertSRGBToLinear(),roughness:.84}),nose=std({color:0x17171a,roughness:.3}),eye=std({color:0x8b5b26,roughness:.19}),glint=std({color:new T.Color(0xfff9db).convertSRGBToLinear(),roughness:.84});
  const mesh=(geometry,mat,x,y,z,parent)=>{const m=new T.Mesh(geometry,mat);m.position.set(x,y,z);m.castShadow=castShadow;m.receiveShadow=receiveShadow;parent.add(m);return m;};
  const orb=(r,mat,x,y,z,sx=1,sy=1,sz=1,parent=group)=>{const m=mesh(new T.SphereGeometry(r,20,14),mat,x,y,z,parent);m.scale.set(sx,sy,sz);return m;};
  // body, chest, head, cheeks, muzzle, nose
  orb(.34,orange,0,.58,.03,1,1.06,1.62);orb(.28,orange,0,.78,-.3,1,1.25,1.1);orb(.255,cream,0,.65,-.38,.8,1.27,.6);orb(.29,orange,0,1.03,-.43,1.12,.97,1.03);
  orb(.2,orange,-.22,1.00,-.39,.82,.7,.9);orb(.2,orange,.22,1.00,-.39,.82,.7,.9);
  orb(.23,cream,0,.92,-.63,.82,.53,1.02);orb(.17,cream,0,.87,-.66,.87,.32,1);orb(.07,nose,0,.96,-.84,1.05,.64,.7);
  // ears: folded outer shell plus a cream inner face
  const ears=[];for(const x of [-.19,.19]){const e=new T.Group();e.position.set(x,1.22,-.37);e.rotation.z=x<0?.16:-.16;group.add(e);ears.push(e);
    const g=new T.BufferGeometry(),p=[-.12,0,.04,.12,0,.04,0,.4,.025, -.12,0,.04,0,.4,.025,0,.06,.15, .12,0,.04,0,.06,.15,0,.4,.025];g.setAttribute('position',new T.Float32BufferAttribute(p,3));g.computeVertexNormals();mesh(g,orange,0,0,0,e);
    const face=new T.Shape();face.moveTo(-.087,.02);face.lineTo(.087,.02);face.lineTo(0,.3);face.closePath();const inner=mesh(new T.ShapeGeometry(face),cream,0,.035,.02,e);inner.rotation.y=Math.PI;}
  // eyes with rims, pupils, highlights and brows
  for(const x of [-.175,.175]){orb(.062,ink,x,1.088,-.643,1.05,.68,.46);orb(.043,eye,x,1.092,-.663,.78,.9,.45);orb(.02,nose,x,1.092,-.678,.5,1,.35);orb(.01,glint,x-.009,1.109,-.685,1,1,.5);orb(.055,orange,x,1.147,-.619,1.2,.38,.7);}
  // legs: hip pivot group > thigh, shin, paw (paw is children[2])
  const legs=[];for(const x of [-.205,.205])for(const z of [-.27,.34]){const leg=new T.Group();leg.position.set(x,.52,z);group.add(leg);orb(.096,orange,0,-.13,0,1,1.9,1,leg);orb(.083,ink,0,-.32,-.01,.8,1.2,.85,leg);orb(.10,ink,0,-.43,-.052,.94,.52,1.36,leg);legs.push(leg);}
  // tail: a tube swollen in the middle, cream tip, on its own pivot
  const tail=new T.Group();tail.position.set(0,.55,.41);group.add(tail);
  const curve=new T.CatmullRomCurve3([new T.Vector3(0,0,0),new T.Vector3(.06,.08,.23),new T.Vector3(.13,.17,.48),new T.Vector3(.21,.29,.74),new T.Vector3(.21,.43,.9)]);
  const tg=new T.TubeGeometry(curve,24,.19,12,false),pa=tg.attributes.position;
  for(let i=0;i<=24;i++){const c=curve.getPointAt(i/24),radius=Math.sin((i/24*.86+.09)*Math.PI)*.94+.08;for(let j=0;j<=12;j++){const k=i*13+j;pa.setXYZ(k,c.x+(pa.getX(k)-c.x)*radius,c.y+(pa.getY(k)-c.y)*radius,c.z+(pa.getZ(k)-c.z)*radius);}}
  tg.computeVertexNormals();mesh(tg,orange,0,0,0,tail);orb(.13,cream,.21,.44,.89,.7,1.12,1.12,tail);
  // whiskers
  const wp=[];for(const side of [-1,1])for(let i=0;i<3;i++)wp.push(side*.12,.945-i*.017,-.735,side*(.31+i*.025),.955-i*.04,-.70);
  const wg=new T.BufferGeometry();wg.setAttribute('position',new T.Float32BufferAttribute(wp,3));const wm=new T.LineBasicMaterial({color:0xe5d9bc,transparent:true,opacity:.54});owned.push(wm);group.add(new T.LineSegments(wg,wm));
  return {group,legs,tail,ears,materials:{orange,cream,ink,nose,eye},tailTip:[.21,.43,.9],
    dispose(){group.parent&&group.parent.remove(group);group.traverse(o=>{if(o.geometry)o.geometry.dispose();});for(const m of owned)m.dispose();}};
};
KE.registerModule('characters',{provides:['foxModel']});
})();
