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
 * CCSDS OEM (Orbit Ephemeris Message, 502.0-B) ingest -- the interchange format
 * real missions actually fly (mission design tools, operators, and the pdb
 * spacecraft simulator all emit it). Parses the KVN text form: header, one or more
 * segments (META block + ephemeris state lines), multiple objects per file.
 *
 * Scope (v0, diagnostics-first): TIME_SYSTEM UTC; positions in km (velocities
 * accepted and ignored); REF_FRAME recorded verbatim and surfaced to the caller --
 * dv.gl renders J2000/EME2000/TEME interchangeably at visualization accuracy, but
 * the frame name travels with the data so nothing silently mixes. Unsupported
 * constructs fail loudly with line numbers, never silently skip.
 */

export interface OemSegment {
  readonly objectName: string;
  readonly objectId: string;
  readonly refFrame: string;
  readonly centerName: string;
  /** Epoch of the first state, Unix ms UTC. */
  readonly epochMs: number;
  /** Seconds since epochMs, strictly increasing. */
  readonly times: Float64Array;
  /** Positions km, stride 3, aligned with times. */
  readonly positions: Float32Array;
}

export interface OemFile {
  readonly version: string;
  readonly originator: string;
  readonly segments: readonly OemSegment[];
}

class OemError extends Error {
  constructor(line: number, message: string) {
    super(`OEM line ${line}: ${message}`);
  }
}

/** Parse CCSDS OEM KVN text. Throws OemError with a line number on any problem. */
export function parseOem(text: string): OemFile {
  const lines = text.split(/\r?\n/);
  let version = "";
  let originator = "";
  const segments: OemSegment[] = [];

  let i = 0;
  const peek = (): string => (lines[i] ?? "").trim();
  const atEnd = (): boolean => i >= lines.length;
  const skipBlank = (): void => {
    while (!atEnd() && (peek() === "" || peek().startsWith("COMMENT"))) i += 1;
  };

  // header
  skipBlank();
  const versionLine = peek();
  if (!versionLine.startsWith("CCSDS_OEM_VERS")) {
    throw new OemError(i + 1, `expected CCSDS_OEM_VERS, got "${versionLine}"`);
  }
  version = kvnValue(versionLine, i);
  i += 1;
  while (!atEnd() && !peek().startsWith("META_START")) {
    const l = peek();
    if (l.startsWith("ORIGINATOR")) originator = kvnValue(l, i);
    i += 1;
  }

  // segments
  while (!atEnd()) {
    skipBlank();
    if (atEnd()) break;
    if (!peek().startsWith("META_START")) {
      throw new OemError(i + 1, `expected META_START, got "${peek()}"`);
    }
    i += 1;
    const meta = new Map<string, string>();
    while (!atEnd() && !peek().startsWith("META_STOP")) {
      const l = peek();
      if (l !== "" && !l.startsWith("COMMENT")) {
        const eq = l.indexOf("=");
        if (eq < 0) throw new OemError(i + 1, `malformed META line "${l}"`);
        meta.set(l.slice(0, eq).trim(), l.slice(eq + 1).trim());
      }
      i += 1;
    }
    if (atEnd()) throw new OemError(i, "unterminated META block");
    i += 1; // META_STOP

    const timeSystem = meta.get("TIME_SYSTEM") ?? "";
    if (timeSystem.toUpperCase() !== "UTC") {
      throw new OemError(i, `unsupported TIME_SYSTEM "${timeSystem}" (v0 supports UTC)`);
    }

    // state lines until next META_START / EOF
    const times: number[] = [];
    const positions: number[] = [];
    let epochMs: number | undefined;
    while (!atEnd() && !peek().startsWith("META_START")) {
      const l = peek();
      i += 1;
      if (l === "" || l.startsWith("COMMENT") || l.startsWith("COVARIANCE")) {
        // covariance blocks are ignored wholesale in v0
        continue;
      }
      const parts = l.split(/\s+/);
      if (parts.length < 4) {
        throw new OemError(i, `state line needs epoch + 3 positions, got "${l}"`);
      }
      const t = Date.parse(parts[0] ?? "");
      if (Number.isNaN(t)) throw new OemError(i, `unparseable epoch "${parts[0]}"`);
      const x = Number(parts[1]);
      const y = Number(parts[2]);
      const z = Number(parts[3]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new OemError(i, `non-finite position in "${l}"`);
      }
      epochMs ??= t;
      const rel = (t - epochMs) / 1000;
      const prev = times[times.length - 1];
      if (prev !== undefined && rel <= prev) {
        throw new OemError(i, `epochs must be strictly increasing (${rel}s <= ${prev}s)`);
      }
      times.push(rel);
      positions.push(x, y, z);
    }
    if (epochMs === undefined || times.length === 0) {
      throw new OemError(i, "segment has no ephemeris states");
    }
    segments.push({
      objectName: meta.get("OBJECT_NAME") ?? "unknown",
      objectId: meta.get("OBJECT_ID") ?? "unknown",
      refFrame: meta.get("REF_FRAME") ?? "unknown",
      centerName: meta.get("CENTER_NAME") ?? "unknown",
      epochMs,
      times: new Float64Array(times),
      positions: new Float32Array(positions),
    });
  }

  if (segments.length === 0) throw new OemError(0, "file has no segments");
  return { version, originator, segments };
}

function kvnValue(line: string, idx: number): string {
  const eq = line.indexOf("=");
  if (eq < 0) throw new OemError(idx + 1, `expected KEY = VALUE, got "${line}"`);
  return line.slice(eq + 1).trim();
}
