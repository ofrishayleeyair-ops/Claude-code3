# Integration and migration

## Edition mapping

The supplied upload called itself Kitsune Engine while reporting internal version 3.3. The requested new product name is **kitsune enginev2**, runtime version **2.1.0**, visual edition **Verdant**. The bundled Three.js remains r128. `KE.legacyVersion` records `3.3`. Do not compare the version strings numerically across these product lines.

## Upgrade an existing game

1. Keep a source copy of the original game. Replace the inlined engine through the source template/build script, not by pasting over an arbitrary minified script block.
2. Keep `window.KitsuneEngine` and existing rendering helper calls. The usual settings API remains available. Version 2.1 replaces the default splat material with standard shading; use `KE.legacyRendering` for the original look and read the rendering reference before changing the color pipeline.
3. Replace independent ground interpolation with the terrain array's `.heightAt`. The legacy `.5` grid offset is retained.
4. Keep references to `KE.settings`: v2 now mutates that object when applying a preset instead of replacing it. Unknown preset names throw RangeError. Saved settings are sanitized.
5. Re-tune physics deliberately. Default bounce is now zero rather than .5. Bodies gain grounded, height, mass, static, sensor, layer, mask, and generated IDs. Static/vertical separation and coincident actors now have defined handling. Replace manually cloned body objects with fresh `Physics.body` calls.
6. Adopt `KE.Loop` if the old game has frame-dependent movement. It is additive, not mandatory for old render-only games.
7. Adopt `KE.Input` and `FollowCamera` as a pair for camera-relative movement. Remove the old keyboard/pointer listeners to prevent doubled input.
8. Dispose old post/grass resources before recreation. Do not dispose textures still shared by other objects. Reload/rebuild for texture detail, terrain subdivision, and direct-render antialiasing changes.
9. Validate save data before restoring. Existing games may keep their own schema and namespace; the new SaveStore does not silently import other games' data.
10. Re-test the actual game loop. API compatibility does not guarantee identical physics feel or identical shading.

## Build contract

Run Python 3 with two paths:

```sh
python3 scripts/build.py assets/starter.html spirit-isle.html
```

Both placeholders must occur exactly once, THREE first. Source and output paths must differ when using the CLI. The builder resolves engine assets relative to its own script, so it works from another current directory. It creates destination directories, guards script end-tag text, writes atomically, and leaves the source untouched. The script catches obvious remote resource tags. It does not perform a complete static audit of fetch calls, CSS imports, URL construction, or assets referenced by user-written JavaScript. Verify zero external requests in an offline browser test.

The built HTML needs no npm install, server, API key, or network request. A browser with WebGL is required. Some mobile file managers preview HTML without running scripts; open the downloaded/extracted file in a full browser. LocalStorage availability varies with browser/file origin. Hosting the same self-contained file can improve opening behavior, but hosting is a separate action and is not needed for the offline design.

For a reusable downloadable engine package, include the source assets, builder, relevant API references, the upgraded skill archive if requested, and a built example. Keep the Three.js MIT license with redistributions. Do not promise native Android APKs, a visual editor, multiplayer, AI models, or asset importers: this package does not implement those systems.

## Recipes

### Add a collectible

Create a mesh, keep a stable ID and a collected flag, test distance to the actor during fixed update, hide the mesh once, emit a bounded particle burst and optional unlocked audio, then update the HUD. Serialize IDs rather than whole Three.js objects. Validate loaded IDs against known content.

### Add an enemy that follows a route

Build a small occupancy grid from the world. Call `findPath` when the target changes or a route becomes blocked. Convert `[cellX,cellZ]` to your terrain's world coordinates, including the .5 offset if appropriate. Move toward the next waypoint through physics. Recompute on a limited cadence rather than allocating A* arrays every frame. The path should account for the actor radius; a center-cell route through a one-cell gap may not fit a wide actor.

### Add an outdoor region

Construct a soft biome mask, then blend heights/material weights. Build terrain once, retain its exact heightAt, instance foliage only where density permits, and bound shoreline movement with your solid callback. Chunking enables frustum culling; it does not automatically stream or unload a distant region. Design explicit scene ownership before adding regional loading.

### Pause, resume, restart

When opening settings, disable input and pause gameplay. For a full pause use `loop.pause(true)`. For a live animated backdrop, keep rendering and gate only gameplay simulation as the starter does. On resume, reset input so a held gesture cannot continue moving the player. On restart reset state and camera initialization. On scene destruction call loop/input/audio/post disposers and release owned scene resources.

## Regression priorities

- Compare terrain height samples to mesh ray intersections, including both triangle orientations and chunk boundaries.
- Verify the graphics preset changes live resources and preserves the settings object's identity.
- Exercise ground contact, wall movement, body overlap, static actors, and distinct collision layers.
- Exercise simultaneous touch joystick/look, pointer cancellation, pinch, blur, and visibility recovery.
- Switch bloom repeatedly and check renderer memory counts after stabilization.
- Save, restore, reject malformed JSON, and handle blocked storage visibly.
- Confirm no remote requests from the final HTML.

Core regression tests run with `node scripts/test_core.cjs`; builder tests run with `python3 scripts/test_build.py`. Optional CPU graphics-resource checks use `node scripts/test_resources.cjs` and require `@napi-rs/canvas`. Optional browser checks use `node scripts/test_browser.cjs path/to/spirit-isle.html screenshot-directory` and require Playwright plus Chromium. The CPU tests use DOM/renderer stubs and do not validate a complete rendered frame. `test_visuals.cjs` checks atlas pixels, packed relief, material hooks, batching, geometry and post state; `test_demo.cjs` constructs and drives the complete starter against real Three.js objects with a renderer stub. A real browser check is still needed after shader, DOM, or graphics-resource changes. Treat screenshots and target-device measurements as separate evidence.
