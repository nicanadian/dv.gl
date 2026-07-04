#!/usr/bin/env node
/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 *
 * Fetch a snapshot of the public GP catalog (CelesTrak, TLE format) and write it as
 * the bench-runner's catalog.json with a SHA-256 so published results reference an
 * exact, reproducible workload. Not run in CI; run manually before a measurement.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle";
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "apps/bench-runner/public/catalog.json",
);

const resp = await fetch(URL);
if (!resp.ok) throw new Error(`fetch failed: ${resp.status}`);
const text = await resp.text();

const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
const objects = [];
for (let i = 0; i + 2 < lines.length + 1; i += 3) {
  const name = lines[i]?.trim();
  const line1 = lines[i + 1];
  const line2 = lines[i + 2];
  if (!name || !line1?.startsWith("1 ") || !line2?.startsWith("2 ")) continue;
  objects.push({ name, line1, line2 });
}
const sha256 = createHash("sha256").update(text).digest("hex");
const snapshot = {
  source: `${URL} fetched ${new Date().toISOString()}`,
  sha256,
  objects,
};
writeFileSync(OUT, JSON.stringify(snapshot));
console.log(`wrote ${objects.length} objects to ${OUT}`);
console.log(`sha256 ${sha256}`);
