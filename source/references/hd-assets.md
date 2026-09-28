# HD asset pack (`21-hd`)

The engine can use real photoscanned assets, loaded from an optional folder `hd/` next to the page:
- ground, bark, plank and roof texture sets (albedo, normal, ARM = AO/roughness/metalness, height);
- scanned 3D models: rocks, cliffs, plants, forest debris, props, furniture and trees;
- sky HDRIs.

Every asset comes from [Poly Haven](https://polyhaven.com) and is CC0 (public domain). `hd/CREDITS.md` names the artists, and `hd/LICENSE.txt` states the licence. Without the folder, nothing changes: games keep the engine's painted textures and procedural rocks.

## Contents

1. Building the pack
2. File format
3. KE.HD API
4. HD terrain layers (KE.GPUTerrain.setLayers)
5. Rock clusters (KE.rockCell) and instance groups
6. How the showcase games use it
7. Costs and limits

## 1. Building the pack

```
python3 scripts/hd_pack.py                 # everything: 5.2 GB in hd/ (4.1 GB of source files), 208 assets: 89 material sets, 96 models, 23 skies
python3 scripts/hd_pack.py --no-library    # only what the Open World uses: about 1.1 GB, 48 assets
python3 scripts/hd_pack.py --list          # show the asset list
```

- **Download.** The script reads Poly Haven's public API and CDN.
- **Cache.** Downloads are cached in `../.hd-cache` (git-ignored), so a re-run only repacks.
- **Atomic writes.** Files are written through a temporary name and renamed, so a page loading the pack never reads a half-written file.
- **Oversized models.** Library models whose 2K glTF exceeds 80 MB are skipped.

The lists at the top of the script say what goes in:

| List | What | Resolution |
|---|---|---|
| `TERRAIN` | the 8 ground layers: forest moss, leaf litter, sand, forest dirt, river gravel, mossy rock, bare rock, snow | 4K albedo, normal and ARM; 2K height |
| `SURFACES` | Japanese cedar, sakura, trident maple, zelkova, metasequoia and pine bark; hinoki, dark and weathered planks; grey roof tiles; stone wall; cobble path | 2K–4K |
| `MODELS` | mossy rock sets, boulders, cliff faces, ferns, shrubs, moss, wildflowers, nettles, grass clumps, stumps, fallen trunks, roots, branches; wooden lantern, stone fire pit, wooden pier | 2K glTF |
| `LIB_HDRI` | 23 skies: dawn, noon, sunset, overcast, night | 4K `.hdr` |
| `LIB_TEXTURES` | 69 more material sets: brick, plaster, concrete, woods, metals, fabrics, leathers, roofs, tiles, cobblestone, asphalt, rock, ground | 4K + 2K height |
| `LIB_MODELS` | 69 more models: lanterns and lamps, barrels, crates, vases, a tea set, furniture, tools, street props, island trees, potted plants, more rocks | 2K glTF (most full-size tree scans exceed the 80 MB cap and are skipped) |

## 2. File format

A page opened from disk (`file://`) may not hand local image files to WebGL: browsers treat them as another origin. A `<script>` in the same folder may carry bytes, though. So every file in the pack is a script:

```
hd/manifest.js            KitsuneHD.manifest({version, license, source, bytes, assets: {id: {kind, role, res, name,
                            authors, page, size_m: [w, h] metres, files: {name: {mime, bytes, parts, script}}}}})
hd/<id>/<file>.js         KitsuneHD.put('<id>/<file>', part, parts, 'mime', 'base64…')
```

- **Kinds and roles.** `kind` is `texture`, `model` or `hdri`. `role` is a space-separated list of tags (`grass`, `bark cedar`, `rock cliff`, `prop light library`, …).
- **Large files.** Files over 30 MB are split into parts (about 40 MB of base64 each). Every script stays under GitHub's 50 MB warning size and its 100 MB limit.
- **Size cost.** Base64 costs a third more space than the raw bytes: 4.1 GB of source files become 5.2 GB of scripts.

## 3. KE.HD API

| Call | Result |
|---|---|
| `KE.HD.ready(base='hd/')` | the manifest, or `null` when the folder is missing or `KE.HD.enabled` is false. Loaded once. |
| `has(id)`, `info(id)`, `find(kind, role)` | lookups; `find('texture','bark')` lists matching ids |
| `mapFile(id, map)` | the file for `'diff'`, `'nor'`, `'arm'` or `'disp'` at the best resolution in the pack |
| `blob(id, file)` | the file's bytes as a `Blob` (parts reassembled; base64 decoded with `fetch('data:')`, `atob` as a fallback). At most 4 files load at once. |
| `bitmap(id, file, {size, flipY})` | an `ImageBitmap`, decoded off the main thread; `size` resamples to a square (high quality) |
| `texture(THREE, id, map, {size, srgb, repeat})` | a mipmapped, anisotropic `Texture` (rows flipped at decode, `flipY` false: the usual UV convention) |
| `material(THREE, id, {size, repeat, color, normalScale})` | `MeshStandardMaterial` with `map`, `normalMap` and the ARM map as `roughnessMap` + `metalnessMap` (G, B) |
| `aoMaterial(material, geometries)` | adds the ARM map as `aoMap` (R) and copies `uv` to `uv2`, which Three r128 needs for AO |
| `layers(renderer, THREE, ids, map, size)` | one `TEXTURE_2D_ARRAY`, one layer per id, uploaded straight from the decoded images (`texStorage3D` + `texSubImage3D`, mipmapped, anisotropic). It is wrapped in a `DataTexture2DArray` left at version 0, so Three binds the handle as-is and never uploads. `dispose()` deletes the GL texture. |
| `gltf(THREE, id)` | `{scene, parts: [{geometry (world-transformed), material, name}], dispose}`. Loaded through `GLTFLoader` with every file mapped to a blob URL. |
| `prepare(THREE, id, opts)` | instancing-ready pieces (below) |
| `hdri(renderer, THREE, id, {pmrem})` | `{texture, envMap}`: the equirectangular sky (`RGBELoader`, half float) and a PMREM environment for `scene.environment` |
| `stats` | `{files, bytes, textures, gpuBytes, ms}` |
| `dispose()` | frees everything this module created |

`prepare(THREE, id, {maxTriangles=5000, split=true, wind, textureSize, keep})` returns pieces ready for instancing:

- **Splitting.** With `split`, each mesh becomes its own piece (a rock set gives several rocks). Otherwise the meshes are merged per material.
- **Recentring.** Every piece is recentred on its footprint: x/z centre at 0, base at y = 0.
- **Simplifying.** A piece above `maxTriangles` is simplified with `KE.simplify` (meshoptimizer). Scans often have 50k–770k triangles; the scanned normal map keeps the surface detail on the simplified mesh.
- **Textures.** `textureSize` resamples the textures, which sets the VRAM budget.
- **Foliage.** Blended foliage becomes alpha-tested and double-sided, so instances need no sorting.
- **Wind.** `wind` adds height-based sway (`KE.foliage`).

Each piece is returned as `{geometry, material, triangles, sourceTriangles, size: [x, y, z] metres, name}`, sorted largest first. `keep` limits how many are returned.

## 4. HD terrain layers

```js
const ids = ['forrest_ground_01','brown_mud_leaves_01','coast_sand_01','forest_ground_04','river_small_rocks','mossy_rock','rock_face_03','snow_02'];
const L = {};
for (const [k, map, size] of [['albedo','diff',4096],['normal','nor',4096],['arm','arm',2048],['height','disp',1024]])
  L[k] = await KE.HD.layers(renderer, THREE, ids, map, size);
terrain.setLayers({...L, scales: ids.map(id => 1 / KE.HD.info(id).size_m[0]), rockHigh: [y0, y1], dirtToMoss: .75, normalStrength: 1});
```

The eight layers are, in order: grass, grass-leaves, sand, dirt, gravel, rock, rock-high, snow.

- **Splitting the biome weights.** The biome map holds grass, sand, rock and snow weights (dirt is the remainder); the HD shader splits these further:
  - grass into moss and leaf litter, by broad noise;
  - dirt into gravel where water flows (the flow mask becomes an R8 texture);
  - rock into mossy and bare, between `rockHigh[0]` and `rockHigh[1]` metres of altitude;
  - with `dirtToMoss`, a share of the dry dirt becomes moss, in noise patches.
- **Blending.** Layers are height-blended using their height maps.
- **Real-world scale.** Every layer is sampled at its real size (`scales`, tiles per metre). It is also sampled at `farScale` in the distance, to hide tiling.
- **Rock.** Rock is projected triplanar.
- **Normals.** Normals come from the layers' normal maps, whiteout-blended onto the terrain normal (triplanar for rock) and faded with distance.
- **Roughness and AO.** Both come from the ARM maps.
- **Switching back.** `setLayers(null)` returns to the painted layers.
- **Texture slots.** The HD variant uses 7 fragment samplers where the painted one uses 9, so it fits the 16 that ANGLE/D3D11 allows even with 4 shadow cascades.

## 5. Rock clusters and instance groups

`KE.rockCell(THREE, {cell, cellSize=96, terrain, types, seed, spacing=24, density, filter, members=[2,6], spread=1.6, tilt=.35, align=.7, cliffSlope=1.05, waterLevel})` places the rocks of one cell:

- **Cluster centres.** They sit on a global jittered lattice, each kept with probability `density(x, z)` and passed through `filter`.
- **Ordinary ground.** A cluster is one hero rock (types with role `hero`) ringed by `members` smaller rocks (role `small`).
- **Steep ground.** Where the slope is at least `cliffSlope`, a cliff piece (role `cliff`) is pressed into the slope with its face turned downhill, and scree is placed below it.
- **Every rock:**
  - It is sunk by a share of its height (`type.sink [a, b]`).
  - It is yawed at random, tilted up to `tilt`, and leaned `align` of the way onto the terrain normal.
  - It is stretched ±12% per axis.
- **Types.** `{geometry, material, role, size: [min, max] metres of the largest side, sink, weight, height, slope, underwater}`.
- **Determinism.** Placement depends only on the seed and the cell, and the group follows the same contract as `KE.scatterCell` (streams with `WorldPartition`, works with `KE.HorizonCuller`).

`KE.instanceGroup(THREE, types, buckets, name)` turns flat matrix lists into one `InstancedMesh` per type. Each mesh draws through a per-group view of the shared geometry that carries the group's bounding sphere. `userData.dispose()` frees only the group's own buffers. `scatterCell` and `rockCell` both build their groups this way, and games can use it for hand-placed sets (river boulders, shore rocks).

## 6. How the showcase games use it

**Open World (High and above, when `hd/` is present).** The HD pack supplies:
- **Ground:** the 8 photoscanned ground layers, at 4K on Epic and Cinematic, 2K on High and Ultra (ARM half that, height 1K).
- **Bark and wood:**
  - The trees get Japanese bark: cedar, zelkova, trident maple and sakura; the daisugi gets metasequoia.
  - The boats and jetty are hinoki planks, and the yakatabune roofs are grey tiles.
  - The torii's lacquer carries wood grain.
- **Rocks** (`KE.rockCell` in 96 m cells):
  - Clusters of scanned mossy rocks and boulders.
  - Cliff faces and a mountainside scan on steep ground.
  - Coast rocks at the waterline.
  - Boulders along both river banks.
- **Forest floor:** stumps, fallen trunks and roots.
- **Near ground cover:** ferns, moss, celandine, nettles, grass clumps, weeds, branches, bark and pebbles.
- **Props:**
  - Scanned lanterns on the jetty and at the torii; their glass glows at night.
  - A stone fire pit by the spawn, with flames, embers, smoke and a flickering light.

The load screen names each step.

**Spirit Isle (High and above).** Its shore rocks are scanned boulders and mossy rocks in sunk clusters.

**Without the pack.** Both games use procedural rocks in the same cluster layout, with a triplanar stone material.

**HD Library (`hd-gallery.html`).** It browses the whole pack:
- search and filters;
- materials on a sphere and on a ground tile at real size;
- models on a turntable, with triangle counts and sizes;
- skies as background and reflections;
- the credits.

## 7. Costs and limits

- **Load time.** In the software-rendered test browser (4 threads), the Open World at High loads 164 files (687 MB) and opens in about 60–75 s. On a desktop with a GPU, JPEG decoding dominates, and `createImageBitmap` spreads it over the browser's decoder threads. Load time on real hardware was not measured.
- **Download size.** Epic reads the 4K ground (about 400 MB of JPEG, 540 MB of scripts) plus the models and bark.
- **VRAM:**
  - Estimate (`KE.HD.stats.gpuBytes`): about 1.5 GB for the Epic ground arrays (albedo and normal 8 × 4K, ARM 8 × 2K, height 8 × 1K, mipmapped) plus about 1 GB for models and bark.
  - Measured: 535 MB at High, in the test browser.
  - No game should load the whole library at once.
- **Git hosting.** The 5.2 GB folder is committed in several pushes, since GitHub rejects a single push over 2 GB. Rebuilding it with `hd_pack.py` downloads straight from Poly Haven instead.
- **Model scans.**
  - Polycounts are reduced at load time.
  - The simplifier works per mesh, so a scan made of one large connected surface (such as `shrub_01`, three shrubs in one mesh) stays one piece.
- **Colour.** Photoscanned albedo is used as captured; grass-layer colour is only nudged by `grassTint`.
