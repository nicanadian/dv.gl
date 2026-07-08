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
 * A minimal WGS84 ellipsoid: shaded surface plus a lat/lon graticule. Deliberately
 * NOT a globe engine -- no imagery, no terrain (stated non-goals). It exists so
 * orbits read against the planet and so depth-tested occlusion works.
 *
 * The mesh is authored in an Earth-FIXED frame; a GMST rotation uniform spins it in
 * inertial views, which keeps it consistent with the earth-fixed camera mode (both
 * rotate together, so the globe appears stationary there).
 */

export const EARTH_A_KM = 6378.137;
export const EARTH_B_KM = 6356.7523142;

export interface EllipsoidMesh {
  /** Interleaved position(3) + normal(3), fp32, km. */
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly graticuleVertices: Float32Array<ArrayBuffer>;
}

/**
 * Build the ellipsoid mesh (UV sphere scaled to WGS84) and a graticule line list
 * every `gridDeg` degrees, slightly raised to avoid z-fighting with the surface.
 */
export function buildEllipsoid(latSegments = 48, lonSegments = 96, gridDeg = 15): EllipsoidMesh {
  const verts: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= latSegments; i += 1) {
    const lat = Math.PI / 2 - (i / latSegments) * Math.PI;
    const cl = Math.cos(lat);
    const sl = Math.sin(lat);
    for (let j = 0; j <= lonSegments; j += 1) {
      const lon = (j / lonSegments) * 2 * Math.PI;
      const x = cl * Math.cos(lon);
      const y = cl * Math.sin(lon);
      const z = sl;
      verts.push(EARTH_A_KM * x, EARTH_A_KM * y, EARTH_B_KM * z);
      // ellipsoid normal: scale by inverse squared radii, normalized
      const nx = x / EARTH_A_KM;
      const ny = y / EARTH_A_KM;
      const nz = z / EARTH_B_KM;
      const nl = Math.hypot(nx, ny, nz) || 1;
      verts.push(nx / nl, ny / nl, nz / nl);
    }
  }
  const stride = lonSegments + 1;
  for (let i = 0; i < latSegments; i += 1) {
    for (let j = 0; j < lonSegments; j += 1) {
      const a = i * stride + j;
      const b = a + stride;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  // graticule as a line list, radius bumped 0.15% to sit above the surface
  const g: number[] = [];
  const bump = 1.0015;
  const seg = 128;
  for (let latDeg = -75; latDeg <= 75; latDeg += gridDeg) {
    const lat = (latDeg * Math.PI) / 180;
    for (let s = 0; s < seg; s += 1) {
      for (const t of [s / seg, (s + 1) / seg]) {
        const lon = t * 2 * Math.PI;
        g.push(
          bump * EARTH_A_KM * Math.cos(lat) * Math.cos(lon),
          bump * EARTH_A_KM * Math.cos(lat) * Math.sin(lon),
          bump * EARTH_B_KM * Math.sin(lat),
        );
      }
    }
  }
  for (let lonDeg = 0; lonDeg < 360; lonDeg += gridDeg) {
    const lon = (lonDeg * Math.PI) / 180;
    for (let s = 0; s < seg; s += 1) {
      for (const t of [s / seg, (s + 1) / seg]) {
        const lat = -Math.PI / 2 + t * Math.PI;
        g.push(
          bump * EARTH_A_KM * Math.cos(lat) * Math.cos(lon),
          bump * EARTH_A_KM * Math.cos(lat) * Math.sin(lon),
          bump * EARTH_B_KM * Math.sin(lat),
        );
      }
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(idx),
    graticuleVertices: new Float32Array(g),
  };
}

export const EARTH_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,
  eyeHigh     : vec4<f32>,
  eyeLow      : vec4<f32>,
  // gmst radians, isGraticule, unused, unused
  params      : vec4<f32>,
};

@group(0) @binding(0) var<uniform> cam : Camera;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) normal : vec3<f32>,
  @location(1) isGrid : f32,
};

