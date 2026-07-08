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
 * Geomorphing low-poly Earth surface: a single fine triangle mesh where each vertex
 * carries BOTH its true (sphere) position and its position on the coarser parent mesh.
 * A camera-altitude morph lerps new vertices from the parent surface out to the sphere —
 * so as you zoom in the coarse triangles visibly *split* into the fine ones with no pop
 * and no cracks (shared coarse vertices never move). The triangle wireframe is drawn
 * in-shader (barycentric), so it morphs *with* the surface instead of a separate pass.
 *
 * Per-vertex: truePos(3) parentPos(3) normal(3) facetId(1) birth(1) bary(2) -> stride 52.
 * Per-facet color comes from a storage buffer. Opaque + depth (closed sphere hides the
 * far side); flat per-facet color + sun-catch keep the low-poly read.
 */
export const GEOMORPH_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,
  eyeHigh : vec4<f32>,
  eyeLow  : vec4<f32>,
  spin    : vec4<f32>, // cos(gmst), sin(gmst), spin flag, opacity
  morph   : vec4<f32>, // bandHi km, bandLo km, camAlt km, wireWidth px
  sun     : vec4<f32>, // xyz sun dir, facetShade
  look    : vec4<f32>, // flatten, wireStrength, limbPow, limbIntensity
};
@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<storage, read> facetColor : array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) @interpolate(flat) facet : u32,
  @location(1) @interpolate(flat) normal : vec3<f32>,
  @location(2) world : vec3<f32>,
  @location(3) bary : vec2<f32>,
};

