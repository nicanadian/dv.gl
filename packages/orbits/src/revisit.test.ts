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
import { RevisitGrid } from "./revisit.js";

describe("RevisitGrid", () => {
  it("row 0 is north and rows increase southward", () => {
    const g = new RevisitGrid(18, 36); // 10-degree cells
    expect(g.cellLat(0)).toBeCloseTo(85, 6); // top row near +90
    expect(g.cellLat(17)).toBeCloseTo(-85, 6); // bottom row near -90
  });

  it("records the latest look and ages it over the window", () => {
    const g = new RevisitGrid(90, 180);
    const cap = 0.1; // ~small cap so only cells near (0,0) are stamped
    g.stamp(0, 0, cap, 60); // collected at t=60 min
    const out = new Uint8Array(90 * 180);
    // one hour later, with a 2-hour window -> ~half-aged -> mid bucket
    g.ageTexture(120, 120, out);
    // find the equator/prime-meridian cell (row 45, col 90)
    const idx = 45 * 180 + 90;
    expect(out[idx]).toBeGreaterThan(1); // aged, not fresh
    expect(out[idx]).toBeLessThan(255); // not fully stale
    // a cell far away was never collected -> transparent sentinel 0
    expect(out[0]).toBe(0);
  });

  it("a later look overwrites an earlier age (freshens the cell)", () => {
    const g = new RevisitGrid(90, 180);
    g.stamp(0, 0, 0.1, 10);
    g.stamp(0, 0, 0.1, 100); // revisit
    const out = new Uint8Array(90 * 180);
    g.ageTexture(100, 60, out); // now == last look -> freshest bucket
    expect(out[45 * 180 + 90]).toBe(1);
  });

  it("reset forgets all history (for scrubs)", () => {
    const g = new RevisitGrid(36, 72);
    g.stamp(0, 0, 0.2, 5);
    expect(g.countCovered()).toBeGreaterThan(0);
    g.reset();
    expect(g.countCovered()).toBe(0);
  });
});
