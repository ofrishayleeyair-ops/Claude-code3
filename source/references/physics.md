# Rigid-body physics · KE.Physics3D · 3.0.0

`KE.Physics3D` (module `physics3d`, file `src/modules/40-physics.js`) is a Three.js-facing layer over the vendored Rapier 3D (`@dimforge/rapier3d-compat` 0.19.3 in `assets/kitsune-libs.js`). It fits colliders to meshes (world scale, parents and child meshes included), steps a fixed-timestep world with render interpolation, writes poses back to objects under any parent, and adds scene queries, a kinematic character controller, joints, Voronoi fracture with impact breaking, radial explosions, buoyancy, a raycast vehicle, contact/trigger events and a collider debug renderer.

The legacy `KE.Physics` upright-actor solver in `core.js` is unchanged; the two are independent.

## Contents

1. Setup and stepping
2. Bodies
3. Terrain and static geometry
4. Body handle
5. Scene queries
6. Events
7. Character controller
8. Joints
9. Destruction: fracture, breakable, explode
10. Buoyancy
11. Vehicle
12. Debug, stats, teardown
13. Quality settings and costs
14. Limits

## 1. Setup and stepping

```js
const KE = window.KitsuneEngine;
if (!KE.Physics3D.available) showMessage('Physics needs kitsune-libs.js');   // true when window.RAPIER exists
const physics = await KE.Physics3D.create(THREE, {gravity:[0,-9.81,0], fixedStep:1/60, maxSubSteps:4, scene});

const ground = physics.addBox(groundMesh, {type:'fixed'});
const crate  = physics.addBox(crateMesh, {density:0.6, friction:0.6});
const land   = physics.addTerrain(terrainMeshes);          // the array returned by KE.terrain()

// every rendered frame (variable dt is fine):
physics.step(dt);            // fixed substeps + interpolated object transforms
renderer.render(scene, camera);
```

`KE.Physics3D.create(THREE, options)` is async: it calls `RAPIER.init()` once per page and resolves to a world. Without `window.RAPIER` it rejects with `KE.Physics3D: window.RAPIER is missing. Load assets/kitsune-libs.js …`; `KE.Physics3D.available` lets a game check first. `KE.Physics3D.init()` returns the same init promise if you want to warm Rapier up early.

Options (defaults): `gravity [0,-9.81,0]` · `fixedStep 1/60` · `maxSubSteps 4` · `maxDelta .25` (seconds of frame time accepted per call) · `interpolate true` · `solverIterations` (Rapier default 4) · `autoUpdateQueries true` (section 5) · `scene null` (parent for fracture pieces of unparented meshes and the default debug scene) · `debug false` · `maxDebris` (see section 13) · `defaults {friction:.6, restitution:.1, density:1}`.

`step(dt)` multiplies `dt` by `physics.timeScale` (default 1), clamps it to `maxDelta`, adds it to an accumulator and runs whole `fixedStep` substeps, at most `maxSubSteps` per call. Time beyond that is discarded and summed in `physics.droppedTime` (bounded catch-up instead of a spiral of death). It returns the number of substeps run. Objects are then placed at `alpha = accumulator/fixedStep` between the previous and current simulated pose, so rendering is smooth at any frame rate and lags the simulation by up to one step. `interpolate:false` writes the latest pose. `pause(true)` stops simulation (transforms are still written); `timeScale = 0` does the same, `0.25` gives slow motion. `setFixedStep(h)`, `setGravity(v)`, `physics.time` (simulated seconds), `physics.alpha`, `physics.stepCount` are available.

With `KE.Loop`, call `physics.step(frameDt)` from `render`, or `physics.step(loop.step)` from `update` with `fixedStep` equal to the loop step.

Vectors are accepted as `THREE.Vector3`, `{x,y,z}` or `[x,y,z]`; rotations as `THREE.Quaternion`, `THREE.Euler`, `[x,y,z,w]` or Euler `[x,y,z]`.

