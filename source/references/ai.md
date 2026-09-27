# AI · 3.0.0

`src/modules/70-ai.js` (module name `ai`) provides navigation meshes, crowd simulation, behavior trees, a blackboard, perception, environment queries, a finite state machine and steering behaviours. Everything is CPU-side JavaScript; the only GPU resources are the optional debug views, which have `dispose()`. Core's grid `KE.findPath` is unchanged and still suits small tile games.

## Contents

1. Quick start
2. KE.NavMesh: building
3. KE.NavMesh: queries and paths
4. Dynamic obstacles, serialization, debug views
5. KE.Crowd
6. KE.Blackboard and KE.BT
7. KE.Perception
8. KE.EQS
9. KE.FSM and KE.steering
10. Costs and limits

## 1. Quick start

```js
const nav = KE.NavMesh.build(THREE, {
  bounds:{minX:0, minZ:0, maxX:96, maxZ:96}, heightAt:land.heightAt,
  cellSize:.5, maxSlope:40, stepHeight:.4, agentRadius:.4, waterLevel:0,
  obstacles:[{x:30, z:40, r:2}, {minX:50, minZ:10, maxX:52, maxZ:30}],
  blocked:(x,z)=>isInsideHouse(x,z)
});
const path = nav.findPath(player.position, chest.position);   // Vector3[] (y from heightAt) or []

const crowd = new KE.Crowd(nav, {maxAgents:64});
const fox = crowd.addAgent({position:spawn, radius:.4, maxSpeed:3.5, userData:{mesh:foxMesh}});
fox.setTarget(chest.position);
// fixed update:
crowd.update(dt);
for (const a of crowd.agents) a.userData.mesh.position.copy(a.position);

const bb = new KE.Blackboard();
const {BT} = KE;
const guard = BT.tree(BT.selector([
  BT.blackboardCondition('target', 'set', chaseAction, {abort:'both'}),
  BT.blackboardCondition('lastKnown', 'set', searchAction, {abort:'lower'}),
  patrolAction
]), {blackboard:bb});
guard.tick(dt, guardContext);
```

## 2. KE.NavMesh: building

`KE.NavMesh.build(THREE, options)` returns a `NavMesh`. The build is Recast-inspired and works on a single-layer heightfield:

1. Rasterize: one cell per `cellSize`, sampled at the cell centre. A cell is open when `heightAt` is finite, above `waterLevel - maxWaterDepth`, the central-difference slope is at most `maxSlope`, no 4-neighbour differs in height by more than `max(stepHeight, cellSize*tan(maxSlope))` (ledges and walls), `blocked(x,z)` is false and no static obstacle contains the centre.
2. Erode: an exact Euclidean distance transform gives each cell its clearance (distance to the nearest blocked cell centre minus half a cell; the grid border counts as blocked). Cells with clearance below `agentRadius` are removed, so polygons describe where an agent's centre may stand. 4-connected regions smaller than `minRegionArea` are pruned.
3. Per tile (`tileSize` world units): 4-connected components are traced into boundary contours (outer loop plus holes; diagonal-only contacts stay separate), simplified with Douglas-Peucker to `maxError` cells while every simplified edge must stay inside the component's cells (so simplification only cuts inward), triangulated by ear clipping, improved by Lawson edge flips into a constrained Delaunay triangulation, then merged greedily (longest shared edge first) into convex polygons of at most `maxVertsPerPoly` vertices. Contour runs on tile borders are kept exact; if simplification ever produces crossing loops it retries with a smaller tolerance and finally falls back to merged cell quads.
4. Link: polygons in a tile connect through shared edges; neighbouring tiles connect through overlapping border edges (portal = overlap). Connected components are labelled as islands.

