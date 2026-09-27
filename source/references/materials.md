# Material graphs · 3.0.0

`src/modules/20-materials.js` (module name `materials`) adds node-based materials: a typed graph of nodes is checked and compiled to GLSL, then injected into Three's `MeshStandardMaterial` / `MeshPhysicalMaterial` (lit) or built into a `ShaderMaterial` (unlit). Parameters are uniforms, so editing them never recompiles, and material instances share one GPU program. A fluent builder (`KE.shaderGraph`) and a library of fourteen ready materials (`KE.materialLibrary`) sit on top. There is no visual node editor; graphs are JSON or builder code.

## Contents

1. Quick start
2. Graph format
3. Compiling: `KE.MaterialGraph.compile` and material members
4. Instances, `clone()` and `apply()`
5. Builder: `KE.shaderGraph`
6. Node reference
7. Material outputs
8. How lit materials are patched (and composing with CSM / GI)
9. Shadows, layers and scene-reading nodes: `bind()`
10. Validation and tooling
11. Time
12. Material library: `KE.materialLibrary`
13. Quality and performance
14. Limits

## 1. Quick start

```js
const KE = window.KitsuneEngine, MG = KE.MaterialGraph;
// Builder form
const grass = KE.shaderGraph(THREE, g => ({
  baseColor: g.lerp(g.color('#2d5a27'), g.param('tip', 'color', '#b8d468'), g.noise(g.worldPos().xz.mul(.4), {kind: 'fbm'})),
  roughness: .8
}), {model: 'standard'});
grass.params.tip = '#d0e070';              // live edit, no recompile

// JSON form
const mat = MG.compile(THREE, {
  params: {tint: {type: 'color', value: '#ff5500'}, speed: {type: 'float', value: .2, min: 0, max: 1}},
  nodes: [
    {id: 'pan', type: 'Panner', in: {speed: [.05, 0]}},
    {id: 'n', type: 'Noise', kind: 'voronoi', scale: 6, in: {p: 'pan'}},
    {id: 'glow', type: 'Multiply', in: {a: {type: 'Param', name: 'tint'}, b: 'n.edge'}}
  ],
  outputs: {baseColor: '#202020', roughness: .6, emissive: 'glow'}
}, {model: 'standard', name: 'energy-floor'});

const red = MG.instance(mat, {tint: '#ff0000'});   // same program, own values
MG.bind(mesh, red);                                 // + shadow materials / layer when needed
// once per frame (optional; otherwise shader time follows the wall clock)
MG.update(dt);
```

## 2. Graph format

```js
{
  nodes:   [{id: 'n1', type: 'Noise', kind: 'fbm', octaves: 4, in: {p: 'wp', scale: 2}}, …],
  params:  {tint: {type: 'color', value: '#ffffff', label: 'Tint'}, …},
  outputs: {baseColor: 'n1', roughness: .7}          // or an {type:'Output', in:{…}} node
}
```

**Nodes** have a unique `id` (letters, digits, `_`, `-`), a `type` from the registry, node-specific properties (`kind`, `mask`, `space`, …) and inputs in `in`. An input may also be written as a top-level property of the same name (`{type:'Noise', scale: 4}`).

**Input values** can be:

| Form | Meaning |
|---|---|
| `'nodeId'` | main output of a node |
| `'nodeId.xz'`, `'nodeId.rgb'` | swizzle of the main output (`xyzw` or `rgba`, 1–4 components) |
| `'nodeId.edge'`, `{node:'id', out:'edge'}` | a named output port (e.g. Voronoi `f1`, `f2`, `edge`, `cell`, `angle`, `signed`) |
| `{type:'UV', …}` | an inline node (gets an automatic id) |
| `0.5`, `true` | float literal |
| `[x, y]`, `[x, y, z]`, `[x, y, z, w]` | vector literal (linear values) |
| `'#rrggbb'`, `'#rgb'` | colour literal, **sRGB**, converted to linear |
| `THREE.Color`, `Vector2/3/4` | vector literal as given (linear) |
| `'@uv'`, `'@worldPos'`, `'@worldNormal'`, `'@viewDir'`, `'@time'`, `'@objectPos'`, `'@screenUV'` | built-in inputs (defaults of many nodes) |

