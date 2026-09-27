#!/usr/bin/env python3
"""Package the engine as an installable skill archive.

    python3 scripts/package_skill.py [output.skill]

Writes a zip whose single top-level folder is the skill name from SKILL.md
(default output: ../<name>.skill next to the source folder). Includes the
skill instructions, agents, assets, references, scripts, engine sources,
vendored library sources and example sources; leaves out test output and
caches. Refuses to package when SKILL.md has no name.
"""
import pathlib, re, sys, zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
INCLUDE = ['SKILL.md', 'agents', 'assets', 'references', 'scripts', 'src', 'vendor', 'examples/src']
SKIP_PARTS = {'.test-output', '__pycache__', 'node_modules'}


def skill_name():
    text = (ROOT / 'SKILL.md').read_text(encoding='utf-8')
    m = re.search(r'^name:\s*([a-z0-9-]+)\s*$', text, re.M)
    if not m:
        sys.exit('SKILL.md front matter has no name: line')
    return m.group(1)


def main():
    name = skill_name()
    out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / f'{name}.skill'
    files = []
    for entry in INCLUDE:
        p = ROOT / entry
        if p.is_file():
            files.append(p)
        elif p.is_dir():
            files += [f for f in sorted(p.rglob('*')) if f.is_file() and not SKIP_PARTS.intersection(f.relative_to(ROOT).parts) and f.suffix != '.pyc']
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in files:
            z.write(f, f'{name}/{f.relative_to(ROOT).as_posix()}')
    print(f'Wrote {out} ({out.stat().st_size:,} bytes, {len(files)} files)')


if __name__ == '__main__':
    main()
