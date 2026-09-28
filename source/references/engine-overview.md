# kitsune enginev3 (Tenko) · engine overview

Version 3.0.0 on the bundled Three.js r128 (WebGL2). One file, `assets/kitsune-engine.js`, holds the 2.1 runtime (`src/core.js`) plus twenty-one v3 modules from `src/modules/`. Every module registers itself in `KE.modules` and degrades or reports `available:false` when a browser feature is missing. Games stay single offline HTML files: `scripts/build.py` inlines Three.js, the add-ons, the libraries and the engine.

Read this page first, then the reference for the system you are touching.

## 1. Module map

| File | `KE.modules` name | Main entry points | Reference | Test |
|---|---|---|---|---|
| `core.js` | (2.1 runtime) | `KE.terrain`, `KE.Loop`, `KE.Physics` (upright actors), `KE.Input`, `KE.FollowCamera`, `KE.SaveStore`, `KE.Audio`, `KE.Particles`, `KE.findPath` | runtime-api.md, rendering.md | test_core.cjs |
| 00-core-v3 | `core-v3` | `KE.capabilities`, v3 settings and presets, `KE.cvars`, `KE.jobs`, `KE.profiler`, `KE.sceneUniforms`, `KE.FullScreenQuad`, `KE.GLSL` | rendering-v3.md §1, §7–8 | test_core.cjs |
| 10-pipeline | `pipeline` | `KE.Pipeline` | rendering-v3.md §2 | test_pipeline.cjs |
| 12-sky | `sky` | `KE.SkyAtmosphere` | rendering-v3.md §3 | test_sky.cjs |
| 14-shadows | `shadows` | `KE.CascadedShadows` | rendering-v3.md §4 | test_shadows.cjs |
| 16-lights | `lights` | `KE.LightPool` | rendering-v3.md §5 | (pipeline, game) |
| 18-gi | `gi` | `KE.ProbeVolume` | rendering-v3.md §10 | test_gi.cjs |
| 20-materials | `materials` | `KE.MaterialGraph`, `KE.shaderGraph`, `KE.materialLibrary` | materials.md | test_materials.cjs |
| 22-water | `water` | `KE.Water`, `KE.waterWaves` | rendering-v3.md §6 | test_water.cjs |
| 24-foliage | `foliage` | `KE.treeGeometry`, `KE.tree`, `KE.FoliageSpawner`, `KE.grassField`, `KE.fur`, `KE.foliage` | foliage.md | test_foliage.cjs |
| 26-weather | `weather` | `KE.SurfaceWeather` | rendering-v3.md §11 | test_weather.cjs |
| 30-geometry | `geometry` | `KE.simplify`, `KE.buildLODs`, `KE.LODMesh`, `KE.InstancedLOD`, `KE.Impostor`, `KE.VirtualGeometry` | geometry.md | test_geometry.cjs |
| 32-world | `world` | `KE.Heightfield`, `KE.GPUTerrain`, `KE.WorldPartition`, `KE.scatterCell` | world.md | test_world.cjs |
| 40-physics | `physics3d` | `KE.Physics3D` (Rapier) | physics.md | test_physics.cjs |
| 42-cloth | `cloth` | `KE.Cloth` | cloth.md | test_cloth.cjs |
| 50-vfx | `vfx` | `KE.VFX` | vfx.md | test_vfx.cjs |
| 62-characters | `characters` | `KE.foxModel` | engine-overview.md §1 | test_browser.cjs, test_open_world.cjs |
| 60-animation | `animation` | `KE.tween`, `KE.IK`, `KE.IKChain`, `KE.SpringChain`, `KE.ProceduralGait`, `KE.AnimStateMachine`, `KE.Sequencer`, `KE.CameraRail` | animation.md | test_animation.cjs |
| 70-ai | `ai` | `KE.NavMesh`, `KE.Crowd`, `KE.BT`, `KE.Blackboard`, `KE.Perception`, `KE.EQS`, `KE.FSM`, `KE.steering` | ai.md | test_ai.cjs |
| 80-audio | `audio` | `KE.AudioEngine`, `KE.Synth`, `KE.SoundCue` | audio.md | test_audio.cjs |
| 85-gameplay | `gameplay` | `KE.GameWorld`, `KE.Components`, `KE.Level`, `KE.Blueprint`, `KE.Prefabs` | gameplay.md | test_editor.cjs |
| 90-editor | `editor` | `KE.Editor` (F8), `KE.ConsoleUI` (backquote) | editor.md | test_editor.cjs |

