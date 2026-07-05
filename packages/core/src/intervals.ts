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
 * Immutable interval sets over scene time (seconds since epoch). The
 * representation for availability, visibility, and contact windows: always
 * sorted, non-overlapping, and merged, so `contains` is a binary search and set
 * operations are linear sweeps.
 */

export interface Interval {
  readonly startSec: number;
  readonly endSec: number;
}

export class IntervalSet {
  private constructor(readonly intervals: readonly Interval[]) {}

  static readonly EMPTY = new IntervalSet([]);

  /** Build from arbitrary intervals: sorts, drops empties, merges overlaps. */
  static from(raw: readonly Interval[]): IntervalSet {
    const valid = raw
      .filter((iv) => Number.isFinite(iv.startSec) && Number.isFinite(iv.endSec))
      .filter((iv) => iv.endSec > iv.startSec)
      .slice()
      .sort((a, b) => a.startSec - b.startSec);
    if (valid.length === 0) return IntervalSet.EMPTY;
    const merged: { startSec: number; endSec: number }[] = [];
    for (const iv of valid) {
      const last = merged[merged.length - 1];
      if (last !== undefined && iv.startSec <= last.endSec) {
        last.endSec = Math.max(last.endSec, iv.endSec);
      } else {
        merged.push({ startSec: iv.startSec, endSec: iv.endSec });
      }
    }
    return new IntervalSet(merged);
  }

  /** True if t lies inside any interval (start inclusive, end exclusive). */
  contains(tSec: number): boolean {
    let lo = 0;
    let hi = this.intervals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const iv = this.intervals[mid];
      if (iv === undefined) break;
      if (tSec < iv.startSec) hi = mid - 1;
      else if (tSec >= iv.endSec) lo = mid + 1;
      else return true;
    }
    return false;
  }

  union(other: IntervalSet): IntervalSet {
    return IntervalSet.from([...this.intervals, ...other.intervals]);
  }

  intersect(other: IntervalSet): IntervalSet {
    const out: Interval[] = [];
    let i = 0;
    let j = 0;
    while (i < this.intervals.length && j < other.intervals.length) {
      const a = this.intervals[i];
      const b = other.intervals[j];
      if (a === undefined || b === undefined) break;
      const start = Math.max(a.startSec, b.startSec);
      const end = Math.min(a.endSec, b.endSec);
      if (end > start) out.push({ startSec: start, endSec: end });
      if (a.endSec < b.endSec) i += 1;
      else j += 1;
    }
    return IntervalSet.from(out);
  }

  /** Sum of interval lengths, seconds. */
  totalSeconds(): number {
    let sum = 0;
    for (const iv of this.intervals) sum += iv.endSec - iv.startSec;
    return sum;
  }

  get isEmpty(): boolean {
    return this.intervals.length === 0;
  }
}
