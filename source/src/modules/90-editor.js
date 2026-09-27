/* kitsune enginev3 in-browser level editor and developer console.
   KE.Editor: dockable editor UI over a running KE.GameWorld — toolbar, viewport with TransformControls gizmo,
   fly camera, picking, outliner, schema-driven details panel, place-actors drawer, structured Blueprint
   editor, output log, undo/redo command stack, Play-In-Editor with snapshot restore, level save/load and
   glTF import/export. Nothing runs per frame while it is closed; closing removes its DOM and listeners.
   KE.ConsoleUI: backquote console for cvars and commands (help, stat fps|unit|none, show, list, clear)
   that works with or without the editor. */
(function(){'use strict';
const KE=window.KitsuneEngine;if(!KE)throw new Error('Load kitsune core before its modules');
const clamp=KE.clamp||((v,a,b)=>Math.min(b,Math.max(a,v)));
const DEG=Math.PI/180,RAD=180/Math.PI;
const hasDOM=typeof document!=='undefined';

/* ---------- scoped stylesheet (reference counted: removed when neither editor nor console needs it) ---------- */
const CSS=`
.ke-ed-root,.ke-ed-console,.ke-ed-stat,.ke-ed-menu{--bg:#131417;--panel:#1b1c20;--panel2:#222328;--raise:#2c2e34;--line:#0a0b0d;--edge:#33353c;--text:#d8dade;--muted:#8d919b;--dim:#5d616a;
  --accent:#3d8cff;--accentbg:#1d3f73;--sel:#f3a43a;--ok:#46c46f;--warn:#e9b44c;--err:#f2625e;--x:#e8554d;--y:#6fc34b;--z:#4c8fe8;font:12px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--text)}
.ke-ed-root{position:fixed;inset:0;z-index:1000;display:grid;grid-template-columns:var(--ke-left,236px) minmax(0,1fr) var(--ke-right,318px);grid-template-rows:42px minmax(0,1fr) var(--ke-bottom,206px);pointer-events:none;user-select:none;-webkit-user-select:none}
.ke-ed-root *,.ke-ed-console *,.ke-ed-menu *{box-sizing:border-box}
.ke-ed-root [hidden],.ke-ed-console [hidden]{display:none!important}
.ke-ed-root>*{pointer-events:auto;min-width:0;min-height:0}
.ke-ed-root svg,.ke-ed-menu svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.ke-ed-bar{grid-column:1/-1;grid-row:1;display:flex;align-items:center;gap:6px;padding:0 8px;background:linear-gradient(#212227,#1b1c20);border-bottom:1px solid var(--line);overflow:hidden}
.ke-ed-brand{display:flex;align-items:center;gap:7px;font-weight:700;letter-spacing:.02em;margin-right:4px;white-space:nowrap;color:#eef0f3}
.ke-ed-brand i{width:18px;height:18px;border-radius:5px;background:conic-gradient(from 210deg,#ff9a3c,#ff5f6d,#7b61ff,#3d8cff,#ff9a3c);box-shadow:0 0 0 1px #0006 inset}
.ke-ed-brand small{font-weight:500;color:var(--muted)}
.ke-ed-sep{width:1px;height:22px;background:var(--edge);margin:0 3px;flex:none}
.ke-ed-grow{flex:1 1 0;min-width:4px}
.ke-ed-btn{height:28px;min-width:28px;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:0 7px;border-radius:4px;border:1px solid transparent;background:transparent;color:var(--text);cursor:pointer;font:inherit;white-space:nowrap;flex:none}
.ke-ed-btn:hover{background:var(--raise)}.ke-ed-btn:active{background:#34363d}
.ke-ed-btn:focus-visible,.ke-ed-in:focus-visible,.ke-ed-sel:focus-visible,.ke-ed-row:focus-visible,.ke-ed-item:focus-visible,.ke-ed-tab:focus-visible{outline:2px solid var(--accent);outline-offset:-1px}
.ke-ed-btn.on{background:var(--accentbg);border-color:#2f6bc4;color:#fff}
.ke-ed-btn[disabled]{opacity:.38;pointer-events:none}
.ke-ed-btn.ke-ed-play{color:var(--ok)}.ke-ed-btn.ke-ed-play.on{background:#1d4a2c;border-color:#2f8a4c;color:#b8f5c9}
.ke-ed-btn.ke-ed-stop{color:var(--err)}.ke-ed-btn.ke-ed-pause.on{background:#4d3b16;border-color:#9c7727;color:#ffe2a6}
.ke-ed-btn.ke-ed-primary{background:var(--accent);color:#fff}.ke-ed-btn.ke-ed-primary:hover{background:#5a9dff}
.ke-ed-btn.ke-ed-danger:hover{background:#4a1f22;color:#ffb3b0}
.ke-ed-seg{display:inline-flex;align-items:center;background:var(--bg);border:1px solid var(--edge);border-radius:6px;padding:2px;gap:1px;flex:none}
.ke-ed-seg .ke-ed-btn{height:24px;min-width:26px;padding:0 5px}
.ke-ed-sel{height:26px;background:var(--bg);color:var(--text);border:1px solid var(--edge);border-radius:4px;padding:0 4px;font:inherit;flex:none;max-width:130px}
.ke-ed-lbl{color:var(--muted);font-size:11px;white-space:nowrap}
.ke-ed-panel{display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--line);overflow:hidden}
.ke-ed-ph{height:30px;flex:none;display:flex;align-items:center;gap:6px;padding:0 6px 0 10px;font-weight:650;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#aeb2bb;background:var(--panel2);border-bottom:1px solid var(--line)}
.ke-ed-ph .ke-ed-btn{height:22px;min-width:22px;padding:0 4px;text-transform:none;letter-spacing:0}
.ke-ed-scroll{flex:1 1 auto;overflow:auto;min-height:0;scrollbar-width:thin;scrollbar-color:#3a3c43 transparent}
.ke-ed-search{margin:6px;flex:none;position:relative}.ke-ed-search svg{position:absolute;left:7px;top:5px;width:14px;height:14px;color:var(--dim)}
.ke-ed-search .ke-ed-in{padding-left:26px;height:26px}
.ke-ed-in{height:24px;width:100%;min-width:0;background:#0e0f12;color:var(--text);border:1px solid #2d2f35;border-radius:3px;padding:0 6px;font:inherit;font-variant-numeric:tabular-nums;user-select:text;-webkit-user-select:text}
.ke-ed-in:hover{border-color:#3f424a}.ke-ed-in:focus{border-color:var(--accent);outline:none}
.ke-ed-in.ke-ed-bad{border-color:var(--err);background:#2a1214}
textarea.ke-ed-in{height:auto;min-height:48px;padding:4px 6px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px}
input[type=color].ke-ed-in{padding:1px;width:34px;flex:none;cursor:pointer}
input[type=checkbox].ke-ed-chk{width:15px;height:15px;accent-color:var(--accent);margin:0;cursor:pointer}
.ke-ed-view{grid-column:2;grid-row:2;position:relative;outline:none;touch-action:none;box-shadow:inset 0 0 0 1px var(--line)}
.ke-ed-view.ke-ed-pie{box-shadow:inset 0 0 0 2px var(--ok)}.ke-ed-view.ke-ed-pie.ke-ed-paused{box-shadow:inset 0 0 0 2px var(--warn)}
.ke-ed-vinfo{position:absolute;left:8px;top:8px;display:flex;gap:4px;pointer-events:none}
.ke-ed-chip{background:rgba(16,17,20,.72);border:1px solid #ffffff14;border-radius:4px;padding:3px 8px;color:#c9ccd3;font-size:11px;backdrop-filter:blur(3px)}
.ke-ed-chip b{color:#fff;font-weight:600}
.ke-ed-vstats{position:absolute;left:8px;top:36px;background:rgba(10,11,13,.7);border:1px solid #ffffff12;border-radius:4px;padding:6px 9px;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#cfe8c0;white-space:pre;pointer-events:none}
.ke-ed-pieban{position:absolute;left:50%;top:8px;transform:translateX(-50%);background:#1d4a2cdd;border:1px solid #2f8a4c;color:#c9f7d6;border-radius:4px;padding:3px 10px;font-size:11px;font-weight:600;pointer-events:none;letter-spacing:.03em}
.ke-ed-paused .ke-ed-pieban{background:#4d3b16dd;border-color:#9c7727;color:#ffe2a6}
.ke-ed-drawer{grid-column:1;grid-row:2}
.ke-ed-cat{padding:8px 10px 3px;font-size:10.5px;font-weight:650;color:var(--dim);text-transform:uppercase;letter-spacing:.07em}
.ke-ed-item{display:flex;align-items:center;gap:9px;margin:1px 5px;padding:4px 6px;border-radius:5px;cursor:grab;border:1px solid transparent;background:none;color:inherit;font:inherit;width:calc(100% - 10px);text-align:left}
.ke-ed-item:hover{background:var(--raise);border-color:#3a3d45}
.ke-ed-item .ke-ed-ico{width:28px;height:28px;border-radius:5px;display:grid;place-items:center;background:linear-gradient(#2c2e35,#23252b);border:1px solid #3a3c43;color:var(--c,#aeb4bf)}
.ke-ed-item small{display:block;color:var(--dim);font-size:10.5px}
.ke-ed-side{grid-column:3;grid-row:2/4;display:flex;flex-direction:column;border-left:1px solid var(--line);background:var(--panel);min-height:0}
.ke-ed-outl{flex:0 0 38%;display:flex;flex-direction:column;min-height:120px;border-bottom:1px solid var(--line)}
.ke-ed-det{flex:1 1 auto;display:flex;flex-direction:column;min-height:0}
.ke-ed-cols{display:flex;height:22px;align-items:center;padding:0 8px 0 30px;color:var(--dim);font-size:10.5px;border-bottom:1px solid #26282d;flex:none}
.ke-ed-cols span:first-child{flex:1}
.ke-ed-row{display:flex;align-items:center;height:24px;padding:0 8px 0 calc(4px + var(--d,0)*14px);gap:5px;cursor:default;white-space:nowrap}
.ke-ed-row:nth-child(even){background:#1e1f23}.ke-ed-row:hover{background:#2a2c32}
.ke-ed-row.sel{background:var(--accentbg);color:#fff}.ke-ed-row.sel .ke-ed-type{color:#b7cdf0}
.ke-ed-row.hid .ke-ed-name{opacity:.45}
.ke-ed-row .ke-ed-name{flex:1;overflow:hidden;text-overflow:ellipsis}
.ke-ed-row .ke-ed-type{color:var(--dim);font-size:11px;max-width:40%;overflow:hidden;text-overflow:ellipsis}
.ke-ed-row .ke-ed-eye{width:20px;height:20px;min-width:20px;padding:0;color:var(--muted)}
.ke-ed-row .ke-ed-glyph{color:var(--c,#aeb4bf);display:flex}
.ke-ed-row .ke-ed-glyph svg{width:14px;height:14px}
.ke-ed-more{padding:6px 10px;color:var(--dim);font-style:italic}
.ke-ed-empty{padding:18px 14px;color:var(--dim);text-align:center;line-height:1.6}
.ke-ed-head{padding:10px;display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;border-bottom:1px solid #26282d}
.ke-ed-head .ke-ed-ico{width:30px;height:30px;border-radius:6px;display:grid;place-items:center;background:#2a2c33;color:var(--c,#aeb4bf)}
.ke-ed-head small{grid-column:2/4;color:var(--dim)}
.ke-ed-sec{border-bottom:1px solid #26282d}
.ke-ed-sech{display:flex;align-items:center;gap:6px;height:28px;padding:0 6px 0 8px;background:#202126;font-weight:600;cursor:pointer;color:#dfe2e7}
.ke-ed-sech .ke-ed-chev{transition:transform .12s;color:var(--dim)}.ke-ed-sec.shut .ke-ed-chev{transform:rotate(-90deg)}.ke-ed-sec.shut .ke-ed-secb{display:none}
.ke-ed-sech small{color:var(--dim);font-weight:500;margin-left:2px}
.ke-ed-sech .ke-ed-btn{height:22px;min-width:22px;padding:0 3px;margin-left:auto;color:var(--muted)}
.ke-ed-secb{padding:4px 0 6px}
.ke-ed-prop{display:grid;grid-template-columns:minmax(80px,38%) minmax(0,1fr);align-items:center;min-height:27px;padding:1px 10px;gap:8px}
.ke-ed-prop>label{color:#aeb2ba;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ke-ed-prop>label.ke-ed-scrub{cursor:ew-resize}
.ke-ed-prop>label.ke-ed-scrub:hover{color:#fff}
.ke-ed-flex{display:flex;gap:4px;align-items:center;min-width:0}
.ke-ed-v3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:3px}
.ke-ed-ax{position:relative}.ke-ed-ax .ke-ed-in{padding-left:9px}
.ke-ed-ax::before{content:"";position:absolute;left:1px;top:1px;bottom:1px;width:4px;border-radius:3px 0 0 3px;background:var(--c)}
.ke-ed-add{margin:10px;display:flex;gap:6px}
.ke-ed-bottom{grid-column:1/3;grid-row:3;display:flex;flex-direction:column;background:var(--panel);border-top:1px solid var(--line)}
.ke-ed-tabs{display:flex;align-items:stretch;height:30px;flex:none;background:var(--panel2);border-bottom:1px solid var(--line);padding:0 4px;gap:2px}
.ke-ed-tab{display:flex;align-items:center;gap:6px;padding:0 12px;background:none;border:0;color:var(--muted);font:inherit;font-weight:600;cursor:pointer}
.ke-ed-tab:hover{color:var(--text)}.ke-ed-tab.on{color:#fff;box-shadow:inset 0 -2px var(--accent);background:#ffffff08}
.ke-ed-tabs .ke-ed-grow+*{align-self:center}
.ke-ed-log{font:11.5px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:4px 0;user-select:text;-webkit-user-select:text}
.ke-ed-log div{padding:0 10px;white-space:pre-wrap;word-break:break-word}.ke-ed-log div:hover{background:#ffffff06}
.ke-ed-log .t{color:var(--dim);margin-right:8px}.ke-ed-log .warn{color:var(--warn)}.ke-ed-log .error{color:var(--err)}.ke-ed-log .print{color:#8fd0ff}.ke-ed-log .cmd{color:#c7a6ff}
.ke-ed-bp{display:grid;grid-template-columns:190px minmax(0,1fr);height:100%;min-height:0}
.ke-ed-bpl{border-right:1px solid #26282d;display:flex;flex-direction:column;min-height:0}
.ke-ed-ev{display:flex;align-items:center;gap:7px;width:100%;height:26px;padding:0 10px;border:0;background:none;color:var(--text);font:inherit;cursor:pointer;text-align:left}
.ke-ed-ev:hover{background:var(--raise)}.ke-ed-ev.on{background:var(--accentbg);color:#fff}
.ke-ed-ev i{width:8px;height:8px;border-radius:2px;background:#c0392b;flex:none;transform:rotate(45deg)}
.ke-ed-ev em{margin-left:auto;font-style:normal;color:var(--dim);font-size:11px}
.ke-ed-bpm{padding:8px 12px;min-height:0}
.ke-ed-node{background:var(--panel2);border:1px solid var(--edge);border-radius:6px;margin:0 0 6px;overflow:hidden;max-width:760px;box-shadow:0 1px 2px #0005}
.ke-ed-nodeh{display:flex;align-items:center;gap:6px;height:26px;padding:0 4px 0 8px;background:linear-gradient(90deg,color-mix(in srgb,var(--nc) 55%,transparent),transparent 70%);border-bottom:1px solid var(--edge);font-weight:650}
.ke-ed-nodeh small{color:#c3c7cf;font-weight:450;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.ke-ed-nodeh .ke-ed-btn{height:20px;min-width:20px;padding:0 2px;color:#c5c9d1}
.ke-ed-nodeb{padding:4px 0}
.ke-ed-nodeb .ke-ed-prop{grid-template-columns:minmax(70px,26%) minmax(0,1fr);min-height:25px}
.ke-ed-nest{margin:2px 10px 4px 14px;padding-left:8px;border-left:2px solid #3a3d45}
.ke-ed-nestl{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;margin:4px 0}
.ke-ed-err{color:var(--err);font-size:11px;padding:0 10px}
.ke-ed-console{position:fixed;left:0;right:0;top:0;height:min(38vh,360px);z-index:1100;background:rgba(11,12,15,.95);border-bottom:1px solid #3d8cff66;box-shadow:0 8px 24px #0008;display:flex;flex-direction:column;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ke-ed-console .ke-ed-conlog{flex:1;overflow:auto;padding:8px 12px;white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text;scrollbar-width:thin}
.ke-ed-console .ke-ed-conlog .cmd{color:#7fb3ff}.ke-ed-console .ke-ed-conlog .err{color:var(--err)}.ke-ed-console .ke-ed-conlog .dim{color:var(--muted)}
.ke-ed-conin{display:flex;align-items:center;gap:8px;border-top:1px solid #2b2d33;padding:6px 12px;background:#0d0e11}
.ke-ed-conin span{color:var(--accent);font-weight:700}
.ke-ed-conin input{flex:1;background:transparent;border:0;outline:none;color:#fff;font:inherit;caret-color:var(--accent)}
.ke-ed-sugg{position:absolute;left:34px;top:100%;margin-top:1px;min-width:320px;max-width:min(680px,92vw);background:#16171b;border:1px solid var(--edge);border-radius:0 0 6px 6px;box-shadow:0 10px 24px #0009;max-height:230px;overflow:auto}
.ke-ed-sugg div{display:flex;gap:12px;padding:3px 10px;cursor:pointer;white-space:nowrap}.ke-ed-sugg div.on,.ke-ed-sugg div:hover{background:var(--accentbg)}
.ke-ed-sugg b{font-weight:600;color:#fff}.ke-ed-sugg i{font-style:normal;color:var(--muted);overflow:hidden;text-overflow:ellipsis}.ke-ed-sugg em{font-style:normal;color:#e9c46a;margin-left:auto}
.ke-ed-stat{position:fixed;right:12px;top:12px;z-index:1150;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#b6f28f;text-shadow:0 1px 1px #000;pointer-events:none;background:rgba(0,0,0,.42);padding:6px 10px;border-radius:4px;white-space:pre;text-align:right}
.ke-ed-stat .hd{color:#fff;font-weight:700}.ke-ed-stat .w{color:#ffd166}.ke-ed-stat .b{color:#ff6b6b}.ke-ed-stat .d{color:#9aa1ab}
.ke-ed-menu{position:fixed;z-index:1200;min-width:210px;background:#1d1e23;border:1px solid var(--edge);border-radius:6px;padding:4px;box-shadow:0 12px 30px #000a}
.ke-ed-menu button{display:flex;align-items:center;gap:9px;width:100%;height:28px;padding:0 10px;background:none;border:0;border-radius:4px;color:var(--text);font:inherit;cursor:pointer;text-align:left}
.ke-ed-menu button:hover,.ke-ed-menu button:focus-visible{background:var(--accentbg);outline:none}
.ke-ed-menu kbd{margin-left:auto;color:var(--dim);font:11px system-ui}
.ke-ed-menu hr{border:0;border-top:1px solid var(--edge);margin:4px 2px}
.ke-ed-root.ke-ed-nodrawer{--ke-left:0px}.ke-ed-root.ke-ed-nodrawer .ke-ed-drawer{display:none}
@media (max-width:900px){
  .ke-ed-root{--ke-left:0px;--ke-right:260px;--ke-bottom:168px}
  .ke-ed-root .ke-ed-drawer{display:none}
  .ke-ed-root.ke-ed-drawer-open .ke-ed-drawer{display:flex;position:absolute;left:0;top:42px;bottom:168px;width:230px;z-index:5;box-shadow:6px 0 18px #0008}
  .ke-ed-brand small,.ke-ed-hide-sm,.ke-ed-bar .ke-ed-btn>span{display:none!important}
  .ke-ed-bar{gap:4px;padding:0 6px}.ke-ed-bar .ke-ed-sel{max-width:96px}
  .ke-ed-bp{grid-template-columns:150px minmax(0,1fr)}
}
@media (max-width:640px){.ke-ed-root{--ke-right:220px;--ke-bottom:140px}.ke-ed-brand{display:none}.ke-ed-hide-xs{display:none!important}}
`;
let styleEl=null,styleRefs=0;
function acquireStyle(){if(!hasDOM)return;if(!styleRefs++){styleEl=document.createElement('style');styleEl.id='ke-ed-style';styleEl.textContent=CSS;document.head.appendChild(styleEl);}}
function releaseStyle(){if(!hasDOM||styleRefs<=0)return;if(!--styleRefs&&styleEl){styleEl.remove();styleEl=null;}}

/* ---------- tiny DOM helpers ---------- */
/* h('div.cls#id',{attr:...,on:{click}},children...) — attributes set as properties when they exist. */
function h(sel,attrs,...kids){
  const m=/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i.exec(sel)||[];const el=document.createElement(m[1]||'div');
  (m[2]||'').replace(/([.#])([\w-]+)/g,(_,t,v)=>{if(t==='.')el.classList.add(v);else el.id=v;return '';});
  if(attrs&&(typeof attrs!=='object'||attrs.nodeType||Array.isArray(attrs))){kids.unshift(attrs);attrs=null;}
  if(attrs)for(const [k,v] of Object.entries(attrs)){if(v===undefined||v===null||v===false)continue;
    if(k==='on'){for(const [e,fn] of Object.entries(v))el.addEventListener(e,fn);}
    else if(k==='style'&&typeof v==='object')Object.assign(el.style,v);
    else if(k==='html')el.innerHTML=v;
    else if(k==='dataset')Object.assign(el.dataset,v);
    else if(k in el&&!/^(aria-|role$|for$|list$)/.test(k))el[k]=v;else el.setAttribute(k,v===true?'':v);}
  for(const k of kids.flat(3)){if(k===null||k===undefined||k===false)continue;el.append(k.nodeType?k:document.createTextNode(String(k)));}
  return el;
}
const svg=name=>{const p=ICONS[name]||ICONS.dot;const t=document.createElement('template');t.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+p+'</svg>';return t.content.firstChild;};
const isTyping=el=>!!el&&(el.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))&&!(el.type==='checkbox'||el.type==='button'||el.type==='color'||el.type==='range');
const fmt=(v,d=3)=>{if(typeof v!=='number'||!Number.isFinite(v))return String(v);const r=Math.round(v*10**d)/10**d;return String(Object.is(r,-0)?0:r);};
const niceKey=k=>k.split('.').pop().replace(/([a-z])([A-Z])/g,'$1 $2').replace(/^./,c=>c.toUpperCase());
function download(name,data,type){const url=URL.createObjectURL(new Blob([data],{type}));const a=h('a',{href:url,download:name});document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function pickFile(accept){return new Promise(resolve=>{const i=h('input',{type:'file',accept,style:{display:'none'}});i.addEventListener('change',()=>{resolve(i.files&&i.files[0]||null);i.remove();});document.body.appendChild(i);i.click();});}

/* ---------- icon set (24px stroke glyphs) ---------- */
const ICONS={
  dot:'<circle cx="12" cy="12" r="3"/>',
  select:'<path d="M5 3l14 8-6 1.8L10 19z"/>',
  move:'<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  rotate:'<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20 4v5h-5"/>',
  scale:'<rect x="3" y="11" width="10" height="10" rx="1"/><path d="M14 3h7v7M21 3l-9 9"/>',
  world:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  local:'<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/>',
  snap:'<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/>',
  grid:'<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
  stats:'<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  camera:'<path d="M3 8h13v10H3zM16 11l5-3v10l-5-3"/>',
  eye:'<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff:'<path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 3.9M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  play:'<path d="M7 4l13 8-13 8z" fill="currentColor"/>',
  pause:'<path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor"/>',
  stop:'<rect x="5" y="5" width="14" height="14" rx="1.5" fill="currentColor"/>',
  undo:'<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
  redo:'<path d="M15 14l5-5-5-5"/><path d="M20 9H9a5 5 0 0 0 0 10h3"/>',
  save:'<path d="M5 3h11l4 4v14H4V3z"/><path d="M8 3v5h8M8 21v-7h8v7"/>',
  folder:'<path d="M3 6h6l2 2h10v11H3z"/>',
  file:'<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6"/>',
  download:'<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  upload:'<path d="M12 15V3M7 8l5-5 5 5M4 21h16"/>',
  close:'<path d="M6 6l12 12M18 6L6 18"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  trash:'<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  up:'<path d="M6 15l6-6 6 6"/>',down:'<path d="M6 9l6 6 6-6"/>',
  chev:'<path d="M6 9l6 6 6-6"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  copy:'<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V4H3v13h5"/>',
  focus:'<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="12" cy="12" r="3"/>',
  drawer:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  script:'<path d="M8 4c-2 0-3 1-3 3v2c0 1.5-1 2.5-2 3 1 .5 2 1.5 2 3v2c0 2 1 3 3 3M16 4c2 0 3 1 3 3v2c0 1.5 1 2.5 2 3-1 .5-2 1.5-2 3v2c0 2-1 3-3 3"/>',
  log:'<path d="M4 6h16M4 12h16M4 18h10"/>',
  mesh:'<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/>',
  light:'<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  spot:'<path d="M9 3h6l3 9H6z"/><path d="M8 15l-3 6M16 15l3 6M12 15v6"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  sky:'<path d="M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 19.5 10 4 4 0 0 1 18 18z"/>',
  physics:'<rect x="4" y="4" width="11" height="11" rx="1"/><path d="M15 9h5v11H9v-5"/>',
  trigger:'<rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2.5"/><path d="M9 12l2 2 4-4"/>',
  fx:'<path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>',
  audio:'<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  player:'<circle cx="12" cy="6" r="3"/><path d="M6 21v-2a6 6 0 0 1 12 0v2M12 12v3"/>',
  text:'<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  empty:'<path d="M12 12L4 7M12 12l8-5M12 12v9"/><circle cx="12" cy="12" r="1.5"/>',
  coin:'<circle cx="12" cy="12" r="8"/><path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4"/>',
  'shape:box':'<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 22V12M21 7l-9 5-9-5"/>',
  'shape:sphere':'<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5"/>',
  'shape:cylinder':'<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-13"/>',
  'shape:cone':'<path d="M12 3L5 18.5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5z"/>',
  'shape:torus':'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>',
  'shape:plane':'<path d="M2 16l6-8h14l-6 8z"/>',
  'shape:capsule':'<rect x="7" y="2" width="10" height="20" rx="5"/>',
  'shape:rock':'<path d="M3 17l3-7 5-4 6 2 4 6-2 5H6z"/><path d="M11 6l1 6 7 2M12 12l-6 7"/>',
  gltf:'<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M8 10.5l4 2.5 4-2.5"/>'
};
const ICON_COLORS={light:'#ffd166',spot:'#ffd166',sun:'#ffcf5c',sky:'#8ec5ff',physics:'#f4a259',trigger:'#57d38c',fx:'#ff8fb1',audio:'#7fd6ff',player:'#b99bff',text:'#e6e6e6',script:'#6fa8ff',coin:'#f2c14e',mesh:'#b6c2d1',empty:'#9aa3ad',gltf:'#7fe0c4'};
const iconColor=n=>ICON_COLORS[n]||(n&&n.startsWith('shape:')?'#b6c2d1':'#aeb4bf');
/* Actor glyph for outliner/drawer/viewport sprites: the most descriptive component wins. */
const ICON_PRIORITY=[['DirectionalLight','sun'],['SkyLight','sky'],['SpotLight','spot'],['PointLight','light'],['PlayerStart','player'],['AudioSource','audio'],['ParticleEmitter','fx'],['TriggerVolume','trigger'],['TextLabel','text'],['RigidBody','physics'],['StaticMesh','mesh'],['Blueprint','script']];
function actorIcon(actor){if(actor.prefab&&KE.Prefabs){const p=KE.Prefabs.info(actor.prefab);if(p&&p.icon&&ICONS[p.icon]&&!p.icon.startsWith('shape:'))return p.icon;}
  for(const [t,i] of ICON_PRIORITY)if(actor.getComponent(t)){if(t==='StaticMesh'){const p=actor.getComponent(t).props.mesh.primitive;return p==='gltf'?'gltf':'shape:'+p;}return i;}return 'empty';}
/* Viewport billboard: lights always; other actors only when they have no visible geometry of their own. */
const SPRITE_ICONS=new Set(['sun','sky','spot','light','player','audio','fx','trigger','script','empty']);
function spriteIcon(actor){for(const [t,i] of ICON_PRIORITY.slice(0,4))if(actor.getComponent(t))return i;if(actor.getComponent('StaticMesh')||actor.getComponent('TextLabel'))return null;
  for(const [t,i] of ICON_PRIORITY)if(actor.getComponent(t))return SPRITE_ICONS.has(i)?i:null;return 'empty';}

/* ---------- canvas-painted billboard textures for viewport icons ---------- */
const spriteTextures=new Map();
function spriteTexture(THREE,name){
  const key=name;if(spriteTextures.has(key))return spriteTextures.get(key);
  const S=96,c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d'),col=iconColor(name);
  g.fillStyle='rgba(18,19,23,.86)';g.strokeStyle=col;g.lineWidth=4;g.beginPath();g.arc(S/2,S/2,S/2-5,0,Math.PI*2);g.fill();g.stroke();
  const img=new Image();const svgText='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="'+col+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+(ICONS[name]||ICONS.dot).replace(/fill="currentColor"/g,'fill="'+col+'"')+'</svg>';
  const tex=new THREE.CanvasTexture(c);tex.encoding=THREE.sRGBEncoding;
  img.onload=()=>{g.drawImage(img,S/2-28,S/2-28,56,56);tex.needsUpdate=true;};img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svgText);
  const entry={tex,refs:0};spriteTextures.set(key,entry);return entry;
}

/* ---------- undo / redo command stack ---------- */
/* A command is {label, undo(), redo(), mergeKey?, merge?(next)}; push() records an already-applied command.
   Consecutive commands with the same mergeKey within mergeWindow seconds collapse into one step. */
class CommandStack{
  constructor(limit=200){this.limit=limit;this.done=[];this.undone=[];this.enabled=true;this.mergeWindow=1.2;this.onChange=null;}
  push(cmd){if(!this.enabled)return cmd;const last=this.done[this.done.length-1],now=performance.now()/1000;
    if(last&&cmd.mergeKey&&last.mergeKey===cmd.mergeKey&&now-last.time<this.mergeWindow&&last.merge){last.merge(cmd);last.time=now;}
    else{cmd.time=now;this.done.push(cmd);if(this.done.length>this.limit)this.done.shift();}
    this.undone.length=0;this.onChange&&this.onChange();return cmd;}
  undo(){const c=this.done.pop();if(!c)return null;c.undo();this.undone.push(c);this.onChange&&this.onChange();return c;}
  redo(){const c=this.undone.pop();if(!c)return null;c.redo();c.time=0;this.done.push(c);this.onChange&&this.onChange();return c;}
  clear(){this.done.length=0;this.undone.length=0;this.onChange&&this.onChange();}
  get canUndo(){return this.done.length>0;}get canRedo(){return this.undone.length>0;}
}

/* ---------- KE.ConsoleUI: developer console ---------- */
/* One global keydown listener (backquote) is installed at load; the console DOM exists only while open.
   Lines are either a registered command, `<cvar>` (print), or `<cvar> <value>` (set via KE.cvars). */
const ConsoleUI={
  enabled:true,hotkey:'Backquote',renderer:null,lines:[],history:[],maxLines:400,
  _commands:new Map(),_flags:new Map(),_el:null,_statMode:'none',_statEl:null,_statRaf:0,_frames:[],_installed:false,_onKey:null,
  /* Installs the toggle hotkey (idempotent). Options: {renderer, hotkey:'Backquote', enabled}. */
  install(o={}){if(o.renderer)this.renderer=o.renderer;if(o.hotkey)this.hotkey=o.hotkey;if(o.enabled!==undefined)this.enabled=!!o.enabled;
    if(this._installed||!hasDOM)return this;this._installed=true;try{this.history=JSON.parse(localStorage.getItem('ke-console-history')||'[]').filter(s=>typeof s==='string').slice(-100);}catch(e){this.history=[];}
    this._onKey=e=>{if(!this.enabled||e.code!==this.hotkey||e.ctrlKey||e.metaKey||e.altKey)return;const t=e.target;if(isTyping(t)&&!(this._el&&this._el.contains(t)))return;e.preventDefault();e.stopPropagation();this.toggle();};
    window.addEventListener('keydown',this._onKey,true);return this;},
  uninstall(){if(!this._installed)return;window.removeEventListener('keydown',this._onKey,true);this._installed=false;this.close();this.stat('none');},
  setRenderer(r){this.renderer=r||null;return this;},
  get isOpen(){return !!this._el;},
  toggle(){return this.isOpen?this.close():this.open();},
  open(){if(this._el||!hasDOM)return this;acquireStyle();
    const log=h('div.ke-ed-conlog',{role:'log','aria-live':'polite'}),input=h('input',{type:'text',spellcheck:false,autocomplete:'off','aria-label':'Console command'}),sugg=h('div.ke-ed-sugg',{role:'listbox',hidden:true});
    const bar=h('div.ke-ed-conin',{style:{position:'relative'}},h('span',{'aria-hidden':'true'},'>'),input,sugg);
    const el=h('div.ke-ed-console',{role:'dialog','aria-label':'Console'},log,bar);this._el=el;this._log=log;this._input=input;this._sugg=sugg;this._hist=this.history.length;this._sel=-1;
    for(const l of this.lines)log.appendChild(this._lineEl(l));
    if(!this.lines.length)this.print(KE.name+' '+KE.version+' console. Type "help" for commands, Tab to complete, Up/Down for history.','dim');
    input.addEventListener('keydown',e=>this._key(e));input.addEventListener('input',()=>this._suggest());
    document.body.appendChild(el);log.scrollTop=log.scrollHeight;setTimeout(()=>input.focus(),0);return this;},
  close(){if(!this._el)return this;this._el.remove();this._el=null;this._log=this._input=this._sugg=null;releaseStyle();return this;},
  print(text,cls=''){const l={text:String(text),cls};this.lines.push(l);if(this.lines.length>this.maxLines)this.lines.shift();
    if(this._log){this._log.appendChild(this._lineEl(l));while(this._log.childNodes.length>this.maxLines)this._log.firstChild.remove();this._log.scrollTop=this._log.scrollHeight;}return l;},
  clear(){this.lines.length=0;if(this._log)this._log.textContent='';},
  _lineEl(l){return h('div',{className:l.cls||''},l.text);},
  /* command(name, fn(args:string[], console, line), help) registers or replaces a console command. */
  command(name,fn,help=''){if(typeof name!=='string'||!/^[\w.]{1,64}$/.test(name))throw new TypeError('Console command name must be a plain identifier');if(typeof fn!=='function')throw new TypeError('Console command needs a function');
    this._commands.set(name.toLowerCase(),{name,fn,help});return ()=>this._commands.delete(name.toLowerCase());},
  removeCommand(name){return this._commands.delete(String(name).toLowerCase());},
  commands(){return [...this._commands.values()].map(c=>({name:c.name,help:c.help}));},
  /* showFlag(name, fn(value|undefined)->bool, help): targets for `show <name>`; editors register grid/icons/bounds. */
  showFlag(name,fn,help=''){this._flags.set(name.toLowerCase(),{name,fn,help});return ()=>{const f=this._flags.get(name.toLowerCase());if(f&&f.fn===fn)this._flags.delete(name.toLowerCase());};},
  /* Runs one line; returns {ok, output:[strings]}. Never throws. */
  run(line){const text=String(line||'').trim();if(!text)return {ok:true,output:[]};const out=[];let ok=true;
    const say=(s,cls)=>{out.push(String(s));this.print(s,cls);};
    this.print('> '+text,'cmd');if(this.history[this.history.length-1]!==text){this.history.push(text);if(this.history.length>100)this.history.shift();try{localStorage.setItem('ke-console-history',JSON.stringify(this.history));}catch(e){}}
    this._hist=this.history.length;
    const parts=text.split(/\s+/),name=parts[0],args=parts.slice(1),cmd=this._commands.get(name.toLowerCase());
    try{
      if(cmd){const r=cmd.fn(args,this,text);if(r!==undefined&&r!==null&&r!=='')for(const s of String(r).split('\n'))say(s);}
      else{const cv=KE.cvars&&KE.cvars.find(name);
        if(!cv){ok=false;say('Unknown command or variable "'+name+'". Type help.','err');}
        else if(!args.length){say(cv.name+' = '+String(KE.cvars.get(cv.name))+(cv.help?'   ('+cv.help+')':''));}
        else{const v=KE.cvars.set(cv.name,args.join(' '));say(cv.name+' = '+String(v));}}
    }catch(e){ok=false;say(e.message||String(e),'err');}
    return {ok,output:out};},
  /* Names starting with prefix: commands first, then cvars. */
  complete(prefix){const p=String(prefix||'').toLowerCase(),out=[];
    for(const c of this._commands.values())if(c.name.toLowerCase().startsWith(p))out.push({name:c.name,help:c.help,kind:'cmd'});
    if(KE.cvars)for(const c of KE.cvars.list(''))if(c.name.toLowerCase().startsWith(p))out.push({name:c.name,help:c.help,value:c.value,kind:'cvar'});
    return out.sort((a,b)=>a.name.localeCompare(b.name));},
  _suggest(){const s=this._sugg;if(!s)return;const v=this._input.value;s.textContent='';this._sel=-1;
    if(!v||/\s/.test(v.trim())&&!/^(stat|show)\s+\S*$/i.test(v)){s.hidden=true;return;}
    let items;const m=/^(stat|show)\s+(\S*)$/i.exec(v);
    if(m){const opts=m[1].toLowerCase()==='stat'?['fps','unit','none']:[...this._flags.values()].map(f=>f.name);items=opts.filter(o=>o.startsWith(m[2].toLowerCase())).map(o=>({name:m[1]+' '+o,help:'',kind:'arg'}));}
    else items=this.complete(v.trim()).slice(0,40);
    if(!items.length){s.hidden=true;return;}
    items.forEach((it,i)=>{const d=h('div',{role:'option',on:{mousedown:e=>{e.preventDefault();this._input.value=it.name+(it.kind==='arg'?'':' ');this._suggest();this._input.focus();}}},h('b',it.name),it.help?h('i',it.help):null,it.value!==undefined?h('em',String(it.value)):null);d.dataset.i=i;d.dataset.name=it.name;s.appendChild(d);});s.hidden=false;},
  _key(e){const inp=this._input,s=this._sugg,opts=s&&!s.hidden?[...s.children]:[];
    if(e.code===this.hotkey){e.preventDefault();this.close();return;}
    if(e.key==='Escape'){e.preventDefault();if(opts.length){s.hidden=true;return;}this.close();return;}
    if(e.key==='Tab'){e.preventDefault();if(!opts.length){this._suggest();return;}const pick=opts[Math.max(0,this._sel)];inp.value=pick.dataset.name+(/\s/.test(pick.dataset.name)?'':' ');this._suggest();return;}
    if((e.key==='ArrowDown'||e.key==='ArrowUp')&&opts.length&&this._sel>=-1&&(this._sel>=0||e.key==='ArrowDown')&&inp.value){e.preventDefault();this._sel=clamp(this._sel+(e.key==='ArrowDown'?1:-1),-1,opts.length-1);opts.forEach((o,i)=>o.classList.toggle('on',i===this._sel));if(this._sel>=0)opts[this._sel].scrollIntoView({block:'nearest'});return;}
    if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();if(!this.history.length)return;this._hist=clamp(this._hist+(e.key==='ArrowUp'?-1:1),0,this.history.length);inp.value=this.history[this._hist]||'';s.hidden=true;return;}
    if(e.key==='Enter'){e.preventDefault();let v=inp.value;if(opts.length&&this._sel>=0)v=opts[this._sel].dataset.name;inp.value='';s.hidden=true;this.run(v);return;}
    e.stopPropagation();},
  /* ----- stat overlays: fps (frame rate and time) and unit (frame, profiler scopes, renderer counters) ----- */
  stat(mode){mode=String(mode||'none').toLowerCase();if(!['fps','unit','none'].includes(mode))throw new RangeError('stat expects fps, unit or none');
    this._statMode=this._statMode===mode&&mode!=='none'?'none':mode;
    if(this._statMode==='none'){if(this._statRaf)cancelAnimationFrame(this._statRaf);this._statRaf=0;if(this._statEl){this._statEl.remove();this._statEl=null;releaseStyle();}return 'none';}
    if(!this._statEl&&hasDOM){acquireStyle();this._statEl=h('div.ke-ed-stat',{'aria-live':'off'});document.body.appendChild(this._statEl);this._frames.length=0;this._last=0;this._shown=0;
      const loop=t=>{if(!this._statEl)return;this._statRaf=requestAnimationFrame(loop);if(this._last){this._frames.push(t-this._last);if(this._frames.length>120)this._frames.shift();}this._last=t;if(t-this._shown>250){this._shown=t;this._drawStat();}};
      this._statRaf=requestAnimationFrame(loop);}
    this._drawStat();return this._statMode;},
  statSample(){const f=this._frames,n=f.length;if(!n)return {fps:0,ms:0,min:0,max:0};let s=0,mn=Infinity,mx=0;for(const v of f){s+=v;mn=Math.min(mn,v);mx=Math.max(mx,v);}const ms=s/n;return {fps:ms>0?1000/ms:0,ms,min:mn,max:mx};},
  _drawStat(){const el=this._statEl;if(!el)return;const s=this.statSample(),col=v=>v<=17.5?'':v<=34?'w':'b',esc=x=>String(x).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])),line=(k,v,c='')=>'<span class="d">'+esc(k)+'</span> <span class="'+c+'">'+esc(v)+'</span>';
    const rows=[line('FPS',s.fps.toFixed(1),s.fps>=55?'':s.fps>=28?'w':'b')+'   '+line('Frame',s.ms.toFixed(2)+' ms',col(s.ms))];
    if(this._statMode==='unit'){rows.push(line('min/max',s.min.toFixed(1)+' / '+s.max.toFixed(1)+' ms'));
      const rep=KE.profiler?KE.profiler.report().sort((a,b)=>b.avg-a.avg).slice(0,8):[];if(rep.length)rows.push('<span class="hd">Profiler (avg / max ms)</span>');
      for(const r of rep)rows.push(line(r.name.slice(0,22),r.avg.toFixed(2)+' / '+r.max.toFixed(2),col(r.avg*2)));
      const R=this.renderer||(Editor.active&&Editor.active.renderer);if(R&&R.info){const i=R.info;rows.push('<span class="hd">Renderer</span>',line('Draws',i.render.calls)+'  '+line('Tris',i.render.triangles.toLocaleString()),line('Geometries',i.memory.geometries)+'  '+line('Textures',i.memory.textures),line('Programs',i.programs?i.programs.length:0));}}
    el.innerHTML=rows.join('\n');
    const ed=Editor.active,con=this._el?this._el.getBoundingClientRect().bottom:0;let top=12,right=12;if(ed&&ed._view){const r=ed._view.getBoundingClientRect();top=r.top+8;right=innerWidth-r.right+8;}
    el.style.top=Math.max(top,con+8)+'px';el.style.right=right+'px';}
};
KE.ConsoleUI=ConsoleUI;
ConsoleUI.command('help',()=>['Commands:',...ConsoleUI.commands().sort((a,b)=>a.name.localeCompare(b.name)).map(c=>'  '+c.name.padEnd(18)+c.help),'Variables: type a name to print it, "<name> <value>" to set it; "list <prefix>" lists them.'].join('\n'),'List commands');
ConsoleUI.command('clear',()=>{ConsoleUI.clear();},'Clear the console output');
ConsoleUI.command('list',args=>{const l=KE.cvars?KE.cvars.list(args[0]||''):[];if(!l.length)return 'No variables match "'+(args[0]||'')+'"';return l.map(c=>c.name.padEnd(22)+String(c.value).padEnd(10)+c.help).join('\n');},'list <prefix>: console variables and values');
ConsoleUI.command('stat',args=>{const m=ConsoleUI.stat(args[0]||'fps');return m==='none'?'stat overlay hidden':'stat '+m+' shown';},'stat fps|unit|none: frame statistics overlay');
ConsoleUI.command('show',args=>{const f=ConsoleUI._flags.get(String(args[0]||'').toLowerCase());if(!args[0])return 'show <flag>: '+([...ConsoleUI._flags.keys()].join(', ')||'no flags (open the editor for grid, icons, bounds)');
  if(!f)return 'Unknown show flag "'+args[0]+'"'+(ConsoleUI._flags.size?' (available: '+[...ConsoleUI._flags.keys()].join(', ')+')':'; open the editor (F8) for grid, icons and bounds');const v=f.fn(args[1]===undefined?undefined:/^(1|on|true)$/i.test(args[1]));return 'show '+f.name+': '+(v?'on':'off');},'show grid|icons|bounds: toggle editor show flags');
