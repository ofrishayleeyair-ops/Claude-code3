# Foliage, grass and fur · 3.0.0

Module `src/modules/24-foliage.js` (registered as `foliage`). It adds procedural trees with hierarchical wind and leaf translucency, shadow materials that deform exactly like the visible ones, world-anchored interactive grass, shell-texture fur and a deterministic instanced foliage spawner. Wind, grass bending and fur motion all run in vertex shaders; the CPU only works when grass or spawner cells change.

## Contents

1. Frame setup and shared wind
2. Foliage materials and shadow materials
3. Procedural trees and textures
4. Interactive grass
5. Shell fur
6. Foliage spawner
7. Integration with shadows, GI and core helpers
8. Quality settings and cost
9. Limits

## 1. Frame setup and shared wind

```js
const KE = window.KitsuneEngine;
const tex  = KE.leafTexture(THREE, {species:'broadleaf', size:512});
const tree = KE.treeGeometry(THREE, {species:'broadleaf', seed:4, height:6, leafCards:{texture:tex}});
const leaves = KE.foliageMaterial(THREE, {map:tex, vertexColors:true});
const bark   = KE.barkMaterial(THREE, {species:'broadleaf', vertexColors:true});
const forest = new KE.FoliageSpawner(THREE, scene, {bounds:{minX:-60,minZ:-60,maxX:60,maxZ:60}, heightAt, seed:1,
  types:[{name:'oak', geometry:tree, material:{trunk:bark, leaves}, spacing:7, scale:[.8,1.2], maxSlope:30}]});
const grass = KE.grassField(THREE, scene, {heightAt, density:(x,z)=>1});
const fur = KE.fur(THREE, foxGroup, {shells:16, length:.06});
const csm = new KE.CascadedShadows(THREE, scene, {sun}); csm.setupScene();
KE.foliage.setShadowSource(csm);                 // grass and fur receive every cascade
// every frame:
KE.foliage.update(dt, {wind:1, windDir:[.8,.6], interactors:[player.position]});
grass.update(camera.position.x, camera.position.z);
forest.update(camera);
fur.update(dt, playerVelocity);
```

`KE.foliageUniforms` is one set of uniform objects shared by reference by every foliage, bark, grass and fur material: `keTime`, `keWindDir` (Vector2, XZ), `keWindStrength`, `keGustScale`, `keInteractors` (8 × Vector4: xyz position, w radius), `keInteractorCount`.

`KE.foliage.update(dt, {wind, windDir, gustScale, interactors})` advances `keTime` by `dt` (clamped to 0..0.25 s) and also advances core's `KE.windUniforms.uTime` (and copies `wind` into `KE.windUniforms.uWind`), so materials using the 2.x `KE.wind` helper stay in step. `windDir` accepts an angle in radians, `[x,z]`, `[x,y,z]`, or `{x,z}`/`{x,y}`. `interactors` takes up to 8 entries, each a `Vector3` (radius .5) or `{position, radius}`; entries with non-finite coordinates are skipped. It allocates nothing.

Gusts are two octaves of value noise scrolled along the wind direction, so brighter, stronger bands visibly travel across grass and forests; `keGustScale` changes their spatial frequency.

## 2. Foliage materials and shadow materials

`KE.foliageMaterial(THREE, options)` returns a `MeshStandardMaterial` with hierarchical wind and thin-leaf lighting. Options (defaults): `map` (null), `color` (0xffffff, sRGB), `alphaTest` (.4 with a map, else 0), `translucency` (.6), `translucencyColor` (0xd2e67a), `wind` ({trunk:.02, branch:.06, leaf:.12}), `roughness` (.78), `doubleSided` (true), `normalsUp` (.5 when double-sided: blends vertex normals toward +Y), `vertexColors` (false; tree geometry stores AO and tint there), `bumpMap`/`bumpScale`, `normalMap`, `windAttribute` (true: read the `windWeight` attribute; false: derive weights from object-space height over `height`), `height` (1), `keepNormals` (true: back faces keep the outward-bent normal instead of flipping it), `alphaMip` (.25), `edgeFade` (1).

Wind, after the GPU Gems 3 ch. 16 / CryEngine scheme, per vertex using `windWeight` = (normalised height, branch weight, flutter weight, branch phase):