## 2. Bodies

```js
physics.addBox(mesh, {type:'dynamic', density:1, friction:.6, restitution:.1});
physics.addSphere(ball, {radius:.3, ccd:true});
physics.addCapsule(null, {radius:.3, halfHeight:.6, position:[0,3,0], lockRotations:true});
physics.addCylinder(barrel); physics.addCone(spike);
physics.addConvex(rock);                              // hull of all vertices, world-scaled
physics.addConvex(statue, {compound:true});           // one hull per child mesh
physics.addFromObject(group, {shape:'auto'});         // compound of per-mesh boxes/spheres
physics.addTrimesh(levelGroup);                       // static triangle mesh of every child mesh
```

The body frame is the object's world position and rotation; its world scale (including parent scale) is baked into the collider. Primitive fitters use the bounding box of every mesh under the object expressed in that frame, so boxes follow scaled/rotated children and capsules/cylinders pick the axis with the most circular cross-section (`axis:'x'|'y'|'z'` overrides). Explicit sizes override fitting: `halfExtents` (box), `radius` (sphere/capsule/cylinder/cone), `halfHeight`, `offset` (collider center in the body frame), `roundRadius` (rounded box or convex). `object` may be `null` when sizes and `position` are given.

`addFromObject(object, {shape})`: `'auto'` fits a sphere to near-spherical meshes and a box otherwise; `'box' | 'sphere' | 'capsule' | 'cylinder' | 'cone'` force the primitive; `'convex'` builds hulls; `'trimesh'` delegates to `addTrimesh`. An object with several meshes becomes one body with a collider per mesh (oriented to each mesh) unless `compound:false`, which fits one primitive around everything. Meshes with `userData.physicsIgnore` are skipped by every fitter.

`addTrimesh(object, {type:'fixed'})` accepts `'fixed'` or `'kinematic'` only (triangle meshes have no volume); use `addConvex({compound:true})` for dynamic concave objects. Mirrored (negative-determinant) transforms have their winding fixed. `fixInternalEdges:true` sets Rapier's internal-edge flag.

Common options (defaults): `type 'dynamic'` (`'fixed'`, `'kinematic'` = position-based, `'kinematicVelocity'`) · `mass` (total kg, split over colliders by volume; otherwise `density 1`) · `friction .6` · `restitution .1` · `linearDamping 0` · `angularDamping 0` · `ccd false` · `sensor false` · `groups` · `userData {}` · `position`, `quaternion`/`rotation` (override the object pose) · `velocity`, `angularVelocity` · `gravityScale` · `canSleep true` · `sleeping` · `lockRotations` · `dominance` · `solverIterations` (extra, per body) · `events` (collision events; on by default for non-fixed bodies and sensors, `false` opts out) · `contactForceThreshold` (enables `contactForce` events) · `onContact(other, info)`, `onTrigger(other, entered)`, `onContactForce(other, info)` · `syncRotation true` (false leaves the object's rotation to the game) · `follow true` (kinematic bodies: the object drives the body, see below).

Collision groups: `groups:{membership:[0,2], filter:[0,1]}` (group indices 0–15) or bitmasks, or a raw 32-bit Rapier value; `KE.Physics3D.groups(membership, filter)` builds the value. Two colliders interact when each one's membership intersects the other's filter.

Transform sync: dynamic bodies write position and rotation to their object every `step`. The object may sit under any parent; the world pose is converted with the parent's current `matrixWorld` (update parents' matrices before stepping if the parents move). Fixed bodies never write. Kinematic bodies with an object follow it: each substep the object's world pose becomes the body's next kinematic target, so animated doors and platforms push dynamic bodies with correct velocities. Pass `follow:false` and use `body.moveKinematic(pos, quat)` to drive one from code.

## 3. Terrain and static geometry

