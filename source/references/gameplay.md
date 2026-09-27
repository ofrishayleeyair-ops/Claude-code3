# Gameplay framework · 3.0.0 (`85-gameplay.js`)

Actors made of schema-described components, a world that ticks them with deterministic timers and tweens, strict JSON levels, prefabs, and data-driven Blueprint event graphs. Registers module `gameplay`. Optional systems (physics, VFX, audio, material graphs) are reached only through runtime guards, so the module works on its own and degrades with a logged warning when a system is missing.

## Contents

1. World and actors
2. Components
3. Built-in components, classes and prefabs
4. Levels
5. Blueprints
6. Integration with other systems
7. Limits and notes

## 1. World and actors

```js
const KE = window.KitsuneEngine;
const physics = KE.Physics3D ? await KE.Physics3D.create(THREE, {}) : null;   // optional
const world = new KE.GameWorld(THREE, scene, {physics, audio, vfx, camera, renderer});
const crate = world.spawn({prefab:'Crate', transform:{position:[0, 2, 0], rotation:[0, 45, 0]}});
const lamp  = world.spawn({name:'Lamp', class:'PointLight', transform:{position:[2, 3, 0]},
                           components:[{type:'PointLight', intensity:4, color:'#ffcf8a'}], tags:['light']});
world.expose('addScore', (n, ctx) => { score += n; return score; });   // callable from Blueprints
world.beginPlay();
// fixed update: world.tick(dt)   — or per frame: world.update(frameDt) (fixed-step accumulator)
world.endPlay();
```

`new KE.GameWorld(THREE, scene, options)` options (defaults): `physics` (null), `audio` (null), `vfx` (null), `camera`, `renderer`, `stepPhysics` (true: `tick` calls `physics.step(dt)`), `updateVFX` (true: `tick` calls `vfx.update(dt, camera)`), `fixedStep` (1/60) and `maxSteps` (5) for `update()`, `seed` (1, drives `world.random` and Blueprint `random()`), `logToConsole` (false), `consoleWarnings` (true; each distinct warning is printed once).

**Spawning.** `world.spawn(def | className)` returns an `Actor`. `def`: `name` (made unique: `Crate`, `Crate_1`, …), `class` (`'Empty'` default; see §3 or `KE.ActorClasses.register`), `prefab` (merged under `def`; component lists are merged by type), `transform` `{position, rotation (degrees, XYZ Euler), scale}` as arrays or `{x,y,z}`, `components` (`[{type, ...props}]`, unknown props warn and are dropped), `tags`, `visible`, `parent` (actor id or name). Spawning while playing runs the actor's `beginPlay` immediately. Unknown classes fall back to `Empty` with a warning.

**Lookup.** `find(name)`, `findById(id)`, `findByTag(tag)` (array), `findByClass(name)`, `findByComponent(type)`, `world.actors` (array in outliner order). `rename(actor, name)`, `uniqueName(base)`, `attach(actor, parent|null, {keepWorld=true})`, `reorder(actor, index)`, `clear()`, `destroy(actor)` (children are destroyed too; inside `tick`/`beginPlay` destruction is deferred to the end of that call and the actor is hidden immediately).

**Play.** `beginPlay()` resets `time`, `frame`, the seeded RNG position is not reset (create a new world for identical replays) and copies `globalDefaults` into `world.vars`; `tick(dt)` (clamped to 0.25 s) advances time, steps physics, polls trigger volumes, fires due timers in due-time order, advances tweens, ticks components in actor order and updates VFX; `update(frameDt)` runs `tick(fixedStep)` up to `maxSteps` times and returns the step count; `setPaused(bool)`; `endPlay()` ends components in reverse order, clears timers and tweens. Properties: `playing`, `paused`, `time`, `frame`, `vars` (Blueprint globals), `globalDefaults` (saved with the level), `logs` (last 500 `{text, level, time, actor, stamp}`), `name`.