fn spin(v : vec3<f32>, c : f32, s : f32) -> vec3<f32> {
  return vec3<f32>(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
}

@vertex
fn vs(
  @location(0) truePos : vec3<f32>,
  @location(1) parentPos : vec3<f32>,
  @location(2) nrm : vec3<f32>,
  @location(3) fid : f32,
  @location(4) birth : f32,
  @location(5) bary : vec2<f32>,
) -> VsOut {
  // morph: 0 at/above bandHi (parent/coarse), 1 at/below bandLo (true/fine)
  let t = clamp((cam.morph.x - cam.morph.z) / max(cam.morph.x - cam.morph.y, 1.0), 0.0, 1.0);
  let vm = select(1.0, t, birth > 0.5); // coarse (birth 0) vertices never move
  var p = mix(parentPos, truePos, vm);
  let c = cos(cam.spin.x); let s = sin(cam.spin.x);
  if (cam.spin.z > 0.5) { p = spin(p, c, s); }
  let n = select(nrm, spin(nrm, c, s), cam.spin.z > 0.5);
  let rel = (p - cam.eyeHigh.xyz) + (vec3<f32>(0.0) - cam.eyeLow.xyz);
  var o : VsOut;
  o.clip = cam.viewProjRte * vec4<f32>(rel, 1.0);
  o.facet = u32(fid + 0.5);
  o.normal = n;
  o.world = p;
  o.bary = bary;
  return o;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  var col = facetColor[in.facet].rgb;
  let sun = normalize(cam.sun.xyz);
  // faceted sun-catch
  let facetLit = 0.5 + 0.5 * dot(normalize(in.normal), sun);
  col *= 1.0 - cam.sun.w + cam.sun.w * facetLit;
  // smooth day/night + flatten (keep the dark side legible)
  let sN = normalize(in.world);
  let dayness = smoothstep(-0.12, 0.12, dot(sN, sun));
  col = mix(col * 0.12, col, dayness);
  col = mix(col, facetColor[in.facet].rgb, cam.look.x * (1.0 - dayness));
  // fresnel limb
  let eyeAbs = cam.eyeHigh.xyz + cam.eyeLow.xyz;
  let viewDir = normalize(eyeAbs - in.world);
  let rim = pow(1.0 - max(dot(sN, viewDir), 0.0), cam.look.z);
  col += vec3<f32>(0.28, 0.5, 0.72) * rim * cam.look.w;
  // in-shader wireframe (barycentric): darken thin triangle edges (morphs with the mesh)
  let w = 1.0 - in.bary.x - in.bary.y;
  let e = min(min(in.bary.x, in.bary.y), w);
  let ew = fwidth(e) * cam.morph.w;
  let wire = 1.0 - smoothstep(0.0, max(ew, 1e-5), e);
  col = mix(col, col * 0.14, wire * cam.look.y);
  return vec4<f32>(col, cam.spin.w);
}
`;

export interface GeomorphEarthRendererOptions {
  readonly format: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  /** Per-vertex stride-13: truePos3 parentPos3 normal3 facetId1 birth1 bary2. */
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly facetCount: number;
}

export class GeomorphEarthRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly cameraBuf: GPUBuffer;
  private readonly colorBuf: GPUBuffer;
  private readonly vertexBuf: GPUBuffer;
  private readonly vertexCount: number;
  private readonly cameraStage = new Float32Array(16 + 4 * 5);
  private readonly colorStage: Float32Array<ArrayBuffer>;
  // tuning
  bandHiKm = 12000;
  bandLoKm = 3500;
  wireWidthPx = 1.2;
  facetShade = 0.24;
  flatten = 0.55;
  limbPow = 3.4;
  limbIntensity = 0.5;
  wireStrength = 0.8;

  constructor(device: GPUDevice, opts: GeomorphEarthRendererOptions) {
    this.device = device;
    this.vertexCount = opts.vertices.length / 13;
    this.colorStage = new Float32Array(opts.facetCount * 4);

    this.vertexBuf = device.createBuffer({
      size: opts.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuf, 0, opts.vertices);

    const module = device.createShaderModule({ code: GEOMORPH_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 52,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x3" },
              { shaderLocation: 3, offset: 36, format: "float32" },
              { shaderLocation: 4, offset: 40, format: "float32" },
              { shaderLocation: 5, offset: 44, format: "float32x2" },
            ],
          },
        ],
      },
      fragment: { module, entryPoint: "fs", targets: [{ format: opts.format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: opts.depthFormat, depthWriteEnabled: true, depthCompare: "less" },
    });

    this.colorBuf = device.createBuffer({
      size: Math.max(16, this.colorStage.byteLength),
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
        { binding: 1, resource: { buffer: this.colorBuf } },
      ],
    });
  }

  /** Per-facet RGBA (stride 4). */
  setFacetColors(rgba: Float32Array): void {
    this.colorStage.set(rgba.subarray(0, this.colorStage.length));
    this.device.queue.writeBuffer(this.colorBuf, 0, this.colorStage);
  }

  updateCamera(
    viewProjRte: Float32Array,
    eyeKm: readonly [number, number, number],
    gmstRad: number,
    sunUnit: readonly [number, number, number],
    opacity = 1,
  ): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const cc = eyeKm[i] ?? 0;
      const h = Math.fround(cc);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(cc - h);
    }
    this.cameraStage[24] = Math.cos(gmstRad);
    this.cameraStage[25] = Math.sin(gmstRad);
    this.cameraStage[26] = 1;
    this.cameraStage[27] = opacity;
    const alt = Math.hypot(eyeKm[0] ?? 0, eyeKm[1] ?? 0, eyeKm[2] ?? 0) - 6371;
    this.cameraStage[28] = this.bandHiKm;
    this.cameraStage[29] = this.bandLoKm;
    this.cameraStage[30] = alt;
    this.cameraStage[31] = this.wireWidthPx;
    this.cameraStage[32] = sunUnit[0] ?? 0;
    this.cameraStage[33] = sunUnit[1] ?? 0;
    this.cameraStage[34] = sunUnit[2] ?? 1;
    this.cameraStage[35] = this.facetShade;
    this.cameraStage[36] = this.flatten;
    this.cameraStage[37] = this.wireStrength;
    this.cameraStage[38] = this.limbPow;
    this.cameraStage[39] = this.limbIntensity;
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.vertexCount < 3) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuf);
    pass.draw(this.vertexCount);
  }

  dispose(): void {
    this.vertexBuf.destroy();
    this.cameraBuf.destroy();
    this.colorBuf.destroy();
  }
}
