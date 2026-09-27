# Rendering v3 (Tenko) · 3.0.0

The v3 renderer adds an HDR frame pipeline, a physically based sky with volumetric clouds and a real-time sky light, stable cascaded shadows, a pooled many-light system and a single-layer water model. Everything runs on the bundled Three.js r128 with WebGL2; each system reports or degrades when an extension is missing. The 2.x helpers (`KE.Post`, `KE.sky`, `KE.dayCycle`, `KE.water`) remain for existing games.

## Contents

1. Frame setup
2. KE.Pipeline
3. KE.SkyAtmosphere
4. KE.CascadedShadows
5. KE.LightPool
6. KE.Water
7. Shared uniforms, layers and custom translucent materials
8. Quality settings, console variables and costs
9. Limits
10. KE.ProbeVolume (dynamic diffuse GI)
11. KE.SurfaceWeather (wet surfaces, puddles, snow)

## 1. Frame setup

```js
const renderer = new THREE.WebGLRenderer({antialias:false, powerPreference:'high-performance'});
renderer.outputEncoding = THREE.sRGBEncoding; renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = KE.settings.shadows; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(55, w/h, .15, 1400);
KE.prepareCamera(camera);                       // enables the translucent layer for direct rendering
const sun = new THREE.DirectionalLight(0xffffff, 3); scene.add(sun, sun.target);
const sky = new KE.SkyAtmosphere(THREE, renderer, scene, {sun, time:.2});
const water = new KE.Water(THREE, scene, {level:0, sky});
// … build the world …
const csm = new KE.CascadedShadows(THREE, scene, {sun}); csm.setupScene();
const lights = new KE.LightPool(THREE, scene);
const pipeline = new KE.Pipeline(THREE, renderer, {sun});
// every frame, in this order:
sky.update(dt, camera); csm.update(camera); lights.update(dt, camera);
pipeline.options.fog.color.copy(sky.fogColor);
water.update(dt, camera, {pipeline});
pipeline.render(scene, camera, dt);
```

`pipeline.render` falls back to `renderer.render` when `KE.settings.pipeline` is false (the Low preset), so the same frame code serves every preset. Spirit Isle (`assets/starter.html`) is the complete reference integration.

## 2. KE.Pipeline

`new KE.Pipeline(THREE, renderer, options)` creates render targets lazily from `renderer.getDrawingBufferSize()` and rebuilds them when the size or pixel ratio changes. Calling `setSize()` is optional.

Frame order:

