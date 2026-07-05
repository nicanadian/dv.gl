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

/** Pre-alpha placeholder: feature-detect WebGPU without touching the device. */
export function isWebGpuAvailable(nav: unknown = globalThis.navigator): boolean {
  return typeof nav === "object" && nav !== null && "gpu" in nav;
}

export * from "./coverageOverlay.js";
export * from "./earth.js";
export * from "./lines.js";
export * from "./orbitTracks.js";
export * from "./points.js";
export * from "./rte.js";
export * from "./trails.js";
export * from "./tris.js";
