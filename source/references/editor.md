# Level editor and console · 3.0.0 (`90-editor.js`)

`KE.Editor` is an in-browser level editor that docks over a running `KE.GameWorld`: toolbar, viewport with a transform gizmo and fly camera, outliner, schema-driven details panel, place-actors drawer, structured Blueprint editor, output log, undo/redo, Play In Editor, level save/load and glTF import/export. `KE.ConsoleUI` is a backquote developer console for cvars and commands that works with or without the editor. Registers module `editor`. Requires `85-gameplay.js`; the gizmo needs `THREE.TransformControls` and glTF needs `THREE.GLTFLoader`/`THREE.GLTFExporter` (all in `assets/three-addons.js`).

## Contents

1. Setup
2. Using the editor
3. API
4. Console
5. Integration notes and limitations

## 1. Setup

```js
const KE = window.KitsuneEngine;
const world = new KE.GameWorld(THREE, scene, {camera, renderer, physics, audio, vfx});
const editor = new KE.Editor(THREE, {
  renderer, scene, camera, world,
  render: dt => pipeline.render(scene, camera, dt),     // default: renderer.render(scene, camera)
  onUpdate: dt => { sky.update(dt, camera); csm.update(camera); },
  onPlay: w => spawnPlayer(w), onStop: w => {},
  onOpen: () => loop.pause(true), onClose: () => loop.pause(false)
});
// F8 toggles it; or editor.open() / editor.close() / editor.toggle()
```

Options (defaults): `renderer`, `camera` (required), `world` or `scene` (a world is created when only a scene is given), `container` (`document.body`), `render(dt, editor)`, `onUpdate(dt, editor)`, `onPlay(world, editor)`, `onStop(world, editor)`, `onOpen(editor)`, `onClose(editor)`, `loop` (true: the editor runs its own requestAnimationFrame loop while open; false: call `editor.frame(dt)` yourself), `dockCanvas` (true: the renderer canvas is positioned and resized to the viewport slot and restored on close), `restoreCamera` (true: the camera pose is restored on close), `hotkey` (`'F8'`, `null` disables), `storageKey` (`'ke-editor-level'`), `duplicateOffset` ([.5, 0, .5]), `levelName`.

The editor uses the game's own camera and renderer. While it is open the game should not run its own update/render (listen to `onOpen`/`onClose` or the `KE.events` `'editor'` event, `{open, editor}`). When closed the editor does no per-frame work: its DOM, stylesheet and listeners are removed; only the F8 hotkey listener stays until `dispose()`.

## 2. Using the editor

**Layout.** Toolbar across the top; Place Actors drawer on the left; the viewport in the centre; Outliner and Details on the right; Output Log and Blueprint tabs at the bottom. Below 900 px wide the drawer collapses behind the drawer button and secondary toolbar controls hide; below 640 px the side panels narrow further. All controls are buttons, selects or inputs with labels and visible focus rings.

**Viewport and camera.** Left click selects (Shift/Ctrl toggles); picking raycasts actor meshes and sprites on layers 0/1 only (editor helpers live on `KE.LAYERS.EDITOR` = 31 in a separate helper scene) plus a 15 px screen-space test on the icons of lights, audio sources, emitters, triggers, player starts and empty actors. Hold the right mouse button to fly: mouse look, W/A/S/D move, Q/E down/up, Shift ×3, mouse wheel changes speed (8 steps, 0.5–80 units/s, also on the toolbar). Middle drag pans, Alt+left drag orbits the selection, the wheel dollies. F frames the selection (animated). End drops the selection onto the surface below. G toggles game view (hides grid and icons).

**Gizmo.** Q select, W translate, E rotate, R scale, Space cycles; the toolbar toggles world/local space and snapping (translation 0.01–10 m, rotation 1–90°, scale 0.05–1). The gizmo drives a pivot at the primary (last selected) actor; its delta is applied to every selected root actor, so multi-selections move, rotate and scale around the pivot. Each drag is one undo step.

**Helpers.** A procedural ground grid (1 m minor / 10 m major lines, red X and blue Z axes, distance fade, minor lines fade where they would alias). Without the post pipeline it depth-tests against the framebuffer (with polygon offset against coplanar ground); after `KE.Pipeline` it compares its depth with `KE.sceneUniforms` scene depth, so geometry still occludes it. Icons are constant-size billboards; trigger volumes draw green wire boxes/spheres; selected actors get orange bounds, and selected lights show their range sphere, spot cone or sun direction. `show grid|icons|bounds` console commands and the toolbar toggle these.