**Types** are `float`, `vec2`, `vec3`, `vec4` and `sampler2D` (texture params). Math nodes unify their inputs: floats broadcast to vectors, vectors must have equal size (`vec2 + vec3` is an error). Typed inputs accept a float (broadcast), `vec4 → vec3` (truncation) and `vec3 → vec4` (appends 1); anything else is a type error naming the node and input.

**Params** become uniforms. `type`: `float`, `color` (value `'#hex'`/number are sRGB, arrays/`THREE.Color` linear), `vec2`, `vec3`, `vec4`, `texture` (`value`: a `THREE.Texture` or null; `fallback`: `'white'` (default), `'black'`, `'gray'` or `'normal'` 1×1 texture). `min`, `max`, `label`, `group` are UI hints only (returned in `paramInfo`; values are not clamped). Param names must be GLSL-style identifiers. A node with `texture: <THREE.Texture>` gets a hidden param `tex_<nodeId>`.

**Outputs**: see section 7. Aliases: `color`/`albedo` → `baseColor`, `metalness` → `metallic`, `emissiveColor` → `emissive`, `opacityMask` → `alphaClip`, `wpo` → `worldPositionOffset`, `ambientOcclusion` → `ao`.

Only nodes reachable from connected outputs are compiled; unconnected nodes cost nothing (but `validate()` still type-checks them and reports problems as warnings).

## 3. Compiling

`KE.MaterialGraph.compile(THREE, graph, options) → material`

| Option | Default | |
|---|---|---|
| `model` | `'standard'` | `'standard'` (MeshStandardMaterial), `'physical'` (MeshPhysicalMaterial; needed for clearcoat/sheen), `'unlit'` (ShaderMaterial) |
| `name` | `'ke-material-graph'` | material name |
| `side` | Three default | `'front'`, `'back'`, `'double'` or a Three constant |
| `transparent` | true if `opacity` or `refraction` is connected | |
| `depthWrite` | `!transparent` | |
| `depthTest`, `flatShading` | Three defaults | |
| `blending` | normal | `'normal'`, `'additive'`, `'multiply'`, `'subtractive'`, `'none'` or a Three constant |
| `fog` | `true` | unlit only (lit materials always take scene fog) |
| `normalSpace` | `'tangent'` | how the `normal` output is interpreted: `'tangent'` (UE convention, derivative tangent frame) or `'world'` |
| `alphaClipThreshold` | `.5` | pixels with `alphaClip` below it are discarded (baked into the shader) |
| `toon` | – | `{steps: 3, smoothness: .06}` quantises N·L of every direct light (lit models) |
| `subsurface` | `{wrap:.5, distortion:.25, power:4, scale:1}` | lighting profile used when the `subsurface` output is connected |
| `material` | – | extra properties assigned to the material, e.g. `{envMapIntensity: 1.3}`; colour properties accept any `Color.set` value |
| `warn` | false | log compiler warnings (outputs ignored by the chosen model) |

Throws `KE.MaterialGraph.GraphError` (`node`, `code`, `detail`) on invalid graphs.

Members added to the returned material:

- `params` — object with one accessor per param: read the current value (`THREE.Color`, `Vector*`, number or texture), assign to update the uniform (same conversions as the graph).
- `setParam(name, value)` (chainable), `getParam(name)`, `resetParam(name)` (instances: go back to following the parent).
- `paramInfo` — `[{name, type, min, max, label, group, default}]` for building UIs (hidden texture params excluded).
- `graph` — the source graph object; `glsl` — `{vertex, fragment, key, outputs}` generated code for inspection.
- `clone()` — returns an instance with every parameter copied (independent values, shared program).
- `isMaterialGraph` — `true`.

`material.dispose()` also disposes its shadow materials. Textures passed as params are owned by the caller.

## 4. Instances, `clone()` and `apply()`

`KE.MaterialGraph.instance(material, overrides = {}, {name}) → material` creates a material of the same class with the same compiled code and cache key, so Three reuses the linked GL program (verified by the tests: zero new programs, identical `currentProgram`). Its parameter uniforms read through to the parent until they are set, so edits to the parent's un-overridden params propagate; `resetParam` restores that link. `MG.parentOf(instance)` returns the parent.

`KE.MaterialGraph.apply(THREE, material, graph, options) → material` injects a graph into an existing `MeshStandardMaterial`/`MeshPhysicalMaterial` (model taken from the class). An `onBeforeCompile` hook and `customProgramCacheKey` already set on the material are called first and included in the key.

