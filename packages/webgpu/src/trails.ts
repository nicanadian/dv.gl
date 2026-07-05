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
 * GPU orbit trails: a ring buffer of the last `slots` epoch snapshots, rendered as
 * one instanced line-strip draw (vertex = age, instance = object) with age-faded
 * alpha. Each epoch update writes ONE slot (count x vec4 x 2 buffers); nothing else
 * moves, so trail cost is independent of trail length except in GPU memory.
 *
 * Discontinuities (scrubs) call reset(): validSlots drops to zero and the trail
 * regrows from subsequent epochs -- stale geometry is never drawn because vertices
 * older than validSlots collapse onto the newest sample with alpha 0.
 */
import { packSplit3To4 } from "./rte.js";

/** Ring slot that holds the age-k sample (k=0 is newest), given the newest slot. */
export function trailSlotForAge(newestSlot: number, age: number, slots: number): number {
  return (((newestSlot - age) % slots) + slots) % slots;
}

/** Ring slot the NEXT push writes, given the newest slot. */
export function nextTrailSlot(newestSlot: number, slots: number): number {
  return (newestSlot + 1) % slots;
}

export const TRAILS_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,
  eyeHigh     : vec4<f32>,
  eyeLow      : vec4<f32>,
  // newestSlot, slots, validSlots, count  (integers stored as f32; exact < 2^24)
  ring        : vec4<f32>,
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> ringHigh : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> ringLow  : array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) alpha : f32,
};

@vertex
fn vs(@builtin(vertex_index) age : u32, @builtin(instance_index) i : u32) -> VsOut {
  let newest = u32(cam.ring.x);
  let slots  = u32(cam.ring.y);
  let valid  = u32(cam.ring.z);
  let count  = u32(cam.ring.w);

  // vertices beyond the valid history collapse onto the newest sample, alpha 0
  let clampedAge = min(age, max(valid, 1u) - 1u);
  let slot = (newest + slots - (clampedAge % slots)) % slots;
  let idx = slot * count + i;

  let rel = (ringHigh[idx].xyz - cam.eyeHigh.xyz) + (ringLow[idx].xyz - cam.eyeLow.xyz);
  var out : VsOut;
  out.clip = cam.viewProjRte * vec4<f32>(rel, 1.0);
  let fade = 1.0 - f32(clampedAge) / f32(max(slots, 2u) - 1u);
  out.alpha = select(0.0, 0.35 * fade, age < valid);
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  return vec4<f32>(0.35 * in.alpha, 0.55 * in.alpha, 0.75 * in.alpha, in.alpha);
}
`;

export interface TrailRendererOptions {
  readonly capacity: number;
  readonly format: GPUTextureFormat;
  /** Ring length: how many epoch snapshots a trail spans. Default 48. */
  readonly slots?: number;
  /** When the pass has a depth attachment: test against it, never write. */
  readonly depthFormat?: GPUTextureFormat;
}

export class TrailRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly cameraBuf: GPUBuffer;
  private readonly highBuf: GPUBuffer;
  private readonly lowBuf: GPUBuffer;
  readonly capacity: number;
  readonly slots: number;
  private readonly highStage: Float32Array<ArrayBuffer>;
  private readonly lowStage: Float32Array<ArrayBuffer>;
  private readonly cameraStage = new Float32Array(16 + 4 + 4 + 4);
  private newestSlot = -1;
  private validSlots = 0;
  private count = 0;

  constructor(device: GPUDevice, opts: TrailRendererOptions) {
    if (opts.capacity <= 0) throw new Error("capacity must be positive");
    this.device = device;
    this.capacity = opts.capacity;
    this.slots = Math.max(2, opts.slots ?? 48);
    this.highStage = new Float32Array(opts.capacity * 4);
    this.lowStage = new Float32Array(opts.capacity * 4);

    const module = device.createShaderModule({ code: TRAILS_WGSL });
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
      primitive: { topology: "line-strip" },
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

    const bytes = this.slots * opts.capacity * 4 * 4;
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

  /** Append one epoch snapshot (packed km positions, stride 3) to the ring. */
  push(positionsKm: Float32Array, count: number): void {
    const n = Math.min(count, this.capacity);
    this.count = n;
    packSplit3To4(positionsKm, n, this.highStage, this.lowStage);
    this.newestSlot = nextTrailSlot(
      this.newestSlot < 0 ? this.slots - 1 : this.newestSlot,
      this.slots,
    );
    this.validSlots = Math.min(this.validSlots + 1, this.slots);
    const byteOffset = this.newestSlot * this.capacity * 4 * 4;
    this.device.queue.writeBuffer(this.highBuf, byteOffset, this.highStage, 0, n * 4);
    this.device.queue.writeBuffer(this.lowBuf, byteOffset, this.lowStage, 0, n * 4);
  }

  /** Drop history after a discontinuity (scrub); the trail regrows. */
  reset(): void {
    this.validSlots = 0;
  }

  updateCamera(
    viewProjRte: Float32Array,
    eyeKm: readonly [number, number, number],
    // width/height unused here; kept for signature parity with PointRenderer
  ): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(c - h);
    }
    this.cameraStage[24] = Math.max(0, this.newestSlot);
    this.cameraStage[25] = this.slots;
    this.cameraStage[26] = this.validSlots;
    this.cameraStage[27] = this.count;
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.count === 0 || this.validSlots < 2) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(Math.min(this.validSlots, this.slots), this.count);
  }
}
