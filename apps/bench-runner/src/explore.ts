/*
 * Copyright 2026 nicanadian
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Interactive explore mode: the @dvgl/webgpu clean-sheet renderer with mouse orbit,
 * wheel zoom, a scrubbable 7-day timeline, and play/pause. NOT a benchmark page --
 * no metrics, input is yours. This is the seed of the actual product demo.
 */
import { declutterLabels, type LabelBox, MissionClock, TimelineMarks } from "@dvgl/core";
import { ecefToGeodetic, ecefToSurface, geodeticToEcef, gmst } from "@dvgl/frames";
import {
  CoverageOverlay,
  decodePickedIndex,
  EarthRenderer,
  LineRenderer,
  OrbitTrackRenderer,
  PointRenderer,
  TriRenderer,
} from "@dvgl/webgpu";
import {
  catalogEpochMs,
  type Collect,
  collectFootprintCorners,
  collectState,
  collectTargetEcef,
  elevationDeg,
  parseCollects,
  parseCatalog,
  RevisitGrid,
  sensorSwathEdges,
  type SwathOptions,
  stationEcef,
} from "@dvgl/orbits";
import { loadCatalogText, makeSource, readVariant } from "./sources.js";

// ---- minimal mat4 (same as cleansheet) ----

function perspective(fovyRad: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovyRad / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

function lookAtRte(eye: readonly [number, number, number]): Float32Array {
  const len = Math.hypot(eye[0], eye[1], eye[2]);
  const fx = -eye[0] / len;
  const fy = -eye[1] / len;
  const fz = -eye[2] / len;
  let rx = fy;
  let ry = -fx;
  let rz = 0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  const ux = ry * fz;
  const uy = -rx * fz;
  const uz = rx * fy - ry * fx;
  const out = new Float32Array(16);
  out[0] = rx;
  out[4] = ry;
  out[8] = rz;
  out[1] = ux;
  out[5] = uy;
  out[9] = uz;
  out[2] = -fx;
  out[6] = -fy;
  out[10] = -fz;
  out[15] = 1;
  return out;
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = s;
    }
  }
  return out;
}

// ---- interactive state ----

const WINDOW_MINUTES = 7 * 24 * 60;

interface View {
  lonDeg: number;
  latDeg: number;
  rangeKm: number;
}

function eyeFrom(view: View): [number, number, number] {
  const lon = (view.lonDeg * Math.PI) / 180;
  const lat = (view.latDeg * Math.PI) / 180;
  return [
    view.rangeKm * Math.cos(lat) * Math.cos(lon),
    view.rangeKm * Math.cos(lat) * Math.sin(lon),
    view.rangeKm * Math.sin(lat),
  ];
}

