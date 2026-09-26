// SurfStampJS public API.
//
//   const mesh = generateSurface(pdb)                         // SurfaceMesh {vertices, faces}
//   const decos = buildResidueDecorations(pdb, mesh)          // [{faces, text, textColor, backgroundColor, ...}]
//   const result = createTexturedObject(mesh, decos, opts)    // unwrap + texture
//   saveTexturedObject(result, 'out.obj')                     // .obj / .obj.mtl / .obj.png
import fs from 'node:fs';
import path from 'node:path';
import { MeshTopology, edgeKey } from './mesh.js';
import { unwrapDecoration } from './unwrap/group.js';
import { packBoxes } from './unwrap/pack.js';
import { drawTextureAtlas } from './texture/draw.js';
import { loadFont } from './texture/font.js';
import { encodePNG } from './texture/png.js';
import { writeTexturedOBJ } from './obj.js';

export { SurfaceMesh, MeshTopology } from './mesh.js';
export { generateSurface } from './surface.js';
export { PDBData } from './pdb.js';
export { mapFacesToStructure, removeJaggy } from './mapping.js';
export { ColorScheme } from './colors.js';
export { buildResidueDecorations } from './decorate.js';
export { loadOBJ, meshToOBJ } from './obj.js';
export { renderMesh } from './texture/preview.js';
export { encodePNG, decodePNG } from './texture/png.js';
export { loadFont } from './texture/font.js';
export { unwrapDecoration } from './unwrap/group.js';

/**
 * Unwrap every decoration's faces, pack the islands into one square texture, paint it and build the textured object.
 *
 * @param {import('./mesh.js').SurfaceMesh} mesh  surface (vertices + CCW faces)
 * @param {Array<{faces:number[], text?:string, textColor?:number[], backgroundColor?:number[], outlineColor?:number[],
 *                font?:string, bold?:boolean, noText?:boolean, noBackground?:boolean, noOutline?:boolean, sortKey?:any}>} decorations
 * @param {object} [opts]
 * @param {number} [opts.imageSize=2048]
 * @param {string} [opts.font] font family name or .ttf path (default: DejaVu Sans / first TrueType found)
 * @param {boolean} [opts.bold=true]
 * @param {number} [opts.outlineWidth=3]
 * @param {number} [opts.textNum=2]
 * @param {number} [opts.textDist=-2]
 * @param {number|null} [opts.fontSizeMin=null] minimum label size in px (null = automatic: 20% of the median fitting size)
 * @param {boolean} [opts.tile=false]
 * @param {number} [opts.tileFontSize=16]
 * @param {boolean} [opts.maxfill=false]
 * @param {[number,number,number]} [opts.upPoint] 3D point placed at the top of every island (label orientation)
 * @param {boolean} [opts.separate=true] split groups by normal direction
 * @param {number} [opts.refineCycles=5]
 * @param {(msg:string)=>void} [opts.log]
 * @returns {{vertices, faces, uv:number[][], faceUV:number[][], texture:import('./texture/raster.js').Raster, imageSize:number, labels:Array, decorations:Array}}
 */
