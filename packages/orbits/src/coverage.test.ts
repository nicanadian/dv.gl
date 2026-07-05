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
import { CoverageGrid } from "./coverage.js";

describe("CoverageGrid", () => {
  it("stamps a cap around the sub-satellite point and leaves far cells clear", () => {
    const g = new CoverageGrid(90, 180);
    g.stamp(0, 0, (10 * Math.PI) / 180); // ~10deg cap at (0,0)
    const covered = g.countCovered();
    expect(covered).toBeGreaterThan(0);
    // the cell at the equator/prime meridian is covered
    const i0 = Math.floor((90 / 180) * 90);
    const j0 = Math.floor((180 / 360) * 180);
    expect(g.data[i0 * 180 + j0]).toBeGreaterThan(0);
    // the antipode is not
    const jAnti = Math.floor((0 / 360) * 180);
    expect(g.data[i0 * 180 + jAnti]).toBe(0);
    // a modest cap covers only a fraction of the globe
    expect(covered).toBeLessThan(90 * 180 * 0.2);
  });

  it("accumulates repeated stamps and resets to zero", () => {
    const g = new CoverageGrid(60, 120);
    g.stamp(30, 45, (15 * Math.PI) / 180);
    const once = g.max();
    g.stamp(30, 45, (15 * Math.PI) / 180);
    expect(g.max()).toBeCloseTo(once * 2, 6);
    g.reset();
    expect(g.max()).toBe(0);
    expect(g.countCovered()).toBe(0);
  });

  it("a wider cap covers strictly more cells", () => {
    const narrow = new CoverageGrid(90, 180);
    const wide = new CoverageGrid(90, 180);
    narrow.stamp(-20, 100, (8 * Math.PI) / 180);
    wide.stamp(-20, 100, (25 * Math.PI) / 180);
    expect(wide.countCovered()).toBeGreaterThan(narrow.countCovered());
  });
});
