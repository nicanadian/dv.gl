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

// Re-export the stable data surface so consumers import it from one place and are
// insulated from internal package churn.
export {
  type Collect,
  EphemerisSource,
  type GroundStation,
  type OemFile,
  type OemSegment,
  type PropagationSource,
  parseCollects,
  parseOem,
} from "@dvgl/orbits";
/**
 * @dvgl/viewer -- the embeddable façade. A framework host (SolidJS, Three, plain
 * DOM) creates a `Scene` on a canvas, adds composable layers, feeds them data, and
 * drives the lifecycle. Nothing here touches `document`/`window` except the opt-in
 * `Scene.attachControls(el)`. Parsers/data types live in @dvgl/orbits and are
 * re-exported here so consumers have one import surface.
 */
export { type CameraView, OrbitCamera } from "./camera.js";
export { CollectsLayer, type CollectsLayerOptions } from "./layers/collects.js";
export { CoverageLayer, type CoverageLayerOptions } from "./layers/coverage.js";
export {
  FieldOfRegardLayer,
  type FieldOfRegardLayerOptions,
} from "./layers/field-of-regard.js";
export { GroundStationsLayer } from "./layers/ground-stations.js";
export { HeadingLayer } from "./layers/heading.js";
export {
  type LabelHit,
  type LabelsCallback,
  LabelsLayer,
  type LabelsLayerOptions,
} from "./layers/labels.js";
export {
  type FleetSource,
  SatellitesLayer,
  type SatellitesLayerOptions,
} from "./layers/satellites.js";
export {
  TracksLayer,
  type TracksLayerOptions,
  type WindowSource,
} from "./layers/tracks.js";
export { Map2DView, type Map2DViewOptions } from "./map2d.js";
export { Scene, type SceneOptions } from "./scene.js";
export type { Fleet, FrameContext, Layer, LayerContext, PickHit } from "./types.js";