1. main bend — the whole plant leans along the wind and slightly across it, quadratic in height, length-preserving about the object/instance origin;
2. branch bend — vertical and along-wind oscillation scaled by the branch weight; a branch and everything attached to it share one phase, so joints never separate;
3. leaf flutter — fast motion along the vertex normal scaled by the flutter weight with a per-vertex phase.

The phase of each plant is hashed from its world root, so instanced copies never move in lockstep. Works for `Mesh` and `InstancedMesh`.

Lighting additions: every direct light also adds a back-lit transmission lobe (`pow(dot(view,-light),4)`), a wrap term for light passing through thin leaves, both tinted by `translucencyColor`; this is injected by redefining the `RE_Direct` macro, so any light loop — including `KE.CascadedShadows`' patched loop — calls it after its own shadowing. Alpha coverage is preserved in small mips by scaling alpha with the mip level, and cards seen edge-on fade out (by the derivative face normal) so they do not smear into streaks.

`KE.foliageDepthMaterial(material, {distance:false})` returns (and caches on the material) a `MeshDepthMaterial` (RGBA packing) or, with `distance:true`, a `MeshDistanceMaterial` that compiles the identical wind function against the same uniform objects and the same alpha cutout. Assign it to `mesh.customDepthMaterial` / `customDistanceMaterial`; `KE.foliage.attach(mesh)` does both. The browser test renders colour and depth coverage masks of wind-deformed leaves, instanced leaves and a trunk and requires them to match pixel for pixel (they do: 0 differing pixels).

`KE.foliage.applyWind(THREE, material, {wind, windAttribute, height, translucency, translucencyColor})` adds the same wind to an existing lit material, chaining its current `onBeforeCompile` and `customProgramCacheKey` (e.g. a `KE.surface` material). `KE.foliage.addWindWeights(THREE, geometry, {height, flutter, phase})` writes a height-based `windWeight` attribute for arbitrary geometry (for example `KE.fernGeometry`).

Composition rules: every foliage hook chains a previous own `onBeforeCompile`, appends `ke-foliage-2-<kind>:<flags>` to any previous cache key (stable, no function text), and patches only `#include` lines, throwing a clear error if a target chunk is missing. Materials may be passed to `KE.CascadedShadows.setupMaterial` and `KE.ProbeVolume.setupMaterial` before or after creation; the resulting programs contain all three patches (verified in the test).

## 3. Procedural trees and textures

`KE.treeGeometry(THREE, options)` → `{trunk, leaves, bounds, stats, species, layout}`. It is deterministic for a given seed and options.

| Option | Default | Meaning |
|---|---|---|
| `species` | `'broadleaf'` | `broadleaf`, `conifer`, `sakura`, `birch`, `palm`, `bush` (`KE.TREE_SPECIES`) |
| `seed` | 1 | random seed |
| `height` | species (5, 7.5, 4.3, 6.5, 6, 1.4) | final height; the finished tree including leaves is fitted to it |
| `trunkRadius` | species (.25 broadleaf) | base radius |
| `levels` | species (3; conifer 2; palm 0) | branching recursion depth (0–4) |
| `branches` | species ([6,4,3] broadleaf) | children per level (palm: frond count) |
| `lengthFalloff`, `gravity`, `phototropism`, `start` | species | child length ratio, droop, upward growth, first child position per level |
| `detail` | `KE.settings.lod` clamped .5–1.25 | scales segments, radial sides and leaf-card count |
| `leafCards` | – | `{texture, size, count}`: atlas (for its cell layout), card size and count overrides |

Growth: each branch is a polyline bent by gravity, phototropism and seeded wobble; children attach along it on a golden-angle spiral with angles and lengths from the species' crown profile (round, cone, umbrella, oval). Bark is built as tapered tubes with parallel-transport frames (no twisting), root flare lobes on the trunk, tip caps, and UVs with u around the circumference and v along arc length at matching texel density (RepeatWrapping). Vertex colours carry AO (darker at the root and inside the crown). Leaf cards are 2×3-vertex quads (they droop) attached near branch tips, oriented to face outward from the crown ellipsoid with a random roll, with a crossed second card on a species-dependent fraction of clusters; vertex normals are bent toward the crown ellipsoid normal (`normalBend`) so canopies shade as volumes. Conifers use flat horizontal needle sprays along level-1 branches; palms use arching V-folded frond strips. Both geometries carry `position`, `normal`, `uv`, `color`, `windWeight`.

