# Animation · 3.0.0

Module `src/modules/60-animation.js`, registered as `animation`. CPU-only: no GPU resources are created except by `buildSkinnedTube` (geometry and, unless you pass one, a material) and `CameraRail.createHelper`. Everything works on plain `Object3D` hierarchies (Groups as joints, as in Spirit Isle's sphere-built fox) and on `THREE.Bone` skeletons. Update paths reuse preallocated scratch objects; the per-frame calls listed below do not allocate (except debug getters such as `AnimStateMachine.weights`).

## Contents

1. Conventions
2. Easing and tweens
3. Inverse kinematics: `IK.twoBone`, `IKChain`, `LookAt`
4. Secondary motion: `SpringChain`
5. Pose blending, blend spaces and the state machine
6. Procedural locomotion: `ProceduralGait`
7. Cinematics: `Sequencer`, `CameraRail`, `CameraShake`
8. Root motion, bone chains and skinned tubes
9. Cost, quality and limitations

## 1. Conventions

Constructors that touch Three objects take `THREE` first. Time is in seconds, Y is up, and world matrices are read with `updateWorldMatrix(true, …)` where needed, so you do not have to refresh them first. Solvers write local `quaternion`s (and, when stretching, `position`/`scale`) and leave `matrixWorld` current. Vectors can be given as `THREE.Vector3`, `[x,y,z]` or `{x,y,z}`.

Parents must be uniformly scaled (non-uniform scale on an ancestor skews rotations; solvers take the rotation part of the world matrix). "Forward" defaults to −Z, the facing of the engine's characters (`FollowCamera`, Spirit Isle's hero); pass `forward:[0,0,1]` for rigs that face +Z (most glTF characters).

## 2. Easing and tweens

```js
const KE = window.KitsuneEngine;
KE.tween(mesh, { 'position.y': 2, scale: [1.2, 1.2, 1.2], 'material.opacity': 0 },
  { duration: 0.6, ease: 'outBack', delay: 0.1, repeat: 1, yoyo: true,
    onUpdate: (target, progress) => {}, onComplete: () => {} });
// once per frame (the global manager is not driven automatically):
KE.tweens.update(dt);
```

`KE.easing` holds `linear`, `in/out/inOut` × `Quad Cubic Quart Quint Sine Expo Circ Back Elastic Bounce`, `smoothstep`, `smootherstep`, CSS `ease easeIn easeOut easeInOut`, and the factories `cubicBezier(x1,y1,x2,y2)` (Newton + bisection) and `steps(n, 'end'|'start')`. Anywhere an ease is accepted you may pass a name or a function `t => t'`.

`KE.tween(target, props, opts)` returns a `KE.Tween` and starts it on `opts.manager` (default `KE.tweens`). Property keys are dot paths resolved when the tween starts (after its delay). Supported values: numbers (and relative strings `'+=n'`, `'-=n'`, `'*=n'`), booleans (switch at the end), `Vector2/3/4`, `Euler`, `Color` (hex, CSS string, array, Color), `Quaternion` (slerped; accepts a Quaternion, `[x,y,z,w]`, an Euler or `[x,y,z]` XYZ Euler angles) and numeric arrays. Camera projection keys (`fov`, `zoom`, `near`, …) call `updateProjectionMatrix()`; tweening a material's `opacity` below 1 sets `transparent`.

Options (defaults): `duration 1`, `ease 'outCubic'`, `delay 0`, `repeat 0` (`Infinity` allowed), `repeatDelay 0`, `yoyo false`, `from null` (map of start values), `onStart`, `onUpdate(target, progress, tween)`, `onComplete`, `onRepeat(target, iteration)`, `onStop`, `manager`, `autoStart true`.

Tween methods: `start()`, `stop()`, `pause()`, `resume()`, `seek(seconds)`, `chain(...tweens)` (holds back the given tweens until this one completes), `finished` (a Promise resolving `true` on completion, `false` on stop), `playing`, `progress`, `done`. An unknown property throws on the first update that starts the tween, and that tween is stopped.

`new KE.TweenManager()` gives an independent group (`update(dt)`, `timeScale`, `count`, `killTweensOf(target)`, `stopAll()`); tweens started from callbacks begin on the next update.