1. **Opaque pass** into a half-float target with a 24-bit depth texture, tone mapping disabled, excluding the translucent layer. With TAA the projection is jittered by a Halton(2,3) sequence through `camera.setViewOffset`; the camera is restored afterwards. When `fog.replaceSceneFog` is true, `scene.fog` is removed for this pass and replaced by post fog.
2. **Scene copies**: HDR colour and linear view depth (R32F) are copied and published through `KE.sceneUniforms`.
3. **Translucent pass**: objects on `KE.LAYERS.TRANSLUCENT` render over the opaque result with depth testing and may sample the copies. Background and shadow-map updates are suppressed for this pass.
4. **GTAO** at half resolution: horizon-based ambient occlusion with the cosine-weighted arc integral (2–3 slices × 6–8 steps, per-frame noise), positions and normals reconstructed from depth, then a depth-aware separable blur and bilateral upsampling. It is screen-space only: occluders outside the view or hidden behind surfaces are missed.
5. **SSGI** (optional, Ultra/Cinematic) at half resolution: cosine rays marched against depth; radiance comes from the previous frame's reprojected image; temporal accumulation and bilateral blur. There is no albedo buffer, so bounce light is tinted with the receiving pixel's normalised colour. Treat it as an approximate one-bounce, screen-limited effect.
6. **Lighting composite**: AO, bounce light, and exponential height fog (`density·exp(-falloff·(h-height))`, analytically integrated along the view ray) with directional sun inscattering and optional horizon haze over the sky.
7. **Volumetric fog** (with `volumetrics`): a half-resolution, per-frame-jittered march (20 steps up to `volumetricFog.maxDistance`) through exponential height fog that tests sun visibility in each cascade's shadow map (call `pipeline.setShadowSource(csm)`; without it only the sun's own shadow map is used) with a Henyey-Greenstein phase, then a depth-aware blur. This adds shadowed in-scattering — light shafts through trees and architecture — and the analytic fog's unshadowed sun inscatter is reduced accordingly. Options: `volumetricFog` {`enabled`, `density` .012, `falloff` .22, `height` 0, `anisotropy` .45, `intensity` 1, `maxDistance` 50, `steps` 20}. It is a screen-space ray march, not a froxel volume: local lights do not scatter.
8. **Light shafts**: bright sky around the sun's screen position radially blurred in two chained passes, faded by sun visibility and elevation.
9. **TAA / temporal upscaling**: with `upscale` < 1 (`KE.settings.upscale`: Medium .67, High .8), steps 1–8 run at the internal resolution (display × upscale) with a 16-sample jitter sequence, and TAA resolves into display-resolution history, so accumulated jittered samples restore detail; final sharpening strengthens slightly when upscaling. Upscaling requires TAA and is disabled with it. TAA itself uses depth-dilated camera reprojection with the unjittered matrices, 3×3 YCoCg variance clipping, Catmull-Rom history sampling, luminance weighting and motion-adaptive blend. Reprojection assumes a static scene; fast-moving objects rely on the neighbourhood clip, which can soften them slightly. Call `resetHistory()` after camera cuts or teleports.
10. **Depth of field** (optional): circle of confusion from linear depth, half-resolution 32-tap golden-angle gather, focus from `dof.focusDistance` or `autoFocus` (screen centre).
11. **Motion blur** (optional): camera-only velocity from depth reprojection, 10 jittered taps.
12. **Bloom**: 13-tap downsample chain (Karis-weighted first level, soft threshold) and additive tent upsampling over up to six levels.
13. **Eye adaptation**: centre-weighted log-average luminance reduced on the GPU (64² → 1²), adapted with separate up/down rates; no CPU readback. **Local exposure** (`localExposure.enabled`, HDR only, console `r.LocalExposure`): the scene's log luminance is averaged into a 64-texel-wide grid (height follows the aspect ratio) and blurred with a separable 9-tap Gaussian.
14. **Final**: exposure; local exposure, which takes a cross-bilateral base from the grid (3×3 taps weighted by `exp(-Δlog²/2)` against the pixel's own log luminance), blends it with the blurred grid by `blurredBlend`, pulls the base toward the adapted middle grey by `highlightContrast` above it and `shadowContrast` below it (1 = off), keeps the pixel's detail above the base times `detail`, and clamps the change to ±4 stops; bloom, white balance, saturation/contrast around mid-grey, fitted ACES, lift/gamma/gain, vignette, film grain, chromatic aberration, TAA sharpening, sRGB encode and dithering. FXAA runs instead of TAA sharpening when TAA is off and `KE.settings.aa` is on.

Options (defaults in parentheses): `taa` (true), `taaBlend` (.1), `upscale` (1), `gtao` (true), `aoRadius` (1.1 world units), `aoStrength` (.85), `aoPower` (1.4), `ssgi` (false), `giStrength` (.55), `giRadius` (3), `bloom` (true), `bloomStrength` (.045), `bloomRadius` (1), `bloomThreshold` (1.2), `bloomKnee` (.6), `lensFlare` (.035; image-based ghosts and halo from the bloom chain, 0 disables), `autoExposure` (true), `exposure` (1, manual; multiplied by `renderer.toneMappingExposure`), `exposureCompensation` (0 EV), `exposureKey` (.2), `minExposure`/`maxExposure` (.25/4), `adaptUp`/`adaptDown` (2.5/1.2 per second), `fxaa`, `sharpen` (.18), `volumetrics` (true), `shaftStrength` (.25), `sun` (DirectionalLight used for fog inscatter, shafts and shared sun uniforms), `fog` {`enabled`, `density` .012, `falloff` .12, `height` 0, `start` 4, `maxOpacity` .9, `color` Color, `inscatter` 1.2, `inscatterExponent` 12, `sky` .35, `replaceSceneFog` true}, `dof` {`enabled`, `focusDistance` 8, `aperture` .035, `maxBlur` 10 px, `autoFocus`}, `motionBlur` {`enabled`, `strength` .6}, `grading` {`saturation`, `contrast`, `temperature` (-1..1), `tint`, `lift`/`gamma`/`gain` (RGB arrays), `vignette`, `grain`, `chromaticAberration`}, `debugView`.

Methods: `set(partialOptions)` deep-merges groups; `applySettings(KE.settings)` maps quality keys (it also runs automatically on the `settings` event); `render(scene, camera, dt)`; `resetHistory()`; `textures` (`sceneColor`, `sceneDepth`, `depth`, `output`); `stats` (`passes`, `ms` CPU submission time); `dispose()`.

Debug views (`pipeline.options.debugView` or console `r.ViewMode`): `lit`, `ao`, `depth`, `bloom`, `ssgi`, `unlit`/`raw` (scene colour before post), `lighting` (luminance), `localexposure` (the local exposure change: mid-grey none, darker = pulled down, one grey step per stop/4).

Local exposure options: `localExposure: {enabled: true, highlightContrast: .75, shadowContrast: .9, detail: 1, blurredBlend: .4}`. Cost: three passes over a 64×N grid and ten extra texture reads per output pixel. The bilateral lookup limits halos at strong edges but does not remove them at the grid's 1/64-of-width scale.

Memory at 1920×1080: about eight full-resolution half-float targets (~16 MB each) plus half-resolution and small targets — roughly 150 MB of render targets at Ultra. Lower `KE.settings.scale` on phones.

## 3. KE.SkyAtmosphere

`new KE.SkyAtmosphere(THREE, renderer, scene, options)` renders a sky model into a cube map and uses it as `scene.background` and, after PMREM prefiltering, as `scene.environment`.

- **Atmosphere**: single scattering with Rayleigh, Mie (Cornette–Shanks phase, g=.8) and an ozone absorption layer over a 6360 km planet, 12–16 view and 6–8 light samples, stable ray–sphere forms in kilometres. There is no multiple-scattering LUT; the view path is capped at 110 km to keep the horizon from over-reddening. Below-horizon directions blend to a ground colour.
- **Clouds**: raymarched slab (default 1.4–3.4 km) over a tileable 64³ Perlin-Worley/Worley-fBm noise atlas generated once on the GPU; weather-map coverage variation, height-shaped density with erosion, five-step light march, three-octave multiple-scattering approximation, dual-lobe Henyey-Greenstein phase, beer-powder term, distance fade. `clouds` quality: 0 off, 1 = 24 steps, 2 = 48 steps (+512² faces when chosen at construction).
- **Capture**: one cube face per frame (all six after `refresh()`), then PMREM when a cycle completes and `envInterval` seconds have passed. Weather and time changes therefore reach reflections and ambient light within a few frames.
- **Lights**: the directional light's colour is the model's transmittance toward the sun; by night it switches to cool moonlight. Sun and moon discs (HDR, bloom-friendly) and a twinkling star field follow the camera. The active light is also written to `KE.sceneUniforms` (`keSunDirection`, `keSunColor`).

Options: `sun`, `hemi` (receives sky/ground ambient colours), `time` (.22), `clouds` (`KE.settings.clouds`), `coverage` (.42), `cloudDensity` (1), `cloudLayer` ([1.4, 3.4] km), `wind` ([.012, .004] noise units/s), `sunIntensity` (22, sky radiance scale), `skyScale` (1), `sunLightIntensity` (4.2), `moonLightIntensity` (.32), `lightDistance` (120), `environment`, `background`, `stars`, `sunDisc`, `moonDisc`, `envInterval` (1.25 s), `cubeSize`.

Methods and state: `update(dt, camera)`, `setTime(dayFraction)` (0 sunrise, .335 noon, .67 sunset, .67–1 night — the `KE.dayCycle` convention), `setSunDirection(v)` (manual), `setWeather({coverage, density, wind})`, `setCloudQuality(q)`, `refresh()`, `sunDirection`, `moonDirection`, `lightDirection`, `sunColor`, `fogColor`, `zenithColor`, `ambientSky`, `ambientGround`, `night` (0..1), `isNight`, `environment`, `envIntensity`, `dispose()`. `KE.atmosphere.scatter/transmittance` expose the CPU model.

Clouds do not shadow the ground, and the sun is not dimmed by clouds automatically (Spirit Isle scales the light when raining).

## 4. KE.CascadedShadows

`new KE.CascadedShadows(THREE, scene, {sun, cascades, mapSize, maxFar, lambda:.72, overlap:.12, margin:60, bias:-.0004, normalBias:1.2 (texels), fadeStart:.85, soft, lightAngle:1.2 (degrees), maxPenumbra:.9 (world units), searchDistance:6})`.

With `soft` (default on High and above) cascades use percentage-closer soft shadows: a 12-tap blocker search, then a 16-tap filter whose radius is the receiver–blocker distance (linear in the orthographic cascade) times `tan(lightAngle)`, clamped to `maxPenumbra`, with per-pixel rotated spiral taps that TAA resolves. Contact points stay sharp and long shadows soften. Otherwise Three's PCF soft shadows are used.

The sun becomes cascade 0; extra cascades are shadow-only directional lights with zero intensity. Splits use the practical log/uniform blend up to `maxFar` (default `KE.settings.view`). Each cascade fits a bounding sphere of its frustum slice (so the projection size never changes with camera rotation) and snaps to whole texels. `setupMaterial(m)` / `setupScene()` patch Standard, Physical, Phong and Toon materials (composing with existing `onBeforeCompile` hooks) to evaluate the sun once and blend cascade shadows across overlap bands, fading out beyond the shadow distance. Unpatched materials still light correctly and receive cascade-0 shadows; Lambert materials multiply cascade shadows. Call `update(camera)` after anything that moves the sun. Cascade count and resolution follow `KE.settings.cascades`/`shadowRes`. Keep the sun and cascade lights as the only shadow-casting directional lights. `dispose()` restores material hooks.

## 5. KE.LightPool

`new KE.LightPool(THREE, scene, {max: KE.settings.lights, fade:6, shadows:0})` owns a fixed set of real `PointLight`s. `add({position, color, intensity, distance, decay, flicker, priority, enabled})` returns an id; `set(id, patch)`, `remove(id)`, `intensity` (global multiplier, e.g. night factor), `update(dt, camera)`. Lights are ranked by intensity, proximity and frustum visibility; assignments are sticky and crossfade. Idle real lights stay in the scene at zero intensity so lit materials never recompile. Changing `KE.settings.lights` resizes the pool (one recompile).

## 6. KE.Water

`new KE.Water(THREE, scene, options)` creates a camera-following radial grid (48–88 rings × 96–176 segments, geometric spacing from 0.12 units to `radius`) on the translucent layer.

- **Waves**: `KE.waterWaves({wind, wavelength, amplitude, choppiness, count, spread, seed})` builds up to eight Gerstner waves with deep-water dispersion; waves fade with distance to avoid aliasing. `setWaves(list)` replaces them.
- **Shading**: Schlick Fresnel between reflection (sky cube, refined by screen-space reflections when the pipeline is active and `KE.settings.ssr`) and refraction of the opaque scene copy with Beer–Lambert absorption (`absorb`, per-channel per unit) and in-scattering (`scatter`); animated Voronoi caustics on the submerged ground, shoreline foam lines from the water-column depth, crest foam from wave folding, sun glints, crest subsurface glow and rain ripples (`water.rain` 0..1). From below, a Snell's-window refraction of the sky.
- **Queries**: `displacement(x0,z0,t)`, `heightAt(x,z,t)` (inverts the horizontal Gerstner shift by fixed-point iteration), `normalAt(x,z,t)`, `isUnderwater(camera)` — identical wave maths to the shader, for buoyancy and swimming.
- **Underwater**: `update(dt, camera, {pipeline})` holds the pipeline fog at `underwaterFog` settings while the camera is submerged and restores it on surfacing.
- **No pipeline**: the surface alpha-blends; pass `heightAt`, `bakedCenter`, `bakedSize` to bake a shoreline depth map (−24..24 range) for foam and absorption.

Options: `level`, `radius` (1600), `rings`, `segments`, `waves`, `wind`, `wavelength` (7), `amplitude` (.12), `choppiness` (.8), `waveCount` (6), `fadeStart`/`fadeEnd`, `scatter`, `absorb`, `foamColor`, `foamDepth` (.3), `refraction` (.035), `detail` (.35), `sunGlint`, `caustics`, `sky` (KE.SkyAtmosphere or cube texture), `heightAt`/`bakedCenter`/`bakedSize`, `opacity`, `horizon`/`zenith` (fallback reflection colours), `underwaterFog`.

It does not simulate fluid dynamics, flow maps, or wakes; SSR only reflects what is on screen.

## 7. Shared uniforms, layers and custom translucent materials

`KE.sceneUniforms(THREE)` returns one set of uniform objects shared by reference: `keSceneColor`, `keSceneDepth` (linear view depth, world units), `keHasScene`, `keResolution`, `keNearFar`, `keProjection`, `keInvProjection`, `keViewMatrix`, `keInvView`, `keTime`, `keFrame`, `keSSR`, `keSunDirection`, `keSunColor`, `keExposure`. `KE.GLSL_SCENE_DECL` declares them. To write a refractive or depth-fading material:

```js
const U = KE.sceneUniforms(THREE);
const m = new THREE.ShaderMaterial({uniforms:{...U, tint:{value:new THREE.Color(.2,.5,.6)}}, transparent:true,
  vertexShader:`varying vec3 vView; void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vView = mv.xyz; gl_Position = projectionMatrix*mv; }`,
  fragmentShader: KE.GLSL_SCENE_DECL + `uniform vec3 tint; varying vec3 vView;
    void main(){ vec2 uv = gl_FragCoord.xy/keResolution; float thickness = texture2D(keSceneDepth, uv).r + vView.z;
      vec3 behind = keHasScene > .5 ? texture2D(keSceneColor, uv).rgb : tint;
      gl_FragColor = vec4(mix(behind, tint, clamp(thickness*.3, 0., 1.)), 1.); }`});
mesh.layers.set(KE.LAYERS.TRANSLUCENT);
```