`bounds` = `{box, sphere, height, canopy:{center, radius}}`; `stats` = `{species, branches, leafCards, trunkTriangles, leafTriangles}`. Typical counts at detail 1: broadleaf ≈ 4.4k triangles, conifer ≈ 7.4k, birch ≈ 6.7k, sakura ≈ 4.6k, palm ≈ 0.7k, bush ≈ 3.9k.

`KE.tree(THREE, options)` is a convenience: geometry + leaf texture + both materials + shadow materials in a `Group`. Extra options: `leafTexture`, `textureSize`, `leafMaterial`, `barkMaterial`, `leafColor`, `barkColor`, `translucency`, `translucencyColor`, `alphaTest`, `wind`. Returns `{group, trunk, leaves, geometry, material, bounds, stats, dispose()}`; `dispose` frees what it created.

`KE.leafTexture(THREE, {species, size:512, seed:1})` paints a mip-mapped sRGB `DataTexture` atlas of leaf sprays (2×2 cells; palm 2×1) on a canvas: curved twigs with alternating leaves (profile, serration, venation, fold shading), blossom clusters for sakura, needle sprays for conifers, fronds for palms. Transparent texels are dilated with neighbouring colour so mips have no dark fringes. `texture.userData.layout` holds the cell layout. Generation takes roughly 100 ms per 512² atlas on the CPU; share one atlas per species.

`KE.barkTexture(THREE, {species, size:256, seed})` paints a tileable bark map (furrowed oak, plated pine, birch with lenticels and patches, banded cherry, ringed palm). `KE.barkMaterial(THREE, {species, color, map, textureSize, roughness:.93, bump:.035, wind, vertexColors})` is a single-sided foliage material without translucency, using the bark map as colour and bump.

## 4. Interactive grass

`KE.grassField(THREE, scene, options)` → `{mesh, material, geometry, stats, cellSize, radius, lodRadius, update(camX, camZ), refresh(), setVisible(v), visible, setShadowSource(csm), dispose()}`.

| Option | Default | Meaning |
|---|---|---|
| `count` | `KE.settings.grass` | blade budget (instances) |
| `radius` | 25 | visible radius around the camera; blades shrink to nothing over the last 20 % |
| `heightAt(x,z)` | 0 | ground height |
| `density(x,z)` | 1 | 0..1 keep probability and height scale |
| `color(x,z,out)` | built-in greens | sRGB base colour; write into `out` and return it |
| `tipColor` / `tipMix` | 0xc9cf7a / .4 | tip tint (`tipColor:null` disables) |
| `bladeHeight` | [.35, .8] | height range |
| `bladeWidth` | .05 | base width |
| `segments` | 4 | segments per blade (2·segments+1 vertices) |
| `interact` | true | interactors bend blades |
| `lodRadius` | .4·radius | beyond it only `farFraction` (.28) of blades remain, widened by `farWiden` (1.8) |
| `cellSize` | radius/7 (1.5–8) | placement cell size |
| `clumpSize` / `clumpRadius` | 5 / ≤.22 | blades per tuft and tuft radius |
| `translucency`, `ambient`, `rootShade` | .6, 1, .4 | shading |
| `castShadow` / `receiveShadow` | false / true | shadow flags |
| `shadows` | `KE.foliage.shadowSource` | a `KE.CascadedShadows` to blend its cascades |
| `seed` | 1 | placement seed |

Placement is world-anchored: the ground is divided into cells, and each cell's blades are generated from a hash of its integer coordinates, so a blade never moves when the camera does. Blades are grouped into tufts: clump centres on a jittered low-discrepancy pattern, blades splayed outward from their centre, sharing the tuft's height, tint and lean. Cells near the camera hold the full set; outer cells hold the first `farFraction` of the same list (so the far set is an exact subset of the near set and cells never pop). Each cell owns a fixed slot in the instance buffers; `update` only regenerates cells that entered the window or changed ring and uploads that sub-range. It returns the number of cells regenerated (0 while the camera stays inside its cell). `update` also accepts a vector (`update(camera.position)`). Call `refresh()` after terrain or density changes.

