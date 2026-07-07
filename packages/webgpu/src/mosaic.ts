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
 * Stylized "mosaic" Earth renderer (spike). A faceted, opaque quadsphere shaded as a
 * shaded-relief cartographic instrument (Direction A) with cloisonne machinery
 * (Direction B): flat per-facet base color from a swappable per-facet DATA buffer,
 * `fwidth`-grout seams between tiles, a SMOOTH per-fragment sun-dot terminator (never
 * staircased), one ocean glint, and an analytic fresnel limb — no imagery, no
 * scattering. The per-facet data buffer is the "strategic unlock": rewrite it +
 * flip a ramp and the same tessellation becomes a coverage/heat choropleth.
 *
 * Vertex layout (Earth-fixed ECEF km, spun to inertial in-shader by Rz(gmst)):
 *   pos(3) · facetNormal(3, flat) · facetId(1) · quadUV(2)   -> stride 36 B
 * Per-facet data (storage, dynamic): vec2(landMask 0/1, scalar 0..1) indexed by facetId.
 */

export const MOSAIC_WGSL = /* wgsl */ `
struct Camera {
  viewProjRte : mat4x4<f32>,
  eyeHigh     : vec4<f32>,
  eyeLow      : vec4<f32>,
  params      : vec4<f32>, // gmst, timeSec, mode(0=cartographic,1=data,2=direct), opacity
};
struct Style {
  sun          : vec4<f32>, // xyz inertial sun dir
  nightFloor   : vec4<f32>, // rgb, blend
  limb         : vec4<f32>, // rgb, power
  grout        : vec4<f32>, // rgb tint, strength
  knobs        : vec4<f32>, // jitterAmp, facetShade, glint, groutWidth
  oceanShallow : vec4<f32>,
  oceanDeep    : vec4<f32>,
  landRamp     : array<vec4<f32>, 6>,
  dataRamp     : array<vec4<f32>, 6>,
};

@group(0) @binding(0) var<uniform> cam : Camera;
@group(0) @binding(1) var<uniform> st  : Style;
@group(0) @binding(2) var<storage, read> facetData  : array<vec2<f32>>;
@group(0) @binding(3) var<storage, read> facetColor : array<vec4<f32>>;

struct VsOut {
  @builtin(position) clip : vec4<f32>,
  @location(0) @interpolate(flat) normal : vec3<f32>,
  @location(1) @interpolate(flat) facet  : u32,
  @location(2) world : vec3<f32>,   // inertial, for smooth normal / sun / fresnel
  @location(3) quv   : vec2<f32>,   // cell-corner coords in [0,1]^2 for grout
};

fn spin(v : vec3<f32>, c : f32, s : f32) -> vec3<f32> {
  return vec3<f32>(c * v.x - s * v.y, s * v.x + c * v.y, v.z);
}

@vertex
fn vs(
  @location(0) pos : vec3<f32>,
  @location(1) fn_ : vec3<f32>,
  @location(2) fid : f32,
  @location(3) quv : vec2<f32>,
) -> VsOut {
  let c = cos(cam.params.x);
  let s = sin(cam.params.x);
  let p = spin(pos, c, s);
  let n = spin(fn_, c, s);
  let rel = (p - cam.eyeHigh.xyz) + (vec3<f32>(0.0) - cam.eyeLow.xyz);
  var o : VsOut;
  o.clip = cam.viewProjRte * vec4<f32>(rel, 1.0);
  o.normal = n;
  o.facet = u32(fid + 0.5);
  o.world = p;
  o.quv = quv;
  return o;
}

fn rampSample(r : ptr<function, array<vec4<f32>, 6>>, t : f32) -> vec3<f32> {
  let x = clamp(t, 0.0, 1.0) * 5.0;
  let i = u32(floor(x));
  let j = min(i + 1u, 5u);
  return mix((*r)[i].rgb, (*r)[j].rgb, fract(x));
}

// cheap hash -> [-1,1], stable per facet id
fn hash1(n : u32) -> f32 {
  var h = n * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  h = (h >> 22u) ^ h;
  return (f32(h & 0xffffu) / 32767.5) - 1.0;
}

@fragment
fn fs(in : VsOut) -> @location(0) vec4<f32> {
  let d = facetData[in.facet];
  let isLand = d.x > 0.5;
  let scalar = d.y;
  let mode = cam.params.z;

  // --- base color -----------------------------------------------------------
  var land = st.landRamp;
  var data = st.dataRamp;
  var base : vec3<f32>;
  if (mode > 1.5) {
    // direct per-facet RGB (CPU-computed palette color, already jittered) — low-poly
    base = facetColor[in.facet].rgb;
  } else {
    if (isLand) {
      if (mode > 0.5) {
        base = rampSample(&data, scalar);         // data-substrate choropleth
      } else {
        base = rampSample(&land, scalar);         // hypsometric relief
      }
    } else {
      base = mix(st.oceanShallow.rgb, st.oceanDeep.rgb, scalar);
    }
    // value-only per-facet jitter (tiles read as "cut", not as false biome/coverage)
    base *= 1.0 + hash1(in.facet) * st.knobs.x;
  }

  // faint faceted-crystal read: flat facet normal vs sun
  let sun = normalize(st.sun.xyz);
  let facetLit = 0.5 + 0.5 * dot(normalize(in.normal), sun);
  base *= 1.0 - st.knobs.y + st.knobs.y * facetLit;

  // --- smooth day/night terminator (per-fragment, NEVER faceted) ------------
  let sN = normalize(in.world);
  let dayness = smoothstep(-0.12, 0.12, dot(sN, sun));
  let nightCol = mix(base * 0.10, st.nightFloor.rgb, st.nightFloor.w);
  var col = mix(nightCol, base, dayness);

  // one ocean glint tracking the subsolar point (the entire "idle life", free)
  let eyeAbs = cam.eyeHigh.xyz + cam.eyeLow.xyz;
  let viewDir = normalize(eyeAbs - in.world);
  if (!isLand) {
    let spec = pow(max(dot(reflect(-sun, sN), viewDir), 0.0), 48.0);
    col += vec3<f32>(0.9, 0.95, 1.0) * spec * st.knobs.z * dayness;
  }

  // --- cloisonne grout: darken a thin seam around each cell (no geometry) ----
  let e = min(min(in.quv.x, 1.0 - in.quv.x), min(in.quv.y, 1.0 - in.quv.y));
  let w = fwidth(min(in.quv.x, in.quv.y)) * st.knobs.w;
  let g = 1.0 - smoothstep(0.0, max(w, 1e-5), e);
  col = mix(col, col * st.grout.rgb, g * st.grout.w);

  // --- analytic fresnel limb ring -------------------------------------------
  let rim = pow(1.0 - max(dot(sN, viewDir), 0.0), st.limb.w);
  col += st.limb.rgb * rim;

  return vec4<f32>(col, cam.params.w); // opacity: 1 opaque; <1 for LOD crossfade
}
`;

