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
			keCsmShadow += keCsmWeight * ( receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0 );
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

KE.CascadedShadows=class{
  constructor(THREE,scene,{sun,cascades=KE.settings.cascades||3,mapSize=KE.settings.shadowRes||2048,maxFar=null,lambda:splitLambda=.72,overlap=.12,margin=60,bias=-.0004,normalBias=1.2,fadeStart=.85}={}){
    if(!sun||!sun.isDirectionalLight)throw new TypeError('KE.CascadedShadows requires {sun: DirectionalLight}');
    Object.assign(this,{THREE,scene,sun,lambda:splitLambda,overlap,margin,bias,normalBias,fadeStart,maxFar});
    this.chunk=buildChunk(THREE);this.uniforms={keCascades:{value:Array.from({length:MAX},()=>new THREE.Vector4(-2,-1,1e9,1e9+1))}};
    this.materials=new Set();this.restore=new Map();this.lights=[];this.splits=[];this.direction=new THREE.Vector3(0,-1,0);this.enabled=true;
    this._m=new THREE.Matrix4();this._mi=new THREE.Matrix4();this._v=new THREE.Vector3();this._c=new THREE.Vector3();this._up=new THREE.Vector3(0,1,0);
    this.configure(cascades,mapSize);
    this.onSettings=KE.events.on('settings',s=>{if(s.cascades!==this.count||s.shadowRes!==this.mapSize)this.configure(s.cascades,s.shadowRes);});
  }
  configure(count,mapSize){const T=this.THREE;count=Math.max(1,Math.min(MAX,Math.round(count||1)));mapSize=mapSize||2048;
    for(const l of this.lights.slice(1)){l.parent&&l.parent.remove(l);l.target.parent&&l.target.parent.remove(l.target);if(l.shadow.map){l.shadow.map.dispose();l.shadow.map=null;}}
    this.lights=[this.sun];this.sun.castShadow=true;
    for(let i=1;i<count;i++){const l=new T.DirectionalLight(0xffffff,0);l.castShadow=true;l.name='ke-csm-'+i;this.scene.add(l,l.target);this.lights.push(l);}
    for(const l of this.lights){if(l.shadow.mapSize.x!==mapSize){l.shadow.mapSize.set(mapSize,mapSize);if(l.shadow.map){l.shadow.map.dispose();l.shadow.map=null;}}l.shadow.bias=this.bias;l.shadow.camera.near=.5;}
    this.count=count;this.mapSize=mapSize;for(const m of this.materials){m.defines.KE_CSM_CASCADES=count;m.needsUpdate=true;}return this;}
  /* Patch a lit material (Standard, Physical, Phong, Toon). Composes with existing onBeforeCompile hooks. */
  setupMaterial(m){if(!m||this.materials.has(m)||m.userData.keNoCSM)return m;if(!(m.isMeshStandardMaterial||m.isMeshPhongMaterial||m.isMeshToonMaterial))return m;
    const prev=m.onBeforeCompile,ownKey=Object.prototype.hasOwnProperty.call(m,'customProgramCacheKey')?m.customProgramCacheKey:null,prevKey=m.customProgramCacheKey.bind(m),chunk=this.chunk,U=this.uniforms;this.restore.set(m,{prev,ownKey});m.defines=m.defines||{};m.defines.USE_KE_CSM='';m.defines.KE_CSM_CASCADES=this.count;
    m.onBeforeCompile=(sh,r)=>{if(prev)prev.call(m,sh,r);sh.uniforms.keCascades=U.keCascades;sh.fragmentShader='uniform vec4 keCascades['+MAX+'];\n'+sh.fragmentShader.replace('#include <lights_fragment_begin>',chunk);};
    m.customProgramCacheKey=()=>prevKey()+':ke-csm';
    m.needsUpdate=true;this.materials.add(m);return m;}
  setupScene(root=this.scene){root.traverse(o=>{if(!o.material)return;for(const m of [o.material].flat())this.setupMaterial(m);});return this;}
  /* Practical split scheme (log/uniform blend), then stable sphere fits per cascade. */
  update(camera){if(!this.enabled)return;const T=this.THREE,n=camera.near,far=Math.min(camera.far,this.maxFar||KE.settings.view||camera.far),N=this.count;
    this.direction.copy(this.sun.target.position).sub(this.sun.position).normalize();if(!Number.isFinite(this.direction.x))this.direction.set(0,-1,0);
    const s=this.splits;s.length=0;s.push(n);for(let i=1;i<N;i++){const f=i/N;s.push(this.lambda*n*Math.pow(far/n,f)+(1-this.lambda)*(n+(far-n)*f));}s.push(far);
    const fov=(camera.fov||50)*Math.PI/180,k2=1+Math.pow(Math.tan(fov/2),2)*(1+camera.aspect*camera.aspect),k=Math.sqrt(k2-1);
    camera.updateMatrixWorld();const fwd=this._v.set(0,0,-1).transformDirection(camera.matrixWorld);
    // Light view basis for texel snapping.
    const up=Math.abs(this.direction.y)>.99?this._up.set(1,0,0):this._up.set(0,1,0);this._m.lookAt(this._c.set(0,0,0),this.direction,up);this._mi.copy(this._m).invert();
    for(let i=0;i<N;i++){const b=i>0?(s[i]-s[i-1])*this.overlap:0,near=Math.max(n,s[i]-b),farI=s[i+1];
      const zc=Math.min(farI,(near+farI)*.5*k2),r=Math.sqrt((farI-zc)**2+(farI*k)**2)*1.02,center=this._c.copy(camera.position).addScaledVector(fwd,zc);
      const texel=2*r/this.mapSize;center.applyMatrix4(this._mi);center.x=Math.floor(center.x/texel)*texel;center.y=Math.floor(center.y/texel)*texel;center.applyMatrix4(this._m);
      const l=this.lights[i],cam=l.shadow.camera;Object.assign(cam,{left:-r,right:r,top:r,bottom:-r,near:.5,far:2*r+2*this.margin});cam.updateProjectionMatrix();
      l.position.copy(center).addScaledVector(this.direction,-(r+this.margin));l.target.position.copy(center);l.target.updateMatrixWorld();l.updateMatrixWorld();
      l.shadow.normalBias=texel*this.normalBias;l.shadow.bias=this.bias*(1+i*.5);
      if(i>0){l.color.copy(this.sun.color);l.intensity=0;}
      const nb=i+1<N?(s[i+1]-s[i])*this.overlap:(far-s[i])*(1-this.fadeStart),v=this.uniforms.keCascades.value[i];
      v.set(i===0?-2:s[i]-b,i===0?-1:s[i]+1e-4,s[i+1]-nb,s[i+1]+1e-4);}
    for(let i=N;i<MAX;i++)this.uniforms.keCascades.value[i].set(-2,-1,1e9,1e9+1);}
  dispose(){this.enabled=false;this.onSettings&&this.onSettings();for(const l of this.lights.slice(1)){l.parent&&l.parent.remove(l);l.target.parent&&l.target.parent.remove(l.target);if(l.shadow.map)l.shadow.map.dispose();}this.lights=[this.sun];
    for(const m of this.materials){const r=this.restore.get(m);delete m.defines.USE_KE_CSM;delete m.defines.KE_CSM_CASCADES;m.onBeforeCompile=r.prev;if(r.ownKey)m.customProgramCacheKey=r.ownKey;else delete m.customProgramCacheKey;m.needsUpdate=true;}this.materials.clear();this.restore.clear();}
};
KE.registerModule('shadows',{provides:['CascadedShadows']});
})();
