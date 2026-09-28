#!/usr/bin/env python3
"""Build the kitsune HD asset pack: photoscanned CC0 textures and models from Poly Haven.

    python3 scripts/hd_pack.py [--out ../hd] [--cache ../.hd-cache] [--only id,id] [--list]

Downloads the assets listed below (Poly Haven's public API and CDN, CC0 licence), then writes them as
script files the engine can load from a page opened straight from disk (file://): browsers refuse to
hand local image files to WebGL, but a <script> in the same folder may carry the bytes. Layout:

    hd/manifest.js            KitsuneHD.manifest({...})  ids, kinds, real-world sizes, files, credits
    hd/<id>/<file>.js         KitsuneHD.put('<id>/<file>', part, parts, 'mime', 'base64...')
    hd/CREDITS.md             authors and source pages; hd/LICENSE.txt (CC0 1.0)

Downloads are cached (--cache) so re-running only packs. The pack is optional: without it the engine
paints its own textures. See references/hd-assets.md.
"""
import argparse, base64, json, os, pathlib, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = 'https://api.polyhaven.com'
PART = 30 * 1024 * 1024  # raw bytes per script part (about 40 MB of base64)

# terrain layers (texture arrays in KE.GPUTerrain): albedo, normal and ARM at 4K, height at 2K
TERRAIN = [
    ('forrest_ground_01', 'grass'), ('brown_mud_leaves_01', 'grass-leaves'), ('coast_sand_01', 'sand'),
    ('forest_ground_04', 'dirt'), ('river_small_rocks', 'gravel'), ('mossy_rock', 'rock'),
    ('rock_face_03', 'rock-high'), ('snow_02', 'snow'),
]
# surfaces for meshes (MeshStandardMaterial map / normalMap / ARM)
SURFACES = [
    ('japanese_cedar_bark', '4k', 'bark cedar'), ('sakura_bark', '2k', 'bark sakura'), ('trident_maple_bark', '2k', 'bark maple'),
    ('japanese_zelkova_bark', '2k', 'bark broadleaf'), ('metasequoia_bark', '2k', 'bark daisugi'), ('pine_bark', '2k', 'bark pine'),
    ('hinoki_planks', '4k', 'wood planks'), ('dark_wooden_planks', '2k', 'wood dark'), ('raw_plank_wall', '2k', 'wood weathered'),
    ('grey_roof_tiles_02', '2k', 'roof tiles'), ('rock_wall_02', '2k', 'stone wall'), ('grassy_cobblestone', '2k', 'stone path'),
]
# scanned models (glTF with 2K textures)
MODELS = [
    ('rock_moss_set_01', 'rock'), ('rock_moss_set_02', 'rock'), ('boulder_01', 'rock'), ('rock_07', 'rock'), ('rock_09', 'rock'),
    ('stone_01', 'rock'), ('coast_rocks_05', 'rock coast'), ('rock_face_01', 'rock cliff'), ('namaqualand_boulder_02', 'rock'),
    ('fern_02', 'plant'), ('shrub_01', 'plant'), ('shrub_04', 'plant'), ('grass_medium_01', 'plant'), ('moss_01', 'plant'),
    ('celandine_01', 'plant flower'), ('nettle_plant', 'plant'), ('weed_plant_02', 'plant'),
    ('tree_stump_01', 'debris'), ('tree_stump_02', 'debris'), ('dead_tree_trunk', 'debris'), ('dead_tree_trunk_02', 'debris'),
    ('pine_roots', 'debris'), ('root_cluster_01', 'debris'), ('bark_debris_01', 'debris'), ('dry_branches_medium_01', 'debris'),
    ('wooden_lantern_01', 'prop'), ('stone_fire_pit', 'prop'), ('modular_wooden_pier', 'prop'),
]
# the wider library (--library, on by default): sky HDRIs, general 4K material sets and more scanned models, for any game
LIB_HDRI = ['kloofendal_48d_partly_cloudy_puresky', 'lilienstein', 'the_sky_is_on_fire', 'kloppenheim_06_puresky', 'spruit_sunrise', 'belfast_sunset_puresky',
            'venice_sunset', 'autumn_field_puresky', 'noon_grass', 'meadow_2', 'rogland_clear_night', 'dikhololo_night', 'overcast_soil_puresky',
            'citrus_orchard_road_puresky', 'kiara_1_dawn', 'golden_gate_hills']