| Option | Default | Meaning |
|---|---|---|
| `bounds` | required | `{minX,minZ,maxX,maxZ}` world rectangle |
| `heightAt(x,z)` | `()=>0` | ground height; non-finite = unwalkable |
| `cellSize` | `.5` | rasterization cell (world units); grid limited to 4 million cells |
| `maxSlope` | `40` | degrees |
| `stepHeight` | `.4` | largest height step between neighbouring cells |
| `agentRadius` | `.4` | erosion radius |
| `agentHeight` | `1.8` | stored for reference only (no overhang test on a heightfield) |
| `waterLevel`, `maxWaterDepth` | `null`, `0` | cells lower than `waterLevel - maxWaterDepth` are unwalkable |
| `blocked(x,z)` | none | extra blocker, sampled at cell centres |
| `obstacles` | `[]` | static shapes: circle `{x,z,r}`, box `{minX,minZ,maxX,maxZ}`, rotated box `{x,z,hx,hz,rotation}` |
| `maxError` | `1.3` | contour simplification tolerance in cells (0 keeps every corner) |
| `maxVertsPerPoly` | `6` | 3–12 |
| `minRegionArea` | `2` | m²; smaller disconnected regions are removed at build time |
| `tileSize` | `16` | world units per tile (dynamic re-carving granularity) |
| `seed` | `1` | seed for the mesh's default `rng` |

`KE.NavMesh.buildAsync(THREE, options, {priority=0, jobs=KE.jobs})` performs the same build one tile per job step and returns the `KE.Jobs` promise (with `cancel()`); your loop must call `KE.jobs.run(ms)`.

Useful properties: `polys` (live polygon records `{ref, n, x, z, y, links, area, cx, cz, island, tile, dead}`), `revision` (increments on every rebuild), `islandCount`, `cellSize`, `agentRadius`, `params`, `bounds`, `W`, `H`, `rng`.

## 3. KE.NavMesh: queries and paths

`findPath(start, end, {maxNodes=16384, searchRadius=max(2, 4*agentRadius), partial=false, subdivide=0})` snaps both points to the nearest polygon within `searchRadius`, runs A*, and string-pulls the corridor with the funnel algorithm. It returns `Vector3` corners including the snapped start and end, with `y` from `heightAt`; `[]` means an endpoint is off the mesh, the points lie on different islands (checked first, no search), or the node budget ran out. `partial:true` instead walks to the reachable point closest to the goal and sets `nav.lastPathPartial`. `subdivide:d` inserts points every `d` units so the polyline drapes over terrain. `nav.lastCorridor` holds the polygon corridor of the last path. `KE.NavMesh.pathLength(path)` sums horizontal length.

The A* graph has one node per portal sample (both endpoints, interior points about every 2 m, and a goal-directed crossing point). Travel between two points on one convex polygon is a straight line inside it, so edge costs are exact and the heuristic is consistent; corridors are near-optimal rather than midpoint-biased. In the tests, every path over 150 random pairs was no longer than an 8-way grid A* on the same eroded grid (worst ratio 0.985, mean 0.92).

| Method | Returns |
|---|---|
| `nearestPoint(p, out?, {radius=4})` | `out` (Vector3, y from height) or `null` |
| `findNearest(x, z, radius=4)` | `{x, z, d2, poly}` or `null` |
| `findPoly(x, z, eps=1e-4)` | polygon record containing the point, or `null` |
| `isWalkable(x, z, eps=1e-3)` / `isWalkable(vec)` | boolean (point inside a polygon) |
| `heightAt(x, z)` | `heightAt` option, or barycentric height from polygon vertices when absent |
| `clearanceAt(x, z)` | distance to the nearest blocker from the erosion field (0 outside) |
| `randomPoint(rng=nav.rng, near=null, radius=Infinity, out?)` | area-uniform point; with `near`, restricted to that point's island and radius |
| `raycast(a, b, out?)` | `{hit, t, point, normal, poly}`: walks polygons along the 2D segment; `hit` means a mesh boundary was reached at fraction `t` (normal points out of the mesh). A start off the mesh returns `hit:true, t:0`. |

Pass `KE.random(seed)` generators to `randomPoint` for repeatable results.

