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
 * Propagation worker: owns a SatelliteJsSource and evaluates the whole catalog off
 * the main thread. Each result buffer is transferred (zero-copy) to the main thread.
 */
import { catalogEpochMs, parseCatalog, SatelliteJsSource } from "@dvgl/orbits";

interface InitMsg {
  readonly type: "init";
  readonly catalogText: string;
  readonly replicate: number;
}
interface PropagateMsg {
  readonly type: "propagate";
  readonly minutes: number;
}
interface WindowMsg {
  readonly type: "sampleWindow";
  readonly centerMinutes: number;
  readonly samples: number;
  readonly ecefEpochMs?: number;
}
type InMsg = InitMsg | PropagateMsg | WindowMsg;

let source: SatelliteJsSource | undefined;

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === "init") {
    const catalog = parseCatalog(msg.catalogText);
    const epochMs = catalogEpochMs(catalog.objects);
    source = new SatelliteJsSource(catalog.objects, epochMs, { replicate: msg.replicate });
    self.postMessage({
      type: "ready",
      count: source.count,
      rejected: source.rejected.length,
    });
    return;
  }
  if (msg.type === "sampleWindow") {
    if (source === undefined) throw new Error("worker: sampleWindow before init");
    const window = new Float32Array(source.count * msg.samples * 3);
    const periods = new Float32Array(source.count);
    source.sampleWindowInto(msg.centerMinutes, msg.samples, window, msg.ecefEpochMs, periods);
    self.postMessage(
      {
        type: "window",
        centerMinutes: msg.centerMinutes,
        samples: msg.samples,
        window,
        periods,
      },
      { transfer: [window.buffer, periods.buffer] },
    );
    return;
  }
  if (msg.type === "propagate") {
    if (source === undefined) throw new Error("worker: propagate before init");
    const positions = new Float32Array(source.count * 3);
    const { failed } = source.propagateInto(msg.minutes, positions);
    // Transfer ownership: no copy, no main-thread GC pressure from this buffer.
    self.postMessage(
      { type: "result", minutes: msg.minutes, failed, positions },
      { transfer: [positions.buffer] },
    );
  }
};