LIB_TEXTURES = [
    ('red_brick_03', 'brick'), ('medieval_blocks_03', 'brick stone'), ('castle_brick_02_red', 'brick'), ('stone_brick_wall_001', 'brick stone'),
    ('concrete_floor_worn_001', 'concrete'), ('painted_plaster_wall', 'plaster'), ('white_plaster_02', 'plaster'), ('gravel_embedded_concrete', 'concrete'),
    ('weathered_brown_planks', 'wood planks'), ('wood_floor', 'wood floor'), ('rough_wood', 'wood'), ('wood_table_001', 'wood'),
    ('metal_plate', 'metal'), ('green_metal_rust', 'metal rust'), ('rust_coarse_01', 'metal rust'), ('corrugated_iron', 'metal roof'),
    ('fabric_pattern_07', 'fabric'), ('brown_leather', 'leather'), ('denim_fabric', 'fabric'),
    ('clay_roof_tiles_02', 'roof tiles'), ('roof_slates_03', 'roof slate'), ('thatch_roof_angled', 'roof thatch'),
    ('stone_embedded_tiles', 'tiles'), ('terrazzo_tiles', 'tiles'), ('checkered_pavement_tiles', 'tiles'),
    ('cobblestone_floor_04', 'cobblestone'), ('mossy_cobblestone', 'cobblestone'), ('cobblestone_large_01', 'cobblestone'), ('asphalt_02', 'road'),
    ('aerial_rocks_02', 'ground rock'), ('aerial_grass_rock', 'ground grass'), ('rocks_ground_02', 'ground rock'), ('lichen_rock', 'rock'), ('cliff_side', 'rock cliff'),
    ('dry_riverbed_rock', 'ground rock'), ('snow_field_aerial', 'ground snow'), ('forest_leaves_02', 'ground leaves'), ('coast_sand_rocks_02', 'ground sand'),
    ('sparse_grass', 'ground grass'), ('grass_path_2', 'ground path'),
]
LIB_MODELS = [
    ('Lantern_01', 'prop light'), ('brass_diya_lantern', 'prop light'), ('chinese_chandelier', 'prop light'), ('street_lamp_01', 'prop light'),
    ('Barrel_01', 'prop container'), ('wooden_crate_01', 'prop container'), ('wine_barrel_01', 'prop container'), ('treasure_chest', 'prop container'),
    ('antique_ceramic_vase_01', 'prop decor'), ('ceramic_vase_01', 'prop decor'), ('cardboard_box_01', 'prop container'), ('tea_set_01', 'prop decor'),
    ('chess_set', 'prop decor'), ('horse_statue_01', 'prop decor'), ('marble_bust_01', 'prop decor'), ('alarm_clock_01', 'prop decor'),
    ('decorative_book_set_01', 'prop decor'), ('Camera_01', 'prop decor'),
    ('wooden_table_02', 'furniture'), ('round_wooden_table_01', 'furniture'), ('outdoor_table_chair_set_01', 'furniture'), ('wooden_picnic_table', 'furniture'),
    ('Rockingchair_01', 'furniture'), ('GothicCabinet_01', 'furniture'), ('sofa_02', 'furniture'), ('ArmChair_01', 'furniture'),
    ('wooden_hammer_01', 'prop tool'), ('rusted_spade_01', 'prop tool'), ('watering_can_metal_01', 'prop tool'), ('metal_tool_chest', 'prop tool'), ('crowbar_01', 'prop tool'),
    ('large_castle_door', 'structure'), ('concrete_road_barrier', 'structure'), ('fire_hydrant', 'structure'), ('utility_box_01', 'structure'),
    ('tree_small_02', 'plant tree'), ('jacaranda_tree', 'plant tree'), ('island_tree_02', 'plant tree'), ('fir_tree_01', 'plant tree'), ('pine_tree_01', 'plant tree'),
    ('fir_sapling_medium', 'plant tree'), ('pine_sapling_medium', 'plant tree'), ('dandelion_01', 'plant flower'), ('grass_medium_02', 'plant'),
    ('potted_plant_02', 'plant potted'), ('potted_plant_04', 'plant potted'), ('shrub_02', 'plant'), ('shrub_03', 'plant'),
    ('namaqualand_boulder_03', 'rock'), ('coast_land_rocks_04', 'rock coast'), ('rock_face_02', 'rock cliff'), ('mountainside', 'rock cliff'),
    ('food_apple_01', 'prop food'), ('stone_01', 'rock'),
]
LIB_HDRI += ['moonless_golf', 'satara_night', 'kloppenheim_02', 'spiaggia_di_mondello', 'sunflowers_puresky', 'rural_asphalt_road', 'shanghai_bund']
LIB_TEXTURES += [
    ('red_brick', 'brick'), ('brick_wall_001', 'brick'), ('sandstone_blocks_05', 'brick stone'), ('beige_wall_001', 'plaster'), ('concrete_floor_02', 'concrete'),
    ('grey_plaster', 'plaster'), ('laminate_floor_02', 'wood floor'), ('wood_cabinet_worn_long', 'wood'), ('oak_veneer_01', 'wood'), ('rusty_metal_02', 'metal rust'),
    ('blue_metal_plate', 'metal'), ('leather_red_02', 'leather'), ('fabric_pattern_05', 'fabric'), ('roof_09', 'roof tiles'), ('ceramic_roof_01', 'roof tiles'),
    ('roof_tiles_14', 'roof tiles'), ('grey_cartago_01', 'tiles'), ('granite_tile_03', 'tiles'), ('worn_tile_floor', 'tiles'), ('cobblestone_floor_08', 'cobblestone'),
    ('patterned_cobblestone', 'cobblestone'), ('asphalt_01', 'road'), ('aerial_rocks_04', 'ground rock'), ('rock_boulder_dry', 'rock'), ('rocks_ground_05', 'ground rock'),
    ('gray_rocks', 'rock'), ('snow_03', 'ground snow'), ('sand_01', 'ground sand'), ('leaves_forest_ground', 'ground leaves'), ('mud_forest', 'ground mud'),
    ('brown_mud_dry', 'ground mud'), ('forest_floor', 'ground leaves'),
]
LIB_MODELS += [
    ('Barrel_02', 'prop container'), ('barrel_03', 'prop container'), ('brass_vase_03', 'prop decor'), ('metal_trash_can', 'prop container'), ('ceramic_vase_02', 'prop decor'),
    ('sofa_03', 'furniture'), ('GreenChair_01', 'furniture'), ('Ottoman_01', 'furniture'), ('plastic_monobloc_chair_01', 'furniture'), ('SchoolChair_01', 'furniture'),
    ('mid_century_lounge_chair', 'furniture'), ('street_lamp_02', 'prop light'), ('brass_candleholders', 'prop light'), ('wooden_candlestick', 'prop light'),
    ('vintage_oil_lamp', 'prop light'), ('concrete_road_barrier_02', 'structure'), ('utility_box_02', 'structure'), ('island_tree_01', 'plant tree'),
    ('island_tree_03', 'plant tree'), ('quiver_tree_01', 'plant tree'), ('dead_quiver_trunk', 'debris'), ('namaqualand_boulder_05', 'rock'), ('coast_rocks_01', 'rock coast'),
]
MODEL_MAX = 80 * 1024 * 1024  # skip library models whose 2K glTF (with textures) is larger than this
MIME = {'.jpg': 'image/jpeg', '.png': 'image/png', '.hdr': 'image/vnd.radiance', '.bin': 'application/octet-stream', '.gltf': 'model/gltf+json'}