export function createTexturedObject(mesh, decorations, opts = {}) {
  const imageSize = opts.imageSize || 2048;
  const log = opts.log || (() => {});
  const t0 = Date.now();
  // ---- unwrap each decoration ---------------------------------------------------------------------
  const unwrapped = [];
  let di = 0;
  for (const d of decorations) {
    if (!d.faces || !d.faces.length) { unwrapped.push(null); di++; continue; }
    const r = unwrapDecoration(mesh, d.faces, { upPoint: opts.upPoint, separate: opts.separate, refineCycles: opts.refineCycles, log: opts.verbose ? log : null });
    const all = r.islands.flatMap(i => i.faces);
    const b = r.wm.uvBounds(all);
    unwrapped.push({ wm: r.wm, islands: r.islands, all, bounds: b });
    di++;
    if (di % 25 === 0) log(`unwrap: ${di}/${decorations.length} decorations (${Date.now() - t0} ms)`);
  }
  log(`unwrap: done ${decorations.length} decorations in ${Date.now() - t0} ms`);
  // ---- atlas packing -------------------------------------------------------------------------------
  const boxes = unwrapped.map(u => (u ? { width: u.bounds.width, height: u.bounds.height } : { width: 0, height: 0 }));
  const margin = 3;
  const placed = packBoxes(boxes, { margin });
  let W = 0, H = 0;
  placed.forEach((p, i) => { if (!unwrapped[i]) return; W = Math.max(W, p.x + boxes[i].width + 2 * margin); H = Math.max(H, p.y + boxes[i].height + 2 * margin); });
  const scale = (imageSize - 10) / Math.max(W, H, 1e-9);
  // ---- assemble uv list and per-decoration drawing data --------------------------------------------
  const uv = [[0, 0]]; // index 0: dummy for unmapped faces
  const faceUV = mesh.faces.map(() => [0, 0, 0]);
  const faceDeco = new Int32Array(mesh.faces.length).fill(-1);
  decorations.forEach((d, i) => { if (d.faces) for (const fi of d.faces) faceDeco[fi] = i; });
  const baseTopo = new MeshTopology(mesh);
  const font = opts.fontObject || loadFont(opts.font, opts.bold !== false, { quiet: !!opts.quiet });
  const decos = [];
  for (let i = 0; i < decorations.length; i++) {
    const u = unwrapped[i];
    const d = decorations[i];
    if (!u) continue;
    const { wm, islands } = u;
    const p = placed[i];
    const toPixel = (q) => [
      (q[0] - u.bounds.minX + margin + p.x) * scale + 5,
      imageSize - ((q[1] - u.bounds.minY + margin + p.y) * scale + 5),
    ];
    const uvIndex = new Map();
    const pixelOf = (v) => {
      let e = uvIndex.get(v);
      if (!e) { const px = toPixel(wm.uv[v]); e = { idx: uv.length, px }; uv.push([px[0] / imageSize, 1 - px[1] / imageSize]); uvIndex.set(v, e); }
      return e;
    };
    const dIslands = [];
    const segs = [];
    let sumAreaPx = 0, sumArea3D = 0, scaleAcc = 0, scaleN = 0;
    for (const isl of islands) {
      const loops = wm.topo(isl.faces).boundaryLoops().map(lp => { const c = []; for (const v of lp) { const px = pixelOf(v).px; c.push(px[0], px[1]); } return c; });
      let area3D = 0;
      for (const fi of isl.faces) {
        const f = wm.faces[fi];
        const bf = wm.faceBase[fi];
        if (bf >= 0) faceUV[bf] = [pixelOf(f[0]).idx, pixelOf(f[1]).idx, pixelOf(f[2]).idx];
        const a3 = wm.faceArea(fi);
        area3D += a3;
        const P = [pixelOf(f[0]).px, pixelOf(f[1]).px, pixelOf(f[2]).px];
        const aPx = Math.abs((P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[1][1] - P[0][1]) * (P[2][0] - P[0][0])) / 2;
        sumAreaPx += aPx; sumArea3D += a3;
        if (a3 > 0 && aPx > 0) { scaleAcc += Math.sqrt(aPx / a3); scaleN++; }
        // outline segments: edges whose base edge separates different decorations
        for (let k = 0; k < 3; k++) {
          const a = f[k], b = f[(k + 1) % 3];
          const ba = wm.vertexBase[a], bb = wm.vertexBase[b];
          if (ba < 0 || bb < 0) continue;
          const fl = baseTopo.facesOnEdge(ba, bb);
          let boundary = fl.length < 2;
          for (const g of fl) if (faceDeco[g] !== i) boundary = true;
          if (boundary) { const pa = pixelOf(a).px, pb = pixelOf(b).px; segs.push([pa[0], pa[1], pb[0], pb[1]]); }
        }
      }
      dIslands.push({ loops, area3D });
    }
    decos.push({
      text: d.text || '', textColor: d.textColor || [0, 0, 0], backgroundColor: d.backgroundColor || [180, 180, 180],
      outlineColor: d.outlineColor || [0, 0, 0], noBackground: !!d.noBackground, noText: !!d.noText, noOutline: !!d.noOutline,
      islands: dIslands, outlineSegments: segs, scaleFactor: scaleN ? scaleAcc / scaleN : 14.5407,
      minLabelArea3D: d.minLabelArea3D,
    });
    void sumAreaPx; void sumArea3D;
  }
  log(`texture: drawing ${imageSize}x${imageSize} (${uv.length} uv)`);
  const t1 = Date.now();
  const { raster, labels, fontThreshold } = drawTextureAtlas({
    size: imageSize, decos, font,
    opts: { outlineWidth: opts.outlineWidth, textNum: opts.textNum, textDist: opts.textDist, fontSizeMin: opts.fontSizeMin, maxfill: opts.maxfill, tile: opts.tile, tileFontSize: opts.tileFontSize },
  });
  log(`texture: ${labels.length} labels drawn (font threshold ${fontThreshold.toFixed(1)} px) in ${Date.now() - t1} ms`);
  return { vertices: mesh.vertices, faces: mesh.faces, uv, faceUV, texture: raster, imageSize, labels, decorations, fontName: font.name };
}

/**
 * Write <objPath>, <objPath>.mtl and <objPath>.png.
 */
export function saveTexturedObject(result, objPath, { mtlTemplate = null, name = 'surface' } = {}) {
  const pngPath = objPath + '.png';
  fs.writeFileSync(pngPath, encodePNG(result.texture.data, result.texture.width, result.texture.height));
  const tex = { vertices: result.vertices, faces: result.faces, uv: result.uv, faceUV: result.faceUV, textureFile: pngPath };
  const { mtlPath } = writeTexturedOBJ(tex, objPath, { mtlTemplate, name });
  return { objPath, mtlPath, pngPath: path.resolve(pngPath) };
}
