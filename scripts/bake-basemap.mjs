/**
 * Bake Natural Earth 110m into a compact binary for dv.gl's BasemapLayer:
 *   - coastlines + admin-0 borders as Earth-fixed (ECEF, km) line-lists;
 *   - land polygons earcut-triangulated into an ECEF triangle-list (filled land).
 *
 * Coastlines/borders densify long lon/lat segments (so borders drape instead of
 * chording under the ellipsoid) and sit at +3 km; land fill sits at +1 km (just under
 * the coastlines). All WGS84 ECEF km.
 *
 * Output (v2): [magic u32][version u32][coastFloats u32][borderFloats u32]
 *              [landFloats u32][coast f32...][border f32...][land f32...]
 *
 * Usage: node scripts/bake-basemap.mjs <coast.geojson> <borders.geojson> <land.geojson> <out.bin>
 * Natural Earth is public domain (nvkelso/natural-earth-vector).
 */
import { readFileSync, writeFileSync } from "node:fs";
import earcut from "earcut";

const A = 6378.137; // WGS84 semi-major, km
const E2 = 6.69437999014e-3; // WGS84 first eccentricity squared
const STEP_DEG = 1.0; // densify granularity for lines

function geodeticToEcef(latDeg, lonDeg, liftKm) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sLat = Math.sin(lat);
  const cLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sLat * sLat);
  return [
    (n + liftKm) * cLat * Math.cos(lon),
    (n + liftKm) * cLat * Math.sin(lon),
    (n * (1 - E2) + liftKm) * sLat,
  ];
}

// ---- lines (coast / borders) -------------------------------------------------
function emitPolyline(coords, out) {
  for (let i = 0; i < coords.length - 1; i += 1) {
    const [lon1, lat1] = coords[i];
    let [lon2, lat2] = coords[i + 1];
    while (lon2 - lon1 > 180) lon2 -= 360;
    while (lon2 - lon1 < -180) lon2 += 360;
    const span = Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1));
    const steps = Math.max(1, Math.ceil(span / STEP_DEG));
    let prev = geodeticToEcef(lat1, lon1, 3);
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const cur = geodeticToEcef(lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t, 3);
      out.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]);
      prev = cur;
    }
  }
}

function bakeLines(path) {
  const gj = JSON.parse(readFileSync(path, "utf8"));
  const out = [];
  for (const f of gj.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "LineString") emitPolyline(g.coordinates, out);
    else if (g.type === "MultiLineString") for (const l of g.coordinates) emitPolyline(l, out);
    else if (g.type === "Polygon") for (const r of g.coordinates) emitPolyline(r, out);
    else if (g.type === "MultiPolygon")
      for (const p of g.coordinates) for (const r of p) emitPolyline(r, out);
  }
  return Float32Array.from(out);
}

// ---- land fill (earcut-triangulated polygons, sphere-tessellated) ------------
const MAX_EDGE_DEG = 3; // subdivide so triangles hug the sphere (chord dip < lift)
const LAND_LIFT_KM = 3;

function edgeDeg(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * Emit a triangle as ECEF, recursively splitting its longest edge until every edge
 * is short — a flat triangle spanning a wide arc chords *below* the globe and gets
 * depth-culled, so we tessellate it to drape on the surface.
 */
function emitTri(a, b, c, out, depth) {
  const ab = edgeDeg(a, b);
  const bc = edgeDeg(b, c);
  const ca = edgeDeg(c, a);
  if (Math.max(ab, bc, ca) <= MAX_EDGE_DEG || depth >= 7) {
    for (const v of [a, b, c]) {
      const [x, y, z] = geodeticToEcef(v[1], v[0], LAND_LIFT_KM);
      out.push(x, y, z);
    }
    return;
  }
  if (ab >= bc && ab >= ca) {
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    emitTri(a, m, c, out, depth + 1);
    emitTri(m, b, c, out, depth + 1);
  } else if (bc >= ca) {
    const m = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
    emitTri(a, b, m, out, depth + 1);
    emitTri(a, m, c, out, depth + 1);
  } else {
    const m = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
    emitTri(a, b, m, out, depth + 1);
    emitTri(m, b, c, out, depth + 1);
  }
}

function emitPolygon(rings, out) {
  const flat = [];
  const holes = [];
  rings.forEach((ring, i) => {
    if (i > 0) holes.push(flat.length / 2);
    for (const [lon, lat] of ring) flat.push(lon, lat);
  });
  if (flat.length < 6) return;
  const idx = earcut(flat, holes.length ? holes : null, 2);
  for (let t = 0; t < idx.length; t += 3) {
    const a = [flat[idx[t] * 2], flat[idx[t] * 2 + 1]];
    const b = [flat[idx[t + 1] * 2], flat[idx[t + 1] * 2 + 1]];
    const c = [flat[idx[t + 2] * 2], flat[idx[t + 2] * 2 + 1]];
    emitTri(a, b, c, out, 0);
  }
}

function bakeLand(path) {
  const gj = JSON.parse(readFileSync(path, "utf8"));
  const out = [];
  for (const f of gj.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "Polygon") emitPolygon(g.coordinates, out);
    else if (g.type === "MultiPolygon") for (const p of g.coordinates) emitPolygon(p, out);
  }
  return Float32Array.from(out);
}

const [, , coastPath, borderPath, landPath, outPath] = process.argv;
const coast = bakeLines(coastPath);
const borders = bakeLines(borderPath);
const land = bakeLand(landPath);

const header = new Uint32Array([0x44564742, 2, coast.length, borders.length, land.length]);
const buf = Buffer.concat([
  Buffer.from(header.buffer),
  Buffer.from(coast.buffer),
  Buffer.from(borders.buffer),
  Buffer.from(land.buffer),
]);
writeFileSync(outPath, buf);
console.log(
  `baked ${outPath}: coast ${coast.length / 6} segs, borders ${borders.length / 6} segs, ` +
    `land ${land.length / 9} tris, ${(buf.length / 1024).toFixed(0)} KB`,
);
