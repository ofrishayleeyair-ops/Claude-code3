---
name: run-kitsune-engine
description: Build, run, drive, test and screenshot the kitsune engine and its Spirit Isle demo game (offline single-file HTML games on Three.js r128). Use when asked to start or play Spirit Isle, build the engine or a game HTML, take screenshots of the game (day/night/rain, quality presets, debug views, phone layout), check for console errors, or run the engine's module and browser tests.
---

The engine builds into self-contained HTML games; there is no server. Build with the Python scripts, then drive the game in headless Chromium (software WebGL2) with the REPL driver `.claude/skills/run-kitsune-engine/driver.mjs`. All paths below are relative to the repo root.

## Prerequisites

This container already had everything: Node 22, Python 3.11, and Playwright 1.56 installed globally at `/opt/node22/lib/node_modules/playwright` with Chromium in `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`). No apt packages were needed. The driver and the test harness look for `playwright` on the normal module path first, then at that global location. Two old CPU test suites also need `@napi-rs/canvas` (see Test).

## Build

```bash
python3 source/scripts/build_engine.py                                  # src/ + vendor/ -> source/assets/{kitsune-engine,three-addons,kitsune-libs}.js
python3 source/scripts/build.py source/assets/starter.html spirit-isle.html   # starter -> offline game (~9 MB)
```

`build_engine.py --engine-only` rebuilds just `kitsune-engine.js`; `--modules 00,10,12` bundles only modules whose filenames start with those prefixes (useful to exclude a module under construction).

## Run (agent path)

Pipe commands to the driver; they run in order. This exact script was run here (~70 s):

```bash
node .claude/skills/run-kitsune-engine/driver.mjs <<'EOF'
launch spirit-isle.html
stats
start
ss 01-low-start
state
hold KeyW 3000
state
preset high
day .84
wait 4000
ss 02-high-night
cvar r.ViewMode ao
wait 2000
ss 03-ao-view
cvar r.ViewMode lit
viewport 390 844
wait 2000
ss 04-mobile
errors
quit
EOF
```

Screenshots land in `/tmp/kitsune-shots/` (override with `SHOT_DIR`). `launch` takes a repo-relative or absolute path (`launch /tmp/kitsune-full.html` works) and optional `width height`. For step-by-step exploration, run the same driver in tmux:

```bash
tmux new -d -s ke -x 200 -y 50 'node .claude/skills/run-kitsune-engine/driver.mjs'
tmux send-keys -t ke 'launch spirit-isle.html' Enter
timeout 120 bash -c 'until tmux capture-pane -t ke -p | grep -q "launched"; do sleep 1; done'
tmux send-keys -t ke 'start' Enter
tmux send-keys -t ke 'press KeyT' Enter          # advance the hour by 1/12 day
tmux send-keys -t ke 'eval demo.getState().day' Enter
tmux capture-pane -t ke -p | tail -5
tmux send-keys -t ke 'quit' Enter
```

| command | what it does |
|---|---|
| `launch [file.html] [w h]` | open a built game (default `spirit-isle.html`, 960×600); waits for `window.demo`, the game's error card, or the first page error (reported as `GAME ERROR`) |
| `start` | click "Enter Spirit Isle" (enables input) |
| `ss [name]` | screenshot (5-minute timeout) |
| `preset low\|medium\|high\|ultra\|cinematic` | quality preset; forces render scale 1 |
| `day <0..1>` / `rain on\|off` | time of day (.33 noon, .6 sunset, .84 night) / weather |
| `hold <KeyCode> <ms>`, `press <key>`, `click <selector>` | input (`KeyW` forward, `Space` jump, `KeyT` advance the hour after `start`) |
| `cvar <name> [value]` | read/set engine console variables: `r.TAA`, `r.GI`, `r.GTAO`, `r.Upscale`, `r.LocalExposure`, `r.ViewMode lit\|ao\|depth\|bloom\|ssgi\|unlit\|lighting\|localexposure`, … (booleans take 0/1, true/false, on/off) |
| `state` / `stats` | player position and collected stones / engine version, modules, draw calls, pipeline passes |
| `eval <js>` | evaluate in the page (`demo`, `KitsuneEngine`, `THREE`). `demo` also exposes `forest`, `fur`, `foxGait`, `guide` (AI wisp: `guide.tree.debugString()`), `vfx`, `physics`, `props`, `sound`, `surfaceWeather`, `world`, `editor` |
| `press F8` / `press Backquote` | open the level editor / the developer console |
| `viewport <w> <h>`, `wait <ms>`, `errors`, `quit` | resize, pause, list page/console errors and any network requests (should be none) |

## Engine modules without the game (direct invocation)

