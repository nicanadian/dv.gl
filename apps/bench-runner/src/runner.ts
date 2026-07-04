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
 * Shared benchmark driver. Both pages implement RenderPath; everything else --
 * catalog load, the shared propagation source, the scripted camera/scrub timeline,
 * metric collection, results download -- is identical by construction, which is the
 * point (docs/benchmark-fairness.md).
 */
import {
  cameraAt,
  FrameTimeRecorder,
  ScrubLatencyProbe,
  stage0Scenario,
} from "@dvgl/benchmarks";
import { catalogEpochMs, parseCatalog, SatelliteJsSource } from "@dvgl/orbits";

export interface CameraState {
  readonly rangeKm: number;
  readonly lonDeg: number;
  readonly latDeg: number;
}

/** What each page must implement. Everything else is shared. */
export interface RenderPath {
  readonly name: string;
  /** Which primitive/API layer is actually in use (for the results metadata). */
  readonly primitive: string;
  /** Consume freshly propagated positions (km TEME, stride 3, NaN = failed). */
  updatePositions(positionsKm: Float32Array, count: number): void;
  setCamera(cam: CameraState): void;
  /** Render one frame; resolve when the frame has been submitted. */
  renderFrame(): void;
}

export interface RunResult {
  readonly path: string;
  readonly primitive: string;
  readonly scenario: string;
  readonly catalogSource: string;
  readonly catalogSha256: string;
  readonly objectCount: number;
  readonly rejectedCount: number;
  readonly propagationSource: string;
  readonly frame: ReturnType<FrameTimeRecorder["stats"]>;
  readonly scrubLatenciesMs: readonly number[];
  readonly scrubP95Ms: number;
  readonly measurementSeconds: number;
  readonly userAgent: string;
}

const MEASUREMENT_SECONDS = 60;

export async function loadSharedWorkload(): Promise<{
  source: SatelliteJsSource;
  positions: Float32Array;
  catalogSource: string;
  catalogSha256: string;
}> {
  const resp = await fetch("./catalog.json");
  if (!resp.ok) {
    throw new Error(
      `catalog.json missing (${resp.status}). Run scripts/fetch-catalog.mjs or use the committed sample.`,
    );
  }
  const catalog = parseCatalog(await resp.text());
  const epochMs = catalogEpochMs(catalog.objects);
  const source = new SatelliteJsSource(catalog.objects, epochMs);
  if (source.rejected.length > 0) {
    console.warn(`catalog: rejected ${source.rejected.length} invalid TLEs`);
  }
  return {
    source,
    positions: new Float32Array(source.count * 3),
    catalogSource: catalog.source,
    catalogSha256: catalog.sha256,
  };
}

/** Run the scripted Stage 0 measurement against one path. Returns the result. */
export async function runScenario(path: RenderPath): Promise<RunResult> {
  const { source, positions, catalogSource, catalogSha256 } =
    await loadSharedWorkload();
  const scenario = stage0Scenario;
  const recorder = new FrameTimeRecorder();
  const probe = new ScrubLatencyProbe();

  let sceneMinutes = 0; // scene time within the 7-day window, minutes from epoch
  let scrubIdx = 0;
  const t0 = performance.now();

  const propagateAndPush = (): void => {
    source.propagateInto(sceneMinutes, positions);
    path.updatePositions(positions, source.count);
  };
  propagateAndPush();

  return await new Promise<RunResult>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      const tSec = (now - t0) / 1000;

      // scripted scrubs: apply every event whose time has come
      let scrubbed = false;
      while (scrubIdx < scenario.scrubs.length) {
        const ev = scenario.scrubs[scrubIdx];
        if (ev === undefined || ev.tSeconds > tSec) break;
        sceneMinutes = (ev.windowFraction * scenario.windowSeconds) / 60;
        probe.scrubInput(now);
        scrubbed = true;
        scrubIdx += 1;
      }
      if (scrubbed) propagateAndPush();

      const kf = cameraAt(scenario, tSec);
      path.setCamera({
        rangeKm: kf.rangeMeters / 1000,
        lonDeg: kf.lonDeg,
        latDeg: kf.latDeg,
      });
      path.renderFrame();

      const after = performance.now();
      recorder.frame(after);
      probe.framePresented(after);

      if (tSec < MEASUREMENT_SECONDS) {
        requestAnimationFrame(tick);
      } else {
        resolve({
          path: path.name,
          primitive: path.primitive,
          scenario: scenario.name,
          catalogSource,
          catalogSha256,
          objectCount: source.count,
          rejectedCount: source.rejected.length,
          propagationSource: "satellite.js CPU (shared, fp64) -- sgp4.gl planned",
          frame: recorder.stats(),
          scrubLatenciesMs: [...probe.samples()],
          scrubP95Ms: probe.p95Ms(),
          measurementSeconds: MEASUREMENT_SECONDS,
          userAgent: navigator.userAgent,
        });
      }
    };
    requestAnimationFrame(tick);
  });
}

/** Download the result as JSON and print it, so nothing is lost either way. */
export function publishResult(result: RunResult): void {
  console.log("BENCH RESULT", result);
  const blob = new Blob([JSON.stringify(result, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${result.path}-${result.scenario}.json`;
  a.click();
  const el = document.getElementById("status");
  if (el) {
    el.textContent =
      `${result.path}: p95 frame ${result.frame.p95Ms.toFixed(2)} ms, ` +
      `p95 scrub-to-frame ${result.scrubP95Ms.toFixed(2)} ms ` +
      `(${result.objectCount} objects)`;
  }
}