`KE.GLSL.ssr` provides `keTraceSSR(viewPos, viewNormal, roughness, jitter)` → rgb + confidence for such materials. Other shared snippets: `KE.GLSL.hash`, `.noise` (value noise, fBm, curl), `.color` (luma, fitted ACES, sRGB, YCoCg), `.depth`. `KE.FullScreenQuad` and `KE.FULLSCREEN_VS` support custom passes.

## 8. Quality settings, console variables and costs

| Setting | Low | Medium | High | Ultra | Cinematic |
|---|---|---|---|---|---|
| pipeline (HDR post) | off | on | on | on | on |
| gi (probe volume) | – | – | ✓ | ✓ | ✓ |
| upscale (internal resolution) | 1 | .67 | .8 | 1 | 1 |
| taa / gtao / ssr | – / – / – | ✓ / – / – | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ |
| ssgi | – | – | – | ✓ | ✓ |
| volumetrics (shafts, fog inscatter) | – | – | ✓ | ✓ | ✓ |
| clouds | off | fast | fast | rich | rich |
| cascades | 1 | 2 | 3 | 4 | 4 |
| dynamic point lights | 2 | 4 | 6 | 8 | 12 |
| dof / motion blur | – | – | – | – | ✓ / ✓ |

Console variables (`KE.cvars`, also typed into the console UI): `r.GI`, `r.TAA`, `r.GTAO`, `r.SSR`, `r.SSGI`, `r.Bloom`, `r.Shadows`, `r.Shadow.Cascades`, `r.Shadow.Resolution`, `r.Volumetrics`, `r.Clouds`, `r.DOF`, `r.MotionBlur`, `r.AutoExposure`, `r.Pipeline`, `r.ScreenPercentage`, `r.Upscale`, `r.ViewDistance`, `r.LODBias`, `r.Lights`, `foliage.Grass`, `fx.Budget`, `r.Fur`, `r.ViewMode`.

