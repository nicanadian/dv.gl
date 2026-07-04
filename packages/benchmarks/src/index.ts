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

/** The metric set every published benchmark reports (pre-alpha placeholder). */
export const BENCHMARK_METRICS = [
  "p50_frame_time_ms",
  "p95_frame_time_ms",
  "main_thread_cpu_ms_per_frame",
  "js_allocation_bytes_per_frame",
  "draw_calls",
  "gpu_memory_bytes",
  "time_to_first_frame_ms",
  "scrub_to_frame_latency_ms",
] as const;
export type BenchmarkMetric = (typeof BENCHMARK_METRICS)[number];

export * from "./metrics.js";
export * from "./scenario.js";
