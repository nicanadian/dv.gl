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
 * The clean-sheet hot path for Stage 0: N instanced screen-space point sprites whose
 * positions live in a storage buffer that the propagation source rewrites each epoch.
 * One draw call for the whole catalog; camera-relative (RTE) subtraction in the
 * vertex shader; no per-frame JS allocation on the update path.
 *
 * Stage 0 scope only: points, RTE, clock, scrub. No picking, labels, trails, volumes.
 */
import { packRte } from "./rte.js";

/** WGSL for instanced point sprites with relative-to-eye precision. */
export const POINTS_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,   // view-projection built with the eye at the origin
  eyeHigh     : vec4<f32>,     // camera position, split (km)
  eyeLow      : vec4<f32>,
  viewport    : vec4<f32>,     // width, height, pointSizePx, unused
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> posHigh : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> posLow  : array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

// Two triangles per point sprite, expanded in clip space.
const QUAD = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
  vec2<f32>(-1.0,  1.0), vec2<f32>(1.0, -1.0), vec2<f32>( 1.0, 1.0),
);

@vertex
fn vs(@builtin(vertex_index) v : u32, @builtin(instance_index) i : u32) -> VsOut {
  // RTE: exact fp32 subtraction of the high parts, residual near the origin.
  let rel = (posHigh[i].xyz - cam.eyeHigh.xyz) + (posLow[i].xyz - cam.eyeLow.xyz);
  var clip = cam.viewProjRte * vec4<f32>(rel, 1.0);

  let corner = QUAD[v];
  let sizeNdc = vec2<f32>(cam.viewport.z / cam.viewport.x,
                          cam.viewport.z / cam.viewport.y) * clip.w;
  clip = vec4<f32>(clip.xy + corner * sizeNdc, clip.zw);

  var out : VsOut;
  out.clip = clip;
  out.uv = corner;
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  // circular sprite with a soft edge
  let r2 = dot(in.uv, in.uv);
  if (r2 > 1.0) { discard; }
  let alpha = 1.0 - smoothstep(0.7, 1.0, r2);
  return vec4<f32>(0.55, 0.85, 1.0, alpha);
}
`;

export interface PointRendererOptions {
  readonly capacity: number;
  readonly format: GPUTextureFormat;
  readonly pointSizePx?: number;
}

/**
 * Owns the pipeline, the split position buffers, and the camera uniform. The caller
 * drives: `updatePositions()` after each propagation epoch, `updateCamera()` per
 * frame, `draw()` inside its render pass.
 */
export class PointRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly cameraBuf: GPUBuffer;
  private readonly highBuf: GPUBuffer;
  private readonly lowBuf: GPUBuffer;
  private readonly capacity: number;
  private readonly pointSizePx: number;
  // preallocated staging arrays: the per-epoch update path does not allocate
  private readonly highStage: Float32Array<ArrayBuffer>;
  private readonly lowStage: Float32Array<ArrayBuffer>;
  private readonly cameraStage = new Float32Array(16 + 4 + 4 + 4);
  private count = 0;

  constructor(device: GPUDevice, opts: PointRendererOptions) {
    if (opts.capacity <= 0) throw new Error("capacity must be positive");
    this.device = device;
    this.capacity = opts.capacity;
    this.pointSizePx = opts.pointSizePx ?? 3;
    // vec4-strided storage (16 B per object) for WGSL array<vec4<f32>> alignment
    this.highStage = new Float32Array(opts.capacity * 4);
    this.lowStage = new Float32Array(opts.capacity * 4);

    const module = device.createShaderModule({ code: POINTS_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format: opts.format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list" },
    });

    const bytes = opts.capacity * 4 * 4;
    this.highBuf = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.lowBuf = device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.cameraBuf = device.createBuffer({
      size: this.cameraStage.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuf } },
        { binding: 1, resource: { buffer: this.highBuf } },
        { binding: 2, resource: { buffer: this.lowBuf } },
      ],
    });
  }

  /**
   * Rewrite the split position buffers from packed TEME km positions (stride 3).
   * Non-finite entries (failed propagation) are pushed far behind the far plane.
   */
  updatePositions(positionsKm: Float32Array, count: number): void {
    const n = Math.min(count, this.capacity);
    for (let k = 0; k < n; k += 1) {
      const src = k * 3;
      const dst = k * 4;
      for (let c = 0; c < 3; c += 1) {
        const v = positionsKm[src + c];
        const x = v !== undefined && Number.isFinite(v) ? v : 1e12;
        const h = Math.fround(x);
        this.highStage[dst + c] = h;
        this.lowStage[dst + c] = Math.fround(x - h);
      }
      this.highStage[dst + 3] = 0;
      this.lowStage[dst + 3] = 0;
    }
    this.count = n;
    this.device.queue.writeBuffer(this.highBuf, 0, this.highStage, 0, n * 4);
    this.device.queue.writeBuffer(this.lowBuf, 0, this.lowStage, 0, n * 4);
  }

  /** Upload the camera: an RTE view-projection (eye at origin) plus the split eye. */
  updateCamera(
    viewProjRte: Float32Array,
    eyeKm: readonly [number, number, number],
    widthPx: number,
    heightPx: number,
  ): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(c - h);
    }
    this.cameraStage[24] = widthPx;
    this.cameraStage[25] = heightPx;
    this.cameraStage[26] = this.pointSizePx;
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.count === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6, this.count);
  }
}

export { packRte };
