/* KE.CascadedShadows — stable cascaded shadow maps for the sun.
   The sun DirectionalLight becomes cascade 0; N-1 shadow-only lights (intensity 0) carry the other cascades.
   Each cascade fits a bounding sphere of its view-frustum slice (rotation invariant) and snaps its centre to
   whole shadow texels, so shadows do not shimmer while the camera moves. Set-up materials evaluate lighting
   once from the sun and blend the cascades' shadow terms across overlap bands (a partition of unity), then
   fade out beyond the shadow distance. Materials that are not set up still light correctly (the extra
   lights have zero intensity) and receive cascade-0 shadows. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const MAX=4;
function buildChunk(THREE){
  const src=THREE.ShaderChunk.lights_fragment_begin,start=src.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'),end=src.indexOf('#if ( NUM_RECT_AREA_LIGHTS > 0 )');
  if(start<0||end<0)throw new Error('KE.CascadedShadows: unexpected lights_fragment_begin chunk (Three.js r128 required)');
  const block=`#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )
	DirectionalLight directionalLight;
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLightShadow directionalLightShadow;
	#endif
	float keCsmShadow = 0.0, keCsmW = 0.0, keCsmZ = vViewPosition.z;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		#if ( UNROLLED_LOOP_INDEX < KE_CSM_CASCADES ) && defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		keCsmCascade = keCascades[ i ];
		keCsmWeight = smoothstep( keCsmCascade.x, keCsmCascade.y, keCsmZ ) * ( 1.0 - smoothstep( keCsmCascade.z, keCsmCascade.w, keCsmZ ) );
		if ( keCsmWeight > 0.0 ) {
			directionalLightShadow = directionalLightShadows[ i ];
			#ifdef USE_KE_PCSS
			keCsmShadow += keCsmWeight * ( receiveShadow ? keShadowPCSS( directionalShadowMap[ i ], directionalLightShadow.shadowBias, vDirectionalShadowCoord[ i ], kePcss[ i ] ) : 1.0 );
			#else
			keCsmShadow += keCsmWeight * ( receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0 );
			#endif
			keCsmW += keCsmWeight;
		}
		#endif
	}
	#pragma unroll_loop_end
	keCsmShadow += 1.0 - keCsmW;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		#if ( UNROLLED_LOOP_INDEX == 0 ) || ( UNROLLED_LOOP_INDEX >= KE_CSM_CASCADES )
		directionalLight = directionalLights[ i ];
		getDirectionalDirectLightIrradiance( directionalLight, geometry, directLight );
		#if ( UNROLLED_LOOP_INDEX == 0 )
		directLight.color *= keCsmShadow;
		#elif defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= all( bvec2( directLight.visible, receiveShadow ) ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif
		RE_Direct( directLight, geometry, material, reflectedLight );
		#endif
	}
	#pragma unroll_loop_end
#endif

`;
  return src.slice(0,start)+'vec4 keCsmCascade; float keCsmWeight;\n'+block+src.slice(end);
}

/* Percentage-closer soft shadows: blocker search, then a filter whose radius grows with the receiver-blocker
   distance in world units (orthographic cascades store linear depth), giving contact-hardening penumbrae. */
