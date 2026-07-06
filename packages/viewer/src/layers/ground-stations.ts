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
 * Ground stations as green markers plus live access lines to every satellite
 * currently above each station's elevation mask. Stations are Earth-fixed (rotated
 * into the world by GMST); the satellites come from the live Fleet.
 */
import { elevationDeg, type GroundStation, stationEcef } from "@dvgl/orbits";
import { LineRenderer, PointRenderer } from "@dvgl/webgpu";
import type { Fleet, FrameContext, Layer, LayerContext } from "../types.js";

export class GroundStationsLayer implements Layer {
  private ctx?: LayerContext;
  private readonly fleet: Fleet;
  private stations: GroundStation[] = [];
  private stEcef: ReturnType<typeof stationEcef>[] = [];
  private stMask: number[] = [];
  private stPts: PointRenderer | undefined;
  private lines: LineRenderer | undefined;
  private stationWorld?: Float32Array;
  private segPos?: Float32Array;
  private segCol?: Float32Array;

  constructor(opts: { fleet: Fleet; stations?: GroundStation[] }) {
    this.fleet = opts.fleet;
    if (opts.stations) this.setStations(opts.stations);
  }

  setStations(stations: GroundStation[]): void {
    this.stations = stations;
    this.stEcef = stations.map((s) => stationEcef(s));
    this.stMask = stations.map((s) => s.minElevationDeg ?? 5);
    if (this.ctx) this.rebuild();
  }

  init(ctx: LayerContext): void {
    this.ctx = ctx;
    if (this.stations.length) this.rebuild();
  }

  private rebuild(): void {
    if (!this.ctx) return;
    const n = this.stations.length;
    const count = this.fleet.count || 1;
    this.stPts = new PointRenderer(this.ctx.device, {
      capacity: n,
      format: this.ctx.format,
      depthFormat: this.ctx.depthFormat,
      pointSizePx: 7,
    });
    this.stPts.setColors(new Float32Array(this.stations.flatMap(() => [0.7, 1, 0.7, 1])));
    this.stationWorld = new Float32Array(n * 3);
    this.lines = new LineRenderer(this.ctx.device, {
      capacity: n * count * 2,
      format: this.ctx.format,
      depthFormat: this.ctx.depthFormat,
    });
    this.segPos = new Float32Array(n * count * 2 * 3);
    this.segCol = new Float32Array(n * count * 2 * 4);
  }

  update(frame: FrameContext): void {
    if (!this.stPts || !this.lines || !this.stationWorld || !this.segPos || !this.segCol) return;
    const cg = Math.cos(frame.gmstRad);
    const sg = Math.sin(frame.gmstRad);
    const n = this.stations.length;
    for (let i = 0; i < n; i += 1) {
      const e = this.stEcef[i]?.ecef ?? [0, 0, 0];
      this.stationWorld[i * 3] = cg * e[0] - sg * e[1]; // Rz(+gmst): ECEF -> world
      this.stationWorld[i * 3 + 1] = sg * e[0] + cg * e[1];
      this.stationWorld[i * 3 + 2] = e[2];
    }
    this.stPts.updatePositions(this.stationWorld, n);
    this.stPts.updateCamera(frame.viewProjRte, frame.eyeKm, frame.width, frame.height);

    const pos = this.fleet.positions;
    const colors = this.fleet.colors;
    const count = this.fleet.count;
    let seg = 0;
    if (pos) {
      for (let i = 0; i < n; i += 1) {
        const se = this.stEcef[i];
        if (!se) continue;
        for (let k = 0; k < count; k += 1) {
          if (colors && (colors[k * 4 + 3] ?? 1) === 0) continue;
          const x = pos[k * 3] ?? Number.NaN;
          if (!Number.isFinite(x)) continue;
          const y = pos[k * 3 + 1] ?? 0;
          const z = pos[k * 3 + 2] ?? 0;
          // world (TEME) -> ECEF via Rz(-gmst) for the topocentric elevation test
          const satEcef: [number, number, number] = [cg * x + sg * y, -sg * x + cg * y, z];
          if (elevationDeg(se, satEcef) < (this.stMask[i] ?? 5)) continue;
          const p = seg * 6;
          this.segPos[p] = this.stationWorld[i * 3] ?? 0;
          this.segPos[p + 1] = this.stationWorld[i * 3 + 1] ?? 0;
          this.segPos[p + 2] = this.stationWorld[i * 3 + 2] ?? 0;
          this.segPos[p + 3] = x;
          this.segPos[p + 4] = y;
          this.segPos[p + 5] = z;
          const cr = colors?.[k * 4] ?? 0.6;
          const cg2 = colors?.[k * 4 + 1] ?? 0.85;
          const cb = colors?.[k * 4 + 2] ?? 1;
          this.segCol.set([cr, cg2, cb, 0.8, cr, cg2, cb, 0.8], seg * 8);
          seg += 1;
        }
      }
    }
    this.lines.setSegments(this.segPos, this.segCol, seg);
    this.lines.updateCamera(frame.viewProjRte, frame.eyeKm);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.lines?.draw(pass);
    this.stPts?.draw(pass);
  }

  dispose(): void {
    this.lines = undefined;
    this.stPts = undefined;
  }
}
