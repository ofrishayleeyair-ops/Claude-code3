# Open worlds · 3.0.0 (`32-world.js`, module `world`)

Core `KE.terrain` builds static chunk meshes for islands about 100 units across. The world module adds the pieces needed for multi-kilometre landscapes: a seeded heightfield generator with hydraulic and thermal erosion, a GPU terrain renderer with continuous LOD, cell streaming with HLOD proxies, and deterministic per-cell scatter.

## Contents

1. Quick start
2. KE.Heightfield
3. KE.GPUTerrain
4. KE.WorldPartition
5. KE.scatterCell
6. Quality settings and cost
7. Limits

## 1. Quick start

```js
const KE = window.KitsuneEngine;
const hf = KE.Heightfield.generate({size:1025, worldSize:2048, seed:11, islands:true, amplitude:180});
KE.Heightfield.erode(hf, {iterations:80000, seed:3});        // or {jobs:KE.jobs} for a promise
KE.Heightfield.thermalErode(hf, {iterations:4, talus:1.1});

const terrain = new KE.GPUTerrain(THREE, {heightfield:hf, castShadow:true, waterLevel:0});
scene.add(terrain.object);
csm.setupMaterial(terrain.material);                         // optional: KE.CascadedShadows

const wp = new KE.WorldPartition({cellSize:128, loadRadius:384, unloadRadius:448, budgetMs:2,
  load: cell => { const g = KE.scatterCell(THREE, {cell, heightfield:terrain, types, seed:21});
                  scene.add(g); return g; },
  unload: (cell, g) => g && g.userData.dispose(),
  hlod: cell => makeProxy(cell), hlodRadius:1200});

// every frame, before shadows and rendering:
terrain.update(camera);
wp.update(player.position, dt);
const ground = terrain.heightAt(x, z);                      // same surface the GPU draws
```

Use heightfield sizes of 2^n + 1 (513, 1025, 2049): the finest terrain vertices then sit exactly on samples. Other sizes work but are resampled bilinearly at the vertices.

## 2. KE.Heightfield

A heightfield is `size × size` samples covering `worldSize × worldSize` units. `data[j*size + i]` is the height at `(originX + i*spacing, originZ + j*spacing)` with `spacing = worldSize/(size-1)`. The default origin centres the field on (0, 0).

### Generation

`KE.Heightfield.generate(options)` returns a Heightfield, or with `options.jobs` (a `KE.Jobs` queue) a promise that resolves once the rows have been produced under that queue's budget. The landscape is a function of world position, so different bakes of one seed (other sizes, origins or streamed tiles) agree where they overlap. `KE.Heightfield.terrainFunction(options)` returns that function `(x, z) → height` directly.

The shape combines a domain-warped continental fbm (lowland versus mountain country and the coast), derivative-damped fbm for rolling eroded hills (octaves are suppressed where the accumulated slope is steep, after Inigo Quilez), and ridged multifractal noise (Musgrave) for crest lines. Octaves are rotated about 37° so lattice axes never line up.

| Option | Default | Meaning |
|---|---|---|
| `size` | 1024 | samples per side (2–8192) |
| `worldSize` | 2048 | extent in world units |
| `seed` | 1 | integer seed |
| `octaves` | 7 | detail octaves for hills and ridges (1–12) |
| `baseHeight` | 0 | added to every height |
| `amplitude` | 180 | vertical scale |
| `ridged` | .5 | 0 = rounded hills, 1 = sharp ridges inside mountain areas |
| `warp` | .35 | domain-warp strength |
| `mountains` | .5 | share of mountain country |
| `hills` | .16 | hill amplitude in lowlands |
| `seaLevel` | .1 | normalised shape value mapped to `baseHeight` |
| `damping` | 1.2 | slope damping of the eroded fbm |
| `scale` | worldSize/2 | horizontal feature scale |
| `islands` / `falloff` | false / – | radial falloff to sea at the edges; `falloff` may be the edge width (.02–.95, default .42) or a function `(x,z) → 0..1` |
| `originX`, `originZ` | −worldSize/2 | placement |

### Hydraulic erosion

`KE.Heightfield.erode(hf, options)` runs particle erosion after Hans Theobald Beyer (2015), in the form popularised by Sebastian Lague. Each droplet follows the bilinear gradient with inertia, carries sediment up to a capacity proportional to its speed, water and downhill drop, erodes with a radial brush and deposits when over capacity or climbing. Heights are normalised by the field's range while simulating, so parameters behave the same at any world scale. Returns `hf`, or a promise with `jobs`.

