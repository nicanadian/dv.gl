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
import { packSplit3To4 } from "./rte.js";

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
@group(0) @binding(3) var<storage, read> colors  : array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) color : vec4<f32>,
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
  out.color = colors[i];
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  // circular sprite with a soft edge
  let r2 = dot(in.uv, in.uv);
  if (r2 > 1.0) { discard; }
  let alpha = (1.0 - smoothstep(0.7, 1.0, r2)) * in.color.a;
  return vec4<f32>(in.color.rgb, alpha);
}
`;

/** WGSL for the id-picking pass: same sprites, output the encoded object id. */
export const POINTS_ID_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,
  eyeHigh     : vec4<f32>,
  eyeLow      : vec4<f32>,
  viewport    : vec4<f32>,
};
@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> posHigh : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> posLow  : array<vec4<f32>>;

const QUAD = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
  vec2<f32>(-1.0,  1.0), vec2<f32>(1.0, -1.0), vec2<f32>( 1.0, 1.0),
);

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
  @location(1) @interpolate(flat) id : u32,
};

@vertex
fn vs(@builtin(vertex_index) v : u32, @builtin(instance_index) i : u32) -> VsOut {
  let rel = (posHigh[i].xyz - cam.eyeHigh.xyz) + (posLow[i].xyz - cam.eyeLow.xyz);
  var clip = cam.viewProjRte * vec4<f32>(rel, 1.0);
  let corner = QUAD[v];
  // pick a slightly larger hit target than the visible sprite for easier hover
  let px = cam.viewport.z + 3.0;
  let sizeNdc = vec2<f32>(px / cam.viewport.x, px / cam.viewport.y) * clip.w;
  clip = vec4<f32>(clip.xy + corner * sizeNdc, clip.zw);
  var out : VsOut;
  out.clip = clip;
  out.uv = corner;
  out.id = i + 1u; // 0 is reserved for "nothing"
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  if (dot(in.uv, in.uv) > 1.0) { discard; }
  let id = in.id;
  return vec4<f32>(
    f32(id & 255u) / 255.0,
    f32((id >> 8u) & 255u) / 255.0,
    f32((id >> 16u) & 255u) / 255.0,
    1.0,
  );
}
`;

export interface PointRendererOptions {
  readonly capacity: number;
  readonly format: GPUTextureFormat;
  readonly pointSizePx?: number;
  /** When the pass has a depth attachment: test against it, never write. */
  readonly depthFormat?: GPUTextureFormat;
  /** Enable id-picking; the offscreen id target format (e.g. "rgba8unorm"). */
  readonly pickFormat?: GPUTextureFormat;
}

/** Decode a picked RGBA8 pixel back to an object index, or -1 for background. */
export function decodePickedIndex(rgba: Uint8Array): number {
  const id = (rgba[0] ?? 0) + ((rgba[1] ?? 0) << 8) + ((rgba[2] ?? 0) << 16);
  return id === 0 ? -1 : id - 1;
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
  private readonly colorBuf: GPUBuffer;
  private readonly idPipeline?: GPURenderPipeline;
  private readonly idBindGroup?: GPUBindGroup;
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
      ...(opts.depthFormat
        ? {
            depthStencil: {
              format: opts.depthFormat,
              depthWriteEnabled: false,
              depthCompare: "less-equal" as const,
            },
          }
        : {}),
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
    this.colorBuf = device.createBuffer({
      size: opts.capacity * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // default: the catalog cyan for every object
    const defaultColors = new Float32Array(opts.capacity * 4);
    for (let k = 0; k < opts.capacity; k += 1) defaultColors.set([0.55, 0.85, 1.0, 1.0], k * 4);
    device.queue.writeBuffer(this.colorBuf, 0, defaultColors);
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuf } },
        { binding: 1, resource: { buffer: this.highBuf } },
        { binding: 2, resource: { buffer: this.lowBuf } },
        { binding: 3, resource: { buffer: this.colorBuf } },
      ],
    });

    if (opts.pickFormat) {
      const idModule = device.createShaderModule({ code: POINTS_ID_WGSL });
      this.idPipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: idModule, entryPoint: "vs" },
        fragment: { module: idModule, entryPoint: "fs", targets: [{ format: opts.pickFormat }] },
        primitive: { topology: "triangle-list" },
        ...(opts.depthFormat
          ? {
              depthStencil: {
                format: opts.depthFormat,
                depthWriteEnabled: true,
                depthCompare: "less" as const,
              },
            }
          : {}),
      });
      this.idBindGroup = device.createBindGroup({
        layout: this.idPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.cameraBuf } },
          { binding: 1, resource: { buffer: this.highBuf } },
          { binding: 2, resource: { buffer: this.lowBuf } },
        ],
      });
    }
  }

  /** Draw the id-picking pass (requires pickFormat at construction). */
  drawIds(pass: GPURenderPassEncoder): void {
    if (this.count === 0 || !this.idPipeline || !this.idBindGroup) return;
    pass.setPipeline(this.idPipeline);
    pass.setBindGroup(0, this.idBindGroup);
    pass.draw(6, this.count);
  }

  /** Per-object RGBA colors (stride 4, [0,1]). */
  setColors(rgba: Float32Array): void {
    const stage = new Float32Array(Math.min(rgba.length, this.capacity * 4));
    stage.set(rgba.subarray(0, stage.length));
    this.device.queue.writeBuffer(this.colorBuf, 0, stage);
  }

  /**
   * Rewrite the split position buffers from packed TEME km positions (stride 3).
   * Non-finite entries (failed propagation) are pushed far behind the far plane.
   */
  updatePositions(positionsKm: Float32Array, count: number): void {
    const n = packSplit3To4(
      positionsKm,
      Math.min(count, this.capacity),
      this.highStage,
      this.lowStage,
    );
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