Relative GPU cost, cheapest first: bloom and exposure (small targets) < fog/composite < GTAO < TAA < light shafts < DOF < SSGI. Cloud cost is amortised over six frames by the cube capture. No frame-time figures are claimed; measure on the target device (`KE.GPUTimer` reports GPU time where `EXT_disjoint_timer_query` is exposed).

## 9. Limits

This is a forward renderer on WebGL2. There is no G-buffer: SSR is limited to translucent-layer materials (water, custom), screen-space bounce light has no albedo input, and AO multiplies all lighting rather than only indirect light. World-space GI comes from the probe volume (section 10), which has no per-probe visibility data and no distance-field or surface-cache tracing. Shadows are rasterised cascades, not virtual shadow maps. The pipeline has not been profiled on physical phones.

## 10. KE.ProbeVolume (dynamic diffuse GI)

```js
const gi = new KE.ProbeVolume(THREE, renderer, scene, {
  bounds: new THREE.Box3(new THREE.Vector3(10,0,10), new THREE.Vector3(86,12,86)),
  spacing: 7, heightAt: terrain.heightAt, faceSize: 16, probesPerFrame: 1, hysteresis: .8
});
gi.tag(scene);        // put significant static meshes on KE.LAYERS.GI (2)
gi.setupScene();      // patch Standard/Physical materials
// per frame, after sky/shadow updates and before rendering:
gi.update(camera);
```

