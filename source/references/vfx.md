# VFX · KE.VFX (50-vfx.js)

GPU particle system with emitters, spawn shapes, force fields, height-field collision, curve-driven rendering and fourteen presets. On WebGL2 with renderable float textures, particle state lives in GPU textures and is advanced by full-screen shader passes, so there is no per-particle CPU work or upload. Otherwise the same configuration runs on the CPU with typed arrays. Registered as module `vfx` (`KE.modules.vfx.provides = ['VFX']`).

## Contents

1. Quick start
2. KE.VFX (the system)
3. Emitter configuration
4. Emitter API
5. Presets
6. Rendering, layers and the pipeline
7. Quality, budget and cost
8. Limits

## 1. Quick start

```js
const KE = window.KitsuneEngine;
const vfx = new KE.VFX(THREE, renderer, scene, {budget: KE.settings.vfx});

const fire = vfx.create('fire', {position: [10, 0, 4]});                 // preset → emitter
const sparks = vfx.emitter(vfx.presets.sparks({position: [12, 0, 4], ground: terrain.heightAt}));
const hit = vfx.emitter({
  capacity: 256, spawn: {rate: 0, shape: {type: 'sphere', radius: .2}},
  init: {life: [.4, .9], speed: [2, 5], size: [.04, .08], color: [0xfff0c0, 0xffa040]},
  forces: {gravity: [0, -9.8, 0], drag: .4},
  collision: {heightAt: terrain.heightAt, bounce: .3},
  render: {blending: 'additive', texture: 'spark', stretch: .05, emissive: 4}
});
hit.burst(60, enemy.position);                                          // world position

// every frame, before rendering (KE.Pipeline or renderer.render):
vfx.update(dt, camera);
pipeline.render(scene, camera, dt);
```

`vfx.update` must run before the frame is drawn: it runs the simulation passes, points each emitter's material at the new state and, for sorted emitters, sorts against `camera`.

## 2. KE.VFX

`new KE.VFX(THREE, renderer, scene, options)`

| Option | Default | Meaning |
|---|---|---|
| `budget` | `KE.settings.vfx` | 0..1 capacity multiplier. When omitted, the system follows later `settings` events (quality panel, `fx.Budget` cvar). |
| `cpuLimit` | 2048 | Capacity cap for CPU-simulated emitters. |
| `maxDt` | .1 | `update` clamps `dt` to this. |
| `prepareCamera` | true | `update` calls `KE.prepareCamera(camera)` so the translucent layer is visible in direct renders. |
| `linearColors` | auto | Convert config colours from sRGB to linear. Defaults to true when `renderer.outputEncoding` is sRGB. |

Methods and properties:

- `emitter(config)` creates an `Emitter` and adds its mesh to `scene`. An array of configs, or `{name, layers:[config,…]}`, returns an `EmitterGroup`. Invalid configs throw `RangeError`/`TypeError` with the reason.
- `create(name, presetOptions)` is shorthand for `emitter(presets[name](presetOptions))`. Unknown names throw.
- `presets.<name>(options)` returns a config object (or `{name, layers}`), not an emitter, so callers can edit it first. `KE.VFX.presets` is the same table.
- `update(dt, camera)` advances every emitter.
- `stats()` → `{emitters, capacity, alive, drawn, gpu, gpuEmitters, cpuEmitters, simPasses, budget, bytes}`. `simPasses` counts this frame's GPU passes, including sort passes. `bytes` is an estimate of GPU targets plus sprite and typed-array memory.
- `gpuSupported()` (and getter `gpu`) runs a one-time probe: WebGL2, `EXT_color_buffer_float`, at least 4 vertex texture units, and a 1×1 RGBA32F render-and-readback that must return exact values.
- `setBudget(b)` sets the budget for new emitters. Existing emitters keep their allocation but scale their spawn rates.
- `texture(name)` returns a shared procedural sprite (see section 6).
- `dispose()` disposes all emitters, sprite textures and the pass quad, and removes the settings listener. Afterwards `renderer.info.memory` is back to its baseline (tested).

Static: `KE.VFX.Emitter`, `KE.VFX.EmitterGroup`, `KE.VFX.internals` (`normalizeConfig`, `SpawnHistory`, `evalCurve`, `noise3`, `noised3`, `curlNoise`, `deepMerge`, `TEXTURE_PAINTERS`, `MAX_BATCHES`) for tests and tools.