ConsoleUI.command('editor',()=>{const e=Editor.instances[Editor.instances.length-1];if(!e)return 'No KE.Editor has been created';e.toggle();return e.isOpen?'editor opened':'editor closed';},'Toggle the level editor');
if(hasDOM)ConsoleUI.install();

/* ---------- editor viewport grid ---------- */
/* Procedural ground grid: anti-aliased minor/major lines via screen-space derivatives, red X / blue Z axes,
   distance fade, minor lines fade out where they would alias. Without the pipeline it depth-tests against
   the framebuffer; after KE.Pipeline (default framebuffer depth is not the scene's) it compares its view
   depth with KE.sceneUniforms.keSceneDepth so geometry still occludes it. */
const GRID_VS=`varying vec3 vWorld;varying float vViewZ;void main(){vec4 w=modelMatrix*vec4(position,1.);vWorld=w.xyz;vec4 mv=viewMatrix*w;vViewZ=-mv.z;gl_Position=projectionMatrix*mv;}`;
const GRID_FS=`uniform float uCell;uniform float uMajor;uniform float uFade;uniform vec3 uCam;uniform float uUseDepth;uniform vec2 uViewport;uniform sampler2D keSceneDepth;
uniform vec3 uMinor;uniform vec3 uMajorCol;uniform vec3 uX;uniform vec3 uZ;varying vec3 vWorld;varying float vViewZ;
float gridLine(vec2 p,float s,float w){vec2 c=p/s;vec2 d=fwidth(c);vec2 g=abs(fract(c-.5)-.5)/max(d*w,vec2(1e-5));return 1.-min(min(g.x,g.y),1.);}
void main(){vec2 p=vWorld.xz;vec2 d=fwidth(p);float dens=max(d.x,d.y)/uCell;
  float minor=gridLine(p,uCell,1.)*(1.-smoothstep(.12,.4,dens));float major=gridLine(p,uCell*uMajor,1.25)*(1.-smoothstep(1.2,4.,dens));
  float ax=1.-min(abs(p.y)/max(d.y*1.6,1e-5),1.);float az=1.-min(abs(p.x)/max(d.x*1.6,1e-5),1.);
  vec3 col=uMinor;float a=minor*.28;if(major*.55>a){col=uMajorCol;a=major*.55;}
  if(ax>0.){col=mix(col,uX,ax);a=max(a,ax*.85);}if(az>0.){col=mix(col,uZ,az);a=max(a,az*.85);}
  float dist=length(vWorld.xz-uCam.xz);a*=1.-smoothstep(uFade*.3,uFade,dist);
  if(uUseDepth>.5){float sd=texture2D(keSceneDepth,gl_FragCoord.xy/uViewport).r;if(sd>0.&&vViewZ>sd*1.002+.03)a=0.;}
  if(a<.004)discard;gl_FragColor=vec4(col,a);}`;
