# Cloth · 3.0.0 (`42-cloth.js`)

`KE.Cloth` simulates a rectangular sheet — a flag, banner, curtain, cape or tablecloth — on the CPU with position-based dynamics. Registers module `cloth`. Test: `node scripts/test_cloth.cjs [--shots]`.

```js
const pole = new THREE.Object3D(); pole.position.set(x, y + 3.7, z); scene.add(pole);
const flag = new KE.Cloth(THREE, {
  anchor: pole, width: .72, height: 2.3, segmentsX: 10, segmentsY: 26,
  pins: (i, j) => i === 0 || j === 0,          // side and crossbar
  position: [.41, 0, 0],                        // rest grid offset in the anchor's frame
  material: new THREE.MeshStandardMaterial({ map: bannerTexture, side: THREE.DoubleSide })
});
scene.add(flag.mesh);
// every frame:
flag.update(dt);
```

## Model

- **Particles** on a `(segmentsX+1) × (segmentsY+1)` grid. The rest layout lies in the local XY plane: x across (−width/2 … width/2), y down from the top edge (0 … −height), with a seeded ripple of 0.1 % of the size so a flat sheet can buckle and fold. `mass` (default .3 kg) is shared equally.
- **Integration**: damped Verlet (`damping` .012 per substep) with gravity and wind forces, `substeps` (2) per `update`, `dt` clamped to `maxDt` (1/30 s).
- **Constraints**: structural (neighbours, `stiffness` 1), shear (diagonals, `shearStiffness` .8) and bend (two apart, `bendStiffness` .25) distance constraints, projected Gauss–Seidel for `iterations` (6) per substep. Stretch at rest stays within about 0.3 % on average in the tests.
- **Wind**: per triangle, pressure drag on the normal component of the relative air velocity (½·ρ·`drag`·A·vₙ|vₙ|, `drag` 1.2) plus skin friction along the fabric (½·ρ·`skin`·A·|vₜ|·vₜ, `skin` .2), shared by the triangle's three vertices. The air velocity is `wind` (a vector, `[x,y,z]` or `fn(time, position, out)`); when omitted it follows the shared foliage wind (`KE.foliageUniforms` direction and strength, 3.5 m/s at strength 1) so banners move with the grass and trees. Travelling value noise adds gusts (`gustStrength` .6, `gustScale` .35) and a small vertical flutter; `windStrength` scales everything.
- **Pins**: `pins` is `'top'` (default), `'left'`, `'right'`, `'corners'`, `'topCorners'`, a list of `[i, j]` grid indices, or `fn(i, j) → bool`. Pinned particles are placed every substep at their rest position transformed by `position`/`quaternion` and then by `anchor.matrixWorld` (the anchor may move and rotate; the rest of the sheet follows physically).
- **Collisions** after each substep: `colliders` entries `{center, radius}` (sphere), `{a, b, radius}` (capsule between two points), or `{object, offset, radius}` (sphere following an object); `ground` is a height or `fn(x, z)`. Particles are pushed out to `radius + thickness` (.02) and `friction` (.35) pulls their previous position toward the contact, slowing sliding. There is no self-collision and no collision with arbitrary meshes.

The mesh (`cloth.mesh`, a `THREE.Mesh` with a dynamic `PlaneGeometry`, `castShadow`/`receiveShadow` true, `frustumCulled` false) is simulated in world space and must stay at the identity transform; normals and the bounding sphere are recomputed every update. The default material is a double-sided `MeshStandardMaterial`; pass `material` to use your own (it is not disposed by `dispose()`).

## API

| Member | Meaning |
|---|---|
| `new KE.Cloth(THREE, options)` | options above, plus `castShadow`, `receiveShadow` |
| `update(dt)` | advance; returns the cloth. Non-finite or zero `dt` does nothing |
| `reset()` | put every particle at its rest pose under the current anchor transform (after teleporting the anchor) |
| `windAt(position, out)` | the air velocity used at a point |
| `energy` | largest particle displacement of the last substep (settling check) |
| `mesh`, `geometry`, `material` | render objects |
| `pos`, `prev`, `rest`, `constraints`, `pins`, `count`, `nx`, `ny` | simulation state (read-only use) |
| `enabled` | false skips updates |
| `dispose()` | removes the mesh from its parent and frees the geometry (and the default material) |

## Cost and limits

Per substep the cost is linear in particles, triangles (wind) and constraints × iterations; a 10 × 26 banner (297 particles, about 1,700 constraints) at 6 iterations and 2 substeps runs a few thousand constraint projections per frame in JavaScript plus a normal recomputation and a vertex upload. Use fewer segments and iterations on low-end devices (Spirit Isle uses 6 × 14 and 4 iterations at Low). Limits: CPU only; no self-collision, tearing or mesh collision; stiffness depends on iteration count and time step (PBD, not XPBD compliance), so very stiff fabric needs more iterations; no frame-time figures are claimed.
