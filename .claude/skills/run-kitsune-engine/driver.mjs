// REPL driver for kitsune engine games (built single-file HTML, e.g. spirit-isle.html).
// Launches headless Chromium with software WebGL2 (SwiftShader), opens the game from file://,
// and exposes line commands on stdin. Commands run strictly in order, so a script can be piped in:
//   node .claude/skills/run-kitsune-engine/driver.mjs <<'EOF'
//   launch spirit-isle.html
//   start
//   ss day
//   quit
//   EOF
// or run it under tmux and send-keys one command at a time. Screenshots go to $SHOT_DIR (/tmp/kitsune-shots).
import { createRequire } from 'node:module';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const UNIT = path.resolve(import.meta.dirname, '../../..');
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/kitsune-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });
let playwright = null;
for (const id of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { playwright = require(id); break; } catch {} }
if (!playwright) { console.log('ERROR: playwright not found (npm i -g playwright, or set NODE_PATH)'); process.exit(1); }

let browser = null, page = null;
const errors = [], requests = [];
const need = () => { if (!page) throw new Error('launch first'); };
const wait = ms => new Promise(r => setTimeout(r, ms));
// SwiftShader renders the HDR pipeline at ~1 frame/s: screenshots wait for a frame, so give them minutes.
const SHOT_TIMEOUT = 300_000;

const COMMANDS = {
  // launch [file.html] [width height] — default spirit-isle.html at 960x600. Waits for window.demo (the game's debug handle) or an error card.
  async launch(arg) {
    if (browser) return console.log('already launched');
    const [file = 'spirit-isle.html', w = '960', h = '600'] = arg.split(/\s+/).filter(Boolean);
    const abs = path.resolve(UNIT, file);
    if (!fs.existsSync(abs)) throw new Error('no such file: ' + abs);
    browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
    page = await browser.newPage({ viewport: { width: +w, height: +h } });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
    page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
    const t0 = Date.now();
    // Fail fast: a script that throws while loading never creates window.demo, so race the wait against the first page error.
    const firstError = new Promise(resolve => page.once('pageerror', e => resolve(e.message)));
    await page.goto('file://' + abs);
    const ready = page.waitForFunction(() => window.demo || document.querySelector('.error'), null, { timeout: 240_000 }).then(() => null);
    const thrown = await Promise.race([ready, firstError]);
    if (thrown) return console.log('GAME ERROR (page error while loading): ' + thrown);
    const ok = await page.evaluate(() => !!window.demo);
    console.log(ok ? `launched ${file} in ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'GAME ERROR: ' + await page.evaluate(() => document.querySelector('.error').innerText));
  },
  // start — press "Enter Spirit Isle" (enables input, dismisses the welcome card)
  async start() { need(); await page.click('#start'); console.log('started'); },
  // ss [name] — screenshot to $SHOT_DIR/<name>.png
  async ss(name) { need(); const f = path.join(SHOT_DIR, (name || `ss-${Date.now()}`) + '.png'); await page.screenshot({ path: f, timeout: SHOT_TIMEOUT }); console.log('screenshot:', f); },
  // preset low|medium|high|ultra|cinematic — applies the quality preset; render scale forced to 1 and dynamic resolution off (at ~1 fps it would drop to the minimum)
  async preset(name) { need(); console.log(JSON.stringify(await page.evaluate(n => { demo.KE.applyPreset(n); demo.KE.setSettings({ scale: 1, dynamicRes: false }); const p = demo.pipeline && demo.pipeline(); return { preset: demo.KE.settings.preset, pipeline: !!(p && p.enabled) }; }, name))); },
  // day <0..1> — time of day (0 sunrise, .33 noon, .6 sunset, .84 night)
  async day(v) { need(); await page.evaluate(v => demo.setDay(+v), v); console.log('day', v); },
  // rain on|off
  async rain(v) { need(); await page.evaluate(v => demo.setRain(v === 'on'), v); console.log('rain', v); },
  // hold <KeyCode> <ms> — hold a key (KeyW forward, Space jump, KeyQ/KeyE turn). Wall-clock ms; at ~1 fps the game sees few frames.
  async hold(arg) { need(); const [code, ms = '1500'] = arg.split(/\s+/); await page.keyboard.down(code); await wait(+ms); await page.keyboard.up(code); console.log('held', code, ms + 'ms'); },
  async press(key) { need(); await page.keyboard.press(key); console.log('pressed', key); },
  async click(sel) { need(); await page.click(sel, { timeout: 30_000 }); console.log('clicked', sel); },
  // cvar <name> [value] — read or set an engine console variable, e.g. "cvar r.TAA 0", "cvar r.ViewMode ao"
  async cvar(arg) { need(); const [n, v] = arg.split(/\s+/); console.log(JSON.stringify(await page.evaluate(([n, v]) => v === undefined ? KitsuneEngine.cvars.get(n) : KitsuneEngine.cvars.set(n, v), [n, v]))); },
  // state — player position, day and collected stones
  async state() { need(); console.log(JSON.stringify(await page.evaluate(() => demo.getState()))); },
  // stats — engine version, modules, renderer counters, pipeline passes and on-screen stats text
  async stats() { need(); console.log(JSON.stringify(await page.evaluate(() => { const p = demo.pipeline && demo.pipeline(), r = demo.renderer.info; return { version: KitsuneEngine.version, modules: Object.keys(KitsuneEngine.modules), preset: KitsuneEngine.settings.preset, pipeline: !!(p && p.enabled), passes: p ? p.stats.passes : 0, calls: r.render.calls, triangles: r.render.triangles, programs: r.programs.length, textures: r.memory.textures }; }), null, 1)); },
  // eval <js> — evaluate in the page (window.demo, window.KitsuneEngine, window.THREE are available)
  async eval(expr) { need(); console.log(JSON.stringify(await page.evaluate(expr))); },
  // wait <ms>
  async wait(ms) { await wait(+ms || 1000); console.log('waited', ms); },
  // viewport <w> <h> — e.g. "viewport 390 844" for a phone portrait layout
  async viewport(arg) { need(); const [w, h] = arg.split(/\s+/).map(Number); await page.setViewportSize({ width: w, height: h }); console.log('viewport', w, h); },
  // errors — page errors, console errors and any http(s) requests seen (a built game should make none)
  errors() { console.log(errors.length ? errors.join('\n') : 'no page/console errors'); console.log(requests.length ? 'NETWORK: ' + requests.join(', ') : 'no network requests'); },
  async quit() { if (browser) await browser.close().catch(() => {}); browser = page = null; console.log('bye'); },
  help() { console.log('commands:', Object.keys(COMMANDS).join(', ')); },
};

// Serialize commands: piped input delivers all lines at once, and each command must finish before the next.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'kitsune> ', terminal: process.stdin.isTTY });
let queue = Promise.resolve();
rl.on('line', line => {
  queue = queue.then(async () => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (!cmd || cmd.startsWith('#')) return;
    const fn = COMMANDS[cmd];
    if (!fn) return console.log('unknown:', cmd, '- try: help');
    try { await fn(rest.join(' ')); } catch (e) { console.log('ERROR:', e.message.split('\n')[0]); }
    if (cmd === 'quit') process.exit(0);
    if (process.stdin.isTTY) rl.prompt();
  });
});
rl.on('close', () => { queue = queue.then(async () => { await COMMANDS.quit(); process.exit(0); }); });
console.log('kitsune driver - "help" for commands, "launch [file.html]" to start');
if (process.stdin.isTTY) rl.prompt();
