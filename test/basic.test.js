import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePNG, decodePNG } from '../src/texture/png.js';
import { Raster } from '../src/texture/raster.js';
import { loadFont, layoutText, inkBounds } from '../src/texture/font.js';
import { SurfaceMesh, MeshTopology } from '../src/mesh.js';
import { PDBData } from '../src/pdb.js';
import { generateSurface } from '../src/surface.js';
import { packBoxes } from '../src/unwrap/pack.js';
import { thirdPoint } from '../src/unwrap/core.js';
import { WorkMesh } from '../src/unwrap/workmesh.js';
import { unwrapDecoration } from '../src/unwrap/group.js';
import { ColorScheme } from '../src/colors.js';
import { createTexturedObject } from '../src/index.js';
import { buildResidueDecorations } from '../src/decorate.js';

test('png round trip', () => {
  const r = new Raster(8, 5);
  r.clear(10, 20, 30);
  r.setPixel(3, 2, 200, 100, 50);
  const png = encodePNG(r.data, 8, 5);
  const dec = decodePNG(png);
  assert.equal(dec.width, 8);
  assert.equal(dec.height, 5);
  assert.deepEqual(Array.from(dec.data), Array.from(r.data));
});

test('raster fill with even-odd hole', () => {
  const r = new Raster(20, 20);
  r.clear(0, 0, 0);
  r.fillPath([[2, 2, 18, 2, 18, 18, 2, 18], [6, 6, 6, 14, 14, 14, 14, 6]], [255, 255, 255], { rule: 'evenodd' });
  assert.equal(r.getPixel(4, 4)[0], 255);
  assert.equal(r.getPixel(10, 10)[0], 0);
  // same orientation for both loops -> nonzero fills the hole
  r.fillPath([[2, 2, 18, 2, 18, 18, 2, 18], [6, 6, 14, 6, 14, 14, 6, 14]], [255, 0, 0], { rule: 'nonzero' });
  assert.equal(r.getPixel(10, 10)[0], 255);
});

test('font layout produces ink', () => {
  const font = loadFont(undefined, true, { quiet: true });
  const lay = layoutText(font, 'TRP181', 20);
  const ink = inkBounds(lay);
  assert.ok(lay.width > 0);
  assert.ok(ink.maxX - ink.minX > 0 && ink.maxY - ink.minY > 0);
});

test('mesh topology: boundary loop and components', () => {
  const m = new SurfaceMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]], [[0, 1, 2], [1, 3, 2]]);
  const t = new MeshTopology(m);
  assert.equal(t.boundaryLoops().length, 1);
  assert.equal(t.boundaryLoops()[0].length, 4);
  assert.equal(t.connectedComponents().length, 1);
  assert.deepEqual(m.faceNormal(0), [0, 0, 1]);
});

test('pdb parsing', () => {
  const text = [
    'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00 10.00           N',
    'ATOM      2  CA  ALA A   1       1.500   0.000   0.000  1.00 10.00           C',
    'ATOM      3  C   ALA A   1       2.000   1.400   0.000  1.00 10.00           C',
    'ATOM      4  O   ALA A   1       3.000   1.800   0.000  1.00 10.00           O',
    'ATOM      5  N   GLY A   2       1.400   2.400   0.000  1.00 10.00           N',
    'HETATM    6  O   HOH A 100       9.000   9.000   9.000  1.00 10.00           O',
  ].join('\n');
  const pdb = PDBData.parse(text);
  assert.equal(pdb.atoms.length, 6);
  assert.equal(pdb.residues.length, 3);
  assert.equal(pdb.removeWater().atoms.length, 5);
  assert.equal(pdb.residues[0].label({ chainName: false }), 'ALA1');
  assert.equal(pdb.residues[0].label({ oneLetter: true, chainName: true }), 'A:A1');
  assert.equal(pdb.residues[1].missingAtoms, true);
});

function sphereMesh(n = 12) {
  // UV sphere, outward CCW faces
  const V = [], F = [];
  for (let i = 0; i <= n; i++) {
    const th = (Math.PI * i) / n;
    for (let j = 0; j < n * 2; j++) {
      const ph = (2 * Math.PI * j) / (n * 2);
      V.push([Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]);
    }
  }
  const idx = (i, j) => i * (n * 2) + (j % (n * 2));
  for (let i = 0; i < n; i++) for (let j = 0; j < n * 2; j++) {
    const a = idx(i, j), b = idx(i + 1, j), c = idx(i + 1, j + 1), d = idx(i, j + 1);
    if (i > 0) F.push([a, c, b]);
    if (i < n - 1) F.push([a, d, c]);
  }
  const m = new SurfaceMesh(V, F);
  m.mergeVertices(1e-9);
  return m;
}