Three's own `new MeshStandardMaterial().copy(graphMaterial)` does **not** carry the graph; use `clone()` or `instance()`.

## 5. Builder: `KE.shaderGraph`

`KE.shaderGraph(THREE, g => outputs, options) → material` (compile), `KE.shaderGraph.build(g => outputs) → graph` (plain JSON-serialisable graph).

`g` offers:

- one method per node type, named in lower camel case (`g.worldPosition()`, `g.noise(p, props)`, `g.triplanarSample(tex, pos, normal, scale, sharpness, {space})`, `g.parallaxOcclusion(tex, uv, height, {steps, channel})`, `g.depthFade(dist)`, …). Positional arguments fill the node's inputs in the order listed in section 6; a trailing plain object holds properties and/or named inputs. A `THREE.Texture` passed to a texture input becomes the node's `texture`.
- aliases: `worldPos`, `worldNormal`, `viewDir`, `cameraPos`, `objectPos`, `vertexColor`, `screenUV`, `uv`, `time`, `texture` (Texture2D), `triplanar`, `pom`, `lerp`/`mix`, `add`, `sub`, `mul`, `div`, `pow`, `fract`.
- `g.param(name, type, value, {min, max, label, fallback})` (returns the same handle on repeated calls), `g.color(v)`, `g.float(v)`, `g.vec2/vec3/vec4(...components)` (numbers → constant; handles → Append chain), `g.custom(code, outType, {name: [type, value]})`.

Handles support chaining: `add sub mul div pow min max mod dot cross distance append step(edge) lerp/mix(b, t) clamp(lo, hi) smoothstep(e0, e1) remap(inMin, inMax, outMin, outMax) posterize(n) saturate oneMinus abs floor ceil fract sqrt sin cos tan exp log sign normalize length negate desaturate(f) hueShift(s) contrast(c)`, swizzle getters (`.x`, `.xz`, `.rgb`, …, up to four components), `.mask('zyx')` and `.out('edge')` for named ports. Arguments may be handles or literals.

## 6. Node reference

Inputs are listed as `name:type=default` (`any` = unified with the other `any` inputs). **F** marks fragment-only nodes, which cannot feed `worldPositionOffset` (a validation error). All other nodes compile in both stages; in the vertex stage `WorldPosition` is the pre-offset position and `WorldNormal` the vertex normal.

**Constants and inputs**

| Node | Inputs / properties | Output |
|---|---|---|
| Constant | `value` (number, array or colour) | literal type |
| Float, Vec2, Vec3, Vec4 | `value` (number or array) | fixed |
| Color | `value` (`'#hex'` sRGB, array, Color) | vec3 (linear) |
| Param | `name` (declared in `params`) | param type (`sampler2D` for textures) |
| Time | scale:float=1 | float seconds (section 11) |
| UV | tiling:vec2=[1,1], offset:vec2=[0,0]; `channel` 0/1 (uv2) | vec2 |
| WorldPosition, WorldNormal, ViewDirection (surface→camera), CameraPosition, ObjectPosition (instance-aware origin) | – | vec3 |
| VertexColor | – (geometry `color` × `instanceColor`; white when absent) | vec3 |
| ScreenUV **F** | – (from the clip position, no resolution uniform needed) | vec2 |
| PixelDepth | – (linear view depth of this pixel) | float |
| SceneDepth **F** | uv=@screenUV | float: `keSceneDepth` when `keHasScene`=1, else camera far |
| SceneColor **F** | uv=@screenUV, fallback:vec3=[0,0,0] | vec3 HDR scene colour or fallback |
| DepthFade **F** | fadeDistance:float=1 | float: saturate((sceneDepth−pixelDepth)/fade), 1.0 without scene data |
| SunDirection, SunColor | – (`keSunDirection` / `keSunColor` shared uniforms) | vec3 |

**Textures** (texture from the `tex` input, the `param` property or a `texture` property)

| Node | Inputs / properties | Output |
|---|---|---|
| Texture2D | tex, uv=@uv; `space` `'srgb'` (default, decoded to linear) or `'linear'` | vec4 |
| TriplanarSample | tex, position=@worldPos, normal=@worldNormal, scale=1, sharpness=4; `space` | vec4 (3 fetches) |
| TriplanarNormal | tex, position, normal, scale=1, sharpness=4, strength=1 | vec3 world-space normal (whiteout blend) |
| NormalMap | tex, uv=@uv, strength=1; `flipY` | vec3 tangent-space normal |
| ParallaxOcclusion **F** | tex (height, 1 = top), uv=@uv, heightScale=.05; `steps` 16 (4–64), `channel` r/g/b/a | vec2 offset UV |

