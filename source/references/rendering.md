# Rendering and world building

## Contents

1. Version and lighting
2. Terrain and materials
3. Sky, water, and foliage
4. Post-processing and quality
5. Scene composition and performance

## 1. Version and lighting

Use the included Three.js r128 UMD bundle. Set `renderer.outputEncoding=THREE.sRGBEncoding` and `THREE.ACESFilmicToneMapping`. The 2.1 starter uses standard materials with roughness, metalness, normal relief and image-based lighting. Convert manually specified color tints to linear when appropriate; the new terrain/surface shaders decode their embedded color textures themselves. Do not additionally set their custom sampler textures to sRGB. Built-in material `map` textures should use the normal r128 encoding workflow.

`KE.environment(THREE)` creates a six-face procedural sky CubeTexture, marked sRGB. Assign it to `scene.environment`; r128 supplies its standard-material environment prefiltering. Dispose the source when the scene is destroyed. The starter reduces material `envMapIntensity` at night. This is static sky image-based lighting; it does not capture nearby objects or perform dynamic global illumination.

Enable `PCFSoftShadowMap` on supported presets. Use a sun shadow camera around ±25–30 world units, bias around -0.0006, normalBias around .03–.04, and follow the player. Keep the light's target in the scene. The day-cycle helper moves both the light and its target. Shadow maps are disposed and reallocated when resolution changes through `applyRendererSettings`.

The eight-material terrain shader needs more fragment samplers than the minimum WebGL1 guarantee once its ten material samplers, environment, and shadow textures are included. A WebGL2-capable modern phone/browser is the recommended target. Do not claim support for every WebGL1 device. If a target GPU reports shader sampler limits, simplify the terrain material instead of only lowering texture resolution; resolution does not reduce sampler count.

## 2. Terrain and materials

```js
await KE.loadVisualAssets();
const textures = KE.materials(THREE, 512);
const material = KE.splatMaterial(THREE, textures, {scale:.4, relief:.3});
const land = KE.terrain(THREE, {
  w:97, h:97, sub:2, chunk:32,
  height:(i,j)=>heightGrid[j*97+i],
  weights:(i,j)=>[1,0,0,0,0,0,0,0],
  material
});
land.forEach(mesh=>scene.add(mesh));
const y=land.heightAt(worldX,worldZ);
```

A source-grid point `(i,j)` renders at `(i+.5,height,j+.5)`. World bounds are x `.5..w-.5` and z `.5..h-.5`. Out-of-bounds height queries clamp to the edge; that does not automatically stop characters leaving the map. Define world boundary collision explicitly.

Width/height must be integers >=2. Source grid allocation is limited to 4,194,304 points, but subdivision grows memory quadratically; use far smaller fields on phones. `sub` normally comes from settings (1 or 2), supports up to 3, and builds bicubic intermediate heights with a bounded overshoot. `detail(x,z)` adds height before mesh construction. Source and detailed heights must be finite. Height is immutable after construction: rebuild if editing terrain.

`heightAt` interpolates the rendered triangle, including alternating diagonals, and therefore agrees with ray intersections. The old version used a bilinear surface that could differ from the visible triangles. Triangle parity is global across chunks. `normalAt(x,z,outVector?)` computes a finite-difference ground normal for placement/slope checks; it is a smooth local estimate rather than the exact face normal.

`chunk` is cells per mesh edge, default 48, clamped to 1–254. Smaller chunks permit more selective Three.js frustum culling but increase draw calls. This is static chunking, not streamed terrain or geometric LOD. `land.dispose()` removes meshes and geometries only, preserving the shared material/textures for their owner.

Material weight order is always grass, sand, dirt, stone, rock, snow, ash, wood. Provide exactly eight finite nonnegative weights; v2 normalizes the total and uses grass if all eight are zero. Use continuous values for soft biome boundaries. `tint(i,j,weights)` optionally supplies an RGB multiplier. `receiveShadow:false` disables ground shadows.

