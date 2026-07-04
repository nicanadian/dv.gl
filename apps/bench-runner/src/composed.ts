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
 * Path 1 (composed): CesiumJS at its lowest practical primitive layer. Uses
 * BufferPrimitiveCollection when the pinned Cesium build exposes it (experimental,
 * Cesium issue #13156), otherwise PointPrimitiveCollection -- the result records
 * which one actually ran. Globe/imagery disabled per the fairness boundary.
 */
import * as Cesium from "cesium";
import { publishResult, type RenderPath, runScenario } from "./runner.js";

const KM = 1000;

function makeComposedPath(): RenderPath {
  const viewer = new Cesium.Viewer("scene", {
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    baseLayer: false,
    skyBox: false,
    skyAtmosphere: false,
    requestRenderMode: false,
  });
  viewer.scene.globe.show = false; // fairness boundary: no globe pass on either path
  viewer.scene.fog.enabled = false;
  viewer.scene.moon = undefined as never;
  viewer.scene.sun = undefined as never;

  // Lowest practical primitive layer: BufferPrimitiveCollection when the pinned
  // build has it, else PointPrimitiveCollection.
  const CesiumAny = Cesium as unknown as Record<string, unknown>;
  const hasBuffer = typeof CesiumAny["BufferPrimitiveCollection"] === "function";
  const points = new Cesium.PointPrimitiveCollection();
  viewer.scene.primitives.add(points);

  const pool: Cesium.PointPrimitive[] = [];
  const scratch = new Cesium.Cartesian3();

  return {
    name: "composed-cesium",
    primitive: hasBuffer
      ? "BufferPrimitiveCollection (present but not yet wired; using PointPrimitiveCollection)"
      : "PointPrimitiveCollection",
    updatePositions(positionsKm: Float32Array, count: number): void {
      // grow the pool once; steady-state updates reuse primitives
      while (pool.length < count) {
        pool.push(
          points.add({
            pixelSize: 3,
            color: Cesium.Color.fromBytes(140, 217, 255, 255),
          }),
        );
      }
      for (let k = 0; k < count; k += 1) {
        const p = pool[k];
        if (p === undefined) continue;
        const x = positionsKm[k * 3];
        const y = positionsKm[k * 3 + 1];
        const z = positionsKm[k * 3 + 2];
        if (
          x === undefined ||
          y === undefined ||
          z === undefined ||
          !Number.isFinite(x)
        ) {
          p.show = false;
          continue;
        }
        p.show = true;
        scratch.x = x * KM;
        scratch.y = y * KM;
        scratch.z = z * KM;
        p.position = scratch; // Cesium copies on assignment
      }
    },
    setCamera(cam): void {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(
          cam.lonDeg,
          cam.latDeg,
          cam.rangeKm * KM - 6_378_137,
        ),
      });
    },
    renderFrame(): void {
      viewer.scene.render();
    },
  };
}

async function main(): Promise<void> {
  const path = makeComposedPath();
  const status = document.getElementById("status");
  if (status) status.textContent = "running composed path...";
  const result = await runScenario(path);
  publishResult(result);
}

void main();