**Procedural** — `Noise`: p:any=@uv (float, vec2 → 2D; vec3 → 3D), scale=1; `kind` `value` / `perlin` (default) / `simplex` / `voronoi` / `fbm` / `ridged` / `turbulence`; for the fractal kinds `octaves` 5 (1–8), `lacunarity` 2, `gain` .5, `base` perlin/value/simplex. Output float in [0,1]; port `signed` = ×2−1. Voronoi ports: `f1` (default), `f2`, `edge` (F2−F1), `cell` (random per cell), `angle` (2D only: angle of the pixel around its feature point).

**Math** — Add, Subtract, Multiply, Divide, Min, Max, Power(base, exp), Modulo, Atan2(y, x), Step(edge, x), Abs, Floor, Ceil, Frac, Sqrt, Sin, Cos, Tan, Exp, Log, Sign, Normalize, Saturate, OneMinus, Negate, Length → float, Clamp(x, min, max), Lerp(a, b, alpha), Smoothstep(edge0, edge1, x), Remap(x, inMin, inMax, outMin, outMax; `clamp`), Dot → float, Distance → float, Cross (vec3), Reflect(incident, normal), Append(a, b) (component counts add, ≤ 4), Split(x) (use swizzle ports), ComponentMask(x; `mask`), If(a, b, aGreater, equal, aLess, threshold) (UE semantics), Compare(a, b; `op` `>`, `>=`, `<`, `<=`, `==`, `!=` → 0/1 per component), CheapContrast(x, contrast).

**Utility, colour, blending, shading**

| Node | Inputs | Output |
|---|---|---|
| Panner | uv:any=@uv, time=@time, speed:any=[.1,0] | uv + speed·time |
| Rotator | uv=@uv, center=[.5,.5], time=@time, speed=.25, angle=0 | vec2 |
| RotateAboutAxis | axis=[0,1,0], angle (radians), pivot=@objectPos, position=@worldPos | vec3 offset (for WPO) |
| TangentToWorld **F**, WorldToTangent **F** | v | vec3 (derivative tangent frame) |
| BlendNormals | a, b (tangent space) | vec3 (whiteout) |
| HeightLerp | a, b, height=.5, transition=.5, contrast=.5 | mix(a, b, saturate(contrast-expanded height−1+2·transition)) |
| WorldAlignedBlend | sharpness=4, bias=0, normal=@worldNormal, direction=[0,1,0] | saturate(dot(N, dir)·sharpness + bias) |
| Posterize | x, steps=4 | floor(x·steps)/steps |
| Desaturation | color, fraction=1, luminance weights | vec3 |
| HueShift | color, shift (turns) | vec3 (rotation about the grey axis) |
| Fresnel | exponent=5, baseReflectFraction=.04, normal=@worldNormal | float |
| Bump **F** | height (world units), strength=1; `space` `'tangent'` (default) or `'world'` | vec3 normal (surface-gradient from derivatives) |
| Dither **F** | – | float interleaved-gradient threshold, varies with `keFrame` (TAA-friendly) |
| DitherOpacity **F** | opacity=1 | 0/1 mask for `alphaClip` (screen-door transparency) |
| AlphaClip | value=1, threshold=.5 | step(threshold, value) |
| CustomGLSL | inputs declared by `inputs: {name: 'vec3', …}`; `code` (one expression), `out` type | `out` |

**CustomGLSL** code must be a single expression over its declared inputs, numbers, swizzles, operators and the built-ins `sin cos tan asin acos atan pow exp log exp2 log2 sqrt inversesqrt abs sign floor ceil fract mod min max clamp mix step smoothstep length distance dot cross normalize reflect refract faceforward radians degrees float vec2..mat4 bool true false PI`. `#`, `;`, braces, quotes, assignments and any other identifier are rejected. The expression is wrapped in its own uniquely named function. GLSL type mismatches inside the expression are reported by the shader compiler, not by `validate()`.

