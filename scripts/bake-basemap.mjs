/**
 * Bake Natural Earth 110m vector coastlines + admin-0 borders into a compact binary
 * of Earth-fixed (ECEF, km) line-list vertices for dv.gl's BasemapLayer.
 *
 * - Densifies long lon/lat segments (borders like the 49th parallel are straight in
 *   lon/lat and would chord *under* the ellipsoid otherwise) by linear lon/lat interp,
 *   which correctly keeps parallels on their parallel.
 * - Converts to WGS84 ECEF at +3 km so lines sit just above the rendered ellipsoid
 *   (no z-fight, no clipping at the equatorial bulge).
 * - Output: [magic u32][version u32][coastFloats u32][borderFloats u32][coast f32...][border f32...]
 *
 * Usage: node scripts/bake-basemap.mjs <coast.geojson> <borders.geojson> <out.bin>
 * Natural Earth is public domain (nvkelso/natural-earth-vector).
 */
import { readFileSync, writeFileSync } from "node:fs";

const A = 6378.137; // WGS84 semi-major, km
const E2 = 6.69437999014e-3; // WGS84 first eccentricity squared
const LIFT_KM = 3; // sit just above the ellipsoid surface
const STEP_DEG = 1.0; // densify granularity

function geodeticToEcef(latDeg, lonDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sLat = Math.sin(lat);
  const cLat = Math.cos(lat);
  const n = A / Math.sqrt(1 - E2 * sLat * sLat);
  return [
    (n + LIFT_KM) * cLat * Math.cos(lon),
    (n + LIFT_KM) * cLat * Math.sin(lon),
    (n * (1 - E2) + LIFT_KM) * sLat,
  ];
}

/** Push a densified, draped line-list for one polyline of [lon,lat] points into `out`. */
function emitPolyline(coords, out) {
  for (let i = 0; i < coords.length - 1; i += 1) {
    const [lon1, lat1] = coords[i];
    let [lon2, lat2] = coords[i + 1];
    // unwrap the antimeridian so linear interp sweeps the short way
    while (lon2 - lon1 > 180) lon2 -= 360;
    while (lon2 - lon1 < -180) lon2 += 360;
    const span = Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1));
    const steps = Math.max(1, Math.ceil(span / STEP_DEG));
    let prev = geodeticToEcef(lat1, lon1);
    for (let s = 1; s <= steps; s += 1) {
      const t = s / steps;
      const cur = geodeticToEcef(lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t);
      out.push(prev[0], prev[1], prev[2], cur[0], cur[1], cur[2]);
      prev = cur;
    }
  }
}

function bakeGeoJson(path) {
  const gj = JSON.parse(readFileSync(path, "utf8"));
  const out = [];
  for (const f of gj.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === "LineString") emitPolyline(g.coordinates, out);
    else if (g.type === "MultiLineString") for (const line of g.coordinates) emitPolyline(line, out);
    else if (g.type === "Polygon") for (const ring of g.coordinates) emitPolyline(ring, out);
    else if (g.type === "MultiPolygon")
      for (const poly of g.coordinates) for (const ring of poly) emitPolyline(ring, out);
  }
  return Float32Array.from(out);
}

const [, , coastPath, borderPath, outPath] = process.argv;
const coast = bakeGeoJson(coastPath);
const borders = bakeGeoJson(borderPath);

const header = new Uint32Array([0x44564742, 1, coast.length, borders.length]);
const buf = Buffer.concat([
  Buffer.from(header.buffer),
  Buffer.from(coast.buffer),
  Buffer.from(borders.buffer),
]);
writeFileSync(outPath, buf);
console.log(
  `baked ${outPath}: coast ${coast.length / 6} segs, borders ${borders.length / 6} segs, ${(buf.length / 1024).toFixed(0)} KB`,
);
