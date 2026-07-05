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
 * The async propagation seam for the runner and explore pages. Three
 * implementations behind one interface -- the fairness rules require both render
 * paths to use the SAME one per run:
 *
 * - "main":   satellite.js on the main thread (v0 behavior; blocks the frame)
 * - "worker": satellite.js in a Web Worker (main thread stays responsive)
 * - "sgp4gl": sgp4.gl WASM+GPU batch propagation (pinned 0.1.5-beta, MIT)
 *
 * All three coalesce requests latest-wins with one evaluation in flight, and
 * deliver results via onResult(positions, minutes, failed).
 */
import * as satellite from "satellite.js";
import { czmlToSegments, parseCzml } from "@dvgl/czml";
import {
  catalogEpochMs,
  EphemerisSource,
  jdayToUnixMs,
  parseCatalog,
  parseOem,
  SatelliteJsSource,
} from "@dvgl/orbits";

export type SourceMode = "main" | "worker" | "sgp4gl" | "oem" | "czml";

export interface AsyncSource {
  readonly label: string;
  readonly count: number;
  readonly rejected: number;
  /** Ephemeris-backed sources know their own epoch and span. */
  readonly epochMs?: number;
  readonly windowSeconds?: number;
  /** Request evaluation at scene time (minutes). Latest request wins. */
  request(minutes: number): void;
  onResult?: (positions: Float32Array, minutes: number, failed: number) => void;
  dispose(): void;
}

export async function loadCatalogText(): Promise<{
  text: string;
  source: string;
  sha256: string;
}> {
  let resp = await fetch("./catalog.json");
  if (!resp.ok) resp = await fetch("./catalog.sample.json");
  if (!resp.ok) {
    throw new Error(`no catalog found (${resp.status}): run scripts/fetch-catalog.mjs`);
  }
  const text = await resp.text();
  const parsed = JSON.parse(text) as { source?: string; sha256?: string };
  return { text, source: parsed.source ?? "unknown", sha256: parsed.sha256 ?? "unknown" };
}

/** Read benchmark variant knobs from the page URL. */
export function readVariant(): { mode: SourceMode; multiplier: number } {
  const params = new URLSearchParams(location.search);
  const src = params.get("src");
  const rawMode = params.get("prop") ?? (src === "oem" || src === "czml" ? src : "worker");
  const mode: SourceMode =
    rawMode === "main" || rawMode === "sgp4gl" || rawMode === "oem" || rawMode === "czml"
      ? rawMode
      : "worker";
  const multiplier = Math.max(1, Math.min(64, Number(params.get("x") ?? "1") || 1));
  return { mode, multiplier };
}

export async function makeSource(
  mode: SourceMode,
  catalogText: string,
  multiplier: number,
): Promise<AsyncSource> {
  if (mode === "main") return makeMainSource(catalogText, multiplier);
  if (mode === "worker") return await makeWorkerSource(catalogText, multiplier);
  if (mode === "oem") return await makeOemSource();
  if (mode === "czml") return await makeCzmlSource();
  return await makeSgp4GlSource(catalogText, multiplier);
}

// ---- OEM ephemeris (mission products; the pdb-sim dogfood bridge) ----

async function makeOemSource(): Promise<AsyncSource> {
  const url = new URLSearchParams(location.search).get("url") ?? "./mission.oem";
  let resp = await fetch(url);
  if (!resp.ok && url === "./mission.oem") resp = await fetch("./mission.sample.oem");
  if (!resp.ok) throw new Error(`OEM fetch failed (${resp.status}): ${url}`);
  const file = parseOem(await resp.text());
  const inner = new EphemerisSource(file.segments);
  const positions = new Float32Array(inner.count * 3);
  const api: AsyncSource = {
    label: `OEM ephemeris (${file.originator}, ${inner.count} objects)`,
    count: inner.count,
    rejected: inner.rejected.length,
    epochMs: inner.epochMs,
    windowSeconds: inner.windowSeconds,
    request(minutes: number): void {
      const { failed } = inner.propagateInto(minutes, positions);
      api.onResult?.(positions, minutes, failed);
    },
    dispose(): void {},
  };
  return api;
}

