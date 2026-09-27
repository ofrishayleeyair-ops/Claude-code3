# Visual edition 2.1: Verdant

Use this edition for visibly richer outdoor scenes. Keep the reusable rendering APIs in the engine and scene composition in the starter.

## Art resources

`assets/surface-atlas.png` is a generated 1254×1254 color atlas. It is also embedded as a data URL in the runtime so the offline HTML needs no separate image request. The four quadrants contain moss/grass/clover, sandy limestone, striated lichen-covered rock, and irregular stone paving. The art brief was a top-down, evenly lit, seamless-style 2×2 natural surface atlas with no labels or borders. These are generated color surfaces, not scanned PBR assets. Mirrored repetition reduces edge discontinuities; it cannot remove recognizable repeated patterns.

Call `await KE.loadVisualAssets()` before creating textures. Rebuild the texture set after replacing the atlas. Retain the original PNG when redistributing source so the art can be edited. Replace the embedded data URL as well when changing the PNG. Procedural wood, bark, roof, leaf, plaster, lacquer and fur fill out the material palette. Terrain relief is derived from texture luminance and should be tuned conservatively.

## Scene choices

The starter adds branching trunks, layered canopies, cutout leaf sprays, fern fronds, flower patches, shoreline rocks, stepping stones, stone lanterns and a curved shrine roof with ridge and tile geometry. A rounded fox has textured fur, inner ears, eyes, whiskers, paws, moving leg groups and a curved tail. Instancing shares repeated vegetation; static batching groups architecture by material and spatial cell.

The initial daylight, closer camera and restrained bloom are chosen to expose those surfaces. Standard materials use a procedural environment cubemap. High and Ultra enable depth occlusion; supported devices use half-float HDR bloom and filmic output. The water samples terrain height for approximate shallow tint and shoreline foam.

## Quality and verification

Prefer 512px material tiles on desktop and 128px for Low. Higher texture settings require recreating materials; live presets adjust render scale, shadows, grass and post effects. Even Low retains the new architecture and vegetation, so profile geometry separately when targeting limited devices.

Run `test_core.cjs`, `test_build.py`, `test_resources.cjs`, `test_visuals.cjs` and `test_demo.cjs` after edits. The last three require `@napi-rs/canvas` and use actual Three.js r128 objects. The demo test replaces the renderer and DOM with CPU stubs; it cannot assess visual output, browser usability or frame rate. Use the optional real-browser test for those integration checks and inspect screenshots directly.

Treat the package as a custom browser runtime. It does not implement a UE5 editor, Nanite geometry, Lumen global illumination, hardware ray tracing, asset streaming or a general rigid-body solver. No measured UE5 equivalence or speedup is claimed. Refer to the rendering API for exact scope rather than extending feature names beyond their implementation.