**Timers and tweens.** `setTimer(fn, seconds, {loop=false, owner=null})` returns `{clear(), active, remaining, loop}`; timers run on world time (deterministic for a given `dt` sequence), are dropped when their `owner` actor dies and are cleared by `endPlay`. `tween(actor, 'position'|'rotation'|'scale', [x,y,z], {duration=1, ease='easeInOut', from, onComplete})` (rotation in radians; a new tween of the same channel replaces the old one). `KE.Ease` holds the easing functions (`linear`, `easeIn`, `easeOut`, `easeInOut`, `cubicIn/Out/InOut`, `sineInOut`, `backOut`, `elasticOut`, `bounceOut`).

**Events.** `world.events` (a `KE.Events`) emits `spawn`, `destroy`, `changed` (actor, what: `name`/`tags`/`parent`), `componentAdded`, `componentRemoved`, `componentChanged` (actor, component, key), `reorder`, `beginPlay`, `endPlay`, `overlap` (trigger, other, entered), `log`, `print`, `asset`, `levelLoaded`. `dispatch(actor, event, payload)` sends an event to the actor's event-handling components (Blueprints) and returns whether one handled it; `broadcast(event, payload)` sends to all.

**Game functions.** `expose(name, fn)` whitelists a function for the Blueprint `CallGame` node (returns an unexpose function); `fn(...args, {actor, world, other})`. `unexpose(name)`, `exposed()`.

**Assets.** `registerAsset(id, {object, animations?, buffer?})` makes a glTF scene available to `StaticMesh` (`primitive:'gltf'`, `asset:id`); actors already referencing the id are rebuilt. `getAsset(id)`, `assets()`, `removeAsset(id, {dispose=true})`. `KE.Level.decodeGLTF(world, id, arrayBuffer)` parses `.glb`/embedded `.gltf` offline and registers it (external URIs are refused, so it never touches the network).

`getPlayerStart()` returns `{actor, position, quaternion}` of the first `PlayerStart` or null. `dispose()` ends play, destroys all actors, releases shared geometry and assets.

**Actor** (`KE.GameWorld.Actor`): `id`, `name`, `className`, `object` (a `THREE.Group`; `object.userData.keActor` is a non-enumerable back reference, so `clone()` and `GLTFExporter` work), `components`, `tags` (a Set that keeps the world's tag index current), `parent`, `children`, `alive`, `pendingKill`, `prefab`, `position`/`rotation`/`quaternion`/`scale` (the object's), `visible`. Methods: `getComponent(type)`, `getComponents(type)`, `addComponent(def)`, `removeComponent(component)`, `destroy()`, `hasTag`, `addTag`, `removeTag`, `setName`, `emit(event, payload)`, `setTransform({position, rotation(deg), scale})` (throws on non-finite values), `getTransform()` (degrees, rounded to 1e-6), `getWorldPosition(out)`, `serialize()`, `boundsRadius()`.

## 2. Components

```js
KE.Components.register('Health', {
  label:'Health', category:'Gameplay', icon:'player',
  schema:{max:{type:'number', default:100, min:1, max:10000, integer:true},
          regen:{type:'number', default:0, min:0, max:100, step:.5, label:'Regen / s'}},
  create(actor, props, world, component){ return {hp:props.max}; },      // instance
  tick(inst, dt, component){ inst.hp = Math.min(component.props.max, inst.hp + component.props.regen*dt); },
  beginPlay(inst, component){}, endPlay(inst, component){}, dispose(inst, component){},
  update(inst, props, key, component){ return key === 'regen'; },         // true = applied in place, else rebuilt
});
world.spawn({name:'Hero', components:[{type:'Health', max:250}]}).getComponent('Health').set('regen', 2);
```

`KE.Components.register(type, def)`: `type` is an identifier. `def`: `schema` (fields below), `create(actor, props, world, component) → instance`, optional `tick`, `beginPlay`, `endPlay`, `dispose`, `serialize(inst, props, component) → props`, `update(inst, props, key, component) → true` (apply a single changed key in place; otherwise the instance is disposed and re-created), `normalize(props, warn) → props`, `onEvent(inst, name, payload, component) → handled`, `label`, `category`, `icon`, `help`, `unique` (default true: one per actor), `hidden`. Registering an existing type replaces it.

