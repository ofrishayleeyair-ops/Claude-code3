# Audio (Tenko) · 3.0.0

`src/modules/80-audio.js` (module name `audio`) adds a Web Audio mixer and sound library: spatial voices with HRTF panning that follow a camera and scene objects, a bus tree with volume/mute/ducking, procedural convolution reverb with position-blended zones, occlusion filtering, voice limiting with priority stealing, an offline-rendered procedural one-shot library (`KE.Synth`), randomised sound cues (`KE.SoundCue`), live generative ambience beds and a generative music player. No audio files are loaded: every sound is built from oscillators, seeded noise, filters and envelopes. The small 2.x `KE.Audio` (`tone()`) in `core.js` is unchanged.

Every API keeps working when Web Audio is missing or the engine was disposed: calls return inert voices/buses/music objects and never throw.

## Contents

1. Setup and frame loop
2. KE.AudioEngine
3. Buses and ducking
4. play() and voices
5. Spatial audio, occlusion, voice limits
6. Reverb presets and zones
7. KE.Synth (procedural one-shots)
8. KE.SoundCue
9. Ambience beds
10. Generative music
11. Stats, meter, dispose
12. Quality settings and cost
13. Limits

## 1. Setup and frame loop

```js
const KE = window.KitsuneEngine;
const audio = new KE.AudioEngine(THREE, {volume: .8});        // THREE is optional: new KE.AudioEngine({volume:.8})
startButton.onclick = async () => { await audio.unlock(); };    // browsers start contexts 'locked' until a gesture
audio.preload(['footstep', 'chime', KE.Synth.impact({hardness: .8})]);   // render ahead (optional)

audio.setReverb({preset: 'forest', wet: .25});
audio.addReverbZone({center: [30, 2, -12], radius: 8, preset: 'cave', wet: .5});
audio.setOcclusion((from, to) => physics.raycastAny(from, to) ? 1 : 0);  // any 0..1 function

const fire  = audio.ambience('fire', {position: campfire.position, intensity: .6});
const birds = audio.ambience('forest-day', {intensity: .7});
const music = audio.music({mood: 'calm', intensity: .4});

// gameplay
audio.play(KE.Synth.footstep({surface: 'stone', intensity: .8}), {position: player.position, volume: .7});
audio.play('pickup', {bus: 'ui'});

// every frame (after moving objects, before or after rendering)
audio.update(dt, camera);
```

`update(dt, camera)` moves the listener to the camera (position, forward = -Z, up = +Y of its world matrix), moves spatial voices to their `follow` objects, smooths occlusion, blends reverb zones and schedules ambience/music events. When the page cannot call it (paused game), a 100 ms timer keeps ambience and music scheduling alive; nothing else needs it.

## 2. KE.AudioEngine

`new KE.AudioEngine(THREE?, options)`. Options and defaults:

| option | default | meaning |
|---|---|---|
| `volume` | 1 | master bus volume |
| `context` | null | inject an `AudioContext` or `OfflineAudioContext` (tests, offline bounces). Injected contexts are never closed by `dispose()` |
| `maxVoices` | quality (24–64) | voice limit before stealing |
| `panningModel` | quality (`'HRTF'`, `'equalpower'` on Low) | default panner model |
| `distanceModel`, `refDistance`, `maxDistance`, `rolloff` | `'inverse'`, 2, 60, 1 | defaults for spatial voices (Web Audio PannerNode semantics) |
| `doppler` | 0 | 0..1 amount of doppler pitch shift for buffer voices (velocities are derived from positions) |
| `speedOfSound` | 343 | units per second for doppler |
| `autoUnlock` | true | resume the context on the first pointer/key/touch event |
| `busSmoothing` | .05 | seconds for `bus.volume = x` fades |
| `ducking` | `KE.AudioEngine.DUCKING` | auto-ducking rules (section 3) |
| `limiter` | `'softclip'` | output safety stage: `'softclip'` (unity gain below 0.85, tanh knee to exactly ±1), `'compressor'` (DynamicsCompressor) or `false` |
| `latencyHint`, `sampleRate` | `'interactive'`, device | passed to the `AudioContext` constructor |
| `suspendWhenHidden` | false | suspend the context while the tab is hidden |

