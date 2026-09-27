# Runtime API · 2.0.0

## Contents

1. Loop and events
2. Input and camera
3. Physics and spatial queries
4. Saves and navigation
5. Particles, audio, and resources
6. Settings

## 1. Loop and events

```js
const KE = window.KitsuneEngine;
const loop = new KE.Loop({
  step: 1 / 60, maxSteps: 6, maxDelta: 0.1,
  update(dt, time) { /* simulation */ },
  render(alpha, frameDt, time) { /* camera, effects, draw */ },
  onError(error) { showError(error.message); }
});
loop.start();
```

`start()` and `stop()` are idempotent. `pause(true/false)` retains the running loop but suspends advancement. `dispose()` removes the visibility listener and stops RAF; a disposed loop cannot restart. `advance(deltaSeconds)` is useful for deterministic tests; it does not check the paused flag. Hidden tabs discard elapsed time instead of performing a large catch-up step. `droppedTime` measures accumulated simulation time discarded when maxSteps is reached. Render interpolation is opt-in: store prior/current transforms yourself and use alpha to blend. The starter uses direct transforms.

`new KE.Events()` provides `on(name,fn)` returning an unsubscribe function, `once`, `off`, `emit`, and `clear`. Emission is synchronous; listener errors propagate. `KE.events` is the shared engine bus. Scope game-specific event buses to their scene if they should not outlive it.

`KE.damp(a,b,lambda,dt)` performs exponential smoothing; prefer it to an unscaled per-frame `.lerp(...,.1)`. `KE.clamp(v,min,max)` bounds numeric values. `KE.random(seed)` returns a seeded generator producing numbers in [0,1). This seeds explicit game choices; old procedural texture helpers still use Math.random, so their pixels need not repeat.

## 2. Input and camera

```js
const input = new KE.Input(renderer.domElement, {touch:true, parent:document.body});
const orbit = new KE.FollowCamera(THREE, camera, {
  distance:10, yaw:0, pitch:0.42, height:1.2,
  minDistance:3, maxDistance:22, smooth:9
});
// In fixed update:
const axes = input.movement();                 // {x,z}, length <= 1
const move = orbit.movement(axes.x, axes.z);   // rotate into camera-relative world XZ
if (input.consume('Space') && actor.grounded) actor.vy = 8;
// In render:
const look = input.consumeLook();             // {x,y,zoom}; resets its deltas
orbit.rotate(look.x, look.y);
orbit.zoom(look.zoom);
orbit.update(actor, dt, groundHeight, cameraObstacles);
```

Keyboard mapping: WASD and arrows. `input.keys` is a Set of physical KeyboardEvent codes, such as `KeyQ`. `consume(code)` removes an edge-triggered press; holding Space will not retrigger jumps. Combine it with a short buffer/coyote timer as the starter does.

The DOM joystick captures one pointer ID. Camera drag uses separate canvas pointer IDs. Two canvas touches pinch to zoom; the mouse wheel also zooms. `pointercancel`, lost capture, blur, and visibility changes clear held state. `setEnabled(false)` clears input and hides touch widgets; use it when opening a modal. `reset()` clears transient state. `dispose()` removes all registered listeners and its controls element. Style the `.ke-controls`, `.ke-stick`, and `.ke-jump` classes in the game.

FollowCamera assumes Y-up and an upright actor. Yaw zero views from +Z toward -Z. Pitch is clamped 0.12–1.3 radians. `KE.settings.cam === 'classic'` selects a steeper view. The camera avoids terrain and optionally shortens its desired arm when an obstacle ray hits. Pass world matrices that are current. This is a single target ray, not a camera capsule sweep; tight spaces may require a game-specific collision solution. Set `initialized=false` after teleporting to snap to the new position.

## 3. Physics and spatial queries

```js
const actor = KE.Physics.body({
  x:10, y:5, z:10, r:0.35, height:1.5,
  mass:1, friction:0.8, airDrag:0.3, bounce:0
});
KE.Physics.step([actor, enemy], dt, solid, groundAt);
// solid(x,z,body) -> boolean; groundAt(x,z) -> finite Y or -Infinity for no floor
```

`y` is a support-center coordinate: the feet rest at `y-r`; the actor's vertical interval is `[y-r, y-r+height]`. Height defaults to the diameter. Position a visual with feet at `body.y-body.r`. Body fields include `vx/vy/vz`, `ground` (last sampled height), `grounded`, `static`, `sensor`, `layer`, and `mask`. IDs are generated uniquely by `body()`; create each body separately rather than cloning its ID. Positive radius/mass and finite initial positions/velocities are required. Gravity defaults to -26.

A step clamps elapsed time to 0.1 seconds and subdivides at 120 Hz or by horizontal travel relative to the smallest radius, up to 64 substeps. Integrate from a fixed-step loop. Do not feed minutes of elapsed time after tab suspension. The solver samples center and four cardinal radius points against `solid`, resolves axes separately for wall sliding, updates floor height at the destination, and tracks grounding. Large instant height changes can lift the actor: use solid queries or game-specific slope limits where cliffs should block walking.

