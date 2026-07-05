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
 * Orbit tracks: the operator product. Each object's actual path over +/- one
 * orbital period around the CURRENT scene time, computed from the dynamics (the
 * propagation source's sampleWindowInto), independent of frame rate and playback
 * speed. Past rev and next rev are both SOLID lines differing by color only --
 * no fades, no dashes: a track is a precise line.
 *
 * Contrast with TrailRenderer, which is a motion-history EFFECT (recent epoch
 * snapshots) -- useful as a visual cue on dense catalogs, meaningless as a
 * planning product. This renderer is the one that answers "where was it last
 * orbit, where will it be next orbit."
 */
import { packSplit3To4 } from "./rte.js";

export const ORBIT_TRACKS_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,
  eyeHigh     : vec4<f32>,
  eyeLow      : vec4<f32>,
  // samples, count, unused, unused
  params      : vec4<f32>,
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> posHigh : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> posLow  : array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) alpha : f32,
  @location(1) future : f32,
};

@vertex
fn vs(@builtin(vertex_index) s : u32, @builtin(instance_index) i : u32) -> VsOut {
  let samples = u32(cam.params.x);
  let idx = i * samples + s;
  let rel = (posHigh[idx].xyz - cam.eyeHigh.xyz) + (posLow[idx].xyz - cam.eyeLow.xyz);
  var out : VsOut;
  out.clip = cam.viewProjRte * vec4<f32>(rel, 1.0);

  // no fades, no dashes: a track is a precise line. past rev and next rev are
  // both solid; they differ by COLOR only.
  let mid = f32(samples - 1u) * 0.5;
  out.alpha = 0.9;
  out.future = select(0.0, 1.0, f32(s) > mid);
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  // past rev: catalog cyan. next rev: amber. both solid.
  let past = vec3<f32>(0.55, 0.80, 1.00);
  let fut  = vec3<f32>(1.00, 0.72, 0.30);
  let c = mix(past, fut, in.future) * in.alpha;
  return vec4<f32>(c, in.alpha);
}
`;

export interface OrbitTrackRendererOptions {
  readonly capacity: number;
  /** Samples per object per window (odd; middle sample = now). Default 129. */
  readonly samples?: number;
  readonly format: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat;
}

export class OrbitTrackRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly cameraBuf: GPUBuffer;
  private readonly highBuf: GPUBuffer;
  private readonly lowBuf: GPUBuffer;
  readonly capacity: number;
  readonly samples: number;
  private readonly highStage: Float32Array<ArrayBuffer>;
  private readonly lowStage: Float32Array<ArrayBuffer>;
  private readonly cameraStage = new Float32Array(16 + 4 + 4 + 4);
  private count = 0;

  constructor(device: GPUDevice, opts: OrbitTrackRendererOptions) {
    if (opts.capacity <= 0) throw new Error("capacity must be positive");
    this.device = device;
    this.capacity = opts.capacity;
    this.samples = opts.samples ?? 129;
    if (this.samples % 2 === 0) throw new Error("samples must be odd (middle = now)");
    this.highStage = new Float32Array(opts.capacity * this.samples * 4);
    this.lowStage = new Float32Array(opts.capacity * this.samples * 4);

    const module = device.createShaderModule({ code: ORBIT_TRACKS_WGSL });
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

    const bytes = opts.capacity * this.samples * 4 * 4;
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

  /** Upload a full window: [object][sample][xyz] km, from sampleWindowInto. */
  setWindow(windowKm: Float32Array, count: number): void {
    const n = Math.min(count, this.capacity);
    this.count = n;
    const packed = packSplit3To4(windowKm, n * this.samples, this.highStage, this.lowStage);
    this.device.queue.writeBuffer(this.highBuf, 0, this.highStage, 0, packed * 4);
    this.device.queue.writeBuffer(this.lowBuf, 0, this.lowStage, 0, packed * 4);
  }

  clear(): void {
    this.count = 0;
  }

  updateCamera(viewProjRte: Float32Array, eyeKm: readonly [number, number, number]): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(c - h);
    }
    this.cameraStage[24] = this.samples;
    this.cameraStage[25] = this.count;
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.count === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    // Near-circular orbits overlap themselves: past rev and next rev share the
    // same ring in space. Draw the future half FIRST and the past half ON TOP,
    // so the solid past orbit always reads, and amber shows exactly where the
    // next rev genuinely deviates from it.
    const half = (this.samples - 1) / 2;
    pass.draw(this.samples - half, this.count, half); // future: mid..end
    pass.draw(half + 1, this.count, 0); // past: start..mid, on top
  }
}
