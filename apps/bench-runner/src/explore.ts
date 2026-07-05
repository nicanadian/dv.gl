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
import { MissionClock } from "@dvgl/core";
import { ecefToSurface, gmst } from "@dvgl/frames";
import {
  decodePickedIndex,
  EarthRenderer,
  LineRenderer,
  OrbitTrackRenderer,
  PointRenderer,
} from "@dvgl/webgpu";
import {
  catalogEpochMs,
  elevationDeg,
  footprintRing,
  parseCatalog,
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
    };
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

    // V5 sensor footprints: per-family nadir half-angle (app policy) -> ground ring
    const FP_SEGMENTS = 48;
    const halfAngleFor = (fam: string | undefined): number =>
      fam === "SAR" ? 25 : fam === "EO" ? 12 : 18;
    const perObjHalfAngle = families?.map(halfAngleFor);
    const footprintsBox = document.getElementById("footprints") as HTMLInputElement;
    const footprintLines = new LineRenderer(device, {
      capacity: source.count * FP_SEGMENTS * 2,
      format,
      depthFormat,
    });
    const fpSeg = new Float32Array(source.count * FP_SEGMENTS * 2 * 3);
    const fpCol = new Float32Array(source.count * FP_SEGMENTS * 2 * 4);
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
    // hovered object: white-boost the point + show its name (mechanism dv.gl
    // provides the id; naming/highlight policy lives here in the app)
    const setHover = (idx: number): void => {
      if (idx === hoveredIndex) return;
      hoveredIndex = idx;
      if (colors) {
        const boosted = new Float32Array(colors);
        if (idx >= 0) boosted.set([1, 1, 1, boosted[idx * 4 + 3] ?? 1], idx * 4);
        renderer?.setColors(boosted);
      }
      if (idx >= 0) {
        pickEl.style.display = "block";
        pickEl.textContent = source.names?.[idx] ?? `object ${idx}`;
      } else {
        pickEl.style.display = "none";
      }
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
    const ecefBox = document.getElementById("ecef") as HTMLInputElement;
    const trackModeSel = document.getElementById("trackmode") as HTMLSelectElement;
    const trackMode = (): "none" | "orbit" | "ground" =>
      trackModeSel.value as "none" | "orbit" | "ground";
    // ground tracks are inherently earth-fixed; orbit tracks follow the camera frame
    const trackEcef = (): boolean => trackMode() === "ground" || ecefBox.checked;
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
    const stationsBox = document.getElementById("stations") as HTMLInputElement;

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
      if (stationsBox.checked) {
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

      // V5: sensor footprint rings on the ground (frame-agnostic small circle)
      if (footprintsBox.checked && latestPositions) {
        let fs = 0;
        for (let k = 0; k < source.count; k += 1) {
          if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue;
          const x = latestPositions[k * 3] ?? Number.NaN;
          const y = latestPositions[k * 3 + 1] ?? Number.NaN;
          const z = latestPositions[k * 3 + 2] ?? Number.NaN;
          if (!Number.isFinite(x)) continue;
          const ring = footprintRing([x, y, z], perObjHalfAngle?.[k] ?? 18, FP_SEGMENTS, 6);
          const cr = colors?.[k * 4] ?? 0.6;
          const cgc = colors?.[k * 4 + 1] ?? 0.85;
          const cb = colors?.[k * 4 + 2] ?? 1.0;
          for (let i = 0; i < FP_SEGMENTS; i += 1) {
            const a = i * 3;
            const b = ((i + 1) % FP_SEGMENTS) * 3;
            const p = fs * 6;
            fpSeg[p] = ring[a] ?? 0;
            fpSeg[p + 1] = ring[a + 1] ?? 0;
            fpSeg[p + 2] = ring[a + 2] ?? 0;
            fpSeg[p + 3] = ring[b] ?? 0;
            fpSeg[p + 4] = ring[b + 1] ?? 0;
            fpSeg[p + 5] = ring[b + 2] ?? 0;
            fpCol.set([cr, cgc, cb, 0.4, cr, cgc, cb, 0.4], fs * 8);
            fs += 1;
          }
        }
        footprintLines.setSegments(fpSeg, fpCol, fs);
        footprintLines.updateCamera(viewProjRte, eye);
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
      if (trackMode() !== "none") tracks?.draw(pass); // under the points
      if (stationsBox.checked) {
        accessLines.draw(pass);
        stationPts.draw(pass);
      }
      if (footprintsBox.checked) footprintLines.draw(pass);
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