def get(url, dest=None, tries=5):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'kitsune-engine-hd-pack/1.0'})
            with urllib.request.urlopen(req, timeout=180) as r:
                data = r.read()
            if dest:
                dest.parent.mkdir(parents=True, exist_ok=True)
                tmp = dest.with_suffix(dest.suffix + '.part'); tmp.write_bytes(data); tmp.replace(dest)
            return data
        except Exception as e:  # network hiccup: back off and retry
            if k == tries - 1:
                raise
            time.sleep(2 ** (k + 1))


def api(path, cache):
    f = cache / 'api' / (path.strip('/').replace('/', '_') + '.json')
    if not f.exists():
        get(API + path, f)
    return json.loads(f.read_text())


def cached(url, cache):
    f = cache / 'files' / url.split('/ph-assets/', 1)[-1]
    if not f.exists():
        get(url, f)
    return f


def texture_files(aid, res, maps, cache):
    files = api('/files/' + aid, cache)
    out = {}
    alt = {'Diffuse': ['Diffuse', 'col_1', 'col_01', 'col_2'], 'Displacement': ['Displacement', 'disp']}
    for key, name, r in maps:
        entry = next((files[k][r or res]['jpg'] for k in alt.get(key, [key]) if k in files and (r or res) in files[k] and 'jpg' in files[k][r or res]), None)
        if not entry:
            raise RuntimeError(f'{aid}: no {key} {r or res} jpg')
        out[f'{name}_{r or res}.jpg'] = cached(entry['url'], cache)
    return out


def model_files(aid, res, cache):
    g = api('/files/' + aid, cache)['gltf'][res]['gltf']
    out = {pathlib.Path(g['url']).name: cached(g['url'], cache)}
    base = g['url'].rsplit('/', 1)[0]
    for rel, info in g['include'].items():
        out[rel] = cached(info['url'], cache)
    return out


def hdri_files(aid, res, cache):
    e = api('/files/' + aid, cache)['hdri'][res]['hdr']
    return {f'sky_{res}.hdr': cached(e['url'], cache)}


def model_size(aid, res, cache):
    g = api('/files/' + aid, cache)['gltf'][res]['gltf']
    return g.get('size', 0) + sum(i.get('size', 0) for i in g['include'].values())