The vertex shader builds each blade as a circular arc (quadratic Bézier, vertical tangent at the root, constant length) bent by: the blade's natural lean, travelling gusts, per-blade sway and cross-wind flutter, and interactors. An interactor pushes blades within about 1.6× its radius radially away, falling off with distance and with height (a sphere well above the blade tips has no effect). The fragment shader uses wrap diffuse, a back-light transmission term, a sheen highlight near the tip, root darkening for self-occlusion, three.js directional/point/hemisphere/ambient/probe lights and fog.

## 5. Shell fur

`KE.fur(THREE, object, options)` furs every mesh under `object` (a single mesh or a `Group` of spheres). Returns `{available, object, meshes, materials, shells, renderedShells, update(dt, velocity), setShells(n), setShadowSource(csm), dispose()}`.

| Option | Default | Meaning |
|---|---|---|
| `shells` | 16 | shell count (2–64) |
| `length` | .06 | fur length in world units |
| `density` | 900 | strands per square unit (approx.) |
| `thickness` | .6 | strand radius at the root (0..1 of the cell) |
| `color` / `tipColor` | source material colour / derived lighter tip | sRGB |
| `gravity` | [0,-1,0] | constant force direction |
| `windResponse` | .3 | response to the shared wind and gusts |
| `colorVariation` | .2 | per-strand brightness variation |
| `lengthVariation`, `droop`, `curl`, `undercoat`, `rim`, `inertia` | .35, .45, .5, .45, .6, 1 | style |
| `lod` | {maxDistance:12} | shells fall off beyond 35 % of this distance; none at it |
| `include(mesh)` | all meshes | false skips a mesh, true furs it, a number furs it with that length multiplier |
| `map` | – | optional colour texture multiplied into the fur (mesh UVs) |
| `shadows` | `KE.foliage.shadowSource` | cascaded shadow source |
| `renderer` | – | when given and not WebGL2, returns `{available:false}` |

Each source mesh gets a child `Mesh` whose `InstancedBufferGeometry` shares the source vertex and index buffers and draws all shells in one instanced call; shell 0 is an opaque undercoat and the rest are alpha-tested strands, so no sorting or blending is needed. Strands come from a 48³ tileable Worley texture (`DataTexture3D`, shared and reference counted) sampled at the unextruded object-space surface point scaled by the object's scale, so each strand is a continuous column through the shells regardless of UVs or non-uniform scaling. Strands taper toward their individual tips; a second, finer layer fills the lower undercoat. Shells are pushed by gravity, the shared wind and a damped spring driven by `update(dt, velocity)` (fur trails behind motion). Shading: wrap diffuse, a Kajiya-style anisotropic highlight along the strand direction, root darkening, a rim term and three.js lights and fog. `KE.settings.fur` (the `r.Fur` cvar) hides all shells immediately via the settings event; `setShells(n)` changes the shell count without recompiling. `dispose()` removes the shell meshes, leaves the source geometry intact and releases the strand texture when the last user is gone.

## 6. Foliage spawner

`new KE.FoliageSpawner(THREE, scene, options)` places instanced plants deterministically. Options: `bounds` (`{minX,minZ,maxX,maxZ}`, a `Box3`, or `{center, size}`; default ±50), `heightAt`, `normalAt` (optional; otherwise finite differences of `heightAt`), `seed` (1), `cellSize` (16), `frustumCull` (true), `cullMargin` (max(6, 1.5 × tallest type)), `maxDistance`, `instancedLOD` (true), `types`.

Each type: `name`, `geometry` (a `BufferGeometry`, `{trunk, leaves}`, or a whole `KE.treeGeometry` result), `material` (one material or `{trunk, leaves}`), `density(x,z)` (0..1), `spacing` (3, Poisson-disc radius), `exclusion` (spacing/2, keeps other types away), `scale` ([1,1]), `alignToNormal` (0..1), `maxSlope` (40 degrees), `castShadow` (true), `lodDistances` (default: .9 × view distance; scaled by `KE.settings.lod`), `lods` (`[{geometry, material}]` for levels after the first), `sink` (.05), `tint` (.1 instance colour variation), `maxCount`, `avoidOthers` (true).

