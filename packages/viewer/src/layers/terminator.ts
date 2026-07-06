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
 * Day/night terminator: the great circle where the Sun is on the horizon, plus a
 * subsolar-point marker so it's clear which hemisphere is lit. For EO mission
 * analysis this gates whether a collect is even valid; for power/thermal it anchors
 * eclipse entry/exit. Drawn in the inertial world (perpendicular to the Sun's ECI
 * direction), depth-tested so the far arc hides behind the globe.
 */
import { sunEciUnit } from "@dvgl/frames";
import { LineRenderer, PointRenderer } from "@dvgl/webgpu";
import type { FrameContext, Layer, LayerContext } from "../types.js";

const R_KM = 6373; // just above the ellipsoid surface
const SEG = 128;

export interface TerminatorLayerOptions {
  readonly color?: readonly [number, number, number, number];
  /** Draw the subsolar point (Sun directly overhead). Default true. */
  readonly showSubsolar?: boolean;
}

export class TerminatorLayer implements Layer {
  private ring: LineRenderer | undefined;
  private sub: PointRenderer | undefined;
  private readonly ringPos = new Float32Array(SEG * 2 * 3);
  private readonly ringCol: Float32Array;
  private readonly subPos = new Float32Array(3);
  private readonly showSubsolar: boolean;

  constructor(opts: TerminatorLayerOptions = {}) {
    const c = opts.color ?? [1, 0.78, 0.35, 0.7];
    this.showSubsolar = opts.showSubsolar ?? true;
    this.ringCol = new Float32Array(SEG * 2 * 4);
    for (let i = 0; i < SEG * 2; i += 1) this.ringCol.set(c, i * 4);
  }

  init(ctx: LayerContext): void {
    this.ring = new LineRenderer(ctx.device, {
      capacity: SEG * 2,
      format: ctx.format,
      depthFormat: ctx.depthFormat,
    });
    if (this.showSubsolar) {
      this.sub = new PointRenderer(ctx.device, {
        capacity: 1,
        format: ctx.format,
        depthFormat: ctx.depthFormat,
        pointSizePx: 9,
      });
      this.sub.setColors(new Float32Array([1, 0.92, 0.4, 1]));
    }
  }

  update(frame: FrameContext): void {
    if (!this.ring) return;
    const s = sunEciUnit(frame.epochMs + frame.timeSec * 1000);
    // orthonormal basis (u, v) spanning the plane perpendicular to the Sun direction
    const a: [number, number, number] = Math.abs(s[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let ux = a[1] * s[2] - a[2] * s[1];
    let uy = a[2] * s[0] - a[0] * s[2];
    let uz = a[0] * s[1] - a[1] * s[0];
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = s[1] * uz - s[2] * uy;
    const vy = s[2] * ux - s[0] * uz;
    const vz = s[0] * uy - s[1] * ux;
    const pt = (k: number): [number, number, number] => {
      const t = (k / SEG) * 2 * Math.PI;
      const c = Math.cos(t) * R_KM;
      const d = Math.sin(t) * R_KM;
      return [c * ux + d * vx, c * uy + d * vy, c * uz + d * vz];
    };
    let prev = pt(0);
    for (let i = 0; i < SEG; i += 1) {
      const cur = pt(i + 1);
      const p = i * 6;
      this.ringPos[p] = prev[0];
      this.ringPos[p + 1] = prev[1];
      this.ringPos[p + 2] = prev[2];
      this.ringPos[p + 3] = cur[0];
      this.ringPos[p + 4] = cur[1];
      this.ringPos[p + 5] = cur[2];
      prev = cur;
    }
    this.ring.setSegments(this.ringPos, this.ringCol, SEG);
    this.ring.updateCamera(frame.viewProjRte, frame.eyeKm); // inertial world, no spin

    if (this.sub) {
      this.subPos[0] = s[0] * R_KM;
      this.subPos[1] = s[1] * R_KM;
      this.subPos[2] = s[2] * R_KM;
      this.sub.updatePositions(this.subPos, 1);
      this.sub.updateCamera(frame.viewProjRte, frame.eyeKm, frame.width, frame.height);
    }
  }

  draw(pass: GPURenderPassEncoder): void {
    this.ring?.draw(pass);
    this.sub?.draw(pass);
  }

  dispose(): void {
    this.ring = undefined;
    this.sub = undefined;
  }
}
