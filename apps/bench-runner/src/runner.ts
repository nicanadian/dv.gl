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
 *
 * Variant knobs (identical on both paths for a valid comparison):
 *   ?prop=main|worker|sgp4gl  propagation source (default worker)
 *   ?x=N                      catalog multiplier via phase-shifted replicas
 *
 * Scrub-to-frame semantics: a scrub closes when a frame is presented that renders
 * positions evaluated AT the scrubbed scene time -- not merely the next frame. With
 * an async source, frames rendered from stale buffers do not close the interval.
 */
import {
  cameraAt,
  FrameTimeRecorder,
  ScrubLatencyProbe,
  stage0Scenario,
} from "@dvgl/benchmarks";
import { loadCatalogText, makeSource, readVariant } from "./sources.js";

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
  /** Render one frame; returns after submission. */
  renderFrame(): void;
}

export interface RunResult {
  readonly path: string;
  readonly primitive: string;
  readonly scenario: string;
  readonly variant: { readonly propagation: string; readonly multiplier: number };
  readonly catalogSource: string;
  readonly catalogSha256: string;
  readonly objectCount: number;
  readonly rejectedCount: number;
  readonly frame: ReturnType<FrameTimeRecorder["stats"]>;
  readonly scrubLatenciesMs: readonly number[];
  readonly scrubP95Ms: number;
  readonly measurementSeconds: number;
  readonly userAgent: string;
}

const MEASUREMENT_SECONDS = 60;

/** Run the scripted Stage 0 measurement against one path. Returns the result. */
export async function runScenario(path: RenderPath): Promise<RunResult> {
  const { mode, multiplier } = readVariant();
  const catalog = await loadCatalogText();
  const source = await makeSource(mode, catalog.text, multiplier);
  const scenario = stage0Scenario;
  const recorder = new FrameTimeRecorder();
  const probe = new ScrubLatencyProbe();

  let sceneMinutes = 0;
  let scrubIdx = 0;
  let renderedMinutes = Number.NaN; // scene time of the buffer the path last consumed
  let freshForFrame = false;

  source.onResult = (positions, minutes) => {
    path.updatePositions(positions, source.count);
    renderedMinutes = minutes;
    freshForFrame = true;
  };

  // first evaluation before the clock starts
  source.request(0);
  await waitFor(() => Number.isFinite(renderedMinutes));

  const t0 = performance.now();
  return await new Promise<RunResult>((resolve) => {
    const tick = (): void => {
      const now = performance.now();
      const tSec = (now - t0) / 1000;

      // scripted scrubs: apply every event whose time has come
      while (scrubIdx < scenario.scrubs.length) {
        const ev = scenario.scrubs[scrubIdx];
        if (ev === undefined || ev.tSeconds > tSec) break;
        sceneMinutes = (ev.windowFraction * scenario.windowSeconds) / 60;
        probe.scrubInput(now);
        source.request(sceneMinutes);
        scrubIdx += 1;
      }

      const kf = cameraAt(scenario, tSec);
      path.setCamera({
        rangeKm: kf.rangeMeters / 1000,
        lonDeg: kf.lonDeg,
        latDeg: kf.latDeg,
      });
      path.renderFrame();

      const after = performance.now();
      recorder.frame(after);
      // close pending scrubs only when this frame showed the scrubbed time
      if (freshForFrame && renderedMinutes === sceneMinutes) {
        probe.framePresented(after);
      }
      freshForFrame = false;

      if (tSec < MEASUREMENT_SECONDS) {
        requestAnimationFrame(tick);
      } else {
        source.dispose();
        resolve({
          path: path.name,
          primitive: path.primitive,
          scenario: `${scenario.name}${multiplier > 1 ? `-x${multiplier}` : ""}`,
          variant: { propagation: source.label, multiplier },
          catalogSource: catalog.source,
          catalogSha256: catalog.sha256,
          objectCount: source.count,
          rejectedCount: source.rejected,
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

function waitFor(cond: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const poll = (): void => {
      if (cond()) resolve();
      else setTimeout(poll, 10);
    };
    poll();
  });
}

/** Download the result as JSON and print it, so nothing is lost either way. */
export function publishResult(result: RunResult): void {
  console.log("BENCH RESULT", JSON.stringify(result));
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
      `${result.path} [${result.scenario}]: p95 frame ${result.frame.p95Ms.toFixed(2)} ms, ` +
      `p95 scrub-to-frame ${result.scrubP95Ms.toFixed(2)} ms ` +
      `(${result.objectCount} objects, ${result.variant.propagation})`;
  }
}
