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
 * Timeline marks: time-indexed events (collects, contacts, maneuvers, eclipses,
 * anomalies...) the app places on the mission clock. dv.gl supplies the
 * time-indexing and queries -- range, nearest, next/prev for jump-to-event; the
 * app supplies the events and everything they MEAN (category colours, what a mark
 * does when clicked, which panels it drives).
 */

export interface TimelineMark {
  /** Scene time of the event, seconds since epoch. */
  readonly timeSec: number;
  /** App-defined category (e.g. "collect", "contact", "eclipse"). */
  readonly category: string;
  readonly label?: string;
}

export class TimelineMarks {
  /** Marks sorted ascending by time. */
  readonly marks: readonly TimelineMark[];

  constructor(marks: readonly TimelineMark[]) {
    this.marks = [...marks]
      .filter((m) => Number.isFinite(m.timeSec))
      .sort((a, b) => a.timeSec - b.timeSec);
  }

  get length(): number {
    return this.marks.length;
  }

  /** Marks with time in [startSec, endSec] (inclusive), in order. */
  inRange(startSec: number, endSec: number): TimelineMark[] {
    return this.marks.filter((m) => m.timeSec >= startSec && m.timeSec <= endSec);
  }

  /** The mark closest in time to `tSec`, or undefined if there are none. */
  nearest(tSec: number): TimelineMark | undefined {
    let best: TimelineMark | undefined;
    let bestDt = Number.POSITIVE_INFINITY;
    for (const m of this.marks) {
      const dt = Math.abs(m.timeSec - tSec);
      if (dt < bestDt) {
        bestDt = dt;
        best = m;
      }
    }
    return best;
  }

  /** First mark strictly after `tSec` (binary search), or undefined. */
  next(tSec: number): TimelineMark | undefined {
    let lo = 0;
    let hi = this.marks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.marks[mid]?.timeSec ?? Number.POSITIVE_INFINITY) <= tSec) lo = mid + 1;
      else hi = mid;
    }
    return this.marks[lo];
  }

  /** Last mark strictly before `tSec`, or undefined. */
  prev(tSec: number): TimelineMark | undefined {
    let lo = 0;
    let hi = this.marks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.marks[mid]?.timeSec ?? Number.NEGATIVE_INFINITY) < tSec) lo = mid + 1;
      else hi = mid;
    }
    return this.marks[lo - 1];
  }
}
