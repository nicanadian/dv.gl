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

/** GPU context a layer is initialized with (all owned by the Scene). */
export interface LayerContext {
  readonly device: GPUDevice;
  readonly format: GPUTextureFormat;
  readonly depthFormat: GPUTextureFormat;
  /** Set when the Scene runs an id-pick pass; a layer may draw ids into it. */
  readonly pickFormat?: GPUTextureFormat;
}

/** Per-frame camera + time state handed to every layer's update(). */
export interface FrameContext {
  readonly viewProjRte: Float32Array;
  readonly eyeKm: readonly [number, number, number];
  /** GMST (radians) at the current scene time -- rotate ECEF geometry by this. */
  readonly gmstRad: number;
  /** Scene time in seconds since the mission epoch. */
  readonly timeSec: number;
  readonly epochMs: number;
  /** Drawable size in device pixels. */
  readonly width: number;
  readonly height: number;
}

/**
 * A composable visualization layer. The Scene owns the device, camera, clock, and
 * render loop; a layer owns its GPU resources and knows how to update + draw them.
 * Layers never touch the DOM.
 */
export interface Layer {
  /** Called once when added to a Scene. */
  init(ctx: LayerContext): void;
  /** Rebuild GPU buffers for the current frame (camera + time). */
  update(frame: FrameContext): void;
  /** Draw into the Scene's main color pass. */
  draw(pass: GPURenderPassEncoder): void;
  /** Optional: draw object ids into the pick pass (RGBA8 id-encoded). */
  drawIds?(pass: GPURenderPassEncoder): void;
  /** Optional: decode a 1x1 pick readback (RGBA bytes) to an object index, -1 = none. */
  pickDecode?(rgba: Uint8Array): number;
  /** Release GPU resources. */
  dispose(): void;
}

/** Result of a pick under the cursor. */
export interface PickHit {
  readonly index: number;
  readonly name?: string;
}
