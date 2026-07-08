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
 * A translucent atmospheric-density shell: a sphere just above the surface, alpha-glowing
 * toward the limb (fresnel), warm at the base and cooling with altitude — a legible cue
 * for where the drag-relevant atmosphere sits (VLEO & Lifetime). Depth-tested against the
 * opaque earth substrate so the far side hides; RTE precision like the other layers.
 */
import { EARTH_A_KM } from "@dvgl/webgpu";
import type { FrameContext, Layer, LayerContext } from "../types.js";

const ATMO_WGSL = /* wgsl */ `
struct Cam { viewProjRte : mat4x4<f32>, eyeHigh : vec4<f32>, eyeLow : vec4<f32>, params : vec4<f32> };
@group(0) @binding(0) var<uniform> cam : Cam;
struct VsOut { @builtin(position) clip : vec4<f32>, @location(0) normal : vec3<f32>, @location(1) world : vec3<f32> };
@vertex
fn vs(@location(0) pos : vec3<f32>, @location(1) nrm : vec3<f32>) -> VsOut {
  let rel = (pos - cam.eyeHigh.xyz) + (vec3<f32>(0.0) - cam.eyeLow.xyz);
  var o : VsOut;
  o.clip = cam.viewProjRte * vec4<f32>(rel, 1.0);
  o.normal = nrm;
  o.world = pos;
  return o;
}
@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let eyeAbs = cam.eyeHigh.xyz + cam.eyeLow.xyz;
  let v = normalize(eyeAbs - in.world);
  let f = pow(1.0 - max(dot(normalize(in.normal), v), 0.0), 2.6); // limb glow
  let col = mix(vec3<f32>(0.9, 0.45, 0.3), vec3<f32>(0.3, 0.55, 1.0), f); // warm base -> cool high
  return vec4<f32>(col, f * cam.params.x);
}
`;

/** UV sphere (pos + normal interleaved, stride 6) at radius `rKm`. */
function sphere(
  rKm: number,
  lat = 48,
  lon = 96,
): { verts: Float32Array<ArrayBuffer>; idx: Uint32Array<ArrayBuffer> } {
  const v: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= lat; i += 1) {
    const th = Math.PI / 2 - (i / lat) * Math.PI;
    const cl = Math.cos(th);
    const sl = Math.sin(th);
    for (let j = 0; j <= lon; j += 1) {
      const ph = (j / lon) * 2 * Math.PI;
      const x = cl * Math.cos(ph);
      const y = cl * Math.sin(ph);
      const z = sl;
      v.push(rKm * x, rKm * y, rKm * z, x, y, z);
    }
  }
  const st = lon + 1;
  for (let i = 0; i < lat; i += 1) {
    for (let j = 0; j < lon; j += 1) {
      const a = i * st + j;
      const b = a + st;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { verts: new Float32Array(v), idx: new Uint32Array(idx) };
}

export interface AtmosphereLayerOptions {
  /** Shell altitude above the surface, km. Default 500 (upper VLEO drag band). */
  readonly altitudeKm?: number;
  /** Peak limb-glow alpha. Default 0.5. */
  readonly intensity?: number;
}

export class AtmosphereLayer implements Layer {
  private readonly altKm: number;
  private readonly intensity: number;
  private pipeline: GPURenderPipeline | undefined;
  private bind: GPUBindGroup | undefined;
  private camBuf: GPUBuffer | undefined;
  private vbuf: GPUBuffer | undefined;
  private ibuf: GPUBuffer | undefined;
  private indexCount = 0;
  private queue: GPUQueue | undefined;
  private readonly cam = new Float32Array(16 + 4 + 4 + 4);

  constructor(opts: AtmosphereLayerOptions = {}) {
    this.altKm = opts.altitudeKm ?? 500;
    this.intensity = opts.intensity ?? 0.5;
  }

  init(ctx: LayerContext): void {
    this.queue = ctx.device.queue;
    const { verts, idx } = sphere(EARTH_A_KM + this.altKm);
    this.indexCount = idx.length;
    this.vbuf = ctx.device.createBuffer({
      size: verts.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    ctx.device.queue.writeBuffer(this.vbuf, 0, verts);
    this.ibuf = ctx.device.createBuffer({
      size: idx.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    ctx.device.queue.writeBuffer(this.ibuf, 0, idx);
    const module = ctx.device.createShaderModule({ code: ATMO_WGSL });
    this.pipeline = ctx.device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 24,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format: ctx.format,
            blend: {
              color: { srcFactor: "src-alpha", dstFactor: "one" }, // additive glow
              alpha: { srcFactor: "one", dstFactor: "one" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-list", cullMode: "front" }, // inner faces -> planet halo
      depthStencil: { format: ctx.depthFormat, depthWriteEnabled: false, depthCompare: "less" },
    });
    this.camBuf = ctx.device.createBuffer({
      size: this.cam.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bind = ctx.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.camBuf } }],
    });
  }

  update(frame: FrameContext): void {
    if (!this.camBuf || !this.queue) return;
    this.cam.set(frame.viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = frame.eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cam[16 + i] = h;
      this.cam[20 + i] = Math.fround(c - h);
    }
    this.cam[24] = this.intensity;
    this.queue.writeBuffer(this.camBuf, 0, this.cam);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bind || !this.vbuf || !this.ibuf) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    pass.setVertexBuffer(0, this.vbuf);
    pass.setIndexBuffer(this.ibuf, "uint32");
    pass.drawIndexed(this.indexCount);
  }

  dispose(): void {
    this.vbuf?.destroy();
    this.ibuf?.destroy();
    this.camBuf?.destroy();
    this.pipeline = undefined;
  }
}