function createGrid(THREE){
  const U=KE.sceneUniforms?KE.sceneUniforms(THREE):{keSceneDepth:{value:null}};
  const m=new THREE.ShaderMaterial({vertexShader:GRID_VS,fragmentShader:GRID_FS,transparent:true,depthWrite:false,side:THREE.DoubleSide,extensions:{derivatives:true},toneMapped:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-8,
    uniforms:{uCell:{value:1},uMajor:{value:10},uFade:{value:80},uCam:{value:new THREE.Vector3()},uUseDepth:{value:0},uViewport:{value:new THREE.Vector2(1,1)},keSceneDepth:U.keSceneDepth,
      uMinor:{value:new THREE.Color(0x5a5e66)},uMajorCol:{value:new THREE.Color(0x8b909a)},uX:{value:new THREE.Color(0xe8554d)},uZ:{value:new THREE.Color(0x4c8fe8)}}});
  const g=new THREE.PlaneGeometry(1,1);g.rotateX(-Math.PI/2);const mesh=new THREE.Mesh(g,m);mesh.frustumCulled=false;mesh.renderOrder=-10;mesh.name='ke-editor-grid';return mesh;
}
/* Three orthogonal circles (unit radius) as line segments, used for sphere volumes and light ranges. */
function circleSegments(THREE,n=48){const p=[];for(const ax of [0,1,2])for(let i=0;i<n;i++){const a=i/n*Math.PI*2,b=(i+1)/n*Math.PI*2;const pt=t=>ax===0?[0,Math.cos(t),Math.sin(t)]:ax===1?[Math.cos(t),0,Math.sin(t)]:[Math.cos(t),Math.sin(t),0];p.push(...pt(a),...pt(b));}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));return g;}

const FLY_SPEEDS=[.5,1,2.5,5,10,20,40,80];
const VIEW_MODES_EXTRA=['wireframe'];
const EVENT_TYPES=['spawn','destroy','changed','reorder','componentAdded','componentRemoved','componentChanged','levelLoaded','log','beginPlay','endPlay'];

/* ---------- KE.Editor ---------- */
class Editor{
  constructor(THREE,opts={}){
    if(!THREE||!THREE.Object3D)throw new TypeError('KE.Editor(THREE, options): THREE is required');
    const o={renderer:null,scene:null,camera:null,world:null,container:null,onPlay:null,onStop:null,onOpen:null,onClose:null,onUpdate:null,render:null,
      loop:true,dockCanvas:true,restoreCamera:true,hotkey:'F8',storageKey:'ke-editor-level',duplicateOffset:[.5,0,.5],levelName:null,...opts};
    if(!o.renderer||!o.renderer.domElement)throw new TypeError('KE.Editor needs {renderer}');
    if(!o.camera||!o.camera.isCamera)throw new TypeError('KE.Editor needs {camera}');
    if(!o.world&&!o.scene)throw new TypeError('KE.Editor needs {world} or {scene}');
    this.THREE=THREE;this.options=o;this.renderer=o.renderer;this.camera=o.camera;
    this.world=o.world||new KE.GameWorld(THREE,o.scene,{camera:o.camera,renderer:o.renderer});this.scene=o.scene||this.world.scene;
    this.events=new KE.Events();this.history=new CommandStack();this.history.onChange=()=>this._syncToolbar();
    this.selection=[];this.mode='translate';this.space='world';this.snap={enabled:false,translate:.5,rotate:15,scale:.25};this.speedIndex=3;
    this.show={grid:true,icons:true,bounds:true,stats:false};this.viewMode='lit';this.isOpen=false;this.pie=null;this.logEntries=[];this.fps=0;
    this._bpEvent='BeginPlay';this._logFilter='all';this._tab='log';
    this._v=[0,1,2,3,4,5].map(()=>new THREE.Vector3());this._q=new THREE.Quaternion();this._m=new THREE.Matrix4();this._m2=new THREE.Matrix4();this._m3=new THREE.Matrix4();this._box=new THREE.Box3();this._ndc=new THREE.Vector2();
    this._onHotkey=e=>{if(!o.hotkey||e.code!==o.hotkey||e.repeat||e.ctrlKey||e.altKey||e.metaKey)return;if(isTyping(e.target)&&!(this._root&&this._root.contains(e.target)))return;e.preventDefault();this.toggle();};
    if(hasDOM&&o.hotkey)window.addEventListener('keydown',this._onHotkey);
    Editor.instances.push(this);
  }
  get primary(){return this.selection[this.selection.length-1]||null;}
  get playing(){return !!this.pie;}
  toggle(){return this.isOpen?this.close():this.open();}

  /* ===== lifecycle ===== */
  open(){
    if(this.isOpen||!hasDOM)return this;if(Editor.active&&Editor.active!==this)Editor.active.close();Editor.active=this;
    const T=this.THREE,R=this.renderer,cam=this.camera;acquireStyle();this.isOpen=true;this._ls=[];this._subs=[];this._flagsOff=[];
    this._saved={pos:cam.position.clone(),quat:cam.quaternion.clone(),aspect:cam.aspect,css:R.domElement.style.cssText,size:R.getSize(new T.Vector2()),mask:cam.layers.mask,override:this.scene.overrideMaterial};
    this._euler=new T.Euler().setFromQuaternion(cam.quaternion,'YXZ');
    /* helpers live in their own scene, drawn after the game frame; editor-created helpers use layer 31 */
    this._helperScene=new T.Scene();this._helperScene.name='ke-editor-helpers';this._raycaster=new T.Raycaster();this._raycaster.layers.set(0);this._raycaster.layers.enable(KE.LAYERS?KE.LAYERS.TRANSLUCENT:1);
    this._grid=createGrid(T);this._helperScene.add(this._grid);
    this._iconMats=new Map();this._icons=new Map();this._vols=new Map();this._boxes=new Map();this._decos=[];this._helpersDirty=true;this._decoDirty=true;
    this._circle=circleSegments(T);this._volMat=new T.LineBasicMaterial({color:0x57d38c,transparent:true,opacity:.85,depthTest:false,toneMapped:false});
    this._decoMat=new T.LineBasicMaterial({color:0xffd166,transparent:true,opacity:.75,depthTest:false,toneMapped:false});
    this._wireMat=new T.MeshBasicMaterial({color:0x9fb4d6,wireframe:true});
    this._buildDOM();
    this.pivot=new T.Object3D();this.pivot.name='ke-editor-pivot';this._helperScene.add(this.pivot);
    if(T.TransformControls){const g=this.gizmo=new T.TransformControls(cam,this._view);g.setSize(.95);g.setSpace(this.space);g.setMode(this.mode==='select'?'translate':this.mode);
      g.addEventListener('mouseDown',()=>this._beginXform());g.addEventListener('objectChange',()=>this._applyXform());g.addEventListener('mouseUp',()=>this._endXform());this._helperScene.add(g);this._applySnap();}
    else{this.gizmo=null;this.log('THREE.TransformControls is not loaded: the gizmo is unavailable','warn');}
    this._bindViewport();this._bindKeys();
    const w=this.world;for(const ev of EVENT_TYPES)this._subs.push(w.events.on(ev,(...a)=>this._onWorldEvent(ev,...a)));
    this._flagsOff.push(ConsoleUI.showFlag('grid',v=>this.setShow('grid',v),'Editor ground grid'),ConsoleUI.showFlag('icons',v=>this.setShow('icons',v),'Editor actor icons and volumes'),ConsoleUI.showFlag('bounds',v=>this.setShow('bounds',v),'Selection bounds'));
    for(const e of w.logs.slice(-60))this._pushLog({text:e.text,level:e.level,stamp:e.stamp,src:'world'});
    this._layout(true);this._renderAll();this.log('Editor opened · '+w.actors.length+' actors · F8 closes · ` opens the console','info');
    this.selection=this.selection.filter(a=>a.alive);this._onSelection();
    if(this.options.loop){let last=performance.now();const tick=t=>{if(!this.isOpen)return;this._raf=requestAnimationFrame(tick);const dt=Math.min(.1,Math.max(0,(t-last)/1000));last=t;this.frame(dt);};this._raf=requestAnimationFrame(tick);}
    if(this.options.onOpen)this.options.onOpen(this);KE.events.emit('editor',{open:true,editor:this});this.events.emit('open',this);
    return this;
  }
  close(){
    if(!this.isOpen)return this;if(this.pie)this.stop();this._endXform();
    if(this._raf)cancelAnimationFrame(this._raf);this._raf=0;this._closeMenu();if(this._laterT)for(const k of Object.keys(this._laterT)){clearTimeout(this._laterT[k]);this._laterT[k]=0;}
    for(const [t,type,fn,opt] of this._ls)t.removeEventListener(type,fn,opt);this._ls=[];for(const off of this._subs)off();this._subs=[];for(const off of this._flagsOff)off();this._flagsOff=[];
    if(this.gizmo){this.gizmo.detach();this.gizmo.dispose();this.gizmo=null;}
    this._clearHelpers();this._grid.geometry.dispose();this._grid.material.dispose();this._circle.dispose();this._volMat.dispose();this._decoMat.dispose();this._wireMat.dispose();
    for(const [name,m] of this._iconMats){m.dispose();const e=spriteTextures.get(name);if(e&&--e.refs<=0){e.tex.dispose();spriteTextures.delete(name);}}this._iconMats.clear();
    this._helperScene=null;this.pivot=null;
    const R=this.renderer,cam=this.camera,s=this._saved;this.scene.overrideMaterial=s.override;
    R.domElement.style.cssText=s.css;R.setSize(s.size.x,s.size.y,false);cam.layers.mask=s.mask;
    if(cam.isPerspectiveCamera){cam.aspect=s.aspect;cam.updateProjectionMatrix();}
    if(this.options.restoreCamera){cam.position.copy(s.pos);cam.quaternion.copy(s.quat);cam.updateMatrixWorld();}
    this._root.remove();this._root=null;this._view=null;releaseStyle();this.isOpen=false;this._fly=this._pan=this._orbit=null;this._keys=null;
    if(Editor.active===this)Editor.active=null;
    if(this.options.onClose)this.options.onClose(this);KE.events.emit('editor',{open:false,editor:this});this.events.emit('close',this);
    return this;
  }
  dispose(){this.close();if(hasDOM)window.removeEventListener('keydown',this._onHotkey);const i=Editor.instances.indexOf(this);if(i>=0)Editor.instances.splice(i,1);this.events.clear();}
  _listen(t,type,fn,opt){t.addEventListener(type,fn,opt);this._ls.push([t,type,fn,opt]);}