@vertex
fn vs(@location(0) pos : vec3<f32>, @location(1) normal : vec3<f32>) -> VsOut {
  // spin the earth-fixed mesh to the inertial frame: Rz(gmst)
  let c = cos(cam.params.x);
  let s = sin(cam.params.x);
  let p = vec3<f32>(c * pos.x - s * pos.y, s * pos.x + c * pos.y, pos.z);
  let n = vec3<f32>(c * normal.x - s * normal.y, s * normal.x + c * normal.y, normal.z);
  // RTE with a single split of the (km-scale) vertex: high = p (fp32 exact enough
  // for a static mesh), eye split carries the precision
  let rel = (p - cam.eyeHigh.xyz) + (vec3<f32>(0.0) - cam.eyeLow.xyz);
  var out : VsOut;
  out.clip = cam.viewProjRte * vec4<f32>(rel, 1.0);
  out.normal = n;
  out.isGrid = cam.params.y;
  return out;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  if (in.isGrid > 0.5) {
    return vec4<f32>(0.22, 0.38, 0.55, 1.0);
  }
  // fixed-direction lambert with an ambient floor: legibility, not realism
  let sun = normalize(vec3<f32>(0.6, 0.35, 0.4));
  let lit = 0.35 + 0.65 * max(dot(normalize(in.normal), sun), 0.0);
  return vec4<f32>(0.10 * lit, 0.22 * lit, 0.38 * lit, 1.0);
}
`;

export interface EarthRendererOptions {
  readonly format: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
}

export class EarthRenderer {
  private readonly device: GPUDevice;
  private readonly surfacePipeline: GPURenderPipeline;
  private readonly gridPipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly gridBindGroup: GPUBindGroup;
  private readonly cameraBuf: GPUBuffer;
  private readonly gridCameraBuf: GPUBuffer;
  private readonly vertexBuf: GPUBuffer;
  private readonly indexBuf: GPUBuffer;
  private readonly gridVertexBuf: GPUBuffer;
  private readonly indexCount: number;
  private readonly gridVertexCount: number;
  private readonly cameraStage = new Float32Array(16 + 4 + 4 + 4);

  constructor(device: GPUDevice, opts: EarthRendererOptions) {
    this.device = device;
    const mesh = buildEllipsoid();
    this.indexCount = mesh.indices.length;
    this.gridVertexCount = mesh.graticuleVertices.length / 3;

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
    this.gridVertexBuf = device.createBuffer({
      size: mesh.graticuleVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.gridVertexBuf, 0, mesh.graticuleVertices);

    const module = device.createShaderModule({ code: EARTH_WGSL });
    const surfaceLayout: GPUVertexBufferLayout = {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 12, format: "float32x3" },
      ],
    };
    const gridLayout: GPUVertexBufferLayout = {
      arrayStride: 12,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" },
        { shaderLocation: 1, offset: 0, format: "float32x3" }, // unused normal alias
      ],
    };
    const depthStencil: GPUDepthStencilState = {
      format: opts.depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less",
    };
    this.surfacePipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs", buffers: [surfaceLayout] },
      fragment: { module, entryPoint: "fs", targets: [{ format: opts.format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil,
    });
    this.gridPipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs", buffers: [gridLayout] },
      fragment: { module, entryPoint: "fs", targets: [{ format: opts.format }] },
      primitive: { topology: "line-list" },
      depthStencil,
    });

    this.cameraBuf = device.createBuffer({
      size: this.cameraStage.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.gridCameraBuf = device.createBuffer({
      size: this.cameraStage.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: this.surfacePipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.cameraBuf } }],
    });
    this.gridBindGroup = device.createBindGroup({
      layout: this.gridPipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.gridCameraBuf } }],
    });
  }

  updateCamera(
    viewProjRte: Float32Array,
    eyeKm: readonly [number, number, number],
    gmstRad: number,
  ): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(c - h);
    }
    this.cameraStage[24] = gmstRad;
    this.cameraStage[25] = 0; // surface
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
    this.cameraStage[25] = 1; // graticule
    this.device.queue.writeBuffer(this.gridCameraBuf, 0, this.cameraStage);
  }

  private gridVisible = true;
  private surfaceVisible = true;

  /** Show/hide the lat/lon graticule (e.g. when a custom earth substrate owns the look). */
  setGridVisible(v: boolean): void {
    this.gridVisible = v;
  }

  /** Show/hide the shaded ellipsoid surface — hide it when a custom opaque earth
   * substrate (e.g. a low-poly mesh) provides the surface, to avoid z-fighting. */
  setSurfaceVisible(v: boolean): void {
    this.surfaceVisible = v;
  }

  draw(pass: GPURenderPassEncoder): void {
    if (this.surfaceVisible) {
      pass.setPipeline(this.surfacePipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.vertexBuf);
      pass.setIndexBuffer(this.indexBuf, "uint32");
      pass.drawIndexed(this.indexCount);
    }
    if (!this.gridVisible) return;
    pass.setPipeline(this.gridPipeline);
    pass.setBindGroup(0, this.gridBindGroup);
    pass.setVertexBuffer(0, this.gridVertexBuf);
    pass.draw(this.gridVertexCount);
  }
}
