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
import { MissionClock } from "./clock.js";
import { IntervalSet } from "./intervals.js";
import { TimelineMarks } from "./marks.js";
import { SampledTrack } from "./track.js";

const DAY = 86_400;

describe("MissionClock", () => {
  it("is deterministic: identical advance sequences give identical scene time", () => {
    const make = () => {
      const c = new MissionClock({ epochMs: 1_767_225_600_000, windowSeconds: 7 * DAY, rate: 600 });
      c.play();
      for (let k = 0; k < 1000; k += 1) c.advance(0.016);
      return c.currentSeconds;
    };
    expect(make()).toBe(make()); // bit-identical across runs: the actual claim
    expect(make()).toBeCloseTo(1000 * 0.016 * 600, 6); // fp summation rounds ~2e-8
  });

  it("does not advance while paused, and scrubbing keeps play state", () => {
    const c = new MissionClock({ epochMs: 0, windowSeconds: 100 });
    expect(c.advance(10)).toBe(0); // paused
    c.scrubTo(42);
    expect(c.currentSeconds).toBe(42);
    expect(c.playing).toBe(false);
    c.play();
    c.scrubTo(10);
    expect(c.playing).toBe(true);
  });

  it("loops by default and clamps when loop=false", () => {
    const looping = new MissionClock({ epochMs: 0, windowSeconds: 100, rate: 1 });
    looping.play();
    looping.scrubTo(90);
    looping.advance(25);
    expect(looping.currentSeconds).toBeCloseTo(15, 9);
    looping.scrubTo(-10); // negative scrubs wrap too
    expect(looping.currentSeconds).toBeCloseTo(90, 9);

    const clamping = new MissionClock({ epochMs: 0, windowSeconds: 100, loop: false });
    clamping.play();
    clamping.scrubTo(90);
    clamping.advance(25);
    expect(clamping.currentSeconds).toBe(100);
    clamping.scrubTo(-5);
    expect(clamping.currentSeconds).toBe(0);
  });

  it("maps scene time to absolute time", () => {
    const c = new MissionClock({ epochMs: 1_000_000, windowSeconds: 100 });
    c.scrubTo(30);
    expect(c.currentUnixMs()).toBe(1_000_000 + 30_000);
  });

  it("rejects nonsense construction and ignores NaN scrubs", () => {
    expect(() => new MissionClock({ epochMs: 0, windowSeconds: 0 })).toThrow(/positive/);
    expect(() => new MissionClock({ epochMs: Number.NaN, windowSeconds: 1 })).toThrow(/finite/);
    const c = new MissionClock({ epochMs: 0, windowSeconds: 100 });
    c.scrubTo(50);
    c.scrubTo(Number.NaN);
    expect(c.currentSeconds).toBe(50);
  });
});

describe("IntervalSet", () => {
  it("sorts, merges overlaps, and drops empty/invalid intervals", () => {
    const s = IntervalSet.from([
      { startSec: 50, endSec: 60 },
      { startSec: 10, endSec: 20 },
      { startSec: 15, endSec: 30 }, // overlaps the previous
      { startSec: 30, endSec: 30 }, // empty
      { startSec: Number.NaN, endSec: 99 }, // invalid
    ]);
    expect(s.intervals).toEqual([
      { startSec: 10, endSec: 30 },
      { startSec: 50, endSec: 60 },
    ]);
    expect(s.totalSeconds()).toBe(30);
  });

  it("contains is start-inclusive, end-exclusive", () => {
    const s = IntervalSet.from([{ startSec: 10, endSec: 20 }]);
    expect(s.contains(10)).toBe(true);
    expect(s.contains(19.999)).toBe(true);
    expect(s.contains(20)).toBe(false);
    expect(s.contains(9.999)).toBe(false);
    expect(IntervalSet.EMPTY.contains(0)).toBe(false);
  });

  it("intersect models 'visible AND in contact' window logic", () => {
    const visibility = IntervalSet.from([
      { startSec: 0, endSec: 100 },
      { startSec: 200, endSec: 300 },
    ]);
    const contact = IntervalSet.from([
      { startSec: 50, endSec: 250 },
      { startSec: 290, endSec: 400 },
    ]);
    expect(visibility.intersect(contact).intervals).toEqual([
      { startSec: 50, endSec: 100 },
      { startSec: 200, endSec: 250 },
      { startSec: 290, endSec: 300 },
    ]);
    expect(visibility.union(contact).intervals).toEqual([{ startSec: 0, endSec: 400 }]);
  });
});