async function main(): Promise<void> {
  const status = document.getElementById("status");
  const say = (t: string): void => {
    if (status) status.textContent = t;
  };
  try {
    if (!navigator.gpu) throw new Error("WebGPU unavailable (check chrome://gpu)");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("no WebGPU adapter");
    const device = await adapter.requestDevice();

    const canvas = document.getElementById("scene") as HTMLCanvasElement;
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    const context = canvas.getContext("webgpu");
    if (!context) throw new Error("no webgpu canvas context");
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: "opaque" });
    const depthFormat: GPUTextureFormat = "depth24plus";
    const depthTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const earth = new EarthRenderer(device, { format, depthFormat });

    // ---- id-picking (V2): an offscreen pass writes object ids; a 1x1 readback
    // at the cursor returns the object under it ----
    const pickFormat: GPUTextureFormat = "rgba8unorm";
    const idTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      format: pickFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const idDepth = device.createTexture({
      size: [canvas.width, canvas.height],
      format: depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const pickReadback = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    let pickX = -1;
    let pickY = -1;
    let pickPending = false;
    let pickMapping = false;
    let hoveredIndex = -1;
    let afterColors: () => void = () => {}; // re-applies the hover highlight after a base recolor
    const pickEl = document.getElementById("pick") as HTMLElement;

    say("loading catalog...");
    const { mode, multiplier } = readVariant();
    const catalog = await loadCatalogText();
    const source = await makeSource(mode, catalog.text, multiplier);
    let renderer: PointRenderer | undefined;
    let tracks: OrbitTrackRenderer | undefined;
    const TRACK_SAMPLES = 129;
    // full-catalog windows are count*samples SGP4 evals; gate to fleet-scale sets
    const tracksAffordable = source.requestWindow !== undefined && source.count <= 512;
    let lastWindowCenterMin = Number.NEGATIVE_INFINITY;
    // latest window buffer kept CPU-side so the 2D map can reproject it to ground
    // tracks; only usable there when the window was sampled in ECEF (per-sample GMST)
    let winRaw: Float32Array | undefined;
    let winSamples = 0;
    let winIsEcef = false;
    let winPeriods: Float32Array | undefined; // per-object orbital period (min) for the 2D past/future split

    const view: View = { lonDeg: -75, latDeg: 25, rangeKm: 45_000 };

    // Mission-object grouping: when the source knows object names, group them by
    // family (the alpha token of the sat id, e.g. "SAR-01" -> "SAR") and colour
    // each family. The per-object alpha channel doubles as the visibility FILTER:
    // 0 hides that family from both points and tracks. The panel is data-driven,
    // so any named fleet gets a grouped, collapsible legend.
    const familyOf = (name: string): string => {
      const tail = name.split("/").pop() ?? name;
      return tail.replace(/[\s_-]*\d+$/, "") || tail;
    };
    const KNOWN: Record<string, [number, number, number]> = {
      EO: [0.55, 0.85, 1.0],
      SAR: [1.0, 0.78, 0.35],
    };
    const PALETTE: [number, number, number][] = [
      [0.55, 0.85, 1.0],
      [1.0, 0.78, 0.35],
      [0.6, 1.0, 0.65],
      [1.0, 0.55, 0.85],
      [0.8, 0.8, 1.0],
      [1.0, 0.5, 0.4],
    ];
    const families = source.names?.map(familyOf);
    const groups: { name: string; color: [number, number, number]; count: number; visible: boolean }[] =
      [];
    if (families) {
      for (const fam of families) {
        let g = groups.find((x) => x.name === fam);
        if (!g) {
          g = {
            name: fam,
            color: KNOWN[fam] ?? PALETTE[groups.length % PALETTE.length] ?? [0.7, 0.85, 1.0],
            count: 0,
            visible: true,
          };
          groups.push(g);
        }
        g.count += 1;
      }
    }
    const buildColors = (): Float32Array | undefined => {
      if (!families) return undefined;
      const rgba = new Float32Array(source.count * 4);
      families.forEach((fam, k) => {
        const g = groups.find((x) => x.name === fam);
        const c = g?.color ?? [0.55, 0.85, 1.0];
        rgba.set([c[0], c[1], c[2], g?.visible ? 1 : 0], k * 4);
      });
      return rgba;
    };
    let colors = buildColors();
    const applyColors = (): void => {
      colors = buildColors();
      if (colors) {
        renderer?.setColors(colors);
        tracks?.setColors(colors);
      }
      afterColors(); // keep pinned/hovered highlights after a family-filter change
    };
    // layers dock (top-left, collapsible): view mode + overlay toggles live here,
    // so the bottom bar is pure transport and the timeline keeps its full width.
    {
      const lp = document.getElementById("layers") as HTMLElement;
      const lh = document.getElementById("layersHead") as HTMLElement;
      lh.addEventListener("click", () => lp.classList.toggle("collapsed"));
    }
    // build the mission-objects panel (top-right, collapsible)
    const panel = document.getElementById("objects") as HTMLElement;
    if (families && groups.length > 0) {
      panel.style.display = "block";
      const head = document.getElementById("objectsHead") as HTMLElement;
      head.addEventListener("click", () => panel.classList.toggle("collapsed"));
      const body = document.getElementById("objectsBody") as HTMLElement;
      for (const g of groups) {
        const row = document.createElement("div");
        row.className = "objRow";
        const hex = (c: [number, number, number]): string =>
          `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
        row.innerHTML =
          `<span class="objSwatch" style="background:${hex(g.color)}"></span>` +
          `<span class="objName">${g.name}</span><span class="objCount">${g.count}</span>`;
        row.addEventListener("click", () => {
          g.visible = !g.visible;
          row.classList.toggle("off", !g.visible);
          applyColors();
        });
        body.appendChild(row);
      }
    }

    // @dvgl/core's first consumer: the MissionClock owns play state, rate, looping,
    // and the scene-time axis; the page just feeds it wall deltas and reads it.
    // ephemeris sources know their own epoch/span; TLE catalogs use the 7-day default
    const windowSeconds = source.windowSeconds ?? WINDOW_MINUTES * 60;
    const clock = new MissionClock({
      epochMs: source.epochMs ?? catalogEpochMs(parseCatalog(catalog.text).objects) ?? 0,
      windowSeconds,
      rate: source.windowSeconds !== undefined ? 60 : 600,
    });
    (document.getElementById("time") as HTMLInputElement).max = String(
      Math.floor(windowSeconds / 60) - 1,
    );
    const timeLabel = document.querySelector('label[for="time"]');
    if (timeLabel) {
      const hours = windowSeconds / 3600;
      timeLabel.textContent =
        hours >= 48 ? `timeline (${Math.round(hours / 24)} days) \u2192` : `timeline (${Math.round(hours)} h) \u2192`;
    }
    clock.play();
    let dirty = true;

    // async propagation: latest-wins coalescing lives in the source; the render
    // loop never blocks on evaluation, which is why scrubbing stays smooth
    const clockEl = document.getElementById("clock");
    let latestPositions: Float32Array | undefined; // world/TEME, for live access geometry
    // V1 direction markers: per-object unit velocity (finite difference) + leaders
    const prevPositions = new Float32Array(source.count * 3);
    const dirVec = new Float32Array(source.count * 3);
    let prevMin = Number.NaN;
    const headingBox = document.getElementById("heading") as HTMLInputElement;
    const headingLines = new LineRenderer(device, {
      capacity: source.count * 2,
      format,
      depthFormat,
    });
    const headSeg = new Float32Array(source.count * 2 * 3);
    const headCol = new Float32Array(source.count * 2 * 4);
    const LEADER_KM = 500;

    // Ground-swath sizing shared by the field-of-regard geometry below. The
    // "footprint" layer is retired; it returns as a tasked collect (see below).
    const SWATH_SEG = 14;
    const SWATH_EO: SwathOptions = {
      side: "both",
      innerOffNadirDeg: 0,
      outerOffNadirDeg: 30,
      alongHalfDeg: 4,
      segments: SWATH_SEG,
    };
    const FP_OUTLINE_SEG = SWATH_SEG * 2 + 2; // near edge + far edge + 2 end caps

    // Field-of-regard ENVELOPE -- everywhere a sensor COULD steer to (not where it
    // is pointed, and NOT "coverage"). Same swath primitive widened to the full
    // steering limits, drawn faintly for every visible satellite (narrow via the
    // family filter). "Could see" must never be mistaken for coverage "did see".
    const ACCESS: Record<string, SwathOptions> = {
      SAR: { side: "right", innerOffNadirDeg: 15, outerOffNadirDeg: 50, alongHalfDeg: 5, segments: SWATH_SEG },
      EO: { side: "both", innerOffNadirDeg: 0, outerOffNadirDeg: 45, alongHalfDeg: 5, segments: SWATH_SEG },
    };
    const ACCESS_EO: SwathOptions = ACCESS.EO ?? SWATH_EO;
    const accessFor = (fam: string | undefined): SwathOptions => ACCESS[fam ?? ""] ?? ACCESS_EO;
    const accessBox = document.getElementById("access") as HTMLInputElement;
    const accessFill = new TriRenderer(device, {
      capacity: source.count * (SWATH_SEG - 1) * 2 * 3,
      format,
      depthFormat,
    });
    const accessTriPos = new Float32Array(source.count * (SWATH_SEG - 1) * 2 * 3 * 3);
    const accessTriCol = new Float32Array(source.count * (SWATH_SEG - 1) * 2 * 3 * 4);
    const accessLineR = new LineRenderer(device, {
      capacity: source.count * FP_OUTLINE_SEG * 2,
      format,
      depthFormat,
    });
    const acSeg = new Float32Array(source.count * FP_OUTLINE_SEG * 2 * 3);
    const acCol = new Float32Array(source.count * FP_OUTLINE_SEG * 2 * 4);

    // Build filled ground swaths (+ edge outlines) for the objects `include`
    // accepts, into caller buffers. Shared by the footprint layer (all visible,
    // nominal angles) and the access layer (selected only, wide FOR angles).
    const buildSwaths = (
      include: (k: number) => boolean,
      optFor: (fam: string | undefined) => SwathOptions,
      triPos: Float32Array,
      triCol: Float32Array,
      segPos: Float32Array,
      segCol: Float32Array,
      fillAlpha: number,
      lineAlpha: number,
    ): { tris: number; segs: number } => {
      if (!latestPositions) return { tris: 0, segs: 0 };
      const pos = latestPositions;
      let ft = 0;
      let fs = 0;
      const tri = (e: Float32Array, j: number, r: number, g: number, b: number): void => {
        triPos[ft * 3] = e[j * 3] ?? 0;
        triPos[ft * 3 + 1] = e[j * 3 + 1] ?? 0;
        triPos[ft * 3 + 2] = e[j * 3 + 2] ?? 0;
        triCol.set([r, g, b, fillAlpha], ft * 4);
        ft += 1;
      };
      const out = (a: Float32Array, ai: number, b: Float32Array, bi: number, r: number, g: number, bl: number): void => {
        const p = fs * 6;
        segPos[p] = a[ai * 3] ?? 0;
        segPos[p + 1] = a[ai * 3 + 1] ?? 0;
        segPos[p + 2] = a[ai * 3 + 2] ?? 0;
        segPos[p + 3] = b[bi * 3] ?? 0;
        segPos[p + 4] = b[bi * 3 + 1] ?? 0;
        segPos[p + 5] = b[bi * 3 + 2] ?? 0;
        segCol.set([r, g, bl, lineAlpha, r, g, bl, lineAlpha], fs * 8);
        fs += 1;
      };
      for (let k = 0; k < source.count; k += 1) {
        if (!include(k)) continue;
        const x = pos[k * 3] ?? Number.NaN;
        if (!Number.isFinite(x)) continue;
        const vx = dirVec[k * 3] ?? 0;
        const vy = dirVec[k * 3 + 1] ?? 0;
        const vz = dirVec[k * 3 + 2] ?? 0;
        if (vx === 0 && vy === 0 && vz === 0) continue; // heading not established yet
        const { near, far } = sensorSwathEdges(
          [x, pos[k * 3 + 1] ?? 0, pos[k * 3 + 2] ?? 0],
          [vx, vy, vz],
          optFor(families?.[k]),
        );
        const seg = near.length / 3;
        const cr = colors?.[k * 4] ?? 0.6;
        const cg = colors?.[k * 4 + 1] ?? 0.85;
        const cb = colors?.[k * 4 + 2] ?? 1.0;
        for (let j = 0; j < seg - 1; j += 1) {
          tri(near, j, cr, cg, cb);
          tri(far, j, cr, cg, cb);
          tri(near, j + 1, cr, cg, cb);
          tri(far, j, cr, cg, cb);
          tri(far, j + 1, cr, cg, cb);
          tri(near, j + 1, cr, cg, cb);
          out(near, j, near, j + 1, cr, cg, cb);
          out(far, j, far, j + 1, cr, cg, cb);
        }
        out(near, 0, far, 0, cr, cg, cb);
        out(near, seg - 1, far, seg - 1, cr, cg, cb);
      }
      return { tris: ft / 3, segs: fs };
    };

    // COVERAGE = age-of-collection ("did see, how recently"), NOT access ("could
    // see"). A revisit grid records when each cell was last stamped by a footprint;
    // the age over a rolling window renders as a filled viridis field draped on the
    // globe and the 2D map (one texture, both views). Highlights where the fleet is
    // going stale -- the operator's real question -- not a vanity hit-count rainbow.
    const COV_LAT = 120;
    const COV_LON = 240;
    const COV_WINDOW_MIN = 360; // age ramp saturates at 6 h since last look
    const revisit = new RevisitGrid(COV_LAT, COV_LON);
    const ageBuf = new Uint8Array(COV_LAT * COV_LON);
    const coverageBox = document.getElementById("coverage") as HTMLInputElement;
    const covLegend = document.getElementById("covLegend") as HTMLElement;
    coverageBox.addEventListener("change", () => {
      if (coverageBox.checked) revisit.reset();
      covLegend.style.display = coverageBox.checked ? "block" : "none";
    });
    const coverageSphere = new CoverageOverlay(device, {
      mode: "sphere",
      gridW: COV_LON,
      gridH: COV_LAT,
      format,
      depthFormat,
      alpha: 0.55,
      steps: 6,
    });
    const coveragePlane = new CoverageOverlay(device, {
      mode: "plane",
      gridW: COV_LON,
      gridH: COV_LAT,
      format,
      alpha: 0.62,
      steps: 6,
    });

    // COLLECTS: real tasked imaging activities (from csched, via mission.collects.json).
    // A collect is what a "footprint" actually is -- a planned ground box shown ahead
    // of time, a spacecraft->target beam while it's collecting, and a coverage stamp
    // once it completes. Data is fetched async; renders only when present.
    const collectsBox = document.getElementById("collects") as HTMLInputElement;
    const COLLECT_RING_SEG = 20;
    const COLLECT_CAP = 128; // max collects drawn at once (state-windowed below)
    const COVERAGE_STAMP_KM = 90; // coverage cell radius a completed collect lights up
    const COLLECT_CAP_RAD = COVERAGE_STAMP_KM / 6371.0088;
    const collectFill = new TriRenderer(device, {
      capacity: COLLECT_CAP * COLLECT_RING_SEG * 3,
      format,
      depthFormat,
    });
    const collectLines = new LineRenderer(device, {
      capacity: COLLECT_CAP * (COLLECT_RING_SEG + 1) * 2,
      format,
      depthFormat,
    });
    const cTriPos = new Float32Array(COLLECT_CAP * COLLECT_RING_SEG * 3 * 3);
    const cTriCol = new Float32Array(COLLECT_CAP * COLLECT_RING_SEG * 3 * 4);
    const cSegPos = new Float32Array(COLLECT_CAP * (COLLECT_RING_SEG + 1) * 2 * 3);
    const cSegCol = new Float32Array(COLLECT_CAP * (COLLECT_RING_SEG + 1) * 2 * 4);
    let collects: Collect[] = [];
    let collectRings: Float32Array[] = []; // ECEF ground ring per collect
    let collectCenters: [number, number, number][] = []; // ECEF target per collect
    let collectSatIdx: number[] = []; // owning object index per collect (-1 if unknown)
    void (async () => {
      try {
        const resp = await fetch("./mission.collects.json");
        if (!resp.ok) return;
        collects = parseCollects(await resp.json(), clock.epochMs);
        const idxByName = new Map<string, number>();
        source.names?.forEach((n, i) => idxByName.set(n.split("/").pop() ?? n, i));
        collectRings = collects.map((c) =>
          collectFootprintCorners(c.targetLatDeg, c.targetLonDeg, c.sensor, c.lookAngleDeg, 5),
        );
        collectCenters = collects.map((c) => collectTargetEcef(c.targetLatDeg, c.targetLonDeg, 5));
        collectSatIdx = collects.map((c) => idxByName.get(c.sat) ?? -1);
        collectsBox.disabled = false;
      } catch {
        /* no collects for this source */
      }
    })();
    // COVERAGE is now driven by collects: rebuild the revisit grid from completed
    // collects (stamp at each target's completion time). "Did see" = actually collected.
    const stampCollects = (nowSec: number): void => {
      revisit.reset();
      for (const c of collects) {
        if (c.endSec <= nowSec) revisit.stamp(c.targetLatDeg, c.targetLonDeg, COLLECT_CAP_RAD, c.endSec / 60);
      }
    };

    // V9 2D equirectangular map: the same clock + data on a flat lon/lat plane.
    // Plane coords: x = lon/90 in [-2,2], y = lat/90 in [-1,1]. No depth (flat).
    const map2dBox = document.getElementById("map2d") as HTMLInputElement;
    const mapPts = new PointRenderer(device, { capacity: source.count, format, pointSizePx: 4 });
    const mapGrat = new LineRenderer(device, { capacity: 4096, format });
    const mapTracks = new LineRenderer(device, { capacity: source.count * TRACK_SAMPLES * 2, format });
    const mapPos = new Float32Array(source.count * 3);
    const mapTrkPos = new Float32Array(source.count * TRACK_SAMPLES * 2 * 3);
    const mapTrkCol = new Float32Array(source.count * TRACK_SAMPLES * 2 * 4);
    // static graticule (30deg grid + border)
    {
      const seg: number[] = [];
      const col: number[] = [];
      const push = (x0: number, y0: number, x1: number, y1: number, a: number): void => {
        seg.push(x0, y0, 0, x1, y1, 0);
        col.push(0.22, 0.38, 0.55, a, 0.22, 0.38, 0.55, a);
      };
      for (let lon = -180; lon <= 180; lon += 30) push(lon / 90, -1, lon / 90, 1, lon === 0 ? 0.7 : 0.4);
      for (let lat = -90; lat <= 90; lat += 30) push(-2, lat / 90, 2, lat / 90, lat === 0 ? 0.7 : 0.4);
      mapGrat.setSegments(new Float32Array(seg), new Float32Array(col), seg.length / 6);
    }
    const orthoViewProj = (): Float32Array => {
      const a = canvas.width / canvas.height;
      const sy = Math.min(0.95, 0.475 * a);
      const sx = sy / a;
      const m = new Float32Array(16);
      m[0] = sx;
      m[5] = sy;
      m[15] = 1;
      return m;
    };
    const draw2D = (): void => {
      const vp = orthoViewProj();
      const eye0: [number, number, number] = [0, 0, 0];
      // fleet sub-satellite dots
      const theta = gmst(clock.currentUnixMs());
      const cc = Math.cos(theta);
      const ss = Math.sin(theta);
      let n = 0;
      if (latestPositions) {
        for (let k = 0; k < source.count; k += 1) {
          const x = latestPositions[k * 3] ?? Number.NaN;
          const y = latestPositions[k * 3 + 1] ?? Number.NaN;
          const z = latestPositions[k * 3 + 2] ?? Number.NaN;
          if (!Number.isFinite(x)) {
            mapPos[k * 3] = 1e12;
            mapPos[k * 3 + 1] = 1e12;
            mapPos[k * 3 + 2] = 1e12;
            continue;
          }
          const g = ecefToGeodetic(cc * x + ss * y, -ss * x + cc * y, z);
          mapPos[k * 3] = g.lonDeg / 90;
          mapPos[k * 3 + 1] = g.latDeg / 90;
          mapPos[k * 3 + 2] = 0;
          n = k + 1;
        }
      }
      mapPts.updatePositions(mapPos, source.count);
      if (colors) mapPts.setColors(colors);
      mapPts.updateCamera(vp, eye0, canvas.width, canvas.height);
      mapGrat.updateCamera(vp, eye0);
      if (stationsOn) mapStationPts.updateCamera(vp, eye0, canvas.width, canvas.height);
      // ground tracks: reproject the ECEF orbit window to sub-satellite lon/lat
      // polylines, splitting each trace at the antimeridian so it doesn't smear
      // a horizontal streak across the map.
      let tv = 0;
      if (trackMode() !== "none" && winRaw && winIsEcef && winSamples > 1) {
        const w = winRaw;
        const nowMin = clock.currentSeconds / 60;
        for (let k = 0; k < source.count; k += 1) {
          if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue; // family filtered off
          const cr = colors?.[k * 4] ?? 0.6;
          const cg = colors?.[k * 4 + 1] ?? 0.8;
          const cb = colors?.[k * 4 + 2] ?? 1;
          // past/future boundary: which sample corresponds to "now" (same convention
          // as the 3D tracks -- frac in [-1,1] over +/-1 period around the window centre)
          const period = winPeriods?.[k] ?? 90;
          const fracNow = (nowMin - lastWindowCenterMin) / (period || 90);
          const base = k * winSamples * 3;
          let plon = Number.NaN;
          let plat = Number.NaN;
          let pok = false;
          for (let s = 0; s < winSamples; s += 1) {
            const b = base + s * 3;
            const x = w[b] ?? Number.NaN;
            let lon = Number.NaN;
            let lat = Number.NaN;
            let ok = false;
            if (Number.isFinite(x)) {
              const g = ecefToGeodetic(x, w[b + 1] ?? 0, w[b + 2] ?? 0);
              lon = g.lonDeg;
              lat = g.latDeg;
              ok = true;
            }
            if (pok && ok && Math.abs(lon - plon) < 180) {
              // segment [s-1, s]: past = full luminance, next rev = dimmed (CVD-safe,
              // no alpha/dash tricks -- luminance carries past vs future)
              const fracSeg = ((s - 0.5) / (winSamples - 1)) * 2 - 1;
              const lum = fracSeg <= fracNow ? 1 : 0.4;
              mapTrkPos[tv * 3] = plon / 90;
              mapTrkPos[tv * 3 + 1] = plat / 90;
              mapTrkCol[tv * 4] = cr * lum;
              mapTrkCol[tv * 4 + 1] = cg * lum;
              mapTrkCol[tv * 4 + 2] = cb * lum;
              mapTrkCol[tv * 4 + 3] = 0.85;
              tv += 1;
              mapTrkPos[tv * 3] = lon / 90;
              mapTrkPos[tv * 3 + 1] = lat / 90;
              mapTrkCol[tv * 4] = cr * lum;
              mapTrkCol[tv * 4 + 1] = cg * lum;
              mapTrkCol[tv * 4 + 2] = cb * lum;
              mapTrkCol[tv * 4 + 3] = 0.85;
              tv += 1;
            }
            plon = lon;
            plat = lat;
            pok = ok;
          }
        }
        mapTracks.setSegments(mapTrkPos.subarray(0, tv * 3), mapTrkCol.subarray(0, tv * 4), tv / 2);
        mapTracks.updateCamera(vp, eye0);
      }
      if (coverageBox.checked) {
        stampCollects(clock.currentSeconds); // coverage = completed collects
        revisit.ageTexture(clock.currentSeconds / 60, COV_WINDOW_MIN, ageBuf);
        coveragePlane.setField(ageBuf);
        coveragePlane.updateCamera(vp, eye0, 0);
      }
      void n;
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.02, g: 0.03, b: 0.06, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });
      if (coverageBox.checked) coveragePlane.draw(pass); // filled field, beneath all
      mapGrat.draw(pass);
      if (tv > 0) mapTracks.draw(pass);
      if (stationsOn) mapStationPts.draw(pass);
      mapPts.draw(pass);
      pass.end();
      device.queue.submit([enc.finish()]);
    };

    // V8 labels: declutter-aware DOM name tags. dv.gl decides which fit
    // (declutterLabels); the app owns the text/style. Gated to fleet-scale sets.
    const labelsBox = document.getElementById("labels") as HTMLInputElement;
    const labelsLayer = document.getElementById("labelLayer") as HTMLElement;
    const labelsCanAfford = source.names !== undefined && source.count <= 200;
    if (!labelsCanAfford) labelsBox.disabled = true;
    const labelEls: HTMLSpanElement[] = [];
    if (labelsCanAfford) {
      for (let k = 0; k < source.count; k += 1) {
        const el = document.createElement("span");
        el.className = "objLabel";
        el.textContent = source.names?.[k] ?? `#${k}`;
        el.style.display = "none";
        labelsLayer.appendChild(el);
        labelEls.push(el);
      }
    }
    source.onResult = (positions, minutes, failed) => {
      latestPositions = positions;
      if (renderer === undefined) {
        renderer = new PointRenderer(device, {
          capacity: source.count,
          format,
          depthFormat,
          pickFormat,
        });
        if (colors) renderer.setColors(colors);
      }
      renderer.updatePositions(positions, source.count);
      // V1: per-object velocity DIRECTION from a finite difference between epochs
      // (inertial, matches the point dots; persists when paused so the marker
      // still shows which way is forward in a still/greyscale frame).
      if (Number.isFinite(prevMin) && minutes !== prevMin) {
        for (let k = 0; k < source.count; k += 1) {
          const dx = (positions[k * 3] ?? 0) - (prevPositions[k * 3] ?? 0);
          const dy = (positions[k * 3 + 1] ?? 0) - (prevPositions[k * 3 + 1] ?? 0);
          const dz = (positions[k * 3 + 2] ?? 0) - (prevPositions[k * 3 + 2] ?? 0);
          const l = Math.hypot(dx, dy, dz) || 1;
          dirVec[k * 3] = dx / l;
          dirVec[k * 3 + 1] = dy / l;
          dirVec[k * 3 + 2] = dz / l;
        }
      }
      prevPositions.set(positions.subarray(0, source.count * 3));
      prevMin = minutes;
      const d = Math.floor(minutes / 1440);
      const h = Math.floor((minutes % 1440) / 60);
      const m = Math.floor(minutes % 60);
      if (clockEl) {
        clockEl.textContent =
          `T+${d}d ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} ` +
          `-- ${source.count - failed}/${source.count} objects [${mode}${multiplier > 1 ? ` x${multiplier}` : ""}]`;
      }
    };

    // mouse orbit + wheel zoom
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      // request a pick under the cursor (device pixels) every move
      pickX = Math.round(e.offsetX * devicePixelRatio);
      pickY = Math.round(e.offsetY * devicePixelRatio);
      pickPending = true;
      if (!dragging) return;
      view.lonDeg -= (e.clientX - lastX) * 0.25;
      view.latDeg = Math.max(-89, Math.min(89, view.latDeg + (e.clientY - lastY) * 0.25));
      lastX = e.clientX;
      lastY = e.clientY;
    });
    canvas.addEventListener("pointerleave", () => {
      pickPending = false;
      setHover(-1);
    });
    // Hover identify: white-boost the point under the cursor and show its name.
    // (Field of regard is driven by the family filter, not per-sat selection.)
    const nameOf = (i: number): string => source.names?.[i] ?? `object ${i}`;
    const refreshHighlights = (): void => {
      if (colors) {
        const c = new Float32Array(colors);
        if (hoveredIndex >= 0) c.set([1, 1, 1, colors[hoveredIndex * 4 + 3] ?? 1], hoveredIndex * 4);
        renderer?.setColors(c);
      }
      if (hoveredIndex >= 0) {
        pickEl.style.display = "block";
        pickEl.textContent = nameOf(hoveredIndex);
      } else {
        pickEl.style.display = "none";
      }
    };
    afterColors = refreshHighlights;
    const setHover = (idx: number): void => {
      if (idx === hoveredIndex) return;
      hoveredIndex = idx;
      refreshHighlights();
    };
    canvas.addEventListener("pointerup", () => {
      dragging = false;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        view.rangeKm = Math.max(6_800, Math.min(300_000, view.rangeKm * (1 + e.deltaY * 0.001)));
      },
      { passive: false },
    );

    // timeline controls, all delegated to the MissionClock
    const slider = document.getElementById("time") as HTMLInputElement;
    const playBtn = document.getElementById("play") as HTMLButtonElement;
    const speedSel = document.getElementById("speed") as HTMLSelectElement;
    slider.addEventListener("input", () => {
      clock.scrubTo(Number(slider.value) * 60);
      clock.pause();
      playBtn.textContent = "play";
      lastWindowCenterMin = Number.NEGATIVE_INFINITY; // tracks recompute at the new time
      revisit.reset(); // a coverage field that ignored the scrub would silently lie
      dirty = true;
    });
    playBtn.addEventListener("click", () => {
      if (clock.playing) clock.pause();
      else clock.play();
      playBtn.textContent = clock.playing ? "pause" : "play";
    });
    speedSel.addEventListener("change", () => {
      clock.rate = Number(speedSel.value);
    });

    // V6 event marks: a @dvgl/core TimelineMarks the app fills with meaning. Here
    // we seed deterministic synthetic events; dv.gl provides the time-indexing,
    // the ticks, and jump-to-event ('.'/',').
    const CATS: Record<string, string> = {
      collect: "#6ab7ff",
      contact: "#7fe0a0",
      eclipse: "#c9a0ff",
      maneuver: "#ff9e6b",
    };
    const catList = Object.keys(CATS);
    const events = Array.from({ length: 14 }, (_, i) => ({
      timeSec: ((i * 7 + 3) % 20) * (windowSeconds / 20) + windowSeconds / 40,
      category: catList[i % catList.length] ?? "collect",
    }));
    const marks = new TimelineMarks(events);
    const marksEl = document.getElementById("timeMarks") as HTMLElement;
    const layoutMarks = (): void => {
      const r = slider.getBoundingClientRect();
      marksEl.style.left = `${r.left}px`;
      marksEl.style.width = `${r.width}px`;
      marksEl.style.bottom = `${window.innerHeight - r.top + 3}px`;
      marksEl.innerHTML = "";
      for (const m of marks.marks) {
        const tick = document.createElement("span");
        tick.className = "tick";
        tick.style.left = `${(m.timeSec / windowSeconds) * 100}%`;
        tick.style.background = CATS[m.category] ?? "#8ab";
        tick.title = m.category;
        marksEl.appendChild(tick);
      }
    };
    layoutMarks();
    window.addEventListener("resize", layoutMarks);
    // jump to next/prev event
    window.addEventListener("keydown", (e) => {
      const t = clock.currentSeconds;
      const target = e.key === "." ? marks.next(t) : e.key === "," ? marks.prev(t) : undefined;
      if (target) {
        clock.scrubTo(target.timeSec);
        clock.pause();
        playBtn.textContent = "play";
        slider.value = String(Math.floor(target.timeSec / 60));
        invalidateWindow();
        revisit.reset();
        dirty = true;
      }
    });

    const ecefBox = document.getElementById("ecef") as HTMLInputElement;
    const trackModeSel = document.getElementById("trackmode") as HTMLSelectElement;
    const trackMode = (): "none" | "orbit" | "ground" =>
      trackModeSel.value as "none" | "orbit" | "ground";
    // ground tracks are inherently earth-fixed; orbit tracks follow the camera
    // frame; the 2D map always needs ECEF samples to draw sub-satellite traces
    const trackEcef = (): boolean =>
      trackMode() === "ground" || ecefBox.checked || map2dBox.checked;
    if (!tracksAffordable) {
      trackModeSel.disabled = true;
      (trackModeSel.parentElement as HTMLElement).title =
        "tracks need a window-capable source and <=512 objects";
    }
    const invalidateWindow = (): void => {
      lastWindowCenterMin = Number.NEGATIVE_INFINITY;
    };
    trackModeSel.addEventListener("change", () => {
      if (trackMode() === "none") tracks?.clear();
      invalidateWindow();
    });
    ecefBox.addEventListener("change", invalidateWindow);
    map2dBox.addEventListener("change", invalidateWindow); // reframe window to ECEF
    // ground mode replaces each window sample with its sub-satellite surface point
    const surfaceScratch = new Float32Array(source.count * TRACK_SAMPLES * 3);
    source.onWindow = (windowKm, centerMinutes, samples, periodsMinutes) => {
      if (tracks === undefined) {
        tracks = new OrbitTrackRenderer(device, {
          capacity: source.count,
          samples,
          format,
          depthFormat,
        });
        if (colors) tracks.setColors(colors);
      }
      let buf = windowKm;
      if (trackMode() === "ground") {
        const n = source.count * samples * 3;
        for (let k = 0; k < n; k += 3) {
          const s = ecefToSurface(
            windowKm[k] ?? Number.NaN,
            windowKm[k + 1] ?? Number.NaN,
            windowKm[k + 2] ?? Number.NaN,
            8, // km lift above the ellipsoid
          );
          surfaceScratch[k] = s[0];
          surfaceScratch[k + 1] = s[1];
          surfaceScratch[k + 2] = s[2];
        }
        buf = surfaceScratch;
      }
      tracks.setWindow(buf, source.count, periodsMinutes);
      winRaw = windowKm; // raw (un-surfaced) samples for the 2D ground-track reprojection
      winSamples = samples;
      winIsEcef = trackEcef();
      winPeriods = periodsMinutes;
      lastWindowCenterMin = centerMinutes; // the split offset is measured from HERE
    };

    // ---- ground stations + live access lines (V4) ----
    const STATIONS = [
      { name: "SVALBARD", latDeg: 78.23, lonDeg: 15.4, minElevationDeg: 5 },
      { name: "FAIRBANKS", latDeg: 64.8, lonDeg: -147.7, minElevationDeg: 5 },
      { name: "PUNTA ARENAS", latDeg: -53.0, lonDeg: -70.9, minElevationDeg: 5 },
      { name: "SINGAPORE", latDeg: 1.35, lonDeg: 103.8, minElevationDeg: 5 },
    ];
    const stEcef = STATIONS.map((s) => stationEcef(s));
    const stMask = STATIONS.map((s) => s.minElevationDeg ?? 5);
    const stationPts = new PointRenderer(device, {
      capacity: STATIONS.length,
      format,
      depthFormat,
      pointSizePx: 7,
    });
    stationPts.setColors(
      new Float32Array(STATIONS.flatMap(() => [0.7, 1.0, 0.7, 1.0])), // station green
    );
    const stationWorld = new Float32Array(STATIONS.length * 3);
    const accessLines = new LineRenderer(device, {
      capacity: STATIONS.length * source.count * 2,
      format,
      depthFormat,
    });
    const segPos = new Float32Array(STATIONS.length * source.count * 2 * 3);
    const segCol = new Float32Array(STATIONS.length * source.count * 2 * 4);
    // stations are mission objects: their visibility toggle lives in the objects
    // panel (right), not the layers dock. A green row toggles the whole network.
    let stationsOn = false;
    {
      const body = document.getElementById("objectsBody");
      if (body) {
        const row = document.createElement("div");
        row.className = "objRow off";
        row.innerHTML =
          `<span class="objSwatch" style="background:rgb(179,255,179)"></span>` +
          `<span class="objName">GROUND STATIONS</span><span class="objCount">${STATIONS.length}</span>`;
        row.addEventListener("click", () => {
          stationsOn = !stationsOn;
          row.classList.toggle("off", !stationsOn);
        });
        body.appendChild(row);
        (document.getElementById("objects") as HTMLElement).style.display = "block";
      }
    }
    // 2D map station markers (green dots at each station's lon/lat)
    const mapStationPts = new PointRenderer(device, {
      capacity: STATIONS.length,
      format,
      pointSizePx: 7,
    });
    mapStationPts.setColors(new Float32Array(STATIONS.flatMap(() => [0.7, 1.0, 0.7, 1.0])));
    const mapStationPos = new Float32Array(STATIONS.length * 3);
    for (let i = 0; i < STATIONS.length; i += 1) {
      mapStationPos[i * 3] = (STATIONS[i]?.lonDeg ?? 0) / 90;
      mapStationPos[i * 3 + 1] = (STATIONS[i]?.latDeg ?? 0) / 90;
      mapStationPos[i * 3 + 2] = 0;
    }
    mapStationPts.updatePositions(mapStationPos, STATIONS.length);

    let lastT = performance.now();
    const tick = (): void => {
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      lastT = now;

      if (clock.playing) {
        clock.advance(dt);
        slider.value = String(Math.floor(clock.currentSeconds / 60));
        dirty = true;
      }
      if (dirty) {
        source.request(clock.currentSeconds / 60);
        dirty = false;
      }
      // sliding +/-1-orbit window: recompute when scene time drifts ~1/8 of a
      // LEO period from the last window center (or after a scrub reset)
      if (trackMode() !== "none" && tracksAffordable) {
        const centerMin = clock.currentSeconds / 60;
        if (Math.abs(centerMin - lastWindowCenterMin) > 12) {
          lastWindowCenterMin = centerMin;
          // ECEF window (per-sample GMST) gives the weave / the ground track
          source.requestWindow?.(centerMin, TRACK_SAMPLES, trackEcef() ? clock.epochMs : undefined);
        }
      }

      // V9: flat equirectangular map replaces the 3D scene entirely
      if (map2dBox.checked) {
        for (const el of labelEls) el.style.display = "none";
        draw2D();
        requestAnimationFrame(tick);
        return;
      }

      // earth-fixed: co-rotate the camera with Earth so ECEF geometry (GEO belt,
      // ground tracks) holds still while inertial orbits sweep past. The globe
      // itself always spins at GMST, so it appears stationary in that mode.
      const gmstRad = gmst(clock.currentUnixMs());
      const gmstDeg = ecefBox.checked ? (gmstRad * 180) / Math.PI : 0;
      const eye = eyeFrom({ ...view, lonDeg: view.lonDeg + gmstDeg });
      const proj = perspective((50 * Math.PI) / 180, canvas.width / canvas.height, 10, 500_000);
      const viewProjRte = mul(proj, lookAtRte(eye));
      earth.updateCamera(viewProjRte, eye, gmstRad);
      renderer?.updateCamera(viewProjRte, eye, canvas.width, canvas.height);
      if (trackMode() !== "none")
        tracks?.updateCamera(
          viewProjRte,
          eye,
          trackEcef() ? gmstRad : 0, // ECEF data spins with the globe
          clock.currentSeconds / 60 - lastWindowCenterMin, // continuous now-split
        );

      // stations + access lines: place stations in the inertial world (Rz(+gmst))
      // and draw a line to each satellite currently above that station's mask.
      if (stationsOn) {
        const cg = Math.cos(gmstRad);
        const sg = Math.sin(gmstRad);
        for (let i = 0; i < STATIONS.length; i += 1) {
          const e = stEcef[i]?.ecef ?? [0, 0, 0];
          stationWorld[i * 3] = cg * e[0] - sg * e[1];
          stationWorld[i * 3 + 1] = sg * e[0] + cg * e[1];
          stationWorld[i * 3 + 2] = e[2];
        }
        stationPts.updatePositions(stationWorld, STATIONS.length);
        stationPts.updateCamera(viewProjRte, eye, canvas.width, canvas.height);
        let seg = 0;
        if (latestPositions) {
          for (let i = 0; i < STATIONS.length; i += 1) {
            const st = stEcef[i];
            if (st === undefined) continue;
            for (let k = 0; k < source.count; k += 1) {
              if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue; // filtered out
              const x = latestPositions[k * 3] ?? Number.NaN;
              const y = latestPositions[k * 3 + 1] ?? Number.NaN;
              const z = latestPositions[k * 3 + 2] ?? Number.NaN;
              if (!Number.isFinite(x)) continue;
              const satEcef: [number, number, number] = [cg * x + sg * y, -sg * x + cg * y, z];
              if (elevationDeg(st, satEcef) < (stMask[i] ?? 5)) continue;
              const p = seg * 6;
              segPos[p] = stationWorld[i * 3] ?? 0;
              segPos[p + 1] = stationWorld[i * 3 + 1] ?? 0;
              segPos[p + 2] = stationWorld[i * 3 + 2] ?? 0;
              segPos[p + 3] = x;
              segPos[p + 4] = y;
              segPos[p + 5] = z;
              const c = seg * 8;
              const cr = colors?.[k * 4] ?? 0.6;
              const cgc = colors?.[k * 4 + 1] ?? 0.85;
              const cb = colors?.[k * 4 + 2] ?? 1.0;
              segCol.set([cr, cgc, cb, 0.8, cr, cgc, cb, 0.8], c);
              seg += 1;
            }
          }
        }
        accessLines.setSegments(segPos, segCol, seg);
        accessLines.updateCamera(viewProjRte, eye);
      }

      // V1: direction leaders -- a short along-track velocity stub at each object
      if (headingBox.checked && latestPositions) {
        let hs = 0;
        for (let k = 0; k < source.count; k += 1) {
          if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue;
          const x = latestPositions[k * 3] ?? Number.NaN;
          const y = latestPositions[k * 3 + 1] ?? Number.NaN;
          const z = latestPositions[k * 3 + 2] ?? Number.NaN;
          if (!Number.isFinite(x)) continue;
          const p = hs * 6;
          headSeg[p] = x;
          headSeg[p + 1] = y;
          headSeg[p + 2] = z;
          headSeg[p + 3] = x + (dirVec[k * 3] ?? 0) * LEADER_KM;
          headSeg[p + 4] = y + (dirVec[k * 3 + 1] ?? 0) * LEADER_KM;
          headSeg[p + 5] = z + (dirVec[k * 3 + 2] ?? 0) * LEADER_KM;
          headCol.set([1, 1, 1, 0.9, 1, 1, 1, 0.9], hs * 8); // bright white leader
          hs += 1;
        }
        headingLines.setSegments(headSeg, headCol, hs);
        headingLines.updateCamera(viewProjRte, eye);
      }

      // FIELD OF REGARD envelope: the wide, faint band each sensor could steer to.
      // Drawn for every visible satellite (narrow it via the family filter in the
      // objects panel), under the footprint so "could see" sits beneath "pointed".
      if (accessBox.checked) {
        const inc = (k: number): boolean => !(colors && (colors[k * 4 + 3] ?? 1) === 0);
        const r = buildSwaths(inc, accessFor, accessTriPos, accessTriCol, acSeg, acCol, 0.13, 0.55);
        accessFill.setTriangles(accessTriPos, accessTriCol, r.tris);
        accessFill.updateCamera(viewProjRte, eye);
        accessLineR.setSegments(acSeg, acCol, r.segs);
        accessLineR.updateCamera(viewProjRte, eye);
      } else {
        accessFill.clear();
        accessLineR.clear();
      }

      // COLLECTS: planned ground boxes (blue outline), the ACTIVE collect (amber
      // box + a spacecraft->target beam), and just-completed ones (green). ECEF
      // rings/targets rotate into the world by GMST like the earth-fixed geometry.
      if (collectsBox.checked && collects.length > 0) {
        const nowSec = clock.currentSeconds;
        const cgm = Math.cos(gmstRad);
        const sgm = Math.sin(gmstRad);
        let ft = 0; // fill vertices
        let sv = 0; // outline/beam segments
        let shown = 0;
        for (let ci = 0; ci < collects.length && shown < COLLECT_CAP; ci += 1) {
          const c = collects[ci];
          if (c === undefined) continue;
          const st = collectState(c, nowSec, 3600, 900); // 60 min planned lead, 15 min trail
          if (st === "idle") continue;
          shown += 1;
          const ring = collectRings[ci];
          const ctr = collectCenters[ci];
          if (!ring || !ctr) continue;
          // state -> colour + fill/line alpha
          let cr = 0.7;
          let cg = 0.8;
          let cb = 1.0;
          let fillA = 0;
          let lineA = 0.55;
          if (st === "active") {
            cr = 1;
            cg = 0.85;
            cb = 0.35;
            fillA = 0.32;
            lineA = 0.95;
          } else if (st === "recent") {
            cr = 0.55;
            cg = 0.9;
            cb = 0.6;
            fillA = 0.14;
          }
          const cx = cgm * ctr[0] - sgm * ctr[1];
          const cy = sgm * ctr[0] + cgm * ctr[1];
          const cz = ctr[2];
          const seg = ring.length / 3;
          // rotate ring into world once
          const wr = new Float32Array(seg * 3);
          for (let j = 0; j < seg; j += 1) {
            const x = ring[j * 3] ?? 0;
            const y = ring[j * 3 + 1] ?? 0;
            wr[j * 3] = cgm * x - sgm * y;
            wr[j * 3 + 1] = sgm * x + cgm * y;
            wr[j * 3 + 2] = ring[j * 3 + 2] ?? 0;
          }
          for (let j = 0; j < seg; j += 1) {
            const k = (j + 1) % seg;
            // outline edge
            const p = sv * 6;
            cSegPos[p] = wr[j * 3] ?? 0;
            cSegPos[p + 1] = wr[j * 3 + 1] ?? 0;
            cSegPos[p + 2] = wr[j * 3 + 2] ?? 0;
            cSegPos[p + 3] = wr[k * 3] ?? 0;
            cSegPos[p + 4] = wr[k * 3 + 1] ?? 0;
            cSegPos[p + 5] = wr[k * 3 + 2] ?? 0;
            cSegCol.set([cr, cg, cb, lineA, cr, cg, cb, lineA], sv * 8);
            sv += 1;
            // fill triangle (centre, j, k)
            if (fillA > 0) {
              const t = ft * 3;
              cTriPos[t] = cx;
              cTriPos[t + 1] = cy;
              cTriPos[t + 2] = cz;
              cTriPos[t + 3] = wr[j * 3] ?? 0;
              cTriPos[t + 4] = wr[j * 3 + 1] ?? 0;
              cTriPos[t + 5] = wr[j * 3 + 2] ?? 0;
              cTriPos[t + 6] = wr[k * 3] ?? 0;
              cTriPos[t + 7] = wr[k * 3 + 1] ?? 0;
              cTriPos[t + 8] = wr[k * 3 + 2] ?? 0;
              cTriCol.set([cr, cg, cb, fillA], ft * 4);
              cTriCol.set([cr, cg, cb, fillA], (ft + 1) * 4);
              cTriCol.set([cr, cg, cb, fillA], (ft + 2) * 4);
              ft += 3;
            }
          }
          // beam from the collecting spacecraft down to the target
          const satIdx = collectSatIdx[ci] ?? -1;
          if (st === "active" && satIdx >= 0 && latestPositions) {
            const sx = latestPositions[satIdx * 3];
            const sy = latestPositions[satIdx * 3 + 1];
            const sz = latestPositions[satIdx * 3 + 2];
            if (Number.isFinite(sx)) {
              const p = sv * 6;
              cSegPos[p] = sx ?? 0;
              cSegPos[p + 1] = sy ?? 0;
              cSegPos[p + 2] = sz ?? 0;
              cSegPos[p + 3] = cx;
              cSegPos[p + 4] = cy;
              cSegPos[p + 5] = cz;
              cSegCol.set([1, 0.85, 0.35, 0.9, 1, 0.85, 0.35, 0.9], sv * 8);
              sv += 1;
            }
          }
        }
        collectFill.setTriangles(cTriPos, cTriCol, ft / 3);
        collectFill.updateCamera(viewProjRte, eye);
        collectLines.setSegments(cSegPos, cSegCol, sv);
        collectLines.updateCamera(viewProjRte, eye);
      } else {
        collectFill.clear();
        collectLines.clear();
      }

      // COVERAGE: age-of-collection field draped on the globe (viridis, GMST-spun
      // so it sits earth-fixed like the footprints that wrote it)
      if (coverageBox.checked) {
        stampCollects(clock.currentSeconds); // coverage = completed collects
        revisit.ageTexture(clock.currentSeconds / 60, COV_WINDOW_MIN, ageBuf);
        coverageSphere.setField(ageBuf);
        coverageSphere.updateCamera(viewProjRte, eye, gmstRad);
      }

      // V8: project objects to screen, declutter, place DOM labels
      if (labelsBox.checked && labelsCanAfford && latestPositions) {
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        const R2 = 6371 * 6371;
        const cand: { k: number; sx: number; sy: number; box: LabelBox }[] = [];
        for (let k = 0; k < source.count; k += 1) {
          if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue;
          const px = latestPositions[k * 3] ?? Number.NaN;
          const py = latestPositions[k * 3 + 1] ?? Number.NaN;
          const pz = latestPositions[k * 3 + 2] ?? Number.NaN;
          if (!Number.isFinite(px)) continue;
          // far-side cull: hide labels for objects behind the globe limb
          if (px * eye[0] + py * eye[1] + pz * eye[2] < R2) continue;
          const rx = px - eye[0];
          const ry = py - eye[1];
          const rz = pz - eye[2];
          const cw = viewProjRte[3]! * rx + viewProjRte[7]! * ry + viewProjRte[11]! * rz + viewProjRte[15]!;
          if (cw <= 0) continue;
          const cx = viewProjRte[0]! * rx + viewProjRte[4]! * ry + viewProjRte[8]! * rz + viewProjRte[12]!;
          const cy = viewProjRte[1]! * rx + viewProjRte[5]! * ry + viewProjRte[9]! * rz + viewProjRte[13]!;
          const sx = ((cx / cw) * 0.5 + 0.5) * cssW;
          const sy = (1 - ((cy / cw) * 0.5 + 0.5)) * cssH;
          const name = source.names?.[k] ?? `#${k}`;
          cand.push({
            k,
            sx,
            sy,
            box: {
              x: sx + 6,
              y: sy - 7,
              w: name.length * 6.3 + 6,
              h: 14,
              priority: k === hoveredIndex ? 1000 : 1,
            },
          });
        }
        const vis = declutterLabels(cand.map((c) => c.box));
        const shownK = new Set<number>();
        cand.forEach((c, i) => {
          const el = labelEls[c.k];
          if (!el) return;
          if (vis[i]) {
            el.style.display = "block";
            el.style.left = `${c.sx + 6}px`;
            el.style.top = `${c.sy - 7}px`;
            shownK.add(c.k);
          }
        });
        for (let k = 0; k < labelEls.length; k += 1) {
          if (!shownK.has(k)) {
            const el = labelEls[k];
            if (el) el.style.display = "none";
          }
        }
      } else if (labelEls.length && !labelsBox.checked) {
        for (const el of labelEls) el.style.display = "none";
      }

      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.01, g: 0.01, b: 0.03, a: 1 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: depthTexture.createView(),
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });
      earth.draw(pass); // writes depth: satellites occlude behind the planet
      if (coverageBox.checked) coverageSphere.draw(pass); // filled age field on the surface
      if (trackMode() !== "none") tracks?.draw(pass); // under the points
      if (stationsOn) {
        accessLines.draw(pass);
        stationPts.draw(pass);
      }
      if (accessBox.checked) {
        accessFill.draw(pass); // field-of-regard envelope
        accessLineR.draw(pass);
      }
      if (collectsBox.checked) {
        collectFill.draw(pass); // collect boxes...
        collectLines.draw(pass); // ...outlines + active beam
      }
      if (headingBox.checked) headingLines.draw(pass);
      renderer?.draw(pass);
      pass.end();

      // id-pick pass: only when a pick is pending and no readback in flight
      if (pickPending && !pickMapping && renderer && pickX >= 0 && pickY >= 0 && pickX < canvas.width && pickY < canvas.height) {
        const idPass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: idTexture.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
          depthStencilAttachment: {
            view: idDepth.createView(),
            depthClearValue: 1,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          },
        });
        renderer.drawIds(idPass);
        idPass.end();
        encoder.copyTextureToBuffer(
          { texture: idTexture, origin: { x: pickX, y: pickY } },
          { buffer: pickReadback, bytesPerRow: 256 },
          { width: 1, height: 1 },
        );
        pickPending = false;
        pickMapping = true;
        device.queue.submit([encoder.finish()]);
        void pickReadback.mapAsync(GPUMapMode.READ).then(() => {
          const bytes = new Uint8Array(pickReadback.getMappedRange().slice(0, 4));
          pickReadback.unmap();
          pickMapping = false;
          setHover(decodePickedIndex(bytes));
        });
      } else {
        device.queue.submit([encoder.finish()]);
      }
      requestAnimationFrame(tick);
    };
    say("drag to orbit, wheel to zoom, slider to scrub");
    requestAnimationFrame(tick);
  } catch (err) {
    say(String(err));
    throw err;
  }
}

void main();
