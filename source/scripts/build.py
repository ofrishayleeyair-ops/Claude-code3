#!/usr/bin/env python3
"""Bundle the supplied engine and Three.js into a standalone offline HTML game."""
import argparse
import os
from pathlib import Path
import re
import tempfile

ASSETS = Path(__file__).resolve().parent.parent / 'assets'


def build(source: Path, destination: Path) -> int:
    html = source.read_text(encoding='utf-8')
    tags = ('<!--THREE-->', '<!--KITSUNE-->')
    for tag in tags:
        if html.count(tag) != 1:
            raise ValueError(f'Require exactly one {tag} placeholder')
    if html.index(tags[0]) > html.index(tags[1]):
        raise ValueError('THREE must precede KITSUNE')
    if re.search(r'<(?:script|link|img|audio|video|source)\b[^>]*(?:src|href)\s*=\s*[\"\']?\s*(?:https?:)?//', html, re.I):
        raise ValueError('External runtime resource detected: bundle it locally first')
    for tag, filename in zip(tags, ('three.min.js', 'kitsune-engine.js')):
        code = (ASSETS / filename).read_text(encoding='utf-8')
        # Prevent a JS string or comment from terminating an HTML script element.
        code = re.sub(r'</script', lambda match: '<\\/' + match.group()[2:], code, flags=re.I)
        html = html.replace(tag, '<script>\n' + code + '\n</script>')
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
    args = parser.parse_args()
    if args.source.resolve() == args.destination.resolve():
        parser.error('Use a different output path to preserve the source template')
    try:
        size = build(args.source, args.destination)
    except (OSError, ValueError) as error:
        parser.exit(1, f'Build failed: {error}\n')
    print(f'Built {args.destination} ({size:,} bytes); no engine network dependencies')


if __name__ == '__main__':
    main()