  /* ===== per-frame ===== */
  /* One editor frame: camera, PIE simulation, deferred UI, helpers, game render, overlay. Driven by the
     editor's own requestAnimationFrame loop while open (options.loop) or called manually. */
  frame(dt=1/60){
    if(!this.isOpen)return;dt=clamp(Number.isFinite(dt)?dt:0,0,.1);const P=KE.profiler;P&&P.begin('editor');
    this._layout();this._updateCamera(dt);
    if(this.pie&&!this.pie.paused){try{this.world.update(dt);}catch(e){this.log('World update failed: '+e.message,'error');}}
    if(this.options.onUpdate)this.options.onUpdate(dt,this);
    this._flush();this._updateHelpers();P&&P.end('editor');
    this._renderFrame(dt);this._updateStats(dt);
  }
  _renderFrame(dt){
    const R=this.renderer,T=this.THREE,cam=this.camera,U=KE._sceneUniforms;
    if(U)U.keHasScene.value=0;
    const wire=this.viewMode==='wireframe',prev=this.scene.overrideMaterial;if(wire)this.scene.overrideMaterial=this._wireMat;
    try{if(this.options.render)this.options.render(dt,this);else R.render(this.scene,cam);}catch(e){this.log('Render failed: '+e.message,'error');}
    finally{if(wire)this.scene.overrideMaterial=prev;}
    const info=R.info.render;this._frameInfo={calls:info.calls,triangles:info.triangles};
    const pipe=!!(U&&U.keHasScene.value>.5),gu=this._grid.material.uniforms;gu.uUseDepth.value=pipe?1:0;R.getDrawingBufferSize(gu.uViewport.value);
    const ac=R.autoClear,ar=R.info.autoReset,mask=cam.layers.mask,tm=R.toneMapping,rt=R.getRenderTarget();
    R.setRenderTarget(null);R.autoClear=false;R.info.autoReset=false;if(pipe)R.clearDepth();cam.layers.enableAll();R.toneMapping=T.NoToneMapping;
    try{R.render(this._helperScene,cam);}finally{R.autoClear=ac;R.info.autoReset=ar;cam.layers.mask=mask;R.toneMapping=tm;R.setRenderTarget(rt);}
  }
  _updateStats(dt){this._statT=(this._statT||0)+dt;this.fps+=((dt>0?1/dt:0)-this.fps)*.1;if(this._statT<.25)return;this._statT=0;
    const i=this._frameInfo||{calls:0,triangles:0};
    if(this._chipSpeed)this._chipSpeed.textContent='Speed '+(this.speedIndex+1);if(this.pie&&this.selection.length===1)this._refreshTransformUI();
    if(this._statsEl){this._statsEl.hidden=!this.show.stats;if(this.show.stats)this._statsEl.textContent=['FPS    '+this.fps.toFixed(1)+'   '+(this.fps>0?(1000/this.fps).toFixed(2):'0')+' ms','Draws  '+i.calls+'   Tris '+i.triangles.toLocaleString(),'Actors '+this.world.actors.length+'   Selected '+this.selection.length,
      this.pie?'PIE    t='+this.world.time.toFixed(2)+'s  frame '+this.world.frame:'Mode   '+this.mode+' · '+this.space+(this.snap.enabled?' · snap':'')].join('\n');}}
  /* Keeps the renderer canvas docked under the viewport slot of the layout. */
  _layout(force){
    const v=this._view;if(!v)return;const r=v.getBoundingClientRect(),w=Math.max(1,Math.round(r.width)),hh=Math.max(1,Math.round(r.height)),L=Math.round(r.left),Tp=Math.round(r.top);
    const key=L+','+Tp+','+w+','+hh,c=this.renderer.domElement;
    if(!force&&key===this._layoutKey&&(!this.options.dockCanvas||(c.style.width===w+'px'&&c.style.left===L+'px'&&c.width===Math.floor(w*this.renderer.getPixelRatio()))))return;this._layoutKey=key;
    if(this.options.dockCanvas){const s=c.style;s.position='fixed';s.left=L+'px';s.top=Tp+'px';s.width=w+'px';s.height=hh+'px';s.zIndex='999';this.renderer.setSize(w,hh,false);
      if(this.camera.isPerspectiveCamera){this.camera.aspect=w/hh;this.camera.updateProjectionMatrix();}}
  }

