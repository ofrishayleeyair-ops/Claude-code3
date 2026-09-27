# Legacy rendering reference

Retained from the supplied predecessor for existing projects. The v2 API and integration references supersede old behavior.

## API summary

All functions take `THREE` first so the engine never hard-codes a three.js copy.

| Call | What it does |
|---|---|
| `KE.settings` | Current graphics settings (loaded from localStorage `ke_settings`, else auto-detected). Keys: `preset, scale, shadows, shadowRes, tex, grass, bloom, aa, fx, view, aniso, showFps, auto`. |
| `KE.PRESETS`, `KE.applyPreset(name)`, `KE.detectPreset()`, `KE.saveSettings(s)` | Presets `low`, `medium`, `high`, `ultra`. |
| `KE.settingsPanel(onChange)` | Returns a ready-made settings UI element. `onChange(settings, changedKey)` — apply live changes there. Texture detail and anti-aliasing apply on next start. |
| `KE.materials(THREE, size?)` | 8 hand-painted, Genshin-style tileable textures in this order: grass, sand, dirt, stone (cobbles), rock (layered cliffs), snow, ash, wood. |
| `KE.splatMaterial(THREE, mats, {scale, flat})` | Toon-shaded terrain material: blends the 8 textures by per-vertex weights with noisy painterly borders, anti-tiling, triplanar rock on cliffs and a soft fade to average colors in the distance. `flat:true` uses plain Phong instead of toon shading. |
| `KE.terrain(THREE, {w,h,height(i,j),weights(i,j),tint(i,j,a),material,sub,detail(x,z),chunk})` | Builds chunked terrain meshes. `sub` 1 or 2 subdivides each cell with smooth bicubic heights (defaults to `settings.terrain`). `detail(x,z)` adds extra height (use `KE.ridged` scaled by a mountain mask for sharp ridges). `weights` returns 8 numbers summing to 1; `tint` returns an RGB multiplier. Returns an array of meshes plus `meshes.heightAt(x,z)`, the exact rendered height: place every object and character with it so nothing floats or sinks. |
| `KE.ridged(x, z, octaves)` | Ridged fractal noise (0..1) for mountain ridges. |
| `KE.sky(THREE, scene, {radius, center})` | Gradient sky dome plus sun, halo and moon sprites. |
| `KE.dayCycle(THREE, {sky, sun, hemi, fogColor})` | `.update(dayFraction, targetVector3, wet)` moves the sun and moon, colors light, fog and sky (0..0.67 is day). |
| `KE.water(THREE, scene, {size, center, level, color})` | Rippling water. Call `.update(t)` each frame. |
| `KE.wind(THREE, material, {amp})` | Makes instanced foliage sway. Set `KE.windUniforms.uTime.value = t` each frame. |
| `KE.grass(THREE, scene, {count, radius, heightAt, density(x,z), color(x,z)})` | Wind-blown grass blades around the player. Call `.update(x, z)` each frame. Returns null when count is 0. |
| `KE.glow(THREE, scene, points, {size})` | One draw call of glowing light points; fade with `.material.opacity` at night. |
| `new KE.Post(THREE, renderer, {aa, bloom, threshold, vignette, grain, saturation, contrast})` | Bloom, vignette, grading and grain. Use `post.render(scene, cam)` instead of `renderer.render`, and `post.setSize(w, h)` on resize. |
| `KE.objectTextures(THREE)` / `KE.triplanar(THREE,{map,color,scale,emissive})` | Painterly grayscale detail textures (plaster, roof tiles, wood, bark, stone, leaf, lacquer) and a toon material that maps them in world space, so any box, cone or instanced mesh gets texture detail tinted by its own color. Map each object color to a kind and pass it through one helper (like `mat3`). |
| `KE.spriteShadow(THREE, scene, texture, w, h)` | Invisible plane that casts a character-shaped shadow from a sprite texture. Move it with the sprite and call `.face(sunDirection)` each frame. |
| `KE.Physics.body({...})`, `KE.Physics.step(bodies, dt, solid(x,z), groundAt(x,z))` | Gravity, bounce, friction, wall collisions and body-to-body pushes. |
| `KE.FPS.tick(now, onDowngrade)` | Returns FPS. When `settings.auto` is on and FPS stays under 24 for 5 seconds, it steps the preset down and calls `onDowngrade(settings)`. |
| `KE.tileNoise(x, y, size, period)`, `KE.canvasTex(...)`, `KE.glowTexture(...)` | Helpers for making your own textures. |

## Rendering defaults that look good

- `renderer.toneMapping = THREE.ACESFilmicToneMapping`, exposure about 1.0.
- Pixel ratio: `clamp(min(devicePixelRatio, 2) * settings.scale * 0.7, 0.6, 2.2)`.
- Shadows: `PCFSoftShadowMap`, a directional sun with an orthographic shadow box of about ±26 to ±30 units that follows the player, `bias -0.0006`, `normalBias 0.03`.
- Fog: `near = view * 0.4`, `far = view`, color from `dayCycle`.
- Water color near `0x1a5f9e`; bright water means the color is too light for ACES.
- Sprites and UI-like materials: set `toneMapped: false` so characters stay crisp.

## Mountains that look good

- Make a mountain mask (1 inside mountain areas, 0 outside) and blur it about 10 times. Use it to fade every mountain effect in, so mountains rise out of the ground instead of starting at a wall.
- Blend the height toward a heavily blurred copy where the mask is between 0 and 1 (`e = min(1, 5.6*m*(1-m))`). This softens the edges.
- Add ridges with `KE.ridged(x*0.07, z*0.07) * 8 * m²` on the coarse grid, and small detail with `KE.ridged(x*0.33, z*0.33) * 1.5 * m²` through the `detail` callback. Keep ridges away from shrines, paths and other flat spots.
- Put snow above a noisy height line (`threshold + noise * 5`), less on steep slopes; steep slopes become rock automatically through the splat weights.

## Camera that feels 3D

- Default to a third-person camera behind the player (`settings.cam === 'follow'`): distance about 11, pitch about 0.4 rad, field of view 55, looking slightly above and ahead of the player so the horizon shows.
- Rotate movement input by the camera yaw so "up" always walks away from the camera, and pick the sprite facing from the movement direction relative to the camera.
- Let the camera slowly swing behind the walking direction, but not when walking toward the camera. Two-finger drag rotates and tilts, pinch zooms, Q/E and on-screen buttons turn it; pause auto-swing for a few seconds after manual control.
- Keep the camera above the ground, and fade buildings to 28% opacity when rays from the camera to the player's feet, chest or head hit them.
- Offer "Top view" (`cam: 'classic'`) in settings for players who prefer it.
- Set `receiveShadow` and `castShadow` on all solid objects, and add `KE.spriteShadow` for characters so they cast real shadows.