export interface MosaicEarthRendererOptions {
  readonly format: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  /** Per-vertex: pos(3)+facetNormal(3)+facetId(1)+quadUV(2), stride 36 B, Earth-fixed km. */
  readonly vertices: Float32Array<ArrayBuffer>;
  /** Facet count (pos count / 6). */
  readonly facetCount: number;
  /** When true: alpha-blend + no depth write (for LOD crossfade over an opaque base). */
  readonly blend?: boolean;
}

const STYLE_FLOATS = 4 * 7 + 4 * 6 + 4 * 6; // sun..oceanDeep(7 vec4) + 2 ramps(6 vec4 each)

/** Default shaded-relief cartographic style (Imhof/Patterson muted, panel-directed). */
export function defaultMosaicStyle(): Float32Array<ArrayBuffer> {
  const s = new Float32Array(STYLE_FLOATS);
  const set = (off: number, r: number, g: number, b: number, a = 0) => {
    s[off] = r;
    s[off + 1] = g;
    s[off + 2] = b;
    s[off + 3] = a;
  };
  set(0, 0.6, 0.35, 0.4); // sun (overwritten per-frame)
  set(4, 0.039, 0.078, 0.125, 0.85); // night floor indigo + blend
  set(8, 0.35, 0.62, 0.85, 3.2); // limb rgb + power
  set(12, 0.42, 0.47, 0.52, 0.6); // grout tint (darken) + strength
  set(16, 0.05, 0.18, 0.5, 1.3); // knobs: jitter, facetShade, glint, groutWidth
  set(20, 0.12, 0.29, 0.36); // ocean shallow slate-teal
  set(24, 0.043, 0.102, 0.157); // ocean deep abyssal indigo
  // land hypsometric ramp: lowland olive -> upland taupe -> pale grey-violet
  const land = [
    [0.184, 0.227, 0.157],
    [0.243, 0.29, 0.204],
    [0.333, 0.345, 0.247],
    [0.42, 0.392, 0.333],
    [0.514, 0.486, 0.42],
    [0.604, 0.627, 0.678],
  ];
  land.forEach((c, i) => {
    set(28 + i * 4, c[0] as number, c[1] as number, c[2] as number);
  });
  // data-substrate ramp: cool low -> warm high (coverage/heat)
  const data = [
    [0.05, 0.09, 0.16],
    [0.1, 0.24, 0.42],
    [0.13, 0.45, 0.55],
    [0.35, 0.68, 0.62],
    [0.85, 0.72, 0.3],
    [0.98, 0.55, 0.25],
  ];
  data.forEach((c, i) => {
    set(52 + i * 4, c[0] as number, c[1] as number, c[2] as number);
  });
  return s;
}

export class MosaicEarthRenderer {
  private readonly device: GPUDevice;
  private readonly pipeline: GPURenderPipeline;
  private readonly bindGroup: GPUBindGroup;
  private readonly cameraBuf: GPUBuffer;
  private readonly styleBuf: GPUBuffer;
  private readonly facetBuf: GPUBuffer;
  private readonly colorBuf: GPUBuffer;
  private readonly vertexBuf: GPUBuffer;
  private readonly vertexCount: number;
  readonly facetCount: number;
  private readonly cameraStage = new Float32Array(16 + 4 + 4 + 4);
  private readonly styleStage: Float32Array<ArrayBuffer>;
  private readonly facetStage: Float32Array<ArrayBuffer>; // vec2 per facet
  private readonly colorStage: Float32Array<ArrayBuffer>; // vec4 per facet (direct mode)
  private colorMode = 0; // 0=cartographic ramp, 1=data ramp, 2=direct facetColor