```js
physics.addHeightfield({heightAt:(x,z)=>h(x,z), minX:-48, minZ:-48, sizeX:96, sizeZ:96, resolution:128, friction:.8});
physics.addTerrain(KE.terrain(THREE, {...}));                 // heightfield on the terrain's own grid
physics.addTerrain(terrainMeshes, {exact:true});              // trimesh of the rendered triangles
```

`addHeightfield` samples `heightAt` on a `(resolutionX+1) x (resolutionZ+1)` grid (`resolution 128` for both) over `[minX, minX+sizeX] x [minZ, minZ+sizeZ]` and creates a fixed Rapier heightfield (internal-edge fix on, `friction .8`, `restitution 0`). The grid is shifted by about 2e-4 of a cell because Rapier 0.19's heightfield ray test can miss rays running exactly along grid lines; heights are sampled at the shifted positions, so the surface differs from `heightAt` by at most slope × 2e-4 cells. `gridOffset:false` disables the shift. The body carries `heights` and `resolution`.

`addTerrain(meshes, options)` reads the mesh array from `KE.terrain`: grid point `(i, j)` renders at `(i+.5, h, j+.5)` in the terrain's local space with `meshes.sub` vertices per unit, and the heightfield vertices coincide with those rendered vertices exactly. The terrain meshes may be moved, rotated or scaled together (the first mesh's world transform is used). KE.terrain alternates cell diagonals while a heightfield uses one diagonal, so heights agree at vertices and differ inside a cell by the triangulation (a few centimetres on the demo island); `exact:true` builds a trimesh of the rendered triangles instead (identical surface, more memory).

## 4. Body handle

Fields: `rigidBody`, `collider` (first), `colliders`, `object`, `id` (Rapier handle), `type`, `shape`, `userData`, `mass`, `localBounds`, `radius`, `removed`.

| Method | Notes |
| --- | --- |
| `applyImpulse(v, point?)` | world-space impulse (N·s), optionally at a world point |
| `applyForce(v, point?)`, `applyTorque(v)` | applied during the next fixed step only, then cleared; call from a `beforeStep` listener for a continuous force |
| `applyTorqueImpulse(v)` | |
| `setVelocity(v)`, `getVelocity(out?)` | linear velocity |
| `setAngularVelocity(v)`, `getAngularVelocity(out?)` | |
| `getPosition(out?)`, `getQuaternion(out?)` | latest simulated pose (not interpolated) |
| `setPosition(v)`, `setRotation(q)` | instant, no interpolation smear, object updated at once |
| `teleport(pos, quat, {keepVelocity:false})` | set pose and clear velocities |
| `moveKinematic(pos, quat)` | kinematic target reached during the next step |
| `sleep()`, `wakeUp()`, `isSleeping()` | |
| `setEnabled(bool)`, `isEnabled()` | disabled bodies are removed from simulation but kept |
| `setGravityScale(s)`, `setCcd(bool)`, `setDamping(linear, angular)`, `setFriction(f)`, `setRestitution(r)`, `setGroups(g)`, `lockRotations(bool)` | |
| `dispose({object:false})` | same as `physics.remove(body)` |

`physics.remove(body, {object:false})` removes the rigid body, its colliders and joints, and returns `true`; `object:true` also detaches the object. Handles of removed bodies throw on use. `physics.bodyOf(object)` finds a body by object; `getBodies()` lists them.

## 5. Scene queries

```js
const hit = physics.raycast(camera.position, dir, 100, {exclude:playerBody});
if (hit) decal(hit.point, hit.normal, hit.body);
const all  = physics.raycastAll(origin, dir, 50);                  // sorted by distance
const cast = physics.sphereCast(origin, .3, dir, 20);              // {body, distance, position, point, normal}
const near = physics.overlapSphere(center, 4, {dynamicOnly:true});  // Body[]
```

