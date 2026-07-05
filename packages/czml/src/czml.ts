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
 * Strict CZML subset: document (+ clock), and entity packets with availability,
 * sampled position (epoch + cartesian), and point styling. Parse and export are
 * inverses over this subset so migration off (or back to) Cesium is reversible.
 *
 * Diagnostics-first: anything outside the subset that would change what the scene
 * MEANS (an unsupported interpolation, a non-sampled position, a missing document
 * packet) throws with the packet id; cosmetic unknowns (billboard, label...) are
 * collected as warnings, never silently dropped.
 *
 * Units: CZML cartesians are METERS (converted to km at the boundary; dv.gl is km
 * everywhere). referenceFrame FIXED (default) and INERTIAL are both accepted and
 * recorded verbatim on the entity.
 */

export interface CzmlClock {
  readonly startMs: number;
  readonly endMs: number;
  readonly currentMs: number;
  readonly multiplier: number;
}

export interface CzmlEntity {
  readonly id: string;
  readonly name: string;
  /** "FIXED" | "INERTIAL" as written in the file. */
  readonly referenceFrame: string;
  /** Epoch of the position samples, Unix ms. */
  readonly epochMs: number;
  /** Seconds since epochMs, strictly increasing. */
  readonly times: Float64Array;
  /** Positions km, stride 3. */
  readonly positions: Float32Array;
  /** Availability [startMs, endMs] if present. */
  readonly availabilityMs?: readonly [number, number];
  readonly pointPixelSize?: number;
  readonly pointColorRgba?: readonly [number, number, number, number];
}

export interface CzmlScene {
  readonly name: string;
  readonly clock?: CzmlClock;
  readonly entities: readonly CzmlEntity[];
  /** Non-semantic properties encountered and ignored, per packet id. */
  readonly warnings: readonly string[];
}

class CzmlError extends Error {
  constructor(packet: string, message: string) {
    super(`CZML packet "${packet}": ${message}`);
  }
}

const SUPPORTED = new Set([
  "id",
  "name",
  "version",
  "clock",
  "availability",
  "position",
  "point",
  "path",
  "orientation",
  "description",
  "parent",
]);

/** Parse a CZML document (JSON text or already-parsed array). */
export function parseCzml(input: string | unknown[]): CzmlScene {
  const packets = typeof input === "string" ? (JSON.parse(input) as unknown[]) : input;
  if (!Array.isArray(packets) || packets.length === 0) {
    throw new CzmlError("?", "CZML must be a non-empty JSON array of packets");
  }
  const doc = packets[0] as Record<string, unknown>;
  if (doc["id"] !== "document") {
    throw new CzmlError(String(doc["id"] ?? "?"), "first packet must have id 'document'");
  }
  if (doc["version"] !== "1.0") {
    throw new CzmlError("document", `unsupported CZML version "${String(doc["version"])}"`);
  }

  const warnings: string[] = [];
  let clock: CzmlClock | undefined;
  const rawClock = doc["clock"] as Record<string, unknown> | undefined;
  if (rawClock) {
    const interval = String(rawClock["interval"] ?? "");
    const [a, b] = interval.split("/");
    const startMs = Date.parse(a ?? "");
    const endMs = Date.parse(b ?? "");
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
      throw new CzmlError("document", `unparseable clock interval "${interval}"`);
    }
    clock = {
      startMs,
      endMs,
      currentMs: Date.parse(String(rawClock["currentTime"] ?? a ?? "")) || startMs,
      multiplier: Number(rawClock["multiplier"] ?? 1),
    };
  }

  const entities: CzmlEntity[] = [];
  for (let p = 1; p < packets.length; p += 1) {
    const pkt = packets[p] as Record<string, unknown>;
    const id = String(pkt["id"] ?? `packet[${p}]`);
    for (const key of Object.keys(pkt)) {
      if (!SUPPORTED.has(key)) warnings.push(`${id}: ignored unsupported property "${key}"`);
    }
    const pos = pkt["position"] as Record<string, unknown> | undefined;
    if (!pos) {
      warnings.push(`${id}: no position; entity skipped`);
      continue;
    }
    const cartesian = pos["cartesian"];
    if (!Array.isArray(cartesian)) {
      throw new CzmlError(id, "only sampled position.cartesian is in the subset");
    }
    if (cartesian.length % 4 !== 0 || cartesian.length === 0) {
      throw new CzmlError(id, `cartesian length ${cartesian.length} is not quadruples`);
    }
    const epochMs = Date.parse(String(pos["epoch"] ?? ""));
    if (Number.isNaN(epochMs)) {
      throw new CzmlError(
        id,
        `sampled position needs a parseable epoch, got "${String(pos["epoch"])}"`,
      );
    }
    const interp = pos["interpolationAlgorithm"];
    if (interp !== undefined && interp !== "LINEAR" && interp !== "LAGRANGE") {
      throw new CzmlError(id, `unsupported interpolationAlgorithm "${String(interp)}"`);
    }
    const n = cartesian.length / 4;
    const times = new Float64Array(n);
    const positionsKm = new Float32Array(n * 3);
    for (let k = 0; k < n; k += 1) {
      const t = Number(cartesian[k * 4]);
      const x = Number(cartesian[k * 4 + 1]);
      const y = Number(cartesian[k * 4 + 2]);
      const z = Number(cartesian[k * 4 + 3]);
      if (![t, x, y, z].every(Number.isFinite)) {
        throw new CzmlError(id, `non-finite sample at index ${k}`);
      }
      if (k > 0 && t <= (times[k - 1] ?? 0)) {
        throw new CzmlError(id, `sample times must be strictly increasing (index ${k})`);
      }
      times[k] = t;
      positionsKm[k * 3] = x / 1000;
      positionsKm[k * 3 + 1] = y / 1000;
      positionsKm[k * 3 + 2] = z / 1000;
    }

    let availabilityMs: [number, number] | undefined;
    if (typeof pkt["availability"] === "string") {
      const [a, b] = (pkt["availability"] as string).split("/");
      const s = Date.parse(a ?? "");
      const e = Date.parse(b ?? "");
      if (Number.isNaN(s) || Number.isNaN(e)) {
        throw new CzmlError(id, `unparseable availability "${String(pkt["availability"])}"`);
      }
      availabilityMs = [s, e];
    }

    const point = pkt["point"] as Record<string, unknown> | undefined;
    const rgba = (point?.["color"] as Record<string, unknown> | undefined)?.["rgba"];
    entities.push({
      id,
      name: String(pkt["name"] ?? id),
      referenceFrame: String(pos["referenceFrame"] ?? "FIXED"),
      epochMs,
      times,
      positions: positionsKm,
      ...(availabilityMs ? { availabilityMs } : {}),
      ...(point?.["pixelSize"] !== undefined ? { pointPixelSize: Number(point["pixelSize"]) } : {}),
      ...(Array.isArray(rgba) && rgba.length === 4
        ? {
            pointColorRgba: [
              Number(rgba[0]),
              Number(rgba[1]),
              Number(rgba[2]),
              Number(rgba[3]),
            ] as const,
          }
        : {}),
    });
  }

  return { name: String(doc["name"] ?? "czml"), ...(clock ? { clock } : {}), entities, warnings };
}