**Outliner.** Hierarchical actor list with search (name, class, tags), eye toggles (undoable visibility), double-click or F2 inline rename, arrow-key navigation (Shift extends), Enter focuses, Delete/Backspace deletes. Rows are capped at 1500 per view; refine the search for larger levels.

**Details.** Name, class, id, prefab and parent; Transform (location, rotation in degrees, scale; typed values are undoable and consecutive edits of the same field merge); Actor (visible, tags); then one collapsible section per component generated from its schema (`KE.Components.fields`): numbers (drag the label to scrub, Shift ×10), vectors, colour pickers, checkboxes, enum selects, asset selects, suggestion lists (`suggest()`), text and JSON. Values go through `component.set`, so they are clamped and validated by the schema; a field whose `when` visibility changes re-renders the section. "Add component…" lists every registered component (unique ones already present are omitted); the bin icon removes one.

**Place Actors.** Actor classes and prefabs grouped by category with search. Click places in front of the camera on the first surface under the screen centre (else on y = 0, else 8 units ahead), resting the actor's bounds on the surface; drag an item into the viewport to place it at the drop point. Placement snaps to the translation grid when snapping is on.

**Blueprint tab.** For the selected actor's `Blueprint` component: event list (BeginPlay, Tick, Overlap, EndOverlap, EndPlay with action counts), custom events (add/delete), variables (name and JSON default), and the selected event's actions as cards with fields generated from `KE.Blueprint.nodeTypes` (nested `then`/`else`/`do` lists are indented; expressions are typed as text and parsed on commit; invalid input is outlined red with the parser message as tooltip and is not committed). Cards move up/down or delete; "+ Add action…" lists nodes by category. Every change is one undoable property edit of `graph`.

**Output Log.** World logs (Blueprint prints tagged `[BP]`, warnings, errors) and editor messages with timestamps; filter all / warnings and errors / prints; clear.

**Play In Editor.** Play (Alt+P) serializes the level, starts `world.beginPlay()`, calls `onPlay`, and ticks the world with `world.update(dt)` every editor frame; the viewport gets a green border and banner, grid and icons hide. Pause (amber border) freezes world time. Stop (Esc) ends play, calls `onStop`, reloads the snapshot (actor ids and selection preserved) and re-enables undo. Undo history is suspended while playing; edits made during play are discarded on Stop.

**Files.** File menu: Save level (Ctrl+S, browser `localStorage`, glTF assets embedded when the quota allows), Load saved level, Download level (.json), Open level file, Import glTF/GLB (parsed offline with `GLTFLoader.parse`, registered as a world asset and placed as a `StaticMesh` actor), Export level as GLB (`GLTFExporter`, visible actor geometry and punctual lights, no editor helpers or sprites), New empty level. Malformed files are rejected before the level is touched and the validation errors are listed in the log.