Schema field types: `number` (`min`, `max`, `step`, `integer`), `vec3` (array of 3), `color` (`'#rrggbb'`; `0xRRGGBB`, `#rgb`, `[r,g,b]` 0–1 and THREE.Color are accepted), `bool`, `string` (`maxLength`, optional `suggest()` for editor autocompletion), `text` (multi-line), `enum` (`options`), `asset` (world asset id), `json` (sanitized plain data). Keys may be dotted paths (`'mesh.material.color'`) into nested props. `when(props) → bool` hides a field that does not apply (hidden fields are not serialized). `label` and `help` feed the editor's details panel.

`KE.Components.defaults(type)`, `sanitize(type, props, warn)` (clamps, coerces, falls back to defaults with a warning, drops unknown keys), `fields(type, props)` (visible fields in declaration order), `get(type)`, `has(type)`, `list()`, `alias(name, type)` (`Bobbing` → `Oscillator`).

**Component** (`KE.GameWorld.Component`): `actor`, `type`, `def`, `props`, `instance`, `started`, `get(key)`, `set(key, value)` (validated; applied in place or rebuilt; returns the stored value), `setProps(partial)`, `serialize()`.

## 3. Built-in components, classes and prefabs

| Component | Key properties (defaults) | Notes |
|---|---|---|
| `StaticMesh` | `mesh.primitive` box/sphere/cylinder/cone/torus/plane/capsule/rock/gltf; `mesh.params.*` (width/height/depth 1, bevel 0, radius .5, radiusTop, tube .15, segments 24, detail 2, seed 1, roughness .35); `mesh.asset`; `mesh.material.type` standard/physical/basic/toon/graph/library; `color` `#a8adb5`, `roughness` .6, `metalness` 0, `emissive`, `emissiveIntensity` 1, `opacity` 1, `flatShading`, `wireframe`, `doubleSided`, `graph`, `library`; `castShadow`/`receiveShadow` true; `offset` | Primitive geometry is shared through a reference-counted cache. `rock` is a seeded value-noise displaced icosphere; `capsule` is a lathe profile (r128 has no CapsuleGeometry). `bevel` uses RoundedBoxGeometry. `graph` compiles with `KE.MaterialGraph.compile` and `library` looks up `KE.materialLibrary(THREE)` when present, else a standard material is used with a warning. Material parameter edits apply in place. |
| `PointLight` | `intensity` 1.5, `color` `#fff4e6`, `range` 10, `decay` 2, `castShadow` false, `offset` | Shadow map 512. |
| `SpotLight` | `intensity` 3, `range` 15, `angle` 35°, `penumbra` .35, `decay` 2, `castShadow` true, `offset` | Points along the actor's local −Y; shadow map 1024. |
| `DirectionalLight` | `intensity` 2.2, `castShadow` true, `shadowArea` 25, `shadowMapSize` 2048, `shadowBias` −.0005 | Direction is local −Y. |
| `SkyLight` | `intensity` .6, `skyColor`, `groundColor` | HemisphereLight. |
| `RigidBody` | `bodyType` dynamic/fixed/kinematic, `shape` auto/box/sphere/capsule/convex, `mass` 1, `friction` .6, `restitution` .1, `linearDamping` 0, `angularDamping` .05 | Physics adapter (§6); bodies exist only while playing. Kinematic bodies follow the actor. |
| `TriggerVolume` | `shape` box/sphere, `size` [2,2,2], `radius` 1, `filterTag` `'player'`, `once` false, `visibleInGame` false | Fires `Overlap` / `EndOverlap` on both actors (and the world `overlap` event). Uses a physics sensor when a physics world exists, plus a closest-point test against tagged actors without bodies (so game-moved characters trigger). |
| `ParticleEmitter` | `preset` `'fire'`, `autoPlay` true, `scale` 1, `overrides` {}, `offset` | `KE.VFX` preset + overrides; without VFX a small `KE.Particles` fallback. |
| `AudioSource` | `synth` `'chime'`, `params` {}, `autoPlay`, `loop`, `spatial` true, `volume` 1, `bus` `'sfx'` | `audio.play({synth, params}, {position, follow, loop, bus, volume})`. |
| `Rotator` | `speed` [0,90,0] deg/s, `space` local/world | |
| `Oscillator` (alias `Bobbing`) | `amplitude` [0,.25,0], `frequency` .5 Hz, `phase` | Around the position at beginPlay. |
| `Follow` | `target` (name or `tag:x`), `offset` [0,2,4], `relative`, `smoothing` 6, `lookAt` | Exponential smoothing. |
| `LookAt` | `target`, `yawOnly` true, `smoothing` 10 | |
| `PlayerStart` | `playerTag` `'player'` | Used by `getPlayerStart()`. |
| `TextLabel` | `text`, `color`, `background`, `backgroundOpacity` .55, `size` .5, `offset` [0,1,0], `depthTest` | Canvas-texture sprite. |
| `Blueprint` | `graph` `{events, variables}` | §5. |

