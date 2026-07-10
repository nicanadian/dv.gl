/* Copyright 2026 nicanadian. Licensed under the Apache License, Version 2.0. */

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { AbsoluteSample } from "./absolute.js";
import { bodyToLvlhQuaternion } from "./scene.js";

describe("body-to-LVLH attitude", () => {
  it("maps pdb NADIR body +Z onto negative radial", () => {
    const target: AbsoluteSample = {
      timeSec: 0,
      position: { xKm: 6878.137, yKm: 0, zKm: 0 },
      velocity: { xKm: 0, yKm: 7.612608173, zKm: 0 },
    };
    const quaternion = bodyToLvlhQuaternion({ x: -0.5, y: -0.5, z: 0.5, w: 0.5 }, target);
    const boresight = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);

    expect(boresight.x).toBeCloseTo(-1, 9);
    expect(boresight.y).toBeCloseTo(0, 9);
    expect(boresight.z).toBeCloseTo(0, 9);
  });
});