**Custom nodes**: `KE.MaterialGraph.registerNode(type, {category, inputs: [[name, type, default], …], out: 'vec3' | type(inputTypes, node, ctx), unify: [inputNames], stage: 'any'|'fragment', glsl(ctx, inputs, node, types, outType) → expression})`. Inside `glsl`, `ctx.helper(name, code, deps)` adds a deduplicated function (names must start with `kmg`), `ctx.builtin('worldPos'|'worldNormal'|'uv'|'viewDir'|'time'|'screenUV'|'tbn'|…)` returns `{expr, type}`, `ctx.global(name, type)` binds shared uniforms. `registerHelper(name, code, deps, stage)` adds library-wide helpers. The builder gains a method for new types automatically.

## 7. Material outputs

| Output | Type | Models | Effect |
|---|---|---|---|
| baseColor | vec3 | all | diffuse albedo (lit); colour when `emissive` is absent (unlit) |
| metallic, roughness | float | lit | replace `metalness`/`roughness` factors |
| normal | vec3 | lit | tangent-space (default) or world-space (`normalSpace:'world'`) shading normal |
| emissive | vec3 | all | emitted radiance (HDR values welcome with bloom); unlit colour |
| opacity | float | all | alpha (sets `transparent` unless overridden) |
| alphaClip | float | all | discard below `alphaClipThreshold`; also applied in shadow passes via `bind()` |
| ao | float | lit | multiplies indirect diffuse; indirect specular gets Three's specular occlusion |
| worldPositionOffset | vec3 | all | world-space vertex offset, compiled into the vertex stage (instancing and skinning aware); also applied in shadow passes |
| subsurface | vec3 | lit | subsurface/translucency colour (section 8) |
| clearcoat, clearcoatRoughness, sheen | float, float, vec3 | physical | Three's clear coat and sheen terms |
| refraction | float | all | screen-space refraction strength using the pipeline's scene copy (section 9) |

## 8. How lit materials are patched

The generated code is inserted through `onBeforeCompile` at Three's include points, which stay in the source so later hooks still find them:

- vertex: declarations after `#include <common>`; before `#include <project_vertex>` the world position/normal (with `instanceMatrix`), the WPO subgraph, `transformed += inverse(mat3(model·instance))·offset` (a cofactor inverse written in GLSL ES 1.0) and the varyings; the clip position after it when screen UVs are used. Because `transformed` itself moves, `worldpos_vertex`, shadow coordinates, fog and GI all see the displaced position.
- fragment: the graph body before `#include <map_fragment>`, then `baseColor`/`opacity`/`alphaClip` after `color_fragment`, metallic/roughness after their map chunks, normal after `normal_fragment_maps`, emissive after `emissivemap_fragment`, clear coat/sheen after `lights_physical_fragment`, AO after `aomap_fragment`, refraction after the `gl_FragColor = vec4( outgoingLight, diffuseColor.a )` line.
- `subsurface` and `toon` patch `RE_Direct_Physical` inside `lights_physical_pars_fragment` (regex-matched, a clear error is thrown if a future Three build changes it). Every punctual light — directional, point, spot, and the cascaded-shadow variant, which calls `RE_Direct` — therefore gets them with its shadowed colour. Subsurface adds wrap diffuse `max((N·L+w)/(1+w),0) − max(N·L,0)` and a view-dependent back-scatter term `pow(saturate(V·−normalize(L+N·distortion)), power)·scale`, both tinted by the output colour. Toon quantises N·L into `steps` bands with `smoothness`-wide edges; image-based light stays smooth.

The program cache key is `kmg-` + a hash of the generated GLSL and options — graph structure only, never parameter values. Hooks installed later chain onto it: `KE.CascadedShadows.setupMaterial` and `KE.ProbeVolume.setupMaterial` wrap the graph hook and append their keys (the tests check that one program contains the graph, CSM and GI code). WebGL1: Standard/Physical programs already enable `GL_OES_standard_derivatives`; unlit and shadow materials set `extensions.derivatives`.

Unlit materials are `ShaderMaterial`s assembled from Three chunks (skinning, morph targets, instancing, fog, clipping planes, log depth, tone mapping, output encoding). As everywhere in r128, set `material.skinning = true` / `morphTargets = true` for skinned or morphed meshes; `bind()` copies these flags to the shadow materials.

## 9. Shadows, layers and scene-reading nodes: `bind()`