def fetch_files(kind, aid, res, cache):
    if kind == 'hdri':
        return hdri_files(aid, res, cache)
    if kind in ('terrain', 'library'):
        return texture_files(aid, res, [('Diffuse', 'diff', None), ('nor_gl', 'nor', None), ('arm', 'arm', None), ('Displacement', 'disp', '2k')], cache)
    if kind == 'surface':
        return texture_files(aid, res, [('Diffuse', 'diff', None), ('nor_gl', 'nor', None), ('arm', 'arm', None)], cache)
    return model_files(aid, res, cache)


def write_js(out, aid, rel, src):
    data = src.read_bytes(); mime = MIME.get(src.suffix.lower(), 'application/octet-stream')
    parts = max(1, -(-len(data) // PART)); key = f'{aid}/{rel}'
    for p in range(parts):
        chunk = base64.b64encode(data[p * PART:(p + 1) * PART]).decode('ascii')
        name = rel.replace('/', '__') + (f'.{p}' if parts > 1 else '') + '.js'
        dest = out / aid / name; dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix('.tmp'); tmp.write_text(f"KitsuneHD.put({json.dumps(key)},{p},{parts},{json.dumps(mime)},'{chunk}');\n", encoding='ascii'); tmp.replace(dest)
    return {'mime': mime, 'bytes': len(data), 'parts': parts, 'script': rel.replace('/', '__')}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(ROOT.parent / 'hd'))
    ap.add_argument('--cache', default=str(ROOT.parent / '.hd-cache'))
    ap.add_argument('--only', default='')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--no-library', action='store_true', help='only the assets the Open World uses (about 1.1 GB)')
    a = ap.parse_args()
    out, cache = pathlib.Path(a.out), pathlib.Path(a.cache)
    only = set(filter(None, a.only.split(',')))
    jobs = [('terrain', aid, '4k', role) for aid, role in TERRAIN] + [('surface', aid, res, role) for aid, res, role in SURFACES] + [('model', aid, '2k', role) for aid, role in MODELS]
    if not a.no_library:
        jobs += [('hdri', aid, '4k', 'sky') for aid in LIB_HDRI] + [('library', aid, '4k', role) for aid, role in LIB_TEXTURES] + [('model', aid, '2k', role + ' library') for aid, role in LIB_MODELS]
    if only:
        jobs = [j for j in jobs if j[1] in only]
    if a.list:
        for j in jobs:
            print(*j)
        return
    manifest = {'version': 1, 'name': 'kitsune HD pack', 'license': 'CC0 1.0 (public domain)', 'source': 'https://polyhaven.com', 'assets': {}}
    total = 0
    for kind, aid, res, role in jobs:
        info = api('/info/' + aid, cache)
        try:
            if kind == 'model' and 'library' in role and model_size(aid, res, cache) > MODEL_MAX:
                print(f'skip     {aid:26} (over {MODEL_MAX >> 20} MB)', flush=True); continue
            files = fetch_files(kind, aid, res, cache)
        except Exception as e:
            if kind in ('hdri', 'library') or 'library' in role:
                print(f'skip     {aid:26} ({e})', flush=True); continue
            raise
        entry = {'kind': {'model': 'model', 'hdri': 'hdri'}.get(kind, 'texture'), 'role': role, 'res': res, 'name': info.get('name', aid),
                 'authors': list((info.get('authors') or {}).keys()), 'page': f'https://polyhaven.com/a/{aid}', 'files': {}}
        if info.get('dimensions'):
            entry['size_m'] = [round(v / 1000, 3) for v in info['dimensions'][:2]]
        for rel, src in files.items():
            entry['files'][rel] = write_js(out, aid, rel, src)
            total += entry['files'][rel]['bytes']
        manifest['assets'][aid] = entry
        print(f'{kind:8} {aid:26} {res} {sum(f["bytes"] for f in entry["files"].values())/1e6:7.1f} MB', flush=True)
    if not only:
        manifest['bytes'] = total
        tmp = out / 'manifest.tmp'; tmp.write_text('KitsuneHD.manifest(' + json.dumps(manifest, indent=1) + ');\n', encoding='utf-8'); tmp.replace(out / 'manifest.js')
        credits = ['# kitsune HD pack: credits', '', 'Every asset here comes from [Poly Haven](https://polyhaven.com) and is licensed CC0 1.0 (public domain).', 'Thanks to the artists who scanned and published them:', '']
        for aid, e in manifest['assets'].items():
            credits.append(f"- [{e['name']}]({e['page']}) ({e['kind']}, {e['res']}): {', '.join(e['authors']) or 'Poly Haven'}")
        (out / 'CREDITS.md').write_text('\n'.join(credits) + '\n', encoding='utf-8')
        (out / 'LICENSE.txt').write_text('The assets in this folder are from Poly Haven (https://polyhaven.com) and are dedicated to the public domain\nunder CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/\n', encoding='utf-8')
        print(f'wrote {out} ({len(manifest["assets"])} assets, {total/1e6:.0f} MB of source files)')


if __name__ == '__main__':
    main()
