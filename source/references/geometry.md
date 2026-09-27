# Geometry · module 30 (`geometry`)

Mesh simplification, discrete LOD, instanced LOD with impostors, and a Nanite-inspired virtualized-geometry path for Three.js r128 / WebGL2. Everything runs CPU-side: LOD selection and cluster cuts happen in JavaScript and are drawn with ordinary Three.js meshes. There is no GPU culling, no occlusion culling, no streaming, and no software rasterizer.

## Contents

1. Backend and readiness
2. Simplification and LOD chains
3. Screen-space error
4. `KE.LODMesh`
5. `KE.InstancedLOD`
6. `KE.Impostor`
7. `KE.VirtualGeometry` (cluster DAG)
8. `KE.proceduralRock`, `KE.meshStats`
9. Quality settings, costs and limitations

## 1. Backend and readiness

```js
const KE = window.KitsuneEngine;
const info = await KE.geometryReady(); // {simplifier, clusterizer, backend:'meshoptimizer'|'js'}
```

The module uses the vendored `MeshoptSimplifier` and `MeshoptClusterizer` (meshoptimizer 0.22 wasm, from `assets/kitsune-libs.js`) once their `.ready` promises resolve. `KE.geometryReady()` awaits both. If you do not await it, each call uses whatever is ready at that moment. When the libraries are missing or fail, every entry point falls back to pure JavaScript (see section 9 for how the fallback differs). `KE.geometryBackend()` returns the current flags synchronously. Any function that takes options also accepts `backend:'js'` to force the fallback.

## 2. Simplification and LOD chains

```js
const low = KE.simplify(THREE, geometry, {ratio: .25, targetError: .01});
low.userData; // {simplifyError, simplifyErrorRelative, ratio, backend}

const lods = KE.buildLODs(THREE, geometry, {levels: [1, .5, .25, .1, .04]});
// [{geometry, ratio, error, triangles, generated}], lods.backend
```

`KE.simplify(THREE, geometry, options)` returns a new indexed `BufferGeometry`. It keeps every source attribute: kept vertices are original vertices, so normals, uvs and colours are copied exactly. Nothing is interpolated. Groups are simplified separately and then restored. Non-indexed input is welded first: vertices whose attributes are all bit-identical become one vertex. The source is not modified.

| option | default | meaning |
|---|---|---|
| `ratio` | `.5` | target triangle fraction |
| `targetError` | `.01` | error limit, relative to the mesh extent (absolute when `errorAbsolute:true`). Simplification stops at whichever limit it reaches first. Pass `Infinity` to be driven by `ratio` alone |
| `lockBorder` | `false` | keep open-border vertices fixed (for tiles that must match their neighbours) |
| `attributes` | `true` | attribute-aware quadrics (meshopt experimental `simplifyWithAttributes`) |
| `normalWeight`, `colorWeight`, `uvWeight` | `.5`, `.5`, `0` | attribute weights. Seams are already preserved without a uv weight |
| `backend` | auto | `'js'` forces the fallback |

`userData.simplifyError` is the error that meshoptimizer reports, in mesh units. With `attributes:true` it includes the weighted attribute error, so it is conservative: on the 104k-triangle test rock, the error at 50% is 4.1e-3, against 1.9e-3 for positions only.

`KE.buildLODs(THREE, geometry, {levels, targetError=Infinity, …simplify options})` simplifies each level from the source rather than from the previous level. It then makes the errors monotonic and drops any level that does not remove at least 10% of the triangles. Level `1` is the source geometry itself (`generated:false`).

## 3. Screen-space error

`KE.screenError(errorWorld, distance, camera, viewportHeight)` returns `error × viewportHeight / (2 × distance × tan(fov/2)) × KE.settings.lod`. For orthographic cameras it returns `error × viewportHeight × zoom / (top − bottom) × lod` instead. All selectors use this model. Distance is measured to the nearest point of a bounding sphere: `|center − camera| − radius`, clamped to `camera.near`. `KE.settings.lod` (cvar `r.LODBias`, 0.25–2) scales every projected error. Higher values keep more detail.

Viewport height: every class has `.viewportHeight`. It defaults to `KE.geometryViewportHeight` (720) and is updated by any `update(camera, viewportHeight)` call. Pass the drawing-buffer height, e.g. `renderer.getDrawingBufferSize(v).y`.

Automatic updates: `LODMesh`, `VirtualGeometry` and `InstancedLOD.object` set `isLOD = true`, so the r128 renderer calls `update(camera)` while projecting the scene. That happens before the shadow pass, so shadows use the same frame's selection. Set `autoUpdate = false` to drive `update(camera, h)` yourself. Updates compare camera, projection and object state, and return `false` without work when nothing changed.

## 4. `KE.LODMesh`

