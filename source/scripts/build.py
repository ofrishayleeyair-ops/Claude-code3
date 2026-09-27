#!/usr/bin/env python3
"""Bundle the supplied engine and Three.js into a standalone offline HTML game."""
import argparse
import os
from pathlib import Path
import re
import tempfile

ASSETS = Path(__file__).resolve().parent.parent / 'assets'


# Each placeholder expands to these assets, in order. Libraries precede the engine that wraps them.
BUNDLES = {'<!--THREE-->': ('three.min.js', 'three-addons.js'),
           '<!--KITSUNE-->': ('kitsune-libs.js', 'kitsune-engine.js')}
LITE_SKIP = {'kitsune-libs.js'}


def build(source: Path, destination: Path, lite: bool = False) -> int:
    html = source.read_text(encoding='utf-8')
    tags = ('<!--THREE-->', '<!--KITSUNE-->')
    for tag in tags:
        if html.count(tag) != 1:
            raise ValueError(f'Require exactly one {tag} placeholder')
    if html.index(tags[0]) > html.index(tags[1]):
        raise ValueError('THREE must precede KITSUNE')
    if re.search(r'<(?:script|link|img|audio|video|source)\b[^>]*(?:src|href)\s*=\s*[\"\']?\s*(?:https?:)?//', html, re.I):
        raise ValueError('External runtime resource detected: bundle it locally first')
    for tag in tags:
        blocks = []
        for filename in BUNDLES[tag]:
            if lite and filename in LITE_SKIP:
                continue
            code = (ASSETS / filename).read_text(encoding='utf-8')
            # Prevent a JS string or comment from terminating an HTML script element.
            code = re.sub(r'</script', lambda match: '<\\/' + match.group()[2:], code, flags=re.I)
            blocks.append('<script>\n' + code + '\n</script>')
        html = html.replace(tag, '\n'.join(blocks), 1)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=destination.parent,
                                         prefix='.kitsune-', suffix='.tmp', delete=False) as out:
            temporary = Path(out.name)
            out.write(html)
        os.replace(temporary, destination)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return destination.stat().st_size


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--lite', action='store_true',
                        help='omit kitsune-libs.js (Rapier physics, meshoptimizer); KE.Physics3D and KE.VirtualGeometry fall back or report unavailable')
    args = parser.parse_args()
    if args.source.resolve() == args.destination.resolve():
        parser.error('Use a different output path to preserve the source template')
    try:
        size = build(args.source, args.destination, args.lite)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Build failed: {error}\n')
    print(f'Built {args.destination} ({size:,} bytes); no engine network dependencies')


if __name__ == '__main__':
    main()