`KE.MaterialGraph.bind(mesh, material = mesh.material, {translucentLayer: true}) → mesh`

- assigns the material;
- when the graph has `worldPositionOffset` or `alphaClip`, sets `mesh.customDepthMaterial` / `customDistanceMaterial` to depth/distance materials compiled from the same graph (only those outputs), sharing the material's parameter uniforms — dissolving objects cast dissolving shadows, swaying foliage casts swaying shadows. `MG.shadowMaterials(material)` returns them (`{depth, distance}` or null).
- when the material reads scene colour or depth (`refraction`, `SceneColor`, `SceneDepth`, `DepthFade`), moves the mesh to `KE.LAYERS.TRANSLUCENT` so `KE.Pipeline` draws it after copying the opaque scene. Cameras must enable that layer (`KE.prepareCamera(camera)`, part of the standard frame setup), otherwise the mesh is invisible. `MG.readsScene(material)` reports this.

**Refraction**: with the pipeline (`keHasScene` = 1) the lit result becomes `(diffuse+emissive)·a + specular + sceneColor(uv − N.xy·refraction·0.05)·baseColor·(1−a)`; samples whose scene depth is in front of the surface fall back to the unrefracted UV. Without the pipeline the material alpha-blends with `alpha = saturate(opacity + luminance(specular))` and premultiplied colour, so reflections stay visible.

## 10. Validation and tooling

- `validate(graph, {model}) → {ok, errors: [{node, code, message}], warnings, types: {nodeId: type}}` — reports unknown node types/params/references, cycles (anywhere in the graph), type errors per output, stage errors, model/output mismatches and CustomGLSL violations. Errors in unconnected nodes are warnings. Error codes: `graph`, `type`, `ref`, `cycle`, `stage`, `input`, `param`, `output`, `custom`, `value`, `model`.
- `generate(graph, options) → {vertexDeclarations, vertexMain, fragmentDeclarations, fragmentMain, key, outputs, worldPositionOffset, warnings}` — GLSL without creating a material.
- `cacheKey(graph, options)`; `nodeTypes` (registry), `outputs`, `helpers`, `stats` (`compiles` = graphs compiled in JS, `patches` = `onBeforeCompile` runs), `isGraphMaterial(m)`, `textures(THREE)` (1×1 fallback textures), `disposeShared(THREE)`.

Identifiers: generated locals are `kmgf<N>`/`kmgv<N>`, outputs `kmgO_<name>`, params `kmgP<i>_<name>`, varyings `vKmg*`, helpers `kmg*`, shared scene uniforms are re-bound under `kmg*` names so they never collide with other modules' declarations.

## 11. Time

`Time`, `Panner` and `Rotator` read one shared uniform (`MG.time`). By default it is wall-clock seconds since the module loaded. `MG.update(dt)` or `MG.setTime(t)` switch to a manual clock (pause, slow motion, deterministic tests); `MG.useWallClock()` switches back.

## 12. Material library: `KE.materialLibrary`

```js
const lib = KE.materialLibrary(THREE, {size: 256});   // cached per THREE; size only applies to the first call
const rock = lib.mossyRock({mossAmount: .7});        // lib.<name>(params, compileOptions)
const blue = lib.create('carPaint', {paintColor: '#0b3a9a'});
lib.names; lib.graph('lava');                        // plain graph for inspection or editing
lib.dispose();                                       // frees the generated textures
```

Textures are generated once on the CPU (tileable value/Worley noise): a layered rock set and a cobblestone set, each with sRGB albedo, a tangent-space normal map and ORM-H (R occlusion, G roughness, B height). Size defaults to `KE.settings.tex` clamped to 128–512; generation cost grows with size².