Properties: `state` is `'locked'` (never started by a gesture), `'running'`, `'suspended'` (was running) or `'unavailable'` (no Web Audio, closed or disposed); an `OfflineAudioContext` always reports `'running'`. `context`, `currentTime`, `sampleRate`, `listener` (`{x,y,z,fx,fy,fz,ux,uy,uz,vx,vy,vz}`), `voices`, `buses`, `quality`, `maxVoices`, `panningModel`.

Methods:

- `await unlock()` → `true` when running. Resumes from a user gesture and plays a one-sample buffer (iOS unlock). Never hangs: gives up after 400 ms if the browser refuses. `resume()` is an alias; `suspend()` → Promise<boolean>.
- `update(dt, camera?)` — per-frame update (see above). Allocation-free; idle voices schedule no automation.
- `setListener(position, forward?, up?, dt?)` — manual listener placement without a camera.
- `bus(name)`, `createBus(name, {parent='sfx', volume=1, reverbSend=1, priority})` — section 3.
- `setDucking(rules)` — replace the auto-ducking rules (`false`/`{}` disables).
- `play(source, options)` → `AudioVoice` (section 4). `preload(items)` → Promise of rendered buffers.
- `ambience(name, options)` → `AudioVoice` (section 9). `music(options)` → `KE.AudioMusic` (section 10).
- `setOcclusion(fn, {cutoff=650, attenuation=.65, rate=8})`, `setReverb({preset, wet, transition})`, `addReverbZone(zone)`, `removeReverbZone(zone)` (sections 5–6).
- `stopAll({fade=.2, buses=null})` — fade out every voice (optionally only those on the named buses) and music.
- `meter()` → `{peak, rms}` of the final output over the last ~46 ms (an AnalyserNode is created on first use).
- `stats()`, `dispose()` (section 11).

Statics: `KE.AudioEngine.QUALITY`, `REVERB_PRESETS`, `MOODS`, `SCALES`, `AMBIENCES`, `DUCKING`, `impulseResponse(ctx, preset, maxSeconds)` (the generated IR buffer, cached).

## 3. Buses and ducking

```
master ─┬─ music      (reverb send 0, priority 10)
        ├─ ui         (reverb send 0, priority 3)
        └─ world ─┬─ sfx      (reverb send .5, priority 1)
                  ├─ ambience (reverb send .2, priority 8)
                  └─ voice    (reverb send .35, priority 6)
```

`audio.bus(name)` returns an `AudioBus` for `'master' | 'world' | 'music' | 'sfx' | 'ambience' | 'ui' | 'voice'` or a custom bus (`createBus('footsteps', {parent:'sfx', volume:.8})`). Unknown names throw a `RangeError` (inert buses are returned when audio is unavailable); `play()` with an unknown bus name warns once and uses `sfx`.

Each bus has a dry chain (input → fader → ducker → parent) and a mirrored reverb-send chain, so volume, mute and ducking also scale the reverb that bus feeds. The `world` bus carries the environment filter used by the underwater preset; music and UI are never filtered.

| member | meaning |
|---|---|
| `volume` (get/set) | fader, ramped over `busSmoothing` |
| `mute` (get/set) | 30 ms fade to/from silence; volume is kept |
| `reverbSend` (get/set) | send level of voices on this bus |
| `fadeTo(v, seconds)` | explicit fade |
| `duck(amount=.5, attack=.05, release=.5, hold=0, holder=null)` | reduce by `amount` (0..1) over `attack`, keep for `hold` seconds (`Infinity` = until released), release over `release`. Overlapping ducks combine by maximum and are scheduled sample-accurately; releasing never jumps |
| `release(holder?)` | release ducks held by `holder` (all when omitted) using their release times |
| `duckLevel` | current multiplier (1 = not ducked) |

Auto-ducking: a voice starting on a bus that has a rule (inherited from parent buses) ducks the rule's target buses for its lifetime (loops and ambience until stopped). The default rule is dialogue only: `voice → {music:.55, ambience:.35, sfx:.15}, attack .08, release .6`. Per voice, `play(..., {duck: false})` opts out, `duck: .4` ducks the rule targets (or `music` when there is no rule) by 0.4, and `duck: {targets:{music:.6, ambience:.3}, attack, release}` defines an ad-hoc rule.

## 4. play() and voices

`audio.play(source, options)` accepts:

- an `AudioBuffer`;
- a synth name (`'footstep'`) with synth parameters in `options` or `options.params`;
- `KE.Synth.<name>(params)` or `{synth, params}`;
- a `Promise<AudioBuffer>`;
- a `KE.SoundCue`.

Synth sources render once per (parameters, sample rate) and are cached; an uncached render leaves the voice `'pending'` for a few milliseconds and starts it when ready (use `preload`). When no explicit `seed` is given, successive plays of a recipe cycle through its variations (6 footsteps, 4 impacts, …), which `preload` renders together. One-shots requested while the engine is `'locked'` are dropped (returned inert with `reason:'locked'`) instead of piling up for the unlock; loops, ambience and music queue. Pass `force:true` to queue a one-shot anyway.

Options:

| option | default | meaning |
|---|---|---|
| `bus` | `'sfx'` | output bus |
| `volume`, `pitch` | 1, 1 | gain and playback rate |
| `loop` | false | loop the buffer |
| `position` | — | `Vector3` or `[x,y,z]`; makes the voice spatial |
| `follow`, `offset` | — | `Object3D` whose world position the voice tracks each `update()`; optional offset |
| `spatial` | auto | force spatial on/off (default: spatial when `position` or `follow` is given) |
| `refDistance`, `maxDistance`, `rolloff`, `distanceModel`, `panningModel` | engine defaults | panner settings |
| `cone`, `direction` | — | `{inner=90, outer=220, outerGain=.3}` directional source; direction follows the `follow` object's +Z |
| `occlusion` | true | participate in occlusion tests |
| `fadeIn` | 0 | seconds (a 4 ms fade is always applied to buffers that are not edge-faded synth renders) |
| `startAt`, `delay` | 0, 0 | buffer offset in seconds; start delay |
| `priority` | bus priority | voice-stealing priority (higher survives) |
| `reverbSend` | 1 | per-voice send multiplier |
| `pan` | — | −1..1 stereo pan for non-spatial voices |
| `duck` | — | see section 3 |
| `params` | — | synth parameters |

`AudioVoice`:

| member | meaning |
|---|---|
| `state` | `'pending' \| 'playing' \| 'stopping' \| 'ended' \| 'inert'`; `playing` is true while pending or playing; `inert` and `reason` (`'unavailable' \| 'locked' \| 'limit' \| 'cooldown' \| 'cue-limit'`) for rejected voices |
| `stop({fade=.04})` / `stop(seconds)` | ramp to zero, then stop and release all nodes |
| `setVolume(v, ramp=.05)`, `setPitch(p, ramp=.05)`, `setPosition(x,y,z \| vec)` | live changes, always ramped |
| `set(name, value, ramp=.5)`, `params`, `intensity` (get/set) | live generator parameters of ambience voices |
| `dispose()` | immediate release (prefer `stop` for a click-free end) |
| `ready` | Promise<boolean> resolved when the voice starts (false if it never does) |
| `onended` | callback `(voice)` |
| `time`, `startTime`, `endTime`, `distance`, `occ`, `virtual`, `stolen`, `bus`, `id` | read-only state |

Click safety: every gain change is a ramp; synth buffers start and end at exactly zero (1.5 ms / 10 ms raised-cosine edges); arbitrary user buffers get a 4 ms fade-in and a 5 ms fade before their natural end; stopping always fades.

## 5. Spatial audio, occlusion, voice limits

Spatial chain per voice: amp → occlusion lowpass → distance/occlusion gain (mono downmix) → `PannerNode` → bus, plus a reverb send tapped before the distance gain. Listener and panner positions glide with a 15 ms time constant (no zipper noise from per-frame steps); while the audio clock is not running they are written directly so no automation piles up.

- Distance: the panner applies the Web Audio distance model; additionally the engine fades the voice to silence between 85% and 100% of `maxDistance` (the inverse model never reaches zero). The reverb send falls with the square root of the distance gain, so distant sources sound relatively wetter.
- Virtualization: looping buffer voices farther than 1.05 × `maxDistance` stop their source (it is silent there) and remember the phase; they restart in phase when the listener returns within range. Ambience generators keep running.
- Occlusion: `setOcclusion((from, to, voice) => 0..1, {cutoff=650, attenuation=.65, rate=8})`. The callback is evaluated round-robin for a quality-dependent number of voices per `update()` (2–16), smoothed with rate `rate`/s, and applied as a lowpass sweeping from 20 kHz to `cutoff` and a gain reduction of `attenuation` (the reverb send is reduced by only half as much). `from`/`to` are reused vectors — copy them if you keep them. Pass `null` to disable.
- Doppler (`options.doppler > 0`): pitch ratio from the smoothed source and listener velocities along the line of sight, clamped to 0.5–2, applied to buffer voices only.
- Voice limit: when `maxVoices` voices exist, a new voice steals the least important voice whose priority is ≤ its own (virtual voices first, then lowest priority, then oldest; the victim fades out in 25 ms). If every voice outranks it, the new voice is rejected (inert, `reason:'limit'`). Music notes are not counted (music has its own note budget).

