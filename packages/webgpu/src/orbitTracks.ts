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
  // samples, count, gmstNow (rad; 0 for inertial-frame data), nowOffsetMinutes
  params      : vec4<f32>,
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> posHigh : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> posLow  : array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> periodsMin : array<f32>;
@group(0) @binding(4) var<storage, read> colors : array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) alpha : f32,
  @location(1) future : f32,
  @location(2) color : vec4<f32>,
};

// pass selector: 0 = draw only future fragments, 1 = draw only past fragments
// (past drawn second so it wins where the revs overlap in space)
struct PassSel { sel : vec4<f32> };
@group(1) @binding(0) var<uniform> passSel : PassSel;

@vertex
fn vs(@builtin(vertex_index) s : u32, @builtin(instance_index) i : u32) -> VsOut {
  let samples = u32(cam.params.x);
  let idx = i * samples + s;
  // ECEF-frame data spins with the planet (same Rz(gmst) as the Earth mesh)
  let c = cos(cam.params.z);
  let si = sin(cam.params.z);
  let ph = posHigh[idx].xyz;
  let pl = posLow[idx].xyz;
  let p = vec3<f32>(c * ph.x - si * ph.y, si * ph.x + c * ph.y, ph.z);
  let l = vec3<f32>(c * pl.x - si * pl.y, si * pl.x + c * pl.y, pl.z);
  let rel = (p - cam.eyeHigh.xyz) + (l - cam.eyeLow.xyz);
  var out : VsOut;
  out.clip = cam.viewProjRte * vec4<f32>(rel, 1.0);

  // no fades, no dashes: a track is a precise line. past rev and next rev are
  // both solid; they differ by COLOR only. The split sits at "now" CONTINUOUSLY:
  // the window spans +/- one period of THIS object around the window center, so
  // the sample index of "now" advances with the clock between geometry refreshes
  // and the satellite always rides the color boundary.
  let mid = f32(samples - 1u) * 0.5;
  let nowIdx = mid * (1.0 + cam.params.w / max(periodsMin[i], 1e-6));
  out.future = select(0.0, 1.0, f32(s) > nowIdx);
  // previous rev: 100% of the object's color. next rev: same hue at 60%.
  // colors[i].a is the per-object visibility (0 hides a filtered family).
  out.alpha = select(1.0, 0.6, out.future > 0.5) * colors[i].a;
  out.color = colors[i];
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  // two passes: future-only then past-only, so the full-opacity past orbit wins
  // where the revs overlap in space
  if (passSel.sel.x < 0.5 && in.future < 0.5) { discard; }
  if (passSel.sel.x >= 0.5 && in.future >= 0.5) { discard; }
  return vec4<f32>(in.color.rgb * in.alpha, in.alpha);
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
  private readonly periodsBuf: GPUBuffer;
  private readonly colorBuf: GPUBuffer;
  private readonly passSelBufs: [GPUBuffer, GPUBuffer];
  private readonly passSelGroups: [GPUBindGroup, GPUBindGroup];
  readonly capacity: number;
  readonly samples: number;
  private readonly highStage: Float32Array<ArrayBuffer>;
  private readonly lowStage: Float32Array<ArrayBuffer>;
  private readonly periodsStage: Float32Array<ArrayBuffer>;
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
    this.periodsStage = new Float32Array(opts.capacity);

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
    this.periodsBuf = device.createBuffer({
      size: Math.max(opts.capacity, 1) * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.colorBuf = device.createBuffer({
      size: opts.capacity * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const defaultColors = new Float32Array(opts.capacity * 4);
    for (let k = 0; k < opts.capacity; k += 1) defaultColors.set([0.55, 0.85, 1.0, 1.0], k * 4);
    device.queue.writeBuffer(this.colorBuf, 0, defaultColors);
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuf } },
        { binding: 1, resource: { buffer: this.highBuf } },
        { binding: 2, resource: { buffer: this.lowBuf } },
        { binding: 3, resource: { buffer: this.periodsBuf } },
        { binding: 4, resource: { buffer: this.colorBuf } },
      ],
    });
    const mkSel = (v: number): GPUBuffer => {
      const buf = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(buf, 0, new Float32Array([v, 0, 0, 0]));
      return buf;
    };
    this.passSelBufs = [mkSel(0), mkSel(1)];
    this.passSelGroups = [
      device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: this.passSelBufs[0] } }],
      }),
      device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(1),
        entries: [{ binding: 0, resource: { buffer: this.passSelBufs[1] } }],
      }),
    ];
  }

  /** Upload a full window: [object][sample][xyz] km + per-object periods (min). */
  setWindow(windowKm: Float32Array, count: number, periodsMinutes: Float32Array): void {
    const n = Math.min(count, this.capacity);
    this.count = n;
    const packed = packSplit3To4(windowKm, n * this.samples, this.highStage, this.lowStage);
    this.device.queue.writeBuffer(this.highBuf, 0, this.highStage, 0, packed * 4);
    this.device.queue.writeBuffer(this.lowBuf, 0, this.lowStage, 0, packed * 4);
    this.periodsStage.set(periodsMinutes.subarray(0, n));
    this.device.queue.writeBuffer(this.periodsBuf, 0, this.periodsStage, 0, n);
  }

  clear(): void {
    this.count = 0;
  }

  /** Per-object RGBA colors (stride 4, [0,1]); alpha channel is reserved. */
  setColors(rgba: Float32Array): void {
    const stage = new Float32Array(Math.min(rgba.length, this.capacity * 4));
    stage.set(rgba.subarray(0, stage.length));
    this.device.queue.writeBuffer(this.colorBuf, 0, stage);
  }

  updateCamera(
    viewProjRte: Float32Array,
    eyeKm: readonly [number, number, number],
    gmstNowRad = 0,
    nowOffsetMinutes = 0,
  ): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(c - h);
    }
    this.cameraStage[24] = this.samples;
    this.cameraStage[25] = this.count;
    this.cameraStage[26] = gmstNowRad;
    this.cameraStage[27] = nowOffsetMinutes;
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.count === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    // Near-circular orbits overlap themselves: past rev and next rev share the
    // same ring in space. The now-split is per-object and continuous, so the
    // halves are selected in the FRAGMENT stage: future-only pass first, then
    // past-only on top -- the solid past orbit always reads, amber shows where
    // the next rev genuinely deviates.
    pass.setBindGroup(1, this.passSelGroups[0]);
    pass.draw(this.samples, this.count);
    pass.setBindGroup(1, this.passSelGroups[1]);
    pass.draw(this.samples, this.count);
  }
}
