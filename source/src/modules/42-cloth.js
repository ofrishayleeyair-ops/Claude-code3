/* KE.Cloth — position-based cloth for flags, banners, curtains and capes.
   A grid of particles integrated with damped Verlet steps, then projected onto distance constraints (structural,
   shear and bend springs, each with its own stiffness) for a fixed number of Gauss–Seidel iterations per substep.
   Wind acts per triangle as an aerodynamic force proportional to the normal component of the relative air velocity
   (so fabric flutters and luffs instead of drifting), with gusts from travelling value noise. Pins hold particles
   at points fixed in an anchor object's frame, so a banner follows its pole. Sphere and capsule colliders and a
   ground height push particles out with friction. The mesh is simulated in world space (identity transform). */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const vec=(v,out)=>v.isVector3?v:Array.isArray(v)?out.set(v[0],v[1],v[2]):out.set(v.x,v.y,v.z);
const hash=(x,y)=>{const s=Math.sin(x*127.1+y*311.7)*43758.5453;return s-Math.floor(s);};
const vnoise=(x,y)=>{const ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,u=fx*fx*(3-2*fx),v=fy*fy*(3-2*fy);
  const a=hash(ix,iy),b=hash(ix+1,iy),c=hash(ix,iy+1),d=hash(ix+1,iy+1);return a+(b-a)*u+(c-a)*v+(a-b-c+d)*u*v;};

