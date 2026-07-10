/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builderRoot = resolve(
  process.env.GLTF_MODEL_BUILDER_DIR ?? join(appRoot, "../../../gltf-model-builder"),
);
const builder = join(builderRoot, ".venv/bin/gltf-build");
const builderOutput = join(builderRoot, "out");
const packOutput = join(appRoot, "public/packs/pdb-native");

function run(args) {
  const result = spawnSync(builder, args, { cwd: builderRoot, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

mkdirSync(builderOutput, { recursive: true });
for (const recipe of [
  "blender/recipes/rpo_demo_client.yaml",
  "blender/recipes/rpo_demo_servicer.yaml",
]) {
  run(["generate", recipe, "-o", builderOutput]);
}
if (!existsSync(join(builderOutput, "restore_l_class_servicing_arm.glb"))) {
  run([
    "robot",
    "generate",
    "data/fixtures/robotics/servicing_arm.robot.yaml",
    "--config",
    "ready",
    "-o",
    builderOutput,
  ]);
}
run([
  "rpo-pack",
  "build",
  "--scenario",
  "data/fixtures/rpo/pdb_native_reference.scenario.json",
  "--policy",
  "data/fixtures/rpo/pdb_native_reference.pack-policy.json",
  "--lod-dir",
  "out/rpo_lod",
  "--build-lods",
  "--force",
  "-o",
  packOutput,
]);

rmSync(join(appRoot, "public/data"), { recursive: true, force: true });
rmSync(join(appRoot, "public/models"), { recursive: true, force: true });
console.log(`Synced native pdb RPO viewer pack from ${builderRoot}`);
