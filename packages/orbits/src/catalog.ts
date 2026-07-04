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
 * Catalog types for the Stage 0 workload. The benchmark loads a snapshot of the
 * public GP catalog (referenced by checksum per the fairness rules); tests and dev
 * use a small committed sample.
 */

export interface CatalogObject {
  readonly name: string;
  readonly line1: string;
  readonly line2: string;
}

export interface Catalog {
  /** Where the snapshot came from and when (for the published results). */
  readonly source: string;
  /** SHA-256 of the canonical snapshot file this catalog was loaded from. */
  readonly sha256: string;
  readonly objects: readonly CatalogObject[];
}

/** Parse the JSON snapshot format produced by scripts/fetch-catalog.mjs. */
export function parseCatalog(json: string): Catalog {
  const raw = JSON.parse(json) as {
    source?: string;
    sha256?: string;
    objects?: { name?: string; line1?: string; line2?: string }[];
  };
  if (!Array.isArray(raw.objects)) {
    throw new Error("catalog: missing objects array");
  }
  const objects: CatalogObject[] = [];
  for (const o of raw.objects) {
    if (typeof o.name !== "string" || typeof o.line1 !== "string" || typeof o.line2 !== "string") {
      throw new Error("catalog: object missing name/line1/line2");
    }
    objects.push({ name: o.name, line1: o.line1, line2: o.line2 });
  }
  return {
    source: raw.source ?? "unknown",
    sha256: raw.sha256 ?? "unknown",
    objects,
  };
}
