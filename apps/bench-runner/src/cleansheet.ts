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
 * Path 2 (clean-sheet): the @dvgl/webgpu instanced point hot path in a minimal raw
 * WebGPU host (canvas + 60 lines of mat4; no framework). The Three.js-hosted
 * friction experiment is a separate, later variant -- see docs/friction-log.md.
 */
import { PointRenderer } from "@dvgl/webgpu";
import { publishResult, type RenderPath, runScenario } from "./runner.js";

// ---- minimal column-major mat4 (just enough for a look-at + perspective) ----

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

/** Look-at with the EYE AT THE ORIGIN (RTE): only the direction matters. */
function lookAtRte(eye: readonly [number, number, number]): Float32Array {
  // forward = normalize(-eye); world up = +Z (inertial pole)
  const len = Math.hypot(eye[0], eye[1], eye[2]);
  const fx = -eye[0] / len;
  const fy = -eye[1] / len;
  const fz = -eye[2] / len;
  // right = normalize(forward x up)
  let rx = fy * 1 - fz * 0;
  let ry = fz * 0 - fx * 1;
  let rz = fx * 0 - fy * 0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // trueUp = right x forward
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  // column-major view matrix with zero translation (eye at origin)
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

function eyeFromLonLat(rangeKm: number, lonDeg: number, latDeg: number): [number, number, number] {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  return [
    rangeKm * Math.cos(lat) * Math.cos(lon),
    rangeKm * Math.cos(lat) * Math.sin(lon),
    rangeKm * Math.sin(lat),
  ];
}

// ---- the path ----

async function makeCleanSheetPath(): Promise<RenderPath> {
  if (!navigator.gpu) {
    throw new Error("WebGPU unavailable in this browser/environment (check chrome://gpu)");
  }
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

  let renderer: PointRenderer | undefined;
  let eye: [number, number, number] = [45_000, 0, 0];

  return {
    name: "cleansheet-webgpu",
    primitive: "@dvgl/webgpu PointRenderer (instanced quads, RTE, 1 draw call)",
    updatePositions(positionsKm: Float32Array, count: number): void {
      // lazy: capacity comes from the actual workload (multiplier-aware)
      renderer ??= new PointRenderer(device, { capacity: count, format });
      renderer.updatePositions(positionsKm, count);
    },
    setCamera(cam): void {
      eye = eyeFromLonLat(cam.rangeKm, cam.lonDeg, cam.latDeg);
      const proj = perspective(
        (50 * Math.PI) / 180,
        canvas.width / canvas.height,
        10, // km
        500_000, // km
      );
      const viewProjRte = mul(proj, lookAtRte(eye));
      renderer?.updateCamera(viewProjRte, eye, canvas.width, canvas.height);
    },
    renderFrame(): void {
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
    },
  };
}

async function main(): Promise<void> {
  const status = document.getElementById("status");
  try {
    const path = await makeCleanSheetPath();
    if (status) status.textContent = "running clean-sheet path...";
    const result = await runScenario(path);
    publishResult(result);
  } catch (err) {
    if (status) status.textContent = String(err);
    throw err;
  }
}

void main();