## 4. Dynamic obstacles, serialization, debug views

`addObstacle(shape, {rebuild=true})` returns an id; `removeObstacle(id, {rebuild=true})` returns whether it existed; `rebuild()` applies deferred changes and returns `{tiles, ms}` (also in `nav.lastRebuild`). A rebuild recomputes erosion over the whole grid (linear time) and re-polygonizes only tiles whose walkable cells changed, then relinks their neighbours and islands. Removed polygons get `dead = true`; crowds replan agents whose corridor contains one. Obstacle shapes are the same as the static `obstacles` option.

`toJSON({grid=true})` returns a plain object: parameters, per-tile polygons (`[x,y,z,…]` rounded to 1e-4), static obstacles and, with `grid`, run-length-encoded open/pruned grids that enable dynamic obstacles after loading. `KE.NavMesh.fromJSON(THREE, json, {heightAt, blocked, seed})` validates the format and rebuilds links, buckets and islands. Without `heightAt`, heights come from the stored polygon vertices. Without the grid, `addObstacle` throws. A 60×60 m test world serializes to about 10 KB.

`debugMesh(THREE, {color=0x39b3ff, opacity=.42, edgeColor=0xe9fbff, borderColor=0x08314f, heightOffset=.06, colorize=true, resolution=2*cellSize})` returns a `Group` with a tinted polygon fill draped over `heightAt` (one colour per polygon) and edge lines (linked edges light, boundary edges dark). `debugPath(THREE, path, {color=0xffc21a, width=.2, heightOffset=.14})` returns a draped ribbon `Mesh`. Both have `dispose()`, which also removes them from their parent. Rebuild the overlay after dynamic changes. `nav.dispose()` drops all polygons and grids (no GPU state).

## 5. KE.Crowd

```js
const crowd = new KE.Crowd(nav, {maxAgents:128, separation:1.2, timeHorizon:1.5, maxNeighbors:10,
  collisionIterations:4, maxPathsPerUpdate:16, cornerCheckInterval:.25, stuckTime:2, laneBias:.35});
const agent = crowd.addAgent({position, radius:.4, height:1.8, maxSpeed:3.5, maxAccel:8, userData:{}});
agent.setTarget(point);           // or null to stop
crowd.events.on('arrive', a => …);   // also 'unreachable'; crowd.onArrive / agent.onArrive callbacks
crowd.update(dt);
```

Each `update(dt)` (dt clamped to 0.1 s):

1. Plans up to `maxPathsPerUpdate` queued paths (`findPath` with `partial:true`). Requests come from `setTarget`, a dead corridor after a navmesh rebuild, losing sight of the current corner, and being stuck for `stuckTime` seconds.
2. Buckets agents in a spatial hash and gathers up to `maxNeighbors` nearest neighbours within `maxSpeed*timeHorizon + radii` (or `neighborDist`).
3. Preferred velocity: towards the current path corner; every `cornerCheckInterval` seconds a navmesh raycast skips corners that are already visible. On the last corner the speed ramps down inside `slowDistance`. A soft separation term pushes apart agents closer than `separation*(ri+rj)` (per-agent `separationWeight`). `laneBias` makes agents sidestep oncoming neighbours to the same side, which forms lanes in counter-flow.
4. ORCA (optimal reciprocal collision avoidance, RVO2 linear programs) picks the velocity closest to the preferred one outside every neighbour's velocity obstacle over `timeHorizon`; agents with `avoidance:false` are treated as moving obstacles that others fully avoid.
5. Acceleration is limited by `maxAccel`; positions integrate; `collisionIterations` passes of Detour-style positional pushes resolve residual overlap.
6. Every agent is kept on the mesh: its polygon is tracked through links, otherwise it is clamped to the nearest mesh point and the velocity component into the wall is removed. `position.y` follows `nav.heightAt`.

