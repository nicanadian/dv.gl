/*
 * Copyright 2026 nicanadian
 * Licensed under the Apache License, Version 2.0.
 */

export const VIEWER_PACK_SCHEMA = "rpo_viewer_pack/v1";

export interface PackFile {
  readonly path: string;
  readonly sha256: string;
}

export interface PackModel {
  readonly name: string;
  readonly accuracy_tier: string;
  readonly source_basis: string;
  readonly not_official_model: true;
  readonly tiers: { readonly high: string };
}

export interface ViewerPack {
  readonly schema_version: typeof VIEWER_PACK_SCHEMA;
  readonly pack_id: string;
  readonly version: string;
  readonly frame_profile: "skframe/v1";
  readonly frame: "LVLH_RIC";
  readonly length_units: "m";
  readonly authority: "visual_only";
  readonly models: {
    readonly client: PackModel;
    readonly chaser: PackModel;
  };
  readonly robot: {
    readonly name: string;
    readonly accuracy_tier: string;
    readonly not_official_model: true;
    readonly glb: string;
    readonly document: string;
    readonly base_frame: string;
    readonly base_frame_resolved: true;
    readonly tool_frame: string;
  };
  readonly scenes: { readonly replay: string; readonly scenario: string };
  readonly evidence: {
    readonly proximity_gate: string;
    readonly absolute_chaser_ephemeris: string;
    readonly absolute_target_ephemeris: string;
  };
  readonly files: readonly PackFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.split("/").includes("..")
  );
}

function validateModel(value: unknown, role: string): asserts value is PackModel {
  if (!isRecord(value)) throw new Error(`viewer pack models.${role} is invalid`);
  const tiers = isRecord(value.tiers) ? value.tiers : {};
  if (
    typeof value.name !== "string" ||
    typeof value.accuracy_tier !== "string" ||
    typeof value.source_basis !== "string" ||
    value.not_official_model !== true ||
    !isSafeRelativePath(tiers.high)
  ) {
    throw new Error(`viewer pack models.${role} contract mismatch`);
  }
}

export function parseViewerPack(value: unknown): ViewerPack {
  if (!isRecord(value)) throw new Error("viewer pack must be an object");
  if (value.schema_version !== VIEWER_PACK_SCHEMA) {
    throw new Error(`unsupported viewer pack schema ${String(value.schema_version)}`);
  }
  if (
    value.frame_profile !== "skframe/v1" ||
    value.frame !== "LVLH_RIC" ||
    value.length_units !== "m"
  ) {
    throw new Error("viewer pack frame contract mismatch");
  }
  if (value.authority !== "visual_only") {
    throw new Error("viewer pack must be visual_only");
  }
  if (
    !isRecord(value.models) ||
    !isRecord(value.robot) ||
    !isRecord(value.scenes) ||
    !isRecord(value.evidence)
  ) {
    throw new Error("viewer pack models, robot, scenes, and evidence are required");
  }
  validateModel(value.models.client, "client");
  validateModel(value.models.chaser, "chaser");
  if (
    typeof value.robot.name !== "string" ||
    typeof value.robot.accuracy_tier !== "string" ||
    value.robot.not_official_model !== true ||
    !isSafeRelativePath(value.robot.glb) ||
    !isSafeRelativePath(value.robot.document) ||
    typeof value.robot.base_frame !== "string" ||
    value.robot.base_frame_resolved !== true ||
    typeof value.robot.tool_frame !== "string"
  ) {
    throw new Error("viewer pack robot contract mismatch");
  }
  if (!isSafeRelativePath(value.scenes.replay) || !isSafeRelativePath(value.scenes.scenario)) {
    throw new Error("viewer pack replay or scenario path is unsafe");
  }
  for (const key of ["proximity_gate", "absolute_chaser_ephemeris", "absolute_target_ephemeris"]) {
    if (!isSafeRelativePath(value.evidence[key])) {
      throw new Error(`viewer pack evidence.${key} path is unsafe`);
    }
  }
  if (!Array.isArray(value.files)) throw new Error("viewer pack files are required");
  const files = value.files as unknown[];
  const records = new Map<string, string>();
  for (const entry of files) {
    if (
      !isRecord(entry) ||
      !isSafeRelativePath(entry.path) ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error("viewer pack file record is invalid");
    }
    records.set(entry.path, entry.sha256);
  }
  const requiredPaths = [
    value.scenes.replay,
    value.scenes.scenario,
    value.evidence.proximity_gate,
    value.evidence.absolute_chaser_ephemeris,
    value.evidence.absolute_target_ephemeris,
    value.models.client.tiers.high,
    value.models.chaser.tiers.high,
    value.robot.glb,
    value.robot.document,
  ] as string[];
  for (const path of requiredPaths) {
    if (!records.has(path)) throw new Error(`viewer pack does not manifest ${path}`);
  }
  if (typeof value.pack_id !== "string" || typeof value.version !== "string") {
    throw new Error("viewer pack identity is required");
  }
  return value as unknown as ViewerPack;
}

export function parsePackScenario(value: unknown): { readonly keepOutMarginM: number } {
  if (!isRecord(value) || value.schema_version !== "rpo_scenario/v1") {
    throw new Error("viewer pack scenario contract mismatch");
  }
  if (
    typeof value.keep_out_margin_m !== "number" ||
    !Number.isFinite(value.keep_out_margin_m) ||
    value.keep_out_margin_m <= 0
  ) {
    throw new Error("viewer pack scenario requires a positive keep-out margin");
  }
  return { keepOutMarginM: value.keep_out_margin_m };
}

export function packAssetUrl(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) throw new Error("unsafe viewer pack path");
  return `${root.replace(/\/$/, "")}/${relative}`;
}

export function packFileDigest(pack: ViewerPack, path: string): string {
  const record = pack.files.find((entry) => entry.path === path);
  if (!record) throw new Error(`viewer pack does not manifest ${path}`);
  return record.sha256;
}