Body pairs use a spatial hash, vertical overlap, circular XZ separation, and inverse-mass impulse distribution. A static body stays fixed. Both `a.mask & b.layer` and `b.mask & a.layer` must pass. Sensors emit `KE.events` `overlap(a,b)` on detected overlap in the first substep of a call; they do not resolve that body pair. Sensor status does not disable ground or wall checks. Add separate trigger state if enter/exit events are needed.

This solver does not include angular momentum, stacking platforms, continuous swept collisions, arbitrary mesh contacts, articulated bodies, or network determinism. Thin walls and extreme velocities can still tunnel. Limit speeds and use a specialist solver when the game requires those features. Collision work scales with local density; dense coincident crowds can still approach quadratic cost.

`new KE.SpatialHash(cellSize)` supports `insert(item)`, `clear()`, and `query(x,z,r,out=[])`. Items need `x,z`. Query returns candidates from overlapping cells, not exact distance-filtered neighbors. It overwrites the supplied output array. Rebuild after moving items. Expand the radius for objects whose centers lie outside a query but whose bounds overlap it.

## 4. Saves and navigation

```js
const saves = new KE.SaveStore('my-game', 2);
const result = saves.save('slot-1', {level:3, coins:18});
if (!result.ok) showError(result.error);
const loaded = saves.load('slot-1', {
  fallback: {level:1,coins:0},
  validate: d => d && Number.isInteger(d.level) && Number.isFinite(d.coins),
  migrate: (data, oldVersion, newVersion) => migrateMySave(data, oldVersion, newVersion)
});
```

`save` returns `{ok:true}` or `{ok:false,error}`. `load` returns `{ok:true,found,data}` on success, including found:false for an absent slot, or `{ok:false,error,data:fallback}`. The JSON envelope has `version`, `savedAt`, and `data`. Migration runs only if the stored version differs; saving a migrated result is an explicit game choice. `remove(slot)` returns a status. Browser settings, private mode, quotas, and `file:` behavior can restrict localStorage. Validate restored values and use the game's own namespace. These saves are local, not cloud backups.

```js
const path = KE.findPath({
  width:40, height:40, start:[2,2], goal:[30,25],
  walkable:(x,z)=>grid[z*40+x]===0,
  diagonal:true, maxNodes:50000
});
```

Grid coordinates are integers `[x,z]`. Returned paths include start and goal. An empty array means invalid/blocked endpoints, no route, or the exploration budget was reached. Four-way movement costs 1; diagonals cost sqrt(2). Diagonals never cut blocked corners. A binary-heap open set and an admissible Manhattan/octile heuristic support shortest paths on this unweighted grid. Recompute when obstacles change; this is not a navmesh, moving-agent avoidance, or weighted terrain routing. The maximum grid allocation is four million cells, but use much smaller grids on phones. Convert cells to world coordinates explicitly.

## 5. Particles, audio, and resources

`new KE.Particles(THREE,scene,{capacity:256,size:.15,color:0xffd78a,gravity:-2,seed:1})` creates one Points draw call and preallocated arrays. Call `burst(x,y,z,count)` and `update(dt)`. Bursts overwrite oldest particles at capacity. Additive vertex colors fade as life ends. `dispose()` removes the object and GPU resources. The default square points are deliberately simple; replace the material if the game needs textured sprites.

`new KE.Audio()` provides `await unlock()` for a user gesture, `tone(frequency,duration,type)`, `volume`, `muted`, and `dispose()`. `unlock` returns false if unavailable. `tone` returns false while blocked/muted. Sound is procedural oscillator feedback, not streamed music or a sample asset loader. Keep volume modest. `dispose` closes only that instance's AudioContext.

`KE.disposeObject(root,{textures:false,remove:true})` traverses the object and deduplicates geometry/material disposal. It also includes custom shadow materials. Opt into texture disposal only when no remaining objects own them. Shader-only textures are recorded in `material.userData.keTextures`. Cached `KE._ramp`/`KE._objTex` are shared: clear and dispose them at application shutdown, not midway through a scene that still uses them.

`new KE.Resources()` tracks values with `.dispose()` or cleanup functions. `track(v)` returns v, `release(v)` relinquishes ownership, `dispose()` releases everything still tracked. `KE.rendererStats(renderer)` returns calls, triangles, geometries, textures, and program count. Those are renderer counters, not a complete memory profiler; with multipass post-processing the call count may reflect the last pass.

## 6. Settings

`KE.settings` is a stable mutable object. `KE.applyPreset('low'|'medium'|'high'|'ultra',{auto:false})` mutates it, persists it, emits `settings`, and rejects unknown names. It preserves camera choice and FPS visibility. `KE.setSettings(patch)` validates known values, persists, and emits `settings`. `KE.sanitizeSettings(raw)` returns normalized settings without saving. The inherited panel invokes its callback directly; use that callback as the central graphics update path rather than assuming every panel operation emits an event.

`KE.applyRendererSettings(THREE,renderer,camera,sun,scene)` applies pixel ratio, shadow enable/resolution, fog distance, and camera aspect. It does not size render targets or rebuild grass/terrain/textures. Follow it with renderer/post sizing and the rebuilds your game needs. `KE.FPS.tick(nowMilliseconds,onDowngrade)` samples frame rate and steps quality down after five low-FPS windows below 24 FPS if Auto is on. Pass the callback; otherwise settings change without rebuilding the renderer's dependent resources. This is one-way adaptive quality, not a guarantee of 60 FPS.