Channel networks need roughly one droplet per sample, which is too slow at 1024². By default the droplets therefore run on a coarser grid (`simSize` 385). The resulting height change is blurred (mass conserving), upsampled, corrected so its total volume equals the simulated change exactly, blurred once more to hide interpolation creases, and added to the full-resolution field, which keeps its fine detail. `detailIterations` adds an optional full-resolution pass. Pass `simSize: hf.size` to simulate at full resolution.

Options (defaults): `iterations` 80000, `seed` 1, `simSize` min(size, 385), `detailIterations` 0, `inertia` .05, `capacity` 4, `minCapacity` .001, `erosion` .3, `deposition` .3, `evaporation` .01, `gravity` 4, `lifetime` 30·√(simSize/256) clamped to 30–90 steps, `radius` 3 (erosion brush, samples), `depositRadius` min(2, radius) (0 = bilinear deposition as in the reference), `spawnAbove` (spawn droplets only above this height, e.g. the sea level), `smoothing` 2 (blur passes of the change), `conserve` true (sediment left when a droplet dies is deposited there), `heightScale`, `masks` true, `batch` 2000 droplets per job step, `jobs`, `priority`.

Material is only lost when a droplet leaves the map; `hf.erosionStats` reports `{droplets, detailDroplets, simSize, erodedVolume, lostVolume, lifetime}`. `hf.masks.flow` counts droplet visits per sample and `hf.masks.delta` holds the signed height change; the biome classifier uses both (dirt in channels and deposition fans).

In this repository's test (headless Chromium with software WebGL, shared 4-CPU machine) 80000 droplets on a 1025² field took about 0.8–1.1 s and generation about 1.3–1.6 s of JavaScript time. Expect different figures on other machines.

### Thermal erosion

`KE.Heightfield.thermalErode(hf, {iterations:40, talus:.85, rate:.5, jobs})` relaxes slopes steeper than `talus` (rise over run) toward the lower 8-neighbours in proportion to their excess. Mass conserving.

### Import

`KE.Heightfield.fromImage(image, options)` accepts an image, canvas, ImageBitmap, ImageData or `{data, width, height, channels}` with Uint8, Uint16 or Float32 samples. `encoding` is `'luma'` (default) or `'rg16'` (R·256 + G). The image is resampled bilinearly to `size` (default max(width, height)); heights map to `minHeight` (0)…`maxHeight` (100); `worldSize` defaults to size−1; `smooth` applies that many 3×3 box passes.

### Biome weights

`KE.Heightfield.biomes(hf, options)` (or `biomes(THREE, hf, options)`) returns an RGBA8 `DataTexture` of splat weights per sample: R grass, G sand, B rock, A snow, and dirt as the remainder (1 − r − g − b − a). Without `THREE` it returns `{data, size, layers}`. Rules: sand on low flat ground near and below the water line; rock on steep or convex ground and on steep ground above the snow line; snow above a noisy snow line where it is flat enough to settle; dirt in erosion channels and deposition fans, on dry mid slopes and in the alpine band; grass elsewhere. Options: `waterLevel` 0, `beachHeight`, `snowLine`, `alpineLine`, `rockSlope` [.55, .95], `snowSlope` [.55, 1.1] (slope range over which snow slides off), `snowOverRock` false (above the snow line snow covers rock instead of rock winning on steep ground, for a snow-capped volcano), `moistureScale` 260, `seed`, and 0–1 multipliers `dirt`, `sand`, `snow`, `rock`. `GPUTerrain` passes `biomeOptions` through. `texture.userData.update(i0, j0, i1, j1)` reclassifies a sample rectangle with the thresholds captured at creation.

### Heightfield instance

Fields: `data`, `size`, `worldSize`, `spacing`, `originX`, `originZ`, `minHeight`, `maxHeight`, `masks`, `version` (incremented by every edit), `erosionStats`. Methods: `heightAt(x,z)` (bilinear, clamped at the edges), `gradientAt(x,z,out)`, `normalAt(x,z,out)`, `slopeAt(x,z)` (|∇h|, 1 = 45°), `sample(i,j)`, `contains(x,z)`, `clone()`, `volume()`, `recomputeRange()`, `toTexture(THREE, {format:'auto'|'float'|'half'|'rgba8', renderer})` (nearest-filtered; `'float'` shares `data`). `KE.noise2D(seed)` exposes the seeded gradient noise.

## 3. KE.GPUTerrain

`new KE.GPUTerrain(THREE, options)` renders a heightfield with continuous distance-dependent LOD (CDLOD, F. Strugar 2010).