```js
const rock = new KE.LODMesh(THREE, geometryOrLods, material, {pixelError: 1.5, hysteresis: .1, castShadow: true, crossfade: .25});
scene.add(rock); // auto-updates; or rock.update(camera, viewportHeight)
rock.level; rock.stats(); // {level, levels, triangles, fullTriangles, error, fading}
```

This is an `Object3D` with one child `Mesh` per level. Only one is visible, or two while crossfading. If you pass a geometry, `buildLODs` runs using `levels` and `targetError`. The object picks the coarsest level whose error projects at or below `pixelError`. Hysteresis keeps the current level while the view stays inside the band between the thresholds with and without the `(1 + hysteresis)` margin.

| option | default | |
|---|---|---|
| `levels` | `[1,.5,.25,.1,.04]` | used when a geometry is given |
| `pixelError` | `1.5` | pixels |
| `hysteresis` | `.1` | relative band |
| `crossfade` | `0` | seconds. When above 0, each level gets a clone of the material, patched with a complementary screen-door dither, and both levels draw during the fade. Costs one extra draw during fades. Not available for material arrays |
| `castShadow`, `receiveShadow` | `false` | |
| `shadowLodBias` | `1` | shadows use `level + bias` through a shadow-only proxy (see section 9) |
| `customDepthMaterial` | — | forwarded to the shadow proxy (e.g. for alpha-tested materials) |
| `debugColors` | `false` | tints each level (materials with `.color`); disables `crossfade` |

`forcedLevel` (−1 = automatic) pins a level. `clone()` shares the LOD geometries. `dispose()` frees generated geometries and cloned materials. The caller's material and the source geometry are left alone.

## 5. `KE.InstancedLOD`

```js
const field = new KE.InstancedLOD(THREE, geometryOrLods, material, {count: 5000, pixelError: 1.5, castShadow: true, shadowDistance: 40});
for (let i = 0; i < 5000; i++) field.setMatrixAt(i, matrix);
field.setColorAt(7, color); field.setVisibleAt(9, false); field.count = 4000;
field.bakeImpostor(renderer, {size: 1024, frames: 8});          // optional far representation
scene.add(field.object);                                         // auto-updates each render
field.stats(); // {capacity, count, visible, culled, levels:[…], impostors, triangles, fullDetailTriangles, drawCalls, shadowCasters, shadowTriangles}
```

It keeps one `InstancedMesh` per level, plus an optional impostor mesh, all sized to `count` capacity. `update()` makes one pass over the instances with no allocations. For each instance it:

1. checks the visibility flag;
2. tests the bounding sphere (transformed and scaled) against the frustum in object space;
3. culls by `maxDistance`;
4. picks a level with the hysteresis band;
5. copies the 16 matrix floats (and the colour) into that level's buffer.

Only the used range of each buffer is uploaded (`updateRange`). Levels with no instances are hidden, so they cost no draw call. When nothing changed, the pass is skipped.

With an impostor attached, an instance switches to the impostor when it is already at the coarsest mesh level and its projected diameter falls below `impostorPixels`. The default is half an atlas frame, e.g. 64 px for a 1024 atlas with 8×8 frames. `setImpostor(impostor, {pixels})` attaches an impostor you baked yourself.

Shadows (`castShadow`): the view meshes do not cast. Separate shadow-only instanced meshes do. They hold every instance within `shadowDistance` (default 80, world units), including instances outside the view frustum, so off-screen casters still cast. They use level `min(viewLevel + shadowLodBias, last)`. Impostors do not cast shadows here; their casters use the coarsest mesh level.

Options: `count` (capacity, required), `levels`, `pixelError=1.5`, `hysteresis=.1`, `maxDistance=Infinity`, `frustumCull=true`, `castShadow=false`, `receiveShadow=false`, `shadowDistance=80`, `shadowLodBias=1`, `impostor`, `impostorPixels`, `debugColors`.

In the test (SwiftShader, 5,000 random rocks of 1,620 triangles, camera inside the field): the pass takes about 1.2–4 ms per update. It culled 3,849 instances and rendered 106,894 triangles, 38,570 with impostors, against 8,100,000 for plain full-detail instancing of the same instances. These are work counts, not frame-rate claims.

## 6. `KE.Impostor`

```js
const imp = KE.Impostor.bake(THREE, renderer, object3D, {size: 1024, frames: 8, mode: 'octahedral', lit: true});
const m = imp.createMesh();                 // or imp.createInstancedMesh(n)
imp.texture; imp.normalTexture; imp.material; imp.depthMaterial; imp.geometry; imp.radius; imp.center; imp.coverage(renderer); imp.dispose();
```

The bake runs in the object's local space: the object is detached, its transform reset, and both restored afterwards. For each frame it renders with an orthographic camera into a shared atlas render target, which has mipmaps.