  /* ===== camera: RMB fly (WASD/QE, wheel = speed), MMB pan, Alt+LMB orbit, wheel dolly, F focus ===== */
  _speed(){return FLY_SPEEDS[this.speedIndex];}
  setCameraSpeed(i){this.speedIndex=clamp(Math.round(i),0,FLY_SPEEDS.length-1);if(this._speedSel)this._speedSel.value=String(this.speedIndex);this._statT=1;return this.speedIndex;}
  _updateCamera(dt){
    const cam=this.camera,k=this._keys;
    if(this._focusAnim){const f=this._focusAnim;f.t=Math.min(1,f.t+dt/f.dur);const e=f.t*f.t*(3-2*f.t);cam.position.lerpVectors(f.from,f.to,e);if(f.t>=1)this._focusAnim=null;}
    if(this._fly&&k&&k.size){const s=this._speed()*(k.has('ShiftLeft')||k.has('ShiftRight')?3:1)*dt,v=this._v[0].set(0,0,0);
      if(k.has('KeyW'))v.z-=1;if(k.has('KeyS'))v.z+=1;if(k.has('KeyA'))v.x-=1;if(k.has('KeyD'))v.x+=1;
      if(v.lengthSq()){v.normalize().multiplyScalar(s).applyQuaternion(cam.quaternion);cam.position.add(v);}
      if(k.has('KeyE'))cam.position.y+=s;if(k.has('KeyQ'))cam.position.y-=s;}
    cam.updateMatrixWorld();
  }
  _look(dx,dy){const e=this._euler;e.y-=dx*.0032;e.x=clamp(e.x-dy*.0032,-1.55,1.55);e.z=0;this.camera.quaternion.setFromEuler(e);}
  _pivotPoint(out){const a=this.primary;if(a&&a.alive)return a.getWorldPosition(out);return out.set(0,0,-10).applyQuaternion(this.camera.quaternion).add(this.camera.position);}
  /* Frames the selection (or the given actors) keeping the view direction. */
  focus(actors=this.selection,{instant=false}={}){
    const T=this.THREE,list=(Array.isArray(actors)?actors:[actors]).filter(a=>a&&a.alive);if(!list.length)return false;
    const box=new T.Box3(),b=new T.Box3(),p=new T.Vector3();for(const a of list){b.setFromObject(a.object);if(b.isEmpty())b.setFromCenterAndSize(a.getWorldPosition(p),p.set(1,1,1));box.union(b);}
    const sphere=box.getBoundingSphere(new T.Sphere()),cam=this.camera,fov=(cam.fov||50)*DEG,r=Math.max(.5,sphere.radius);
    const dist=r/Math.sin(Math.min(fov,fov*(cam.aspect||1))/2)*1.15,dir=new T.Vector3(0,0,-1).applyQuaternion(cam.quaternion);
    const to=sphere.center.clone().addScaledVector(dir,-dist);if(instant){cam.position.copy(to);cam.updateMatrixWorld();this._focusAnim=null;}else this._focusAnim={from:cam.position.clone(),to,t:0,dur:.28};return true;
  }
  _bindViewport(){
    const v=this._view,S=this;
    this._listen(v,'contextmenu',e=>e.preventDefault());
    this._listen(v,'pointerdown',e=>{v.focus({preventScroll:true});this._closeMenu();
      if(e.button===2){this._fly={x:e.clientX,y:e.clientY,moved:0};this._euler.setFromQuaternion(this.camera.quaternion,'YXZ');try{v.setPointerCapture(e.pointerId);}catch(_){}e.preventDefault();return;}
      if(e.button===1){this._pan={x:e.clientX,y:e.clientY};try{v.setPointerCapture(e.pointerId);}catch(_){}e.preventDefault();return;}
      if(e.button===0&&e.altKey){const c=this._pivotPoint(new this.THREE.Vector3());this._orbit={x:e.clientX,y:e.clientY,center:c,dist:c.distanceTo(this.camera.position)};this._euler.setFromQuaternion(this.camera.quaternion,'YXZ');try{v.setPointerCapture(e.pointerId);}catch(_){}return;}
      if(e.button===0&&!(this.gizmo&&this.gizmo.dragging))this._click={x:e.clientX,y:e.clientY,add:e.shiftKey||e.ctrlKey||e.metaKey};});
    this._listen(v,'pointermove',e=>{
      if(this._fly){const dx=e.clientX-this._fly.x,dy=e.clientY-this._fly.y;this._fly.x=e.clientX;this._fly.y=e.clientY;this._fly.moved+=Math.abs(dx)+Math.abs(dy);this._look(dx,dy);return;}
      if(this._pan){const dx=e.clientX-this._pan.x,dy=e.clientY-this._pan.y;this._pan.x=e.clientX;this._pan.y=e.clientY;const k=this._speed()*.012,cam=this.camera;
        cam.position.addScaledVector(this._v[1].set(1,0,0).applyQuaternion(cam.quaternion),-dx*k).addScaledVector(this._v[2].set(0,1,0).applyQuaternion(cam.quaternion),dy*k);return;}
      if(this._orbit){const o=this._orbit,dx=e.clientX-o.x,dy=e.clientY-o.y;o.x=e.clientX;o.y=e.clientY;this._look(dx,dy);const cam=this.camera;cam.position.copy(o.center).addScaledVector(this._v[1].set(0,0,1).applyQuaternion(cam.quaternion),o.dist);return;}
      if(this._click&&Math.hypot(e.clientX-this._click.x,e.clientY-this._click.y)>5)this._click=null;});
    const up=e=>{if(this._fly&&e.button===2){if(this._keys)this._keys.clear();this._fly=null;}if(this._pan&&e.button===1)this._pan=null;if(this._orbit&&e.button===0)this._orbit=null;
      if(this._click&&e.button===0){const c=this._click;this._click=null;if(!(this.gizmo&&this.gizmo.dragging))this.pickAt(c.x,c.y,{add:c.add});}};
    this._listen(v,'pointerup',up);this._listen(v,'pointercancel',()=>{this._fly=this._pan=this._orbit=this._click=null;});
    this._listen(v,'wheel',e=>{e.preventDefault();if(this._fly){this.setCameraSpeed(this.speedIndex+(e.deltaY<0?1:-1));return;}
      const cam=this.camera,step=Math.max(.25,this._speed()*.35)*(e.deltaY<0?1:-1)*(e.shiftKey?3:1);cam.position.addScaledVector(this._v[1].set(0,0,-1).applyQuaternion(cam.quaternion),step);},{passive:false});
    this._listen(v,'dragover',e=>{if(e.dataTransfer&&[...e.dataTransfer.types].includes('text/ke-actor')){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
    this._listen(v,'drop',e=>{const d=e.dataTransfer&&e.dataTransfer.getData('text/ke-actor');if(!d)return;e.preventDefault();try{const def=JSON.parse(d);const r=v.getBoundingClientRect();this.placeActor(def,{ndc:[(e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1]});}catch(err){this.log('Drop failed: '+err.message,'error');}});
  }
  _bindKeys(){
    this._keys=new Set();
    this._listen(window,'keyup',e=>{if(this._keys)this._keys.delete(e.code);});
    this._listen(window,'blur',()=>{if(this._keys)this._keys.clear();});
    this._listen(window,'keydown',e=>{
      if(e.code===this.options.hotkey||e.code===ConsoleUI.hotkey)return;
      const t=e.target;if(ConsoleUI._el&&ConsoleUI._el.contains(t))return;
      if(isTyping(t)){if(e.key==='Escape')t.blur();return;}
      if(t&&this._root&&!this._root.contains(t)&&t!==document.body&&t!==document.documentElement&&t!==this.renderer.domElement)return;
      const ctrl=e.ctrlKey||e.metaKey,k=e.key.length===1?e.key.toLowerCase():e.key;
      if(this._fly){if(/^(Key[WASDQE]|Shift(Left|Right))$/.test(e.code)){this._keys.add(e.code);e.preventDefault();}return;}
      let done=true;
      if(ctrl&&k==='z')e.shiftKey?this.redo():this.undo();else if(ctrl&&k==='y')this.redo();
      else if(ctrl&&k==='d')this.duplicate();else if(ctrl&&k==='s')this.saveLevel();else if(ctrl&&k==='a')this.select(this.world.actors.filter(a=>!a.parent));
      else if(e.altKey&&k==='p')this.pie?this.stop():this.play();
      else if(ctrl||e.altKey)done=false;
      else if(k==='Delete'||(k==='Backspace'&&this._outlinerFocused()))this.deleteSelected();
      else if(k==='q')this.setMode('select');else if(k==='w')this.setMode('translate');else if(k==='e')this.setMode('rotate');else if(k==='r')this.setMode('scale');
      else if(k===' '&&this._view.contains(t)){const m=['translate','rotate','scale'];this.setMode(m[(m.indexOf(this.mode)+1)%3]);}
      else if(k==='f')this.focus();else if(k==='g')this.setShow('game',!this.show.game);else if(k==='End')this.dropToGround();
      else if(k==='Escape'){if(this.pie)this.stop();else this.select(null);}
      else done=false;
      if(done){e.preventDefault();e.stopPropagation();}});
  }
  _outlinerFocused(){const a=document.activeElement;return !!(a&&this._outl&&this._outl.contains(a));}

  /* ===== picking and placement ===== */
  _actorOf(o){while(o){const a=o.userData&&o.userData.keActor;if(a&&a.world===this.world)return a;o=o.parent;}return null;}
  _visibleChain(o){while(o){if(!o.visible)return false;o=o.parent;}return true;}
  _ray(ndcX,ndcY){this._ndc.set(ndcX,ndcY);this._raycaster.setFromCamera(this._ndc,this.camera);this._raycaster.camera=this.camera;return this._raycaster;}
  /* Actor under a client-space point: meshes/sprites of actors (layer 0/1 only) and viewport icons. */
  actorAt(clientX,clientY){
    const r=this._view.getBoundingClientRect(),nx=(clientX-r.left)/r.width*2-1,ny=-(clientY-r.top)/r.height*2+1,ray=this._ray(nx,ny);
    const roots=[];for(const a of this.world.actors)if(!a.parent&&a.object.visible){a.object.updateMatrixWorld(true);roots.push(a.object);}
    let best=null,bestD=Infinity;
    for(const hit of ray.intersectObjects(roots,true)){const o=hit.object;if(!(o.isMesh||o.isSprite)||!this._visibleChain(o))continue;const a=this._actorOf(o);if(a){best=a;bestD=hit.distance;break;}}
    if(this.show.icons&&!this.show.game&&!this.pie){const p=this._v[3];for(const [a,s] of this._icons){if(!s.visible)continue;p.copy(s.position).project(this.camera);if(p.z>1||p.z<-1)continue;
      const sx=(p.x+1)/2*r.width+r.left,sy=(1-p.y)/2*r.height+r.top;if(Math.hypot(sx-clientX,sy-clientY)<=15){const d=s.position.distanceTo(this.camera.position);if(d<bestD){best=a;bestD=d;}}}}
    return best;
  }
  pickAt(clientX,clientY,{add=false}={}){const a=this.actorAt(clientX,clientY);if(add){if(a)this.select(a,{toggle:true});}else this.select(a);return a;}
  /* World point in front of the camera (screen centre or ndc) on the first surface, else on y=0, else 8 units ahead. */
  placementPoint(ndc=[0,0]){
    const T=this.THREE,ray=this._ray(ndc[0],ndc[1]),out=new T.Vector3();this.scene.updateMatrixWorld();
    const hits=ray.intersectObjects(this.scene.children,true);
    for(const h of hits){const o=h.object;if(!o.isMesh||h.distance>400||!this._visibleChain(o))continue;const m=Array.isArray(o.material)?o.material[0]:o.material;if(m&&m.side===T.BackSide)continue;if(o.frustumCulled===false&&o.geometry&&o.geometry.boundingSphere&&o.geometry.boundingSphere.radius>500)continue;return {point:out.copy(h.point),ground:true};}
    const d=ray.ray.direction,o=ray.ray.origin;if(d.y<-1e-4){const t=-o.y/d.y;if(t<400)return {point:out.copy(o).addScaledVector(d,t),ground:true};}
    return {point:out.copy(o).addScaledVector(d,8),ground:false};
  }

  /* ===== selection ===== */
  /* select(actor | actor[] | null, {add, toggle}) */
  select(target,{add=false,toggle=false}={}){
    const list=(target===null||target===undefined?[]:Array.isArray(target)?target:[target]).filter(a=>a&&a.alive&&a.world===this.world);
    let next;if(toggle){next=this.selection.slice();for(const a of list){const i=next.indexOf(a);if(i>=0)next.splice(i,1);else next.push(a);}}
    else if(add){next=this.selection.slice();for(const a of list)if(!next.includes(a))next.push(a);}else next=list;
    const same=next.length===this.selection.length&&next.every((a,i)=>a===this.selection[i]);this.selection=next;if(!same)this._onSelection();return this.selection;
  }
  selectById(ids){return this.select(ids.map(id=>this.world.findById(id)).filter(Boolean));}
  _onSelection(){this._decoDirty=true;this._syncPivot(true);if(!this.isOpen)return;this._markSelectionUI();this._renderDetails();this._renderBlueprint();this.events.emit('selection',this.selection);}
  _roots(list=this.selection){return list.filter(a=>{for(let p=a.parent;p;p=p.parent)if(list.includes(p))return false;return a.alive;});}

  /* ===== gizmo and transforms ===== */
  setMode(m){if(!['select','translate','rotate','scale'].includes(m))throw new RangeError('Editor mode must be select, translate, rotate or scale');this.mode=m;if(this.gizmo&&m!=='select')this.gizmo.setMode(m);this._syncPivot(true);this._syncToolbar();return m;}
  setSpace(s){if(s!=='local'&&s!=='world')throw new RangeError('Space must be local or world');this.space=s;if(this.gizmo)this.gizmo.setSpace(s);this._syncToolbar();return s;}
  setSnap(o={}){Object.assign(this.snap,o);this._applySnap();this._syncToolbar();return {...this.snap};}
  _applySnap(){const g=this.gizmo;if(!g)return;const s=this.snap;g.setTranslationSnap(s.enabled?s.translate:null);g.setRotationSnap(s.enabled?s.rotate*DEG:null);g.setScaleSnap(s.enabled?s.scale:null);}
  /* The gizmo drives a pivot at the primary actor; its delta is applied to every selected root actor. */
  _syncPivot(force){
    const g=this.gizmo,a=this.primary;if(!this.pivot)return;if(this._xf&&!force)return;
    if(!a||!a.alive||this.mode==='select'){if(g&&g.object)g.detach();return;}
    a.object.updateWorldMatrix(true,false);a.object.matrixWorld.decompose(this.pivot.position,this.pivot.quaternion,this._v[4]);this.pivot.scale.set(1,1,1);this.pivot.updateMatrixWorld(true);
    if(g&&g.object!==this.pivot)g.attach(this.pivot);
  }
  _localT(a){const o=a.object;return {p:o.position.toArray(),q:o.quaternion.toArray(),s:o.scale.toArray()};}
  _setLocalT(a,t){const o=a.object;o.position.fromArray(t.p);o.quaternion.fromArray(t.q);o.scale.fromArray(t.s);o.updateMatrixWorld(true);a._radius=-1;}
  _beginXform(){if(this._xf)return;const P=this.pivot;P.updateMatrixWorld(true);
    this._xf={inv:P.matrixWorld.clone().invert(),items:this._roots().map(a=>{a.object.updateWorldMatrix(true,false);return {a,world:a.object.matrixWorld.clone(),before:this._localT(a)};})};}
  _applyXform(){const x=this._xf;if(!x)return;const P=this.pivot;P.updateMatrixWorld(true);const d=this._m.multiplyMatrices(P.matrixWorld,x.inv),m=this._m2;
    for(const it of x.items){const o=it.a.object;m.multiplyMatrices(d,it.world);if(o.parent){o.parent.updateWorldMatrix(true,false);m.premultiply(this._m3.copy(o.parent.matrixWorld).invert());}
      m.decompose(o.position,o.quaternion,o.scale);o.updateMatrixWorld(true);it.a._radius=-1;}
    this._xfDirty=true;}
  _endXform(){const x=this._xf;this._xf=null;if(!x)return;const after=x.items.map(it=>this._localT(it.a));
    const changed=x.items.some((it,i)=>JSON.stringify(it.before)!==JSON.stringify(after[i]));
    if(changed)this._pushTransform(x.items.map(it=>it.a.id),x.items.map(it=>it.before),after,'Transform');this._syncPivot(true);this._xfDirty=true;}
  _pushTransform(ids,before,after,label,mergeKey){const S=this;const apply=list=>{ids.forEach((id,i)=>{const a=S.world.findById(id);if(a)S._setLocalT(a,list[i]);});S._syncPivot(true);S._xfDirty=true;};
    this.history.push({label,ids,before,after,mergeKey,undo(){apply(this.before);},redo(){apply(this.after);},merge(n){this.after=n.after;}});}
  /* Programmatic gizmo operations (same path as a gizmo drag; undoable). */
  translateSelection(delta){return this._gizmoOp(()=>this.pivot.position.add(this._v[0].fromArray(delta)));}
  rotateSelection(deg){return this._gizmoOp(()=>{this._q.setFromEuler(new this.THREE.Euler(deg[0]*DEG,deg[1]*DEG,deg[2]*DEG));if(this.space==='local')this.pivot.quaternion.multiply(this._q);else this.pivot.quaternion.premultiply(this._q);});}
  scaleSelection(f){const v=Array.isArray(f)?f:[f,f,f];return this._gizmoOp(()=>this.pivot.scale.multiply(this._v[0].fromArray(v)));}
  _gizmoOp(fn){if(!this.selection.length||!this.pivot)return false;const mode=this.mode;if(mode==='select')this.mode='translate';this._syncPivot(true);this.mode=mode;this._beginXform();fn();this._applyXform();this._endXform();return true;}
  /* Sets one transform channel (position | rotation (deg) | scale) of an actor from the details panel. */
  setActorTransform(a,channel,value){const before=[this._localT(a)];const t=a.getTransform();t[channel]=value.slice();a.setTransform(t);a.object.updateMatrixWorld(true);
    this._pushTransform([a.id],before,[this._localT(a)],'Edit '+channel,'xf:'+a.id+':'+channel);this._syncPivot(true);this._xfDirty=true;}
  /* Drops selected actors onto the surface below them (End). */
  dropToGround(){const T=this.THREE,ray=new T.Raycaster(),roots=this._roots();if(!roots.length)return 0;this.scene.updateMatrixWorld();const before=roots.map(a=>this._localT(a));let n=0;
    for(const a of roots){const box=new T.Box3().setFromObject(a.object),p=a.getWorldPosition(new T.Vector3());const bottom=box.isEmpty()?p.y:box.min.y;ray.set(new T.Vector3(p.x,bottom+.01,p.z),new T.Vector3(0,-1,0));
      const others=this.scene.children.filter(o=>o!==a.object);let hit=null;for(const h of ray.intersectObjects(others,true)){if(!h.object.isMesh||!this._visibleChain(h.object)||this._isInside(h.object,a))continue;hit=h;break;}
      if(!hit)continue;const wp=p.clone();wp.y+=hit.point.y-bottom;if(a.object.parent){a.object.parent.updateWorldMatrix(true,false);a.object.parent.worldToLocal(wp);}a.object.position.copy(wp);a.object.updateMatrixWorld(true);n++;}
    if(n)this._pushTransform(roots.map(a=>a.id),before,roots.map(a=>this._localT(a)),'Drop to ground');this._syncPivot(true);this._xfDirty=true;return n;}
  _isInside(o,a){while(o){if(o===a.object)return true;o=o.parent;}return false;}

  /* ===== undoable actor operations ===== */
  undo(){if(this.pie)return null;const c=this.history.undo();if(c){this.log('Undo: '+c.label,'dim');this._afterHistory();}return c;}
  redo(){if(this.pie)return null;const c=this.history.redo();if(c){this.log('Redo: '+c.label,'dim');this._afterHistory();}return c;}
  _afterHistory(){this.selection=this.selection.filter(a=>a.alive);this._onSelection();this._dirty('outliner');}
  _tree(a){const out=[a.serialize()];for(const c of a.children)out.push(...this._tree(c));return out;}
  /* Re-creates serialized actor trees (parent-first); keepIds reuses the saved ids (undo), otherwise new ids and names. */
  _restore(list,{keepIds=true,offset=null}={}){const w=this.world,map=new Map(),roots=[];
    for(const d of list){const def={...d,components:d.components.map(c=>({...c})),transform:{...d.transform}};delete def.parent;if(!keepIds)delete def.id;
      const isRoot=!map.has(d.parent);if(isRoot&&offset)def.transform.position=def.transform.position.map((v,i)=>v+offset[i]);
      const a=w.spawn(def,{fromLevel:true});map.set(d.id,a);const p=isRoot?(d.parent!==undefined?w.findById(d.parent):null):map.get(d.parent);
      if(p)w.attach(a,p,{keepWorld:false});if(isRoot)roots.push(a);}
    return roots;}
  _pushSpawn(label,roots){const S=this,data=roots.map(a=>this._tree(a)),ids=roots.map(a=>a.id);
    this.history.push({label,undo(){for(const id of ids){const a=S.world.findById(id);if(a)S.world.destroy(a);}},redo(){for(const d of data)S._restore(d,{keepIds:true});S.selectById(ids);}});}
  /* Spawns an actor definition (class/prefab/components) and records it for undo. */
  spawnActor(def,{select=true,label}={}){const a=this.world.spawn(def);this._pushSpawn(label||'Spawn '+a.name,[a]);if(select)this.select(a);this.log('Spawned '+a.name+' ('+a.className+')','dim');return a;}
  /* Spawns in front of the camera (or at an ndc point), resting on the surface under it. */
  placeActor(def,{ndc=[0,0]}={}){const T=this.THREE,{point,ground}=this.placementPoint(ndc);const a=this.world.spawn({...def,transform:{...(def.transform||{}),position:point.toArray()}});
    a.object.updateMatrixWorld(true);const box=new T.Box3().setFromObject(a.object);if(ground){if(!box.isEmpty())a.object.position.y+=point.y-box.min.y;else a.object.position.y+=1;}
    if(this.snap.enabled){const s=this.snap.translate;a.object.position.x=Math.round(a.object.position.x/s)*s;a.object.position.z=Math.round(a.object.position.z/s)*s;}
    a.object.updateMatrixWorld(true);this._pushSpawn('Place '+a.name,[a]);this.select(a);this.log('Placed '+a.name,'dim');return a;}
  duplicate(){const roots=this._roots();if(!roots.length)return [];const out=[];
    for(const a of roots)out.push(...this._restore(this._tree(a),{keepIds:false,offset:this.options.duplicateOffset}));
    this._pushSpawn('Duplicate '+out.length+' actor'+(out.length>1?'s':''),out);this.select(out);this.log('Duplicated '+out.map(a=>a.name).join(', '),'dim');return out;}
  deleteSelected(){const roots=this._roots();if(!roots.length)return 0;const S=this,data=roots.map(a=>this._tree(a)),ids=roots.map(a=>a.id),names=roots.map(a=>a.name);
    for(const a of roots)this.world.destroy(a);this.select(null);
    this.history.push({label:'Delete '+names.join(', '),undo(){for(const d of data)S._restore(d,{keepIds:true});S.selectById(ids);},redo(){for(const id of ids){const a=S.world.findById(id);if(a)S.world.destroy(a);}}});
    this.log('Deleted '+names.join(', '),'dim');return roots.length;}
  /* Component property edit through the schema (validated), undoable; consecutive edits merge. */
  setProperty(a,comp,key,value){const idx=a.components.indexOf(comp);if(idx<0)return;const before=clone(comp.get(key));comp.set(key,value);const after=clone(comp.get(key));
    if(JSON.stringify(before)===JSON.stringify(after))return after;const S=this,id=a.id,type=comp.type;
    const get=()=>{const x=S.world.findById(id),c=x&&x.components[idx];return c&&c.type===type?c:null;};
    this.history.push({label:'Edit '+type+'.'+key,mergeKey:'prop:'+id+':'+idx+':'+key,before,after,undo(){const c=get();if(c)c.set(key,this.before);},redo(){const c=get();if(c)c.set(key,this.after);},merge(n){this.after=n.after;}});return after;}
  addComponent(a,type){const c=this.world._addComponent(a,{type});if(!c){this.log('Could not add '+type+' to '+a.name,'warn');return null;}const S=this,id=a.id,idx=a.components.indexOf(c),data=c.serialize();
    this.history.push({label:'Add '+type,undo(){const x=S.world.findById(id);if(x&&x.components[idx])x.removeComponent(x.components[idx]);},redo(){const x=S.world.findById(id);if(x)S.world._addComponent(x,data,{index:idx});}});this._renderDetails();this._renderBlueprint();return c;}
  removeComponent(a,comp){const idx=a.components.indexOf(comp);if(idx<0)return false;const S=this,id=a.id,data=comp.serialize();a.removeComponent(comp);
    this.history.push({label:'Remove '+comp.type,undo(){const x=S.world.findById(id);if(x)S.world._addComponent(x,data,{index:idx});},redo(){const x=S.world.findById(id);if(x&&x.components[idx])x.removeComponent(x.components[idx]);}});this._renderDetails();this._renderBlueprint();return true;}
  renameActor(a,name){const before=a.name,after=this.world.rename(a,name);if(!after||after===before)return before;const S=this,id=a.id;
    this.history.push({label:'Rename '+before,undo(){const x=S.world.findById(id);if(x)S.world.rename(x,before);},redo(){const x=S.world.findById(id);if(x)S.world.rename(x,after);}});return after;}
  setVisible(a,v){const before=a.visible;if(before===!!v)return;a.visible=!!v;const S=this,id=a.id;this._dirty('outliner');
    this.history.push({label:(v?'Show ':'Hide ')+a.name,undo(){const x=S.world.findById(id);if(x){x.visible=before;S._dirty('outliner');}},redo(){const x=S.world.findById(id);if(x){x.visible=!!v;S._dirty('outliner');}}});}
  setTags(a,tags){const before=[...a.tags],after=[...new Set(tags.map(t=>String(t).trim()).filter(Boolean))];if(before.join('\u0000')===after.join('\u0000'))return;const S=this,id=a.id;
    const apply=list=>{const x=S.world.findById(id);if(!x)return;x.tags.clear();for(const t of list)x.tags.add(t);};apply(after);this.history.push({label:'Tags '+a.name,undo(){apply(before);},redo(){apply(after);}});}

  /* ===== Play In Editor ===== */
  /* play() snapshots the level, begins play and ticks the world each editor frame; stop() ends play and
     restores the snapshot (ids and selection preserved). Undo history is paused while playing. */
  play(){if(this.pie){if(this.pie.paused)this.pause(false);return true;}this._endXform();
    let snapshot;try{snapshot=KE.Level.serialize(this.world);}catch(e){this.log('Cannot snapshot level: '+e.message,'error');return false;}
    this.pie={snapshot,sel:this.selection.map(a=>a.id),paused:false,camera:{p:this.camera.position.clone(),q:this.camera.quaternion.clone()}};this.history.enabled=false;
    try{this.world.beginPlay();}catch(e){this.log('BeginPlay failed: '+e.message,'error');}
    if(this.options.onPlay)try{this.options.onPlay(this.world,this);}catch(e){this.log('onPlay: '+e.message,'error');}
    this._syncPie();this.log('Play In Editor started','info');this.events.emit('play',this);return true;}
  pause(v){if(!this.pie)return false;const p=v===undefined?!this.pie.paused:!!v;this.pie.paused=p;this.world.setPaused(p);this._syncPie();this.log(p?'Paused':'Resumed','dim');return p;}
  stop(){if(!this.pie)return false;const pie=this.pie;
    try{this.world.endPlay();}catch(e){this.log('EndPlay failed: '+e.message,'error');}
    if(this.options.onStop)try{this.options.onStop(this.world,this);}catch(e){this.log('onStop: '+e.message,'error');}
    this.pie=null;this.selection=[];try{KE.Level.load(this.world,pie.snapshot,{clear:true});}catch(e){this.log('Restoring the level failed: '+e.message,'error');}
    this.history.enabled=true;this.selectById(pie.sel);this._helpersDirty=true;this._syncPie();this._dirty('outliner');this.log('Play In Editor stopped · level restored','info');this.events.emit('stop',this);return true;}
  _syncPie(){if(!this._view)return;this._view.classList.toggle('ke-ed-pie',!!this.pie);this._view.classList.toggle('ke-ed-paused',!!(this.pie&&this.pie.paused));
    if(this._pieBan){this._pieBan.hidden=!this.pie;this._pieBan.textContent=this.pie?(this.pie.paused?'PAUSED':'PLAYING IN EDITOR')+' · Esc to stop':'';}this._syncToolbar();}

  /* ===== files: levels and glTF ===== */
  _slotKey(slot){return this.options.storageKey+':'+String(slot||'default');}
  saveLevel(slot='default'){let json,embedded=true;
    try{json=KE.Level.stringify(this.world,{embedAssets:true,name:this.options.levelName||this.world.name});localStorage.setItem(this._slotKey(slot),json);}
    catch(e){embedded=false;try{json=KE.Level.stringify(this.world,{name:this.options.levelName||this.world.name});localStorage.setItem(this._slotKey(slot),json);}catch(e2){this.log('Save failed: '+e2.message,'error');return 0;}}
    this.log('Saved level to browser storage slot "'+slot+'" ('+this.world.actors.length+' actors, '+(json.length/1024).toFixed(1)+' KB'+(embedded?'':', glTF assets not embedded: storage quota')+')','info');return json.length;}
  hasSavedLevel(slot='default'){try{return !!localStorage.getItem(this._slotKey(slot));}catch(e){return false;}}
  async loadLevel(slot='default'){let json=null;try{json=localStorage.getItem(this._slotKey(slot));}catch(e){}if(!json){this.log('No saved level in slot "'+slot+'"','warn');return false;}return this.loadLevelJSON(json,'slot "'+slot+'"');}
  /* Validates fully before touching the world; malformed input leaves the level untouched and is reported. */
  async loadLevelJSON(json,from='file'){if(this.pie)this.stop();
    try{const actors=await KE.Level.loadAsync(this.world,json,{clear:true});this.history.clear();this.select(null);this._helpersDirty=true;this._dirty('outliner');this.log('Loaded level from '+from+' ('+actors.length+' actors)','info');return true;}
    catch(e){this.log('Load failed: '+e.message,'error');if(e.errors)for(const m of e.errors.slice(0,8))this.log('  '+m,'error');return false;}}
  downloadLevel(filename){const name=filename||((this.world.name||'level').replace(/[^\w.-]+/g,'_')+'.level.json');download(name,KE.Level.stringify(this.world,{embedAssets:true,pretty:true}),'application/json');this.log('Downloaded '+name,'info');return name;}
  async uploadLevel(file){file=file||await pickFile('.json,application/json');if(!file)return false;let text;try{text=await file.text();}catch(e){this.log('Could not read '+file.name,'error');return false;}return this.loadLevelJSON(text,file.name);}
  /* glTF/GLB import (offline parse, no external URIs): registers a world asset and places a StaticMesh actor using it. */
  async importGLTF(src,name){let buffer=src,label=name;
    if(!src){src=await pickFile('.glb,.gltf,model/gltf-binary,model/gltf+json');if(!src)return null;}
    if(typeof Blob!=='undefined'&&src instanceof Blob){label=label||src.name||'model';buffer=await src.arrayBuffer();}
    if(!(buffer instanceof ArrayBuffer))throw new TypeError('importGLTF expects a File, Blob or ArrayBuffer');
    label=String(label||'model').replace(/\.(glb|gltf)$/i,'').replace(/[^\w.\- ]+/g,'_').slice(0,64)||'model';let id=label,n=1;while(this.world.getAsset(id))id=label+'_'+(++n);
    try{await KE.Level.decodeGLTF(this.world,id,buffer);}catch(e){this.log('glTF import failed: '+e.message,'error');return null;}
    const a=this.placeActor({name:label,class:'StaticMeshActor',components:[{type:'StaticMesh',mesh:{primitive:'gltf',asset:id}}]});this.log('Imported glTF "'+id+'"','info');return a;}
  /* Exports visible actor geometry and lights (no editor helpers) as GLB; resolves with the ArrayBuffer. */
  exportGLTF({download:dl=true,binary=true,filename}={}){const T=this.THREE;
    if(!T.GLTFExporter){this.log('THREE.GLTFExporter is not loaded','error');return Promise.reject(new Error('THREE.GLTFExporter is not loaded'));}
    const root=new T.Group();root.name=this.world.name||'Level';
    for(const a of this.world.actors){if(a.parent||!a.object.visible)continue;const c=a.object.clone(true);const drop=[];c.traverse(o=>{if(o.isSprite||o.isPoints||o.isLine||(o.isLight&&o.isHemisphereLight))drop.push(o);});for(const o of drop)o.parent&&o.parent.remove(o);root.add(c);}
    return new Promise((resolve,reject)=>{try{new T.GLTFExporter().parse(root,res=>{const name=filename||((this.world.name||'level').replace(/[^\w.-]+/g,'_')+(binary?'.glb':'.gltf'));
      if(dl)download(name,binary?res:JSON.stringify(res),binary?'model/gltf-binary':'model/gltf+json');this.log('Exported '+name+(binary?' ('+(res.byteLength/1024).toFixed(1)+' KB)':''),'info');resolve(res);},{binary,onlyVisible:true});}catch(e){this.log('glTF export failed: '+e.message,'error');reject(e);}});}

  /* ===== log ===== */
  log(text,level='info'){this._pushLog({text:String(text),level,stamp:Date.now(),src:'editor'});return this;}
  _pushLog(e){this.logEntries.push(e);if(this.logEntries.length>500)this.logEntries.shift();if(this._logEl&&this._logPass(e)){this._logEl.appendChild(this._logRow(e));while(this._logEl.childNodes.length>500)this._logEl.firstChild.remove();if(this._tab==='log'){const s=this._logEl.parentNode;if(s)s.scrollTop=s.scrollHeight;}}}
  _logPass(e){const f=this._logFilter;return f==='all'||(f==='warn'&&(e.level==='warn'||e.level==='error'))||(f==='print'&&e.level==='print');}
  _logRow(e){const d=new Date(e.stamp||Date.now());const ts=[d.getHours(),d.getMinutes(),d.getSeconds()].map(n=>String(n).padStart(2,'0')).join(':');
    return h('div',{className:e.level==='dim'?'':e.level},h('span.t',ts),(e.src==='world'&&e.level==='print'?'[BP] ':'')+e.text);}

  /* ===== world events → deferred UI refresh ===== */
  _onWorldEvent(ev,a,b,c){
    switch(ev){
      case 'log':this._pushLog({text:a.text,level:a.level,stamp:a.stamp,src:'world'});return;
      case 'destroy':{const i=this.selection.indexOf(a);if(i>=0){this.selection.splice(i,1);this._dirty('selection');}this._helpersDirty=true;this._dirty('outliner');return;}
      case 'spawn':case 'reorder':case 'levelLoaded':this._helpersDirty=true;this._dirty('outliner');return;
      case 'changed':this._dirty('outliner');if(b==='name'&&this.primary===a)this._dirty('head');return;
      case 'componentAdded':case 'componentRemoved':this._helpersDirty=true;if(this.selection.includes(a)){this._decoDirty=true;this._dirty('details');}return;
      case 'componentChanged':this._helpersDirty=true;if(this.selection.includes(a)){this._decoDirty=true;if(!this._panelEdit)this._dirty('details');}return;
      case 'beginPlay':case 'endPlay':this._syncToolbar();return;
    }
  }
  _dirty(what){(this._dirtySet||(this._dirtySet=new Set())).add(what);if(!this._flushQueued){this._flushQueued=true;Promise.resolve().then(()=>{this._flushQueued=false;this._flush();});}}
  _flush(){const d=this._dirtySet;if(!d||!d.size||!this.isOpen)return;const s=new Set(d);d.clear();
    if(s.has('selection'))this._onSelection();else{if(s.has('details'))this._renderDetails();if(s.has('head')&&!s.has('details'))this._renderDetails();}
    if(s.has('outliner'))this._renderOutliner();if(this._xfDirty)this._refreshTransformUI();}

  /* ===== viewport helpers: icons, volumes, selection bounds, light gizmos ===== */
  setShow(flag,v){if(!(flag in this.show)&&flag!=='game')throw new RangeError('Unknown show flag '+flag);this.show[flag]=v===undefined?!this.show[flag]:!!v;this._syncToolbar();this._statT=1;return this.show[flag];}
  _iconMat(name){let m=this._iconMats.get(name);if(!m){const e=spriteTexture(this.THREE,name);e.refs++;m=new this.THREE.SpriteMaterial({map:e.tex,depthTest:false,depthWrite:false,sizeAttenuation:false,transparent:true,toneMapped:false});this._iconMats.set(name,m);}return m;}
  _clearHelpers(){for(const s of this._icons.values())s.parent&&s.parent.remove(s);this._icons.clear();for(const v of this._vols.values()){v.parent&&v.parent.remove(v);if(v.geometry!==this._circle)v.geometry.dispose();}this._vols.clear();
    for(const b of this._boxes.values()){b.parent&&b.parent.remove(b);b.geometry.dispose();b.material.dispose();}this._boxes.clear();this._clearDecos();}
  _clearDecos(){for(const d of this._decos){d.obj.parent&&d.obj.parent.remove(d.obj);if(d.obj.geometry&&d.obj.geometry!==this._circle)d.obj.geometry.dispose();}this._decos=[];}
  _rebuildHelpers(){const T=this.THREE,S=this._helperScene;this._helpersDirty=false;
    for(const s of this._icons.values())S.remove(s);this._icons.clear();for(const v of this._vols.values()){S.remove(v);if(v.geometry!==this._circle)v.geometry.dispose();}this._vols.clear();
    for(const a of this.world.actors){const icon=spriteIcon(a);
      if(icon){const s=new T.Sprite(this._iconMat(icon));s.scale.set(.075,.075,1);s.layers.set(31);s.renderOrder=10;S.add(s);this._icons.set(a,s);}
      const tv=a.getComponent('TriggerVolume');if(tv){const p=tv.props;let v;if(p.shape==='sphere'){v=new T.LineSegments(this._circle,this._volMat);v.userData.r=p.radius;}else{const g=new T.EdgesGeometry(new T.BoxGeometry(p.size[0],p.size[1],p.size[2]));v=new T.LineSegments(g,this._volMat);}
        v.matrixAutoUpdate=false;v.layers.set(31);S.add(v);this._vols.set(a,v);}}
  }
  _rebuildDecos(){const T=this.THREE,S=this._helperScene;this._decoDirty=false;this._clearDecos();
    for(const a of this.selection){for(const c of a.components){let obj=null,kind=c.type,p=c.props;
      if(kind==='PointLight'){obj=new T.LineSegments(this._circle,this._decoMat);obj.userData.r=p.range||1;obj.userData.off=p.offset;}
      else if(kind==='SpotLight'){const L=p.range||5,r=Math.tan(p.angle*DEG)*L,pts=[],n=32;for(let i=0;i<n;i++){const a0=i/n*Math.PI*2,a1=(i+1)/n*Math.PI*2;pts.push(Math.cos(a0)*r,-L,Math.sin(a0)*r,Math.cos(a1)*r,-L,Math.sin(a1)*r);}
        for(let i=0;i<4;i++){const t=i/4*Math.PI*2;pts.push(0,0,0,Math.cos(t)*r,-L,Math.sin(t)*r);}const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pts,3));g.translate(...p.offset);obj=new T.LineSegments(g,this._decoMat);}
      else if(kind==='DirectionalLight'){const pts=[0,0,0,0,-2.5,0];for(let i=0;i<4;i++){const t=i/4*Math.PI*2;pts.push(0,-2.5,0,Math.cos(t)*.25,-2.1,Math.sin(t)*.25);}for(let i=0;i<5;i++){const x=(i-2)*.35;pts.push(x,0,0,x,-1.2,0);}
        const g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(pts,3));obj=new T.LineSegments(g,this._decoMat);}
      if(obj){obj.matrixAutoUpdate=false;obj.layers.set(31);S.add(obj);this._decos.push({a,obj,kind});}}}
  }
  _updateHelpers(){
    if(this._helpersDirty)this._rebuildHelpers();if(this._decoDirty)this._rebuildDecos();
    const cam=this.camera,game=!!(this.show.game||this.pie),icons=this.show.icons&&!game,g=this._grid,m=this._m,v=this._v;
    g.visible=this.show.grid&&!game;if(g.visible){const fade=Math.max(60,Math.abs(cam.position.y)*8);g.material.uniforms.uFade.value=fade;g.material.uniforms.uCam.value.copy(cam.position);g.scale.set(fade*2.2,1,fade*2.2);g.position.set(Math.round(cam.position.x/10)*10,0,Math.round(cam.position.z/10)*10);}
    for(const [a,s] of this._icons){s.visible=icons&&a.alive&&this._visibleChain(a.object);if(s.visible)a.getWorldPosition(s.position);}
    for(const [a,l] of this._vols){l.visible=icons&&a.alive&&this._visibleChain(a.object);if(!l.visible)continue;a.object.updateWorldMatrix(true,false);l.matrix.copy(a.object.matrixWorld);if(l.userData.r){l.matrix.multiply(m.makeScale(l.userData.r,l.userData.r,l.userData.r));}l.matrixWorld.copy(l.matrix);}
    for(const d of this._decos){const a=d.a;d.obj.visible=a.alive&&!game;if(!d.obj.visible)continue;a.object.updateWorldMatrix(true,false);
      if(d.obj.userData.r){a.getWorldPosition(v[0]);const off=d.obj.userData.off||[0,0,0];v[1].fromArray(off).applyQuaternion(a.object.getWorldQuaternion(this._q));d.obj.matrix.makeScale(d.obj.userData.r,d.obj.userData.r,d.obj.userData.r).setPosition(v[0].add(v[1]));}
      else{a.object.matrixWorld.decompose(v[0],this._q,v[1]);d.obj.matrix.compose(v[0],this._q,v[2].set(1,1,1));}d.obj.matrixWorld.copy(d.obj.matrix);}
    /* selection bounds */
    for(const [a,b] of this._boxes)if(!this.selection.includes(a)){b.parent&&b.parent.remove(b);b.geometry.dispose();b.material.dispose();this._boxes.delete(a);}
    for(const a of this.selection){let b=this._boxes.get(a);if(!b){b=new this.THREE.Box3Helper(new this.THREE.Box3(),0xf3a43a);b.material.depthTest=false;b.material.transparent=true;b.material.opacity=.95;b.material.toneMapped=false;b.layers.set(31);b.renderOrder=5;this._helperScene.add(b);this._boxes.set(a,b);}
      b.visible=this.show.bounds&&a.alive;if(!b.visible)continue;b.box.setFromObject(a.object);if(b.box.isEmpty()){a.getWorldPosition(v[0]);b.box.setFromCenterAndSize(v[0],v[1].set(.6,.6,.6));}else b.box.expandByScalar(.02);}
    if(!this._xf&&!(this.gizmo&&this.gizmo.dragging))this._syncPivot();
    if(this.gizmo)this.gizmo.visible=!!this.primary&&this.mode!=='select';
  }
}
Editor.instances=[];Editor.active=null;Editor.FLY_SPEEDS=FLY_SPEEDS;Editor.CommandStack=CommandStack;
const clone=v=>v===undefined?undefined:JSON.parse(JSON.stringify(v));

/* ---------- editor UI (DOM built on open, removed on close) ---------- */
const CAT_ORDER=['Basic','Shapes','Lights','Volumes','Effects','Audio','Gameplay','Prefabs'];
const NODE_COLORS={Flow:'#8d96a8',Actor:'#3d8cff',Transform:'#46c46f',Audio:'#38b6d8',Effects:'#e86f9a',Physics:'#f08a3c',Variables:'#9b7bff',Events:'#e2a93b',Rendering:'#d9b640',Utility:'#7f8896',Game:'#ef5b5b',Custom:'#7f8896'};
Object.assign(Editor.prototype,{
  _btn(icon,title,fn,{label,cls='',kbd}={}){const b=h('button',{type:'button',className:'ke-ed-btn '+cls,title:title+(kbd?' ('+kbd+')':''),'aria-label':title,on:{click:e=>fn(e)}},svg(icon),label?h('span',label):null);return b;},
  _buildDOM(){
    const root=this._root=h('div.ke-ed-root',{role:'application','aria-label':'Kitsune level editor'});
    root.append(this._buildToolbar(),this._buildDrawer(),this._buildViewport(),this._buildSide(),this._buildBottom());
    (this.options.container||document.body).appendChild(root);
  },
  _buildToolbar(){
    const B=this._btn.bind(this),tb=this._tb={};
    const modes=h('div.ke-ed-seg',{role:'radiogroup','aria-label':'Transform tool'});
    for(const [m,icon,title,k] of [['select','select','Select','Q'],['translate','move','Translate','W'],['rotate','rotate','Rotate','E'],['scale','scale','Scale','R']]){const b=B(icon,title,()=>this.setMode(m),{kbd:k});b.setAttribute('role','radio');modes.appendChild(tb[m]=b);}
    tb.space=B('world','Coordinate space: world / local',()=>this.setSpace(this.space==='world'?'local':'world'));
    tb.snap=B('snap','Grid snapping',()=>this.setSnap({enabled:!this.snap.enabled}));
    const sel=(opts,val,title,fn,cls='')=>{const s=h('select',{className:'ke-ed-sel '+cls,title,'aria-label':title,on:{change:e=>fn(e.target.value)}},opts.map(([v,t])=>h('option',{value:String(v)},t)));s.value=String(val);return s;};
    tb.snapT=sel([.01,.1,.25,.5,1,5,10].map(v=>[v,v+' m']),this.snap.translate,'Translation snap',v=>this.setSnap({translate:+v}),'ke-ed-hide-sm');
    tb.snapR=sel([1,5,10,15,30,45,90].map(v=>[v,v+'°']),this.snap.rotate,'Rotation snap',v=>this.setSnap({rotate:+v}),'ke-ed-hide-sm');
    tb.snapS=sel([.05,.1,.25,.5,1].map(v=>[v,'×'+v]),this.snap.scale,'Scale snap',v=>this.setSnap({scale:+v}),'ke-ed-hide-sm');
    this._speedSel=sel(FLY_SPEEDS.map((s,i)=>[i,'Speed '+(i+1)]),this.speedIndex,'Camera speed (mouse wheel while flying)',v=>this.setCameraSpeed(+v),'ke-ed-hide-sm');
    const cv=KE.cvars&&KE.cvars.find('r.ViewMode'),vm=[...new Set([...((cv&&cv.options)||['lit']),...VIEW_MODES_EXTRA])];
    tb.view=sel(vm.map(v=>[v,v[0].toUpperCase()+v.slice(1)]),this.viewMode,'View mode (r.ViewMode)',v=>this.setViewMode(v),'ke-ed-hide-xs');
    tb.grid=B('grid','Show grid',()=>this.setShow('grid'));tb.stats=B('stats','Show viewport stats',()=>this.setShow('stats'));
    tb.play=B('play','Play in editor',()=>this.play(),{cls:'ke-ed-play',kbd:'Alt+P'});tb.pause=B('pause','Pause',()=>this.pause(),{cls:'ke-ed-pause'});tb.stop=B('stop','Stop',()=>this.stop(),{cls:'ke-ed-stop',kbd:'Esc'});
    tb.undo=B('undo','Undo',()=>this.undo(),{kbd:'Ctrl+Z'});tb.redo=B('redo','Redo',()=>this.redo(),{kbd:'Ctrl+Y'});
    tb.file=B('file','Level and file menu',e=>this._fileMenu(e.currentTarget),{label:'File'});
    tb.drawer=B('drawer','Toggle Place Actors panel',()=>this._toggleDrawer());
    tb.close=B('close','Close editor',()=>this.close(),{kbd:'F8'});
    return h('div.ke-ed-bar',{role:'toolbar','aria-label':'Editor toolbar'},
      h('div.ke-ed-brand',h('i'),'Tenko',h('small','Editor')),tb.drawer,h('div.ke-ed-sep'),modes,tb.space,h('div.ke-ed-seg',tb.snap,tb.snapT,tb.snapR,tb.snapS),h('div.ke-ed-sep.ke-ed-hide-xs'),
      this._speedSel,tb.view,tb.grid,tb.stats,h('div.ke-ed-grow'),h('div.ke-ed-seg',{'aria-label':'Play controls'},tb.play,tb.pause,tb.stop),h('div.ke-ed-grow'),tb.undo,tb.redo,h('div.ke-ed-sep'),tb.file,tb.close);
  },
  _syncToolbar(){const tb=this._tb;if(!tb||!this.isOpen)return;const on=(b,v)=>{b.classList.toggle('on',!!v);b.setAttribute(b.getAttribute('role')==='radio'?'aria-checked':'aria-pressed',String(!!v));};
    for(const m of ['select','translate','rotate','scale'])on(tb[m],this.mode===m);
    tb.space.replaceChildren(svg(this.space==='world'?'world':'local'),h('span.ke-ed-hide-sm',this.space==='world'?'World':'Local'));tb.space.title='Coordinate space: '+this.space;
    on(tb.snap,this.snap.enabled);for(const k of ['snapT','snapR','snapS'])tb[k].disabled=!this.snap.enabled;on(tb.grid,this.show.grid);on(tb.stats,this.show.stats);
    on(tb.play,!!this.pie&&!this.pie.paused);on(tb.pause,!!(this.pie&&this.pie.paused));tb.pause.disabled=tb.stop.disabled=!this.pie;
    tb.undo.disabled=!!this.pie||!this.history.canUndo;tb.redo.disabled=!!this.pie||!this.history.canRedo;
    if(this.history.canUndo)tb.undo.title='Undo '+this.history.done[this.history.done.length-1].label+' (Ctrl+Z)';
    if(tb.view.value!==this.viewMode)tb.view.value=this.viewMode;if(this._chipView)this._chipView.textContent=this.viewMode[0].toUpperCase()+this.viewMode.slice(1);},
  setViewMode(v){if(VIEW_MODES_EXTRA.includes(v)){this.viewMode=v;try{KE.cvars&&KE.cvars.find('r.ViewMode')&&KE.cvars.set('r.ViewMode','lit');}catch(e){}}
    else{try{if(KE.cvars&&KE.cvars.find('r.ViewMode'))KE.cvars.set('r.ViewMode',v);this.viewMode=v;}catch(e){this.log(e.message,'warn');}}this._syncToolbar();return this.viewMode;},
  _toggleDrawer(){const r=this._root;if(innerWidth<=900)r.classList.toggle('ke-ed-drawer-open');else r.classList.toggle('ke-ed-nodrawer');this._layout(true);},
  _fileMenu(anchor){this._menu(anchor,[
    {icon:'save',label:'Save level',kbd:'Ctrl+S',fn:()=>this.saveLevel()},{icon:'folder',label:'Load saved level',fn:()=>this.loadLevel(),disabled:!this.hasSavedLevel()},'-',
    {icon:'download',label:'Download level (.json)',fn:()=>this.downloadLevel()},{icon:'upload',label:'Open level file…',fn:()=>this.uploadLevel()},'-',
    {icon:'gltf',label:'Import glTF / GLB…',fn:()=>this.importGLTF()},{icon:'download',label:'Export level as GLB',fn:()=>this.exportGLTF().catch(()=>{})},'-',
    {icon:'trash',label:'New empty level',fn:()=>{if(this.pie)this.stop();this.world.clear();this.history.clear();this.select(null);this.log('New empty level','info');}}]);},
  /* Popover menu: keyboard navigable, closes on outside press, Escape or activation. */
  _menu(anchor,items){this._closeMenu();const m=h('div.ke-ed-menu',{role:'menu'});
    for(const it of items){if(it==='-'){m.appendChild(h('hr'));continue;}const b=h('button',{type:'button',role:'menuitem',disabled:!!it.disabled,on:{click:()=>{this._closeMenu();it.fn();}}},svg(it.icon||'dot'),h('span',it.label),it.kbd?h('kbd',it.kbd):null);m.appendChild(b);}
    const r=anchor.getBoundingClientRect();document.body.appendChild(m);const w=m.offsetWidth;m.style.left=Math.max(4,Math.min(innerWidth-w-4,r.right-w))+'px';m.style.top=(r.bottom+4)+'px';
    const btns=[...m.querySelectorAll('button:not([disabled])')];btns[0]&&btns[0].focus();
    m.addEventListener('keydown',e=>{const i=btns.indexOf(document.activeElement);if(e.key==='ArrowDown'){e.preventDefault();btns[(i+1)%btns.length].focus();}else if(e.key==='ArrowUp'){e.preventDefault();btns[(i-1+btns.length)%btns.length].focus();}else if(e.key==='Escape'){e.preventDefault();this._closeMenu();anchor.focus();}});
    const away=e=>{if(!m.contains(e.target)&&e.target!==anchor&&!anchor.contains(e.target))this._closeMenu();};setTimeout(()=>{if(this._menuEl===m)document.addEventListener('pointerdown',away,true);},0);
    this._menuEl=m;this._menuAway=away;},
  _closeMenu(){if(this._menuEl){this._menuEl.remove();this._menuEl=null;document.removeEventListener('pointerdown',this._menuAway,true);}},

  /* ----- viewport slot ----- */
  _buildViewport(){
    this._chipView=h('b','Lit');this._chipSpeed=h('span','Speed '+(this.speedIndex+1));
    this._statsEl=h('div.ke-ed-vstats',{hidden:true,'aria-live':'off'});this._pieBan=h('div.ke-ed-pieban',{hidden:true,role:'status'});
    return this._view=h('div.ke-ed-view',{tabIndex:0,role:'region','aria-label':'Viewport. Click to select, Shift-click to add, right-drag and WASD to fly, F to focus, Delete to delete'},
      h('div.ke-ed-vinfo',h('div.ke-ed-chip',h('b','Perspective')),h('div.ke-ed-chip',this._chipView),h('div.ke-ed-chip.ke-ed-hide-xs',this._chipSpeed)),this._statsEl,this._pieBan);
  },

  /* ----- place actors drawer ----- */
  _buildDrawer(){
    const list=h('div.ke-ed-scroll',{role:'list'}),q=h('input',{className:'ke-ed-in',type:'search',placeholder:'Search classes and prefabs','aria-label':'Search classes and prefabs',on:{input:()=>this._renderDrawer()}});
    this._drawerList=list;this._drawerQ=q;
    return h('div.ke-ed-panel.ke-ed-drawer',{role:'region','aria-label':'Place actors'},h('div.ke-ed-ph','Place Actors'),h('div.ke-ed-search',svg('search'),q),list);
  },
  _renderDrawer(){const list=this._drawerList;if(!list)return;list.textContent='';const q=this._drawerQ.value.trim().toLowerCase(),groups=new Map();
    const add=(cat,it)=>{if(q&&!(it.label.toLowerCase().includes(q)||cat.toLowerCase().includes(q)))return;if(!groups.has(cat))groups.set(cat,[]);groups.get(cat).push(it);};
    for(const c of KE.ActorClasses.list())add(c.category,{label:c.label,help:c.help||'Actor class',icon:c.icon||'empty',def:{class:c.name}});
    for(const p of KE.Prefabs.list())add(p.category,{label:p.label,help:p.category==='Shapes'?'Static mesh':'Prefab',icon:p.icon||'mesh',def:{prefab:p.name}});
    const cats=[...groups.keys()].sort((a,b)=>{const i=CAT_ORDER.indexOf(a),j=CAT_ORDER.indexOf(b);return (i<0?99:i)-(j<0?99:j)||a.localeCompare(b);});
    if(!cats.length)list.appendChild(h('div.ke-ed-empty','Nothing matches "'+q+'"'));
    for(const cat of cats){list.appendChild(h('div.ke-ed-cat',cat));for(const it of groups.get(cat)){const b=h('button.ke-ed-item',{type:'button',draggable:true,role:'listitem',title:'Click to place in front of the camera, or drag into the viewport',
        on:{click:()=>this.placeActor(it.def),dragstart:e=>{e.dataTransfer.setData('text/ke-actor',JSON.stringify(it.def));e.dataTransfer.effectAllowed='copy';}}},
        h('span.ke-ed-ico',{style:{'--c':iconColor(it.icon)}},svg(it.icon)),h('span',it.label,h('small',it.help)));list.appendChild(b);}}},

  /* ----- outliner + details column ----- */
  _buildSide(){
    const q=h('input',{className:'ke-ed-in',type:'search',placeholder:'Search actors','aria-label':'Search actors',on:{input:()=>this._renderOutliner()}});
    this._outlCount=h('span',{style:{marginLeft:'auto',fontWeight:500,letterSpacing:0,textTransform:'none',color:'var(--dim)'}});
    this._outl=h('div.ke-ed-scroll',{role:'tree','aria-label':'Actors',tabIndex:0,'aria-multiselectable':'true'});this._outlQ=q;
    const o=this._outl;
    o.addEventListener('click',e=>{const row=e.target.closest('.ke-ed-row');if(!row)return;const a=this.world.findById(+row.dataset.id);if(!a)return;
      if(e.target.closest('.ke-ed-eye')){this.setVisible(a,!a.visible);return;}this.select(a,{toggle:e.shiftKey||e.ctrlKey||e.metaKey});row.focus({preventScroll:true});});
    o.addEventListener('dblclick',e=>{const row=e.target.closest('.ke-ed-row');if(!row||e.target.closest('.ke-ed-eye'))return;const a=this.world.findById(+row.dataset.id);if(a)this._inlineRename(row,a);});
    o.addEventListener('keydown',e=>{const rows=[...o.querySelectorAll('.ke-ed-row')];if(!rows.length)return;let i=rows.indexOf(document.activeElement);
      if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();i=clamp(i+(e.key==='ArrowDown'?1:-1),0,rows.length-1);rows[i].focus();const a=this.world.findById(+rows[i].dataset.id);if(a)this.select(a,{add:e.shiftKey});}
      else if(e.key==='F2'&&this.primary){e.preventDefault();const r=o.querySelector('[data-id="'+this.primary.id+'"]');if(r)this._inlineRename(r,this.primary);}
      else if(e.key==='Enter'){e.preventDefault();this.focus();}});
    this._detBody=h('div.ke-ed-scroll');
    return h('div.ke-ed-side',
      h('div.ke-ed-outl',{role:'region','aria-label':'Outliner'},h('div.ke-ed-ph','Outliner',this._outlCount),h('div.ke-ed-search',svg('search'),q),h('div.ke-ed-cols',h('span','Item Label'),h('span','Type')),o),
      h('div.ke-ed-det',{role:'region','aria-label':'Details'},h('div.ke-ed-ph','Details'),this._detBody));
  },
  _renderOutliner(){const o=this._outl;if(!o)return;const q=this._outlQ.value.trim().toLowerCase(),rows=[],MAX=1500;let total=0;
    const walk=(a,d)=>{const hit=!q||a.name.toLowerCase().includes(q)||a.className.toLowerCase().includes(q)||[...a.tags].some(t=>t.toLowerCase().includes(q));if(hit){total++;if(rows.length<MAX)rows.push([a,d]);}for(const c of a.children)walk(c,q?d:d+1);};
    for(const a of this.world.actors)if(!a.parent)walk(a,0);
    const focusId=document.activeElement&&o.contains(document.activeElement)&&document.activeElement.dataset.id,st=o.scrollTop;o.textContent='';
    const frag=document.createDocumentFragment();
    for(const [a,d] of rows){const icon=actorIcon(a),sel=this.selection.includes(a);
      frag.appendChild(h('div',{className:'ke-ed-row'+(sel?' sel':'')+(a.visible?'':' hid'),role:'treeitem','aria-selected':String(sel),tabIndex:-1,dataset:{id:String(a.id)},style:{'--d':String(d)},title:a.name+' · '+a.className+(a.tags.size?' · tags: '+[...a.tags].join(', '):'')},
        h('button',{type:'button',className:'ke-ed-btn ke-ed-eye',tabIndex:-1,title:a.visible?'Hide':'Show','aria-label':(a.visible?'Hide ':'Show ')+a.name},svg(a.visible?'eye':'eyeoff')),
        h('span.ke-ed-glyph',{style:{'--c':iconColor(icon)}},svg(icon)),h('span.ke-ed-name',a.name),h('span.ke-ed-type',a.className)));}
    if(total>rows.length)frag.appendChild(h('div.ke-ed-more',(total-rows.length)+' more… refine the search'));
    if(!rows.length)frag.appendChild(h('div.ke-ed-empty',q?'No actors match "'+q+'"':'The level is empty. Place actors from the panel on the left.'));
    o.appendChild(frag);o.scrollTop=st;if(focusId){const r=o.querySelector('[data-id="'+focusId+'"]');if(r)r.focus({preventScroll:true});}
    this._outlCount.textContent=this.world.actors.length+' actor'+(this.world.actors.length===1?'':'s');},
  _markSelectionUI(){const o=this._outl;if(!o)return;for(const r of o.querySelectorAll('.ke-ed-row')){const a=this.world.findById(+r.dataset.id),s=!!a&&this.selection.includes(a);r.classList.toggle('sel',s);r.setAttribute('aria-selected',String(s));}
    const p=this.primary&&o.querySelector('[data-id="'+this.primary.id+'"]');if(p)p.scrollIntoView({block:'nearest'});this._syncToolbar();},
  _inlineRename(row,a){const span=row.querySelector('.ke-ed-name');if(!span)return;const inp=h('input',{className:'ke-ed-in',value:a.name,'aria-label':'Rename '+a.name,style:{height:'20px'}});span.replaceWith(inp);inp.focus();inp.select();
    let done=false;const finish=ok=>{if(done)return;done=true;if(ok&&inp.value.trim())this.renameActor(a,inp.value);this._renderOutliner();this._renderDetails();};
    inp.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter')finish(true);else if(e.key==='Escape')finish(false);});inp.addEventListener('blur',()=>finish(true));},

  /* ----- details: generated from component schemas ----- */
  _renderDetails(){const body=this._detBody;if(!body)return;const act=document.activeElement,fk=act&&body.contains(act)?act.dataset.k:null,st=body.scrollTop;body.textContent='';this._xfInputs=null;
    const sel=this.selection;this._shut=this._shut||new Set();
    if(!sel.length){body.appendChild(h('div.ke-ed-empty','Select an actor in the viewport or the Outliner to see its details.'));return;}
    if(sel.length>1){body.append(h('div.ke-ed-head',h('span.ke-ed-ico',svg('copy')),h('b',sel.length+' actors selected'),h('span'),h('small',sel.map(a=>a.name).slice(0,8).join(', ')+(sel.length>8?'…':''))),
      h('div.ke-ed-add',this._btn('focus','Focus',()=>this.focus(),{label:'Focus'}),this._btn('copy','Duplicate',()=>this.duplicate(),{label:'Duplicate'}),this._btn('trash','Delete',()=>this.deleteSelected(),{label:'Delete',cls:'ke-ed-danger'})),
      h('div.ke-ed-empty','Use the gizmo to transform the whole selection. Select one actor to edit its properties.'));return;}
    const a=sel[0],icon=actorIcon(a);
    const name=h('input',{className:'ke-ed-in',value:a.name,'aria-label':'Actor name',dataset:{k:'name'},on:{change:e=>{e.target.value=this.renameActor(a,e.target.value);},keydown:e=>{if(e.key==='Enter')e.target.blur();}}});
    body.appendChild(h('div.ke-ed-head',h('span.ke-ed-ico',{style:{'--c':iconColor(icon)}},svg(icon)),name,this._btn('focus','Focus camera on actor',()=>this.focus(),{kbd:'F'}),
      h('small',a.className+' · id '+a.id+(a.prefab?' · prefab '+a.prefab:'')+(a.parent?' · parent '+a.parent.name:''))));
    /* transform */
    const t=a.getTransform(),xf=this._xfInputs={};
    const tr=[['position','Location'],['rotation','Rotation'],['scale','Scale']].map(([ch,label])=>{const {el,inputs}=this._vec3(t[ch],v=>this.setActorTransform(a,ch,v),'xf.'+ch);xf[ch]=inputs;return this._prop(label,el);});
    body.appendChild(this._section('Transform','',tr));
    const tags=h('input',{className:'ke-ed-in',value:[...a.tags].join(', '),placeholder:'tag, another',dataset:{k:'tags'},'aria-label':'Tags',on:{change:e=>this.setTags(a,e.target.value.split(','))}});
    const vis=h('input',{type:'checkbox',className:'ke-ed-chk',checked:a.visible,dataset:{k:'visible'},'aria-label':'Visible',on:{change:e=>this.setVisible(a,e.target.checked)}});
    body.appendChild(this._section('Actor','',[this._prop('Visible',vis),this._prop('Tags',tags)]));
    a.components.forEach((c,i)=>body.appendChild(this._componentSection(a,c,i)));
    const types=KE.Components.list().filter(d=>!(KE.Components.get(d.type).unique&&a.getComponent(d.type))),cats=[...new Set(types.map(d=>d.category))];
    const addSel=h('select',{className:'ke-ed-sel','aria-label':'Component to add',style:{flex:'1',maxWidth:'none'}},h('option',{value:''},'Add component…'),cats.map(cat=>h('optgroup',{label:cat},types.filter(d=>d.category===cat).map(d=>h('option',{value:d.type},d.label)))));
    addSel.addEventListener('change',()=>{if(addSel.value)this.addComponent(a,addSel.value);});
    body.appendChild(h('div.ke-ed-add',addSel));
    body.scrollTop=st;if(fk){const el=body.querySelector('[data-k="'+fk.replace(/"/g,'')+'"]');if(el)el.focus({preventScroll:true});}},
  _section(title,sub,rows,{key=title,actions=null}={}){const shut=this._shut.has(key);
    const head=h('div.ke-ed-sech',{role:'button',tabIndex:0,'aria-expanded':String(!shut)},h('span.ke-ed-chev',svg('chev')),h('span',title),sub?h('small',sub):null,actions);
    const sec=h('div',{className:'ke-ed-sec'+(shut?' shut':'')},head,h('div.ke-ed-secb',rows));
    const tog=e=>{if(e.target.closest('button'))return;const s=sec.classList.toggle('shut');head.setAttribute('aria-expanded',String(!s));if(s)this._shut.add(key);else this._shut.delete(key);};
    head.addEventListener('click',tog);head.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();tog(e);}});return sec;},
  _prop(label,el,{scrub=null,title}={}){const l=h('label',{title:title||label},label);if(scrub)this._scrub(l,scrub);return h('div.ke-ed-prop',l,el);},
  /* Drag a numeric label horizontally to scrub its value (Shift = 10×); consecutive edits merge into one undo step. */
  _scrub(label,{get,set,step=.1}){label.classList.add('ke-ed-scrub');label.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();const x0=e.clientX,v0=get();label.setPointerCapture(e.pointerId);
    const mv=ev=>{const k=(ev.shiftKey?10:1)*step;set(Math.round((v0+(ev.clientX-x0)*k)/step)*step);},up=()=>{label.removeEventListener('pointermove',mv);label.removeEventListener('pointerup',up);};label.addEventListener('pointermove',mv);label.addEventListener('pointerup',up);});},
  _vec3(val,commit,k,{placeholder}={}){const inputs=[0,1,2].map(i=>h('input',{className:'ke-ed-in',inputMode:'decimal',value:val?fmt(val[i]):'',placeholder:placeholder||'',dataset:{k:k+'.'+i},'aria-label':['X','Y','Z'][i]}));
    const read=()=>inputs.map(inp=>parseFloat(inp.value));
    for(const inp of inputs){inp.addEventListener('change',()=>{const v=read();const bad=v.some(n=>!Number.isFinite(n));for(const x of inputs)x.classList.toggle('ke-ed-bad',bad&&!Number.isFinite(parseFloat(x.value)));if(!bad)commit(v);});inp.addEventListener('keydown',e=>{if(e.key==='Enter')inp.blur();});}
    const el=h('div.ke-ed-v3',inputs.map((inp,i)=>h('div.ke-ed-ax',{style:{'--c':['var(--x)','var(--y)','var(--z)'][i]}},inp)));return {el,inputs};},
  _refreshTransformUI(){this._xfDirty=false;const x=this._xfInputs,a=this.primary;if(!x||!a||this.selection.length!==1)return;const t=a.getTransform();
    for(const ch of ['position','rotation','scale'])x[ch].forEach((inp,i)=>{if(document.activeElement!==inp)inp.value=fmt(t[ch][i]);});},
  _componentSection(a,c,idx){const d=c.def,rows=[];
    for(const f of KE.Components.fields(c.type,c.props))rows.push(this._fieldRow(a,c,f));
    if(c.type==='Blueprint')rows.push(h('div.ke-ed-add',this._btn('script','Open the Blueprint editor',()=>this._setTab('bp'),{label:'Edit Blueprint graph',cls:'ke-ed-primary'})));
    if(!rows.length)rows.push(h('div.ke-ed-empty',{style:{padding:'6px 12px'}},'No editable properties'));
    const rm=this._btn('trash','Remove component',()=>this.removeComponent(a,c),{cls:'ke-ed-danger'});
    return this._section(d.label,d.type!==d.label.replace(/\s+/g,'')?d.type:'',rows,{key:'c:'+c.type,actions:rm});},
  /* One schema field → widget. Edits go through setProperty (validated by the component schema, undoable). */
  _fieldRow(a,c,f){const key=f.key,val=c.get(key),dk='c'+a.components.indexOf(c)+'.'+key;
    const commit=v=>{this._panelEdit=true;let out;try{out=this.setProperty(a,c,key,v);}finally{this._panelEdit=false;}
      const sig=KE.Components.fields(c.type,c.props).map(x=>x.key).join('|');if(sig!==this._fieldSig(c,f))this._later('details',()=>this._renderDetails());return out;};
    this._sigs=this._sigs||new WeakMap();this._sigs.set(c,KE.Components.fields(c.type,c.props).map(x=>x.key).join('|'));
    let el,scrub=null;
    switch(f.type){
      case 'number':{const inp=h('input',{className:'ke-ed-in',inputMode:'decimal',value:fmt(val,4),dataset:{k:dk},'aria-label':f.label});
        inp.addEventListener('change',()=>{const n=parseFloat(inp.value);inp.classList.toggle('ke-ed-bad',!Number.isFinite(n));if(Number.isFinite(n)){const r=commit(n);inp.value=fmt(r,4);}});inp.addEventListener('keydown',e=>{if(e.key==='Enter')inp.blur();});
        el=inp;scrub={get:()=>+c.get(key)||0,set:v=>{const r=commit(f.integer?Math.round(v):v);inp.value=fmt(r,4);},step:f.integer?1:(f.step||.1)};break;}
      case 'vec3':el=this._vec3(val,v=>commit(v),dk).el;break;
      case 'color':{const pick=h('input',{type:'color',className:'ke-ed-in',value:val,dataset:{k:dk},'aria-label':f.label}),txt=h('input',{className:'ke-ed-in',value:val,'aria-label':f.label+' hex'});
        pick.addEventListener('input',()=>{txt.value=commit(pick.value);});txt.addEventListener('change',()=>{const r=commit(txt.value);txt.value=r;pick.value=r;});el=h('div.ke-ed-flex',pick,txt);break;}
      case 'bool':el=h('input',{type:'checkbox',className:'ke-ed-chk',checked:!!val,dataset:{k:dk},'aria-label':f.label,on:{change:e=>commit(e.target.checked)}});break;
      case 'enum':el=h('select',{className:'ke-ed-sel',style:{maxWidth:'none',width:'100%'},dataset:{k:dk},'aria-label':f.label,on:{change:e=>commit(e.target.value)}},f.options.map(o=>h('option',{value:o},o)));el.value=val;break;
      case 'asset':{const assets=this.world.assets();el=h('select',{className:'ke-ed-sel',style:{maxWidth:'none',width:'100%'},dataset:{k:dk},'aria-label':f.label,on:{change:e=>commit(e.target.value)}},h('option',{value:''},assets.length?'(none)':'No assets: File ▸ Import glTF'),assets.map(o=>h('option',{value:o},o)));
        if(val&&!assets.includes(val))el.appendChild(h('option',{value:val},val+' (missing)'));el.value=val;break;}
      case 'text':el=h('textarea',{className:'ke-ed-in',rows:2,value:val,dataset:{k:dk},'aria-label':f.label,on:{change:e=>commit(e.target.value)}});break;
      case 'json':{if(c.type==='Blueprint'&&key==='graph')return h('div');const ta=h('textarea',{className:'ke-ed-in',rows:3,value:JSON.stringify(val),dataset:{k:dk},'aria-label':f.label});
        ta.addEventListener('change',()=>{try{commit(JSON.parse(ta.value||'null'));ta.classList.remove('ke-ed-bad');}catch(e){ta.classList.add('ke-ed-bad');ta.title=e.message;}});el=ta;break;}
      default:{const listId='ke-ed-dl-'+(++dlCount),sug=typeof f.suggest==='function'?(()=>{try{return f.suggest()||[];}catch(e){return [];}})():[];
        const inp=h('input',{className:'ke-ed-in',value:val,dataset:{k:dk},'aria-label':f.label,list:sug.length?listId:null,on:{change:e=>{e.target.value=commit(e.target.value);},keydown:e=>{if(e.key==='Enter')e.target.blur();}}});
        el=sug.length?h('div.ke-ed-flex',inp,h('datalist',{id:listId},sug.map(s=>h('option',{value:s})))):inp;}
    }
    return this._prop(f.label,el,{scrub,title:(f.help||f.label)+' ('+key+')'});},
  _fieldSig(c){return this._sigs&&this._sigs.get(c);},
  _later(key,fn){this._laterT=this._laterT||{};if(this._laterT[key])return;this._laterT[key]=setTimeout(()=>{this._laterT[key]=0;if(this.isOpen)fn();},0);},

