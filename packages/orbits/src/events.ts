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
 * Mission timeline events, as @dvgl/core TimelineMarks: AOS/LOS (station passes) and
 * eclipse entry/exit. These answer the day-one questions of mission analysis ("when
 * is my next Svalbard pass?", "when does it go into eclipse?") that a bare timeline
 * can't. The app supplies stations + a propagation source; dv.gl does the geometry.
 */
import type { TimelineMark } from "@dvgl/core";
import { inEclipse, sunEciUnit } from "@dvgl/frames";
import { accessWindows, type GroundStation } from "./access.js";
import type { PropagationSource } from "./propagation.js";

export interface EventWindowOptions {
  /** Scene-time window start/end, minutes since epoch. */
  readonly startMinutes: number;
  readonly endMinutes: number;
  /** Coarse sample step, minutes. Default 0.5 (30 s). */
  readonly stepMinutes?: number;
}

/** AOS/LOS marks (categories "aos" / "los") for every station × object pass. */
export function accessEvents(
  stations: readonly GroundStation[],
  source: PropagationSource,
  epochMs: number,
  options: EventWindowOptions,
  names?: readonly string[],
): TimelineMark[] {
  const out: TimelineMark[] = [];
  for (const st of stations) {
    for (let k = 0; k < source.count; k += 1) {
      const name = names?.[k] ?? `#${k}`;
      for (const w of accessWindows(st, source, epochMs, k, options).intervals) {
        out.push({ timeSec: w.startSec, category: "aos", label: `AOS ${name} · ${st.name}` });
        out.push({ timeSec: w.endSec, category: "los", label: `LOS ${name} · ${st.name}` });
      }
    }
  }
  return out;
}

/** Eclipse entry/exit marks (categories "eclipse-enter" / "eclipse-exit") per object. */
export function eclipseEvents(
  source: PropagationSource,
  epochMs: number,
  options: EventWindowOptions,
  names?: readonly string[],
): TimelineMark[] {
  const step = options.stepMinutes ?? 0.5;
  const scratch = new Float32Array(source.count * 3);
  const out: TimelineMark[] = [];

  const eclAt = (tMin: number, base: number): boolean => {
    source.propagateInto(tMin, scratch);
    const x = scratch[base] ?? Number.NaN;
    if (!Number.isFinite(x)) return false;
    return inEclipse(
      [x, scratch[base + 1] ?? 0, scratch[base + 2] ?? 0],
      sunEciUnit(epochMs + tMin * 60_000),
    );
  };

  for (let k = 0; k < source.count; k += 1) {
    const base = k * 3;
    const name = names?.[k] ?? `#${k}`;
    let prevT = options.startMinutes;
    let prev = eclAt(prevT, base);
    for (let t = options.startMinutes + step; t <= options.endMinutes; t += step) {
      const cur = eclAt(t, base);
      if (cur !== prev) {
        // bisect for the crossing, keeping the half that matches the earlier state
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 20; i += 1) {
          const mid = (lo + hi) / 2;
          if (eclAt(mid, base) === prev) lo = mid;
          else hi = mid;
        }
        out.push({
          timeSec: ((lo + hi) / 2) * 60,
          category: cur ? "eclipse-enter" : "eclipse-exit",
          label: `${cur ? "eclipse in" : "eclipse out"} ${name}`,
        });
      }
      prev = cur;
      prevT = t;
    }
  }
  return out;
}