- `mode:'octahedral'` gives a `frames × frames` grid over the upper hemisphere (hemi-octahedral, the default for ground objects) or the whole sphere (`hemisphere:false`).
- `mode:'billboard'` gives `frames` views around the vertical axis, drawn as a cylindrical billboard.

`lit:true` (default) bakes base colour plus alpha (sRGB) and object-space normals. The runtime material is a patched `MeshStandardMaterial` (`roughness=.85`, `metalness=0`), so it is lit by scene lights and fog like any mesh. `lit:false` bakes colours under a neutral hemisphere-plus-directional rig and shows them unlit.

At runtime the vertex shader builds a camera-facing quad around the bounding sphere. It picks the 3 grid frames around the view direction (2 for billboards) and projects the quad onto each frame's image plane. The fragment shader blends the three samples by barycentric weight, divides by alpha to remove fringes, and alpha-tests at 0.5. The shaders support `InstancedMesh`, because they use per-instance view directions and normal matrices. `depthMaterial` (set as `customDepthMaterial` by `createMesh` and `createInstancedMesh`) makes impostors cast billboard shadows.

Measured in the test: at 24 m the impostor's silhouette overlapped the real mesh's at 0.96 IoU. Side-by-side shading from three views matched closely.

Limits:
- There is no depth-based parallax correction, so frame blending softens detail at close range.
- There is no colour dilation into transparent texels.
- Normal maps and emissive are not baked.
- Point-light shadows (distance material) are not patched.
- WebGL2 is required (it uses `transpose`).

## 7. `KE.VirtualGeometry` (cluster DAG)

```js
const dag = KE.VirtualGeometry.build(THREE, geometry, {clusterTriangles: 128});  // share between objects
const vg = new KE.VirtualGeometry(THREE, dag /* or a geometry */, material, {pixelError: 1, castShadow: true});
scene.add(vg);                         // auto-updates; or vg.update(camera, viewportHeight)
vg.stats(); // {clusters, groups, levels, sourceTriangles, selectedClusters, triangles, culledClusters, clustersPerLevel, rebuilds, shadowTriangles, buildMs, backend, renderVertices, levelTriangles}
vg.setDebugColors('cluster' | 'group' | 'level' | false);
```

**Build.** This follows meshoptimizer's `clusterlod.h` and Karis' Nanite notes.

1. The mesh is split into meshlets of at most `clusterTriangles` triangles (meshopt `buildMeshlets`).
2. Each level partitions the current clusters into groups of about `groupSize` (8). Seeds are taken in Morton order, and each group grows greedily toward the unassigned neighbour that shares the most welded vertices. Tiny leftover groups are merged into their best-connected neighbour.
3. Every vertex shared by two groups of the level is locked. That includes all attribute-seam copies of the position.
4. Each group is merged and simplified to 50% with those locks (meshopt `simplifyWithAttributes`, absolute error, normals weighted by `normalWeight=.1`).
5. The result is re-clustered.
6. A group whose result keeps more than 85% of its triangles is terminal (error = ∞).
7. Group bounds are a sphere that encloses the child clusters' bounds, and the group error is `max(child errors, simplification error)`. Both are therefore monotonic up the DAG.
8. Levels continue until one cluster remains or no group makes progress.

The 103,680-triangle test rock builds 11 levels (103,680 → 51,840 → … → 100 triangles), 1,654 clusters and 207 groups. That takes about 0.6 s in headless Chromium.

**Runtime cut.** Every group's projected error is computed once per update. A cluster is drawn when its own group's error projects above the threshold and either it is original geometry or the group it was simplified from projects at or below the threshold. This is the per-cluster clusterlod rule. It needs no traversal and is consistent because errors and bounds are monotonic. Selected clusters are then frustum-culled with their own tight spheres. Their index slices are copied into one dynamic 32-bit index buffer and drawn as one mesh (one draw call). The buffer is uploaded (`updateRange`) only when the selection changes.

Each cluster owns a private vertex range, so duplicated border vertices keep bit-identical positions. Any cut produced by the rule is therefore watertight.

The test verifies the cut in two ways:
- **Edge balance:** every welded edge is used equally often in each direction, at eight distances.
- **Pixel check:** a double-sided render with red back faces on black, compared against the full-detail mesh, shows no cracks at mixed-level cuts (levels 1–3, 3–4, 6–7). A deliberately naive per-cluster level mix used as a control shows 4,139 red pixels.

Shadows (`castShadow:true`) come from a second index buffer drawn with a shadow-only material. It is cut at `shadowPixelError` (default 4× `pixelError`) without frustum culling, so off-screen parts still cast. It is re-uploaded only when the camera position or the threshold changes.

