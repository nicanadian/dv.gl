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
import { accessEvents, eclipseEvents } from "./events.js";
import type { PropagationSource } from "./propagation.js";

// A single satellite on a circular equatorial orbit (~400 km), inertial +x/+y plane.
const R = 6778;
const PERIOD_MIN = 92.6;
const W = (2 * Math.PI) / PERIOD_MIN;
const source: PropagationSource = {
  count: 1,
  names: ["SAT-1"],
  propagateInto(minutes, out) {
    const a = W * minutes;
    out[0] = R * Math.cos(a);
    out[1] = R * Math.sin(a);
    out[2] = 0;
    return { written: 1, failed: 0 };
  },
};
const EPOCH = Date.UTC(2026, 0, 1);
const opts = { startMinutes: 0, endMinutes: PERIOD_MIN * 2, stepMinutes: 0.5 };

describe("eclipseEvents", () => {
  it("emits alternating enter/exit crossings over two revs", () => {
    const marks = eclipseEvents(source, EPOCH, opts, source.names);
    expect(marks.length).toBeGreaterThanOrEqual(2);
    // an equatorial circular orbit crosses the shadow twice per rev
    const enters = marks.filter((m) => m.category === "eclipse-enter").length;
    const exits = marks.filter((m) => m.category === "eclipse-exit").length;
    expect(Math.abs(enters - exits)).toBeLessThanOrEqual(1);
    for (const m of marks) expect(Number.isFinite(m.timeSec)).toBe(true);
  });
});

describe("accessEvents", () => {
  it("emits AOS strictly before LOS for each pass", () => {
    const station = { name: "EQ", latDeg: 0, lonDeg: 0, minElevationDeg: 5 };
    const marks = accessEvents([station], source, EPOCH, opts, source.names);
    const aos = marks.filter((m) => m.category === "aos").map((m) => m.timeSec);
    const los = marks.filter((m) => m.category === "los").map((m) => m.timeSec);
    expect(aos.length).toBeGreaterThan(0);
    expect(aos.length).toBe(los.length);
    // marks are emitted AOS then LOS per pass; each AOS precedes its paired LOS
    for (let i = 0; i < aos.length; i += 1) {
      expect(aos[i]).toBeLessThan(los[i] as number);
    }
  });
});
