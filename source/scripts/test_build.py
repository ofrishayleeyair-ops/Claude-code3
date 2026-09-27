#!/usr/bin/env python3
"""Builder regression checks; Python standard library only."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('kitsune_build', Path(__file__).with_name('build.py'))
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)

class BuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'game.html'
        self.output = self.root / 'nested' / 'game-offline.html'

    def tearDown(self):
        self.temp.cleanup()

    def test_real_bundle(self):
        self.source.write_text('<html><!--THREE--><!--KITSUNE--></html>')
        size = BUILD.build(self.source, self.output)
        self.assertGreater(size, 600000)
        text = self.output.read_text()
        self.assertNotIn('<!--THREE-->', text)
        self.assertIn('window.KitsuneEngine=KE', text)
        self.assertIn('THREE.TransformControls', text)
        self.assertIn('window.RAPIER=module.exports', text)
        self.assertLess(text.index('examples/js add-ons bundled for kitsune engine'), text.index('window.KitsuneEngine=KE'))
        self.assertEqual(self.source.read_text(), '<html><!--THREE--><!--KITSUNE--></html>')

    def test_missing_or_duplicate_markers(self):
        for text in ['<!--THREE-->', '<!--THREE--><!--THREE--><!--KITSUNE-->']:
            self.source.write_text(text)
            with self.assertRaises(ValueError): BUILD.build(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_wrong_order(self):
        self.source.write_text('<!--KITSUNE--><!--THREE-->')
        with self.assertRaises(ValueError): BUILD.build(self.source, self.output)

    def test_remote_resource(self):
        self.source.write_text('<script src="https://example.invalid/a.js"></script><!--THREE--><!--KITSUNE-->')
        with self.assertRaises(ValueError): BUILD.build(self.source, self.output)

    def test_script_end_escape(self):
        old = BUILD.ASSETS
        assets = self.root / 'assets'
        assets.mkdir()
        (assets / 'three.min.js').write_text("const x='</ScRiPt>';")
        (assets / 'three-addons.js').write_text("const a=1;")
        (assets / 'kitsune-libs.js').write_text("const l='</script >';")
        (assets / 'kitsune-engine.js').write_text("const y='</script>';")
        BUILD.ASSETS = assets
        try:
            self.source.write_text('<!--THREE--><!--KITSUNE-->')
            BUILD.build(self.source, self.output)
            text = self.output.read_text()
            self.assertEqual(text.lower().count('</script>'), 4)
            self.assertIn('<\\/ScRiPt>', text)
            BUILD.build(self.source, self.output, lite=True)
            lite = self.output.read_text()
            self.assertEqual(lite.lower().count('</script>'), 3)
            self.assertNotIn("const l=", lite)
        finally:
            BUILD.ASSETS = old

if __name__ == '__main__':
    unittest.main(verbosity=2)