| option | default | |
|---|---|---|
| `clusterTriangles` | `128` | 16–256, multiple of 4 |
| `groupSize` | `8` | clusters per group |
| `levels` | `'auto'` | maximum DAG depth (≤ 24) |
| `normalWeight` | `.1` | attribute weight during group simplification |
| `lockBorder` | `false` | also lock open mesh borders (tiles/terrain patches that must match neighbours) |
| `pixelError` | `r.Geometry.PixelError` cvar (1) | |
| `shadowPixelError` | `4 × pixelError` | |
| `frustumCull` | `true` | cluster culling |
| `castShadow`, `receiveShadow` | `false` | |
| `debugColors` | `false` | `true`/`'cluster'`, `'group'`, `'level'` |
| `backend` | auto | `'js'` forces the fallback builder |

Memory: render vertices are about 2.7× the source vertex count (142k for the 52k-vertex rock), because each cluster duplicates its border vertices and all levels are kept. Each object also owns an index buffer the size of level 0 (4 bytes per index), plus a second one when it casts shadows. `KE.VirtualGeometry.build` shares vertex buffers between objects. The shared DAG's GPU buffers are freed when the last object using it is disposed. The CPU data stays valid, and a later object re-uploads it.

`debugCut(predicate)` forces an arbitrary cut and freezes updates. It is for tests and tools; set `freeze=false` to resume. Only a single material is supported: geometry groups are merged.

## 8. `KE.proceduralRock`, `KE.meshStats`

`KE.proceduralRock(THREE, {detail=6, seed=1, radius=1, roughness=.35, facets=7, flatten=.3, color, moss, uv=true, colors=true, frequency})` builds a closed geodesic rock. The icosahedron frequency is `n = round(1.125 × 2^detail)`, giving `20 n²` triangles and `10 n² + 2` shared vertices: detail 6 has 103,680 triangles, 5 has 25,920, 4 has 6,480 and 3 has 1,620. The shape comes from seeded ridged fbm displacement, random planar cuts that make flat cliff faces, and a flattened base. The geometry has smooth normals, a seam-free planar uv and cavity/moss vertex colours (linear).

`KE.meshStats(object3D)` walks visible objects and returns `{objects, meshes, instancedMeshes, instances, drawCalls, triangles, vertices, shadowProxyDraws}`. Triangles respect draw ranges and instance counts. Shadow-only proxies are counted separately and not included in `triangles`.

## 9. Quality settings, costs and limitations

- `KE.settings.lod` scales all projected errors: low .6, medium .8, high 1, ultra 1.25, cinematic 1.5. On the low preset, objects therefore switch to coarser levels at about 60% of the high-preset distance. `r.Geometry.PixelError` sets the default for new `VirtualGeometry` objects.
- Per-frame CPU cost:
  - `LODMesh`: O(levels).
  - `InstancedLOD`: O(instances), with a copy of 16 floats per visible instance.
  - `VirtualGeometry`: O(groups + clusters), plus a copy of the selected index slices when the cut changes.
- GPU upload cost: `InstancedLOD` uploads only the used buffer ranges. `VirtualGeometry` re-uploads the selected indices (4 bytes each) only on change. Camera rotation changes the frustum cut, so it triggers uploads.
- Shadow-only proxies: these meshes draw nothing in the main pass. Their vertex shader writes positions outside clip space and the material has depth and colour writes off. The shadow pass renders them with Three's depth materials. Each proxy still costs one main-pass draw call and a trivial vertex shader per vertex. They are worthwhile when shadow cascades would otherwise render full-detail geometry.
- JS fallback:
  - Simplification uses vertex clustering: each cell collapses to its original vertex nearest the cell mean, and the grid resolution is binary-searched to meet the ratio or error target. It is roughly 3–5× the meshopt error at the same ratio, and attribute seams are not preserved.
  - Clusterization uses breadth-first growth over vertex-adjacent triangles.
  - The fallback DAG is valid and crack-free, but its errors are larger, so it keeps more detail at a given pixel error.
- Not implemented:
  - GPU-driven culling or occlusion culling (Hi-Z).
  - Streaming or paging of cluster data.
  - Cone (back-face) culling of clusters.
  - Per-cluster materials.
  - Skinned or morphing geometry in `VirtualGeometry`, `LODMesh` and `InstancedLOD` (use static meshes).
  - Crossfade for `InstancedLOD`.
  - Parallax-corrected impostors.
  - The error metric is meshoptimizer's quadric error, not a measured image-space error.

Demo: `examples/src/geometry-demo.html` (build with `python3 scripts/build.py`) shows 14 VirtualGeometry rocks sharing one DAG and a 4,000-instance InstancedLOD field with impostors. It has a pixel-error slider, shaded/cluster/group/DAG-level views, and live triangle and draw statistics. Tests: `node scripts/test_geometry.cjs`. Screenshots are written to `.test-output/geometry-*.png`.