## 3. Emitter configuration

Top level (defaults in parentheses): `name` ('emitter'), `capacity` (1024; 1..1048576 before budget), `gpu` (true, meaning GPU when supported), `space` ('world' or 'local'), `attachTo` (Object3D; `position` then becomes an offset in its frame), `attachRotation` (true; false follows the parent's position only, e.g. weather attached to the camera), `position` ([0,0,0]), `orientation` (Quaternion or Euler array; rotates shapes, directions and local forces), `autoplay` (true), `prewarm` (0 s; the looping presets set it), `teleportDistance` (20; a larger jump between frames does not smear spawns along the path or inherit velocity), `scaleWithBudget` (true), `seed` (random), `events` ({`onDeath(info)`}, which forces the CPU path).

In **world** space, particles stay where they were born when the emitter moves. In **local** space, positions are stored in the emitter frame and the whole system moves and rotates with it (portal preset). Vectors can be `Vector3`, `[x,y,z]` or a scalar.

**spawn**

| Key | Default | Meaning |
|---|---|---|
| `rate` | 50 (0 when bursts exist) | Particles per second, scaled by budget. |
| `bursts` | [] | `{time, count:n or [min,max], cycle, repeat, probability}`. `cycle` > 0 repeats every `cycle` s (`repeat` times, default ∞). |
| `duration` | ∞ | Emission cycle length in seconds. |
| `loop` | true | Restart the cycle (and bursts) after `duration`; if false, `playing` becomes false. |
| `rateOverDistance` | 0 | Extra particles per world unit the emitter moves (trails). |
| `shape` | point | See below. |

Rate spawns are spread over the frame. Each gets a sub-frame age and an origin interpolated from the previous to the current emitter position, so fast emitters leave continuous streams.

Shapes (`spawn.shape.type`), with the "shape" direction each produces:

| type | Keys | Emits | Shape direction |
|---|---|---|---|
| `point` | – | origin | random |
| `sphere`, `hemisphere` | `radius` (.5), `thickness` (1 = solid, 0 = shell), `surfaceOnly` | volume/shell (hemisphere: y ≥ 0) | radial |
| `box` | `size` ([1,1,1]), `surfaceOnly` | volume or faces (area-weighted) | from centre / face normal |
| `cone` | `radius` (.5), `angle` (.4 rad), `thickness`, `surfaceOnly` | base disc (y = 0) | up, tilted outward toward `angle` at the rim |
| `disc` | `radius` (.5), `thickness`, `surfaceOnly` (rim) | XZ disc | +Y |
| `ring` | `radius` (.5), `width` (0) | torus of tube radius `width` | radial |
| `line` | `from` ([0,0,0]), `to` ([0,1,0]), `radius` (0) | segment (cylinder with radius) | perpendicular to the line |
| `mesh` | `mesh` (THREE.Mesh), `samples` (2048) | mesh surface, area-weighted, sampled once at creation with `THREE.MeshSurfaceSampler`; follows the mesh's current world matrix | surface normal |

**init**

| Key | Default | Meaning |
|---|---|---|
| `life` | [1,2] | Seconds, uniform in range. |
| `speed` | [1,2] | Initial speed along `direction`. |
| `direction` | 'shape' | A vector (emitter frame), or `'shape'`, `'random'` or `'tangent'` (around the emitter's up axis: swirls and rings). |
| `spread` | 0 | Cone half-angle (rad) of random deviation around the direction. |
| `velocity` | [0,0,0] | Constant extra velocity (emitter frame). |
| `inheritVelocity` | 0 | Fraction of the emitter's velocity added at birth (world space only). |
| `size` | [.1,.2] | World-unit sprite width, per particle. |
| `color` | white | One colour or `[a,b]`; each particle picks a random mix. |
| `rotation`, `angularVelocity` | 0 | Sprite roll (rad) and roll speed (rad/s) ranges. |

Per-particle random values come from a hash of the slot and its randomised lifetime. Size, colour mix, rotation and flipbook frame therefore need no extra storage.

**forces.** Accelerations in m/s², applied in this order, then drag, max speed and collision:

- `gravity` [0,0,0]: constant acceleration (world axes; rotated into the frame for local emitters).
- `wind` [0,0,0] and `drag` (0, or .5 when wind is set): velocity relaxes exponentially toward `wind` at rate `drag` (exact per step, stable for any dt).
- `curl` (number = strength, or `{strength:1, scale:1, speed:.5, octaves:2}`): divergence-free curl noise. The curl of a vector potential made of three value-noise fields with analytic gradients, `octaves` 1–4, advected over time by `speed`. It swirls without making particles bunch up or thin out. The GPU shader and the CPU path use the same formula; the CPU reference is tested numerically (divergence below 1% of the field magnitude).
- `turbulence` (0): cheaper value-noise acceleration of that amplitude. It is not divergence-free.
- `vortex` {`axis` [0,1,0], `center` [0,0,0] (emitter frame), `strength` 1 = tangential acceleration, `pull` 0 = acceleration toward the axis}.
- `attractor` {`position` [0,0,0] (emitter frame, i.e. relative to the emitter), `strength` 1, `radius` 0 (0 = unlimited; otherwise linear falloff to 0 at `radius`)}. Pull fades out within .3 units of the centre to avoid singular jitter.
- `maxSpeed` (0 = off).

`emitter.forces` is the normalized, live object: `e.forces.gravity.set(…)`, `e.forces.attractor.position.copy(target)`, or `e.forces.drag = 2` take effect on the next update. Adding a force family that was absent at creation (for example curl) needs a new emitter, because each family is a shader define.

**collision.** Enabled when `plane` or `heightAt` is given:

| Key | Default | Meaning |
|---|---|---|
| `plane` | – | Ground height (world Y). |
| `heightAt` | – | `(x,z) => y`. On the GPU it is baked into a `resolution`² float height texture (bilinear) around the emitter, re-baked when the emitter moves a quarter of the region (at most every .25 s); the CPU path calls it directly. Both plane and height field can be combined (maximum). |
| `bounce` | .3 | Normal restitution. |
| `friction` | .2 | Tangential velocity removed per contact (0..1). |
| `die` | false | Kill particles on contact (rain, splashes). |
| `radius` | 0 | Particle radius added to the ground height. |
| `resolution` | 64 | Height texture size (4..512). |
| `region` | auto | `{center:[x,z], size}` for a fixed bake instead of the auto region (reach = shape extent + (max speed + wind) × max life, clamped to 8..256 units). |

The response uses the height-field normal (central differences), so particles slide and bounce off slopes. Particles are clamped above the surface after integration. Collision is against the plane/height field only, not scene meshes or the depth buffer.

**render**

| Key | Default | Meaning |
|---|---|---|
| `blending` | 'additive' | `'additive'`, `'alpha'` or `'premultiplied'`. All three use one premultiplied blend state; additive is alpha 0. With `premultiplied`, `blendOverLife` ([[t,v]…], 0 = alpha-over, 1 = additive) crossfades, e.g. from glowing flame to occluding smoke. |
| `texture` | 'soft' | Built-in `'soft'`, `'glow'`, `'spark'`, `'smoke'` (2×2 puff atlas), `'flare'`, `'ring'`, `'star'`, `'leaf'`, or a `THREE.Texture` (straight alpha unless `premultipliedTexture:true`). |
| `flipbook` | smoke: `{cols:2,rows:2,random:true}` | `{cols, rows, frames, fps, random, blend}`. `fps` > 0 plays at that rate (random start offset with `random`); `fps` 0 picks one random frame (`random`) or plays over the lifetime; `blend` crossfades frames. |
| `stretch` | 0 | Velocity stretch in seconds: the sprite extends backward by `stretch × speed` along its screen-space velocity (sparks, rain). |
| `sizeOverLife` | 1 | Scalar curve `[[t, v], …]` or a number. |
| `colorOverLife` | fade in/out | `[[t, color, alpha], …]`, multiplied with `init.color`. Stored in a 128-sample LUT (sqrt-encoded 8-bit colour). |
| `emissive` | 1 | Colour multiplier. Values above 1 give HDR output that the pipeline's bloom picks up. |
| `softness` | .5 | Soft-particle depth fade distance (world units); 0 disables it. |
| `cameraOffset` | 0 | Slides each sprite this far toward the camera and shrinks it by the same ratio. Screen footprint is unchanged, but less of it clips into the ground. Useful without the pipeline. |
| `cameraFade` | [.05,.4] | Near-camera fade start and length. |
| `lit` | false | Simple volumetric lighting from `KE.sceneUniforms` `keSunDirection`/`keSunColor`: a curved sprite normal (`curvature` .7), wrap diffuse (`wrap` .6), forward scatter toward the sun (`translucency` .4) and a constant `ambient` (0x5a6070). |
| `sortAlpha` | false | Back-to-front sort within the emitter every frame (GPU bitonic sort, CPU typed-array sort). Needs a camera in `update`. |
| `ribbons` | false | Connect consecutive particles into a camera-facing strip (trails). `ribbonMaxGap` (4 units) and `ribbonMaxAgeGap` (.5 s) break the strip; `ribbonUV` 'profile' or 'length'. |
| `order` | 0 | `mesh.renderOrder` (ordering between emitters at the same position). |
| `layer` | auto | Override the render layer. |

## 4. Emitter API

- `play()` starts emission; `playing` is true until `stop()` or a non-looping duration ends. `restart()` resets the cycle and bursts.
- `stop({clear})` stops emitting. Live particles finish their lives unless `clear:true` kills them immediately.
- `burst(count, position?)` spawns `count` (× budget scale) on the next update, at `position` (world) or at the emitter. Up to 8 spawn batches are handled per frame and further bursts queue.
- `setPosition(x, y, z)` or `setPosition(vec3 | [x,y,z])`: world position, or an offset when `attachTo` is set. `position`, `orientation` and `attachTo` are also live properties.
- `setRate(r)` sets particles per second.
- `prewarm(seconds)` simulates immediately in steps of at most 1/15 s (at most 240 steps).
- `alive`: on the CPU path, the exact count. On the GPU path, an estimate from the spawn history, which assumes uniform lifetimes; it is exact for bursts younger than the minimum life and overestimates when collision `die` kills early. `countAlive()` reads the state back (synchronous GPU stall; tests and tools).
- `drawn`: instances submitted this frame. `capacity`: allocated slots after budget. `spawnScale`: rate/burst multiplier from the budget. `gpu`, `fallbackReason`.
- `readState()` → `{position, velocity, width, height}`, RGBA float arrays (xyz + age, xyz + life) in simulation space (world, or the emitter frame for local). This is a GPU read-back.
- `memoryBytes()` returns an estimate. `gpuState` returns the current state render targets (GPU path), for custom shaders.
- `velocity` (world units/s, measured from the last update), `visible` (true), `mesh`, `material`, `geometry`, `forces`, `config`.
- `dispose()` removes the mesh and frees targets, geometry, material, LUT, height and mesh-sample textures.

`EmitterGroup` (layered presets) forwards `play`, `restart`, `stop`, `burst` (split in proportion to the members' burst sizes), `setPosition`, `setRate`, `visible` and `dispose`, and sums `alive`, `drawn`, `capacity` and `countAlive()`. `emitters` lists the members.

## 5. Presets

Each preset is `(options) => config`. Options: `position` (added to the preset's own offset), `attachTo`, `scale` (world-size multiplier for sizes, speeds, shapes and forces; default 1), `intensity` (rate and emissive multiplier), `color` (overrides the main colour), `ground` (collision plane height or a `heightAt` function), plus any config keys, which are deep-merged, e.g. `{render:{softness:0}}`.

| Preset | Capacity | Description |
|---|---|---|
| `fire` | 320 | Flipbook smoke puffs, additive→alpha blend over life, buoyancy, curl noise and an attractor above the base that converges the flame into a tip. |
| `smoke` | 160 | Lit, sorted alpha puffs rising with wind and slow curl. |
| `sparks` | 600 | Stretched additive sparks, bursts plus stream, gravity, optional ground bounce (`ground`). |
| `embers` | 160 | Slow rising glow motes with curl drift and flicker. |
| `fireflies` | 96 | Blinking glow points wandering in a 5 × 1.6 × 5 box. |
| `magic` | 512 | Wisps launched tangentially from a ring, held by a vortex, stretched into arcs, rising. |
| `rain` | 3000 | 30 × 30 area 14 units up, stretched streaks, die on the ground (plane 0 unless `ground`). To follow the player use `{attachTo: camera, attachRotation: false}`. |
| `snow` | 3000 | Drifting flakes with curl, settle on the ground. |
| `dust` | 96 | Large, faint, lit dust clouds in wind. |
| `leaves` | 128 | Tumbling lit leaf sprites in wind, settle on the ground. |
| `waterSplash` | 256 + 64 | Layered: droplet crown (dies on contact) plus mist puffs; one-shot. |
| `explosion` | 128 + 256 + 64 | Layered: fireball (additive→smoke), spark shower and a delayed smoke plume; one-shot. |
| `portal` | 600 | Local-space vertical ring with vortex and tangential swirl. |
| `trail` | 256 | Ribbon emitted by distance (`rateOverDistance`). Move it with `setPosition` or `attachTo`. |

Looping presets set `prewarm` so they start in steady state. One-shot presets (`waterSplash`, `explosion`) play once when created; call `restart()` or `burst()` to replay.

## 6. Rendering, layers and the pipeline

Each emitter is one instanced draw of camera-facing quads (or ribbon segments). The GPU path fetches particle state in the vertex shader (`texelFetch`), so only a static index attribute exists. Dead slots in the drawn window collapse to a degenerate vertex. The CPU path packs live particles into instance attributes each frame. Sprites use world-unit sizes, optional roll, velocity stretch, flipbooks and fog (`scene.fog`).

Layers: emitters with `softness > 0` or non-additive blending go on `KE.LAYERS.TRANSLUCENT`. With `KE.Pipeline` they render after the opaque scene has been copied, so the fragment shader fades them against `keSceneDepth` (linear view depth). The fade applies only when `keHasScene` is 1. Without the pipeline, sprites render normally (the translucent layer is enabled on the camera by `update`) and intersect geometry with a hard edge; use `cameraOffset` or keep sprites off the ground. Purely additive emitters with `softness: 0` stay on the default layer and draw in the opaque pass's transparent list.

Tone mapping and output encoding use Three's chunks, so direct rendering and the HDR pipeline both work. Ordering between emitters is Three's transparent sort by emitter position, then `render.order`. Particles of different emitters are not interleaved.

Procedural sprites (canvas, generated once per system and premultiplied): `soft` (Gaussian disc), `glow` (pinpoint core and halo), `spark` (elongated streak), `smoke` (2×2 fBm puff atlas with self-shading), `flare` (glow with rays), `ring`, `star` (4-point), `leaf`.

## 7. Quality, budget and cost

Capacity = `capacity × budget`, at least 64 and never above the request (`scaleWithBudget:false` disables this); CPU emitters are also capped at `cpuLimit`. Spawn rates and bursts scale by the same factor, so a lower budget thins effects instead of starving their tails. `KE.settings.vfx`: Low .35, Medium .6, High/Ultra/Cinematic 1 (console `fx.Budget`).

GPU cost per emitter per frame:

- Two full-screen passes over a W×H state texture (W = next power of two ≥ √capacity). Emitters that have nothing alive and nothing to spawn skip them.
- One instanced draw of the live window (the ring range that can hold live particles, tracked by a CPU spawn history).
- With `sortAlpha`: 1 + log₂n(log₂n+1)/2 extra passes (n = window rounded to a power of two; 78 passes for 4096).
- Shader cost grows with enabled force families (each is a compile-time define): curl costs 3 noise-gradient evaluations (24 hashes) per octave per particle.

Memory is 64 bytes per slot for the four RGBA32F state targets, plus 32 bytes per power-of-two slot when sorting, plus a height texture (`resolution`² × 16 bytes) with `heightAt`. `stats().bytes` sums these. The CPU path costs one JavaScript loop over the live window and a 36–72 bytes/particle attribute upload per frame. No frame-time figures are claimed; profile on the target device (`KE.GPUTimer`, `stats().simPasses`).

## 8. Limits

- The GPU `alive` count is an estimate (see section 4). `events.onDeath` needs the CPU path, which is capped at `cpuLimit` particles.
- Collision is against one plane and/or a baked height field. There is no collision with scene meshes, the depth buffer or other particles, and no particle–particle forces.
- `heightAt` baking calls `heightAt` resolution² times on the CPU per re-bake (4096 calls by default), which can hitch with an expensive function. Pass a fixed `region` for static areas.
- Lighting is one directional light plus constant ambient. Particles do not receive shadows, local lights or GI, and do not cast shadows or emit light (add a `KE.LightPool` light for fire).
- Sorting is per emitter. Overlapping alpha emitters sort as whole objects.
- `attachTo` follows position and rotation but ignores scale. Mesh shapes sample the geometry once (skinned/morphed deformation is not followed).
- Ribbons connect particles in spawn order, one strip per emitter.
- Soft particles require `KE.Pipeline` (depth copy). WebGL1 and devices without float render targets use the CPU path.