- **Quadtree.** Level-0 nodes (leaves) are `gridResolution` quads across; each level up doubles the node size, and the root covers the heightfield. `levels` defaults to the count that makes the finest vertex spacing about equal to the sample spacing (1025 samples over 2048 units with a 32 grid: 6 levels, 64-unit leaves, 2-unit vertices). Per-node minimum and maximum heights give tight bounding boxes.
- **Selection** (`update(camera)`). From the root, a node is drawn at its own level when it lies outside the next finer LOD range; otherwise its children are visited, and a child out of reach of the finer range is drawn as a quadrant of the parent at the parent's density. Nodes outside the view frustum are skipped. Ranges double per level starting at `lodDistance` × `KE.settings.lod` (never below 2.2 leaf sizes); the top level has no limit.
- **One draw call.** Every selected node or quadrant becomes one instance of a shared grid mesh (`InstancedBufferGeometry`, attributes `kePatch` = x, z, size, level and `kePatchStep`), so all terrain patches are a single instanced draw.
- **Vertex shader.** Heights come from an R32F copy of the heightfield, sampled with four nearest texels and manual bilinear filtering, identical to `Heightfield.heightAt`. Odd grid vertices glide onto their even neighbours as the distance approaches the level's range (the last 32% of the range by default), so levels meet without cracks and without popping. Morph distances use a dedicated uniform camera position, so shadow passes rendered from a light share the main camera's geometry. Skirts (short downward strips along patch edges) cover any residual gaps.
- **Normals** come from an RGBA8 normal map at heightfield resolution, sampled per pixel, so lighting detail does not depend on the LOD.

| Option | Default | Meaning |
|---|---|---|
| `heightfield` | required | a `KE.Heightfield` |
| `material` | null | null builds the default landscape material; any Three material is patched with `patchMaterial` |
| `textures` | `KE.materials(THREE, textureSize)` | layer tiles and packed height maps (the core `KE.materials` array) |
| `textureSize` | min(512, `KE.settings.tex`) | tile size when textures are created here |
| `gridResolution` | 32 | quads per patch side (multiple of 4, 4–256) |
| `levels` | auto | quadtree depth (1–14) |
| `detail` | 1 | >1 makes the finest vertices denser than the samples (with automatic levels) |
| `lodDistance` | 3 × leaf size | first LOD range, scaled by `KE.settings.lod` |
| `morph` / `morphRatio` | true / .68 | geomorphing and where it starts inside each range |
| `skirts` / `skirtDepth` | true / 2 | skirts and their depth in vertex spacings |
| `castShadow` / `receiveShadow` | false / true | mesh shadow flags |
| `shadowSweep` | 2 × max(200, height range) with castShadow | nodes outside the view are kept when sweeping them this far away from the sun reaches the frustum, so off-screen mountains still cast shadows into view (uses `terrain.sunDirection` or the shared `keSunDirection`) |
| `waterLevel` | 0 | biome sand line and wet-shore band |
| `biomes` / `biomeOptions` | computed | own splat texture, or options for `Heightfield.biomes` |
| `textureScale` / `farScale` | .3 / .2 | tiles per unit near, and the far-scale multiplier |
| `relief` | .32 | relief-normal strength |
| `macro` | 1 | macro variation strength (0 disables) |
| `grassTint` | [1, 1, 1] | multiplier on the grass layer colour (for example [.8, 1, .65] for a greener, less dry look); live in `materialUniforms.keGrassTint` |

