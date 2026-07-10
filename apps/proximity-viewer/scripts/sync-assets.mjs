/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builderRoot = resolve(
  process.env.GLTF_MODEL_BUILDER_DIR ?? join(appRoot, "../../../gltf-model-builder"),
);
const outputDir = join(appRoot, "public/models");
const dataDir = join(appRoot, "public/data");
const builder = join(builderRoot, ".venv/bin/gltf-build");

const models = [
  {
    id: "servicer",
    label: "Servicer",
    role: "chaser",
    recipe: "blender/recipes/rpo_demo_servicer.yaml",
    file: "rpo_demo_servicer_proxy.glb",
  },
  {
    id: "marman-client",
    label: "MARMAN client",
    role: "target",
    recipe: "blender/recipes/rpo_demo_client_marman.yaml",
    file: "rpo_demo_client_marman_proxy.glb",
  },
  {
    id: "leo-client",
    label: "LEO grapple client",
    role: "target",
    recipe: "blender/recipes/rpo_demo_leo_client.yaml",
    file: "rpo_demo_leo_client_proxy.glb",
  },
];

mkdirSync(outputDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

for (const model of models) {
  const result = spawnSync(builder, ["generate", model.recipe, "-o", outputDir], {
    cwd: builderRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

for (const file of models.map((model) => model.file)) {
  const stem = file.replace(/\.glb$/, "");
  for (const suffix of [".blend", ".blend1", ".blend2", ".plan.json", ".manifest.json"]) {
    rmSync(join(outputDir, `${stem}${suffix}`), { force: true });
  }
  const metadataPath = join(outputDir, `${stem}.metadata.json`);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  delete metadata.generated_at;
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
}

const replaySource = join(builderRoot, "data/fixtures/rpo/vbar_terminal_approach.replay.json");
copyFileSync(replaySource, join(dataDir, "replay.json"));

const manifest = {
  schema_version: "dvgl/proximity-assets/0.1",
  authority: "visual_only",
  source_repository: "gltf-model-builder",
  models: models.map((model) => {
    const glbPath = join(outputDir, model.file);
    const metadataPath = glbPath.replace(/\.glb$/, ".metadata.json");
    return {
      ...model,
      uri: `/models/${model.file}`,
      sha256: createHash("sha256").update(readFileSync(glbPath)).digest("hex"),
      metadata: JSON.parse(readFileSync(metadataPath, "utf8")),
    };
  }),
};
writeFileSync(join(dataDir, "assets.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Synced ${models.length} visual-proxy GLBs from ${builderRoot}`);
