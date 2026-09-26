#!/usr/bin/env node
// SurfStampJS command line interface.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDBData } from '../src/pdb.js';
import { generateSurface } from '../src/surface.js';
import { loadOBJ } from '../src/obj.js';
import { buildResidueDecorations } from '../src/decorate.js';
import { createTexturedObject, saveTexturedObject } from '../src/index.js';
import { renderMesh } from '../src/texture/preview.js';
import { encodePNG } from '../src/texture/png.js';

const USAGE = `Usage: surfstamp [-pdb file.pdb[.gz]] [-obj surface.obj] -out prefix [options]

Input
  -pdb FILE              PDB file (optionally gzipped)
  -obj FILE              use an existing surface mesh (.obj) instead of generating one (requires -pdb for labels)
  -nowater               remove HOH/DOD residues
  -nohetatm              remove HETATM records
  -noh                   remove hydrogen atoms
Surface
  -surface_resolution F  lattice spacing in Angstrom (default 0.5)
  -surface_proberadius F probe radius (default 1.4)
  -surface_removeinside  fill internal cavities
  -save_surface FILE     also write the plain surface mesh (.obj)
Grouping / labels
  -residue               group by residue (default)
  -residue_oneletter     one-letter residue labels
  -atom                  group by atom
  -chain                 group by chain
  -nochainname / -chainname   omit / force chain id in labels
  -color_scheme N|FILE   0 default (ClustalX), 1 hydropathy, 2 isoelectric, 3 atom, 4 B-factor, 5 occupancy, 7 chain gradation, or a file
  -color_missing         do not gray out chain breaks / terminals / missing atoms
  -remove_jaggy          absorb jagged boundary triangles
  -force                 skip the face-atom distance check
Texture
  -out PREFIX            output prefix: PREFIX.obj, PREFIX.obj.mtl, PREFIX.obj.png
  -image_size N          texture size (default 2048)
  -font_name NAME|FILE   font family or .ttf path (default DejaVu Sans)
  -text_weight plain|bold
  -font_size_min N       minimum label size in px (default: automatic)
  -outline_width F       outline width (default 3)
  -text_num N            labels per island (default 2)
  -text_dist F           minimum label spacing (default -2)
  -tile [-font_size N]   tile the label (font size default 16)
  -nobackground -nooutline -notext
  -maxfill               nonzero fill rule
  -nosep                 do not split groups by normal direction
  -large_threshold N     groups with more faces use cluster mapping (default 10000)
  -unwrap_large          always use cluster mapping
  -areamax_ratio F       split groups larger than F x the decoration area (e.g. 0.1)
  -max_group_faces N     split groups with more than N faces
  -verbose               per-decoration details
  -refinement_num N      scale refinement cycles (default 5)
  -targetpoint x,y,z     point placed at the top of every island (default: +y)
  -mtl_template FILE     material template
  -preview               also render preview images of the textured model
  -quiet                 less output
`;

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('-')) continue;
    const key = a.replace(/^-+/, '').toLowerCase().replace(/_/g, '');
    const next = argv[i + 1];
    if (next != null && !next.startsWith('-')) { o[key] = next; i++; } else o[key] = true;
  }
  return o;
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.h || o.help || (!o.pdb && !o.obj)) { process.stdout.write(USAGE); return o.h || o.help ? 0 : 1; }
  const quiet = !!o.quiet;
  const log = quiet ? () => {} : (m) => process.stderr.write(m + '\n');
  const t0 = Date.now();
  let pdb = null;
  if (o.pdb) {
    pdb = PDBData.load(o.pdb);
    if (o.nowater) pdb = pdb.removeWater();
    if (o.nohetatm) pdb = pdb.removeHetatm();
    if (o.noh) pdb = pdb.removeHydrogens();
    log(`loaded ${o.pdb}: ${pdb.atoms.length} atoms, ${pdb.residues.length} residues, ${pdb.chains.size} chain(s)`);
  }
  let mesh;
  if (o.obj) { mesh = loadOBJ(o.obj); mesh.mergeVertices(1e-6); log(`loaded mesh ${o.obj}: ${mesh.vertices.length} vertices, ${mesh.faces.length} faces`); }
  else {
    mesh = generateSurface(pdb, {
      resolution: o.surfaceresolution ? parseFloat(o.surfaceresolution) : 0.5,
      probeRadius: o.surfaceproberadius ? parseFloat(o.surfaceproberadius) : 1.4,
      removeInside: !!o.surfaceremoveinside, log,
    });
  }
  if (o.savesurface) { const { meshToOBJ } = await import('../src/obj.js'); fs.writeFileSync(o.savesurface, meshToOBJ(mesh)); }
  const outPrefix = (o.out || 'surfstamp_out').replace(/\.obj$/i, '');
  const objPath = outPrefix + '.obj';
  let scheme = 0;
  if (o.colorscheme != null) scheme = /^\d+$/.test(String(o.colorscheme)) ? parseInt(o.colorscheme) : String(o.colorscheme);
  const mode = o.atom ? 'atom' : o.chain ? 'chain' : 'residue';
  const decos = pdb ? buildResidueDecorations(pdb, mesh, {
    mode, scheme, oneLetter: !!o.residueoneletter,
    chainName: o.nochainname ? false : o.chainname ? true : undefined,
    colorMissing: !o.colormissing, removeJaggy: !!o.removejaggy, force: !!o.force,
    exvalueMin: o.exvaluemin != null ? parseFloat(o.exvaluemin) : undefined,
    exvalueMax: o.exvaluemax != null ? parseFloat(o.exvaluemax) : undefined,
  }) : [{ faces: mesh.faces.map((_, i) => i), text: '', backgroundColor: [200, 200, 200], noText: true }];
  if (o.nobackground) for (const d of decos) { d.noBackground = true; d.textColor = [0, 0, 0]; }
  if (o.nooutline) for (const d of decos) d.noOutline = true;
  if (o.notext) for (const d of decos) d.noText = true;
  log(`${decos.length} decorations`);
  let upPoint;
  if (o.targetpoint) { const p = String(o.targetpoint).split(',').map(Number); if (p.length === 3 && p.every(isFinite)) upPoint = p; }
  const result = createTexturedObject(mesh, decos, {
    imageSize: o.imagesize ? parseInt(o.imagesize) : 2048,
    font: o.fontname, bold: o.textweight !== 'plain',
    fontSizeMin: o.fontsizemin != null ? parseFloat(o.fontsizemin) : null,
    outlineWidth: o.outlinewidth != null ? parseFloat(o.outlinewidth) : 3,
    textNum: o.textnum != null ? parseInt(o.textnum) : 2,
    textDist: o.textdist != null ? parseFloat(o.textdist) : -2,
    tile: !!o.tile, tileFontSize: o.fontsize != null ? parseFloat(o.fontsize) : 16,
    maxfill: !!o.maxfill, separate: !o.nosep,
    refineCycles: o.refinementnum != null ? parseInt(o.refinementnum) : 5,
    upPoint, log, quiet, verbose: !!o.verbose,
    largeThreshold: o.largethreshold != null ? parseInt(o.largethreshold) : 10000, forceLarge: !!o.unwraplarge,
    areaMaxRatio: o.areamaxratio != null ? parseFloat(o.areamaxratio) : 0,
    maxGroupFaces: o.maxgroupfaces != null ? parseInt(o.maxgroupfaces) : 0,
  });
  const mtlTemplate = o.mtltemplate ? fs.readFileSync(o.mtltemplate, 'utf8') : null;
  const saved = saveTexturedObject(result, objPath, { mtlTemplate, name: path.basename(outPrefix) });
  log(`wrote ${saved.objPath}, ${saved.mtlPath}, ${saved.pngPath}`);
  if (o.preview) {
    const views = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
    views.forEach((v, i) => {
      const r = renderMesh({ vertices: result.vertices, faces: result.faces, size: 1024, view: v, texture: { raster: result.texture, uv: result.uv, faceUV: result.faceUV } });
      fs.writeFileSync(`${outPrefix}_preview${i + 1}.png`, encodePNG(r.data, r.width, r.height));
    });
    log(`wrote ${views.length} preview images`);
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code)).catch(e => { console.error(e); process.exit(1); });
}