**Keyboard summary.** F8 editor, ` console, Q/W/E/R tools, Space cycle tool, F focus, End drop to ground, G game view, Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z) undo/redo, Ctrl+D duplicate, Delete delete, Ctrl+A select all, Ctrl+S save, Alt+P play/stop, Esc stop or deselect. Shortcuts are ignored while typing in an input.

## 3. API

Lifecycle: `open()`, `close()`, `toggle()`, `isOpen`, `dispose()` (closes and removes the hotkey), `frame(dt)` (one editor frame; only needed with `loop:false`), `events` (`KE.Events`: `open`, `close`, `selection`, `play`, `stop`).

Selection and camera: `selection` (array), `primary`, `select(actor | actor[] | null, {add, toggle})`, `selectById(ids)`, `actorAt(clientX, clientY)`, `pickAt(clientX, clientY, {add})`, `focus(actors?, {instant})`, `setCameraSpeed(index 0–7)`, `placementPoint(ndc=[0,0]) → {point, ground}`.

Tools and view: `setMode('select'|'translate'|'rotate'|'scale')`, `setSpace('world'|'local')`, `setSnap({enabled, translate, rotate, scale})`, `setShow('grid'|'icons'|'bounds'|'stats'|'game', bool?)`, `setViewMode(mode)` — any `r.ViewMode` option (forwarded to the cvar, which `KE.Pipeline` uses for its debug views) or the editor's `'wireframe'` (scene override material). `gizmo` (the TransformControls) and `pivot` are exposed for tools.

Undoable operations (all recorded on `history`, a command stack of 200 steps with merging of rapid edits to the same field): `translateSelection([x,y,z])`, `rotateSelection([x,y,z] degrees)`, `scaleSelection(f | [x,y,z])`, `setActorTransform(actor, 'position'|'rotation'|'scale', [x,y,z])`, `dropToGround()`, `spawnActor(def, {select})`, `placeActor(def, {ndc})`, `duplicate()`, `deleteSelected()`, `setProperty(actor, component, key, value)`, `addComponent(actor, type)`, `removeComponent(actor, component)`, `renameActor(actor, name)`, `setVisible(actor, bool)`, `setTags(actor, tags[])`, `undo()`, `redo()`. Delete and undo restore whole actor subtrees with their original ids.

Play: `play()`, `pause(bool?)`, `stop()`, `playing`.

Files: `saveLevel(slot='default') → bytes`, `hasSavedLevel(slot)`, `loadLevel(slot) → Promise<bool>`, `loadLevelJSON(json, label) → Promise<bool>`, `downloadLevel(filename?)`, `uploadLevel(file?)`, `importGLTF(file | Blob | ArrayBuffer, name?) → Promise<Actor|null>`, `exportGLTF({download=true, binary=true, filename}) → Promise<ArrayBuffer|object>`.

Log: `log(text, level='info'|'warn'|'error'|'dim')`, `logEntries`.

Statics: `KE.Editor.instances`, `KE.Editor.active` (the open editor), `KE.Editor.FLY_SPEEDS`, `KE.Editor.CommandStack`.

## 4. Console

```js
KE.ConsoleUI.install({renderer});                 // done automatically at load (without a renderer)
KE.ConsoleUI.command('god', args => { player.invulnerable = args[0] !== '0'; return 'god ' + player.invulnerable; }, 'god [0|1]: toggle damage');
KE.ConsoleUI.run('r.TAA 0');                      // → {ok, output:['r.TAA = false']}
```

Backquote (`KE.ConsoleUI.hotkey`) toggles a drop-down console (ignored while typing in other inputs). Enter runs, Up/Down walks the history (last 100 lines, kept in `localStorage`), Tab completes commands and cvar names (suggestions show help and current values; `stat`/`show` arguments complete too), Esc closes.

Built-in commands: `help`, `clear`, `list <prefix>` (cvars with values), `stat fps|unit|gpu|none` (overlay: FPS and frame time from requestAnimationFrame intervals; `unit` adds min/max frame time, the top `KE.profiler` scopes and renderer counters — draw calls, triangles, geometries, textures, programs — from the installed renderer or the open editor; `gpu` switches on `KE.GPUTimer` timer queries (the `r.ProfileGPU` cvar) and lists each timed system's per-pass GPU milliseconds, for example every `KE.Pipeline` stage; browsers without `EXT_disjoint_timer_query_webgl2`, which includes nearly all phones, show that it is unsupported; the same `stat` again hides it), `show <flag>` (flags registered by the open editor: `grid`, `icons`, `bounds`), `editor`. Any other first word is looked up in `KE.cvars`: `<cvar>` prints value and help, `<cvar> <value>` sets it (errors such as out-of-range options are printed, not thrown).

API: `install({renderer, hotkey, enabled})`, `uninstall()`, `setRenderer(r)`, `open()`, `close()`, `toggle()`, `isOpen`, `run(line) → {ok, output}`, `print(text, cls)`, `clear()`, `command(name, fn(args, console, line), help) → unregister`, `removeCommand`, `commands()`, `complete(prefix)`, `showFlag(name, fn(value?) → bool, help) → unregister`, `stat(mode)`, `statSample() → {fps, ms, min, max}`, `lines`, `history`, `enabled`.

The stat overlay runs its own requestAnimationFrame loop only while a stat mode is active; the console DOM exists only while open.

## 5. Integration notes and limitations

- Overlay rendering: after the game frame the editor draws its helper scene into the default framebuffer with tone mapping off, `autoClear` off and `renderer.info.autoReset` off (so `stat unit` counts include both passes). It sets `keHasScene` to 0 before calling `render`; if the pipeline ran (it sets it back to 1) the depth buffer is cleared and the grid switches to scene-depth occlusion.
- Docking changes the canvas style and drawing-buffer size while open; a game resize handler that runs while the editor is open is corrected on the next editor frame. Everything is restored on close.
- The editor edits the live world. Levels, undo and Play In Editor operate on serialized actor data, so component instances are re-created on undo of deletions and on Stop.
- Picking uses CPU raycasts against actor meshes (no GPU id buffer), which is fine for editor-sized scenes but slow for very dense meshes; hidden actors cannot be picked.
- The Blueprint editor is a structured list editor (events → action cards), not a wire-graph canvas.
- Selection bounds use axis-aligned world boxes; there is no outline post-effect.
- glTF export includes meshes, materials and punctual lights but not sprites (text labels, icons), particles or hemisphere lights.
- `localStorage` quotas (typically ~5 MB) limit saved levels with embedded glTF assets; the editor falls back to saving without assets and says so.
