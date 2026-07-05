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
import { PointRenderer } from "@dvgl/webgpu";
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

    say("loading catalog...");
    const { mode, multiplier } = readVariant();
    const catalog = await loadCatalogText();
    const source = await makeSource(mode, catalog.text, multiplier);
    let renderer: PointRenderer | undefined;

    const view: View = { lonDeg: -75, latDeg: 25, rangeKm: 45_000 };
    let sceneMinutes = 0;
    let playing = true;
    let speed = 60; // scene-seconds per wall-second
    let dirty = true;

    // async propagation: latest-wins coalescing lives in the source; the render
    // loop never blocks on evaluation, which is why scrubbing stays smooth
    const clockEl = document.getElementById("clock");
    source.onResult = (positions, minutes, failed) => {
      renderer ??= new PointRenderer(device, { capacity: source.count, format });
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

    // timeline controls
    const slider = document.getElementById("time") as HTMLInputElement;
    const playBtn = document.getElementById("play") as HTMLButtonElement;
    const speedSel = document.getElementById("speed") as HTMLSelectElement;
    slider.addEventListener("input", () => {
      sceneMinutes = Number(slider.value);
      playing = false;
      playBtn.textContent = "play";
      dirty = true;
    });
    playBtn.addEventListener("click", () => {
      playing = !playing;
      playBtn.textContent = playing ? "pause" : "play";
    });
    speedSel.addEventListener("change", () => {
      speed = Number(speedSel.value);
    });

    let lastT = performance.now();
    const tick = (): void => {
      const now = performance.now();
      const dt = (now - lastT) / 1000;
      lastT = now;

      if (playing) {
        sceneMinutes = (sceneMinutes + (dt * speed) / 60) % WINDOW_MINUTES;
        slider.value = String(Math.floor(sceneMinutes));
        dirty = true;
      }
      if (dirty) {
        source.request(sceneMinutes);
        dirty = false;
      }

      const eye = eyeFrom(view);
      const proj = perspective((50 * Math.PI) / 180, canvas.width / canvas.height, 10, 500_000);
      renderer?.updateCamera(mul(proj, lookAtRte(eye)), eye, canvas.width, canvas.height);

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
      });
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
