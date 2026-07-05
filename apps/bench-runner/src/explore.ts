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
import { gmst } from "@dvgl/frames";
import { EarthRenderer, OrbitTrackRenderer, PointRenderer } from "@dvgl/webgpu";
import { catalogEpochMs, parseCatalog } from "@dvgl/orbits";
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
    source.onResult = (positions, minutes, failed) => {
      renderer ??= new PointRenderer(device, { capacity: source.count, format, depthFormat });
      renderer.updatePositions(positions, source.count);
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
      if (!dragging) return;
      view.lonDeg -= (e.clientX - lastX) * 0.25;
      view.latDeg = Math.max(-89, Math.min(89, view.latDeg + (e.clientY - lastY) * 0.25));
      lastX = e.clientX;
      lastY = e.clientY;
    });
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
    const tracksBox = document.getElementById("tracks") as HTMLInputElement;
    if (!tracksAffordable) {
      tracksBox.disabled = true;
      (tracksBox.parentElement as HTMLElement).title =
        "orbit tracks need a window-capable source and <=512 objects";
    }
    tracksBox.addEventListener("change", () => {
      if (!tracksBox.checked) tracks?.clear();
      lastWindowCenterMin = Number.NEGATIVE_INFINITY;
    });
    // switching frames changes what the track DATA means: recompute
    ecefBox.addEventListener("change", () => {
      lastWindowCenterMin = Number.NEGATIVE_INFINITY;
    });
    source.onWindow = (windowKm, centerMinutes, samples, periodsMinutes) => {
      tracks ??= new OrbitTrackRenderer(device, {
        capacity: source.count,
        samples,
        format,
        depthFormat,
      });
      tracks.setWindow(windowKm, source.count, periodsMinutes);
      lastWindowCenterMin = centerMinutes; // the split offset is measured from HERE
    };

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
      if (tracksBox.checked && tracksAffordable) {
        const centerMin = clock.currentSeconds / 60;
        if (Math.abs(centerMin - lastWindowCenterMin) > 12) {
          lastWindowCenterMin = centerMin;
          // earth-fixed: window computed in ECEF (per-sample GMST) -> the weave
          source.requestWindow?.(
            centerMin,
            TRACK_SAMPLES,
            ecefBox.checked ? clock.epochMs : undefined,
          );
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
      if (tracksBox.checked)
        tracks?.updateCamera(
          viewProjRte,
          eye,
          ecefBox.checked ? gmstRad : 0,
          clock.currentSeconds / 60 - lastWindowCenterMin, // continuous now-split
        );

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
      if (tracksBox.checked) tracks?.draw(pass); // under the points
      renderer?.draw(pass);
      pass.end();
      device.queue.submit([encoder.finish()]);
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
