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
 * The Stage 0 benchmark scenario, defined as deterministic data so both render paths
 * consume the exact same workload, camera motion, and scrub pattern. See
 * docs/benchmark-fairness.md; this module is those rules as code.
 */

export interface CameraKeyframe {
  /** Seconds from measurement start. */
  readonly tSeconds: number;
  /** Camera distance from Earth's center, meters. */
  readonly rangeMeters: number;
  /** Longitude/latitude the camera bore-sights, degrees. */
  readonly lonDeg: number;
  readonly latDeg: number;
}

export interface ScrubEvent {
  /** Seconds from measurement start at which the scrub input fires. */
  readonly tSeconds: number;
  /** Target scene time as a fraction [0,1] of the scenario window. */
  readonly windowFraction: number;
}

export interface BenchmarkScenario {
  readonly name: string;
  /** Scene-time window length in seconds (the scrubbable timeline). */
  readonly windowSeconds: number;
  /** Target catalog object count (the same snapshot on both paths). */
  readonly catalogSize: number;
  /** Trails: the single fairness-mandated configuration. */
  readonly trails: { readonly enabled: boolean; readonly lengthSeconds: number };
  /** Warmup passes discarded before measurement. */
  readonly warmupPasses: number;
  /** Measured passes; the median pass is reported. */
  readonly measuredPasses: number;
  /** Deterministic scripted camera motion (piecewise-linear between keyframes). */
  readonly camera: readonly CameraKeyframe[];
  /** Deterministic scrub pattern. */
  readonly scrubs: readonly ScrubEvent[];
}

const DAY = 86_400;

/** Deterministic scrub script: a mix of small steps, large jumps, and a fast drag. */
function buildScrubs(): ScrubEvent[] {
  const events: ScrubEvent[] = [];
  // small forward steps every 2 s for 20 s
  for (let k = 0; k < 10; k += 1) {
    events.push({ tSeconds: 10 + 2 * k, windowFraction: 0.1 + 0.02 * k });
  }
  // large jumps
  events.push({ tSeconds: 34, windowFraction: 0.95 });
  events.push({ tSeconds: 38, windowFraction: 0.05 });
  events.push({ tSeconds: 42, windowFraction: 0.5 });
  // fast drag: 20 events over 4 s sweeping half the window
  for (let k = 0; k < 20; k += 1) {
    events.push({ tSeconds: 46 + 0.2 * k, windowFraction: 0.5 + 0.02 * k });
  }
  return events;
}

/** The canonical Stage 0 scenario. Both paths must consume exactly this object. */
export const stage0Scenario: BenchmarkScenario = {
  name: "stage0-50k-7day",
  windowSeconds: 7 * DAY,
  catalogSize: 50_000,
  trails: { enabled: false, lengthSeconds: 0 },
  warmupPasses: 1,
  measuredPasses: 3,
  camera: [
    { tSeconds: 0, rangeMeters: 45_000_000, lonDeg: -75, latDeg: 20 },
    { tSeconds: 15, rangeMeters: 20_000_000, lonDeg: -30, latDeg: 10 },
    { tSeconds: 30, rangeMeters: 9_000_000, lonDeg: 10, latDeg: 0 },
    { tSeconds: 45, rangeMeters: 9_000_000, lonDeg: 60, latDeg: -15 },
    { tSeconds: 60, rangeMeters: 45_000_000, lonDeg: 120, latDeg: 0 },
  ],
  scrubs: buildScrubs(),
};

/** Piecewise-linear camera state at time t, for driving either path's camera. */
export function cameraAt(scenario: BenchmarkScenario, tSeconds: number): CameraKeyframe {
  const keys = scenario.camera;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error("scenario has no camera keyframes");
  }
  if (tSeconds <= first.tSeconds) return first;
  if (tSeconds >= last.tSeconds) return last;
  for (let k = 0; k + 1 < keys.length; k += 1) {
    const a = keys[k];
    const b = keys[k + 1];
    if (a === undefined || b === undefined) continue;
    if (tSeconds >= a.tSeconds && tSeconds <= b.tSeconds) {
      const u = (tSeconds - a.tSeconds) / (b.tSeconds - a.tSeconds);
      return {
        tSeconds,
        rangeMeters: a.rangeMeters + u * (b.rangeMeters - a.rangeMeters),
        lonDeg: a.lonDeg + u * (b.lonDeg - a.lonDeg),
        latDeg: a.latDeg + u * (b.latDeg - a.latDeg),
      };
    }
  }
  return last;
}
