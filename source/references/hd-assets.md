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
python3 scripts/hd_pack.py                 # everything: 5.9 GB in hd/ (4.7 GB of source files), 217 assets: 95 material sets, 99 models, 23 skies
python3 scripts/hd_pack.py --no-library    # only what the games use: 55 assets, 1.4 GB of source files (1.8 GB of scripts)
python3 scripts/hd_pack.py --ultra         # adds 8K texture tiers, 4K hero scans and 8K/16K skies (a local build, see below)
python3 scripts/hd_pack.py --list          # show the asset list
```

- **Download.** The script reads Poly Haven's public API and CDN.
- **Cache.** Downloads are cached in `../.hd-cache` (git-ignored), so a re-run only repacks.
- **Atomic writes.** Files are written through a temporary name and renamed, so a page loading the pack never reads a half-written file.
- **Oversized models.** Library models whose 2K glTF exceeds 80 MB are skipped.
- **Resolution tiers.** Each ground layer is stored at 1K, 2K and 4K (albedo, normal and ARM) with 1K and 2K height maps; each bark, plank and roof set at 1K, 2K and its full size. The engine loads the smallest tier that meets the quality setting, so a lower preset reads fewer bytes.
- **`--ultra`.** Adds an 8K tier to the ground layers, the hero surfaces (cedar bark, hinoki planks) and the library materials, 4K glTF files for the hero scans (rocks, cliffs, stumps, fire pit), and 8K skies (16K for two of them), where Poly Haven has them. The result is far too large for git hosting, so it is meant to be built on the machine that runs the game. The Open World's presets top out at 4K ground; an 8K tier is used only by code that asks for it (`KE.HD.layers(…, 8192)`, `texture(…, {size: 8192})`).

The lists at the top of the script say what goes in:

| List | What | Resolution |
|---|---|---|
| `TERRAIN` | the 12 ground layers: forest moss, leaf litter, dry sand, forest dirt, river gravel, mossy rock, bare rock, snow, volcanic ash, lichen-covered volcanic rock, trail, wet sand | 1K/2K/4K albedo, normal and ARM; 1K/2K height |
| `SURFACES` | Japanese cedar, sakura, trident maple, zelkova, metasequoia and pine bark; hinoki, dark and weathered planks; grey roof tiles; stone wall; cobble path | 1K, 2K and 2K–4K |
| `MODELS` | mossy rock sets, boulders, cliff faces, coastal cliffs, sand rocks, ferns, shrubs, moss, wildflowers, nettles, grass clumps, stumps, fallen trunks, roots, branches; wooden lantern, stone fire pit, wooden pier | 2K glTF |
| `LIB_HDRI` | 23 skies: dawn, noon, sunset, overcast, night | 4K `.hdr` |
| `LIB_TEXTURES` | 71 more material sets: brick, plaster, concrete, woods, metals, fabrics, leathers, roofs, tiles, cobblestone, asphalt, rock, ground | 4K + 2K height |
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
- **Size cost.** Base64 costs a third more space than the raw bytes: 4.7 GB of source files become 5.9 GB of scripts.
- **Tiers.** A file's resolution is in its name (`diff_1k.jpg`, `nor_4k.jpg`, `scene_2k.gltf`); the manifest lists every tier of an asset.

## 3. KE.HD API

| Call | Result |
|---|---|
| `KE.HD.ready(base='hd/')` | the manifest, or `null` when the folder is missing or `KE.HD.enabled` is false. Loaded once. |
| `has(id)`, `info(id)`, `find(kind, role)` | lookups; `find('texture','bark')` lists matching ids |
| `mapFile(id, map, size)` | the file for `'diff'`, `'nor'`, `'arm'` or `'disp'`: the smallest tier at least `size` pixels wide, else the largest there is; without `size`, the largest |
| `blob(id, file)` | the file's bytes as a `Blob` (parts reassembled; base64 decoded with `fetch('data:')`, `atob` as a fallback). At most 4 files load at once. |
| `bitmap(id, file, {size, flipY})` | an `ImageBitmap`, decoded off the main thread; `size` resamples to a square (high quality) |
| `texture(THREE, id, map, {size, srgb, repeat})` | a mipmapped, anisotropic `Texture` (rows flipped at decode, `flipY` false: the usual UV convention) |
| `material(THREE, id, {size, repeat, color, normalScale})` | `MeshStandardMaterial` with `map`, `normalMap` and the ARM map as `roughnessMap` + `metalnessMap` (G, B) |
| `aoMaterial(material, geometries)` | adds the ARM map as `aoMap` (R) and copies `uv` to `uv2`, which Three r128 needs for AO |
| `layers(renderer, THREE, ids, map, size)` | one `TEXTURE_2D_ARRAY`, one layer per id, read from the tier that meets `size` and uploaded straight from the decoded images (`texStorage3D` + `texSubImage3D`, mipmapped, anisotropic). It is wrapped in a `DataTexture2DArray` left at version 0, so Three binds the handle as-is and never uploads. `dispose()` deletes the GL texture. |
| `gltf(THREE, id, {tier})` | `{scene, parts: [{geometry (world-transformed), material, name}], dispose}`. Loaded through `GLTFLoader` with every file mapped to a blob URL. |
| `prepare(THREE, id, opts)` | instancing-ready pieces (below) |
| `hdri(renderer, THREE, id, {pmrem, tier=4096})` | `{texture, envMap}`: the equirectangular sky (`RGBELoader`, half float) and a PMREM environment for `scene.environment` |
| `stats` | `{files, bytes, textures, gpuBytes, ms}` |
| `dispose()` | frees everything this module created |

`prepare(THREE, id, {maxTriangles=5000, split=true, wind, textureSize, keep})` returns pieces ready for instancing:

- **Splitting.** With `split`, each mesh becomes its own piece (a rock set gives several rocks). Otherwise the meshes are merged per material.
- **Recentring.** Every piece is recentred on its footprint: x/z centre at 0, base at y = 0.
- **Simplifying.** A piece above `maxTriangles` is simplified with `KE.simplify` (meshoptimizer). Scans often have 50k–770k triangles; the scanned normal map keeps the surface detail on the simplified mesh.
- **Textures.** `textureSize` resamples the textures, which sets the VRAM budget; it also picks the glTF tier (a 4K hero scan when `textureSize` is above 2048 and the pack has one).
- **Foliage.** Blended foliage becomes alpha-tested and double-sided, so instances need no sorting.
- **Wind.** `wind` adds height-based sway (`KE.foliage`).

Each piece is returned as `{geometry, material, triangles, sourceTriangles, size: [x, y, z] metres, name}`, sorted largest first. `keep` limits how many are returned.

## 4. HD terrain layers

```js
const roles = ['grass','grass-leaves','sand','dirt','gravel','rock','rock-high','snow','ash','rock-volcanic','trail','sand-wet'];
const ids = roles.map(r => KE.HD.find('texture', r)[0]);
const L = {};
for (const [k, map, size] of [['albedo','diff',2048],['normal','nor',2048],['arm','arm',1024],['height','disp',1024]])
  L[k] = await KE.HD.layers(renderer, THREE, ids, map, size);
