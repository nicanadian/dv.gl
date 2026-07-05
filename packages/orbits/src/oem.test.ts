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
import { EphemerisSource } from "./ephemerisSource.js";
import { parseOem } from "./oem.js";

const SAMPLE = `CCSDS_OEM_VERS = 2.0
CREATION_DATE = 2026-07-04T00:00:00
ORIGINATOR = pdb-spacecraft-simulator

META_START
OBJECT_NAME = demo/sat1
OBJECT_ID = sat1
CENTER_NAME = EARTH
REF_FRAME = EME2000
COMMENT frame is the pdb sim ECI axis set
TIME_SYSTEM = UTC
START_TIME = 2026-06-29T00:00:00.000Z
STOP_TIME = 2026-06-29T00:02:00.000Z
META_STOP
2026-06-29T00:00:00.000Z 6874.263449 0.000000 0.000000
2026-06-29T00:01:00.000Z 6859.064586 447.616464 0.000000
2026-06-29T00:02:00.000Z 6813.596600 892.244664 0.000000

META_START
OBJECT_NAME = demo/sat2
OBJECT_ID = sat2
CENTER_NAME = EARTH
REF_FRAME = EME2000
TIME_SYSTEM = UTC
META_STOP
2026-06-29T00:01:00.000Z 0.0 7000.0 0.0
2026-06-29T00:03:00.000Z 0.0 6900.0 500.0
`;

describe("parseOem", () => {
  it("parses header, multiple segments, and states with relative times", () => {
    const file = parseOem(SAMPLE);
    expect(file.version).toBe("2.0");
    expect(file.originator).toBe("pdb-spacecraft-simulator");
    expect(file.segments).toHaveLength(2);
    const s1 = file.segments[0];
    expect(s1?.objectName).toBe("demo/sat1");
    expect(s1?.refFrame).toBe("EME2000");
    expect(s1?.epochMs).toBe(Date.UTC(2026, 5, 29));
    expect([...(s1?.times ?? [])]).toEqual([0, 60, 120]);
    expect(s1?.positions[3]).toBeCloseTo(6859.064586, 3);
    // second segment starts a minute later; its own times are still relative to itself
    expect(file.segments[1]?.epochMs).toBe(Date.UTC(2026, 5, 29, 0, 1));
  });

  it("fails loudly with line numbers, never silently", () => {
    expect(() => parseOem("not an oem")).toThrow(/line 1.*CCSDS_OEM_VERS/);
    expect(() => parseOem("CCSDS_OEM_VERS = 2.0\n")).toThrow(/no segments/);
    const badTime = SAMPLE.replace("TIME_SYSTEM = UTC", "TIME_SYSTEM = TAI");
    expect(() => parseOem(badTime)).toThrow(/unsupported TIME_SYSTEM "TAI"/);
    const badState = SAMPLE.replace("6874.263449 0.000000 0.000000", "6874.263449 nope 0");
    expect(() => parseOem(badState)).toThrow(/non-finite position/);
    const backwards = SAMPLE.replace(
      "2026-06-29T00:02:00.000Z 6813",
      "2026-06-29T00:00:30.000Z 6813",
    );
    expect(() => parseOem(backwards)).toThrow(/strictly increasing/);
  });
});

describe("EphemerisSource", () => {
  it("anchors at the earliest segment and interpolates within spans", () => {
    const source = new EphemerisSource(parseOem(SAMPLE).segments);
    expect(source.count).toBe(2);
    expect(source.epochMs).toBe(Date.UTC(2026, 5, 29));
    expect(source.windowSeconds).toBe(180); // sat2 ends at anchor+3min
    const out = new Float32Array(6);
    // t = 1 min: sat1 exact sample, sat2 at its own start
    let r = source.propagateInto(1, out);
    expect(r.written).toBe(2);
    expect(out[0]).toBeCloseTo(6859.0645, 3);
    expect(out[4]).toBeCloseTo(7000, 3);
    // t = 2 min: sat2 midway through its 2-minute gap -> linear midpoint
    r = source.propagateInto(2, out);
    expect(out[4]).toBeCloseTo(6950, 3);
    expect(out[5]).toBeCloseTo(250, 3);
  });

  it("hides objects outside their span instead of freezing them", () => {
    const source = new EphemerisSource(parseOem(SAMPLE).segments);
    const out = new Float32Array(6);
    // t = 2.5 min: sat1's segment ended at 2 min -> hidden; sat2 still live
    const r = source.propagateInto(2.5, out);
    expect(r.written).toBe(1);
    expect(r.failed).toBe(1);
    expect(Number.isNaN(out[0] ?? 0)).toBe(true);
    expect(Number.isFinite(out[3] ?? Number.NaN)).toBe(true);
  });
});

describe("sampleWindowInto (orbit tracks)", () => {
  it("EphemerisSource: middle sample equals the propagateInto position; ends clamp to span", () => {
    const source = new EphemerisSource(parseOem(SAMPLE).segments);
    const S = 5;
    const window = new Float32Array(source.count * S * 3);
    source.sampleWindowInto(1, S, window); // center t=1min
    const direct = new Float32Array(source.count * 3);
    source.propagateInto(1, direct);
    // sat1 middle sample (index 2) == direct evaluation
    const mid = (0 * S + 2) * 3;
    expect(window[mid]).toBeCloseTo(direct[0] ?? Number.NaN, 4);
    expect(window[mid + 1]).toBeCloseTo(direct[1] ?? Number.NaN, 4);
    // sat1 last sample clamps to its span end (t=2min sample), never extrapolates
    const last = (0 * S + S - 1) * 3;
    expect(window[last]).toBeCloseTo(6813.5966, 3);
  });
});
