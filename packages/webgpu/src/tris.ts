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
 * General world-space filled triangles with relative-to-eye precision: a dynamic
 * triangle-list the host rewrites each frame. Reusable for translucent ground
 * areas -- sensor footprints/swaths, AOI polygons, filled corridors. Positions
 * are km in the same world frame as the point/line renderers; RTE keeps them
 * precise at Earth scale. Depth-tested (not written) so fills sit on the globe
 * without z-fighting the geometry drawn after them.
 */
import { packSplit3To4 } from "./rte.js";

export const TRIS_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,
  eyeHigh     : vec4<f32>,
  eyeLow      : vec4<f32>,
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> posHigh : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> posLow  : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> colors  : array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) color : vec4<f32>,
};

@vertex
fn vs(@builtin(vertex_index) v : u32) -> VsOut {
  let rel = (posHigh[v].xyz - cam.eyeHigh.xyz) + (posLow[v].xyz - cam.eyeLow.xyz);
  var out : VsOut;
  out.clip = cam.viewProjRte * vec4<f32>(rel, 1.0);
  out.color = colors[v];
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
}
`;

export interface TriRendererOptions {
  /** Max vertices (3 per triangle). */
  readonly capacity: number;
  readonly format: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat;
}

export class TriRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly cameraBuf: GPUBuffer;
  private readonly highBuf: GPUBuffer;
  private readonly lowBuf: GPUBuffer;
  private readonly colorBuf: GPUBuffer;
  readonly capacity: number;
  private readonly highStage: Float32Array<ArrayBuffer>;
  private readonly lowStage: Float32Array<ArrayBuffer>;
  private readonly colorStage: Float32Array<ArrayBuffer>;
  private readonly cameraStage = new Float32Array(16 + 4 + 4);
  private vertexCount = 0;

  constructor(device: GPUDevice, opts: TriRendererOptions) {
    if (opts.capacity <= 0) throw new Error("capacity must be positive");
    this.device = device;
    this.capacity = opts.capacity;
    this.highStage = new Float32Array(opts.capacity * 4);
    this.lowStage = new Float32Array(opts.capacity * 4);
    this.colorStage = new Float32Array(opts.capacity * 4);

    const module = device.createShaderModule({ code: TRIS_WGSL });
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
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      // no back-face culling: ground fills are viewed from either side
      primitive: { topology: "triangle-list", cullMode: "none" },
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
    this.colorBuf = device.createBuffer({
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
        { binding: 3, resource: { buffer: this.colorBuf } },
      ],
    });
  }

  /**
   * Set the triangles: `positionsKm` is stride-3, 3 vertices per triangle;
   * `colorsRgba` is stride-4 per vertex. `triCount` triangles = 3*triCount vertices.
   */
  setTriangles(positionsKm: Float32Array, colorsRgba: Float32Array, triCount: number): void {
    const verts = Math.min(triCount * 3, this.capacity);
    packSplit3To4(positionsKm, verts, this.highStage, this.lowStage);
    this.colorStage.set(colorsRgba.subarray(0, verts * 4));
    this.vertexCount = verts;
    this.device.queue.writeBuffer(this.highBuf, 0, this.highStage, 0, verts * 4);
    this.device.queue.writeBuffer(this.lowBuf, 0, this.lowStage, 0, verts * 4);
    this.device.queue.writeBuffer(this.colorBuf, 0, this.colorStage, 0, verts * 4);
  }

  clear(): void {
    this.vertexCount = 0;
  }

  updateCamera(viewProjRte: Float32Array, eyeKm: readonly [number, number, number]): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(c - h);
    }
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.vertexCount < 3) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(this.vertexCount);
  }
}
