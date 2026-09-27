#!/usr/bin/env python3
"""Assemble the distributable runtime files from src/ and vendor/.

Outputs (all in assets/):
  kitsune-engine.js  core.js + embedded surface atlas + src/modules/*.js (sorted)
  three-addons.js    selected Three.js r128 examples/js add-ons (same revision as three.min.js)
  kitsune-libs.js    meshoptimizer simplifier/clusterizer and the Rapier physics engine

Run after editing anything under src/ or vendor/:  python3 scripts/build_engine.py
"""
import argparse
import base64
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
VENDOR = ROOT / 'vendor'
ASSETS = ROOT / 'assets'

# Order matters: later add-ons may reference earlier ones (ConvexObjectBreaker -> ConvexGeometry -> ConvexHull).
THREE_ADDONS = [
    'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js',
    'math/ConvexHull.js', 'math/SimplexNoise.js', 'math/ImprovedNoise.js', 'math/MeshSurfaceSampler.js',
    'math/OBB.js', 'math/Capsule.js', 'math/Octree.js',
    'geometries/ConvexGeometry.js', 'geometries/RoundedBoxGeometry.js', 'geometries/DecalGeometry.js',
    'controls/TransformControls.js', 'controls/OrbitControls.js',
    'loaders/GLTFLoader.js', 'loaders/RGBELoader.js', 'exporters/GLTFExporter.js',
    'misc/GPUComputationRenderer.js', 'misc/ConvexObjectBreaker.js',
    'objects/Lensflare.js', 'modifiers/SimplifyModifier.js',
]


MODULE_FILTER = None


def module_files():
    files = sorted((SRC / 'modules').glob('*.js'))
    if MODULE_FILTER:
        files = [f for f in files if any(f.name.startswith(prefix) for prefix in MODULE_FILTER)]
    return files


def engine_source() -> str:
    atlas = base64.b64encode((ASSETS / 'surface-atlas.png').read_bytes()).decode('ascii')
    parts = [(SRC / 'core.js').read_text(encoding='utf-8'),
             "/* ---------- embedded generated surface atlas (assets/surface-atlas.png) ---------- */\n"
             "(function(){window.KitsuneEngine.visualAtlasURL='data:image/png;base64," + atlas + "';})();\n"]
    for path in module_files():
        parts.append(f'/* ===== module: {path.name} ===== */\n' + path.read_text(encoding='utf-8').rstrip() + '\n')
    return '\n'.join(parts)


def addons_source() -> str:
    head = ('/*! Three.js r128 examples/js add-ons bundled for kitsune engine. MIT License, Copyright 2010-2021 '
            'Three.js Authors. Each file is unmodified from three@0.128.0/examples/js. */\n')
    body = []
    for rel in THREE_ADDONS:
        body.append(f'/* --- three/examples/js/{rel} --- */\n' + (VENDOR / 'three-r128' / rel).read_text(encoding='utf-8'))
    return head + '\n'.join(body)


def libs_source() -> str:
    meshopt = [(VENDOR / 'meshoptimizer' / name).read_text(encoding='utf-8')
               for name in ('meshopt_simplifier.js', 'meshopt_clusterizer.js')]
    rapier = (VENDOR / 'rapier' / 'rapier.cjs').read_text(encoding='utf-8')
    rapier = rapier.replace('//# sourceMappingURL=rapier.cjs.map', '')
    # Built games inline this file, so carry the full license texts with it (Apache-2.0 asks for a copy of the license).
    notices = '\n\n'.join((VENDOR / d / f).read_text(encoding='utf-8').strip().replace('*/', '* /')
                           for d, f in (('meshoptimizer', 'LICENSE.md'), ('rapier', 'LICENSE')))
    return ('/*! Third-party runtime libraries for kitsune engine: meshoptimizer 0.22 (MIT, Arseny Kapoulkine) and '
            'Rapier 3D 0.19.3 compat build (Apache-2.0, Dimforge). License texts follow.\n\n' + notices + '\n*/\n'
            + '\n'.join(meshopt)
            + '\n/* --- @dimforge/rapier3d-compat 0.19.3 (CommonJS build wrapped as window.RAPIER) --- */\n'
            + '(function(){var module={exports:{}},exports=module.exports;\n' + rapier
            + '\n;window.RAPIER=module.exports;})();\n')


def write(path: Path, text: str):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.kitsune-', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return path.stat().st_size


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--engine-only', action='store_true', help='rebuild kitsune-engine.js only')
    parser.add_argument('--modules', help='comma-separated module filename prefixes to include (development builds)')
    args = parser.parse_args()
    global MODULE_FILTER
    if args.modules:
        MODULE_FILTER = [m.strip() for m in args.modules.split(',') if m.strip()]
    outputs = [('kitsune-engine.js', engine_source)]
    if not args.engine_only:
        outputs += [('three-addons.js', addons_source), ('kitsune-libs.js', libs_source)]
    for name, make in outputs:
        size = write(ASSETS / name, make())
        print(f'Built assets/{name} ({size:,} bytes)')
    print('Modules: ' + ', '.join(p.name for p in module_files()))


if __name__ == '__main__':
    main()