async function makeCzmlSource(): Promise<AsyncSource> {
  const url = new URLSearchParams(location.search).get("url") ?? "./mission.czml";
  let resp = await fetch(url);
  if (!resp.ok && url === "./mission.czml") resp = await fetch("./mission.sample.czml");
  if (!resp.ok) throw new Error(`CZML fetch failed (${resp.status}): ${url}`);
  const scene = parseCzml(await resp.text());
  for (const w of scene.warnings) console.warn(`czml: ${w}`);
  const inner = new EphemerisSource(czmlToSegments(scene));
  const positions = new Float32Array(inner.count * 3);
  const api: AsyncSource = {
    label: `CZML (${scene.name}, ${inner.count} entities)`,
    count: inner.count,
    rejected: inner.rejected.length,
    epochMs: inner.epochMs,
    windowSeconds: inner.windowSeconds,
    request(minutes: number): void {
      const { failed } = inner.propagateInto(minutes, positions);
      api.onResult?.(positions, minutes, failed);
    },
    dispose(): void {},
  };
  return api;
}

// ---- main-thread (v0 baseline) ----

function makeMainSource(catalogText: string, multiplier: number): AsyncSource {
  const catalog = parseCatalog(catalogText);
  const inner = new SatelliteJsSource(catalog.objects, catalogEpochMs(catalog.objects), {
    replicate: multiplier,
  });
  const positions = new Float32Array(inner.count * 3);
  const api: AsyncSource = {
    label: "satellite.js CPU main-thread (fp64)",
    count: inner.count,
    rejected: inner.rejected.length,
    request(minutes: number): void {
      const { failed } = inner.propagateInto(minutes, positions);
      api.onResult?.(positions, minutes, failed);
    },
    dispose(): void {},
  };
  return api;
}

// ---- Web Worker ----

async function makeWorkerSource(catalogText: string, multiplier: number): Promise<AsyncSource> {
  const worker = new Worker(new URL("./propagation.worker.ts", import.meta.url), {
    type: "module",
  });
  const ready = await new Promise<{ count: number; rejected: number }>((resolve, reject) => {
    worker.onmessage = (e) => resolve(e.data as { count: number; rejected: number });
    worker.onerror = (e) => reject(new Error(e.message));
    worker.postMessage({ type: "init", catalogText, replicate: multiplier });
  });

  let inFlight = false;
  let pending: number | undefined;
  const api: AsyncSource = {
    label: "satellite.js CPU worker (fp64, transferable buffers)",
    count: ready.count,
    rejected: ready.rejected,
    request(minutes: number): void {
      if (inFlight) {
        pending = minutes; // latest wins
        return;
      }
      inFlight = true;
      worker.postMessage({ type: "propagate", minutes });
    },
    dispose(): void {
      worker.terminate();
    },
  };
  worker.onmessage = (e) => {
    const msg = e.data as { type: string; minutes: number; failed: number; positions: Float32Array };
    if (msg.type !== "result") return;
    inFlight = false;
    api.onResult?.(msg.positions, msg.minutes, msg.failed);
    if (pending !== undefined) {
      const next = pending;
      pending = undefined;
      api.request(next);
    }
  };
  return api;
}

// ---- sgp4.gl (WASM + GPU) ----

