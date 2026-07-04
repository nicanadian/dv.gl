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
import { describe, expect, it } from "vitest";
import {
  FrameTimeRecorder,
  GATE_MIN_RATIO,
  gateRatio,
  passesGate,
  percentile,
  ScrubLatencyProbe,
} from "./metrics.js";
import { cameraAt, stage0Scenario } from "./scenario.js";

describe("stage0 scenario (the fairness rules as code)", () => {
  it("defines the shared workload", () => {
    expect(stage0Scenario.catalogSize).toBe(50_000);
    expect(stage0Scenario.windowSeconds).toBe(7 * 86_400);
    expect(stage0Scenario.trails.enabled).toBe(false); // single mandated config
    expect(stage0Scenario.warmupPasses).toBe(1);
    expect(stage0Scenario.measuredPasses).toBe(3);
  });

  it("scrub script is deterministic, ordered, and in-window", () => {
    const ts = stage0Scenario.scrubs.map((s) => s.tSeconds);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    for (const s of stage0Scenario.scrubs) {
      expect(s.windowFraction).toBeGreaterThanOrEqual(0);
      expect(s.windowFraction).toBeLessThanOrEqual(1);
    }
    expect(stage0Scenario.scrubs.length).toBeGreaterThan(20); // steps + jumps + drag
  });

  it("camera script interpolates piecewise-linearly", () => {
    const first = stage0Scenario.camera[0];
    const mid = cameraAt(stage0Scenario, 7.5); // halfway between keyframes 0 and 15
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(cameraAt(stage0Scenario, -5)).toEqual(first);
    expect(mid.rangeMeters).toBeCloseTo((45_000_000 + 20_000_000) / 2, 0);
  });
});

describe("metric collectors", () => {
  it("percentile is nearest-rank", () => {
    const s = [10, 20, 30, 40, 50];
    expect(percentile(s, 50)).toBe(30);
    expect(percentile(s, 95)).toBe(50);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });

  it("frame recorder measures deltas without per-frame allocation", () => {
    const rec = new FrameTimeRecorder(16);
    for (let t = 0; t <= 160; t += 16) rec.frame(t);
    const stats = rec.stats();
    expect(stats.frames).toBe(10);
    expect(stats.p50Ms).toBe(16);
    rec.reset();
    expect(rec.stats().frames).toBe(0); // warmup discard
  });

  it("scrub probe closes latency on the next presented frame only", () => {
    const probe = new ScrubLatencyProbe();
    probe.framePresented(0); // frame with no pending scrub: ignored
    probe.scrubInput(100);
    probe.framePresented(148); // closes: 48 ms
    probe.framePresented(164); // no pending scrub: ignored
    probe.scrubInput(200);
    probe.framePresented(203); // closes: 3 ms
    expect(probe.samples()).toEqual([48, 3]);
  });

  it("the gate is >=3x on p95 scrub latency", () => {
    expect(GATE_MIN_RATIO).toBe(3.0);
    expect(gateRatio(90, 30)).toBe(3);
    expect(passesGate(90, 30)).toBe(true); // exactly 3x passes
    expect(passesGate(89, 30)).toBe(false); // 2.97x fails: one hard number
  });
});