terrain.setLayers({...L, scales: ids.map(id => 1 / KE.HD.info(id).size_m[0]), rockHigh: [y0, y1], dirtToMoss: .75,
  normalStrength: 1, sparkle: 1, masks: (x, z) => [volcanic, trail, 0]});
```

The twelve layers are, in order: grass, grass-leaves, sand, dirt, gravel, rock, rock-high, snow, ash, rock-volcanic, trail, sand-wet.

- **Splitting the biome weights.** The biome map holds grass, sand, rock and snow weights (dirt is the remainder); the HD shader splits these further:
  - grass into moss and leaf litter, by broad noise;
  - dirt into gravel where water flows;
  - rock into mossy and bare, between `rockHigh[0]` and `rockHigh[1]` metres of altitude;
  - sand into dry sand and wet sand in the band just above `waterLevel`;
  - with `dirtToMoss`, a share of the dry dirt becomes moss, in noise patches.
- **Masks.** `masks(x, z)` returns up to three 0–1 values per heightfield sample; with the flow map they fill one RGBA texture (R flow, G–A the masks).
  - The first mask marks volcanic ground: ash replaces grass, dirt and gravel, and lichen-covered volcanic rock replaces rock. Snow stays.
  - The second mask marks trails: packed earth and stones replace every layer except deep snow.
  - The third is unused.
  - Call `setLayers` again with new masks after the terrain changes.
- **Blending.** Layers are height-blended using their height maps.
- **Real-world scale.** Every layer is sampled at its real size (`scales`, tiles per metre). It is also sampled at `farScale` in the distance, to hide tiling.
- **Rock.** Rock, bare rock and volcanic rock are projected triplanar.
- **Normals.** Normals come from the layers' normal maps, whiteout-blended onto the terrain normal (triplanar for rock) and faded with distance.
- **Roughness and AO.** Both come from the ARM maps.
- **Snow.** With `sparkle` above 0, about one snow texel in thirty gets a random facet and near-mirror roughness, so the sun leaves glints that move with the eye.
- **Sand.** Dry sand gets wind ripples about 1.1 m apart in its normal (crests bent by noise, a steeper lee side, faded in the distance and near the water) and is bleached lighter further up the beach.
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
- **Ground:** the 12 photoscanned ground layers, at 4K on Epic and Cinematic, 2K on High and Ultra (ARM half that, height 1K). The volcano's slopes are ash and volcanic rock; the trails are packed earth; the beaches are dry sand with wet sand at the waterline.
- **Bark and wood:**
  - The trees get Japanese bark: cedar, zelkova, trident maple and sakura; the daisugi gets metasequoia.
  - The boats and jetty are hinoki planks, and the yakatabune roofs are grey tiles.
  - The torii's lacquer carries wood grain.
- **Rocks** (`KE.rockCell` in 96 m cells):
  - Clusters of scanned mossy rocks and boulders.
  - Cliff faces and a mountainside scan on steep ground.
  - Coast rocks and scanned sea cliffs at the waterline, sand rocks on the beaches.
  - Boulders along both river banks.
- **Forest floor:** stumps, fallen trunks and roots.
- **Near ground cover:** ferns, moss, celandine, nettles, grass clumps, weeds, branches, bark and pebbles.
- **Props:**
  - Scanned lanterns on the jetty and at the torii; their glass glows at night.
  - A stone fire pit by the spawn, with flames, embers, smoke and a flickering light.
  - Driftwood on the beaches: the scanned fallen trunks, bleached pale.

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

- **Load time.** In the software-rendered test browser (4 threads), the Open World at High opened in about 60–75 s before the tiers and the four new ground layers were added; it now reads the 2K ground tier (116 MB of JPEG for the ground) instead of resampling the 4K files. On a desktop with a GPU, JPEG decoding dominates, and `createImageBitmap` spreads it over the browser's decoder threads. Load time on real hardware was not measured.
- **Download size.** Epic reads the 4K ground (415 MB of JPEG, about 550 MB of scripts) plus the models and bark; High reads 116 MB for the ground.
- **VRAM:**
  - Estimate (`KE.HD.stats.gpuBytes`): about 2.5 GB for the Epic ground arrays (albedo and normal 12 × 4K, ARM 12 × 2K, height 12 × 1K, mipmapped) plus about 1 GB for models and bark.
  - Measured: 535 MB at High, in the test browser.
  - No game should load the whole library at once.
- **Git hosting.** The 5.9 GB folder is committed in several pushes, since GitHub rejects a single push over 2 GB. Rebuilding it with `hd_pack.py` downloads straight from Poly Haven instead.
- **Model scans.**
  - Polycounts are reduced at load time.
  - The simplifier works per mesh, so a scan made of one large connected surface (such as `shrub_01`, three shrubs in one mesh) stays one piece.
- **Colour.** Photoscanned albedo is used as captured; grass-layer colour is only nudged by `grassTint`.