async function makeSgp4GlSource(catalogText: string, multiplier: number): Promise<AsyncSource> {
  // Dynamic import so the WASM bundle only loads when this mode is selected.
  const sgp4gl = await import("sgp4.gl");
  const wasmUrl = (await import("sgp4.gl/wasm?url")).default;
  await sgp4gl.init(wasmUrl);

  const catalog = parseCatalog(catalogText);
  const anchorMs = catalogEpochMs(catalog.objects);
  if (anchorMs === undefined) throw new Error("catalog has no valid TLE epoch");

  const enc = new TextEncoder();
  const gpuConsts: unknown[] = [];
  const epochOffsets: number[] = [];
  let rejected = 0;
  const phase = 17;
  for (const o of catalog.objects) {
    try {
      // per-object offset from the shared anchor epoch (same convention as CPU path)
      const satrec = satellite.twoline2satrec(o.line1, o.line2);
      const offset = (anchorMs - jdayToUnixMs(satrec.jdsatepoch)) / 60_000;
      // register_const_set consumes each WASM object (ownership moves into WASM),
      // so replicas need FRESH consts -- pushing the same handle twice hands the
      // registry a neutered pointer and it rejects the whole array.
      for (let r = 0; r < multiplier; r += 1) {
        const el = sgp4gl.WasmElements.from_tle(
          enc.encode(o.name),
          enc.encode(o.line1),
          enc.encode(o.line2),
        );
        const c = sgp4gl.WasmConstants.from_elements(el);
        gpuConsts.push(sgp4gl.WasmGpuConsts.from_constants(c));
        epochOffsets.push(offset + r * phase);
      }
    } catch {
      rejected += 1;
    }
  }

  const propagator = await sgp4gl.GpuPropagator.new_for_web();

  // sgp4.gl caps a batch at 65,536 objects (friction-log item): register the
  // constellation as chunks and fan a request out across them.
  const MAX_BATCH = 65_536;
  const n = epochOffsets.length;
  interface Chunk {
    readonly setId: number;
    readonly start: number;
    readonly size: number;
    readonly times: Float64Array;
  }
  const chunks: Chunk[] = [];
  for (let start = 0; start < n; start += MAX_BATCH) {
    const size = Math.min(MAX_BATCH, n - start);
    // register_const_set consumes the array for zero-copy reuse across calls
    const setId = propagator.register_const_set(
      gpuConsts.slice(start, start + size) as never,
    );
    chunks.push({ setId, start, size, times: new Float64Array(size) });
  }

  const positions = new Float32Array(n * 3);

  let inFlight = false;
  let pending: number | undefined;
  const api: AsyncSource = {
    label: `sgp4.gl 0.1.5-beta WASM+GPU (fp32, ${chunks.length} batch${chunks.length > 1 ? "es" : ""})`,
    count: n,
    rejected,
    request(minutes: number): void {
      if (inFlight) {
        pending = minutes;
        return;
      }
      inFlight = true;
      // The WASM propagator is NOT reentrant (concurrent calls panic with
      // "unreachable"): evaluate chunks strictly sequentially.
      const runChunks = async (): Promise<number> => {
        let failed = 0;
        for (const chunk of chunks) {
          for (let k = 0; k < chunk.size; k += 1) {
            chunk.times[k] = minutes + (epochOffsets[chunk.start + k] ?? 0);
          }
          const out: Float32Array = await propagator.propagate_registered_f32(
            chunk.setId,
            chunk.times,
          );
          // out is [x,y,z,vx,vy,vz] per object; repack to stride 3 + NaN failures
          for (let k = 0; k < chunk.size; k += 1) {
            const dst = (chunk.start + k) * 3;
            const x = out[k * 6];
            const y = out[k * 6 + 1];
            const z = out[k * 6 + 2];
            if (x === undefined || y === undefined || z === undefined || !Number.isFinite(x)) {
              positions[dst] = Number.NaN;
              positions[dst + 1] = Number.NaN;
              positions[dst + 2] = Number.NaN;
              failed += 1;
            } else {
              positions[dst] = x;
              positions[dst + 1] = y;
              positions[dst + 2] = z;
            }
          }
        }
        return failed;
      };
      void runChunks()
        .then((failed) => {
          inFlight = false;
          api.onResult?.(positions, minutes, failed);
          if (pending !== undefined) {
            const next = pending;
            pending = undefined;
            api.request(next);
          }
        })
        .catch((err: unknown) => {
          inFlight = false;
          throw err;
        });
    },
    dispose(): void {
      for (const chunk of chunks) propagator.unregister_const_set?.(chunk.setId);
    },
  };
  return api;
}
