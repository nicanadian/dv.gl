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
 * Scene: the DOM-independent core of a dv.gl mission view. Owns the WebGPU device
 * (or an injected one), the depth buffer, an Earth, a MissionClock, the render
 * loop, and an id-pick pass -- and orchestrates a list of composable Layers. It
 * never touches `document` or `window`: the host supplies the canvas, drives
 * resize()/start()/stop()/dispose(), and gets picks + optional controls back as
 * callbacks/disposers. This is the seam a framework (SolidJS, Three host, ...)
 * mounts.
 */
import { MissionClock } from "@dvgl/core";
import { gmst } from "@dvgl/frames";
import { EarthRenderer } from "@dvgl/webgpu";
import { OrbitCamera } from "./camera.js";
import type { FrameContext, Layer, PickHit } from "./types.js";

export interface SceneOptions {
  /** Host-owned canvas; the Scene configures the WebGPU context on it. */
  readonly canvas: HTMLCanvasElement;
  /** Reuse an existing device instead of creating one (Scene won't destroy it). */
  readonly device?: GPUDevice;
  readonly epochMs?: number;
  readonly windowSeconds?: number;
  readonly rate?: number;
  /** Co-rotate the camera with Earth so an Earth-fixed scene looks stationary. */
  readonly earthFixed?: boolean;
  /** Clear colour (RGBA 0..1). */
  readonly clearColor?: readonly [number, number, number, number];
}

const DEPTH: GPUTextureFormat = "depth24plus";
const PICK: GPUTextureFormat = "rgba8unorm";

export class Scene {
  readonly clock: MissionClock;
  readonly camera: OrbitCamera;
  earthFixed: boolean;

  private readonly canvas: HTMLCanvasElement;
  private readonly device: GPUDevice;
  private readonly ownsDevice: boolean;
  private readonly context: GPUCanvasContext;
  private readonly format: GPUTextureFormat;
  private readonly earth: EarthRenderer;
  private readonly clear: [number, number, number, number];
  private readonly layers: Layer[] = [];

  private depthTexture: GPUTexture;
  private idTexture: GPUTexture;
  private idDepth: GPUTexture;
  private readonly pickReadback: GPUBuffer;

  private raf = 0;
  private lastT = 0;
  private running = false;
  private disposed = false;

  private readonly pickCbs = new Set<(hit: PickHit | null) => void>();
  private pickX = -1;
  private pickY = -1;
  private pickPending = false;
  private pickMapping = false;