Actor classes: `Empty`, `StaticMeshActor`, `PhysicsProp`, `PointLight`, `SpotLight`, `DirectionalLight`, `SkyLight`, `TriggerVolume`, `ParticleEmitter`, `AudioSource`, `PlayerStart`, `TextRender`, `BlueprintActor`. `KE.ActorClasses.register(name, {components, tags, label, category, icon, help})`, `get`, `list`.

Prefabs: shapes `Cube`, `Sphere`, `Cylinder`, `Cone`, `Torus`, `Plane`, `Capsule`, `Rock`; `Crate` (physics prop), `Coin` (rotating pickup with a sphere trigger and a Blueprint that increments `global.coins`, plays a chime, bursts sparks, prints and destroys itself), `Lamp` (pole + point light), `Boulder`. `KE.Prefabs.register(name, def, {category, icon, label})` stores sanitized data (returns `{name, warnings}`), `get(name)` (a copy), `info`, `list`, `unregister`. Spawning `{prefab}` records the prefab name on the actor; level files store the fully merged components, so later prefab edits do not change saved levels.

`KE.buildPrimitive(THREE, primitive, params)` returns a new BufferGeometry for the primitive shapes (caller owns it).

## 4. Levels

```js
const json = KE.Level.stringify(world, {pretty:true, embedAssets:true});
try { KE.Level.load(world, json); }                 // validates everything first
catch (e) { if (e instanceof KE.LevelError) console.warn(e.errors); }
await KE.Level.loadAsync(world, json);             // decodes embedded glTF before spawning
```

Format: `{format:'kitsune-level', version:1, engine, name, globals, actors:[{id, name, class, transform:{position, rotation(deg), scale}, tags, visible, components:[{type, ...props}], parent?, prefab?}], assets?:{id:{type:'gltf', data:base64}}}`. Transforms are local to the parent.

- `serialize(world, {name, embedAssets=false})` → object; `stringify(world, {pretty, ...})` → string. Serialize → load → serialize reproduces the same text (tested), including parents, hidden actors, prefabs, tags and Blueprint graphs.
- `validate(json)` → `{ok, errors, warnings, level}`; never throws. **Errors** (the level is rejected): invalid JSON, wrong `format`, missing/newer `version`, non-array `actors`, more than 20 000 actors, non-object entries, non-finite or out-of-range (±1e7) transforms, bad names/tags/ids, duplicate ids, parent cycles, malformed embedded assets, text over 96 MB. **Warnings** (the level loads): unknown classes (loaded as `Empty`), unknown components (skipped), invalid property values (defaults used), unknown properties, missing parents (attached to the scene).
- `load(world, json, {clear=true})` throws `KE.LevelError` (`.errors`) before touching the world, forwards warnings to `world.warn`, clears the world (optional), restores `globalDefaults` and `name`, spawns and re-parents actors (ids preserved) and emits `levelLoaded`. Loading during `world.tick` throws.
- `loadAsync` additionally awaits embedded glTF decoding. `decodeGLTF(world, id, buffer)` → Promise of the registered asset.