test('surface generation of a two-atom molecule is a closed manifold', () => {
  const atoms = [{ pos: [0, 0, 0], element: 'C' }, { pos: [1.5, 0, 0], element: 'N' }];
  const mesh = generateSurface(atoms, { resolution: 0.5 });
  assert.ok(mesh.faces.length > 100);
  const t = new MeshTopology(mesh);
  assert.equal(t.boundaryEdges().length, 0);
  for (const [, fl] of t.edgeFaces) assert.equal(fl.length, 2);
  // normals point outward
  let out = 0;
  for (let i = 0; i < mesh.faces.length; i++) { const c = mesh.faceCenter(i), nrm = mesh.faceNormal(i); if (c[0] * nrm[0] + c[1] * nrm[1] + c[2] * nrm[2] > 0) out++; }
  assert.ok(out > mesh.faces.length * 0.95);
});

test('third point is placed to the left of A->B', () => {
  const p = thirdPoint([0, 0], [2, 0], 2, Math.SQRT2, Math.SQRT2);
  assert.ok(Math.abs(p[0] - 1) < 1e-9 && Math.abs(p[1] - 1) < 1e-9);
});

test('packing produces non-overlapping boxes', () => {
  const boxes = [{ width: 10, height: 5 }, { width: 3, height: 8 }, { width: 6, height: 6 }, { width: 2, height: 2 }];
  const pos = packBoxes(boxes, { margin: 1 });
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = { x: pos[i].x, y: pos[i].y, w: boxes[i].width + 2, h: boxes[i].height + 2 };
    const b = { x: pos[j].x, y: pos[j].y, w: boxes[j].width + 2, h: boxes[j].height + 2 };
    const overlap = a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9 && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;
    assert.ok(!overlap, `boxes ${i} and ${j} overlap`);
  }
});

test('workmesh: handle detection on a torus and cutting', () => {
  // torus
  const V = [], F = [];
  const n = 16, m = 8, R = 3, r = 1;
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const u = (2 * Math.PI * i) / n, v = (2 * Math.PI * j) / m;
    V.push([(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]);
  }
  const id = (i, j) => ((i + n) % n) * m + ((j + m) % m);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    F.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)]);
    F.push([id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
  }
  const mesh = new SurfaceMesh(V, F);
  const wm = new WorkMesh(mesh, F.map((_, i) => i));
  const all = wm.liveFaces();
  assert.equal(wm.euler(all).chi, 0);
  const loop = wm.findHandleLoop(all);
  assert.ok(loop && loop.length >= 3);
  wm.cutPath(loop, all, { loop: true });
  const eu = wm.euler(all);
  assert.equal(eu.loops, 2); // cylinder
});

test('unwrap of a whole sphere yields a valid island', () => {
  const mesh = sphereMesh(10);
  const r = unwrapDecoration(mesh, mesh.faces.map((_, i) => i), {});
  let mapped = 0, flipped = 0;
  for (const isl of r.islands) for (const fi of isl.faces) { mapped++; if (r.wm.isFlipped(fi)) flipped++; }
  assert.equal(mapped, mesh.faces.length);
  assert.equal(flipped, 0);
});

test('colour scheme parsing and resolution (last match wins)', () => {
  const cs = ColorScheme.parse('residue=ALA\tbackground_color=1,2,3\ttext_color=4,5,6\nresidue=ALA\tresidue_number=5\tbackground_color=7,8,9');
  assert.deepEqual(cs.resolve({ residue: 'ALA', residueNumber: '3' }).background, [1, 2, 3]);
  assert.deepEqual(cs.resolve({ residue: 'ALA', residueNumber: '5' }).background, [7, 8, 9]);
  assert.deepEqual(cs.resolve({ residue: 'ALA', residueNumber: '5' }).text, [4, 5, 6]);
  assert.deepEqual(ColorScheme.preset(0).resolve({ residue: 'LYS' }).background, [229, 51, 25]);
});

test('end-to-end: small peptide texture', () => {
  const text = [
    'ATOM      1  N   ALA A   1       0.000   0.000   0.000  1.00 10.00           N',
    'ATOM      2  CA  ALA A   1       1.500   0.000   0.000  1.00 10.00           C',
    'ATOM      3  C   ALA A   1       2.000   1.400   0.000  1.00 10.00           C',
    'ATOM      4  O   ALA A   1       3.000   1.800   0.000  1.00 10.00           O',
    'ATOM      5  N   GLY A   2       1.400   2.400   0.000  1.00 10.00           N',
    'ATOM      6  CA  GLY A   2       1.800   3.800   0.200  1.00 10.00           C',
    'ATOM      7  C   GLY A   2       3.200   4.200   0.500  1.00 10.00           C',
    'ATOM      8  O   GLY A   2       4.100   3.400   0.400  1.00 10.00           O',
  ].join('\n');
  const pdb = PDBData.parse(text);
  const mesh = generateSurface(pdb, { resolution: 0.6 });
  const decos = buildResidueDecorations(pdb, mesh, { colorMissing: false });
  assert.equal(decos.length, 2);
  const res = createTexturedObject(mesh, decos, { imageSize: 256, quiet: true });
  assert.equal(res.faceUV.length, mesh.faces.length);
  assert.ok(res.faceUV.every(t => t.every(i => i > 0)));
  assert.ok(res.uv.every(u => u[0] >= 0 && u[0] <= 1 && u[1] >= 0 && u[1] <= 1));
  assert.equal(res.texture.width, 256);
});