Placement: Bridson Poisson-disc sampling per type over the bounds, filtered by density, slope and an occupancy grid shared between types. Instances are bucketed into square cells. `update(camera)` classifies each cell by distance into an LOD level (and culls cells outside the frustum expanded by `cullMargin`, so trees just off-screen still cast shadows) and rebuilds instance buffers only when that classification changes; it returns true when it rebuilt. `visibleCount` sums visible instances. Foliage and bark materials automatically get their shadow depth materials. Returns/fields: `groups` (per type: `name`, `count`, `matrices`, `colors`, `levels`, `meshes`), `count`, `backend`.

When a module providing `KE.InstancedLOD` is loaded (none ships at the time of writing), each type is handed to `new KE.InstancedLOD(THREE, scene, {name, matrices, colors, count, castShadow, levels:[{distance, parts:[{geometry, material, customDepthMaterial}]}]})`, which must return an object with `update(camera)` and `dispose()`; any failure falls back to the built-in cell LOD. `backend` reports `'cells'` or `'InstancedLOD'`. `dispose()` removes the instanced meshes and frees their instance buffers; geometries and materials stay with the caller.

## 7. Integration with shadows, GI and core helpers

- `KE.CascadedShadows`: foliage and bark materials can be set up like any standard material. Grass and fur are custom shaders; bind a cascaded-shadow source with `KE.foliage.setShadowSource(csm)` (all live and future grass/fur) or `setShadowSource`/`shadows` per system. They then blend the cascades exactly like set-up materials (PCF filtering; PCSS is not used for grass/fur). Without a source they receive the sun's own (cascade 0) shadow map.
- `KE.ProbeVolume`: foliage and bark materials take `setupMaterial` (probe irradiance replaces sky ambient); grass and fur use scene lights and the light probe only.
- Core 2.x: `KE.foliage.update` drives `KE.windUniforms`, so `KE.wind` materials keep working. `KE.grassField` replaces `KE.grass` (which re-lays all blades around the camera every 2 units and uses unseeded randomness). `KE.leafTexture` replaces `KE.leafSprayTexture`. `KE.fernGeometry` works with the spawner after `KE.foliage.addWindWeights`.

## 8. Quality settings and cost

- `KE.settings.grass` (`foliage.Grass`, 0–20000) is the default blade budget. Vertex cost is `count × (2·segments+1)`; lowering `segments` to 3 saves ~22 %. With the default `farFraction` (.28) blades inside `lodRadius` are about 3.5× denser than outside it.
- `KE.settings.lod` scales tree detail at generation (segments, radial sides, leaf cards) and spawner LOD distances.
- `KE.settings.fur` enables fur; fur cost is roughly `shells × source vertices` in the vertex stage plus alpha-tested overdraw proportional to the covered screen area × rendered shells. Distance LOD reduces shells beyond 35 % of `lod.maxDistance` (minimum 4) and removes fur beyond it.
- Leaf cards are alpha-tested and double-sided; overdraw from dense canopies is the main GPU cost of trees on phones. Use fewer, larger cards (`leafCards.count`, `detail`) or a lower `KE.settings.lod`.
- Nothing allocates per frame: `KE.foliage.update`, grass `update` inside a cell, fur `update` and a spawner `update` without a classification change are allocation-free. No frame-time figures are claimed; measure on the target device.

## 9. Limits

- Wind does not rotate normals; lighting ignores the small bend of leaves and blades.
- Trees are generated on the CPU at load (about 1–15 ms each) and have no billboard/impostor level; the spawner's `lods` must be supplied by the caller.
- Grass heights come from a JavaScript `heightAt`, so regenerating cells costs CPU time proportional to the blades in them; grass is not culled per cell against the frustum (hidden blades still pay vertex cost), and blades do not collide with anything except the eight interactors.
- Grass and fur use their own lighting model (not PBR) and do not sample `KE.ProbeVolume`, reflections or area lights; point lights are unshadowed.
- Fur requires WebGL2 for the 3D strand texture (a slower per-pixel hashed fallback is compiled for GLSL 1, untested). Shells are not rendered into shadow maps (the base mesh casts the shadow). Fur on thin geometry shows shell layering at grazing angles, as all shell methods do.
- The translucency model is an empirical wrap/back-light lobe, not subsurface transport.