A grid of probes covers `bounds` (`spacing` or explicit `counts`). With `heightAt`, probes below ground are lifted `lift` units above it and dropped if they would duplicate the next layer. Each update renders `probesPerFrame` probes — six `faceSize`² faces of the GI layer plus the sky background, shadows reused, no tone mapping — nearest to the camera first, and projects each cube onto order-1 spherical harmonics on the GPU (128 Fibonacci directions). New values blend into the atlas with `hysteresis`; the first capture of a probe replaces its value. Because patched materials sample the volume while probes are captured, each refresh adds another bounce.

**Visibility** (`visibility: true`, default; needs a half-float or float colour target, otherwise it switches itself off). Each capture also renders the GI layer once more per face with a two-sided distance material into a float cube (distance to the probe, back-face flag), then writes an 8×8 octahedral tile per probe holding the mean and mean² of distance over a small cone per texel and the probe's back-face fraction over 48 directions. Shading runs a Chebyshev test per probe, as DDGI does: when the shaded point (offset 0.2 along its normal) is farther from the probe than the stored mean distance in that direction, the weight becomes `max(p³, .05)` with `p = σ²/(σ² + (d − μ)²)`, so probes on the far side of a wall stop lighting it. Probes whose sphere is more than about 25–35 % back faces are buried in geometry and are dropped; the remaining probes are renormalised, and a point with no surviving probe falls back to the sky light. Moments blend with the same `hysteresis` as irradiance. `uniforms.keProbeVisOn.value = 0` disables the test at run time (for comparisons).

