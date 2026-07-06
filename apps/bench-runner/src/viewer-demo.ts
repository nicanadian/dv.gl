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
 * External-style consumer of @dvgl/viewer -- the D1 exit check. Imports ONLY from
 * @dvgl/viewer, owns its canvas + fetching, composes the layer stack, and drives the
 * Scene lifecycle. No dv.gl internals, no ambient element IDs beyond the one canvas.
 * Exactly what a SolidJS <GeometryView> would do.
 */
import {
  CollectsLayer,
  CoverageLayer,
  EphemerisSource,
  FieldOfRegardLayer,
  type GroundStation,
  GroundStationsLayer,
  type LabelHit,
  LabelsLayer,
  HeadingLayer,
  parseCollects,
  parseOem,
  SatellitesLayer,
  Scene,
  TracksLayer,
} from "@dvgl/viewer";

const STATIONS: GroundStation[] = [
  { name: "SVALBARD", latDeg: 78.23, lonDeg: 15.4, minElevationDeg: 5 },
  { name: "FAIRBANKS", latDeg: 64.8, lonDeg: -147.7, minElevationDeg: 5 },
  { name: "PUNTA ARENAS", latDeg: -53.0, lonDeg: -70.9, minElevationDeg: 5 },
  { name: "SINGAPORE", latDeg: 1.35, lonDeg: 103.8, minElevationDeg: 5 },
];

async function main(): Promise<void> {
  const status = document.getElementById("status");
  const pickEl = document.getElementById("pick") as HTMLElement;
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const dpr = window.devicePixelRatio || 1;
  const sizeToHost = (): void => {
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  };
  sizeToHost();

  try {
    const source = new EphemerisSource(parseOem(await (await fetch("./mission.oem")).text()).segments);
    const collectsResp = await fetch("./mission.collects.json");
    const collects = collectsResp.ok ? parseCollects(await collectsResp.json(), source.epochMs) : [];

    const scene = await Scene.create({
      canvas,
      epochMs: source.epochMs,
      windowSeconds: source.windowSeconds,
      rate: 600,
    });

    const sats = new SatellitesLayer({ pointSizePx: 6 });
    sats.setSource(source);
    const colors = new Float32Array(source.count * 4);
    source.names.forEach((n, i) => {
      colors.set(/sar/i.test(n) ? [1, 0.78, 0.35, 1] : [0.55, 0.85, 1, 1], i * 4);
    });
    sats.setColors(colors);

    // compose the layer stack (draw order = add order; points on top)
    scene.add(new CoverageLayer({ collects }));
    scene.add(new TracksLayer({ source, fleet: sats, mode: "orbit" }));
    scene.add(new FieldOfRegardLayer({ fleet: sats }));
    scene.add(new GroundStationsLayer({ fleet: sats, stations: STATIONS }));
    scene.add(new CollectsLayer({ fleet: sats, collects }));
    scene.add(new HeadingLayer({ fleet: sats }));
    scene.add(sats);

    // labels are GPU-silent: the layer emits positions, the HOST renders text
    const labelsEl = document.getElementById("labels") as HTMLElement;
    const labelPool: HTMLSpanElement[] = [];
    const labels = new LabelsLayer({ fleet: sats });
    labels.onLabels((hits: readonly LabelHit[]) => {
      hits.forEach((hit, i) => {
        let el = labelPool[i];
        if (!el) {
          el = document.createElement("span");
          labelsEl.appendChild(el);
          labelPool[i] = el;
        }
        el.textContent = hit.name.split("/").pop() ?? hit.name;
        el.style.left = `${hit.x * labelsEl.clientWidth + 6}px`;
        el.style.top = `${hit.y * labelsEl.clientHeight - 7}px`;
        el.style.display = "block";
      });
      for (let i = hits.length; i < labelPool.length; i += 1) {
        const el = labelPool[i];
        if (el) el.style.display = "none";
      }
    });
    scene.add(labels);

    scene.attachControls(canvas);
    scene.onPick((hit) => {
      pickEl.style.display = hit ? "block" : "none";
      if (hit) pickEl.textContent = hit.name ?? `object ${hit.index}`;
    });
    window.addEventListener("resize", () => {
      sizeToHost();
      scene.resize(canvas.width, canvas.height);
    });

    scene.clock.play();
    scene.start();
    if (status) {
      status.textContent = `@dvgl/viewer · ${source.count} sats · ${collects.length} collects · 8 layers`;
    }
  } catch (e) {
    if (status) status.textContent = `error: ${(e as Error).message}`;
  }
}

void main();
