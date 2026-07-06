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
 * Coverage = age-of-collection ("did see, how recently"), a viridis field draped on
 * the globe. Collect-driven: the revisit grid rebuilds from completed collects each
 * frame (stamp each target at its completion time), so the field only shows what was
 * actually collected -- and reacts correctly to scrubbing.
 */
import { type Collect, RevisitGrid } from "@dvgl/orbits";
import { CoverageOverlay } from "@dvgl/webgpu";
import type { FrameContext, Layer, LayerContext } from "../types.js";

const N_LAT = 120;
const N_LON = 240;
const EARTH_R_KM = 6371.0088;

export interface CoverageLayerOptions {
  readonly collects?: readonly Collect[];
  /** Age ramp saturates after this many hours since the last look. Default 6. */
  readonly windowHours?: number;
  /** Radius (km) each completed collect lights up in the grid. Default 90. */
  readonly stampRadiusKm?: number;
}

export class CoverageLayer implements Layer {
  private overlay: CoverageOverlay | undefined;
  private readonly grid = new RevisitGrid(N_LAT, N_LON);
  private readonly ageBuf = new Uint8Array(N_LAT * N_LON);
  private collects: readonly Collect[] = [];
  private readonly windowMin: number;
  private readonly capRad: number;

  constructor(opts: CoverageLayerOptions = {}) {
    this.windowMin = (opts.windowHours ?? 6) * 60;
    this.capRad = (opts.stampRadiusKm ?? 90) / EARTH_R_KM;
    if (opts.collects) this.collects = opts.collects;
  }

  setCollects(collects: readonly Collect[]): void {
    this.collects = collects;
  }

  init(ctx: LayerContext): void {
    this.overlay = new CoverageOverlay(ctx.device, {
      mode: "sphere",
      gridW: N_LON,
      gridH: N_LAT,
      format: ctx.format,
      depthFormat: ctx.depthFormat,
      alpha: 0.55,
      steps: 6,
    });
  }

  update(frame: FrameContext): void {
    if (!this.overlay) return;
    const nowSec = frame.timeSec;
    this.grid.reset();
    for (const c of this.collects) {
      if (c.endSec <= nowSec)
        this.grid.stamp(c.targetLatDeg, c.targetLonDeg, this.capRad, c.endSec / 60);
    }
    this.grid.ageTexture(nowSec / 60, this.windowMin, this.ageBuf);
    this.overlay.setField(this.ageBuf);
    this.overlay.updateCamera(frame.viewProjRte, frame.eyeKm, frame.gmstRad);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.overlay?.draw(pass);
  }

  dispose(): void {
    this.overlay = undefined;
  }
}