`raycast(origin, direction, maxDistance=1000, options)` returns `{body, collider, point, normal, distance}` or `null`; `direction` need not be normalized. `raycastAll` returns every hit. `shapeCast(shape, origin, rotation, direction, maxDistance, options)` sweeps `{type:'ball'|'box'|'capsule'|'cylinder', radius, halfExtents, halfHeight}` (or a Rapier shape) and returns `{body, collider, distance, position (shape center at impact), point, normal}`; `sphereCast(origin, radius, direction, maxDistance, options)` is the ball case. `overlapShape(shape, center, rotation, options)`, `overlapSphere(center, radius, options)` and `overlapBox(center, halfExtents, rotation, options)` return the bodies touching the shape.

Query options: `exclude` (a body or an array), `solidOnly true` (skip sensors; `false` includes them), `solid true` (a ray starting inside a shape hits at distance 0), `groups`, `dynamicOnly`, `filter(body) -> bool`, and for shape casts `targetDistance 0`, `stopAtPenetration true`. Rapier refreshes its query structure only inside a step, so the world marks it stale when bodies are added, removed, enabled/disabled or teleported (`setPosition`, `setRotation`, `teleport`, character `teleport`) and the next query, character move or vehicle update refreshes it with a zero-length step (no integration; a pending `moveKinematic` target is applied at once, without velocity). Queries therefore see bodies created in the same frame, including fresh fracture pieces. With `autoUpdateQueries:false`, queries see the world as of the last step until you call `physics.updateQueries()`. Motion from ordinary simulation never marks the structure stale. Each call allocates its result objects.

## 6. Events

```js
const off = physics.on('contact', (a, b, {started, impulse, point, normal}) => { if (started && impulse > 5) thud(point); });
physics.on('trigger', (sensor, other, entered) => { if (other === hero.body) setZone(entered); });
off();   // every on() returns its unsubscribe function; once() and off() exist too
```

| Event | Arguments |
| --- | --- |
| `contact` | `(a, b, {started, impulse, point, normal, colliderA, colliderB})`: sent when two solid colliders start and stop touching. On start, `impulse` is the total normal impulse of that step, `point` the mean solver contact point, `normal` points from `a` to `b` (world space); on stop they are `0/null`. |
| `trigger` | `(sensor, other, entered)`: a sensor collider starts or stops overlapping another collider (including characters and fixed bodies). |
| `contactForce` | `(a, b, {magnitude, force, direction})`: each step a body with `contactForceThreshold` is pushed harder than that. |
| `beforeStep`, `afterStep` | `(fixedStep, time)` around every substep. |
| `fracture` | `(body, pieces)` |
| `break` | `(body, pieces, {point, direction, impulse})`: a `breakable` body broke. |
| `remove`, `dispose` | `(body)`, `(world)` |

Events are dispatched synchronously after every substep, so a frame may deliver several steps' worth. Handlers may remove or fracture bodies; later events for removed bodies are skipped. Collision events exist only for colliders that request them (non-fixed bodies and sensors by default), so fixed-vs-fixed pairs never report.

## 7. Character controller

```js
const hero = physics.character(heroObject, {radius:.35, height:1.5, maxSlope:45*Math.PI/180, stepHeight:.35, snapToGround:.3});
// fixed update or frame:
hero.move(desiredVelocity, dt);            // world XZ m/s; gravity and jumps are integrated
if (input.consume('Space')) hero.jump(6);   // true when grounded or within coyoteTime
physics.step(dt);
heroObject.rotation.y = facing;             // the controller never rotates the object
```

A capsule on a kinematic body moved by Rapier's `KinematicCharacterController`: it slides along walls, climbs slopes up to `maxSlope`, steps up ledges up to `stepHeight`, snaps down to ground within `snapToGround`, and pushes dynamic bodies while `pushDynamic` is true (settable). The object origin is the feet.