**Default material.** A `MeshStandardMaterial` patched through `onBeforeCompile` with five layers from the biome weights (grass, sand, dirt, rock, snow) using the core `KE.materials` tiles: height blending (each layer's weight is raised by its tile height and only layers within a narrow band of the tallest survive), triplanar rock on cliffs plus rock forced on steep per-pixel normals, a second sample at 1/5 scale that takes over with distance to hide tiling, low-frequency macro noise that varies grass hue and brightness, relief normals from texture-space differences of the blended layer heights two texels apart (smooth and mip-aware, as in `KE.splatMaterial`), and wet darkening with lower roughness just above `waterLevel`. It chains with `KE.CascadedShadows.setupMaterial` (its `onBeforeCompile` and cache key are composed). `terrain.materialUniforms` exposes `keTexScale`, `keFarScale`, `keRelief`, `keWaterLevel`, `keMacro` and the textures for live tweaking.

**Queries.** `heightAt(x,z)` returns the finest-LOD surface: bilinear samples at the level-0 vertex grid, interpolated over the same two triangles per quad the patch mesh uses. It equals what the GPU draws wherever level 0 is shown unmorphed; coarser levels deviate by their simplification, as with any LOD. `normalAt(x,z,out)` and `slopeAt(x,z)` follow the heightfield (the normal map agrees within 8-bit precision). `raycast(origin, dir, maxDist, out)` returns `{point, normal, distance}` or null: a 2D DDA walks level-0 nodes along the ray, skips nodes whose maximum height lies below the ray, marches candidates at half the vertex spacing and refines the first crossing by bisection. A ray starting below the surface hits at its origin. `terrain.object.raycast` is overridden, so `THREE.Raycaster.intersectObject(terrain.object)` works.

**Editing.** `sculpt({x, z, radius:8, strength:1, mode, height, falloff:1})` with `mode` `'raise'`/`'lower'` (adds strength × falloff units), `'smooth'` (blends toward the 3×3 mean) or `'flatten'` (blends toward `height`, default the height under the brush centre) by strength × falloff (0–1). `setHeightRegion(i0, j0, width, height, values)` replaces a sample rectangle. Both update the heightfield, normal map, min/max tree and biome weights on the CPU and queue sub-rectangle uploads (`texSubImage2D` through `renderer.copyTextureToTexture`), flushed immediately once the terrain has seen a renderer (first render, or `update(camera, renderer)`). They return the touched sample rectangle. Call `refresh()` after changing the heightfield elsewhere (for example eroding it again); that re-uploads everything.

**Other methods.** `update(camera, renderer?)`; `patchMaterial(material)` makes any material draw the patches (injects the vertex code, shares `terrain.uniforms`); `setDebug('lod' | 'wireframe' | 'height' | null)` swaps in an unlit view coloured per LOD level (morph shown as a blend), the same with triangle edges, or world height in the red channel for float render targets; `stats()` → `{patches, drawCalls, triangles, nodesVisited, culled, levels, levelCounts, leafSize, vertexSpacing, gridResolution, ranges, selectionMs, capacity}`; `dispose()` frees the geometry, height, normal and owned biome textures, owned materials and tiles. `KE.GPUTerrain.GLSL.vertex` holds the shared vertex code (`keTerrainVertex()`, `keTerrainHeight(xz)`).

Keep `terrain.object` at the identity transform: the heightfield origin places it and CPU queries assume world coordinates. Call `update` before `csm.update` and before rendering each frame.

## 4. KE.WorldPartition

`new KE.WorldPartition(options)` streams square cells around a position.

- Cells whose nearest point lies within `loadRadius` are wanted. Loaded cells beyond `unloadRadius` are unloaded (the gap is hysteresis). In-flight loads beyond it are cancelled.
- New loads start nearest-first, measured from the position extrapolated by the smoothed velocity × `prefetch` seconds, while the frame budget lasts (at least one per update) and while fewer than `maxConcurrent` asynchronous loads are in flight.
- `load(cell, ctx)` may return a value (synchronous), a Promise, or an iterator/generator. Generators are stepped nearest-first under the budget, or submitted to `jobs` (a `KE.Jobs` queue) when given; `update` then runs that queue for the remaining budget unless `runJobs:false`. `ctx.signal.aborted` becomes true when the load is cancelled.
- Cancellation: generators get `return()`, so their `finally` blocks run. A promise cannot be stopped; the cell waits in state `'cancelling'` and the result is passed to `unload` when it settles. A cell never has two loads at once and a loaded cell is never loaded again.
- HLOD: with `hlod(cell)`, every wanted-but-not-loaded cell within `hlodRadius` gets a proxy (a merged low-poly mesh, an impostor, anything). This includes cells whose load is still queued or in flight, so streaming leaves no holes. A proxy is removed when its cell finishes loading or moves beyond `hlodUnloadRadius`. A loaded cell that moves out of range gets its proxy before it unloads.

Options (defaults): `cellSize` 128, `loadRadius` 3 × cellSize, `unloadRadius` loadRadius + cellSize/2, `load`, `unload(cell, data)`, `hlod`, `hlodUnload(cell, proxy)` (default: `proxy.dispose()` or remove it from its parent), `hlodRadius` 3 × loadRadius, `hlodUnloadRadius` hlodRadius + (unloadRadius − loadRadius), `budgetMs` 2, `maxConcurrent` 4, `jobs` null, `runJobs` true, `originX`/`originZ` 0, `bounds` `{minX, minZ, maxX, maxZ}`, `filter(ix, iz)`, `prefetch` .5 s, `retryDelay` 2 s (failed loads retry after this), `onError(error, cell)`.

Methods: `update(position, dt, budgetMs?)` (pass `Infinity` to load everything now); `cellAt(x, z)`; `isReady(position)` (every wanted cell loaded); `preload(position, {timeoutMs})` (async; loads everything around a teleport target); `stats()` → `{cells, loaded, loading, cancelling, failedCells, hlod, pending, inflight, started, completed, cancelled, unloaded, failed (load failures so far), discarded (late results of cancelled promise loads), hlodCreated, hlodRemoved, doubleLoads (always 0; a guard counter), ms, maxMs}`; `dispose()` cancels loads and unloads cells and proxies. `wp.cells` is a `Map` of cell records `{key, ix, iz, x, z, size, cx, cz, state, data, proxy, distance, loads, error}` with `state` one of `unloaded`, `loading`, `loaded`, `cancelling`, `failed`.

The budget bounds when new work starts. A single synchronous load longer than the budget still runs to completion, so split heavy loads into generators.

## 5. KE.scatterCell

`KE.scatterCell(THREE, options)` returns a `THREE.Group` with one `InstancedMesh` per used type. Candidate points sit on a global jittered lattice: one point per `spacing × spacing` square, jittered by a hash of the square's integer coordinates and the seed. Each cell keeps the points inside its bounds, so the result depends only on (seed, cell) and neighbouring cells tile without seams or overlap in any streaming order. Each point draws acceptance, type, yaw, tilt and scale from its own hash.

Options: `cell` (`{ix, iz}` or a WorldPartition cell record), `cellSize` 128, `originX`/`originZ`, `heightfield` (or `terrain`; anything with `heightAt`, optionally `slopeAt` and `normalAt`), `spacing` 4, `density` 1 (probability, or a function `(x, z) → 0..1`), `seed` 1, `waterLevel` (skip points below), `filter(x, y, z, typeIndex, slope)`, `castShadow`, `receiveShadow`, and `types`: `[{geometry, material, weight:1, scale:[.8,1.2], scaleY, slope:[0,∞], height:[−∞,∞], density:1, align:0 (0 upright … 1 follows the normal), sink:0 (× scale), castShadow, receiveShadow, name}]`.

Each mesh draws through a per-cell view of the shared geometry (same attribute objects, no copies) carrying the cell's bounding sphere, so Three's frustum culling works per cell. `group.userData.dispose()` frees the cell's instance buffers and vertex-array state without touching the shared geometry, and removes the group. `group.userData.count` is the instance total.

## 6. Quality settings and cost

- `KE.settings.lod` (`r.LODBias`: Low .6, Medium .8, High 1, Ultra 1.25, Cinematic 1.5) scales every LOD range. The triangle count grows roughly with its square. Ranges update on the next `update()` after the setting changes.
- `gridResolution` sets triangles per patch (2N² + 8N with skirts): 32 gives 2304 triangles per patch.
- `KE.settings.tex` picks the tile size when the terrain creates its textures.
- The default fragment shader does about 18 texture fetches (biome, normal map, two scales of four planar layers and two height packs, three triplanar rock samples) plus value-noise macro variation. Shade cost is per pixel and independent of the LOD. Supply your own `material` for low-end targets.
- CPU per frame: quadtree selection visits a few dozen to a few hundred nodes (`stats().selectionMs`). Memory: the heightfield (4 bytes per sample), its R32F texture, an RGBA8 normal map and an RGBA8 biome map with mipmaps, about 16 MB of GPU textures for 1025².
- Construction time is dominated by painting the `KE.materials` tiles and classifying biomes. In the test environment it took about 4.5–7 s for 1025² with 256-pixel tiles. Pass `textures` or `biomes` to reuse them.

Numbers above were measured only in this repository's headless software-rendering test; no GPU frame-time figures are claimed.

## 7. Limits

- A single heightfield per terrain (no tiled virtual heightmap). Streaming very large worlds means several terrains or regenerating a heightfield per region; `Heightfield.terrainFunction` keeps such tiles consistent.
- Erosion is a droplet model. It carves and smooths valleys and builds sediment fans, but it does not simulate rivers, lakes or long-term flow networks, and the default coarse grid (385²) limits channel width to a few samples of the full field.
- `heightAt` matches the rendered surface at LOD 0. Far away the GPU draws a coarser surface; physics should use `heightAt`.
- Frustum culling is per patch against the camera (plus the sun sweep for shadow casters). There is no occlusion culling.
- Holes, overhangs and caves are not supported (height-map terrain).
- The terrain object must stay at the identity transform.
- Three r128 decides whether to upload changed geometry buffers from `renderer.info.render.frame`. `KE.Pipeline` resets `renderer.info` before its passes, so a direct `renderer.render()` straight after a pipeline frame would draw last frame's patch list once. Call `renderer.info.reset()` before such a render, or render every frame the same way.
- Biome weights, the normal map and LOD bounds are recomputed on the CPU for sculpted regions. Large brushes on large fields cost milliseconds.