## 6. Reverb presets and zones

Impulse responses are synthesized in JavaScript per sample rate and cached: two noise bands split at 1.2 kHz decay with separate RT60s (highs die faster), a build-up fade, damping lowpass, low cut, early-reflection taps after the pre-delay, mid/side width, then energy normalization so presets sit at comparable loudness.

| preset | RT60 target (s) | character |
|---|---|---|
| `none` | — | dry |
| `room` | 0.6 | short, dense early reflections |
| `forest` | 1.2 | sparse, clumped reflections, bright low cut |
| `hall` | 2.3 | smooth, wide |
| `cave` | 3.8 | long, dark, strong early reflections |
| `underwater` | 1.8 | very dark wobbling tail; also lowpasses the dry `world` bus to 900 Hz and lowers it ~2 dB |

The tests measure the generated IRs with Schroeder integration (T20 × 3): room 0.49 s, forest 1.0 s, hall 1.86 s, cave 3.43 s, underwater 1.85 s at the default seeds.

`setReverb({preset='none', wet, transition})`: `wet` 0..2 (kept when omitted, initially 0.3), `transition` seconds (default 1.5) for the crossfade. `addReverbZone({center=[0,0,0], radius | box:{min,max} | size, preset='cave', wet=.35, fade, priority, enabled=true})` returns the zone object (`remove()`, `weight`, `enabled`, `preset`, `wet`). Zones are weighted by listener position: 1 inside, smoothstep falloff over `fade` metres outside (default 30% of the radius or 15% of the largest box extent, at least 1). Smaller zones take priority; each takes its weight of what remains and the base preset gets the rest, so nested zones blend continuously.

The mix is rendered by a small pool of convolver slots (2 on Low/Medium, 3 above). A preset switch crossfades two slots; a slot is reused only after it has faded below −48 dB, so convolver buffers are never swapped under an audible tail (a third simultaneous preset waits for a free slot). Silent slots are disconnected once their tail has died so the browser can skip the convolution.

## 7. KE.Synth (procedural one-shots)

`KE.Synth.<name>(params)` returns a `KE.Synth.SynthSound` descriptor: `audio.play()` accepts it directly, and it is thenable, so `const buffer = await KE.Synth.chime({note:'E5'})` yields a stereo `AudioBuffer` (44.1 kHz). Renders use `OfflineAudioContext`, at most two at a time, and are cached (LRU, 192 buffers / 360 s of audio). Every buffer is high-passed at 25 Hz, peak-normalized to the recipe level, trimmed after its tail falls below −74 dB and edge-faded to exactly zero. Identical parameters and seed reproduce the same sound.

| recipe | parameters (defaults) | variations |
|---|---|---|
| `footstep` | `surface:'grass'` (`'grass' \| 'stone' \| 'wood' \| 'water' \| 'sand'`), `intensity:.7`, `seed:1` | 6 |
| `chime` | `note:'C5'` or `freq` (Hz, overrides note), `bell:true` (false = struck bar), `decay:2.4`, `brightness:.6`, `seed:1` | 1 |
| `impact` | `size:1` (0.1–5), `hardness:.5` (0 soft thud … 1 ringing metal), `seed:1` | 4 |
| `whoosh` | `duration:.6`, `brightness:.5`, `seed:1` | 3 |
| `click` | `tone:2400`, `seed:1` | 1 |
| `pickup` | `note:'A5'`, `seed:1` (rising arpeggio with shimmer) | 1 |
| `jump` | `seed:1` | 3 |
| `splash` | `size:1` (0.2–4), `seed:1` | 4 |
| `explosion` | `size:1` (0.25–4), `seed:1` | 3 |
| `thunder` | `distance:.4` (0 = crack overhead … 1 = distant rumble), `seed:1` | 3 |