  private constructor(opts: SceneOptions, device: GPUDevice, ownsDevice: boolean) {
    this.canvas = opts.canvas;
    this.device = device;
    this.ownsDevice = ownsDevice;
    this.earthFixed = opts.earthFixed ?? false;
    this.clear = [...(opts.clearColor ?? [0.01, 0.01, 0.03, 1])] as [
      number,
      number,
      number,
      number,
    ];
    this.camera = new OrbitCamera();
    this.clock = new MissionClock({
      epochMs: opts.epochMs ?? 0,
      windowSeconds: opts.windowSeconds ?? 24 * 3600,
      rate: opts.rate ?? 60,
    });

    const context = this.canvas.getContext("webgpu");
    if (!context) throw new Error("no WebGPU canvas context");
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "opaque" });
    this.earth = new EarthRenderer(device, { format: this.format, depthFormat: DEPTH });

    this.depthTexture = this.makeDepth();
    this.idTexture = this.makeId();
    this.idDepth = this.makeDepth();
    this.pickReadback = device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  static async create(opts: SceneOptions): Promise<Scene> {
    let device = opts.device;
    let ownsDevice = false;
    if (!device) {
      if (!navigator.gpu) throw new Error("WebGPU unavailable");
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("no WebGPU adapter");
      device = await adapter.requestDevice();
      ownsDevice = true;
    }
    return new Scene(opts, device, ownsDevice);
  }

  private makeDepth(): GPUTexture {
    return this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: DEPTH,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }
  private makeId(): GPUTexture {
    return this.device.createTexture({
      size: [this.canvas.width, this.canvas.height],
      format: PICK,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
  }

  add(layer: Layer): this {
    layer.init({ device: this.device, format: this.format, depthFormat: DEPTH, pickFormat: PICK });
    this.layers.push(layer);
    return this;
  }

  remove(layer: Layer): void {
    const i = this.layers.indexOf(layer);
    if (i >= 0) {
      this.layers.splice(i, 1);
      layer.dispose();
    }
  }

  /** Show/hide the base Earth's lat/lon graticule. */
  setGraticule(visible: boolean): void {
    this.earth.setGridVisible(visible);
  }

  /** Show/hide the base Earth's shaded ellipsoid surface. Hide it when a custom opaque
   * earth substrate (e.g. a low-poly mesh) owns the surface, to avoid z-fighting. */
  setBaseSurface(visible: boolean): void {
    this.earth.setSurfaceVisible(visible);
  }

  /** Resize the drawable (device pixels). Call after the host resizes the canvas. */
  resize(widthPx: number, heightPx: number): void {
    if (this.canvas.width === widthPx && this.canvas.height === heightPx) return;
    this.canvas.width = Math.max(1, widthPx);
    this.canvas.height = Math.max(1, heightPx);
    this.depthTexture.destroy();
    this.idTexture.destroy();
    this.idDepth.destroy();
    this.depthTexture = this.makeDepth();
    this.idTexture = this.makeId();
    this.idDepth = this.makeDepth();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const l of this.layers) l.dispose();
    this.layers.length = 0;
    this.depthTexture.destroy();
    this.idTexture.destroy();
    this.idDepth.destroy();
    this.pickReadback.destroy();
    if (this.ownsDevice) this.device.destroy();
  }

  /** Subscribe to picks (object under the cursor, or null). Returns an unsubscribe. */
  onPick(cb: (hit: PickHit | null) => void): () => void {
    this.pickCbs.add(cb);
    return () => this.pickCbs.delete(cb);
  }

  /** Queue an id-pick at a device-pixel coordinate; result arrives via onPick. */
  pickAt(xDevicePx: number, yDevicePx: number): void {
    this.pickX = Math.round(xDevicePx);
    this.pickY = Math.round(yDevicePx);
    this.pickPending = true;
  }

  /**
   * Attach default mouse orbit + wheel zoom + hover-pick to an element (usually the
   * canvas). Opt-in and DOM-scoped: returns a disposer that removes every listener.
   * A headless/framework host can skip this and drive camera/pick itself.
   */
  attachControls(el: HTMLElement): () => void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    const down = (e: PointerEvent): void => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    };
    const move = (e: PointerEvent): void => {
      const dpr = this.canvas.width / (el.clientWidth || 1);
      this.pickAt(e.offsetX * dpr, e.offsetY * dpr);
      if (!dragging) return;
      this.camera.orbit((e.clientX - lastX) * 0.25, (e.clientY - lastY) * 0.25);
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const up = (): void => {
      dragging = false;
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      this.camera.zoom(1 + e.deltaY * 0.001);
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("wheel", wheel);
    };
  }

  private readonly loop = (): void => {
    if (!this.running) return;
    const now = performance.now();
    const dt = (now - this.lastT) / 1000;
    this.lastT = now;
    if (this.clock.playing) this.clock.advance(dt);
    this.renderOnce();
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Advance nothing; just render the current clock state (useful when paused). */
  renderOnce(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const gmstRad = gmst(this.clock.currentUnixMs());
    const extraLonDeg = this.earthFixed ? (gmstRad * 180) / Math.PI : 0;
    const { viewProjRte, eyeKm } = this.camera.frame(w / h, extraLonDeg);
    this.earth.updateCamera(viewProjRte, eyeKm, gmstRad);

    const frame: FrameContext = {
      viewProjRte,
      eyeKm,
      gmstRad,
      timeSec: this.clock.currentSeconds,
      epochMs: this.clock.epochMs,
      width: w,
      height: h,
    };
    for (const l of this.layers) l.update(frame);

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: this.clear[0], g: this.clear[1], b: this.clear[2], a: this.clear[3] },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    });
    this.earth.draw(pass);
    for (const l of this.layers) l.draw(pass);
    pass.end();

    // id-pick pass: only when a pick is queued and no readback is in flight
    let picker: Layer | undefined;
    if (
      this.pickPending &&
      !this.pickMapping &&
      this.pickX >= 0 &&
      this.pickY >= 0 &&
      this.pickX < w &&
      this.pickY < h
    ) {
      picker = this.layers.find((l) => l.drawIds && l.pickDecode);
      if (picker) {
        const idPass = encoder.beginRenderPass({
          colorAttachments: [
            {
              view: this.idTexture.createView(),
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            },
          ],
          depthStencilAttachment: {
            view: this.idDepth.createView(),
            depthClearValue: 1,
            depthLoadOp: "clear",
            depthStoreOp: "store",
          },
        });
        for (const l of this.layers) l.drawIds?.(idPass);
        idPass.end();
        encoder.copyTextureToBuffer(
          { texture: this.idTexture, origin: { x: this.pickX, y: this.pickY } },
          { buffer: this.pickReadback, bytesPerRow: 256 },
          { width: 1, height: 1 },
        );
        this.pickPending = false;
        this.pickMapping = true;
      }
    }

    this.device.queue.submit([encoder.finish()]);

    if (this.pickMapping && picker) {
      const layer = picker;
      this.pickReadback.mapAsync(GPUMapMode.READ).then(() => {
        const rgba = new Uint8Array(this.pickReadback.getMappedRange().slice(0, 4));
        this.pickReadback.unmap();
        this.pickMapping = false;
        const index = layer.pickDecode?.(rgba) ?? -1;
        const names = (layer as { names?: readonly string[] }).names;
        const hit: PickHit | null =
          index >= 0 ? { index, ...(names?.[index] ? { name: names[index] } : {}) } : null;
        for (const cb of this.pickCbs) cb(hit);
      });
    }
  }
}
