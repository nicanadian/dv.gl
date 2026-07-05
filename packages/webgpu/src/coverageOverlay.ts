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
 * A filled scalar-field overlay draped on the globe (or the flat map): an
 * equirectangular R8 texture sampled through a perceptual, luminance-monotonic
 * ramp (viridis), quantized into discrete steps. The coverage / age-of-collection
 * field renders through this -- a flat draped field, NOT a point stipple, and NOT
 * the blue->yellow->red rainbow (CVD-hostile, collides with the family colours).
 *
 * `mode: "sphere"` builds an Earth-fixed shell (GMST-spun, RTE, depth-tested) for
 * the 3D globe; `mode: "plane"` builds a lon/lat quad for the 2D map. Both sample
 * the SAME field the same way, so the two views can never disagree. Nearest
 * sampling keeps texel edges crisp (no bilinear smear faking precision).
 */

const EARTH_R_KM = 6371.0088;

export const COVERAGE_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,
  eyeHigh     : vec4<f32>,
  eyeLow      : vec4<f32>,
  // gmst radians, alpha, steps, unused
  params      : vec4<f32>,
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var field : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) uv : vec2<f32>,
};

@vertex
fn vs(@location(0) pos : vec3<f32>, @location(1) uv : vec2<f32>) -> VsOut {
  let c = cos(cam.params.x);
  let s = sin(cam.params.x);
  let p = vec3<f32>(c * pos.x - s * pos.y, s * pos.x + c * pos.y, pos.z);
  let rel = (p - cam.eyeHigh.xyz) + (vec3<f32>(0.0) - cam.eyeLow.xyz);
  var out : VsOut;
  out.clip = cam.viewProjRte * vec4<f32>(rel, 1.0);
  out.uv = uv;
  return out;
}

