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
 * @dvgl/viewer, owns its canvas + fetching, and drives the lifecycle. It composes
 * the 3D Scene's layer stack AND the flat Map2DView, sharing one GPUDevice and
 * toggling between them -- exactly what a SolidJS <GeometryView> would do.
 */
import {
  BasemapLayer,
  CollectsLayer,
  CoverageLayer,
  EphemerisSource,
  FieldOfRegardLayer,
  type GroundStation,
  GroundStationsLayer,
  type LabelHit,
  LabelsLayer,
  HeadingLayer,
  Map2DView,
  parseBasemap,
  parseCollects,
  parseOem,
  SatellitesLayer,
  Scene,
  TerminatorLayer,
  TracksLayer,
} from "@dvgl/viewer";

const STATIONS: GroundStation[] = [
  { name: "SVALBARD", latDeg: 78.23, lonDeg: 15.4, minElevationDeg: 5 },
  { name: "FAIRBANKS", latDeg: 64.8, lonDeg: -147.7, minElevationDeg: 5 },
  { name: "PUNTA ARENAS", latDeg: -53.0, lonDeg: -70.9, minElevationDeg: 5 },
  { name: "SINGAPORE", latDeg: 1.35, lonDeg: 103.8, minElevationDeg: 5 },
];

function familyColors(source: EphemerisSource): Float32Array {
  const colors = new Float32Array(source.count * 4);
  source.names.forEach((n, i) => {
    colors.set(/sar/i.test(n) ? [1, 0.78, 0.35, 1] : [0.55, 0.85, 1, 1], i * 4);
  });
  return colors;
}

async function main(): Promise<void> {
  const status = document.getElementById("status");
  const pickEl = document.getElementById("pick") as HTMLElement;
  const modeBtn = document.getElementById("mode") as HTMLButtonElement;
  const labelsEl = document.getElementById("labels") as HTMLElement;
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
    const colors = familyColors(source);
    const basemapResp = await fetch("./basemap-110m.bin");
    const basemap = basemapResp.ok ? parseBasemap(await basemapResp.arrayBuffer()) : undefined;

    // one device, shared by both views (neither owns it, so neither destroys it)
    if (!navigator.gpu) throw new Error("WebGPU unavailable");
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error("no WebGPU adapter");
    const device = await adapter.requestDevice();

    const sceneOpts = { epochMs: source.epochMs, windowSeconds: source.windowSeconds, rate: 600 };
    let teardown: (() => void) | null = null;
    let mode: "3d" | "2d" = "3d";

    const build3D = async (): Promise<void> => {
      const scene = await Scene.create({ canvas, device, ...sceneOpts });
      const sats = new SatellitesLayer({ pointSizePx: 6 });
      sats.setSource(source);
      sats.setColors(colors);

      if (basemap) scene.add(new BasemapLayer(basemap));
      scene.add(new TerminatorLayer());
      scene.add(new CoverageLayer({ collects }));
      scene.add(new TracksLayer({ source, fleet: sats, mode: "orbit" }));
      scene.add(new FieldOfRegardLayer({ fleet: sats }));
      scene.add(new GroundStationsLayer({ fleet: sats, stations: STATIONS }));
      scene.add(new CollectsLayer({ fleet: sats, collects }));
      scene.add(new HeadingLayer({ fleet: sats }));
      scene.add(sats);

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

      const detach = scene.attachControls(canvas);
      const unpick = scene.onPick((hit) => {
        pickEl.style.display = hit ? "block" : "none";
        if (hit) pickEl.textContent = hit.name ?? `object ${hit.index}`;
      });
      scene.clock.play();
      scene.start();
      teardown = () => {
        unpick();
        detach();
        scene.dispose();
        for (const el of labelPool) el.remove();
        pickEl.style.display = "none";
      };
      if (status) {
        status.textContent = `@dvgl/viewer · 3D · ${source.count} sats · ${collects.length} collects · 8 layers`;
      }
    };

    const build2D = async (): Promise<void> => {
      const map = await Map2DView.create({ canvas, device, ...sceneOpts });
      map.setFleetSource(source);
      map.setColors(colors);
      map.setTrackSource(source);
      map.setCollects(collects);
      map.setStations(STATIONS);
      if (basemap) map.setBasemap(basemap.coastlines, basemap.borders);
      map.clock.play();
      map.start();
      teardown = () => {
        map.dispose();
      };
      if (status) {
        status.textContent = `@dvgl/viewer · 2D map · ${source.count} sats · ${collects.length} collects`;
      }
    };

    await build3D();
    modeBtn.addEventListener("click", () => {
      teardown?.();
      teardown = null;
      if (mode === "3d") {
        mode = "2d";
        modeBtn.textContent = "3D globe";
        void build2D();
      } else {
        mode = "3d";
        modeBtn.textContent = "2D map";
        void build3D();
      }
    });

    window.addEventListener("resize", () => {
      sizeToHost();
      // both views read canvas.width/height each frame; nudge the 3D depth textures
    });
  } catch (e) {
    if (status) status.textContent = `error: ${(e as Error).message}`;
  }
}

void main();