Agent fields: `position`, `velocity`, `desiredVelocity` (Vector3), `radius`, `height`, `maxSpeed`, `maxAccel`, `arriveDistance` (default `max(.15, radius/2)`), `slowDistance` (default from speed and acceleration), `separationWeight`, `avoidance`, `userData`, `target`, `state` (`idle`, `waiting`, `moving`, `arrived`, `unreachable`, `removed`), `path`, `pathIndex`, `corridor`, `partial`, `poly`. Methods: `setTarget(v|null)`, `stop()`, `teleport(v)`, `speed`, `remainingDistance()`. `arrive` fires once per `setTarget`; arrived agents keep holding their target and walk back if pushed away. A target on another island yields a partial path that ends in state `unreachable`.

`crowd.removeAgent(agent)`, `crowd.query(x, z, radius, out=[])`, `crowd.dispose()`. `crowd.debugView(THREE, {colors})` returns `{object, update(), dispose()}`: one instanced cylinder per agent coloured by state plus a heading wedge (two draw calls).

## 6. KE.Blackboard and KE.BT

`new KE.Blackboard(initial={}, parent=null)`: `get(key, fallback)` (falls back to the parent), `set(key, value)` (emits only when the value changes, by `Object.is`), `has`, `delete`, `keys`, `clear`, `toJSON`, and `onChange(key, fn)` / `onChange(fn)` for every key; listeners receive `(value, old, key, blackboard)` and the call returns an unsubscribe function.

Node factories return immutable definitions that can be shared by many trees; `BT.tree(root, {blackboard, seed=1, name})` flattens them into per-instance memory. `tree.tick(dt, ctx)` returns `'success' | 'failure' | 'running'`.

