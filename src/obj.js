// Wavefront .obj / .mtl export and (plain) import.
import fs from 'node:fs';
import path from 'node:path';
import { SurfaceMesh } from './mesh.js';

/**
 * Export a plain mesh (no texture) to .obj text.
 */
export function meshToOBJ(mesh, { name = 'surface', normals = true } = {}) {
  const out = [];
  out.push(`o ${name}`);
  for (const v of mesh.vertices) out.push(`v ${v[0].toFixed(4)} ${v[1].toFixed(4)} ${v[2].toFixed(4)}`);
  let vn = null;
  if (normals) {
    vn = mesh.vertexNormals();
    for (const n of vn) out.push(`vn ${n[0].toFixed(4)} ${n[1].toFixed(4)} ${n[2].toFixed(4)}`);
  }
  for (const f of mesh.faces) {
    if (vn) out.push(`f ${f[0] + 1}//${f[0] + 1} ${f[1] + 1}//${f[1] + 1} ${f[2] + 1}//${f[2] + 1}`);
    else out.push(`f ${f[0] + 1} ${f[1] + 1} ${f[2] + 1}`);
  }
  return out.join('\n') + '\n';
}

/**
 * Export a textured mesh.
 * @param {object} tex result of createTexturedObject: {vertices, faces, uv: [u,v][] (0..1, v up), faceUV: [[a,b,c]] indices into uv, textureFile}
 * @param {string} objPath output path (.obj). The .mtl is written next to it as <obj>.mtl.
 */
export function writeTexturedOBJ(tex, objPath, { materialName = 'material1', mtlTemplate = null, name = 'surface' } = {}) {
  const mtlPath = objPath + '.mtl';
  const out = [];
  out.push(`mtllib ${path.basename(mtlPath)}`);
  out.push(`o ${name}`);
  for (const v of tex.vertices) out.push(`v ${v[0].toFixed(4)} ${v[1].toFixed(4)} ${v[2].toFixed(4)}`);
  for (const t of tex.uv) out.push(`vt ${t[0].toFixed(6)} ${t[1].toFixed(6)}`);
  const vn = new SurfaceMesh(tex.vertices, tex.faces).vertexNormals();
  for (const n of vn) out.push(`vn ${n[0].toFixed(4)} ${n[1].toFixed(4)} ${n[2].toFixed(4)}`);
  out.push(`usemtl ${materialName}`);
  for (let i = 0; i < tex.faces.length; i++) {
    const f = tex.faces[i], t = tex.faceUV[i];
    out.push(`f ${f[0] + 1}/${t[0] + 1}/${f[0] + 1} ${f[1] + 1}/${t[1] + 1}/${f[1] + 1} ${f[2] + 1}/${t[2] + 1}/${f[2] + 1}`);
  }
  fs.writeFileSync(objPath, out.join('\n') + '\n');
  const texName = path.basename(tex.textureFile);
  let mtl;
  if (mtlTemplate) {
    mtl = mtlTemplate.replace(/^newmtl\s+.*$/m, `newmtl ${materialName}`).replace(/\s*$/, '\n') + `map_Kd ${texName}\n`;
  } else {
    mtl = [`newmtl ${materialName}`, 'Ka 1.0 1.0 1.0', 'Kd 0.8 0.8 0.8', 'Ks 0.0 0.0 0.0', 'Ke 0.2 0.2 0.2', 'Ns 0.0', 'Ni 1.0', 'd 1.0', 'illum 2',
      `map_Kd ${texName}`, `map_Ka ${texName}`, ''].join('\n');
  }
  fs.writeFileSync(mtlPath, mtl);
  return { objPath, mtlPath };
}

/** Load a plain .obj (v / f lines; polygons are fan-triangulated). Returns SurfaceMesh. */
export function loadOBJ(file) {
  const text = fs.readFileSync(file, 'utf8');
  const vertices = [], faces = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[0] === 'v') vertices.push([parseFloat(t[1]), parseFloat(t[2]), parseFloat(t[3])]);
    else if (t[0] === 'f') {
      const idx = t.slice(1).map(s => { const i = parseInt(s.split('/')[0]); return i < 0 ? vertices.length + i : i - 1; });
      for (let k = 1; k + 1 < idx.length; k++) faces.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  return new SurfaceMesh(vertices, faces);
}