`KE.materials(THREE,size)` creates eight diffuse CanvasTextures and two packed raw RGBA DataTextures in `.heightMaps`. Size is rounded and clamped to 64–1024. Color and relief use matching mirrored repeats; relief bytes reverse row order to match CanvasTexture UV orientation. Grass, sand, rock and stone come from the bundled generated atlas after `await KE.loadVisualAssets()`. The other surfaces are deterministic procedural textures. If decoding fails, all surfaces use a deterministic fallback. Cache textures for a world.

`KE.splatMaterial(THREE,maps,{scale:.38,relief:.34})` is a MeshStandardMaterial with height-influenced weight blending, triplanar cliff color, macro variation, and derivative normal relief. Relief is derived from color luminance, not a measured height/normal scan. Shader differences controlled by uniforms can share a program cache key. Geometry still supplies `splatA`, `splatB`, and vertex color attributes. The older toon appearance remains available through `KE.legacyRendering.materials` and `KE.legacyRendering.splatMaterial`; `flat` belongs to that legacy path.

`KE.surface(THREE,kind,{color,scale,bump,textureSize,roughness,metalness,emissive,side})` creates detailed standard materials with triplanar sampling. Kinds include bark, roof, leaf, plaster, lacquer, stone, wood, rock and fur. Texture maps are cached by `KE.detailTextures`. Use near-uniform instance scales: the triplanar blend-normal transform is approximate under nonuniform scale. `KE.paintTile` exposes the underlying deterministic texture generator.

The older `KE.objectTextures`, `KE.triplanar` and `toonRamp` are retained for existing games. Dispose shared assets only when their final owner is gone. `KE.disposeObject(scene,{textures:true})` includes textures recorded by the new material hooks. Clear `KE._detailTex` when destroying its entire owning world.

`KE.noise(x,z,period)`, `tileNoise(x,z,size,period)`, and `ridged(x,z,octaves)` provide existing procedural world helpers. Keep noise periods within their 256-cell table's range; default recipes use small integer periods. Use a soft mountain mask to fade ridge amplitude, reduce ridges around paths and buildings, and place objects using the finished terrain.

## 3. Sky, water, and foliage

`KE.sky(THREE,scene,{radius:600,center})` creates a sky dome and sun/moon/halo sprites. `KE.dayCycle(THREE,{sky,sun,hemi,fogColor})` returns `update(dayFraction,targetVector,wet=0)` and a sun direction. Day is 0–.67; night is .67–1. Fraction wraps. The inherited transition is stylized and has a day/night switch rather than a physically continuous solar model. Wetness dims light/fog. Clouds, stars, and rain in Spirit Isle are game-level examples, not a separate volumetric atmosphere subsystem.

`KE.water(THREE,scene,{size,center,level,color,opacity,heightAt})` returns `mesh`, `uniforms`, `update(timeSeconds,light=1)`, and `dispose()`. Passing `heightAt` selects the 2.1 water: a tessellated moving surface, Fresnel color, glints, shallow-water tint, and shoreline foam from a baked 128×128 height field. The encoded ground range is -24..24 world units; the sampled field does not update after terrain edits. Depth is approximate between samples. `opacity:0` remains transparent at every depth. Without `heightAt`, the legacy scrolling-normal effect is retained. This does not simulate refraction, scene reflections, buoyancy or fluid dynamics.

`KE.leafSprayTexture` creates cutout leaf cards. `KE.fernGeometry` creates seven fronds with consistently upward-facing triangles and geometric normals. The starter instances trunks, branches, canopy clusters, leaves, ferns, flowers and rocks, and uses a separate detailed fox model with animated leg groups and tail.

`KE.wind(THREE,material,{amp})` modifies the vertex shader for simple sway and composes with the material's previous compile hook. Set `KE.windUniforms.uTime.value` to simulation time; `uWind.value` adjusts strength. Keep GPU bounding volumes conservative for windy objects. Shadow depth materials do not automatically receive matching wind deformation, so shadow movement can differ; clone the deformation into a customDepthMaterial if close-up accuracy matters.

`KE.grass(THREE,scene,{count,radius,heightAt,density,color})` creates one InstancedMesh and returns `mesh`, `update(playerX,playerZ)`, `setVisible(bool)`, and `dispose()`. Count zero returns null. `density` must return 0–1 and handle map boundaries. Layout refreshes after about two units of movement. Rebuild on grass-count changes and dispose the old object first. Expect visible distribution shifts at cell transitions: this is a compact mobile technique, not continuous world-anchored vegetation streaming.