JSON input is sanitized: only plain objects/arrays/finite numbers/strings; `__proto__`, `constructor` and `prototype` keys are dropped; depth ≤ 16 and ≤ 20 000 nodes per value.

## 5. Blueprints

A `Blueprint` component holds `graph = {variables:{name:value}, events:{BeginPlay:[…], Tick:[…], Overlap:[…], EndOverlap:[…], EndPlay:[…], Custom:{Name:[…]}}}`. Each event is an ordered list of action nodes `{op, ...fields}`; flow nodes nest lists. Graphs are validated when set (unknown ops and events are dropped with warnings; string expressions are parsed into ASTs), so a stored graph only contains whitelisted nodes. There is no `eval`, no `new Function` and no property access outside the whitelist.

```js
world.spawn({name:'Door', prefab:'Cube', components:[{type:'Blueprint', graph:{
  variables:{open:false},
  events:{
    Overlap:[{op:'Branch', if:'!open && hasTag("player", "other")', then:[
      {op:'SetVar', name:'open', value:true},
      {op:'Move', by:[0, 2.5, 0], duration:.8, ease:'cubicOut', then:[{op:'Print', text:'Door open'}]},
      {op:'PlaySound', synth:'chime', params:{note:'G5'}},
      {op:'SetTimer', seconds:3, loop:false, event:'Close'}]}],
    Custom:{Close:[{op:'Move', by:[0, -2.5, 0], duration:.8}, {op:'SetVar', name:'open', value:false}]}}}}]});
```

Nodes (`KE.Blueprint.nodeTypes`; `target` is `self` | `other` | `all` | actor name | `tag:x`; `location` is a target or `[x,y,z]`; number fields accept an expression):

| Node | Fields |
|---|---|
| `Print` | `text` (`{var}` / `{global.var}` substituted), `value?` expr → output log and `print` event |
| `SetVisible` | `target`, `value` bool |
| `Move` | `target`, `to?` vec3 or `by?` vec3, `duration`, `ease`, `then?` actions (after the tween) |
| `Rotate` | `target`, `by` degrees, `duration`, `ease`, `then?` |
| `Scale` | `target`, `to`, `duration`, `ease` |
| `PlaySound` | `synth`, `params`, `at` location, `volume` |
| `SpawnEmitter` | `preset`, `at`, `duration`, `burst`, `overrides` |
| `ApplyImpulse` | `target`, `vector` (needs a RigidBody with an active body) |
| `Destroy` | `target` |
| `SetVar` | `name`, `value?` JSON literal or `expr?`, `scope` local/global |
| `Branch` | `if` expr, `then`, `else` |
| `Delay` | `seconds`, `then?` (without `then`, the rest of the current list resumes after the delay) |
| `ForLoop` | `count` (≤1000), `index` var, `do` |
| `Return` | stops the current event |
| `Emit` | `event`, `target` → custom event (`other`/`sender` = this actor) |
| `SetTimer` / `ClearTimer` | `seconds`, `loop`, `event`, `target` / `event` |
| `SpawnActor` | `prefab` (prefab or class), `at`, `offset`, `name?` |
| `SetLight` | `target`, `intensity?`, `color?` (every `*Light` component) |
| `SetText` | `target`, `text` (TextLabel) |
| `AddTag` / `RemoveTag` | `target`, `tag` |
| `CallGame` | `name` (must be `world.expose`d), `args` exprs, `store?` var (result is sanitized to plain data) |

`KE.Blueprint.registerNode(op, {category, help, fields, exec(ctx, node, list, index)})` adds a node type; `fields` use the types above, `ctx` has `world`, `actor`, `other`, `vars`, `event`, `dt`, and delayed work should go through `ctx.world.setTimer(fn, s, {owner:ctx.actor})`. Custom nodes appear in the editor's Blueprint panel automatically.

