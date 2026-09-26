// Tiny software renderer for previews: orthographic projection, z-buffer, Lambert shading,
// per-face colours or texture sampling. Debug/verification aid only.
import { Raster } from './raster.js';
import { v3 } from '../vec.js';

/**
 * @param {object} p
 * @param {Array<[number,number,number]>} p.vertices
 * @param {Array<[number,number,number]>} p.faces
 * @param {number} [p.size=800]
 * @param {[number,number,number]} [p.view] view direction (from camera to scene), default [0,0,-1]
 * @param {[number,number,number]} [p.up]
 * @param {(fi:number)=>number[]} [p.faceColor] returns [r,g,b]
 * @param {{raster:Raster, uv:number[][], faceUV:number[][]}} [p.texture] texture sampling (uv in 0..1, v up)
 * @param {boolean} [p.cullBack=true]
 * @returns {Raster}
 */
export function renderMesh(p) {
  const size = p.size || 800;
  const view = v3.norm(p.view || [0, 0, -1]);
  let up = p.up || (Math.abs(view[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0]);
  const right = v3.norm(v3.cross(view, up));
  up = v3.norm(v3.cross(right, view));
  const V = p.vertices;
  // project
  const proj = V.map(v => [v3.dot(v, right), v3.dot(v, up), v3.dot(v, view)]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const q of proj) { if (q[0] < minX) minX = q[0]; if (q[0] > maxX) maxX = q[0]; if (q[1] < minY) minY = q[1]; if (q[1] > maxY) maxY = q[1]; }
  const span = Math.max(maxX - minX, maxY - minY) * 1.05 || 1;
  const scale = size / span;
  const ox = (size - (maxX - minX) * scale) / 2, oy = (size - (maxY - minY) * scale) / 2;
  const px = proj.map(q => [ox + (q[0] - minX) * scale, size - (oy + (q[1] - minY) * scale), q[2]]);
  const r = new Raster(size, size);
  r.clear(30, 30, 40);
  const zbuf = new Float32Array(size * size).fill(-Infinity);
  const light = v3.norm([-0.4, 0.6, -0.7]);
  const cull = p.cullBack !== false;
  const tex = p.texture;
  const data = r.data;
  for (let fi = 0; fi < p.faces.length; fi++) {
    const f = p.faces[fi];
    const a = px[f[0]], b = px[f[1]], c = px[f[2]];
    const n = v3.triNormal(V[f[0]], V[f[1]], V[f[2]]);
    const facing = -v3.dot(n, view); // >0 faces camera
    if (cull && facing <= 0) continue;
    let shade = Math.max(0, -v3.dot(n, light)) * 0.75 + 0.25;
    if (!cull && facing <= 0) shade *= 0.5;
    let col = p.faceColor ? p.faceColor(fi) : [200, 200, 200];
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(det) < 1e-12) continue;
    let ta, tb, tc;
    if (tex) { const t = tex.faceUV[fi]; ta = tex.uv[t[0]]; tb = tex.uv[t[1]]; tc = tex.uv[t[2]]; }
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const qx = x + 0.5, qy = y + 0.5;
      let w0 = ((b[0] - qx) * (c[1] - qy) - (b[1] - qy) * (c[0] - qx)) / det;
      let w1 = ((c[0] - qx) * (a[1] - qy) - (c[1] - qy) * (a[0] - qx)) / det;
      let w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      const z = w0 * a[2] + w1 * b[2] + w2 * c[2];
      const zi = y * size + x;
      if (z <= zbuf[zi]) continue;
      zbuf[zi] = z;
      if (tex) {
        const u = w0 * ta[0] + w1 * tb[0] + w2 * tc[0];
        const v = w0 * ta[1] + w1 * tb[1] + w2 * tc[1];
        const tx = Math.min(tex.raster.width - 1, Math.max(0, Math.floor(u * tex.raster.width)));
        const ty = Math.min(tex.raster.height - 1, Math.max(0, Math.floor((1 - v) * tex.raster.height)));
        const o = (ty * tex.raster.width + tx) * 4;
        col = [tex.raster.data[o], tex.raster.data[o + 1], tex.raster.data[o + 2]];
      }
      const o = zi * 4;
      data[o] = col[0] * shade; data[o + 1] = col[1] * shade; data[o + 2] = col[2] * shade; data[o + 3] = 255;
    }
  }
  return r;
}