`KE.glow(THREE,scene,points,{size,inner,outer})` returns additive light points. It starts at opacity zero; set `material.opacity` according to time of day. These are emissive sprites, not light sources illuminating nearby objects. `spriteShadow(THREE,scene,texture,width,height)` creates an invisible shadow-casting plane; position it and call `.face(sunDirection)` each frame.

## 4. Post-processing and quality

`new KE.Post(THREE,renderer,{aa,hdr,ao,bloom,threshold,vignette,grain,saturation,contrast})` provides threshold bloom, blur, grading, grain, and vignette. `bloom` here is a numeric strength; the graphics setting of the same name is a boolean selecting the effect. Render through `.render(scene,camera)` and resize with CSS dimensions via `.setSize(width,height)`; it multiplies by the current renderer pixel ratio internally. `enabled=false` renders directly. `dispose()` releases its targets, full-screen geometry, and materials. It restores the render target that was active before the call.

With `hdr:true`, supported floating-point color-buffer extensions select half-float targets. Scene tone mapping is temporarily disabled, bloom operates on unclamped linear values, and the final composite applies a fitted filmic curve and sRGB encoding. `post.hdr` reports whether the HDR target path was selected. Unsupported devices fall back to unsigned-byte targets and the renderer's normal tone mapping. Target and tone-mapping state are restored even if rendering throws. This fallback has not been profiled on physical phones.

`ao:true` (or a strength number) adds an eight-neighbor depth occlusion approximation when depth textures are supported. It is a local contact-depth effect, not full GTAO or ray-traced occlusion. AO disables multisampled targets so their depth is available; `aa:true` then selects a luminance-edge FXAA pass in the final composite. Without AO, available WebGL2 multisample targets provide AA. Direct-render AA belongs to the renderer constructor and needs a restart to change.

Quality changes should apply in this order:

1. Mutate settings through a preset or panel callback.
2. Apply renderer pixel ratio, shadows, and fog.
3. Resize renderer, then resize/recreate post targets.
4. Dispose and recreate grass if count changed.
5. Rebuild textures/terrain only on an intentional restart or world rebuild.

`KE.settingsPanel(callback)` is a DOM element, not an entire dialog. Provide your own open/close button, focus treatment, max-height scrolling, pause behavior, and styling. Texture detail, terrain detail, and renderer AA need a restart in the starter; the panel explains that. Auto must have a downgrade callback that actually reapplies resources. Hardware detection is a rough initial guess, not a benchmark.

## 5. Scene composition and performance

Build clear silhouettes and a readable path before increasing texture detail. Keep the player visible against the ground, reserve bright/emissive elements for interactions, use fog to separate distance, and place the camera so the horizon and immediate route both remain legible on portrait screens. Prefer a coherent stylized palette over expensive effects without an art purpose.

`KE.batchStatic(THREE,root,{cellSize:16,disposeSource:false,filter})` merges compatible static opaque leaf meshes by material, shadow flags, layers, attribute layout and spatial cell. It preserves world placement relative to the root and returns source mesh count, batch count and draw-call savings. Instanced/skinned meshes, morph targets, interleaved attributes, partial draw ranges, negative transforms, transparent materials, and objects marked `userData.keepSeparate` are left alone. Call only on static owned scenery. Set `disposeSource:true` only when removed geometries have no owners elsewhere. Batching sacrifices per-object identity and individual culling within each cell. It does not implement automatic LOD.

For phones: instance repeated trees/rocks, share materials, keep transparent layers sparse, avoid new vectors in every inner loop, and bound particle counts. Reduce render scale, shadows, grass, then view distance when GPU-bound. Measure startup separately from frame time; procedural textures can cost CPU during initialization. Do not call an effect “optimized” based only on fewer source-code lines.

When diagnosing: reproduce with low quality, inspect JavaScript/shader errors, check draw calls and render-target sizes, compare direct and post rendering, then re-enable effects one at a time. Software rendering in a headless browser verifies integration; it is not a phone performance benchmark.