Footsteps are two contacts (heel, toe) with surface-specific excitation: filtered noise and grain clusters for grass/sand, a ringing band plus grit for stone, modal wood resonances (and an occasional creak), splashes with Minnaert bubbles for water. Chimes and bells are modal synthesis (inharmonic bell/bar partial tables, detuned stereo pairs).

Utilities (non-enumerable, so `Object.keys(KE.Synth)` lists only recipes): `render(name, params, {sampleRate})` → Promise<AudioBuffer>; `get(name, params, sampleRate)` → cached buffer or null; `sound(name, params)`; `define(name, {defaults, duration(p), level, build(P, p), variants, channels, highpass})` to add recipes (`build` receives a `KE.Synth.Patch` with oscillator/noise/filter/envelope helpers); `names()`, `has()`, `defaults(name)`, `params(name, p)`, `key()`, `clearCache()`, `cacheStats()`, `setCacheLimit({entries, seconds})`, `analyze(buffer)` → `{peak, rms, dc, nan, headPeak, tailPeak, maxStep, duration, channels}`, `noteToHz`, `noteToMidi`, `midiToHz`, `noiseBuffer(ctx, 'white'|'pink'|'brown', variant)`.

## 8. KE.SoundCue

```js
const steps = new KE.SoundCue({
  variations: [KE.Synth.footstep({surface:'wood'}), 'footstep', {synth:'footstep', params:{surface:'wood', intensity:1}}],
  randomPitch: [.94, 1.06], randomVolume: .15, cooldown: .08, maxInstances: 3, bus: 'sfx'
});
audio.play(steps, {position: foot.getWorldPosition(v)});   // or steps.play(audio, options)
```

Options: `variations` (buffers, synth names, `KE.Synth` descriptors or `{synth, params}`; required), `randomPitch` / `randomVolume` (`[min, max]` multipliers, or a number x meaning `[1−x, 1+x]`), `cooldown` seconds (wall clock), `maxInstances` (default unlimited), `limit` (`'steal'` stops the oldest instance, `'reject'` returns an inert voice), `order` (`'shuffle'` bag without immediate repeats, `'random'`, `'sequential'`), `volume`, `pitch`, `seed`, plus any `play()` options as defaults. Methods: `play(audio, options)`, `preload(audio)`, `stopAll(fade)`, `next()`; `instances` counts playing voices.

## 9. Ambience beds

`audio.ambience(name, options)` returns a looping `AudioVoice` driven by a live generator (continuous filtered noise beds plus randomized events scheduled 0.6 s ahead on the audio clock). Options: generator parameters, `fadeIn` (1.5 s), `volume`, `bus` (`'ambience'`), `seed`, `priority` (8), and `position`/`follow` to make it spatial (a campfire, a stream). Change parameters live with `voice.set('intensity', .9, rampSeconds)` or `voice.intensity = .9`.

| name | parameters | content |
|---|---|---|
| `wind` | `intensity` .5, `gustiness` .6 | brown body, resonant band that moves with gusts, high hiss |
| `rain` | `intensity` .5 | light and heavy drop textures, hiss, rumble, occasional drips |
| `water` | `intensity` .5, `period` 6 s | shore waves: swell, foam wash, undertow |
| `fire` | `intensity` .5 | roar with flicker, crackle texture, pops |
| `forest-day` | `intensity` .5, `wind` .25 | leaf rustle, 5 birds of 6 seeded species singing repeated phrases |
| `night` | `intensity` .5 | cricket choir, pulsed crickets, frogs, owl calls |
| `stream` | `intensity` .5 | babbling resonances with slow random modulation, bubbles |

If scheduling stalls (a throttled background tab), missed events are skipped rather than played in a burst.

## 10. Generative music

```js
const music = audio.music({mood:'mysterious', intensity:.3});
music.intensity = .8;                 // layers fade in by threshold over ~2 s
music.setMood('triumphant', 4);       // crossfade to a new section
music.onBeat = (beat, time, mood) => {};   // audio-clock time of each beat
music.stop(3);
```

`music({mood='calm', intensity=.5, volume=1, tempo, key, scale, layers, seed, fadeIn=2, bus='music', pad, pluck})` → `KE.AudioMusic` with `setMood(mood, crossfade=4, overrides)`, `intensity` (get/set), `volume`, `tempo` (get/set, current section), `mood`, `state`, `playing`, `stop(fade=2)`, `dispose()`, `onBeat`, and counters `notes` / `counts`.