**Expressions** (text is parsed by a recursive-descent parser into a JSON AST; `KE.Blueprint.parseExpr`/`formatExpr` convert both ways): numbers, `"strings"`, `true/false/null`, `[a, b, c]`; variables `name`, `global.name`, `event.field`, `time`, `dt`; actor reads `self.position.x`, `other.rotation.y` (degrees), `actor("Door").scale.z`, `.visible`, `.name`, `.alive`, `.id`, `.var.name` (another Blueprint's variable), `distance("Player")`, `hasTag("tag", "other")`; operators `! - * / % + - < <= > >= == != && || ?:`; functions `min max pow atan2 random(lo,hi) abs floor ceil round sqrt sin cos sign str num len clamp lerp`. Division by zero yields 0, non-finite results become 0, `random` uses the world's seeded generator. `KE.Blueprint.evaluate(expr, {world, actor, vars, event, dt})` evaluates outside a graph.

Execution: events run synchronously; `Tick` gets `dt`; `Overlap`/`EndOverlap` set `other`. Each event run has a 20 000-step budget (an infinite `ForLoop`/`Emit` chain is aborted with a warning) and custom events nest at most 32 deep. Timers and delayed continuations are owned by the actor and are dropped when it is destroyed or play ends. With the same `dt` sequence and seed, runs are identical (tested).

`KE.Blueprint`: `nodeTypes`, `events`, `eases`, `registerNode`, `validate(graph) → {graph, warnings}`, `parseExpr`, `formatExpr`, `normalizeExpr`, `evaluate`, `run(actor, event, payload)`.

## 6. Integration with other systems

All integrations are checked when used, never at load:

- **Physics** (`options.physics`, e.g. `await KE.Physics3D.create(THREE, {})`): `RigidBody` calls `addFromObject`/`addBox`/`addSphere`/`addCapsule`/`addConvex(actor.object, {type, mass, friction, restitution, linearDamping, angularDamping})` at beginPlay and `physics.remove(body)` at endPlay; `TriggerVolume` creates a kinematic sensor (`sensor:true`, half extents/radius scaled by the actor's world scale) and subscribes to `physics.on('trigger', (sensor, other, entered))`; `ApplyImpulse` calls `body.applyImpulse`. `world.tick` calls `physics.step(dt)` unless `stepPhysics:false`. Without physics, rigid bodies are inert (one warning) and triggers use overlap tests.
- **VFX** (`options.vfx`, `new KE.VFX(THREE, renderer, scene)`): emitters come from `vfx.presets[preset](overrides)` → `vfx.emitter(cfg)`; `setPosition` follows the actor; `world.tick` calls `vfx.update(dt, camera)`.
- **Audio** (`options.audio`, `new KE.AudioEngine()`): `audio.play({synth, params}, {position, follow, loop, bus, volume})` for `KE.Synth` recipes, otherwise the raw source name; legacy `KE.Audio.tone` as a fallback.
- **Materials**: `KE.MaterialGraph.compile(THREE, graph, {model:'standard'})` and `KE.materialLibrary(THREE)` for `graph`/`library` material types.

## 7. Limits and notes

Names ≤ 128 chars, tags ≤ 64 chars and ≤ 32 per actor, ≤ 32 components per actor, strings ≤ 256 (text ≤ 2000), ≤ 4000 Blueprint actions per graph, nesting ≤ 16, expressions ≤ 1000 chars / depth 32, ≤ 256 variables.

Performance: component ticking iterates a cached list of tickable components (rebuilt only when components change); tag lookups are indexed; triggers without physics cost one closest-point test per tagged actor per tick. Hot paths reuse scratch vectors; Blueprint `Tick` reuses its context object. Primitive geometry is shared per parameter set. Quality: shadow casting of built-in components follows `KE.settings.shadows`.

Limitations: no networking/replication, no visual node-graph wiring (graphs are structured lists), no hierarchical prefab overrides (prefab data is merged at spawn), trigger overlap tests without physics treat the other actor as a sphere of half its bounds radius, `Move`/`Rotate` tweens are position/Euler interpolations (no physics sweep), and ids are unique per world, not globally.