Patched materials evaluate cosine-convolved SH irradiance at the shaded point (offset along the normal), trilinearly blending the eight surrounding probes with a wrap-shading weight toward each probe to reduce light leaking through the surface. The result replaces the sky-only diffuse image lighting (scaled by `envMapIntensity` and `strength`); specular image lighting is scaled by the probe/sky irradiance ratio so covered areas stop reflecting open sky. Uncaptured probes fall back to the sky light. Materials need `scene.environment` (the sky light) for the patch to engage.

`tag(root, {minRadius:.6, filter})` skips points, lines, translucent-layer meshes, objects marked `userData.keNoGI` (the sky discs are) and meshes smaller than `minRadius`. `bake(camera)` captures every probe synchronously; `progress` reports the captured fraction; `strength` scales the result; `dispose()` restores material hooks. The `gi` setting (`r.GI`) toggles the effect.

Cost per update: twelve small scene renders of the GI layer with visibility on, six without (draw calls equal to its mesh count each), one SH pass and one 64-texel moment pass; shading adds eight extra texture reads per pixel. A 12×3×12 volume refreshed one probe per frame takes about seven seconds at 60 FPS for a full sweep, so lighting changes (time of day, lights switching on) settle gradually. Limits: walls thinner than about one distance texel at `faceSize` can still leak, there is no probe relocation (a buried probe is only switched off), two-sided materials such as foliage cards count as back faces from one side, no specular GI beyond the sky light and SSR, dynamic objects are not captured unless tagged, and grid resolution bounds detail (use GTAO for contact-scale occlusion).