| mood | tempo | key / scale | layers |
|---|---|---|---|
| `calm` | 72 | D pentatonic | pad, pluck arpeggio, bass, bells |
| `mysterious` | 64 | A dorian | pad, pluck melody, bass, bells |
| `triumphant` | 96 | C major | pad, pluck arpeggio, bass, bells, percussion |
| `night` | 56 | E minor | pad, sparse melody, bass, bells |

Scales: `major, minor, dorian, pentatonic, minorPentatonic, lydian, mixolydian, phrygian, harmonicMinor`; keys are note names (`'F#'`) or pitch classes. Harmony is a weighted Markov chain over scale degrees with voice-led pad chords (the inversion that moves least), Euclidean-rhythm arpeggios or a weighted random-walk melody favouring chord tones, modal bells and a synthesized kit. Intensity controls layers (pad always; bass ≥ 0.18, pluck ≥ 0.35, bells ≥ 0.5, percussion ≥ 0.68, each faded in over a smoothstep) and density. The music has its own hall reverb and tempo-synced echo. The mix sits around −20 dBFS RMS (measured 0.089–0.098 RMS at intensity 0.9).

## 11. Stats, meter, dispose

`stats()` → `{state, voices, virtual, pending, total, maxVoices, stolen, rejected, cachedBuffers, cachedSeconds, ambience, music, musicNotes, reverb, reverbSlots:[{preset,target,active}], zones, sampleRate, currentTime, panningModel, buses:{name:{volume,mute,duck}}}`.

`dispose()` releases every voice, generator, music player, reverb slot and bus node, removes listeners and closes the context if the engine created it. It is immediate; call `stopAll({fade})` first and wait for a click-free exit. After disposal `state` is `'unavailable'` and all calls are inert.

## 12. Quality settings and cost

The tier follows `KE.settings.preset` and is re-read on the `settings` event (new voices and reverb loads use it).

| preset | max voices | panning | IR length cap | reverb slots | occlusion tests / update | music note budget |
|---|---|---|---|---|---|---|
| low | 24 | equal-power | 1.6 s | 2 | 2 | 72 sources |
| medium | 32 | HRTF | 2.5 s | 2 | 4 | 120 |
| high | 48 | HRTF | 3.5 s | 3 | 8 | 192 |
| ultra | 64 | HRTF | 5 s | 3 | 12 | 288 |
| cinematic | 64 | HRTF | 6 s | 3 | 16 | 384 |

Main costs: HRTF panners (one per spatial voice) and convolution (proportional to IR length × active slots; the music player adds one ≤3 s convolver). Each spatial voice costs a biquad, two gains and a panner; ambience beds run 3–12 continuous sources each. Synth renders happen off the audio thread in OfflineAudioContext (2–60 ms per sound in headless Chromium on the test machine); `preload` at load time avoids first-play latency.

## 13. Limits

- Reverb is statistical (noise IRs), not geometric; zones blend by listener position only, and at most 2–3 presets sound at once.
- Occlusion is whatever the callback returns (e.g. a physics raycast); there is no diffraction, portal or propagation model.
- HRTF uses the browser's built-in dataset; no near-field or custom HRTFs; distance air absorption is not modelled beyond the occlusion filter.
- Doppler affects buffer voices only (not ambience generators or music) and is off by default.
- Ambience and music schedule 0.6 s ahead; parameter changes on already-scheduled events take effect within that window (wind reschedules immediately).
- Music is a lightweight generative sequencer: no stingers, transitions only by crossfade, one tempo per section.
- One-shots played before the first user gesture are dropped by design; `SoundCue` cooldowns use wall-clock time.
- `dispose()` cuts sound immediately; `voice.dispose()` likewise — use `stop({fade})` for click-free ends.

Tests: `node source/scripts/test_audio.cjs` (OfflineAudioContext renders of every recipe, spatial panning with a moving camera/object, bus ducking curves, reverb decay, zones, occlusion, stealing, cues, ambience, music, dispose, an unavailable context, and a real AudioContext under `--autoplay-policy=no-user-gesture-required`). It writes `.test-output/audio-sheet.png` with waveforms and spectrograms.