The rows are in file order except `62-characters`, listed here for grouping; it loads between animation and AI. `KE.foxModel(THREE, {textureSize, coat, belly, castShadow})` returns `{group, legs, tail, tailTip, ears, materials, dispose()}`: the Spirit Isle fox built from scaled spheres, with knee-less leg groups (paw is each leg's third child, the layout `KE.ProceduralGait` expects) and the tail on a pivot for `KE.SpringChain`.

Modules load in file order. Optional integrations are checked at call time (`if (KE.VFX)`), so a bundle built with `build_engine.py --modules 00,10,12` still runs. Libraries: `assets/kitsune-libs.js` provides `RAPIER` (physics) and `MeshoptSimplifier`/`MeshoptClusterizer` (geometry); without it physics reports `available:false` and geometry falls back to its JavaScript simplifier.

## 2. How the systems relate to Unreal Engine 5 features

This table names the UE5 feature each system is modelled on so you can find the right tool. It is a map of intent, not a claim of equivalence: every row lists what is missing. No side-by-side comparison with UE5 has been made, and no frame-rate figures are claimed.

| UE5 feature | kitsune v3 system | What it does here | Main differences |
|---|---|---|---|
| Lumen (diffuse GI) | `KE.ProbeVolume` + pipeline SSGI | Probe grid with L1 SH irradiance refreshed a few probes per frame, multi-bounce by feedback, DDGI-style Chebyshev visibility and buried-probe rejection; SSGI adds screen-space bounce | No ray tracing, no surface cache, no specular GI beyond sky light and SSR; grid resolution bounds detail |
| Nanite | `KE.VirtualGeometry` (cluster DAG), `KE.InstancedLOD`, `KE.Impostor` | Meshlet groups simplified level by level with locked borders; crack-free runtime cut drawn in one call; instanced LOD with octahedral impostors | CPU-side cut, no GPU culling, no software rasterizer, no streaming |
| Virtual Shadow Maps | `KE.CascadedShadows` | Stable fitted cascades with texel snapping, blended cascade seams, PCSS contact hardening | Fixed cascade resolution, no per-page caching |
| TSR | pipeline TAA / temporal upscaling | Halton jitter, variance clipping, Catmull-Rom history, reconstruction from 50–100 % internal resolution | No learned or motion-vector-per-object reconstruction; camera-only velocity |
| Sky Atmosphere, Volumetric Clouds | `KE.SkyAtmosphere` | Rayleigh/Mie/ozone single scattering, ray-marched Perlin-Worley clouds, time-sliced sky capture as the sky light | Single scattering; clouds are a 2D-weather-driven layer |
| Exponential Height Fog, Volumetric Fog | pipeline composite + volumetric pass | Analytic height fog with sun inscatter; shadowed volumetric fog marched through cascade shadow maps; light shafts | Half resolution, sun only |
| Post process, Local Exposure | pipeline final pass | Eye adaptation, local exposure, bloom, lens flare, ACES, grading, DOF, motion blur, debug view modes | No bokeh shapes, camera-only motion blur |
| Material Editor | `KE.MaterialGraph`, `KE.shaderGraph` | JSON node graphs → GLSL on Standard/Physical materials, live parameters, instances sharing programs | No visual node canvas |
| Water plugin | `KE.Water` | Gerstner waves, SSR, refraction, depth absorption, caustics, foam, underwater | Single water body, no river splines |
| Weather (wetness, snow) | `KE.SurfaceWeather` | Wet darkening, puddles with rain ripples, snow cover with drifts | No sheltering, noise-driven puddles |
| Foliage, PCG, Groom | `KE.FoliageSpawner`, `KE.treeGeometry`, `KE.grassField`, `KE.fur` | Procedural trees (six species), Poisson placement, world-anchored grass with interactors, shell fur | Shell fur rather than strands; no billboard tree LOD in the spawner |
| World Partition, Landscape | `KE.WorldPartition`, `KE.GPUTerrain`, `KE.Heightfield` | Cell streaming with time budgets and HLOD proxies; CDLOD terrain in one draw with sculpting; hydraulic and thermal erosion | One heightfield per terrain, no holes or caves |
| Chaos Physics | `KE.Physics3D` (Rapier 0.19) | Rigid bodies, joints, character controller, vehicles, Voronoi fracture, buoyancy | Main-thread, no cross-platform determinism claim |
| Chaos Cloth | `KE.Cloth` | Position-based cloth with pins on moving anchors, aerodynamic wind with gusts, sphere/capsule/ground collision | CPU only, no self-collision or tearing, grid sheets only |
| Niagara | `KE.VFX` | GPU-simulated emitters with CPU fallback, forces, curl noise, collision, soft particles, ribbons, 14 presets | No per-particle lights or mesh collision |
| Control Rig, IK, Animation Blueprint, Sequencer | `KE.IK`, `KE.ProceduralGait`, `KE.SpringChain`, `KE.AnimStateMachine`, `KE.Sequencer` | Two-bone/FABRIK/CCD IK, foot-planting gait, spring chains, blend spaces, crossfading state machine, keyframe sequencer with camera cuts | Reactive gait (no motion matching), no retargeting |
| AI (NavMesh, Behavior Trees, EQS, Perception) | `KE.NavMesh`, `KE.Crowd`, `KE.BT`, `KE.EQS`, `KE.Perception` | Tiled navmesh with dynamic re-carving, ORCA crowd, BT with observer aborts, environment queries, sight/hearing | Single-layer navmesh, no off-mesh links |
| MetaSounds, audio mixing | `KE.AudioEngine`, `KE.Synth` | HRTF spatial voices, buses with ducking, convolution reverb zones, synthesized one-shots, ambience beds, generative music | Statistical reverb, no geometric propagation |
| Gameplay framework, Blueprints | `KE.GameWorld`, `KE.Components`, `KE.Blueprint` | Actors and components, validated JSON levels, prefabs, seeded event graphs | Structured action lists, not node wires |
| Unreal Editor, console | `KE.Editor`, `KE.ConsoleUI` | F8 editor with gizmos, outliner, details, undo/redo, Play In Editor, glTF import/export; cvar console with `stat` overlays | CPU picking, no content browser beyond the drawer |

## 3. Frame order for a full game

Spirit Isle (`assets/starter.html`) is the reference integration; each system is guarded with `has('module')`. The open-world showcase (`examples/src/open-world.html`, built to `../open-world.html`) is the reference for large worlds: a 2 km island generated and eroded while loading, `KE.GPUTerrain`, `KE.WorldPartition` cells filled by `KE.scatterCell` with octahedral impostor HLOD proxies (the same scatter with impostor geometry, so placements match), fly mode, weather and sound. At High it drew about 540 calls and 3.7 million triangles per frame in the test view (shadow passes included); the full-detail radius shrinks with the preset. Per rendered frame:

1. Move the player (`KE.Physics` legacy or `KE.Physics3D`), camera follow.
2. Character animation: `ProceduralGait.update`, `SpringChain.update`, `fur.update`.
3. AI: `BT` tick, `Crowd.update`.
4. `sky.update(dt, camera)` → sun/moon light, fog colour, sky light.
5. `csm.update(camera)`, `gi.update(camera)`, `lights.update(dt, camera)`.
6. `KE.foliage.update(dt, {wind, interactors})`, `forest.update(camera)`, `grass.update(x, z)`, `surfaceWeather.update(dt, {raining})`.
7. `water.update(dt, camera, {pipeline})`, `vfx.update(dt, camera)`, `physics.step(dt)`, `audio.update(dt, camera)`.
8. `pipeline.render(scene, camera, dt)`.

Spirit Isle also shows two presentation features built from engine parts: an intro flyover (a `KE.Sequencer` animates a `KE.CameraRail` parameter and a look target, then hands over to the follow camera; automated browsers skip it unless the URL has `?intro=1`) and a photo mode (hidden interface, the pipeline's depth of field focused on the fox each frame, exposure compensation, grading presets, vignette, time of day, and `canvas.toBlob` right after a rendered frame to save a PNG).

While the editor is open (F8) the game loop is paused and the editor runs its own frame with the same scene, camera and renderer.

## 4. Quality presets

`KE.applyPreset(name)` sets every key at once; `KE.detectPreset()` picks a starting preset from the device (headless and 4-thread machines get Low). Console variables (`r.*`, `fx.*`, `foliage.*`, `t.*`) change single keys; `list` in the console prints them.

| key | low | medium | high | ultra | cinematic |
|---|---|---|---|---|---|
| HDR pipeline | off | on | on | on | on |
| TAA / internal resolution | off | on / .67 | on / .8 | on / 1 | on / 1 |
| Dynamic resolution | off | on | on | off | off |
| GTAO / SSR / SSGI | off | off | on / on / off | on | on |
| Probe GI | off | off | on | on | on |
| Volumetrics, clouds | off, 0 | off, 1 | on, 1 | on, 2 | on, 2 |
| Shadow cascades | 1 | 2 | 3 | 4 | 4 |
| Fur, VFX budget, pool lights | off, .35, 2 | on, .6, 4 | on, 1, 6 | on, 1, 8 | on, 1, 12 |

## 5. Mobile budgets (from public WebGL2 survey data)

These numbers come from Web3D Survey reports (web3dsurvey.com, snapshot 27 Sep 2026) and vendor guides; they count reports, not users, and are not measurements of this engine.

- Float render targets are safe: `EXT_color_buffer_float` is reported by 99.94 % of Android and 100 % of iOS WebGL2 reports, so the HDR pipeline's half-float targets are available.
- Float32 blending and filtering are not: `EXT_float_blend` and `OES_texture_float_linear` are near 53 % on iOS (the latter 75.9 % on Android). The engine blends and filters only half-float targets unless `KE.capabilities(renderer).floatBlend`/`floatLinear` say otherwise (the GI atlas checks `floatBlend`).
- Texture size: every Android report allows 4096², only 76 % allow 8192², so keep atlases and render targets at or below 4096 (the surface atlas is 1254²).
- MSAA: Android reports top out at 4× (about 1 % reach 8×); the pipeline uses TAA instead of MSAA.
- GPU timer queries (`EXT_disjoint_timer_query_webgl2`) are reported by 0.26 % of Android and 0.13 % of iOS reports, so auto-quality (`KE.FPS`) uses CPU frame time. On desktops that expose them, `stat gpu` in the console (or `r.ProfileGPU 1` and `pipeline.gpu.timings`) shows per-stage GPU milliseconds for the pipeline; use it to find the expensive pass on a target machine.
- `KHR_parallel_shader_compile` is reported by 0.14 % of Android reports: compile programs during loading (`renderer.compile(scene, camera)`, as Spirit Isle does) to avoid mid-game stalls, and keep material variants few.
- Fill rate: rendering at full device pixel ratio multiplies pixel cost; use `KE.settings.scale` and the pipeline's internal resolution (`upscale`) on phones (PlayCanvas optimisation guidelines give the same advice).

Physical-device frame rates for Spirit Isle have not been measured; test on target hardware before promising a frame rate.

## 6. Upgrading a 2.x game

2.x games keep working: the 2.1 helpers (`KE.Post`, `KE.sky`, `KE.dayCycle`, `KE.water`, `KE.grass`) are still in core. To move to v3, replace them one at a time in this order: `KE.Pipeline` (post), `KE.SkyAtmosphere` (sky and sun), `KE.CascadedShadows`, `KE.Water`, `KE.grassField`, then add GI, weather, physics, VFX, audio and the editor. Spirit Isle's starter shows each replacement behind a `has('module')` guard. See integration.md for the 2.x build contract, which is unchanged.

## 7. Testing

`node scripts/test_all.cjs` runs every suite (Node suites, then headless Chromium with SwiftShader software WebGL2) and writes `../verification.json` with per-suite results and file hashes. Individual suites are listed in §1; most accept `--shots` or write screenshots to `.test-output/`. Software WebGL runs at about one frame per second at High, so browser suites take minutes. What these tests do not cover: frame rates on real GPUs or phones, touch input on devices, and audio on real speakers.