## 3. Inverse kinematics

### IK.twoBone

```js
const err = KE.IK.twoBone(THREE, thigh, shin, foot, targetWorld, poleWorld /* or null */,
  { weight: 1, stretch: false, maxStretch: 1.5, soft: 0, updateMatrices: true });
```

Analytic law-of-cosines solve. The mid joint bends in the plane of the target direction and the pole (or the current bend when `pole` is null; a stable perpendicular is chosen if the limb is straight). Root and mid receive shortest-arc world rotations that are converted back to local space, so any joint axes and any parent transform work. `mid` must descend from `root` and `end` from `mid` (intermediate nodes are fine). Returns the remaining distance from the end joint to the target (0 when reachable). Unreachable targets straighten the limb toward the target.

- `weight` 0–1 slerps each local rotation from its input pose.
- `stretch:true` scales `mid.position` (and `end.position` when `end` is a direct child of `mid`) up to `maxStretch` so the chain reaches; the rest offsets are remembered and restored on the first call without `stretch`.
- `soft` (0–0.5) eases the approach to full extension over that fraction of the chain length to avoid the knee "pop".
- Degenerate cases (target at the root, zero-length bones, colinear pole) are handled without NaN.

`KE.IK.swingTwist(q, axis, swingOut, twistOut)` splits a quaternion into swing × twist about a unit axis.

### IKChain

```js
const chain = new KE.IKChain(THREE, [shoulder, elbow, wrist, fingertip], {
  method: 'fabrik',           // or 'ccd'
  iterations: 12, tolerance: 1e-3, weight: 1, maxStep: Infinity /* ccd: max radians per joint per sweep */,
  constraints: [null, { axis: 'x', minAngle: -2.4, maxAngle: 0 }, { maxAngle: 0.6, twist: [-0.3, 0.3] }]
});
const remaining = chain.solve(targetWorld, poleWorld /* optional */);
```

Joints must each descend from the previous one; bone lengths are measured from world positions every solve, so they are preserved exactly. FABRIK reaches unreachable targets in one straight pass; `pole` rotates interior joints toward the pole about the line through their neighbours. CCD ignores `pole`.