  /* ----- bottom: output log + Blueprint editor ----- */
  _buildBottom(){
    const tab=(id,icon,label)=>h('button',{type:'button',className:'ke-ed-tab',role:'tab',dataset:{tab:id},on:{click:()=>this._setTab(id)}},svg(icon),label);
    this._tabs={log:tab('log','log','Output Log'),bp:tab('bp','script','Blueprint')};
    this._logFilterSel=h('select',{className:'ke-ed-sel','aria-label':'Log filter',on:{change:e=>{this._logFilter=e.target.value;this._fillLog();}}},h('option',{value:'all'},'All messages'),h('option',{value:'warn'},'Warnings and errors'),h('option',{value:'print'},'Blueprint prints'));
    this._logTools=h('div.ke-ed-flex',{style:{alignSelf:'center'}},this._logFilterSel,this._btn('trash','Clear log',()=>{this.logEntries.length=0;this._fillLog();}));
    this._logEl=h('div.ke-ed-log');this._logPane=h('div.ke-ed-scroll',{role:'tabpanel','aria-label':'Output log'},this._logEl);
    this._bpBody=h('div',{style:{flex:'1 1 auto',minHeight:'0'},role:'tabpanel','aria-label':'Blueprint editor'});
    const el=h('div.ke-ed-bottom',h('div.ke-ed-tabs',{role:'tablist'},this._tabs.log,this._tabs.bp,h('div.ke-ed-grow'),this._logTools),this._logPane,this._bpBody);
    return el;
  },
  _setTab(id){this._tab=id;for(const [k,b] of Object.entries(this._tabs)){b.classList.toggle('on',k===id);b.setAttribute('aria-selected',String(k===id));}
    this._logPane.hidden=id!=='log';this._bpBody.hidden=id!=='bp';this._logTools.hidden=id!=='log';if(id==='bp')this._renderBlueprint();else this._logPane.scrollTop=this._logPane.scrollHeight;},
  _fillLog(){const el=this._logEl;if(!el)return;el.textContent='';const f=document.createDocumentFragment();for(const e of this.logEntries)if(this._logPass(e))f.appendChild(this._logRow(e));el.appendChild(f);this._logPane.scrollTop=this._logPane.scrollHeight;},
  _renderAll(){this._syncToolbar();this._renderDrawer();this._renderOutliner();this._renderDetails();this._fillLog();this._setTab(this._tab);},