const PCSS_GLSL=`
#ifdef USE_KE_PCSS
uniform vec4 kePcss[${MAX}];
float keIgn(vec2 p){return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715))));}
vec2 keSpiral(int i,float n,float rot){float r=sqrt((float(i)+.5)/n);float a=float(i)*2.39996323+rot;return vec2(cos(a),sin(a))*r;}
float keShadowPCSS(sampler2D map,float bias,vec4 coord,vec4 P){coord.xyz/=coord.w;coord.z+=bias;
 if(coord.x<0.||coord.y<0.||coord.x>1.||coord.y>1.||coord.z>1.)return 1.;float rot=keIgn(gl_FragCoord.xy)*6.2831853;
 float blockers=0.,sum=0.;for(int i=0;i<12;i++){float d=unpackRGBAToDepth(texture2D(map,coord.xy+keSpiral(i,12.,rot)*P.z));if(d<coord.z){sum+=d;blockers+=1.;}}
 if(blockers<.5)return 1.;float pen=clamp((coord.z-sum/blockers)*P.x,P.w*1.5,P.y);float lit=0.;
 for(int i=0;i<16;i++)lit+=step(coord.z,unpackRGBAToDepth(texture2D(map,coord.xy+keSpiral(i,16.,rot+1.7)*pen)));return lit/16.;}
#endif
`;
KE.CascadedShadows=class{
  constructor(THREE,scene,{sun,cascades=KE.settings.cascades||3,mapSize=KE.settings.shadowRes||2048,maxFar=null,lambda:splitLambda=.72,overlap=.12,margin=60,bias=-.0004,normalBias=1.2,fadeStart=.85,soft=KE.settings.preset!=='low'&&KE.settings.preset!=='medium',lightAngle=1.2,maxPenumbra=.9,searchDistance=6,cache=KE.settings.shadowCache!==false,cacheSlack=.1,cacheAngle=.35}={}){
    if(!sun||!sun.isDirectionalLight)throw new TypeError('KE.CascadedShadows requires {sun: DirectionalLight}');
    Object.assign(this,{THREE,scene,sun,lambda:splitLambda,overlap,margin,bias,normalBias,fadeStart,maxFar,soft:!!soft,lightAngle,maxPenumbra,searchDistance,cache:!!cache,cacheSlack,cacheAngle});this._rec=[];this._frame=0;this.stats={drawn:0,reused:0};
    this.chunk=buildChunk(THREE);this.uniforms={keCascades:{value:Array.from({length:MAX},()=>new THREE.Vector4(-2,-1,1e9,1e9+1))},kePcss:{value:Array.from({length:MAX},()=>new THREE.Vector4(1,.01,.005,.001))}};
    this.materials=new Set();this.restore=new Map();this.lights=[];this.splits=[];this.direction=new THREE.Vector3(0,-1,0);this.enabled=true;
    this._m=new THREE.Matrix4();this._mi=new THREE.Matrix4();this._v=new THREE.Vector3();this._c=new THREE.Vector3();this._up=new THREE.Vector3(0,1,0);
    this.configure(cascades,mapSize);
    this.onSettings=KE.events.on('settings',s=>{if(typeof s.shadowCache==='boolean')this.cache=s.shadowCache;if(s.cascades!==this.count||s.shadowRes!==this.mapSize)this.configure(s.cascades,s.shadowRes);});
  }
  configure(count,mapSize){const T=this.THREE;count=Math.max(1,Math.min(MAX,Math.round(count||1)));mapSize=mapSize||2048;
    for(const l of this.lights.slice(1)){l.parent&&l.parent.remove(l);l.target.parent&&l.target.parent.remove(l.target);if(l.shadow.map){l.shadow.map.dispose();l.shadow.map=null;}}
    this.lights=[this.sun];this.sun.castShadow=true;
    for(let i=1;i<count;i++){const l=new T.DirectionalLight(0xffffff,0);l.castShadow=true;l.name='ke-csm-'+i;this.scene.add(l,l.target);this.lights.push(l);}
    for(const l of this.lights){if(l.shadow.mapSize.x!==mapSize){l.shadow.mapSize.set(mapSize,mapSize);if(l.shadow.map){l.shadow.map.dispose();l.shadow.map=null;}}l.shadow.bias=this.bias;l.shadow.camera.near=.5;}
    this.count=count;this.mapSize=mapSize;if(this._rec)this._rec.length=0;for(const m of this.materials){m.defines.KE_CSM_CASCADES=count;m.needsUpdate=true;}return this;}
  /* Patch a lit material (Standard, Physical, Phong, Toon). Composes with existing onBeforeCompile hooks. */
  setupMaterial(m){if(!m||this.materials.has(m)||m.userData.keNoCSM)return m;if(!(m.isMeshStandardMaterial||m.isMeshPhongMaterial||m.isMeshToonMaterial))return m;
    const prev=m.onBeforeCompile,ownKey=Object.prototype.hasOwnProperty.call(m,'customProgramCacheKey')?m.customProgramCacheKey:null,prevKey=m.customProgramCacheKey.bind(m),chunk=this.chunk,U=this.uniforms;this.restore.set(m,{prev,ownKey});m.defines=m.defines||{};m.defines.USE_KE_CSM='';m.defines.KE_CSM_CASCADES=this.count;if(this.soft)m.defines.USE_KE_PCSS='';
    m.onBeforeCompile=(sh,r)=>{if(prev)prev.call(m,sh,r);sh.uniforms.keCascades=U.keCascades;sh.uniforms.kePcss=U.kePcss;sh.fragmentShader='uniform vec4 keCascades['+MAX+'];\n'+sh.fragmentShader.replace('#include <shadowmap_pars_fragment>','#include <shadowmap_pars_fragment>\n'+PCSS_GLSL).replace('#include <lights_fragment_begin>',chunk);};
    m.customProgramCacheKey=()=>prevKey()+':ke-csm';
    m.needsUpdate=true;this.materials.add(m);return m;}
  setupScene(root=this.scene){root.traverse(o=>{if(!o.material)return;for(const m of [o.material].flat())this.setupMaterial(m);});return this;}
  /* Practical split scheme (log/uniform blend), then stable sphere fits per cascade.
     Cached far cascades (cache: true): cascade 0 is drawn every frame; the others take turns, at most one per frame,
     each drawn over a sphere cacheSlack larger than it needs and reused on the other frames while the sphere the
     current view needs still fits inside the drawn one and the sun has turned less than cacheAngle degrees. A
     reused cascade keeps the light matrix it was drawn with (Three.js only updates it when the map is drawn), so
     the lookup stays consistent. With 4 cascades that is 2 shadow passes per frame instead of 4. */
  update(camera){if(!this.enabled)return;const T=this.THREE,n=camera.near,far=Math.min(camera.far,this.maxFar||KE.settings.view||camera.far),N=this.count;
    this.direction.copy(this.sun.target.position).sub(this.sun.position).normalize();if(!Number.isFinite(this.direction.x))this.direction.set(0,-1,0);
    const s=this.splits;s.length=0;s.push(n);for(let i=1;i<N;i++){const f=i/N;s.push(this.lambda*n*Math.pow(far/n,f)+(1-this.lambda)*(n+(far-n)*f));}s.push(far);
    const fov=(camera.fov||50)*Math.PI/180,k2=1+Math.pow(Math.tan(fov/2),2)*(1+camera.aspect*camera.aspect),k=Math.sqrt(k2-1);
    camera.updateMatrixWorld();const fwd=this._v.set(0,0,-1).transformDirection(camera.matrixWorld);
    // Light view basis for texel snapping.
    const up=Math.abs(this.direction.y)>.99?this._up.set(1,0,0):this._up.set(0,1,0);this._m.lookAt(this._c.set(0,0,0),this.direction,up);this._mi.copy(this._m).invert();
    const cache=!!this.cache&&N>1,slots=Math.max(2,N-1),due=cache?this._frame%slots+1:-1,rec=this._rec,cosA=Math.cos(this.cacheAngle*Math.PI/180),d=this.direction;this._frame++;
    const st=this.stats;st.drawn=0;st.reused=0;
    for(let i=0;i<N;i++){const b=i>0?(s[i]-s[i-1])*this.overlap:0,near=Math.max(n,s[i]-b),farI=s[i+1];
      const zc=Math.min(farI,(near+farI)*.5*k2),need=Math.sqrt((farI-zc)**2+(farI*k)**2)*1.02,center=this._c.copy(camera.position).addScaledVector(fwd,zc);
      const l=this.lights[i],cam=l.shadow.camera,cached=cache&&i>0,r=cached?need*(1+this.cacheSlack):need;l.shadow.autoUpdate=!cached;
      const nb=i+1<N?(s[i+1]-s[i])*this.overlap:(far-s[i])*(1-this.fadeStart),v=this.uniforms.keCascades.value[i];
      v.set(i===0?-2:s[i]-b,i===0?-1:s[i]+1e-4,s[i+1]-nb,s[i+1]+1e-4);
      if(cached){const q=rec[i];if(q&&i!==due&&Math.hypot(center.x-q.x,center.y-q.y,center.z-q.z)+need<=q.r&&q.dx*d.x+q.dy*d.y+q.dz*d.z>=cosA&&q.map===this.mapSize){st.reused++;continue;}
        rec[i]={x:center.x,y:center.y,z:center.z,r,dx:d.x,dy:d.y,dz:d.z,map:this.mapSize};l.shadow.needsUpdate=true;}
      st.drawn++;
      const texel=2*r/this.mapSize;center.applyMatrix4(this._mi);center.x=Math.floor(center.x/texel)*texel;center.y=Math.floor(center.y/texel)*texel;center.applyMatrix4(this._m);
      Object.assign(cam,{left:-r,right:r,top:r,bottom:-r,near:.5,far:2*r+2*this.margin});cam.updateProjectionMatrix();
      l.position.copy(center).addScaledVector(this.direction,-(r+this.margin));l.target.position.copy(center);l.target.updateMatrixWorld();l.updateMatrixWorld();
      l.shadow.normalBias=texel*this.normalBias;l.shadow.bias=this.bias*(1+i*.5);
      {const uvPerWorld=1/(2*r),tanA=Math.tan(this.lightAngle*Math.PI/180),range=cam.far-cam.near;this.uniforms.kePcss.value[i].set(range*tanA*uvPerWorld,this.maxPenumbra*uvPerWorld,Math.max(this.searchDistance*tanA*uvPerWorld,2/this.mapSize),1/this.mapSize);}
      if(i>0){l.color.copy(this.sun.color);l.intensity=0;}}
    for(let i=N;i<MAX;i++)this.uniforms.keCascades.value[i].set(-2,-1,1e9,1e9+1);}
  /* Redraw every cascade on the next update (e.g. after moving many shadow casters at once). */
  invalidate(){this._rec.length=0;return this;}
  dispose(){this.enabled=false;this.onSettings&&this.onSettings();for(const l of this.lights.slice(1)){l.parent&&l.parent.remove(l);l.target.parent&&l.target.parent.remove(l.target);if(l.shadow.map)l.shadow.map.dispose();}this.lights=[this.sun];
    for(const m of this.materials){const r=this.restore.get(m);delete m.defines.USE_KE_CSM;delete m.defines.KE_CSM_CASCADES;delete m.defines.USE_KE_PCSS;m.onBeforeCompile=r.prev;if(r.ownKey)m.customProgramCacheKey=r.ownKey;else delete m.customProgramCacheKey;m.needsUpdate=true;}this.materials.clear();this.restore.clear();}
};
KE.registerModule('shadows',{provides:['CascadedShadows']});
})();
