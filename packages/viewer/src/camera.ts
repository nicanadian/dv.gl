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
 * An orbit camera around Earth's centre, producing a relative-to-eye view-proj
 * matrix + eye position (km) for the RTE renderers. Pure math, no DOM: the host
 * drives it via orbit()/zoom() or the Scene's optional attachControls().
 */

function perspective(fovyRad: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovyRad / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far / (near - far);
  out[11] = -1;
  out[14] = (far * near) / (near - far);
  return out;
}

function lookAtRte(eye: readonly [number, number, number]): Float32Array {
  const len = Math.hypot(eye[0], eye[1], eye[2]) || 1;
  const fx = -eye[0] / len;
  const fy = -eye[1] / len;
  const fz = -eye[2] / len;
  let rx = fy;
  let ry = -fx;
  const rl = Math.hypot(rx, ry, 0) || 1;
  rx /= rl;
  ry /= rl;
  const ux = ry * fz;
  const uy = -rx * fz;
  const uz = rx * fy - ry * fx;
  const out = new Float32Array(16);
  out[0] = rx;
  out[4] = ry;
  out[1] = ux;
  out[5] = uy;
  out[9] = uz;
  out[2] = -fx;
  out[6] = -fy;
  out[10] = -fz;
  out[15] = 1;
  return out;
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let s = 0;
      for (let k = 0; k < 4; k += 1) s += (a[k * 4 + r] ?? 0) * (b[c * 4 + k] ?? 0);
      out[c * 4 + r] = s;
    }
  }
  return out;
}

export interface CameraView {
  lonDeg: number;
  latDeg: number;
  rangeKm: number;
}

export class OrbitCamera {
  readonly view: CameraView;
  minRangeKm = 6_800;
  maxRangeKm = 300_000;
  fovyDeg = 50;

  constructor(view?: Partial<CameraView>) {
    this.view = { lonDeg: -75, latDeg: 25, rangeKm: 45_000, ...view };
  }

  /** Drag: dLonDeg east-negative (screen-natural), dLatDeg clamped to the poles. */
  orbit(dLonDeg: number, dLatDeg: number): void {
    this.view.lonDeg -= dLonDeg;
    this.view.latDeg = Math.max(-89, Math.min(89, this.view.latDeg + dLatDeg));
  }

  /** Multiplicative zoom, clamped to [minRangeKm, maxRangeKm]. */
  zoom(factor: number): void {
    this.view.rangeKm = Math.max(
      this.minRangeKm,
      Math.min(this.maxRangeKm, this.view.rangeKm * factor),
    );
  }

  eye(extraLonDeg = 0): [number, number, number] {
    const lon = ((this.view.lonDeg + extraLonDeg) * Math.PI) / 180;
    const lat = (this.view.latDeg * Math.PI) / 180;
    const r = this.view.rangeKm;
    return [
      r * Math.cos(lat) * Math.cos(lon),
      r * Math.cos(lat) * Math.sin(lon),
      r * Math.sin(lat),
    ];
  }

  /**
   * View-proj (RTE, eye at origin) + eye position. `extraLonDeg` co-rotates the
   * camera with Earth (pass GMST degrees) so an Earth-fixed scene looks stationary.
   */
  frame(
    aspect: number,
    extraLonDeg = 0,
  ): { viewProjRte: Float32Array; eyeKm: [number, number, number] } {
    const eyeKm = this.eye(extraLonDeg);
    const proj = perspective((this.fovyDeg * Math.PI) / 180, aspect, 10, 500_000);
    return { viewProjRte: mul(proj, lookAtRte(eyeKm)), eyeKm };
  }
}