| Node | Semantics |
|---|---|
| `sequence(children, {memory=true, name})` | runs children in order; fails on the first failure. With memory the running child resumes next tick; `memory:false` re-evaluates from the first child each tick and halts a previously running child it no longer reaches |
| `selector(children, {memory=true})` | first child that does not fail wins |
| `parallel(children, {success:'all'\|'one', failure})` | ticks unfinished children every tick; `failure` defaults to `'one'` when success is `'all'`, else `'all'`; remaining children are halted on completion |
| `inverter`, `succeeder`, `failer` | status mapping (running passes through) |
| `repeat(child, {count=Infinity, ignoreFailure=false})` | one completed iteration per tick; success after `count` |
| `retry(child, {count=3})` | retries a failing child on later ticks |
| `cooldown(child, seconds \| {duration})` | fails while cooling down; the timer starts when the child finishes or is aborted |
| `timeout(child, seconds \| {duration})` | halts the child and fails after the duration |
| `wait(seconds \| [min,max] \| {min,max})` | running until elapsed (random range from the tree's seeded rng) |
| `action(fn, {onEnter, onExit, name})` | `fn(ctx, bb, dt, memory, tree)` returns a status, `true`/`false`, or `undefined` (= success); any other value throws. `onEnter(ctx, bb, memory, tree)`; `onExit(ctx, status, bb, memory, tree)` with status `'aborted'` when halted. `memory` is a fresh object per activation |
| `condition(fn[, child][, {abort, name}])` | `fn(ctx, bb, tree)`; leaf without a child, decorator (guard) with one |
| `blackboardCondition(key, op[, value][, child][, {abort}])` | ops `== != < <= > >= set unset truthy falsy in` |
| `subtree(root, {name})` | embeds another definition |

Observer aborts on condition decorators, polled every tick (equivalent to event-driven aborts at tick granularity):
- `'self'`: while the guarded subtree runs, it is halted and the decorator fails as soon as the condition turns false (a selector falls through to the next child in the same tick).
- `'lower'`: while a later sibling of the parent composite runs, it is halted when this condition's result changes from the value it had when the composite passed it (selector: became true; sequence: became false), and evaluation restarts at this child.
- `'both'`: both. Aborts are found through chains of decorators directly under the composite.

`tree.halt()` aborts running nodes; `tree.reset()` also clears cooldowns and counters. `tree.debugState()` returns a nested `{type, name, status, running, lastTick, children, …}` snapshot (conditions add `abort`, `value`, `key/op/compare`; cooldowns `readyIn`; waits `remaining`); `tree.debugString()` renders it as indented text with `>` on the running path.

`KE.BT.fromJSON(json, registry)` builds definitions from data: `{type, name?, children | child, …}` using the factory names above plus `blackboardCondition {key, op, value}`, `action {action}`, `condition {condition}`, `subtree {ref}`, `wait {duration | min,max}`, `repeat/retry {count}`, `cooldown/timeout {duration}`, `parallel {success, failure}`, `selector/sequence {memory}`, and `abort` on conditions. `registry = {actions:{name: fn | {fn, onEnter, onExit}}, conditions:{name: fn}, subtrees:{name: json | node}}`. Only own registry properties resolve; unknown types or names, recursive subtrees, depth over 64 and more than 10000 nodes throw with a path such as `root.children[1].child`. No code is evaluated.

## 7. KE.Perception

```js
const eyes = new KE.Perception(THREE, {
  sight:{range:15, fov:110, height:1.6, targetHeight:1, lineOfSight:nav, detectTime:0, proximity:0},
  hearing:{range:12}, memory:5,
  onSee:(target, rec)=>…, onLose, onHear, onForget
});
eyes.listen();                                   // KE.events 'noise' → hear()
eyes.update(dt, guard, [player, ...npcs]);       // self: {position, forward|heading|quaternion|rotation|velocity}
KE.events.emit('noise', {position:p, loudness:1, source:player});
```

Sight tests 3D distance to the target point (`position` plus `height*0.75` when the candidate has `height`, else `targetHeight`), a horizontal field-of-view cone around the facing (`heading` 0 faces +Z; quaternions use the +Z forward), `proximity` for 360° awareness close by, then line of sight: a function `(eye, targetPoint, target) → clear`, a `NavMesh` (2D raycast), or an array of `Object3D` occluders when `THREE` was passed (Raycaster). With `detectTime > 0` awareness rises at `1/detectTime` per second (up to twice as fast when close) and the target counts as seen at 1; it decays at half that rate when unseen.

`known` is a `Map` from target (or sound source, or `'noise'` for anonymous sounds) to a record: `{target, visible, awareness, lastSeen, lastHeard, lastSensed, sense ('sight'|'hearing'), lastKnown, velocity (estimated from sightings), distance, loudness}`. Records are forgotten `memory` seconds after they were last sensed (`onForget`). Hearing registers when the distance from the listener's position at its last `update` is at most `hearing.range * loudness`. Events also go to `perception.events` (`see`, `lose`, `hear`, `forget`). Methods: `canSee(target)`, `get(target)`, `best()` (visible and nearest, else the most recent), `forget(target)`, `clear()`, `listen(bus=KE.events, event='noise')` (returns an unsubscribe), `dispose()`.

## 8. KE.EQS

```js
const r = KE.EQS.query({
  nav, generator:{type:'grid', center:guard.position, radius:10, spacing:1.5},
  tests:[
    KE.EQS.tests.visibility(player.position, nav, {want:false}),  // filter: hidden from the player
    KE.EQS.tests.distance(guard.position, {prefer:'near'}),
    KE.EQS.tests.clearance(nav, {min:.6, weight:.3})
  ]});
if (r.best) agent.setTarget(r.best);
```

Generators: `grid {center, radius | size, spacing=1, circle=true}`, `ring {center, radius=5, count=12, rings=1, innerRadius, angle}`, `points {points}`, `navRandom {center, radius, count=24}` (needs `nav`; seeded by `seed` or `rng`). With `nav`, generated points are projected to the mesh within `projectRadius` (default two cells), off-mesh points are dropped and duplicates merged. Tests run in order; `fn(position, item, context)` returns a number (booleans count 1/0; non-finite drops the item). `filter` may be `true` (keep values > 0), `{min, max}` or `fn(value, item)`. Scoring tests (non-zero `weight`, default 1 unless the test only filters) are min-max normalized across surviving items (`normalize:false` uses raw values); negative weights prefer low values. The result is `{best, bestScore, bestItem, items (sorted best first, invalid last), valid}`. Built-in tests: `distance(to, {prefer, weight, min, max})`, `pathLength(nav, from, {prefer, weight, max})`, `visibility(from, los | nav, {want=true, height=1.5})`, `clearance(nav, {min, weight})`. `KE.EQS.run` is an alias.

## 9. KE.FSM and KE.steering

`new KE.FSM({initial, states, context, any=[], onChange})`: states are `{enter(ctx, fsm, from, ...args), update(ctx, dt, fsm), exit(ctx, fsm, to), transitions:[{to, when(ctx, fsm)}]}`. `update(dt)` takes the first passing transition (the state's own, then `any`), otherwise runs `update`, which may return the next state name. `change(name, ...args)` runs exit → enter → `onChange` and the `events` `'change'` event; changes requested during enter/exit are queued (loops longer than 32 throw). Fields: `state`, `previous`, `time` (seconds in the state); `is(name)`.

`KE.steering` functions work in the XZ plane on `{position, velocity, maxSpeed}` and write a desired velocity into `out` (y = 0), returning it: `seek(agent, target, out)`, `flee(agent, threat, out, panicDistance=Infinity)`, `arrive(agent, target, out, slowRadius=2, stopRadius=.05)`, `pursue(agent, quarry, out, maxPrediction=1.5)`, `evade(agent, pursuer, out, maxPrediction=1.5, panicDistance)`, `wander(agent, out, {radius=1, distance=2, jitter=2, dt, rng})` (state in `agent.wanderAngle`), `separate(agent, neighbors, out, radius=1)`, and `force(desired, agent, maxForce, out)` (clamped `desired - velocity`). They are allocation free when `out` is reused.

## 10. Costs and limits

Measured by `scripts/test_ai.cjs` (Node 22 on the shared 4-CPU test machine; treat as orders of magnitude): a 60×60 m hilly world at 0.5 m cells (14 400 cells, 16 tiles) builds in roughly 80–200 ms into about 140 polygons; the 72×45 m browser scene builds in 30–70 ms; random paths average about 0.4 ms; a dynamic obstacle re-carves 1–4 tiles in 10–35 ms; a 40-agent crowd update takes about 0.6 ms and 128 agents about 2.3 ms. Build cost grows with cell count (rasterization, distance transform) and with contour complexity per tile; memory is a few bytes per cell plus the polygons. There are no `KE.settings` quality keys for AI: cost is controlled by `cellSize`, `tileSize`, `maxAgents`, `maxNeighbors`, `maxPathsPerUpdate` and how often you tick trees and perception.

Limits:
- Single-layer heightfield: no bridges, overhangs, multi-storey interiors or agent-height clearance tests. Off-mesh links (jumps, ladders, doors) and area costs are not implemented.
- Walkability is sampled at cell centres; features thinner than a cell can be missed, and passage widths are resolved to about half a cell (erosion is conservative). Polygons stay inside the eroded cells, so they can be up to about one cell smaller than the true walkable area.
- `blocked` and `heightAt` are sampled once per cell at build time; dynamic changes go through obstacles (circle and box shapes) only.
- Crowd walls are handled by clamping to the mesh, not by ORCA obstacle lines. Dense counter-flow through a doorway narrower than about four agent diameters can congest for a long time (a 128-agent two-way crossing of a 3 m door in the tests moved about 50 agents in 90 s); `laneBias` helps but does not remove it. Agents have no formations, priorities or local path smoothing beyond corner skipping.
- Perception line of sight uses one ray to one target point; sight cones are horizontal only.
- Behavior-tree observer aborts are polled on tick, so a condition that flips and flips back between ticks is not observed.
