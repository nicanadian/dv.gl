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
 * Screen-space wide lines: each segment is expanded into a camera-facing quad (2 tris)
 * offset by a pixel width, so borders read as bold strokes (GPU line primitives are
 * 1px-only). Earth-fixed (ECEF km) with GMST spin + analytic horizon cull, so it drapes
 * on the globe on the near side and hides at the limb. RTE precision via an eye split.
 */

export const THICK_LINES_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,
  eyeHigh     : vec4<f32>,
  eyeLow      : vec4<f32>,
  model       : vec4<f32>, // cos(gmst), sin(gmst), spin flag, horizon-cull flag
  view        : vec4<f32>, // viewportW, viewportH, halfWidthPx, _
};
@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> segA   : array<vec4<f32>>; // xyz=A km, w=t (0/1)
@group(0) @binding(2) var<storage, read> segB   : array<vec4<f32>>; // xyz=B km, w=side (-1/1)
@group(0) @binding(3) var<storage, read> colors : array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) color : vec4<f32>,
  @location(1) world : vec3<f32>,
};

fn spin(v : vec3<f32>, c : f32, s : f32) -> vec3<f32> {
  return vec3<f32>(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
}
fn project(pw : vec3<f32>) -> vec4<f32> {
  let rel = (pw - cam.eyeHigh.xyz) + (vec3<f32>(0.0) - cam.eyeLow.xyz);
  return cam.viewProjRte * vec4<f32>(rel, 1.0);
}

@vertex
fn vs(@builtin(vertex_index) vi : u32) -> VsOut {
  let c = cos(cam.model.x);
  let s = sin(cam.model.x);
  var a = segA[vi].xyz;
  var b = segB[vi].xyz;
  if (cam.model.z > 0.5) { a = spin(a, c, s); b = spin(b, c, s); }
  let t = segA[vi].w;
  let side = segB[vi].w;

  let ca = project(a);
  let cb = project(b);
  let px = cam.view.xy;
  let na = ca.xy / ca.w * px;
  let nb = cb.xy / cb.w * px;
  var dir = nb - na;
  if (length(dir) < 1e-6) { dir = vec2<f32>(1.0, 0.0); }
  dir = normalize(dir);
  let nrm = vec2<f32>(-dir.y, dir.x);
  let clipThis = select(ca, cb, t > 0.5);
  let offset = nrm * side * cam.view.z / px * clipThis.w;

  var o : VsOut;
  o.clip = vec4<f32>(clipThis.xy + offset, clipThis.zw);
  o.color = colors[vi];
  o.world = select(a, b, t > 0.5);
  return o;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  if (cam.model.w > 0.5) {
    let eyeAbs = cam.eyeHigh.xyz + cam.eyeLow.xyz;
    if (dot(in.world, eyeAbs) < 40589641.0) { discard; }
  }
  return vec4<f32>(in.color.rgb * in.color.a, in.color.a);
}
`;

export interface ThickLineRendererOptions {
  /** Max segments. */
  readonly capacity: number;
  readonly format: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat;
  /** Line half-width is set per frame; this is the initial px width. Default 2. */
  readonly widthPx?: number;
}

const QUAD_T = [0, 0, 1, 1, 1, 0]; // per-vertex t (which endpoint)
const QUAD_S = [-1, 1, -1, 1, 1, -1]; // per-vertex side

export class ThickLineRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly cameraBuf: GPUBuffer;
  private readonly aBuf: GPUBuffer;
  private readonly bBuf: GPUBuffer;
  private readonly colorBuf: GPUBuffer;
  readonly capacity: number;
  private readonly aStage: Float32Array<ArrayBuffer>;
  private readonly bStage: Float32Array<ArrayBuffer>;
  private readonly colorStage: Float32Array<ArrayBuffer>;
  private readonly cameraStage = new Float32Array(16 + 4 + 4 + 4 + 4);
  private vertexCount = 0;
  private widthPx: number;

  constructor(device: GPUDevice, opts: ThickLineRendererOptions) {
    this.device = device;
    this.capacity = opts.capacity;
    this.widthPx = opts.widthPx ?? 2;
    const maxVerts = opts.capacity * 6;
    this.aStage = new Float32Array(maxVerts * 4);
    this.bStage = new Float32Array(maxVerts * 4);
    this.colorStage = new Float32Array(maxVerts * 4);

    const module = device.createShaderModule({ code: THICK_LINES_WGSL });
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
      primitive: { topology: "triangle-list", cullMode: "none" },
      ...(opts.depthFormat
        ? {
            depthStencil: {
              format: opts.depthFormat,
              depthWriteEnabled: false,
              depthCompare: "always" as const,
            },
          }
        : {}),
    });

    const bytes = maxVerts * 4 * 4;
    const mk = (): GPUBuffer =>
      device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.aBuf = mk();
    this.bBuf = mk();
    this.colorBuf = mk();
    this.cameraBuf = device.createBuffer({
      size: this.cameraStage.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuf } },
        { binding: 1, resource: { buffer: this.aBuf } },
        { binding: 2, resource: { buffer: this.bBuf } },
        { binding: 3, resource: { buffer: this.colorBuf } },
      ],
    });
  }

  /** `posKm` stride-3, 2 vertices per segment; `rgba` stride-4 per SEGMENT. */
  setSegments(posKm: Float32Array, rgba: Float32Array, segmentCount: number): void {
    const segs = Math.min(segmentCount, this.capacity);
    let vo = 0;
    for (let sidx = 0; sidx < segs; sidx += 1) {
      const ax = posKm[sidx * 6] ?? 0;
      const ay = posKm[sidx * 6 + 1] ?? 0;
      const az = posKm[sidx * 6 + 2] ?? 0;
      const bx = posKm[sidx * 6 + 3] ?? 0;
      const by = posKm[sidx * 6 + 4] ?? 0;
      const bz = posKm[sidx * 6 + 5] ?? 0;
      const r = rgba[sidx * 4] ?? 0;
      const g = rgba[sidx * 4 + 1] ?? 0;
      const b = rgba[sidx * 4 + 2] ?? 0;
      const al = rgba[sidx * 4 + 3] ?? 1;
      for (let k = 0; k < 6; k += 1) {
        const o = vo * 4;
        this.aStage[o] = ax;
        this.aStage[o + 1] = ay;
        this.aStage[o + 2] = az;
        this.aStage[o + 3] = QUAD_T[k] as number;
        this.bStage[o] = bx;
        this.bStage[o + 1] = by;
        this.bStage[o + 2] = bz;
        this.bStage[o + 3] = QUAD_S[k] as number;
        this.colorStage[o] = r;
        this.colorStage[o + 1] = g;
        this.colorStage[o + 2] = b;
        this.colorStage[o + 3] = al;
        vo += 1;
      }
    }
    this.vertexCount = segs * 6;
    this.device.queue.writeBuffer(this.aBuf, 0, this.aStage, 0, this.vertexCount * 4);
    this.device.queue.writeBuffer(this.bBuf, 0, this.bStage, 0, this.vertexCount * 4);
    this.device.queue.writeBuffer(this.colorBuf, 0, this.colorStage, 0, this.vertexCount * 4);
  }

  setWidth(px: number): void {
    this.widthPx = px;
  }

  updateCamera(
    viewProjRte: Float32Array,
    eyeKm: readonly [number, number, number],
    viewportW: number,
    viewportH: number,
    spinGmstRad?: number,
    horizonCull = true,
  ): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(c - h);
    }
    if (spinGmstRad === undefined) {
      this.cameraStage[24] = 1;
      this.cameraStage[25] = 0;
      this.cameraStage[26] = 0;
    } else {
      this.cameraStage[24] = Math.cos(spinGmstRad);
      this.cameraStage[25] = Math.sin(spinGmstRad);
      this.cameraStage[26] = 1;
    }
    this.cameraStage[27] = horizonCull ? 1 : 0;
    this.cameraStage[28] = viewportW;
    this.cameraStage[29] = viewportH;
    this.cameraStage[30] = this.widthPx * 0.5;
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.vertexCount < 3) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(this.vertexCount);
  }
}