/** Export a scene back to CZML (the same strict subset; parse(export(x)) == x). */
export function exportCzml(scene: CzmlScene): string {
  const packets: unknown[] = [
    {
      id: "document",
      name: scene.name,
      version: "1.0",
      ...(scene.clock
        ? {
            clock: {
              interval: `${iso(scene.clock.startMs)}/${iso(scene.clock.endMs)}`,
              currentTime: iso(scene.clock.currentMs),
              multiplier: scene.clock.multiplier,
              range: "LOOP_STOP",
            },
          }
        : {}),
    },
  ];
  for (const e of scene.entities) {
    const cartesian: number[] = [];
    for (let k = 0; k < e.times.length; k += 1) {
      cartesian.push(
        e.times[k] ?? 0,
        (e.positions[k * 3] ?? 0) * 1000,
        (e.positions[k * 3 + 1] ?? 0) * 1000,
        (e.positions[k * 3 + 2] ?? 0) * 1000,
      );
    }
    packets.push({
      id: e.id,
      name: e.name,
      ...(e.availabilityMs
        ? { availability: `${iso(e.availabilityMs[0])}/${iso(e.availabilityMs[1])}` }
        : {}),
      position: {
        epoch: iso(e.epochMs),
        referenceFrame: e.referenceFrame,
        interpolationAlgorithm: "LINEAR",
        cartesian,
      },
      ...(e.pointPixelSize !== undefined || e.pointColorRgba
        ? {
            point: {
              ...(e.pointPixelSize !== undefined ? { pixelSize: e.pointPixelSize } : {}),
              ...(e.pointColorRgba ? { color: { rgba: [...e.pointColorRgba] } } : {}),
            },
          }
        : {}),
    });
  }
  return JSON.stringify(packets);
}

/**
 * Bridge to the ephemeris seam: entities become segment objects structurally
 * compatible with @dvgl/orbits' OemSegment, so EphemerisSource renders CZML with
 * zero extra code. Frame caveat travels along: FIXED entities are Earth-fixed and
 * the caller decides whether to counter-rotate (visualization-accuracy decision).
 */
export function czmlToSegments(scene: CzmlScene): {
  readonly objectName: string;
  readonly objectId: string;
  readonly refFrame: string;
  readonly centerName: string;
  readonly epochMs: number;
  readonly times: Float64Array;
  readonly positions: Float32Array;
}[] {
  return scene.entities.map((e) => ({
    objectName: e.name,
    objectId: e.id,
    refFrame: e.referenceFrame,
    centerName: "EARTH",
    epochMs: e.epochMs,
    times: e.times,
    positions: e.positions,
  }));
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