Most engine changes land in `source/src/modules/NN-name.js`. `source/scripts/harness.cjs` loads Three, the add-ons, `src/core.js` and chosen module files (not the bundle) in headless Chromium; each `test_<module>.cjs` uses it. `--shots` writes screenshots to `source/.test-output/`:

```bash
node source/scripts/test_water.cjs --shots     # also: test_pipeline, test_sky, test_shadows, test_gi (--half: no float blending), test_weather
```

The other modules have their own suites (`test_materials`, `test_foliage`, `test_geometry`, `test_world`, `test_physics`, `test_vfx`, `test_animation`, `test_ai`, `test_audio`, `test_editor`); each writes screenshots to `source/.test-output/`. Showcase pages for single systems are in `source/examples/src/*-demo.html`; build one with `python3 source/scripts/build.py source/examples/src/physics-demo.html /tmp/physics.html` and `launch /tmp/physics.html` (the driver waits for `window.demo` or an error card, so for these pages use `eval` and `ss` after launch times out, or open them through the harness).

## Run (human path)

Open `spirit-isle.html` from disk in a desktop browser with WebGL2 — it runs from `file://` and makes no network requests. Not useful headless; use the driver.

## Test

```bash
node source/scripts/test_all.cjs                       # every suite in sequence (~30+ min under SwiftShader); writes verification.json
node source/scripts/test_all.cjs --only core,build,pipeline --out /tmp/v.json   # a subset
node source/scripts/test_core.cjs                      # 22 core tests (Node only)
python3 source/scripts/test_build.py                   # 5 builder tests
node source/scripts/test_browser.cjs spirit-isle.html /tmp/kitsune-browser   # full game in Chromium, ~3 min; prints JSON, exits 1 on failure
mkdir -p /tmp/kitsune-npm && (cd /tmp/kitsune-npm && npm init -y >/dev/null && npm install @napi-rs/canvas)
NODE_PATH=/tmp/kitsune-npm/node_modules node source/scripts/test_visuals.cjs     # 17 CPU checks
NODE_PATH=/tmp/kitsune-npm/node_modules node source/scripts/test_resources.cjs
```

## Gotchas

- **Headless auto-picks the Low preset** (4 hardware threads → `KE.detectPreset()` = low), which turns the HDR pipeline, shadows and GI off. Run `preset high` (or ultra) before judging rendering.
- **Software WebGL is ~1 frame per second at High.** Playwright's default 30 s screenshot timeout fails (`page.screenshot: Timeout 30000ms exceeded`); the driver waits up to 5 minutes. Use `wait` of a few seconds after `day`/`preset`/`cvar` changes so the sky cube, probe GI and TAA history catch up. Startup takes ~13 s.
- **`hold` is wall-clock time.** The game loop caps each frame at 0.1 s, so at ~1 fps a 3 s hold moves the fox only ~4 units at Low (less at High).
- **`page.waitForFunction(fn, {timeout})` silently ignores the timeout** — the object is taken as the page-function argument. Pass `(fn, null, {timeout})`.
- **Edit `source/src/`, not `source/assets/kitsune-engine.js`.** The bundle (including the ~5 MB embedded surface atlas) is regenerated by `build_engine.py`; hand edits are overwritten.
- **`build.py` needs exactly one `<!--THREE-->` placeholder followed by one `<!--KITSUNE-->`** in the source HTML, and refuses remote `src/href` URLs.
- **Engine shader patches must regex-match the minified Three chunks.** `three.min.js` strips comments from `THREE.ShaderChunk` (e.g. `/*lightProbe,*/`), so string replacements copied from the unminified r128 source fail. r128 also has no `Object3D.removeFromParent`, and setting `needsUpdate` on a render-target texture wipes it.

## Troubleshooting

- **A browser suite hangs or times out**: another suite or agent is probably using the CPUs; SwiftShader is CPU-bound. Run suites one at a time (`test_all.cjs` does) and close stray `headless_shell` processes (`pkill -f headless_shell`).
- **`TypeError: renderer.getContext is not a function` from `test_demo.cjs`**: that test drives the old 2.x starter with a CPU renderer stub; the v3 starter's pipeline needs a real WebGL context. Use `test_browser.cjs` for the game.
- **`GAME ERROR (page error while loading): Identifier 'stoneMat' has already been declared`**: the starter is one script scope, and new top-level `const`s collide with names in the scenery block (`stoneMat` and `sceneryBatch` both bit us). Rename yours and rebuild.
- **`launch` reports `GAME ERROR` but you expected a warning only**: any uncaught exception during loading ends the wait; the page stays open, so `errors`, `eval` and `ss` still work to inspect it.