  /* ----- structured Blueprint editor ----- */
  /* Edits a working copy of the selected actor's graph; every change is committed through setProperty
     (validated by KE.Blueprint rules and undoable), then the panel re-renders keeping focus. */
  _renderBlueprint(){const body=this._bpBody;if(!body||body.hidden)return;const act=document.activeElement,fk=act&&body.contains(act)?act.dataset.k:null;const main0=body.querySelector('.ke-ed-bpm'),st=main0?main0.scrollTop:0;body.textContent='';
    const a=this.selection.length===1?this.selection[0]:null;
    if(!a){body.appendChild(h('div.ke-ed-empty','Select one actor to edit its Blueprint event graph.'));return;}
    const comp=a.getComponent('Blueprint');
    if(!comp){body.appendChild(h('div.ke-ed-empty',h('div',a.name+' has no Blueprint component.'),h('div',{style:{marginTop:'8px'}},this._btn('plus','Add Blueprint component',()=>{this.addComponent(a,'Blueprint');this._setTab('bp');},{label:'Add Blueprint component',cls:'ke-ed-primary'}))));return;}
    const g=clone(comp.props.graph);g.events=g.events||{};g.variables=g.variables||{};
    const commit=()=>{this._panelEdit=true;try{this.setProperty(a,comp,'graph',g);}finally{this._panelEdit=false;}this._later('bp',()=>this._renderBlueprint());};
    const evs=KE.Blueprint.events,custom=g.events.Custom||{};if(!evs.includes(this._bpEvent)&&!(this._bpEvent.startsWith('Custom:')&&custom[this._bpEvent.slice(7)]))this._bpEvent='BeginPlay';
    const evBtn=(key,label,list,del)=>h('button',{type:'button',className:'ke-ed-ev'+(this._bpEvent===key?' on':''),on:{click:()=>{this._bpEvent=key;this._renderBlueprint();}}},h('i',{style:del?{background:'#8e44ad'}:null}),label,h('em',list&&list.length?String(list.length):''));
    const left=h('div.ke-ed-scroll');
    left.appendChild(h('div.ke-ed-cat','Events'));for(const e of evs)left.appendChild(evBtn(e,e,g.events[e]));
    left.appendChild(h('div.ke-ed-cat','Custom events'));for(const n of Object.keys(custom))left.appendChild(evBtn('Custom:'+n,n,custom[n],true));
    const newEv=h('input',{className:'ke-ed-in',placeholder:'NewEvent','aria-label':'New custom event name',dataset:{k:'bp.newev'}});
    const addEv=()=>{const n=newEv.value.trim();if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(n)){newEv.classList.add('ke-ed-bad');return;}g.events.Custom=custom;if(!custom[n])custom[n]=[];this._bpEvent='Custom:'+n;commit();};
    newEv.addEventListener('keydown',e=>{if(e.key==='Enter')addEv();});left.appendChild(h('div.ke-ed-flex',{style:{margin:'2px 8px 6px'}},newEv,this._btn('plus','Add custom event',addEv)));
    left.appendChild(h('div.ke-ed-cat','Variables'));
    for(const [k,v] of Object.entries(g.variables)){const inp=h('input',{className:'ke-ed-in',value:typeof v==='string'?JSON.stringify(v):JSON.stringify(v),dataset:{k:'bp.var.'+k},'aria-label':'Default value of '+k});
      inp.addEventListener('change',()=>{let nv;try{nv=JSON.parse(inp.value);}catch(e){nv=inp.value;}g.variables[k]=nv;commit();});
      left.appendChild(h('div.ke-ed-flex',{style:{margin:'2px 8px'}},h('span',{style:{minWidth:'64px',color:'#c9b8ff',overflow:'hidden',textOverflow:'ellipsis'}},k),inp,this._btn('trash','Delete variable',()=>{delete g.variables[k];commit();},{cls:'ke-ed-danger'})));}
    const newVar=h('input',{className:'ke-ed-in',placeholder:'name','aria-label':'New variable name',dataset:{k:'bp.newvar'}});
    const addVar=()=>{const n=newVar.value.trim();if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(n)){newVar.classList.add('ke-ed-bad');return;}if(!(n in g.variables))g.variables[n]=0;commit();};
    newVar.addEventListener('keydown',e=>{if(e.key==='Enter')addVar();});left.appendChild(h('div.ke-ed-flex',{style:{margin:'2px 8px 10px'}},newVar,this._btn('plus','Add variable',addVar)));
    const isCustom=this._bpEvent.startsWith('Custom:'),evName=isCustom?this._bpEvent.slice(7):this._bpEvent;
    let list=isCustom?custom[evName]:g.events[evName];if(!list){list=[];if(isCustom)custom[evName]=list;else g.events[evName]=list;}
    const main=h('div.ke-ed-scroll.ke-ed-bpm');
    main.appendChild(h('div.ke-ed-flex',{style:{marginBottom:'8px'}},h('b',{style:{fontSize:'13px'}},(isCustom?'Custom event ':'Event ')+evName),h('span',{style:{color:'var(--dim)',marginLeft:'8px'}},{BeginPlay:'runs once when play starts',Tick:'runs every simulation step (dt available)',Overlap:'a tagged actor entered a trigger volume (other = that actor)',EndOverlap:'the actor left the trigger volume',EndPlay:'runs when play stops or the actor is destroyed'}[evName]||'sent by Emit, SetTimer or world.dispatch'),
      h('div.ke-ed-grow'),isCustom?this._btn('trash','Delete custom event',()=>{delete custom[evName];this._bpEvent='BeginPlay';commit();},{label:'Delete event',cls:'ke-ed-danger'}):null));
    main.appendChild(this._bpList(list,commit,'bp.'+this._bpEvent));
    body.appendChild(h('div.ke-ed-bp',h('div.ke-ed-bpl',left),main));
    main.scrollTop=st;if(fk){const el=body.querySelector('[data-k="'+fk.replace(/"/g,'')+'"]');if(el){el.focus({preventScroll:true});}}},
  _bpList(list,commit,path){const wrap=h('div');const NT=KE.Blueprint.nodeTypes;
    list.forEach((node,i)=>{const t=NT[node.op];if(!t)return;const p=path+'.'+i;
      const move=d=>{const j=i+d;if(j<0||j>=list.length)return;list.splice(j,0,list.splice(i,1)[0]);commit();};
      const head=h('div.ke-ed-nodeh',{style:{'--nc':NODE_COLORS[t.category]||'#7f8896',background:'linear-gradient(90deg,'+(NODE_COLORS[t.category]||'#7f8896')+'66,transparent 70%)'}},h('span',node.op),h('small',t.help),
        this._btn('up','Move up',()=>move(-1)),this._btn('down','Move down',()=>move(1)),this._btn('trash','Delete action',()=>{list.splice(i,1);commit();},{cls:'ke-ed-danger'}));
      const b=h('div.ke-ed-nodeb');
      for(const [k,f] of Object.entries(t.fields)){
        if(f.type==='actions'){if(node[k]===undefined&&f.optional){b.appendChild(h('div',{style:{padding:'0 10px'}},this._btn('plus','Add a '+k+' branch',()=>{node[k]=[];commit();},{label:'Add "'+k+'" actions'})));continue;}
          node[k]=node[k]||[];b.appendChild(h('div.ke-ed-nest',h('div.ke-ed-nestl',k),this._bpList(node[k],commit,p+'.'+k)));continue;}
        b.appendChild(this._prop(niceKey(k)+(f.optional?'':''),this._bpField(node,k,f,commit,p+'.'+k),{title:f.type+(f.optional?' (optional)':'')}));}
      wrap.appendChild(h('div.ke-ed-node',head,b));});
    const cats=[...new Set(Object.values(NT).map(t=>t.category))];
    const add=h('select',{className:'ke-ed-sel',style:{maxWidth:'none'},'aria-label':'Add action',dataset:{k:path+'.add'}},h('option',{value:''},'+ Add action…'),cats.map(c=>h('optgroup',{label:c},Object.values(NT).filter(t=>t.category===c).map(t=>h('option',{value:t.op,title:t.help},t.op)))));
    add.addEventListener('change',()=>{if(!add.value)return;const v=KE.Blueprint.validate({events:{BeginPlay:[{op:add.value}]}}).graph.events.BeginPlay[0];if(v){list.push(v);commit();}});
    wrap.appendChild(h('div',{style:{margin:'2px 0 6px'}},add));return wrap;},
  _bpField(node,k,f,commit,dk){const v=node[k],B=KE.Blueprint;
    const set=nv=>{if(nv===undefined)delete node[k];else node[k]=nv;commit();};
    const exprText=x=>x===undefined?'':typeof x==='string'?JSON.stringify(x):B.formatExpr(x);
    const text=(val,onCommit,ph)=>{const inp=h('input',{className:'ke-ed-in',value:val,placeholder:ph||'',dataset:{k:dk},spellcheck:false,'aria-label':k});
      inp.addEventListener('change',()=>{try{onCommit(inp.value);inp.classList.remove('ke-ed-bad');inp.title='';}catch(e){inp.classList.add('ke-ed-bad');inp.title=e.message;}});inp.addEventListener('keydown',e=>{if(e.key==='Enter')inp.blur();});return inp;};
    const withList=(inp,opts)=>{if(!opts.length)return inp;const id='ke-ed-dl-'+(++dlCount);inp.setAttribute('list',id);return h('div.ke-ed-flex',inp,h('datalist',{id},opts.map(o=>h('option',{value:o}))));};
    switch(f.type){
      case 'number':return text(v===undefined?'':typeof v==='number'?fmt(v,4):exprText(v),s=>{const t=s.trim();if(!t){if(f.optional)return set(undefined);throw new Error('A value is required');}set(/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)?Number(t):B.parseExpr(t));},f.optional?'(optional)':'number or expression');
      case 'bool':if(v===undefined||typeof v==='boolean')return h('input',{type:'checkbox',className:'ke-ed-chk',checked:!!v,dataset:{k:dk},'aria-label':k,on:{change:e=>set(e.target.checked)}});return text(exprText(v),s=>set(B.parseExpr(s)));
      case 'expr':return text(exprText(v),s=>{if(!s.trim()&&f.optional)return set(undefined);set(B.parseExpr(s||'0'));},f.optional?'(optional expression)':'expression, e.g. score + 1');
      case 'exprs':return text((v||[]).map(x=>exprText(x)).join(', '),s=>set(s.trim()?B.parseExpr('['+s+']'):[]),'arg1, arg2');
      case 'vec3':{if(v===undefined&&f.optional){const {el}=this._vec3(null,nv=>set(nv),dk,{placeholder:'–'});return el;}return this._vec3(v||[0,0,0],nv=>set(nv),dk).el;}
      case 'color':return h('input',{type:'color',className:'ke-ed-in',value:v||'#ffffff',dataset:{k:dk},'aria-label':k,on:{change:e=>set(e.target.value)}});
      case 'ease':{const s=h('select',{className:'ke-ed-sel',dataset:{k:dk},'aria-label':k,on:{change:e=>set(e.target.value)}},B.eases.map(e=>h('option',{value:e},e)));s.value=v||'linear';return s;}
      case 'enum':{const s=h('select',{className:'ke-ed-sel',dataset:{k:dk},'aria-label':k,on:{change:e=>set(e.target.value)}},f.options.map(e=>h('option',{value:e},e)));s.value=v;return s;}
      case 'json':return text(v===undefined?'':JSON.stringify(v),s=>set(s.trim()?JSON.parse(s):f.optional?undefined:f.default),f.optional?'(optional JSON)':'JSON');
      case 'prefab':{const s=h('select',{className:'ke-ed-sel',style:{maxWidth:'none'},dataset:{k:dk},'aria-label':k,on:{change:e=>set(e.target.value)}},h('optgroup',{label:'Prefabs'},KE.Prefabs.list().map(p=>h('option',{value:p.name},p.label))),h('optgroup',{label:'Classes'},KE.ActorClasses.list().map(c=>h('option',{value:c.name},c.label))));s.value=v;return s;}
      case 'location':return withList(text(Array.isArray(v)?v.join(', '):(v||''),s=>{const t=s.trim(),m=t.split(/[\s,]+/).map(Number);set(m.length===3&&m.every(Number.isFinite)?m:t||'self');},'self, actor name or x, y, z'),this._targets());
      case 'target':return withList(text(v||'',s=>set(s.trim()||'self'),'self'),this._targets(true));
      case 'synth':return withList(text(v||'',s=>set(s.trim())),KE.Synth&&KE.Synth.names?KE.Synth.names():[]);
      case 'preset':return withList(text(v||'',s=>set(s.trim())),KE.VFX&&KE.VFX.presets?Object.keys(KE.VFX.presets):['fire','smoke','sparks','magic','dust','fireflies','rain','snow','embers','fountain']);
      case 'var':case 'event':return text(v===undefined?'':v,s=>{const t=s.trim();if(!t&&f.optional)return set(undefined);if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(t))throw new Error('Must be an identifier');set(t);},f.optional?'(optional)':'');
      case 'text':return text(v===undefined?'':v,s=>set(s),f.optional?'(optional)':'text, {var} and {global.var} are replaced');
      default:return text(v===undefined?'':String(v),s=>set(s===''&&f.optional?undefined:s),f.optional?'(optional)':'');
    }},
  _targets(all){const out=['self','other'];if(all)out.push('all');for(const t of new Set(this.world.actors.flatMap(a=>[...a.tags])))out.push('tag:'+t);for(const a of this.world.actors.slice(0,200))out.push(a.name);return out;}
});
let dlCount=0;

KE.Editor=Editor;
KE.registerModule('editor',{provides:['Editor','ConsoleUI']});
})();
