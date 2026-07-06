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
 * Minimal external-style consumer of @dvgl/viewer -- the D1 exit check. It imports
 * ONLY from @dvgl/viewer's public surface, owns its own canvas + fetching, and
 * drives the Scene lifecycle. No dv.gl internals, no ambient element IDs beyond the
 * one canvas the host created -- exactly what a SolidJS <GeometryView> would do.
 */
import { EphemerisSource, parseOem, SatellitesLayer, Scene } from "@dvgl/viewer";

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
    const resp = await fetch("./mission.oem");
    if (!resp.ok) throw new Error("mission.oem not found");
    const source = new EphemerisSource(parseOem(await resp.text()).segments);

    const scene = await Scene.create({
      canvas,
      epochMs: source.epochMs,
      windowSeconds: source.windowSeconds,
      rate: 600,
    });

    const sats = new SatellitesLayer({ pointSizePx: 6 });
    sats.setSource(source);
    // family colours (EO cyan / SAR gold) -- host policy, fed to the layer
    const colors = new Float32Array(source.count * 4);
    source.names.forEach((n, i) => {
      colors.set(/sar/i.test(n) ? [1, 0.78, 0.35, 1] : [0.55, 0.85, 1, 1], i * 4);
    });
    sats.setColors(colors);
    scene.add(sats);

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
    if (status) status.textContent = `@dvgl/viewer · ${source.count} objects`;
  } catch (e) {
    if (status) status.textContent = `error: ${(e as Error).message}`;
  }
}

void main();