Constraints are relative to the rest pose captured at construction (`captureRest()` re-captures): a **hinge** (`axis` `'x'|'y'|'z'` or a vector in the joint's local frame, `minAngle`, `maxAngle`) keeps only the rotation about the axis and clamps it; a **cone** (`maxAngle`, optional `twist:[min,max]`) limits the swing of the bone direction and optionally its twist. With constraints, FABRIK re-applies limits every iteration and finishes with CCD sweeps if it stalled. `error` and `iterationsUsed` report the last solve. CCD converges slowly for targets near full extension (up to ~100+ sweeps in our tests); it is warm-started from the current pose, so per-frame use converges over frames.

### LookAt

```js
const look = new KE.LookAt(THREE, [neck, head], {
  forward: [0, 0, -1], up: [0, 1, 0], maxYaw: 1.2, maxPitch: 0.7, minPitch: -0.7,
  speed: 10, weight: 1, weights: null, releaseAngle: Infinity, base: 'rest'
});
look.update(targetWorldOrNull, dt);
```

`object` may be one Object3D or a chain; the yaw/pitch are measured from the eye (last object) in the rest frame of the first object and split across the chain by `weights` (equal by default). Yaw and pitch are clamped, then smoothed exponentially with `speed` (`Infinity` snaps). `null` (or a target beyond `releaseAngle` of yaw) eases back to the rest pose. `base:'rest'` applies on top of the pose captured at construction (`captureRest()` to refresh); use `base:'current'` when an AnimationMixer writes the joints every frame before `update`. Properties `yaw`, `pitch`, `engaged` expose the current state.

## 4. Secondary motion: SpringChain

```js
const tail = new KE.SpringChain(THREE, tailJoints, {
  stiffness: 120, damping: 12, gravity: [0, -2, 0], inertia: 1, maxAngle: Math.PI * 0.6,
  drag: 0, substep: 1 / 120, maxSubsteps: 8, tip: 'auto',
  colliders: [{ object: body, offset: [0, 0.1, 0.2], radius: 0.25 }], groundAt: null, radius: 0.02,
  wind: null, weight: 1, teleportDistance: 2, base: 'rest'
});
tail.update(dt);   // after the parent has moved this frame
```

Every child joint (and a virtual tip beyond the last joint: `'auto'` repeats the last bone, or pass a local offset, or `null` to omit) is a particle pulled toward its rest position relative to the already simulated parent, damped relative to that goal's velocity (so the chain does not drag through the air when the character moves steadily), plus gravity, `wind` (vector or `fn(time, out, index)`) and `drag`. Constraints restore bone length, cap the deflection from the rest direction at `maxAngle`, push particles out of sphere `colliders` (world `center` or `offset` local to `object`) and above `groundAt(x,z)`. The first joint rotates too (it is the tail root). Fixed substeps make it frame-rate independent (30 Hz and 144 Hz end within 1 cm in the tests). `stiffness` and `damping` may be arrays (per bone, last value repeats). `inertia` < 1 lets the chain follow part of the root translation rigidly. A jump larger than `teleportDistance` or `reset()` snaps to rest. `energy` is the largest particle speed (m/s). `weight` blends with the rest pose; `base:'current'` re-reads the rest pose each frame (only when an animation writes those joints every frame).

The rest pose also sags under gravity: with the defaults a horizontal 0.8 m chain droops about 0.16 m at the tip, since each link's sag rotates the next link's goal. Lower `gravity` or raise `stiffness` for stiffer appendages.

## 5. Pose blending, blend spaces and the state machine

### PoseBlender

`new KE.PoseBlender(THREE, objects, {position:true, rotation:true, scale:false})` accumulates weighted local transforms for procedural poses: `reset()`, `add(object|index, {position?, quaternion?, scale?}, weight)`, `addPose(snapshot, weight)` (a `capture()` Float32Array of 10 floats per object), `apply()`. Rotations are nlerped in the rest pose's hemisphere; weight missing from 1 is filled with the rest pose captured at construction (`captureRest()`).

### BlendSpace1D / BlendSpace2D

```js
const loco = new KE.BlendSpace1D([
  { value: 0,   action: idleAction },
  { value: 1.4, action: walkAction },
  { value: 4,   action: runAction }
], { sync: true, smoothing: 0 });
loco.update(speed, dt);             // returns the weight array (entry order sorted by value)
const strafe = new KE.BlendSpace2D([{ x: 0, y: 0, pose: fn }, { x: 1, y: 0, pose: fn }, /* … */], { method: 'triangulate' });
strafe.update(vx, vz, dt);
```

Entries hold an `AnimationAction` (weights are set with `setEffectiveWeight`; actions are started when needed) or a `pose(weight, dt, time, phase)` callback (with `duration` for sync). 1D blends the two neighbours linearly and clamps outside the range. 2D triangulates the samples (Bowyer–Watson Delaunay on normalized coordinates) and uses barycentric weights, projecting outside points onto the nearest hull edge; `method:'idw'` (or colinear samples) uses inverse-distance weighting with `power`. `sync:true` drives all actions with one normalized phase whose speed follows the weighted cycle length, so feet stay in step during the blend. `smoothing` (1/s) eases weight changes. `weight` (set by the state machine) scales all weights.

### AnimStateMachine

```js
const fsm = new KE.AnimStateMachine({ params: { speed: 0, grounded: true }, mixer });   // or (THREE, {…})
fsm.addState('idle', { action: idle })
   .addState('move', { blend: loco, param: 'speed' })
   .addState('jump', { action: jump, loop: false, notifies: [{ t: 0.1, fn: () => sfx('jump') }] })
   .addTransition('idle', 'move', { when: p => p.speed > 0.1, duration: 0.25 })
   .addTransition('move', 'idle', { when: p => p.speed < 0.05, duration: 0.3 })
   .addTransition('*', 'jump', { trigger: 'jump', duration: 0.1, priority: 10 })
   .addTransition('jump', 'idle', { exitTime: 1, duration: 0.2 });
fsm.set('speed', v); fsm.trigger('jump');
fsm.update(dt);    // also calls mixer.update(dt) when a mixer was given
```

States: `action` (AnimationAction; looping per `loop`), `pose(weight, dt, time, state)`, or `blend` (a blend space fed from `param`: a parameter name, `[xName, yName]`, or `fn(params)`); plus `speed` (number, parameter name or `fn(params)`), `duration` (for pose states), `onEnter`, `onExit`, `onUpdate`, `notifies` (`{t: normalized time, fn}`, fired once per loop on the current state). Transitions: `from` (name, array or `'*'`), `to`, `when(params, fsm)`, `trigger` (a param consumed when the transition fires), `exitTime` (normalized; a transition with no condition waits for the end, 1), `duration`, `ease`, `priority`, `allowSelf`.

A crossfade starts from the current weights of every active state, so interrupted fades stay continuous and weights always sum to 1 (verified each frame in the tests, with procedural states and with real mixer actions). States that fade to zero are stopped. `play(name, duration)` forces a state. Read `state`, `previous`, `normalizedTime`, `blending`, `weightOf(name)`, `weights`; hooks `onEnter/onExit/onTransition`.

## 6. Procedural locomotion: ProceduralGait

```js
// root: the object your game moves (position on the ground, yaw); body: a child Group that holds the
// visual parts and the legs. The gait owns body's transform and the leg joints' rotations.
const gait = new KE.ProceduralGait(THREE, {
  body, root: body.parent, heightAt: (x, z) => terrain.heightAt(x, z),
  legs: [
    { hip: hipFL, knee: kneeFL, foot: pawFL, group: 0 },
    { hip: hipFR, knee: kneeFR, foot: pawFR, group: 1 },
    { hip: hipBL, knee: kneeBL, foot: pawBL, group: 1 },
    { hip: hipBR, knee: kneeBR, foot: pawBR, group: 0 }
  ],
  stepLength: 0.45, stepHeight: 0.12, stepDuration: 0.18, lean: 0.15, pelvisAdjust: true
});
// every frame, after moving root:
gait.update(dt, velocity /* optional world Vector3; derived from root motion when omitted */);
```

Legs: `hip`, optional `knee`, `foot` (nested hip > knee > foot; hips must descend from `body`), `group` (default `index % 2`; feet of one group swing together and groups swing in order 0, 1, …), optional `rest` (foot rest point in body space; default: its current position), `pole` (knee pole in body space; default: the knee's current bend direction), `footOffset` (foot joint height above the ground at rest; default measured).

How it works: planted feet stay exactly on their contact points. Each foot's drift is measured from its home point (rest point under the root, on `heightAt`) predicted half a step ahead with the current velocity and yaw rate, so stance sweeps are centered on the hip when walking straight, curving or turning in place. One group swings at a time; the next lifts after drifting `trigger`·stepLength, or earlier if a waiting group would otherwise exceed `maxDrift`·stepLength before its turn (short catch-up steps when starting or speeding up). The landing point is re-predicted during the swing; the paw follows a raised arc that clears bumps, curls (`toeCurl`) and aligns to the ground normal on landing (`footAlign`). Swing time shortens with speed (cadence rises). At idle, feet farther than `settleDistance` from home are stepped back under the hips one group at a time, and the body breathes (`breathe`).

The body follows a least-squares plane through the home ground points (legs with knees) or the actual footholds (knee-less legs), times `slopeAlign`, clamped to `maxTilt`; leans against acceleration (`lean`, saturating at `leanAccel` m/s²); bobs (`bob`) and sways (`sway`) with the swing; and its height is kept inside the window where every planted foot is reachable (`pelvisAdjust`: not farther than `reach`·leg length, not closer than `minReach`·length). Legs with knees are solved with `IK.twoBone`; knee-less legs (a single Group per leg, like Spirit Isle's fox) are aimed at the foot target and stretched along the leg axis by at most `legStretch`.

Options (defaults): `root` (body.parent), `stepLength .45`, `stepHeight .12`, `stepDuration .18`, `bodyHeight` (pivot height above ground; default the rest height), `lean .15`, `leanAccel 8`, `pelvisAdjust true`, `forward [0,0,-1]`, `slopeAlign` (.85 with knees, 1 without), `slopeFeet` (0 with knees, 1 without), `maxTilt .6`, `bob stepHeight·.18`, `sway stepLength·.03`, `breathe .004`, `idleSpeed .05`, `settleDistance stepLength·.14`, `smoothing 10`, `footAlign .7`, `toeCurl .5`, `reach .985`, `minReach` (.35 with knees, (1−legStretch)/reach without), `trigger .95`, `maxDrift 1`, `legStretch .15`, `pivot` (body-space point the body tilts about; default the hips' centroid), `onFootPlant(leg, index, contactWorld, gait)`, `onFootLift(leg, index, fromWorld, gait)` (footstep sounds, dust). Distances are in root units and scale with the root's world scale.

State: `pitch`, `roll`, `height`, `speed`, `drift`, `yawRate`, `stepCount`, `history` (last 64 lifted groups), `planted` (all feet down), `legs[i]` (`planted`, `contact`, `home`, `swingT`, …), `heightMin/heightMax` (last reach window). `reset()` (or moving the root more than max(2, 8 steps) in one frame) snaps feet to their homes.

Measured in the tests (60 Hz, wavy terrain with ±0.5 m relief and slopes up to about 17°, straight, curved, 0.7–2.2 m/s, turning in place at 2 rad/s): legs with knees keep every planted foot within 1 cm (in practice under 0.01 mm); diagonal groups alternate strictly; body pitch correlates with the terrain slope (r ≈ 0.98). Knee-less legs can only change length by ±15 %, so on the same terrain 99.6 % of planted samples stay within 1 cm and the worst is about 3 cm (on flat ground they are exact).

Spirit Isle integration: the starter's hero Group is both the moved object and the parent of the legs, so wrap the parts in a body Group first, then remove the starter's sine-driven leg rotation and vertical bob:

```js
const foxBody = new THREE.Group();
while (hero.children.length) foxBody.add(hero.children[0]);
hero.add(foxBody);
const foxGait = new KE.ProceduralGait(THREE, { body: foxBody, heightAt: ground,
  legs: foxLegs.map((leg, i) => ({ hip: leg, foot: leg.children[2], group: i === 0 || i === 3 ? 0 : 1 })) });
// per frame, after hero.position/rotation are set: foxGait.update(dt, {x: player.vx, y: 0, z: player.vz});
```

## 7. Cinematics

### Sequencer

```js
const seq = new KE.Sequencer(THREE, { loop: false, speed: 1 });
seq.addTrack({ target: door, path: 'rotation.y', keys: [{ t: 0, value: 0 }, { t: 1.5, value: -1.6, ease: 'inOutCubic' }] });
seq.addTrack({ target: cameraA, path: 'position', interp: 'cubic', keys: [{ t: 0, value: [0, 2, 8] }, { t: 2, value: [3, 2, 5] }, { t: 4, value: [6, 3, 0] }] });
seq.addTrack({ target: light, path: 'intensity', keys: [{ t: 0, value: 0, interp: 'step' }, { t: 2, value: 3 }] });
seq.addCameraCut({ t: 0, camera: cameraA }).addCameraCut({ t: 2.5, camera: cameraB });
seq.addEvent({ t: 1.5, fn: () => audio.play('creak'), name: 'creak' });
seq.onCameraCut = (camera) => { activeCamera = camera; };
seq.play();
// per frame: seq.update(dt); render with seq.camera || defaultCamera
```

Tracks animate any property path with the value types listed under tweens. A key's `interp` (`'linear'` default, `'cubic'` Hermite with finite-difference tangents for non-uniform key times, `'step'`) and `ease` control the segment that starts at that key; quaternion tracks slerp (cubic tracks are renormalized). Values hold before the first and after the last key.

`play()`, `pause()`, `stop()` (seek 0), `seek(t, {fireEvents:false})`, `update(dt)`, `time`, `duration` (the last key/cut/event unless set), `playing`, `loop`, `speed` (negative plays backwards; events fire backwards only with `reverseEvents:true`), `camera` (active cut), `onFinish`, `onCameraCut(camera, previous)`, `onUpdate(t)`. Events fire exactly once when playback crosses their time, including across loop wraps; seeking does not fire them. `toJSON()` stores tracks, cuts and named events with targets referenced by `name` (or `uuid`); `KE.Sequencer.fromJSON(THREE, json, sceneOrResolver, {eventName: fn})` rebuilds it (`resolver(id)` may be a function). Event callbacks are never serialized as code.

### CameraRail

```js
const rail = new KE.CameraRail(THREE, [[0, 3, 10], [6, 4, 4], [2, 5, -6]], { closed: false, lookAt: null, lookAhead: 0.02, roll: 0 });
rail.apply(camera, t);   // t in [0,1] (wraps when closed)
```

A Catmull–Rom spline (centripetal by default; an explicit `tension` selects the uniform variant with that tension) parameterized by arc length, so constant `t` speed means constant camera speed. The camera looks at `lookAt` (Vector3 or Object3D) or `lookAhead` further along the rail. `roll` may be a number or `fn(u)`. Also `getPoint(t)`, `getTangent(t)`, `getLookTarget(t)`, `length`, `createHelper(divisions, color)` (a Line you add and dispose).

### CameraShake

```js
const shake = new KE.CameraShake(THREE, { maxYaw: .06, maxPitch: .06, maxRoll: .09, maxOffset: [.12, .12, .06], frequency: 16, decay: 1.1, exponent: 2, seed: 7 });
shake.add(0.5);                // trauma 0..1
shake.update(dt, camera);      // after your camera controller, before rendering
```

Trauma model: intensity = trauma^`exponent` scales seeded, multi-octave 1D gradient noise per channel; trauma decays linearly by `decay` per second. The previous frame's offset is removed first when the camera was not moved since (`restore(camera)` does it manually), so it composes with controllers that rewrite the camera every frame and with static cameras.

## 8. Root motion, bone chains and skinned tubes

`new KE.RootMotion(THREE, clip, {track: null, axes: 'xz', inPlace: true})` finds the first `.position` track (or the named one), optionally flattens the chosen axes in the clip so it plays in place, and `update(action, outVector3)` returns the clip-space displacement since the previous call, including loop wrap-around (`reset(action)` first). Rotate it by the character's facing and move your controller.

`KE.createBoneChain(THREE, count, length=.1, {direction, parent, name})` builds nested `THREE.Bone`s (`length` may be an array).

`KE.buildSkinnedTube(THREE, bones, {radius:.08 | fn(u), segments:12, rings:4, tip:'auto', material, color: hex | fn(u, colorOut), capRings:4, capStart:true, capEnd:true, up:[0,1,0]})` returns a `SkinnedMesh` around a bone chain: rings follow a centripetal Catmull–Rom curve through the bone origins with parallel-transport frames, each ring skinned to its bone and blended half-way into the neighbour near joints, with rounded caps. The mesh is added to the root bone's parent and bound in the current pose. It owns its geometry, and its material unless you pass one (`mesh.userData.keTube.ownsMaterial`); dispose them (e.g. `KE.disposeObject`). Pair it with `SpringChain` for tails, antennae, tentacles and ropes.

## 9. Cost, quality and limitations

All work is CPU and scales with joint counts: two-bone IK is a handful of quaternion operations; `IKChain` is O(joints × iterations); `SpringChain` is O(joints × substeps) (substeps capped by `maxSubsteps`); `ProceduralGait` per update costs a two-bone solve per leg plus about 3 + 2 `heightAt` calls per leg (keep `heightAt` cheap, e.g. the terrain's `heightAt`). No `KE.settings` quality key changes their results; for distant characters, update them at a lower rate or skip secondary motion (for example when `KE.settings.lod` is low).

Limitations: solvers assume uniformly scaled parents. `IKChain` constraints are simple per-joint hinge/cone limits relative to the rest pose, not a full-body solver; CCD ignores `pole`. `LookAt` distributes yaw/pitch but does not roll. `SpringChain` collides particles (not bone segments) with spheres and a height field. `ProceduralGait` is reactive (no clip-based foot phases); it assumes a character that stays upright (no climbing walls or ceilings), one gait style set by groups and timing (it does not switch trot to gallop), and knee-less legs are only approximately planted on steep terrain (see numbers above). Speeds beyond roughly 3 × stepLength / (2·stepDuration) outrun the stepping; raise `stepLength` or lower `stepDuration` for fast creatures. `BlendSpace2D` weights are piecewise linear. The sequencer is a runtime player with JSON storage, not an editor.