// polynomial approximation of the viridis colormap (public domain, Matt Zucker)
fn viridis(t : f32) -> vec3<f32> {
  let c0 = vec3<f32>(0.2777, 0.0054, 0.3341);
  let c1 = vec3<f32>(0.1051, 1.4046, 1.3846);
  let c2 = vec3<f32>(-0.3308, 0.2148, 0.0951);
  let c3 = vec3<f32>(-4.6342, -5.7991, -19.3324);
  let c4 = vec3<f32>(6.2283, 14.1799, 56.6906);
  let c5 = vec3<f32>(4.7764, -13.7451, -65.3530);
  let c6 = vec3<f32>(-5.4355, 4.6459, 26.3124);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let v = textureSample(field, samp, in.uv).r;
  if (v < 0.004) { discard; }              // never collected -> transparent
  let t = clamp((v * 255.0 - 1.0) / 254.0, 0.0, 1.0); // 0 = fresh, 1 = stale
  let steps = cam.params.z;
  let q = floor(t * steps) / max(steps - 1.0, 1.0);   // discrete buckets
  let a = cam.params.y;
  return vec4<f32>(clamp(viridis(clamp(q, 0.0, 1.0)), vec3<f32>(0.0), vec3<f32>(1.0)) * a, a);
}
`;

export interface CoverageOverlayOptions {
  readonly format: GPUTextureFormat;
  readonly mode: "sphere" | "plane";
  readonly gridW: number;
  readonly gridH: number;
  readonly depthFormat?: GPUTextureFormat;
  /** Overlay opacity. Default 0.55. */
  readonly alpha?: number;
  /** Discrete ramp steps. Default 6. */
  readonly steps?: number;
  /** Shell lift above the surface (sphere mode), km. Default 12. */
  readonly bumpKm?: number;
}

/** Build an indexed lon/lat sphere shell (ECEF km) with equirectangular uv. */
function buildSphere(
  radiusKm: number,
  latSeg: number,
  lonSeg: number,
): {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
} {
  const verts: number[] = [];
  for (let i = 0; i <= latSeg; i += 1) {
    const lat = ((90 - (i / latSeg) * 180) * Math.PI) / 180; // north -> south
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    for (let j = 0; j <= lonSeg; j += 1) {
      const lon = ((-180 + (j / lonSeg) * 360) * Math.PI) / 180;
      verts.push(radiusKm * cl * Math.cos(lon), radiusKm * cl * Math.sin(lon), radiusKm * sl);
      verts.push(j / lonSeg, i / latSeg); // uv: matches the texture's top-down rows
    }
  }
  const idx: number[] = [];
  const stride = lonSeg + 1;
  for (let i = 0; i < latSeg; i += 1) {
    for (let j = 0; j < lonSeg; j += 1) {
      const a = i * stride + j;
      const b = a + stride;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return { vertices: new Float32Array(verts), indices: new Uint32Array(idx) };
}

/** Build the flat map quad (plane coords x=lon/90, y=lat/90) with equirect uv. */
function buildPlane(): { vertices: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  // corners: (plane x, plane y, z, u, v)
  const v = [
    -2,
    1,
    0,
    0,
    0, // NW
    2,
    1,
    0,
    1,
    0, // NE
    -2,
    -1,
    0,
    0,
    1, // SW
    2,
    -1,
    0,
    1,
    1, // SE
  ];
  return { vertices: new Float32Array(v), indices: new Uint32Array([0, 2, 1, 1, 2, 3]) };
}

export class CoverageOverlay {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly cameraBuf: GPUBuffer;
  private readonly vertexBuf: GPUBuffer;
  private readonly indexBuf: GPUBuffer;
  private readonly texture: GPUTexture;
  private readonly indexCount: number;
  private readonly gridW: number;
  private readonly gridH: number;
  private readonly cameraStage = new Float32Array(16 + 4 + 4 + 4);
  private hasField = false;

  constructor(device: GPUDevice, opts: CoverageOverlayOptions) {
    this.device = device;
    this.gridW = opts.gridW;
    this.gridH = opts.gridH;
    const mesh =
      opts.mode === "sphere"
        ? buildSphere(EARTH_R_KM + (opts.bumpKm ?? 12), 90, 180)
        : buildPlane();
    this.indexCount = mesh.indices.length;

    this.vertexBuf = device.createBuffer({
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuf, 0, mesh.vertices);
    this.indexBuf = device.createBuffer({
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.indexBuf, 0, mesh.indices);

    this.texture = device.createTexture({
      size: [opts.gridW, opts.gridH],
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const sampler = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });

    const module = device.createShaderModule({ code: COVERAGE_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 20,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x2" },
            ],
          },
        ],
      },
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
              depthCompare: "less-equal" as const,
            },
          }
        : {}),
    });

    this.cameraBuf = device.createBuffer({
      size: this.cameraStage.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.cameraStage[25] = opts.alpha ?? 0.55; // params.y (16 mat + 4 high + 4 low + 1)
    this.cameraStage[26] = opts.steps ?? 6; // params.z
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuf } },
        { binding: 1, resource: this.texture.createView() },
        { binding: 2, resource: sampler },
      ],
    });
  }

  /** Upload the field (length gridW*gridH, row-major top-down, 0 = no data). */
  setField(field: Uint8Array<ArrayBuffer>): void {
    // r8unorm requires bytesPerRow a multiple of 256; pad rows if needed
    const padded = Math.ceil(this.gridW / 256) * 256;
    if (padded === this.gridW) {
      this.device.queue.writeTexture(
        { texture: this.texture },
        field,
        { bytesPerRow: this.gridW, rowsPerImage: this.gridH },
        { width: this.gridW, height: this.gridH },
      );
    } else {
      const buf = new Uint8Array(padded * this.gridH);
      for (let r = 0; r < this.gridH; r += 1) {
        buf.set(field.subarray(r * this.gridW, (r + 1) * this.gridW), r * padded);
      }
      this.device.queue.writeTexture(
        { texture: this.texture },
        buf,
        { bytesPerRow: padded, rowsPerImage: this.gridH },
        { width: this.gridW, height: this.gridH },
      );
    }
    this.hasField = true;
  }

  updateCamera(
    viewProjRte: Float32Array,
    eyeKm: readonly [number, number, number],
    gmstRad = 0,
  ): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(c - h);
    }
    this.cameraStage[24] = gmstRad; // params.x
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.hasField) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuf);
    pass.setIndexBuffer(this.indexBuf, "uint32");
    pass.drawIndexed(this.indexCount);
  }
}