describe("SampledTrack", () => {
  const times = new Float64Array([0, 10, 20, 30]);
  const values = new Float32Array([0, 0, 0, 10, 100, -10, 20, 200, -20, 30, 300, -30]);

  it("interpolates linearly between samples into a caller-owned buffer", () => {
    const track = new SampledTrack(times, values, 3);
    const out = new Float32Array(3);
    expect(track.sampleInto(15, out)).toBe(true);
    expect([...out]).toEqual([15, 150, -15]);
  });

  it("clamps beyond both ends and supports hold interpolation", () => {
    const track = new SampledTrack(times, values, 3);
    const out = new Float32Array(3);
    track.sampleInto(-5, out);
    expect([...out]).toEqual([0, 0, 0]);
    track.sampleInto(99, out);
    expect([...out]).toEqual([30, 300, -30]);

    const held = new SampledTrack(times, values, 3, { interpolation: "hold" });
    held.sampleInto(15, out);
    expect([...out]).toEqual([10, 100, -10]); // holds the left sample
  });

  it("sequential playback (memoized bracket) matches random access exactly", () => {
    const n = 500;
    const ts = new Float64Array(n);
    const vs = new Float32Array(n);
    for (let k = 0; k < n; k += 1) {
      ts[k] = k * 2;
      vs[k] = Math.fround(Math.sin(k * 0.1) * 1000);
    }
    const seq = new SampledTrack(ts, vs, 1);
    const rnd = new SampledTrack(ts, vs, 1);
    const a = new Float32Array(1);
    const b = new Float32Array(1);
    // sequential sweep on one instance; fresh-search queries on the other
    for (let t = 0; t <= 998; t += 0.37) {
      seq.sampleInto(t, a);
      rnd.sampleInto(t, b);
      expect(a[0]).toBe(b[0]);
    }
    // then jump backwards (breaks the memo) and verify correctness
    seq.sampleInto(3.3, a);
    rnd.sampleInto(3.3, b);
    expect(a[0]).toBe(b[0]);
  });

  it("supports offset writes for packing many tracks into one buffer", () => {
    const track = new SampledTrack(times, values, 3);
    const big = new Float32Array(9);
    expect(track.sampleInto(10, big, 3)).toBe(true);
    expect([...big]).toEqual([0, 0, 0, 10, 100, -10, 0, 0, 0]);
    expect(track.sampleInto(10, big, 7)).toBe(false); // too small: refused, not clipped
  });

  it("rejects malformed construction loudly", () => {
    expect(() => new SampledTrack(new Float64Array([]), new Float32Array([]), 1)).toThrow(
      /at least one/,
    );
    expect(() => new SampledTrack(times, values, 4)).toThrow(/values length/);
    expect(() => new SampledTrack(new Float64Array([0, 0]), new Float32Array([1, 2]), 1)).toThrow(
      /strictly increasing/,
    );
  });
});

describe("TimelineMarks", () => {
  const marks = new TimelineMarks([
    { timeSec: 300, category: "contact" },
    { timeSec: 100, category: "collect" },
    { timeSec: 200, category: "eclipse" },
    { timeSec: Number.NaN, category: "bad" }, // dropped
  ]);

  it("sorts by time and drops non-finite marks", () => {
    expect(marks.length).toBe(3);
    expect(marks.marks.map((m) => m.timeSec)).toEqual([100, 200, 300]);
  });

  it("range query is inclusive and ordered", () => {
    expect(marks.inRange(150, 300).map((m) => m.category)).toEqual(["eclipse", "contact"]);
    expect(marks.inRange(0, 50)).toEqual([]);
  });

  it("nearest picks the closest mark either side", () => {
    expect(marks.nearest(120)?.timeSec).toBe(100);
    expect(marks.nearest(260)?.timeSec).toBe(300);
    expect(new TimelineMarks([]).nearest(0)).toBeUndefined();
  });

  it("next/prev are strict and support jump-to-event", () => {
    expect(marks.next(100)?.timeSec).toBe(200); // strictly after
    expect(marks.next(250)?.timeSec).toBe(300);
    expect(marks.next(300)).toBeUndefined(); // nothing after the last
    expect(marks.prev(300)?.timeSec).toBe(200);
    expect(marks.prev(100)).toBeUndefined();
  });
});