Options (defaults): `radius .35` · `height 1.5` (total) · `maxSlope 45°` (radians) · `stepHeight .35` (0 disables) · `stepMinWidth radius/2` · `snapToGround .3` (0 disables) · `slideOnSlopes true` (slide down slopes steeper than `maxSlope`) · `offset .02` (skin) · `coyoteTime .12` · `gravity` (world gravity Y) · `maxFallSpeed 55` · `fly false` (use the velocity's Y instead of gravity) · `mass 70` (for pushing) · `pushDynamic true` · `friction 0` · `groups` · `userData`.

State: `position` (feet), `velocity` (actual motion of the last move), `verticalVelocity`, `grounded`, `airTime`, `collisions` (`[{body, normal, point}]` of the last move), `body` (its kinematic body, usable in joints and `exclude`). Methods: `move(v, dt)` (dt clamped to 0.1 and scaled by `timeScale`, a no-op while paused), `jump(speed=5)`, `teleport(feetPosition)`, `dispose()`.

## 8. Joints

```js
const hinge = physics.joint(door, null, {type:'hinge', anchor:[0,1,0], worldAxis:[0,1,0], limits:[-1.6, 1.6]});
physics.joint(wheel, axle, {type:'hinge', axis:[1,0,0], motor:{targetVelocity:8, maxForce:40}});
physics.joint(lamp, null, {type:'rope', anchorA:[0,.2,0], anchor:[0,6,0]});
physics.joint(a, b, {type:'spring', length:1, stiffness:80, damping:4});
```

`joint(bodyA, bodyB, options)` returns a `Joint` with `setLimits(min, max)`, `setMotor(motor)`, `angle()` (hinge: rotation of B relative to A about the axis since creation), `dispose()`, `bodyA`, `bodyB`, `type`, `joint` (the Rapier joint). `bodyB = null` attaches A to the world through a private collider-less fixed body placed at A's pose (released with the joint).

Types: `'fixed'` (keeps the current relative pose), `'ball'`, `'hinge'`, `'prismatic'`, `'rope'` (maximum distance, default the current distance), `'spring'` (`length` default current distance, `stiffness 50`, `damping 2`). Anchors: `anchorA`/`anchorB` in body-local coordinates, or one world-space `anchor`; the missing side keeps the current relative placement (rope/spring between two bodies default to B's origin). Axis: `axis` in A's local frame (default +Y) or `worldAxis` in world space. `limits:[min, max]` (radians or metres) for hinge and prismatic. `motor:{targetVelocity, targetPosition, stiffness, damping, maxForce, model:'acceleration'|'force'}`: velocity motors use `maxForce` as Rapier's motor factor; position motors default to `stiffness = 10 × maxForce`, `damping = maxForce`. `collide:false` disables contacts between the two bodies.

## 9. Destruction: fracture, breakable, explode

```js
const pieces = physics.fracture(body, {pieces:12, point:hit.point, impulse:dir.multiplyScalar(20), interiorMaterial:stoneInside});
physics.breakable(vaseBody, {pieces:8, interiorMaterial:clay});           // shatters on a hard impact
physics.explode(center, 6, 40, {upward:.3});
```

`fracture(body, options)` splits a body whose object is a `Mesh` into convex Voronoi chunks and returns the new bodies (the original body is removed and its mesh detached unless `keepObject:true`; if fewer than two cells survive it returns `[body]` unchanged). Pieces are new meshes under the original's parent (or `physics.scene`) that share its material(s), inherit its collider friction, restitution, density, collision groups, `userData` (plus `fractureOf`), linear and angular velocity (`v + ω × r` per piece), and are convex-hull bodies owned by the world: removing them disposes their geometry.

Options (defaults): `pieces 8` (max 256) · `seed` (deterministic for a given seed) · `point` (impact point: a share `impactBias .6` of the seeds is Gaussian around it with `spread .22` × diagonal, and spacing shrinks there, giving finer chunks at the hit) · `impulse` (total impulse vector distributed by mass and proximity to `point`, plus `scatter .35` × its magnitude pushed outward) · `minSize .08` (minimum seed spacing) · `interiorMaterial` (applied to cut faces through a second geometry group) · `uvScale 1` (planar UVs on cut faces) · `friction`, `restitution`, `density`, `ccd`, `linearDamping`, `angularDamping` overrides · `inheritCallbacks false` · `forceHull false` · `quality false` (scale `pieces` by `KE.settings.vfx`).

Algorithm: seeds are placed by dart throwing inside the solid with a spacing that starts at 0.62 × cbrt(volume / pieces) and relaxes when darts fail. Each cell clips the source polygons by the bisector planes of its nearest seeds (Sutherland–Hodgman), closes every cut with a cap polygon, and triangulates; pieces are re-centred on their centroid. Normals and UVs of the original surface are interpolated across cuts. Cells partition the source exactly, so total piece volume equals the source volume for convex meshes. Non-convex meshes (volume more than 2% below their hull) are replaced by their convex hull first, so their pieces add up to the hull volume. `KE.Physics3D.fractureGeometry(THREE, geometry, {pieces, seed, point, scale, …})` exposes the geometry step alone and returns `{pieces:[{geometry, centroid, volume}], convex, sourceVolume, seeds}`.

`breakable(body, options)` fractures the body automatically when one of its contacts starts with a total impulse ≥ `threshold` (N·s, default 4 × mass, roughly a 4 m/s change of velocity). Other options go to `fracture`; by default the contact point is the impact point and `impulseScale .35` of the contact impulse is re-applied to the pieces along the contact normal. `onBreak(pieces, info)` and the `break` event report it. Returns `{dispose()}` to cancel. Breaking runs after the step's events are delivered.

`explode(center, radius, strength, options)` applies a radial impulse of `strength` (N·s at the centre) to every dynamic body whose centre of mass is within `radius`, with `falloff 'linear'` (`'quadratic'`, `'none'`) and `upward .3` added to the direction before normalizing. The impulse is applied slightly towards the centre from the centre of mass, so bodies also spin. `mode:'velocity'` treats `strength` as a velocity change (mass independent). Sleeping bodies are woken. Returns the number of bodies pushed.

## 10. Buoyancy

```js
physics.addBuoyancy(crate, {waterLevel:0, density:1, drag:1.5, angularDrag:1});
physics.addBuoyancy(boat, {waterLevel:(x, z) => water.heightAt(x, z)});      // KE.Water surface
```

Per sample point Archimedes force (`density × g × pointVolume × submergedFraction`) plus linear drag proportional to the displaced fluid (`drag × density × pointVolume × fraction × pointVelocity`) and exponential angular damping while submerged. The default samples are a 2×2×2 grid over the body's local bounds (`samplePoints:n` for n×n×n, or an array of local points with `pointHeight`); the submerged fraction of each point is linear over its cell height, which makes the equilibrium draft exact for axis-aligned boxes. `density` uses the same units as body density: with the default body density 1, a body of density 0.5 floats half submerged. `waterLevel` is a number or `(x, z, time) => y` with `time = physics.time`; a function is evaluated 8 times per body per step. Returns `{submerged (0..1), waterLevel (get/set), record, dispose()}`. With KE.Water, keep `water.time` in step with the simulation (for example `physics.on('beforeStep', (h, t) => water.time = t)`) or let `water.update` drive it.

## 11. Vehicle

```js
const chassis = physics.addBox(carMesh, {density:100});
const car = physics.vehicle(chassis, {wheels:[
  {position:[-.8,0,1.2], radius:.35, steering:true, object:wheelFL}, {position:[.8,0,1.2], radius:.35, steering:true, object:wheelFR},
  {position:[-.8,0,-1.2], radius:.35, object:wheelRL}, {position:[.8,0,-1.2], radius:.35, object:wheelRR}]});
car.setEngineForce(input.throttle * 600); car.setSteering(input.steer * .5); car.setBrake(input.brake * 20);
```

Rapier's `DynamicRayCastVehicleController` on a dynamic chassis; forward is chassis +Z (`forwardAxis`), up +Y. Wheel options (defaults): `position` (chassis-local connection point), `direction [0,-1,0]`, `axle [-1,0,0]`, `radius .35`, `suspensionRestLength .3`, `suspensionStiffness 30`, `suspensionCompression 4.4`, `suspensionRelaxation 2.3`, `maxSuspensionTravel .3`, `maxSuspensionForce 1e5`, `frictionSlip 2.5`, `sideFrictionStiffness 1`, `steering false`, `drive true`, `brake true`, `object` (placed each step with suspension, steering and spin; children of the chassis mesh get local transforms). `speed`, `wheelInContact(i)`, `dispose()`.

## 12. Debug, stats, teardown

`debug(scene, true, {fixed:true, sensors:true, filter:body=>bool, opacity:.9})` adds one `LineSegments` named `physics-debug` with Rapier's collider wireframes, joints and body axes, refreshed on frames that ran a step. It shows the latest simulated pose, up to one step ahead of the interpolated meshes. `debug(scene, false)` or `debug(false)` removes it and frees its GPU buffers.

`stats()` returns `{bodies, colliders, joints, dynamic, sleeping, awake, contacts, characters, vehicles, debris, stepMs, lastStepMs, substeps, time, droppedTime}`. `stepMs` is a smoothed wall time of `world.step`, which is also recorded as the `physics.step` scope in `KE.profiler`. `contacts` counts touching pairs that report collision events.

`dispose()` frees the Rapier world, event queue, character and vehicle controllers and debug lines, detaches and disposes the geometry of world-owned fracture pieces, and invalidates every handle. Game objects stay in the scene. A disposed world throws on use.

## 13. Quality settings and costs

`KE.settings.vfx` sets the default debris cap: `maxDebris = 64 + 192 × vfx` world-owned fracture pieces (131 at Low, 256 at High); the oldest pieces are removed first. `fracture({quality:true})` scales the piece count by `vfx` (at least 25%). Everything else is independent of quality presets; choose `fixedStep`, `maxSubSteps` and `solverIterations` per game.

Costs on the JavaScript side: one translation and rotation read per active body per substep (Rapier's JS API allocates a small object for each read), one transform write per moving body per frame, eight force applications per buoyant body per substep, and the drained collision events. Sleeping bodies cost nothing on the JS side. The step itself is Rapier's WebAssembly solver on the main thread. Fracture runs synchronously at call time and costs roughly O(pieces × (pieces + source triangles)) plus one Rapier convex hull per piece; keep sources low-poly and counts modest for mid-game breaks. The debug renderer copies the full line buffer on every stepped frame and is a development tool.

## 14. Limits

- One Rapier world on the main thread; no worker offloading, no networking or rollback. Results are repeatable for the same inputs in the same browser, but no cross-platform determinism is claimed.
- Rendering lags simulation by up to one fixed step (interpolation). `getPosition()` returns the simulated pose.
- Moving an object directly does not move its dynamic body; use `setPosition`/`teleport`. Parents must have current world matrices.
- Revolute and prismatic joints share one axis for both bodies in Rapier's JS API, so a body-to-body hinge requires the bodies' relative rotation at creation to be a rotation about that axis (for example equal orientations). World joints do not have this restriction.
- Heightfields use one diagonal per cell; see section 3 for the difference from KE.terrain and the grid offset.
- Fracture pieces are convex; concave meshes are fractured as their hull. Only `Mesh` objects fracture (not groups); every piece is its own mesh and draw call. There is no progressive damage, and pieces are not breakable again unless you call `breakable` on them.
- The character controller is an upright capsule. It does not ride moving platforms by itself (add the platform's velocity to `move`), and very thin walls at high speed can be missed by its shape casts.
- Contact event impulses are reported only when contact starts; use `contactForceThreshold` for sustained forces.