## 11. KE.SurfaceWeather (wet surfaces, puddles, snow)

```js
const weather = new KE.SurfaceWeather(THREE, { puddleScale: .16, puddleCoverage: .55 });
weather.setupScene(scene);                 // or weather.setupMaterial(material) per material
// per frame: ramps wetness/puddles/snow like a real surface
weather.update(dt, { raining, snowing: false, rain: 1 });
// or drive it directly (all 0..1)
weather.set({ wetness: 1, puddles: .6, snow: 0, rain: 1 });
```

Patches lit `MeshStandardMaterial`/`MeshPhysicalMaterial` with one block that runs after the material's albedo, roughness, metalness and normal are final (before emissive), so it composes with other `onBeforeCompile` hooks such as terrain splatting, `KE.ProbeVolume` and `KE.CascadedShadows`. Transparent materials and materials or objects with `userData.keNoWeather` are skipped.

| option | default | meaning |
|---|---|---|
| `wetness`, `puddles`, `snow`, `rain` | 0 | initial levels (0..1) |
| `puddleScale` | .18 | world frequency of the puddle noise (lower = larger puddles) |
| `puddleCoverage` | 1 | scales how much flat ground floods at `puddles = 1` (1 ≈ 40 % of perfectly flat ground) |
| `porosity` | .6 | global albedo darkening strength when wet |
| `snowColor` | `0xf2f5fa` | snow albedo (sRGB) |
| `wetRate`, `dryRate` | .08, .012 per s | wetness ramp in rain / drying |
| `puddleRate`, `drainRate` | .025, .008 per s | puddles fill once wetness > .6 / drain |
| `snowRate`, `meltRate` | .02, .01 per s | snow accumulation while snowing (not raining) / melt |
| `ripples` | from `KE.settings.vfx` (≥ .5 on) | force rain ripples on/off; `weather.ripples = null` returns to the setting |

Model: exposure to rain falls off on down-facing surfaces (`smoothstep(-.35,.45,N.y)` of the world vertex normal). Wet surfaces darken albedo by up to 58 % scaled by the per-material `userData.kePorosity` (0 sealed … 1 porous, default 1) and move roughness toward `max(.2, 0.5·roughness)`; metals keep their albedo. Puddles appear where the world normal is within about 15° of vertical and a two-octave value-noise mask exceeds a threshold that falls as `puddles` rises; inside them roughness goes to .03, the normal flattens to the surface normal and, when `rain > 0`, three offset grids of expanding rain-drop rings perturb it. Snow covers faces where `0.85·N.y + 0.3·noise` exceeds a threshold that falls with `snow` (vertical faces stay bare at `snow = 1`), whitens albedo, raises roughness to about .6 with sparse glints, and replaces normal detail with soft low-frequency drifts. Snow suppresses wetness and puddles underneath it.

Cost: one extra varying pair and about 30 ALU ops per pixel on patched materials, plus two noise evaluations when puddles are enabled and nine hash/noise evaluations inside puddles when ripples are on, three fBm evaluations inside snow. Limits: there is no sheltering (surfaces under a roof still get wet unless you set `userData.keNoWeather` or a low `kePorosity`), puddles follow noise rather than terrain concavity, puddles reflect only the environment map (SSR covers translucent-layer materials only), and snow is a material layer with no added geometry or deformation.