| Material | Model / setup | Technique | Main params |
|---|---|---|---|
| pbrTriplanar | standard, world normals | triplanar albedo + ORM + whiteout normal map | scale .55, sharpness 6, tint, roughness 1, metallic 0, normalStrength 1, albedoMap/ormMap/normalMap |
| parallaxStone | standard | POM on the cobble height, albedo/ORM/normal at the offset UV (needs UVs) | tiling 1, heightScale .06, tint, normalStrength 1.2 |
| mossyRock | standard + subsurface | rock + up-facing, noise-broken, height-blended moss with fuzz bump | rock params, mossAmount .55, mossColor, mossTipColor |
| snowCovered | standard + subsurface | rock + WorldAlignedBlend snow in crevices first, micro bump, view-dependent sparkle | rock params, coverage .5, snowColor |
| carPaint | physical | fresnel colour flip, Voronoi metallic flakes with per-flake normals, clear coat | paintColor, flipColor, flakeScale 95, flakeStrength .5, metallic .6, roughness .34, clearcoat 1, clearcoatRoughness .03 |
| glass | physical, transparent | fresnel opacity, screen-space refraction with the pipeline | tint, roughness .03, opacity .12, refraction .6 |
| hologram | unlit, additive, double-sided | fresnel rim, moving scan bands, fine lines, flicker, WPO glitch bands | color, intensity 2.2, scanDensity 9 |
| dissolve | standard, alpha clip | fBm threshold with charred band and HDR edge glow (shadows follow via `bind`) | amount .45, edgeWidth .06, edgeColor, edgeIntensity 12, baseColor |
| forceField | unlit, additive, double-sided | fresnel + Voronoi cell lines + pulse + DepthFade intersection glow | color, intensity 1.8, cellScale 7, intersection .35 |
| lava | standard + WPO | drifting fBm, Voronoi crust cracks and pools, black-body-like emissive ramp, bump, surface heave | cellScale 5.5, glow 5, bubble .04 |
| waterPuddle | standard | noise puddles on flat areas, wet darkening, mirror roughness, animated ripple rings as bump | wetness .5, rippleScale 5 |
| toon | standard, `toon` 3 bands | stepped direct light, fresnel rim light and ink edge | color, rimColor |
| foliageSSS | standard, double-sided, alpha clip, WPO | two layers of randomly oriented elliptical Voronoi leaves, translucency, wind sway | leafTiling [12,6], colorA, colorB, translucency, wind 1 |
| stylizedGrass | standard, double-sided, world normals, WPO | root→tip gradient on UV.y, world-space colour patches, bent normals, gust + sway wind ∝ height² | rootColor, tipColor, wind .22 |

Materials that use UVs expect them (parallaxStone, foliageSSS, stylizedGrass — grass blades should have `uv.y` 0 at the root, 1 at the tip). Call `MG.bind(mesh)` for materials with WPO, alpha clip or scene reads.

## 13. Quality and performance

- Parameter edits are uniform uploads only. Instances and repeated compiles of the same structure share one GL program; `onBeforeCompile` string patching runs once per material.
- Fragment cost is dominated by noise and texture fetches: 3D Perlin = 8 hashed gradients, fBm = octaves × base noise, 3D Voronoi = 27 cells, triplanar = 3 fetches per sample (pbrTriplanar: 9), POM = steps + 1 fetches. Prefer 2D noise, fewer octaves or baked textures on mobile. No timings are claimed; measure with `KE.GPUTimer`.
- Quality settings used: `KE.settings.tex` sets the library texture size; `KE.settings.preset` sets parallaxStone's POM steps (low 8, medium 12, high 16, ultra 24, cinematic 32) when the material is created.
- No per-frame allocations: time is a getter on a shared uniform, instance uniforms are read through getters.

## 14. Limits

- Graphs are authored as JSON or builder code; there is no visual editor or graph serialisation inside `material.toJSON()` (keep `material.graph`).
- Tangent frames come from screen-space derivatives of world position and UV; mesh tangents are ignored, meshes without UVs get an arbitrary frame, and derivative frames are per-triangle on low-poly geometry.
- WPO does not recompute normals and does not enlarge bounding volumes; for large offsets enlarge `geometry.boundingSphere` or disable frustum culling.
- Refraction is a screen-space offset of the opaque scene copy (no ray tracing, nothing off-screen, no total internal reflection); SceneColor/SceneDepth/DepthFade need `KE.Pipeline` and the translucent layer and otherwise return their fallbacks.
- Subsurface is wrap lighting plus a back-scatter lobe per light, not a diffusion profile; there is no thickness input. Toon shading affects direct light only.
- Voronoi `edge` (F2−F1) approximates the distance to the cell border. Noise is hash-based and may show precision artefacts at very large world coordinates (offset inputs by the object position for local patterns).
- Instances inherit parameters live, but not later structural changes: a graph change needs a new compile.
- Verified on WebGL2 only (headless Chromium/SwiftShader). The generated code avoids GLSL 3-only features and requests the derivatives extension, but WebGL1 has not been tested.