  constructor(device: GPUDevice, opts: MosaicEarthRendererOptions) {
    this.device = device;
    this.facetCount = opts.facetCount;
    this.vertexCount = opts.vertices.length / 9;
    this.styleStage = defaultMosaicStyle();
    this.facetStage = new Float32Array(opts.facetCount * 2);
    this.colorStage = new Float32Array(opts.facetCount * 4);

    this.vertexBuf = device.createBuffer({
      size: opts.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.vertexBuf, 0, opts.vertices);

    const module = device.createShaderModule({ code: MOSAIC_WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: 36,
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32" },
              { shaderLocation: 3, offset: 28, format: "float32x2" },
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
            ...(opts.blend
              ? {
                  blend: {
                    color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
                    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
                  },
                }
              : {}),
          },
        ],
      },
      // cullMode none: robust to per-cube-face winding; the closed opaque sphere +
      // depth test still hides the far hemisphere.
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: {
        format: opts.depthFormat,
        depthWriteEnabled: !opts.blend,
        depthCompare: "less",
      },
    });

    this.cameraBuf = device.createBuffer({
      size: this.cameraStage.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.styleBuf = device.createBuffer({
      size: this.styleStage.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.facetBuf = device.createBuffer({
      size: Math.max(16, this.facetStage.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.colorBuf = device.createBuffer({
      size: Math.max(16, this.colorStage.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.styleBuf, 0, this.styleStage);
    device.queue.writeBuffer(this.facetBuf, 0, this.facetStage);
    device.queue.writeBuffer(this.colorBuf, 0, this.colorStage);

    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuf } },
        { binding: 1, resource: { buffer: this.styleBuf } },
        { binding: 2, resource: { buffer: this.facetBuf } },
        { binding: 3, resource: { buffer: this.colorBuf } },
      ],
    });
  }

  /** Per-facet (landMask 0/1, scalar 0..1). Rewrite any frame to restyle/re-encode. */
  setFacetData(landMaskAndScalar: Float32Array): void {
    this.facetStage.set(landMaskAndScalar.subarray(0, this.facetStage.length));
    this.device.queue.writeBuffer(this.facetBuf, 0, this.facetStage);
  }

  /** Overwrite just the per-facet scalar (keep land mask) — the data-substrate path. */
  setScalar(scalar: Float32Array): void {
    for (let i = 0; i < this.facetCount; i += 1) this.facetStage[i * 2 + 1] = scalar[i] ?? 0;
    this.device.queue.writeBuffer(this.facetBuf, 0, this.facetStage);
  }

  /** Replace the full style block (see defaultMosaicStyle for the float layout). */
  setStyle(style: Float32Array): void {
    this.styleStage.set(style.subarray(0, this.styleStage.length));
    this.device.queue.writeBuffer(this.styleBuf, 0, this.styleStage);
  }

  /**
   * Per-facet RGBA color for direct mode (low-poly palettes): the shader uses this
   * verbatim as the base color (still lit by facet-normal + terminator). Also switches
   * the renderer into direct-color mode. Rewrite to repaint / swap palette live.
   */
  setFacetColors(rgba: Float32Array): void {
    this.colorStage.set(rgba.subarray(0, this.colorStage.length));
    this.device.queue.writeBuffer(this.colorBuf, 0, this.colorStage);
    this.colorMode = 2;
  }

  updateCamera(
    viewProjRte: Float32Array,
    eyeKm: readonly [number, number, number],
    gmstRad: number,
    sunUnit: readonly [number, number, number],
    timeSec = 0,
    mode: number = this.colorMode,
    opacity = 1,
  ): void {
    this.cameraStage.set(viewProjRte, 0);
    for (let i = 0; i < 3; i += 1) {
      const c = eyeKm[i] ?? 0;
      const h = Math.fround(c);
      this.cameraStage[16 + i] = h;
      this.cameraStage[20 + i] = Math.fround(c - h);
    }
    this.cameraStage[24] = gmstRad;
    this.cameraStage[25] = timeSec;
    this.cameraStage[26] = mode;
    this.cameraStage[27] = opacity;
    this.device.queue.writeBuffer(this.cameraBuf, 0, this.cameraStage);
    this.styleStage[0] = sunUnit[0] ?? 0;
    this.styleStage[1] = sunUnit[1] ?? 0;
    this.styleStage[2] = sunUnit[2] ?? 1;
    this.device.queue.writeBuffer(this.styleBuf, 0, this.styleStage, 0, 4);
  }

  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuf);
    pass.draw(this.vertexCount);
  }

  dispose(): void {
    this.vertexBuf.destroy();
    this.cameraBuf.destroy();
    this.styleBuf.destroy();
    this.facetBuf.destroy();
    this.colorBuf.destroy();
  }
}