KE.Cloth=class{
  constructor(THREE,{width=1,height=1.6,segmentsX=12,segmentsY=20,pins='top',anchor=null,position=null,quaternion=null,material=null,
      mass=.3,stiffness=1,shearStiffness=.8,bendStiffness=.25,damping=.012,gravity=[0,-9.81,0],wind=null,windStrength=1,gustStrength=.6,gustScale=.35,
      drag=1.2,skin=.2,iterations=6,substeps=2,colliders=[],ground=null,friction=.35,thickness=.02,maxDt=1/30,castShadow=true,receiveShadow=true}={}){
    const T=this.THREE=THREE;Object.assign(this,{width,height,nx:Math.max(1,segmentsX|0),ny:Math.max(1,segmentsY|0),anchor,stiffness,shearStiffness,bendStiffness,damping,drag,skin,
      iterations:Math.max(1,iterations|0),substeps:Math.max(1,substeps|0),colliders,ground,friction,thickness,maxDt,windStrength,gustStrength,gustScale,time:0,enabled:true});
    this.gravity=new T.Vector3(...gravity);this.wind=wind;this._windVec=new T.Vector3();
    const nx=this.nx,ny=this.ny,n=(nx+1)*(ny+1);this.count=n;
    this.pos=new Float32Array(n*3);this.prev=new Float32Array(n*3);this.rest=new Float32Array(n*3);this.invMass=new Float32Array(n);this.force=new Float32Array(n*3);
    // Rest layout in the cloth's local frame: x across, y down from the top edge (top row j=0 at y=0), z = 0.
    // A millimetre of seeded out-of-plane ripple: a perfectly flat sheet under in-plane forces never buckles or folds.
    for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++){const k=j*(nx+1)+i;this.rest[k*3]=(i/nx-.5)*width;this.rest[k*3+1]=-j/ny*height;this.rest[k*3+2]=(hash(i*1.7,j*2.3)-.5)*.002*Math.min(width,height);}
    this.frame=new T.Matrix4();if(anchor){anchor.updateWorldMatrix(true,false);this.frame.copy(anchor.matrixWorld);}
    // Optional placement of the rest grid inside the anchor's frame (or the world when there is no anchor).
    const pv=position?vec(position,new T.Vector3()).clone():new T.Vector3(),q=quaternion?(quaternion.isQuaternion?quaternion:new T.Quaternion().setFromEuler(new T.Euler(...quaternion))):new T.Quaternion();
    this.local=new T.Matrix4().compose(pv,q,new T.Vector3(1,1,1));
    const pm=this.particleMass=mass/n;const v=new T.Vector3();
    for(let k=0;k<n;k++){v.fromArray(this.rest,k*3).applyMatrix4(this.local).applyMatrix4(this.frame);v.toArray(this.pos,k*3);v.toArray(this.prev,k*3);this.invMass[k]=1/pm;}
    // Pins: 'top' | 'left' | 'right' | 'corners' | 'topCorners' | array of [i,j] | fn(i,j) → bool
    this.pins=[];const isPin=typeof pins==='function'?pins:(i,j)=>pins==='top'?j===0:pins==='left'?i===0:pins==='right'?i===nx:pins==='corners'?(j===0||j===ny)&&(i===0||i===nx):pins==='topCorners'?j===0&&(i===0||i===nx):Array.isArray(pins)&&pins.some(p=>p[0]===i&&p[1]===j);
    for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++)if(isPin(i,j)){const k=j*(nx+1)+i;this.invMass[k]=0;this.pins.push(k);}
    // Constraints: [a, b, restLength, stiffness]
    const cons=[],add=(a,b,s)=>{const dx=this.rest[a*3]-this.rest[b*3],dy=this.rest[a*3+1]-this.rest[b*3+1];cons.push(a,b,Math.hypot(dx,dy),s);},id=(i,j)=>j*(nx+1)+i;
    for(let j=0;j<=ny;j++)for(let i=0;i<=nx;i++){if(i<nx)add(id(i,j),id(i+1,j),stiffness);if(j<ny)add(id(i,j),id(i,j+1),stiffness);
      if(i<nx&&j<ny){add(id(i,j),id(i+1,j+1),shearStiffness);add(id(i+1,j),id(i,j+1),shearStiffness);}
      if(i<nx-1)add(id(i,j),id(i+2,j),bendStiffness);if(j<ny-1)add(id(i,j),id(i,j+2),bendStiffness);}
    this.constraints=new Float32Array(cons);
    // Geometry and mesh (world space).
    const g=new T.PlaneGeometry(width,height,nx,ny);g.setAttribute('position',new T.BufferAttribute(this.pos.slice(),3).setUsage(T.DynamicDrawUsage));g.computeVertexNormals();
    this.tris=g.index.array;this.geometry=g;
    this.ownMaterial=!material;this.material=material||new T.MeshStandardMaterial({color:0xd04830,roughness:.85,side:T.DoubleSide});
    this.mesh=new T.Mesh(g,this.material);this.mesh.castShadow=castShadow;this.mesh.receiveShadow=receiveShadow;this.mesh.frustumCulled=false;this.mesh.name='ke-cloth';
    this._a=new T.Vector3();this._b=new T.Vector3();this._c=new T.Vector3();this._n=new T.Vector3();this._w=new T.Vector3();this._p=new T.Vector3();
    this._sync();
  }
  /* Wind velocity (m/s) at a point: options.wind (vector, [x,y,z] or fn(time,pos,out)), else the shared foliage wind, plus gusts. */
  windAt(p,out){const w=this.wind,t=this.time;
    if(typeof w==='function')w(t,p,out);else if(w)out.set(w.x!==undefined?w.x:w[0],w.y!==undefined?w.y:w[1],w.z!==undefined?w.z:w[2]);
    else{const U=KE.foliageUniforms,s=U?U.keWindStrength.value:1,d=U?U.keWindDir.value:null;out.set(d?d.x:.8,0,d?d.y:.6).normalize().multiplyScalar(3.5*s);}
    const gs=this.gustScale,g=vnoise(p.x*gs-t*1.3,p.z*gs+t*.7)*2-1,flutter=vnoise(p.y*1.7+t*4.1,p.x*1.3)*2-1;
    out.multiplyScalar(this.windStrength*(1+this.gustStrength*g));out.y+=flutter*.4*this.gustStrength;return out;}
  /* Advance by dt seconds (clamped to maxDt), in `substeps` fixed substeps. */
  update(dt){if(!this.enabled)return this;dt=clamp(+dt||0,0,this.maxDt);if(!dt)return this;const h=dt/this.substeps;
    if(this.anchor){this.anchor.updateWorldMatrix(true,false);this.frame.copy(this.anchor.matrixWorld);}
    for(let s=0;s<this.substeps;s++){this.time+=h;this._forces(h);this._integrate(h);for(let it=0;it<this.iterations;it++)this._solve();this._pinsAndCollide();}
    this._sync();return this;}
  _forces(h){const P=this.pos,Q=this.prev,F=this.force,tr=this.tris,a=this._a,b=this._b,c=this._c,n=this._n,w=this._w,p=this._p,wind=this._windVec;F.fill(0);
    const g=this.gravity,pm=this.particleMass;for(let k=0;k<this.count;k++){F[k*3]+=g.x*pm;F[k*3+1]+=g.y*pm;F[k*3+2]+=g.z*pm;}
    if(!this.drag&&!this.skin)return;
    for(let t=0;t<tr.length;t+=3){const i0=tr[t],i1=tr[t+1],i2=tr[t+2];a.fromArray(P,i0*3);b.fromArray(P,i1*3);c.fromArray(P,i2*3);
      p.copy(a).add(b).add(c).multiplyScalar(1/3);this.windAt(p,wind);
      // triangle velocity from Verlet positions
      w.set((P[i0*3]-Q[i0*3]+P[i1*3]-Q[i1*3]+P[i2*3]-Q[i2*3])/(3*h),(P[i0*3+1]-Q[i0*3+1]+P[i1*3+1]-Q[i1*3+1]+P[i2*3+1]-Q[i2*3+1])/(3*h),(P[i0*3+2]-Q[i0*3+2]+P[i1*3+2]-Q[i1*3+2]+P[i2*3+2]-Q[i2*3+2])/(3*h));
      wind.sub(w);b.sub(a);c.sub(a);n.crossVectors(b,c);const area2=n.length();if(area2<1e-9)continue;n.multiplyScalar(1/area2);
      // Pressure drag on the normal component (½ρ·Cd·A·vn|vn|) plus skin friction along the fabric (½ρ·Cf·A·|vt|·vt),
      // which is what makes a flag stream out downwind; each triangle's force is shared by its three vertices.
      const vn=wind.dot(n),tx=wind.x-n.x*vn,ty=wind.y-n.y*vn,tz=wind.z-n.z*vn,vt=Math.sqrt(tx*tx+ty*ty+tz*tz),q=.5*1.2*area2*.5/3,kn=q*this.drag*vn*Math.abs(vn),kt=q*this.skin*vt;
      for(const i of [i0,i1,i2]){F[i*3]+=n.x*kn+tx*kt;F[i*3+1]+=n.y*kn+ty*kt;F[i*3+2]+=n.z*kn+tz*kt;}}}
  _integrate(h){const P=this.pos,Q=this.prev,F=this.force,im=this.invMass,damp=1-this.damping,h2=h*h;
    for(let k=0;k<this.count;k++){if(!im[k])continue;const o=k*3;for(let d=0;d<3;d++){const x=P[o+d],v=(x-Q[o+d])*damp;Q[o+d]=x;P[o+d]=x+v+F[o+d]*im[k]*h2;}}}
  _solve(){const P=this.pos,im=this.invMass,C=this.constraints;
    for(let c=0;c<C.length;c+=4){const a=C[c]*3,b=C[c+1]*3,L=C[c+2],s=C[c+3],wa=im[C[c]],wb=im[C[c+1]],ws=wa+wb;if(!ws)continue;
      const dx=P[b]-P[a],dy=P[b+1]-P[a+1],dz=P[b+2]-P[a+2],d=Math.sqrt(dx*dx+dy*dy+dz*dz);if(d<1e-9)continue;
      const k=(d-L)/(d*ws)*s;P[a]+=dx*k*wa;P[a+1]+=dy*k*wa;P[a+2]+=dz*k*wa;P[b]-=dx*k*wb;P[b+1]-=dy*k*wb;P[b+2]-=dz*k*wb;}}
  _pinsAndCollide(){const P=this.pos,Q=this.prev,v=this._a,T=this.THREE;
    for(const k of this.pins){v.fromArray(this.rest,k*3).applyMatrix4(this.local).applyMatrix4(this.frame);v.toArray(P,k*3);v.toArray(Q,k*3);}
    const th=this.thickness,fr=this.friction,cs=this.colliders,gr=this.ground;if(!cs.length&&gr==null)return;
    const c=this._b,a=this._c,b=this._n;
    for(let k=0;k<this.count;k++){if(!this.invMass[k])continue;const o=k*3;let x=P[o],y=P[o+1],z=P[o+2];
      for(const col of cs){let cx,cy,cz,r=(col.radius||.5)+th;
        if(col.a&&col.b){const A=vec(col.a,a),B=vec(col.b,b);const abx=B.x-A.x,aby=B.y-A.y,abz=B.z-A.z,ll=abx*abx+aby*aby+abz*abz||1;
          const t=clamp(((x-A.x)*abx+(y-A.y)*aby+(z-A.z)*abz)/ll,0,1);cx=A.x+abx*t;cy=A.y+aby*t;cz=A.z+abz*t;}
        else if(col.object){col.object.updateWorldMatrix(true,false);c.set(...(col.offset||[0,0,0])).applyMatrix4(col.object.matrixWorld);cx=c.x;cy=c.y;cz=c.z;}
        else{const C=vec(col.center,c);cx=C.x;cy=C.y;cz=C.z;}
        const dx=x-cx,dy=y-cy,dz=z-cz,d=Math.sqrt(dx*dx+dy*dy+dz*dz);
        if(d<r&&d>1e-9){const s=r/d;x=cx+dx*s;y=cy+dy*s;z=cz+dz*s;// friction: pull the previous position toward the contact so tangential motion slows
          Q[o]+= (x-Q[o])*fr;Q[o+1]+=(y-Q[o+1])*fr;Q[o+2]+=(z-Q[o+2])*fr;}}
      if(gr!=null){const gy=(typeof gr==='function'?gr(x,z):gr)+th;if(y<gy){y=gy;Q[o]+=(x-Q[o])*fr;Q[o+2]+=(z-Q[o+2])*fr;Q[o+1]=gy;}}
      P[o]=x;P[o+1]=y;P[o+2]=z;}}
  _sync(){const attr=this.geometry.attributes.position;attr.array.set(this.pos);attr.needsUpdate=true;this.geometry.computeVertexNormals();this.geometry.computeBoundingSphere();}
  /* Put every particle back at its rest pose under the current anchor transform (after a teleport). */
  reset(){if(this.anchor){this.anchor.updateWorldMatrix(true,false);this.frame.copy(this.anchor.matrixWorld);}const v=this._a;
    for(let k=0;k<this.count;k++){v.fromArray(this.rest,k*3).applyMatrix4(this.local).applyMatrix4(this.frame);v.toArray(this.pos,k*3);v.toArray(this.prev,k*3);}this._sync();return this;}
  /* Largest particle speed of the last step (m/s per substep length estimate). */
  get energy(){let m=0;for(let o=0;o<this.pos.length;o+=3){const dx=this.pos[o]-this.prev[o],dy=this.pos[o+1]-this.prev[o+1],dz=this.pos[o+2]-this.prev[o+2];m=Math.max(m,dx*dx+dy*dy+dz*dz);}return Math.sqrt(m);}
  dispose(){if(this.mesh.parent)this.mesh.parent.remove(this.mesh);this.geometry.dispose();if(this.ownMaterial)this.material.dispose();this.enabled=false;}
};
KE.registerModule('cloth',{provides:['Cloth']});
})();
